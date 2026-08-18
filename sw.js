/* Wetterfunk — Service Worker
   Programmhülle offline verfügbar halten. Wetterdaten kommen immer frisch
   aus dem Netz; nur bei Netzausfall greift die letzte Antwort aus dem Cache. */

// Bei jeder Auslieferung hochzählen — sonst behalten Geräte die alte
// Programmhülle im Cache und sehen Korrekturen nicht.
const VERSION = 'wetterfunk-v177';
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

/* ── Meldungen vom Worker ───────────────────────────────────
   Regen, amtliche Warnungen und Himmelstermine. Ohne diesen Empfänger
   zeigt iOS nur eine leere Standardmeldung. */
self.addEventListener('push', (e) => {
  let d = { titel: 'Wetterfunk', text: 'Es zieht Regen auf.' };
  try { if (e.data) d = { ...d, ...e.data.json() }; } catch {}

  e.waitUntil(self.registration.showNotification(d.titel, {
    body: d.text,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    /* Jede Art bekommt eine eigene Kennung. Mit einer gemeinsamen ersetzte
       jede Meldung die vorige — ein Sonnenaufgang hätte eine noch offene
       Unwetterwarnung vom Bildschirm geschoben. */
    tag: d.tag || `wf-${d.art || 'regen'}`,
    renotify: true,
    data: { url: './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(liste => {
      for (const c of liste) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    })
  );
});
