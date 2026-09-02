/* Wetterfunk — Service Worker
   Programmhülle offline verfügbar halten. Wetterdaten kommen immer frisch
   aus dem Netz; nur bei Netzausfall greift die letzte Antwort aus dem Cache. */

// Bei jeder Auslieferung hochzählen — sonst behalten Geräte die alte
// Programmhülle im Cache und sehen Korrekturen nicht.
const VERSION = 'wetterfunk-v224';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/icons.js',
  './js/radar.js',
  './js/forecast.js',
  './js/briefing.js',
  './js/kueste.js',
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

/* Ein hängendes Mobilfunknetz ist schlimmer als gar keins: `fetch` meldet
   dann keinen Fehler, sondern wartet ewig — die App blieb weiß. Nach dieser
   Frist wird deshalb die gespeicherte Fassung gezeigt, falls es eine gibt. */
const NETZ_FRIST = 4000;

/** Passende Ablage suchen. Zweiter Versuch ohne `?v=` — die vorab gespeicherte
    Schale liegt ohne Versionsmarke da, angefragt wird sie aber mit. */
async function ausAblage(request) {
  return (await caches.match(request)) ||
         (await caches.match(request, { ignoreSearch: true }));
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Fremde Dienste (Wetter, Radar, Karte, Webcams) nie aus dem Cache bedienen
  if (url.origin !== self.location.origin) return;

  // Programmhülle: erst Netz, bei Ausfall oder Hänger die Ablage
  e.respondWith((async () => {
    const ausNetz = fetch(request).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(request, copy)).catch(() => {});
      return res;
    });

    let bremse;
    const frist = new Promise(ok => { bremse = setTimeout(() => ok('spaet'), NETZ_FRIST); });

    try {
      const erster = await Promise.race([ausNetz.catch(() => 'weg'), frist]);
      clearTimeout(bremse);
      if (erster !== 'spaet' && erster !== 'weg') return erster;

      const gespeichert = await ausAblage(request);
      if (gespeichert) return gespeichert;
      if (erster === 'spaet') return await ausNetz;   // nichts da — dann eben warten
      throw new Error('offline');
    } catch {
      clearTimeout(bremse);
      const gespeichert = await ausAblage(request);
      if (gespeichert) return gespeichert;
      /* Nur echte Seitenaufrufe dürfen auf die Startseite ausweichen. Vorher
         bekam auch ein fehlendes Skript das HTML zurück — der Browser wollte
         es als JavaScript lesen und die App war kaputt statt nur unvollständig. */
      if (request.mode === 'navigate') {
        return (await caches.match('./index.html')) || Response.error();
      }
      return Response.error();
    }
  })());
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
