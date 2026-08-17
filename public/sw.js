// sw.js
// Service Worker — roda em background, separado da aba do navegador.
// Duas funções:
//   1) NOTIFICAÇÃO PUSH: recebe o push do servidor mesmo com o app fechado
//      e mostra a notificação do sistema (mensagem nova, lead novo).
//   2) ATUALIZAÇÃO EM DIA: garante que todo deploy novo apareça na hora,
//      sem o app/navegador ficar preso numa versão antiga em cache — que
//      era o motivo de "subi o arquivo mas na tela continua igual".

self.addEventListener('install', () => {
  // Assume o controle assim que instala, sem esperar a aba antiga fechar.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Apaga qualquer cache que uma versão anterior possa ter deixado.
    try {
      if (self.caches && caches.keys) {
        const chaves = await caches.keys();
        await Promise.all(chaves.map((k) => caches.delete(k)));
      }
    } catch (e) { /* sem cache pra limpar — ok */ }

    await self.clients.claim();

    // Força um reload ÚNICO nas telas abertas pra puxarem o HTML novo.
    // Isso destrava aparelhos que estavam segurando uma versão velha em
    // cache (típico de PWA "Adicionar à Tela de Início"). Só acontece uma
    // vez, no momento em que uma versão nova do app entra no ar.
    try {
      const janelas = await self.clients.matchAll({ type: 'window' });
      for (const janela of janelas) {
        if ('navigate' in janela) janela.navigate(janela.url);
      }
    } catch (e) { /* se não der pra navegar, o fetch abaixo já garante o resto */ }
  })());
});

// Navegações (abrir/atualizar a página) sempre buscam o HTML fresco da rede,
// ignorando o cache do navegador — assim o app nunca mais fica preso numa
// versão antiga. As demais requisições (imagens, chamadas de API) seguem o
// comportamento padrão do navegador (não são interceptadas aqui).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'reload' }).catch(() => fetch(req))
    );
  }
});

// Chega um push do servidor (via web-push) — mostra a notificação do
// sistema operacional. O "payload" é o JSON que o server.js mandou.
self.addEventListener('push', (event) => {
  let dados = { titulo: 'Depósito Santo Antônio', corpo: 'Você tem uma atualização.', leadId: null };
  try {
    if (event.data) dados = { ...dados, ...event.data.json() };
  } catch {
    // payload não veio em JSON — usa os valores padrão acima
  }

  const opcoes = {
    body: dados.corpo,
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: dados.leadId ? `lead-${dados.leadId}` : 'geral', // evita empilhar 10 notificações do mesmo lead
    renotify: true,
    data: { leadId: dados.leadId || null },
  };

  event.waitUntil(self.registration.showNotification(dados.titulo, opcoes));
});

// Vendedor clicou na notificação — abre (ou foca) a aba do sistema já na
// conversa certa, em vez de só abrir a tela inicial.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const leadId = event.notification.data && event.notification.data.leadId;
  const destino = leadId ? `/?abrir_lead=${leadId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if ('focus' in janela) {
          janela.focus();
          if (leadId && 'postMessage' in janela) {
            janela.postMessage({ tipo: 'abrir_lead', leadId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(destino);
      }
    })
  );
});
