# Implantação da rota de indicadores (checklist — NÃO executado)

Preparado nas Etapas 3E–3G só com informações do repositório. Nada aqui foi
feito no Railway nem no Cloudflare. Itens marcados **(confirmar)** dependem
do painel ou da documentação do Railway/Cloudflare e precisam ser verificados
por quem tem acesso. A implantação só começa com autorização explícita.

**Ordem entre os sistemas** (detalhada em `IMPLANTACAO.md` do Scob 3D
Operations): Fase 1, Scob com Cloudflare Access e sem dados de Vendas; Fase 2,
este checklist; Fase 3, conectar o Scob. Os indicadores nunca ficam
acessíveis antes de a autenticação do Scob estar validada.

## O que muda nesta instalação

- Código: `indicadores-vendas.js` (novo) e 3 linhas no `server.js` (monta a
  rota e registra um log de inicialização). Nenhuma outra rota muda.
- Banco: nenhuma migração, nenhuma escrita. A rota só lê `leads` e `mensagens`.
- Comportamento sem configuração: a rota responde 404 (sem `SETOR=vendas`
  explícito) ou 503 (sem token). O atendimento não depende dela.

## 1. Variáveis

| Serviço | Variável | Valor |
| --- | --- | --- |
| Vendas | `SETOR` | `vendas` — **explícita** (hoje o sistema funciona como Vendas mesmo sem ela; a rota não) |
| Vendas | `INDICADORES_VENDAS_TOKEN` | novo, aleatório: 48 bytes em base64url (ex.: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`), gerado offline, guardado em cofre de senhas |
| Financeiro / Expedição | — | **não** criar `INDICADORES_VENDAS_TOKEN` |
| Scob 3D | `VENDAS_API_URL` | `https://<domínio da instalação de Vendas>` (sem caminho) |
| Scob 3D | `VENDAS_API_HOSTS_PERMITIDOS` | o mesmo host (com `:porta` se houver) |
| Scob 3D | `VENDAS_INDICADORES_TOKEN` | o mesmo valor do token de Vendas |
| Scob 3D | `CF_ACCESS_TEAM_DOMAIN` | `https://<equipe>.cloudflareaccess.com` |
| Scob 3D | `CF_ACCESS_AUD` | "Application Audience (AUD) Tag" da aplicação no Cloudflare Access |
| Scob 3D | `CF_ACCESS_CHAVES_TESTE_ARQUIVO` | **não** criar em produção (só testes locais; ignorada fora de `next dev`) |

Variáveis existentes de Vendas que não mudam: `DATA_DIR`, `PORT`, `ZAPI_*`,
`RELATORIO_TOKEN`, `ANTHROPIC_API_KEY`, `BOAS_VINDAS_AUTOMATICA`,
`BACKUP_MANTER_DIAS`.

Ordem obrigatória no Scob: `CF_ACCESS_*` **antes** das `VENDAS_*`. Em
produção, sem o Access válido, o Scob inteiro responde 503 — não há como
expor os indicadores sem autenticação.

## 2. Identificar a instalação de Vendas (sem consultar dados)

Todos os itens precisam bater; se um divergir, parar.

1. Na aba de variáveis do serviço, `SETOR=vendas` aparece **escrito** (não só
   "ausente"). **(confirmar no painel)**
2. O log de inicialização mostra `setor "vendas"` na linha
   `Servidor rodando em ...`.
3. O `ZAPI_INSTANCE_ID` do serviço é o da instância do WhatsApp de **Vendas**
   no painel da Z-API (o código recusa webhooks de outra instância).
4. O webhook "Ao receber" da instância de Vendas na Z-API aponta para
   `https://<domínio deste serviço>/webhook/zapi` (sem `/financeiro` ou
   `/expedicao`).
5. O `RELATORIO_TOKEN` é diferente em cada serviço; não confundir com o token
   novo.
6. No serviço do Financeiro, o log mostra
   `Indicadores de Vendas (Scob 3D): rota inativa (SETOR=vendas não está definido explicitamente)`.

## 3. Verificar `SETOR=vendas`

- Antes do deploy: variável escrita no painel (item 2.1).
- Depois do deploy, no log: `setor "vendas"` **e**
  `Indicadores de Vendas (Scob 3D): rota ativa`.
- `rota inativa (SETOR...)` no serviço de Vendas = variável ausente ou
  diferente: corrigir antes de continuar.
- Depois de ligado: consulta com token no endereço do Financeiro = `404`.

## 4. Backup

O `backup.js` já faz uma cópia diária (e a cada início) com `VACUUM INTO` em
`DATA_DIR/backups/`, guardando `BACKUP_MANTER_DIAS` (padrão 7). **Limite:** a
cópia fica no mesmo volume — se o volume se perder, o backup vai junto.

- [ ] No dia, antes do deploy: conferir no log o backup do dia ou gerar um na
      hora em `GET /api/admin/backup` (login de administrador no painel de
      Vendas).
- [ ] Guardar essa cópia **fora** do volume, como dado pessoal sensível
      (conversas e telefones de clientes): local com acesso restrito e
      criptografado, nunca em chat, e-mail ou repositório; apagar ao fim do
      prazo de guarda combinado.
- [ ] Se o plano do Railway oferecer backup/snapshot do volume, fazer um
      antes do deploy. **(confirmar disponibilidade)**
- A mudança não escreve no banco: o backup é precaução para o reinício, não
  para uma migração.

## 5. Janela de manutenção

- Fora do expediente atual: domingo, dia útil depois das 18h ou sábado depois
  das 13h. Avisar os vendedores antes.
- Motivos:
  - as sessões dos vendedores ficam em memória (`auth.js`): todos precisam
    entrar de novo após o reinício;
  - o controle de eco de mensagens enviadas também é em memória
    (`zapi.foiEnviadaPorNos`);
  - com volume persistente, o serviço fica indisponível por alguns instantes
    durante a troca (documentação do Railway: um só deploy ativo por volume,
    mesmo com healthcheck; duração **(confirmar)**); mensagens que chegarem
    da Z-API nesse intervalo dependem do reenvio da Z-API **(confirmar)**.
- Duração estimada: 30 min (deploy + validações das seções 7 e 8), com mais
  30 min reservados para reverter.
- Mudança de variável pode disparar um deploy **(confirmar)**: cadastrar as
  variáveis e publicar o código na mesma janela, para reiniciar uma vez só.

## 6. Deploy (ordem)

1. Autorização explícita para a implantação.
2. `npm test` no branch `feat/indicadores-vendas` (20 testes) e revisão do
   diff contra `main` (só `indicadores-vendas.js`, `server.js`, testes e
   documentação).
3. Horário comercial confirmado (hoje: seg–sex 7h–18h, sáb 8h–13h, domingo
   fechado, sem feriados).
4. Backup (seção 4).
5. Variáveis do serviço de Vendas (seção 1).
6. Publicar o código: merge de `feat/indicadores-vendas` em `main` e push (ou
   o fluxo configurado no Railway — **confirmar qual branch o serviço
   acompanha**). O `railway.json` usa Nixpacks, `npm start` e reinício
   automático em falha (até 5 vezes).
7. Log de inicialização (seções 2 e 3). Seed: com o banco de produção cheio,
   o `seed-vendas.sqlite` é ignorado — não pode aparecer `Histórico importado`.
8. WhatsApp (seção 7) e indicadores (seção 8).
9. Só depois, Fase 3 do `IMPLANTACAO.md` do Scob (que já deve estar com o
   Cloudflare Access validado na Fase 1): variáveis `VENDAS_*` e redeploy.

## 7. WhatsApp depois do deploy

- [ ] Painel da Z-API: instância de Vendas **conectada**.
- [ ] Painel de Vendas: entrar como vendedor (login novo, sessões zeradas).
- [ ] De um celular de teste da equipe (não de cliente), enviar uma mensagem
      ao número de Vendas: aparece no painel em poucos segundos.
- [ ] Responder pelo painel: a resposta chega ao celular de teste e não volta
      duplicada como mensagem do vendedor.
- [ ] Se `BOAS_VINDAS_AUTOMATICA` estiver ligada: a boas-vindas chega uma vez só.
- [ ] Mídia: enviar uma foto do celular de teste e conferir que ela abre no painel.
- [ ] Encerrar a conversa de teste.
- [ ] Log sem erros repetidos de webhook nos primeiros 15 min.
- Qualquer falha aqui → reverter (seção 9) antes de investigar.

## 8. Indicadores depois do deploy

De uma máquina confiável, sem colar o token em chats, tickets ou logs:

- [ ] Sem token: `401` com `{"erro":"nao_autorizado"}`.
- [ ] Com token: `200`, `Cache-Control: no-store`, corpo só com os campos do
      contrato v1, `setor: "vendas"`, `gerado_em` com `-03:00`.
- [ ] Tempo de resposta (ex.: `curl -w "%{time_total}"`): anotar; acima de 1 s,
      investigar antes de ligar o Scob.
- [ ] "Finalizadas hoje" confere com a tela de Histórico/Progresso (o
      Progresso agrupa por dia UTC e inclui grupos).
- [ ] O mesmo token no endereço do Financeiro: `404`.
- [ ] No Scob (depois do passo 6.9): pelo endereço oficial, login do Access e
      painel com "Dados reais"; pelo endereço direto da hospedagem do Scob,
      `401`; numa janela anônima sem login, a tela do Access.
- [ ] O Scob consulta este serviço pelo endereço **público HTTPS**: endereços
      internos do Railway (`*.railway.internal`) são recusados pelo Scob.

## 9. Reverter

- Gatilhos: WhatsApp sem receber ou enviar, erro de inicialização, `SETOR`
  errado no log, `Histórico importado` no log, lentidão no painel de Vendas.
- Só desligar a rota, sem reverter código: remover `INDICADORES_VENDAS_TOKEN`
  (a rota passa a responder 503) — exige reinício.
- Reverter o código: voltar ao deploy anterior no histórico de deploys do
  Railway **(confirmar o nome da ação no painel)**, ou `git revert` do merge
  em `main` + novo deploy. A mudança é aditiva e não toca o banco: não há
  dado a desfazer.
- Banco danificado por outro motivo (não esperado): restaurar o backup da
  seção 4 conforme o procedimento do `backup.js`/Railway **(confirmar)**.
- No Scob: remover `VENDAS_*` desliga a integração (rota 404 em produção sem
  configuração); o Access continua protegendo o app. Remover as `CF_ACCESS_*`
  **não** reabre o Scob: ele passa a responder 503.
- Se o token vazar: gerar outro, trocar nos dois serviços (Vendas e Scob) e
  reiniciar.
