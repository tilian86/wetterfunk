/* Wetterfunk — Hauptlogik
   Datenquellen: Open-Meteo (Wetter, Luft, Geocoding), DWD (Warnungen), RainViewer (Radar).
   Kein Konto, kein Tracker, kein Backend. Alles bleibt im Browser. */

(() => {
'use strict';

// ══ Konstanten ═════════════════════════════════════════════
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR      = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEO      = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE  = 'https://nominatim.openstreetmap.org/reverse';
const DWD      = 'https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json';

/* ── Ab wann ist Regen Regen? ──────────────────────────────
   Die Modelle geben Niederschlag ab 0,1 mm/h aus, und der WMO-Wettercode
   nennt das schon „leichter Regen". Draußen heißt 0,1 mm: Die Straße ist
   fleckig feucht, man wird nicht nass, man merkt es kaum. Die App hat das
   trotzdem als „Leichte Schauer" angesagt und dafür sogar gemeldet — sie
   war damit pessimistischer als DWD und WetterOnline, die bei derselben
   Lage „bewölkt, 30 % Regenwahrscheinlichkeit" schreiben.

   Deshalb eine gemeinsame Staffelung für die ganze App:

     unter 0,15 mm/h   nichts. Nicht erwähnen.
     bis 0,4 mm/h      Tröpfeln — erwähnen, aber nie „Regen" nennen
                       und nie dafür melden.
     ab 0,4 mm/h       leichter Regen. Ab hier lohnt der Schirm.
     ab 2,5 mm/h       kräftiger Regen.

   Alle Zahlen beziehen sich auf eine Stunde; Viertelstundenwerte werden
   entsprechend umgerechnet. */
const REGEN = {
  nichts:   0.15,   // darunter im Text nicht erwähnt
  troepfeln: 0.6,   // darunter „ein paar Tropfen", kein Regen
  kraeftig:  2.5
};
/** Viertelstundenwert auf Stundenmaß bringen. */
const proStunde = (mm15) => (mm15 ?? 0) * 4;

const MODELS = [
  { id: 'icon_d2',       name: 'ICON-D2',  org: 'DWD',   color: '#5ac8fa', note: '2 km · bis 48 h' },
  { id: 'icon_eu',       name: 'ICON-EU',  org: 'DWD',   color: '#64d2a0', note: '7 km · bis 5 Tage' },
  { id: 'ecmwf_ifs025',  name: 'ECMWF',    org: 'EU',    color: '#ffd426', note: '25 km · bis 15 Tage' },
  { id: 'gfs_seamless',  name: 'GFS',      org: 'NOAA',  color: '#ff9f6a', note: '13 km · bis 16 Tage' },
  /* Zwei weitere, bewusst von anderen Wetterdiensten: Je unabhängiger die
     Rechnungen, desto belastbarer ihr Mittelweg. Mit ihnen trifft die
     Bewölkung 63 statt 59 Prozent der Stunden. */
  { id: 'ukmo_seamless', name: 'Met Office', org: 'UK',  color: '#c58cf0', note: '2 km · bis 7 Tage' },
  { id: 'meteofrance_seamless', name: 'Météo-France', org: 'FR', color: '#7fdca4', note: '1,5 km · bis 4 Tage' }
];

/* ── Bewölkung im Mittelweg mehrerer Modelle ────────────────
   Ein einzelnes Modell irrt bei Wolken erstaunlich oft. Nachgeprüft an
   18 Tagen gegen die Reanalyse: ICON-D2 lag im Mittel 22,2 Prozentpunkte
   daneben und rechnete dabei systematisch 11 Punkte ZU TRÜB — aus
   „sonnig" wurde 27-mal „bedeckt", aus „heiter" 31-mal „bedeckt". Genau
   deshalb wirkte diese App pessimistischer als andere.

   Der Mittelweg aus sechs Modellen liegt bei 16,7 Punkten und trifft das
   angezeigte Wort in 63 statt 57 Prozent der Stunden.

   Für den REGEN bleibt es beim feinen Modell: Ein Sommerschauer ist drei
   Kilometer groß, den sieht ein 25-km-Modell gar nicht. Auflösung, wo sie
   zählt — Mehrheit, wo ein einzelnes Modell überfordert ist. */
let wolkenMittel = null;          // Zeitstempel → Bewölkung in Prozent

function baueWolkenKonsens() {
  wolkenMittel = null;
  /* Wer ausdrücklich ein Modell wählt, bekommt dessen Sicht — auch beim
     Himmel. Der Mittelweg gehört zum automatischen Verfahren. */
  if (effektiveQuelle() !== 'best_match') return;
  const H = modelData?.hourly;
  if (!H?.time) return;
  const felder = MODELS.map(m => H[`cloud_cover_${m.id}`]).filter(Array.isArray);
  if (felder.length < 3) return;

  const karte = new Map();
  for (let i = 0; i < H.time.length; i++) {
    const w = felder.map(f => f[i]).filter(v => v != null).sort((a, b) => a - b);
    /* Unter drei Rechnungen ist es kein Mittelweg mehr. Weiter als zwei
       Tage voraus fällt ICON-D2 weg, dann tragen die übrigen. */
    if (w.length < 3) continue;
    karte.set(H.time[i], w.length % 2
      ? w[(w.length - 1) / 2]
      : Math.round((w[w.length / 2 - 1] + w[w.length / 2]) / 2));
  }
  if (karte.size) wolkenMittel = karte;
}

/** Bewölkung für eine Stunde — Mittelweg, sonst der Wert der Datenquelle. */
const wolkenFuer = (zeitISO, ersatz) => wolkenMittel?.get(zeitISO) ?? ersatz;

/* ── Temperatur ebenfalls aus dem Mittelweg ─────────────────
   Nachgeprüft walk-forward über 30 Tage gegen die nächste Station, die
   Ortskorrektur kannte dabei jeweils nur die Vergangenheit:

     ICON + Ortskorrektur       1,68 °C daneben   (bisheriges Verfahren)
     Mittelweg + Ortskorrektur  1,29 °C           (gewinnt 28 von 30 Tagen)

   23 Prozent weniger Fehler, und der Sieger stand an 28 von 30 Tagen
   fest — das ist kein Münzwurf mehr wie beim verworfenen Modellwechsel.
   Der Regen bleibt beim feinen Modell; für Schauer zählt das Gitter. */
let tempMittel = null;            // Zeitstempel → Grad

function baueTempKonsens() {
  tempMittel = null;
  if (effektiveQuelle() !== 'best_match') return;   // gewählte Modelle bleiben pur
  const H = modelData?.hourly;
  if (!H?.time) return;
  const felder = MODELS.map(m => H[`temperature_2m_${m.id}`]).filter(Array.isArray);
  if (felder.length < 3) return;
  const karte = new Map();
  for (let i = 0; i < H.time.length; i++) {
    const w = felder.map(f => f[i]).filter(v => v != null).sort((a, b) => a - b);
    if (w.length < 3) continue;
    karte.set(H.time[i], w.length % 2
      ? w[(w.length - 1) / 2]
      : +((w[w.length / 2 - 1] + w[w.length / 2]) / 2).toFixed(1));
  }
  if (karte.size) tempMittel = karte;
}

/** Temperaturen der Datenquelle durch den Mittelweg ersetzen. Läuft VOR der
    Ortskorrektur — die lernt inzwischen auf derselben Grundlage. */
function wendeTempMittelAn(fc) {
  if (!tempMittel || !fc?.hourly?.time) return fc;
  if (fc.__tempMittel) return fc;                  // Zwischenspeicher-Schutz
  fc.__tempMittel = true;

  const h = fc.hourly;
  let letzterDelta = 0;
  h.time.forEach((t, k) => {
    const med = tempMittel.get(t);
    if (med == null || h.temperature_2m?.[k] == null) return;
    const delta = med - h.temperature_2m[k];
    letzterDelta = delta;
    h.temperature_2m[k] = med;
    /* Die gefühlte Temperatur liegt nur je Quelle vor, nicht je Modell —
       sie wandert um denselben Betrag mit, ihr Abstand zur Lufttemperatur
       (Wind, Feuchte) bleibt damit erhalten. */
    if (h.apparent_temperature?.[k] != null) {
      h.apparent_temperature[k] = +(h.apparent_temperature[k] + delta).toFixed(1);
    }
  });

  if (fc.current?.temperature_2m != null) {
    const jetzt = nowIndex(h.time);
    const med = tempMittel.get(h.time[jetzt]);
    const delta = med != null ? med - fc.current.temperature_2m : letzterDelta;
    if (med != null) {
      fc.current.temperature_2m = med;
      if (fc.current.apparent_temperature != null) {
        fc.current.apparent_temperature = +(fc.current.apparent_temperature + delta).toFixed(1);
      }
    }
  }

  // Tageswerte nachziehen — wie in wendeVersatzAn, das ohne Station nicht läuft
  if (fc.daily?.time) {
    fc.daily.time.forEach((tag, i) => {
      const werte = [];
      h.time.forEach((t, k) => { if (t.startsWith(tag) && h.temperature_2m[k] != null)
        werte.push(h.temperature_2m[k]); });
      if (werte.length >= 20) {
        if (fc.daily.temperature_2m_max) fc.daily.temperature_2m_max[i] = Math.max(...werte);
        if (fc.daily.temperature_2m_min) fc.daily.temperature_2m_min[i] = Math.min(...werte);
      }
    });
  }
  return fc;
}

/* Der Wettercode kommt aus einem einzigen Modell — und damit auch das
   Zeichen in der Stundenleiste. Ohne diesen Schritt widerspricht sich die
   App: Im Tagesblatt stünde „heiter" aus dem Mittelweg, in der Leiste
   darüber eine Sonne oder eine geschlossene Wolke aus ICON-D2.

   Fällt nichts, richtet sich das Zeichen deshalb nach dem Mittelweg.
   Fällt etwas — oder ist es Nebel oder Gewitter —, bleibt der Code des
   feinen Modells: Dafür ist es da. */
function himmelCode(i) {
  const h = data?.hourly;
  if (!h) return 0;
  const code = h.weather_code[i];
  if (code === 45 || code === 48) return code;          // Nebel
  if (code >= 95) return code;                          // Gewitter
  if ((h.precipitation[i] ?? 0) >= REGEN.nichts) return code;
  const w = wolkenFuer(h.time[i], h.cloud_cover?.[i] ?? 0);
  return w < 25 ? 0 : w < 55 ? 1 : w < 80 ? 2 : 3;
}

/** Auswählbare Datenquellen für Stunden- und Tageswerte. */
const SOURCES = [
  { id: 'best_match', name: 'Bestes Verfahren', desc: 'Automatisch, je Frage das Passende: Regen aus dem feinsten Gitter (in Deutschland DWD ICON-D2, 2 km — ein Schauer ist drei Kilometer groß, den sieht nur ein feines Netz). Temperatur und Himmel aus dem Mittelweg von sechs Modellen, dazu die Ortskorrektur — nachgemessen trifft das deutlich besser als jedes einzelne Modell.', best: true },
  { id: 'icon_seamless', name: 'DWD ICON', desc: 'Deutscher Wetterdienst, nahtlos: D2 (2 km) → EU (7 km) → global (11 km). Das amtliche deutsche Modell.' },
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS', desc: 'Europäisches Zentrum, 25 km. Gilt weltweit als das treffsicherste Globalmodell auf mehrere Tage.' },
  { id: 'gfs_seamless', name: 'GFS', desc: 'US-Wetterdienst NOAA, 13 km. Reicht am weitesten, streut auf kurze Sicht stärker.' },
  { id: 'ukmo_seamless', name: 'UK Met Office', desc: 'Britischer Wetterdienst, 2 km über Westeuropa.' },
  { id: 'meteofrance_seamless', name: 'Météo-France', desc: 'Französisches AROME/ARPEGE, 1,5 km über Mitteleuropa.' }
];

/* Es gab hier kurz eine Quelle „Lernend", die automatisch auf das Modell
   umschaltete, das zuletzt am besten lag. Nachgeprüft an 23 Tagen mit
   mitlaufender Auswertung war sie 13 % SCHLECHTER als einfach bei ICON zu
   bleiben — fünf Tage sind schlicht zu wenig, um einen Sieger zu erkennen
   (in der Stichprobe gewann ECMWF in 55 %, GFS in 40 % der Fälle, also
   Münzwurf). Und ICONs Schwäche ist gar keine Schwäche: Es streut am
   wenigsten von allen, liegt nur um einen festen Betrag zu warm. Ein fester
   Fehler gehört korrigiert, nicht mit einem Modellwechsel beantwortet.
   Deshalb ist die Auswahl wieder ehrlich manuell. */
const sourceId = () => {
  const s = store.get(LS.source, 'best_match');
  // Wer die kurzlebige Quelle „lernend" eingestellt hatte, landet wieder
  // beim besten verfügbaren Modell — sie gibt es nicht mehr.
  if (s === 'lernend') { store.set(LS.source, 'best_match'); return 'best_match'; }
  return s;
};
const effektiveQuelle = () => sourceId();
const sourceOf = (id) => SOURCES.find(s => s.id === id) || SOURCES[0];
const quellenName = () => sourceOf(sourceId()).name;

const LS = {
  places: 'wf.places',
  active: 'wf.active',
  cams:   'wf.cams',
  cache:  'wf.cache',
  source: 'wf.source',
  layers: 'wf.layers'
};

// ══ State ══════════════════════════════════════════════════
let place = null;           // {name, lat, lon, region, county}
let data = null;            // Forecast-Antwort
let air = null;             // Luftqualität + Pollen
let modelData = null;       // Modellvergleich
let activeWarnings = [];    // DWD-Warnungen für diesen Ort
let radarReady = false;
/* Abweichung der Geräteuhr zur Serverzeit, in Millisekunden. Einmal beim
   Start gemessen; die Ringuhr oben rechnet damit, sonst zeigte sie die
   falsche Zeit eines falsch gestellten Geräts. */
let uhrVersatz = 0;

// ══ Hilfsfunktionen ════════════════════════════════════════
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v));
/** Zahl mit deutschem Komma — 0,6 statt 0.6. */
/* Fremdtext, der ins Seitengerüst geht, muss entschärft werden: DWD-Meldungen,
   Nachrichten, Ortsnamen und Modellantworten kommen von außen. Ohne das könnte
   dort stehender Code im Browser ausgeführt werden. */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const dez = (v, n = 1) => (v == null ? "–" : v.toFixed(n).replace(".", ","));

const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

const hhmm = (d) => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const weekday = (d) => new Date(d).toLocaleDateString('de-DE', { weekday: 'short' });
/* „Do" ist über zehn Tage nicht eindeutig: Tag 2 und Tag 9 heißen beide so.
   Überall dort, wo eine Liste über eine Woche hinausreicht, gehört das Datum
   dazu — sonst sucht man das schöne Wochenende in der falschen Zeile. */
const tagDatum = (d) => { const t = new Date(d); return `${t.getDate()}.${t.getMonth() + 1}.`; };

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => (t.hidden = true), 300);
  }, ms);
}

/** Index der aktuellen bzw. nächsten Stunde in einem stündlichen Zeit-Array. */
function nowIndex(times) {
  const now = Date.now();
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]).getTime() + 3600e3 > now) return i;
  }
  return 0;
}

// ══ Datenabruf ═════════════════════════════════════════════
/** Open-Meteo antwortet unter Last gelegentlich mit 429 oder 503. Ein kurzer
    zweiter Anlauf rettet das in aller Regel, statt die Anzeige leer zu lassen. */
async function fetchJSON(url, opts, tries = 3) {
  let lastErr;
  for (let n = 0; n < tries; n++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res.json();
      if (![429, 500, 502, 503, 504].includes(res.status)) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      lastErr = new Error(`${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e;
      if (e.message?.startsWith('4') && !e.message.startsWith('429')) throw e;
    }
    if (n < tries - 1) await new Promise(r => setTimeout(r, 400 * Math.pow(2, n)));
  }
  throw lastErr;
}

/* Der Wetterdienst begrenzt kostenlose Abrufe pro Stunde. Damit häufiges
   Öffnen der App nicht ins Limit läuft, halten wir Antworten kurz vor. */
const CACHE_MIN = 8;

async function fetchCached(url, minuten = CACHE_MIN) {
  const key = `wf.c:${url}`;
  let alt = null;
  try { alt = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
  if (alt && Date.now() - alt.t < minuten * 60000) return alt.d;

  const merken = (d) => {
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch {}
    return d;
  };

  try {
    return merken(await fetchJSON(url, undefined, 1));
  } catch (e) {
    /* Das Abruflimit gilt pro Anschluss. Steckt der eigene fest, hilft der
       Umweg über den eigenen Worker — der zählt auf eine andere Adresse. */
    if (/429/.test(e.message)) {
      try {
        const d = await fetchJSON(`${pushProxy()}/wetter?url=${encodeURIComponent(url)}`);
        umweg = true;
        return merken(d);
      } catch {}
    }
    // Lieber etwas ältere Daten zeigen als gar keine
    if (alt) { veraltet = true; return alt.d; }
    throw e;
  }
}

let veraltet = false, umweg = false, standAlt = null;

/** Mit welcher Quelle die angezeigten Zahlen tatsächlich geladen wurden.
    Die Lernwertung kann den Sieger NACH dem Laden wechseln — dann stimmt
    die Anzeige erst nach der nächsten Aktualisierung, und genau das soll
    sie auch sagen. */
let geladeneQuelle = null;

function loadForecast(lat, lon) {
  const src = effektiveQuelle();
  geladeneQuelle = src;
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '10',
    ...(src !== 'best_match' ? { models: src } : {}),
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day',
      'precipitation', 'weather_code', 'cloud_cover', 'pressure_msl',
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'
    ].join(','),
    minutely_15: 'precipitation,weather_code,temperature_2m,wind_speed_10m,is_day',
    hourly: [
      'temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation',
      'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'uv_index', 'is_day',
      'relative_humidity_2m', 'dew_point_2m', 'visibility', 'cloud_cover',
      'sunshine_duration'
    ].join(','),
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'sunrise', 'sunset',
      'uv_index_max', 'precipitation_sum', 'precipitation_probability_max',
      'wind_speed_10m_max', 'wind_gusts_10m_max', 'sunshine_duration'
    ].join(',')
  });
  return fetchCached(`${FORECAST}?${p}`);
}

function loadAir(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto',
    current: 'european_aqi,pm2_5,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,ragweed_pollen'
  });
  return fetchCached(`${AIR}?${p}`, 20).catch(() => null);
}

function loadModels(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '7',
    hourly: 'temperature_2m,precipitation,cloud_cover',
    models: MODELS.map(m => m.id).join(',')
  });
  return fetchCached(`${FORECAST}?${p}`, 20).catch(() => null);
}

/** DWD-Warnungen. Antwort ist JSONP: warnWetter.loadWarnings({…}); */
async function loadWarnings() {
  try {
    const res = await fetch(DWD, { cache: 'no-store' });
    const txt = await res.text();
    const start = txt.indexOf('{'), end = txt.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    return JSON.parse(txt.slice(start, end + 1));
  } catch { return null; }
}

// ══ Ort ════════════════════════════════════════════════════
async function searchPlaces(q) {
  const p = new URLSearchParams({ name: q, count: '8', language: 'de', format: 'json' });
  const r = await fetchJSON(`${GEO}?${p}`).catch(() => null);
  return (r?.results || []).map(x => ({
    name: x.name,
    lat: x.latitude,
    lon: x.longitude,
    region: [x.admin1, x.country].filter(Boolean).join(' · '),
    county: x.admin3 || x.admin2 || x.name,
    country: x.country_code
  }));
}

async function reverseGeocode(lat, lon) {
  const p = new URLSearchParams({
    lat, lon, format: 'jsonv2', zoom: '10', 'accept-language': 'de'
  });
  const r = await fetchJSON(`${REVERSE}?${p}`).catch(() => null);
  const a = r?.address;
  if (!a) return { name: 'Mein Standort', lat, lon, region: '', county: '' };
  const name = a.city || a.town || a.village || a.municipality || a.county || 'Mein Standort';
  return {
    name,
    lat, lon,
    region: [a.state, a.country].filter(Boolean).join(' · '),
    county: a.county || a.city_district || name,
    country: (a.country_code || '').toUpperCase()
  };
}

/* ── Kleine Ringuhr im Kopf ────────────────────────────────
   Florians Idee war, die große Ringuhr ganz nach oben zu holen und die
   Temperatur hineinzuschreiben. Die große Zahl ist aber der Anker der App —
   in einem Ring würde sie kleiner und müsste sich den Platz teilen, und
   300 Pixel Ring ganz oben drücken alles andere nach unten.

   Deshalb der Mittelweg: ein kleiner Ring neben der Zahl. Er zeigt
   dasselbe wie der große — Nacht, Dämmerung, Tag als Ring, dazu der
   Sonnenpunkt an seiner Stelle — nur auf 76 Pixeln, ohne Beschriftung.
   In der Mitte steht, wie weit der Tag ist. Ein Tippen führt zum vollen
   Abschnitt. Damit sieht man beim Öffnen sofort, wo im Tag man steht. */
const MINI = { r: 30, ring: 7, mitte: 38 };

function renderHeroUhr() {
  const el = $('#heroUhr');
  if (!el || !place || !data?.daily) { if (el) el.hidden = true; return; }

  const jetzt = new Date(Date.now() + uhrVersatz);
  const tagStart = new Date(jetzt); tagStart.setHours(0, 0, 0, 0);
  const ev = sunEvents(jetzt, place.lat, place.lon);
  const w = (t) => (t ? uhrWinkel(new Date(t), tagStart) : null);

  const polarMini = (grad, radius) => {
    const b = (grad - 90) * Math.PI / 180;
    return [MINI.mitte + radius * Math.cos(b), MINI.mitte + radius * Math.sin(b)];
  };
  const segMini = (von, bis, farbe) => {
    let spanne = bis - von;
    if (spanne <= 0) spanne += 360;
    if (spanne >= 359.9) {
      return `<circle cx="${MINI.mitte}" cy="${MINI.mitte}" r="${MINI.r}"
        fill="none" stroke="${farbe}" stroke-width="${MINI.ring}"/>`;
    }
    const [x1, y1] = polarMini(von, MINI.r);
    const [x2, y2] = polarMini(von + spanne, MINI.r);
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A ${MINI.r} ${MINI.r} 0 ${
      spanne > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}"
      fill="none" stroke="${farbe}" stroke-width="${MINI.ring}"/>`;
  };

  const stufen = [
    { bis: w(ev.astroDaemmerung),      farbe: '#141d16' },
    { bis: w(ev.blaueStundeMorgen),    farbe: '#1b3a6b' },
    { bis: w(ev.aufgang),              farbe: '#3f7fd4' },
    { bis: w(ev.goldenEndeMorgen),     farbe: '#ffb347' },
    { bis: w(ev.goldenStartAbend),     farbe: '#ffd60a' },
    { bis: w(ev.untergang),            farbe: '#ffb347' },
    { bis: w(ev.blaueStundeEndeAbend), farbe: '#3f7fd4' },
    { bis: w(ev.astroNacht),           farbe: '#1b3a6b' },
    { bis: 180,                        farbe: '#141d16' }
  ].filter(x => x.bis != null);

  let ring = segMini(-180, 179.99, '#141d16');
  let start = -180;
  for (const st of stufen) {
    if (st.bis > start) ring += segMini(start, st.bis, st.farbe);
    start = st.bis;
  }

  const jetztW = uhrWinkel(jetzt, tagStart);
  const [px, py] = polarMini(jetztW, MINI.r);

  /* Ohne Marken sagt der Ring nur „irgendwo im Tag". Vier Striche genügen:
     neun, zwölf, fünfzehn und achtzehn Uhr. Mittag steht etwas kräftiger da,
     das gibt dem Ring einen Anker — mehr Striche machen ihn bei 76 Pixeln
     nur unruhig. */
  /* Die Striche sitzen außerhalb des Rings, nicht quer darüber: Der Ring
     wechselt im Tagesverlauf von Schwarz über Blau nach Gelb — eine Farbe,
     die auf allen dreien zu sehen ist, gibt es nicht. Außen liegt immer der
     dunkle Himmelsverlauf, dort trägt ein heller Strich. */
  const marken = [9, 12, 15, 18].map(h => {
    const g = uhrWinkel(new Date(tagStart.getTime() + h * 3600000), tagStart);
    const aussen = MINI.r + MINI.ring / 2;
    const [ax, ay] = polarMini(g, aussen + 1.4);
    const [bx, by] = polarMini(g, aussen + (h === 12 ? 4.2 : 3.4));
    return `<path class="hu-marke${h === 12 ? ' ist-mittag' : ''}"
      d="M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}"/>`;
  }).join('');

  /* Dieselbe Rechnung wie der Balken darunter — nachts zählt der Anteil der
     Nacht, nicht ein leerer Tageswert. Vorher stand dort nur „Nacht". */
  const d = data.daily;
  const n = jetzt.getTime();
  const sr = new Date(d.sunrise[0]).getTime();
  const ss = new Date(d.sunset[0]).getTime();
  const srMorgen = d.sunrise[1] ? new Date(d.sunrise[1]).getTime() : sr + 864e5;
  const ssGestern = ss - 864e5;

  let phase, anteil, bis;
  if (n >= sr && n < ss)      { phase = 'Tag';   anteil = (n - sr) / (ss - sr); bis = ss; }
  else if (n >= ss)           { phase = 'Nacht'; anteil = (n - ss) / (srMorgen - ss); bis = srMorgen; }
  else                        { phase = 'Nacht'; anteil = (n - ssGestern) / (sr - ssGestern); bis = sr; }
  anteil = Math.round(Math.max(0, Math.min(1, anteil)) * 100);
  const rest = restZeit(bis);

  /* Eine echte Uhr statt einer Prozentzahl: In der Mitte steht die Zeit,
     der Ring darum zeigt, wo im Tag sie liegt — Nacht dunkel, Dämmerung
     blau, Tag gelb, dazu der Sonnenpunkt an seiner Stelle. Die Prozentzahl
     wandert zurück in den Balken darunter, wo sie direkt neben der
     Tageslänge steht; getrennt sahen die beiden Zahlen widersprüchlich aus
     („noch 13 Std." über „Tag dauert 15 Std."). */
  el.hidden = false;
  el.dataset.phase = phase === 'Tag' ? 'tag' : 'nacht';
  const zeit = jetzt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <svg viewBox="0 0 76 76" class="hu-svg" aria-hidden="true">
      ${ring}
      ${marken}
      <circle class="hu-punkt" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.6"/>
    </svg>
    <span class="hu-mitte"><b class="hu-zeit">${zeit}</b></span>
    <span class="hu-rest">Zeit weltweit</span>`;
  el.title = `${zeit} Uhr — ${phase.toLowerCase()} zu ${anteil} % vorbei, noch ${rest}`;
}

// ══ Rendering: Jetzt ═══════════════════════════════════════
function renderHero() {
  const c = data.current, d = data.daily;

  /* Der Wettercode nennt schon 0,1 mm „leichten Regen" — dann stand oben
     „Leichte Schauer", während draußen nichts fiel. Fällt zu wenig für den
     Code, wird auf die Bewölkung zurückgegriffen: Das beschreibt den Himmel
     ehrlicher als ein Regenwort ohne Regen. */
  const m15 = data.minutely_15;
  const jetzt15 = m15?.time ? proStunde(m15.precipitation?.[nowIndex(m15.time)]) : 0;
  const nassJetzt = (c.precipitation ?? 0) >= REGEN.nichts || jetzt15 >= REGEN.nichts;
  const hi = nowIndex(data.hourly.time);
  /* Dieselbe Regel wie in der Leiste darunter: Fällt nichts, beschreibt
     der Mittelweg den Himmel. Sonst gilt der Code des feinen Modells. */
  const zeigeCode = nassJetzt || c.weather_code === 45 || c.weather_code === 48
                    || c.weather_code >= 95
    ? c.weather_code
    : himmelCode(hi);

  $('#heroIcon').innerHTML = WX.icon(zeigeCode, c.is_day);
  $('#heroTemp').textContent = round(c.temperature_2m);
  $('#heroDesc').textContent = WX.text(zeigeCode, c.is_day);
  $('#heroFeels').textContent = `Gefühlt ${round(c.apparent_temperature)}°`;
  $('#heroMax').textContent = `${round(d.temperature_2m_max[0])}°`;
  $('#heroMin').textContent = `${round(d.temperature_2m_min[0])}°`;
  setMood(WX.mood(zeigeCode, c.is_day), c.is_day);
  renderHeroUhr();
}

/** Zeigt oben, wie weit Tag oder Nacht fortgeschritten sind — als Anhalt
    für den eigenen Rhythmus, nicht als Wetterangabe. */
function renderDayProgress() {
  const el = $('#dayProgress');
  if (!el || !data?.daily) return;
  const d = data.daily;
  const jetzt = Date.now();

  const sr = new Date(d.sunrise[0]).getTime();
  const ss = new Date(d.sunset[0]).getTime();
  const srMorgen = d.sunrise[1] ? new Date(d.sunrise[1]).getTime() : sr + 864e5;
  const ssGestern = ss - 864e5;

  let phase, anteil, bis, seit;
  if (jetzt >= sr && jetzt < ss) {
    phase = 'Tag'; anteil = (jetzt - sr) / (ss - sr); bis = ss; seit = sr;
  } else if (jetzt >= ss) {
    phase = 'Nacht'; anteil = (jetzt - ss) / (srMorgen - ss); bis = srMorgen; seit = ss;
  } else {
    phase = 'Nacht'; anteil = (jetzt - ssGestern) / (sr - ssGestern); bis = sr; seit = ssGestern;
  }
  anteil = Math.max(0, Math.min(1, anteil));

  const restMin = Math.max(0, Math.round((bis - jetzt) / 60000));
  const rest = restMin >= 60
    ? `${Math.floor(restMin / 60)} Std. ${String(restMin % 60).padStart(2, '0')} Min.`
    : `${restMin} Min.`;

  // Wie lang ist diese Phase insgesamt — und wie verändert sie sich?
  const gesamtMin = Math.round((bis - seit) / 60000);
  const dauer = `${Math.floor(gesamtMin / 60)} Std. ${String(gesamtMin % 60).padStart(2, '0')} Min.`;

  /* Der Trend muss zu dem passen, was gerade dasteht: Wird der Tag kürzer,
     wird die Nacht im selben Maß länger. Vorher stand nachts die Änderung
     der Tageslänge — mit falschem Vorzeichen. */
  const tagesLaenge = (i) => (new Date(d.sunset[i]) - new Date(d.sunrise[i])) / 60000;
  const tagDiff = d.sunrise[1] ? Math.round(tagesLaenge(1) - tagesLaenge(0)) : 0;
  const diff = phase === 'Tag' ? tagDiff : -tagDiff;
  const trend = Math.abs(diff) < 1 ? ''
    : ` · morgen ${diff > 0 ? `${diff} Min. länger` : `${-diff} Min. kürzer`}`;

  el.dataset.phase = phase === 'Tag' ? 'tag' : 'nacht';
  // Antippen springt zu Sonne & Licht — dort stehen die Zeiten im Detail
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.onclick = () => {
    const ziel = document.querySelector('.card-cd') || document.querySelector('#tiles');
    if (!ziel) return;
    window.scrollTo({ top: Math.max(0, ziel.getBoundingClientRect().top + window.scrollY - kopfHoehe()),
                      behavior: 'smooth' });
  };
  el.innerHTML = `
    <!-- Anteil und Restzeit stehen hier, direkt über der Gesamtlänge: So
         sieht man, dass die 13 Stunden der Rest von 15 sind. Getrennt
         wirkten die beiden Zahlen widersprüchlich. -->
    <span class="dp-head">
      <span class="dp-label">${phase === 'Tag' ? '☀ Tag' : '☾ Nacht'} zu
        <b>${Math.round(anteil * 100)} %</b> vorbei</span>
      <span class="dp-rest">noch ${rest} von ${dauer}</span>
    </span>
    <span class="dp-bar"><i style="width:${(anteil * 100).toFixed(1)}%"></i></span>
    <span class="dp-ends"><span>${hhmm(seit)}</span>
      <span class="dp-len">${phase === 'Tag' ? 'Sonnenaufgang bis -untergang'
        : 'Untergang bis Aufgang'}${trend}</span>
      <span>${hhmm(bis)}</span></span>`;
}

/** Hintergrundstimmung + Statusleistenfarbe. */
function setMood(mood, isDay) {
  document.body.dataset.mood = mood;
  document.body.dataset.day = isDay ? '1' : '0';
  const colors = {
    clear: '#2b6fd6', partly: '#3d72b8', cloudy: '#4a5b70', rain: '#33465c',
    storm: '#2a3348', snow: '#5a6b80', fog: '#4d5560', night: '#0f1626'
  };
  $('meta[name=theme-color]').setAttribute('content', colors[mood] || '#0b1220');
  renderSkyFx(mood);
}

/** Dezente Partikel: Regentropfen bzw. Schneeflocken im Hintergrund. */
function renderSkyFx(mood) {
  const fx = $('#skyFx');
  if (!['rain', 'storm', 'snow'].includes(mood)) { fx.innerHTML = ''; return; }
  const isSnow = mood === 'snow';
  const n = isSnow ? 26 : 40;
  fx.innerHTML = Array.from({ length: n }, () => {
    const left = (Math.random() * 100).toFixed(1);
    const delay = (Math.random() * 3).toFixed(2);
    const dur = (isSnow ? 6 + Math.random() * 5 : 0.7 + Math.random() * 0.6).toFixed(2);
    const drift = (Math.random() * 40 - 20).toFixed(0);
    return `<i class="${isSnow ? 'flake' : 'rainline'}" style="left:${left}%;animation-delay:-${delay}s;animation-duration:${dur}s;--drift:${drift}px"></i>`;
  }).join('');
}

/* ── Was Millimeter im Alltag bedeuten ─────────────────────
   „Regen (65 %)" sagt einem Laien nichts darüber, ob die Kapuze reicht.
   Millimeter je Stunde sind eine Größe, mit der außerhalb der Meteorologie
   niemand rechnet — also wird sie übersetzt. Die Stufen orientieren sich
   daran, wie schnell man ohne Schutz nass wird. */
function regenKlartext(mmProStunde) {
  const mm = mmProStunde ?? 0;
  if (mm < REGEN.nichts)  return { wort: 'trocken',            rat: '',                                     kurz: '' };
  if (mm < 0.5)           return { wort: 'ein paar Tropfen',   rat: 'Kapuze reicht',                        kurz: 'Kapuze' };
  if (mm < 2)             return { wort: 'leichter Regen',     rat: 'kleiner Schirm genügt',                kurz: 'kleiner Schirm' };
  if (mm < 5)             return { wort: 'Regen',              rat: 'Schirm mitnehmen',                     kurz: 'Schirm' };
  if (mm < 10)            return { wort: 'kräftiger Regen',    rat: 'ohne Schirm in Minuten durchnässt',    kurz: 'großer Schirm' };
  return                         { wort: 'Platzregen',         rat: 'Unterstand suchen, Schirm hilft kaum', kurz: 'Unterstand' };
}

/** Menge und Rat in einem Satzteil: „leichter Regen, 1,2 mm — kleiner Schirm genügt". */
function regenSatzteil(mmProStunde, summe = null) {
  const k = regenKlartext(mmProStunde);
  const menge = summe != null && summe >= 0.1 ? `, ${dez(summe)} mm` : '';
  return `${k.wort}${menge}${k.rat ? ` — ${k.rat}` : ''}`;
}

// ══ Rendering: Klartext-Prognose ═══════════════════════════
/** Beantwortet die eine Frage, die man wirklich hat: Wann regnet es? */
function renderVerdict() {
  const el = $('#verdict');
  const now = Date.now();

  // 1) Feinauflösung: 15-Minuten-Werte der nächsten 2 Stunden
  const m = data.minutely_15;
  const mi = m ? m.time.findIndex(t => new Date(t).getTime() >= now - 9e5) : -1;
  const near = mi >= 0 ? m.time.slice(mi, mi + 10).map((t, k) => ({
    t: new Date(t).getTime(), mm: m.precipitation[mi + k] ?? 0, code: m.weather_code[mi + k]
  })) : [];

  /* Ob es gerade regnet, hing allein an `current.precipitation` — einem
     gerechneten Wert. Zwei Geräte, die im Abstand von Minuten laden, treffen
     unterschiedliche Modellläufe: Auf dem einen stand der Regen-Countdown,
     auf dem anderen nicht, bei gleichem Wetter vor der Tür.

     Jetzt zählt jede der drei Quellen — und die Messung wiegt am schwersten,
     denn ein Regenmesser rechnet nicht, er misst. */
  const jetztBlock = near.find(x => x.t <= now && x.t + 9e5 > now);
  const gemessenerRegen = naechsteStation?.w ? messWert(naechsteStation.w, 'precipitation') : null;
  /* „Es regnet" nur, wenn es auch spürbar ist. Vorher genügten 0,05 mm je
     Viertelstunde — das sind 0,2 mm in der Stunde und draußen praktisch
     nichts. Die Messung darf niedriger ansetzen: Was ein Regenmesser
     auffängt, ist wirklich gefallen. */
  const raining = (gemessenerRegen != null && gemessenerRegen >= 0.1)
               || data.current.precipitation >= REGEN.nichts
               || proStunde(jetztBlock?.mm) >= REGEN.nichts;
  const wet = near.filter(x => proStunde(x.mm) >= REGEN.nichts);

  /* Der Punktverlauf des DWD hat Vorrang vor allem anderen: Er kommt vom
     Radar über dem Standort, während die Modellwerte für eine Gitterzelle
     gelten und die Station kilometerweit weg steht.

     Hier steckte ein Fehler, der genau den wichtigsten Fall verschluckte:
     Der Zweig unten verlangte `pv.start` — die Uhrzeit, zu der der Regen
     ANFÄNGT. Regnete es am Standort bereits, liefert `punktSatz()` gar
     kein `start`, und die Zeile fiel durch bis zum Stundenraster, das für
     die ganze Masche „trocken" sagte. Bei einem einzelnen Schauer über der
     Stadt stand dann „Bleibt trocken", während es vor der Tür schüttete. */
  const pv = punktSatz();
  if (pv?.regnet) {
    /* Ohne umschließendes <b>: Die Sätze setzen ihre Betonung selbst, und
       ein <b> um alles machte die inneren wirkungslos. */
    el.innerHTML = pv.text + punktLeiste();
    el.dataset.tone = 'wet';
    return;
  }

  if (raining) {
    /* Regnet es gerade, ist die einzig interessante Frage: wie lange noch?
       Die Viertelstundenwerte reichen zwei Stunden voraus — daraus eine
       Leiste, die den nassen Rest zeigt und wo er aufhört. */
    const dry = near.find(x => x.t > now && proStunde(x.mm) < REGEN.nichts);
    /* Wortwahl nach Menge, nicht nach Wettercode: Der Code nennt schon
       0,1 mm „Regen", und dann stand hier „Regen gerade", während draußen
       ein paar Tropfen fielen. */
    const jetztStaerke = Math.max(proStunde(jetztBlock?.mm), data.current.precipitation ?? 0);
    const word = jetztStaerke < REGEN.troepfeln
      ? 'Ein paar Tropfen' : WX.precipWord(data.current.weather_code);
    const bis = dry ? dry.t : null;
    const restMin = bis ? Math.max(0, Math.round((bis - now) / 60000)) : null;

    // Zeitfenster der Leiste: mindestens eine Stunde, sonst bis zum Ende
    const fenster = Math.min(120, Math.max(60, (restMin ?? 120) + 15));
    const bloecke = near.filter(x => x.t >= now - 9e5 && x.t <= now + fenster * 60000);
    const staerkste = Math.max(0.4, ...bloecke.map(x => x.mm));

    const leiste = bloecke.length ? `
      <span class="rp-leiste" aria-hidden="true">
        ${bloecke.map(x => {
          const anteil = Math.min(1, x.mm / staerkste);
          return `<i class="${proStunde(x.mm) >= REGEN.nichts ? 'rp-nass' : 'rp-trocken'}"
                     style="--h:${(24 + anteil * 34).toFixed(0)}%"></i>`;
        }).join('')}
      </span>
      <span class="rp-achse">
        <em>jetzt</em>${bis ? `<em class="rp-ende" style="left:${
          Math.min(97, (bis - (now - 9e5)) / ((fenster + 15) * 60000) * 100).toFixed(1)}%">${hhmm(bis)}</em>` : ''}
        <em class="rp-rechts">+${Math.round(fenster / 60)} Std.</em>
      </span>` : '';

    /* Hört der Regen auf und fängt im selben Fenster wieder an, gehört das
       in denselben Satz. „Noch 14 Minuten" allein hätte jemanden losgeschickt,
       der eine halbe Stunde später wieder im Regen steht. */
    const wieder = bis ? near.find(x => x.t > bis && proStunde(x.mm) >= REGEN.nichts) : null;
    const nachsatz = wieder ? ` Dann ab ${hhmm(wieder.t)} wieder.` : '';

    const kJetzt = regenKlartext(jetztStaerke);
    el.innerHTML = `<b>${kJetzt.wort.charAt(0).toUpperCase()}${kJetzt.wort.slice(1)} gerade.</b> ${
      restMin != null
        ? (restMin <= 5 ? `Hört gleich auf.${nachsatz}`
           : `Noch etwa <b class="rp-rest">${restMin} Minuten</b>, bis gegen ${hhmm(bis)}.${nachsatz}`)
        : 'Hält die nächsten zwei Stunden an.'}${
      kJetzt.rat ? ` <i>${kJetzt.rat}.</i>` : ''}${leiste}`;
    el.dataset.tone = 'wet';
    return;
  }

  // Regen kündigt sich am Standort an, bevor das Stundenraster ihn kennt
  if (pv && !raining && (pv.start || pv.nahe)) {
    /* Beim Schauer nebenan keine Leiste: Sie zeigt den Verlauf über dem
       eigenen Standort, und der ist in diesem Fall durchweg leer — ein
       flaches Balkenbild unter „nebenan regnet es" verwirrt mehr, als es
       sagt. */
    el.innerHTML = pv.text + (pv.start ? punktLeiste() : '');
    el.dataset.tone = 'soon';
    return;
  }

  if (wet.length) {
    const first = wet[0];
    const mins = Math.max(0, Math.round((first.t - now) / 60000));
    /* Bei 0,2 mm in der Stunde von „Regen" zu sprechen, wäre übertrieben —
       das sind ein paar Tropfen, die kaum den Boden benetzen. */
    const staerke = proStunde(first.mm);
    const k = regenKlartext(staerke);
    // Menge der ganzen Phase, nicht nur des ersten Blocks
    let summe = 0;
    for (const x of wet) {
      if (x.t < first.t) continue;
      if (proStunde(x.mm) < REGEN.nichts) break;
      summe += x.mm;
    }
    const menge = summe >= 0.1 ? ` <i>${dez(summe)} mm — ${k.rat}.</i>` : '';
    el.innerHTML = mins <= 5
      ? `<b>Gleich ${k.wort}.</b>${menge}`
      : `<b>${k.wort.charAt(0).toUpperCase()}${k.wort.slice(1)} in etwa ${mins} Minuten</b>
         (gegen ${hhmm(first.t)}).${menge}`;
    el.dataset.tone = staerke < REGEN.troepfeln ? 'later' : 'soon';
    return;
  }

  /* 2) Grobauflösung: nächste Regenstunde in den kommenden 24 h.

     Gesucht wird nach einer Stunde mit wirklicher Menge. Eine hohe
     Wahrscheinlichkeit allein ist kein Regen: Die Prozentzahl sagt, wie
     viele Rechnungen dort überhaupt etwas sehen — über die Menge sagt sie
     nichts. Beides in einen Satz zu packen ergab den Widerspruch „Regen
     nicht ausgeschlossen (65 %), gerechnet wird aber mit nichts". */
  const h = data.hourly;
  const i0 = nowIndex(h.time);
  let vielleicht = null;      // erste Stunde mit Risiko, aber ohne Menge

  for (let i = i0; i < Math.min(i0 + 24, h.time.length); i++) {
    const prob = h.precipitation_probability[i] ?? 0;
    const mm = h.precipitation[i] ?? 0;

    if (mm < 0.2) {
      if (prob >= 60 && !vielleicht) vielleicht = { t: new Date(h.time[i]).getTime(), prob };
      continue;
    }

    const t = new Date(h.time[i]).getTime();
    const hrs = Math.round((t - now) / 3600e3);
    /* Menge der Regenphase aufsummieren, nicht nur die erste Stunde —
       zwei Stunden mit je 0,8 mm sind etwas anderes als eine mit 0,8. */
    let summe = 0, spitze = 0;
    for (let k = i; k < Math.min(i + 8, h.time.length); k++) {
      const v = h.precipitation[k] ?? 0;
      if (v < REGEN.nichts && k > i) break;
      summe += v; spitze = Math.max(spitze, v);
    }
    const was = regenSatzteil(spitze, summe);
    el.innerHTML = hrs <= 1
      ? `<b>Trocken bis etwa ${hhmm(t)}</b>, dann ${was}. <i>${prob} % Wahrscheinlichkeit.</i>`
      : `<b>Bleibt ${hrs} Std. trocken.</b> Ab ca. ${hhmm(t)} ${was}. <i>${prob} %.</i>`;
    el.dataset.tone = 'later';
    return;
  }

  if (vielleicht) {
    /* Die laufende Stunde ist keine Vorschau: „gegen 08:00" stand um 08:24
       schon in der Vergangenheit. Dann gehört keine Uhrzeit in den Satz. */
    const laeuft = vielleicht.t <= now;
    el.innerHTML = `<b>Bleibt trocken — kein Schirm nötig.</b>
      ${laeuft ? 'In dieser Stunde' : `Gegen ${hhmm(vielleicht.t)}`} können einzelne
      Tropfen fallen, nass wird man davon nicht. <i>Die ${vielleicht.prob} % sagen
      nur, wie viele Rechnungen dort überhaupt etwas sehen — nicht wie viel.</i>`;
    el.dataset.tone = 'dry';
    return;
  }

  const maxProb = Math.max(...h.precipitation_probability.slice(i0, i0 + 24).map(v => v ?? 0));
  el.innerHTML = `<b>Die nächsten 24 Stunden bleiben trocken.</b> Regenrisiko max. ${maxProb} %.`;
  el.dataset.tone = 'dry';
}

// ══ Rendering: DWD-Warnungen ═══════════════════════════════
const normalize = (s) => (s || '')
  .toLowerCase()
  .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
  .replace(/\b(stadt|kreis|landkreis|region|verbandsgemeinde|gemeinde|kreisfreie)\b/g, '')
  .replace(/[^a-z]/g, '');

/* Gültigkeitszeitraum einer Warnung. Der DWD schreibt ihn immer mit Datum
   dazu, und das aus gutem Grund: „bis 19:00" allein lässt offen, ob die
   Warnung von heute ist oder seit vorgestern im Zwischenspeicher liegt.

   `start` und `end` kommen als Millisekunden. `end` darf fehlen — dann
   gilt die Warnung bis auf Weiteres. */
function warnZeitraum(w) {
  const von = w.start ? new Date(w.start) : null;
  const bis = w.end ? new Date(w.end) : null;
  const jetzt = new Date();

  const tagIndex = (d) => {
    const a = new Date(d); a.setHours(0, 0, 0, 0);
    const b = new Date(jetzt); b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 86400000);
  };
  const tagWort = (d) => {
    const i = tagIndex(d);
    if (i === 0) return 'heute';
    if (i === 1) return 'morgen';
    if (i === -1) return 'gestern';
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  };
  const lang = (d) => d.toLocaleDateString('de-DE',
    { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

  const laeuft = (!von || von <= jetzt) && (!bis || bis > jetzt);
  const vorbei = bis && bis <= jetzt;

  // Kurzform für die Kopfzeile
  let kurz;
  if (!von) {
    kurz = bis ? `bis ${tagWort(bis)} ${hhmm(bis)} Uhr` : 'Zeitraum offen';
  } else if (!bis) {
    kurz = `ab ${tagWort(von)} ${hhmm(von)} Uhr — Ende offen`;
  } else if (tagIndex(von) === tagIndex(bis)) {
    kurz = `${tagWort(von)} ${hhmm(von)}–${hhmm(bis)} Uhr`;
  } else {
    kurz = `${tagWort(von)} ${hhmm(von)} bis ${tagWort(bis)} ${hhmm(bis)} Uhr`;
  }

  // Langform wie beim DWD, mit Wochentag und Jahr
  const voll = von && bis
    ? `Gültig von ${lang(von)}, ${hhmm(von)} Uhr bis ${lang(bis)}, ${hhmm(bis)} Uhr`
    : von ? `Gültig ab ${lang(von)}, ${hhmm(von)} Uhr — Ende noch offen`
    : bis ? `Gültig bis ${lang(bis)}, ${hhmm(bis)} Uhr` : 'Zeitraum nicht angegeben';

  const stand = laeuft ? 'läuft' : vorbei ? 'abgelaufen' : 'noch nicht in Kraft';
  return { kurz, voll, stand, laeuft, vorbei };
}

function renderWarnings(raw) {
  const box = $('#warnings');
  box.innerHTML = '';
  activeWarnings = [];
  if (!raw || place?.country && place.country !== 'DE') return;

  const targets = [normalize(place.name), normalize(place.county)].filter(Boolean);
  const all = [];
  for (const group of [raw.warnings, raw.vorabInformation]) {
    for (const id in (group || {})) {
      for (const w of group[id]) {
        const region = normalize(w.regionName);
        if (targets.some(t => t && region && (region === t || region.includes(t) || t.includes(region)))) {
          all.push(w);
        }
      }
    }
  }
  if (!all.length) return;

  /* Abgelaufene Warnungen aussortieren. Der DWD räumt seine Datei zwar
     selbst auf, aber wenn sie einmal hängt, sollen keine Warnungen von
     vorgestern als aktuell durchgehen. */
  const jetztMs = Date.now();
  const gueltig = all.filter(w => !w.end || w.end > jetztMs);

  // Doppelte Meldungen (mehrere Warncells) zusammenfassen
  const seen = new Set();
  const uniq = gueltig.filter(w => {
    const k = `${w.type}|${w.level}|${w.event}|${w.start}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => b.level - a.level);
  if (!uniq.length) return;

  /* Die Stufe steckt nicht verlässlich im \`level\`: Für Hitze nutzt der DWD
     eine eigene Skala (50 aufwärts), für Wetterwarnungen 1 bis 4. Die
     Überschrift ist dagegen immer eindeutig formuliert. */
  const stufeVon = (w) => {
    const h = String(w.headline || '').toUpperCase();
    if (h.includes('EXTREME')) return 'Extremes Unwetter';
    if (h.includes('UNWETTER')) return 'Unwetterwarnung';
    if (h.includes('VORABINFORMATION')) return 'Vorabinformation';
    if (w.level >= 4 && w.level < 10) return 'Unwetterwarnung';
    return 'Warnung';
  };
  activeWarnings = uniq;

  const zeit = warnZeitraum;   // kurzer Name für die Vorlage
  box.innerHTML = uniq.map(w => `
    <details class="warn lvl-${w.level}">
      <summary>
        <svg class="warn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 1.8 21h20.4L12 3.5z"/><path d="M12 10v5" stroke-width="2"/><circle cx="12" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg>
        <span class="warn-txt">
          <b>${esc(w.event || stufeVon(w))}</b>
          <i>${esc(w.regionName)}</i>
          <i class="warn-zeit"><em class="wz-${zeit(w).laeuft ? 'an' : 'aus'}">${
            zeit(w).stand}</em> · ${zeit(w).kurz}</i>
        </span>
        <svg class="warn-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      </summary>
      <div class="warn-body">
        <p class="warn-gueltig">${zeit(w).voll}</p>
        <p>${esc(w.description)}</p>
        ${w.instruction ? `<p class="warn-instr">${esc(w.instruction)}</p>` : ''}
        <p class="warn-src">${stufeVon(w)} · Deutscher Wetterdienst${
          raw.time ? ` · Warnlage vom ${new Date(raw.time).toLocaleDateString('de-DE',
            { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${hhmm(raw.time)} Uhr` : ''}</p>
      </div>
    </details>`).join('');
}

// ══ Rendering: Stündlich ═══════════════════════════════════
function renderHourly() {
  const h = data.hourly, i0 = nowIndex(h.time);
  const end = Math.min(i0 + 48, h.time.length);
  const sunrise = data.daily.sunrise.map(s => new Date(s).getTime());
  const sunset = data.daily.sunset.map(s => new Date(s).getTime());

  const items = [];
  for (let i = i0; i < end; i++) {
    const t = new Date(h.time[i]).getTime();
    // Sonnenauf-/untergang als eigene Spalte einschieben
    for (let d = 0; d < sunrise.length; d++) {
      if (sunrise[d] > t - 36e5 && sunrise[d] <= t) items.push({ kind: 'sun', up: true, t: sunrise[d] });
      if (sunset[d] > t - 36e5 && sunset[d] <= t) items.push({ kind: 'sun', up: false, t: sunset[d] });
    }
    items.push({ kind: 'h', i, t });
  }

  const temps = items.filter(x => x.kind === 'h').map(x => h.temperature_2m[x.i]);
  const tMin = Math.min(...temps), tMax = Math.max(...temps), span = Math.max(1, tMax - tMin);

  $('#hourly').innerHTML = items.map((x, n) => {
    if (x.kind === 'sun') {
      return `<div class="hcol hcol-sun" data-zeit="${x.t}">
        <span class="h-time">${hhmm(x.t)}</span>
        <span class="sun-ico">${x.up ? sunUpSvg() : sunDownSvg()}</span>
        <span class="h-sunlabel">${x.up ? 'Aufgang' : 'Untergang'}</span>
      </div>`;
    }
    const i = x.i;
    const prob = h.precipitation_probability[i] ?? 0;
    const mm = h.precipitation[i] ?? 0;
    const temp = round(h.temperature_2m[i]);
    const rel = (h.temperature_2m[i] - tMin) / span;      // 0..1 für den Verlauf
    const isNow = n === 0 || (items[0].kind === 'sun' && n === 1);
    return `<div class="hcol${isNow ? ' is-now' : ''}" data-zeit="${x.t}" data-i="${i}">
      <span class="h-time">${isNow ? 'Jetzt' : hhmm(x.t)}</span>
      <span class="h-icon">${WX.icon(himmelCode(i), h.is_day[i])}</span>
      <span class="h-temp" style="--rel:${rel.toFixed(2)}">${temp}°</span>
      <span class="h-rain ${prob >= 25 ? 'on' : ''}">
        <span class="h-bar"><i style="height:${clamp(prob, 3, 100)}%"></i></span>
        <span class="h-prob">${prob >= 15 ? prob + '%' : ''}</span>
      </span>
      ${mm >= 0.1 ? `<span class="h-mm">${dez(mm)}</span>` : '<span class="h-mm"></span>'}
    </div>`;
  }).join('');

  wireHourlyScroll();
}

/** Am Rechner gibt es kein Wischen: Mausrad und Trackpad-Gesten auf die
    Stundenleiste umlenken, damit sie sich waagerecht bewegen lässt. */
function wireHourlyScroll() {
  const box = $('#hourly');
  if (!box || box.dataset.wired) return;
  box.dataset.wired = '1';

  /* Beim Schieben zeigt die Kopfzeile, wo man gerade ist. Unter dem Daumen
     steht der Wert, aber der Tag ist dort nicht ablesbar — oben schon. */
  const marke = $('#hourlyWhen');
  let ruhe = null;
  const zeigeZeit = () => {
    if (!marke) return;
    const kasten = box.getBoundingClientRect();
    // Die Spalte, die am linken Rand steht — dort setzt der Blick an
    const spalten = [...box.querySelectorAll('.hcol[data-zeit]')];
    const treffer = spalten.find(s => s.getBoundingClientRect().right > kasten.left + 12);
    if (!treffer) return;

    // Steht die Leiste am Anfang, bleibt die Beschriftung stehen
    if (treffer.classList.contains('is-now')) {
      marke.textContent = '48 Stunden';
      marke.classList.remove('on');
      return;
    }
    const t = new Date(+treffer.dataset.zeit);

    const heute = t.toDateString() === new Date().toDateString();
    const morgen = t.toDateString() === new Date(Date.now() + 864e5).toDateString();
    const tag = heute ? 'Heute' : morgen ? 'Morgen' : weekday(t);
    marke.textContent = `${tag}, ${hhmm(t)} Uhr`;
    marke.classList.add('on');

    // Nach dem Loslassen zurück auf die Beschriftung
    clearTimeout(ruhe);
    ruhe = setTimeout(() => {
      marke.textContent = '48 Stunden';
      marke.classList.remove('on');
    }, 2200);
  };
  box.addEventListener('scroll', zeigeZeit, { passive: true });

  box.addEventListener('wheel', (e) => {
    // Waagerechte Gesten macht der Browser selbst; nur senkrechte umlenken
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const vorher = box.scrollLeft;
    box.scrollLeft += e.deltaY;
    if (box.scrollLeft !== vorher) e.preventDefault();   // Seite nicht mitscrollen
  }, { passive: false });

  // Ziehen mit gedrückter Maustaste
  let zieht = false, startX = 0, startL = 0;
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    zieht = true; startX = e.clientX; startL = box.scrollLeft;
    box.setPointerCapture(e.pointerId);
    box.style.cursor = 'grabbing';
  });
  box.addEventListener('pointermove', (e) => {
    if (!zieht) return;
    box.scrollLeft = startL - (e.clientX - startX);
  });
  const los = () => { zieht = false; box.style.cursor = ''; };
  box.addEventListener('pointerup', los);
  box.addEventListener('pointercancel', los);
}

const sunUpSvg = () => `<svg viewBox="0 0 24 24" class="wx-sunmini"><circle cx="12" cy="14" r="4"/><path d="M12 4v3M5 14H2M22 14h-3M6.5 8.5 4.4 6.4M17.5 8.5l2.1-2.1M2 19h20"/><path d="m9 6 3-3 3 3" class="arrow"/></svg>`;
const sunDownSvg = () => `<svg viewBox="0 0 24 24" class="wx-sunmini down"><circle cx="12" cy="14" r="4"/><path d="M12 4v3M5 14H2M22 14h-3M6.5 8.5 4.4 6.4M17.5 8.5l2.1-2.1M2 19h20"/><path d="m9 4 3 3 3-3" class="arrow"/></svg>`;

// ══ Rendering: 10 Tage ═════════════════════════════════════
/** Open-Meteo liefert als Tages-Code den ungünstigsten Wert des Tages: zwei
    trübe Abendstunden machen aus einem Sonnentag "bedeckt". Für die Tagesreihe
    leiten wir das Symbol deshalb aus den echten Tagstunden ab — vorrangig aus
    dem Niederschlag, sonst aus der mittleren Bewölkung. */
function daySymbol(dayIndex) {
  const d = data.daily, h = data.hourly;
  const day = d.time[dayIndex];
  const raw = d.weather_code[dayIndex];

  const idx = [];
  for (let i = 0; i < h.time.length; i++) {
    if (!h.time[i].startsWith(day)) continue;
    const hour = +h.time[i].slice(11, 13);
    if (hour >= 7 && hour <= 20) idx.push(i);           // Tagstunden
  }
  if (!idx.length) return raw;

  // Niederschlag hat Vorrang: häufigster Regen-/Schnee-Code der nassen Stunden
  const wet = idx.filter(i => (h.precipitation[i] ?? 0) >= 0.1);
  const wetShare = wet.length / idx.length;
  if (wetShare >= 0.2 || (d.precipitation_sum[dayIndex] ?? 0) >= 1.5) {
    const counts = {};
    wet.forEach(i => { const c = h.weather_code[i]; counts[c] = (counts[c] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) return +top[0];
  }
  // Gewitter nie verschlucken
  if (idx.some(i => [95, 96, 99].includes(h.weather_code[i]))) return 95;

  // Sonst: mittlere Bewölkung der Tagstunden entscheidet
  const cc = idx.map(i => wolkenFuer(h.time[i], h.cloud_cover?.[i])).filter(v => v != null);
  if (!cc.length) return raw;
  const avg = cc.reduce((a, b) => a + b, 0) / cc.length;
  if (avg < 20) return 0;
  if (avg < 45) return 1;
  if (avg < 80) return 2;
  return 3;
}

/** Regenmenge in Worte fassen — eine Zahl in Millimetern sagt den meisten nichts. */
function rainWords(mm) {
  if (mm < 0.2) return null;
  if (mm < 1)  return 'ein paar Tropfen';
  if (mm < 3)  return 'leichter Regen';
  if (mm < 8)  return 'mäßiger Regen';
  if (mm < 20) return 'kräftiger Regen';
  return 'sehr kräftig';
}

/** Wann am Tag fällt der Regen? Liefert die zusammenhängende Hauptphase. */
function rainWindow(dayIndex) {
  const d = data.daily, h = data.hourly;
  const tag = d.time[dayIndex];
  const stunden = [];
  for (let i = 0; i < h.time.length; i++) {
    if (h.time[i].startsWith(tag)) stunden.push(i);
  }
  const nass = stunden.filter(i => (h.precipitation[i] ?? 0) >= 0.1);
  if (!nass.length) return null;

  // Größten zusammenhängenden Block suchen
  let bestVon = nass[0], bestBis = nass[0], von = nass[0], bis = nass[0];
  for (let k = 1; k < nass.length; k++) {
    if (nass[k] === bis + 1) bis = nass[k];
    else { if (bis - von > bestBis - bestVon) { bestVon = von; bestBis = bis; } von = bis = nass[k]; }
  }
  if (bis - von > bestBis - bestVon) { bestVon = von; bestBis = bis; }

  const a = new Date(h.time[bestVon]);
  const b = new Date(h.time[bestBis] );
  b.setHours(b.getHours() + 1);
  return { von: a, bis: b, anteil: nass.length / Math.max(1, stunden.length) };
}

/* Sonnenstunden immer aus den Stundenwerten summiert — nie aus dem
   Tageswert. Beides steht in der Antwort, und normalerweise stimmt es
   überein; bei längerer Vorhersage kann der Tageswert aber aus einem
   anderen Modelllauf stammen als die Stundenwerte. Dann stünden "12 Stunden
   Sonne" neben einem Streifen, der ab Mittag zu ist.

   `sunshine_duration` je Stunde ist die gerechnete Zeit mit direkter
   Einstrahlung über 120 W/m² — das ist die amtliche Definition von
   Sonnenschein. Ein Ersatzmaß aus der Bewölkung wäre deutlich grober:
   dünne hohe Wolken lassen die Sonne durch, tiefe nicht. Fehlt das Feld
   trotzdem, bleibt die Bewölkung als Notbehelf. */
function sonnenStunden(dayISO) {
  const h = data.hourly;
  let sekunden = 0, gefunden = false, ersatz = 0;
  for (let u = 0; u < 24; u++) {
    const k = h.time.indexOf(`${dayISO}T${String(u).padStart(2, '0')}:00`);
    if (k < 0) continue;
    if (h.sunshine_duration?.[k] != null) {
      sekunden += h.sunshine_duration[k];
      gefunden = true;
    }
    if (h.is_day[k] === 1 && (h.precipitation[k] ?? 0) < 0.3) {
      ersatz += Math.max(0, (100 - wolkenFuer(h.time[k], h.cloud_cover[k] ?? 100)) / 100);
    }
  }
  return gefunden ? sekunden / 3600 : ersatz;
}

/** Farbe einer Tagesstunde für den Verlaufsbalken.
    Reihenfolge zählt: Regen schlägt Bewölkung, Nacht färbt den Rest ein. */
function hourShade(mm, wolken, tags) {
  if (mm >= 1.5) return '#3d8fd6';
  if (mm >= 0.4) return '#5ac8fa';
  if (mm >= 0.1) return '#8ad8f5';
  if (!tags)     return wolken > 70 ? '#2c3550' : '#1e2740';
  if (wolken < 25) return '#ffd25e';
  if (wolken < 55) return '#f0dc9a';
  if (wolken < 80) return '#b9c2d2';
  return '#7d8798';
}

/** 24-Stunden-Streifen eines Tages: zeigt auf einen Blick, wann die Sonne
    scheint und wann Regen fällt — aussagekräftiger als ein Min-Max-Balken,
    dessen Werte ohnehin daneben stehen. */
function dayStrip(dayISO) {
  const h = data.hourly;
  const teile = [];
  for (let u = 0; u < 24; u++) {
    const marke = `${dayISO}T${String(u).padStart(2, '0')}:00`;
    const k = h.time.indexOf(marke);
    if (k < 0) { teile.push('#1a2135'); continue; }
    teile.push(hourShade(h.precipitation[k] ?? 0,
      wolkenFuer(h.time[k], h.cloud_cover[k] ?? 0), h.is_day[k] === 1));
  }
  const stops = teile.map((c, u) => `${c} ${(u / 24 * 100).toFixed(2)}%, ${c} ${((u + 1) / 24 * 100).toFixed(2)}%`).join(', ');
  return `<span class="d-strip" style="background:linear-gradient(90deg, ${stops})">
    ${[6, 12, 18].map(u => `<i style="left:${(u / 24 * 100).toFixed(2)}%"></i>`).join('')}
  </span>`;
}

function renderDaily() {
  const d = data.daily;
  /* Fehlende Tage (das Modell reicht nicht so weit) enthalten null. Ohne
     Filter las Math.min das als 0 — im Kopf stand „0° bis 35°", obwohl der
     kälteste Wert 14° war. */
  const minWerte = d.temperature_2m_min.filter(v => v != null);
  const maxWerte = d.temperature_2m_max.filter(v => v != null);
  const lo = minWerte.length ? Math.min(...minWerte) : null;
  const hi = maxWerte.length ? Math.max(...maxWerte) : null;
  const today = new Date().toDateString();

  $('#dailyRange').textContent = lo != null ? `${round(lo)}° bis ${round(hi)}°` : '';

  /* Die Überschrift log: „10 Tage" stand da, obwohl das gewählte Modell nur
     bis Freitag reicht. Sie nennt jetzt, was wirklich da ist. */
  const echteTage = d.time.filter((_, i) =>
    d.temperature_2m_min[i] != null && d.temperature_2m_max[i] != null).length;
  const h2 = document.querySelector('#daily')?.closest('.card')?.querySelector('h2');
  if (h2) h2.textContent = echteTage >= 2 ? `${echteTage} Tage` : 'Tagesübersicht';

  $('#daily').innerHTML = d.time.map((day, i) => {
    const isToday = new Date(day).toDateString() === today;
    const min = d.temperature_2m_min[i], max = d.temperature_2m_max[i];
    if (min == null || max == null) return '';      // Modell reicht nicht so weit
    const prob = d.precipitation_probability_max[i] ?? 0;
    const mm = d.precipitation_sum[i] ?? 0;
    const sun = Math.round(sonnenStunden(day));
    const wind = round(d.wind_speed_10m_max?.[i]);
    const boe = round(d.wind_gusts_10m_max?.[i]);
    const w = mm >= 0.2 ? rainWindow(i) : null;
    const worte = mm >= 0.2 ? rainWords(mm) : null;

    return `<div class="drow${isToday ? ' is-today' : ''}" data-day="${i}">
      <span class="d-day">${isToday ? 'Heute' : weekday(day)}${
        isToday ? '' : `<i>${tagDatum(day)}</i>`}</span>
      <span class="d-icon" title="${WX.text(daySymbol(i), 1)}">${WX.icon(daySymbol(i), 1)}</span>
      <span class="d-vals">
        <span class="d-sunval">☀ ${sun} Std.</span>
        ${prob >= 10 ? `<span class="d-rainval">💧 ${prob}%</span>` : ''}
        <span class="d-windval">🌬 ${wind} km/h${boe >= wind + 15 ? ` <i>Böen ${boe}</i>` : ''}</span>
      </span>
      <span class="d-temps"><b>${round(max)}°</b> / ${round(min)}°</span>
      ${dayStrip(day)}
      ${w ? `<span class="d-detail">${worte} · ${hhmm(w.von)}–${hhmm(w.bis)} · ${dez(mm)} mm</span>` : ''}
    </div>`;
  }).join('');
}

// ══ Datenquelle: Anzeige und Auswahl ═══════════════════════
/** Zeigt unter der Stundenleiste, woher die Zahlen stammen. */
function renderSource() {
  const el = $('#modelName');
  if (!el) return;
  const q = sourceOf(sourceId());
  const basis = q.id === 'best_match'
    ? `Quelle: <b>bestes Verfahren</b> — Regen: ICON-D2 · Temperatur & Himmel: Mittelweg aus 6 Modellen`
    : `Quelle: <b>${q.name}</b>`;

  /* Die Ortskorrektur stand früher als eigene Kastenzeile darüber. Sie sagt
     etwas über die Herkunft der Zahlen, nicht über das Wetter — und genau
     dort steht sie jetzt: hinter der Quelle, klein, antippbar. */
  const v = ortsVersatz ? versatzFuer(new Date().getHours()) : null;
  const korr = v == null ? ''
    : ` <i class="src-korr">· ortskorrigiert${
        Math.abs(v) >= 0.2 ? ` ${dez(-v)} °C` : ''}<u>?</u></i>`;
  el.innerHTML = basis + korr;
}

function renderSourceList() {
  const cur = sourceId();
  $('#modelList').innerHTML = SOURCES.map(s => `
    <button class="model-row${s.id === cur ? ' on' : ''}" data-src="${s.id}">
      <span class="mr-head">
        <b>${s.name}</b>
        ${s.id === cur ? '<span class="mr-check">✓</span>' : ''}
      </span>
      <span class="mr-desc">${s.desc}</span>
    </button>`).join('');

  $$('#modelList .model-row').forEach(b => b.addEventListener('click', async () => {
    store.set(LS.source, b.dataset.src);
    closeSheet('#modelSheet');
    renderSource();
    renderVersatzHinweis();
    toast(`Quelle: ${sourceOf(b.dataset.src).name}`);
    await refresh();
  }));
}

// ══ Zeitstrahl: 5 Tage durchschieben ═══════════════════════
/** Ein Regler über die kommenden 120 Stunden. Zu jedem Punkt stehen die Werte
    für genau diese Stunde da — die flächige Radarkarte reicht nur 30 Minuten
    voraus, hier sieht man die ganze Spanne am eigenen Standort. */
/** Stützstellen des Zeitstrahls: die ersten drei Stunden im Viertelstundentakt,
    danach stündlich. So lässt sich der Regenbeginn auf die Viertelstunde genau
    ablesen, ohne dass der Regler für fünf Tage unbrauchbar lang wird. */
/* Ein Regler für alles: links die letzten zwei Stunden echte Radarmessung,
   in der Mitte das Jetzt, rechts die Vorhersage bis fünf Tage. Vorher gab es
   zwei Regler, die man nicht gleichzeitig im Blick hatte. */
function buildScrubPoints() {
  /* Deckt der DWD-Nowcast den Nahbereich ab, kommt der Zeitstrahl von dort:
     Fünf-Minuten-Schritte von einer Stunde zurück bis anderthalb Stunden
     voraus. Genau in diesem Fenster will man wissen, wann der Schauer den
     eigenen Ort erreicht — Viertelstunden sind dafür zu grob. */
  const nowcast = (Radar.rvZeiten?.() || []).map(t => ({
    t: new Date(t), fein: true, i: -1, radar: true, nowcast: true
  }));

  if (nowcast.length) {
    const ende = nowcast[nowcast.length - 1].t.getTime();
    const spaeter = buildFuturePoints().filter(p => p.t.getTime() > ende + 20 * 60000);
    return [...nowcast, ...spaeter];
  }

  const vergangen = (Radar.frameTimes?.() || [])
    .filter(f => f.kind === 'past')
    .map(f => ({ t: new Date(f.t), fein: true, i: -1, radar: true }));
  return [...vergangen, ...buildFuturePoints()];
}

/** Wo im Regler liegt das Jetzt? */
function jetztIndex(punkte = buildScrubPoints()) {
  const jetzt = Date.now();
  let best = 0, diff = Infinity;
  punkte.forEach((p, i) => {
    const d = Math.abs(p.t.getTime() - jetzt);
    if (d < diff) { diff = d; best = i; }
  });
  return best;
}

/* Wie fein der Regler greift, hängt davon ab, wie viele Stützstellen auf
   welchen Zeitraum entfallen — der Regler verteilt sie ja gleichmäßig über
   seine Breite.

   Vorher lagen 117 der 142 Stellen in der fernen Zukunft: Die ersten drei
   Stunden bekamen damit ein Sechstel des Wegs, gut fünfzig Pixel auf dem
   Telefon. Genau dort will man aber genau treffen — ob der Schauer um 16:15
   oder 16:45 kommt, entscheidet, ob man losgeht.

   Jetzt wird nach hinten ausgedünnt: die nächsten drei Stunden im
   Viertelstundentakt, bis zwölf Stunden stündlich, bis zwei Tage in
   Dreierschritten, danach alle sechs Stunden. Die fünf Tage bleiben
   erreichbar, aber der Nahbereich bekommt fast die halbe Breite. */
function buildFuturePoints() {
  const h = data.hourly, m = data.minutely_15;
  const jetzt = Date.now();
  const punkte = [];

  if (m?.time?.length) {
    const start = m.time.findIndex(t => new Date(t).getTime() >= jetzt - 9e5);
    if (start >= 0) {
      for (let k = start; k < m.time.length; k++) {
        const t = new Date(m.time[k]);
        if (t.getTime() > jetzt + 3 * 36e5) break;       // nur die nächsten 3 Std.
        punkte.push({ t, fein: true, i: k });
      }
    }
  }

  /** Abstand in Stunden, je nachdem wie weit der Zeitpunkt voraus liegt. */
  const schrittWeite = (stundenVoraus) =>
    stundenVoraus <= 12 ? 1 : stundenVoraus <= 48 ? 3 : 6;

  const i0 = nowIndex(h.time);
  let letzte = punkte.length ? punkte[punkte.length - 1].t.getTime() : 0;
  for (let k = 0; k < h.time.length - i0; k++) {
    const t = new Date(h.time[i0 + k]);
    const ms = t.getTime();
    if (punkte.length && ms <= letzte) continue;
    if (punkte.length >= 1 && ms > jetzt + 120 * 36e5) break;

    const voraus = (ms - jetzt) / 36e5;
    const weite = schrittWeite(voraus);
    // Auf volle Schrittweiten rasten, damit die Marken auf runden Zeiten sitzen
    if (weite > 1 && t.getHours() % weite !== 0) continue;

    punkte.push({ t, fein: false, i: i0 + k });
    letzte = ms;
  }
  return punkte;
}

/* ── Meteogramm: zehn Tage als eine Kurve ──────────────────
   Die Tagesliste sagt, wie warm ein Tag wird. Sie sagt nicht, ob die Wärme
   gleichmäßig kommt oder ob am Sonntag ein Einbruch von zwölf Grad steckt.
   Genau dafür ist der Verlauf da — oben die Temperatur, unten der Regen,
   beides auf derselben Zeitachse wie beim DWD. */
/* Maße bewusst nah an der echten Pixelgröße auf dem Telefon: Bei einem
   700 Einheiten breiten Feld auf 305 px Karte schrumpft jede Schrift auf
   44 % — 10-px-Text wurde zu 4 px und war nicht mehr zu lesen. */
const METEO = { w: 340, h: 116, links: 26, rechts: 6, oben: 12, tempUnten: 66,
                regenOben: 70, regenUnten: 92, achse: 92 };

function renderMeteogramm() {
  const ziel = $('#meteoWrap');
  if (!ziel || !data?.hourly) return;
  const h = data.hourly;
  const i0 = Math.max(0, nowIndex(h.time) - 2);      // zwei Stunden Vorlauf
  const bis = h.time.length;
  if (bis - i0 < 24) { ziel.innerHTML = ''; return; }

  /* Die Modelle reichen unterschiedlich weit: ICON hört nach gut sieben
     Tagen auf, die Antwort enthält danach `null`. `Math.min` liest null als
     0 — daraus wurde die Achse „0° bis 35°" und eine Kurve, die am Samstag
     auf null abstürzt und flach weiterläuft. Deshalb wird die Reihe dort
     abgeschnitten, wo die Werte enden. */
  let ende = bis;
  for (let k = i0; k < bis; k++) {
    if (h.temperature_2m[k] == null) { ende = k; break; }
  }
  if (ende - i0 < 24) { ziel.innerHTML = ''; return; }

  const zeiten = h.time.slice(i0, ende).map(t => new Date(t));
  const temps = h.temperature_2m.slice(i0, ende);
  const regen = h.precipitation.slice(i0, ende).map(v => v ?? 0);
  const n2 = temps.length;

  const tMin = Math.min(...temps), tMax = Math.max(...temps);
  // Etwas Luft nach oben und unten, sonst klebt die Kurve am Rand
  const spanne = Math.max(6, tMax - tMin);
  const yMin = tMin - spanne * 0.12, yMax = tMax + spanne * 0.12;
  const regenMax = Math.max(1, ...regen);

  const breite = METEO.w - METEO.links - METEO.rechts;
  const n = n2;
  const X = (k) => METEO.links + (k / (n - 1)) * breite;
  const Y = (t) => METEO.oben + (1 - (t - yMin) / (yMax - yMin)) * (METEO.tempUnten - METEO.oben);
  const YR = (mm) => METEO.regenUnten - (mm / regenMax) * (METEO.regenUnten - METEO.regenOben);

  // Temperaturkurve, geglättet über kubische Zwischenstücke
  const punkte = temps.map((t, k) => [X(k), Y(t)]);
  let kurve = `M${punkte[0][0].toFixed(1)},${punkte[0][1].toFixed(1)}`;
  for (let k = 1; k < punkte.length; k++) {
    const [x0, y0] = punkte[k - 1], [x1, y1] = punkte[k];
    const mx = (x0 + x1) / 2;
    kurve += ` C${mx.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  const flaeche = `${kurve} L${X(n - 1).toFixed(1)},${METEO.tempUnten} L${METEO.links},${METEO.tempUnten} Z`;

  // Regensäulen — nur zeichnen, wo wirklich etwas fällt
  const saeulen = regen.map((mm, k) => {
    if (mm < 0.05) return '';
    const bw = Math.max(1.4, breite / n * 0.8);
    return `<rect class="mg-regen" x="${(X(k) - bw / 2).toFixed(1)}" y="${YR(mm).toFixed(1)}"
      width="${bw.toFixed(1)}" height="${(METEO.regenUnten - YR(mm)).toFixed(1)}" rx="0.8"/>`;
  }).join('');

  // Tagesgrenzen und Wochentage
  let tage = '';
  zeiten.forEach((t, k) => {
    if (t.getHours() !== 0 || k === 0) return;
    const x = X(k);
    tage += `<line class="mg-tag" x1="${x.toFixed(1)}" y1="${METEO.oben}" x2="${x.toFixed(1)}" y2="${METEO.achse}"/>`;
  });
  // Beschriftung in die Mitte jedes Tages
  let namen = '';
  for (let k = 0; k < n; k++) {
    if (zeiten[k].getHours() !== 12) continue;
    /* Erste Woche als Wort, zweite als Datum: Ab da wiederholen sich die
       Wochennamen, und „Do" stand sonst zweimal an derselben Achse. */
    const tag = k / 24;
    namen += `<text class="mg-wtag" x="${X(k).toFixed(1)}" y="${METEO.h - 3}">${
      k < 12 ? 'heute' : tag >= 7 ? tagDatum(zeiten[k]) : weekday(zeiten[k])}</text>`;
  }

  // Nachtstreifen, damit man Tag und Nacht auseinanderhält
  let naechte = '';
  let start = null;
  for (let k = 0; k < n; k++) {
    const tags = h.is_day[i0 + k] === 1;
    if (!tags && start === null) start = k;
    if ((tags || k === n - 1) && start !== null) {
      naechte += `<rect class="mg-nacht" x="${X(start).toFixed(1)}" y="${METEO.oben}"
        width="${(X(k) - X(start)).toFixed(1)}" height="${METEO.achse - METEO.oben}"/>`;
      start = null;
    }
  }

  // Jetzt-Linie
  const jetztK = zeiten.findIndex(t => t.getTime() >= Date.now());
  const jetztLinie = jetztK > 0 ? `
    <line class="mg-jetzt" x1="${X(jetztK).toFixed(1)}" y1="${METEO.oben}"
          x2="${X(jetztK).toFixed(1)}" y2="${METEO.achse}"/>` : '';

  // Höchst- und Tiefstwert beschriften
  const iMax = temps.indexOf(tMax), iMin = temps.indexOf(tMin);
  /* Beide Werte über den Punkt: Unter dem Tiefstwert liegt schon die
     Regenachse, dort wäre die Zahl nicht mehr zu lesen. */
  const marke = (k, t) => `
    <circle class="mg-punkt" cx="${X(k).toFixed(1)}" cy="${Y(t).toFixed(1)}" r="2"/>
    <text class="mg-wert" x="${X(k).toFixed(1)}" y="${(Y(t) - 5).toFixed(1)}">${Math.round(t)}°</text>`;

  /* Der Verlauf reicht nur so weit wie die Stundenwerte — bei manchen
     Modellen sind das gut sieben Tage, während die Tagesliste darunter
     zehn zeigt. Ohne Hinweis sah der kürzere Verlauf nach Fehler aus. */
  const tageImVerlauf = Math.round(n / 24);
  const tageInListe = data.daily.time.filter((_, i) =>
    data.daily.temperature_2m_max[i] != null).length;
  const hinweis = tageImVerlauf < tageInListe - 1
    ? `<p class="mg-note">Der Verlauf reicht ${tageImVerlauf} Tage — so weit rechnet
       das gewählte Modell stundenweise. Die Liste darunter geht ${tageInListe} Tage,
       dort genügen Tageswerte.</p>` : '';

  ziel.innerHTML = hinweis + `
    <svg viewBox="0 0 ${METEO.w} ${METEO.h}" class="mg-svg" role="img"
         aria-label="Temperatur- und Regenverlauf der nächsten Tage">
      <defs>
        <linearGradient id="mgTemp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ff9f6a" stop-opacity=".42"/>
          <stop offset="1" stop-color="#ff9f6a" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${naechte}
      ${tage}
      ${namen}
      <line class="mg-achse" x1="${METEO.links}" y1="${METEO.regenUnten}"
            x2="${METEO.w - METEO.rechts}" y2="${METEO.regenUnten}"/>
      <path d="${flaeche}" fill="url(#mgTemp)"/>
      <path class="mg-linie" d="${kurve}" fill="none" stroke="#ff9f6a"/>
      ${saeulen}
      ${marke(iMax, tMax)}
      ${marke(iMin, tMin)}
      ${jetztLinie}
      <g class="mg-zeiger" hidden>
        <line y1="${METEO.oben}" y2="${METEO.achse}"/>
        <circle r="2.6"/>
      </g>
      <text class="mg-achsentext" x="${METEO.links - 4}" y="${METEO.oben + 3}">${Math.round(yMax)}°</text>
      <text class="mg-achsentext" x="${METEO.links - 4}" y="${METEO.tempUnten}">${Math.round(yMin)}°</text>
      <text class="mg-achsentext mg-regenachse" x="${METEO.links - 4}" y="${METEO.regenUnten}">${
        dez(regenMax)} mm</text>
    </svg>`;

  meteoTasten(ziel, { i0, zeiten, temps, regen, X, Y, n });
}

/* ── Mit dem Finger am Verlauf entlangfahren ────────────────
   Abgeschaut bei der WarnWetter-App des DWD — das eine, was sie besser
   konnte: den Finger auf den Graphen legen und für genau diese Stunde
   alles sehen. Hier genügt EIN Diagramm dafür, weil die Werte in einem
   Kästchen zusammenkommen, statt auf vier Charts verteilt zu sein, durch
   die man scrollen muss. `touch-action: pan-y` teilt die Gesten sauber:
   waagerecht tasten, senkrecht weiter scrollen. */
function meteoTasten(ziel, m) {
  const svg = ziel.querySelector('.mg-svg');
  const zeiger = ziel.querySelector('.mg-zeiger');
  if (!svg || !zeiger) return;
  const linie = zeiger.querySelector('line');
  const punkt = zeiger.querySelector('circle');

  let lupe = ziel.querySelector('.mg-lupe');
  if (!lupe) {
    lupe = document.createElement('div');
    lupe.className = 'mg-lupe';
    lupe.hidden = true;
    ziel.appendChild(lupe);
  }

  const breite = METEO.w - METEO.links - METEO.rechts;
  const zeige = (clientX) => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const vx = (clientX - r.left) / r.width * METEO.w;
    const k = Math.max(0, Math.min(m.n - 1,
      Math.round((vx - METEO.links) / breite * (m.n - 1))));
    const x = m.X(k);

    /* removeAttribute statt `.hidden = false`: Die Eigenschaft `hidden`
       gehört zu HTMLElement — bei einer SVG-Gruppe setzt die Zuweisung nur
       eine JS-Eigenschaft und lässt das Attribut stehen. Zusammen mit der
       Regel `[hidden] { display: none }` blieb der Zeiger dadurch unsichtbar. */
    zeiger.removeAttribute('hidden');
    linie.setAttribute('x1', x.toFixed(1)); linie.setAttribute('x2', x.toFixed(1));
    punkt.setAttribute('cx', x.toFixed(1));
    punkt.setAttribute('cy', m.Y(m.temps[k]).toFixed(1));

    const H = data.hourly, i = m.i0 + k, t = m.zeiten[k];
    const wind = Math.round(H.wind_speed_10m?.[i] ?? 0);
    const boe = Math.round(H.wind_gusts_10m?.[i] ?? 0);
    const feucht = H.relative_humidity_2m?.[i];
    const prob = H.precipitation_probability?.[i];
    const mm = m.regen[k];
    /* Regenspalte: gefallene Menge, wenn etwas fällt; sonst das Risiko,
       wenn es nennenswert ist; sonst schlicht „trocken". */
    const nass = mm >= 0.05 ? `${dez(mm)} mm Regen`
               : (prob ?? 0) >= 20 ? `trocken, ${prob} % Risiko` : 'trocken';
    /* Drei kurze Zeilen statt einer langen: Einzeilig war das Kästchen
       breiter als ein halber iPhone-Schirm und klebte nur noch am Rand. */
    lupe.hidden = false;
    lupe.innerHTML = `<b>${k < 24 && t.getDate() === new Date().getDate()
        ? 'heute' : weekday(t) + ' ' + tagDatum(t)} · ${String(t.getHours()).padStart(2, '0')} Uhr</b>
      <span>${dez(m.temps[k])}° · ${nass}</span>
      <span>Wind ${wind}${boe >= wind + 10 ? `, Böen ${boe}` : ''} km/h${
        feucht != null ? ` · ${feucht} %` : ''}</span>`;

    // Kästchen dem Finger nachführen, an den Rändern festhalten
    const px = x / METEO.w * r.width;
    const lw = lupe.offsetWidth;
    lupe.style.left = `${Math.max(0, Math.min(r.width - lw, px - lw / 2))}px`;
  };

  /* Ohne Hinweis findet die Fingerführung niemand — beim Sonnenbogen steht
     derselbe Satz schon lange darunter. Er verschwindet für immer, sobald
     man es einmal gemacht hat: Ein Hinweis, den man nicht mehr braucht,
     ist ab dann nur noch Text, den Florian nicht lesen will. */
  let wink = ziel.querySelector('.mg-wink');
  const gelernt = () => store.get('wf.mgGetastet', false);
  if (!gelernt()) {
    if (!wink) {
      wink = document.createElement('p');
      wink.className = 'mg-wink';
      wink.textContent = 'Mit dem Finger über den Verlauf fahren — für jede Stunde '
        + 'Temperatur, Regen und Wind.';
      ziel.appendChild(wink);
    }
  } else if (wink) {
    wink.remove();
  }

  const getastet = (clientX) => {
    zeige(clientX);
    if (!gelernt()) {
      store.set('wf.mgGetastet', true);
      ziel.querySelector('.mg-wink')?.remove();
    }
  };
  svg.addEventListener('pointerdown', (e) => getastet(e.clientX));
  svg.addEventListener('pointermove', (e) => {
    // Maus: schon beim Überfahren; Finger: solange er aufliegt
    if (e.pointerType === 'mouse' || e.buttons) getastet(e.clientX);
  });
}

/* ── Regen im Detail ───────────────────────────────────────
   Die häufigste Frage an eine Wetter-App ist nicht, wie warm es wird,
   sondern ob es regnet. Ein Tippen auf die Regenzeile beantwortet sie
   vollständig: die nächsten zwei Stunden im Viertelstundentakt, wie viel
   heute insgesamt fällt, und — das Entscheidende — wie sicher das ist.

   Sicherheit heißt hier: Sind sich die vier Rechenmodelle einig? Sagen
   alle vier Regen, kann man sich darauf verlassen. Sagt einer Regen und
   drei nicht, ist es ein Vielleicht. Diese Auskunft gibt sonst keine
   Wetter-App im Alltagsgebrauch. */
function regenStufe(mmProStunde) {
  if (mmProStunde < REGEN.nichts) return { wort: 'trocken', farbe: null };
  if (mmProStunde < REGEN.troepfeln) return { wort: 'ein paar Tropfen', farbe: '#8ad8f5' };
  if (mmProStunde < 3.2) return { wort: 'leichter Regen', farbe: '#5ac8fa' };
  if (mmProStunde < 10) return { wort: 'Regen', farbe: '#2f8fd6' };
  return { wort: 'kräftiger Regen', farbe: '#8b3fd6' };
}

/* ── Regen genau bei dir ───────────────────────────────────
   Bis hierher zeigte die App Regengebiete auf der Karte und Modellwerte für
   die Rastermasche. Der DWD kann aber den Wert an einer einzelnen
   Koordinate herausgeben — für jeden Fünf-Minuten-Schritt, gemessen und
   90 Minuten voraus. Damit steht dort nicht mehr „im Raum Tübingen regnet
   es", sondern „bei dir fängt es um 06:35 an und hört um 07:10 auf".

   Das ist der Punkt, an dem die App mehr kann als die DWD-App: Die zeigt
   Schirme an Messstationen — hier steht der Wert für deinen Standort. */
let punktVerlauf = null;          // { punkte: [{t, mm}], geholt }

async function ladePunktVerlauf(lat, lon) {
  const proxy = (store.get('wf.proxy', '') || 'https://wetterfunk.florian-s-thiel.workers.dev')
    .replace(/\/+$/, '');
  try {
    const r = await fetch(`${proxy}/dwdverlauf?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
    if (!r.ok) { punktVerlauf = null; return; }
    const d = await r.json();
    punktVerlauf = Array.isArray(d?.punkte) && d.punkte.length
      ? { punkte: d.punkte, geholt: Date.now() } : null;
  } catch { punktVerlauf = null; }
}

/** Aus dem Verlauf einen Satz machen: Wann fängt es an, wann hört es auf? */
function punktSatz() {
  if (!punktVerlauf) return null;
  const jetzt = Date.now();
  const p = punktVerlauf.punkte.filter(x => x.t >= jetzt - 12 * 60000);
  if (!p.length) return null;

  const uhr = (t) => hhmm(t);
  const inMin = (t) => Math.max(0, Math.round((t - jetzt) / 60000));
  const gross = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* Zwei Schwellen für zwei verschiedene Aussagen: Über der eigenen Zelle
     zählt Regen ab 0,2 mm/h, im Umkreis erst ab 0,5 — sonst meldete jeder
     Nieselfleck im Nachbarort einen Schauer. */
  const NASS = 0.2, NAHE = 0.5;
  const eigenNass = (x) => x.mm >= NASS;
  const irgendwoNass = (x) => x.mm >= NASS || (x.umfeld ?? 0) >= NAHE;

  /* Rückblick über gut zehn Minuten statt nur des letzten Radarbildes: Eine
     Zelle am Rand eines Schauers flackert von Bild zu Bild zwischen nass und
     trocken (gemessen am 1. August: 0,19 – 0,34 – 0,05 – 0,83 – 0,05). Ohne
     Rückblick wechselte die Zeile alle fünf Minuten die Aussage. */
  const bisJetzt = (min) => p.filter(x => x.t >= jetzt - min * 60000 && x.t <= jetzt);
  const eigenJetzt = Math.max(0, ...bisJetzt(12).map(x => x.mm));
  /* Der Umkreis mit kürzerem Gedächtnis: „Bei dir regnet es" darf ein paar
     Minuten nachhängen — nass ist nass. „Nebenan" ist dagegen eine Warnung
     für gleich und wäre nach zwölf Minuten schlicht veraltet. */
  const naheJetzt = Math.max(0, ...bisJetzt(6).map(x => x.umfeld ?? 0));

  if (eigenJetzt >= NASS) {
    // Vorbei ist es erst, wenn auch der Umkreis frei ist — sonst zieht die Zelle nur weiter
    const trocken = p.find(x => x.t > jetzt && !irgendwoNass(x));
    const k = regenKlartext(Math.max(eigenJetzt, naheJetzt * 0.6));
    return { regnet: true, staerke: eigenJetzt,
      text: (trocken
        ? `Bei dir: <b>${k.wort}</b> bis etwa <b>${uhr(trocken.t)}</b> (${inMin(trocken.t)} Min.).`
        : `Bei dir: <b>${k.wort}</b>, hält die nächste Stunde an.`)
        + (k.rat ? ` ${gross(k.rat)}.` : '') };
  }

  /* Die eigene Zelle ist trocken, der Umkreis nicht. Bei Sommerschauern ist
     das der Normalfall — die Zelle ist einen Kilometer breit, der Schauer ein
     paar Kilometer, und welche Zelle er trifft, ist Zufall. Das gehört
     gesagt, aber als das, was es ist: nebenan, nicht hier. */
  if (naheJetzt >= NAHE) {
    const k = regenKlartext(naheJetzt);
    return { regnet: false, nahe: true, staerke: naheJetzt,
      text: `<b>Ein Schauer geht direkt nebenan nieder</b> — ${k.wort} im Umkreis `
          + `von gut zwei Kilometern. Über dir fällt gerade nichts, das kann `
          + `sich in Minuten ändern.` };
  }

  const start = p.find(x => x.t > jetzt && eigenNass(x));
  if (!start) return { regnet: false, text: 'Bei dir bleibt es die nächsten anderthalb Stunden trocken.' };
  const ende = p.find(x => x.t > start.t && !irgendwoNass(x));
  const spitze = Math.max(...p.filter(x => x.t >= start.t && (!ende || x.t < ende.t))
                            .map(x => Math.max(x.mm, (x.umfeld ?? 0) * 0.6)));
  const kk = regenKlartext(spitze);
  return { regnet: false, start: start.t, staerke: spitze,
    text: `Bei dir fängt es gegen <b>${uhr(start.t)}</b> an — in ${inMin(start.t)} Minuten. `
        + `${gross(kk.wort)}${kk.rat ? `, ${kk.rat}` : ''}.`
        + (ende ? ` Vorbei gegen <b>${uhr(ende.t)}</b>.` : '') };
}

/** Balkenbild aus dem Radarverlauf über dem Standort — dieselbe Quelle wie
    der Satz darüber, in Fünf-Minuten-Schritten statt Viertelstunden. */
function punktLeiste() {
  if (!punktVerlauf) return '';
  const jetzt = Date.now();
  /* Nur bis eine halbe Stunde voraus: So weit läuft der Verlauf im
     Fünf-Minuten-Takt. Danach sind es Zehn-Minuten-Schritte, und gleich
     breite Balken für ungleiche Zeiträume wären eine falsche Auskunft. */
  const von = jetzt - 6e5, bis = jetzt + 30 * 60000;
  const p = punktVerlauf.punkte.filter(x => x.t >= von && x.t <= bis);
  if (p.length < 6) return '';

  const staerkste = Math.max(0.4, ...p.map(x => x.mm));

  /* Die Marke bedeutet je nach Lage etwas anderes: Regnet es gerade, zeigt
     sie, wann es aufhört; ist es trocken, wann es anfängt. Vorher stand dort
     immer der nächste trockene Zeitpunkt — bei trockener Lage also die
     übernächste Viertelstunde, was gar nichts aussagte. */
  const nassJetzt = p.some(x => x.t <= jetzt && x.t >= jetzt - 6e5 && x.mm >= 0.2);
  const marke = nassJetzt
    ? p.find(x => x.t > jetzt && x.mm < 0.2)
    : p.find(x => x.t > jetzt && x.mm >= 0.2);

  return `
    <span class="rp-leiste" aria-hidden="true">
      ${p.map(x => {
        const anteil = Math.min(1, x.mm / staerkste);
        return `<i class="${x.mm >= 0.2 ? 'rp-nass' : 'rp-trocken'}"
                   style="--h:${(24 + anteil * 34).toFixed(0)}%"></i>`;
      }).join('')}
    </span>
    <span class="rp-achse">
      <em>jetzt</em>${marke ? `<em class="rp-ende" style="left:${
        Math.min(97, (marke.t - von) / (bis - von) * 100).toFixed(1)}%">${hhmm(marke.t)}</em>` : ''}
      <em class="rp-rechts">+30 Min.</em>
    </span>`;
}

function openRegenSheet() {
  const inhalt = $('#regenInhalt');
  if (!inhalt || !data?.hourly) return;
  const now = Date.now();
  const m = data.minutely_15;
  const h = data.hourly;

  // ── 1. Die nächsten zwei Stunden, Viertelstunde für Viertelstunde
  let feinTeil = '';
  if (m?.time?.length) {
    const ab = m.time.findIndex(t => new Date(t).getTime() >= now - 9e5);
    const bloecke = ab >= 0 ? m.time.slice(ab, ab + 9).map((t, k) => ({
      t: new Date(t).getTime(),
      mm: proStunde(m.precipitation[ab + k])
    })) : [];
    const maxMm = Math.max(0.5, ...bloecke.map(b => b.mm));
    const summe = bloecke.reduce((a, b) => a + b.mm / 4, 0);
    const alleTrocken = bloecke.every(b => b.mm < REGEN.nichts);

    /* Bei durchweg trockener Lage wäre das Säulenbild eine leere Fläche mit
       ein paar unsichtbaren Stummeln. Dann lieber ein klarer Streifen mit
       der Aussage darin — er beantwortet die Frage sofort. */
    feinTeil = alleTrocken ? `
      <p class="rs-kopf">Die nächsten zwei Stunden</p>
      <div class="rs-trocken">
        <span class="rs-tzeile">${bloecke.map(b => `<i></i>`).join('')}</span>
        <span class="rs-tspanne">${hhmm(bloecke[0].t)} – ${hhmm(bloecke[bloecke.length - 1].t)}</span>
      </div>
      <p class="rs-summe">Durchgehend trocken — von oben kommt nichts.</p>` : `
      <p class="rs-kopf">Die nächsten zwei Stunden</p>
      <div class="rs-fein">
        ${bloecke.map(b => {
          const st = regenStufe(b.mm);
          const hoch = b.mm < REGEN.nichts ? 3 : Math.max(12, (b.mm / maxMm) * 100);
          return `<span class="rs-saeule">
            <i style="height:${hoch.toFixed(0)}%;background:${
              st.farbe || 'rgba(255,255,255,.22)'}"></i>
            <em>${new Date(b.t).getMinutes() === 0 ? hhmm(b.t) : ''}</em>
          </span>`;
        }).join('')}
      </div>
      <p class="rs-summe">Zusammen rund <b>${dez(summe)} mm</b> —
        ${regenKlartext(maxMm).rat || 'kaum spürbar'}.</p>`;
  }

  // ── 2. Der ganze Tag in Stunden
  const heute = h.time[0]?.slice(0, 10);
  const heutigeStunden = [];
  h.time.forEach((t, k) => {
    if (t.slice(0, 10) !== heute) return;
    heutigeStunden.push({ t: new Date(t).getTime(), stunde: +t.slice(11, 13),
                          mm: h.precipitation[k] ?? 0,
                          p: h.precipitation_probability[k] ?? 0 });
  });
  const tagesSumme = heutigeStunden.reduce((a, x) => a + x.mm, 0);
  const nasse = heutigeStunden.filter(x => x.mm >= REGEN.nichts);

  // ── 3. Was sagen die anderen Modelle?
  let modellTeil = '';
  if (modelData?.hourly) {
    const H = modelData.hourly;
    const urteile = MODELS.map(mo => {
      let mm = 0, gesehen = false;
      const stunden = [];
      H.time.forEach((t, k) => {
        if (t.slice(0, 10) !== heute) return;
        const v = H[`precipitation_${mo.id}`]?.[k];
        if (v == null) return;
        gesehen = true; mm += v;
        if (v >= REGEN.nichts) stunden.push(+t.slice(11, 13));
      });
      return gesehen ? { name: mo.name, farbe: mo.color, mm, stunden } : null;
    }).filter(Boolean);

    if (urteile.length >= 2) {
      const nassZahl = urteile.filter(u => u.mm >= 0.5).length;
      const sicher = nassZahl === urteile.length ? 'Alle Modelle sagen Regen — darauf ist Verlass.'
        : nassZahl === 0 ? 'Kein Modell sieht nennenswerten Regen.'
        : `Nur <b>${nassZahl} von ${urteile.length}</b> Modellen sehen Regen — unsicher.`;
      const ton = nassZahl === urteile.length || nassZahl === 0 ? 'good' : 'warn';

      modellTeil = `
        <p class="rs-kopf">Wie sicher ist das?</p>
        <p class="rs-sicher" data-tone="${ton}">${sicher}</p>
        <div class="rs-modelle">
          ${urteile.map(u => `<div class="rs-mzeile">
            <span class="rs-mpunkt" style="background:${u.farbe}"></span>
            <span class="rs-mname">${esc(u.name)}</span>
            <span class="rs-mmenge">${u.mm < 0.05 ? 'trocken' : `${dez(u.mm)} mm`}</span>
            <span class="rs-mzeit">${u.stunden.length
              ? `${String(u.stunden[0]).padStart(2, '0')}–${
                  String(u.stunden[u.stunden.length - 1] + 1).padStart(2, '0')} Uhr`
              : u.mm >= 0.05
                /* Menge da, aber keine Stunde über der Schwelle: über den Tag
                   verstreute Spuren. „—" ließ das wie ein Fehler aussehen. */
                /* „Spuren" heißt: übers Ganze verteilt kommt etwas zusammen,
                   aber keine einzelne Stunde bringt genug, um sie zu nennen. */
                ? '<span title="über den Tag verteilt, keine Stunde nennenswert">verstreute Tropfen</span>'
                : '—'}</span>
          </div>`).join('')}
        </div>`;
    }
  }

  /* Der Punktverlauf steht ganz oben — er ist die genaueste Auskunft, die
     die App geben kann, und beantwortet die Frage direkt. */
  let punktTeil = '';
  if (punktVerlauf) {
    const jetzt = Date.now();
    const p = punktVerlauf.punkte.filter(x => x.t >= jetzt - 6 * 60000);
    const maxMm = Math.max(0.6, ...p.map(x => x.mm));
    const satz = punktSatz();
    punktTeil = `
      <p class="rs-kopf">Genau bei dir <span class="rs-neu">DWD 1 km</span></p>
      <p class="rs-punktsatz${satz?.regnet ? ' ist-nass' : ''}">${satz?.text || ''}</p>
      <div class="rs-fein rs-punktbild">
        ${p.map((x, k) => {
          const st = regenStufe(x.mm);
          const hoch = x.mm < 0.2 ? 3 : Math.max(12, (x.mm / maxMm) * 100);
          const beschriften = k === 0 || new Date(x.t).getMinutes() % 30 === 0;
          return `<span class="rs-saeule">
            <i style="height:${hoch.toFixed(0)}%;background:${st.farbe || 'rgba(255,255,255,.22)'}"></i>
            <em>${beschriften ? hhmm(x.t) : ''}</em></span>`;
        }).join('')}
      </div>
      <p class="rs-legende">Fünf-Minuten-Schritte vom Radar des Deutschen Wetterdienstes,
        1 km Auflösung — gemessen bis jetzt, danach gerechnet bis anderthalb Stunden voraus.
        Nicht für die Region, sondern für deinen Punkt.</p>`;
  }

  $('#regenTitel').textContent = tagesSumme < 0.1 ? 'Heute bleibt es trocken' : 'Regen heute';
  inhalt.innerHTML = `
    ${punktTeil}
    ${feinTeil}
    <p class="rs-kopf">Heute insgesamt</p>
    <p class="rs-tag">${tagesSumme < 0.1
      ? 'Für heute ist kein Niederschlag gerechnet.'
      : `<b>${dez(tagesSumme)} mm</b> über den Tag${nasse.length
          ? `, hauptsächlich ${String(nasse[0].stunde).padStart(2, '0')}–${
              String(nasse[nasse.length - 1].stunde + 1).padStart(2, '0')} Uhr` : ''}.
         Die höchste Wahrscheinlichkeit liegt bei <b>${Math.max(...heutigeStunden.map(x => x.p))} %</b>.
         Zur stärksten Stunde: ${regenSatzteil(Math.max(...heutigeStunden.map(x => x.mm)))}.`}</p>
    <div class="rs-stunden">
      ${(() => {
        /* Balken mit echter Höhe: Vorher hatten alle Stunden dieselbe Höhe
           und unterschieden sich nur in der Deckkraft — bei 0,2 mm über den
           Tag sah man schlicht nichts, obwohl darunter „Höhe der Balken"
           stand. Jetzt zeigt die Höhe die Menge, wie die Beschriftung sagt. */
        const maxStunde = Math.max(0.3, ...heutigeStunden.map(x => x.mm));
        return heutigeStunden.filter(x => x.stunde % 2 === 0).map(x => {
          const st = regenStufe(x.mm);
          const hoch = x.mm < 0.05 ? 2 : Math.max(6, (x.mm / maxStunde) * 100);
          return `<span class="rs-stunde" title="${String(x.stunde).padStart(2,'0')} Uhr: ${
            dez(x.mm)} mm, ${x.p} %">
            <b><i style="height:${hoch.toFixed(0)}%;opacity:${Math.min(1, 0.35 + x.p / 130)};
                 background:${st.farbe || 'rgba(255,255,255,.16)'}"></i></b>
            <em>${String(x.stunde).padStart(2, '0')}</em>
          </span>`;
        }).join('');
      })()}
    </div>
    <p class="rs-legende">Balkenhöhe: Menge je Stunde (höchster Wert
      ${dez(Math.max(...heutigeStunden.map(x => x.mm)))} mm) · Farbe: Kräftigkeit ·
      Deckkraft: Wahrscheinlichkeit.</p>
    ${modellTeil}
    <p class="rs-quelle">Viertelstundenwerte aus dem Kurzfristmodell des DWD —
      für die nächsten ein bis zwei Stunden erstaunlich treffsicher, weiter voraus
      wird aus „Regen um 16:15" eher „irgendwann am Nachmittag".</p>`;

  openSheet('#regenSheet');
}

/* ── Ortskorrektur ─────────────────────────────────────────
   Das Modell rechnet ein Gitter über Deutschland. Die Masche, in der
   Tübingen liegt, hat eine andere Höhe als die Stadt selbst — deshalb
   liegt die Vorhersage hier fast immer in dieselbe Richtung daneben.
   So etwas gehört korrigiert, und der Wetterdienst macht das mit seinen
   eigenen Vorhersagen genauso (dort heißt es MOS).

   Gemessen wird der Versatz aus 25 Tagen: Was war für gestern angesagt,
   was hat die Station gemessen? Wichtig ist die Aufteilung nach Tageszeit.
   Nachgeprüft für Tübingen:

     Nacht     +1,18 °C      vormittags  +1,24 °C
     früh 6-9  +0,03 °C      nachmittags +1,35 °C
                             abends      +1,77 °C

   Morgens stimmt das Modell also. Ein einziger Wert für alles hätte genau
   diese Stunden um 18 % verschlechtert — nach Tageszeit getrennt schadet
   die Korrektur nirgends und hilft abends um mehr als ein Drittel.
   Mitlaufend geprüft: 20 % weniger Fehler über alle Stunden. */
const VERSATZ_TAGE = 25;
const VERSATZ_MIN_PAARE = 8;        // je Block, sonst wird nicht korrigiert
let ortsVersatz = null;             // { bloecke: [24], tage, station, stand }

/** Vier-Stunden-Blöcke: fein genug für den Tagesgang, grob genug für Zahlen. */
const versatzBlock = (stunde) => Math.floor(stunde / 4);

async function ladeVersatz(lat, lon) {
  /* Neuer Schlüssel seit der Umstellung auf den Mittelweg: Ein bis zu 20
     Stunden alter, noch auf ICON gelernter Versatz würde sonst auf die
     neue Grundlage angewandt. */
  const key = `wf.versatz2:${lat.toFixed(2)},${lon.toFixed(2)}`;
  try {
    const alt = store.get(key, null);
    // Einmal am Tag reicht — der Versatz wandert über Wochen, nicht Stunden
    if (alt && Date.now() - alt.stand < 20 * 3600e3) { ortsVersatz = alt; return; }
  } catch {}

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
  const heute = new Date(); heute.setHours(0, 0, 0, 0);
  const von = new Date(heute); von.setDate(von.getDate() - VERSATZ_TAGE);
  const bis = new Date(heute); bis.setDate(bis.getDate() - 1);

  try {
    const [vh, ms] = await Promise.all([
      /* Auf derselben Grundlage lernen, auf der die App anzeigt: dem
         Mittelweg aus sechs Modellen. Ein auf ICON gelernter Versatz passte
         nicht mehr, seit die Temperatur aus dem Mittelweg kommt. */
      fetch('https://previous-runs-api.open-meteo.com/v1/forecast?' + new URLSearchParams({
        latitude: String(lat), longitude: String(lon), timezone: 'auto',
        hourly: 'temperature_2m_previous_day1',
        models: MODELS.map(m => m.id).join(','),
        past_days: String(VERSATZ_TAGE), forecast_days: '1'
      })).then(r => (r.ok ? r.json() : null)),
      fetch(`${BRIGHTSKY}/weather?lat=${lat}&lon=${lon}&date=${iso(von)}&last_date=${iso(bis)}`
            + `&tz=Europe/Berlin`).then(r => (r.ok ? r.json() : null))
    ]);
    if (!vh?.hourly || !ms?.weather?.length) { ortsVersatz = null; return; }

    const gemessen = new Map();
    for (const w of ms.weather) {
      if (w.temperature != null) gemessen.set(w.timestamp.slice(0, 13), w.temperature);
    }

    const felder = MODELS.map(m => vh.hourly[`temperature_2m_previous_day1_${m.id}`])
      .filter(Array.isArray);
    const mittel = (k) => {
      const w = felder.map(f => f[k]).filter(v => v != null).sort((a, b) => a - b);
      if (w.length < 3) return null;
      return w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
    };
    const summen = Array.from({ length: 6 }, () => ({ s: 0, n: 0 }));
    vh.hourly.time.forEach((t, k) => {
      const soll = mittel(k);
      const ist = gemessen.get(t.slice(0, 13));
      if (soll == null || ist == null) return;
      const b = versatzBlock(+t.slice(11, 13));
      summen[b].s += soll - ist;              // + = Modell zu warm
      summen[b].n++;
    });

    const bloecke = summen.map(x => (x.n >= VERSATZ_MIN_PAARE ? x.s / x.n : 0));
    const paare = summen.reduce((a, x) => a + x.n, 0);
    if (paare < 60) { ortsVersatz = null; return; }

    ortsVersatz = { bloecke, paare, station: ms.sources?.[0]?.station_name || '',
                    km: ms.sources?.[0] ? Math.round(ms.sources[0].distance / 1000) : null,
                    stand: Date.now() };
    store.set(key, ortsVersatz);
  } catch (e) {
    console.warn('Ortskorrektur:', e.message);
    ortsVersatz = null;
  }
}

/** Versatz für eine bestimmte Stunde. 0, wenn nichts bekannt ist. */
const versatzFuer = (stunde) => ortsVersatz?.bloecke?.[versatzBlock(stunde)] ?? 0;

/* Die Korrektur greift einmal, direkt nach dem Laden — nicht beim Zeichnen.
   Sonst würde sie bei jedem Neuzeichnen erneut abgezogen. */
function wendeVersatzAn(fc) {
  if (!ortsVersatz || !fc?.hourly?.time) return fc;
  /* Aus dem Zwischenspeicher kommen bereits korrigierte Zahlen zurück —
     ohne diese Marke würde der Versatz ein zweites Mal abgezogen und die
     Vorhersage wäre um mehrere Grad zu kalt. */
  if (fc.__korrigiert) return fc;
  fc.__korrigiert = true;

  const h = fc.hourly;
  const korrigiere = (feld) => {
    if (!Array.isArray(h[feld])) return;
    h[feld] = h[feld].map((v, k) =>
      (v == null ? v : +(v - versatzFuer(+h.time[k].slice(11, 13))).toFixed(1)));
  };
  korrigiere('temperature_2m');
  korrigiere('apparent_temperature');

  if (fc.current?.temperature_2m != null) {
    const st = new Date().getHours();
    fc.current.temperature_2m = +(fc.current.temperature_2m - versatzFuer(st)).toFixed(1);
    if (fc.current.apparent_temperature != null) {
      fc.current.apparent_temperature = +(fc.current.apparent_temperature - versatzFuer(st)).toFixed(1);
    }
  }

  /* Tageswerte aus den korrigierten Stundenwerten neu bilden statt separat
     zu korrigieren — sonst stünde im Streifen ein anderes Maximum als in
     der Kurve darüber. */
  if (fc.daily?.time) {
    fc.daily.time.forEach((tag, i) => {
      const werte = [];
      h.time.forEach((t, k) => { if (t.startsWith(tag) && h.temperature_2m[k] != null)
        werte.push(h.temperature_2m[k]); });
      if (werte.length >= 20) {
        if (fc.daily.temperature_2m_max) fc.daily.temperature_2m_max[i] = Math.max(...werte);
        if (fc.daily.temperature_2m_min) fc.daily.temperature_2m_min[i] = Math.min(...werte);
      }
    });
  }
  return fc;
}

/** Die Korrektur wird in der Quellenzeile mitgeführt — ein eigener Kasten
    darüber war eine Zeile zu viel für eine Angabe, die zur Herkunft der
    Zahlen gehört und nicht zum Wetter. */
function renderVersatzHinweis() {
  renderSource();
}

/* ── Rückblick: was war angesagt, was kam wirklich? ────────
   Jede Wetter-App zeigt, was kommt. Keine zeigt, ob sie beim letzten Mal
   recht hatte. Dabei ist genau das die Frage, an der Vertrauen hängt.

   Zwei Quellen, bewusst getrennt:
   · Was angesagt war — Open-Meteo hält frühere Modellläufe vor, also die
     Vorhersage von vor einem und von vor drei Tagen.
   · Was wirklich kam — die Messung der nächsten DWD-Station. Nicht die
     spätere Modellrechnung: Das Modell gegen sich selbst zu prüfen wäre
     ein Zirkelschluss.

   Der Vergleich läuft deshalb nur in Deutschland; anderswo fehlt die
   Messreihe und die Karte bleibt weg. */
const RUECK_TAGE = 6;
/* Untertitel der zugeklappten Karten: Die Render-Funktionen laufen auch,
   wenn die Karte zu ist — der Text wird gemerkt und beim Aufklappen gesetzt. */
let rueckStandText = '', modelAgreeText = '', dwdRegionText = '';

async function ladeRueckblick(lat, lon) {
  const karte = $('#rueckCard');
  if (!karte) return;
  try {
    const heute = new Date(); heute.setHours(0, 0, 0, 0);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
      String(d.getDate()).padStart(2, '0')}`;
    const von = new Date(heute); von.setDate(von.getDate() - RUECK_TAGE);
    const bis = new Date(heute); bis.setDate(bis.getDate() - 1);

    const vorhersageUrl = 'https://previous-runs-api.open-meteo.com/v1/forecast?'
      + new URLSearchParams({
          latitude: String(lat), longitude: String(lon), timezone: 'auto',
          hourly: ['temperature_2m_previous_day1', 'temperature_2m_previous_day3',
                   'precipitation_previous_day1'].join(','),
          past_days: String(RUECK_TAGE), forecast_days: '1'
        });
    const messUrl = `${BRIGHTSKY}/weather?lat=${lat}&lon=${lon}`
      + `&date=${iso(von)}&last_date=${iso(bis)}&tz=Europe/Berlin`;

    /* Dritter Abruf: dieselben gestrigen Vorhersagen, aber je Modell.
       Daraus lernt die Quelle „Lernend", wem sie glauben soll. */
    const LERN_MODELLE = ['icon_seamless', 'ecmwf_ifs025', 'gfs_seamless'];
    const modellUrl = 'https://previous-runs-api.open-meteo.com/v1/forecast?'
      + new URLSearchParams({
          latitude: String(lat), longitude: String(lon), timezone: 'auto',
          hourly: 'temperature_2m_previous_day1,precipitation_previous_day1',
          models: LERN_MODELLE.join(','),
          past_days: String(RUECK_TAGE), forecast_days: '1'
        });

    const [vh, ms, mvh] = await Promise.all([
      fetch(vorhersageUrl).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(messUrl).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(modellUrl).then(r => (r.ok ? r.json() : null)).catch(() => null)
    ]);
    if (!vh?.hourly || !ms?.weather?.length) { karte.hidden = true; return; }

    // Beides auf Tage zusammenfassen
    const proTag = new Map();
    const holen = (tag) => {
      if (!proTag.has(tag)) proTag.set(tag, { temps: [], regen: 0, stunden: 0,
                                              v1: [], v3: [], r1: 0 });
      return proTag.get(tag);
    };
    for (const w of ms.weather) {
      if (w.temperature == null) continue;
      const e = holen(w.timestamp.slice(0, 10));
      e.temps.push(w.temperature);
      e.regen += w.precipitation || 0;
      e.stunden++;
    }
    const h = vh.hourly;
    h.time.forEach((t, k) => {
      const e = proTag.get(t.slice(0, 10));
      if (!e) return;
      const a = h.temperature_2m_previous_day1?.[k];
      const b = h.temperature_2m_previous_day3?.[k];
      if (a != null) e.v1.push(a);
      if (b != null) e.v3.push(b);
      e.r1 += h.precipitation_previous_day1?.[k] || 0;
    });

    // Nur vollständige Tage — ein halber Tag verzerrt das Maximum
    const tage = [...proTag.entries()]
      .filter(([, e]) => e.stunden >= 20 && e.v1.length >= 20)
      .map(([tag, e]) => ({
        tag,
        istMax: Math.max(...e.temps), istRegen: e.regen,
        sollMax1: Math.max(...e.v1),
        sollMax3: e.v3.length >= 20 ? Math.max(...e.v3) : null,
        sollRegen1: e.r1
      }))
      .sort((a, b) => (a.tag < b.tag ? 1 : -1));

    if (!tage.length) { karte.hidden = true; return; }
    renderRueckblick(tage, ms.sources?.[0]);
    bewerteModelle(tage, mvh, LERN_MODELLE);
    karte.hidden = false;
  } catch (e) {
    console.warn('Rückblick:', e.message);
    karte.hidden = true;
  }
}

/* ── Lernen: welches Modell lag zuletzt am besten? ─────────
   Für jedes Modell dieselbe Rechnung wie oben: Was hat es gestern für
   gestern vorhergesagt, was hat die Station gemessen? Der Sieger nach
   mittlerem Temperaturfehler wird gespeichert — die Quelle „Lernend"
   greift ihn beim nächsten Laden ab. Bewusst erst ab vier Tagen und nur
   bei echtem Vorsprung gewechselt, sonst springt die App bei jedem
   Wetterumschwung zwischen den Modellen hin und her. */
function bewerteModelle(tage, mvh, modelle) {
  const box = $('#rueckModelle');
  if (!box) return;
  if (!mvh?.hourly) { box.innerHTML = ''; return; }
  const h = mvh.hourly;

  const wertung = modelle.map(mid => {
    let fehlerSumme = 0, versatzSumme = 0, regenTreffer = 0, n = 0;
    for (const t of tage) {
      const temps = [], regen = [];
      h.time.forEach((zt, k) => {
        if (!zt.startsWith(t.tag)) return;
        const tv = h[`temperature_2m_previous_day1_${mid}`]?.[k];
        const rv = h[`precipitation_previous_day1_${mid}`]?.[k];
        if (tv != null) temps.push(tv);
        if (rv != null) regen.push(rv);
      });
      if (temps.length < 20) continue;
      const diff = Math.max(...temps) - t.istMax;     // + = Modell zu warm
      fehlerSumme += Math.abs(diff);
      versatzSumme += diff;
      const sollNass = regen.reduce((a, b) => a + b, 0) >= 0.5;
      if (sollNass === (t.istRegen >= 0.5)) regenTreffer++;
      n++;
    }
    return n >= 4 ? { id: mid, name: sourceOf(mid).name,
                      mae: fehlerSumme / n, bias: versatzSumme / n,
                      regen: regenTreffer, tage: n } : null;
  }).filter(Boolean).sort((a, b) => a.mae - b.mae);

  if (wertung.length < 2) { box.innerHTML = ''; return; }

  /* Die Reihenfolge ist Information, keine Anweisung: Über wenige Tage
     entscheidet der Zufall, wer vorn steht. Deshalb steht hier bewusst
     auch, wie sich die Fehler zusammensetzen — ein gleichmäßiger Versatz
     ist etwas anderes als wildes Streuen. */
  box.innerHTML = `
    <p class="rm-kopf">Und welches Modell lag am besten?</p>
    <div class="rm-reihe">${wertung.map((w, i) => `
      <span class="rm-eintrag${i === 0 ? ' rm-sieger' : ''}">
        <b>${i + 1}. ${esc(w.name)}</b>
        <i>Ø ${dez(w.mae)} °C · ${w.bias > 0.4 ? `${dez(w.bias)} °C zu warm`
           : w.bias < -0.4 ? `${dez(-w.bias)} °C zu kalt` : 'ohne festen Versatz'}</i>
      </span>`).join('')}
    </div>
    <p class="rm-text">Über so wenige Tage ist die Reihenfolge nicht belastbar —
      sie kann nächste Woche anders aussehen. Aussagekräftiger ist ein Versatz,
      der immer in dieselbe Richtung zeigt: Der kommt von der Lage des Ortes und
      bleibt. Die Vorhersage oben wird davon nicht umgestellt.</p>`;
}

/** Ab wann ist eine Abweichung schlimm? Ein Grad merkt niemand, drei schon. */
const rueckTon = (d) => (d <= 1 ? 'gut' : d <= 2.5 ? 'ok' : 'schlecht');

function renderRueckblick(tage, quelle) {
  const abw1 = tage.map(t => Math.abs(t.istMax - t.sollMax1));
  const mittel1 = abw1.reduce((a, b) => a + b, 0) / abw1.length;
  const mitDrei = tage.filter(t => t.sollMax3 != null);
  const mittel3 = mitDrei.length
    ? mitDrei.reduce((a, t) => a + Math.abs(t.istMax - t.sollMax3), 0) / mitDrei.length : null;

  // Regen zählt als getroffen, wenn die Aussage "nass oder trocken" stimmte
  const nass = (mm) => mm >= 0.5;
  const regenTreffer = tage.filter(t => nass(t.istRegen) === nass(t.sollRegen1)).length;

  rueckStandText = `letzte ${tage.length} Tage`;
  if ($('#rueckBody')?.hidden === false) $('#rueckStand').textContent = rueckStandText;

  const urteil = mittel1 <= 1 ? 'sehr gut' : mittel1 <= 2 ? 'gut'
               : mittel1 <= 3 ? 'brauchbar' : 'eher daneben';

  /* Liegt die Vorhersage immer in dieselbe Richtung daneben, ist das kein
     Zufall, sondern eine Eigenart des Modells an diesem Ort — meist wegen
     der Höhenlage oder weil die Stadt wärmer ist als das Umland. Das ist
     die nützlichere Aussage als der reine Mittelwert. */
  const abweichungen = tage.map(t => t.istMax - t.sollMax1);
  const zuWarm = abweichungen.filter(d => d < -0.5).length;
  const zuKalt = abweichungen.filter(d => d > 0.5).length;
  const schnitt = abweichungen.reduce((a, b) => a + b, 0) / abweichungen.length;
  let muster = '';
  if (zuWarm >= tage.length * 0.8 && Math.abs(schnitt) >= 0.8) {
    muster = ` Auffällig: Sie lag dabei fast immer <b>zu hoch</b>, im Mittel um ${dez(-schnitt)} °C.`;
  } else if (zuKalt >= tage.length * 0.8 && Math.abs(schnitt) >= 0.8) {
    muster = ` Auffällig: Sie lag dabei fast immer <b>zu niedrig</b>, im Mittel um ${dez(schnitt)} °C.`;
  }

  /* Regen zuerst: Ob man nass wird, entscheidet den Tag — ein halbes Grad
     Abweichung merkt niemand. Vorher stand die Temperatur vorn. */
  const regenQuote = Math.round((regenTreffer / tage.length) * 100);
  const regenUrteil = regenQuote >= 85 ? 'sehr zuverlässig'
    : regenQuote >= 70 ? 'meistens richtig' : 'nur bedingt verlässlich';
  // Wie gut stimmte auch die Menge, nicht nur nass/trocken?
  const mitRegen = tage.filter(t => nass(t.istRegen) || nass(t.sollRegen1));
  const mengenFehler = mitRegen.length
    ? mitRegen.reduce((a, t) => a + Math.abs(t.istRegen - t.sollRegen1), 0) / mitRegen.length
    : null;

  $('#rueckFazit').innerHTML =
    `<b>Regen:</b> Ob es nass wird oder trocken bleibt, stimmte an `
    + `<b>${regenTreffer} von ${tage.length}</b> Tagen — ${regenUrteil}.`
    + (mengenFehler != null
        ? ` Bei der Menge lag sie im Schnitt ${dez(mengenFehler)} mm daneben.` : '')
    + `<br><b>Temperatur:</b> Die Höchstwerte lagen im Schnitt `
    + `<b>${dez(mittel1)} °C</b> daneben — ${urteil}.${mittel3 != null
        ? ` Drei Tage im Voraus ${dez(mittel3)} °C.` : ''}`
    + muster;

  $('#rueckListe').innerHTML = tage.map(t => {
    const d = t.istMax - t.sollMax1;
    const ton = rueckTon(Math.abs(d));
    /* Runden beide Werte auf dieselbe Zahl, die Abweichung ist aber sichtbar,
       wirkt „29° → 29°  −0,8" widersprüchlich. Dann eine Stelle mehr zeigen. */
    const genau = Math.round(t.sollMax1) === Math.round(t.istMax) && Math.abs(d) >= 0.5;
    const zahl = (v) => (genau ? dez(v) : String(Math.round(v)));
    const datum = new Date(t.tag + 'T12:00');
    const regenPasst = nass(t.istRegen) === nass(t.sollRegen1);
    return `<div class="rk-zeile">
      <span class="rk-tag"><b>${weekday(datum)}</b><i>${datum.getDate()}.${datum.getMonth() + 1}.</i></span>
      <span class="rk-werte">
        <span class="rk-paar"><i>angesagt</i><b>${zahl(t.sollMax1)}°</b></span>
        <span class="rk-pfeil">→</span>
        <span class="rk-paar"><i>gemessen</i><b>${zahl(t.istMax)}°</b></span>
      </span>
      <span class="rk-abw t-${ton}">${d > 0 ? '+' : ''}${dez(d)}</span>
      <span class="rk-regen">${nass(t.istRegen) ? '🌧' : '☀️'}</span>
      ${regenPasst ? '' : `<span class="rk-notiz">${
        nass(t.istRegen)
          ? `Regen war nicht angesagt — es fielen ${dez(t.istRegen)} mm`
          : `${dez(t.sollRegen1)} mm Regen angesagt, gefallen ist nichts`}</span>`}
    </div>`;
  }).join('');

  $('#rueckQuelle').innerHTML = quelle
    ? `Gemessen an der DWD-Station ${esc(quelle.station_name)}, ${
        Math.round(quelle.distance / 1000)} km entfernt. Verglichen wird die Vorhersage, `
      + `die einen Tag vorher galt — nicht die spätere Nachrechnung.`
    : '';
}

function renderScrub() {
  const h = data.hourly, m = data.minutely_15;
  const punkte = buildScrubPoints();
  if (!punkte.length) return;
  // Dieselbe Liste bekommt auch currentScrubTime() — siehe dort
  scrubPunkte = punkte;

  const sl = $('#scrubSlider');
  sl.max = String(punkte.length - 1);
  const anteil = (k) => (k / (punkte.length - 1)) * 100;
  const nullpunkt = jetztIndex(punkte);

  /** Zur Stunde gehörender Index in den Stundendaten — auch für die
      Radarbilder der Vergangenheit, die keine eigenen Modellwerte haben. */
  const stundeVon = (p) => {
    if (!p.radar && !p.fein) return p.i;
    const k = h.time.findIndex(x => new Date(x).getTime() >= p.t.getTime());
    return Math.max(0, k < 0 ? h.time.length - 1 : (k > 0 ? k - 1 : 0));
  };

  // Marken: Jetzt, Ende des Feinbereichs, Tagesgrenzen
  const ticks = [`<span class="tick-now" style="left:${anteil(nullpunkt).toFixed(1)}%"
    data-label="jetzt"></span>`];
  const letzteFein = punkte.findLastIndex(p => p.fein && !p.radar);
  if (letzteFein > 0) {
    /* Ohne Schrift: „jetzt", der Wochentag und dieses Etikett lagen auf
       derselben Linie übereinander. Was der grüne Strich bedeutet, steht
       jetzt im Erklärsatz unter dem Regler. */
    ticks.push(`<span class="tick-fine" style="left:${anteil(letzteFein).toFixed(1)}%"
      title="Bis hier im 15-Minuten-Takt"></span>`);
  }
  punkte.forEach((p, k) => {
    if (k > 0 && p.t.getHours() === 0 && p.t.getMinutes() === 0) {
      ticks.push(`<span class="tick-day" style="left:${anteil(k).toFixed(1)}%"
        data-label="${weekday(p.t)}"></span>`);
    }
  });
  $('#scrubTicks').innerHTML = ticks.join('');

  // Regenband über alle Stützstellen
  const mmVon = (p) => (p.radar ? (h.precipitation[stundeVon(p)] ?? 0)
                      : p.fein  ? (m.precipitation[p.i] ?? 0) * 4
                                : (h.precipitation[p.i] ?? 0));
  const maxMm = Math.max(0.6, ...punkte.map(mmVon));
  $('#scrubStrip').innerHTML = punkte.map((p, k) => {
    const mm = mmVon(p);
    const hi = stundeVon(p);
    const prob = p.fein && !p.radar ? 0 : (h.precipitation_probability[hi] ?? 0);
    const nacht = p.radar ? !h.is_day[hi] : p.fein ? !m.is_day?.[p.i] : !h.is_day[p.i];
    const hoehe = mm > 0 ? Math.max(9, (mm / maxMm) * 100) : (prob >= 20 ? 5 : 2);
    return `<i class="${mm > 0 ? 'on' : prob >= 20 ? 'maybe' : ''}${nacht ? ' night' : ''}${
      p.fein ? ' fine' : ''}${p.radar ? ' past' : ''}${k === nullpunkt ? ' now' : ''}"
      style="height:${hoehe.toFixed(0)}%"></i>`;
  }).join('');

  const paint = () => {
    const k = Math.min(+sl.value, punkte.length - 1);
    const p = punkte[k];
    const t = p.t;
    const heute = t.toDateString() === new Date().toDateString();
    const morgen = t.toDateString() === new Date(Date.now() + 864e5).toDateString();
    const tag = heute ? 'Heute' : morgen ? 'Morgen' : t.toLocaleDateString('de-DE', { weekday: 'long' });
    const minuten = Math.round((t - Date.now()) / 60000);

    $('#scrubWhen').innerHTML =
      p.radar && minuten < -3 ? `${hhmm(t)} Uhr <em>vor ${-minuten} Min. gemessen</em>`
      : Math.abs(minuten) <= 7 ? 'jetzt'
      : `${tag}, ${hhmm(t)} Uhr${p.fein ? ` <em>in ${minuten} Min.</em>` : ''}`;

    sl.parentElement?.classList.toggle('is-past', k < nullpunkt);

    // Feinbereich: echte Viertelstundenwerte, sonst Stundenwerte.
    // Was es nur stündlich gibt, kommt aus der nächstgelegenen Stunde.
    const hi = stundeVon(p);
    const echt = !p.radar && p.fein;
    const code = p.radar ? h.weather_code[hi] : echt ? m.weather_code[p.i] : h.weather_code[p.i];
    const tag_ = p.radar ? h.is_day[hi] : echt ? (m.is_day?.[p.i] ?? 1) : h.is_day[p.i];
    const temp = p.radar ? h.temperature_2m[hi] : echt ? m.temperature_2m[p.i] : h.temperature_2m[p.i];
    const wind = p.radar ? h.wind_speed_10m[hi] : echt ? m.wind_speed_10m[p.i] : h.wind_speed_10m[p.i];
    const mm = p.radar ? (h.precipitation[hi] ?? 0)
             : echt ? (m.precipitation[p.i] ?? 0) : (h.precipitation[p.i] ?? 0);
    const prob = h.precipitation_probability[hi] ?? 0;

    $('#scrubRead').innerHTML = `
      <span class="sr-icon">${WX.icon(code, tag_)}</span>
      <span class="sr-main">
        <b>${round(temp)}°</b>
        <i>${WX.text(code, tag_)}</i>
      </span>
      <span class="sr-plain">${windWorte(wind)}${
        Math.abs((h.apparent_temperature[hi] ?? temp) - temp) >= 1.5
          ? ` · fühlt sich wie ${round(h.apparent_temperature[hi])}° an` : ''}</span>
      <span class="sr-grid">
        <span><em>Gefühlt</em>${round(h.apparent_temperature[hi])}°</span>
        <span><em>Regen</em>${prob}%${mm >= 0.05
          ? ` · ${dez(mm, mm < 1 ? 2 : 1)} mm${echt ? '/15min' : ''}` : ''}</span>
        <span><em>Wind</em>${round(wind)} km/h</span>
        <span><em>Böen</em>${round(h.wind_gusts_10m[hi])} km/h</span>
        <span><em>Feuchte</em>${round(h.relative_humidity_2m[hi])}%</span>
        <span><em>Wolken</em>${round(h.cloud_cover?.[hi])}%</span>
      </span>`;
  };

  sl.oninput = (e) => {
    // Zieht der Finger, den Zeitraffer anhalten — mein eigener Takt darf weiter
    if (e?.isTrusted && spielTimer) toggleZeitraffer();
    paint();
    syncMapAt(punkte[+sl.value]?.t);
    zeitMarkeHeben();      // Zeitpunkt oben in der Karte kurz hervorheben
  };

  /* Am Rechner gibt es kein Wischen: waagerechte Trackpad-Gesten und das
     Mausrad über dem Regler auf den Zeitstrahl umlenken. Sonst muss man den
     kleinen Knopf treffen, um die Karte durch die Zeit zu schieben. */
  const wrap = sl.parentElement;
  if (wrap && !wrap.dataset.wired) {
    wrap.dataset.wired = '1';
    wrap.addEventListener('wheel', (ev) => {
      const d = Math.abs(ev.deltaX) >= Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      if (!d) return;
      const weiter = Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 12));
      const neu = clamp(+sl.value + weiter, 0, +sl.max);
      if (neu === +sl.value) return;                  // am Ende die Seite scrollen lassen
      ev.preventDefault();
      if (spielTimer) toggleZeitraffer();
      sl.value = String(neu);
      sl.dispatchEvent(new Event('input'));
    }, { passive: false });
  }
  // Beim Öffnen im Jetzt stehen — nicht am linken Rand in der Vergangenheit
  sl.value = String(nullpunkt);
  paint();
  syncMapAt(punkte[nullpunkt].t);
}

/* Der Abspielknopf lief früher nur über die gemessene Vergangenheit und hielt
   im Jetzt an. Wer ihn drückte, sah die Zugbahn heranziehen — und dann nichts
   mehr. Genau das ist die Frage beim Regenradar: Kommt es zu mir?

   Jetzt läuft er weiter in die Vorhersage, bis ans Ende des Viertelstunden-
   Takts (rund drei Stunden voraus). Weiter zu laufen brächte nichts: Ab da
   gibt es nur noch Stundenschritte, und die Zugbahn eines Schauers ist so
   weit voraus ohnehin nicht mehr genau. */
let spielTimer = null;

function spielEnde(punkte) {
  // Ende des Viertelstunden-Bereichs; fehlt er, wenigstens drei Stunden voraus
  const fein = punkte.findLastIndex(p => p.fein && !p.radar);
  if (fein > 0) return fein;
  const grenze = Date.now() + 3 * 3600e3;
  const k = punkte.findIndex(p => p.t.getTime() > grenze);
  return k > 0 ? k : punkte.length - 1;
}

function toggleZeitraffer() {
  const sl = $('#scrubSlider');
  const knopf = $('#playBtn');
  if (spielTimer) {
    clearInterval(spielTimer); spielTimer = null;
    knopf?.classList.remove('is-playing');
    return;
  }
  const punkte = buildScrubPoints();
  const ziel = spielEnde(punkte);
  if (ziel <= 0) return;

  knopf?.classList.add('is-playing');
  let k = 0;
  const schritt = () => {
    sl.value = String(k);
    sl.dispatchEvent(new Event('input'));
    if (k++ >= ziel) {
      clearInterval(spielTimer); spielTimer = null;
      knopf?.classList.remove('is-playing');
      // Die Zahlen erst jetzt setzen — während des Laufs wären sie nur Last
      Radar.updateLabels?.();
    }
  };
  schritt();
  /* 420 ms je Bild war zäh: Eine Zugbahn erkennt man erst, wenn die Bilder
     schnell genug aufeinanderfolgen. Bei 150 ms läuft der Nachmittag in gut
     vier Sekunden durch — nah an dem, was Radaransichten üblicherweise
     zeigen, und immer noch verfolgbar. */
  spielTimer = setInterval(schritt, 150);
}

// ══ Kartenebenen ═══════════════════════════════════════════
/* Symbole statt Wörter: Im Vollbild ist die Karte das Wichtigste, und sechs
   ausgeschriebene Wörter fressen den halben Schirm. Die Zeichen sind
   selbsterklärend genug, die Wörter stehen weiter in der Legende und beim
   Antippen der Legende. */
const LAYER_SVG = {
  regen: '<path d="M6 15.5a4 4 0 0 1 .4-8 5.6 5.6 0 0 1 10.6 1.3 3.4 3.4 0 0 1-.5 6.7z"/>'
       + '<path d="M8.5 17.6 7.4 20.5M12.5 17.6l-1.1 2.9M16.5 17.6l-1.1 2.9"/>',
  wolken: '<path d="M6 17a4.2 4.2 0 0 1 .4-8.4A5.9 5.9 0 0 1 17.6 10a3.6 3.6 0 0 1-.5 7z"/>',
  temperatur: '<path d="M14 13.6V5.5a2 2 0 1 0-4 0v8.1a4 4 0 1 0 4 0z"/><path d="M12 9.5v5"/>',
  boeen: '<path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 14h14a3 3 0 1 1-3 3"/><path d="M3 19h7"/>',
  wind: '<path d="M12 4v16"/><path d="M8 8l4-4 4 4"/>',
  gewitter: '<path d="M6 14.5a4 4 0 0 1 .4-8 5.6 5.6 0 0 1 10.6 1.3 3.4 3.4 0 0 1-.5 6.7z"/>'
          + '<path d="m12.5 15-2.5 4h3l-2 4"/>',
  // Zahlen auf der Karte: ein Etikett mit Ziffer statt kryptischer Striche
  zahlen: '<rect x="3.5" y="6.5" width="17" height="11" rx="2.5"/>'
        + '<path d="M8 10.5h1.5v3M13 10.5h2.5l-2 3h2.5"/>',
  schirme: '<path d="M2.8 12.4a9.2 9.2 0 0 1 18.4 0"/>'
         + '<path d="M2.8 12.4c1.2 2.2 4.9 2.2 6.1 0c1.2 2.2 4.9 2.2 6.1 0c1.2 2.2 4.9 2.2 6.1 0"/>'
         + '<path d="M12 3.2V17.8q0 2.6 2.8 2"/>'
};

const LAYERS = [
  { id: 'regen',      name: 'Niederschlag', farbe: '#5ac8fa' },
  { id: 'schirme',    name: 'Regenschirme', farbe: '#4aa8e0' },
  { id: 'wolken',     name: 'Wolken',       farbe: '#e6ecf5' },
  { id: 'temperatur', name: 'Temperatur',   farbe: '#ff9f6a' },
  { id: 'boeen',      name: 'Sturmböen',    farbe: '#be78f0' },
  { id: 'wind',       name: 'Windpfeile',   farbe: '#39a0e8' },
  { id: 'gewitter',   name: 'Gewitter',     farbe: '#ff5a5a' },
  { id: 'zahlen',     name: 'Grad-Zahlen',  farbe: '#ffffff' }
];

/* Diese drei sind Zeichen auf der Karte, keine eingefärbten Flächen. Sie
   gehören deshalb nicht in den Schlüssel, unter dem die Rasterbilder
   zwischengespeichert werden — sonst passen Ablegen und Suchen nicht
   zusammen. An zwei Stellen gebraucht, darum hier an einer Stelle erklärt. */
const SYMBOL_EBENEN = new Set(['zahlen', 'wind', 'schirme']);

const activeLayers = () => new Set(store.get(LS.layers, ['regen', 'wolken']));

function renderLayerPicker() {
  const box = $('#layerPick');
  if (!box) return;
  const an = activeLayers();
  box.innerHTML = LAYERS.map(l =>
    `<button class="lchip${an.has(l.id) ? ' on' : ''}" data-layer="${l.id}"
       style="--c:${l.farbe}" title="${esc(l.name)}" aria-label="${esc(l.name)}"
       aria-pressed="${an.has(l.id) ? 'true' : 'false'}">
       <svg class="lc-sym" viewBox="0 0 24 24" aria-hidden="true">${LAYER_SVG[l.id] || ''}</svg>
       <span class="lc-wort">${l.name}</span></button>`).join('');

  $$('.lchip', box).forEach(b => b.addEventListener('click', () => {
    const jetzt = activeLayers();
    const id = b.dataset.layer;
    jetzt.has(id) ? jetzt.delete(id) : jetzt.add(id);
    if (!jetzt.size) jetzt.add('regen');            // mindestens eine Ebene
    store.set(LS.layers, [...jetzt]);
    renderLayerPicker();
    Radar.updateLegend?.();      // Legende zeigt nur die aktiven Ebenen
    ebenenGeaendert();
  }));
}

/* Der Zeitstrahl wurde an zwei Stellen unabhängig gebaut: renderScrub()
   beschriftet aus seiner Fassung, currentScrubTime() baute jedes Mal eine
   neue. Die Zahl der Radarbilder am linken Rand ändert sich aber mit jedem
   Fünf-Minuten-Takt — danach bedeutet derselbe Reglerstand in beiden
   Fassungen eine andere Stunde.

   Sichtbar wurde das auf der Karte: Über dem Regler stand „Montag, 09:00",
   die Zahlen im Bild gehörten zu Mittwoch 18:00. Beide lesen jetzt aus
   derselben Liste, die renderScrub() beim Zeichnen hinterlegt. */
let scrubPunkte = null;
const currentScrubTime = () => {
  const p = scrubPunkte?.length ? scrubPunkte : buildScrubPoints();
  return p[Math.min(+($('#scrubSlider')?.value || 0), p.length - 1)]?.t;
};

/** Kurzform des Zeitpunkts für die Karte: heute reicht die Uhrzeit,
    an anderen Tagen gehört der Wochentag davor. */
function mapZeitWort(t) {
  const d = t instanceof Date ? t : new Date(t);
  const minuten = Math.round((d - Date.now()) / 60000);
  if (Math.abs(minuten) <= 2) return 'jetzt';
  /* Im Nahbereich zählt der Abstand, nicht die Uhrzeit: „in 35 Min." sagt
     einem beim Vorschieben sofort, wann das Regengebiet ankommt. */
  if (minuten > 0 && minuten <= 120) return `${hhmm(d)} · in ${minuten} Min.`;
  if (minuten < 0 && minuten >= -120) return `${hhmm(d)} · vor ${-minuten} Min.`;
  return d.toDateString() === new Date().toDateString()
    ? `${hhmm(d)} Uhr` : `${weekday(d)} ${hhmm(d)} Uhr`;
}

/** Beschriftung oben in der Karte: erst der Zeitpunkt, dann die Art der
    Darstellung. Beim Schieben am Zeitstrahl ist der Zeitpunkt das Wichtigste —
    sonst sieht man nicht, welchen Moment die Karte gerade zeigt. */
function setMapMode(zeit, art, mode) {
  const label = $('#mapMode');
  if (!label) return;
  label.innerHTML = (zeit ? `<b class="mm-zeit">${zeit}</b>` : '') +
                    `<span class="mm-art">${art}</span>`;
  label.dataset.mode = mode;
}

/** Beim Schieben tritt die Zeit kurz hervor und legt sich danach wieder
    zurück — dauerhaft groß würde sie die Karte verdecken. */
let zeitMarkeTimer = null;
function zeitMarkeHeben() {
  const label = $('#mapMode');
  if (!label) return;
  label.classList.add('is-scrub');
  clearTimeout(zeitMarkeTimer);
  zeitMarkeTimer = setTimeout(() => label.classList.remove('is-scrub'), 1600);
}

/* Karte an den Zeitstrahl koppeln. Bis wohin das echte Radar zuständig ist,
   hängt davon ab, wie weit seine Bilder reichen: RainViewer liefert manchmal
   eine halbe Stunde Kurzprognose, manchmal gar keine. Ohne diese Prüfung
   zeigte die Karte bis zu 35 Minuten „Radar-Kurzprognose", obwohl sie in
   Wahrheit das letzte gemessene Bild eingefroren hatte — die Vorhersage
   schien nicht zu funktionieren. */
function radarGrenze() {
  const bilder = Radar.frameTimes?.() || [];
  const letzte = bilder.length ? bilder[bilder.length - 1].t : null;
  if (!letzte) return 0;
  // Ein halber Bildabstand Puffer, damit der Wechsel nicht flackert
  return Math.max(0, (letzte - Date.now()) / 60000 + 5);
}

function syncMapAt(ziel) {
  if (!radarReady || !ziel) return;
  const zielMs = ziel instanceof Date ? ziel.getTime() : ziel;
  const vorlauf = (zielMs - Date.now()) / 60000;    // Minuten voraus

  /* Im Fenster von einer Stunde zurück bis anderthalb Stunden voraus zeigt
     das RV-Komposit des DWD: 1 km Auflösung, Fünf-Minuten-Takt, gemessen
     und gerechnet aus einem Guss. Genauer geht es in Deutschland nicht. */
  if (Radar.rvMoeglich?.(zielMs) && Radar.zeigeNowcast?.(zielMs)) {
    const zeitWort = mapZeitWort(ziel);
    setMapMode(zeitWort, vorlauf > 2 ? 'DWD-Radarvorhersage' : 'DWD-Radarmessung', 'radar');
    if (!spielTimer) Radar.updateLabels();
    return;
  }

  /* Die Zahlen auf der Karte bauen bei jedem Aufruf eine neue GeoJSON-Quelle
     aus 400 Punkten. Während der Animation ist das die teuerste Einzelheit
     und ändert dabei kaum etwas Sichtbares — deshalb dort ausgelassen und
     einmal am Ende nachgeholt. */
  const beschriften = () => { if (!spielTimer) Radar.updateLabels(); };

  const zeit = mapZeitWort(ziel);
  if (vorlauf <= radarGrenze()) {
    Radar.showRadar();
    Radar.showAt(ziel instanceof Date ? ziel.getTime() : ziel);
    beschriften();                 // sonst greift ein Ebenenwechsel hier nicht
    setMapMode(zeit, vorlauf > 7 ? 'Radar-Kurzprognose' : 'Radarmessung', 'radar');
  } else {
    const hi = Forecast.indexFor(ziel);
    // Zahlen und Windpfeile sind Symbole, keine Farbflächen
    const flaechen = new Set([...activeLayers()].filter(x => !SYMBOL_EBENEN.has(x)));
    const ok = hi >= 0 && (flaechen.size ? Radar.showForecast(hi, flaechen) : true);
    beschriften();
    // Die Zahlen sind keine Fläche — sie gehören nicht in die Aufzählung
    const namen = LAYERS.filter(l => l.id !== 'zahlen' && activeLayers().has(l.id))
      .map(l => l.name).join(' + ') || 'Karte';
    setMapMode(zeit, ok ? `${namen} · Vorhersage` : 'Vorhersage nicht geladen',
               ok ? 'forecast' : 'none');
  }
}

/** Wird die Karte weit weggeschoben, deckt das Raster den Ausschnitt nicht
    mehr ab. Dann für die neue Mitte nachladen — auch auf dem Globus. */
let nachladeTimer = null;
/** Sichtbarer Kartenausschnitt in der Form, die Forecast erwartet. */
function sichtbarerBereich() {
  const b = Radar.map?.getBounds?.();
  if (!b) return null;
  return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
}

function onMapMoved(mitte, zoom) {
  const ebenen = activeLayers();
  const sicht = sichtbarerBereich();
  if (Forecast.covers(mitte.lat, mitte.lng, zoom, ebenen, sicht)) { Radar.updateLabels?.(); return; }
  clearTimeout(nachladeTimer);
  nachladeTimer = setTimeout(() => {
    ladeRaster(mitte.lat, mitte.lng, zoom, ebenen, sichtbarerBereich());
  }, 600);
}

/** Raster holen und dabei sichtbar machen, dass gerade geladen wird. */
function ladeRaster(lat, lon, zoom, ebenen, sicht) {
  const zeit = () => { const t = currentScrubTime(); return t ? mapZeitWort(t) : ''; };
  const laden = $('#mapLoading');
  setMapMode(zeit(), 'Vorhersage wird geladen…', 'laden');
  if (laden) laden.hidden = false;

  return Forecast.load(lat, lon, zoom, ebenen, sicht)
    .then(() => {
      syncMapAt(currentScrubTime());
      Radar.updateLabels?.();
      /* Die Stunden, die der Abspielknopf durchläuft, still vorbereiten.

         Hier stand früher nur `x !== 'zahlen'`, beim Anzeigen aber auch
         `x !== 'wind'`. Die vorgewärmten Bilder lagen deshalb unter einem
         anderen Schlüssel als dem, unter dem sie gesucht wurden — bei
         eingeschalteten Windpfeilen war jedes vorbereitete Bild wertlos und
         der erste Durchlauf ruckelte, als gäbe es kein Vorwärmen. */
      const flaechen = new Set([...ebenen].filter(x => !SYMBOL_EBENEN.has(x)));
      const stunden = [];
      for (let k = 0; k <= 4; k++) {
        const h = Forecast.indexFor(Date.now() + k * 3600e3);
        if (h >= 0 && !stunden.includes(h)) stunden.push(h);
      }
      Radar.vorwaermen?.(stunden, flaechen);
    })
    .catch((e) => {
      /* Zeigt die Karte gerade den DWD-Nowcast, ist das Raster gar nicht
         gefragt — dann darf ein Fehler beim Rasterabruf auch nicht
         „für diese Region keine Daten" über ein einwandfreies Radarbild
         schreiben. Genau das stand bei Florian über der vollen Karte. */
      if (Radar.nowcastAktiv) return;
      setMapMode(zeit(), /429/.test(e?.message)
        ? 'Wetterdienst bremst — gleich nochmal versuchen'
        : 'für diese Region keine Daten', 'none');
    })
    .finally(() => { if (laden) laden.hidden = true; });
}

/** Beim Ein- oder Ausschalten einer Ebene fehlen unter Umständen die Werte. */
function ebenenGeaendert() {
  const m = Radar.map;
  if (!m) { syncMapAt(currentScrubTime()); return; }
  const mitte = m.getCenter(), zoom = m.getZoom();
  const ebenen = activeLayers();
  const sicht = sichtbarerBereich();
  if (Forecast.covers(mitte.lat, mitte.lng, zoom, ebenen, sicht)) {
    syncMapAt(currentScrubTime());
    return;
  }
  ladeRaster(mitte.lat, mitte.lng, zoom, ebenen, sicht);
}

// ══ Rendering: Modellvergleich ═════════════════════════════
/** Zeigt, wo sich die Rechenmodelle einig sind – und ab wann nicht mehr. */
/* ── Modellvergleich nach Wettercharakter ──────────────────
   Florians Einwand: Temperaturkurven übereinander sagen dem Laien wenig.
   Die eigentliche Frage ist, ob die Modelle denselben WETTERABLAUF sehen —
   sonnig, bedeckt oder Regen. Deshalb je Tag und Modell ein Zeichen, und
   daneben, ob sie sich einig sind. Die Temperaturkurve bleibt darunter
   als Detail: Ihre Spannweite zeigt, WANN die Rechnung unsicher wird.

   Grob gruppiert wird in freundlich / trüb / Regen. Ob 40 oder 60 % Wolken,
   ist Geschmackssache — ob nass oder trocken, ist die Entscheidung. */
function modellCharakter(H, mid, tagISO) {
  let regen = 0, hatRegen = false, spitze = 0;
  const wolken = [];
  const nasseStunden = [];
  for (let k = 0; k < H.time.length; k++) {
    if (!H.time[k].startsWith(tagISO)) continue;
    const p = H[`precipitation_${mid}`]?.[k];
    const stunde = +H.time[k].slice(11, 13);
    if (p != null) {
      regen += p; hatRegen = true;
      /* Die stärkste Stunde entscheidet über den Schirm, nicht die
         Tagessumme: 3 mm über acht Stunden sind Nieseln, 3 mm in einer
         Stunde sind ein Guss. */
      spitze = Math.max(spitze, p);
      if (p >= REGEN.nichts) nasseStunden.push(stunde);
    }
    const c = H[`cloud_cover_${mid}`]?.[k];
    if (c != null && stunde >= 8 && stunde <= 20) wolken.push(c);
  }
  if (!wolken.length && !hatRegen) return null;         // Modell reicht nicht so weit

  /* Wann das Modell den Regen sieht, ist die eigentlich nützliche Angabe:
     Zwei Modelle können beide „Regen" sagen und trotzdem verschiedene
     Tage meinen — eins vormittags, eins abends. Zusammenhängende Stunden
     werden zu Zeitfenstern zusammengefasst. */
  const fenster = [];
  for (const st of nasseStunden) {
    const letzte = fenster[fenster.length - 1];
    if (letzte && st === letzte.bis + 1) letzte.bis = st;
    else fenster.push({ von: st, bis: st });
  }
  const zeiten = fenster.slice(0, 3).map(f => f.von === f.bis
    ? `${String(f.von).padStart(2, '0')} Uhr`
    : `${String(f.von).padStart(2, '0')}–${String(f.bis + 1).padStart(2, '0')} Uhr`);

  const basis = { mm: regen, spitze, zeiten, stunden: nasseStunden };
  if (regen >= 1) return { ...basis, zeichen: '🌧', wort: 'Regen', grob: 'nass' };

  /* Widerspruch beseitigt: Das Zeichen kam allein aus der Bewölkung, die
     Zeitangabe darunter aus den Regenstunden. Dadurch stand unter einer
     Sonne „15–16" — Symbol trocken, Text nass. Sobald es nasse Stunden
     gibt, zeigt auch das Zeichen Niederschlag, nur eben in schwächerer
     Form. */
  if (nasseStunden.length) {
    return { ...basis, zeichen: '🌦', wort: 'kurze Schauer', grob: 'nass' };
  }

  const wm = wolken.length ? wolken.reduce((a, b) => a + b, 0) / wolken.length : null;
  if (wm == null) return null;
  if (wm < 25) return { ...basis, zeichen: '☀️', wort: 'sonnig', grob: 'freundlich' };
  if (wm < 55) return { ...basis, zeichen: '🌤', wort: 'heiter', grob: 'freundlich' };
  if (wm < 80) return { ...basis, zeichen: '⛅', wort: 'wolkig', grob: 'trüb' };
  return { ...basis, zeichen: '☁️', wort: 'bedeckt', grob: 'trüb' };
}

const GROB_WORT = { freundlich: 'freundlich', trüb: 'bedeckt', nass: 'Regen' };

/* Tageszeit-Fenster eines Modells in Worte: „vormittags", „ab 16 Uhr".
   Für die Planung zählt der Abschnitt, nicht die Minute. */
function zeitFensterWort(stunden) {
  if (!stunden.length) return '';
  const bloecke = [];
  for (const st of stunden) {
    const l = bloecke[bloecke.length - 1];
    if (l && st === l.bis + 1) l.bis = st; else bloecke.push({ von: st, bis: st });
  }
  const p2 = (n) => String(n).padStart(2, '0');
  return bloecke.slice(0, 2).map(b => `${p2(b.von)}–${p2(b.bis + 1)}`).join(', ')
       + (bloecke.length > 2 ? ' …' : '');
}

function renderModellTage(H) {
  const box = $('#modelTage');
  if (!box) return { streit: null };

  // Die nächsten fünf Kalendertage ab heute
  const heute = new Date(); heute.setHours(12, 0, 0, 0);
  const tage = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(heute); d.setDate(d.getDate() + i);
    return d;
  });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;

  let ersterStreit = null;

  const zeilen = tage.map((d, i) => {
    const urteile = MODELS.map(m => ({ m, c: modellCharakter(H, m.id, iso(d)) }));
    const mitDaten = urteile.filter(u => u.c);
    if (mitDaten.length < 2) return '';

    // Zählen, wie viele Modelle je Grobgruppe stimmen
    const gruppen = {};
    for (const u of mitDaten) gruppen[u.c.grob] = (gruppen[u.c.grob] || 0) + 1;
    const sortiert = Object.entries(gruppen).sort((a, b) => b[1] - a[1]);
    const einig = sortiert.length === 1;
    // Sobald ein Modell Regen sieht und ein anderes nicht, ist die
    // Tagesfrage strittig — egal ob das trockene Lager sonnig oder trüb sagt
    const nassStreit = 'nass' in gruppen && !einig;
    const ton = einig ? 'good' : nassStreit ? 'bad' : 'ok';
    if (nassStreit && ersterStreit === null && i <= 2) {
      ersterStreit = { tag: i === 0 ? 'heute' : i === 1 ? 'morgen' : weekday(d) };
    }

    const urteilText = einig
      ? `einig: ${GROB_WORT[sortiert[0][0]]}`
      : sortiert.map(([g, n]) => `${n}× ${GROB_WORT[g]}`).join(' · ');

    return `<div class="mt-zeile">
      <span class="mt-tag"><b>${i === 0 ? 'heute' : i === 1 ? 'morgen' : weekday(d)}</b>
        <i>${d.getDate()}.${d.getMonth() + 1}.</i></span>
      <span class="mt-modelle">${urteile.map(({ m, c }) => c
        ? `<button class="mt-chip" data-info="${esc(m.name)}|${c.wort}|${
             c.mm >= REGEN.nichts
               ? `${dez(c.mm)} mm, ${regenKlartext(c.spitze).kurz || 'kaum spürbar'}`
               : ''}|${c.zeiten.join(', ')}">
             <em>${c.zeichen}</em><i style="background:${m.color}"></i></button>`
        : `<button class="mt-chip mt-leer" data-info="${esc(m.name)}|reicht nicht so weit||">
             <em>·</em><i style="background:${m.color}"></i></button>`).join('')}
      </span>
      <span class="mt-urteil" data-tone="${ton}">${urteilText}</span>
    </div>`;
  }).join('');

  /* Zweite Ansicht: die Tabelle. Modelle als Zeilen, Tage als Spalten —
     so liest man waagerecht, was ein Modell über die Woche sagt, und
     senkrecht, wie einig sich alle über einen Tag sind. Unter jedem Zeichen
     steht das Zeitfenster: Für einen Biergarten ist „13–17 Uhr" eine ganz
     andere Auskunft als „ab 20 Uhr", auch wenn beide „Regen" heißen. */
  const kopf = tage.map((d, i) => `<th>${i === 0 ? 'heute' : i === 1 ? 'morgen' : weekday(d)}
    <i>${d.getDate()}.${d.getMonth() + 1}.</i></th>`).join('');

  /* Alle Fenster ausschreiben, nicht nur zwei mit „…". Wer einen Biergarten
     hat, muss jeden Zeitraum kennen, in dem irgendein Modell Regen sieht —
     ein abgeschnittenes Kürzel hilft dabei nicht. Für die Zelle bleiben zwei
     Zeilen, alles Weitere kommt beim Antippen. */
  const alleFenster = (stunden) => {
    const bl = [];
    for (const st of stunden) {
      const l = bl[bl.length - 1];
      if (l && st === l.bis + 1) l.bis = st; else bl.push({ von: st, bis: st });
    }
    const p2 = (n) => String(n).padStart(2, '0');
    return bl.map(b => `${p2(b.von)}–${p2(b.bis + 1)}`);
  };

  const koerper = MODELS.map(m => {
    const zellen = tage.map((d, i) => {
      const c = modellCharakter(H, m.id, iso(d));
      /* Der Bindestrich im dritten Feld heißt „dieses Modell reicht nicht so
         weit". Ohne die Unterscheidung stand darunter „reicht nicht so weit
         voraus, kein Niederschlag gerechnet" — beides zugleich. */
      if (!c) return `<td class="mtb-leer" data-info="${esc(m.name)}|${
        i === 0 ? 'heute' : i === 1 ? 'morgen' : weekday(d)}|-|reicht nicht so weit voraus">·</td>`;
      const fenster = alleFenster(c.stunden);
      const nass = fenster.length > 0;
      const tagWort = i === 0 ? 'heute' : i === 1 ? 'morgen' : weekday(d);
      /* Auch trockene Zellen antippbar: Wer auf ein Feld tippt, erwartet
         eine Antwort — „nichts passiert" ist eine Antwort. */
      /* Nicht nur die Menge, sondern was sie bedeutet: „0,4 mm" sagt einem
         Laien nichts, „kleiner Schirm genügt" beantwortet die Frage. */
      const k = regenKlartext(c.spitze);
      const info = nass
        ? `${esc(m.name)}|${tagWort}|${fenster.join(', ')}|${dez(c.mm)} mm — ${k.wort}, ${k.rat || 'kaum spürbar'}`
        : `${esc(m.name)}|${tagWort}||${c.wort}`;
      return `<td class="${nass ? 'mtb-nass' : ''}${nass && fenster.length > 2 ? ' mtb-mehr' : ''}"
        data-info="${info}">
        <em>${c.zeichen}</em>
        ${nass ? `<i>${fenster.slice(0, 2).join('<br>')}${
          fenster.length > 2 ? `<u>+${fenster.length - 2}</u>` : ''}</i>`
          : `<i class="mtb-tr">trocken</i>`}
      </td>`;
    }).join('');
    return `<tr><th scope="row"><span class="mtb-punkt" style="background:${m.color}"></span>
      ${esc(m.name)}</th>${zellen}</tr>`;
  }).join('');

  box.innerHTML = `
    <div class="mt-umschalter" role="tablist">
      <button class="mt-tab is-an" data-ansicht="tabelle">Alle Modelle</button>
      <button class="mt-tab" data-ansicht="uebersicht">Überblick</button>
    </div>
    <div class="mt-uebersicht" hidden>${zeilen}</div>
    <div class="mt-tabelle">
      <table class="mtb">
        <thead><tr><th class="mtb-ecke">Modell</th>${kopf}</tr></thead>
        <tbody>${koerper}</tbody>
      </table>
      <p class="mtb-hinweis">Waagerecht lesen: Was sagt ein Modell über die Woche?
        Senkrecht: Wie einig sind sich alle über einen Tag? Die Zeit darunter ist
        das Fenster, in dem dieses Modell Niederschlag rechnet.</p>
    </div>`;

  // Antippen erklärt, was das Zeichen bedeutet — auf dem Telefon gibt es
  // kein Überfahren mit der Maus, `title` blieb dort unsichtbar.
  $$('.mt-chip', box).forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const [name, wort, mm, zeiten] = (b.dataset.info || '').split('|');
    toast(`${name}: ${wort}${mm ? ` · ${mm}` : ''}${
      zeiten ? ` · nass ${zeiten}` : ''}`, 5000);
  }));

  // Zelle antippen: alle Regenfenster dieses Modells für diesen Tag
  $$('.mtb td[data-info]', box).forEach(td => {
    td.style.cursor = 'pointer';
    td.addEventListener('click', (e) => {
      e.stopPropagation();
      const [name, tag, fenster, rest] = (td.dataset.info || '').split('|');
      toast(fenster === '-' ? `${name}, ${tag}: ${rest}`
          : fenster ? `${name}, ${tag}: Regen ${fenster} Uhr · ${rest}`
          : `${name}, ${tag}: ${rest}, kein Niederschlag gerechnet`, 6000);
    });
  });

  $$('.mt-tab', box).forEach(t => t.addEventListener('click', (e) => {
    e.stopPropagation();
    const tab = t.dataset.ansicht;
    $$('.mt-tab', box).forEach(x => x.classList.toggle('is-an', x === t));
    box.querySelector('.mt-uebersicht').hidden = tab !== 'uebersicht';
    box.querySelector('.mt-tabelle').hidden = tab !== 'tabelle';
    store.set('wf.modellAnsicht', tab);
  }));
  const gemerkt = store.get('wf.modellAnsicht', 'tabelle');
  if (gemerkt === 'uebersicht') box.querySelector('[data-ansicht="uebersicht"]')?.click();

  return { streit: ersterStreit };
}

function renderModels(md) {
  const chart = $('#modelChart'), legend = $('#modelLegend');
  if (!md?.hourly) { chart.innerHTML = '<p class="empty">Modelldaten nicht verfügbar.</p>'; return; }

  const H = md.hourly, i0 = nowIndex(H.time);
  const { streit } = renderModellTage(H);
  const N = Math.min(120, H.time.length - i0);                 // 5 Tage
  const series = MODELS.map(m => ({
    ...m,
    vals: Array.from({ length: N }, (_, k) => H[`temperature_2m_${m.id}`]?.[i0 + k] ?? null)
  })).filter(s => s.vals.some(v => v !== null));

  if (!series.length) { chart.innerHTML = '<p class="empty">Modelldaten nicht verfügbar.</p>'; return; }

  const flat = series.flatMap(s => s.vals).filter(v => v !== null);
  const lo = Math.floor(Math.min(...flat) - 1), hi = Math.ceil(Math.max(...flat) + 1);
  const span = Math.max(1, hi - lo);
  const W = 660, Hh = 170, PAD = { l: 26, r: 8, t: 10, b: 20 };
  const px = (k) => PAD.l + (k / (N - 1)) * (W - PAD.l - PAD.r);
  const py = (v) => PAD.t + (1 - (v - lo) / span) * (Hh - PAD.t - PAD.b);

  // Streuung je Stunde → wo wird es unsicher?
  const spread = Array.from({ length: N }, (_, k) => {
    const v = series.map(s => s.vals[k]).filter(x => x !== null);
    return v.length > 1 ? Math.max(...v) - Math.min(...v) : 0;
  });

  const band = spread.map((_, k) => {
    const v = series.map(s => s.vals[k]).filter(x => x !== null);
    return v.length ? { k, hi: Math.max(...v), lo: Math.min(...v) } : null;
  }).filter(Boolean);

  const bandPath =
    'M' + band.map(b => `${px(b.k).toFixed(1)} ${py(b.hi).toFixed(1)}`).join(' L') +
    ' L' + [...band].reverse().map(b => `${px(b.k).toFixed(1)} ${py(b.lo).toFixed(1)}`).join(' L') + ' Z';

  const line = (s) => {
    let dd = '', pen = false;
    s.vals.forEach((v, k) => {
      if (v === null) { pen = false; return; }
      dd += `${pen ? 'L' : 'M'}${px(k).toFixed(1)} ${py(v).toFixed(1)} `;
      pen = true;
    });
    return `<path class="ml" d="${dd}" stroke="${s.color}"/>`;
  };

  // Tagesraster
  const t0 = new Date(H.time[i0]);
  const ticks = [];
  for (let k = 0; k < N; k++) {
    const t = new Date(H.time[i0 + k]);
    if (t.getHours() === 0 || k === 0) ticks.push({ k, label: k === 0 ? 'heute' : weekday(t) });
  }

  const yTicks = [lo, Math.round((lo + hi) / 2), hi];

  chart.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" class="mchart" preserveAspectRatio="none">
    ${yTicks.map(v => `<line class="grid" x1="${PAD.l}" y1="${py(v).toFixed(1)}" x2="${W - PAD.r}" y2="${py(v).toFixed(1)}"/>
       <text class="ytick" x="2" y="${(py(v) + 3.5).toFixed(1)}">${v}°</text>`).join('')}
    ${ticks.map(t => `<line class="vgrid" x1="${px(t.k).toFixed(1)}" y1="${PAD.t}" x2="${px(t.k).toFixed(1)}" y2="${Hh - PAD.b}"/>
       <text class="xtick" x="${(px(t.k) + 3).toFixed(1)}" y="${Hh - 6}">${t.label}</text>`).join('')}
    <path class="mband" d="${bandPath}"/>
    ${series.map(line).join('')}
  </svg>`;

  legend.innerHTML = series.map(s =>
    `<span class="mleg"><i style="background:${s.color}"></i><b>${s.name}</b><em>${s.note}</em></span>`
  ).join('');

  wireChartReadout(chart, series, H, i0, N, px);

  // Bewertung: mittlere Streuung heute vs. ab Tag 3
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const near = avg(spread.slice(0, 24));
  const far = avg(spread.slice(48, N));
  const firstBad = spread.findIndex((v, k) => k > 12 && v > 3.5);

  let verdict, tone;
  if (near < 1.2) { verdict = 'Modelle sind sich einig'; tone = 'good'; }
  else if (near < 2.5) { verdict = 'weitgehend einig'; tone = 'ok'; }
  else { verdict = 'uneinig — Prognose unsicher'; tone = 'bad'; }

  /* Streit über Regen schlägt Streit über Zehntelgrade: Ob es nass wird,
     entscheidet den Tag — das gehört in die Überschrift. */
  if (streit) { verdict = `uneinig, ob es ${streit.tag} regnet`; tone = 'bad'; }

  modelAgreeText = verdict;
  if ($('#modelBody')?.hidden === false) $('#modelAgree').textContent = verdict;
  $('#modelAgree').dataset.tone = tone;

  // Verlässlichkeit in Klartext, direkt unter der Tagesreihe
  const sicher = $('#confidence');
  if (sicher) {
    const tage = firstBad > 0 ? Math.max(1, Math.round(firstBad / 24)) : 5;
    const stufe = near < 1.2 ? 'hoch' : near < 2.5 ? 'mittel' : 'gering';
    sicher.dataset.level = stufe === 'hoch' ? 'good' : stufe === 'mittel' ? 'ok' : 'bad';
    sicher.innerHTML =
      `<b>Verlässlichkeit ${stufe}.</b> ` +
      (stufe === 'hoch'
        ? `Die Rechenmodelle sind sich für die kommenden Tage weitgehend einig — was hier steht, tritt mit hoher Wahrscheinlichkeit so ein.`
        : stufe === 'mittel'
        ? `Für die nächsten ein bis zwei Tage ist die Vorhersage belastbar, danach gehen die Modelle auseinander. Details können sich noch verschieben.`
        : `Die Modelle rechnen deutlich unterschiedlich. Nimm vor allem die nächsten Stunden ernst, alles Weitere kann sich noch ändern.`) +
      (firstBad > 0 ? ` Ab etwa ${tage} Tag${tage > 1 ? 'en' : ''} wird es unsicher.` : '');
  }

  const when = firstBad > 0 ? new Date(H.time[i0 + firstBad]) : null;
  /* Oben steht die Frage nach dem Wettercharakter, unten das Temperatur-
     Detail — jeder Text zu seinem Teil, nicht der zweite über dem ersten. */
  $('#modelNote').innerHTML =
    'Vier Rechenmodelle, ein Tag — sehen sie denselben Wetterablauf? '
    + 'Wo sie sich widersprechen, ist die Vorhersage mit Vorsicht zu genießen. '
    + 'Antippen der Zeichen zeigt Modell und Regenmenge.';
  const hinweis = $('.mt-hinweis');
  if (hinweis) hinweis.innerHTML =
    `Temperaturverlauf im Vergleich. Das farbige Band zeigt die Spannweite — je schmaler, desto verlässlicher. ` +
    (when
      ? `Ab <b>${weekday(when)}</b> laufen die Modelle deutlich auseinander (bis ${Math.round(Math.max(...spread))} °C Unterschied).`
      : `Über den ganzen Zeitraum bleiben sie dicht beieinander (max. ${Math.round(Math.max(...spread))} °C Unterschied).`) +
    ` Ø Abweichung heute ${near.toFixed(1)} °C, in 3–5 Tagen ${far.toFixed(1)} °C.`;
}

/** Am Diagramm entlangfahren: zeigt für die berührte Stunde alle Modellwerte. */
function wireChartReadout(chart, series, H, i0, N, px) {
  const svg = chart.querySelector('svg');
  if (!svg) return;

  let box = chart.querySelector('.mread');
  if (!box) {
    box = document.createElement('div');
    box.className = 'mread';
    chart.appendChild(box);
  }
  let linie = svg.querySelector('.mcursor');
  if (!linie) {
    linie = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    linie.setAttribute('class', 'mcursor');
    linie.setAttribute('y1', '10'); linie.setAttribute('y2', '150');
    svg.appendChild(linie);
  }

  const zeigen = (clientX) => {
    const r = svg.getBoundingClientRect();
    const anteil = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    // Auf den Zeichenbereich abbilden (links und rechts ist Rand)
    const k = Math.round(anteil * (N - 1));
    const t = new Date(H.time[i0 + k]);

    linie.setAttribute('x1', px(k).toFixed(1));
    linie.setAttribute('x2', px(k).toFixed(1));
    linie.style.opacity = '1';

    const werte = series
      .map(s => ({ name: s.name, color: s.color, v: s.vals[k] }))
      .filter(s => s.v !== null && s.v !== undefined);
    if (!werte.length) return;

    const spanne = Math.max(...werte.map(w => w.v)) - Math.min(...werte.map(w => w.v));
    box.innerHTML = `
      <span class="mr-time">${weekday(t)}, ${hhmm(t)} Uhr</span>
      <span class="mr-vals">${werte.map(w =>
        `<span><i style="background:${w.color}"></i>${w.v.toFixed(1)}°</span>`).join('')}</span>
      <span class="mr-spread">${spanne < 1 ? 'einig' : `${spanne.toFixed(1)}° auseinander`}</span>`;
    box.classList.add('on');
  };

  const verstecken = () => { box.classList.remove('on'); linie.style.opacity = '0'; };

  chart.onpointermove = (e) => zeigen(e.clientX);
  chart.onpointerdown = (e) => { chart.setPointerCapture?.(e.pointerId); zeigen(e.clientX); };
  chart.onpointerleave = verstecken;
  chart.onpointercancel = verstecken;
  chart.style.touchAction = 'pan-y';
}

// ══ Rendering: Detail-Kacheln ══════════════════════════════
// ══ Sonnenstand ════════════════════════════════════════════
/** Sonnenhöhe für einen Zeitpunkt (NOAA-Näherung, genügt auf Minuten genau).
    Damit lassen sich goldene und blaue Stunde sowie die Dämmerungen bestimmen. */
function sunAltitude(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;          // Tage seit J2000
  const g = (357.529 + 0.98560028 * d) * rad;                      // mittlere Anomalie
  const q = (280.459 + 0.98564736 * d) * rad;                      // mittlere Länge
  const L = q + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = ((gmst * 15 + lon) % 360) * rad;
  const H = lst - ra;
  const la = lat * rad;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)) / rad;
}

/** Zeitpunkte suchen, an denen die Sonne eine bestimmte Höhe durchläuft. */
function sunEvents(day, lat, lon) {
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const marken = [
    { key: 'astroDaemmerung', h: -18, auf: true },
    { key: 'blaueStundeMorgen', h: -6, auf: true },
    { key: 'aufgang', h: -0.833, auf: true },
    { key: 'goldenEndeMorgen', h: 6, auf: true },
    { key: 'goldenStartAbend', h: 6, auf: false },
    { key: 'untergang', h: -0.833, auf: false },
    { key: 'blaueStundeEndeAbend', h: -6, auf: false },
    { key: 'astroNacht', h: -18, auf: false }
  ];
  const out = {};
  let vorher = sunAltitude(new Date(start.getTime()), lat, lon);
  for (let m = 1; m <= 1440; m++) {
    const t = new Date(start.getTime() + m * 60000);
    const jetzt = sunAltitude(t, lat, lon);
    for (const mk of marken) {
      if (out[mk.key]) continue;
      const kreuzt = mk.auf ? (vorher < mk.h && jetzt >= mk.h) : (vorher > mk.h && jetzt <= mk.h);
      if (kreuzt) out[mk.key] = t;
    }
    vorher = jetzt;
  }
  return out;
}

// ══ Mond ═══════════════════════════════════════════════════
const MOON_NAMES = ['Neumond', 'Zunehmende Sichel', 'Erstes Viertel', 'Zunehmender Mond',
                    'Vollmond', 'Abnehmender Mond', 'Letztes Viertel', 'Abnehmende Sichel'];

/** Mondphase: Anteil 0…1 im Zyklus, Beleuchtung und Name. */
function moonPhase(date = new Date()) {
  const synodisch = 29.530588853;
  const bekannterNeumond = Date.UTC(2000, 0, 6, 18, 14);        // 6.1.2000, 18:14 UT
  const tage = (date.getTime() - bekannterNeumond) / 86400000;
  let anteil = (tage % synodisch) / synodisch;
  if (anteil < 0) anteil += 1;
  const beleuchtet = (1 - Math.cos(2 * Math.PI * anteil)) / 2;
  const name = MOON_NAMES[Math.floor(anteil * 8 + 0.5) % 8];
  return { anteil, beleuchtet, name, alter: anteil * synodisch };
}

/* Mondphasen nach Meeus (Astronomical Algorithms, Kap. 49).
   Die einfache Rechnung mit fester Umlaufdauer liegt je nach Monat über eine
   Stunde daneben — der Mond läuft auf einer Ellipse und wird von der Sonne
   gestört. Mit den Korrekturgliedern stimmt es auf gut eine Minute. */
const gr = (x) => x * Math.PI / 180;

/** Julianisches Datum → Zeitstempel. */
const ausJD = (jd) => new Date((jd - 2440587.5) * 86400000);

/** k zählt die Lunationen ab dem Neumond vom 6. Januar 2000. */
function phaseZeit(k, art) {
  // art: 0 = Neumond, 0.25 = erstes Viertel, 0.5 = Vollmond, 0.75 = letztes Viertel
  k += art;
  const T = k / 1236.85, T2 = T * T, T3 = T2 * T, T4 = T3 * T;

  let jde = 2451550.09766 + 29.530588861 * k
          + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;

  const E  = 1 - 0.002516 * T - 0.0000074 * T2;
  const M  = gr(2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3);
  const Ms = gr(201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4);
  const F  = gr(160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4);
  const O  = gr(124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3);
  const s = Math.sin, c = Math.cos;

  const teilN = (a) =>                         // Neumond und Vollmond, nur erster Term abweichend
      a * s(Ms)
    + 0.17241 * E * s(M)
    + 0.01608 * s(2 * Ms)
    + 0.01039 * s(2 * F)
    + 0.00739 * E * s(Ms - M)
    - 0.00514 * E * s(Ms + M)
    + 0.00208 * E * E * s(2 * M)
    - 0.00111 * s(Ms - 2 * F)
    - 0.00057 * s(Ms + 2 * F)
    + 0.00056 * E * s(2 * Ms + M)
    - 0.00042 * s(3 * Ms)
    + 0.00042 * E * s(M + 2 * F)
    + 0.00038 * E * s(M - 2 * F)
    - 0.00024 * E * s(2 * Ms - M)
    - 0.00017 * s(O)
    - 0.00007 * s(Ms + 2 * M)
    + 0.00004 * s(2 * Ms - 2 * F)
    + 0.00004 * s(3 * M)
    + 0.00003 * s(Ms + M - 2 * F)
    + 0.00003 * s(2 * Ms + 2 * F)
    - 0.00003 * s(Ms + M + 2 * F)
    + 0.00003 * s(Ms - M + 2 * F)
    - 0.00002 * s(Ms - M - 2 * F)
    - 0.00002 * s(3 * Ms + M)
    + 0.00002 * s(4 * Ms);

  if (art === 0)        jde += teilN(-0.40720);
  else if (art === 0.5) jde += teilN(-0.40614);
  else {
    jde += -0.62801 * s(Ms)
        + 0.17172 * E * s(M)
        - 0.01183 * E * s(Ms + M)
        + 0.00862 * s(2 * Ms)
        + 0.00804 * s(2 * F)
        + 0.00454 * E * s(Ms - M)
        + 0.00204 * E * E * s(2 * M)
        - 0.00180 * s(Ms - 2 * F)
        - 0.00070 * s(Ms + 2 * F)
        - 0.00040 * s(3 * Ms)
        - 0.00034 * E * s(2 * Ms - M)
        + 0.00032 * E * s(M + 2 * F)
        + 0.00032 * E * s(M - 2 * F)
        - 0.00028 * E * E * s(Ms + 2 * M)
        + 0.00027 * E * s(2 * Ms + M)
        - 0.00017 * s(O);
    const W = 0.00306 - 0.00038 * E * c(M) + 0.00026 * c(Ms)
            - 0.00002 * c(Ms - M) + 0.00002 * c(Ms + M) + 0.00002 * c(2 * F);
    jde += (art === 0.25 ? W : -W);
  }
  return ausJD(jde);
}

/** Nächster Zeitpunkt dieser Phase ab jetzt. */
function naechstePhase(art, ab = new Date()) {
  // Lunation grob schätzen, dann ein paar Schritte vor und zurück prüfen
  const jahre = (ab.getTime() - Date.UTC(2000, 0, 6)) / (365.25 * 86400000);
  const k0 = Math.floor(jahre * 12.3685) - 2;
  for (let k = k0; k < k0 + 5; k++) {
    const t = phaseZeit(k, art);
    if (t.getTime() > ab.getTime()) return t;
  }
  return phaseZeit(k0 + 5, art);
}

const PHASEN = [
  { art: 0,    name: 'Neumond',         zeichen: '🌑' },
  { art: 0.25, name: 'Erstes Viertel',  zeichen: '🌓' },
  { art: 0.5,  name: 'Vollmond',        zeichen: '🌕' },
  { art: 0.75, name: 'Letztes Viertel', zeichen: '🌗' }
];

/** Alle vier Phasen nach Termin sortiert. */
const kommendePhasen = (ab = new Date()) =>
  PHASEN.map(p => ({ ...p, t: naechstePhase(p.art, ab) })).sort((a, b) => a.t - b.t);

/** Kurzer Hinweis für die Kachel: welche Phase steht als Nächstes an? */
function naechsteMondMarke() {
  const n = kommendePhasen()[0];
  const stunden = (n.t - Date.now()) / 36e5;
  const wann = stunden < 24
    ? `heute ${hhmm(n.t)} Uhr`
    : stunden < 48 ? `morgen ${hhmm(n.t)} Uhr`
    : `${weekday(n.t)} ${hhmm(n.t)} Uhr`;
  return `${n.zeichen} ${n.name} ${wann}`;
}

/** Entfernung des Mondes in km — schwankt zwischen rund 356.000 und 407.000.
    Nah heißt größer und heller am Himmel ("Supermond"). */
function moonDistance(date = new Date()) {
  const rad = Math.PI / 180;
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const M = (134.963 + 13.064993 * d) * rad;          // mittlere Anomalie
  const D = (297.850 + 12.190749 * d) * rad;          // Elongation
  return 385000.56 - 20905 * Math.cos(M) - 3699 * Math.cos(2 * D - M) - 2956 * Math.cos(2 * D);
}

/** Mondposition (Näherung) — genügt für Auf- und Untergang auf wenige Minuten. */
/** Höhe UND Himmelsrichtung des Mondes. Für die Bahn im Kamerabild reicht
    die Höhe nicht — man muss auch wissen, wo am Horizont er steht.

    Die Bahn des Mondes ist deutlich unruhiger als die der Sonne, weil die
    Erde an ihr zieht. Die drei größten Störungen sind dabei: Evektion
    (1,27°), Variation (0,66°) und die jährliche Gleichung (0,19°). Ohne sie
    läge der Mond bis zu zwei Grad daneben — mit ihnen unter einem Zehntel
    Grad, und das ist weit genauer als jeder Handykompass. */
function moonHorizont(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const L = 218.316 + 13.176396 * d;              // mittlere Länge
  const M = (134.963 + 13.064993 * d) * rad;      // mittlere Anomalie Mond
  const Ms = (357.529 + 0.98560028 * d) * rad;    // mittlere Anomalie Sonne
  const D = (297.850 + 12.190749 * d) * rad;      // Abstand zur Sonne
  const F = (93.272 + 13.229350 * d) * rad;       // Argument der Breite

  const lam = (L
    + 6.289 * Math.sin(M)
    + 1.274 * Math.sin(2 * D - M)                 // Evektion
    + 0.658 * Math.sin(2 * D)                     // Variation
    - 0.186 * Math.sin(Ms)                        // jährliche Gleichung
    - 0.059 * Math.sin(2 * M - 2 * D)
    - 0.057 * Math.sin(M - 2 * D + Ms)
    + 0.053 * Math.sin(M + 2 * D)
    + 0.046 * Math.sin(2 * D - Ms)
    + 0.041 * Math.sin(M - Ms)
    - 0.035 * Math.sin(D)
    - 0.031 * Math.sin(M + Ms)) * rad;

  const bet = (5.128 * Math.sin(F)
    + 0.281 * Math.sin(M + F)
    - 0.278 * Math.sin(F - M)
    - 0.173 * Math.sin(F - 2 * D)) * rad;

  const e = 23.4397 * rad;
  const dec = Math.asin(Math.sin(bet) * Math.cos(e) + Math.cos(bet) * Math.sin(e) * Math.sin(lam));
  const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(bet) * Math.sin(e), Math.cos(lam));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) % 360) * rad - ra;
  const la = lat * rad;
  const hoehe = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)) / rad;
  const azimut = (Math.atan2(Math.sin(H),
    Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) / rad + 180) % 360;
  return { hoehe, azimut };
}

function moonAltitude(date, lat, lon) {
  return moonHorizont(date, lat, lon).hoehe;
}

/** Auf- und Untergang des Mondes für den laufenden Tag. */
function moonTimes(day, lat, lon) {
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  let auf = null, unter = null;
  let vorher = moonAltitude(new Date(start.getTime()), lat, lon);
  for (let m = 5; m <= 1440; m += 5) {
    const t = new Date(start.getTime() + m * 60000);
    const jetzt = moonAltitude(t, lat, lon);
    if (!auf && vorher < 0 && jetzt >= 0) auf = t;
    if (!unter && vorher > 0 && jetzt <= 0) unter = t;
    vorher = jetzt;
  }
  return { auf, unter };
}

const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirName = (deg) => DIRS[Math.round(deg / 22.5) % 16];

const UV_LEVELS = [[3, 'niedrig', 'good'], [6, 'mäßig', 'ok'], [8, 'hoch', 'warn'], [11, 'sehr hoch', 'bad'], [99, 'extrem', 'bad']];
const AQI_LEVELS = [[20, 'sehr gut', 'good'], [40, 'gut', 'good'], [60, 'mäßig', 'ok'], [80, 'schlecht', 'warn'], [100, 'sehr schlecht', 'bad'], [999, 'extrem schlecht', 'bad']];
const POLLEN_LEVELS = [[1, 'keine', 'good'], [10, 'gering', 'good'], [30, 'mäßig', 'ok'], [80, 'hoch', 'warn'], [9999, 'sehr hoch', 'bad']];

const levelOf = (table, v) => table.find(([max]) => v < max) || table[table.length - 1];

/** Sonnenbogen: flache Halbellipse, damit sie in die Zeichenfläche (200×74) passt.
    Umfang nach Ramanujan, halbiert – wird für die Fortschrittslinie gebraucht. */
const ARC = (() => {
  const rx = 90, ry = 50, y = 66, x0 = 10, x1 = 190, cx = 100;
  const half = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))) / 2;
  return { rx, ry, y, x0, x1, cx, len: half };
})();

/** Erklärungen in Alltagssprache — jede Kachel lässt sich antippen.
    Wo es eine gute weiterführende Seite gibt, ist sie verlinkt. */
const EXPLAIN = {
  uv: { titel: 'UV-Index',
    text: 'Misst, wie stark die Sonnenstrahlung auf der Haut wirkt. Bis 2 ist unbedenklich, '
        + 'ab 3 sollte man an Sonnenschutz denken, ab 6 sind Schatten und Kopfbedeckung ratsam, '
        + 'ab 8 wird ungeschützte Haut in kurzer Zeit rot. Der Wert steigt mit der Sonnenhöhe — '
        + 'mittags ist er am höchsten, auch wenn es sich nicht am heißesten anfühlt.',
    link: { url: 'https://www.bfs.de/DE/themen/opt/uv/uv-index/uv-index_node.html',
            text: 'Bundesamt für Strahlenschutz' } },
  luft: { titel: 'Luftqualität',
    text: 'Der europäische Luftqualitätsindex fasst Feinstaub, Stickstoffdioxid und Ozon zu '
        + 'einer Zahl zusammen. Unter 20 ist die Luft sehr gut, bis 40 gut, bis 60 mittelmäßig. '
        + 'Ab 80 sollten empfindliche Menschen längere Anstrengung im Freien meiden, ab 100 gilt '
        + 'das für alle. Kleinere Zahlen sind also besser.',
    link: { url: 'https://www.umweltbundesamt.de/daten/luft/luftdaten', text: 'Umweltbundesamt' } },
  pollen: { titel: 'Pollen',
    text: 'Angegeben ist die Zahl der Pollenkörner je Kubikmeter Luft. Unter 10 merken das nur '
        + 'sehr empfindliche Menschen, ab 30 reagieren die meisten Allergiker, ab 80 wird es für '
        + 'Betroffene deutlich unangenehm. Nach Regen sinkt die Belastung, an warmen, windigen '
        + 'Tagen steigt sie.',
    link: { url: 'https://www.dwd.de/DE/leistungen/gefahrenindizespollen/gefahrenindexpollen.html',
            text: 'Pollenflug-Vorhersage des DWD' } },
  wind: { titel: 'Wind und Böen',
    text: 'Die erste Zahl ist der Durchschnittswind, die zweite die stärkste zu erwartende Bö. '
        + 'Ab etwa 40 km/h in Böen rauscht es hörbar in den Bäumen, ab 60 km/h wird Radfahren '
        + 'unangenehm, ab 80 km/h können Äste brechen. Die Richtung sagt, woher der Wind kommt.',
    link: { url: 'https://www.dwd.de/DE/service/lexikon/lexikon_node.html', text: 'Wetterlexikon des DWD' } },
  druck: { titel: 'Luftdruck',
    text: 'Der Normalwert auf Meereshöhe liegt bei 1013 hPa. Steigender Druck bedeutet meist '
        + 'ruhigeres, freundlicheres Wetter, fallender Druck kündigt oft Wolken, Wind und Regen an. '
        + 'Wichtiger als der Wert selbst ist also seine Richtung.' },
  feuchte: { titel: 'Luftfeuchte und Taupunkt',
    text: 'Die Luftfeuchte sagt, wie voll die Luft mit Wasserdampf ist. Der Taupunkt ist die '
        + 'Temperatur, bei der sich dieser Dampf niederschlägt — als Nebel, Tau oder beschlagene '
        + 'Scheiben. Über 16 °C Taupunkt empfinden die meisten die Luft als schwül, über 20 °C als drückend.' },
  sicht: { titel: 'Sichtweite',
    text: 'Wie weit man bei klarer Luft sehen kann. Über 10 km ist gute Fernsicht. '
        + 'Unter 1 km spricht man von Nebel, unter 150 m wird es für den Verkehr gefährlich.' },
  wolken: { titel: 'Bewölkung',
    text: 'Anteil des Himmels, der von Wolken bedeckt ist. Bis 20 % nennt man das wolkenlos, '
        + 'bis 50 % heiter, bis 80 % bewölkt, darüber bedeckt. Für Sternenbeobachtung sollte '
        + 'der Wert unter 30 % liegen.' },
  sonne: { titel: 'Sonnenverlauf',
    text: 'Zwei Ansichten desselben Tages, zum Umschalten oder Wischen. Die Ringuhr läuft '
        + 'einmal in 24 Stunden um, Mitternacht unten, Mittag oben: Der äußere Ring färbt '
        + 'Nacht, Dämmerung und Tag, der innere zeigt, wann der Mond über dem Horizont steht. '
        + 'Die Sonnenbahn zeigt dasselbe von der Seite — waagerecht die Himmelsrichtung, '
        + 'senkrecht der Winkel über dem Horizont. Fährt man mit dem Finger darüber, stehen '
        + 'zu jeder Stelle Uhrzeit, Winkel, Richtung und Schattenlänge. '
        + 'Die Sonnenscheindauer ist die Zeit ohne verdeckende Wolken — sie ist meist kürzer '
        + 'als die Tageslänge.' },
  licht: { titel: 'Goldene und blaue Stunde',
    text: 'Die goldene Stunde ist die Zeit kurz nach Sonnenaufgang und kurz vor Sonnenuntergang, '
        + 'wenn das Licht flach einfällt und warm-golden wirkt — die beliebteste Zeit zum '
        + 'Fotografieren. Die blaue Stunde folgt danach: Die Sonne ist schon unter dem Horizont, '
        + 'der Himmel leuchtet aber noch tiefblau. Danach beginnt die Dämmerung, ab 18 Grad '
        + 'Sonnentiefe die astronomische Nacht — erst dann sind lichtschwache Sterne sichtbar.' },
  versatz: { titel: 'Ortskorrektur',
    text: 'Das Rechenmodell arbeitet mit einem Gitter über Deutschland. Die Masche, in der '
        + 'dein Ort liegt, hat eine andere Höhe und Umgebung als der Ort selbst — deshalb '
        + 'liegt die Vorhersage hier meist in dieselbe Richtung daneben.\n\n'
        + 'Die App misst diesen Versatz aus den letzten 25 Tagen: Was war jeweils für den '
        + 'Folgetag angesagt, was hat die nächste DWD-Station wirklich gemessen? Der '
        + 'Unterschied wird nach Tageszeit getrennt berechnet — morgens rechnet das Modell '
        + 'oft richtig, während es abends deutlich zu warm liegt. Ein einziger Wert für den '
        + 'ganzen Tag würde die Morgenstunden verschlechtern.\n\n'
        + 'Nachgeprüft mit mitlaufender Auswertung ergibt das rund 20 Prozent weniger Fehler; '
        + 'abends über ein Drittel. Der Deutsche Wetterdienst korrigiert seine eigenen '
        + 'Vorhersagen nach demselben Prinzip.\n\n'
        + 'Die Korrektur gilt nur für die Temperatur. Regen, Wind und Bewölkung bleiben, '
        + 'wie das Modell sie rechnet. Außerhalb Deutschlands oder ohne Station in der Nähe '
        + 'wird nicht korrigiert.' },
  messung: { titel: 'Gerechnet oder gemessen?',
    text: 'Die große Zahl oben ist ein Modellwert: Der Wetterdienst rechnet ein Gitter '
        + 'über Deutschland — beim Modell ICON-D2 mit 2 km Maschenweite — und liest den Wert '
        + 'für deinen Punkt ab. Ein Thermometer steht dort nicht. In der Stadt, im Talkessel '
        + 'oder auf einer Höhe kann das ein bis zwei Grad danebenliegen.\n\n'
        + 'Darunter steht, was die nächste echte Wetterstation des DWD zuletzt gemessen hat, '
        + 'mit Entfernung und Uhrzeit. Die Messung ist die härtere Zahl — sie gilt aber für '
        + 'den Ort der Station, nicht für deinen. Liegen die beiden weit auseinander, sagt '
        + 'das meist etwas über den Höhenunterschied oder die Lage.',
    link: { url: 'https://www.dwd.de/DE/forschung/wettervorhersage/num_modellierung/'
               + '01_num_vorhersagemodelle/icon_beschreibung.html',
            text: 'Wie das Modell ICON rechnet (DWD)' } },
  regenlage: { titel: 'Die Regenzeile',
    text: 'Diese Zeile beantwortet die häufigste Frage zuerst: Werde ich nass?\n\n'
        + 'Regnet es gerade, steht dort, wie lange noch — und die Leiste darunter zeigt die '
        + 'nächsten Viertelstunden. Hohe Balken heißen kräftiger Regen, flache Nieseln, '
        + 'die dunklen sind trocken.\n\n'
        + 'Regnet es nicht, sucht die App zuerst in den Viertelstundenwerten der nächsten '
        + 'zwei Stunden. Findet sie dort nichts, geht sie die kommenden 24 Stunden durch und '
        + 'nennt die erste Stunde mit nennenswertem Regen.\n\n'
        + 'Die Viertelstundenwerte stammen aus dem Kurzfristmodell des DWD und sind für die '
        + 'nächsten ein bis zwei Stunden erstaunlich treffsicher. Weiter voraus wird aus '
        + '„es regnet um 16:15" eher „irgendwann am Nachmittag".' },
  mond: { titel: 'Mondphase',
    text: 'Der Anteil der beleuchteten Mondscheibe. Bei Vollmond ist die Nacht so hell, dass '
        + 'schwache Sterne und Sternschnuppen untergehen; bei Neumond ist der Himmel am dunkelsten. '
        + 'Für Himmelsbeobachtung ist Neumond deshalb die beste Zeit.' }
};

function tile(label, value, sub, extra = '', tone = '', key = '') {
  return `<div class="tile${tone ? ' t-' + tone : ''}${key ? ' has-info' : ''}"${
      key ? ` data-info="${key}" role="button" tabindex="0"` : ''}>
    <span class="t-label">${label}${key ? '<i class="t-q">?</i>' : ''}</span>
    <span class="t-value">${value}</span>
    ${extra}
    <span class="t-sub">${sub || ''}</span>
  </div>`;
}

function openExplain(key) {
  const e = EXPLAIN[key];
  if (!e) return;
  $('#explainTitle').textContent = e.titel;
  $('#explainText').textContent = e.text;
  if (key === 'mond') mondDetails();
  if (key === 'sonne') sonnenDetails();
  const l = $('#explainLink');
  if (e.link) {
    l.href = e.link.url; l.textContent = `${e.link.text} öffnen →`; l.hidden = false;
  } else l.hidden = true;
  openSheet('#explainSheet');
}

/** Was der Einstrahlwinkel bedeutet — Schatten, Kraft, Jahreszeit. */
function sonnenDetails() {
  const jetzt = new Date();
  const winkel = sunAltitude(jetzt, place.lat, place.lon);
  const { zeit: mittag, hoehe: hoch } = solarNoon(jetzt, place.lat, place.lon);

  // Schattenlänge eines 1,80-m-Menschen: Körpergröße geteilt durch Tangens
  const schatten = winkel > 1
    ? (1.8 / Math.tan(winkel * Math.PI / 180)).toFixed(1).replace('.', ',')
    : null;
  // Die Strahlung fällt mit dem Sinus des Winkels — bei 30° nur die Hälfte
  const kraft = winkel > 0 ? Math.round(Math.sin(winkel * Math.PI / 180) * 100) : 0;

  // Höchststände zu den Wendepunkten: 90 − Breite ± 23,44°
  const sommer = (90 - Math.abs(place.lat) + 23.44).toFixed(0);
  const winter = (90 - Math.abs(place.lat) - 23.44).toFixed(0);

  const box = document.createElement('div');
  box.innerHTML = `
    <dl class="ds-facts" style="margin-top:14px">
      <dt>Gerade</dt><dd>${winkel > -0.833
        ? `${dez(winkel)}° über dem Horizont<i>${winkelWort(winkel)}</i>`
        : `${dez(winkel)}° — unter dem Horizont`}</dd>
      ${schatten ? `<dt>Dein Schatten</dt><dd>${schatten} m bei 1,80 m Körpergröße</dd>` : ''}
      ${winkel > 0 ? `<dt>Strahlungskraft</dt><dd>${kraft} % der Kraft, die bei senkrechtem
        Stand ankäme<i>${kraft > 80 ? 'fast voll — Sonnenschutz sinnvoll'
        : kraft > 50 ? 'kräftig' : kraft > 20 ? 'mäßig' : 'schwach'}</i></dd>` : ''}
      <dt>Heute höchstens</dt><dd>${dez(hoch)}° um ${hhmm(mittag)} Uhr</dd>
      <dt>Im Jahreslauf</dt><dd>${sommer}° zur Sonnenwende im Juni,
        nur ${winter}° im Dezember</dd>
    </dl>
    <p class="ds-note">Der Winkel entscheidet über fast alles: Steht die Sonne tief, verteilt
      sich dieselbe Energie auf eine größere Fläche und der Weg durch die Luftschichten ist
      länger — deshalb ist Morgenlicht warm und mild, Mittagslicht hart und heiß.
      Bei ${winkel > 0 ? winkel.toFixed(0) : 0}° kommt gerade ${kraft} % der
      Strahlung an, die bei senkrechtem Einfall ankäme.</p>`;

  $('#explainText').appendChild(box);
}

/** Termine und Kennzahlen zum Mond unter die Erklärung hängen. */
function mondDetails() {
  const mp = moonPhase();
  const mt = moonTimes(new Date(), place.lat, place.lon);
  const km = moonDistance();
  const naechste = kommendePhasen();

  // 356.500 km ist die engste, 406.700 km die weiteste mögliche Entfernung
  const naehe = (406700 - km) / (406700 - 356500);
  const groesse = km < 362000 ? 'ungewöhnlich nah — er wirkt größer und heller ("Supermond")'
                : km > 400000 ? 'weit entfernt — er wirkt etwas kleiner als sonst'
                : 'im mittleren Abstand';

  const box = document.createElement('div');
  box.innerHTML = `
    <dl class="ds-facts" style="margin-top:14px">
      <dt>Gerade</dt><dd>${mp.name}, ${Math.round(mp.beleuchtet * 100)} % beleuchtet</dd>
      ${mt.auf ? `<dt>Mondaufgang</dt><dd>${hhmm(mt.auf)} Uhr</dd>` : ''}
      ${mt.unter ? `<dt>Monduntergang</dt><dd>${hhmm(mt.unter)} Uhr</dd>` : ''}
      <dt>Entfernung</dt><dd>${Math.round(km).toLocaleString('de-DE')} km<i>${groesse}</i></dd>
    </dl>
    <p class="ds-untertitel">Die nächsten Phasen</p>
    <div class="ds-spans">
      ${naechste.map(p => {
        const tage = Math.round((p.t - Date.now()) / 864e5);
        return `<div class="ds-span">
          <b>${p.zeichen} ${p.name}</b>
          <span>${p.t.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })},
            ${hhmm(p.t)} Uhr${tage <= 1 ? '' : ` · in ${tage} Tagen`}</span>
        </div>`;
      }).join('')}
    </div>
    <p class="ds-note">Die Uhrzeiten sind auf etwa eine Minute genau — der Mond läuft
      auf einer Ellipse und wird von der Sonne gestört, deshalb reicht eine feste
      Umlaufdauer nicht aus. Zwischen zwei Vollmonden liegen im Mittel 29 Tage,
      12 Stunden und 44 Minuten.</p>`;

  $('#explainText').appendChild(box);
}

/** Antippen auf Kacheln erst nach dem Rendern verdrahten. */
function wireExplain() {
  $$('.tile.has-info').forEach(t => {
    t.onclick = () => openExplain(t.dataset.info);
    t.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openExplain(t.dataset.info); } };
  });
  $$('#daily .drow').forEach(r => {
    r.onclick = () => openDaySheet(Number(r.dataset.day));
  });
  // Jede Stunde antippbar — in der Leiste ist nur Platz für drei Werte
  $$('#hourly .hcol[data-i]').forEach(c => {
    c.onclick = () => openStundeSheet(Number(c.dataset.i));
  });
}

/** Alle Stunden eines Tages als Zeilen — Grundlage der Tagesansicht. */
function dayHours(dayISO) {
  const h = data.hourly, out = [];

  /* `is_day` gilt für den Beginn der Stunde. Geht die Sonne um 21:04 unter,
     ist die Stunde 21–22 damit „Tag" — und ein wolkenloser Himmel wurde als
     „21–22 Uhr sonnig" ausgewiesen, obwohl es 56 der 60 Minuten dunkel war.
     Entscheidend ist deshalb die Mitte der Stunde. */
  const tag = data.daily?.time?.indexOf(dayISO) ?? -1;
  const auf = tag >= 0 ? new Date(data.daily.sunrise[tag]).getTime() : null;
  const unter = tag >= 0 ? new Date(data.daily.sunset[tag]).getTime() : null;

  for (let u = 0; u < 24; u++) {
    const k = h.time.indexOf(`${dayISO}T${String(u).padStart(2, '0')}:00`);
    if (k < 0) continue;
    const mitte = new Date(h.time[k]).getTime() + 30 * 60000;
    const tags = (auf != null && unter != null)
      ? (mitte >= auf && mitte <= unter)
      : h.is_day[k] === 1;
    out.push({ u, temp: h.temperature_2m[k], mm: h.precipitation[k] ?? 0,
               wolken: wolkenFuer(h.time[k], h.cloud_cover[k] ?? 0), wind: h.wind_speed_10m[k],
               boe: h.wind_gusts_10m[k], tags, uv: h.uv_index[k],
               gefuehlt: h.apparent_temperature?.[k], feuchte: h.relative_humidity_2m?.[k] });
  }
  return out;
}

/** Zusammenhängende Abschnitte gleicher Art zusammenfassen ("9–14 Uhr sonnig").
    Zu jedem Abschnitt kommen die Zahlen, die man dort wirklich braucht:
    Temperaturspanne, Wind und Böen. Vorher stand die Windspitze nur als
    Tageswert weiter unten — ohne Bezug, wann sie kommt. */
function daySpans(stunden) {
  /* „Regen" ab 0,1 mm in der Stunde war zu großzügig: Darunter stand dann
     „🌧 Regen · kaum spürbar" in einer Zeile. Zwei Stufen lösen das auf. */
  /* Dieselbe Schwelle wie überall sonst (REGEN.nichts): Bei 0,1 mm stand
     hier „ein paar Tropfen", während die Leiste darüber „bedeckt" zeigte
     und der Klartext „trocken" sagte — drei Aussagen für eine Stunde. */
  const art = (s) => (s.mm >= 0.5 ? 'regen' : s.mm >= REGEN.nichts ? 'tropfen'
                    : !s.tags ? 'nacht'
                    : s.wolken < 25 ? 'sonnig' : s.wolken < 55 ? 'heiter'
                    : s.wolken < 80 ? 'wolkig' : 'bedeckt');
  const spans = [];
  for (const s of stunden) {
    const a = art(s);
    const letzt = spans[spans.length - 1];
    if (letzt && letzt.art === a) { letzt.bis = s.u + 1; letzt.mm += s.mm; letzt.h.push(s); }
    else spans.push({ art: a, von: s.u, bis: s.u + 1, mm: s.mm, h: [s] });
  }

  const groesste = (liste) => (liste.length ? Math.max(...liste) : null);
  for (const sp of spans) {
    const temps = sp.h.map(x => x.temp).filter(v => v != null);
    sp.tMin = temps.length ? Math.min(...temps) : null;
    sp.tMax = temps.length ? Math.max(...temps) : null;
    sp.wind = groesste(sp.h.map(x => x.wind).filter(v => v != null));
    sp.boe  = groesste(sp.h.map(x => x.boe).filter(v => v != null));
  }
  return spans;
}

const SPAN_WORT = { sonnig: '☀️ sonnig', heiter: '🌤 heiter', wolkig: '⛅ wolkig',
                    bedeckt: '☁️ bedeckt', regen: '🌧 Regen',
                    tropfen: '🌦 ein paar Tropfen', nacht: '🌙 Nacht' };

/** Was 11 km/h bedeuten, weiß kaum jemand — die Beaufort-Skala in Worten. */
function windWorte(kmh) {
  if (kmh == null) return '';
  if (kmh < 2)  return 'windstill, Rauch steigt gerade auf';
  if (kmh < 6)  return 'kaum spürbar';
  if (kmh < 12) return 'leichter Zug, Blätter rascheln';
  if (kmh < 20) return 'spürbare Brise, Zweige bewegen sich';
  if (kmh < 29) return 'frischer Wind, Papier fliegt weg';
  if (kmh < 39) return 'kräftig, kleine Bäume schwanken';
  if (kmh < 50) return 'starker Wind, Regenschirme kaum zu halten';
  if (kmh < 62) return 'stürmisch, Gehen wird mühsam';
  if (kmh < 75) return 'Sturm, Äste brechen';
  if (kmh < 89) return 'schwerer Sturm, Dachziegel lösen sich';
  if (kmh < 103) return 'orkanartig, Bäume entwurzeln';
  return 'Orkan, schwere Schäden';
}

/** Warum sich die Temperatur anders anfühlt, als das Thermometer sagt. */
function gefuehltWarum(temp, gefuehlt, wind, feuchte) {
  const d = gefuehlt - temp;
  if (Math.abs(d) < 1) return 'wie gemessen';
  if (d > 0) return feuchte >= 65 ? `${dez(d)}° wärmer — die feuchte Luft staut die Wärme`
                                  : `${dez(d)}° wärmer — Sonne und wenig Wind`;
  return wind >= 15 ? `${dez(-d)}° kühler — der Wind zieht Wärme weg`
                    : `${dez(-d)}° kühler`;
}

/** Antippen einer Zahl auf der Karte: was bedeutet der Wert, und wann
    genau regnet es an dieser Stelle? */
function showPointDetail(props, lngLat) {
  const reihe = Forecast.series?.(lngLat.lat, lngLat.lng);
  const mm = Number(props.mm) || 0;
  const h = Number(props.stunde) || 0;

  // Nächste Regenphase ab der gezeigten Stunde suchen
  let phase = null;
  if (reihe) {
    for (let k = h; k < Math.min(reihe.times.length, h + 48); k++) {
      if ((reihe.precip[k] ?? 0) >= 0.1) {
        let bis = k, summe = 0;
        while (bis < reihe.times.length && (reihe.precip[bis] ?? 0) >= 0.1) { summe += reihe.precip[bis]; bis++; }
        phase = { von: new Date(reihe.times[k]), bis: new Date(reihe.times[bis] || reihe.times[bis - 1]), summe };
        break;
      }
    }
  }

  $('#explainTitle').textContent = mm >= 0.1 ? `${dez(mm)} mm Regen` : `${props.grad}°`;
  $('#explainText').innerHTML = `
    <p style="margin:0 0 12px">${mm >= 0.1
      ? `An dieser Stelle fällt in der gezeigten Stunde <b>${dez(mm)} mm</b> Regen — ${rainWords(mm)}.`
      : `An dieser Stelle sind <b>${props.grad}°</b> vorhergesagt. Zeigt die Karte Regen, steht dort statt der Temperatur die Menge in Millimetern.`}</p>
    ${phase ? `<div class="ds-span" style="margin-bottom:12px">
      <b>${hhmm(phase.von)}–${hhmm(phase.bis)}</b>
      <span>🌧 ${dez(phase.summe)} mm insgesamt</span>
    </div>` : '<p class="ds-note" style="margin-bottom:12px">In den nächsten zwei Tagen ist hier kein Regen vorhergesagt.</p>'}
    <dl class="ds-facts">
      <dt>unter 0,5 mm</dt><dd>Nieseln — Jacke reicht</dd>
      <dt>0,5 – 2 mm</dt><dd>leichter Regen — Schirm sinnvoll</dd>
      <dt>2 – 5 mm</dt><dd>mäßiger Regen — man wird nass</dd>
      <dt>über 5 mm</dt><dd>kräftiger Regen bis Starkregen</dd>
    </dl>
    <p class="ds-note">1 mm bedeutet: ein Liter Wasser pro Quadratmeter.
      Die Werte stammen aus dem Vorhersagemodell, nicht aus dem Radar — je weiter
      in der Zukunft, desto gröber.</p>`;
  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
}

/* Der Taupunkt sagt mehr über die Schwüle als die relative Feuchte: Er misst,
   wie viel Wasser wirklich in der Luft ist, unabhängig von der Temperatur. */
function taupunktWort(t) {
  if (t < 5)  return 'sehr trocken';
  if (t < 11) return 'trocken';
  if (t < 16) return 'angenehm';
  if (t < 18) return 'leicht schwül';
  if (t < 21) return 'schwül';
  return 'drückend schwül';
}

/* Alles, was für eine Stunde bekannt ist. In der Leiste ist nur Platz für
   Symbol, Temperatur und Regen — der Rest steht hier. */
function openStundeSheet(i) {
  const h = data?.hourly;
  if (!h || i == null || !h.time[i]) return;

  const t = new Date(h.time[i]);
  const heute = t.toDateString() === new Date().toDateString();
  const morgen = t.toDateString() === new Date(Date.now() + 864e5).toDateString();
  const tag = heute ? 'Heute' : morgen ? 'Morgen'
            : t.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  const temp = h.temperature_2m[i];
  const gefuehlt = h.apparent_temperature?.[i];
  const mm = h.precipitation[i] ?? 0;
  const prob = h.precipitation_probability[i] ?? 0;
  const wind = h.wind_speed_10m[i];
  const boe = h.wind_gusts_10m[i];
  const wolken = h.cloud_cover?.[i];
  const feuchte = h.relative_humidity_2m?.[i];
  const taupunkt = h.dew_point_2m?.[i];
  const uv = h.uv_index?.[i];
  const sicht = h.visibility?.[i];
  const tags = h.is_day[i] === 1;
  // Sonnenscheindauer kommt in Sekunden je Stunde
  const sonneMin = h.sunshine_duration?.[i] != null
    ? Math.round(h.sunshine_duration[i] / 60) : null;

  // Wie sich die Temperatur zur Stunde davor entwickelt
  const vorher = i > 0 ? h.temperature_2m[i - 1] : null;
  const wandel = vorher == null ? '' : temp - vorher >= 0.8 ? ' steigend'
               : vorher - temp >= 0.8 ? ' fallend' : ' gleichbleibend';

  $('#explainTitle').textContent = `${tag}, ${hhmm(t)} Uhr`;
  $('#explainText').innerHTML = `
    <div class="sh-kopf">
      <span class="sh-icon">${WX.icon(himmelCode(i), h.is_day[i])}</span>
      <span class="sh-haupt">
        <b>${round(temp)}°</b>
        <i>${esc(WX.text(himmelCode(i), h.is_day[i]))}${wandel}</i>
      </span>
    </div>
    <dl class="ds-facts">
      ${gefuehlt != null ? `<dt>Gefühlt</dt><dd>${round(gefuehlt)}°<i>${
        gefuehltWarum(temp, gefuehlt, wind, feuchte)}</i></dd>` : ''}
      <dt>Regen</dt><dd>${mm >= 0.05
        ? `${dez(mm)} mm — ${rainWords(mm)}<i>Wahrscheinlichkeit ${prob} %</i>`
        : `keiner erwartet<i>Wahrscheinlichkeit ${prob} %</i>`}</dd>
      <dt>Wind</dt><dd>${round(wind)} km/h${boe >= wind + 5 ? `, Böen ${round(boe)} km/h` : ''}
        <i>${windWorte(wind)}</i></dd>
      ${wolken != null ? `<dt>Bewölkung</dt><dd>${round(wolken)} %<i>${wolkenWort(wolken)}</i></dd>` : ''}
      ${sonneMin != null ? `<dt>Sonne</dt><dd>${sonneMin === 0 ? 'keine'
        : sonneMin >= 58 ? 'die ganze Stunde' : `${sonneMin} von 60 Minuten`}<i>${
        sonneMin === 0 ? (tags ? 'durchgehend bedeckt' : 'die Sonne steht unter dem Horizont')
        : sonneMin >= 58 ? 'ungetrübt'
        : sonneMin >= 30 ? 'überwiegend sonnig, zwischendurch Wolken'
        : 'meist bewölkt, kurze Aufheiterungen'}</i></dd>` : ''}
      ${feuchte != null ? `<dt>Luftfeuchte</dt><dd>${round(feuchte)} %${
        taupunkt != null ? `<i>Taupunkt ${round(taupunkt)}° — ${taupunktWort(taupunkt)}</i>` : ''}</dd>` : ''}
      ${uv != null && tags ? `<dt>UV-Index</dt><dd>${dez(uv)}<i>${
        uv >= 8 ? 'sehr hoch — Mittagssonne meiden' : uv >= 6 ? 'hoch — Sonnenschutz'
        : uv >= 3 ? 'mäßig' : 'unkritisch'}</i></dd>` : ''}
      ${sicht != null ? `<dt>Sicht</dt><dd>${sicht >= 20000 ? 'über 20 km' : `${Math.round(sicht / 1000)} km`}<i>${
        sicht < 1000 ? 'Nebel' : sicht < 4000 ? 'diesig' : sicht < 10000 ? 'leicht trüb' : 'klar'}</i></dd>` : ''}
      <dt>Tageszeit</dt><dd>${tags ? '☀️ Tag' : '🌙 Nacht'}</dd>
    </dl>
    <p class="ds-note">Diese Zahlen stammen aus dem Vorhersagemodell für genau diese
      Stunde. Je weiter der Zeitpunkt entfernt ist, desto gröber wird die Aussage —
      für die nächsten Stunden ist sie meist zuverlässig, in fünf Tagen eher eine
      Tendenz.</p>`;

  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
}

/* Welcher Tag gerade offen ist. Kommen neue Daten herein, zeichnet sich das
   Blatt damit selbst neu — sonst stünden dort die Zahlen von vorhin weiter,
   während oben schon die frischen stehen. */
let offenerTag = null;

function openDaySheet(i) {
  const d = data.daily, dayISO = d.time[i];
  if (!dayISO) return;
  offenerTag = dayISO;
  const stunden = dayHours(dayISO);
  const spans = daySpans(stunden).filter(s => s.art !== 'nacht' || s.bis - s.von >= 3);
  const sun = Math.round(sonnenStunden(dayISO));
  const mm = d.precipitation_sum[i] ?? 0;
  const warm = stunden.reduce((a, b) => (b.temp > a.temp ? b : a), stunden[0] || { u: 12, temp: 0 });
  const kalt = stunden.reduce((a, b) => (b.temp < a.temp ? b : a), stunden[0] || { u: 5, temp: 0 });
  const wind = d.wind_speed_10m_max?.[i], boe = d.wind_gusts_10m_max?.[i];
  /* Die Windspitze ohne Uhrzeit half niemandem: „Böen bis 38 km/h" kann
     nachts um drei gelten oder mitten am Nachmittag. */
  const windSpitze = stunden.length
    ? stunden.reduce((a, b) => ((b.boe ?? b.wind ?? -1) > (a.boe ?? a.wind ?? -1) ? b : a)).u
    : null;
  const uvMax = d.uv_index_max?.[i];
  const heute = new Date(dayISO).toDateString() === new Date().toDateString();

  $('#explainTitle').textContent = heute ? 'Heute' : `${weekday(dayISO)}, ${new Date(dayISO).toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })}`;

  $('#explainText').innerHTML = `
    <div class="ds-spans">
      ${spans.map(s => {
        /* Beim heutigen Tag den Abschnitt markieren, in dem wir gerade
           stehen — sonst muss man selbst suchen, was gerade gilt. */
        const jetztStunde = new Date().getHours();
        const laeuft = heute && jetztStunde >= s.von && jetztStunde < s.bis;

        /* Zweite Zeile: Temperatur und Wind für genau diesen Abschnitt.
           Ohne sie stand hier nur „bedeckt" — die Frage, wie warm und wie
           windig es dann ist, musste man sich aus Tageswerten zusammenreimen. */
        const zahlen = [];
        if (s.tMin != null) {
          zahlen.push(round(s.tMin) === round(s.tMax)
            ? `${round(s.tMax)}°`
            : `${round(s.tMin)}–${round(s.tMax)}°`);
        }
        if (s.wind != null) {
          zahlen.push(`Wind ${round(s.wind)} km/h${
            s.boe != null && s.boe >= s.wind + 8 ? `, Böen ${round(s.boe)}` : ''}`);
        }
        if (s.art === 'regen' || s.art === 'tropfen') {
          const k = regenKlartext(s.mm / Math.max(1, s.bis - s.von));
          zahlen.push(`${dez(s.mm)} mm${k.kurz ? ` — ${k.kurz}` : ''}`);
        }

        return `<div class="ds-span ds-zwei${laeuft ? ' ist-jetzt' : ''}">
          <span class="ds-kopf">
            <b>${String(s.von).padStart(2, '0')}–${String(s.bis).padStart(2, '0')} Uhr${
              laeuft ? '<em>jetzt</em>' : ''}</b>
            <span class="ds-wort">${SPAN_WORT[s.art]}</span>
          </span>
          ${zahlen.length ? `<span class="ds-zahlen">${
            zahlen.map(z => `<i>${z}</i>`).join('')}</span>` : ''}
        </div>`;
      }).join('')}
    </div>
    <dl class="ds-facts">
      <dt>Wärmster Moment</dt><dd>${round(warm.temp)}° gegen ${String(warm.u).padStart(2, '0')} Uhr${
        warm.gefuehlt != null ? ` <i>fühlt sich an wie ${round(warm.gefuehlt)}°</i>` : ''}</dd>
      <dt>Kältester Moment</dt><dd>${round(kalt.temp)}° gegen ${String(kalt.u).padStart(2, '0')} Uhr${
        kalt.gefuehlt != null ? ` <i>fühlt sich an wie ${round(kalt.gefuehlt)}°</i>` : ''}</dd>
      <dt>Sonne</dt><dd>${sun} Stunden${sun >= 8 ? ' — viel' : sun <= 2 ? ' — wenig' : ''}</dd>
      <dt>Regen</dt><dd>${mm < 0.2 ? 'keiner erwartet' : `${dez(mm)} mm — ${rainWords(mm)}`}</dd>
      <dt>Wind</dt><dd>bis ${round(wind)} km/h, Böen bis ${round(boe)} km/h${
        windSpitze != null ? ` gegen ${String(windSpitze).padStart(2, '0')} Uhr` : ''}
        <i>${windWorte(wind)}${boe >= 60 ? ' · in Böen auf lose Gegenstände achten' : ''}</i></dd>
      <dt>Sonnenaufgang</dt><dd>${hhmm(d.sunrise[i])}</dd>
      <dt>Sonnenuntergang</dt><dd>${hhmm(d.sunset[i])}</dd>
      ${uvMax != null ? `<dt>UV-Höchstwert</dt><dd>${dez(uvMax)}${uvMax >= 6 ? ' — Sonnenschutz sinnvoll' : uvMax >= 3 ? ' — mäßig' : ' — unkritisch'}</dd>` : ''}
    </dl>
    <p class="ds-note">1 mm Regen heißt: Auf einen Quadratmeter fällt ein Liter Wasser.
      Verteilt über mehrere Stunden ist das kaum spürbar, in zehn Minuten ein kräftiger Schauer.
      ${warm.gefuehlt != null
        ? `Die gefühlte Temperatur weicht am Nachmittag ab: ${gefuehltWarum(warm.temp, warm.gefuehlt, warm.wind, warm.feuchte)}.`
        : ''}</p>
    <p class="ds-stand">Stand ${standZeit ? hhmm(standZeit) : hhmm(Date.now())} Uhr · ${
      esc(quellenName())}. Die App lädt alle zehn Minuten nach; dieses Blatt
      zieht dann mit.</p>`;

  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
}

/** Nach dem Laden: offenes Tagesblatt auf den neuen Stand bringen. */
function tagesblattAuffrischen() {
  if (!offenerTag || !data?.daily) return;
  // #explainSheet ist die Hülle selbst und trägt die Klasse „open"
  if (!$('#explainSheet')?.classList.contains('open')) { offenerTag = null; return; }
  const i = data.daily.time.indexOf(offenerTag);
  if (i < 0) return;

  /* Wer gerade unten bei den Windwerten liest, soll nicht plötzlich wieder
     oben stehen, nur weil im Hintergrund neue Zahlen kamen. */
  const rolle = $('#explainSheet .sheet');
  const oben = rolle?.scrollTop ?? 0;
  openDaySheet(i);
  if (rolle) rolle.scrollTop = oben;
}


/* ── Sonnenbahn im Kamerabild ───────────────────────────────
   Das Gerät weiß, wohin es zeigt (Kompass und Neigung), und wir wissen, wo
   die Sonne steht. Beides zusammen ergibt: die Bahn ins Livebild gezeichnet.
   Damit sieht man vor Ort, ob ein Platz mittags Schatten hat oder hinter
   welchem Haus die Sonne untergeht. */
let arLauf = null, arStream = null, arVersatz = null;

/* Der eigene Standort, nicht der eingestellte Ort: Man steht ja vor Ort und
   will wissen, wo hier die Sonne langläuft. Fällt GPS aus, gilt der Ort aus
   der App — dann stimmt es nur, wenn man tatsächlich dort ist. */
let arOrtPos = null;

/* Ausgleich für den Kompass. Handymagnetometer liegen oft 10–20° daneben,
   und Eisen in der Nähe verzerrt zusätzlich. Wer die Sonne sieht und antippt,
   sagt dem Gerät, wo sie wirklich steht — der Versatz gilt danach für alle
   weiteren Messungen. */
const arKorrektur = () => ({
  azimut: store.get('wf.arAz', 0),
  hoehe: store.get('wf.arHo', 0)
});

async function arStarten() {
  const back = $('#arBack');
  if (!back || !place) return;

  // iOS gibt die Lagesensoren erst nach ausdrücklicher Erlaubnis frei,
  // und nur direkt aus einer Nutzergeste heraus.
  let lageOk = true;
  try {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      lageOk = (await DeviceOrientationEvent.requestPermission()) === 'granted';
    }
  } catch { lageOk = false; }

  try {
    arStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false
    });
  } catch (e) {
    toast(e?.name === 'NotAllowedError'
      ? 'Ohne Kamerazugriff geht die Ansicht nicht.'
      : 'Kamera nicht verfügbar.', 4000);
    return;
  }

  const video = $('#arVideo');
  video.srcObject = arStream;
  await video.play().catch(() => {});

  back.hidden = false;
  document.body.classList.add('ar-offen');
  arOrtPos = null;
  arOrtAnzeigen();

  // Echten Standort holen — die Bahn hängt an Breite und Länge
  navigator.geolocation?.getCurrentPosition((pos) => {
    arOrtPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    arOrtAnzeigen();
  }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 3e5 });
  const k = arKorrektur();
  $('#arKal').hidden = Math.abs(k.azimut) < 0.5 && Math.abs(k.hoehe) < 0.5;
  arHinweisText();
  if (!lageOk) $('#arHinweis').textContent = 'Ohne Lagesensor wird die Bahn nur grob gezeigt.';

  const zeitRegler = $('#arZeit');
  zeitRegler.value = String(new Date().getHours() * 60 + new Date().getMinutes());
  arVersatz = null;
  zeitRegler.oninput = () => { arVersatz = Number(zeitRegler.value); arZeitText(); };
  arZeitText();

  starteLage(lageOk);
  arZeichnen();
}

/** Position, mit der gerechnet wird — GPS wenn vorhanden, sonst der Ort. */
const arPos = () => arOrtPos || { lat: place.lat, lon: place.lon };

/** Zustand des letzten Bildes — Grundlage für das Einmessen. */
let arLetzteSonne = null;
let arLetzterMond = null;

/* Einmessen: Der Finger zeigt auf die echte Sonne, die App weiß, wo sie sie
   vermutet. Die Differenz ist der Fehler von Kompass und Neigungsmesser und
   wird für alle weiteren Messungen abgezogen. */
function arEinmessen(e) {
  if (!arLetzteSonne || arLetzteSonne.blick == null) {
    toast('Ohne Kompass lässt sich nichts einmessen.', 3500);
    return;
  }
  /* Eingemessen wird an dem Gestirn, das gerade am Himmel steht: tagsüber
     die Sonne, nachts der Mond. Beides zu verlangen hieße, dass die Ansicht
     die halbe Zeit schief bleibt. */
  const nachSonne = arLetzteSonne.hoehe >= -1;
  const ziel = nachSonne ? arLetzteSonne : arLetzterMond;
  if (!ziel || ziel.hoehe < -1) {
    toast('Sonne und Mond sind beide unter dem Horizont — dann gibt es nichts zum Einmessen.', 4500);
    return;
  }
  const back = $('#arBack');
  const b = back.getBoundingClientRect();
  const t = e.touches?.[0] || e.changedTouches?.[0] || e;
  const x = t.clientX - b.left, y = t.clientY - b.top;

  const { proGrad, mitteY, breite } = arLetzteSonne;
  const { azi, hoehe } = ziel;

  // Bildpunkt zurück in Himmelskoordinaten rechnen
  const getipptAb = (x - breite / 2) / proGrad;          // Grad neben der Blickmitte
  const getipptHoehe = (mitteY - y) / proGrad;

  // Wo die App die Sonne vermutet hat
  let sollAb = azi - arLetzteSonne.blick;
  while (sollAb > 180) sollAb -= 360;
  while (sollAb < -180) sollAb += 360;

  const azVersatz = store.get('wf.arAz', 0) + (getipptAb - sollAb);
  const hoVersatz = store.get('wf.arHo', 0) + (getipptHoehe - hoehe);

  /* Hier stand eine Grenze von 45° auf die Abweichung — gedacht gegen
     Fehlgriffe, in Wahrheit eine Sperre gegen genau den Fall, für den das
     Einmessen da ist. Der Kompass eines iPhones liegt ohne Kalibrierung
     gern 60° und mehr daneben, und die Neigung noch weiter: Am 3. August
     stand die Sonne 46° über der gezeichneten Bahn, das Antippen wurde
     abgelehnt, und der Fehler blieb.

     Wer auf die Sonne tippt, hat recht — der Tipp IST die Messung. Geprüft
     wird deshalb nur noch, ob das Ergebnis überhaupt eine Kompassabweichung
     sein kann. Und wenn nicht, führt der Weg über „Zurück auf reine
     Kompasswerte", nicht über eine Absage. */
  if (Math.abs(azVersatz) > 150 || Math.abs(hoVersatz) > 80) {
    toast('So weit kann kein Kompass danebenliegen. Erst zurücksetzen, dann neu einmessen.', 5000);
    return;
  }

  store.set('wf.arAz', Math.round(azVersatz * 10) / 10);
  store.set('wf.arHo', Math.round(hoVersatz * 10) / 10);
  $('#arKal').hidden = false;
  toast(nachSonne ? 'Eingemessen. Die Bahn sitzt jetzt auf der Sonne.'
                  : 'Eingemessen. Die Bahn sitzt jetzt auf dem Mond.', 3000);
  arHinweisText();
}

function arKalibrierungLoeschen() {
  store.set('wf.arAz', 0);
  store.set('wf.arHo', 0);
  $('#arKal').hidden = true;
  toast('Einmessung zurückgesetzt.');
  arHinweisText();
}

function arHinweisText() {
  const el = $('#arHinweis');
  if (!el) return;
  const k = arKorrektur();
  const eingemessen = Math.abs(k.azimut) > 0.5 || Math.abs(k.hoehe) > 0.5;
  if (eingemessen) {
    el.innerHTML = `Eingemessen: ${k.azimut > 0 ? '+' : ''}${dez(k.azimut)}° Richtung, ${
      k.hoehe > 0 ? '+' : ''}${dez(k.hoehe)}° Höhe. Nochmal tippen misst neu ein.`;
  } else if (arLage.richtung != null) {
    el.innerHTML = 'Siehst du Sonne oder Mond? Tippe genau darauf, dann sitzt die Bahn richtig.';
  } else if (arLageWartet) {
    el.innerHTML = 'Kompass wird gesucht — dreh dich einmal langsam im Kreis.';
  } else {
    el.innerHTML = 'Kompass nicht verfügbar. Unter Einstellungen › Safari › '
      + 'Bewegung &amp; Ausrichtung erlauben, dann die Ansicht neu öffnen.';
  }
}

function arOrtAnzeigen() {
  const el = $('#arOrt');
  if (!el) return;
  const datum = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long' });
  el.textContent = arOrtPos
    ? `Dein Standort · ${datum}`
    : `${place.name} · ${datum}`;
}

function arZeitText() {
  const el = $('#arZeitwert');
  if (!el) return;
  if (arVersatz == null) { el.textContent = 'jetzt'; return; }
  const h = Math.floor(arVersatz / 60), m = arVersatz % 60;
  el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} Uhr`;
}

/** Ausrichtung des Geräts: Kompassrichtung und Neigung nach oben. */
let arLage = { richtung: null, neigung: 0 };
let arLageAb = null;              // zum Abmelden beim Schließen
let arLageWartet = false;         // Erlaubnis da, aber noch kein Messwert
let arLetzterZustand = null;

function starteLage(erlaubt) {
  if (arLageAb) arLageAb();       // nie zweimal anmelden
  arLageWartet = erlaubt;
  arLetzterZustand = null;
  const auf = (e) => {
    // Safari liefert die Kompassrichtung direkt, andere rechnen aus alpha
    const kompass = e.webkitCompassHeading != null
      ? e.webkitCompassHeading
      : (e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null);
    if (kompass != null) { arLage.richtung = kompass; arLageWartet = false; }
    if (e.beta != null) arLage.neigung = e.beta - 90;   // 0 = waagerecht nach vorn
  };
  window.addEventListener('deviceorientationabsolute', auf, true);
  window.addEventListener('deviceorientation', auf, true);
  arLageAb = () => {
    window.removeEventListener('deviceorientationabsolute', auf, true);
    window.removeEventListener('deviceorientation', auf, true);
    arLageAb = null;
  };
  // Antwortet der Sensor nach fünf Sekunden nicht, ist er wirklich nicht da
  setTimeout(() => { if (arLage.richtung == null) arLageWartet = false; }, 5000);
}

function arBeenden() {
  const back = $('#arBack');
  if (back) back.hidden = true;
  document.body.classList.remove('ar-offen');
  cancelAnimationFrame(arLauf);
  arLauf = null;
  if (arStream) { arStream.getTracks().forEach(t => t.stop()); arStream = null; }
  if (arLageAb) arLageAb();
}

/** Abgerundetes Feld — für die Zahlen, die im Kamerabild lesbar bleiben müssen. */
function rundesFeld(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else {
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  }
  g.fill();
}

/* Zeichnet die Bahn. Die Kamera hat etwa 65° Blickwinkel in der Breite —
   daraus ergibt sich, wie viele Pixel ein Grad am Himmel misst. */
function arZeichnen() {
  const cv = $('#arCanvas');
  const back = $('#arBack');
  if (!cv || back?.hidden) return;

  const b = back.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(b.width * dpr)) {
    cv.width = Math.round(b.width * dpr);
    cv.height = Math.round(b.height * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, b.width, b.height);

  const proGrad = b.width / 65;
  const kor = arKorrektur();
  // Gemessene Richtung um den beim Antippen gefundenen Versatz bereinigen
  const blick = arLage.richtung == null ? null : arLage.richtung - kor.azimut;
  const mitteY = b.height / 2 + (arLage.neigung - kor.hoehe) * proGrad;

  /* Bildposition eines Himmelspunkts. null, wenn er hinter einem liegt. */
  const punkt = (azimut, hoehe) => {
    if (blick == null) return null;
    let ab = azimut - blick;
    while (ab > 180) ab -= 360;
    while (ab < -180) ab += 360;
    if (Math.abs(ab) > 70) return null;
    return [b.width / 2 + ab * proGrad, mitteY - hoehe * proGrad];
  };

  const ort = arPos();
  const tagStart = new Date(); tagStart.setHours(0, 0, 0, 0);
  const bahn = [];
  for (let m = 0; m <= 1440; m += 10) {
    const t = new Date(tagStart.getTime() + m * 60000);
    const hoehe = sunAltitude(t, ort.lat, ort.lon);
    const azi = sunAzimut(t, ort.lat, ort.lon);
    bahn.push({ t, m, hoehe, azi, p: punkt(azi, hoehe) });
  }

  // Mondbahn desselben Tages — nachts ist sie das Einzige am Himmel
  const mondBahn = [];
  for (let m = 0; m <= 1440; m += 10) {
    const t = new Date(tagStart.getTime() + m * 60000);
    const mh = moonHorizont(t, ort.lat, ort.lon);
    mondBahn.push({ t, m, hoehe: mh.hoehe, azi: mh.azimut, p: punkt(mh.azimut, mh.hoehe) });
  }

  // Kompassband auf dem Horizont — sagt in jeder Lage, wohin man schaut
  if (blick != null) {
    g.save();
    const bandH = 26;
    g.fillStyle = 'rgba(0,0,0,.34)';
    g.fillRect(0, mitteY - bandH / 2, b.width, bandH);
    g.strokeStyle = 'rgba(255,255,255,.32)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, mitteY); g.lineTo(b.width, mitteY); g.stroke();

    const namen = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
    g.textAlign = 'center';
    // Von der Blickrichtung aus in beide Richtungen bis an den Bildrand
    const spanne = Math.ceil((b.width / 2) / proGrad) + 5;
    const von = Math.floor((blick - spanne) / 5) * 5;
    for (let a = von; a <= blick + spanne; a += 5) {
      const x = b.width / 2 + (a - blick) * proGrad;
      if (x < -20 || x > b.width + 20) continue;
      const istRichtung = ((a % 45) + 45) % 45 === 0;
      const gross = ((a % 15) + 15) % 15 === 0;
      g.strokeStyle = `rgba(255,255,255,${istRichtung ? '.85' : gross ? '.5' : '.28'})`;
      g.lineWidth = istRichtung ? 1.6 : 1;
      g.beginPath();
      g.moveTo(x, mitteY - (istRichtung ? 9 : gross ? 6 : 3));
      g.lineTo(x, mitteY + (istRichtung ? 9 : gross ? 6 : 3));
      g.stroke();
      if (istRichtung) {
        const grad = ((a % 360) + 360) % 360;
        g.fillStyle = 'rgba(255,255,255,.95)';
        g.font = '700 12px -apple-system, sans-serif';
        g.fillText(namen[grad / 45], x, mitteY - 13);
      }
    }

    // Die genaue Zahl in der Mitte, damit man sie ablesen kann
    const heading = ((blick % 360) + 360) % 360;
    const txt = `${heading.toFixed(0)}°`;
    g.font = '600 13px -apple-system, sans-serif';
    const bw = g.measureText(txt).width + 16;
    g.fillStyle = 'rgba(255,255,255,.92)';
    rundesFeld(g, b.width / 2 - bw / 2, mitteY + 15, bw, 21, 10);
    g.fillStyle = '#0b1220';
    g.fillText(txt, b.width / 2, mitteY + 30);
    g.restore();

    g.fillStyle = 'rgba(255,255,255,.5)';
    g.font = '11px -apple-system, sans-serif';
    g.textAlign = 'left';
    g.fillText('Horizont', 10, mitteY - 22);
    g.textAlign = 'center';
  }

  // Die Mondbahn liegt unter der Sonnenbahn — sie ist die leisere von beiden
  const zeichneMond = (ueber) => {
    g.beginPath();
    let offen = false;
    for (const s of mondBahn) {
      if (!s.p || (s.hoehe > 0) !== ueber) { offen = false; continue; }
      if (!offen) { g.moveTo(s.p[0], s.p[1]); offen = true; }
      else g.lineTo(s.p[0], s.p[1]);
    }
    g.strokeStyle = ueber ? 'rgba(214,226,240,.85)' : 'rgba(214,226,240,.22)';
    g.lineWidth = ueber ? 2.6 : 1.8;
    g.setLineDash(ueber ? [] : [6, 8]);
    g.lineCap = 'round';
    g.stroke();
    g.setLineDash([]);
  };
  zeichneMond(false);
  zeichneMond(true);

  // Die Bahn: über dem Horizont kräftig, darunter gestrichelt
  const zeichneBahn = (ueber) => {
    g.beginPath();
    let offen = false;
    for (const s of bahn) {
      if (!s.p || (s.hoehe > 0) !== ueber) { offen = false; continue; }
      if (!offen) { g.moveTo(s.p[0], s.p[1]); offen = true; }
      else g.lineTo(s.p[0], s.p[1]);
    }
    g.strokeStyle = ueber ? '#ffd60a' : 'rgba(255,214,10,.32)';
    g.lineWidth = ueber ? 4 : 2.5;
    g.setLineDash(ueber ? [] : [7, 7]);
    g.lineCap = 'round';
    g.stroke();
    g.setLineDash([]);
  };
  zeichneBahn(false);
  zeichneBahn(true);

  // Stundenpunkte
  g.font = '600 11px -apple-system, sans-serif';
  g.textAlign = 'center';
  for (const s of bahn) {
    if (s.m % 60 || !s.p || s.hoehe < -2) continue;
    g.beginPath(); g.arc(s.p[0], s.p[1], 10, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,214,10,.92)'; g.fill();
    g.fillStyle = '#1a1400';
    g.fillText(String(s.m / 60), s.p[0], s.p[1] + 4);
  }

  // Die Sonne zum gewählten Zeitpunkt
  const zeit = arVersatz == null ? new Date() : new Date(tagStart.getTime() + arVersatz * 60000);
  const sHoehe = sunAltitude(zeit, ort.lat, ort.lon);
  const sAzi = sunAzimut(zeit, ort.lat, ort.lon);
  const sp = punkt(sAzi, sHoehe);
  if (sp) {
    const schein = g.createRadialGradient(sp[0], sp[1], 4, sp[0], sp[1], 46);
    schein.addColorStop(0, 'rgba(255,220,90,.55)');
    schein.addColorStop(1, 'rgba(255,190,60,0)');
    g.fillStyle = schein;
    g.beginPath(); g.arc(sp[0], sp[1], 46, 0, Math.PI * 2); g.fill();

    g.beginPath(); g.arc(sp[0], sp[1], 17, 0, Math.PI * 2);
    g.fillStyle = sHoehe > 0 ? '#ff9d2e' : 'rgba(255,157,46,.45)';
    g.fill();

    g.fillStyle = '#fff';
    g.font = '600 12px -apple-system, sans-serif';
    g.fillText(`${sHoehe.toFixed(0)}° · ${sAzi.toFixed(0)}°`, sp[0], sp[1] + 38);
  }

  arLetzteSonne = { azi: sAzi, hoehe: sHoehe, bild: sp, proGrad, mitteY,
                    breite: b.width, blick };

  // Der Mond zur selben Zeit, mit der Phase als Schatten auf der Scheibe
  const mNow = moonHorizont(zeit, ort.lat, ort.lon);
  const mp = punkt(mNow.azimut, mNow.hoehe);
  /* Auch am Mond lässt sich einmessen. Nachts ist er das einzige, was am
     Himmel steht — bisher hieß es dann „einmessen geht nur, wenn du die
     Sonne siehst", und die Ansicht blieb schief, bis es hell wurde. */
  arLetzterMond = { azi: mNow.azimut, hoehe: mNow.hoehe, bild: mp };
  if (mp) {
    const ph = moonPhase(zeit);
    const r = 15;
    g.save();
    g.beginPath(); g.arc(mp[0], mp[1], r, 0, Math.PI * 2);
    g.fillStyle = mNow.hoehe > 0 ? 'rgba(232,240,252,.96)' : 'rgba(232,240,252,.4)';
    g.fill();
    // Schattenkante: bei zunehmendem Mond von links, sonst von rechts
    g.clip();
    const versatz = (ph.anteil < 0.5 ? -1 : 1) * (1 - ph.beleuchtet) * 2 * r;
    g.beginPath(); g.arc(mp[0] + versatz, mp[1], r, 0, Math.PI * 2);
    g.fillStyle = mNow.hoehe > 0 ? 'rgba(18,26,40,.82)' : 'rgba(18,26,40,.5)';
    g.fill();
    g.restore();

    g.fillStyle = 'rgba(255,255,255,.92)';
    g.font = '600 11px -apple-system, sans-serif';
    g.fillText(mNow.hoehe > 0.5 ? `Mond ${mNow.hoehe.toFixed(0)}°` : 'Mond am Horizont',
      mp[0], mp[1] + 30);
  }

  /* Wegweiser nur zu dem, was am Himmel auch steht.

     Nachts um halb drei stand hier „Sonne ist links" — die Sonne war
     dreißig Grad unter dem Horizont, auf der anderen Seite der Erde. Der
     Hinweis schickte einen zielsicher gegen die Wand. Und tagsüber kam er
     schon, wenn die Sonne seitlich 70° ablag, was ein unkalibrierter
     Kompass ständig behauptet, während sie geradeaus stand.

     Gezeigt wird deshalb nur, was über dem Horizont steht: bei Tag die
     Sonne, nachts der Mond. Ist beides unten, steht genau das da — und der
     Bogen bleibt als Weg des Tages sichtbar, ohne einen Wegweiser dorthin. */
  if (blick != null) {
    const wohin = (azimut, bild) => {
      let ab = azimut - blick;
      while (ab > 180) ab -= 360;
      while (ab < -180) ab += 360;
      if (Math.abs(ab) > 70) return ab > 0 ? { text: 'ist rechts →' } : { text: 'ist links', pfeil: true };
      if (bild && bild[1] < 8) return { text: 'ist weiter oben ↑' };
      if (bild && bild[1] > b.height - 8) return { text: 'ist weiter unten ↓' };
      return null;                       // im Bild — dann braucht es keinen Hinweis
    };

    const sonneOben = sHoehe > -1;
    const mondOben = mNow.hoehe > -1;
    let wort = null, findbar = false;

    if (sonneOben) {
      const r = wohin(sAzi, sp);
      if (r) { wort = `${r.pfeil ? '← ' : ''}Sonne ${r.text}`; findbar = true; }
    } else if (mondOben) {
      const r = wohin(mNow.azimut, mp);
      if (r) { wort = `${r.pfeil ? '← ' : ''}Mond ${r.text}`; findbar = true; }
    } else {
      wort = 'Sonne und Mond sind gerade unter dem Horizont';
    }

    if (wort) {
      const kal = Math.abs(kor.azimut) > 0.5 || Math.abs(kor.hoehe) > 0.5;
      g.fillStyle = findbar ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.62)';
      g.font = `${findbar ? '600 15px' : '13.5px'} -apple-system, sans-serif`;
      g.fillText(wort, b.width / 2, b.height / 2);
      if (findbar && !kal) {
        g.fillStyle = 'rgba(255,255,255,.7)';
        g.font = '12.5px -apple-system, sans-serif';
        g.fillText('Siehst du sie trotzdem? Tippe darauf — dann stimmt die Richtung.',
          b.width / 2, b.height / 2 + 22);
      }
    }
  }
  if (blick == null) {
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.font = '13px -apple-system, sans-serif';
    g.fillText(arLageWartet ? 'Kompass wird gesucht…' : 'Kompass nicht verfügbar',
      b.width / 2, b.height / 2);
  }

  /* Der Hinweis unten wurde früher nur beim Öffnen geschrieben — da hatte der
     Kompass noch gar nicht geantwortet, und es stand dauerhaft „nicht
     verfügbar" da. Jetzt zieht er nach, sobald sich der Zustand ändert. */
  const zustand = blick == null ? (arLageWartet ? 'warten' : 'ohne') : 'da';
  if (zustand !== arLetzterZustand) { arLetzterZustand = zustand; arHinweisText(); }

  arLauf = requestAnimationFrame(arZeichnen);
}

/* ── Sonnenuhr: der ganze Tag als Ring ──────────────────────
   Ein Halbbogen zeigt nur den hellen Teil. Der Ring fasst 24 Stunden: außen
   die Sonne mit allen Dämmerungsstufen, innen der Mond, in der Mitte die
   Zeit. Mitternacht unten, Mittag oben — wie eine Uhr, die einmal am Tag
   umläuft statt zweimal. */
const UHR = {
  r: 74, ring: 13,          // Sonnenring
  innen: 56, mondRing: 8,   // Mondring
  marken: 87, zahlen: 96,   // Stundenpunkte und die vier Zahlen darüber
  mitte: 100
};

/** Zeit → Winkel. 0 Uhr unten, 12 Uhr oben, im Uhrzeigersinn. */
function uhrWinkel(datum, tagStart) {
  const min = (datum - tagStart) / 60000;
  return (min / 1440) * 360 - 180;
}

const polar = (grad, radius) => {
  const b = (grad - 90) * Math.PI / 180;
  return [UHR.mitte + radius * Math.cos(b), UHR.mitte + radius * Math.sin(b)];
};

/** Ringsegment zwischen zwei Winkeln. */
function segment(von, bis, radius, breite, farbe) {
  let spanne = bis - von;
  if (spanne <= 0) spanne += 360;
  if (spanne >= 359.9) {            // Vollkreis lässt sich nicht als Bogen zeichnen
    return `<circle cx="${UHR.mitte}" cy="${UHR.mitte}" r="${radius}"
      fill="none" stroke="${farbe}" stroke-width="${breite}"/>`;
  }
  const [x1, y1] = polar(von, radius);
  const [x2, y2] = polar(von + spanne, radius);
  const gross = spanne > 180 ? 1 : 0;
  return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${gross} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}"
    fill="none" stroke="${farbe}" stroke-width="${breite}" stroke-linecap="butt"/>`;
}

/** Gradzahl in eine Himmelsrichtung, wie man sie im Alltag nennt. */
function himmelsrichtung(grad) {
  const namen = ['Norden', 'Nordosten', 'Osten', 'Südosten',
                 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
  return `im ${namen[Math.round(((grad % 360) + 360) % 360 / 45) % 8]}`;
}

/** Himmelsrichtung der Sonne — sagt, wo sie auf- und untergeht. */
function sunAzimut(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = (280.459 + 0.98564736 * d) * rad;
  const L = q + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) % 360) * rad - ra;
  const la = lat * rad;
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la));
  return (az / rad + 180) % 360;
}

function renderSonnenuhr() {
  const ziel = $('#sonnenuhr');
  if (!ziel || !place) return '';

  const jetzt = new Date();
  const tagStart = new Date(jetzt); tagStart.setHours(0, 0, 0, 0);
  const ev = sunEvents(jetzt, place.lat, place.lon);
  const w = (t) => (t ? uhrWinkel(new Date(t), tagStart) : null);

  /* Von Mitternacht aus aufgebaut: Nacht, dann die Dämmerungsstufen hinein
     in den Tag und wieder heraus. Fehlt eine Marke (Polarsommer), bleibt der
     darunterliegende Ton stehen. */
  const stufen = [
    { bis: w(ev.astroDaemmerung),     farbe: '#141d16' },   // Nacht
    { bis: w(ev.blaueStundeMorgen),   farbe: '#1b3a6b' },   // astronomische Dämmerung
    { bis: w(ev.aufgang),             farbe: '#3f7fd4' },   // blaue Stunde
    { bis: w(ev.goldenEndeMorgen),    farbe: '#ffb347' },   // goldene Stunde
    { bis: w(ev.goldenStartAbend),    farbe: '#ffd60a' },   // Tag
    { bis: w(ev.untergang),           farbe: '#ffb347' },
    { bis: w(ev.blaueStundeEndeAbend), farbe: '#3f7fd4' },
    { bis: w(ev.astroNacht),          farbe: '#1b3a6b' },
    { bis: 180,                       farbe: '#141d16' }
  ].filter(s => s.bis != null);

  let sonneRing = segment(-180, 179.99, UHR.r, UHR.ring, '#141d16');   // Grundton
  let start = -180;
  for (const s of stufen) {
    if (s.bis > start) sonneRing += segment(start, s.bis, UHR.r, UHR.ring, s.farbe);
    start = s.bis;
  }

  // Mondring: heller, solange der Mond über dem Horizont steht
  const mondStufen = [];
  let vorherOben = moonAltitude(tagStart, place.lat, place.lon) > 0;
  let abschnitt = -180;
  for (let m = 10; m <= 1440; m += 10) {
    const t = new Date(tagStart.getTime() + m * 60000);
    const oben = moonAltitude(t, place.lat, place.lon) > 0;
    if (oben !== vorherOben) {
      mondStufen.push({ von: abschnitt, bis: uhrWinkel(t, tagStart), oben: vorherOben });
      abschnitt = uhrWinkel(t, tagStart);
      vorherOben = oben;
    }
  }
  mondStufen.push({ von: abschnitt, bis: 180, oben: vorherOben });

  const mp = moonPhase();
  let mondRing = '';
  for (const s of mondStufen) {
    mondRing += segment(s.von, s.bis, UHR.innen, UHR.mondRing,
      s.oben ? `rgba(226,232,240,${(0.25 + mp.beleuchtet * 0.6).toFixed(2)})` : 'rgba(255,255,255,.06)');
  }

  // Zeiger und Marken
  const jetztW = uhrWinkel(jetzt, tagStart);
  const [sx, sy] = polar(jetztW, UHR.r);
  const mt = moonTimes(jetzt, place.lat, place.lon);
  const mondJetzt = moonAltitude(jetzt, place.lat, place.lon) > 0;
  const [mx, my] = polar(jetztW, UHR.innen);

  /* Stundenpunkte und die vier Zahlen liegen außen — beide am selben Winkel
     berechnet, damit keine Zahl auf einem Punkt sitzt. */
  const stundenMarken = Array.from({ length: 24 }, (_, s) => {
    if (s % 6 === 0) return '';                 // dort steht die Zahl
    const grad = (s / 24) * 360 - 180;
    const [x, y] = polar(grad, UHR.marken);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s % 3 === 0 ? 1.7 : 1}"
      fill="rgba(255,255,255,${s % 3 === 0 ? '.4' : '.2'})"/>`;
  }).join('');

  const stundenZahlen = [0, 6, 12, 18].map(s => {
    const [x, y] = polar((s / 24) * 360 - 180, UHR.zahlen);
    return `<text class="uhr-std" x="${x.toFixed(1)}" y="${(y + 3.2).toFixed(1)}">${s}</text>`;
  }).join('');

  const naechstes = kommendeSonnenMarke(ev, jetzt);

  ziel.innerHTML = `
    <svg viewBox="-8 -8 216 216" class="uhr-svg" role="img"
         aria-label="Tagesverlauf von Sonne und Mond als Ring">
      ${stundenMarken}
      ${stundenZahlen}
      ${sonneRing}
      ${mondRing}
      <circle class="uhr-punkt-aussen" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5.5"/>
      <circle class="uhr-punkt-innen" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="3.6"
              opacity="${mondJetzt ? 1 : 0.3}"/>
      <g id="uhrGriff" hidden>
        <line class="uhr-strahl" x1="0" y1="0" x2="0" y2="0"/>
        <circle class="uhr-griff" cx="0" cy="0" r="6.5"/>
      </g>
      <circle id="uhrFeld" cx="${UHR.mitte}" cy="${UHR.mitte}" r="${UHR.zahlen}" fill="transparent"/>
    </svg>
    <div class="uhr-mitte">
      <span class="uhr-zeit">${hhmm(jetzt)}</span>
      <span class="uhr-datum">${jetzt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long' })}</span>
      ${naechstes ? `<span class="uhr-next">${esc(naechstes.name)}<br>in ${restZeit(naechstes.t)}</span>` : ''}
    </div>`;

  uhrText(null);
  uhrAbfahrenBinden(tagStart);
  return { ev, mt, mp };
}

/* ── Globus: die zwei Drehungen zum Anfassen ────────────────
   Die Erde dreht sich in 24 Stunden um sich selbst und in einem Jahr um
   die Sonne. Beide Drehungen liegen hier unter demselben Finger: waagerecht
   wischen dreht den Tag, senkrecht wischen schiebt durchs Jahr.

   Gerechnet wird in einem festen Bezugssystem, in dem die Bahnebene die
   XY-Ebene ist. Die Erdachse N steht darin um 23,44° geneigt und zeigt
   IMMER in dieselbe Richtung — genau das macht die Jahreszeiten, und genau
   das sieht man, wenn man durchs Jahr wischt.

   Keine Fremdbibliothek: Eine orthografische Kugel ist ein Skalarprodukt.
   Ein Punkt ist sichtbar, wenn er zur Kamera zeigt, und beleuchtet, wenn er
   zur Sonne zeigt. Mehr braucht es nicht. */
/* r 108 statt 132: Der Rand braucht Platz für die Sonne als Scheibe mit
   Strahlen. Ohne sie sah es aus, „als würde sich die Achse einfach so
   bewegen" — die Neigung wird erst als Neigung ZUR SONNE lesbar. */
const GLOBUS = { w: 320, h: 320, r: 108 };
let globusZeit = null;        // Zeitpunkt, den der Globus zeigt

const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vMul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vKreuz = (a, b) => [a[1] * b[2] - a[2] * b[1],
                          a[2] * b[0] - a[0] * b[2],
                          a[0] * b[1] - a[1] * b[0]];
const vNorm = (a) => { const l = Math.hypot(...a) || 1; return vMul(a, 1 / l); };

/** Alles, was die Lage der Erde zu einem Zeitpunkt beschreibt. */
function globusLage(zeit) {
  const rad = Math.PI / 180;
  const eps = EKLIPTIK * rad;
  /* Achse fest im Raum, um eps aus der Bahnebene gekippt. Die Neigung
     gehört NUR hierher: Sie zusätzlich in die Sonnenrichtung zu rechnen
     verschob die Jahreszeiten um ein Vierteljahr — zur Tagundnachtgleiche
     stand die Sonne dann über dem Wendekreis statt über dem Äquator. */
  const N = [0, Math.sin(eps), Math.cos(eps)];

  /* Ekliptikale Länge der Sonne, von der Erde aus gesehen. Bei 0° steht die
     Sonne im Frühlingspunkt — dann trifft sie den Äquator senkrecht. */
  const tage = (zeit - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const M = rad * ((357.529 + 0.98560028 * tage) % 360);
  const C = 1.915 * Math.sin(M) + 0.02 * Math.sin(2 * M);
  const lam = rad * (((280.459 + 0.98564736 * tage) + C) % 360);

  /* Richtung Erde → Sonne, per Definition in der Bahnebene. Damit gilt
     sin(Sonnenhöhe über dem Äquator) = S·N = sin(eps)·sin(lam): null zur
     Tagundnachtgleiche, ±23,44° zu den Sonnenwenden. */
  const S = [Math.cos(lam), Math.sin(lam), 0];

  // Erdfeste Achsen: e3 = N, e1 senkrecht dazu in der Bahnebene
  const e1 = vNorm(vKreuz([0, 0, 1], N).some(x => x) ? vKreuz([0, 0, 1], N) : [1, 0, 0]);
  const e2 = vKreuz(N, e1);

  /* Drehung so setzen, dass der Punkt unter der Sonne den richtigen
     Längengrad hat: um 12 Uhr UTC steht die Sonne über 0°, je Stunde
     wandert sie 15° nach Westen. */
  const utcStunden = (zeit % 86400000) / 3600000;
  const lonSub = rad * (180 - 15 * utcStunden);
  const lamS = Math.atan2(vDot(S, e2), vDot(S, e1));
  const theta = lamS - lonSub;

  const punkt = (latGrad, lonGrad) => {
    const ph = latGrad * rad, la = lonGrad * rad + theta;
    return vAdd(vAdd(vMul(e1, Math.cos(ph) * Math.cos(la)),
                     vMul(e2, Math.cos(ph) * Math.sin(la))),
                vMul(N, Math.sin(ph)));
  };

  /* Kamera in festem Winkel zur Sonne, damit man immer die Tagseite mit
     der Grenze sieht — stünde sie fest im Raum, schaute man im Winter auf
     die Nachtseite. Der Bildschirm-Hoch ist die Bahnebenen-Normale, sonst
     stünde die Achse immer senkrecht und die Neigung wäre unsichtbar. */
  /* 55° statt 42°: Bei knapperem Winkel füllte die Tagseite fast die ganze
     Scheibe, und die Grenze klebte am Rand. So bleibt immer eine sichtbare
     Nachtsichel — und darum geht es hier. */
  const dreh = 55 * rad;
  const C0 = [S[0] * Math.cos(dreh) - S[1] * Math.sin(dreh),
              S[0] * Math.sin(dreh) + S[1] * Math.cos(dreh), S[2]];
  const kam = vNorm([C0[0], C0[1], C0[2] + 0.34]);
  const rechts = vNorm(vKreuz([0, 0, 1], kam));
  const hoch = vKreuz(kam, rechts);

  return { N, S, punkt, kam, rechts, hoch, e1, e2, theta,
           sichtbar: (p) => vDot(p, kam) > 0,
           hell: (p) => vDot(p, S) > 0,
           bild: (p) => [GLOBUS.w / 2 + vDot(p, rechts) * GLOBUS.r,
                         GLOBUS.h / 2 - vDot(p, hoch) * GLOBUS.r] };
}

let kuestenLinien = null;
/** Die Küsten einmal aus der Textform in Zahlen holen. */
function kuesten() {
  if (kuestenLinien) return kuestenLinien;
  const roh = window.WF_KUESTE;
  if (!roh) return (kuestenLinien = []);
  kuestenLinien = roh.split(';').map(z => z.split(',').map(pp => {
    const [a, b] = pp.split(' ');
    return [+b / 10, +a / 10];              // [Breite, Länge]
  }));
  return kuestenLinien;
}

/* ── Zeichnen auf Canvas statt SVG ──────────────────────────
   Die erste Fassung baute bei jeder Fingerbewegung das komplette SVG als
   Text neu und ließ es den Browser parsen — auf dem iPhone ruckelte das
   Drehen spürbar (Florian: „richtig stockend"). Jetzt: alle Linien EINMAL
   als Einheitsvektoren im erdfesten System vorberechnet; je Bild dreht nur
   noch die Basis (neun Multiplikationen pro Punkt, keine Winkelfunktion),
   gezeichnet wird direkt in ein Canvas, angestoßen höchstens einmal je
   Bildschirmtakt über requestAnimationFrame. */
let globusFest = null;

function globusVektoren() {
  if (globusFest) return globusFest;
  const rad = Math.PI / 180;
  const vek = (la, lo) => [Math.cos(la * rad) * Math.cos(lo * rad),
                           Math.cos(la * rad) * Math.sin(lo * rad),
                           Math.sin(la * rad)];
  const linien = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [];
    for (let lo = -180; lo <= 180; lo += 5) pts.push(vek(lat, lo));
    linien.push({ art: lat === 0 ? 'aequator' : 'netz', pts });
  }
  for (let lo = -180; lo < 180; lo += 30) {
    const pts = [];
    for (let la = -90; la <= 90; la += 5) pts.push(vek(la, lo));
    linien.push({ art: 'netz', pts });
  }
  for (const lat of [EKLIPTIK, -EKLIPTIK]) {
    const pts = [];
    for (let lo = -180; lo <= 180; lo += 5) pts.push(vek(lat, lo));
    linien.push({ art: 'wende', pts });
  }
  for (const kette of kuesten()) {
    linien.push({ art: 'kueste', pts: kette.map(([la, lo]) => vek(la, lo)) });
  }
  globusFest = linien;
  return linien;
}

/** Bogen „am Stück" aus einer ringförmigen Punktliste — siehe Nachtfläche. */
function bogenAmStueck(liste, gilt) {
  const n = liste.length;
  const trifft = liste.map(gilt);
  if (trifft.every(x => x)) return liste.slice();
  if (!trifft.some(x => x)) return [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (trifft[i] && !trifft[(i - 1 + n) % n]) { start = i; break; }
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!trifft[i]) break;
    out.push(liste[i]);
  }
  return out;
}

function kreisUm(achse) {
  const u = vNorm(vKreuz(achse, [0, 0, 1]).some(x => x)
    ? vKreuz(achse, [0, 0, 1]) : vKreuz(achse, [1, 0, 0]));
  const v = vKreuz(achse, u);
  const pts = [];
  for (let a = 0; a < 360; a += 2) {
    const w = a * Math.PI / 180;
    pts.push(vAdd(vMul(u, Math.cos(w)), vMul(v, Math.sin(w))));
  }
  return pts;
}

function globusMalen(zeit) {
  const wrap = $('#globus');
  if (!wrap || !place) return;
  let cv = wrap.querySelector('canvas');
  if (!cv) {
    wrap.innerHTML = '<canvas class="gl-canvas"></canvas>'
      + '<button class="gl-jetzt" id="globusJetzt" hidden>Jetzt</button>';
    cv = wrap.querySelector('canvas');
    $('#globusJetzt').addEventListener('click', (e) => {
      e.stopPropagation();
      globusZeit = null;
      globusZeichnen();
    });
  }
  /* Der Rückweg ins Jetzt: Wer durchs Jahr gewischt hat, fand vorher nur
     über Neuladen zurück. Der Knopf zeigt sich, sobald die gezeigte Zeit
     mehr als eine Minute vom Jetzt abweicht. */
  const jetztKnopf = $('#globusJetzt');
  if (jetztKnopf) jetztKnopf.hidden = Math.abs(zeit - Date.now()) < 60000;
  const w = GLOBUS.w, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = w * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, w);

  const L = globusLage(zeit);
  const R = GLOBUS.r;

  /* Erst die Sonnenrichtung, dann die Mitte: Kugel UND Sonne bilden zusammen
     das Bild, und die Sonne sitzt immer seitlich davon. Mittig war bisher
     nur die Kugel — dadurch ragte die Sonne links über den Rand und die
     Erde wirkte angeschnitten. Jetzt wird der umschließende Kasten aus
     beidem gebildet und der ins Bild gerückt. */
  const SONNE_WEG = R + 42, SONNE_AUSSEN = 25;
  const sdx0 = vDot(L.S, L.rechts), sdy0 = -vDot(L.S, L.hoch);
  const sl0 = Math.hypot(sdx0, sdy0) || 1;
  const sn = [sdx0 / sl0, sdy0 / sl0];
  const kastenX = [Math.min(-R, sn[0] * SONNE_WEG - SONNE_AUSSEN),
                   Math.max(R, sn[0] * SONNE_WEG + SONNE_AUSSEN)];
  const kastenY = [Math.min(-R, sn[1] * SONNE_WEG - SONNE_AUSSEN),
                   Math.max(R, sn[1] * SONNE_WEG + SONNE_AUSSEN)];
  const Mx = w / 2 - (kastenX[0] + kastenX[1]) / 2;
  const My = w / 2 - (kastenY[0] + kastenY[1]) / 2;

  // Erdfeste Basis für diesen Moment — der einzige Ort mit Winkelfunktionen
  const ct = Math.cos(L.theta), st = Math.sin(L.theta);
  const E1 = vAdd(vMul(L.e1, ct), vMul(L.e2, st));
  const E2 = vAdd(vMul(L.e1, -st), vMul(L.e2, ct));
  const N = L.N, kam = L.kam, re = L.rechts, ho = L.hoch;

  /** Erdfester Einheitsvektor → [x, y, vorn?] in einem Rutsch. */
  const P = (v) => {
    const px = v[0] * E1[0] + v[1] * E2[0] + v[2] * N[0];
    const py = v[0] * E1[1] + v[1] * E2[1] + v[2] * N[1];
    const pz = v[0] * E1[2] + v[1] * E2[2] + v[2] * N[2];
    return [Mx + (px * re[0] + py * re[1] + pz * re[2]) * R,
            My - (px * ho[0] + py * ho[1] + pz * ho[2]) * R,
            px * kam[0] + py * kam[1] + pz * kam[2] > 0];
  };
  const Pfrei = (p) => [Mx + vDot(p, re) * R, My - vDot(p, ho) * R];

  // Kugel
  ctx.beginPath(); ctx.arc(Mx, My, R, 0, 7);
  ctx.fillStyle = '#123055'; ctx.fill();

  // Alle Linien, nach Art gebündelt (ein Stilwechsel je Art, nicht je Linie)
  const stile = {
    netz:     { s: 'rgba(255,255,255,.13)', b: 0.6, strich: null },
    aequator: { s: 'rgba(255,255,255,.30)', b: 0.9, strich: null },
    wende:    { s: 'rgba(255,214,10,.34)',  b: 0.7, strich: [3, 3] },
    kueste:   { s: '#6fd6a0',               b: 0.9, strich: null }
  };
  const alle = globusVektoren();
  for (const art of ['netz', 'aequator', 'wende', 'kueste']) {
    const st2 = stile[art];
    ctx.strokeStyle = st2.s; ctx.lineWidth = st2.b;
    ctx.setLineDash(st2.strich || []);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const linie of alle) {
      if (linie.art !== art) continue;
      let vorher = false;
      for (const v of linie.pts) {
        const [x, y, vorn] = P(v);
        if (vorn && vorher) ctx.lineTo(x, y);
        else if (vorn) ctx.moveTo(x, y);
        vorher = vorn;
      }
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Nachtseite + Tag-Nacht-Grenze (Logik wie gehabt, nur als Canvas-Pfad)
  const grenzeSicht = bogenAmStueck(kreisUm(L.S), L.sichtbar);
  const randDunkel = bogenAmStueck(kreisUm(kam), (q) => !L.hell(q));
  if (randDunkel.length > 1) {
    ctx.beginPath();
    const start = Pfrei(randDunkel[0]);
    ctx.moveTo(start[0], start[1]);
    for (const q of randDunkel.slice(1)) { const b = Pfrei(q); ctx.lineTo(b[0], b[1]); }
    if (grenzeSicht.length > 1) {
      const ende = Pfrei(randDunkel[randDunkel.length - 1]);
      const gA = Pfrei(grenzeSicht[0]);
      const gE = Pfrei(grenzeSicht[grenzeSicht.length - 1]);
      const nah = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2;
      const teil = nah(ende, gA) <= nah(ende, gE) ? grenzeSicht : [...grenzeSicht].reverse();
      for (const q of teil) { const b = Pfrei(q); ctx.lineTo(b[0], b[1]); }
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(4,10,22,.66)'; ctx.fill();
  }
  if (grenzeSicht.length > 1) {
    ctx.beginPath();
    const g0 = Pfrei(grenzeSicht[0]); ctx.moveTo(g0[0], g0[1]);
    for (const q of grenzeSicht.slice(1)) { const b = Pfrei(q); ctx.lineTo(b[0], b[1]); }
    ctx.strokeStyle = 'rgba(255,214,10,.6)'; ctx.lineWidth = 1; ctx.stroke();
  }

  /* ── Die Sonne als Körper, nicht als Punkt ────────────────
     Vorher markierte ein gelber Punkt auf der ERDE die Stelle unter der
     Sonne — Florian: „da ist einfach so ein gelber Punkt", und die Neigung
     der Achse wirkte wie ein Wackeln der Erde selbst. Jetzt steht die
     Sonne als Scheibe neben der Kugel, mit parallelen Strahlen darauf zu.
     Weil die Kamera das ganze Jahr im festen Winkel zur Sonne steht,
     bleibt sie am Bildschirm an derselben Stelle — und man sieht beim
     Wischen durchs Jahr, wie sich die ACHSE gegen das Licht neigt. Genau
     das ist die Schiefe der Ekliptik. */
  const sonneP = [Mx + sn[0] * SONNE_WEG, My + sn[1] * SONNE_WEG];
  const quer = [-sn[1], sn[0]];

  // Parallele Strahlen — Sonnenlicht kommt als Bündel, nicht aus einem Punkt
  ctx.strokeStyle = 'rgba(255,214,10,.35)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const v of [-30, -15, 0, 15, 30]) {
    const ax = sonneP[0] + quer[0] * v - sn[0] * 20;
    const ay = sonneP[1] + quer[1] * v - sn[1] * 20;
    const laenge = SONNE_WEG - 20 - Math.sqrt(Math.max(0, R * R - v * v)) - 6;
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - sn[0] * laenge, ay - sn[1] * laenge);
  }
  ctx.stroke();

  ctx.beginPath(); ctx.arc(sonneP[0], sonneP[1], 17, 0, 7);
  ctx.fillStyle = '#ffd60a'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,214,10,.5)'; ctx.lineWidth = 1.2; ctx.beginPath();
  for (let k = 0; k < 12; k++) {
    const a = k * Math.PI / 6;
    ctx.moveTo(sonneP[0] + Math.cos(a) * 20, sonneP[1] + Math.sin(a) * 20);
    ctx.lineTo(sonneP[0] + Math.cos(a) * 25, sonneP[1] + Math.sin(a) * 25);
  }
  ctx.stroke();
  ctx.font = '600 10px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,214,10,.85)';
  ctx.textAlign = 'center';
  ctx.fillText('Sonne', sonneP[0] - sn[0] * 34, sonneP[1] - sn[1] * 34 + 3);
  ctx.textAlign = 'left';

  // Der eigene Ort — mit Namen, damit klar ist, welcher Punkt man selbst ist
  const eigen = L.punkt(place.lat, place.lon);
  if (L.sichtbar(eigen)) {
    const [ox, oy] = Pfrei(eigen);
    ctx.beginPath(); ctx.arc(ox, oy, 4, 0, 7);
    ctx.fillStyle = L.hell(eigen) ? '#ff6b5e' : '#8fa6c4';
    ctx.fill();
    ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '600 10px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(232,238,248,.85)';
    ctx.textAlign = ox > w - 74 ? 'right' : 'left';
    ctx.fillText(place.name || 'dein Ort', ox + (ox > w - 74 ? -9 : 9), oy - 7);
  }

  // Erdachse mit Polpunkt
  const nP = Pfrei(vMul(L.N, 1.12)), sP = Pfrei(vMul(L.N, -1.12));
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(sP[0], sP[1]); ctx.lineTo(nP[0], nP[1]); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(nP[0], nP[1], 2.6, 0, 7);
  ctx.fillStyle = '#fff'; ctx.fill();

  // Rand
  ctx.beginPath(); ctx.arc(Mx, My, R, 0, 7);
  ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1; ctx.stroke();
}

/* ── Die Weltraum-Ansicht: die Erde AUF ihrer Bahn ──────────
   Florian: „dass man sieht, wo die Erde gerade im Weltall bei der Sonne
   ist". Sonne in der Mitte, die Bahn als flache Ellipse, die Erde wandert
   darauf — und ihre Achse zeigt an JEDER Stelle in dieselbe Richtung.
   Zwölf Positionen, ein Winkel: Das ist das ganze Geheimnis der
   Jahreszeiten, und hier steht es als Bild.

   Die Monate am Rand sind antippbar, die Erde lässt sich auch direkt an
   der Bahn entlangziehen. Beides stellt dieselbe Zeit, die auch der
   Globus darüber zeigt — eine Zeit, zwei Blickwinkel. */
const BAHN = { w: 320, h: 190, cx: 160, cy: 96, rx: 118, quetsch: 0.36 };
const BAHN_BLICK = -0.6;          // Blickdrehung: so steht die Achse sichtbar schräg
let bahnJahrDaten = null;

function bahnPunkt(weltXY) {
  const c = Math.cos(BAHN_BLICK), s2 = Math.sin(BAHN_BLICK);
  const x = weltXY[0] * c - weltXY[1] * s2;
  const y = weltXY[0] * s2 + weltXY[1] * c;
  return [BAHN.cx + x * BAHN.rx, BAHN.cy - y * BAHN.rx * BAHN.quetsch];
}

function bahnDaten() {
  const jahr = new Date().getFullYear();
  if (bahnJahrDaten?.jahr === jahr) return bahnJahrDaten;
  const tage = [];
  for (let t = 0; t < 365; t++) {
    const ms = Date.UTC(jahr, 0, 1 + t, 12);
    const L = globusLage(ms);
    const [x, y] = bahnPunkt([-L.S[0], -L.S[1]]);   // Erde = Gegenrichtung der Sonne
    tage.push({ ms, x, y });
  }
  /* Auf den Monatsersten, nicht die Monatsmitte: Wer „Jul" antippt,
     erwartet den 1. Juli. Die Marke sitzt damit auch dort, wo der Monat
     auf der Bahn beginnt. */
  const monate = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'].map((name, m) => {
    const ms = Date.UTC(jahr, m, 1, 12);
    const L = globusLage(ms);
    const w = [-L.S[0], -L.S[1]];
    const [x, y] = bahnPunkt(w);
    const [ax, ay] = bahnPunkt([w[0] * 1.24, w[1] * 1.24]);
    return { name, ms, x, y, ax, ay };
  });
  return (bahnJahrDaten = { jahr, tage, monate });
}

function bahnMalen(zeit) {
  const wrap = $('#bahnWrap');
  if (!wrap) return;
  let cv = wrap.querySelector('canvas');
  if (!cv) {
    wrap.innerHTML = '<canvas class="gl-canvas bahn-canvas"></canvas>';
    cv = wrap.querySelector('canvas');
    bahnBinden(cv);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== BAHN.w * dpr) { cv.width = BAHN.w * dpr; cv.height = BAHN.h * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, BAHN.w, BAHN.h);
  const d = bahnDaten();

  // Bahn als geschlossener Zug durch die echten Tagespositionen
  ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = .8;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  d.tage.forEach((g, i) => i ? ctx.lineTo(g.x, g.y) : ctx.moveTo(g.x, g.y));
  ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);

  // Sonne in der Mitte
  ctx.beginPath(); ctx.arc(BAHN.cx, BAHN.cy, 10, 0, 7);
  ctx.fillStyle = '#ffd60a'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,214,10,.5)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4;
    ctx.moveTo(BAHN.cx + Math.cos(a) * 12, BAHN.cy + Math.sin(a) * 12);
    ctx.lineTo(BAHN.cx + Math.cos(a) * 15, BAHN.cy + Math.sin(a) * 15);
  }
  ctx.stroke();

  // Monatsmarken samt Namen — antippbar
  ctx.font = '600 8.5px -apple-system, sans-serif';
  for (const m of d.monate) {
    ctx.beginPath(); ctx.arc(m.x, m.y, 1.6, 0, 7);
    ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fill();
    ctx.fillStyle = 'rgba(232,238,248,.55)';
    ctx.textAlign = 'center';
    ctx.fillText(m.name, m.ax, m.ay + 3);
  }

  // Die Erde an ihrer heutigen Stelle — Tagesposition, Zeit interessiert hier nicht
  const jetzt = new Date(zeit);
  const tIdx = Math.max(0, Math.min(364,
    Math.floor((Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate())
      - Date.UTC(d.jahr, 0, 1)) / 86400000)));
  const g = d.tage[tIdx];

  // Nachtseite der Mini-Erde: die sonnenabgewandte Hälfte
  const zurSonne = Math.atan2(BAHN.cy - g.y, BAHN.cx - g.x);
  ctx.beginPath(); ctx.arc(g.x, g.y, 7, 0, 7);
  ctx.fillStyle = '#2f6fb5'; ctx.fill();
  ctx.beginPath();
  ctx.arc(g.x, g.y, 7, zurSonne + Math.PI / 2, zurSonne + 3 * Math.PI / 2);
  ctx.fillStyle = 'rgba(4,10,22,.75)'; ctx.fill();
  ctx.beginPath(); ctx.arc(g.x, g.y, 7, 0, 7);
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = .8; ctx.stroke();

  /* Die Achse: an jeder Position DIESELBE Richtung. Projiziert aus
     N = (0, sin eps, cos eps) mit derselben Blickdrehung wie die Bahn. */
  const eps = EKLIPTIK * Math.PI / 180;
  const c = Math.cos(BAHN_BLICK), s2 = Math.sin(BAHN_BLICK);
  const nx = -Math.sin(eps) * s2;
  const nSchirm = [nx, -(Math.sin(eps) * c * BAHN.quetsch + Math.cos(eps))];
  const nl = Math.hypot(...nSchirm);
  const dA = [nSchirm[0] / nl * 12, nSchirm[1] / nl * 12];
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.1;
  ctx.setLineDash([2.5, 2]);
  ctx.beginPath();
  ctx.moveTo(g.x - dA[0], g.y - dA[1]); ctx.lineTo(g.x + dA[0], g.y + dA[1]);
  ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(g.x + dA[0], g.y + dA[1], 1.8, 0, 7);
  ctx.fillStyle = '#fff'; ctx.fill();
}

function bahnBinden(cv) {
  const springe = (clientX, clientY) => {
    const b = cv.getBoundingClientRect();
    if (!b.width) return;
    const x = (clientX - b.left) / b.width * BAHN.w;
    const y = (clientY - b.top) / b.height * BAHN.h;
    const d = bahnDaten();
    /* Erst die Monatsnamen (großzügige Trefferfläche), sonst der nächste
       Tag auf der Bahn — so ist Tippen UND Ziehen dieselbe Geste. */
    for (const m of d.monate) {
      if ((m.ax - x) ** 2 + (m.ay - y) ** 2 < 14 ** 2) return setzeTag(m.ms);
    }
    let best = null, dist = Infinity;
    for (const g of d.tage) {
      const dd = (g.x - x) ** 2 + (g.y - y) ** 2;
      if (dd < dist) { dist = dd; best = g; }
    }
    if (best && dist < 45 ** 2) setzeTag(best.ms);
  };
  const setzeTag = (ms) => {
    /* Der Sprung wechselt den TAG, nicht die Uhrzeit — wie beim
       senkrechten Wischen am Globus. */
    const alt = new Date(globusZeit ?? Date.now());
    const ziel = new Date(ms);
    ziel.setUTCHours(alt.getUTCHours(), alt.getUTCMinutes(), 0, 0);
    globusZeit = ziel.getTime();
    globusZeichnen();
  };
  const los = (ev) => {
    ev.stopPropagation(); ev.preventDefault();
    const p = ev.touches?.[0] || ev;
    springe(p.clientX, p.clientY);
    const zug = (e) => {
      e.preventDefault();
      const q = e.touches?.[0] || e;
      springe(q.clientX, q.clientY);
    };
    const ende = () => {
      window.removeEventListener('pointermove', zug);
      window.removeEventListener('pointerup', ende);
      window.removeEventListener('pointercancel', ende);
    };
    window.addEventListener('pointermove', zug);
    window.addEventListener('pointerup', ende);
    window.addEventListener('pointercancel', ende);
  };
  cv.addEventListener('pointerdown', los);
}

// Höchstens ein Bild je Bildschirmtakt, egal wie schnell der Finger meldet
let globusRaf = false;
let globusFormat = null;
function globusZeichnen() {
  if (globusRaf) return;
  globusRaf = true;
  requestAnimationFrame(() => {
    globusRaf = false;
    const zeit = globusZeit ?? Date.now();
    globusMalen(zeit);
    bahnMalen(zeit);
    globusText(zeit, globusLage(zeit));
  });
}

function renderGlobus() {
  if (!$('#globus') || !place) return;
  const zeit = globusZeit ?? Date.now();
  globusMalen(zeit);
  bahnMalen(zeit);
  globusText(zeit, globusLage(zeit));
  globusBinden();
}

function globusText(zeit, L) {
  const el = $('#globusText');
  if (!el) return;
  const d = new Date(zeit);
  const eigen = L.punkt(place.lat, place.lon);
  const hell = L.hell(eigen);
  // Wo steht die Sonne senkrecht?
  const dek = Math.asin(vDot(L.S, L.N)) * 180 / Math.PI;
  const zone = data?.timezone || 'Europe/Berlin';
  /* Die Formatierer sind teuer im Aufbau und liefen vorher bei JEDEM Bild
     neu an — beim Drehen sechzigmal je Sekunde. Einmal je Zeitzone reicht. */
  if (globusFormat?.zone !== zone) {
    globusFormat = {
      zone,
      uhr: new Intl.DateTimeFormat('de-DE', { timeZone: zone, hour: '2-digit',
        minute: '2-digit', hour12: false }),
      datum: new Intl.DateTimeFormat('de-DE', { timeZone: zone, day: 'numeric',
        month: 'long' })
    };
  }
  const uhr = globusFormat.uhr.format(d);
  const datum = globusFormat.datum.format(d);
  el.innerHTML = `<b>${datum} · ${uhr} Uhr</b> · ${
      hell ? 'bei dir ist es hell' : 'bei dir ist es dunkel'}`
    /* Kurz halten: Der lange Bedienhinweis brauchte zwei Zeilen und drückte
       den erklärenden Text unter den Bildschirmrand. */
    + `<br><i>Sonne senkrecht über ${Math.abs(dek).toFixed(1)}° ${dek >= 0 ? 'Nord' : 'Süd'}`
    + ` · quer wischen = Tag, hoch/runter = Jahr</i>`;
}

function globusBinden() {
  const feld = $('#globus')?.querySelector('canvas');
  if (!feld || feld.dataset.gebunden) return;
  feld.dataset.gebunden = '1';
  let start = null, startZeit = 0;
  const los = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    const p = ev.touches?.[0] || ev;
    start = [p.clientX, p.clientY];
    startZeit = globusZeit ?? Date.now();
    const zug = (e) => {
      e.preventDefault();
      const q = e.touches?.[0] || e;
      const b = feld.getBoundingClientRect();
      if (!b.width) return;
      /* Eine Bildbreite = ein ganzer Tag, eine Bildhöhe = ein halbes Jahr.
         So liegen beide Drehungen unter demselben Finger.
         Senkrecht wird auf GANZE Tage gerundet: Sonst verschöbe das Wischen
         durchs Jahr nebenbei die Uhrzeit, und man wüsste nicht mehr, ob sich
         gerade die Jahreszeit oder der Tag geändert hat. */
      const dx = (q.clientX - start[0]) / b.width;
      const dy = (q.clientY - start[1]) / b.height;
      const tage = Math.round(dy * 182.5);
      globusZeit = startZeit + dx * 86400000 + tage * 86400000;
      globusZeichnen();
    };
    const ende = () => {
      window.removeEventListener('pointermove', zug);
      window.removeEventListener('pointerup', ende);
      window.removeEventListener('pointercancel', ende);
    };
    window.addEventListener('pointermove', zug);
    window.addEventListener('pointerup', ende);
    window.addEventListener('pointercancel', ende);
  };
  feld.addEventListener('pointerdown', los);
}

/* ── Licht im Jahr ──────────────────────────────────────────
   Ringuhr und Bogen zeigen einen Tag. Diese Ansicht zeigt das Jahr — und
   den Tag gleich mit: Waagerecht laufen die 365 Tage, senkrecht die 24
   Stunden. Ein einzelner Tag ist damit die senkrechte Scheibe durch das
   Bild, und die Farben sind dieselben wie im Ring. Man sieht die
   Lichtsichel im Sommer aufgehen und im Winter zuschnüren — das ist die
   Schiefe der Ekliptik (23,44°), sichtbar gemacht.

   Warum nicht sunEvents für alle 365 Tage? Das tastet je Tag 1440 Minuten
   ab — über ein Jahr wären das über eine halbe Million Rechnungen und ein
   spürbares Hängen. Zum ZEICHNEN genügt die geschlossene Formel über den
   Stundenwinkel: Bei 300 Pixeln Breite entspricht ein Pixel gut sechs
   Minuten, da fällt ihre Ungenauigkeit von ein bis zwei Minuten nicht auf.
   Für die abgelesenen ZAHLEN wird dann doch sunEvents gefragt — aber nur
   für den einen Tag unter dem Finger. */
const EKLIPTIK = 23.44;
/* Höher als vorher (206 statt 168 Einheiten für 24 Stunden): Bei sieben
   Pixeln je Stunde lagen Aufgang und Untergang zu dicht beieinander, um
   den Verlauf abzulesen. */
const JAHR = { w: 360, h: 246, links: 24, rechts: 20, oben: 8, unten: 214 };
let jahrDaten = null;          // { schluessel, tage: [...] }

/** Ortszeit-Stunde eines UTC-Zeitpunkts in der Zeitzone des Ortes.
    Über Intl, damit die Sommerzeit für JEDEN Tag stimmt — ein einzelner
    Versatz von heute läge im Winterhalbjahr eine Stunde daneben. */
function stundeInZone(datum, zone) {
  try {
    const teile = new Intl.DateTimeFormat('de-DE', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(datum);
    const h = Number(teile.find(x => x.type === 'hour')?.value);
    const m = Number(teile.find(x => x.type === 'minute')?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h + m / 60 : null;
  } catch { return null; }
}

/** Sonnenstands-Schwellen eines Tages, geschlossen gerechnet. */
function jahrTag(jdMitternacht, lat, lon) {
  const rad = Math.PI / 180;
  const n = Math.ceil(jdMitternacht - 2451545.0 + 0.0008);
  const nStern = n - lon / 360;
  const Mgrad = (357.5291 + 0.98560028 * nStern) % 360;
  const M = rad * Mgrad;
  const C = 1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M);
  const lambda = rad * ((Mgrad + C + 180 + 102.9372) % 360);
  const transit = 2451545.0 + nStern + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * lambda);
  const dec = Math.asin(Math.sin(lambda) * Math.sin(rad * EKLIPTIK));
  const out = { transit, dec: dec / rad };
  for (const [name, hoehe] of [['tag', 6], ['gold', -0.833], ['blau', -6],
                               ['naut', -12], ['astro', -18]]) {
    const cosW = (Math.sin(rad * hoehe) - Math.sin(rad * lat) * Math.sin(dec))
               / (Math.cos(rad * lat) * Math.cos(dec));
    /* Über 1: Die Sonne steigt nie so hoch (Polarnacht). Unter -1: Sie
       sinkt nie so tief — dann füllt die Stufe die ganze Spalte, sonst
       riss die Fläche im Hochsommer unten aus dem Bild. */
    out[name] = cosW > 1 ? null : cosW < -1 ? 'immer'
      : [transit - Math.acos(cosW) / rad / 360, transit + Math.acos(cosW) / rad / 360];
  }
  return out;
}

function baueJahrDaten() {
  if (!place) return null;
  const zone = data?.timezone || 'UTC';
  const jahr = new Date().getFullYear();
  const schluessel = `${place.lat.toFixed(3)},${place.lon.toFixed(3)},${zone},${jahr}`;
  if (jahrDaten?.schluessel === schluessel) return jahrDaten;

  const tage = [];
  for (let t = 0; t < 365; t++) {
    const ms = Date.UTC(jahr, 0, 1 + t);
    const jd = ms / 86400000 + 2440587.5;
    const roh = jahrTag(jd, place.lat, place.lon);
    const stunde = (jdWert) => {
      const h = stundeInZone(new Date((jdWert - 2440587.5) * 86400000), zone);
      if (h == null) return null;
      /* Ereignisse vor Mitternacht Ortszeit erscheinen als 23 Uhr des
         Vortages — auf die Ränder klemmen, sonst springt die Fläche. */
      const utcH = (jdWert - jd) * 24;
      return utcH < -1 ? 0 : utcH > 25 ? 24 : h;
    };
    const z = {};
    for (const k of ['tag', 'gold', 'blau', 'naut', 'astro']) {
      const v = roh[k];
      if (v === null) { z[k] = null; continue; }
      if (v === 'immer') { z[k] = [0, 24]; continue; }
      const a = stunde(v[0]), b = stunde(v[1]);
      z[k] = (a == null || b == null || b < a) ? null : [a, b];
    }
    tage.push({ t, ms, z, dec: roh.dec });
  }
  jahrDaten = { schluessel, tage, zone, jahr };
  return jahrDaten;
}

/** Tagesindex → die vier Eckpunkte des Jahres (aus den Daten, nicht geraten). */
function jahrEckpunkte(tage) {
  const laenge = tage.map(g => (g.z.gold ? g.z.gold[1] - g.z.gold[0] : null));
  let iMax = 0, iMin = 0;
  laenge.forEach((l, i) => {
    if (l == null) return;
    if (laenge[iMax] == null || l > laenge[iMax]) iMax = i;
    if (laenge[iMin] == null || l < laenge[iMin]) iMin = i;
  });
  // Tagundnachtgleiche: wo die Länge die zwölf Stunden kreuzt
  const kreuz = [];
  for (let i = 1; i < laenge.length; i++) {
    if (laenge[i - 1] == null || laenge[i] == null) continue;
    if ((laenge[i - 1] - 12) * (laenge[i] - 12) <= 0) kreuz.push(i);
  }
  return { iMax, iMin, kreuz: kreuz.slice(0, 2) };
}

function renderJahrBand() {
  const ziel = $('#jahrBand');
  if (!ziel || !place) return;
  const d = baueJahrDaten();
  if (!d) return;
  const { tage } = d;
  const J = JAHR;
  const X = (t) => J.links + t / 364 * (J.w - J.links - J.rechts);
  const Y = (h) => J.oben + h / 24 * (J.unten - J.oben);

  let flaechen = `<rect x="${J.links}" y="${J.oben}" width="${J.w - J.links - J.rechts}"
    height="${J.unten - J.oben}" fill="#141d16"/>`;
  /* Vorher lagen hier drei Blautöne übereinander — nebeneinander waren sie
     nicht mehr auseinanderzuhalten und ergaben nur Matsch. Die nautische
     Stufe ist raus; übrig bleiben Dämmerung, blaue Stunde, goldene Stunde,
     Tag. Vier Stufen kann das Auge trennen, sechs nicht. */
  for (const [name, farbe] of [['astro', '#1e3f74'],
                               ['blau', '#4a8ede'], ['gold', '#ffb347'], ['tag', '#ffd60a']]) {
    const oben = [], unten = [];
    for (const g of tage) {
      const v = g.z[name];
      if (!v) continue;
      oben.push(`${X(g.t).toFixed(1)},${Y(v[0]).toFixed(1)}`);
      unten.push(`${X(g.t).toFixed(1)},${Y(v[1]).toFixed(1)}`);
    }
    if (oben.length < 2) continue;
    flaechen += `<path class="jb-flaeche" d="M${oben.join(' L')} L${
      unten.reverse().join(' L')} Z" fill="${farbe}"/>`;
  }

  /* Alle drei Stunden eine Linie statt alle sechs: Wer wissen will, wann
     die Sonne im Oktober untergeht, musste vorher zwischen 18 und 24 raten. */
  let gitter = '';
  for (let h = 0; h <= 24; h += 3) {
    const stark = h % 6 === 0;
    gitter += `<line class="${stark ? 'jb-linie' : 'jb-linie-fein'}" x1="${J.links}"
        y1="${Y(h).toFixed(1)}" x2="${J.w - J.rechts}" y2="${Y(h).toFixed(1)}"/>
      <text class="jb-achse" x="${J.links - 3}" y="${(Y(h) + 2.6).toFixed(1)}"
        text-anchor="end">${h}</text>`;
  }
  /* Drei Buchstaben statt einem: „J F M A M J J A S O N D" hatte zweimal J
     und zweimal M — man wusste nicht, wo man ist. Beschriftet wird jeder
     zweite Monat, die Striche stehen weiter bei jedem. */
  const namen = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  namen.forEach((m, i) => {
    const t0 = Math.round(i / 12 * 365);
    if (i % 2 === 0) {
      gitter += `<text class="jb-achse" x="${X(Math.min(364, t0 + 15)).toFixed(1)}"
        y="${J.unten + 11}" text-anchor="middle">${m}</text>`;
    }
    if (i) gitter += `<line class="jb-monat" x1="${X(t0).toFixed(1)}" y1="${J.oben}"
      x2="${X(t0).toFixed(1)}" y2="${J.unten}"/>`;
  });

  /* Die eigentliche Kurve: Aufgang und Untergang als gezogene Linien. Als
     bloße Kante zwischen zwei Farbflächen war der Verlauf weich und schwer
     zu verfolgen — genau das war Florians Einwand. */
  let kurven = '';
  for (const rand of [0, 1]) {
    const pts = tage.filter(g => g.z.gold)
      .map(g => `${X(g.t).toFixed(1)},${Y(g.z.gold[rand]).toFixed(1)}`);
    if (pts.length > 1) kurven += `<path class="jb-kurve" fill="none" d="M${pts.join(' L')}"/>`;
  }

  const eck = jahrEckpunkte(tage);
  let marken = '';
  const setzeMarke = (i, txt) => {
    marken += `<line class="jb-marke" x1="${X(i).toFixed(1)}" y1="${J.oben}"
      x2="${X(i).toFixed(1)}" y2="${J.unten}"/>
      <text class="jb-markentext" x="${X(i).toFixed(1)}" y="${J.unten + 22}"
        text-anchor="middle">${txt}</text>`;
  };
  setzeMarke(eck.iMax, 'längster Tag');
  setzeMarke(eck.iMin, 'kürzester');
  // „gleich" verstand niemand — hier steht, was gleich ist
  eck.kreuz.forEach(i => setzeMarke(i, 'Tag = Nacht'));

  const jetzt = new Date();
  const heuteT = Math.max(0, Math.min(364,
    Math.floor((jetzt - new Date(jetzt.getFullYear(), 0, 1)) / 864e5)));
  const heuteH = (stundeInZone(jetzt, d.zone) ?? jetzt.getHours());
  const kreuzJetzt = `
    <line class="jb-heute" x1="${X(heuteT).toFixed(1)}" y1="${J.oben}"
          x2="${X(heuteT).toFixed(1)}" y2="${J.unten}"/>
    <line class="jb-jetzt" x1="${J.links}" y1="${Y(heuteH).toFixed(1)}"
          x2="${J.w - J.rechts}" y2="${Y(heuteH).toFixed(1)}"/>
    <circle class="jb-punkt" cx="${X(heuteT).toFixed(1)}" cy="${Y(heuteH).toFixed(1)}" r="3.4"/>`;

  ziel.innerHTML = `
    <svg viewBox="0 0 ${J.w} ${J.h}" class="jb-svg" role="img"
         aria-label="Helligkeit über das ganze Jahr: waagerecht die Tage, senkrecht die Stunden">
      ${flaechen}${gitter}${kurven}${marken}${kreuzJetzt}
      <g id="jahrGriff" class="jb-griff" hidden>
        <line class="jb-griff-linie" x1="0" y1="${J.oben}" x2="0" y2="${J.unten}"/>
      </g>
      <rect id="jahrFeld" x="0" y="0" width="${J.w}" height="${J.h}" fill="transparent"/>
    </svg>
    <p class="jb-legende">
      <i style="background:#ffd60a"></i>Tag
      <i style="background:#ffb347"></i>golden
      <i style="background:#4a8ede"></i>blau
      <i style="background:#1e3f74"></i>Dämmerung
      <i style="background:#141d16;border:1px solid rgba(255,255,255,.18)"></i>Nacht
    </p>
    ${jahrBahnBild()}
    <p class="jb-warum">Die Erdachse steht <b>${EKLIPTIK.toFixed(2).replace('.', ',')}°</b> schief und zeigt immer
      in dieselbe Richtung — das ist die <b>Schiefe der Ekliptik</b>. Im Juni neigt sich die
      Nordhalbkugel zur Sonne, im Dezember weg. Nicht die Entfernung macht die Jahreszeiten:
      Im Januar ist die Erde der Sonne sogar am nächsten.</p>`;

  jahrText(null);
  jahrAbfahrenBinden(heuteT);
}

/** Die Erdbahn als Streifen: vier Stationen, die Achse überall gleich
    geneigt. Ein Streifen statt einer Ellipse — auf dem Handy ist er breit
    und flach, und die vier Stationen sind das, worauf es ankommt. */
function jahrBahnBild() {
  const B = { w: 360, h: 74, mitte: 37 };
  const sonneX = 180;
  let out = `<svg viewBox="0 0 ${B.w} ${B.h}" class="jb-bahn" role="img"
    aria-label="Die Erde umrundet die Sonne, ihre Achse bleibt gleich geneigt">
    <line class="jb-bahnlinie" x1="14" y1="${B.mitte}" x2="${B.w - 14}" y2="${B.mitte}"/>
    <circle class="jb-sonne" cx="${sonneX}" cy="${B.mitte}" r="11"/>`;
  const kipp = EKLIPTIK * Math.PI / 180;
  const stationen = [
    { x: 40,  txt: 'Juni',      zur: 1 },
    { x: 110, txt: 'September', zur: 0 },
    { x: 250, txt: 'Dezember',  zur: -1 },
    { x: 320, txt: 'März',      zur: 0 }
  ];
  for (const st of stationen) {
    /* Die Achse zeigt IMMER gleich — deshalb überall derselbe Winkel.
       Genau das ist der Punkt des Bildes. */
    const ax = Math.sin(kipp) * 13, ay = -Math.cos(kipp) * 13;
    out += `
      <circle class="jb-erde" cx="${st.x}" cy="${B.mitte}" r="9"/>
      <line class="jb-achse2" x1="${(st.x - ax).toFixed(1)}" y1="${(B.mitte - ay).toFixed(1)}"
            x2="${(st.x + ax).toFixed(1)}" y2="${(B.mitte + ay).toFixed(1)}"/>
      <circle class="${st.zur > 0 ? 'jb-pol-hell' : st.zur < 0 ? 'jb-pol-dunkel' : 'jb-pol-mittel'}"
              cx="${(st.x + ax * 0.62).toFixed(1)}" cy="${(B.mitte + ay * 0.62).toFixed(1)}" r="2.3"/>
      <text class="jb-achse" x="${st.x}" y="${B.h - 6}" text-anchor="middle">${st.txt}</text>`;
  }
  out += `<text class="jb-achse" x="${sonneX}" y="${B.h - 6}" text-anchor="middle">Sonne</text>
    <text class="jb-grad" x="${stationen[0].x + 16}" y="${B.mitte - 12}">${EKLIPTIK.toFixed(2).replace('.', ',')}°</text>
    </svg>`;
  return out;
}

/** Zeile über dem Jahresbild. Die Zahlen kommen aus sunEvents — also aus
    derselben Quelle wie überall sonst in der App, nicht aus der Näherung,
    mit der das Bild gemalt wird. */
function jahrText(tIndex) {
  const el = $('#jahrText');
  if (!el || !jahrDaten) return;
  if (tIndex == null) {
    el.innerHTML = '<i>Mit dem Finger durchs Jahr fahren — für jeden Tag Aufgang, '
      + 'Untergang und Tageslänge.</i>';
    return;
  }
  const g = jahrDaten.tage[tIndex];
  if (!g) return;
  const tag = new Date(jahrDaten.jahr, 0, 1 + tIndex, 12);
  const ev = sunEvents(tag, place.lat, place.lon);
  const auf = ev.aufgang, unter = ev.untergang;
  const dauer = auf && unter ? (unter - auf) / 60000 : null;

  const vor = tIndex > 0 ? jahrDaten.tage[tIndex - 1] : null;
  const laenge = (x) => (x?.z.gold ? (x.z.gold[1] - x.z.gold[0]) * 60 : null);
  const diff = vor && laenge(g) != null && laenge(vor) != null
    ? Math.round(laenge(g) - laenge(vor)) : null;

  el.innerHTML = `<b>${tag.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })}</b>`
    + (dauer != null ? ` · ${Math.floor(dauer / 60)} Std. ${Math.round(dauer % 60)} Min. hell` : '')
    + `<br><i>${auf ? `↑ ${hhmm(auf)}` : 'kein Aufgang'} · ${unter ? `↓ ${hhmm(unter)}` : 'kein Untergang'}`
    + (diff != null ? ` · ${diff >= 0 ? '+' : ''}${diff} Min. gegen den Vortag` : '') + `</i>`;
}

function jahrAbfahrenBinden(heuteT) {
  const feld = $('#jahrFeld');
  const griff = $('#jahrGriff');
  const svg = feld?.ownerSVGElement;
  if (!feld || !griff || !svg) return;
  const J = JAHR;
  const X = (t) => J.links + t / 364 * (J.w - J.links - J.rechts);

  const nach = (ev) => {
    const b = svg.getBoundingClientRect();
    if (!b.width) return;
    const p = ev.touches?.[0] || ev.changedTouches?.[0] || ev;
    const x = (p.clientX - b.left) / b.width * J.w;
    const t = Math.max(0, Math.min(364,
      Math.round((x - J.links) / (J.w - J.links - J.rechts) * 364)));
    const gx = X(t).toFixed(1);
    griff.removeAttribute('hidden');   // siehe Meteogramm: SVG kennt `.hidden` nicht
    const l = griff.querySelector('.jb-griff-linie');
    l.setAttribute('x1', gx); l.setAttribute('x2', gx);
    jahrText(t);
  };
  const los = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    nach(ev);
    const zug = (e) => { e.preventDefault(); nach(e); };
    const ende = () => {
      window.removeEventListener('pointermove', zug);
      window.removeEventListener('pointerup', ende);
      window.removeEventListener('pointercancel', ende);
    };
    window.addEventListener('pointermove', zug);
    window.addEventListener('pointerup', ende);
    window.addEventListener('pointercancel', ende);
  };
  feld.addEventListener('pointerdown', los);
}

/* ── Die Ringuhr abfahren ───────────────────────────────────
   Der Bogen ließ sich längst abfahren, die Uhr nicht — dabei ist sie die
   Ansicht, in der die Frage „wie ist das Licht um halb zehn?" überhaupt
   erst auftaucht. Der Winkel am Ring IST die Uhrzeit; die Umrechnung ist
   nur die Umkehrung von `uhrWinkel` und `polar`.

   Die Leiste steht ÜBER der Uhr, nicht darunter: Auf dem Handy liegt sonst
   genau der Finger auf der Zahl, die man lesen will. */
let uhrTagStart = null;

/** Zeile über der Uhr — ohne Finger die Einladung, sonst die Werte. */
function uhrText(p) {
  const el = $('#uhrText');
  if (!el || !place) return;
  if (!p) {
    el.innerHTML = '<i>Mit dem Finger über den Ring fahren — für jede Uhrzeit '
      + 'Licht, Sonnenstand und Mond.</i>';
    return;
  }
  const alt = sunAltitude(p.t, place.lat, place.lon);
  const m = moonHorizont(p.t, place.lat, place.lon);
  /* Knapp halten: Ausgeschriebene Himmelsrichtungen brachen die Zeile auf
     dem iPhone auf drei Umbrüche, und dann sprang die Uhr beim Abfahren nach
     unten. Kürzel und ein Minuszeichen für „unter dem Horizont" passen in
     zwei Zeilen — genau die Höhe, die min-height freihält. */
  const kurz = (grad) => ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][
    Math.round(((grad % 360) + 360) % 360 / 45) % 8];
  const sonne = alt > -0.833
    ? `Sonne ${alt.toFixed(0)}° ${kurz(sunAzimut(p.t, place.lat, place.lon))}`
    : `Sonne −${Math.abs(alt).toFixed(0)}°`;
  const mond = m.hoehe > 0 ? `Mond ${m.hoehe.toFixed(0)}° ${kurz(m.azimut)}` : 'Mond unter';
  el.innerHTML = `<b>${hhmm(p.t)}</b> · ${lichtWort(alt)}`
    + `<br><i>${sonne} · ${mond}</i>`;
}

function uhrAbfahrenBinden(tagStart) {
  uhrTagStart = tagStart;
  const feld = $('#uhrFeld');
  const griff = $('#uhrGriff');
  const svg = feld?.ownerSVGElement;
  if (!feld || !griff || !svg) return;

  const nach = (ev) => {
    const b = svg.getBoundingClientRect();
    if (!b.width) return;
    const t = ev.touches?.[0] || ev.changedTouches?.[0] || ev;
    /* Bildpunkt → Zeichenfläche. Die viewBox beginnt bei -8, deshalb der
       Versatz; ohne ihn läge die Mitte um acht Einheiten daneben. */
    const x = (t.clientX - b.left) / b.width * 216 - 8;
    const y = (t.clientY - b.top) / b.height * 216 - 8;
    const dx = x - UHR.mitte, dy = y - UHR.mitte;
    if (dx === 0 && dy === 0) return;
    /* Umkehrung von polar(): dort ist der Winkel (grad - 90) im Bogenmaß. */
    let grad = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    while (grad < -180) grad += 360;
    while (grad >= 180) grad -= 360;
    const min = Math.round((grad + 180) / 360 * 1440);
    const zeit = new Date(uhrTagStart.getTime() + min * 60000);

    const [gx, gy] = polar(grad, UHR.r);
    /* Der Strahl beginnt erst am Mondring, nicht in der Mitte: Von der Mitte
       aus lief er quer über Uhrzeit und Datum. */
    const [ix, iy] = polar(grad, UHR.innen - 4);
    griff.removeAttribute('hidden');   // siehe Meteogramm: SVG kennt `.hidden` nicht
    griff.querySelector('.uhr-griff').setAttribute('cx', gx.toFixed(1));
    griff.querySelector('.uhr-griff').setAttribute('cy', gy.toFixed(1));
    const strahl = griff.querySelector('.uhr-strahl');
    strahl.setAttribute('x1', ix.toFixed(1));
    strahl.setAttribute('y1', iy.toFixed(1));
    strahl.setAttribute('x2', gx.toFixed(1));
    strahl.setAttribute('y2', gy.toFixed(1));
    uhrText({ t: zeit });
  };

  const los = (ev) => {
    ev.stopPropagation();          // sonst öffnet der Block seine Erklärung
    ev.preventDefault();
    nach(ev);
    const zug = (e) => { e.preventDefault(); nach(e); };
    const ende = () => {
      window.removeEventListener('pointermove', zug);
      window.removeEventListener('pointerup', ende);
      window.removeEventListener('pointercancel', ende);
    };
    window.addEventListener('pointermove', zug);
    window.addEventListener('pointerup', ende);
    window.addEventListener('pointercancel', ende);
  };
  feld.addEventListener('pointerdown', los);
}

/** Nächste Sonnenmarke ab jetzt — für die Mitte der Uhr. */
function kommendeSonnenMarke(ev, jetzt) {
  const liste = [
    { name: 'Sonnenaufgang', t: ev.aufgang },
    { name: 'Höchststand', t: solarNoon(jetzt, place.lat, place.lon).zeit },
    { name: 'Goldene Stunde', t: ev.goldenStartAbend },
    { name: 'Sonnenuntergang', t: ev.untergang },
    { name: 'Blaue Stunde endet', t: ev.blaueStundeEndeAbend }
  ].filter(x => x.t && new Date(x.t) > jetzt).sort((a, b) => new Date(a.t) - new Date(b.t));
  return liste[0] || null;
}

/* ── Sonnenbahn: derselbe Tag, andere Frage ────────────────────
   Die Ringuhr beantwortet „wann", der Bogen „wo am Himmel und wie hoch".
   Waagerecht die Himmelsrichtung, senkrecht der Winkel über dem Horizont.
   Mit dem Finger abfahrbar: an jeder Stelle stehen Uhrzeit, Winkel,
   Richtung und Schattenlänge. */
const BOGEN = { w: 300, h: 172, padX: 18, oben: 16, horizont: 122 };

/** Höhe und Richtung der Sonne, alle vier Minuten über den ganzen Tag.
    Der Azimut wird fortlaufend gemacht (aufgedreht), damit der Sprung von
    359° auf 0° in der Polarsonne keine Zacke in die Kurve reißt. */
function sonnenBahn(tagStart, lat, lon) {
  const punkte = [];
  let letzte = null, versatz = 0;
  for (let m = 0; m <= 1440; m += 4) {
    const t = new Date(tagStart.getTime() + m * 60000);
    let az = sunAzimut(t, lat, lon) + versatz;
    if (letzte != null && az - letzte < -180) { versatz += 360; az += 360; }
    letzte = az;
    punkte.push({ t, alt: sunAltitude(t, lat, lon), az });
  }
  return punkte;
}

/** Schattenlänge eines 1,80-m-Menschen. Über 20 m wird die Zahl sinnlos. */
function schattenText(grad) {
  if (grad <= 1) return null;
  const l = 1.8 / Math.tan(grad * Math.PI / 180);
  if (l > 20) return 'Schatten länger als 20 m';
  return `Schatten ${dez(l)} m`;
}

let bogenBahn = null;          // Punkte des aktuellen Tages
let bogenMap = null;           // Umrechnung Punkt → Bildkoordinate

function renderSonnenbogen() {
  const ziel = $('#sonnenbogen');
  if (!ziel || !place) return;

  const jetzt = new Date();
  const tagStart = new Date(jetzt); tagStart.setHours(0, 0, 0, 0);
  const bahn = sonnenBahn(tagStart, place.lat, place.lon);
  const hell = bahn.filter(p => p.alt > -7);

  /* Der Mond steht dann am Himmel, wenn die Sonne es nicht tut — ohne ihn
     wäre die Ansicht nachts leer. Anders als die Sonne hält er sich aber
     nicht an den Kalendertag: Er geht abends auf und morgens wieder unter.
     Deshalb wird nicht der Tag gezeigt, sondern der eine Bogen, der gerade
     zählt — der laufende, sonst der nächste. */
  const mond = (() => {
    const alle = [];
    let letzte = null, versatz = 0;
    for (let m = -840; m <= 1800; m += 4) {
      const t = new Date(jetzt.getTime() + m * 60000);
      const mh = moonHorizont(t, place.lat, place.lon);
      let az = mh.azimut + versatz;
      if (letzte != null && az - letzte < -180) { versatz += 360; az += 360; }
      letzte = az;
      alle.push({ t, alt: mh.hoehe, az });
    }
    // Zusammenhängende Abschnitte über dem Horizont heraussuchen
    const boegen = [];
    let lauf = null;
    for (const p of alle) {
      if (p.alt > -1) { if (!lauf) boegen.push(lauf = []); lauf.push(p); }
      else lauf = null;
    }
    const b = boegen.find(x => x[0].t <= jetzt && x[x.length - 1].t >= jetzt)
           || boegen.find(x => x[0].t > jetzt) || [];
    if (!b.length || !hell.length) return b;
    /* Sonne und Mond wurden ab verschiedenen Zeitpunkten aufgedreht und
       liegen dadurch womöglich ganze Umdrehungen auseinander. Den Mondbogen
       als Ganzes auf die Umdrehung der Sonne schieben — nur so passen beide
       auf dieselbe Skala. */
    const sonneMitte = (Math.min(...hell.map(p => p.az)) + Math.max(...hell.map(p => p.az))) / 2;
    const mondMitte = (b[0].az + b[b.length - 1].az) / 2;
    const k = Math.round((sonneMitte - mondMitte) / 360);
    return k ? b.map(p => ({ ...p, az: p.az + k * 360 })) : b;
  })();
  const mondOben = mond.filter(p => p.alt > 0);

  // Ausschnitt so wählen, dass beide Bahnen hineinpassen — im Winter steht
  // die Sonne nur zwischen Südost und Südwest, im Sommer viel weiter.
  const azWerte = [...(hell.length ? hell : bahn), ...mondOben].map(p => p.az);
  const azMin = Math.min(...azWerte) - 12, azMax = Math.max(...azWerte) + 12;
  const altMax = Math.max(14, Math.max(...bahn.map(p => p.alt),
                                       ...mondOben.map(p => p.alt)) + 8);
  const altMin = -10;

  const X = (az) => BOGEN.padX + (az - azMin) / (azMax - azMin) * (BOGEN.w - 2 * BOGEN.padX);
  const Y = (alt) => BOGEN.horizont - (alt - 0) / (altMax - 0) * (BOGEN.horizont - BOGEN.oben);
  /* Zum Abfahren beide Bahnen als Bildpunkte vorhalten. Der Finger sucht
     sich die nächstgelegene Stelle — auf der Sonnenbahn tagsüber, auf der
     Mondbahn nachts. */
  bogenBahn = [
    ...hell.map(p => ({ t: p.t, alt: p.alt, az: p.az, art: 'sonne', x: X(p.az), y: Y(p.alt) })),
    ...mond.map(p => ({ t: p.t, alt: p.alt, az: p.az, art: 'mond', x: X(p.az), y: Y(p.alt) }))
  ];
  bogenMap = { X, Y, azMin, azMax, altMax, altMin };

  const punkte = hell.map(p => `${X(p.az).toFixed(1)},${Y(p.alt).toFixed(1)}`);
  const linie = punkte.length ? `M${punkte.join(' L')}` : '';

  const mondPunkte = mond.map(p => `${X(p.az).toFixed(1)},${Y(p.alt).toFixed(1)}`);
  const mondLinie = mondPunkte.length > 1 ? `M${mondPunkte.join(' L')}` : '';
  // Der Mond an seiner jetzigen Stelle, mit der Phase als Schatten darauf
  const mJetzt = moonHorizont(jetzt, place.lat, place.lon);
  const mp = moonPhase(jetzt);
  const mAz = [-720, -360, 0, 360, 720].map(k => mJetzt.azimut + k)
    .find(a => a >= azMin && a <= azMax);
  let mondScheibe = '';
  if (mJetzt.hoehe > -2 && mAz != null) {
    const cx = X(mAz), cy = Y(mJetzt.hoehe), r = 6.5;
    const schatten = cx + (mp.anteil < 0.5 ? -1 : 1) * (1 - mp.beleuchtet) * 2 * r;
    mondScheibe = `
      <clipPath id="bgMondRund"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}"/></clipPath>
      <circle class="bg-mondscheibe" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}"/>
      <circle class="bg-mondschatten" cx="${schatten.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}"
              clip-path="url(#bgMondRund)" opacity="${mp.beleuchtet > 0.97 ? 0 : 1}"/>`;
  }
  const flaeche = punkte.length
    ? `${linie} L${X(hell[hell.length - 1].az).toFixed(1)},${Y(0).toFixed(1)}
       L${X(hell[0].az).toFixed(1)},${Y(0).toFixed(1)} Z` : '';

  // Waagerechte Hilfslinien für den Winkel
  const stufen = [30, 60].filter(g => g < altMax - 4);
  const gitter = stufen.map(g => `
    <line class="bg-gitter" x1="${BOGEN.padX}" y1="${Y(g).toFixed(1)}"
          x2="${BOGEN.w - BOGEN.padX}" y2="${Y(g).toFixed(1)}"/>
    <text class="bg-gradtext" x="${BOGEN.w - BOGEN.padX + 2}" y="${(Y(g) + 3).toFixed(1)}">${g}°</text>`).join('');

  // Himmelsrichtungen unter dem Horizont
  const kurz = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  let richtungen = '';
  for (let a = Math.ceil(azMin / 45) * 45; a <= azMax; a += 45) {
    const x = X(a);
    richtungen += `<line class="bg-tick" x1="${x.toFixed(1)}" y1="${BOGEN.horizont}"
      x2="${x.toFixed(1)}" y2="${BOGEN.horizont + 4}"/>
      <text class="bg-himmel" x="${x.toFixed(1)}" y="${BOGEN.horizont + 15}">${kurz[((a / 45) % 8 + 8) % 8]}</text>`;
  }

  // Auf-, Untergang und Höchststand als feste Marken
  const marke = (p, txt) => p ? `
    <circle class="bg-marke" cx="${X(p.az).toFixed(1)}" cy="${Y(p.alt).toFixed(1)}" r="2.6"/>
    <text class="bg-markentext" x="${X(p.az).toFixed(1)}" y="${(Y(p.alt) - 7).toFixed(1)}">${txt}</text>` : '';
  const hoch = bahn.reduce((a, b) => (b.alt > a.alt ? b : a), bahn[0]);
  const auf = hell.find(p => p.alt > -0.833);
  const unter = [...hell].reverse().find(p => p.alt > -0.833);

  const jetztP = bahn.reduce((a, b) => (Math.abs(b.t - jetzt) < Math.abs(a.t - jetzt) ? b : a), bahn[0]);
  const jetztSichtbar = jetztP.alt > -7;

  /* Die gestrichelte Bahn ist der Mond — nur sah man ihr das nicht an.
     Florian hielt sie in seiner eigenen App für eine Hilfslinie und fragte,
     ob man eine Mondbahn einbauen könne. Was niemand erkennt, ist nicht
     eingebaut.

     Ein Name direkt auf der Kurve ging nicht: Am 6. August lag der Mondgipfel
     bei x=150/y=20, die Beschriftung des Sonnenhöchststands bei x=149/y=28 —
     die beiden Bahnen laufen an manchen Tagen so dicht, dass es auf der Kurve
     keinen sicheren Platz gibt. Deshalb eine feste kleine Legende oben links,
     über beiden Bahnen (die Sonne erreicht hier nie den oberen Rand, weil
     altMax immer acht Grad Luft lässt). */
  const mondName = mondLinie ? `
      <line class="bg-legende-linie" x1="${BOGEN.padX}" y1="9" x2="${BOGEN.padX + 13}" y2="9"/>
      <text class="bg-legende" x="${BOGEN.padX + 17}" y="11.5">Mond</text>` : '';

  ziel.innerHTML = `
    <svg viewBox="0 0 ${BOGEN.w} ${BOGEN.h}" class="bogen-svg" role="img"
         aria-label="Bahn der Sonne über den Himmel — zum Abfahren antippen">
      <defs>
        <linearGradient id="bgFuell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffd60a" stop-opacity=".28"/>
          <stop offset="1" stop-color="#ffd60a" stop-opacity=".03"/>
        </linearGradient>
      </defs>
      ${gitter}
      ${flaeche ? `<path d="${flaeche}" fill="url(#bgFuell)"/>` : ''}
      <line class="bg-horizont" x1="${BOGEN.padX - 8}" y1="${BOGEN.horizont}"
            x2="${BOGEN.w - BOGEN.padX + 8}" y2="${BOGEN.horizont}"/>
      ${richtungen}
      ${mondLinie ? `<path class="bg-mondlinie" d="${mondLinie.trim()}" fill="none"/>` : ''}
      ${mondName}
      ${mondScheibe}
      ${linie ? `<path class="bg-linie" d="${linie}" fill="none"/>` : ''}
      ${marke(auf, hhmm(auf.t))}
      ${marke(unter, hhmm(unter.t))}
      ${marke(hoch, `${hoch.alt.toFixed(0)}°`)}
      ${jetztSichtbar ? `<circle class="bg-jetzt" cx="${X(jetztP.az).toFixed(1)}"
            cy="${Y(jetztP.alt).toFixed(1)}" r="5"/>` : ''}
      <g id="bogenGriff" hidden>
        <line class="bg-lot" x1="0" y1="0" x2="0" y2="0"/>
        <circle class="bg-griff" cx="0" cy="0" r="7"/>
      </g>
      <rect id="bogenFeld" x="0" y="0" width="${BOGEN.w}" height="${BOGEN.h}" fill="transparent"/>
    </svg>`;

  bogenText(null);
  bogenAbfahrenBinden();
}

/** Zeile unter dem Bogen — ohne Finger der Stand von jetzt. */
function bogenText(p) {
  const el = $('#bogenText');
  if (!el) return;
  if (!p) {
    const jetzt = new Date();
    const alt = sunAltitude(jetzt, place.lat, place.lon);
    /* Ohne Finger nur der Hinweis — wie hoch die Sonne gerade steht, sagt
       schon die Zeile unter der Ansicht. Zweimal dasselbe liest sich schlecht. */
    const m = moonHorizont(jetzt, place.lat, place.lon);
    el.innerHTML = (m.hoehe > 0
        ? `Mond <b>${m.hoehe.toFixed(0)}°</b> hoch ${himmelsrichtung(m.azimut)}<br>` : '')
      + `<i>Mit dem Finger über die Bahn fahren — für jede Stelle Uhrzeit, Winkel und Schatten.</i>`;
    return;
  }
  if (p.art === 'mond') {
    const tag = p.t.toDateString() !== new Date().toDateString()
      ? p.t.toLocaleDateString('de-DE', { weekday: 'short' }) + ' ' : '';
    const stand = p.alt < 0.5 ? `am Horizont ${himmelsrichtung(p.az)}`
                              : `${p.alt.toFixed(0)}° hoch ${himmelsrichtung(p.az)}`;
    el.innerHTML = `<b>${tag}${hhmm(p.t)}</b> · Mond ${stand}`
      + `<br><i>${moonPhase(p.t).name}, ${Math.round(moonPhase(p.t).beleuchtet * 100)} % beleuchtet</i>`;
    return;
  }
  const s = schattenText(p.alt);
  const m = moonHorizont(p.t, place.lat, place.lon);
  el.innerHTML = `<b>${hhmm(p.t)}</b> · Sonne ${p.alt > -0.833
      ? `${p.alt.toFixed(0)}° hoch ${himmelsrichtung(p.az)}${s ? ` · ${s}` : ''}`
      : `unter dem Horizont`}`
    + (m.hoehe > 0
        ? `<br><i>Mond ${m.hoehe.toFixed(0)}° hoch ${himmelsrichtung(m.azimut)}</i>`
        : '');
}

function bogenAbfahrenBinden() {
  const svg = $('#bogenFeld')?.ownerSVGElement;
  const griff = $('#bogenGriff');
  if (!svg || !griff || !bogenMap) return;

  const nach = (ev) => {
    const b = svg.getBoundingClientRect();
    const t = ev.touches?.[0] || ev.changedTouches?.[0] || ev;
    const x = (t.clientX - b.left) / b.width * BOGEN.w;
    const y = (t.clientY - b.top) / b.height * BOGEN.h;
    /* Nächstgelegener Punkt in der Fläche: Der senkrechte Abstand zählt nur
       halb, damit man nicht ständig auf die andere Bahn springt, wenn beide
       übereinanderliegen. */
    let beste = null, dist = Infinity;
    for (const p of bogenBahn) {
      const d = (p.x - x) ** 2 + ((p.y - y) * 0.5) ** 2;
      if (d < dist) { dist = d; beste = p; }
    }
    if (!beste) return;
    const px = beste.x, py = beste.y;
    griff.removeAttribute('hidden');   // siehe Meteogramm: SVG kennt `.hidden` nicht
    griff.classList.toggle('ist-mond', beste.art === 'mond');
    griff.querySelector('.bg-griff').setAttribute('cx', px.toFixed(1));
    griff.querySelector('.bg-griff').setAttribute('cy', py.toFixed(1));
    const lot = griff.querySelector('.bg-lot');
    lot.setAttribute('x1', px.toFixed(1)); lot.setAttribute('x2', px.toFixed(1));
    lot.setAttribute('y1', py.toFixed(1)); lot.setAttribute('y2', BOGEN.horizont);
    bogenText(beste);
  };

  const los = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    nach(ev);
    const zug = (e) => { e.preventDefault(); nach(e); };
    const ende = () => {
      window.removeEventListener('pointermove', zug);
      window.removeEventListener('pointerup', ende);
      window.removeEventListener('pointercancel', ende);
    };
    window.addEventListener('pointermove', zug);
    window.addEventListener('pointerup', ende);
    window.addEventListener('pointercancel', ende);
  };
  svg.addEventListener('pointerdown', los);
}

/* Umschalter zwischen Ringuhr und Bogen. Der Wunsch bleibt gespeichert —
   wer lieber den Bogen sieht, soll ihn nicht jedes Mal neu suchen. */
let sonneAnsicht = 'uhr';
let sonneHoeheAnpassen = () => {};
addEventListener('resize', () => sonneHoeheAnpassen());
addEventListener('orientationchange', () => setTimeout(() => sonneHoeheAnpassen(), 300));

function sonneAnsichtBinden() {
  sonneAnsicht = store.get('wf.sonneAnsicht', 'uhr');
  const buehne = $('#svBuehne');
  if (!buehne) return;
  const REIHE = ['uhr', 'bogen', 'jahr'];
  const setzen = (v) => {
    const i = Math.max(0, REIHE.indexOf(v));
    sonneAnsicht = REIHE[i];
    store.set('wf.sonneAnsicht', sonneAnsicht);
    /* Drei Tafeln nebeneinander in einer 300 % breiten Bühne: ein Schritt
       ist ein Drittel. Bei zwei Tafeln war es die Hälfte — die Zahl darf
       nicht stehen bleiben, sonst zeigt „Jahr" ins Leere. */
    buehne.style.transform = `translateX(-${(i * 100 / REIHE.length).toFixed(4)}%)`;
    // Das Fenster wächst und schrumpft mit der gezeigten Tafel — sonst
    // stünde unter dem flachen Bogen die Lücke der runden Uhr.
    const tafel = buehne.children[i];
    if (tafel) buehne.parentElement.style.height = tafel.offsetHeight + 'px';
    $$('.sv-tab').forEach(t => {
      const an = t.dataset.view === v;
      t.classList.toggle('is-an', an);
      t.setAttribute('aria-selected', an ? 'true' : 'false');
    });
  };
  $$('.sv-tab').forEach(t => {
    t.onclick = (e) => { e.stopPropagation(); setzen(t.dataset.view); };
  });
  // Beim Drehen des Geräts ändert sich die Breite und damit die Höhe des Rings
  sonneHoeheAnpassen = () => { if (document.body.contains(buehne)) setzen(sonneAnsicht); };

  // Wischen zum Wechseln — aber nicht dort, wo der Finger den Bogen abfährt
  let startX = null, startY = null;
  buehne.addEventListener('touchstart', (e) => {
    if (e.target.closest('.bogen-svg, .jb-svg, .uhr-svg')) { startX = null; return; }
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
  }, { passive: true });
  buehne.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const i = REIHE.indexOf(sonneAnsicht);
      setzen(REIHE[Math.max(0, Math.min(REIHE.length - 1, i + (dx < 0 ? 1 : -1)))]);
    }
    startX = null;
  }, { passive: true });

  setzen(sonneAnsicht);
}

/* Sonnenbogen, Lichtphasen und Mond — gehören zum Countdown darüber und
   standen vorher als eigene Kacheln weiter unten, mit denselben Zeiten. */
function renderSonneDetail() {
  const ziel = $('#sonneDetail');
  if (!ziel || !place || !data?.daily) return;
  const d = data.daily;
  const sr = new Date(d.sunrise[0]), ss = new Date(d.sunset[0]);
  const now = Date.now();
  const dayProg = clamp((now - sr) / (ss - sr), 0, 1);
  const sunH = Math.round(sonnenStunden(d.time[0]));
  const minutenTag = Math.round((ss - sr) / 60000);
  const dayLen = `${Math.floor(minutenTag / 60)} Std. ${minutenTag % 60} Min.`;
  const teile = [];

  // Höchststand: wichtig für Schatten, UV und Fotografie.
  // solarNoon liefert { zeit, hoehe } — nicht das Datum selbst.
  const mittagInfo = solarNoon(new Date(), place.lat, place.lon);
  const mittag = mittagInfo.zeit;
  const hoechststand = mittagInfo.hoehe;
  const jetztWinkel = sunAltitude(new Date(), place.lat, place.lon);
  const azimut = sunAzimut(new Date(), place.lat, place.lon);
  teile.push(`<div class="sm-block has-info" data-info="sonne" role="button" tabindex="0">
    <span class="sm-titel">Sonnenstand<i class="t-q">?</i></span>
    <div class="sv-tabs" role="tablist">
      <button class="sv-tab" data-view="uhr" role="tab">Ringuhr</button>
      <button class="sv-tab" data-view="bogen" role="tab">Sonnenbahn</button>
      <button class="sv-tab" data-view="jahr" role="tab">Jahr</button>
    </div>
    <div class="sv-fenster">
      <div class="sv-buehne" id="svBuehne">
        <div class="sv-panel">
          <p class="bogen-text" id="uhrText"></p>
          <div class="uhr-wrap" id="sonnenuhr"></div>
        </div>
        <div class="sv-panel sv-mitte">
          <p class="bogen-text" id="bogenText"></p>
          <div class="bogen-wrap" id="sonnenbogen"></div>
        </div>
        <div class="sv-panel sv-mitte">
          <p class="bogen-text" id="jahrText"></p>
          <div class="jahr-wrap" id="jahrBand"></div>
        </div>
      </div>
    </div>
    <span class="t-jetztwinkel">${jetztWinkel > -0.833
      ? `Jetzt <b>${jetztWinkel.toFixed(0)}°</b> über dem Horizont, ${himmelsrichtung(azimut)} — ${winkelWort(jetztWinkel)}`
      : `Sonne <b>${jetztWinkel.toFixed(0)}°</b> unter dem Horizont`}</span>
    <span class="t-sub">↑ ${hhmm(sr)} · Höchststand ${hhmm(mittag)} bei ${hoechststand.toFixed(0)}° · ↓ ${hhmm(ss)}<br>
      ${sunH} Std. Sonnenschein erwartet · Tag ${dayLen}</span>
  </div>`);

  // Goldene und blaue Stunde, Dämmerung
  const ev = sunEvents(new Date(), place.lat, place.lon);
  const z = (t) => (t ? hhmm(t) : '–');
  const jetztAlt = sunAltitude(new Date(), place.lat, place.lon);
  const phase = jetztAlt > 6 ? 'Tag' : jetztAlt > -0.833 ? 'Goldene Stunde'
    : jetztAlt > -6 ? 'Blaue Stunde' : jetztAlt > -18 ? 'Dämmerung' : 'Nacht';

  teile.push(`<div class="sm-block has-info" data-info="licht" role="button" tabindex="0">
    <span class="sm-titel">Licht &amp; Dämmerung<i class="t-q">?</i></span>
    <span class="t-value">${phase} <em>${jetztAlt.toFixed(0)}° Sonnenhöhe</em></span>
    <div class="light-rows">
      <div class="lrow"><span class="ld gold"></span><span>Goldene Stunde früh</span><b>${z(ev.aufgang)}–${z(ev.goldenEndeMorgen)}</b></div>
      <div class="lrow"><span class="ld gold"></span><span>Goldene Stunde abends</span><b>${z(ev.goldenStartAbend)}–${z(ev.untergang)}</b></div>
      <div class="lrow"><span class="ld blau"></span><span>Blaue Stunde abends</span><b>${z(ev.untergang)}–${z(ev.blaueStundeEndeAbend)}</b></div>
      <div class="lrow"><span class="ld nacht"></span><span>Astronomische Nacht</span><b>ab ${z(ev.astroNacht)}</b></div>
    </div>
  </div>`);

  // Mond
  const mp = moonPhase();
  const mt = moonTimes(new Date(), place.lat, place.lon);
  const bel = Math.round(mp.beleuchtet * 100);
  // Schattenkante: bei zunehmendem Mond von links, bei abnehmendem von rechts
  const zunehmend = mp.anteil < 0.5;
  const versatz = (1 - Math.abs(mp.beleuchtet * 2 - 1)) * 100;
  teile.push(`<div class="sm-block has-info" data-info="mond" role="button" tabindex="0">
    <span class="sm-titel">Mond<i class="t-q">?</i></span>
    <div class="moon-row">
      <span class="moon-disc">
        <span class="moon-shadow" style="
          transform: translateX(${(zunehmend ? -1 : 1) * (100 - versatz) * 0.42}%);
          opacity:${bel > 96 ? 0 : 1}"></span>
      </span>
      <span class="moon-val"><b>${bel}%</b><i>beleuchtet</i></span>
    </div>
    <span class="t-sub">${mp.name}${mt.auf ? ` · ↑ ${hhmm(mt.auf)}` : ''}${mt.unter ? ` ↓ ${hhmm(mt.unter)}` : ''}<br>
      <b class="t-plain">${naechsteMondMarke()}</b></span>
  </div>`);


  ziel.innerHTML = teile.join('');
  renderSonnenuhr();          // braucht den Container aus teile
  renderSonnenbogen();
  renderJahrBand();
  // Der Globus lebt in einer eigenen Karte, wird aber vom selben Ort gespeist
  const erde = $('#erdeKarte');
  if (erde) { erde.hidden = false; renderGlobus(); }
  sonneAnsichtBinden();
  $$('.sm-block.has-info', ziel).forEach(b => {
    b.onclick = (e) => {
      /* Umschalter, Bogen und Ringuhr sind eigene Bedienelemente — sie
         sollen nicht die Erklärung öffnen. `stopPropagation` beim Zeiger
         reicht dafür nicht: Der Klick entsteht erst danach aus Druck und
         Loslassen und läuft auf einem eigenen Weg nach oben. */
      if (e.target.closest('.sv-tabs, .bogen-wrap, .uhr-wrap, .jahr-wrap')) return;
      openExplain(b.dataset.info);
    };
  });
}

function renderTiles(air) {
  const c = data.current, h = data.hourly, d = data.daily;
  const i = nowIndex(h.time);
  const out = [];

  // Wind mit Kompassnadel
  const deg = c.wind_direction_10m;
  out.push(`<div class="tile has-info" data-info="wind" role="button" tabindex="0">
    <span class="t-label">Wind<i class="t-q">?</i></span>
    <div class="t-wind">
      <svg class="compass" viewBox="0 0 60 60" style="--deg:${deg}deg">
        <circle class="c-ring" cx="30" cy="30" r="24"/>
        ${[0, 90, 180, 270].map(a => `<text class="c-lbl" x="30" y="10" transform="rotate(${a} 30 30)">${['N','O','S','W'][a/90]}</text>`).join('')}
        <g class="c-needle"><path d="M30 12 L35 34 L30 30 L25 34 Z"/></g>
      </svg>
      <span class="t-windval"><b>${round(c.wind_speed_10m)}</b><i>km/h</i></span>
    </div>
    <span class="t-sub">aus ${dirName(deg)} · Böen ${round(c.wind_gusts_10m)} km/h<br>
      <b class="t-plain">${windWorte(c.wind_speed_10m)}</b></span>
  </div>`);

  // UV
  const uvNow = h.uv_index[i] ?? 0;
  const [, uvTxt, uvTone] = levelOf(UV_LEVELS, uvNow);
  out.push(tile('UV-Index', round(uvNow), `${uvTxt} · heute max. ${round(d.uv_index_max[0])}`,
    `<span class="t-meter"><i style="width:${clamp(uvNow / 11 * 100, 4, 100)}%"></i></span>`, uvTone, 'uv'));

  // Luftfeuchte + Taupunkt
  out.push(tile('Luftfeuchte', `${round(c.relative_humidity_2m)}%`,
    `Taupunkt ${round(h.dew_point_2m[i])}°`,
    `<span class="t-meter"><i style="width:${clamp(c.relative_humidity_2m, 4, 100)}%"></i></span>`, '', 'feuchte'));

  // Sonne
  const sr = new Date(d.sunrise[0]), ss = new Date(d.sunset[0]);
  const now = Date.now();
  const dayProg = clamp((now - sr) / (ss - sr), 0, 1);
  const sunH = Math.round(sonnenStunden(d.time[0]));
  const minutenTag = Math.round((ss - sr) / 60000);
  const dayLen = `${Math.floor(minutenTag / 60)} Std. ${minutenTag % 60} Min.`;
  // Luftdruck
  out.push(tile('Luftdruck', round(c.pressure_msl), 'hPa auf Meereshöhe', '', '', 'druck'));

  // Sicht
  const vis = h.visibility?.[i];
  if (vis != null) {
    out.push(tile('Sicht', vis >= 10000 ? '>10' : (vis / 1000).toFixed(1),
      vis >= 10000 ? 'km · klare Sicht' : 'km', '', '', 'sicht'));
  }

  // Bewölkung
  out.push(tile('Bewölkung', `${round(c.cloud_cover)}%`,
    c.cloud_cover < 20 ? 'nahezu wolkenlos' : c.cloud_cover > 85 ? 'geschlossene Decke' : 'aufgelockert',
    `<span class="t-meter"><i style="width:${clamp(c.cloud_cover, 4, 100)}%"></i></span>`, '', 'wolken'));

  // Luftqualität
  if (air?.current?.european_aqi != null) {
    const aqi = air.current.european_aqi;
    const [, aqiTxt, aqiTone] = levelOf(AQI_LEVELS, aqi);
    out.push(tile('Luftqualität', round(aqi), `${aqiTxt} · Feinstaub ${air.current.pm2_5?.toFixed(1)} µg/m³`,
      `<span class="t-meter"><i style="width:${clamp(aqi, 4, 100)}%"></i></span>`, aqiTone, 'luft'));
  }

  // Pollen – nur wenn tatsächlich welche fliegen
  if (air?.current) {
    const POLLEN = [
      ['birch_pollen', 'Birke'], ['alder_pollen', 'Erle'], ['grass_pollen', 'Gräser'],
      ['mugwort_pollen', 'Beifuß'], ['ragweed_pollen', 'Ambrosia']
    ];
    const active = POLLEN.map(([k, n]) => ({ n, v: air.current[k] ?? 0 }))
      .filter(x => x.v >= 1).sort((a, b) => b.v - a.v);
    if (active.length) {
      const top = active[0];
      const [, pTxt, pTone] = levelOf(POLLEN_LEVELS, top.v);
      out.push(`<div class="tile t-wide t-${pTone} has-info" data-info="pollen" role="button" tabindex="0">
        <span class="t-label">Pollen<i class="t-q">?</i></span>
        <span class="t-value">${top.n} <em>${pTxt}</em></span>
        <div class="pollen-rows">${active.slice(0, 4).map(p => {
          const [, txt] = levelOf(POLLEN_LEVELS, p.v);
          return `<div class="prow"><span>${p.n}</span>
            <span class="pbar"><i style="width:${clamp(p.v / 80 * 100, 3, 100)}%"></i></span>
            <span class="pval">${txt}</span></div>`;
        }).join('')}</div>
      </div>`);
    }
  }

  $('#tiles').innerHTML = out.join('');
  wireExplain();
}

// ══ Countdown zu Sonne und Mond ════════════════════════════
let countdownTimer = null;

/** Zeitpunkt des höchsten Sonnenstands (wahrer Mittag). */
function solarNoon(day, lat, lon) {
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  let best = null, hoch = -99;
  for (let m = 0; m <= 1440; m += 2) {
    const t = new Date(start.getTime() + m * 60000);
    const a = sunAltitude(t, lat, lon);
    if (a > hoch) { hoch = a; best = t; }
  }
  return { zeit: best, hoehe: hoch };
}

/** Sammelt die nächsten Sonnen- und Mondereignisse ab jetzt. */
function nextEvents(lat, lon) {
  const jetzt = Date.now();
  const liste = [];
  for (let tag = 0; tag < 3 && liste.length < 14; tag++) {
    const d = new Date(jetzt + tag * 864e5);
    const s = sunEvents(d, lat, lon);
    const mittag = solarNoon(d, lat, lon);
    const m = moonTimes(d, lat, lon);
    liste.push(
      { key: 'aufgang', name: 'Sonnenaufgang', t: s.aufgang, art: 'sonne' },
      { key: 'mittag', name: 'Höchststand', t: mittag.zeit, art: 'sonne',
        zusatz: `${Math.round(mittag.hoehe)}° über dem Horizont` },
      { key: 'goldabend', name: 'Goldene Stunde', t: s.goldenStartAbend, art: 'gold' },
      { key: 'untergang', name: 'Sonnenuntergang', t: s.untergang, art: 'sonne' },
      { key: 'blau', name: 'Blaue Stunde endet', t: s.blaueStundeEndeAbend, art: 'blau' },
      { key: 'mondauf', name: 'Mondaufgang', t: m.auf, art: 'mond' },
      { key: 'mondunter', name: 'Monduntergang', t: m.unter, art: 'mond' }
    );
  }
  return liste
    .filter(e => e.t && e.t.getTime() > jetzt)
    .sort((a, b) => a.t - b.t);
}

const restZeit = (ziel) => {
  const s = Math.max(0, Math.floor((ziel - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 1) return `${h} Std. ${String(m).padStart(2, '0')} Min.`;
  if (m >= 1) return `${m} Min. ${String(s % 60).padStart(2, '0')} Sek.`;
  return `${s} Sek.`;
};

function renderCountdown() {
  const box = $('#countdown');
  if (!box || !place) return;
  clearInterval(countdownTimer);

  const alle = nextEvents(place.lat, place.lon);
  if (!alle.length) return;

  // Je Art nur den nächsten Termin, damit die Liste nicht zuläuft
  const gesehen = new Set();
  const zeigen = alle.filter(e => {
    if (gesehen.has(e.key)) return false;
    gesehen.add(e.key); return true;
  }).slice(0, 6);

  const [erstes, ...weitere] = zeigen;

  box.innerHTML = `
    <div class="cd-main">
      <span class="cd-icon ${erstes.art}"></span>
      <span class="cd-body">
        <span class="cd-label">${erstes.name}</span>
        <span class="cd-rest" data-t="${erstes.t.getTime()}">${restZeit(erstes.t)}</span>
        <span class="cd-clock">um ${hhmm(erstes.t)} Uhr${erstes.zusatz ? ` · ${erstes.zusatz}` : ''}</span>
      </span>
    </div>
    ${losgehenZeile()}
    <div class="cd-list">
      ${weitere.map(e => `
        <div class="cd-row">
          <span class="cd-dot ${e.art}"></span>
          <span class="cd-name">${e.name}</span>
          <span class="cd-time">${hhmm(e.t)}</span>
          <span class="cd-in" data-t="${e.t.getTime()}">${restZeit(e.t)}</span>
        </div>`).join('')}
    </div>
    <div class="cd-knoepfe">
      <button class="cd-globus" id="cdGlobus">🌍 Wo ist gerade Tag?</button>
      <button class="cd-globus" id="cdAR">📷 Sonnenbahn im Bild</button>
    </div>`;

  $('#cdGlobus').addEventListener('click', openTerminator);
  $('#cdAR').addEventListener('click', arStarten);

  countdownTimer = setInterval(() => {
    let neuLaden = false;
    $$('[data-t]', box).forEach(el => {
      const ziel = +el.dataset.t;
      if (ziel <= Date.now()) neuLaden = true;
      el.textContent = restZeit(ziel);
    });
    if (neuLaden) renderCountdown();          // Ereignis vorbei → Liste erneuern
  }, 1000);
}

// ══ Himmelsereignisse ══════════════════════════════════════
/** Kuratierte Liste. Wenn ein Termin in die Vorhersage fällt, kommt die
    Bewölkung dazu — bei Himmelsbeobachtung ist das die entscheidende Frage. */
const SKY_EVENTS = [
  { von: '2026-08-12T19:30', bis: '2026-08-12T20:50', titel: 'Partielle Sonnenfinsternis',
    text: 'In Süddeutschland rund 89 % der Sonnenfläche bedeckt. Beginn am späten Nachmittag, '
        + 'größte Phase gegen halb neun — die Sonne geht als schmale Sichel unter.',
    warnung: 'Nie ohne geprüfte Sonnenfinsternisbrille hineinsehen.', icon: 'sofi' },
  { von: '2026-08-12T22:30', bis: '2026-08-13T04:30', titel: 'Perseiden — Maximum',
    text: 'Bis zu 60 Sternschnuppen je Stunde, und der Neumond fällt genau auf diese Nacht: '
        + 'kein Mondlicht stört. Beste Zeit nach Mitternacht, Blick Richtung Nordost.',
    icon: 'meteor' }
];

/* ── Termin für den Kalender ────────────────────────────────
   Ein Himmelstermin nützt nur, wenn man zur richtigen Stunde daran denkt —
   und das ist bei einer Finsternis in zwei Wochen genau die Stelle, an der
   eine Wetter-App aufhört und der Kalender anfängt. Erzeugt wird eine echte
   iCalendar-Datei, kein Link zu einem Anbieter: Sie funktioniert in Apple
   Kalender, Google, Outlook und Thunderbird gleichermaßen und verlässt das
   Gerät nicht. */

/** Text für eine iCalendar-Zeile absichern: Komma, Semikolon, Backslash und
    Zeilenumbruch haben dort eine eigene Bedeutung. */
const icsText = (t) => String(t)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\n/g, '\\n');

/** Zeilen auf 75 Bytes umbrechen — der Standard zählt Bytes, nicht Zeichen,
    und „größte" belegt in UTF-8 sieben statt sechs. Nach Zeichen gefaltet
    wären Zeilen mit Umlauten zu lang; manche Kalender verschlucken dann
    stillschweigend den Rest der Beschreibung. Fortsetzungszeilen beginnen
    mit einem Leerzeichen, und ein Zeichen wird nie zerschnitten. */
function icsFalten(zeile) {
  const bytes = (t) => new TextEncoder().encode(t).length;
  if (bytes(zeile) <= 75) return zeile;
  const teile = [];
  let rest = zeile, grenze = 75;
  while (bytes(rest) > grenze) {
    let n = grenze;
    while (bytes(rest.slice(0, n)) > grenze) n--;
    teile.push((teile.length ? ' ' : '') + rest.slice(0, n));
    rest = rest.slice(n);
    grenze = 74;                      // das führende Leerzeichen zählt mit
  }
  if (rest) teile.push((teile.length ? ' ' : '') + rest);
  return teile.join('\r\n');
}

/** Zeitstempel in UTC — damit der Termin unabhängig von der Zeitzone des
    Kalenders auf denselben Moment fällt, ohne eine VTIMEZONE mitzuliefern. */
const icsZeit = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function himmelTermin(e) {
  const beschreibung = [
    e.text,
    e.warnung ? `Achtung: ${e.warnung}` : '',
    'Ob der Himmel klar ist, steht in Wetterfunk: https://tilian86.github.io/wetterfunk/'
  ].filter(Boolean).join('\n\n');

  /* Feste Kennung je Termin: Wer zweimal tippt, bekommt keinen zweiten
     Eintrag, sondern denselben aktualisiert. */
  const uid = `wetterfunk-${e.von.replace(/[^0-9T]/g, '')}@tilian86.github.io`;

  const zeilen = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wetterfunk//DE', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsZeit(new Date())}`,
    `DTSTART:${icsZeit(e.start)}`,
    `DTEND:${icsZeit(e.ende)}`,
    `SUMMARY:${icsText(e.titel)}`,
    `DESCRIPTION:${icsText(beschreibung)}`,
    // Eine Stunde vorher erinnern — ohne Erinnerung nützt der Eintrag wenig
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H',
    `DESCRIPTION:${icsText(e.titel)} — in einer Stunde`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return zeilen.map(icsFalten).join('\r\n') + '\r\n';
}

async function himmelInKalender(index) {
  const e = himmelListe[index];
  if (!e) return;
  const inhalt = himmelTermin(e);
  const name = e.titel.toLowerCase()
    .replace(/[^a-zäöüß0-9]+/g, '-').replace(/^-|-$/g, '') + '.ics';

  /* Auf dem iPhone ist Teilen der kürzere Weg: Das Systemblatt bietet
     „Zu Kalender hinzufügen" direkt an. Ein Download landete stattdessen
     erst in „Dateien" und bräuchte zwei weitere Tipper. Wo Teilen von
     Dateien fehlt (Desktop-Browser), bleibt es beim Download. */
  try {
    const datei = new File([inhalt], name, { type: 'text/calendar' });
    if (navigator.canShare?.({ files: [datei] })) {
      await navigator.share({ files: [datei], title: e.titel });
      return;
    }
  } catch (err) {
    // Abbruch durch den Nutzer ist kein Fehler — dann still zurück
    if (err?.name === 'AbortError') return;
  }

  const blob = new Blob([inhalt], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  /* Erst später freigeben: Ein sofortiges revoke bricht den Download ab. */
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Termin geladen — im Kalender öffnen und bestätigen.', 3500);
}

/* Die angezeigten Termine merken, damit der Knopf sie wiederfindet. */
let himmelListe = [];

function renderSky() {
  const box = $('#sky-events');
  if (!box) return;
  const jetzt = Date.now();
  const kommend = SKY_EVENTS
    .map(e => ({ ...e, start: new Date(e.von), ende: new Date(e.bis) }))
    .filter(e => e.ende.getTime() > jetzt)
    .sort((a, b) => a.start - b.start)
    .slice(0, 3);

  if (!kommend.length) { box.closest('section').hidden = true; return; }
  box.closest('section').hidden = false;
  himmelListe = kommend;
  /* Einmal am Behälter lauschen statt an jedem Knopf: Die Karten werden bei
     jeder Aktualisierung neu gebaut, Knöpfe darin wären ihre Hörer los. */
  if (!box.dataset.calGebunden) {
    box.dataset.calGebunden = '1';
    box.addEventListener('click', (ev) => {
      const knopf = ev.target.closest('.sky-cal');
      if (knopf) himmelInKalender(+knopf.dataset.termin);
    });
  }

  const h = data?.hourly;
  box.innerHTML = kommend.map((e, nr) => {
    const tage = Math.ceil((e.start - jetzt) / 864e5);
    const wann = e.start.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

    // Bewölkung nachschlagen, falls der Termin schon in der Vorhersage liegt
    let sicht = '';
    if (h) {
      const i = h.time.findIndex(t => new Date(t) >= e.start);
      if (i >= 0) {
        const cc = h.cloud_cover?.[i];
        if (cc != null) {
          const gut = cc < 35, mittel = cc < 70;
          sicht = `<span class="sky-view ${gut ? 'ok' : mittel ? 'mid' : 'bad'}">
            ${cc}% Bewölkung — ${gut ? 'gute Sicht zu erwarten' : mittel ? 'teils bewölkt' : 'wohl bedeckt'}</span>`;
        }
      } else {
        sicht = `<span class="sky-view wait">Wetter dazu ab etwa ${tage - 9} Tagen vorher absehbar</span>`;
      }
    }

    return `<article class="sky-item">
      <div class="sky-head">
        <span class="sky-icon ${e.icon}"></span>
        <span class="sky-when"><b>${e.titel}</b><i>${wann} · ${hhmm(e.start)}–${hhmm(e.ende)} Uhr</i></span>
        <span class="sky-days">${tage <= 0 ? 'heute' : `in ${tage} Tg.`}</span>
      </div>
      <p class="sky-text">${e.text}</p>
      ${e.warnung ? `<p class="sky-warn">${e.warnung}</p>` : ''}
      <div class="sky-fuss">
        ${sicht}
        <button class="sky-cal" data-termin="${nr}">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="3"/>
            <path d="M3 10h18M8 3v4M16 3v4"/>
          </svg>
          In den Kalender
        </button>
      </div>
    </article>`;
  }).join('');
}

// ══ Webcams ════════════════════════════════════════════════
/* Kameras, deren Bild sich direkt einbetten lässt — jeweils beim Betreiber
   selbst abgerufen, nicht über ein Portal. Die großen Wetterportale liefern
   ihre Bilder nur per JavaScript hinter einem Zustimmungsdialog aus; die
   stehen deshalb weiterhin als Verweis darunter. */
const CAM_FEST = [
  { name: 'Tübingen · Marktplatz',
    url: 'https://www.tuebingen.de/camera/webcam_marktplatz.jpg',
    quelle: 'https://www.tuebingen.de/webcam.html', ort: 'Rathaus, Blick über den Markt' },
  { name: 'Tübingen · Markt (Silberburg)',
    url: 'https://www.tuemarkt.de/webcam/marktplatz-tuebingen.jpg',
    quelle: 'https://www.tuemarkt.de/Erleben/Webcam_Marktplatz.html', ort: 'zweite Perspektive' },
  { name: 'Ammerbuch · Flugplatz Poltringen',
    url: 'https://images.bergfex.at/webcams/?id=5720&format=4',
    quelle: 'https://www.bergfex.de/sommer/schwaebische-alb/webcams/', ort: '11 km westlich' },
  { name: 'Reutlingen · Marktplatz',
    url: 'https://images.bergfex.at/webcams/?id=17061&format=4',
    quelle: 'https://www.reutlingen.de/webcam', ort: '12 km östlich' },
  { name: 'Reutlingen · Stadthalle',
    url: 'https://www.reutlingen.de/webcam/stadthalle/showImage.php5',
    quelle: 'https://www.reutlingen.de/webcam', ort: '12 km östlich' },
  { name: 'Bronnweiler',
    url: 'https://images.bergfex.at/webcams/?id=24162&format=4',
    quelle: 'https://www.bergfex.de/sommer/schwaebische-alb/webcams/', ort: '13 km südöstlich' },
  { name: 'St. Johann · Alb',
    url: 'https://images.bergfex.at/webcams/?id=14893&format=4',
    quelle: 'https://www.bergfex.de/sommer/schwaebische-alb/webcams/', ort: '21 km östlich, Feuerwehrturm' },
  { name: 'Burg Hohenzollern',
    url: 'https://www.c-mor.de/burg-hohenzollern/hohenzollern-webcam-live.jpg',
    quelle: 'https://www.zollerblick.de/', ort: '23 km südlich' }
];

/** Portale ohne einbettbares Bild — als Verweis. */
const CAM_PRESETS = [
  { name: 'Region · Kachelmann', page: 'https://kachelmannwetter.com/de/webcams/tuebingen',
    hint: 'Kameras im Umkreis, mit Zeitraffer' },
  { name: 'Region · Übersicht', page: 'https://www.wetteronline.de/webcam/tuebingen',
    hint: 'Alle Kameras im Umkreis bei WetterOnline' }
];

function getCams() { return store.get(LS.cams, []); }

function renderCams() {
  const cams = getCams();
  const box = $('#cams');

  const presets = `
    <div class="cam-links">
      ${CAM_PRESETS.map(c => `
        <a class="cam-link" href="${c.page}" target="_blank" rel="noopener noreferrer">
          <span class="cl-name">${c.name}</span>
          <span class="cl-hint">${c.hint}</span>
          <svg class="cl-arrow" viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>
        </a>`).join('')}
    </div>
    <p class="cam-note">Diese Portale lassen sich nicht einbetten — die Einträge öffnen
      die jeweilige Seite. Wer eine weitere Kamera mit direkter Bild-Adresse kennt (endet auf
      <code>.jpg</code>), trägt sie über <b>＋ Hinzufügen</b> ein und sieht das Bild dann hier.</p>`;

  // Bei jedem Rendern eine neue Adresse, sonst zeigt der Zwischenspeicher
  // stundenlang dasselbe Bild.
  const bust = Date.now();
  const bild = (url) => `${url}${url.includes('?') ? '&' : '?'}_=${bust}`;

  const feste = CAM_FEST.map(c => `
    <figure class="cam">
      <a class="cam-img" href="${c.quelle}" target="_blank" rel="noopener noreferrer">
        <img src="${bild(c.url)}" alt="${c.name}" loading="lazy"
             onerror="this.closest('.cam').classList.add('cam-err')">
        <span class="cam-err-msg">Bild gerade nicht abrufbar</span>
      </a>
      <figcaption>
        <span class="cam-name">${c.name}</span>
        <span class="cam-ort">${c.ort}${c.pflichtQuelle ? ' · foto-webcam.eu' : ''}</span>
      </figcaption>
    </figure>`).join('');

  const eigene = cams.map((c, i) => `
    <figure class="cam" data-i="${i}">
      <div class="cam-img">
        <img src="${esc(bild(c.url))}" alt="${esc(c.name)}" loading="lazy"
             referrerpolicy="no-referrer"
             onerror="this.closest('.cam').classList.add('cam-err')">
        <span class="cam-err-msg">Bild nicht abrufbar</span>
      </div>
      <figcaption>
        <span class="cam-name">${esc(c.name)}</span>
        <button class="cam-del" data-i="${i}" aria-label="Entfernen">✕</button>
      </figcaption>
    </figure>`).join('');

  box.innerHTML = feste + eigene + presets;

  $$('.cam-del', box).forEach(b => b.addEventListener('click', (e) => {
    e.preventDefault();
    const list = getCams(); list.splice(+b.dataset.i, 1);
    store.set(LS.cams, list); renderCams(); renderCamManage();
  }));
}

function renderCamManage() {
  const cams = getCams();
  $('#camManage').innerHTML = cams.length
    ? `<p class="sheet-note">Gespeichert: ${cams.map(c => c.name).join(', ')}</p>` : '';
}

// ══ Orts-Dialog ════════════════════════════════════════════
function openSheet(id) {
  const s = $(id);
  s.hidden = false;
  void s.offsetWidth;              // Reflow erzwingen – requestAnimationFrame feuert
  s.classList.add('open');         // im Hintergrundtab nicht und ließe das Blatt unsichtbar
  document.body.classList.add('sheet-offen');   // Hintergrund nicht mitscrollen
  s.querySelector('.sheet')?.scrollTo?.(0, 0);
}
function closeSheet(id) {
  offenerTag = null;
  const s = $(id); s.classList.remove('open');
  const blatt = s.querySelector('.sheet');
  if (blatt) blatt.style.transform = '';
  setTimeout(() => {
    s.hidden = true;
    if (!$('.sheet-back.open')) document.body.classList.remove('sheet-offen');
  }, 260);
}

/** Nach unten wischen schließt — der Griff sieht danach aus, also soll er es
    auch können. Nur wenn das Blatt schon ganz oben steht, sonst kollidiert
    die Geste mit dem Scrollen im Inhalt. */
function wireSheetGesten() {
  $$('.sheet-back').forEach(back => {
    const blatt = back.querySelector('.sheet');
    if (!blatt) return;
    let startY = 0, zieht = false;

    blatt.addEventListener('touchstart', (e) => {
      zieht = blatt.scrollTop <= 0;
      startY = e.touches[0].clientY;
    }, { passive: true });

    blatt.addEventListener('touchmove', (e) => {
      if (!zieht) return;
      const weg = e.touches[0].clientY - startY;
      if (weg <= 0) { blatt.style.transform = ''; return; }
      blatt.style.transition = 'none';
      blatt.style.transform = `translateY(${weg}px)`;
    }, { passive: true });

    blatt.addEventListener('touchend', (e) => {
      if (!zieht) return;
      const weg = e.changedTouches[0].clientY - startY;
      blatt.style.transition = '';
      if (weg > 90) closeSheet('#' + back.id);
      else blatt.style.transform = '';
      zieht = false;
    });

    back.querySelector('.sheet-x')?.addEventListener('click', () => closeSheet('#' + back.id));
  });

  // Zurücktaste und Esc schließen das oberste Blatt
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const offen = $('.sheet-back.open');
    if (offen) closeSheet('#' + offen.id);
  });
}

/* Die gespeicherten Orte zusätzlich als Chips ganz oben. Der Weg
   „Ortswähler öffnen, tippen, fertig" ist damit zwei Berührungen kurz —
   die Liste weiter unten bleibt für das Löschen. */
function renderOrtsChips() {
  const box = $('#ortChips');
  if (!box) return;
  const saved = store.get(LS.places, []).slice(0, 6);
  if (saved.length < 2) { box.hidden = true; box.innerHTML = ''; return; }

  box.hidden = false;
  box.innerHTML = saved.map((p, i) => {
    const hier = place && Math.abs(p.lat - place.lat) < 0.01 && Math.abs(p.lon - place.lon) < 0.01;
    return `<button class="ort-chip${hier ? ' on' : ''}" data-i="${i}">
      <svg class="oc-pin" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="11" r="2.6"/>
      </svg>${esc(p.name)}</button>`;
  }).join('');

  $$('.ort-chip', box).forEach(b => b.addEventListener('click', () => {
    const liste = store.get(LS.places, []);
    const p = liste[+b.dataset.i];
    if (!p) return;
    closeSheet('#placeSheet');
    selectPlace(p);
  }));
}

function renderSaved() {
  renderOrtsChips();
  const saved = store.get(LS.places, []);
  const box = $('#savedPlaces');
  if (!saved.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="sheet-label">Gespeichert</p>` + saved.map((p, i) => `
    <button class="place-row" data-i="${i}">
      <span><b>${p.name}</b><i>${p.region || ''}</i></span>
      <span class="place-del" data-del="${i}">✕</span>
    </button>`).join('');

  $$('.place-row', box).forEach(b => b.addEventListener('click', (e) => {
    const saved = store.get(LS.places, []);
    if (e.target.dataset.del !== undefined) {
      e.stopPropagation();
      saved.splice(+e.target.dataset.del, 1);
      store.set(LS.places, saved); renderSaved();
      return;
    }
    selectPlace(saved[+b.dataset.i]);
  }));
}

function savePlace(p) {
  const saved = store.get(LS.places, []);
  if (!saved.some(x => Math.abs(x.lat - p.lat) < 0.01 && Math.abs(x.lon - p.lon) < 0.01)) {
    saved.unshift(p);
    store.set(LS.places, saved.slice(0, 8));
  }
}

async function selectPlace(p) {
  place = p;
  store.set(LS.active, p);
  savePlace(p);
  renderSaved();          // frisch gewählter Ort wandert nach vorn und wird markiert
  closeSheet('#placeSheet');
  $('#placeName').textContent = p.name;
  renderSaved();
  await refresh();
  if (radarReady) Radar.setCenter(p.lat, p.lon);
}

// ══ Laden & Aktualisieren ══════════════════════════════════
let busy = false;

async function refresh(leise = false) {
  if (!place || busy) return;
  busy = true;
  document.body.classList.add('loading');
  $('#refreshBtn').classList.add('spin');
  if (!leise) {
    const stamp = $('#footStamp');
    if (stamp) stamp.textContent = 'Daten werden geholt…';
    zeigeStand('lädt…');
    toast('Daten werden geholt…', 1500);
  }

  // Unabhängig von den Zahlen — er soll auch dastehen, wenn Open-Meteo hakt
  loadDwdText(place.lat, place.lon);
  ladeStationen(place.lat, place.lon);
  ladeRueckblick(place.lat, place.lon);
  ladePunktVerlauf(place.lat, place.lon).then(() => renderVerdict());
  renderPush();

  try {
    let [fc, aq, md, warn] = [null, null, null, null];
    try {
      [fc, aq, md, warn] = await Promise.all([
        loadForecast(place.lat, place.lon),
        loadAir(place.lat, place.lon),
        loadModels(place.lat, place.lon),
        loadWarnings()
      ]);
    } catch (e) {
      /* Lieber die letzten bekannten Zahlen zeigen als eine leere App. Beim
         Abruflimit oder ohne Netz stand sonst gar nichts da, obwohl die
         Vorhersage von vorhin noch im Speicher liegt. */
      const alt = store.get(LS.cache, null);
      const passt = alt?.data && Math.abs((alt.place?.lat ?? 99) - place.lat) < 0.2
                              && Math.abs((alt.place?.lon ?? 99) - place.lon) < 0.2;
      if (!passt) throw e;
      fc = alt.data;
      veraltet = true;
      standAlt = alt.at;
      warn = await loadWarnings().catch(() => null);
      console.warn('Frische Daten nicht erreichbar, zeige Stand von',
        new Date(alt.at).toLocaleTimeString('de-DE'));
    }

    /* Erst korrigieren, dann alles Weitere: Sämtliche Anzeigen und auch der
       Zwischenspeicher arbeiten mit den korrigierten Zahlen. */
    await ladeVersatz(place.lat, place.lon);
    air = aq; modelData = md;
    baueWolkenKonsens();
    baueTempKonsens();
    data = wendeVersatzAn(wendeTempMittelAn(fc));
    if (!veraltet) store.set(LS.cache, { at: Date.now(), place, data });

    renderHero();
    renderDayProgress();
    renderVerdict();
    renderWarnings(warn);
    renderHourly();
    renderSource();
    renderVersatzHinweis();
    renderDaily();
    renderMeteogramm();
    renderScrub();
    renderModels(md);
    renderTiles(aq);
    renderLayerPicker();
    renderCountdown();
    renderSonneDetail();
    renderSky();
    renderCams();

    // Radarbilder mitziehen — sonst zeigt die Karte nach dem Aktualisieren
    // weiter den Stand vom Seitenaufruf.
    if (radarReady) {
      Radar.load()
        .then(() => renderScrub())     // neue Messzeiten in die Achse übernehmen
        .catch(e => console.warn('Radar:', e));
    }

    // Bei alten Daten den echten Stand zeigen, nicht die Uhrzeit des Versuchs
    const standZeitpunkt = veraltet && standAlt ? standAlt : Date.now();
    $('#footStamp').textContent =
      `Zuletzt aktualisiert: ${new Date(standZeitpunkt).toLocaleTimeString('de-DE')} · ` +
      `Quelle: ${quellenName()}` +
      (veraltet ? ' · aus dem Zwischenspeicher' : umweg ? ' · über den Umweg geholt' : '');
    setzeStand(standZeitpunkt);
    tagesblattAuffrischen();     // erst jetzt — das Blatt zeigt den Stand mit an
    if (!leise || veraltet) {
      toast(veraltet ? 'Der Wetterdienst antwortet gerade nicht — angezeigt werden die zuletzt geholten Daten.'
                     : 'Aktualisiert.', veraltet ? 4500 : 1400);
    }
    veraltet = false; umweg = false; standAlt = null;
    document.body.classList.remove('loading', 'error');
  } catch (err) {
    console.error(err);
    toast(/429/.test(err?.message)
      ? 'Der Wetterdienst bremst gerade wegen zu vieler Abrufe. In ein paar Minuten nochmal.'
      : 'Daten konnten nicht geladen werden. Offline?', 5000);
    document.body.classList.add('error');
  } finally {
    busy = false;
    $('#refreshBtn').classList.remove('spin');
  }
}

async function useGPS() {
  if (!navigator.geolocation) { toast('Standort wird nicht unterstützt.'); return; }
  toast('Standort wird ermittelt…', 1600);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const p = await reverseGeocode(lat, lon);
    selectPlace(p);
  }, (err) => {
    toast(err.code === 1 ? 'Standortzugriff abgelehnt.' : 'Standort nicht verfügbar.');
  }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 6e5 });
}

/* ── Bist du woanders? ──────────────────────────────────────
   Die App wechselt den Ort nicht von selbst — sonst verlöre man beim Blick
   auf das Wetter zu Hause aus Versehen die Ansicht. Aber wenn das Gerät weit
   weg ist und die Standortfreigabe ohnehin schon erteilt wurde, fragt sie
   einmal nach. Ohne erteilte Freigabe passiert gar nichts. */
const ORTS_SCHWELLE_KM = 40;

async function pruefeStandortWechsel() {
  if (!navigator.geolocation || !place) return;

  // Nur wenn die Erlaubnis schon steht — sonst käme ungefragt ein Dialog
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    if (status && status.state !== 'granted') return;
  } catch { return; }

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const km = entfernungKm(lat, lon, place.lat, place.lon);
    if (km < ORTS_SCHWELLE_KM) return;

    const p = await reverseGeocode(lat, lon).catch(() => null);
    if (!p?.name) return;
    if (store.get('wf.ortAbgelehnt', '') === p.name) return;   // schon abgelehnt

    zeigeOrtsFrage(p, Math.round(km));
  }, () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 9e5 });
}

/** Entfernung zweier Punkte in Kilometern (Haversine). */
function entfernungKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* Verreist? Das lässt sich auch ohne Standortfreigabe erkennen: Open-Meteo
   nennt die Zeitzone des eingestellten Orts, der Browser die des Geräts.
   Weichen sie voneinander ab, steht das Gerät woanders.

   Der Weg über die Standortfreigabe oben greift nämlich nur, wenn jemand
   sie erteilt hat — und die meisten tun das nie. Ein Gerät stand deshalb
   wochenlang in Südtirol und bekam weiter Regenwarnungen für Tübingen. */
const ZONEN_STADT = {
  'Europe/Berlin': 'Deutschland',
  'Europe/Rome': 'Italien', 'Europe/Vienna': 'Österreich', 'Europe/Zurich': 'der Schweiz',
  'Europe/Paris': 'Frankreich', 'Europe/Madrid': 'Spanien', 'Europe/Lisbon': 'Portugal',
  'Europe/Athens': 'Griechenland', 'Europe/Prague': 'Tschechien', 'Europe/Warsaw': 'Polen',
  'Europe/Copenhagen': 'Dänemark', 'Europe/Stockholm': 'Schweden', 'Europe/Oslo': 'Norwegen',
  'Europe/Brussels': 'Belgien', 'Europe/Amsterdam': 'den Niederlanden',
  'Europe/London': 'Großbritannien', 'Europe/Dublin': 'Irland', 'Europe/Istanbul': 'der Türkei',
  'Europe/Budapest': 'Ungarn', 'Europe/Zagreb': 'Kroatien', 'Europe/Ljubljana': 'Slowenien'
};
const zonenWort = (z) => ZONEN_STADT[z]
  || (z.split('/').pop() || z).replace(/_/g, ' ');

function pruefeZeitzone() {
  if (!place || !data?.timezone) return;
  const geraet = geraeteZone();
  if (!geraet || geraet === data.timezone) return;
  if (store.get('wf.zoneAbgelehnt', '') === geraet) return;
  if ($('#ortsFrage')) return;              // die Standortfrage steht schon
  zeigeZonenFrage(geraet);
}

function zeigeZonenFrage(zone) {
  const el = document.createElement('div');
  el.className = 'orts-frage';
  el.id = 'ortsFrage';
  el.innerHTML = `
    <span class="of-text">Dein Gerät ist auf die Zeit in <b>${esc(zonenWort(zone))}</b>
      eingestellt — dein Wetterort ist aber <b>${esc(place.name)}</b>. Bist du verreist?
      Auch die Meldungen gehen weiter nach ${esc(place.name)}.</span>
    <span class="of-knoepfe">
      <button class="of-ja">Ort ändern</button>
      <button class="of-nein">${esc(place.name)} behalten</button>
    </span>`;
  document.querySelector('#app')?.prepend(el);

  el.querySelector('.of-ja').onclick = () => {
    el.remove();
    renderSaved();
    openSheet('#placeSheet');
    $('#placeSearch')?.focus();
  };
  el.querySelector('.of-nein').onclick = () => {
    // Nicht noch einmal für dieselbe Zeitzone fragen — die Antwort gilt
    store.set('wf.zoneAbgelehnt', zone);
    el.remove();
  };
}

function zeigeOrtsFrage(p, km) {
  const alt = $('#ortsFrage');
  if (alt) alt.remove();

  const el = document.createElement('div');
  el.className = 'orts-frage';
  el.id = 'ortsFrage';
  el.innerHTML = `
    <span class="of-text">Du scheinst in <b>${esc(p.name)}</b> zu sein —
      ${km} km von ${place.name} entfernt. Wetter dort anzeigen?</span>
    <span class="of-knoepfe">
      <button class="of-ja">Ja, wechseln</button>
      <button class="of-nein">Nein</button>
    </span>`;
  document.querySelector('#app')?.prepend(el);

  el.querySelector('.of-ja').onclick = () => { el.remove(); selectPlace(p); };
  el.querySelector('.of-nein').onclick = () => {
    store.set('wf.ortAbgelehnt', p.name);      // nicht nochmal für denselben Ort fragen
    el.remove();
  };
}

// ══ Sprungleiste ═══════════════════════════════════════════
/* ── Wo ist gerade Tag? ─────────────────────────────────────
   Die Grenze zwischen Tag und Nacht heißt Terminator. Sie hängt nur von der
   Sonnendeklination und der Uhrzeit ab — beides steckt schon in sunAltitude,
   hier nur der Punkt, über dem die Sonne senkrecht steht. */
function subsolarPunkt(date = new Date()) {
  const rad = Math.PI / 180;
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = (280.459 + 0.98564736 * d) * rad;
  const L = q + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  let lon = ra - gmst * 15;
  lon = ((lon + 540) % 360) - 180;
  return { lat: dec, lon };
}

/** Nachtseite als Polygon — eine Punktkette entlang der Grenze, oben oder
    unten zum Pol geschlossen, je nach Jahreszeit. */
function nachtPolygon(date = new Date()) {
  const rad = Math.PI / 180;
  const sonne = subsolarPunkt(date);
  const punkte = [];
  for (let x = -180; x <= 180; x += 2) {
    const stundenwinkel = (x - sonne.lon) * rad;
    const lat = Math.atan(-Math.cos(stundenwinkel) / Math.tan(sonne.lat * rad)) / rad;
    punkte.push([x, Math.max(-89.5, Math.min(89.5, lat))]);
  }
  // Im Nordsommer ist die Nacht unten, im Nordwinter oben
  const polSeite = sonne.lat > 0 ? -90 : 90;
  const ring = [...punkte, [180, polSeite], [-180, polSeite], punkte[0]];
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

let globusKarte = null, globusTimer = null;

function openTerminator() {
  const sonne = subsolarPunkt();
  const hierHell = sunAltitude(new Date(), place.lat, place.lon) > -0.833;

  $('#explainTitle').textContent = 'Wo ist gerade Tag?';
  $('#explainText').innerHTML = `
    <div class="globus-wrap"><div id="globusMap"></div></div>
    <p class="globus-note" id="globusNote"></p>
    <p class="ds-note">Die Sonne steht in jedem Moment über genau einem Punkt der
      Erde senkrecht. Von dort aus wird es nach allen Seiten hin später
      Nachmittag, Abend, Nacht. Die Grenze wandert pro Stunde 15 Längengrade
      nach Westen — deshalb geht die Sonne im Osten früher auf.</p>`;

  $('#globusNote').innerHTML =
    `Senkrecht steht die Sonne gerade über <b>${Math.abs(sonne.lat).toFixed(1)}° ${sonne.lat >= 0 ? 'Nord' : 'Süd'}, ` +
    `${Math.abs(sonne.lon).toFixed(1)}° ${sonne.lon >= 0 ? 'Ost' : 'West'}</b>. ` +
    `Bei dir in ${place.name} ist es gerade ${hierHell ? 'hell' : 'dunkel'}.`;

  openSheet('#explainSheet');
  const l = $('#explainLink');
  if (l) l.hidden = true;

  // Erst nach dem Öffnen bauen — vorher hat der Container keine Größe
  setTimeout(() => baueGlobus(), 60);
}

function baueGlobus() {
  const ziel = document.getElementById('globusMap');
  if (!ziel || typeof maplibregl === 'undefined') return;

  /* Helle Karte als Tagseite, darüber die Nachtseite als dunkle Fläche —
     so sieht man auf einen Blick, wo gerade Licht ist. Auf einer dunklen
     Grundkarte wäre der Unterschied nicht zu erkennen gewesen. */
  globusKarte = new maplibregl.Map({
    container: ziel,
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [place.lon, place.lat],
    zoom: 0.55,
    projection: { type: 'globe' },
    attributionControl: false,
    interactive: true
  });

  globusKarte.on('load', () => {
    globusKarte.addSource('nacht', { type: 'geojson', data: nachtPolygon() });
    globusKarte.addLayer({ id: 'nacht', type: 'fill', source: 'nacht',
      paint: { 'fill-color': '#0a1428', 'fill-opacity': 0.74 } });
    // Dämmerungssaum: der Übergang ist keine scharfe Kante
    globusKarte.addLayer({ id: 'nachtkante', type: 'line', source: 'nacht',
      paint: { 'line-color': '#ff9a3c', 'line-width': 2.4, 'line-opacity': 0.85,
               'line-blur': 2 } });

    const s = subsolarPunkt();
    globusKarte.addSource('sonne', { type: 'geojson', data: {
      type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { z: '☀️' }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } },
        { type: 'Feature', properties: { z: '📍' }, geometry: { type: 'Point', coordinates: [place.lon, place.lat] } }
      ]}});
    globusKarte.addLayer({ id: 'sonne', type: 'symbol', source: 'sonne',
      layout: { 'text-field': ['get', 'z'], 'text-size': 22, 'text-allow-overlap': true } });

    // Alle halbe Minute nachführen, solange das Fenster offen ist
    clearInterval(globusTimer);
    globusTimer = setInterval(() => {
      if (!document.getElementById('globusMap')) {
        clearInterval(globusTimer);
        globusKarte?.remove(); globusKarte = null;
        return;
      }
      globusKarte.getSource('nacht')?.setData(nachtPolygon());
      const n = subsolarPunkt();
      globusKarte.getSource('sonne')?.setData({
        type: 'FeatureCollection', features: [
          { type: 'Feature', properties: { z: '☀️' }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } },
          { type: 'Feature', properties: { z: '📍' }, geometry: { type: 'Point', coordinates: [place.lon, place.lat] } }
        ]});
    }, 30000);
  });
}

/* ── Auf den Homeschirm legen ───────────────────────────────
   Android bietet dafür ein eigenes Fenster an, das der Browser über
   `beforeinstallprompt` anbietet. Safari kennt das nicht — dort bleibt nur
   die Anleitung von Hand. */
let installEreignis = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEreignis = e;
  renderInstall();
});

function renderInstall() {
  const karte = $('#installCard');
  if (!karte) return;
  if (alsAppInstalliert()) { karte.hidden = true; return; }

  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const schritte = $('#installSteps');

  if (iOS) {
    schritte.innerHTML = `
      <ol class="inst-list">
        <li>Unten in Safari auf <b>Teilen</b> tippen
          <svg class="inst-ico" viewBox="0 0 24 24"><path d="M12 3v13M8.5 6.5L12 3l3.5 3.5"/><path d="M6 12v7.5h12V12"/></svg></li>
        <li>In der Liste nach unten wischen bis <b>Zum Home-Bildschirm</b></li>
        <li><b>Hinzufügen</b> tippen — fertig</li>
      </ol>
      <p class="inst-note">Geht nur in Safari, nicht in Chrome oder Firefox auf dem iPhone.</p>`;
    $('#installBtn').hidden = true;
  } else if (installEreignis) {
    schritte.innerHTML = `<p class="inst-note">Ein Tippen genügt — der Browser fragt nach.</p>`;
    $('#installBtn').hidden = false;
  } else {
    schritte.innerHTML = `
      <ol class="inst-list">
        <li>Im Browsermenü <b>⋮</b> öffnen</li>
        <li><b>App installieren</b> oder <b>Zum Startbildschirm zufügen</b> wählen</li>
        <li>Bestätigen — fertig</li>
      </ol>`;
    $('#installBtn').hidden = true;
  }
  karte.hidden = false;
}

async function installAnstossen() {
  if (!installEreignis) return;
  installEreignis.prompt();
  const { outcome } = await installEreignis.userChoice;
  installEreignis = null;
  if (outcome === 'accepted') $('#installCard').hidden = true;
  else toast('Kannst du jederzeit später machen.');
}

/* Was der Sonnenstand im Alltag bedeutet. Die Schattenlänge folgt dem
   Kotangens: bei 45° genau die Körpergröße, bei 27° das Doppelte,
   bei 18° das Dreifache. Die Stufen sind danach gesetzt, damit Wort und
   Zahl in der Erklärung nicht auseinanderlaufen. */
/** Wie die Ringfarben, nur als Wort: In welcher Lichtphase liegt diese
    Sonnenhöhe? Die Grenzen sind dieselben wie in `stufen` der Ringuhr. */
function lichtWort(alt) {
  if (alt > 6)      return 'Tag';
  if (alt > -0.833) return 'Goldene Stunde';
  if (alt > -6)     return 'Blaue Stunde';
  if (alt > -12)    return 'Nautische Dämmerung';
  if (alt > -18)    return 'Astronomische Dämmerung';
  return 'Nacht';
}

function winkelWort(grad) {
  if (grad < 6)  return 'sehr flach, Schatten zehnfach und länger';
  if (grad < 11) return 'flach, Schatten etwa fünfmal so lang wie du';
  if (grad < 18) return 'tief, Schatten drei- bis viermal so lang wie du';
  if (grad < 27) return 'schräg, Schatten gut doppelt so lang wie du';
  if (grad < 40) return 'mittelhoch, Schatten anderthalbmal so lang wie du';
  if (grad < 52) return 'hoch, Schatten etwa so lang wie du';
  if (grad < 65) return 'steil, Schatten kürzer als du';
  return 'sehr steil, kaum Schatten';
}

/** Wettercode zu Zeichen — für das Teilen-Bild, wo kein SVG passt. */
function wetterZeichen(code, tag = 1) {
  if (code === 0) return tag ? '☀️' : '🌙';
  if (code <= 2) return tag ? '🌤' : '🌙';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫';
  if (code <= 57) return '🌦';
  if (code <= 67) return '🌧';
  if (code <= 77) return '🌨';
  if (code <= 82) return '🌧';
  if (code <= 86) return '🌨';
  return '⛈';
}

/* ── Wetter teilen ──────────────────────────────────────────
   Zeichnet eine Karte mit den wichtigsten Werten und teilt sie über das
   Teilen-Menü des Geräts. Ohne Bild-Unterstützung geht der Text allein raus. */
async function wetterBild() {
  const c = data?.current, d = data?.daily;
  if (!c) return null;

  const B = 1080, H = 1080, s = 2;                 // quadratisch, gut für Nachrichten
  const cv = document.createElement('canvas');
  cv.width = B; cv.height = H;
  const g = cv.getContext('2d');

  // Hintergrund in der Stimmung der App
  const mood = document.body.dataset.mood || 'clear';
  const paare = {
    clear: ['#3a8ee0', '#12325c'], partly: ['#4b83c4', '#16304d'],
    cloudy: ['#5a6a7d', '#222d3b'], rain: ['#3c5570', '#16222f'],
    storm: ['#3b3f5c', '#191d2c'], snow: ['#6b7d92', '#26313f'],
    fog: ['#5b6470', '#242a33'], night: ['#1d3f75', '#0b1220']
  };
  const [oben, unten] = paare[mood] || paare.clear;
  const verlauf = g.createLinearGradient(0, 0, 0, H);
  verlauf.addColorStop(0, oben); verlauf.addColorStop(1, unten);
  g.fillStyle = verlauf; g.fillRect(0, 0, B, H);

  const schrift = (px, gew = '400') => `${gew} ${px}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.textAlign = 'center';

  // Ort
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.font = schrift(46, '600');
  g.fillText(place.name, B / 2, 130);

  // Wetterzeichen als Zeichen — ein SVG einzubetten wäre umständlicher
  g.font = schrift(150);
  g.fillText(wetterZeichen(c.weather_code, c.is_day), B / 2, 300);

  // Temperatur
  g.fillStyle = '#fff';
  g.font = schrift(200, '200');
  g.fillText(`${round(c.temperature_2m)}°`, B / 2, 480);

  g.fillStyle = 'rgba(255,255,255,.9)';
  g.font = schrift(52);
  g.fillText(WX.text(c.weather_code, c.is_day), B / 2, 552);

  g.fillStyle = 'rgba(255,255,255,.7)';
  g.font = schrift(38);
  g.fillText(`gefühlt ${round(c.apparent_temperature)}°  ·  ` +
             `${round(d.temperature_2m_max[0])}° / ${round(d.temperature_2m_min[0])}°`, B / 2, 614);

  // Klartext-Zeile, auf zwei Zeilen umgebrochen
  const satz = $('#verdict')?.textContent?.trim() || '';
  if (satz) {
    g.font = schrift(36);
    g.fillStyle = 'rgba(255,255,255,.82)';
    const worte = satz.split(' ');
    let zeile = '', y = 706;
    for (const w of worte) {
      const test = zeile ? `${zeile} ${w}` : w;
      if (g.measureText(test).width > B - 140 && zeile) {
        g.fillText(zeile, B / 2, y); y += 50; zeile = w;
        if (y > 806) break;
      } else zeile = test;
    }
    if (zeile && y <= 806) g.fillText(zeile, B / 2, y);
  }

  // Die nächsten Stunden als kleine Leiste
  const h = data.hourly, i0 = nowIndex(h.time);
  g.font = schrift(30);
  for (let k = 0; k < 5; k++) {
    const i = i0 + k * 2;
    if (i >= h.time.length) break;
    const x = 140 + k * 200;
    g.fillStyle = 'rgba(255,255,255,.6)';
    g.fillText(hhmm(h.time[i]), x, 900);
    g.fillStyle = '#fff';
    g.font = schrift(44, '500');
    g.fillText(`${round(h.temperature_2m[i])}°`, x, 952);
    g.font = schrift(30);
  }

  // Fuß
  g.fillStyle = 'rgba(255,255,255,.55)';
  g.font = schrift(28);
  g.fillText('Wetterfunk · wetterfunk von Florian S. Thiel', B / 2, 1030);

  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}

async function wetterTeilen() {
  const c = data?.current, d = data?.daily;
  if (!c) { toast('Noch keine Daten zum Teilen.'); return; }

  const text = `${place.name}: ${round(c.temperature_2m)}°, ${WX.text(c.weather_code, c.is_day)}. ` +
    `Heute ${round(d.temperature_2m_min[0])}° bis ${round(d.temperature_2m_max[0])}°. ` +
    ($('#verdict')?.textContent?.trim() || '');
  const url = location.href.split('#')[0];

  try {
    const blob = await wetterBild();
    const datei = blob ? new File([blob], `wetter-${place.name}.png`, { type: 'image/png' }) : null;

    // Erst mit Bild versuchen — nicht jedes Gerät kann Dateien teilen
    if (datei && navigator.canShare?.({ files: [datei] })) {
      await navigator.share({ files: [datei], text, title: `Wetter in ${place.name}` });
      return;
    }
    if (navigator.share) {
      await navigator.share({ title: `Wetter in ${place.name}`, text, url });
      return;
    }
    // Kein Teilen-Menü: Text in die Zwischenablage
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('In die Zwischenablage kopiert.');
  } catch (e) {
    if (e?.name === 'AbortError') return;          // Nutzer hat abgebrochen
    console.warn('Teilen:', e);
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('In die Zwischenablage kopiert.');
    } catch { toast('Teilen hat nicht geklappt.'); }
  }
}

/* ── Impressum und Datenschutz ──────────────────────────────
   Die Seite ist öffentlich abrufbar, damit greift die Impressumspflicht
   nach § 5 DDG. Der Datenschutzhinweis ist kurz, weil es kaum etwas zu
   erklären gibt: Es werden keine Daten erhoben. */
function openImpressum() {
  $('#explainTitle').textContent = 'Impressum';
  $('#explainText').innerHTML = `
    <p style="margin:0 0 14px">Angaben gemäß § 5 Digitale-Dienste-Gesetz (DDG).</p>
    <dl class="ds-facts">
      <dt>Verantwortlich</dt><dd>Florian S. Thiel</dd>
      <dt>Anschrift</dt><dd>Kingersheimer Straße 36<br>72070 Tübingen<br>Deutschland</dd>
      <dt>Kontakt</dt><dd><a href="mailto:florian.s.thiel@gmail.com">florian.s.thiel@gmail.com</a></dd>
    </dl>
    <p class="ds-untertitel">Haftung für Inhalte</p>
    <p class="eh-text">Wetterfunk zeigt Daten des Deutschen Wetterdienstes und weiterer
      Anbieter. Für die Richtigkeit der Vorhersagen wird keine Gewähr übernommen.
      Bei Unwetterlagen gelten ausschließlich die amtlichen Warnungen des DWD.</p>
    <p class="ds-untertitel">Verlinkte Seiten</p>
    <p class="eh-text">Für die Inhalte verlinkter Seiten (Webcams, Wetterdienste)
      sind deren Betreiber verantwortlich.</p>`;
  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
}

function openDatenschutz() {
  $('#explainTitle').textContent = 'Datenschutz';
  $('#explainText').innerHTML = `
    <p class="ds-note" style="margin:0 0 15px">Wetterfunk erhebt keine personenbezogenen
      Daten, setzt keine Cookies und bindet keine Zähl- oder Werbedienste ein.
      Es gibt kein Konto und keine Anmeldung.</p>
    <p class="ds-untertitel">Was auf deinem Gerät bleibt</p>
    <p class="eh-text">Der gewählte Ort, deine Einstellungen und zwischengespeicherte
      Wetterdaten liegen ausschließlich im Speicher deines Browsers. Sie werden nicht
      übertragen und verschwinden, wenn du die Websitedaten löschst.</p>
    <p class="ds-untertitel">Welche Dienste angefragt werden</p>
    <p class="eh-text">Damit Wetterdaten erscheinen, ruft dein Gerät diese Anbieter
      direkt auf. Dabei wird technisch bedingt deine IP-Adresse übermittelt —
      wie bei jedem Aufruf einer Webseite:</p>
    <dl class="ds-facts">
      <dt>Open-Meteo</dt><dd>Vorhersagedaten (Schweiz/EU)</dd>
      <dt>Bright Sky</dt><dd>Messwerte des DWD (Deutschland)</dd>
      <dt>Deutscher Wetterdienst</dt><dd>Warnungen, Radarbild, Berichte</dd>
      <dt>RainViewer</dt><dd>Radarbilder</dd>
      <dt>OpenFreeMap</dt><dd>Kartenmaterial</dd>
    </dl>
    <p class="ds-untertitel">Standort</p>
    <p class="eh-text">Der Standort wird nur abgefragt, wenn du auf den Standortknopf
      tippst, und nur zur Bestimmung des Wetterortes verwendet. Er wird nicht gespeichert
      und nicht weitergegeben.</p>
    <p class="ds-untertitel">Meldungen aufs Gerät</p>
    <p class="eh-text">Schaltest du Meldungen ein, werden die Abo-Adresse deines Geräts,
      der gewählte Ort und der Landkreis auf einem Server (Cloudflare) gespeichert —
      nur, um die Meldungen zuzustellen. Schaltest du sie aus, wird der Eintrag gelöscht.</p>
    <p class="ds-untertitel">KI-Berichte</p>
    <p class="eh-text">Lässt du einen Wetterbericht schreiben, gehen die angezeigten
      Wetterdaten und der Ortsname an das Sprachmodell. Persönliche Angaben sind nicht
      dabei.</p>`;
  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
}

/* Die wichtigste Zeile für alle, die den Sonnenuntergang wirklich sehen
   wollen: nicht wann er ist, sondern wann man losgehen muss. Steht direkt
   unter dem Countdown, weil man dort ohnehin nachschaut. */
function losgehenZeile() {
  if (!place || !data?.daily) return '';
  const ev = sunEvents(new Date(), place.lat, place.lon);
  if (!ev.goldenStartAbend || !ev.untergang) return '';

  const start = new Date(ev.goldenStartAbend).getTime();
  const unter = new Date(ev.untergang).getTime();
  const jetzt = Date.now();
  if (jetzt > unter) return '';                       // heute vorbei

  const bis = Math.round((start - jetzt) / 60000);
  const dauer = Math.round((unter - start) / 60000);

  /* Kein data-t hier: Der Countdown-Takt schreibt in jedes Element mit diesem
     Attribut die Restzeit und würde den ganzen Block überschreiben. */
  return `<div class="cd-losgehen">
    <span class="cl-kopf">🌅 Für den Sonnenuntergang</span>
    <span class="cl-haupt">${bis > 0
      ? `Ab <b>${hhmm(start)}</b> dort sein — in ${bis > 90
          ? `${Math.floor(bis / 60)} Std. ${String(bis % 60).padStart(2, '0')} Min.` : `${bis} Min.`}`
      : `Das gute Licht läuft <b>jetzt gerade</b>`}</span>
    <span class="cl-weg">Dann beginnt die goldene Stunde: ${dauer} Minuten warmes Licht
      bis zum Untergang um ${hhmm(unter)}. Danach die blaue Stunde, oft mit den
      kräftigsten Farben.</span>
  </div>`;
}

/* Wer den Sonnenuntergang sehen will, muss vorher da sein: Das schöne Licht
   beginnt mit der goldenen Stunde, und bis zu einem Aussichtspunkt braucht
   man Zeit. Punkt Sonnenuntergang anzukommen heißt, das Beste zu verpassen. */
function sonnenuntergangTipp(ev) {
  if (!ev.goldenStartAbend || !ev.untergang) return '';
  const start = new Date(ev.goldenStartAbend), unter = new Date(ev.untergang);
  const jetzt = Date.now();
  const bisStart = Math.round((start - jetzt) / 60000);

  if (bisStart < -30 && jetzt > unter.getTime()) return '';   // vorbei für heute

  const wann = bisStart > 120 ? `ab ${hhmm(start)} Uhr`
             : bisStart > 0 ? `in ${bisStart} Min., ab ${hhmm(start)} Uhr`
             : 'jetzt gerade';
  const dauer = Math.round((unter - start) / 60000);

  return `<p class="su-tipp">
    <b>Für den Sonnenuntergang</b> lohnt es sich, ${wann} draußen zu sein —
    dann beginnt die goldene Stunde und das Licht wird warm. Sie dauert etwa
    ${dauer} Minuten bis zum Untergang um ${hhmm(unter)} Uhr. Danach folgt noch
    die blaue Stunde; oft sind die Farben erst nach dem Untergang am kräftigsten.
    Für einen Aussichtspunkt den Aufstieg dazurechnen.
  </p>`;
}

/* ── Messwerte aus der Region ───────────────────────────────
   Echte Stationsmessungen des DWD über Bright Sky — ein freier Zugang zu
   denselben Daten, aber als JSON und mit Freigabe für den Browser. Die
   Vorhersagezahlen der App sind gerechnet, das hier ist gemessen. */
const BRIGHTSKY = 'https://api.brightsky.dev';

async function ladeStationen(lat, lon) {
  const karte = $('#stationenCard');
  if (!karte) return;

  try {
    const res = await fetch(`${BRIGHTSKY}/sources?lat=${lat}&lon=${lon}&max_dist=70000`);
    if (!res.ok) throw new Error(`Stationen ${res.status}`);
    const { sources = [] } = await res.json();

    /* Nur echte Messstationen ("synop"), und nur solche, die in der letzten
       Stunde gemeldet haben — sonst antwortet der Messwert-Abruf mit 404. */
    const frisch = Date.now() - 3600000;
    const nah = sources
      .filter(s => s.observation_type === 'synop' && s.last_record
                && new Date(s.last_record).getTime() > frisch)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 7);

    if (!nah.length) { karte.hidden = true; return; }

    const werte = await Promise.all(nah.map(s =>
      fetch(`${BRIGHTSKY}/current_weather?source_id=${s.id}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)));

    const zeilen = nah.map((s, i) => ({ station: s, w: werte[i]?.weather }))
      .filter(x => x.w && x.w.temperature != null);

    if (!zeilen.length) { karte.hidden = true; return; }
    renderStationen(zeilen);
    karte.hidden = false;
    renderHeroMessung(zeilen);
    // Die Messung kann die Regenfrage anders beantworten als das Modell
    if (data?.current) renderVerdict();
  } catch (e) {
    console.warn('Stationen:', e.message);
    karte.hidden = true;
    naechsteStation = null;
    const el = $('#heroMess'); if (el) el.hidden = true;
  }
}

/* Die große Zahl oben kommt aus einem Rechenmodell: Der Wetterdienst
   rechnet ein Gitter über Deutschland und liest den Wert für deinen Punkt
   ab. Das ist kein Thermometer. In der Stadt, im Tal oder auf dem Berg kann
   das Modell ein bis zwei Grad danebenliegen.

   Deshalb steht darunter, was die nächste echte DWD-Station gerade gemessen
   hat — mit Name, Entfernung und Uhrzeit der Messung, damit man beides
   einordnen kann. Nur für Deutschland: Bright Sky kennt nur DWD-Stationen. */
let naechsteStation = null;

/* Wind, Böen und Regen meldet der DWD über 10, 30 oder 60 Minuten gemittelt —
   je nach Station steht nur eines davon in der Antwort. Das kürzeste zuerst. */
const messWert = (w, feld) => w[`${feld}_10`] ?? w[`${feld}_30`] ?? w[`${feld}_60`] ?? null;

/* Alle Stationen der letzten Abfrage — die Kopfzeile zeigt nur das Nötigste,
   das Blatt beim Antippen zeigt sie vollständig. */
let messZeilen = null;

const abstandKm = (z) => z.station.distance / 1000;
const stationName = (z) => `${esc(z.station.station_name)}, ${
  abstandKm(z) < 10 ? dez(abstandKm(z)) : Math.round(abstandKm(z))} km`;

/* Wind mit Richtung und Böen, sofern die Station ihn misst. */
function windMessung(z) {
  const x = z?.w;
  const wind = x ? messWert(x, 'wind_speed') : null;
  if (wind == null) return null;
  const boe = messWert(x, 'wind_gust_speed');
  const richtung = messWert(x, 'wind_direction');
  return {
    kurz: `Wind ${richtung != null ? dirName(richtung) + ' ' : ''}${round(wind)} km/h`,
    boe: boe != null && boe >= wind + 5 ? `Böen ${round(boe)} km/h` : null,
    wind
  };
}

function renderHeroMessung(zeilen) {
  const el = $('#heroMess');
  if (!el) return;
  naechsteStation = null;
  messZeilen = zeilen?.length ? zeilen : null;
  el.hidden = true;
  const erste = zeilen?.[0];
  if (!erste?.w || erste.w.temperature == null) return;

  const km = abstandKm(erste);
  const alterMin = (Date.now() - new Date(erste.w.timestamp).getTime()) / 60000;
  // Zu weit weg oder zu alt sagt nichts mehr über den eigenen Standort aus
  if (km > 60 || alterMin > 100 || alterMin < -10) return;

  naechsteStation = erste;
  const w = erste.w;

  /* Der Kasten hier war ein zweiter Wetterblock unter dem ersten: noch eine
     Temperatur, noch eine Zeile Stationsnamen. Die große Zahl oben genügt.
     Gezeigt wird deshalb nur, was sie nicht sagt — Feuchte und Wind, und
     zwar gemessen statt gerechnet. Namen, Entfernungen, Luftdruck und die
     übrigen Stationen stehen beim Antippen.

     Ausnahme: Weicht die Messung deutlich von der gerechneten Zahl ab,
     gehört das nach vorn. Ein Grad ist Rauschen, zwei sind eine Aussage. */
  const teile = [`gemessen ${hhmm(new Date(w.timestamp))}`];
  const modellT = data?.current?.temperature_2m;
  if (modellT != null && Math.abs(w.temperature - modellT) >= 2) {
    teile.push(`<b>${dez(w.temperature)}°</b>`);
  }
  if (w.relative_humidity != null) teile.push(`${w.relative_humidity} % Feuchte`);

  /* Kleine Automatikstationen messen oft nur Temperatur und Feuchte. Fehlt
     der Wind, wird er von der nächsten Station geholt, die ihn misst. Ein
     Stationsname steht hier bewusst nicht dabei — er stünde sonst über
     einem geliehenen Wert. Im Blatt beim Antippen ist jeder Wert seiner
     Station zugeordnet. */
  const windVon = windMessung(erste)
    ? erste
    : zeilen.find(z => abstandKm(z) <= 60 && windMessung(z));
  const wm = windMessung(windVon);
  if (wm) teile.push(wm.kurz);
  if (teile.length === 1 && w.cloud_cover != null) teile.push(wolkenWort(w.cloud_cover));
  if (teile.length === 1) return;

  el.innerHTML = `<span class="hm-dot" aria-hidden="true"></span>
    <span class="hm-werte">${teile.map(v => `<span>${v}</span>`).join('')}</span>
    <span class="hm-mehr" aria-hidden="true">›</span>`;
  el.setAttribute('aria-label',
    `Messwerte der Wetterstation ${erste.station.station_name}, ${Math.round(km)} km entfernt`);
  el.hidden = false;
}

/** Das ganze Messbild: nächste Station im Vergleich zum Modell, dann die
    übrigen Stationen ringsum — jeder Wert mit seiner Herkunft. */
function openMessung() {
  const zeilen = messZeilen;
  const erste = zeilen?.[0];
  if (!erste) { openExplain('messung'); return; }

  const w = erste.w;
  const modellT = data?.current?.temperature_2m;
  const diff = modellT != null ? w.temperature - modellT : null;

  const wm = windMessung(erste);
  const geliehen = wm ? null : zeilen.find(z => abstandKm(z) <= 60 && windMessung(z));
  const gm = windMessung(geliehen);

  const werte = [];
  if (w.relative_humidity != null) werte.push(['Luftfeuchte', `${w.relative_humidity} %`, '']);
  if (wm) werte.push(['Wind', `${wm.kurz.replace('Wind ', '')}`, wm.boe || '']);
  else if (gm) werte.push(['Wind', gm.kurz.replace('Wind ', ''),
                           `gemessen in ${stationName(geliehen)}`]);
  if (w.cloud_cover != null) werte.push(['Bewölkung', `${w.cloud_cover} %`, wolkenWort(w.cloud_cover)]);
  if (w.pressure_msl != null) werte.push(['Luftdruck', `${round(w.pressure_msl)} hPa`,
    w.pressure_msl >= 1020 ? 'Hochdruck' : w.pressure_msl <= 1000 ? 'Tiefdruck' : 'normal']);
  const regen = messWert(w, 'precipitation');
  if (regen != null) werte.push(['Niederschlag',
    regen > 0 ? `${dez(regen)} mm` : 'nichts gefallen', 'in der letzten Stunde']);

  const weitere = (zeilen || []).slice(1, 6);

  $('#explainTitle').textContent = 'Gemessen statt gerechnet';
  $('#explainText').innerHTML = `
    <div class="ms-kopf">
      <span class="ms-paar">
        <b>${round(modellT)}°</b><i>gerechnet für ${esc(place?.name || 'deinen Ort')}</i>
      </span>
      <span class="ms-pfeil" aria-hidden="true">↔</span>
      <span class="ms-paar">
        <b>${dez(w.temperature)}°</b><i>gemessen, ${stationName(erste)}</i>
      </span>
    </div>
    <p class="ms-satz">${diff == null ? ''
      : Math.abs(diff) < 1
        ? 'Beide Zahlen liegen beieinander — das Modell trifft deinen Ort gerade gut.'
        : `Das sind <b>${dez(Math.abs(diff))}°</b> Unterschied. Die Station steht
           ${erste.station.height != null ? `auf ${Math.round(erste.station.height)} m und ` : ''}
           ${Math.round(abstandKm(erste))} km entfernt — Höhe und Lage erklären
           solche Abstände meist besser als ein Fehler im Modell.`}</p>

    <dl class="ds-facts">
      <dt>Messzeit</dt><dd>${hhmm(new Date(w.timestamp))} Uhr<i>${
        esc(erste.station.station_name)}, DWD</i></dd>
      ${werte.map(([k, v, s]) => `<dt>${k}</dt><dd>${v}${s ? `<i>${s}</i>` : ''}</dd>`).join('')}
    </dl>

    ${weitere.length ? `<p class="rs-kopf">Stationen ringsum</p>
      <div class="ms-liste">${weitere.map(z => `
        <span class="ms-zeile">
          <span class="ms-ort"><b>${esc(z.station.station_name)}</b>
            <i>${Math.round(abstandKm(z))} km${
              z.station.height != null ? ` · ${Math.round(z.station.height)} m` : ''}</i></span>
          <span class="ms-grad">${dez(z.w.temperature)}°</span>
        </span>`).join('')}</div>` : ''}

    <p class="ds-note">${EXPLAIN.messung.text.split('\n\n')[0]}</p>`;

  const l = $('#explainLink');
  if (l) {
    l.href = EXPLAIN.messung.link.url;
    l.textContent = `${EXPLAIN.messung.link.text} öffnen →`;
    l.hidden = false;
  }
  openSheet('#explainSheet');
}

function renderStationen(zeilen) {
  const neueste = Math.max(...zeilen.map(z => new Date(z.w.timestamp).getTime()));
  $('#stationenStand').textContent = `gemessen ${hhmm(neueste)} Uhr`;

  $('#stationen').innerHTML = zeilen.map(({ station: s, w }) => {
    const wind = messWert(w, 'wind_speed');
    const boe = messWert(w, 'wind_gust_speed');
    const richtung = messWert(w, 'wind_direction');
    const km = Math.round(s.distance / 1000);

    const rechts = [];
    if (w.cloud_cover != null) rechts.push(wolkenWort(w.cloud_cover));
    if (wind != null) rechts.push(`Wind ${richtung != null ? dirName(richtung) + ' ' : ''}${round(wind)} km/h`);
    if (boe != null && boe >= (wind ?? 0) + 5) rechts.push(`Böen ${round(boe)} km/h`);
    if (!rechts.length && w.relative_humidity != null) rechts.push(`Feuchte ${w.relative_humidity} %`);

    return `<div class="st-zeile">
      <span class="st-ort">
        <b>${esc(s.station_name)}</b>
        <i>${s.height != null ? `${Math.round(s.height)} m` : ''}${
             s.height != null && km ? ' · ' : ''}${km ? `${km} km entfernt` : ''}</i>
      </span>
      <span class="st-temp">${dez(w.temperature)}°</span>
      <span class="st-rest">${rechts.join('<br>') || '–'}</span>
    </div>`;
  }).join('');
}

const wolkenWort = (p) => p < 12 ? 'wolkenlos' : p < 38 ? 'heiter'
                        : p < 70 ? 'wolkig' : p < 88 ? 'stark bewölkt' : 'bedeckt';

/* ── Was zeigt die Karte gerade? ────────────────────────────
   Bei mehreren Ebenen übereinander sind farbige Schatten ohne Erklärung
   nicht zu deuten. Ein Tippen auf die Legende sagt, was was bedeutet. */
const EBENEN_HILFE = {
  regen: { name: 'Niederschlag', farbe: '#5ac8fa',
    text: 'Wie viel Regen oder Schnee in einer Stunde fällt. Blau ist wenig, '
        + 'grün und gelb mittel, rot und violett viel. Unter 0,5 mm merkt man kaum etwas, '
        + 'ab 5 mm in der Stunde wird man ohne Schirm nass.' },
  schirme: { name: 'Regenschirme', farbe: '#4aa8e0',
    text: 'Ein Schirm steht dort, wo in der gezeigten Stunde mindestens 0,15 mm Regen '
        + 'fallen; daneben die Menge in Millimetern. Geschlossen heißt ein paar Tropfen, '
        + 'aufgespannt leichter bis mäßiger Regen, aufgespannt mit Tropfen ab 5 mm — dann '
        + 'wird man ohne Schirm in Minuten nass. Die Farbfläche darunter zeigt dasselbe '
        + 'flächig; die Schirme sagen es auf einen Blick.' },
  wolken: { name: 'Wolken', farbe: '#9aa8bb',
    text: 'Wie dicht der Himmel bedeckt ist. Je grauer die Fläche, desto geschlossener '
        + 'die Wolkendecke. Helle Stellen sind Lücken, durch die die Sonne kommt.' },
  temperatur: { name: 'Temperatur', farbe: '#ff9f6a',
    text: 'Blau ist kalt, grün mild, orange und rot heiß. Gut zu sehen, wo eine '
        + 'Kaltfront durchzieht oder wo es im Bergland kühler bleibt.' },
  wind: { name: 'Windpfeile', farbe: '#39a0e8',
    text: 'Jeder Pfeil zeigt, wohin der Wind weht — Größe und Farbe sagen, wie stark: '
        + 'grau ist ein Lüftchen, blau spürbarer Wind, violett kräftig (ab 30 km/h), '
        + 'rot stürmisch (ab 55 km/h). Die Angabe ist der Mittelwind in 10 m Höhe; '
        + 'Böen darüber zeigt die eigene Ebene.' },
  boeen: { name: 'Sturmböen', farbe: '#af5afa',
    text: 'Violett erscheint erst ab 45 km/h — das ist Windstärke 6, bei der Regenschirme '
        + 'kaum noch zu halten sind. Ab 60 km/h knicken Äste, ab 75 km/h wird es gefährlich.' },
  gewitter: { name: 'Gewitterneigung', farbe: '#ff3c3c',
    text: 'Zeigt, wie viel Energie in der Luft steckt (Fachleute sagen CAPE dazu). '
        + 'Rot heißt: Die Luft ist labil genug für Gewitter. Ob wirklich eines entsteht, '
        + 'hängt davon ab, ob etwas es auslöst — ein Bergrücken, eine Front. '
        + 'Rot ist also keine Gewittervorhersage, sondern eine Bereitschaft.' },
  zahlen: { name: 'Zahlen auf der Karte', farbe: '#ffffff',
    text: 'Die Messpunkte des Rasters. Wo Regen fällt, steht die Menge in Millimetern, '
        + 'sonst die Temperatur. Antippen erklärt den Wert.' }
};

function openEbenenHilfe() {
  const an = activeLayers();
  const aktiv = Object.entries(EBENEN_HILFE).filter(([id]) => an.has(id));

  $('#explainTitle').textContent = 'Was die Karte zeigt';
  $('#explainText').innerHTML = `
    <p style="margin:0 0 14px">Mehrere Ebenen liegen übereinander. Von hinten nach vorn:
      Temperatur, Wolken, Böen, Gewitter, Regen — der Regen liegt immer obenauf.</p>
    ${aktiv.map(([, e]) => `
      <div class="eh-block">
        <span class="eh-kopf"><span class="lg-punkt" style="background:${e.farbe}"></span>
          <b>${e.name}</b></span>
        <span class="eh-text">${e.text}</span>
      </div>`).join('')}
    ${aktiv.length > 2 ? `<p class="ds-note">Mit drei oder mehr Ebenen gleichzeitig wird das
      Bild schnell unübersichtlich — für eine klare Aussage lieber nur eine oder zwei
      einschalten.</p>` : ''}`;
  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
}

/* ── Zeitzonen ──────────────────────────────────────────────
   Antippen der Uhr zeigt, wie spät es anderswo ist — und ob dort gerade
   Tag oder Nacht herrscht. */
/* Mit Koordinaten, damit Tag oder Nacht wirklich gerechnet wird — nach der
   Uhrzeit zu raten ginge im Winter auf der Südhalbkugel schief. */
const ZONEN = [
  { zone: 'Pacific/Auckland',    ort: 'Auckland',    lat: -36.85, lon: 174.76 },
  { zone: 'Australia/Sydney',    ort: 'Sydney',      lat: -33.87, lon: 151.21 },
  { zone: 'Asia/Tokyo',          ort: 'Tokio',       lat:  35.68, lon: 139.69 },
  { zone: 'Asia/Shanghai',       ort: 'Peking',      lat:  39.90, lon: 116.41 },
  { zone: 'Asia/Kolkata',        ort: 'Delhi',       lat:  28.61, lon:  77.21 },
  { zone: 'Asia/Dubai',          ort: 'Dubai',       lat:  25.20, lon:  55.27 },
  { zone: 'Europe/Moscow',       ort: 'Moskau',      lat:  55.75, lon:  37.62 },
  { zone: 'Europe/Berlin',       ort: 'Berlin',      lat:  52.52, lon:  13.40 },
  { zone: 'Europe/London',       ort: 'London',      lat:  51.51, lon:  -0.13 },
  { zone: 'Africa/Lagos',        ort: 'Lagos',       lat:   6.52, lon:   3.38 },
  { zone: 'America/Sao_Paulo',   ort: 'São Paulo',   lat: -23.55, lon: -46.63 },
  { zone: 'America/New_York',    ort: 'New York',    lat:  40.71, lon: -74.01 },
  { zone: 'America/Chicago',     ort: 'Chicago',     lat:  41.88, lon: -87.63 },
  { zone: 'America/Los_Angeles', ort: 'Los Angeles', lat:  34.05, lon:-118.24 },
  { zone: 'Pacific/Honolulu',    ort: 'Honolulu',    lat:  21.31, lon:-157.86 }
];

let zonenTimer = null;
let zonenWetter = null;        // { 'Ort': { t, code } }

/* Wetter für alle Zeitzonen-Städte in einem Abruf. Ein Sonnensymbol allein
   sagt nur, ob dort Tag ist — interessanter ist, ob es dort gerade schüttet
   und wie warm es ist. Open-Meteo nimmt mehrere Koordinaten auf einmal, das
   ist ein Abruf für fünfzehn Städte. */
async function ladeZonenWetter() {
  if (zonenWetter && Date.now() - zonenWetter.stand < 20 * 60000) return;

  /* Beim Start aus dem Zwischenspeicher: Sonst steht beim Öffnen erst
     einmal nichts da, bis die Antwort kommt — und wenn Open-Meteo gerade
     nicht mag, bleibt es leer. Eine halbe Stunde alte Zahl ist besser als
     gar keine, sie wird ja gleich überschrieben. */
  if (!zonenWetter) {
    const alt = store.get('wf.zonenWetter', null);
    if (alt?.karte && Date.now() - alt.stand < 6 * 3600e3) {
      zonenWetter = alt;
      renderZonen();
    }
  }

  const p = new URLSearchParams({
    latitude: ZONEN.map(z => z.lat).join(','),
    longitude: ZONEN.map(z => z.lon).join(','),
    current: 'temperature_2m,weather_code,is_day'
  });
  const direkt = `${FORECAST}?${p}`;
  /* Erst über den eigenen Worker: Der puffert die Antwort zwölf Minuten und
     zählt auf die Adresse von Cloudflare. Fünfzehn Städte gehen sonst voll
     auf das Tageskontingent dieses Anschlusses — und dann fehlte hier das
     Wetter, obwohl der Code stimmte. */
  const proxy = (store.get('wf.proxy', '') || 'https://wetterfunk.florian-s-thiel.workers.dev')
    .replace(/\/+$/, '');
  const wege = [`${proxy}/wetter?url=${encodeURIComponent(direkt)}`, direkt];

  for (const weg of wege) {
    try {
      const r = await fetch(weg);
      if (!r.ok) continue;
      const d = await r.json();
      const liste = Array.isArray(d) ? d : [d];
      const karte = {};
      ZONEN.forEach((z, i) => {
        const c = liste[i]?.current;
        if (c) karte[z.ort] = { t: c.temperature_2m, code: c.weather_code, tag: c.is_day };
      });
      if (!Object.keys(karte).length) continue;
      zonenWetter = { karte, stand: Date.now() };
      store.set('wf.zonenWetter', zonenWetter);
      renderZonen();
      return;
    } catch { /* nächster Weg */ }
  }
}

function renderZonen() {
  const box = $('#zonenListe');
  if (!box) return;
  const jetzt = new Date();
  const heimZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Den eigenen Ort mit aufnehmen, falls er nicht ohnehin dabei ist
  const eigene = place ? [{ zone: heimZone, ort: place.name, lat: place.lat, lon: place.lon, heim: true }] : [];
  const liste = [...eigene, ...ZONEN.filter(z => z.zone !== heimZone)]
    .sort((a, b) => b.lon - a.lon);

  box.innerHTML = liste.map(z => {
    const zeit = jetzt.toLocaleTimeString('de-DE', { timeZone: z.zone, hour: '2-digit', minute: '2-digit' });
    const datum = jetzt.toLocaleDateString('de-DE', { timeZone: z.zone, weekday: 'short', day: 'numeric', month: 'short' });
    // Versatz zur eigenen Zeit, in vollen Stunden
    const diff = Math.round(
      (new Date(jetzt.toLocaleString('en-US', { timeZone: z.zone })) -
       new Date(jetzt.toLocaleString('en-US', { timeZone: heimZone }))) / 36e5);

    // Echte Sonnenhöhe statt Uhrzeit-Faustregel
    const hoehe = sunAltitude(jetzt, z.lat, z.lon);
    const himmel = hoehe > 6 ? '☀️' : hoehe > -0.833 ? '🌇' : hoehe > -6 ? '🌆' : '🌙';
    const wetter = zonenWetter?.karte?.[z.ort];

    /* Das Wetterzeichen sagt schon, ob dort Tag oder Nacht ist — daneben
       stand sonst zweimal derselbe Mond. Das Himmelszeichen bleibt nur,
       solange kein Wetter vorliegt. */
    return `<div class="tz-row${z.heim ? ' is-here' : ''}">
      <span class="tz-ort">${esc(z.ort)}</span>
      <span class="tz-sky" title="Sonne ${hoehe.toFixed(0)}° über dem Horizont">${
        wetter ? '' : himmel}</span>
      <span class="tz-wetter">${wetter
        ? `<i>${wetterZeichen(wetter.code, wetter.tag)}</i><b>${round(wetter.t)}°</b>` : ''}</span>
      <span class="tz-zeit">${zeit}</span>
      <span class="tz-diff">${z.heim ? 'hier' : `${diff >= 0 ? '+' : ''}${diff} Std.`}</span>
      <span class="tz-datum">${datum}</span>
    </div>`;
  }).join('');
}

function openZonen() {
  ladeZonenWetter();
  $('#explainTitle').textContent = 'Zeit und Wetter weltweit';
  /* Die Warnung vor einer falsch gehenden Geräteuhr stand früher in der
     Zeile unter dem Tagesbalken. Die gibt es nicht mehr — also gehört sie
     hierher, wo man die Zeit ohnehin nachschlägt. */
  const schief = Math.abs(uhrVersatz) > 30000;
  $('#explainText').innerHTML = `
    <p style="margin:0 0 12px">${schief
      ? `<b>Achtung:</b> Die Uhr dieses Geräts geht
         ${uhrVersatz > 0 ? 'nach' : 'vor'} — um
         ${Math.abs(Math.round(uhrVersatz / 1000))} Sekunden. Die Ringuhr oben
         rechnet das heraus und zeigt die richtige Zeit.`
      : `Die Ringuhr oben wird beim Start gegen die Serverzeit geprüft.
         Dieses Gerät geht richtig.`}</p>
    <div class="tz-liste" id="zonenListe"></div>
    <p class="ds-note" style="margin-top:12px">Die Sonne wandert in einer Stunde
      um 15 Längengrade weiter. Wo es später Nachmittag ist, ist es weiter östlich.</p>`;
  renderZonen();
  clearInterval(zonenTimer);
  zonenTimer = setInterval(() => {
    if ($('#zonenListe')) renderZonen(); else clearInterval(zonenTimer);
  }, 1000);
  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
}

/* ── Regenwarnung aufs Gerät ────────────────────────────────
   Web Push. Auf dem iPhone geht das nur, wenn die Seite über "Zum
   Home-Bildschirm" installiert wurde — im Safari-Tab fehlt die Schnittstelle. */
const pushProxy = () => ((localStorage.getItem('wf.proxy') || '').replace(/^"|"$/g, '')
  || 'https://wetterfunk.florian-s-thiel.workers.dev').replace(/\/+$/, '');

const pushMoeglich = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Welche Meldungen sollen kommen — lokal gemerkt, damit die Kästchen
    beim nächsten Öffnen noch stimmen. */
const PUSH_ARTEN = [
  ['regen',        'wf.artRegen', '#artRegen',        true,  'Regen'],
  ['warnungen',    'wf.artWarn',  '#artWarnungen',    true,  'Warnungen'],
  ['aufgang',      'wf.artAuf',   '#artAufgang',      false, 'Aufgang'],
  ['hoechststand', 'wf.artHoch',  '#artHoechststand', false, 'Höchststand'],
  ['untergang',    'wf.artUnter', '#artUntergang',    false, 'Untergang'],
  ['mondaufgang',  'wf.artMond',  '#artMond',         false, 'Mond']
];
const pushArten = () => Object.fromEntries(
  PUSH_ARTEN.map(([name, key, , vor]) => [name, store.get(key, vor)]));
/* Keine Meldungsart, sondern eine Uhrzeit — deshalb getrennt von PUSH_ARTEN
   und außerhalb von nichtsGewaehlt(): Nachtruhe allein schaltet nichts ab. */
const nachtruheAn = () => store.get('wf.nachtruhe', false);
const nichtsGewaehlt = () => !Object.values(pushArten()).some(Boolean);
/** Zeitzone des Geräts — der Worker formuliert die Uhrzeiten damit. */
const geraeteZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; }
  catch { return 'Europe/Berlin'; }
};

const alsAppInstalliert = () => window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const roh = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(roh, c => c.charCodeAt(0));
}

async function aktuellesAbo() {
  if (!pushMoeglich()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderPush() {
  const karte = $('#pushCard');
  if (!karte) return;

  if (!pushMoeglich()) {
    karte.hidden = true;
    return;
  }
  karte.hidden = false;

  const abo = await aktuellesAbo();
  const an = !!abo;

  // Beim Ortswechsel den hinterlegten Standort nachziehen
  if (an && place?.lat != null) {
    fetch(`${pushProxy()}/push/an`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ abo: abo.toJSON(), lat: place.lat, lon: place.lon,
                                ort: place.name, kreis: place.county, arten: pushArten(),
                                tz: geraeteZone(), nachtruhe: nachtruheAn() })
    }).catch(() => {});
  }

  const arten = pushArten();
  PUSH_ARTEN.forEach(([name, , sel]) => {
    const el = $(sel);
    if (el) el.checked = arten[name];
  });
  const nrEl = $('#artNachtruhe');
  if (nrEl) nrEl.checked = nachtruheAn();

  // Bei mehr als drei Häkchen wird die Aufzählung länger als die Zeile
  const namen = PUSH_ARTEN.filter(([n]) => arten[n]).map(([, , , , kurz]) => kurz);
  const gewaehlt = namen.length > 3 ? `${namen.length} Arten` : namen.join(' + ');
  $('#pushState').textContent = an ? (gewaehlt || 'nichts gewählt') : 'aus';
  $('#pushToggle').textContent = an ? 'Ausschalten' : 'Einschalten';
  $('#pushToggle').classList.toggle('on', an);
  $('#pushToggle').disabled = !an && nichtsGewaehlt();
  $('#pushTest').hidden = !an;
  // Läuft die Warnung, schrumpft die Karte — dann gibt es nichts mehr zu tun
  karte.classList.toggle('is-on', an);

  const hinweis = $('#pushHint');
  if (an) {
    hinweis.textContent = `Gilt für ${place.name}. Beim Ortswechsel hier neu einschalten.`;
  } else if (!alsAppInstalliert() && /iPhone|iPad/.test(navigator.userAgent)) {
    hinweis.innerHTML = 'Auf dem iPhone geht das nur aus der installierten App heraus: ' +
      'im Safari auf <b>Teilen → Zum Home-Bildschirm</b>, danach die App vom Homescreen öffnen.';
  } else if (Notification.permission === 'denied') {
    hinweis.innerHTML = 'Mitteilungen sind für diese Seite gesperrt — ' +
      'in den Einstellungen des Geräts wieder erlauben.';
  } else {
    hinweis.textContent = '';
  }
}

async function pushUmschalten() {
  const knopf = $('#pushToggle');
  knopf.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const vorhanden = await reg.pushManager.getSubscription();

    if (vorhanden) {
      await fetch(`${pushProxy()}/push/aus`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: vorhanden.endpoint })
      }).catch(() => {});
      await vorhanden.unsubscribe();
      toast('Regenwarnungen ausgeschaltet.');
      return renderPush();
    }

    const erlaubnis = await Notification.requestPermission();
    if (erlaubnis !== 'granted') {
      toast('Ohne Erlaubnis für Mitteilungen geht es nicht.', 4000);
      return renderPush();
    }

    const { key } = await (await fetch(`${pushProxy()}/push/key`)).json();
    if (!key) throw new Error('Kein Schlüssel vom Server');

    const abo = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(key)
    });

    const res = await fetch(`${pushProxy()}/push/an`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        abo: abo.toJSON(), lat: place.lat, lon: place.lon,
        ort: place.name, kreis: place.county, arten: pushArten(),
        tz: geraeteZone(), nachtruhe: nachtruheAn()
      })
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server ${res.status}`);

    toast('Regenwarnungen eingeschaltet.');
  } catch (e) {
    console.warn('Push:', e);
    toast(`Hat nicht geklappt: ${e.message}`.slice(0, 120), 5000);
  } finally {
    knopf.disabled = false;
    renderPush();
  }
}

async function pushProbe() {
  const abo = await aktuellesAbo();
  if (!abo) return;
  try {
    const res = await fetch(`${pushProxy()}/push/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: abo.endpoint })
    });
    const d = await res.json();
    toast(d.ok ? 'Probemeldung unterwegs.' : `Fehlgeschlagen: ${d.error || d.status}`, 4000);
  } catch (e) {
    toast(`Probemeldung fehlgeschlagen: ${e.message}`.slice(0, 120), 4000);
  }
}

/* ── Amtlicher Regionalwetterbericht des DWD ────────────────
   Von Meteorologen geschriebene Lagebeurteilung — mehr Einordnung, als
   Zahlen liefern können. Die Region wird grob aus den Koordinaten geraten;
   die Grenzen sind Rechtecke, das genügt für die Zuordnung. */
const DWD_REGIONEN = [
  { k: 'DWHH', name: 'Schleswig-Holstein und Hamburg', lat: [53.3, 55.1], lon: [7.8, 11.4] },
  { k: 'DWPH', name: 'Mecklenburg-Vorpommern',         lat: [53.0, 54.8], lon: [10.5, 14.5] },
  { k: 'DWHG', name: 'Niedersachsen und Bremen',       lat: [51.2, 53.9], lon: [6.6, 11.6] },
  { k: 'DWPG', name: 'Brandenburg und Berlin',         lat: [51.3, 53.6], lon: [11.2, 14.8] },
  { k: 'DWEH', name: 'Nordrhein-Westfalen',            lat: [50.3, 52.6], lon: [5.8, 9.5] },
  { k: 'DWLH', name: 'Sachsen-Anhalt',                 lat: [50.9, 53.1], lon: [10.5, 13.3] },
  { k: 'DWEG', name: 'Hessen',                         lat: [49.3, 51.7], lon: [7.7, 10.3] },
  { k: 'DWLI', name: 'Thüringen',                      lat: [50.2, 51.7], lon: [9.8, 12.7] },
  { k: 'DWLG', name: 'Sachsen',                        lat: [50.1, 51.7], lon: [11.8, 15.1] },
  { k: 'DWEI', name: 'Rheinland-Pfalz und Saarland',   lat: [48.9, 51.0], lon: [6.0, 8.6] },
  { k: 'DWMO', name: 'Nordbayern',                     lat: [48.9, 50.6], lon: [8.9, 12.4] },
  { k: 'DWSG', name: 'Baden-Württemberg',              lat: [47.5, 49.8], lon: [7.5, 10.5] },
  { k: 'DWMP', name: 'Südbayern',                      lat: [47.2, 49.1], lon: [9.7, 13.9] }
];

const dwdRegionFuer = (lat, lon) =>
  DWD_REGIONEN.find(r => lat >= r.lat[0] && lat <= r.lat[1] && lon >= r.lon[0] && lon <= r.lon[1])
  || { k: 'DWOG', name: 'Deutschland' };

let dwdVoll = '';

async function loadDwdText(lat, lon) {
  const karte = $('#dwdCard');
  if (!karte) return;
  const region = dwdRegionFuer(lat, lon);

  try {
    const proxy = (localStorage.getItem('wf.proxy') || '').replace(/^"|"$/g, '')
      || 'https://wetterfunk.florian-s-thiel.workers.dev';
    const res = await fetch(`${proxy.replace(/\/+$/, '')}/dwdtext?region=${region.k}`);
    const d = await res.json();
    if (!d.text) throw new Error(d.error || 'kein Text');

    // Fernschreibformat: Steuerzeichen weg, harte Zeilenumbrüche auflösen
    const roh = d.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/\r/g, "");
    const absaetze = roh.split(/\n{2,}/)
      .map(a => a.replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim())
      .filter(Boolean);

    const kopfEnde = absaetze.findIndex(a => /\d{1,2}\.\d{2}\.\d{4}/.test(a));
    const stand = (absaetze[kopfEnde] || "")
      .match(/\w+tag, \d{1,2}\.\d{2}\.\d{4}, \d{1,2}[:.]\d{2} Uhr/)?.[0] || "";

    // Überschriften wie "WIND:" stehen im Original in derselben Zeile wie der
    // Text — hier eigene Absätze daraus machen, sonst liest es sich als Brei.
    const inhalt = [];
    for (const a of absaetze.slice(Math.max(0, kopfEnde + 1))) {
      const m = a.match(/^([A-ZÄÖÜ][\wÄÖÜäöüß\- ]{2,38}:)\s*(.*)$/);
      if (m) { inhalt.push(m[1]); if (m[2]) inhalt.push(m[2]); }
      else inhalt.push(a);
    }

    dwdVoll = inhalt.join("\n\n");
    const kurz = inhalt.slice(0, 3);

    dwdRegionText = region.name;
    if ($('#dwdBody')?.hidden === false) $('#dwdRegion').textContent = region.name;
    $('#dwdText').innerHTML = kurz.map(dwdAbsatz).join('');
    $('#dwdFoot').textContent = stand ? `Deutscher Wetterdienst · Stand ${stand}` : 'Deutscher Wetterdienst';
    $('#dwdMore').hidden = inhalt.length <= 3;
    Briefing.voiceControls?.($('#dwdVoiceBar'));
    karte.hidden = false;
  } catch (e) {
    console.warn('DWD-Text:', e);
    karte.hidden = true;
  }
}

/** Kurze Absätze, die mit Doppelpunkt enden, sind im DWD-Text Überschriften. */
const dwdAbsatz = (a) => (a.length < 42 && a.trim().endsWith(':')
  ? `<p class="dwd-h">${esc(a.replace(/:$/, ''))}</p>`
  : `<p>${esc(a)}</p>`);

function openDwdFull() {
  $('#explainTitle').textContent = `Amtlicher Bericht · ${$('#dwdRegion').textContent}`;
  $('#explainText').innerHTML =
    `<div class="dwd-text">${dwdVoll.split('\n\n').map(dwdAbsatz).join('')}</div>`;
  const l = $('#explainLink');
  if (l) {
    l.href = 'https://www.dwd.de/DE/wetter/wetterundklima_vorort/_node.html';
    l.textContent = 'Beim DWD weiterlesen →';
    l.hidden = false;
  }
  openSheet('#explainSheet');
}

/* Reihenfolge nach Alltagsnutzen: Was man täglich braucht, steht vorn.
   Wind, UV und Feuchte schaut man ständig nach — wie treffsicher das Modell
   zuletzt war, vielleicht einmal die Woche. Deshalb sind die auswertenden
   Abschnitte ans Ende gerückt, hinter die Berichte. */
/* Die Messwerte-Karte fehlte hier — sie war der einzige Abschnitt der Seite
   ohne Reiter. „Radar & Zeit" heißt jetzt kurz „Radar", damit die Leiste in
   drei Zeilen bleibt. */
const NAV = [
  { id: 'nav-jetzt',   ziel: '.hero',           name: 'Jetzt' },
  { id: 'nav-stunden', ziel: '.card-hourly',    name: 'Stunden' },
  { id: 'nav-tage',    ziel: '#daily',          name: '10 Tage' },
  { id: 'nav-radar',   ziel: '.card-radar',     name: 'Radar' },
  { id: 'nav-details', ziel: '#tiles',          name: 'Details' },
  { id: 'nav-mess',    ziel: '.card-stationen', name: 'Messung' },
  { id: 'nav-sonne',   ziel: '.card-cd',        name: 'Sonne' },
  { id: 'nav-modelle', ziel: '.card-modelle',   name: 'Modelle' },
  { id: 'nav-dwd',     ziel: '.card-dwd',       name: 'DWD' },
  { id: 'nav-bericht', ziel: '.card-brief',     name: 'Bericht' },
  { id: 'nav-himmel',  ziel: '.card-sky',       name: 'Himmel' },
  { id: 'nav-erde',    ziel: '#erdeKarte',      name: 'Erde' },
  { id: 'nav-cams',    ziel: '.card-cams',      name: 'Webcams' },
  { id: 'nav-rueck',   ziel: '.card-rueck',     name: 'Treffer' },
  { id: 'nav-push',    ziel: '.card-push',      name: 'Meldungen' },
  { id: 'nav-install', ziel: '.card-install',   name: 'Als App' }
];

/** Waagerechte Leiste unter dem Kopf: springt zum Abschnitt und hebt hervor,
    wo man gerade ist. Auf der langen Seite spart das viel Scrollen. */
/* Springt man auf eine zugeklappte Karte, klappt sie sich auf — sonst
   landet man vor einer Überschrift und weiß nicht, warum nichts kommt. */
function zielOeffnen(sel) {
  const karte = document.querySelector(sel)?.closest('.card') || document.querySelector(sel);
  const koerper = karte?.querySelector('.klapp-body');
  if (koerper?.hidden) karte.querySelector('.klapp-kopf')?.click();
}

/** Höhe der umgebrochenen Sprungleiste messen und weiterreichen. Fest
    verdrahtet stimmte sie nicht mehr, sobald das Gerät auf größere Schrift
    steht oder ein Reiter in die nächste Zeile rutscht. */
function navHoeheMessen() {
  const bar = $('#nav');
  if (!bar) return 0;
  const h = Math.round(bar.getBoundingClientRect().height);
  if (h) document.documentElement.style.setProperty('--nav-h', `${h}px`);
  return h;
}

/** Kopfhöhe für Sprungziele: Kopfzeile plus Sprungleiste plus Luft. */
const kopfHoehe = () =>
  ($('.topbar')?.offsetHeight || 0) + ($('#nav')?.offsetHeight || 0) + 8;

/** Reiter für Abschnitte ausblenden, die es gerade nicht gibt. */
function navChipsPruefen() {
  const bar = $('#nav');
  if (!bar) return;
  $$('.nav-chip', bar).forEach(c => {
    const el = document.querySelector(c.dataset.ziel);
    c.hidden = !el || el.hasAttribute('hidden');
  });
  navHoeheMessen();
}

function renderNav() {
  const bar = $('#nav');
  if (!bar) return;

  bar.innerHTML = NAV.map(n =>
    `<button class="nav-chip" data-ziel="${n.ziel}">${n.name}</button>`).join('');

  $$('.nav-chip', bar).forEach(b => b.addEventListener('click', () => {
    zielOeffnen(b.dataset.ziel);          // zugeklappte Karte mitnehmen
    const el = document.querySelector(b.dataset.ziel);
    if (!el) return;
    /* Beim Springen soll die Leiste zu sehen sein — sonst landet man in
       einem Abschnitt und weiß nicht mehr, wo man ist. */
    document.body.classList.remove('nav-weg');
    const kopf = kopfHoehe();
    // Nach dem Aufklappen kurz warten, sonst zielt der Sprung auf die alte Höhe
    setTimeout(() => {
      const y = el.getBoundingClientRect().top + window.scrollY - kopf;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }, 30);
  }));

  navChipsPruefen();
  /* Ein ResizeObserver auf der Leiste selbst statt eines resize-Horchers am
     Fenster: Die Leiste ändert ihre Höhe auch ohne Fensterwechsel — wenn ein
     Reiter dazukommt, wegfällt oder das Gerät auf größere Schrift steht. */
  if (window.ResizeObserver) new ResizeObserver(() => navHoeheMessen()).observe(bar);
  addEventListener('resize', navHoeheMessen);
  addEventListener('orientationchange', () => setTimeout(navHoeheMessen, 250));
  /* Nachmessen, sobald die Seite wieder sichtbar wird: Ein Browser hält im
     Hintergrund sowohl den ResizeObserver als auch das Zeichnen an — die
     Höhe stünde sonst auf dem Stand von vor dem Wegschalten. */
  addEventListener('visibilitychange', () => { if (!document.hidden) navHoeheMessen(); });
  setTimeout(navHoeheMessen, 400);

  /* Mehrere Karten erscheinen erst, wenn ihre Daten da sind (DWD-Bericht,
     Trefferquote, Meldungen, Messwerte). Ein Reiter, der auf eine
     ausgeblendete Karte zeigt, führte ins Leere — deshalb hört die Leiste
     mit, wann eine Karte auf- oder zugeht. */
  const wache = new MutationObserver(() => navChipsPruefen());
  NAV.forEach(n => {
    const el = document.querySelector(n.ziel);
    if (el) wache.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });

  /* Aktiven Abschnitt beim Scrollen mitführen. Der obere Rand muss die
     ganze Kopfhöhe abziehen — sonst gilt ein Abschnitt schon als „aktiv",
     während er noch hinter der Leiste steckt. Früher stand dort fest 90 px,
     inzwischen ist der Kopf deutlich höher. */
  const ziele = NAV.map(n => ({ ...n, el: document.querySelector(n.ziel) })).filter(z => z.el);
  const beob = new IntersectionObserver((eintraege) => {
    const sichtbar = eintraege.filter(e => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!sichtbar) return;
    const treffer = ziele.find(z => z.el === sichtbar.target);
    if (!treffer) return;
    /* Kein scrollIntoView mehr: Die Leiste scrollt nicht mehr seitwärts,
       der Aufruf hätte stattdessen die ganze Seite verschoben. */
    $$('.nav-chip', bar).forEach(c => c.classList.toggle('on', c.dataset.ziel === treffer.ziel));
  }, { rootMargin: `-${Math.round(kopfHoehe())}px 0px -60% 0px`, threshold: [0.05, 0.3] });

  ziele.forEach(z => beob.observe(z.el));
  navAusblendenBinden();
}

/* Drei Zeilen Reiter sind viel Bild. Beim Herunterscrollen fährt die Leiste
   deshalb ein, beim Hochscrollen und ganz oben ist sie wieder da — dort,
   wo man ohnehin entscheidet, wohin man will. */
function navAusblendenBinden() {
  let letztes = window.scrollY;
  /* Bewusst ohne requestAnimationFrame: In einem nicht sichtbaren Fenster
     hält der Browser rAF an, und die Leiste bliebe hängen, wo sie gerade
     steht. Ein Zeitfenster von 80 ms genügt für ruhiges Scrollen. */
  let zuletztGeprueft = 0;
  addEventListener('scroll', () => {
    const jetzt = Date.now();
    if (jetzt - zuletztGeprueft < 80) return;
    zuletztGeprueft = jetzt;

    const y = window.scrollY;
    // Im Kartenvollbild ist die Leiste ohnehin weg
    if (document.body.classList.contains('map-full')) { letztes = y; return; }
    // Kleine Rucke ignorieren, sonst flackert die Leiste
    if (Math.abs(y - letztes) < 8) return;
    document.body.classList.toggle('nav-weg', y > letztes && y > kopfHoehe());
    letztes = y;
  }, { passive: true });
}

/** Karte auf den ganzen Bildschirm ziehen. */
function toggleMapFull() {
  const karte = $('.card-radar');
  const an = karte.classList.toggle('is-full');
  document.body.classList.toggle('map-full', an);
  $('#mapFull').setAttribute('aria-label', an ? 'Karte verkleinern' : 'Karte vergrößern');

  /* Läuft gerade ein Kameraflug (etwa zur Erdkugel), rechnet er mit der
     alten Fenstergröße weiter — nach dem Umschalten lag die Kugel dann
     außerhalb des Bildes und die Karte wirkte leer. Deshalb: Flug anhalten,
     Größe anpassen, Kamera ausdrücklich wieder auf ihren Stand setzen. */
  const m = Radar.map;
  if (m) {
    m.stop();
    const kamera = { center: m.getCenter(), zoom: m.getZoom() };
    setTimeout(() => { m.resize(); m.jumpTo(kamera); }, 220);
  }
  if (an) karte.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// ══ Ereignisse ═════════════════════════════════════════════
function wire() {
  $('#placeBtn').addEventListener('click', () => {
    renderSaved();                 // markiert den gerade aktiven Ort
    openSheet('#placeSheet');
    $('#placeSearch').focus();
  });
  $('#placeClose').addEventListener('click', () => closeSheet('#placeSheet'));
  $('#placeSheet').addEventListener('click', e => { if (e.target.id === 'placeSheet') closeSheet('#placeSheet'); });
  $('#gpsBtn').addEventListener('click', useGPS);
  $('#mapFull').addEventListener('click', toggleMapFull);
  $('#dwdMore')?.addEventListener('click', openDwdFull);
  $('#dwdSpeak')?.addEventListener('click', (e) => {
    // Überschriften weglassen, sie klingen vorgelesen wie Stolpersteine
    const zumLesen = dwdVoll.split('\n\n')
      .filter(a => !(a.length < 42 && a.trim().endsWith(':')))
      .join(' ');
    Briefing.speakText?.(zumLesen, e.currentTarget);
  });
  wireSheetGesten();
  $('#playBtn')?.addEventListener('click', toggleZeitraffer);
  [$('#footClock')].forEach(el => {
    if (!el) return;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('click', openZonen);
  });
  /* Die große Zahl führt zum Tagesblatt: Wer sie ansieht, will meistens
     wissen, wie der Tag weitergeht. Die Ringuhr daneben behält ihr eigenes
     Ziel, deshalb hört sie das Tippen ab, bevor es den Kopf erreicht. */
  const heroEl = $('#hero');
  if (heroEl) {
    heroEl.setAttribute('role', 'button');
    heroEl.tabIndex = 0;
    heroEl.addEventListener('click', (e) => {
      if (e.target.closest('#heroUhr, #heroMess')) return;
      if (data?.daily) openDaySheet(0);
    });
    heroEl.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && data?.daily) { e.preventDefault(); openDaySheet(0); }
    });
  }

  // Die Uhr im Kopf öffnet die Weltzeit — das ist ihr Thema
  $('#heroUhr')?.addEventListener('click', (e) => { e.stopPropagation(); openZonen(); });
  $('#heroMess')?.addEventListener('click', (e) => { e.stopPropagation(); openMessung(); });
  const vd = $('#verdict');
  if (vd) {
    vd.setAttribute('role', 'button');
    vd.tabIndex = 0;
    vd.addEventListener('click', openRegenSheet);
    vd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRegenSheet(); }
    });
  }
  $('#regenClose')?.addEventListener('click', () => closeSheet('#regenSheet'));
  $('#regenSheet')?.addEventListener('click', (e) => {
    if (e.target.id === 'regenSheet' || e.target.classList.contains('sheet-x')) closeSheet('#regenSheet');
  });
  $('#pushToggle')?.addEventListener('click', pushUmschalten);

  // Häkchen wirken sofort — auch bei bereits laufendem Abo
  PUSH_ARTEN.forEach(([, key, sel]) => {
    $(sel)?.addEventListener('change', (e) => {
      store.set(key, e.target.checked);
      renderPush();
      if (!e.target.checked && nichtsGewaehlt()) {
        toast('Ohne Auswahl kommen keine Meldungen.', 3000);
      }
    });
  });
  $('#artNachtruhe')?.addEventListener('change', (e) => {
    store.set('wf.nachtruhe', e.target.checked);
    renderPush();      // meldet den Stand beim Worker nach
    toast(e.target.checked
      ? 'Zwischen 23 und 6 Uhr kommt nur noch Unwetter.'
      : 'Meldungen kommen wieder rund um die Uhr.', 3000);
  });
  /* Drei Karten starten zugeklappt: Webcams (Bilder), Trefferquote und
     Wettermodelle (beides Auswertung, nicht Alltag). Zusammen waren das
     rund zwei Drittel der Seitenlänge. Der Zustand bleibt je Karte
     gespeichert — wer sie offen haben will, hat sie beim nächsten Mal
     wieder offen. */
  const klappen = (kopfId, bodyId, key, beimOeffnen, untertitel) => {
    const kopf = $(kopfId), body = $(bodyId);
    if (!kopf || !body) return;
    const setzen = (auf) => {
      body.hidden = !auf;
      kopf.setAttribute('aria-expanded', auf ? 'true' : 'false');
      kopf.classList.toggle('offen', auf);
      store.set(key, auf);
      if (auf) beimOeffnen?.();
      const el = kopf.querySelector('.klapp-sub');
      if (el && untertitel) el.textContent = auf ? (untertitel(true) || '') : untertitel(false);
    };
    setzen(store.get(key, false));
    kopf.addEventListener('click', () => setzen(body.hidden));
  };

  klappen('#camsKopf', '#camsBody', 'wf.camsAuf', renderCams, (auf) => {
    if (auf) return '';
    const n = (store.get(LS.cams, []) || []).length;
    return n ? `${n} Kameras aus der Region` : 'Bilder aus der Region';
  });
  /* Die Erde-Karte hatte den Kopf, aber nie diesen Aufruf — der Knopf war
     stumm. Jede Klapp-Karte braucht ihre eigene Zeile hier; das Muster hat
     keinen Sammellauf über alle .klapp-kopf. */
  klappen('#erdeKopf', '#erdeBody', 'wf.erdeAuf', renderGlobus,
    (auf) => (auf ? '' : 'Tag, Jahr und die Neigung'));
  klappen('#rueckKopf', '#rueckBody', 'wf.rueckAuf', null,
    (auf) => (auf ? rueckStandText : 'Vorhersage gegen Messung'));
  klappen('#modelKopf', '#modelBody', 'wf.modelAuf', null,
    (auf) => (auf ? modelAgreeText : 'Sind sich die Modelle einig?'));
  klappen('#dwdKopf', '#dwdBody', 'wf.dwdAuf', null,
    (auf) => (auf ? dwdRegionText : 'Vom Meteorologen geschrieben'));
  klappen('#briefKopf', '#briefBody', 'wf.briefAuf', null,
    () => 'selbst erstellen, vorlesen lassen');
  klappen('#skyKopf', '#skyBody', 'wf.skyAuf', null,
    () => 'Finsternisse, Sternschnuppen, Planeten');
  klappen('#sonneKopf', '#sonneBody', 'wf.sonneAuf', () => {
    renderSonneDetail();          // Ringuhr braucht sichtbare Maße
  }, () => 'Sonnenstand, Licht, Mond');

  $('#installBtn')?.addEventListener('click', installAnstossen);
  $('#radarLegend')?.addEventListener('click', openEbenenHilfe);
  $('#arZu')?.addEventListener('click', arBeenden);
  $('#arKal')?.addEventListener('click', (e) => { e.stopPropagation(); arKalibrierungLoeschen(); });
  $('#arCanvas')?.addEventListener('click', arEinmessen);
  $('#shareBtn')?.addEventListener('click', wetterTeilen);
  $('#impressumBtn')?.addEventListener('click', openImpressum);
  $('#datenschutzBtn')?.addEventListener('click', openDatenschutz);
  renderInstall();
  $('#pushTest')?.addEventListener('click', pushProbe);
  renderPush();
  $('#refreshBtn').addEventListener('click', refresh);

  // Datenquelle
  $('#modelPick').addEventListener('click', (e) => {
    // Der Hinweis auf die Ortskorrektur sitzt in derselben Zeile und erklärt sich selbst
    if (e.target.closest('.src-korr')) { openExplain('versatz'); return; }
    renderSourceList(); openSheet('#modelSheet');
  });
  $('#modelClose').addEventListener('click', () => closeSheet('#modelSheet'));
  $('#explainClose').addEventListener('click', () => closeSheet('#explainSheet'));
  $('#explainSheet').addEventListener('click', e => { if (e.target.id === 'explainSheet') closeSheet('#explainSheet'); });
  $('#modelSheet').addEventListener('click', e => { if (e.target.id === 'modelSheet') closeSheet('#modelSheet'); });

  let searchTimer;
  $('#placeSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#placeResults').innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      const res = await searchPlaces(q);
      $('#placeResults').innerHTML = res.length
        ? res.map((r, i) => `<button class="place-row" data-i="${i}">
            <span><b>${r.name}</b><i>${r.region}</i></span></button>`).join('')
        : '<p class="empty">Nichts gefunden.</p>';
      $$('#placeResults .place-row').forEach(b =>
        b.addEventListener('click', () => selectPlace(res[+b.dataset.i])));
    }, 260);
  });

  // Webcams
  $('#camAddBtn').addEventListener('click', () => { renderCamManage(); openSheet('#camSheet'); });
  $('#camClose').addEventListener('click', () => closeSheet('#camSheet'));
  $('#camSheet').addEventListener('click', e => { if (e.target.id === 'camSheet') closeSheet('#camSheet'); });
  $('#camSave').addEventListener('click', () => {
    const name = $('#camName').value.trim(), url = $('#camUrl').value.trim();
    if (!name || !url) { toast('Name und URL angeben.'); return; }
    if (!/^https:\/\//i.test(url)) { toast('Nur https-Adressen möglich.'); return; }
    const list = getCams(); list.push({ name, url });
    store.set(LS.cams, list);
    $('#camName').value = ''; $('#camUrl').value = '';
    closeSheet('#camSheet'); renderCams();
    toast('Webcam gespeichert.');
  });

  /* Frisch bleiben, ohne dass man daran denken muss. Zwei Wege:

     1. Beim Zurückkehren zur App — der häufige Fall auf dem Telefon.
     2. Alle zehn Minuten, solange die App offen im Vordergrund liegt.
        Ohne das blieben die Zahlen stehen, wenn die App den ganzen
        Nachmittag offen ist, und ein Tippen auf einen Tag zeigte den
        Stand von vor drei Stunden.

     Zehn Minuten passen zum Takt der Quellen: Das Radar kommt alle fünf
     Minuten, die DWD-Warnungen etwa alle zwei, die Modellvorhersage
     stündlich. Häufiger wäre nur Last ohne neue Zahlen. */
  const FRISCH_MS = 6e5;
  const zuAlt = () => {
    const c = store.get(LS.cache, null);
    return !c || Date.now() - c.at > FRISCH_MS;
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && zuAlt()) refresh(true);
  });

  setInterval(() => {
    if (!document.hidden && zuAlt()) refresh(true);
  }, 60000);
}

// ══ Start ══════════════════════════════════════════════════
/** Schnittstelle für das Berichts-Modul. */
const hostApi = {
  state: () => ({ place, data, air, models: modelData, warnings: activeWarnings }),
  toast, openSheet, closeSheet
};

async function boot() {
  wire();
  renderNav();
  renderSaved();
  renderCams();
  Briefing.init(hostApi);
  // Nachrichtenlage ist raus — sie gehörte nicht in eine Wetter-App und
  // machte die Seite lang. Das Modul bleibt für später im Repo liegen.
  if (typeof News !== 'undefined') News.init(hostApi);

  // Zuletzt genutzter Ort, sonst Cache, sonst Standardort
  place = store.get(LS.active, null) || store.get(LS.cache, {})?.place || {
    name: 'Tübingen', lat: 48.5227, lon: 9.0522,
    region: 'Baden-Württemberg · Deutschland', county: 'Tübingen', country: 'DE'
  };
  $('#placeName').textContent = place.name;

  // Zwischengespeicherte Daten sofort zeigen, dann aktualisieren
  const cached = store.get(LS.cache, null);
  if (cached?.data && cached.place?.name === place.name && Date.now() - cached.at < 36e5) {
    data = cached.data;
    try { renderHero(); renderVerdict(); renderHourly(); renderDaily(); } catch {}
  }

  await refresh();

  // Radar erst nach den Wetterdaten – es ist das schwerste Modul
  try {
    // Regler, Abspielknopf und Zeitanzeige steuert jetzt der gemeinsame
    // Zeitstrahl in app.js — das Radarmodul bekommt sie nicht mehr.
    Radar.init(place.lat, place.lon, {
      legend: $('#radarLegend'), locate: $('#radarLocate'), empty: $('#radarEmpty'),
      globe: $('#radarGlobe'), onMoveEnd: onMapMoved,
      currentTime: currentScrubTime,
      labelsOn: () => activeLayers().has('zahlen'),
      aktiveEbenen: activeLayers,
      onPointTap: showPointDetail,
      sharp: $('#mapSharp'),
      mode: $('#mapMode'),
      onLocate: () => Radar.setCenter(place.lat, place.lon)
    });
    await Radar.load();
    radarReady = true;
    $('#radarStamp').textContent = 'gemessen + Vorhersage';

    // Der Zeitstrahl entsteht vor dem Radar — jetzt sind die Messzeiten da,
    // also den linken Teil der Achse nachtragen.
    if (data) renderScrub();

    // Flächenvorhersage im Hintergrund nachladen — sie deckt die Zeit ab,
    // die das Radar nicht mehr schafft. Dauert ein paar Sekunden, deshalb
    // sagt die Karte solange an, dass sie noch lädt.
    ladeRaster(place.lat, place.lon, Radar.map?.getZoom(), activeLayers(), sichtbarerBereich())
      .catch(e => console.warn('Flächenvorhersage:', e));
  } catch (e) {
    console.warn('Radar:', e);
    $('#radarStamp').textContent = 'nicht verfügbar';
    $('#map').innerHTML = '<p class="empty">Radardaten gerade nicht erreichbar.</p>';
  }

  startClock();
  registerWorker();
  // Zum Schluss, damit die Frage nicht während des Aufbaus aufpoppt
  /* Erst die Zeitzone — sie braucht keine Erlaubnis und ist sofort da. Die
     Standortfrage kommt danach; sie kennt den Ortsnamen und ersetzt die
     Zeitzonenfrage, falls die Freigabe vorliegt. */
  setTimeout(pruefeZeitzone, 1800);
  setTimeout(pruefeStandortWechsel, 2500);
}

/** Sekundengenaue Uhr, einmal gegen die Serverzeit abgeglichen — die Gerätezeit
    kann abweichen, und bei Radarbildern zählt die Minute. */
/* ── Stand der Daten ────────────────────────────────────────
   Beim Wetter zählt, wie alt die Zahlen sind. Der Zeitpunkt steht deshalb
   direkt am Aktualisieren-Knopf und altert sichtbar mit. */
let standZeit = null, standTimer = null;

function setzeStand(zeit) {
  standZeit = zeit;
  zeigeStand();
  clearInterval(standTimer);
  standTimer = setInterval(zeigeStand, 30000);
}

function zeigeStand(text = null) {
  const el = $('#refreshAge');
  if (!el) return;
  if (text) { el.textContent = text; el.dataset.alt = '0'; return; }
  if (!standZeit) { el.textContent = ''; return; }

  const min = Math.round((Date.now() - standZeit) / 60000);
  el.textContent = min < 1 ? 'gerade eben'
                 : min < 60 ? `vor ${min} Min.`
                 : hhmm(standZeit) + ' Uhr';
  el.title = `Daten von ${hhmm(standZeit)} Uhr`;
  // Ab einer halben Stunde farblich anmerken, dass es Zeit wird
  el.dataset.alt = min >= 30 ? '1' : '0';
}

function startClock() {
  fetch('./manifest.webmanifest', { method: 'HEAD', cache: 'no-store' })
    .then(res => {
      const serverzeit = res.headers.get('date');
      if (serverzeit) uhrVersatz = new Date(serverzeit).getTime() - Date.now();
    })
    .catch(() => {});

  let letzteMinute = -1;
  const tick = () => {
    const t = new Date(Date.now() + uhrVersatz);
    const fuss = $('#footClock');
    if (fuss) {
      fuss.innerHTML = `<b>${t.toLocaleTimeString('de-DE')}</b> Uhr` +
        (Math.abs(uhrVersatz) > 30000
          ? ` · Gerät geht ${uhrVersatz > 0 ? 'nach' : 'vor'} (${Math.abs(Math.round(uhrVersatz / 1000))} s)`
          : '');
    }

    /* Die Ringuhr oben zeigt jetzt die Zeit — die muss mitlaufen. Vorher
       wurde sie nur beim Laden neuer Wetterdaten gezeichnet und stand
       danach bis zu zehn Minuten falsch da. Die Minute genügt: Sekunden
       ständig neu zu setzen kostet nur Strom. */
    if (t.getMinutes() !== letzteMinute) {
      letzteMinute = t.getMinutes();
      if (data?.daily) renderHeroUhr();
    }
  };
  tick();
  setInterval(tick, 1000);
}

/** Der Service Worker liefert die Programmhülle. Kommt eine neue Fassung,
    laden wir genau einmal neu — sonst mischen sich alte und neue Dateien,
    weil GitHub Pages Antworten zehn Minuten zwischenspeichern lässt. */
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register('sw.js')
    .then(reg => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          // Nur wenn schon eine Fassung lief – beim allerersten Besuch nicht neu laden
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Neue Fassung wird geladen…', 1800);
          }
        });
      });

      /* Übernimmt der neue Dienst, einmal neu laden. Vorher stand hier nur
         der Hinweis — die Seite lief aber mit dem alten Programm weiter, auf
         dem iPhone teils tagelang: Eine installierte App startet selten neu.
         So testete man gemeldete Fehler an einer Fassung, die längst
         korrigiert war. Die Schutzvariable verhindert eine Schleife. */
      let neuGeladen = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (neuGeladen || !navigator.serviceWorker.controller) return;
        neuGeladen = true;
        location.reload();
      });
      // Beim Start und bei Rückkehr auf Aktualisierungen prüfen
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
})();
