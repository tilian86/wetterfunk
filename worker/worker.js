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

   Ist der Mac aus, meldet /ai das ehrlich zurück; es gibt bewusst keinen
   kostenpflichtigen Ausweichweg.

   Einrichten:
     wrangler deploy
     wrangler secret put BRIDGE_URL      # https://…ts.net
     wrangler secret put BRIDGE_SECRET   # gleiches Geheimnis wie in der Bridge
     wrangler secret put VAPID_PRIVATE   # privater Schlüssel für Web Push
*/

import { sendPush } from './push.js';

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
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Origin nicht erlaubt' }, 403, origin);
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
      const { abo, lat, lon, ort } = req || {};
      if (!abo?.endpoint || !abo?.keys?.p256dh || !abo?.keys?.auth) {
        return json({ error: 'Unvollständiges Abo' }, 400, origin);
      }
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return json({ error: 'Standort fehlt' }, 400, origin);
      }

      // Beim Ortswechsel wird derselbe Eintrag überschrieben. Den Zeitpunkt
      // der letzten Meldung übernehmen, sonst käme sofort wieder eine.
      const key = aboSchluessel(abo.endpoint);
      const alt = await env.WF_PUSH.get(key, 'json');
      await env.WF_PUSH.put(key, JSON.stringify({
        abo, lat, lon, ort: String(ort || '').slice(0, 60),
        seit: alt?.seit || Date.now(), zuletzt: alt?.zuletzt || 0
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

      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      if (!req?.system || !req?.user) {
        return json({ error: 'system und user werden gebraucht' }, 400, origin);
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

  for (const eintragMeta of liste.keys) {
    const eintrag = await env.WF_PUSH.get(eintragMeta.name, 'json');
    if (!eintrag) continue;

    try {
      const lage = await regenLage(eintrag.lat, eintrag.lon);
      if (!lage) continue;

      const meldung = entscheide(lage, eintrag);
      if (!meldung) continue;
      if (Date.now() - (eintrag.zuletzt || 0) < MIN_ABSTAND) continue;

      const status = await sendPush(eintrag.abo, JSON.stringify({
        titel: meldung.titel, text: meldung.text, art: meldung.art
      }), env);

      // 404/410 heißt: Gerät hat das Abo verworfen
      if (status === 404 || status === 410) {
        await env.WF_PUSH.delete(eintragMeta.name);
        continue;
      }
      if (status < 300) {
        eintrag.zuletzt = Date.now();
        eintrag.gemeldet = meldung.merker;
        await env.WF_PUSH.put(eintragMeta.name, JSON.stringify(eintrag));
      }
    } catch (e) {
      console.log('Regenprüfung fehlgeschlagen:', eintragMeta.name, e.message);
    }
  }
}

/** Aus der Lage und dem zuletzt Gemeldeten ableiten, ob etwas zu sagen ist. */
function entscheide(lage, eintrag) {
  const alt = eintrag.gemeldet || {};

  // Fall 1: Es regnet gerade — melden, wann es aufhört
  if (lage.laeuft) {
    const schonGesagt = alt.art === 'ende'
      && Math.abs((alt.ende || 0) - lage.laeuft.ende) < START_TOLERANZ;
    if (schonGesagt) return null;
    // Nur ansagen, wenn das Ende absehbar ist und nicht in zwei Minuten eintritt
    const minuten = Math.round((lage.laeuft.ende - Date.now()) / 60000);
    if (minuten < 10 || minuten > 180) return null;
    return {
      art: 'ende',
      titel: `Regen hört gegen ${lage.laeuft.endeUhr} Uhr auf`,
      text: `Noch etwa ${minuten} Minuten${lage.naechste
        ? `. Danach ab ${lage.naechste.startUhr} Uhr wieder ${lage.naechste.staerke}.` : '.'}`,
      merker: { art: 'ende', ende: lage.laeuft.ende }
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
    merker: { art: 'start', start: p.start }
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}
