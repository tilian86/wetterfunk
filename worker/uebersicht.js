/* Wetterfunk — Übersicht der angemeldeten Geräte
   Nur für den Betreiber. Eigene Adresse, nirgends verlinkt, hinter einem
   Kennwort. Bewusst NICHT in der App: Wer Regenmeldungen einschaltet, soll
   nicht das Gefühl haben, beobachtet zu werden.

   Gezeigt wird genau das, was ohnehin gespeichert sein muss, damit eine
   Meldung am richtigen Ort ankommt. Die Push-Adresse selbst wird nie
   ausgegeben — sie ist der Schlüssel zum Senden, wer sie hat, kann dem
   Gerät Meldungen schicken.

   Die Notiz je Gerät setzt der Betreiber, nicht das Gerät. Ein Namensfeld
   in der App wäre der Anfang davon, dass sich Leute verfolgt fühlen. */

/* Welcher Dienst die Meldung zustellt, verrät grob die Art des Geräts —
   aber weniger, als man denkt: Chrome meldet über Google, auch auf einem
   Mac. „fcm.googleapis.com" heißt also NICHT Android. */
const PUSH_DIENSTE = {
  'web.push.apple.com': 'Apple — iPhone, iPad oder Mac (Safari)',
  'fcm.googleapis.com': 'Google — Chrome oder Edge, gleich auf welchem Gerät',
  'android.googleapis.com': 'Google — Chrome oder Edge',
  'updates.push.services.mozilla.com': 'Mozilla — Firefox'
};

const KOPF = {
  'cache-control': 'no-store, private',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer'
};

