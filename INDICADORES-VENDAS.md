# Indicadores de Vendas para o Scob 3D Operations

Rota somente leitura que entrega ao Scob 3D Operations os números agregados do
atendimento de Vendas. Código em `indicadores-vendas.js`, testes em
`test/indicadores-vendas.test.js` (`npm test`, só dados fictícios).

## Contrato HTTP (v1)

```
GET /api/externo/indicadores-vendas
Authorization: Bearer <INDICADORES_VENDAS_TOKEN>
```

Resposta `200` (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`):

```json
{
  "versao": 1,
  "setor": "vendas",
  "gerado_em": "2026-11-03T15:00:00-03:00",
  "finalizadas": { "hoje": 1, "mes": 2 },
  "aguardando_resposta": { "total": 2, "espera_mais_antiga_min": 120 },
  "primeira_resposta_hoje": { "media_min": 17.3, "amostras": 3, "sem_resposta": 1 }
}
```

| Situação | Status | Corpo |
| --- | --- | --- |
| `SETOR` diferente de `vendas`, ou **ausente** | 404 | `{"erro":"nao_encontrado"}` |
| mais de 20 requisições por minuto do mesmo IP | 429 + `Retry-After` | `{"erro":"muitas_requisicoes"}` |
| `INDICADORES_VENDAS_TOKEN` ausente ou com menos de 32 caracteres | 503 | `{"erro":"nao_configurado"}` |
| token ausente, errado, fora do formato `Bearer` | 401 + `WWW-Authenticate: Bearer` | `{"erro":"nao_autorizado"}` |
| falha ao calcular | 500 | `{"erro":"falha_interna"}` |

Parâmetros de URL são ignorados: não existe seleção de setor nem de instalação.

## Configuração (não feita nesta etapa)

- `SETOR=vendas` **definido explicitamente**. O resto do sistema assume
  `vendas` quando a variável falta; esta rota não: sem ela, 404. Isso evita
  que outra instalação sem `SETOR` configurado exponha a rota por engano.
- `INDICADORES_VENDAS_TOKEN`: valor aleatório longo (ex.: 48 bytes em base64),
  exclusivo desta integração, diferente do `RELATORIO_TOKEN`. Guardado só nas
  variáveis do serviço de Vendas e no servidor do Scob, nunca no navegador ou
  no repositório.
- Tráfego somente por HTTPS.

## Fórmulas

Todas as contagens excluem grupos (`is_grupo = 1`) e usam só o setor Vendas.
"Hoje" e "mês" são o dia e o mês de **Brasília** (UTC−3 fixo, igual ao
`horario.js`); o banco guarda UTC.

**Finalizadas hoje / no mês** — conversas com `status = 'encerrado'` cujo
`encerrado_em` está entre o início do dia (ou do mês) de Brasília e agora.

**Aguardando resposta** — conversas não encerradas cuja última mensagem
relevante (`cliente` ou `vendedor`) é do cliente. `ia` (boas-vindas
automática) e `nota` (nota interna) são ignoradas. `espera_mais_antiga_min`:
maior espera atual, contada da primeira mensagem do cliente ainda sem resposta
humana até agora, em minutos de expediente.

**Primeira resposta de hoje** — para cada conversa em que o cliente escreveu
hoje: do começo da espera que contém a primeira mensagem do cliente no dia
(pode ter começado em dia anterior) até a primeira mensagem `vendedor` depois
dela, em minutos de expediente (`horario.minutosUteis`). Mensagens da IA não
contam como resposta.
- `media_min`: média dessas esperas (1 casa decimal); `null` sem amostras.
- `amostras`: conversas respondidas.
- `sem_resposta`: conversas em que o cliente escreveu hoje e ninguém respondeu ainda.

## Conversas reabertas

O sistema reabre a conversa no mesmo lead (cliente volta a escrever, vendedor
escreve ou usa "reabrir"); não há histórico de eventos.

- Ao reabrir, `encerrado_em` fica com o valor antigo, mas o status sai de
  `encerrado`: a conversa **deixa de contar** como finalizada até ser
  encerrada de novo.
- Ao encerrar de novo, `encerrado_em` é sobrescrito: a conversa conta **uma
  vez**, na data do último encerramento. Encerramentos anteriores no mesmo mês
  não são somados (subcontagem possível).
- Na primeira resposta, a mensagem do cliente que reabre a conversa conta como
  a primeira do dia, como qualquer outra.

## Horário comercial: divergências encontradas

A regra do `horario.js` foi usada como **hipótese inicial**. O sistema tem
hoje três regras diferentes:

| Onde | Expediente | Feriados | O que mede |
| --- | --- | --- | --- |
| `horario.js` (`minutosUteis`), usado no card "Tempo médio de resposta" do Histórico e nesta rota | seg–sex 07–18, sáb 08–13 | não | — |
| `/api/indicadores/tempo-resposta` (Histórico) | `horario.js` | não | **toda** resposta (cada sequência do cliente até a próxima mensagem do vendedor), respostas das últimas 48 h, IA não conta, grupos fora |
| `/relatorio-uso` (página do admin) | **seg–sex 08–18, sem sábado** (`minutosComerciaisEntre`) | não | só a primeira mensagem do cliente de **toda a história** do lead, e **a IA conta como resposta**; descarta esperas ≥ 24 h de expediente |

Consequências:
- Uma resposta às 07:30 ou no sábado conta no Histórico e nesta rota, mas não
  no Relatório de Uso.
- O Relatório de Uso tende a mostrar tempos muito menores, porque a boas-vindas
  automática conta como resposta.
- Esta rota mede só a primeira resposta humana **do dia** por conversa, então
  não deve bater com nenhum dos dois.
- **Decisão pendente:** confirmar o expediente oficial (incluindo sábado e
  feriados) antes de consolidar a fórmula.

Outra divergência: o gráfico de Progresso agrupa encerramentos por dia **UTC**
(um encerramento às 22:00 de Brasília cai no dia seguinte) e inclui grupos;
esta rota usa o dia de Brasília e exclui grupos.

## Limitações

- Sem histórico de eventos: reaberturas e encerramentos repetidos não são
  reconstruídos (ver acima).
- A mensagem humana é identificada por `remetente = 'vendedor'`. Respostas
  manuais pelo celular contam como humanas. O eco de uma mensagem automática
  só é reconhecido pela memória do processo (`foiEnviadaPorNos`): se chegar
  depois de um reinício, pode ser gravado como `vendedor` e contar como
  resposta humana.
- Mensagens apagadas (`apagada = 1`) continuam contando como resposta.
- A busca das mensagens de hoje supõe que o `id` cresce com o tempo (mesma
  suposição do Histórico); importações fora de ordem cronológica podem esconder
  mensagens.
- Feriados não são considerados.
- O limite de requisições é por IP e em memória. Atrás de proxy sem `trust
  proxy`, todos os clientes compartilham o mesmo limite, e ele zera quando o
  serviço reinicia.
- A rota não foi executada contra dados reais: valores e desempenho com o
  volume de produção não foram medidos.
