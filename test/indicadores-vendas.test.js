// Testes do endpoint de indicadores de Vendas — só dados FICTÍCIOS, num banco
// temporário criado do zero (DATA_DIR aponta pra uma pasta descartável).
// Rodar: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'indicadores-vendas-'));
process.env.DATA_DIR = pasta;
process.env.SETOR = 'vendas';

const express = require('express');
const db = require('../db');
const { criarRotaIndicadoresVendas, calcularIndicadoresVendas } = require('../indicadores-vendas');

const setorId = db.getSetorPorSlug('vendas').id;
const TOKEN = 'token-ficticio-de-teste-0123456789abcdef'; // não é credencial real
const NOMES = ['Cliente Ficticio Alfa', 'Cliente Ficticio Beta'];
const TELEFONES = ['5500900000001', '5500900000002'];
const TEXTO = 'mensagem-ficticia-secreta';

// "2026-11-03 10:00" no horário de Brasília → formato do banco (UTC).
function brt(texto) {
  const [d, h] = texto.split(' ');
  const utc = new Date(`${d}T${h}:00.000-03:00`);
  return utc.toISOString().replace('T', ' ').replace('Z', '');
}
const agoraBrt = (texto) => new Date(brt(texto).replace(' ', 'T') + 'Z');

function limpar() {
  db.exec('DELETE FROM mensagens; DELETE FROM leads;');
}
let seq = 0;
function lead({ status = 'em_atendimento', grupo = false, encerrado = null, setor = setorId } = {}) {
  seq += 1;
  return db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, status, setor_id, is_grupo, encerrado_em, valor_venda)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(TELEFONES[seq % 2], NOMES[seq % 2], TEXTO, status, setor, grupo ? 1 : 0, encerrado ? brt(encerrado) : null, 98765.43).lastInsertRowid;
}
function msg(leadId, remetente, quando) {
  db.prepare('INSERT INTO mensagens (lead_id, remetente, texto, criado_em) VALUES (?, ?, ?, ?)')
    .run(leadId, remetente, TEXTO, brt(quando));
}

// Regras do contrato v1 aceitas pelo Scob 3D Operations (parseSalesAttendance).
function validarContratoV1(corpo) {
  assert.deepEqual(Object.keys(corpo).sort(), ['aguardando_resposta', 'finalizadas', 'gerado_em', 'primeira_resposta_hoje', 'setor', 'versao']);
  assert.equal(corpo.versao, 1);
  assert.equal(corpo.setor, 'vendas');
  assert.match(corpo.gerado_em, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/);
  const contagem = (n) => Number.isInteger(n) && n >= 0;
  const minutos = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  assert.deepEqual(Object.keys(corpo.finalizadas).sort(), ['hoje', 'mes']);
  assert.ok(contagem(corpo.finalizadas.hoje) && contagem(corpo.finalizadas.mes));
  assert.deepEqual(Object.keys(corpo.aguardando_resposta).sort(), ['espera_mais_antiga_min', 'total']);
  assert.ok(contagem(corpo.aguardando_resposta.total) && minutos(corpo.aguardando_resposta.espera_mais_antiga_min));
  const p = corpo.primeira_resposta_hoje;
  assert.deepEqual(Object.keys(p).sort(), ['amostras', 'media_min', 'sem_resposta']);
  assert.ok((p.media_min === null || minutos(p.media_min)) && contagem(p.amostras) && contagem(p.sem_resposta));
}

// Terça-feira, 03/11/2026, 15:00 em Brasília.
const TERCA_15H = agoraBrt('2026-11-03 15:00');

// ---------------------------------------------------------------
// CÁLCULO
// ---------------------------------------------------------------
test('finalizadas: dia e mês de Brasília, sem grupos, sem reabertas', () => {
  limpar();
  lead({ status: 'encerrado', encerrado: '2026-11-03 09:00' });   // hoje
  lead({ status: 'encerrado', encerrado: '2026-11-02 23:30' });   // ontem (em UTC já seria hoje)
  lead({ status: 'encerrado', encerrado: '2026-10-31 22:00' });   // outubro (em UTC já seria novembro)
  lead({ status: 'encerrado', grupo: true, encerrado: '2026-11-03 10:00' });
  lead({ status: 'em_atendimento', encerrado: '2026-11-03 08:00' }); // reaberta depois de encerrar hoje
  lead({ status: 'novo' });
  const r = calcularIndicadoresVendas(db, setorId, TERCA_15H);
  assert.deepEqual(r.finalizadas, { hoje: 1, mes: 2 });
  assert.equal(r.gerado_em, '2026-11-03T15:00:00-03:00');
});

