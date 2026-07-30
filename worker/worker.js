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

      const ziel = 'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.1.1' +
        '&request=GetMap&layers=dwd%3ANiederschlagsradar&srs=EPSG%3A3857' +
        `&format=image%2Fpng&transparent=true&styles=&bbox=${bbox}&width=${px}&height=${px}`;

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
      const { abo, lat, lon, ort, kreis, arten, tz } = req || {};
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
      await env.WF_PUSH.put(key, JSON.stringify({
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
        seit: alt?.seit || Date.now(),
        zuletzt: alt?.zuletzt || 0,
        gemeldet: alt?.gemeldet || null,
        warnGemeldet: alt?.warnGemeldet || [],
        himmelGemeldet: alt?.himmelGemeldet || []
      }));
      return json({ ok: true }, 200, origin);
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
        if (lage) meldung = entscheide(lage, eintrag);
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
          eintrag.warnGemeldet = [...(eintrag.warnGemeldet || []), ...meldung.kennungen].slice(-40);
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

  // Dieselbe Warnung kommt für mehrere Warncells — nach Inhalt entdoppeln
  const schon = new Set(eintrag.warnGemeldet || []);
  const gesehen = new Set();
  const neu = gefunden.filter(w => {
    const k = `${w.type}|${w.level}|${w.event}|${w.start}`;
    if (gesehen.has(k) || schon.has(k)) return false;
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
    kennungen: neu.map(x => `${x.type}|${x.level}|${x.event}|${x.start}`)
  };
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
    // Nur ansagen, wenn das Ende absehbar ist und nicht in zwei Minuten eintritt
    if (minuten < 10 || minuten > 180) return null;

    const gleichesEnde = alt.art === 'ende'
      && Math.abs((alt.ende || 0) - lage.laeuft.ende) < ENDE_TOLERANZ;
    const frischGemeldet = Date.now() - (alt.wann || 0) < NACHFASSEN_MS;
    if (gleichesEnde && frischGemeldet) return null;

    return {
      art: 'ende',
      titel: `Regen hört gegen ${lage.laeuft.endeUhr} Uhr auf`,
      text: `Noch etwa ${minuten} Minuten${lage.naechste
        ? `. Danach ab ${lage.naechste.startUhr} Uhr wieder ${lage.naechste.staerke}.` : '.'}`,
      merker: { art: 'ende', ende: lage.laeuft.ende, wann: Date.now(), regnete: true }
    };
  }

  /* Fall 1b: Es hat aufgehört. Beim letzten Durchgang lief noch Regen —
     dann gehört die Entwarnung dazu, sonst wartet man weiter im Trockenen
     auf ein Ende, das längst eingetreten ist. */
  if (alt.regnete) {
    return {
      art: 'vorbei',
      titel: 'Regen ist durch',
      text: lage.naechste
        ? `Trocken. Ab ${lage.naechste.startUhr} Uhr kommt ${lage.naechste.staerke} nach.`
        : 'Trocken, und in den nächsten Stunden kommt nichts nach.',
      merker: { art: 'vorbei', wann: Date.now(), regnete: false }
    };
  }

  // Fall 2: Es ist trocken und Regen zieht auf
  if (!lage.naechste) return null;
  const p = lage.naechste;
  const schonGesagt = alt.art === 'start' && Math.abs((alt.start || 0) - p.start) < START_TOLERANZ;
  if (schonGesagt) return null;

  const minuten = Math.round((p.start - Date.now()) / 60000);
  return {
    art: 'start',
    titel: minuten <= 20 ? `Gleich ${p.staerke}` : `In ${minuten} Minuten ${p.staerke}`,
    text: `Von ${p.startUhr} bis ${p.endeUhr} Uhr, rund ${p.summe.toFixed(1)} mm.` +
          (p.danachPause ? ` Danach Pause bis ${p.danachPause}.` : ''),
    merker: { art: 'start', start: p.start, wann: Date.now(), regnete: false }
  };
}

/* Die Regenlage der nächsten Stunden in einzelne Phasen zerlegt: wann jede
   beginnt, wann sie endet, wie stark und wie viel. Grundlage sind die
   Viertelstundenwerte — feiner geht es bei Open-Meteo nicht. */
async function regenLage(lat, lon) {
  const p = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'auto',
    minutely_15: 'precipitation', forecast_days: '2'
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

  const ab = zeiten.findIndex(t => alsZeit(t) + 9e5 > jetzt);
  if (ab < 0) return null;
  const horizont = Math.min(zeiten.length, ab + 24);   // sechs Stunden voraus

  const NASS = 0.1;
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
      staerke: spitze >= 2.5 ? 'kräftiger Regen' : spitze >= 0.8 ? 'Regen' : 'leichter Regen'
    });
    i = j + 1;
  }
  if (!phasen.length) return { laeuft: null, naechste: null };

  // Regnet es jetzt schon, ist die erste Phase die laufende
  const esRegnet = (werte[ab] ?? 0) >= NASS && phasen[0].start <= jetzt + 9e5;
  const laeuft = esRegnet ? phasen[0] : null;
  const rest = esRegnet ? phasen.slice(1) : phasen;
  const naechste = rest[0] || null;

  // Nur ankündigen, was in den nächsten zwei Stunden anfängt
  if (naechste && naechste.start - jetzt > 2 * 36e5 && !laeuft) return { laeuft: null, naechste: null };

  if (naechste && rest[1]) naechste.danachPause = rest[1].startUhr;
  return { laeuft, naechste };
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
async function zuVieleAnfragen(env, request, bereich, grenze, fensterSek) {
  const ip = request.headers.get('cf-connecting-ip') || 'unbekannt';
  const fenster = Math.floor(Date.now() / (fensterSek * 1000));
  const key = `rl:${bereich}:${fenster}:${ip}`;
  try {
    const stand = Number(await env.WF_PUSH.get(key)) || 0;
    if (stand >= grenze) return true;
    // Der Eintrag verfällt von selbst — kein Aufräumen nötig
    await env.WF_PUSH.put(key, String(stand + 1), { expirationTtl: Math.max(60, fensterSek * 2) });
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
