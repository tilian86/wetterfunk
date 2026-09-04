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

    // ── Meldung von einem eigenen Dienst (z. B. Limit-Wächter) ──
    // Schickt eine freie Nachricht an ALLE Push-Abos dieses Geräts.
    // Geschützt mit demselben Geheimnis wie die Mac-Brücke.
    if (url.pathname === '/push/melden' && request.method === 'POST') {
      if (!env.BRIDGE_SECRET ||
          request.headers.get('x-bridge-secret') !== env.BRIDGE_SECRET) {
        return json({ error: 'Nicht erlaubt' }, 403, origin);
      }
      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      const titel = String(req?.titel || 'Meldung').slice(0, 100);
      const text = String(req?.text || '').slice(0, 300);
      if (!text) return json({ error: 'text fehlt' }, 400, origin);
      const nutz = JSON.stringify({ titel, text, art: String(req?.art || 'dienst') });

      /* Dienst-Meldungen (Limit-Wächter & Co.) sind PRIVAT und gehen
         ausschließlich an die eigenen Geräte. Vorher ging jede an ALLE
         Wetterfunk-Abos — fremde Nutzer bekamen also Meldungen, die sie
         nichts angehen. Wer "eigen" ist, steht in KV unter 'dienst:eigene'
         als Liste von Namensteilen, z. B. ["Florian"]; verglichen wird mit
         dem Gerätenamen aus den Push-Einstellungen.
         Fehlt der Eintrag, wird NICHTS verschickt — lieber keine Meldung
         als eine an Fremde. */
      const eigene = await env.WF_PUSH.get('dienst:eigene', 'json');
      if (!Array.isArray(eigene) || !eigene.length) {
        return json({ error: 'Keine eigenen Geräte hinterlegt (dienst:eigene)' }, 409, origin);
      }
      const istEigen = (name) => {
        const n = String(name || '').toLowerCase();
        return !!n && eigene.some(t => n.includes(String(t).toLowerCase()));
      };

      const liste = await env.WF_PUSH.list({ prefix: 'abo:' });
      let ok = 0, weg = 0, fremd = 0;
      for (const k of liste.keys) {
        const eintrag = await env.WF_PUSH.get(k.name, 'json');
        if (!eintrag?.abo) continue;
        if (!istEigen(eintrag.geraet)) { fremd++; continue; }
        try {
          const status = await sendPush(eintrag.abo, nutz, env);
          if (status === 404 || status === 410) { await env.WF_PUSH.delete(k.name); weg++; }
          else if (status < 300) ok++;
        } catch { /* ein totes Abo darf den Rest nicht aufhalten */ }
      }
      return json({ ok, entfernt: weg, uebersprungen: fremd }, 200, origin);
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
    /* ── EIN Deutschland-Bild je Fünf-Minuten-Schritt ─────────
       Kacheln einzeln beim DWD zu holen hieß: jede Ansicht, jeder Nutzer,
       jeder Zoom eine eigene teure Anfrage (kalt 3-14 s). Hier ist der
       Schlüssel für ALLE gleich — nur der Zeitstempel. Vergangene Schritte
       ändern sich nie und liegen dauerhaft in R2; damit zahlt weltweit
       genau EINER pro Schritt den kalten DWD-Abruf, alle danach bekommen
       das Bild in Millisekunden. Die App schneidet ihre Kacheln selbst. */
    if (url.pathname === '/dwdbild') {
      const zeit = url.searchParams.get('time') || '';
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(\.000)?Z$/.test(zeit)) {
        return json({ error: 'time fehlt oder ist ungültig' }, 400, origin);
      }
      const ms = Date.parse(zeit);
      // RV reicht 2 h zurück ohne Grenze (R2 hält 3 Tage) und 2 h voraus
      if (!isFinite(ms) || ms > Date.now() + 2 * 3600e3) {
        return json({ error: 'Zeitpunkt außerhalb des Fensters' }, 400, origin);
      }
      const vergangen = ms <= Date.now() - 5 * 60000;
      const kopf = (maxAge, dauerhaft) => ({
        ...cors(origin),
        'content-type': 'image/png',
        'cache-control': `public, max-age=${maxAge}${dauerhaft ? ', immutable' : ''}`
      });

      /* Nutzungsmarke für den Cron: Solange die App in den letzten zwei
         Stunden Radarbilder wollte, wärmt er auch die Vorhersageschritte
         vor. Geschrieben wird höchstens alle 20 Minuten — das KV-Kontingent
         (1000 Schreibvorgänge/Tag frei) bleibt praktisch unberührt. */
      ctx.waitUntil((async () => {
        const marke = +(await env.WF_PUSH.get('radar:aktiv') || 0);
        if (Date.now() - marke > 20 * 60000) {
          await env.WF_PUSH.put('radar:aktiv', String(Date.now()));
        }
        /* Nach einer Pause hat der Cron nichts vorgewärmt — die Zeitleiste
           wäre also genau dann kalt, wenn jemand sie zuerst antippt
           (gemessen 2,8 bis 9,3 s je Schritt). Deshalb hier sofort selbst
           anstoßen, statt bis zu fünf Minuten auf den nächsten Cron zu
           warten. Höchstens alle vier Minuten, damit sich die Läufe nicht
           überlappen. */
        const letzte = +(await env.WF_PUSH.get('radar:warm') || 0);
        if (Date.now() - letzte > 4 * 60000) {
          await env.WF_PUSH.put('radar:warm', String(Date.now()));
          await radarBildVorwaermen(env, true);
        }
      })().catch(() => {}));

      /* Getrennte Ablagen: bild/ hält die endgültige Analyse (für immer
         gültig), fc/ die Vorhersage des jüngsten Rechenlaufs. Läge beides
         unter einem Schlüssel, bekäme man für einen vergangenen Zeitpunkt
         womöglich die alte VORHERSAGE statt der Messung. */
      if (vergangen) {
        const da = await env.RADAR_BILDER.get(`bild/${zeit}`);
        if (da) return new Response(da.body, { headers: kopf(86400, true) });
      } else {
        const fc = await env.RADAR_BILDER.get(`fc/${zeit}`);
        /* Vorhandenes SOFORT ausliefern und bei Bedarf im Hintergrund
           erneuern. Eine harte Frischegrenze war hier falsch: Sie war
           enger als die Laufzeit des Crons, und ein knapp herausgefallener
           Schritt kostete den Nutzer wieder 8 bis 23 Sekunden — genau das,
           was das Vorwärmen verhindern soll. Jetzt wartet niemand mehr auf
           den DWD; das Bild ist höchstens einen Rechenlauf alt, und der
           nächste Abruf bekommt die frische Fassung. */
        const alterMin = fc ? (Date.now() - fc.uploaded.getTime()) / 60000 : Infinity;
        if (fc && alterMin < 20) {
          if (alterMin > 5) {
            ctx.waitUntil((async () => {
              const neu = await deutschlandBild(zeit);
              if (neu) await env.RADAR_BILDER.put(`fc/${zeit}`, neu);
            })().catch(() => {}));
          }
          return new Response(fc.body, { headers: kopf(120, false) });
        }
      }

      const daten = await deutschlandBild(zeit);
      if (!daten) return json({ error: 'DWD liefert dieses Bild nicht' }, 502, origin);
      ctx.waitUntil(env.RADAR_BILDER.put(
        vergangen ? `bild/${zeit}` : `fc/${zeit}`, daten.slice(0)));
      return new Response(daten, { headers: kopf(vergangen ? 86400 : 120, vergangen) });
    }

    if (url.pathname === '/dwdradar') {
      const bbox = url.searchParams.get('bbox') || '';
      /* Untergrenze 64 statt 256: Die App fragt jetzt EIN Pixel je
         Radarzelle an (1 km) und glättet selbst beim Vergrößern — bei
         einem 30-km-Ausschnitt sind das 30 Pixel, nicht 256. */
      const px = Math.min(1024, Math.max(64, +url.searchParams.get('px') || 512));
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

      const wms = (ebene, zeitStr) => 'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.1.1' +
        `&request=GetMap&layers=${ebene}&srs=EPSG%3A3857` +
        `&format=image%2Fpng&transparent=true&styles=&bbox=${bbox}&width=${px}&height=${px}` +
        (zeitStr ? `&time=${encodeURIComponent(zeitStr)}` : '');

      /* Notnagel: Das Messbild („Niederschlagsradar") fiel am 19.08. stunden-
         lang mit 500ern aus — größenunabhängig, ein DWD-Problem. Das RV-
         Produkt lief dabei ungestört weiter, und sein Analyse-Schritt trägt
         dieselben Daten. Deshalb: Scheitert das Messbild, die letzten drei
         Fünf-Minuten-Schritte des RV-Produkts durchprobieren, statt dem
         Nutzer ein leeres Jetzt-Bild zu zeigen. */
      const kandidaten = zeitOk
        ? [wms('dwd%3ARadar_rv_product_1x1km_ger', zeit)]
        : (() => {
            const takt = Math.floor(Date.now() / 300000) * 300000;
            const rv = (ms) => wms('dwd%3ARadar_rv_product_1x1km_ger',
              new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z'));
            return [wms('dwd%3ANiederschlagsradar', ''),
                    rv(takt), rv(takt - 300000), rv(takt - 600000)];
          })();

      try {
        let res = null;
        for (const ziel of kandidaten) {
          try {
            /* Vergangene Zeitpunkte ändern sich NIE — ein Radarbild von
               vor einer Stunde ist morgen noch dasselbe. Die bisherigen
               fünf Minuten für alles waren der Grund, warum die Zeitleiste
               dauernd neu beim DWD anfragte. Gemessen: eine kalte Anfrage
               mit Zeitstempel kostet den DWD 7 bis 14 Sekunden, eine warme
               0,12. Also: Vergangenes einen Tag halten, nur das laufende
               Bild kurz. */
            const alterMin = zeitOk ? (Date.now() - Date.parse(zeit)) / 60000 : 0;
            const ttl = alterMin > 12 ? 86400 : 300;
            res = await withTimeout(
              fetch(ziel, { cf: { cacheTtl: ttl, cacheEverything: true } }), 12000);
            if (res.ok && /image\/png/i.test(res.headers.get('content-type') || '')) break;
          } catch { res = null; }
          res = res && null;
        }
        if (!res) {
          return json({ error: 'DWD liefert derzeit kein Radarbild' }, 502, origin);
        }
        const alterMin = zeitOk ? (Date.now() - Date.parse(zeit)) / 60000 : 0;
        const maxAge = alterMin > 12 ? 86400 : 300;
        return new Response(res.body, {
          headers: {
            ...cors(origin),
            'content-type': 'image/png',
            /* `immutable` nur für Vergangenes — das Jetzt-Bild ändert
               sich alle fünf Minuten und darf nicht als unveränderlich
               ausgezeichnet werden. */
            'cache-control': `public, max-age=${maxAge}`
              + (maxAge > 300 ? ', immutable' : '')
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

      /* Fertigen Verlauf aus R2, wenn er frisch ist. Die Berechnung kostet
         rund 35 DWD-Abfragen und gemessen 3 bis 8 Sekunden — pro
         Fuenf-Minuten-Schritt lohnt sie sich genau einmal. Der Cron stoesst
         sie im Voraus an, sodass der Nutzer den fertigen Stand vorfindet. */
      const vKey = `verlauf/${lat.toFixed(3)},${lon.toFixed(3)}`;
      const vDa = await env.RADAR_BILDER.get(vKey);
      if (vDa && Date.now() - new Date(vDa.uploaded).getTime() < 6 * 60000) {
        return new Response(await vDa.text(), {
          headers: { ...cors(origin), 'content-type': 'application/json',
                     'cache-control': 'public, max-age=120' }
        });
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
          /* Vergangene Zeitpunkte aendern sich nie — ein Messwert von vor
             zehn Minuten ist morgen derselbe. Mit pauschal vier Minuten
             wurde jeder Aufruf neu beim DWD geholt: gemessen 5,6 bis 8,2
             Sekunden, reproduzierbar, fuer 539 Byte Antwort. Vergangenes
             gilt jetzt einen Tag, nur Gegenwart und Vorhersage kurz. */
          const alterMin = (Date.now() - t) / 60000;
          const ttl = alterMin > 6 ? 86400 : 240;
          const r = await withTimeout(
            fetch(u, { cf: { cacheTtl: ttl, cacheEverything: true } }), 8000);
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
      const koerper = JSON.stringify({ punkte: werte, einheit: 'mm/h',
                                       umkreisKm: RING_KM, quelle: 'DWD RV 1 km' });
      ctx.waitUntil(env.RADAR_BILDER.put(vKey, koerper));
      return new Response(koerper, {
        headers: { ...cors(origin), 'content-type': 'application/json',
                   'cache-control': 'public, max-age=120' }
      });
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

    /* ── Amtliche Warnungen im Ausland (MeteoAlarm) ───────────
       In Deutschland kommen die Warnungen vom DWD. Jenseits der Grenze
       schweigt der aber, und genau dort wird eine Wetter-App gebraucht.
       MeteoAlarm ist kein eigener Wetterdienst, sondern das gemeinsame
       Sprachrohr der nationalen Dienste: Was hier ankommt, hat GeoSphere
       Austria, ARSO oder das kroatische DHMZ selbst herausgegeben — die
       amtliche Warnung des jeweiligen Landes, nur in einem einheitlichen
       Format.

       Die App schickt mit, in welchen Warngebieten sie steht; gefiltert
       wird hier, damit aufs Handy nur das Nötige geht. Österreich hat
       gerade über 400 laufende Warnungen — ungefiltert wären das ein paar
       hundert Kilobyte für eine Handvoll Zeilen.

       Kosten: Der Feed-Abruf hängt im Randspeicher von Cloudflare
       (`cacheTtl`), also holt ihn ein Aufruf alle zehn Minuten wirklich.
       Kein einziger KV-Schreibvorgang — das Tageslimit bleibt unberührt. */
    if (url.pathname === '/auslandswarnungen') {
      const MA_LAENDER = {
        AT: 'austria', SI: 'slovenia', HR: 'croatia', IT: 'italy', HU: 'hungary',
        CH: 'switzerland', FR: 'france', ES: 'spain', NL: 'netherlands', BE: 'belgium',
        LU: 'luxembourg', CZ: 'czechia', PL: 'poland', SK: 'slovakia', DK: 'denmark',
        SE: 'sweden', NO: 'norway', FI: 'finland', GR: 'greece', PT: 'portugal',
        IE: 'ireland', RO: 'romania', BG: 'bulgaria', RS: 'serbia', ME: 'montenegro',
        BA: 'bosnia-herzegovina', EE: 'estonia', LV: 'latvia', LT: 'lithuania',
        IS: 'iceland', MT: 'malta', CY: 'cyprus', MD: 'moldova', UA: 'ukraine',
        GB: 'united-kingdom'
      };
      /* Deutschland fehlt mit Absicht: Dafür ist der DWD zuständig, und der
         deutsche MeteoAlarm-Feed ist über acht Megabyte groß. */

      const land = (url.searchParams.get('land') || '').toUpperCase();
      const feed = MA_LAENDER[land];
      if (!feed) return json({ error: 'Für dieses Land gibt es keinen Feed' }, 400, origin);

      /* Warnart und -stufe stecken bei MeteoAlarm nicht im Freitext, sondern
         in zwei festen Kennziffern. Die sind in allen Ländern gleich — also
         lässt sich das Wichtigste auf Deutsch anzeigen, auch wenn Kroatien
         seine Beschreibung nur auf Englisch mitschickt. */
      const ARTEN = {
        1: 'Sturm', 2: 'Schnee und Eis', 3: 'Gewitter', 4: 'Nebel', 5: 'Hitze',
        6: 'Kälte', 7: 'Küste', 8: 'Waldbrand', 9: 'Lawinen', 10: 'Regen',
        11: 'Hochwasser', 12: 'Überflutung', 13: 'Regen und Hochwasser'
      };
      const kenn = (info, name) => {
        const p = (info.parameter || []).find(x => x.valueName === name);
        return p ? String(p.value) : '';
      };

      const gebiete = new Set((url.searchParams.get('gebiete') || '')
        .split('|').map(s => s.trim()).filter(Boolean));

      try {
        const res = await withTimeout(fetch(
          `https://feeds.meteoalarm.org/api/v1/warnings/feeds-${feed}`,
          { headers: { 'Accept': '*/*' }, cf: { cacheTtl: 600, cacheEverything: true } }
        ), 12000);
        if (!res.ok) return json({ error: `MeteoAlarm antwortet ${res.status}` }, 502, origin);
        const daten = await res.json();

        const jetzt = Date.now();
        const gesammelt = new Map();

        for (const eintrag of (daten.warnings || [])) {
          const alarm = eintrag.alert || {};
          if (alarm.status && alarm.status !== 'Actual') continue;
          if (alarm.msgType === 'Cancel') continue;

          const bloecke = alarm.info || [];
          /* Deutsch, wenn das Land es liefert (Österreich, Schweiz), sonst
             Englisch. Die Landessprache hilft hier niemandem weiter. */
          const info = bloecke.find(i => (i.language || '').startsWith('de'))
                    || bloecke.find(i => (i.language || '').startsWith('en'))
                    || bloecke[0];
          if (!info) continue;

          const stufe = parseInt(kenn(info, 'awareness_level'), 10) || 0;
          if (stufe < 2) continue;          // grün heißt „keine Warnung“
          const art = parseInt(kenn(info, 'awareness_type'), 10) || 0;

          const von = Date.parse(info.onset || info.effective || alarm.sent || '') || null;
          const bis = Date.parse(info.expires || '') || null;
          if (bis && bis <= jetzt) continue;

          const treffer = (info.area || [])
            .filter(a => !gebiete.size || gebiete.has(a.areaDesc))
            .map(a => a.areaDesc);
          if (!treffer.length) continue;

          /* Dieselbe Warnung kommt für jedes Gebiet einzeln. Zusammenfassen,
             sonst steht in Wien dieselbe Meldung dreiundzwanzigmal. */
          const schluessel = `${art}|${stufe}|${von}|${bis}|${info.event || ''}`;
          const alt = gesammelt.get(schluessel);
          if (alt) { for (const t of treffer) alt.orte.add(t); continue; }

          gesammelt.set(schluessel, {
            orte: new Set(treffer),
            art, artName: ARTEN[art] || 'Wetterwarnung', stufe,
            event: info.event || ARTEN[art] || 'Wetterwarnung',
            headline: info.headline || '',
            description: info.description || '',
            instruction: info.instruction || '',
            start: von, end: bis,
            sprache: (info.language || '').slice(0, 2),
            sender: info.senderName || alarm.sender || ''
          });
        }

        const warnungen = [...gesammelt.values()]
          .map(w => ({ ...w, gebiete: [...w.orte].sort(), orte: undefined }))
          .sort((a, b) => b.stufe - a.stufe || (a.start || 0) - (b.start || 0))
          .slice(0, 40);

        return json({ land, stand: jetzt, warnungen }, 200, origin, 'public, max-age=600');
      } catch (e) {
        return json({ error: `MeteoAlarm nicht erreichbar: ${e.message}` }, 502, origin);
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
      const { abo, lat, lon, ort, kreis, arten, tz, geraet, nachtruhe } = req || {};
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
        /* Nachtruhe ist AUS, solange sie niemand einschaltet: Wer nachts
           unterwegs ist, will wissen, dass Regen kommt — und wer schlafen
           will, stellt das Telefon leise. Diese Entscheidung gehört dem
           Gerät, nicht dem Worker. */
        nachtruhe: nachtruhe === true,
        /* Freiwilliger Gerätename. Ein Browser gibt keine Gerätekennung
           heraus — ohne diesen Namen sind zwei iPhones am selben Ort in der
           Übersicht nicht auseinanderzuhalten. Steuerzeichen raus, damit die
           Übersicht lesbar bleibt. Ein leeres Feld löscht den alten Namen. */
        geraet: typeof geraet === 'string'
          ? geraet.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30)
          : (alt?.geraet || ''),
        seit: alt?.seit || Date.now(),
        gesehen: alt?.gesehen || 0,
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
        && !!alt.nachtruhe === neu.nachtruhe
        && JSON.stringify(alt.arten || {}) === JSON.stringify(neu.arten);

      /* „Wann war dieses Gerät zuletzt da?" — die Frage lag bisher offen.
         Angezeigt wurde nur, wann zuletzt eine MELDUNG hinausging; wer
         die App täglich öffnet, aber seit Tagen keinen Regen hatte, sah
         einen wochenalten Stempel und musste ihn zwangsläufig für ein
         Versäumnis der App halten. Der Standort hatte dasselbe Problem:
         Er wird nur bei Änderung geschrieben, also stand dort ein Wert
         ohne Datum — richtig oder Wochen alt, nicht unterscheidbar.

         Warum nicht bei jedem Öffnen stempeln: Genau das war der Grund
         für die Schreibsperre oben — der kostenlose Tarif gibt tausend
         Schreibvorgänge am Tag her. Ein Stempel alle sechs Stunden reicht
         für die Frage völlig und kostet je Gerät höchstens vier davon. */
      const GESEHEN_ABSTAND = 6 * 3600 * 1000;
      const stempelFaellig = Date.now() - (alt?.gesehen || 0) > GESEHEN_ABSTAND;
      if (stempelFaellig) neu.gesehen = Date.now();

      if (!unveraendert || stempelFaellig) {
        await env.WF_PUSH.put(key, JSON.stringify(neu));
        /* Nur wenn wirklich ein Gerät DAZUKOMMT. Die App meldet ihren
           Standort bei jedem Öffnen nach; würde das Verzeichnis dabei
           jedes Mal verworfen, listete die Wache gleich wieder auf — und
           genau die Auflistungen sollen ja weg. */
        if (!alt) await aboIndexVerwerfen(env);
      }
      return json({ ok: true, geschrieben: !unveraendert || stempelFaellig }, 200, origin);
    }

    if (url.pathname === '/push/aus' && request.method === 'POST') {
      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      if (!req?.endpoint) return json({ error: 'endpoint fehlt' }, 400, origin);
      await env.WF_PUSH.delete(aboSchluessel(req.endpoint));
      await aboIndexVerwerfen(env);
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
      ctx.waitUntil(aboIndexNeu(env).catch(() => {}));
      ctx.waitUntil(radarBilderPutzen(env));
      return;
    }
    ctx.waitUntil(regenPruefen(env));
    ctx.waitUntil(verlaufVorwaermen(env).catch(() => {}));
    ctx.waitUntil(radarBildVorwaermen(env).catch(() => {}));

    /* Nachzügler: Der Prüflauf hatte genau EINEN Versuch um 03:20. Blieb
       Open-Meteo oder Bright Sky einmal stumm, war der Tag für immer weg —
       nachgezählt fehlten so der 29. und 30. August und der 2. September,
       obwohl die Daten längst dalagen (von Hand angestoßen lief jeder
       dieser Tage anstandslos durch). Deshalb bis zum Mittag stündlich ein
       weiterer Anlauf. Er kostet fast nichts: Liegt das Ergebnis schon vor,
       steigt taeglichePruefung() nach einem einzigen KV-Lesevorgang aus. */
    const jetzt = new Date();
    if (jetzt.getUTCMinutes() < 5 && jetzt.getUTCHours() >= 4 && jetzt.getUTCHours() <= 11) {
      ctx.waitUntil(taeglichePruefung(env).catch(() => {}));
    }
  }
};

/* Eine feste Ruhezeit von drei Stunden wäre zu grob: Hört Regen auf und fängt
   eine Stunde später wieder an, will man das wissen. Gemeldet wird deshalb
   jede neue Regenphase — erkannt an ihrem Startzeitpunkt — und zusätzlich das
   Ende der laufenden. Wiederholungen derselben Phase unterbleiben, solange
   sich der Startzeitpunkt nicht wesentlich verschiebt. */
const START_TOLERANZ = 25 * 60000;   // Verschiebt sich der Beginn stärker, ist es eine neue Lage
const MIN_ABSTAND    = 20 * 60000;   // Nie öfter als alle 20 Minuten irgendetwas melden

/* ── Verzeichnis der Abos ─────────────────────────────────
   Die Regenwache lief alle fünf Minuten und listete jedes Mal alle Abos
   auf — zweimal sogar, einmal für die Wache und einmal fürs Vorwärmen.
   Macht 576 Auflistungen am Tag, erlaubt sind 1.000. Cloudflare hat
   deshalb gewarnt, dass die Hälfte des Tageskontingents weg ist.

   Auflisten ist die knappste Währung im kostenlosen Tarif; Lesen gibt es
   hundertmal so oft. Also steht die Namensliste jetzt in einem einzigen
   Eintrag, und die Wache liest den. Aufgelistet wird nur noch, wenn das
   Verzeichnis fehlt — also nach einer An- oder Abmeldung und einmal
   nachts zur Sicherheit, falls es je auseinanderläuft.

   Der Schlüssel heißt bewusst NICHT `abo:…`: Sonst fiele er den anderen
   Stellen, die nach `abo:` auflisten, als vermeintliches Gerät in die Hand. */
export const ABO_INDEX = 'index:abos';

export async function aboEintraege(env) {
  try {
    const namen = await env.WF_PUSH.get(ABO_INDEX, 'json');
    if (Array.isArray(namen)) return namen.map((name) => ({ name }));
  } catch {}
  return aboIndexNeu(env);
}

async function aboIndexNeu(env) {
  const liste = await env.WF_PUSH.list({ prefix: 'abo:' });
  const namen = liste.keys.map((k) => k.name);
  try { await env.WF_PUSH.put(ABO_INDEX, JSON.stringify(namen)); } catch {}
  return namen.map((name) => ({ name }));
}

/* Nach jeder Änderung an den Abos wegwerfen — dann baut der nächste
   Durchgang es neu. Ein neues Gerät wartet so nie auf seine erste Meldung. */
async function aboIndexVerwerfen(env) {
  try { await env.WF_PUSH.delete(ABO_INDEX); } catch {}
}


async function regenPruefen(env) {
  const liste = { keys: await aboEintraege(env) };
  if (!liste.keys.length) return;

  // Amtliche Warnungen einmal für alle holen, nicht je Abo
  const warnungen = await ladeWarnungen();

  /* Zwei Geräte am selben Ort sollen nicht zwei Radarabfragen auslösen —
     auf zwei Kilometer gerundet ist es derselbe Schauer. Der Vorrat begrenzt,
     wie viele verschiedene Orte je Durchgang aufs Radar dürfen. */
  const radarSpeicher = new Map();
  let radarVorrat = RADAR_PRO_LAUF;

  /* Cloudflare erlaubt 50 ausgehende Anfragen je Durchgang. Fest verplant
     sind: eine für die Warnungen, je Gerät eine für das Modell und im
     Zweifel eine für die Meldung selbst. Was übrig bleibt, gehört dem
     Radar — ein Vorposten kostet bis zu 2 (jetzt und der Trend +30 Min),
     eine Gegenprobe vor dem Senden 1 bis 2, ein voller Blick 20.

     Vorher stand hier nur „höchstens zwei Orte". Das reichte, solange nur
     der teure Blick am Radar hing; mit dem Vorposten je Gerät wäre die
     Grenze ab dem fünften Gerät gerissen — und zwar stillschweigend, denn
     Cloudflare wirft die überzähligen Anfragen einfach weg. */
  const radarBudget = Math.max(0, 46 - 2 * liste.keys.length);
  let radarAusgegeben = 0;
  const reichtFuer = (n) => radarAusgegeben + n <= radarBudget;

  /* ── Wach-Journal ─────────────────────────────────────────
     Der Prüflauf maß bisher nur das Modell — den 5. August (Regen ohne
     Meldung) hätte er nie bemerkt. Hier schreibt der Wächter deshalb mit,
     was das Radar am Ort sah (nur bei Änderung nass/trocken) und was
     gemeldet oder unterdrückt wurde. Nachts rechnet meldungsBilanz daraus
     die einzige Zahl, die für den Nutzer zählt: Wurde gemeldet, wenn es
     regnete — und regnete es, wenn gemeldet wurde? Ein Schlüssel je Tag
     (Ortszeit), höchstens eine Schreibaktion je Durchgang. */
  const wachTag = new Intl.DateTimeFormat('en-CA',
    { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  const journal = (await env.WF_PUSH.get(`wach:${wachTag}`, 'json')) || { eintraege: [] };
  let journalNeu = false;
  const merke = (o, art, extra = {}) => {
    if (art === 'obs') {
      // Nur Übergänge festhalten — sonst schriebe jeder trockene Tag 288-mal
      for (let i = journal.eintraege.length - 1; i >= 0; i--) {
        const e = journal.eintraege[i];
        if (e.o === o && e.art === 'obs') {
          if (e.nass === extra.nass) return;
          break;
        }
      }
    }
    journal.eintraege.push({ t: Date.now(), o, art, ...extra });
    if (journal.eintraege.length > 500) journal.eintraege = journal.eintraege.slice(-500);
    journalNeu = true;
  };

  for (const eintragMeta of liste.keys) {
    const eintrag = await env.WF_PUSH.get(eintragMeta.name, 'json');
    if (!eintrag) continue;
    const arten = eintrag.arten || { regen: true, warnungen: true };

    try {
      let meldung = null;
      let regenlage = null;
      const ortKey = typeof eintrag.lat === 'number'
        ? `${eintrag.lat.toFixed(2)},${eintrag.lon.toFixed(2)}` : '?';

      /* Amtliche Warnungen haben Vorrang: Ein Unwetter ist wichtiger als die
         Ankündigung von Nieselregen. */
      if (arten.warnungen && warnungen) {
        meldung = warnungMelden(warnungen, eintrag);
      }
      /* Himmelstermine vor dem Regen: Ein Sonnenaufgang lässt sich nicht
         nachholen, eine Regenmeldung schon — die gilt für zwei Stunden. */
      if (!meldung) meldung = himmelMelden(eintrag);
      if (!meldung && arten.regen) {
        const lage = regenlage = await regenLage(eintrag.lat, eintrag.lon);
        if (lage) {
          /* Das Modell schweigt, aber es ist Schauerlage: Dann entscheidet
             das Radar. Genau hier lag der Fall vom 1. August — das Gitter
             hatte nichts, über der Stadt ging ein Schauer nieder. */
          const stillJetzt = !lage.laeuft
            && (!lage.naechste || lage.naechste.start - Date.now() > 30 * 60000);
          /* Zwei Wege zum Radar: Das Modell hält Regen für möglich — oder
             der Vorposten meldet, dass es bereits fällt. Der zweite Weg
             wird nur beschritten, wenn der erste zu ist; sonst zahlte man
             die Vorposten-Anfrage umsonst. */
          let radarNoetig = false, obsErfasst = false;
          if (stillJetzt && imRadargebiet(eintrag.lat, eintrag.lon)) {
            radarNoetig = (lage.risiko ?? 0) >= RADAR_AB_RISIKO;
            if (!radarNoetig && radarVorrat > 0 && reichtFuer(2)) {
              radarAusgegeben += 2;
              const vp = await radarVorposten(eintrag.lat, eintrag.lon);
              if (vp) {
                merke(ortKey, 'obs', { nass: vp.nun >= RADAR_NASS,
                                       mm: Math.round(vp.nun * 100) / 100 });
                obsErfasst = true;
                radarNoetig = vp.nun >= RADAR_NASS || (vp.gleich ?? 0) >= RADAR_NAHE;
              }
            }
          }
          if (radarNoetig) {
            const schluessel = ortKey;
            if (!radarSpeicher.has(schluessel) && radarVorrat > 0 && reichtFuer(20)) {
              radarVorrat--;
              radarAusgegeben += 20;
              radarSpeicher.set(schluessel,
                await radarLage(eintrag.lat, eintrag.lon, eintrag.tz));
            }
            const rl = radarSpeicher.get(schluessel);
            if (rl && !obsErfasst) merke(ortKey, 'obs', { nass: !!rl.laeuft });
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

      /* Nachtruhe, falls für dieses Gerät eingeschaltet: zwischen 23 und 6
         Uhr schweigt alles — außer einer amtlichen Unwetterwarnung ab Stufe
         3. Wer nachts gar nichts hören will, schaltet die Meldungen ganz aus
         oder das Telefon leise; ein Unwetter ist der eine Fall, in dem
         Wecken richtig ist. Genau so steht es auch im Schalter. */
      if (nachtruheAktiv(eintrag) && !meldung.dringend) continue;

      /* Warnungen dürfen die Ruhefrist durchbrechen — bei Unwetter zählt
         Zeit. Himmelstermine ebenfalls: Sie kommen höchstens einmal am Tag
         und wären zwanzig Minuten später wertlos. */
      if (meldung.art !== 'warnung' && meldung.art !== 'himmel'
          && Date.now() - (eintrag.zuletzt || 0) < MIN_ABSTAND) continue;

      /* ── Gegenprobe vor dem Senden ──────────────────────
         Eine Regenmeldung aus dem MODELL muss erst am Radar vorbei: „Es
         regnet" wird nur gesendet, wenn es am Ort wirklich nass ist; eine
         Ankündigung mit unter 45 Minuten Vorlauf nur, wenn das Radar zum
         Startzeitpunkt (und zehn Minuten danach) etwas sieht — so weit
         voraus ist das Radar verlässlicher als jedes Modell. Das ist die
         andere Hälfte des Versprechens: nicht nur melden, wenn das Modell
         blind war, sondern auch schweigen, wenn es Gespenster sieht. Wer
         dreimal grundlos aufs Handy schaut, glaubt der vierten Meldung
         nicht mehr.
         Meldungen, deren Zahlen schon vom Radar stammen, sind geprüft.
         Antwortet der DWD nicht (null), wird gesendet: Das Radar darf
         Meldungen verhindern, sein Ausfall darf es nicht. */
      if (regenlage && regenlage.quelle !== 'radar'
          && ['ende', 'haelt', 'start'].includes(meldung.art)
          && imRadargebiet(eintrag.lat, eintrag.lon)) {
        let zeiten = null;
        if (meldung.art !== 'start') {
          zeiten = [Math.floor(Date.now() / 300000) * 300000];
        } else if (regenlage.naechste
                   && regenlage.naechste.start - Date.now() <= 90 * 60000) {
          /* 90 statt 45 Minuten: So weit sieht das RV-Radar voraus, und die
             beiden einzigen Fehlalarme seit Journalstart (16.08.) waren
             Ankündigungen. Der Handel ist bewusst: Widerspricht das Radar
             einer frühen Ankündigung zu Unrecht, kommt die Meldung beim
             nächsten Durchgang mit kürzerem Vorlauf trotzdem — später, aber
             richtig, statt früh und falsch. Ob Unterdrückungen zu Unrecht
             geschahen, zählt die Bilanz ohnehin mit (unterdruecktFalsch). */
          const start = Math.floor(regenlage.naechste.start / 300000) * 300000;
          zeiten = [start, start + 6e5];
        }
        /* Nicht nur die eigene Zelle fragen, sondern auch das Umfeld.
           Unterdrückt wurde bisher, sobald das Radar an GENAU dieser
           1-km-Zelle trocken meldete — derselbe Zufall, den /dwdverlauf an
           anderer Stelle längst berücksichtigt: Ein Sommerschauer ist wenige
           Kilometer groß, ob er die eigene Zelle trifft, ist Glückssache.
           Gemessen: 69 von 260 Unterdrückungen (26 %) waren falsch — es
           regnete innerhalb einer Dreiviertelstunde doch.

           Jetzt zählt auch ein Treffer im Umkreis von 2,5 km als „nass", und
           unterdrückt wird nur, wenn ringsum alles trocken ist. Reicht das
           Anfragebudget dafür nicht, wird NICHT unterdrückt — im Zweifel
           lieber eine Meldung zu viel als ein verpasster Regen. */
        const RING_KM = 2.5;
        const dLat = RING_KM / 111;
        const dLon = RING_KM / (111 * Math.cos(eintrag.lat * Math.PI / 180));
        const punkte = [[eintrag.lat, eintrag.lon],
                        [eintrag.lat + dLat, eintrag.lon],
                        [eintrag.lat - dLat, eintrag.lon],
                        [eintrag.lat, eintrag.lon + dLon],
                        [eintrag.lat, eintrag.lon - dLon]];
        const kosten = zeiten ? zeiten.length * punkte.length : 0;
        if (zeiten && reichtFuer(kosten)) {
          radarAusgegeben += kosten;
          const werte = await Promise.all(
            zeiten.flatMap(t => punkte.map(([a, b]) => radarWert(a, b, t))));
          const eigen = werte.filter((_, i) => i % punkte.length === 0);
          if (eigen.every(v => typeof v === 'number')) {
            if (meldung.art !== 'start') {
              merke(ortKey, 'obs', { nass: eigen[0] >= RADAR_NASS,
                                     mm: Math.round(eigen[0] * 100) / 100 });
            }
            if (!werte.some(v => typeof v === 'number' && v >= RADAR_NASS)) {
              /* Kein Merker, kein zuletzt-Stempel: Der nächste Durchgang
                 prüft neu. Solange das Modell Gespenster sieht, kostet das
                 eine Anfrage alle fünf Minuten — der Preis der Ruhe. */
              merke(ortKey, 'unterdrueckt', { typ: meldung.art });
              continue;
            }
          }
        }
      }

      const status = await sendPush(eintrag.abo, JSON.stringify({
        titel: meldung.titel, text: meldung.text, art: meldung.art,
        // Eigene Kennung je Termin, damit sich die Meldungen nicht ersetzen
        tag: meldung.tag || `wf-${meldung.art}`
      }), env);

      // 404/410 heißt: Gerät hat das Abo verworfen
      if (status === 404 || status === 410) {
        await env.WF_PUSH.delete(eintragMeta.name);
        await aboIndexVerwerfen(env);
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
          if (['start', 'ende', 'haelt'].includes(meldung.art)) {
            merke(ortKey, 'meldung', { typ: meldung.art });
          }
        }
        await env.WF_PUSH.put(eintragMeta.name, JSON.stringify(eintrag));
      }
    } catch (e) {
      console.log('Prüfung fehlgeschlagen:', eintragMeta.name, e.message);
    }
  }

  if (journalNeu) {
    await env.WF_PUSH.put(`wach:${wachTag}`, JSON.stringify(journal),
                          { expirationTtl: 3 * 86400 });
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
    dringend: stufe.dringend,
    titel: `${stufe.dringend ? '⚠️ ' : ''}${stufe.wort}: ${ereignis}`,
    text: `${w.regionName}${bis ? `, bis ${bis} Uhr` : ''}.${weitere} ` +
          `${String(w.description || '').slice(0, 150)}`.trim().slice(0, 180),
    kennungen: neu.map(x => ({ k: `${x.type}|${String(x.event || '').toLowerCase()}`,
                               level: Number(x.level) || 0, wann: Date.now() }))
  };
}

/* Nachtruhe war einmal eine feste Regel des Worker: nachts keine Tropfen.
   Das war anmaßend — wer um zwei noch unterwegs ist, will es wissen, und wer
   schläft, stellt das Telefon leise. Jetzt ist es eine Einstellung im Gerät,
   die AUS ist, solange sie niemand einschaltet. Wer sie einschaltet, hat
   zwischen 23 und 6 Uhr Ruhe — bis auf amtliche Unwetterwarnungen; das steht
   so auch im Schalter. */
const NACHT_VON = 23, NACHT_BIS = 6;
function stundeIn(tz) {
  try {
    /* Auf Deutsch liefert Intl „00 Uhr" statt „00" — `+"00 Uhr"` ist NaN,
       und mit NaN wäre jeder Vergleich stillschweigend falsch. */
    const txt = new Intl.DateTimeFormat('de-DE',
      { hour: '2-digit', hour12: false, timeZone: tz || 'Europe/Berlin' }).format(new Date());
    const h = Number((txt.match(/\d+/) || [])[0]);
    return Number.isFinite(h) ? h : null;
  } catch { return null; }
}
function nachtruheAktiv(eintrag) {
  if (!eintrag?.nachtruhe) return false;
  const h = stundeIn(eintrag.tz);
  return h != null && (h >= NACHT_VON || h < NACHT_BIS);
}

/** Aus der Lage und dem zuletzt Gemeldeten ableiten, ob etwas zu sagen ist. */

function entscheide(lage, eintrag) {
  const alt = eintrag.gemeldet || {};

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
   immer: Ein voller Abruf kostet zwanzig Anfragen an den DWD, und an einem
   wolkenlosen Tag wäre das reine Verschwendung. Höchstens zwei Orte je
   Durchgang, gleiche Orte werden zusammengefasst.

   Am 5. August fiel um 15:45 über Tübingen 1,5 mm Regen. ICON-D2 sagte für
   den ganzen Nachmittag 0,0 mm und höchstens 20 % Risiko — unter der
   damaligen Schwelle von 25 %. Das Radar wurde deshalb den ganzen
   Nachmittag NICHT befragt, und es kam keine Meldung. Die Bremse hat genau
   den Fall ausgebremst, für den die Einrichtung gebaut wurde.

   Nachgemessen an 57 Tagen gegen die Station Rottenburg-Kiebingen: 19 mal
   fiel Regen, den das Modell mit 0,0 mm gar nicht sah. Davon lagen über
   der Schwelle
       25 %:  5 von 19  (26 %)   ← alte Einstellung
       10 %: 10 von 19  (53 %)   ← beste Ausbeute je Abruf im ganzen Feld
        0 %: 19 von 19  (100 %), aber 24 statt 1,6 Abrufe am Tag

   Daraus zwei Auslöser statt einem:
   · RADAR_AB_RISIKO auf 10 — für Regen, der ERST KOMMT. Das Radar sieht
     nur 90 Minuten voraus, das Modell weiter; unter 10 % lohnt der Abruf
     nachweislich nicht mehr.
   · Ein Vorposten für Regen, der SCHON DA IST: ein einziger Abruf für die
     eigene Zelle, jetzt. Das kostet ein Zwanzigstel und läuft deshalb bei
     jedem Durchgang — auch wenn das Modell 0 % sagt. Nur wenn er nass
     meldet, folgt der volle Blick mit Umfeld und Zeitverlauf.
     Damit hängt „es regnet gerade auf dich" nicht mehr daran, ob das
     Modell den Schauer vorher geahnt hat. */
const RADAR_AB_RISIKO = 10;          // Prozent Regenwahrscheinlichkeit
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

/** Vorposten: Regnet es GERADE über dieser Koordinate — oder in einer
    halben Stunde? Ein bis zwei Abrufe statt zwanzig, billig genug für jeden
    Durchgang. Der zweite Schritt schaut auf den Radar-Trend +30 Minuten und
    fängt damit Schauer, die anrollen, während das Modell noch 0 % sagt; er
    entfällt, wenn es schon jetzt nass ist. Für den Trend gilt die höhere
    Schwelle RADAR_NAHE — eine Vorhersage ist unsicherer als eine Messung.
    Fällt der DWD aus, kommt null zurück und es bleibt beim Modell; ein
    stiller Ausfall darf keine Meldung erfinden. */
async function radarVorposten(lat, lon) {
  const takt = Math.floor(Date.now() / 300000) * 300000;
  const nun = await radarWert(lat, lon, takt);
  if (typeof nun !== 'number') return null;
  if (nun >= RADAR_NASS) return { nun, gleich: null };
  const gleich = await radarWert(lat, lon, takt + 30 * 60000);
  return { nun, gleich: typeof gleich === 'number' ? gleich : null };
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


/* Das Deutschland-Bild beim DWD holen: fester Kasten, 1024 x 1396 (eine
   Zelle je Kilometer), mit derselben Rückfalllogik wie die Kachelabrufe.
   Gemessen: 141 KB, kalt 7-9 s — aber eben nur EINMAL je Zeitschritt. */
const DE_BBOX = '612257,5942074,1725452,7459517';

async function deutschlandBild(zeit) {
  const u = 'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.1.1' +
    '&request=GetMap&layers=dwd%3ARadar_rv_product_1x1km_ger&srs=EPSG%3A3857' +
    '&format=image%2Fpng&transparent=true&styles=' +
    `&bbox=${DE_BBOX}&width=1024&height=1396&time=${encodeURIComponent(zeit)}`;
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      const r = await withTimeout(fetch(u, { cf: { cacheTtl: 300, cacheEverything: true } }), 20000);
      if (r.ok && /image\/png/i.test(r.headers.get('content-type') || '')) {
        return await r.arrayBuffer();
      }
    } catch { /* zweiter Versuch */ }
    await new Promise((x) => setTimeout(x, 1200));
  }
  return null;
}

/* Beim Fünf-Minuten-Lauf den frischen Analyse-Schritt nach R2 legen: Dann
   trifft schon der ERSTE Nutzer eines Schritts auf das fertige Bild und
   niemand wartet je auf den kalten DWD-Abruf der Vergangenheit. */
async function radarBildVorwaermen(env, erzwingen = false) {
  const takt = Math.floor(Date.now() / 300000) * 300000 - 300000;   // letzter fertiger Schritt
  const zeit = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');

  // Die Analyse immer — sie ist danach für immer gültig
  if (!(await env.RADAR_BILDER.head(`bild/${zeit(takt)}`))) {
    const daten = await deutschlandBild(zeit(takt));
    if (daten) await env.RADAR_BILDER.put(`bild/${zeit(takt)}`, daten);
  }

  /* Die Vorhersageschritte nur, wenn die App in den letzten zwei Stunden
     benutzt wurde — sonst fragte der Cron den DWD rund um die Uhr für
     niemanden. Mit Vorwärmen ist JEDER Schritt der Zeitleiste beim
     Antippen sofort da, wie in der DWD-App. */
  if (!erzwingen) {
    const marke = +(await env.WF_PUSH.get('radar:aktiv') || 0);
    if (Date.now() - marke > 2 * 3600e3) return;
  }

  /* Bis +120 statt +90: Gezählt wird ab dem letzten FERTIGEN Schritt, der
     schon fünf Minuten zurückliegt. Das RV-Produkt reicht bis +120.

     ABER NICHT ALLE AUF EINMAL: 24 Bilder à 141 KB in einem Lauf zu holen
     und in R2 abzulegen sprengte die Cloudflare-Grenzen — gemessen 71
     „exceededResources" an einem Tag bei nur 129 Erfolgen, 37 am Tag davor.
     Jetzt je Lauf ein Sechstel, reihum durchgewechselt. Der Cron läuft alle
     fünf Minuten, nach spätestens einer halben Stunde ist alles gewärmt. */
  const alle = [];
  for (let m = 5; m <= 120; m += 5) alle.push(takt + m * 60000);
  const TEILE = 6;
  const runde = Math.floor(Date.now() / 300000) % TEILE;
  const schritte = alle.filter((_, k) => k % TEILE === runde);

  let i = 0;
  const kette = async () => {
    while (i < schritte.length) {
      const t = schritte[i++];
      const daten = await deutschlandBild(zeit(t));
      if (daten) await env.RADAR_BILDER.put(`fc/${zeit(t)}`, daten);
    }
  };
  await Promise.all([kette(), kette()]);
}

/* Aufräumen: R2 hält 10 GB frei; ein Tag sind rund 40 MB Bilder. Drei Tage
   reichen der App (die Leiste zeigt 2 h) — Älteres fliegt im Nachtlauf. */
async function radarBilderPutzen(env) {
  const grenze = Date.now() - 3 * 86400e3;
  for (const vorspann of ['bild/', 'fc/']) {
    let cursor;
    do {
      const seite = await env.RADAR_BILDER.list({ prefix: vorspann, cursor });
      const alt = seite.objects.filter((o) => {
        const t = Date.parse(o.key.slice(vorspann.length));
        return isFinite(t) && t < grenze;
      });
      if (alt.length) await env.RADAR_BILDER.delete(alt.map((o) => o.key));
      cursor = seite.truncated ? seite.cursor : null;
    } while (cursor);
  }
}


/* Den Punktverlauf im Voraus rechnen lassen, damit der Nutzer nie auf die
   35 DWD-Abfragen wartet (gemessen 3 bis 8 Sekunden).

   Bewusst ueber einen HTTP-Aufruf an den eigenen Worker statt als
   Funktionsaufruf: So bekommt die schwere Arbeit ein EIGENES
   Unteranfrage-Budget und eigene Rechenzeit. Im Cron selbst gerechnet
   haette sie genau die Grenze gesprengt, an der das Bild-Vorwaermen schon
   einmal gescheitert ist (71 "exceededResources" an einem Tag). Der Cron
   zahlt so nur eine Unteranfrage je Standort. */
async function verlaufVorwaermen(env) {
  const liste = { keys: await aboEintraege(env) };
  const orte = new Map();
  for (const k of liste.keys.slice(0, 4)) {
    const e = await env.WF_PUSH.get(k.name, 'json');
    if (!e || typeof e.lat !== 'number' || typeof e.lon !== 'number') continue;
    orte.set(`${e.lat.toFixed(3)},${e.lon.toFixed(3)}`, e);
  }
  for (const e of orte.values()) {
    await fetch('https://wetterfunk.florian-s-thiel.workers.dev/dwdverlauf'
      + `?lat=${e.lat.toFixed(3)}&lon=${e.lon.toFixed(3)}`,
      { headers: { Origin: 'https://tilian86.github.io' } }).catch(() => {});
  }
}