test('conversa reaberta e encerrada de novo conta uma vez, pelo último encerramento', () => {
  limpar();
  const l = lead({ status: 'encerrado', encerrado: '2026-11-03 09:30' }); // 1º encerramento foi 02/11 16:00, sobrescrito
  msg(l, 'cliente', '2026-11-02 15:00');
  msg(l, 'vendedor', '2026-11-02 15:10');
  msg(l, 'cliente', '2026-11-03 09:00'); // reabriu hoje
  msg(l, 'vendedor', '2026-11-03 09:05');
  const r = calcularIndicadoresVendas(db, setorId, TERCA_15H);
  assert.deepEqual(r.finalizadas, { hoje: 1, mes: 1 });
  assert.equal(r.primeira_resposta_hoje.amostras, 1);
  assert.equal(r.primeira_resposta_hoje.media_min, 5);
});

test('aguardando resposta: última mensagem relevante do cliente, sem grupos, IA e nota não contam', () => {
  limpar();
  const a = lead(); msg(a, 'cliente', '2026-11-03 13:00'); msg(a, 'cliente', '2026-11-03 14:00'); // espera desde 13:00
  const b = lead(); msg(b, 'cliente', '2026-11-03 14:50'); msg(b, 'ia', '2026-11-03 14:50');     // IA não é resposta
  const c = lead(); msg(c, 'cliente', '2026-11-03 10:00'); msg(c, 'vendedor', '2026-11-03 10:05'); msg(c, 'nota', '2026-11-03 10:06');
  const g = lead({ grupo: true }); msg(g, 'cliente', '2026-11-03 12:00');
  const e = lead({ status: 'encerrado', encerrado: '2026-11-03 12:00' }); msg(e, 'cliente', '2026-11-03 11:00');
  const r = calcularIndicadoresVendas(db, setorId, TERCA_15H);
  assert.equal(r.aguardando_resposta.total, 2);
  assert.equal(r.aguardando_resposta.espera_mais_antiga_min, 120);
});

test('primeira resposta de hoje: só humana, horário comercial, grupos fora', () => {
  limpar();
  const [l1, l2, l3, l4, ontem] = [lead(), lead(), lead(), lead(), lead()];
  const g = lead({ grupo: true });
  // Em ordem cronológica, como o sistema grava (o id cresce com o tempo).
  msg(ontem, 'cliente', '2026-11-02 10:00'); msg(ontem, 'vendedor', '2026-11-02 10:05');
  // Segunda 17:50 sem resposta; terça 06:30 de novo; resposta 07:10 → 10 min (seg) + 10 min (ter)
  msg(l3, 'cliente', '2026-11-02 17:50'); msg(l3, 'cliente', '2026-11-03 06:30'); msg(l3, 'vendedor', '2026-11-03 07:10');
  msg(g, 'cliente', '2026-11-03 09:00'); msg(g, 'vendedor', '2026-11-03 09:30');
  msg(l1, 'cliente', '2026-11-03 10:00'); msg(l1, 'ia', '2026-11-03 10:00'); msg(l1, 'vendedor', '2026-11-03 10:12'); // 12 (IA ignorada)
  msg(l2, 'cliente', '2026-11-03 11:00'); msg(l2, 'cliente', '2026-11-03 11:05'); msg(l2, 'vendedor', '2026-11-03 11:20'); // 20
  msg(l4, 'cliente', '2026-11-03 14:00'); msg(l4, 'ia', '2026-11-03 14:00'); // só automática → sem resposta
  const r = calcularIndicadoresVendas(db, setorId, TERCA_15H);
  assert.deepEqual(r.primeira_resposta_hoje, { media_min: 17.3, amostras: 3, sem_resposta: 1 });
});

test('fora do expediente: domingo e noite não contam', () => {
  limpar();
  // Sábado 12:50 → segunda 07:05: 10 min (sáb até 13:00) + 5 min (seg)
  const l = lead(); msg(l, 'cliente', '2026-10-31 12:50'); msg(l, 'cliente', '2026-11-02 06:00'); msg(l, 'vendedor', '2026-11-02 07:05');
  const r = calcularIndicadoresVendas(db, setorId, agoraBrt('2026-11-02 08:00'));
  assert.deepEqual(r.primeira_resposta_hoje, { media_min: 15, amostras: 1, sem_resposta: 0 });
});

