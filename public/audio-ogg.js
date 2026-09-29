// audio-ogg.js
// ---------------------------------------------------------------------------
// Converte (sem reencodar) o áudio gravado pelo navegador de WebM/Opus para
// OGG/Opus — o formato nativo das notas de voz do WhatsApp.
//
// Por quê: o Chrome/Edge só sabem gravar WebM. Mandar WebM pra Z-API como
// nota de voz faz o áudio chegar "mudo" em parte dos aparelhos (o WhatsApp
// espera OGG/Opus). O conteúdo de áudio (os pacotes Opus) é exatamente o
// mesmo nos dois formatos — só muda a "embalagem" — então aqui a gente só
// tira os pacotes do WebM e reembala em páginas OGG. Sem biblioteca, sem
// perda de qualidade.
//
// Se qualquer coisa fugir do esperado (codec diferente, lacing, arquivo
// estranho), devolve null e quem chamou manda o arquivo original.
// ---------------------------------------------------------------------------

(function () {
  // ---- EBML (WebM) ----
  const ID = {
    SEGMENT: 0x18538067, CLUSTER: 0x1F43B675, TRACKS: 0x1654AE6B, TRACK_ENTRY: 0xAE,
    AUDIO: 0xE1, BLOCK_GROUP: 0xA0, BLOCK: 0xA1, SIMPLE_BLOCK: 0xA3,
    CODEC_ID: 0x86, CODEC_PRIVATE: 0x63A2, CHANNELS: 0x9F, TRACK_NUMBER: 0xD7,
  };
  // Elementos "container": entramos neles em vez de pular (funciona mesmo com
  // tamanho desconhecido, que é como o MediaRecorder grava Segment/Cluster).
  const CONTAINERS = new Set([ID.SEGMENT, ID.CLUSTER, ID.TRACKS, ID.TRACK_ENTRY, ID.AUDIO, ID.BLOCK_GROUP]);

  function lerVint(bytes, pos, manterMarcador) {
    const primeiro = bytes[pos];
    if (primeiro === undefined || primeiro === 0) return null;
    let tamanho = 1;
    while (!(primeiro & (0x80 >> (tamanho - 1)))) tamanho++;
    if (pos + tamanho > bytes.length) return null;
    let valor = manterMarcador ? primeiro : primeiro & (0xFF >> tamanho);
    let tudoUm = valor === (0xFF >> tamanho);
    for (let i = 1; i < tamanho; i++) {
      valor = valor * 256 + bytes[pos + i];
      if (bytes[pos + i] !== 0xFF) tudoUm = false;
    }
    return { valor, tamanho, desconhecido: !manterMarcador && tudoUm };
  }

  function extrairOpusDoWebm(bytes) {
    const pacotes = [];
    let codecPrivate = null, codecId = null, canais = 1, trilhaAudio = null, trilhaAtual = null;
    let pos = 0;
    while (pos < bytes.length) {
      const id = lerVint(bytes, pos, true);
      if (!id) break;
      const tam = lerVint(bytes, pos + id.tamanho, false);
      if (!tam) break;
      const inicio = pos + id.tamanho + tam.tamanho;
      if (CONTAINERS.has(id.valor)) { pos = inicio; continue; }
      if (tam.desconhecido) return null; // só containers podem ter tamanho desconhecido
      const fim = Math.min(inicio + tam.valor, bytes.length);
      const dado = bytes.subarray(inicio, fim);
      if (id.valor === ID.TRACK_NUMBER) trilhaAtual = dado.reduce((a, b) => a * 256 + b, 0);
      else if (id.valor === ID.CODEC_ID) {
        codecId = new TextDecoder().decode(dado);
        if (codecId === 'A_OPUS') trilhaAudio = trilhaAtual;
      } else if (id.valor === ID.CODEC_PRIVATE) codecPrivate = dado.slice();
      else if (id.valor === ID.CHANNELS) canais = dado[0] || 1;
      else if (id.valor === ID.SIMPLE_BLOCK || id.valor === ID.BLOCK) {
        const trilha = lerVint(dado, 0, false);
        if (!trilha) return null;
        const flags = dado[trilha.tamanho + 2];
        if (flags & 0x06) return null; // lacing: o MediaRecorder não usa; não arriscamos
        if (trilhaAudio === null || trilha.valor === trilhaAudio) pacotes.push(dado.slice(trilha.tamanho + 3));
      }
      pos = fim;
    }
    if (codecId !== 'A_OPUS' || !pacotes.length) return null;
    return { pacotes, codecPrivate, canais };
  }

  // ---- Opus / OGG ----
  // Quantas amostras (a 48 kHz) um pacote Opus representa — pelo byte TOC.
  function amostrasDoPacote(p) {
    if (!p.length) return 0;
    const config = p[0] >> 3;
    let duracao; // em unidades de 2,5 ms
    if (config < 12) duracao = [4, 8, 16, 24][config & 3];
    else if (config < 16) duracao = [4, 8][config & 1];
    else duracao = [1, 2, 4, 8][config & 3];
    const c = p[0] & 3;
    const quadros = c === 0 ? 1 : c === 3 ? (p[1] & 0x3F) : 2;
    return quadros * duracao * 120;
  }

  const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
      t[i] = r >>> 0;
    }
    return t;
  })();
  function crcOgg(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ TABELA_CRC[((crc >>> 24) ^ bytes[i]) & 0xFF]) >>> 0;
    return crc;
  }

  function paginaOgg(pacotes, { granulo, serial, sequencia, flags }) {
    const lacos = [];
    pacotes.forEach((p) => {
      let resto = p.length;
      while (resto >= 255) { lacos.push(255); resto -= 255; }
      lacos.push(resto);
    });
    const corpo = pacotes.reduce((a, p) => a + p.length, 0);
    const pagina = new Uint8Array(27 + lacos.length + corpo);
    const dv = new DataView(pagina.buffer);
    pagina.set([0x4F, 0x67, 0x67, 0x53], 0); // "OggS"
    pagina[5] = flags;
    dv.setUint32(6, granulo % 0x100000000, true);
    dv.setUint32(10, Math.floor(granulo / 0x100000000), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, sequencia, true);
    pagina[26] = lacos.length;
    pagina.set(lacos, 27);
    let pos = 27 + lacos.length;
    pacotes.forEach((p) => { pagina.set(p, pos); pos += p.length; });
    dv.setUint32(22, crcOgg(pagina), true);
    return pagina;
  }

  function cabecalhoOpus(canais) {
    const h = new Uint8Array(19);
    const dv = new DataView(h.buffer);
    h.set(new TextEncoder().encode('OpusHead'), 0);
    h[8] = 1; h[9] = canais;
    dv.setUint16(10, 3840, true);   // pre-skip padrão do encoder
    dv.setUint32(12, 48000, true);
    return h;
  }

  function tagsOpus() {
    const vendor = new TextEncoder().encode('central-atendimento');
    const t = new Uint8Array(8 + 4 + vendor.length + 4);
    t.set(new TextEncoder().encode('OpusTags'), 0);
    new DataView(t.buffer).setUint32(8, vendor.length, true);
    t.set(vendor, 12);
    return t; // 0 comentários (os 4 bytes finais já são zero)
  }

  function montarOgg({ pacotes, codecPrivate, canais }) {
    const cabecalho = codecPrivate && codecPrivate.length >= 19
      && new TextDecoder().decode(codecPrivate.subarray(0, 8)) === 'OpusHead'
      ? codecPrivate : cabecalhoOpus(canais);
    const serial = (Math.random() * 0xFFFFFFFF) >>> 0;
    const paginas = [
      paginaOgg([cabecalho], { granulo: 0, serial, sequencia: 0, flags: 0x02 }),
      paginaOgg([tagsOpus()], { granulo: 0, serial, sequencia: 1, flags: 0 }),
    ];
    // Granulo conta desde o 1º pacote: os pacotes do encoder já incluem as
    // amostras de pre-skip, então começar em preSkip esticaria a duração.
    let granulo = 0, sequencia = 2, lote = [], segmentos = 0;
    pacotes.forEach((p, i) => {
      const seg = Math.floor(p.length / 255) + 1;
      if (lote.length && segmentos + seg > 255) {
        paginas.push(paginaOgg(lote, { granulo, serial, sequencia: sequencia++, flags: 0 }));
        lote = []; segmentos = 0;
      }
      lote.push(p); segmentos += seg;
      granulo += amostrasDoPacote(p);
      if (i === pacotes.length - 1) paginas.push(paginaOgg(lote, { granulo, serial, sequencia: sequencia++, flags: 0x04 }));
    });
    return new Blob(paginas, { type: 'audio/ogg' });
  }

  // Recebe o Blob gravado e devolve um Blob OGG/Opus, ou null se não der.
  async function webmParaOgg(blob) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes[0] !== 0x1A || bytes[1] !== 0x45 || bytes[2] !== 0xDF || bytes[3] !== 0xA3) return null;
      const opus = extrairOpusDoWebm(bytes);
      return opus ? montarOgg(opus) : null;
    } catch (e) {
      console.warn('Conversão WebM→OGG falhou, enviando o áudio original:', e);
      return null;
    }
  }

  window.webmParaOgg = webmParaOgg;
})();
