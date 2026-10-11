// Caches the app shell only. The glasses' link is slow, so launch paints from
// cache. One versioned set, served cache-first: mixing new scripts with old
// HTML kills the app at start. Bump CACHE with every release.
const PREFIX = 'signalglass-';
const CACHE = PREFIX + 'v1';
const SHELL = ['./', './app.css', './config.js', './ui.js', './demo.js', './app.js',
  './manifest.webmanifest', './icon-96.png', './icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache:"reload" so a new worker never fills its cache from stale HTTP-cached files.
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // The host is shared with other apps: only ever delete our own caches.
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // API calls go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;
  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(request, { ignoreSearch: true }))
      .then((cached) => cached || fetch(request)),
  );
});
