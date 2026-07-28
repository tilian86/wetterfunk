/* Wetterfunk — Service Worker
   Programmhülle offline verfügbar halten. Wetterdaten kommen immer frisch
   aus dem Netz; nur bei Netzausfall greift die letzte Antwort aus dem Cache. */

// Bei jeder Auslieferung hochzählen — sonst behalten Geräte die alte
// Programmhülle im Cache und sehen Korrekturen nicht.
const VERSION = 'wetterfunk-v15';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/icons.js',
  './js/radar.js',
  './js/forecast.js',
  './js/briefing.js',
  './js/news.js',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Fremde Dienste (Wetter, Radar, Karte, Webcams) nie aus dem Cache bedienen
  if (url.origin !== self.location.origin) return;

  // Programmhülle: erst Netz, bei Ausfall Cache
  e.respondWith(
    fetch(request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then(r => r || caches.match('./index.html')))
  );
});