test('virada de dia e de mês em Brasília', () => {
  limpar();
  lead({ status: 'encerrado', encerrado: '2026-10-31 22:00' });
  lead({ status: 'encerrado', encerrado: '2026-10-30 23:00' });
  lead({ status: 'encerrado', encerrado: '2026-10-05 10:00' });
  const sab = calcularIndicadoresVendas(db, setorId, agoraBrt('2026-10-31 23:30'));
  assert.deepEqual(sab.finalizadas, { hoje: 1, mes: 3 });
  assert.equal(sab.gerado_em, '2026-10-31T23:30:00-03:00');
  const dom = calcularIndicadoresVendas(db, setorId, agoraBrt('2026-11-01 00:30'));
  assert.deepEqual(dom.finalizadas, { hoje: 0, mes: 0 });
  assert.equal(dom.gerado_em, '2026-11-01T00:30:00-03:00');
});

test('sem dados: média nula e contagens zeradas', () => {
  limpar();
  const r = calcularIndicadoresVendas(db, setorId, TERCA_15H);
  validarContratoV1(r);
  assert.deepEqual(r.primeira_resposta_hoje, { media_min: null, amostras: 0, sem_resposta: 0 });
  assert.deepEqual(r.aguardando_resposta, { total: 0, espera_mais_antiga_min: 0 });
});

// ---------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------
async function servidor(env, limite) {
  const app = express();
  app.use(criarRotaIndicadoresVendas({ db, env, agora: () => TERCA_15H, limite }));
  const s = await new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
  const base = `http://127.0.0.1:${s.address().port}/api/externo/indicadores-vendas`;
  return { base, fechar: () => new Promise((r) => s.close(r)) };
}
const comToken = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const VENDAS = { SETOR: 'vendas', INDICADORES_VENDAS_TOKEN: TOKEN };

function popularFicticio() {
  limpar();
  const a = lead(); msg(a, 'cliente', '2026-11-03 13:00');
  const b = lead({ status: 'encerrado', encerrado: '2026-11-03 11:00' }); msg(b, 'cliente', '2026-11-03 10:00'); msg(b, 'vendedor', '2026-11-03 10:07');
}

test('Vendas com token correto: 200, contrato v1, no-store, sem dados pessoais', async () => {
  popularFicticio();
  const { base, fechar } = await servidor(VENDAS);
  const res = await fetch(`${base}?setor=financeiro&instalacao=outra`, comToken(TOKEN));
  const texto = await res.text();
  await fechar();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const corpo = JSON.parse(texto);
  validarContratoV1(corpo);
  assert.equal(corpo.setor, 'vendas'); // parâmetro de setor é ignorado
  assert.deepEqual(corpo.finalizadas, { hoje: 1, mes: 1 });
  for (const proibido of [...NOMES, ...TELEFONES, TEXTO, '98765', 'valor', 'telefone', 'nome', 'financeiro']) {
    assert.ok(!texto.includes(proibido), `resposta contém "${proibido}"`);
  }
});

test('Vendas sem token e com token incorreto: 401', async () => {
  const { base, fechar } = await servidor(VENDAS);
  const sem = await fetch(base);
  const errado = await fetch(base, comToken(TOKEN.slice(0, -1) + 'x'));
  const curto = await fetch(base, comToken('abc'));
  const basic = await fetch(base, { headers: { Authorization: `Basic ${TOKEN}` } });
  const naQuery = await fetch(`${base}?token=${TOKEN}`);
  await fechar();
  for (const r of [sem, errado, curto, basic, naQuery]) {
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { erro: 'nao_autorizado' });
  }
  assert.equal(sem.headers.get('www-authenticate'), 'Bearer');
});

