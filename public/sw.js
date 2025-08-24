const CACHE_NAME = 'dognet-shell-v1';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/login.html',
  '/registration.html',
  '/manifest.json'
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => {/* ignore */})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); })))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evt) => {
  // Network-first for API calls, cache-first for shell
  const url = new URL(evt.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/nearby') || url.pathname.startsWith('/locations') || url.pathname.startsWith('/dog') || url.pathname.startsWith('/user')) {
    // network-first
    evt.respondWith(fetch(evt.request).catch(() => caches.match(evt.request)));
    return;
  }

  evt.respondWith(caches.match(evt.request).then(r => r || fetch(evt.request)));
});
