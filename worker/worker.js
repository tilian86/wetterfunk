/* Wetterfunk — Cloudflare Worker
   Aufgaben:
     1. /rss?url=…  holt RSS-Feeds (der Browser darf das wegen CORS nicht selbst)
     2. /ai         reicht Textanfragen an die Mac-Bridge weiter, die sie über
                    die Claude-CLI beantwortet — läuft damit über das Max-Abo
                    statt über bezahlte API-Tokens. Kein API-Schlüssel nötig.
     3. /dwdtext    amtlicher Regionalwetterbericht des DWD
     4. /push/*     Abos für Regenwarnungen; ein Zeitplan prüft alle 15 Minuten,
                    ob bei einem Abonnenten Regen aufzieht, und schickt eine
                    Benachrichtigung aufs Gerät.
     5. /tts        spricht Text mit einer KI-Stimme (xAI). Der Schlüssel bleibt
                    hier, der Browser sieht ihn nie; freigeschaltet wird mit
                    einem Kennwort. Erzeugte Audios liegen im Cache.

   Ist der Mac aus, meldet /ai das ehrlich zurück; es gibt bewusst keinen
   kostenpflichtigen Ausweichweg.

   Einrichten:
     wrangler deploy
     wrangler secret put BRIDGE_URL      # https://…ts.net
     wrangler secret put BRIDGE_SECRET   # gleiches Geheimnis wie in der Bridge
     wrangler secret put VAPID_PRIVATE   # privater Schlüssel für Web Push
     wrangler secret put XAI_API_KEY     # für die KI-Stimme (xAI/Grok)
     wrangler secret put TTS_PASSWORT    # schützt die Stimme vor fremder Nutzung
*/

import { sendPush } from './push.js';
import { sonnenTermine, mondTermine, mondPhase } from './himmel.js';
import { uebersicht } from './uebersicht.js';
import { taeglichePruefung, pruefVerlauf, pruefeOrt } from './pruefung.js';

// Nur diese Absender dürfen den Worker nutzen.
const ALLOWED_ORIGINS = [
  'https://tilian86.github.io',
  'http://localhost:8099'
];

