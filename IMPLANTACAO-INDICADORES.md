# Implantação da rota de indicadores (checklist — NÃO executado)

Preparado na Etapa 3E só com informações do repositório. Nada aqui foi
feito no Railway. Itens marcados **(confirmar)** dependem do painel ou da
documentação do Railway e precisam ser verificados por quem tem acesso.

## O que muda nesta instalação

- Código: `indicadores-vendas.js` (novo) e 4 linhas no `server.js` (monta a
  rota e registra um log de inicialização). Nenhuma outra rota muda.
- Banco: nenhuma migração, nenhuma escrita. A rota só lê `leads` e `mensagens`.
- Comportamento sem configuração: a rota responde 404 (sem `SETOR=vendas`
  explícito) ou 503 (sem token). O atendimento não depende dela.

## Variáveis

| Serviço | Variável | Valor |
| --- | --- | --- |
| Vendas | `SETOR` | `vendas` — **explícita** (hoje o sistema funciona como Vendas mesmo sem ela; a rota não) |
| Vendas | `INDICADORES_VENDAS_TOKEN` | novo, aleatório, ≥ 32 caracteres (recomendado: 48 bytes em base64url, gerado offline, guardado em cofre de senhas) |
| Financeiro / Expedição | — | **não** criar `INDICADORES_VENDAS_TOKEN` |
| Scob 3D (quando a autenticação estiver decidida) | `VENDAS_API_URL` | `https://<domínio da instalação de Vendas>` |
| Scob 3D | `VENDAS_API_HOSTS_PERMITIDOS` | o mesmo host (com `:porta` se houver) |
| Scob 3D | `VENDAS_INDICADORES_TOKEN` | o mesmo valor do token de Vendas |

Variáveis existentes que não mudam: `DATA_DIR`, `PORT`, `ZAPI_*`,
`RELATORIO_TOKEN`, `ANTHROPIC_API_KEY`, `BOAS_VINDAS_AUTOMATICA`,
`BACKUP_MANTER_DIAS`.

## Identificar a instalação de Vendas (sem consultar dados)

1. No serviço, a aba de variáveis deve mostrar `SETOR=vendas` escrito
   (não só "ausente"). **(confirmar no painel)**
2. O log de inicialização mostra `setor "vendas"` na linha
   `Servidor rodando em ...`. Depois do deploy, também
   `Indicadores de Vendas (Scob 3D): rota ativa`.
3. O `ZAPI_INSTANCE_ID` do serviço é o da instância do WhatsApp de Vendas no
   painel da Z-API (o código recusa webhooks de outra instância).
4. O `RELATORIO_TOKEN` é diferente em cada serviço; não confundir com o token
   novo.
5. No serviço do Financeiro, o mesmo log deve mostrar
   `rota inativa (SETOR=vendas não está definido explicitamente)`.

## Antes do deploy

- [ ] Autorização explícita para a implantação.
- [ ] `npm test` no branch `feat/indicadores-vendas` (19 testes).
- [ ] Revisão do diff contra `main` (só `indicadores-vendas.js`, `server.js`,
      testes e documentação).
- [ ] Confirmar o horário comercial (hoje: seg–sex 7h–18h, sáb 8h–13h,
      domingo fechado, sem feriados).
- [ ] Verificar o backup automático mais recente do volume (`backup.js`, diário).
- [ ] Escolher horário fora do expediente (domingo, depois das 18h em dia útil
      ou depois das 13h no sábado):
  - as sessões dos vendedores ficam em memória (`auth.js`): todos precisam
    entrar de novo após o reinício;
  - o controle de eco de mensagens enviadas também é em memória
    (`zapi.foiEnviadaPorNos`);
  - com volume persistente, o serviço provavelmente fica indisponível por
    alguns instantes durante a troca **(confirmar)**; mensagens que chegarem
    da Z-API nesse intervalo dependem do reenvio da Z-API **(confirmar)**.
- [ ] Seed: o `server.js` só importa `seed-vendas.sqlite` se o banco do volume
      estiver vazio (0 conversas). O banco de produção tem conversas, então o
      seed é ignorado — conferir no log a linha `seed ignorado` ou a ausência
      de `Histórico importado`.

## Deploy (ordem sugerida)

1. Cadastrar `INDICADORES_VENDAS_TOKEN` e confirmar `SETOR=vendas` no serviço
   de Vendas. Mudanças de variável podem disparar um novo deploy
   **(confirmar)** — se sim, fazer junto com o passo 2 para reiniciar uma vez só.
2. Publicar o código: merge de `feat/indicadores-vendas` em `main` e push
   (ou o fluxo de deploy configurado no Railway **(confirmar qual branch o
   serviço acompanha)**). O `railway.json` usa Nixpacks, `npm start` e
   reinício automático em falha (até 5 vezes).
3. Acompanhar o log de inicialização (itens da seção "Identificar").

## Validação depois da publicação

De uma máquina confiável, sem colar o token em chats, tickets ou logs:

- [ ] Sem token: `401` com `{"erro":"nao_autorizado"}`.
- [ ] Com token: `200`, `Cache-Control: no-store`, corpo só com os campos do
      contrato v1, `setor: "vendas"`, `gerado_em` com `-03:00`.
- [ ] Tempo de resposta (ex.: `curl -w "%{time_total}"`): anotar; acima de 1 s,
      investigar antes de ligar o Scob.
- [ ] Conferir "Finalizadas hoje" com a tela de Histórico/Progresso (lembrando
      que o Progresso agrupa por dia UTC e inclui grupos).
- [ ] Mesmo token no endereço do Financeiro: `404`.
- [ ] Atendimento: abrir o painel, receber e responder uma conversa normalmente.

## Reverter

- A mudança é aditiva e não toca o banco: voltar ao deploy anterior no
  histórico de deploys do Railway **(confirmar o nome da ação no painel)** ou
  `git revert` do merge em `main` + novo deploy.
- Para só desligar a rota sem reverter código: remover
  `INDICADORES_VENDAS_TOKEN` (a rota passa a responder 503) — exige reinício.
- Se o token vazar: gerar outro, trocar nos dois serviços (Vendas e Scob) e
  reiniciar.
