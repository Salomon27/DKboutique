const CACHE_NAME = 'dk-boutique-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map(key => caches.delete(key)));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Contournement total du cache pour forcer la mise à jour
  event.respondWith(
    fetch(event.request).catch(() => {
      return new Response("Hors-ligne et cache vidé.", { status: 503 });
    })
  );
});