test('Financeiro, Expedição ou SETOR ausente com token correto: 404', async () => {
  const casos = [
    { SETOR: 'financeiro', INDICADORES_VENDAS_TOKEN: TOKEN },
    { SETOR: 'expedicao', INDICADORES_VENDAS_TOKEN: TOKEN },
    { INDICADORES_VENDAS_TOKEN: TOKEN }, // padrão do sistema seria "vendas": aqui não ativa
    { SETOR: '', INDICADORES_VENDAS_TOKEN: TOKEN },
  ];
  for (const env of casos) {
    const { base, fechar } = await servidor(env);
    const r = await fetch(base, comToken(TOKEN));
    await fechar();
    assert.equal(r.status, 404, JSON.stringify(env));
    assert.deepEqual(await r.json(), { erro: 'nao_encontrado' });
  }
});

test('token não configurado ou curto demais: 503 mesmo com Authorization', async () => {
  for (const env of [{ SETOR: 'vendas' }, { SETOR: 'vendas', INDICADORES_VENDAS_TOKEN: '   ' }, { SETOR: 'vendas', INDICADORES_VENDAS_TOKEN: 'curto' }]) {
    const { base, fechar } = await servidor(env);
    const r = await fetch(base, comToken(env.INDICADORES_VENDAS_TOKEN || 'qualquer-coisa'));
    await fechar();
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { erro: 'nao_configurado' });
  }
});

test('limite de requisições: 429 com Retry-After, inclusive para token errado', async () => {
  const { base, fechar } = await servidor(VENDAS, { janelaMs: 60_000, max: 3 });
  const status = [];
  for (let i = 0; i < 3; i++) status.push((await fetch(base, comToken('errado'))).status);
  const bloqueada = await fetch(base, comToken(TOKEN));
  await fechar();
  assert.deepEqual(status, [401, 401, 401]);
  assert.equal(bloqueada.status, 429);
  assert.ok(Number(bloqueada.headers.get('retry-after')) > 0);
});

test('somente leitura e sem logs: banco igual e nada impresso no console', async () => {
  popularFicticio();
  const fotografia = () => JSON.stringify([db.prepare('SELECT * FROM leads ORDER BY id').all(), db.prepare('SELECT * FROM mensagens ORDER BY id').all()]);
  const antes = fotografia();
  const impressos = [];
  const originais = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(originais)) console[k] = (...a) => impressos.push(a.join(' '));
  try {
    const { base, fechar } = await servidor(VENDAS);
    await fetch(base, comToken(TOKEN));
    await fetch(base, comToken('errado'));
    await fetch(base);
    await fechar();
  } finally {
    Object.assign(console, originais);
  }
  assert.equal(fotografia(), antes);
  assert.deepEqual(impressos, []);
});

test('outros métodos não existem na rota', async () => {
  const { base, fechar } = await servidor(VENDAS);
  const r = await fetch(base, { method: 'POST', ...comToken(TOKEN) });
  await fechar();
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------
// SERVIDOR COMPLETO (server.js) — sobe o sistema de verdade num banco vazio
// temporário, com ambiente mínimo (sem credenciais herdadas da máquina).
// ---------------------------------------------------------------
async function subirServer(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indicadores-vendas-srv-'));
  const porta = 39000 + Math.floor(Math.random() * 900);
  const filho = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DATA_DIR: dataDir, PORT: String(porta), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saida = '';
  filho.stdout.on('data', (d) => { saida += d; });
  filho.stderr.on('data', (d) => { saida += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server.js não subiu: ' + saida)), 15000);
    const ver = setInterval(() => { if (saida.includes('Servidor rodando')) { clearTimeout(t); clearInterval(ver); resolve(); } }, 50);
  });
  return {
    base: `http://127.0.0.1:${porta}/api/externo/indicadores-vendas`,
    saida: () => saida,
    parar: () => new Promise((r) => { filho.once('exit', r); filho.kill(); }),
  };
}

test('server.js: Vendas responde o contrato; Financeiro com o mesmo token dá 404', async () => {
  const vendas = await subirServer(VENDAS);
  const ok = await fetch(vendas.base, comToken(TOKEN));
  const sem = await fetch(vendas.base);
  const corpo = await ok.json();
  await vendas.parar();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  validarContratoV1(corpo);
  assert.equal(sem.status, 401);
  assert.ok(!vendas.saida().includes(TOKEN), 'token apareceu no log');

  const fin = await subirServer({ SETOR: 'financeiro', INDICADORES_VENDAS_TOKEN: TOKEN });
  const r = await fetch(fin.base, comToken(TOKEN));
  await fin.parar();
  assert.equal(r.status, 404);
});
