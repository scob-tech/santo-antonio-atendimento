# Indicadores de Vendas para o Scob 3D Operations

Rota somente leitura que entrega ao Scob 3D Operations os números agregados do
atendimento de Vendas. Código em `indicadores-vendas.js`, testes em
`test/indicadores-vendas.test.js` (`npm test`, só dados fictícios).

## Contrato HTTP (v2)

```
GET /api/externo/indicadores-vendas
Authorization: Bearer <INDICADORES_VENDAS_TOKEN>
```

Resposta `200` (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`),
exatamente três indicadores do dia de Brasília:

```json
{
  "versao": 2,
  "setor": "vendas",
  "gerado_em": "2026-11-03T15:00:00-03:00",
  "encerradas_hoje": 12,
  "primeira_resposta": { "media_min": 15, "amostras": 9, "sem_resposta": 2 },
  "tempo_resposta": { "media_min": 8.8, "amostras": 41, "sem_resposta": 3 }
}
```

- `media_min`: média em minutos de expediente, 1 casa decimal; **`null` sem
  amostras** (nunca 0 por falta de dados).
- `amostras`: esperas respondidas hoje usadas na média.
- `sem_resposta`: esperas em andamento agora (fora da média).

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
"Hoje" é o dia de **Brasília** (UTC−3 fixo, igual ao `horario.js`), da 00:00
até agora; o banco guarda UTC. Mensagens posteriores a "agora" são ignoradas.

**Mensagens consideradas** — só `cliente` e `vendedor` (humano: painel,
resposta manual pelo celular, encaminhamento, figurinha). `ia` (automática) e
`nota` (interna) são ignoradas: não abrem nem respondem espera.

**Espera** — começa na primeira mensagem do cliente depois da última resposta
humana (ou do início do ciclo); mensagens seguintes do cliente não reiniciam o
relógio. Termina na próxima mensagem `vendedor`. Duração em minutos de
expediente (`horario.minutosUteis`): noite, domingo e sábado à tarde não contam.

**Ciclo de atendimento** — começa na criação da conversa ou na primeira
mensagem depois do último encerramento registrado (`encerrado_em`), quando a
conversa foi reaberta. Uma espera em aberto no encerramento termina sem
resposta e não passa para o ciclo seguinte.

1. **`encerradas_hoje`** — conversas com `status = 'encerrado'` e
   `encerrado_em` no dia de Brasília.
2. **`primeira_resposta`** — média das **primeiras esperas respondidas** de
   cada ciclo cuja resposta humana ocorreu hoje.
3. **`tempo_resposta`** — média de **todas** as esperas respondidas (incluindo
   a primeira) cuja resposta humana ocorreu hoje.

**Sem resposta** — esperas em andamento agora, em conversas abertas (não
encerradas): `tempo_resposta.sem_resposta` conta todas;
`primeira_resposta.sem_resposta` só as que são a primeira do ciclo. Ficam fora
das médias. Conversa encerrada com espera pendente não conta.

## Conversas reabertas

O sistema reabre a conversa no mesmo lead (cliente volta a escrever, vendedor
escreve ou usa "reabrir"); não há histórico de eventos.

- Ao reabrir, `encerrado_em` fica com o valor antigo, mas o status sai de
  `encerrado`: a conversa **deixa de contar** como encerrada hoje até ser
  encerrada de novo.
- Ao encerrar de novo, `encerrado_em` é sobrescrito: a conversa conta **uma
  vez**, pelo último encerramento.
- A primeira mensagem depois do último encerramento abre um novo ciclo: a
  primeira espera respondida dele volta a ser "primeira resposta".
  Reaberturas anteriores ao último encerramento não são distinguidas
  (limitação aceita, sem mudança de esquema): numa conversa encerrada e
  reaberta várias vezes, esperas de ciclos antigos contam como seguintes.

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
- `tempo_resposta` desta rota segue a mesma ideia do Histórico (cada espera
  até a resposta humana), mas agrupa pelo dia de Brasília da resposta, não
  pelas últimas 48 h; `primeira_resposta` só considera a primeira espera
  respondida de cada ciclo. Os números não devem bater com o Relatório de Uso.
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
