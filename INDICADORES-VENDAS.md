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
| `INDICADORES_VENDAS_TOKEN` ausente ou com menos de 32 caracteres | 503 | `{"erro":"nao_configurado"}` |
| token ausente, errado, fora do formato `Bearer` | 401 + `WWW-Authenticate: Bearer` | `{"erro":"nao_autorizado"}` |
| mais de 10 tentativas inválidas por minuto do mesmo endereço de conexão | 429 + `Retry-After` | `{"erro":"muitas_tentativas"}` |
| mais de 30 consultas **autorizadas** por minuto | 429 + `Retry-After` | `{"erro":"muitas_requisicoes"}` |
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

## Limite de requisições e proxy

Duas cotas separadas, em memória (janela fixa de 1 minuto, zeram quando o
serviço reinicia):

| Cota | Quem consome | Limite | Chave |
| --- | --- | --- | --- |
| autorizadas | só consultas com o token **válido** | 30/min | uma só para a integração |
| falhas | token ausente, errado ou malformado | 10/min | `req.ip` (endereço da conexão) |

- O token é verificado **antes** de qualquer contagem: tentativas inválidas
  nunca consomem a cota da integração, e o token certo continua aceito mesmo
  com a cota de falhas esgotada.
- `trust proxy` **não** está habilitado: `X-Forwarded-For` enviado pelo cliente
  é ignorado e não cria cotas novas. Atrás do proxy de entrada do Railway,
  `req.ip` é o endereço do proxy, então a cota de falhas é uma só para todos os
  clientes — o que só bloqueia outras tentativas inválidas.
- A tabela de falhas guarda no máximo 1.000 endereços (sem crescimento
  ilimitado quando não há proxy à frente).

Validado com proxy reverso local que acrescenta `X-Forwarded-For` (Etapa 3E):
20 tentativas inválidas de um "cliente" esgotaram a cota de falhas (429) e, em
seguida, a consulta com o token certo de outro "cliente" foi aceita (200).
Antes da correção (Etapa 3D.3), a mesma sequência bloqueava a consulta legítima.

Limitações:
- Durante o bloqueio, uma tentativa com o token certo ainda é aceita — não
  há como separar o cliente legítimo sem verificar o token. A proteção contra
  adivinhação é o tamanho do token (≥ 32 caracteres aleatórios; recomendado
  48 bytes em base64url, ~384 bits); a cota de falhas só reduz o volume.
- Sem `trust proxy`, não há limite de falhas por cliente real atrás do proxy.
  Habilitar `trust proxy` só com evidência do número real de proxies à frente
  do serviço (um valor maior que o real permitiria forjar o IP).
- As cotas são por processo: com mais de uma réplica, cada uma conta à parte
  (testado: a cota esgotada numa instância não vale na outra).

### Várias instâncias

- Hoje o serviço tem **uma** instância: o banco SQLite fica num volume
  persistente, e as sessões dos vendedores e o controle de eco também ficam
  em memória — o sistema inteiro já supõe um processo só. Com volume, o Railway
  mantém um só deploy ativo por serviço (documentação do Railway), então não
  há réplicas.
- Com N instâncias, os limites efetivos viram N × 30 consultas autorizadas e
  N × 10 tentativas inválidas por minuto. Para a integração isso não muda
  nada (o Scob consulta no máximo ~6 vezes por minuto, com reaproveitamento de
  10 s), e a proteção contra adivinhação continua sendo o tamanho do token.
- Um reinício zera as cotas (no máximo +10 tentativas por reinício).
- Por isso **não** há Redis nem outro armazenamento compartilhado: só se
  justificaria se o serviço passasse a ter réplicas E o limite global se
  tornasse necessário.

### Revisão da Etapa 3F

Conferido no código e nos testes:
- tentativas inválidas só consomem a cota de falhas; o token válido é aceito
  mesmo com ela esgotada (testes "tentativas inválidas..." e "atrás de proxy
  reverso");
- a cota de consultas válidas devolve 429 `muitas_requisicoes` com
  `Retry-After` depois do máximo e reabre na janela seguinte;
- nenhum `app.set('trust proxy')` no projeto; `X-Forwarded-For` forjado não
  cria cotas (teste "X-Forwarded-For forjado...").

## Horário comercial (pendente de confirmação)

A primeira resposta e a maior espera usam **provisoriamente** a regra do
`horario.js`, sem alteração nas fórmulas:

- segunda a sexta: 07:00 às 18:00;
- sábado: 08:00 às 13:00;
- domingo: fechado;
- feriados: ainda não considerados.

Essa regra **precisa ser confirmada** pelo Depósito Santo Antônio antes da
implantação (ver divergências acima).

## Limitações gerais

- A rota não foi executada contra dados reais: valores e desempenho com o
  volume de produção não foram medidos.