const sauber = (s, max) => String(s || '')
  .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export async function uebersicht(url, request, env, { gleich, zuVieleAnfragen }) {
  if (!env.ADMIN_PASSWORT) {
    return new Response('Kennwort ist nicht eingerichtet.\n\n'
      + 'Einmalig setzen mit:  wrangler secret put ADMIN_PASSWORT\n',
      { status: 503, headers: { ...KOPF, 'content-type': 'text/plain; charset=utf-8' } });
  }

  // Die Seite selbst — sie fragt das Kennwort ab und holt die Daten dann
  if (url.pathname === '/uebersicht' && request.method === 'GET') {
    return new Response(SEITE, {
      headers: { ...KOPF, 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (request.method !== 'POST') {
    return new Response('Nicht gefunden', { status: 404, headers: KOPF });
  }

  const antwort = (obj, status = 200) => new Response(JSON.stringify(obj),
    { status, headers: { ...KOPF, 'content-type': 'application/json; charset=utf-8' } });

  // Kennwortversuche begrenzen, sonst ließe sich das Kennwort durchprobieren
  if (await zuVieleAnfragen(env, request, 'adm', 30, 3600)) {
    return antwort({ error: 'Zu viele Versuche — später nochmal' }, 429);
  }

  let req;
  try { req = await request.json(); } catch { req = {}; }
  if (!gleich(req.pw, env.ADMIN_PASSWORT)) {
    return antwort({ error: 'Falsches Kennwort' }, 401);
  }

  // Notiz zu einem Gerät setzen oder löschen
  if (url.pathname === '/uebersicht/notiz') {
    const key = String(req.key || '');
    if (!key.startsWith('abo:')) return antwort({ error: 'Unbekannter Eintrag' }, 400);
    const e = await env.WF_PUSH.get(key, 'json');
    if (!e) return antwort({ error: 'Eintrag gibt es nicht mehr' }, 404);
    e.geraet = sauber(req.notiz, 40);
    await env.WF_PUSH.put(key, JSON.stringify(e));
    return antwort({ ok: true, notiz: e.geraet });
  }

  if (url.pathname !== '/uebersicht/daten') return antwort({ error: 'Nicht gefunden' }, 404);

  const liste = await env.WF_PUSH.list({ prefix: 'abo:' });
  const geraete = [];
  for (const k of liste.keys) {
    const e = await env.WF_PUSH.get(k.name, 'json');
    if (!e) continue;
    const host = (e.abo?.endpoint || '').split('/')[2] || '';
    geraete.push({
      key: k.name,
      notiz: e.geraet || '',
      dienst: PUSH_DIENSTE[host] || host || 'unbekannt',
      ort: e.ort || '', kreis: e.kreis || '',
      lat: e.lat, lon: e.lon,
      /* Viele Nachkommastellen heißen: aus dem Satellitenempfänger, auf
         wenige Meter genau. Wenige heißen: aus der Ortssuche, also die
         Stadtmitte. Der Unterschied gehört sichtbar gemacht. */
      genau: String(e.lat).split('.')[1]?.length > 6 ? 'GPS' : 'Ortssuche',
      tz: e.tz || '',
      arten: e.arten || {},
      seit: e.seit || 0,
      zuletzt: e.zuletzt || 0,
      letzteArt: e.gemeldet?.art || ''
    });
  }
  geraete.sort((a, b) => (b.zuletzt || 0) - (a.zuletzt || 0));
  return antwort({ geraete, stand: Date.now() });
}

/* Die Seite kommt ohne fremde Bausteine aus — kein Skript, kein Stil und
   keine Schrift von außen. Sie soll nichts ins Netz melden. */
const SEITE = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Wetterfunk — angemeldete Geräte</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  /* Muss vor die eigenen display-Regeln: Ein .tor { display: grid } gewinnt
     sonst gegen das hidden-Attribut, und die Kennwortabfrage bleibt nach
     dem Anmelden stehen. */
  [hidden] { display: none !important; }
  body { margin: 0; padding: 22px 16px 60px; background: #0b1220; color: #f7fafd;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .huelle { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .unter { color: #8fa3bb; font-size: 13px; margin: 0 0 22px; }
  .tor { display: grid; gap: 10px; max-width: 320px; }
  input, button { font: inherit; }
  input { padding: 11px 13px; border-radius: 10px; background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.14); color: #f7fafd; width: 100%; }
  input:focus { outline: none; border-color: #6cc6ff; }
  button { padding: 11px 18px; border-radius: 10px; border: 0; background: #6cc6ff;
    color: #04121f; font-weight: 700; cursor: pointer; }
  button.klein { padding: 7px 12px; font-size: 13px; background: rgba(255,255,255,.1); color: #cfe0f2; }
  .fehler { color: #ff8f8f; font-size: 13px; min-height: 18px; }
  .karte { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1);
    border-radius: 14px; padding: 15px 16px; margin-bottom: 12px; }
  .kopf { display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    margin-bottom: 10px; flex-wrap: wrap; }
  .kopf b { font-size: 16px; }
  .kopf span { color: #8fa3bb; font-size: 12px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; margin: 0 0 12px; font-size: 13.5px; }
  dt { color: #8fa3bb; }
  dd { margin: 0; }
  dd a { color: #6cc6ff; }
  .marke { display: inline-block; padding: 1px 7px; border-radius: 20px; font-size: 11px;
    background: rgba(108,198,255,.18); color: #6cc6ff; margin-left: 6px; }
  .marke.gps { background: rgba(255,159,106,.18); color: #ff9f6a; }
  .notiz { display: flex; gap: 8px; align-items: center; }
  .notiz input { flex: 1; }
  .hinweis { color: #8fa3bb; font-size: 12px; line-height: 1.55; margin-top: 24px;
    border-top: 1px solid rgba(255,255,255,.1); padding-top: 14px; }
</style>
</head><body><div class="huelle">
<h1>Angemeldete Geräte</h1>
<p class="unter">Wer Meldungen eingeschaltet hat — und wohin sie gehen.</p>

<div id="tor" class="tor">
  <input type="password" id="pw" placeholder="Kennwort" autocomplete="current-password">
  <button id="rein">Ansehen</button>
  <p class="fehler" id="fehler"></p>
</div>

<div id="liste" hidden></div>
<p class="hinweis" id="fuss" hidden></p>

<script>
const $ = (s) => document.querySelector(s);
let pw = '';

const zeit = (ms) => !ms ? 'nie' : new Date(ms).toLocaleString('de-DE',
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const artenText = (a) => Object.entries(a || {})
  .filter(([, an]) => an)
  .map(([n]) => ({ regen: 'Regen', warnungen: 'Warnungen', aufgang: 'Sonnenaufgang',
    hoechststand: 'Höchststand', untergang: 'Sonnenuntergang', mondaufgang: 'Mondaufgang' }[n] || n))
  .join(', ') || 'nichts';

async function ruf(pfad, daten) {
  const r = await fetch(pfad, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pw, ...daten }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('Server ' + r.status));
  return d;
}

function zeichne(d) {
  const box = $('#liste');
  box.textContent = '';
  d.geraete.forEach((g, i) => {
    const k = document.createElement('div');
    k.className = 'karte';

    const kopf = document.createElement('div');
    kopf.className = 'kopf';
    const b = document.createElement('b');
    b.textContent = g.notiz || ('Gerät ' + (i + 1));
    const s = document.createElement('span');
    s.textContent = 'zuletzt gemeldet: ' + zeit(g.zuletzt) + (g.letzteArt ? ' (' + g.letzteArt + ')' : '');
    kopf.append(b, s);

    const dl = document.createElement('dl');
    const zeile = (label, wert, knoten) => {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd');
      if (knoten) dd.append(knoten); else dd.textContent = wert;
      dl.append(dt, dd);
    };
    zeile('Dienst', g.dienst);
    zeile('Ort', g.ort + (g.kreis ? ' · ' + g.kreis : ''));

    const koord = document.createElement('span');
    const a = document.createElement('a');
    a.href = 'https://www.openstreetmap.org/?mlat=' + g.lat + '&mlon=' + g.lon + '#map=17/' + g.lat + '/' + g.lon;
    a.target = '_blank'; a.rel = 'noreferrer';
    a.textContent = Number(g.lat).toFixed(5) + ', ' + Number(g.lon).toFixed(5);
    const m = document.createElement('span');
    m.className = 'marke' + (g.genau === 'GPS' ? ' gps' : '');
    m.textContent = g.genau === 'GPS' ? 'aus GPS — auf Meter genau' : 'aus der Ortssuche — Stadtmitte';
    koord.append(a, m);
    zeile('Koordinaten', '', koord);

    zeile('Zeitzone des Geräts', g.tz);
    zeile('Meldungen', artenText(g.arten));
    zeile('Angemeldet seit', zeit(g.seit));

    const notiz = document.createElement('div');
    notiz.className = 'notiz';
    const feld = document.createElement('input');
    feld.value = g.notiz; feld.placeholder = 'Notiz, z. B. Jeanettes iPhone'; feld.maxLength = 40;
    const knopf = document.createElement('button');
    knopf.className = 'klein'; knopf.textContent = 'Merken';
    knopf.onclick = async () => {
      knopf.disabled = true;
      try { await ruf('/uebersicht/notiz', { key: g.key, notiz: feld.value });
            b.textContent = feld.value || ('Gerät ' + (i + 1)); knopf.textContent = 'Gemerkt'; }
      catch (e) { knopf.textContent = e.message; }
      finally { setTimeout(() => { knopf.textContent = 'Merken'; knopf.disabled = false; }, 1600); }
    };
    notiz.append(feld, knopf);

    k.append(kopf, dl, notiz);
    box.append(k);
  });

  box.hidden = false;
  const f = $('#fuss');
  f.textContent = d.geraete.length + ' Gerät(e) angemeldet. Gespeichert wird nur, was zum '
    + 'Verschicken einer Meldung nötig ist: Ort, Zeitzone und die Adresse des Push-Dienstes. '
    + 'Keine Namen, keine Konten, kein Verlauf. Die Koordinaten aktualisieren sich, wenn die '
    + 'Person die App öffnet — es ist kein laufender Standort.';
  f.hidden = false;
}

async function laden() {
  $('#fehler').textContent = '';
  try {
    const d = await ruf('/uebersicht/daten', {});
    $('#tor').hidden = true;
    zeichne(d);
  } catch (e) {
    pw = '';
    $('#fehler').textContent = e.message;
  }
}

$('#rein').onclick = () => { pw = $('#pw').value; laden(); };
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#rein').click(); });
</script>
</div></body></html>`;
