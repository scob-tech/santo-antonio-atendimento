// horario.js
// Horário de funcionamento da loja — usado pra avisar automaticamente o
// cliente quando ele escreve fora do expediente, sem deixar de registrar
// o interesse dele: o lead entra na fila do mesmo jeito de sempre, só a
// mensagem de boas-vindas muda de tom.
//
// Horário atual (ajuste aqui se mudar, nada mais precisa ser mexido):
//   Segunda a sexta: 07:00 às 18:00
//   Sábado: 08:00 às 13:00
//   Domingo: fechado
//
// Feriados ainda não são considerados — fica pra uma próxima etapa
// (precisaria de uma lista de datas, fixa ou vinda de alguma API de
// feriados nacionais/municipais de São Paulo).

const HORARIOS = {
  0: null,                    // domingo — fechado
  1: { abre: 7, fecha: 18 },  // segunda
  2: { abre: 7, fecha: 18 },  // terça
  3: { abre: 7, fecha: 18 },  // quarta
  4: { abre: 7, fecha: 18 },  // quinta
  5: { abre: 7, fecha: 18 },  // sexta
  6: { abre: 8, fecha: 13 },  // sábado
};

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function agoraBRT() {
  const agora = new Date();
  return new Date(agora.getTime() - 3 * 60 * 60 * 1000); // UTC-3 fixo (Brasil não tem mais horário de verão desde 2019)
}

// Retorna { aberto: true } se a loja está aberta agora, ou
// { aberto: false, proxima_abertura_texto: "hoje às 07:00" | "amanhã às 07:00" | "sábado às 08:00" }
function statusAgora() {
  const brt = agoraBRT();
  const diaSemana = brt.getUTCDay();
  const hora = brt.getUTCHours() + brt.getUTCMinutes() / 60;
  const horarioHoje = HORARIOS[diaSemana];

  if (horarioHoje && hora >= horarioHoje.abre && hora < horarioHoje.fecha) {
    return { aberto: true };
  }

  // Procura a próxima abertura, olhando os próximos dias a partir de hoje
  for (let i = 0; i <= 7; i++) {
    const diaCandidato = (diaSemana + i) % 7;
    const horarioCandidato = HORARIOS[diaCandidato];
    if (!horarioCandidato) continue;
    if (i === 0 && hora >= horarioCandidato.abre) continue; // hoje já passou do horário de abrir

    const quando = i === 0 ? 'hoje' : i === 1 ? 'amanhã' : DIAS[diaCandidato];
    return {
      aberto: false,
      proxima_abertura_texto: `${quando} às ${String(horarioCandidato.abre).padStart(2, '0')}:00`,
    };
  }

  return { aberto: false, proxima_abertura_texto: 'em breve' };
}

module.exports = { statusAgora };