// Feeds, die abgerufen werden dürfen — verhindert, dass der Worker
// zum offenen Proxy für beliebige Adressen wird.
const ALLOWED_FEED_HOSTS = [
  'www.swr.de',
  'www.tagesschau.de',
  'www.deutschlandfunk.de',
  'newsfeed.zeit.de',
  'rss.sueddeutsche.de'
];

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
  /* Ohne Vary legt der Browser die Antwort samt Absenderfreigabe im Cache ab.
     Ruft dann eine andere Adresse denselben Pfad auf, prüft er die alte
     Freigabe gegen den neuen Absender — und bricht mit "Failed to fetch" ab.
     Betrifft alles, was ein cache-control mitgibt. */
  'Vary': 'Origin'
});

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    /* ── Übersicht der angemeldeten Geräte ────────────────────
       Eigene Adresse, nirgends verlinkt, hinter einem Kennwort. Bewusst
       NICHT in der App: Wer Regenmeldungen einschaltet, soll nicht das
       Gefühl haben, beobachtet zu werden. Hier steht nichts, was der
       Worker nicht ohnehin braucht, um die Meldung zu verschicken.

       Diese Seite läuft vor der Absenderprüfung, weil sie als eigene Seite
       aufgerufen wird und nicht aus der App heraus. Ihr Schutz ist das
       Kennwort, nicht die Herkunft. */
    if (url.pathname.startsWith('/uebersicht')) {
      return uebersicht(url, request, env, { gleich, zuVieleAnfragen, sendPush,
                                            pruefung: { pruefeOrt, pruefVerlauf } });
    }

    /* Absender MUSS bekannt sein — auch wenn gar keiner mitgeschickt wird.
       Vorher stand hier `if (origin && …)`: Fehlt der Kopf ganz, griff die
       Prüfung nicht. Browser senden ihn immer, Skripte und curl nicht — damit
       standen alle Endpunkte offen, auch die kostenpflichtigen. */
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Nicht erlaubt' }, 403, origin);
    }

    // ── RSS-Feed weiterreichen ───────────────────────────────
    if (url.pathname === '/rss') {
      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'Parameter url fehlt' }, 400, origin);

      let t;
      try { t = new URL(target); } catch { return json({ error: 'Ungültige Adresse' }, 400, origin); }
      if (t.protocol !== 'https:' || !ALLOWED_FEED_HOSTS.includes(t.hostname)) {
        return json({ error: `Feed-Host nicht erlaubt: ${t.hostname}` }, 403, origin);
      }

      const res = await fetch(t.toString(), {
        headers: { 'user-agent': 'Wetterfunk/1.0 (privater Feed-Abruf)' },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (!res.ok) return json({ error: `Feed antwortet ${res.status}` }, 502, origin);

      return new Response(await res.text(), {
        headers: {
          ...cors(origin),
          'content-type': 'text/xml; charset=utf-8',
          'cache-control': 'public, max-age=300'
        }
      });
    }

    /* ── Vorlesen mit KI-Stimme (Grok/xAI) ────────────────────
       Der Schlüssel bleibt im Worker, der Browser bekommt ihn nie zu sehen.
       Geschützt durch ein Kennwort, damit nicht jeder, der die Adresse kennt,
       auf fremde Rechnung sprechen lässt. Erzeugte Audios liegen im
       Zwischenspeicher: derselbe Bericht kostet nur einmal. */
    if (url.pathname === '/tts' && request.method === 'POST') {
      if (!env.XAI_API_KEY || !env.TTS_PASSWORT) {
        return json({ error: 'Sprachausgabe ist nicht eingerichtet' }, 503, origin);
      }

      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      const { text, stimme, tempo, passwort } = req || {};

      // Höchstens 40 Kennwortversuche und Abrufe je Stunde und Adresse
      if (await zuVieleAnfragen(env, request, 'tts', 40, 3600)) {
        return json({ error: 'Zu viele Anfragen — später nochmal' }, 429, origin);
      }
      if (!gleich(passwort, env.TTS_PASSWORT)) {
        return json({ error: 'Falsches Kennwort' }, 401, origin);
      }
      if (!text || typeof text !== 'string') {
        return json({ error: 'Kein Text übergeben' }, 400, origin);
      }
      if (text.length > 6000) {
        return json({ error: 'Text zu lang (höchstens 6000 Zeichen)' }, 413, origin);
      }

      const wahl = ['ara', 'eve', 'leo', 'rex', 'sal'].includes(stimme) ? stimme : 'eve';
      const speed = Math.min(1.5, Math.max(0.7, Number(tempo) || 1));

      /* Zwischenspeicher über den Inhalt: Wer denselben Bericht zweimal
         anhört, löst keinen zweiten Abruf aus. */
      const kennung = await hashText(`${wahl}|${speed}|${text}`);
      const cacheSchluessel = new Request(`https://tts.wetterfunk/${kennung}.mp3`);
      const cache = caches.default;
      const gespeichert = await cache.match(cacheSchluessel);
      if (gespeichert) {
        return new Response(gespeichert.body, {
          headers: { ...cors(origin), 'content-type': 'audio/mpeg', 'x-wf-cache': 'treffer' }
        });
      }

      try {
        const res = await withTimeout(fetch('https://api.x.ai/v1/tts', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${env.XAI_API_KEY}`
          },
          body: JSON.stringify({
            text, voice_id: wahl, language: 'de', speed,
            output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 }
          })
        }), 45000);

        if (!res.ok) {
          const grund = await res.text().catch(() => '');
          return json({ error: `Sprachdienst antwortet ${res.status}`, detail: grund.slice(0, 200) },
                      502, origin);
        }

        /* xAI liefert je nach Fassung rohe Audiobytes oder ein JSON mit
           Base64 — beides abfangen, sonst spielt der Browser Kauderwelsch. */
        const typ = String(res.headers.get('content-type') || '').toLowerCase();
        let audio;
        if (typ.includes('application/json')) {
          const d = await res.json();
          const b64 = String(d?.audio || '').trim();
          if (!b64) return json({ error: 'Antwort enthielt kein Audio' }, 502, origin);
          audio = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        } else {
          audio = new Uint8Array(await res.arrayBuffer());
        }

        const antwort = new Response(audio, {
          headers: { ...cors(origin), 'content-type': 'audio/mpeg',
                     'cache-control': 'public, max-age=86400' }
        });
        ctx.waitUntil(cache.put(cacheSchluessel, antwort.clone()));
        return antwort;
      } catch (e) {
        return json({ error: `Sprachdienst nicht erreichbar: ${e.message}` }, 504, origin);
      }
    }

    /* ── DWD-Radarbild (1 km) durchreichen ────────────────────
       Der Kartendienst des DWD ist zeitweise sehr langsam oder antwortet mit
       500. Über den Worker gepuffert wird daraus ein stabiler Abruf: gleiche
       Bildausschnitte kommen fünf Minuten lang aus dem Zwischenspeicher. */
    if (url.pathname === '/dwdradar') {
      const bbox = url.searchParams.get('bbox') || '';
      const px = Math.min(1024, Math.max(256, +url.searchParams.get('px') || 512));
      if (!/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(bbox)) {
        return json({ error: 'bbox fehlt oder ist ungültig' }, 400, origin);
      }

      /* Zwei Produkte des DWD:
         · ohne `time`  → Niederschlagsradar, das aktuelle Messbild
         · mit  `time`  → RV-Komposit „Analyse und Vorhersage", 1 km, im
                          Fünf-Minuten-Takt, rund 90 Minuten voraus.
         Das RV-Produkt ist der Grund, warum die App den Regenzug jetzt
         minutengenau zeigen kann statt in Viertelstundenschritten. */
      const zeit = url.searchParams.get('time') || '';
      const zeitOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(\.000)?Z$/.test(zeit);
      if (zeit && !zeitOk) return json({ error: 'time ungültig' }, 400, origin);

      const ebene = zeitOk ? 'dwd%3ARadar_rv_product_1x1km_ger' : 'dwd%3ANiederschlagsradar';
      const ziel = 'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.1.1' +
        `&request=GetMap&layers=${ebene}&srs=EPSG%3A3857` +
        `&format=image%2Fpng&transparent=true&styles=&bbox=${bbox}&width=${px}&height=${px}` +
        (zeitOk ? `&time=${encodeURIComponent(zeit)}` : '');

      try {
        const res = await withTimeout(
          fetch(ziel, { cf: { cacheTtl: 300, cacheEverything: true } }), 12000);
        if (!res.ok || !/image\/png/i.test(res.headers.get('content-type') || '')) {
          return json({ error: `DWD antwortet ${res.status}` }, 502, origin);
        }
        return new Response(res.body, {
          headers: {
            ...cors(origin),
            'content-type': 'image/png',
            'cache-control': 'public, max-age=300'
          }
        });
      } catch {
        return json({ error: 'DWD zu langsam' }, 504, origin);
      }
    }

    /* ── Regenverlauf für einen Punkt ─────────────────────────
       Der DWD kann aus dem RV-Komposit den Wert an einer Koordinate
       herausgeben — für jeden Fünf-Minuten-Schritt, gemessen wie
       vorhergesagt. Damit lässt sich sagen: „Bei dir fängt es um 06:35 an",
       statt nur ein Regengebiet auf der Karte zu zeigen.

       Die Einheit ist Millimeter je fünf Minuten; mal zwölf ergibt die
       gewohnte Angabe in mm/h. Werte um -0.001 bedeuten „kein Echo". */
    if (url.pathname === '/dwdverlauf') {
      const lat = +url.searchParams.get('lat');
      const lon = +url.searchParams.get('lon');
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return json({ error: 'lat/lon fehlen' }, 400, origin);
      }
      // Nur Deutschland und Umgebung — anderswo gibt es kein Komposit
      if (lat < 46.5 || lat > 56 || lon < 4.5 || lon > 16.5) {
        return json({ error: 'außerhalb der Radarabdeckung' }, 404, origin);
      }
      if (await zuVieleAnfragen(env, request, 'punkt', 120, 3600)) {
        return json({ error: 'Zu viele Anfragen' }, 429, origin);
      }

      /* Fünf Minuten Raster für die nächste halbe Stunde, danach zehn: Für
         „fängt es gleich an?" zählt die Minute, für „wie wird der Abend?"
         nicht mehr. Das spart Abrufe für die Umgebungspunkte. */
      const jetzt = Math.floor(Date.now() / 300000) * 300000;
      const schritte = [];
      for (let m = -10; m <= 30; m += 5) schritte.push(jetzt + m * 60000);
      for (let m = 40; m <= 90; m += 10) schritte.push(jetzt + m * 60000);

      /* Eine Radarzelle ist einen Kilometer breit. Ein Sommerschauer ist
         wenige Kilometer groß — ob er genau die eigene Zelle trifft, ist
         Zufall. Gemessen am 1. August: über der Stadtmitte 0,02 mm/h,
         zweieinhalb Kilometer weiter 4,9. Wer draußen steht, wird nass,
         die App sagte „trocken".

         Deshalb zusätzlich vier Punkte im Umkreis von rund 2,5 km. Sie
         werden getrennt gemeldet, nicht mit dem eigenen Wert vermischt:
         „bei dir" und „direkt nebenan" sind zwei verschiedene Aussagen. */
      const RING_KM = 2.5;
      const dLat = RING_KM / 111;
      const dLon = RING_KM / (111 * Math.cos(lat * Math.PI / 180));
      const ring = [[lat + dLat, lon], [lat - dLat, lon],
                    [lat, lon + dLon], [lat, lon - dLon]];
      // Umgebung nur im Nahbereich — weiter draußen ist die Bahn ohnehin unsicher
      const ringBis = jetzt + 15 * 60000;

      const wert = async (pLat, pLon, t) => {
        const zeit = new Date(t).toISOString().replace(/\.\d+Z$/, '.000Z');
        const bb = `${(pLon - 0.05).toFixed(4)},${(pLat - 0.05).toFixed(4)},`
                 + `${(pLon + 0.05).toFixed(4)},${(pLat + 0.05).toFixed(4)}`;
        const u = 'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.3.0'
          + '&request=GetFeatureInfo&layers=dwd:Radar_rv_product_1x1km_ger'
          + '&query_layers=dwd:Radar_rv_product_1x1km_ger&crs=CRS:84'
          + `&bbox=${bb}&width=101&height=101&i=50&j=50`
          + `&info_format=application/json&time=${encodeURIComponent(zeit)}`;
        try {
          const r = await withTimeout(
            fetch(u, { cf: { cacheTtl: 240, cacheEverything: true } }), 8000);
          if (!r.ok) return null;
          const d = await r.json();
          const v = d?.features?.[0]?.properties?.RV_ANALYSIS;
          if (typeof v !== 'number' || v < 0) return 0;
          return +(v * 12).toFixed(2);                   // mm/5min → mm/h
        } catch { return null; }
      };

      const holen = async (t) => {
        const eigen = await wert(lat, lon, t);
        if (eigen == null) return null;
        if (t > ringBis) return { t, mm: eigen };
        const rund = (await Promise.all(ring.map(([a, b]) => wert(a, b, t))))
          .filter(x => typeof x === 'number');
        return rund.length
          ? { t, mm: eigen, umfeld: Math.max(...rund) }
          : { t, mm: eigen };
      };

      const werte = (await Promise.all(schritte.map(holen))).filter(Boolean);
      if (werte.length < schritte.length / 2) {
        return json({ error: 'DWD antwortet nicht vollständig' }, 502, origin);
      }
      return json({ punkte: werte, einheit: 'mm/h', umkreisKm: RING_KM,
                    quelle: 'DWD RV 1 km' }, 200, origin, 'public, max-age=120');
    }

    /* ── Amtlicher Regionalwetterbericht des DWD ──────────────
       Von Meteorologen geschriebene Texte, offene Daten. Der Server setzt
       keine CORS-Freigabe und liefert Latin-1, deshalb der Umweg hier. */
    if (url.pathname === '/dwdtext') {
      const kuerzel = (url.searchParams.get('region') || 'DWSG').toUpperCase();
      if (!/^DW[A-Z]{2}$/.test(kuerzel)) return json({ error: 'Ungültige Region' }, 400, origin);

      const BASIS = 'https://opendata.dwd.de/weather/text_forecasts/txt/';
      try {
        const liste = await fetch(BASIS, { cf: { cacheTtl: 900, cacheEverything: true } });
        if (!liste.ok) return json({ error: `DWD antwortet ${liste.status}` }, 502, origin);

        const namen = [...(await liste.text()).matchAll(/href="([^"]*VHDL13_[A-Z]{4}[^"]*ia5)"/g)]
          .map(m => m[1]).filter(n => n.includes(`VHDL13_${kuerzel}_`));
        if (!namen.length) return json({ error: 'Kein Bericht für diese Region' }, 404, origin);

        const datei = namen[namen.length - 1];
        const res = await fetch(BASIS + datei, { cf: { cacheTtl: 900, cacheEverything: true } });
        if (!res.ok) return json({ error: `DWD antwortet ${res.status}` }, 502, origin);

        const text = new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
        return json({ text, datei }, 200, origin, 'public, max-age=900');
      } catch (e) {
        return json({ error: `DWD nicht erreichbar: ${e.message}` }, 502, origin);
      }
    }

    /* ── Wetterdaten über den Worker holen ────────────────────
       Open-Meteo begrenzt die Abrufe pro IP. Sitzen mehrere Geräte hinter
       demselben Anschluss oder wurde viel getestet, greift das Limit für
       alle. Dieser Umweg zählt auf die Adresse von Cloudflare und wird nur
       genutzt, wenn der direkte Weg blockt. */
    if (url.pathname === '/wetter') {
      const ziel = url.searchParams.get('url');
      let t;
      try { t = new URL(ziel); } catch { return json({ error: 'Ungültige Adresse' }, 400, origin); }
      if (t.protocol !== 'https:' || !/(^|\.)open-meteo\.com$/.test(t.hostname)) {
        return json({ error: 'Nur Open-Meteo erlaubt' }, 403, origin);
      }

      /* Zwölf Minuten vorhalten: Das Punktraster ist der teuerste Abruf und
         zählt bei Open-Meteo je Messpunkt aufs Kontingent. Gepuffert teilen
         sich alle Geräte dieselbe Antwort, statt sie einzeln zu holen. */
      const res = await fetch(t.toString(), { cf: { cacheTtl: 720, cacheEverything: true } });
      return new Response(await res.text(), {
        status: res.status,
        headers: {
          ...cors(origin), 'content-type': 'application/json',
          'cache-control': 'public, max-age=720'
        }
      });
    }

    // ── Regenwarnungen: an- und abmelden ─────────────────────
    if (url.pathname === '/push/key') {
      return json({ key: env.VAPID_PUBLIC }, 200, origin);
    }

    if (url.pathname === '/push/an' && request.method === 'POST') {
      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      const { abo, lat, lon, ort, kreis, arten, tz, geraet } = req || {};
      if (!abo?.endpoint || !abo?.keys?.p256dh || !abo?.keys?.auth) {
        return json({ error: 'Unvollständiges Abo' }, 400, origin);
      }
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return json({ error: 'Standort fehlt' }, 400, origin);
      }
      /* Nur die echten Push-Dienste der Hersteller. Ohne diese Prüfung könnte
         jemand eine beliebige Adresse eintragen und den Worker Anfragen an
         fremde Server schicken lassen. */
      if (!istPushDienst(abo.endpoint)) {
        return json({ error: 'Unbekannter Push-Dienst' }, 400, origin);
      }
      if (await zuVieleAnfragen(env, request, 'push', 20, 3600)) {
        return json({ error: 'Zu viele Anmeldungen' }, 429, origin);
      }

      // Beim Ortswechsel wird derselbe Eintrag überschrieben. Den Zeitpunkt
      // der letzten Meldung übernehmen, sonst käme sofort wieder eine.
      const key = aboSchluessel(abo.endpoint);
      const alt = await env.WF_PUSH.get(key, 'json');
      const neu = {
        abo, lat, lon,
        ort: String(ort || '').slice(0, 60),
        kreis: String(kreis || '').slice(0, 80),
        /* Zeitzone des Geräts — ohne sie stünde in der Meldung die
           Weltzeit. Nur ein Name aus der Zeitzonendatenbank ist erlaubt. */
        tz: /^[A-Za-z_+-]+\/[A-Za-z_+\-\/]+$/.test(String(tz || '')) ? tz : 'Europe/Berlin',
        // Was gemeldet werden soll. Regen und Warnungen sind voreingestellt,
        // die Himmelstermine nicht — die will nicht jeder täglich.
        arten: {
          regen: arten?.regen !== false,
          warnungen: arten?.warnungen !== false,
          aufgang: arten?.aufgang === true,
          hoechststand: arten?.hoechststand === true,
          untergang: arten?.untergang === true,
          mondaufgang: arten?.mondaufgang === true
        },
        /* Freiwilliger Gerätename. Ein Browser gibt keine Gerätekennung
           heraus — ohne diesen Namen sind zwei iPhones am selben Ort in der
           Übersicht nicht auseinanderzuhalten. Steuerzeichen raus, damit die
           Übersicht lesbar bleibt. Ein leeres Feld löscht den alten Namen. */
        geraet: typeof geraet === 'string'
          ? geraet.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30)
          : (alt?.geraet || ''),
        seit: alt?.seit || Date.now(),
        zuletzt: alt?.zuletzt || 0,
        gemeldet: alt?.gemeldet || null,
        warnGemeldet: alt?.warnGemeldet || [],
        himmelGemeldet: alt?.himmelGemeldet || []
      };

      /* Die App meldet ihren Standort bei JEDEM Öffnen nach — damit ein
         Ortswechsel nicht erst beim nächsten Ein- und Ausschalten ankommt.
         Bis hierher wurde dabei jedes Mal geschrieben: Ein Blick in die App
         kostete einen Schreibvorgang, und davon gibt der kostenlose Tarif
         tausend am Tag her. Geschrieben wird deshalb nur noch, wenn sich
         wirklich etwas geändert hat. */
      const unveraendert = alt
        && alt.lat === neu.lat && alt.lon === neu.lon
        && alt.ort === neu.ort && alt.kreis === neu.kreis && alt.tz === neu.tz
        && (alt.geraet || '') === (neu.geraet || '')
        && alt.abo?.endpoint === abo.endpoint
        && JSON.stringify(alt.arten || {}) === JSON.stringify(neu.arten);

      if (!unveraendert) await env.WF_PUSH.put(key, JSON.stringify(neu));
      return json({ ok: true, geschrieben: !unveraendert }, 200, origin);
    }

    if (url.pathname === '/push/aus' && request.method === 'POST') {
      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      if (!req?.endpoint) return json({ error: 'endpoint fehlt' }, 400, origin);
      await env.WF_PUSH.delete(aboSchluessel(req.endpoint));
      return json({ ok: true }, 200, origin);
    }

    // Probelauf, damit man das Einrichten prüfen kann
    if (url.pathname === '/push/test' && request.method === 'POST') {
      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      const eintrag = await env.WF_PUSH.get(aboSchluessel(req?.endpoint || ''), 'json');
      if (!eintrag) return json({ error: 'Kein Abo gefunden' }, 404, origin);
      try {
        const status = await sendPush(eintrag.abo, JSON.stringify({
          titel: 'Wetterfunk meldet sich',
          text: `Regenwarnungen für ${eintrag.ort || 'deinen Ort'} sind aktiv.`,
          art: 'test'
        }), env);
        return json({ ok: status < 300, status }, 200, origin);
      } catch (e) {
        return json({ error: e.message }, 500, origin);
      }
    }

    // ── Text über die Mac-Bridge erzeugen ────────────────────
    if (url.pathname === '/ai' && request.method === 'POST') {
      if (!env.BRIDGE_URL || !env.BRIDGE_SECRET) {
        return json({ error: 'Bridge ist im Worker nicht konfiguriert' }, 500, origin);
      }

      // Der Mac ist privat und das Kontingent begrenzt: 30 Berichte je Stunde
      if (await zuVieleAnfragen(env, request, 'ai', 30, 3600)) {
        return json({ error: 'Zu viele Anfragen — später nochmal' }, 429, origin);
      }

      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      if (!req?.system || !req?.user) {
        return json({ error: 'system und user werden gebraucht' }, 400, origin);
      }
      if (String(req.system).length + String(req.user).length > 30000) {
        return json({ error: 'Anfrage zu lang' }, 413, origin);
      }

      const base = env.BRIDGE_URL.replace(/\/+$/, '');
      const headers = { 'x-bridge-secret': env.BRIDGE_SECRET, 'content-type': 'application/json' };

      // Erst kurz anklopfen: ist der Mac wach und die CLI gesund?
      try {
        const ping = await withTimeout(fetch(base + '/ping', { headers }), 4000);
        if (!ping.ok) throw new Error('Bridge antwortet nicht');
        const pj = await ping.json().catch(() => ({}));
        if (pj.cli === false) {
          return json({ error: 'Claude-CLI auf dem Mac gerade nicht nutzbar (Login abgelaufen?)' }, 503, origin);
        }
      } catch {
        return json({ error: 'Mac nicht erreichbar — läuft er gerade?' }, 503, origin);
      }

      try {
        const res = await withTimeout(fetch(base + '/generate', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: req.model || 'claude-opus-5',
            system: req.system,
            user: req.user,
            effort: req.effort || 'low'
          })
        }), 60000);

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.text) {
          return json({ error: data.error || 'Bridge lieferte keine Antwort' }, 502, origin);
        }
        return json({ text: data.text }, 200, origin);
      } catch {
        return json({ error: 'Zeitüberschreitung bei der Bridge' }, 504, origin);
      }
    }

    return json({ error: 'Unbekannter Pfad',
      paths: ['/rss?url=…', '/ai', '/dwdtext?region=…', '/push/an', '/push/aus', '/push/test'] },
      404, origin);
  },

  /* ── Zeitplan: zieht bei jemandem Regen auf? ───────────────
     Läuft alle 15 Minuten über alle Abos. Gemeldet wird nur, wenn in den
     nächsten zwei Stunden Regen beginnt und die letzte Meldung für diesen
     Ort mindestens drei Stunden her ist — sonst wird es zur Belästigung. */
  async scheduled(event, env, ctx) {
    /* Zwei Zeitpläne: alle fünf Minuten die Regenwache, einmal am Tag der
       Prüflauf. Der Prüflauf liegt um 03:20, wenn die Reanalyse für den
       Vortag steht und niemand die App benutzt. */
    if (event.cron === '20 3 * * *') {
      ctx.waitUntil(taeglichePruefung(env));
      return;
    }
    ctx.waitUntil(regenPruefen(env));
  }
};

/* Eine feste Ruhezeit von drei Stunden wäre zu grob: Hört Regen auf und fängt
   eine Stunde später wieder an, will man das wissen. Gemeldet wird deshalb
   jede neue Regenphase — erkannt an ihrem Startzeitpunkt — und zusätzlich das
   Ende der laufenden. Wiederholungen derselben Phase unterbleiben, solange
   sich der Startzeitpunkt nicht wesentlich verschiebt. */
const START_TOLERANZ = 25 * 60000;   // Verschiebt sich der Beginn stärker, ist es eine neue Lage
const MIN_ABSTAND    = 20 * 60000;   // Nie öfter als alle 20 Minuten irgendetwas melden

async function regenPruefen(env) {
  const liste = await env.WF_PUSH.list({ prefix: 'abo:' });
  if (!liste.keys.length) return;

  // Amtliche Warnungen einmal für alle holen, nicht je Abo
  const warnungen = await ladeWarnungen();

  /* Zwei Geräte am selben Ort sollen nicht zwei Radarabfragen auslösen —
     auf zwei Kilometer gerundet ist es derselbe Schauer. Der Vorrat begrenzt,
     wie viele verschiedene Orte je Durchgang aufs Radar dürfen. */
  const radarSpeicher = new Map();
  let radarVorrat = RADAR_PRO_LAUF;

  for (const eintragMeta of liste.keys) {
    const eintrag = await env.WF_PUSH.get(eintragMeta.name, 'json');
    if (!eintrag) continue;
    const arten = eintrag.arten || { regen: true, warnungen: true };

    try {
      let meldung = null;

      /* Amtliche Warnungen haben Vorrang: Ein Unwetter ist wichtiger als die
         Ankündigung von Nieselregen. */
      if (arten.warnungen && warnungen) {
        meldung = warnungMelden(warnungen, eintrag);
      }
      /* Himmelstermine vor dem Regen: Ein Sonnenaufgang lässt sich nicht
         nachholen, eine Regenmeldung schon — die gilt für zwei Stunden. */
      if (!meldung) meldung = himmelMelden(eintrag);
      if (!meldung && arten.regen) {
        const lage = await regenLage(eintrag.lat, eintrag.lon);
        if (lage) {
          /* Das Modell schweigt, aber es ist Schauerlage: Dann entscheidet
             das Radar. Genau hier lag der Fall vom 1. August — das Gitter
             hatte nichts, über der Stadt ging ein Schauer nieder. */
          const stillJetzt = !lage.laeuft
            && (!lage.naechste || lage.naechste.start - Date.now() > 30 * 60000);
          if (stillJetzt && (lage.risiko ?? 0) >= RADAR_AB_RISIKO
              && imRadargebiet(eintrag.lat, eintrag.lon)) {
            const schluessel = `${eintrag.lat.toFixed(2)},${eintrag.lon.toFixed(2)}`;
            if (!radarSpeicher.has(schluessel) && radarVorrat > 0) {
              radarVorrat--;
              radarSpeicher.set(schluessel,
                await radarLage(eintrag.lat, eintrag.lon, eintrag.tz));
            }
            const rl = radarSpeicher.get(schluessel);
            if (rl && (rl.laeuft || rl.naechste)) {
              lage.laeuft = rl.laeuft;
              /* Die spätere Phase des Modells bleibt stehen, wenn das Radar
                 keine eigene hat — sie liefert das „ab 16:30 wieder" am Ende
                 der Meldung, und so weit voraus sieht das Radar nicht. */
              lage.naechste = rl.naechste || lage.naechste;
              lage.quelle = 'radar';
            }
          }
          meldung = entscheide(lage, eintrag);
          // Woher die Zahl kommt, gehört in die Meldung — sie widerspricht der App sonst
          if (meldung && lage.quelle === 'radar' && meldung.art !== 'vorbei') {
            meldung.text = `${meldung.text} · Radar`;
          }
        }
      }
      if (!meldung) continue;
      /* Warnungen dürfen die Ruhefrist durchbrechen — bei Unwetter zählt
         Zeit. Himmelstermine ebenfalls: Sie kommen höchstens einmal am Tag
         und wären zwanzig Minuten später wertlos. */
      if (meldung.art !== 'warnung' && meldung.art !== 'himmel'
          && Date.now() - (eintrag.zuletzt || 0) < MIN_ABSTAND) continue;

      const status = await sendPush(eintrag.abo, JSON.stringify({
        titel: meldung.titel, text: meldung.text, art: meldung.art,
        // Eigene Kennung je Termin, damit sich die Meldungen nicht ersetzen
        tag: meldung.tag || `wf-${meldung.art}`
      }), env);

      // 404/410 heißt: Gerät hat das Abo verworfen
      if (status === 404 || status === 410) {
        await env.WF_PUSH.delete(eintragMeta.name);
        continue;
      }
      if (status < 300) {
        eintrag.zuletzt = Date.now();
        if (meldung.art === 'warnung') {
          // Kennungen der gemeldeten Warnungen merken, höchstens 40 Stück
          /* Je Ereignisart ein Eintrag, der ersetzt wird — sonst wächst die
             Liste bei jeder Aktualisierung und die ältesten fallen heraus,
             worauf dieselbe Warnung wieder als neu gälte. */
          const gemischt = new Map((eintrag.warnGemeldet || [])
            .filter(x => x && typeof x === 'object').map(x => [x.k, x]));
          for (const x of meldung.kennungen) gemischt.set(x.k, x);
          eintrag.warnGemeldet = [...gemischt.values()].slice(-40);
        } else if (meldung.art === 'himmel') {
          eintrag.himmelGemeldet = [...(eintrag.himmelGemeldet || []), meldung.merker].slice(-12);
        } else {
          eintrag.gemeldet = meldung.merker;
        }
        await env.WF_PUSH.put(eintragMeta.name, JSON.stringify(eintrag));
      }
    } catch (e) {
      console.log('Prüfung fehlgeschlagen:', eintragMeta.name, e.message);
    }
  }
}

/* ── Amtliche Warnungen des DWD ─────────────────────────────
   Die Datei ist als JSONP verpackt: warnWetter.loadWarnings({...}). */
async function ladeWarnungen() {
  try {
    const res = await fetch('https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json',
      { cf: { cacheTtl: 240, cacheEverything: true } });
    if (!res.ok) return null;
    const txt = await res.text();
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a < 0 || b < 0) return null;
    return JSON.parse(txt.slice(a, b + 1));
  } catch (e) {
    console.log('DWD-Warnungen:', e.message);
    return null;
  }
}

/* Die Stufe steckt nicht verlässlich im `level`: Für Hitze verwendet der DWD
   eine eigene Skala (50 und höher), für Wetterwarnungen 1 bis 4. Die
   Überschrift ist dagegen immer eindeutig formuliert. */
function stufeVon(w) {
  const h = String(w.headline || '').toUpperCase();
  if (h.includes('EXTREME')) return { wort: 'Extremes Unwetter', dringend: true };
  if (h.includes('UNWETTER')) return { wort: 'Unwetterwarnung', dringend: true };
  if (h.includes('VORABINFORMATION')) return { wort: 'Vorabinformation', dringend: false };
  if (w.level >= 4 && w.level < 10) return { wort: 'Unwetterwarnung', dringend: true };
  return { wort: 'Warnung', dringend: false };
}

/** Ortsnamen vergleichbar machen — der DWD schreibt "Kreis und Stadt Tübingen". */
const glatt = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
  .replace(/\b(stadt|kreis|landkreis|und|die|der)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Gibt es eine neue Warnung für diesen Ort? */
/* ── Sonne und Mond ────────────────────────────────────────
   Der Zeitplan läuft alle 15 Minuten. Gemeldet wird deshalb nicht der
   Augenblick selbst, sondern ein kurzer Vorlauf: Wer weiß, dass die Sonne
   in einer Viertelstunde untergeht, kann noch losgehen. Wer es im selben
   Moment erfährt, hat nichts davon.

   Jeder Termin wird höchstens einmal gemeldet — gemerkt wird er über
   Datum und Art, nicht über die Uhrzeit. So bleibt die Sperre bestehen,
   auch wenn die Rechnung beim nächsten Lauf eine Minute anders ausfällt. */
const VORLAUF_MIN = 5;      // näher dran lohnt die Meldung nicht mehr
const VORLAUF_MAX = 22;     // ein Lauf mehr als der Abstand des Zeitplans

function himmelMelden(eintrag) {
  const arten = eintrag.arten || {};
  if (!arten.aufgang && !arten.hoechststand && !arten.untergang && !arten.mondaufgang) {
    return null;
  }
  const jetzt = new Date();
  const von = new Date(jetzt.getTime() - 5 * 60000);
  const tz = eintrag.tz || 'Europe/Berlin';

  const sonne = sonnenTermine(von, eintrag.lat, eintrag.lon, 3);
  const mond = arten.mondaufgang ? mondTermine(von, eintrag.lat, eintrag.lon, 3) : [];
  const untergang = sonne.find(e => e.art === 'untergang');

  /* Die goldene Stunde vertritt den Sonnenuntergang: Ab da fällt das Licht
     flach ein — das ist der Zeitpunkt, zu dem man draußen sein will, nicht
     der Untergang selbst. Fehlt sie (Polartag), tut es der Untergang. */
  const kandidaten = [];
  for (const e of sonne) {
    if (e.art === 'aufgang' && arten.aufgang) {
      kandidaten.push({ ...e, titel: 'Sonnenaufgang',
        text: (t) => `Um ${t} geht die Sonne auf${eintrag.ort ? ` in ${eintrag.ort}` : ''}.` });
    }
    if (e.art === 'hoechststand' && arten.hoechststand) {
      kandidaten.push({ ...e, titel: 'Sonnenhöchststand',
        text: (t) => `Um ${t} steht die Sonne mit ${Math.round(e.hoehe)}° am höchsten — `
          + `kürzeste Schatten und stärkste UV-Strahlung des Tages.` });
    }
    if (e.art === 'gold' && arten.untergang) {
      kandidaten.push({ ...e, art: 'abend', titel: 'Goldene Stunde',
        text: (t) => `Ab ${t} fällt das Licht flach ein`
          + (untergang ? `, Sonnenuntergang um ${uhrzeit(untergang.t, tz)}.` : '.') });
    }
  }
  /* Der Untergang trägt dieselbe Kennung wie die goldene Stunde und belegt
     damit denselben Tagesplatz. Sonst käme abends beides — erst um 20:00
     das Licht, dann um 20:45 noch einmal der Untergang. Gemeldet wird der
     frühere Termin; fehlt die goldene Stunde (Polartag), bleibt dieser. */
  if (arten.untergang && untergang) {
    kandidaten.push({ ...untergang, art: 'abend', titel: 'Sonnenuntergang',
      text: (t) => `Um ${t} geht die Sonne unter.` });
  }
  for (const e of mond) {
    const p = mondPhase(e.t);
    kandidaten.push({ ...e, titel: 'Mondaufgang',
      text: (t) => `Um ${t} geht der Mond auf — ${p.name}, `
        + `${Math.round(p.beleuchtet * 100)} % beleuchtet.` });
  }

  const gemeldet = eintrag.himmelGemeldet || [];
  for (const k of kandidaten.sort((a, b) => a.t - b.t)) {
    const min = (k.t - jetzt) / 60000;
    if (min < VORLAUF_MIN || min > VORLAUF_MAX) continue;
    const merker = `${tagSchluessel(k.t, tz)}:${k.art}`;
    if (gemeldet.includes(merker)) continue;
    return { art: 'himmel', merker, tag: `wf-${k.art}`,
             titel: k.titel, text: k.text(uhrzeit(k.t, tz)) };
  }
  return null;
}

const uhrzeit = (d, tz) => new Intl.DateTimeFormat('de-DE',
  { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);

/** Datum am Ort des Empfängers — Grundlage für „einmal am Tag". */
const tagSchluessel = (d, tz) => new Intl.DateTimeFormat('sv-SE',
  { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(d);

function warnungMelden(daten, eintrag) {
  const ziele = [glatt(eintrag.ort), glatt(eintrag.kreis)].filter(Boolean);
  if (!ziele.length) return null;

  const passt = (regionName) => {
    const r = glatt(regionName);
    if (!r) return false;
    return ziele.some(z => z && (r === z || r.includes(z) || z.includes(r)));
  };

  const gefunden = [];
  for (const gruppe of [daten.warnings, daten.vorabInformation]) {
    for (const id in (gruppe || {})) {
      for (const w of gruppe[id]) {
        if (passt(w.regionName)) gefunden.push(w);
      }
    }
  }
  if (!gefunden.length) return null;

  /* Entdoppeln — und zwar nach dem Ereignis, nicht nach der Kennung.

     Der Schlüssel enthielt den Beginn der Warnung. Den setzt der DWD bei
     jeder Aktualisierung neu, und bei einem Gewitter aktualisiert er im
     Minutentakt: Am 4. August kamen fünf identische Meldungen in einer
     Stunde, dreimal davon mit demselben Wortlaut und derselben Endzeit.

     Gemeldet wird deshalb je Ereignisart höchstens einmal — es sei denn,
     die Stufe steigt (aus einer Gewitterwarnung wird eine Unwetterwarnung;
     das gehört sofort durch) oder es sind drei Stunden vergangen, dann ist
     es eine neue Lage. Eine verschobene Endzeit allein weckt niemanden. */
  const RUHE_MS = 3 * 36e5;
  const jetzt = Date.now();
  /* Ältere Einträge waren einfache Zeichenketten. Sie werden übergangen —
     einmalig kommt dadurch eine Meldung mehr, danach greift die neue Sperre. */
  const alteListe = (eintrag.warnGemeldet || []).filter(x => x && typeof x === 'object');
  const schon = new Map(alteListe.map(x => [x.k, x]));

  const schluessel = (w) => `${w.type}|${String(w.event || '').toLowerCase()}`;
  const gesehen = new Set();
  const neu = gefunden.filter(w => {
    const k = schluessel(w);
    if (gesehen.has(k)) return false;
    const alt = schon.get(k);
    const wiederholen = !alt
      || (Number(w.level) || 0) > (Number(alt.level) || 0)
      || jetzt - (alt.wann || 0) > RUHE_MS;
    if (!wiederholen) return false;
    gesehen.add(k);
    return true;
  }).sort((a, b) => (stufeVon(b).dringend ? 1 : 0) - (stufeVon(a).dringend ? 1 : 0));

  if (!neu.length) return null;

  const w = neu[0];
  const stufe = stufeVon(w);
  const bis = w.end ? new Date(w.end).toLocaleTimeString('de-DE',
    { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : null;
  const weitere = neu.length > 1 ? ` Dazu ${neu.length - 1} weitere Warnung${neu.length > 2 ? 'en' : ''}.` : '';

  // Der Ereignisname des DWD steht in Großbuchstaben — das schreit in einer Meldung
  const ereignis = String(w.event || '').replace(/\b[A-ZÄÖÜ]{2,}\b/g,
    m => m.charAt(0) + m.slice(1).toLowerCase());

  return {
    art: 'warnung',
    titel: `${stufe.dringend ? '⚠️ ' : ''}${stufe.wort}: ${ereignis}`,
    text: `${w.regionName}${bis ? `, bis ${bis} Uhr` : ''}.${weitere} ` +
          `${String(w.description || '').slice(0, 150)}`.trim().slice(0, 180),
    kennungen: neu.map(x => ({ k: `${x.type}|${String(x.event || '').toLowerCase()}`,
                               level: Number(x.level) || 0, wann: Date.now() }))
  };
}

/** Aus der Lage und dem zuletzt Gemeldeten ableiten, ob etwas zu sagen ist. */
/* Nachts nur, wenn es sich lohnt. Ein paar Tropfen um Viertel vor zwölf
   helfen niemandem, der schläft — der Alarm soll wecken, wenn es etwas zu
   entscheiden gibt, nicht wenn die Kapuze reicht. Amtliche Warnungen und
   kräftiger Regen kommen weiter jederzeit durch. */
const NACHT_VON = 22, NACHT_BIS = 6;
function istNacht(tz) {
  try {
    /* Auf Deutsch liefert Intl „00 Uhr" statt „00" — `+"00 Uhr"` ist NaN,
       und mit NaN sind beide Vergleiche unten falsch. Die Nachtruhe griff
       dadurch überhaupt nie. Deshalb die Ziffern herausziehen. */
    const txt = new Intl.DateTimeFormat('de-DE',
      { hour: '2-digit', hour12: false, timeZone: tz || 'Europe/Berlin' }).format(new Date());
    const h = Number((txt.match(/\d+/) || [])[0]);
    if (!Number.isFinite(h)) return false;
    return h >= NACHT_VON || h < NACHT_BIS;
  } catch { return false; }
}

function entscheide(lage, eintrag) {
  const alt = eintrag.gemeldet || {};
  const nachts = istNacht(eintrag.tz);

  /* Solange es regnet, ist die Vorhersage vom Ende die eine Zahl, die zählt —
     und sie verschiebt sich. Deshalb wird nachgemeldet, wenn sie sich um mehr
     als eine Viertelstunde bewegt hat, und sonst spätestens nach 45 Minuten
     mit dem dann gültigen Stand. Wer im Regen steht, will nicht dreimal
     dasselbe hören, aber auch nicht mit einer Zahl von vor zwei Stunden
     dastehen. */
  const NACHFASSEN_MS = 45 * 60000;
  const ENDE_TOLERANZ = 15 * 60000;

  // Fall 1: Es regnet gerade — melden, wann es aufhört
  if (lage.laeuft) {
    const minuten = Math.round((lage.laeuft.ende - Date.now()) / 60000);

    /* Beim Radar reicht der Blick nur eine halbe Stunde voraus. Regnet es
       am Ende noch, ist das Ende schlicht unbekannt — dann eine Restdauer
       zu nennen wäre erfunden. */
    if (lage.laeuft.offen) {
      /* Auch hier gilt: Tröpfeln ist keine Nachricht wert. Diese Lücke
         blieb bei der ersten Entschlackung offen — anhaltender Niesel über
         das Radarfenster hinaus hätte weiter gemeldet. */
      if (lage.laeuft.leicht) return null;
      const gleicheLage = alt.art === 'haelt' && Date.now() - (alt.wann || 0) < NACHFASSEN_MS;
      if (gleicheLage) return null;
      return {
        art: 'ende',
        titel: 'Es regnet',
        text: `Hält mindestens die nächste halbe Stunde an · ${lage.laeuft.rat}`,
        merker: { art: 'haelt', ende: lage.laeuft.ende, wann: Date.now(),
                  regnete: true, leicht: !!lage.laeuft.leicht }
      };
    }

    // Nur ansagen, wenn das Ende absehbar ist und nicht in zwei Minuten eintritt
    if (minuten < 10 || minuten > 180) return null;

    /* „Tropfen bis etwa 00:20 — noch 10 Minuten" ist keine Nachricht wert.
       Wer ein paar Tropfen abbekommt, merkt es selbst, und wann sie
       aufhören, ändert keine Entscheidung. */
    if (lage.laeuft.leicht) return null;

    const gleichesEnde = alt.art === 'ende'
      && Math.abs((alt.ende || 0) - lage.laeuft.ende) < ENDE_TOLERANZ;
    const frischGemeldet = Date.now() - (alt.wann || 0) < NACHFASSEN_MS;
    if (gleichesEnde && frischGemeldet) return null;

    /* Kurz halten: Der Sperrbildschirm des iPhones zeigt rund zwei Zeilen,
       alles Weitere wird abgeschnitten. Das Wichtigste gehört nach vorn. */
    const was = lage.laeuft.leicht ? 'Tropfen' : 'Regen';
    return {
      art: 'ende',
      titel: `${was} bis etwa ${lage.laeuft.endeUhr}`,
      text: `Noch ${minuten} Min.${lage.laeuft.leicht ? ' · nur ein paar Tropfen' : ''}${
        lage.naechste ? ` · ab ${lage.naechste.startUhr} wieder` : ''}`,
      merker: { art: 'ende', ende: lage.laeuft.ende, wann: Date.now(),
                regnete: true, leicht: !!lage.laeuft.leicht }
    };
  }

  /* Fall 1b: Es hat aufgehört. Beim letzten Durchgang lief noch Regen —
     dann gehört die Entwarnung dazu, sonst wartet man weiter im Trockenen
     auf ein Ende, das längst eingetreten ist. */
  /* Entwarnung nur, wenn vorher wirklich Regen gemeldet wurde. Nach ein
     paar Tropfen ist „von oben kommt nichts mehr" eine Meldung über nichts. */
  if (alt.regnete && !alt.leicht) {
    return {
      art: 'vorbei',
      titel: 'Von oben kommt nichts mehr',
      text: lage.naechste
        ? `Trocken · ab ${lage.naechste.startUhr} ${lage.naechste.staerke}`
        : 'Trocken, es kommt nichts nach',
      merker: { art: 'vorbei', wann: Date.now(), regnete: false }
    };
  }

  // Fall 2: Es ist trocken und Regen zieht auf
  if (!lage.naechste) return null;
  const p = lage.naechste;
  const minuten = Math.round((p.start - Date.now()) / 60000);

  /* Zwei Meldungen je Phase, nicht eine:
     1. Die Ankündigung, sobald der Beginn in Reichweite rückt (bis 150
        Minuten) — zum Planen.
     2. Die Erinnerung kurz vor dem Beginn (unter 25 Minuten) — zum
        Handeln: Fenster zu, Wäsche rein, jetzt losfahren oder nicht.

     Vorher gab es nur die erste. Eine Phase, die früh im Blick war, wurde
     angekündigt und dann nie wieder erwähnt — wer die Meldung um 14 Uhr
     las, stand um 17 Uhr trotzdem überrascht im Regen. Weiter als 150
     Minuten voraus wird geschwiegen: Dafür gibt es die Tagesübersicht. */
  if (minuten > 150) return null;
  // Nachts schweigt die Ankündigung, solange es bei Tropfen bleibt
  if (nachts && p.leicht) return null;

  const gleichePhase = alt.art === 'start' && Math.abs((alt.start || 0) - p.start) < START_TOLERANZ;
  if (gleichePhase) {
    const schonKurzfristig = (alt.vorlauf ?? 999) <= 40;
    const erinnerungFaellig = minuten <= 25 && !schonKurzfristig;
    if (!erinnerungFaellig) return null;
  }

  /* Großschreibung am Satzanfang: „Gleich ein paar Tropfen" liest sich
     richtig, „In 20 Min. Ein paar Tropfen" nicht. */
  const wort = minuten <= 20 ? p.staerke
             : p.staerke.charAt(0).toUpperCase() + p.staerke.slice(1);
  return {
    art: 'start',
    titel: minuten <= 20 ? `Gleich ${wort}` : `${wort} in ${minuten} Min.`,
    text: `${p.startUhr}–${p.endeUhr} · ${p.summe < 0.3
      ? 'kaum messbar' : `${p.summe.toFixed(1)} mm`} · ${p.rat}`,
    merker: { art: 'start', start: p.start, vorlauf: minuten, wann: Date.now(), regnete: false }
  };
}

/* Die Regenlage der nächsten Stunden in einzelne Phasen zerlegt: wann jede
   beginnt, wann sie endet, wie stark und wie viel. Grundlage sind die
   Viertelstundenwerte — feiner geht es bei Open-Meteo nicht. */
async function regenLage(lat, lon) {
  const p = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'auto',
    minutely_15: 'precipitation', hourly: 'precipitation_probability',
    forecast_days: '2'
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
  if (!res.ok) return null;
  const d = await res.json();

  const zeiten = d.minutely_15?.time || [];
  const werte = d.minutely_15?.precipitation || [];
  const jetzt = Date.now();

  /* Open-Meteo liefert Ortszeit ohne Zeitzonenkürzel ("2026-07-28T05:15").
     Der Worker läuft in UTC — ohne Umrechnung läge alles um den Zeitversatz
     daneben. Deshalb als UTC lesen und den Versatz abziehen. */
  const versatz = (d.utc_offset_seconds ?? 0) * 1000;
  const alsZeit = (t) => Date.parse(t + 'Z') - versatz;
  const uhr = (i) => zeiten[i].slice(11, 16);          // steht schon in Ortszeit da

  /* Regenrisiko der nächsten zwei Stunden — die Bremse für den Radarabruf.
     Sieht das Modell überhaupt keine Möglichkeit von Regen, braucht auch
     das Radar nicht befragt zu werden. */
  const hZeiten = d.hourly?.time || [];
  const hProb = d.hourly?.precipitation_probability || [];
  let risiko = 0;
  for (let k = 0; k < hZeiten.length; k++) {
    const t = Date.parse(hZeiten[k] + 'Z') - (d.utc_offset_seconds ?? 0) * 1000;
    if (t + 36e5 > jetzt && t < jetzt + 2 * 36e5) risiko = Math.max(risiko, hProb[k] ?? 0);
  }

  const ab = zeiten.findIndex(t => alsZeit(t) + 9e5 > jetzt);
  if (ab < 0) return null;
  const horizont = Math.min(zeiten.length, ab + 24);   // sechs Stunden voraus

  /* Empfindlich wie ein Regenalarm: Sobald von oben etwas kommt, wird es
     gemeldet. Die Schwelle liegt deshalb an der Nachweisgrenze der Modelle.

     Der Fehler in der Nacht zum 1. August war nicht die Empfindlichkeit,
     sondern die Wortwahl: Bei 0,1 mm hieß es „Regen hört gegen 05:00 auf" —
     das klingt nach Schütten, draußen waren es ein paar Tropfen. Gemeldet
     wird jetzt alles, aber mit dem Wort, das zur Menge passt. Wer „ein paar
     Tropfen" liest, weiß, dass die Jacke reicht; wer „Regen" liest, nimmt
     den Schirm. */
  const NASS = 0.05;               // je Viertelstunde = 0,2 mm/h, Nachweisgrenze
  const MELDE_SUMME = 0.05;        // ein einzelner nasser Abschnitt genügt
  const phasen = [];
  let i = ab;
  while (i < horizont) {
    if ((werte[i] ?? 0) < NASS) { i++; continue; }
    let j = i, summe = 0, spitze = 0;
    while (j < zeiten.length && (werte[j] ?? 0) >= NASS) {
      summe += werte[j]; spitze = Math.max(spitze, werte[j]); j++;
    }
    phasen.push({
      start: alsZeit(zeiten[i]),
      ende: j < zeiten.length ? alsZeit(zeiten[j]) : alsZeit(zeiten[j - 1]) + 9e5,
      startUhr: uhr(i),
      endeUhr: uhr(Math.min(j, zeiten.length - 1)),
      summe, spitze,
      /* Vier Stufen statt drei, und die unterste heißt nicht „Regen".
         Bezug ist die Spitze je Viertelstunde: 0,15 entspricht 0,6 mm/h. */
      staerke: spitze >= 2.5 ? 'kräftiger Regen'
             : spitze >= 0.8 ? 'Regen'
             : spitze >= 0.15 ? 'leichter Regen'
             : 'ein paar Tropfen',
      /* Was das im Alltag heißt — dieselben Stufen wie in der App. Eine
         Meldung ohne Handlungshinweis zwingt zum Nachschauen. */
      rat: spitze >= 2.5 ? 'ohne Schirm sofort nass'
         : spitze >= 0.8 ? 'Schirm mitnehmen'
         : spitze >= 0.15 ? 'kleiner Schirm genügt'
         : 'Kapuze reicht',
      leicht: spitze < 0.15
    });
    i = j + 1;
  }
  /* Phasen, die insgesamt zu wenig bringen, werden verworfen — sie stehen
     in der App weiterhin als „ein paar Tropfen", lösen aber nichts aus. */
  const echte = phasen.filter(p => p.summe >= MELDE_SUMME);
  if (!echte.length) return { laeuft: null, naechste: null, risiko };
  phasen.length = 0;
  phasen.push(...echte);
  if (!phasen.length) return { laeuft: null, naechste: null, risiko };

  // Regnet es jetzt schon, ist die erste Phase die laufende
  const esRegnet = (werte[ab] ?? 0) >= NASS && phasen[0].start <= jetzt + 9e5;
  const laeuft = esRegnet ? phasen[0] : null;
  const rest = esRegnet ? phasen.slice(1) : phasen;
  const naechste = rest[0] || null;

  // Nur ankündigen, was in den nächsten zwei Stunden anfängt
  if (naechste && naechste.start - jetzt > 2 * 36e5 && !laeuft) return { laeuft: null, naechste: null, risiko };

  if (naechste && rest[1]) naechste.danachPause = rest[1].startUhr;
  return { laeuft, naechste, risiko };
}

/* ── Radar-Alarm: was das Gitter verpasst ───────────────────
   Das Rechenmodell arbeitet mit Maschen von zwei Kilometern. Ein Sommer-
   schauer ist oft kleiner und fällt damit zwischen die Zahlen. Nachgemessen
   am 1. August über Tübingen: Das Modell hatte für den Nachmittag nichts,
   das Radar zeigte von 13:35 bis 14:00 Regen über der Stadt — wer draußen
   war, wurde nass, und es kam keine Meldung.

   Deshalb schaut der Wächter bei Schauerlage zusätzlich aufs Radar. Nicht
   immer: Ein Abruf kostet zwanzig Anfragen an den DWD, und an einem
   wolkenlosen Tag wäre das reine Verschwendung. Zwei Bremsen:
   · nur, wenn das Modell überhaupt Regenrisiko sieht (RADAR_AB_RISIKO)
   · höchstens zwei Orte je Durchgang, gleiche Orte werden zusammengefasst */
const RADAR_AB_RISIKO = 25;          // Prozent Regenwahrscheinlichkeit
const RADAR_PRO_LAUF  = 2;           // verschiedene Orte je Fünf-Minuten-Takt
const RADAR_NASS      = 0.2;         // mm/h über der eigenen Zelle
const RADAR_NAHE      = 0.5;         // mm/h im Umkreis von 2,5 km

const imRadargebiet = (lat, lon) =>
  lat > 46.5 && lat < 56 && lon > 4.5 && lon < 16.5;

/* Ein Wert vom DWD-Radar, umgerechnet in Millimeter je Stunde. */
async function radarWert(lat, lon, t) {
  const zeit = new Date(t).toISOString().replace(/\.\d+Z$/, '.000Z');
  const bb = `${(lon - 0.05).toFixed(4)},${(lat - 0.05).toFixed(4)},`
           + `${(lon + 0.05).toFixed(4)},${(lat + 0.05).toFixed(4)}`;
  const u = 'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.3.0'
    + '&request=GetFeatureInfo&layers=dwd:Radar_rv_product_1x1km_ger'
    + '&query_layers=dwd:Radar_rv_product_1x1km_ger&crs=CRS:84'
    + `&bbox=${bb}&width=101&height=101&i=50&j=50`
    + `&info_format=application/json&time=${encodeURIComponent(zeit)}`;
  try {
    const r = await withTimeout(fetch(u, { cf: { cacheTtl: 240, cacheEverything: true } }), 8000);
    if (!r.ok) return null;
    const d = await r.json();
    const v = d?.features?.[0]?.properties?.RV_ANALYSIS;
    return typeof v === 'number' && v >= 0 ? v * 12 : 0;
  } catch { return null; }
}

/* Die Stufen wie in der App, hier aber aus dem Stundenwert gebildet. Die
   Modellphasen rechnen in Millimetern je Viertelstunde — deshalb steht
   `spitze` unten umgerechnet da, sonst gälten für Radar und Modell
   verschiedene Maßstäbe bei gleichem Wort. */
function radarStufe(mmH) {
  if (mmH >= 10) return { staerke: 'kräftiger Regen', rat: 'ohne Schirm sofort nass', leicht: false };
  if (mmH >= 3.2) return { staerke: 'Regen',          rat: 'Schirm mitnehmen',        leicht: false };
  if (mmH >= 0.6) return { staerke: 'leichter Regen', rat: 'kleiner Schirm genügt',   leicht: false };
  return             { staerke: 'ein paar Tropfen', rat: 'Kapuze reicht',           leicht: true };
}

/** Regenlage aus dem Radar, in derselben Form wie `regenLage()`. */
async function radarLage(lat, lon, tz) {
  const jetzt = Math.floor(Date.now() / 300000) * 300000;
  const zeiten = [0, 10, 20, 30].map(m => jetzt + m * 60000);
  const dLat = 2.5 / 111;
  const dLon = 2.5 / (111 * Math.cos(lat * Math.PI / 180));
  // Mitte zuerst, dann der Ring — die Reihenfolge wird unten gebraucht
  const orte = [[lat, lon], [lat + dLat, lon], [lat - dLat, lon],
                [lat, lon + dLon], [lat, lon - dLon]];

  const reihe = [];
  for (const t of zeiten) {
    const werte = await Promise.all(orte.map(([a, b]) => radarWert(a, b, t)));
    if (typeof werte[0] !== 'number') return null;      // ohne den eigenen Wert keine Aussage
    const ring = werte.slice(1).filter(v => typeof v === 'number');
    reihe.push({ t, mm: werte[0], umfeld: ring.length ? Math.max(...ring) : 0 });
  }

  const nass = (x) => x.mm >= RADAR_NASS || x.umfeld >= RADAR_NAHE;
  const uhr = (t) => uhrzeit(new Date(t), tz || 'Europe/Berlin');

  /* Aus den Zehn-Minuten-Schritten eine Phase bauen. Feiner geht es nicht,
     ohne die Zahl der Abrufe zu verdoppeln — und für „gleich wird es nass"
     reichen zehn Minuten. */
  const bauePhase = (vonIdx) => {
    let bis = vonIdx, spitzeH = 0, summe = 0;
    while (bis < reihe.length && nass(reihe[bis])) {
      spitzeH = Math.max(spitzeH, reihe[bis].mm, reihe[bis].umfeld * 0.6);
      summe += Math.max(reihe[bis].mm, reihe[bis].umfeld * 0.6) / 6;   // zehn Minuten
      bis++;
    }
    const endeT = bis < reihe.length ? reihe[bis].t : reihe[reihe.length - 1].t + 6e5;
    const stufe = radarStufe(spitzeH);
    return {
      start: reihe[vonIdx].t, ende: endeT,
      startUhr: uhr(reihe[vonIdx].t), endeUhr: uhr(endeT),
      summe, spitze: spitzeH / 4,          // mm/h → mm je Viertelstunde
      ...stufe, offen: bis >= reihe.length
    };
  };

  /* Reicht der Regen über das Fenster hinaus, bleibt `offen` gesetzt — dann
     wird unten keine Restdauer behauptet, sondern „hält an". Diese Phase
     ganz zu verschweigen wäre der schlechteste Ausweg: Dauerregen ist genau
     der Fall, in dem eine Meldung zählt. */
  if (nass(reihe[0])) return { laeuft: bauePhase(0), naechste: null, quelle: 'radar' };
  const ab = reihe.findIndex(x => nass(x));
  if (ab < 0) return { laeuft: null, naechste: null, quelle: 'radar' };
  return { laeuft: null, naechste: bauePhase(ab), quelle: 'radar' };
}

/** KV-Schlüssel aus der Abo-Adresse — die ist je Gerät eindeutig. */
function aboSchluessel(endpoint) {
  let h = 0;
  for (let i = 0; i < endpoint.length; i++) h = (h * 31 + endpoint.charCodeAt(i)) | 0;
  return `abo:${(h >>> 0).toString(36)}:${endpoint.slice(-24).replace(/[^\w-]/g, '')}`;
}

function json(obj, status, origin, cache) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...cors(origin), 'content-type': 'application/json',
      ...(cache ? { 'cache-control': cache } : {})
    }
  });
}

/* ── Ratenbegrenzung ────────────────────────────────────────
   Für alles, was Geld kostet oder den privaten Mac belastet. Gezählt wird je
   Absenderadresse in Zeitfenstern; ohne das könnte ein Skript in Minuten das
   Guthaben leerlaufen lassen oder Kennwörter durchprobieren. */
/* Der Zähler lag früher im Schlüsselspeicher. Damit war JEDE gezählte
   Anfrage ein Schreibvorgang — und davon erlaubt der kostenlose Tarif nur
   tausend am Tag. Ein einziger Nachmittag Ausprobieren brachte die Hälfte
   davon zusammen und hätte am Abend die Regenmeldungen lahmgelegt.

   Der Zwischenspeicher von Cloudflare zählt genauso gut und zählt gegen
   kein Kontingent. Er wird je Rechenzentrum getrennt gehalten, die Grenze
   wirkt also etwas großzügiger als angegeben. Für den Zweck — Missbrauch
   bremsen, nicht exakt abrechnen — genügt das. */
async function zuVieleAnfragen(env, request, bereich, grenze, fensterSek) {
  const ip = request.headers.get('cf-connecting-ip') || 'unbekannt';
  const fenster = Math.floor(Date.now() / (fensterSek * 1000));
  const key = new Request(
    `https://zaehler.wetterfunk/${bereich}/${fenster}/${encodeURIComponent(ip)}`);
  try {
    const cache = caches.default;
    const alt = await cache.match(key);
    const stand = alt ? (Number(await alt.text()) || 0) : 0;
    if (stand >= grenze) return true;
    await cache.put(key, new Response(String(stand + 1), {
      headers: { 'cache-control': `max-age=${Math.max(60, fensterSek)}` }
    }));
    return false;
  } catch {
    return false;        // Zähler kaputt? Dann lieber durchlassen als sperren
  }
}

/** Nur die echten Push-Dienste der Hersteller. */
function istPushDienst(endpoint) {
  try {
    const h = new URL(endpoint).hostname;
    return /(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|windows\.com|microsoft\.com)$/.test(h);
  } catch { return false; }
}

/** Vergleich in gleichbleibender Zeit — erschwert das Erraten Zeichen für Zeichen. */
function gleich(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Kurzer Inhaltsschlüssel für den Audio-Zwischenspeicher. */
async function hashText(s) {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 16)
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}
