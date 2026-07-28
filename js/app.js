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

const MODELS = [
  { id: 'icon_d2',       name: 'ICON-D2',  org: 'DWD',   color: '#5ac8fa', note: '2 km · bis 48 h' },
  { id: 'icon_eu',       name: 'ICON-EU',  org: 'DWD',   color: '#64d2a0', note: '7 km · bis 5 Tage' },
  { id: 'ecmwf_ifs025',  name: 'ECMWF',    org: 'EU',    color: '#ffd426', note: '25 km · bis 15 Tage' },
  { id: 'gfs_seamless',  name: 'GFS',      org: 'NOAA',  color: '#ff9f6a', note: '13 km · bis 16 Tage' }
];

/** Auswählbare Datenquellen für Stunden- und Tageswerte. */
const SOURCES = [
  { id: 'best_match', name: 'Bestes verfügbares', desc: 'Automatisch — in Deutschland DWD ICON-D2 (2 km) für die ersten zwei Tage, danach ICON-EU und ICON global.', best: true },
  { id: 'icon_seamless', name: 'DWD ICON', desc: 'Deutscher Wetterdienst, nahtlos: D2 (2 km) → EU (7 km) → global (11 km). Das amtliche deutsche Modell.' },
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS', desc: 'Europäisches Zentrum, 25 km. Gilt weltweit als das treffsicherste Globalmodell auf mehrere Tage.' },
  { id: 'gfs_seamless', name: 'GFS', desc: 'US-Wetterdienst NOAA, 13 km. Reicht am weitesten, streut auf kurze Sicht stärker.' },
  { id: 'ukmo_seamless', name: 'UK Met Office', desc: 'Britischer Wetterdienst, 2 km über Westeuropa.' },
  { id: 'meteofrance_seamless', name: 'Météo-France', desc: 'Französisches AROME/ARPEGE, 1,5 km über Mitteleuropa.' }
];

const sourceId = () => store.get(LS.source, 'best_match');
const sourceOf = (id) => SOURCES.find(s => s.id === id) || SOURCES[0];

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

// ══ Hilfsfunktionen ════════════════════════════════════════
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v));
/** Zahl mit deutschem Komma — 0,6 statt 0.6. */
const dez = (v, n = 1) => (v == null ? "–" : v.toFixed(n).replace(".", ","));

const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

const hhmm = (d) => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const weekday = (d) => new Date(d).toLocaleDateString('de-DE', { weekday: 'short' });

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

let veraltet = false, umweg = false;

function loadForecast(lat, lon) {
  const src = sourceId();
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
      'relative_humidity_2m', 'dew_point_2m', 'visibility', 'cloud_cover'
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
    hourly: 'temperature_2m,precipitation',
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

// ══ Rendering: Jetzt ═══════════════════════════════════════
function renderHero() {
  const c = data.current, d = data.daily;
  $('#heroIcon').innerHTML = WX.icon(c.weather_code, c.is_day);
  $('#heroTemp').textContent = round(c.temperature_2m);
  $('#heroDesc').textContent = WX.text(c.weather_code, c.is_day);
  $('#heroFeels').textContent = `Gefühlt ${round(c.apparent_temperature)}°`;
  $('#heroMax').textContent = `${round(d.temperature_2m_max[0])}°`;
  $('#heroMin').textContent = `${round(d.temperature_2m_min[0])}°`;
  setMood(WX.mood(c.weather_code, c.is_day), c.is_day);
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

  const tagesLaenge = (i) => (new Date(d.sunset[i]) - new Date(d.sunrise[i])) / 60000;
  const heuteLang = tagesLaenge(0);
  const diff = d.sunrise[1] ? Math.round(tagesLaenge(1) - heuteLang) : 0;
  const trend = Math.abs(diff) < 1 ? ''
    : ` · morgen ${diff > 0 ? `${diff} Min. länger` : `${-diff} Min. kürzer`}`;

  el.dataset.phase = phase === 'Tag' ? 'tag' : 'nacht';
  // Antippen springt zu Sonne & Licht — dort stehen die Zeiten im Detail
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.onclick = () => {
    const ziel = document.querySelector('.card-cd') || document.querySelector('#tiles');
    if (!ziel) return;
    const kopf = ($('.topbar')?.offsetHeight || 0) + ($('#nav')?.offsetHeight || 0) + 8;
    window.scrollTo({ top: Math.max(0, ziel.getBoundingClientRect().top + window.scrollY - kopf),
                      behavior: 'smooth' });
  };
  el.innerHTML = `
    <span class="dp-head">
      <span class="dp-label">${phase === 'Tag' ? '☀ Tag' : '☾ Nacht'} zu
        <b>${Math.round(anteil * 100)} %</b> vorbei</span>
      <span class="dp-rest">noch ${rest} bis ${phase === 'Tag' ? 'Sonnenuntergang' : 'Sonnenaufgang'}</span>
    </span>
    <span class="dp-bar"><i style="width:${(anteil * 100).toFixed(1)}%"></i></span>
    <span class="dp-ends"><span>${hhmm(seit)}</span>
      <span class="dp-len">${phase === 'Tag' ? 'Tag' : 'Nacht'} dauert ${dauer}${trend}</span>
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

  const raining = data.current.precipitation > 0.02;
  const wet = near.filter(x => x.mm > 0.05);

  if (raining) {
    const dry = near.find(x => x.t > now && x.mm <= 0.05);
    const word = WX.precipWord(data.current.weather_code);
    el.innerHTML = dry
      ? `<b>${word} gerade.</b> Lässt gegen ${hhmm(dry.t)} nach.`
      : `<b>${word} gerade.</b> Hält vorerst an.`;
    el.dataset.tone = 'wet';
    return;
  }

  if (wet.length) {
    const first = wet[0];
    const mins = Math.max(0, Math.round((first.t - now) / 60000));
    const word = WX.precipWord(first.code ?? 61);
    el.innerHTML = mins <= 5
      ? `<b>${word} setzt gleich ein.</b>`
      : `<b>${word} in etwa ${mins} Minuten</b> (gegen ${hhmm(first.t)}).`;
    el.dataset.tone = 'soon';
    return;
  }

  // 2) Grobauflösung: nächste Regenstunde in den kommenden 24 h
  const h = data.hourly;
  const i0 = nowIndex(h.time);
  for (let i = i0; i < Math.min(i0 + 24, h.time.length); i++) {
    const prob = h.precipitation_probability[i] ?? 0;
    const mm = h.precipitation[i] ?? 0;
    if (mm >= 0.2 || prob >= 60) {
      const t = new Date(h.time[i]).getTime();
      const hrs = Math.round((t - now) / 3600e3);
      const word = WX.precipWord(h.weather_code[i]);
      el.innerHTML = hrs <= 1
        ? `<b>Trocken bis etwa ${hhmm(t)}</b>, dann ${word} (${prob} %).`
        : `<b>Bleibt ${hrs} Std. trocken.</b> ${word} ab ca. ${hhmm(t)} (${prob} %).`;
      el.dataset.tone = 'later';
      return;
    }
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

  // Doppelte Meldungen (mehrere Warncells) zusammenfassen
  const seen = new Set();
  const uniq = all.filter(w => {
    const k = `${w.type}|${w.level}|${w.event}|${w.start}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => b.level - a.level);

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

  box.innerHTML = uniq.map(w => `
    <details class="warn lvl-${w.level}">
      <summary>
        <svg class="warn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 1.8 21h20.4L12 3.5z"/><path d="M12 10v5" stroke-width="2"/><circle cx="12" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg>
        <span class="warn-txt">
          <b>${w.event || stufeVon(w)}</b>
          <i>${w.regionName} · bis ${hhmm(w.end)}</i>
        </span>
        <svg class="warn-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      </summary>
      <div class="warn-body">
        <p>${w.description || ''}</p>
        ${w.instruction ? `<p class="warn-instr">${w.instruction}</p>` : ''}
        <p class="warn-src">${stufeVon(w)} · Deutscher Wetterdienst</p>
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
      return `<div class="hcol hcol-sun">
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
    return `<div class="hcol${isNow ? ' is-now' : ''}">
      <span class="h-time">${isNow ? 'Jetzt' : hhmm(x.t)}</span>
      <span class="h-icon">${WX.icon(h.weather_code[i], h.is_day[i])}</span>
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
  const cc = idx.map(i => h.cloud_cover?.[i]).filter(v => v != null);
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

/* Open-Meteo liefert `sunshine_duration` als Tageswert — bei längerer Vorhersage
   aus einem anderen Modelllauf als die Stundenwerte. Dann stehen "12 Stunden
   Sonne" neben einem Streifen, der ab Mittag zu ist. Deshalb rechnen wir die
   Sonnenstunden aus denselben Stundenwerten wie den Streifen: alles aus einer
   Quelle, in sich stimmig. */
function sonnenStunden(dayISO) {
  const h = data.hourly;
  let summe = 0;
  for (let u = 0; u < 24; u++) {
    const k = h.time.indexOf(`${dayISO}T${String(u).padStart(2, '0')}:00`);
    if (k < 0 || h.is_day[k] !== 1) continue;
    if ((h.precipitation[k] ?? 0) >= 0.3) continue;      // bei Regen keine Sonne
    summe += Math.max(0, (100 - (h.cloud_cover[k] ?? 100)) / 100);
  }
  return summe;
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
    teile.push(hourShade(h.precipitation[k] ?? 0, h.cloud_cover[k] ?? 0, h.is_day[k] === 1));
  }
  const stops = teile.map((c, u) => `${c} ${(u / 24 * 100).toFixed(2)}%, ${c} ${((u + 1) / 24 * 100).toFixed(2)}%`).join(', ');
  return `<span class="d-strip" style="background:linear-gradient(90deg, ${stops})">
    ${[6, 12, 18].map(u => `<i style="left:${(u / 24 * 100).toFixed(2)}%"></i>`).join('')}
  </span>`;
}

function renderDaily() {
  const d = data.daily;
  const lo = Math.min(...d.temperature_2m_min), hi = Math.max(...d.temperature_2m_max);
  const today = new Date().toDateString();

  $('#dailyRange').textContent = `${round(lo)}° bis ${round(hi)}°`;

  $('#daily').innerHTML = d.time.map((day, i) => {
    const isToday = new Date(day).toDateString() === today;
    const min = d.temperature_2m_min[i], max = d.temperature_2m_max[i];
    const prob = d.precipitation_probability_max[i] ?? 0;
    const mm = d.precipitation_sum[i] ?? 0;
    const sun = Math.round(sonnenStunden(day));
    const wind = round(d.wind_speed_10m_max?.[i]);
    const boe = round(d.wind_gusts_10m_max?.[i]);
    const w = mm >= 0.2 ? rainWindow(i) : null;
    const worte = mm >= 0.2 ? rainWords(mm) : null;

    return `<div class="drow${isToday ? ' is-today' : ''}" data-day="${i}">
      <span class="d-day">${isToday ? 'Heute' : weekday(day)}</span>
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
  const s = sourceOf(sourceId());
  const el = $('#modelName');
  if (!el) return;
  el.innerHTML = s.best
    ? `Quelle: <b>bestes verfügbares Modell</b> — hier DWD ICON-D2, 2 km`
    : `Quelle: <b>${s.name}</b>`;
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

  const i0 = nowIndex(h.time);
  for (let k = 0; k < h.time.length - i0; k++) {
    const t = new Date(h.time[i0 + k]);
    if (punkte.length && t.getTime() <= punkte[punkte.length - 1].t.getTime()) continue;
    if (punkte.length >= 1 && t.getTime() > jetzt + 120 * 36e5) break;
    punkte.push({ t, fein: false, i: i0 + k });
  }
  return punkte;
}

function renderScrub() {
  const h = data.hourly, m = data.minutely_15;
  const punkte = buildScrubPoints();
  if (!punkte.length) return;

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
    ticks.push(`<span class="tick-fine" style="left:${anteil(letzteFein).toFixed(1)}%"
      data-label="15-Min-Takt"></span>`);
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
  };
  // Beim Öffnen im Jetzt stehen — nicht am linken Rand in der Vergangenheit
  sl.value = String(nullpunkt);
  paint();
  syncMapAt(punkte[nullpunkt].t);
}

/** Der Abspielknopf lässt die letzten zwei Stunden über die Karte laufen und
    endet im Jetzt — der Regler wandert sichtbar mit. */
let spielTimer = null;
function toggleZeitraffer() {
  const sl = $('#scrubSlider');
  const knopf = $('#playBtn');
  if (spielTimer) {
    clearInterval(spielTimer); spielTimer = null;
    knopf?.classList.remove('is-playing');
    return;
  }
  const punkte = buildScrubPoints();
  const ziel = jetztIndex(punkte);
  if (ziel <= 0) return;

  knopf?.classList.add('is-playing');
  let k = 0;
  const schritt = () => {
    sl.value = String(k);
    sl.dispatchEvent(new Event('input'));
    if (k++ >= ziel) {
      clearInterval(spielTimer); spielTimer = null;
      knopf?.classList.remove('is-playing');
    }
  };
  schritt();
  spielTimer = setInterval(schritt, 420);
}

// ══ Kartenebenen ═══════════════════════════════════════════
const LAYERS = [
  { id: 'regen',      name: 'Niederschlag', farbe: '#5ac8fa' },
  { id: 'wolken',     name: 'Wolken',       farbe: '#e6ecf5' },
  { id: 'temperatur', name: 'Temperatur',   farbe: '#ff9f6a' },
  { id: 'boeen',      name: 'Sturmböen',    farbe: '#be78f0' },
  { id: 'gewitter',   name: 'Gewitter',     farbe: '#ff5a5a' },
  { id: 'zahlen',     name: 'Grad-Zahlen',  farbe: '#ffffff' }
];

const activeLayers = () => new Set(store.get(LS.layers, ['regen', 'wolken']));

function renderLayerPicker() {
  const box = $('#layerPick');
  if (!box) return;
  const an = activeLayers();
  box.innerHTML = LAYERS.map(l =>
    `<button class="lchip${an.has(l.id) ? ' on' : ''}" data-layer="${l.id}"
       style="--c:${l.farbe}"><i></i>${l.name}</button>`).join('');

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

const currentScrubTime = () => {
  const p = buildScrubPoints();
  return p[Math.min(+($('#scrubSlider')?.value || 0), p.length - 1)]?.t;
};

/** Karte an den Zeitstrahl koppeln: bis 30 Minuten zeigt das echte Radar,
    danach die selbst gezeichnete Flächenvorhersage. */
function syncMapAt(ziel) {
  if (!radarReady || !ziel) return;
  const vorlauf = (ziel - Date.now()) / 60000;      // Minuten voraus

  const label = $('#mapMode');
  if (vorlauf <= 35) {
    Radar.showRadar();
    Radar.showAt(ziel instanceof Date ? ziel.getTime() : ziel);
    Radar.updateLabels();          // sonst greift ein Ebenenwechsel hier nicht
    if (label) {
      label.textContent = vorlauf < -3 ? 'Radarmessung · Vergangenheit'
                        : vorlauf > 7  ? 'Radar-Kurzprognose' : 'Radarmessung · jetzt';
      label.dataset.mode = 'radar';
    }
  } else {
    const hi = Forecast.indexFor(ziel);
    const flaechen = new Set([...activeLayers()].filter(x => x !== 'zahlen'));
    const ok = hi >= 0 && (flaechen.size ? Radar.showForecast(hi, flaechen) : true);
    Radar.updateLabels();
    if (label) {
      // Die Zahlen sind keine Fläche — sie gehören nicht in die Aufzählung
      const namen = LAYERS.filter(l => l.id !== 'zahlen' && activeLayers().has(l.id))
        .map(l => l.name).join(' + ') || 'Karte';
      label.textContent = ok ? `${namen} · Vorhersage` : 'Vorhersage nicht geladen';
      label.dataset.mode = ok ? 'forecast' : 'none';
    }
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
  const marke = $('#mapMode');
  const laden = $('#mapLoading');
  if (marke) { marke.textContent = 'Vorhersage wird geladen…'; marke.dataset.mode = 'laden'; }
  if (laden) laden.hidden = false;

  return Forecast.load(lat, lon, zoom, ebenen, sicht)
    .then(() => { syncMapAt(currentScrubTime()); Radar.updateLabels?.(); })
    .catch((e) => {
      if (!marke) return;
      // Beim Abruflimit den Grund nennen — "keine Daten" wäre irreführend
      marke.textContent = /429/.test(e?.message)
        ? 'Wetterdienst bremst — gleich nochmal versuchen'
        : 'für diese Region keine Daten';
      marke.dataset.mode = 'none';
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
function renderModels(md) {
  const chart = $('#modelChart'), legend = $('#modelLegend');
  if (!md?.hourly) { chart.innerHTML = '<p class="empty">Modelldaten nicht verfügbar.</p>'; return; }

  const H = md.hourly, i0 = nowIndex(H.time);
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

  $('#modelAgree').textContent = verdict;
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
  $('#modelNote').innerHTML =
    `Temperaturverlauf der nächsten 5 Tage. Das farbige Band zeigt die Spannweite zwischen den Modellen — je schmaler, desto verlässlicher. ` +
    (when
      ? `Ab <b>${weekday(when)}</b> laufen sie deutlich auseinander (bis ${Math.round(Math.max(...spread))} °C Unterschied).`
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
function moonAltitude(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const L = (218.316 + 13.176396 * d) * rad;      // mittlere Länge
  const M = (134.963 + 13.064993 * d) * rad;      // mittlere Anomalie
  const F = (93.272 + 13.229350 * d) * rad;       // Argument der Breite
  const lam = L + 6.289 * rad * Math.sin(M);
  const bet = 5.128 * rad * Math.sin(F);
  const e = 23.4397 * rad;
  const dec = Math.asin(Math.sin(bet) * Math.cos(e) + Math.cos(bet) * Math.sin(e) * Math.sin(lam));
  const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(bet) * Math.sin(e), Math.cos(lam));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) % 360) * rad - ra;
  const la = lat * rad;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)) / rad;
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
    text: 'Der Bogen zeigt den Weg der Sonne über den Himmel und wo sie gerade steht. '
        + 'Die Sonnenscheindauer ist die Zeit ohne verdeckende Wolken — sie ist meist kürzer '
        + 'als die Tageslänge.' },
  licht: { titel: 'Goldene und blaue Stunde',
    text: 'Die goldene Stunde ist die Zeit kurz nach Sonnenaufgang und kurz vor Sonnenuntergang, '
        + 'wenn das Licht flach einfällt und warm-golden wirkt — die beliebteste Zeit zum '
        + 'Fotografieren. Die blaue Stunde folgt danach: Die Sonne ist schon unter dem Horizont, '
        + 'der Himmel leuchtet aber noch tiefblau. Danach beginnt die Dämmerung, ab 18 Grad '
        + 'Sonnentiefe die astronomische Nacht — erst dann sind lichtschwache Sterne sichtbar.' },
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
        ? `${winkel.toFixed(1)}° über dem Horizont<i>${winkelWort(winkel)}</i>`
        : `${winkel.toFixed(1)}° — unter dem Horizont`}</dd>
      ${schatten ? `<dt>Dein Schatten</dt><dd>${schatten} m bei 1,80 m Körpergröße</dd>` : ''}
      ${winkel > 0 ? `<dt>Strahlungskraft</dt><dd>${kraft} % der Kraft, die bei senkrechtem
        Stand ankäme<i>${kraft > 80 ? 'fast voll — Sonnenschutz sinnvoll'
        : kraft > 50 ? 'kräftig' : kraft > 20 ? 'mäßig' : 'schwach'}</i></dd>` : ''}
      <dt>Heute höchstens</dt><dd>${hoch.toFixed(1)}° um ${hhmm(mittag)} Uhr</dd>
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
}

/** Alle Stunden eines Tages als Zeilen — Grundlage der Tagesansicht. */
function dayHours(dayISO) {
  const h = data.hourly, out = [];
  for (let u = 0; u < 24; u++) {
    const k = h.time.indexOf(`${dayISO}T${String(u).padStart(2, '0')}:00`);
    if (k < 0) continue;
    out.push({ u, temp: h.temperature_2m[k], mm: h.precipitation[k] ?? 0,
               wolken: h.cloud_cover[k] ?? 0, wind: h.wind_speed_10m[k],
               boe: h.wind_gusts_10m[k], tags: h.is_day[k] === 1, uv: h.uv_index[k],
               gefuehlt: h.apparent_temperature?.[k], feuchte: h.relative_humidity_2m?.[k] });
  }
  return out;
}

/** Zusammenhängende Abschnitte gleicher Art zusammenfassen ("9–14 Uhr sonnig"). */
function daySpans(stunden) {
  const art = (s) => (s.mm >= 0.1 ? 'regen' : !s.tags ? 'nacht'
                    : s.wolken < 25 ? 'sonnig' : s.wolken < 55 ? 'heiter'
                    : s.wolken < 80 ? 'wolkig' : 'bedeckt');
  const spans = [];
  for (const s of stunden) {
    const a = art(s);
    const letzt = spans[spans.length - 1];
    if (letzt && letzt.art === a) { letzt.bis = s.u + 1; letzt.mm += s.mm; }
    else spans.push({ art: a, von: s.u, bis: s.u + 1, mm: s.mm });
  }
  return spans;
}

const SPAN_WORT = { sonnig: '☀️ sonnig', heiter: '🌤 heiter', wolkig: '⛅ wolkig',
                    bedeckt: '☁️ bedeckt', regen: '🌧 Regen', nacht: '🌙 Nacht' };

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

function openDaySheet(i) {
  const d = data.daily, dayISO = d.time[i];
  if (!dayISO) return;
  const stunden = dayHours(dayISO);
  const spans = daySpans(stunden).filter(s => s.art !== 'nacht' || s.bis - s.von >= 3);
  const sun = Math.round(sonnenStunden(dayISO));
  const mm = d.precipitation_sum[i] ?? 0;
  const warm = stunden.reduce((a, b) => (b.temp > a.temp ? b : a), stunden[0] || { u: 12, temp: 0 });
  const kalt = stunden.reduce((a, b) => (b.temp < a.temp ? b : a), stunden[0] || { u: 5, temp: 0 });
  const wind = d.wind_speed_10m_max?.[i], boe = d.wind_gusts_10m_max?.[i];
  const uvMax = d.uv_index_max?.[i];
  const heute = new Date(dayISO).toDateString() === new Date().toDateString();

  $('#explainTitle').textContent = heute ? 'Heute' : `${weekday(dayISO)}, ${new Date(dayISO).toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })}`;

  $('#explainText').innerHTML = `
    <div class="ds-spans">
      ${spans.map(s => `<div class="ds-span">
        <b>${String(s.von).padStart(2, '0')}–${String(s.bis).padStart(2, '0')} Uhr</b>
        <span>${SPAN_WORT[s.art]}${s.art === 'regen' ? ` · ${dez(s.mm)} mm` : ''}</span>
      </div>`).join('')}
    </div>
    <dl class="ds-facts">
      <dt>Wärmster Moment</dt><dd>${round(warm.temp)}° gegen ${String(warm.u).padStart(2, '0')} Uhr${
        warm.gefuehlt != null ? ` <i>fühlt sich an wie ${round(warm.gefuehlt)}°</i>` : ''}</dd>
      <dt>Kältester Moment</dt><dd>${round(kalt.temp)}° gegen ${String(kalt.u).padStart(2, '0')} Uhr${
        kalt.gefuehlt != null ? ` <i>fühlt sich an wie ${round(kalt.gefuehlt)}°</i>` : ''}</dd>
      <dt>Sonne</dt><dd>${sun} Stunden${sun >= 8 ? ' — viel' : sun <= 2 ? ' — wenig' : ''}</dd>
      <dt>Regen</dt><dd>${mm < 0.2 ? 'keiner erwartet' : `${dez(mm)} mm — ${rainWords(mm)}`}</dd>
      <dt>Wind</dt><dd>bis ${round(wind)} km/h, Böen bis ${round(boe)} km/h
        <i>${windWorte(wind)}${boe >= 60 ? ' · in Böen auf lose Gegenstände achten' : ''}</i></dd>
      <dt>Sonnenaufgang</dt><dd>${hhmm(d.sunrise[i])}</dd>
      <dt>Sonnenuntergang</dt><dd>${hhmm(d.sunset[i])}</dd>
      ${uvMax != null ? `<dt>UV-Höchstwert</dt><dd>${uvMax.toFixed(1)}${uvMax >= 6 ? ' — Sonnenschutz sinnvoll' : uvMax >= 3 ? ' — mäßig' : ' — unkritisch'}</dd>` : ''}
    </dl>
    <p class="ds-note">1 mm Regen heißt: Auf einen Quadratmeter fällt ein Liter Wasser.
      Verteilt über mehrere Stunden ist das kaum spürbar, in zehn Minuten ein kräftiger Schauer.
      ${warm.gefuehlt != null
        ? `Die gefühlte Temperatur weicht am Nachmittag ab: ${gefuehltWarum(warm.temp, warm.gefuehlt, warm.wind, warm.feuchte)}.`
        : ''}</p>`;

  const l = $('#explainLink');
  if (l) l.hidden = true;
  openSheet('#explainSheet');
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
  const sunH = Math.floor((d.sunshine_duration?.[0] ?? 0) / 3600);
  const minutenTag = Math.round((ss - sr) / 60000);
  const dayLen = `${Math.floor(minutenTag / 60)} Std. ${minutenTag % 60} Min.`;
  // Höchststand: wichtig für Schatten, UV und Fotografie.
  // solarNoon liefert { zeit, hoehe } — nicht das Datum selbst.
  const mittagInfo = solarNoon(new Date(), place.lat, place.lon);
  const mittag = mittagInfo.zeit;
  const hoechststand = mittagInfo.hoehe;
  const jetztWinkel = sunAltitude(new Date(), place.lat, place.lon);
  out.push(`<div class="tile t-wide has-info" data-info="sonne" role="button" tabindex="0">
    <span class="t-label">Sonne<i class="t-q">?</i></span>
    <div class="sun-arc">
      <svg viewBox="0 0 200 74">
        <path class="arc-bg" d="M${ARC.x0} ${ARC.y} A ${ARC.rx} ${ARC.ry} 0 0 1 ${ARC.x1} ${ARC.y}"/>
        <path class="arc-fg" d="M${ARC.x0} ${ARC.y} A ${ARC.rx} ${ARC.ry} 0 0 1 ${ARC.x1} ${ARC.y}"
              style="--p:${dayProg};--len:${ARC.len.toFixed(1)}"/>
        <line class="arc-ground" x1="4" y1="${ARC.y}" x2="196" y2="${ARC.y}"/>
        <!-- Höchststand: Scheitel des Bogens, dort steht die Sonne am steilsten -->
        <line class="arc-noon" x1="${ARC.cx}" y1="${ARC.y}" x2="${ARC.cx}" y2="${(ARC.y - ARC.ry).toFixed(1)}"/>
        <circle class="arc-noon-dot" cx="${ARC.cx}" cy="${(ARC.y - ARC.ry).toFixed(1)}" r="2.6"/>
        <circle class="arc-sun" r="5.5"
          cx="${(ARC.cx - ARC.rx * Math.cos(Math.PI * dayProg)).toFixed(1)}"
          cy="${(ARC.y - ARC.ry * Math.sin(Math.PI * dayProg)).toFixed(1)}"/>
      </svg>
      <div class="arc-times">
        <span>↑ ${hhmm(sr)}</span>
        <span class="arc-mittag">☀ ${hhmm(mittag)}<i>${hoechststand.toFixed(0)}°</i></span>
        <span>↓ ${hhmm(ss)}</span>
      </div>
    </div>
    <span class="t-jetztwinkel">${jetztWinkel > -0.833
      ? `Jetzt <b>${jetztWinkel.toFixed(0)}°</b> über dem Horizont — ${winkelWort(jetztWinkel)}`
      : `Sonne unter dem Horizont (<b>${jetztWinkel.toFixed(0)}°</b>)`}</span>
    <span class="t-sub">${sunH} Std. Sonnenschein erwartet · Tag ${dayLen}</span>
  </div>`);

  // Goldene und blaue Stunde, Dämmerung
  const ev = sunEvents(new Date(), place.lat, place.lon);
  const z = (t) => (t ? hhmm(t) : '–');
  const jetztAlt = sunAltitude(new Date(), place.lat, place.lon);
  const phase = jetztAlt > 6 ? 'Tag' : jetztAlt > -0.833 ? 'Goldene Stunde'
    : jetztAlt > -6 ? 'Blaue Stunde' : jetztAlt > -18 ? 'Dämmerung' : 'Nacht';

  out.push(`<div class="tile t-wide has-info" data-info="licht" role="button" tabindex="0">
    <span class="t-label">Licht &amp; Dämmerung<i class="t-q">?</i></span>
    <span class="t-value">${phase} <em>${jetztAlt.toFixed(0)}° Sonnenhöhe</em></span>
    <div class="light-rows">
      <div class="lrow"><span class="ld gold"></span><span>Goldene Stunde früh</span><b>${z(ev.aufgang)}–${z(ev.goldenEndeMorgen)}</b></div>
      <div class="lrow"><span class="ld gold"></span><span>Goldene Stunde abends</span><b>${z(ev.goldenStartAbend)}–${z(ev.untergang)}</b></div>
      <div class="lrow"><span class="ld blau"></span><span>Blaue Stunde abends</span><b>${z(ev.untergang)}–${z(ev.blaueStundeEndeAbend)}</b></div>
      <div class="lrow"><span class="ld sonne"></span><span>Sonnenhöchststand</span><b>${z(mittag)} · ${hoechststand.toFixed(0)}°</b></div>
      <div class="lrow"><span class="ld nacht"></span><span>Astronomische Nacht</span><b>ab ${z(ev.astroNacht)}</b></div>
    </div>
    ${sonnenuntergangTipp(ev)}
  </div>`);

  // Mond
  const mp = moonPhase();
  const mt = moonTimes(new Date(), place.lat, place.lon);
  const bel = Math.round(mp.beleuchtet * 100);
  // Schattenkante: bei zunehmendem Mond von links, bei abnehmendem von rechts
  const zunehmend = mp.anteil < 0.5;
  const versatz = (1 - Math.abs(mp.beleuchtet * 2 - 1)) * 100;
  out.push(`<div class="tile has-info" data-info="mond" role="button" tabindex="0">
    <span class="t-label">Mond<i class="t-q">?</i></span>
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
    <div class="cd-list">
      ${weitere.map(e => `
        <div class="cd-row">
          <span class="cd-dot ${e.art}"></span>
          <span class="cd-name">${e.name}</span>
          <span class="cd-time">${hhmm(e.t)}</span>
          <span class="cd-in" data-t="${e.t.getTime()}">${restZeit(e.t)}</span>
        </div>`).join('')}
    </div>
    <button class="cd-globus" id="cdGlobus">🌍 Wo ist gerade Tag?</button>`;

  $('#cdGlobus').addEventListener('click', openTerminator);

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

  const h = data?.hourly;
  box.innerHTML = kommend.map(e => {
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
      ${sicht}
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
  { name: 'Burg Hohenzollern',
    url: 'https://www.c-mor.de/burg-hohenzollern/hohenzollern-webcam-live.jpg',
    quelle: 'https://www.zollerblick.de/', ort: '23 km südlich' },
  { name: 'Buchkopfturm · Oppenau',
    url: 'https://www.foto-webcam.eu/webcam/buchkopfturm/current/640.jpg',
    quelle: 'https://www.foto-webcam.eu/webcam/buchkopfturm/',
    ort: 'Schwarzwald, 65 km westlich', pflichtQuelle: true },
  { name: 'Bad Peterstal · Windbeutelbaron',
    url: 'https://www.foto-webcam.eu/webcam/windbeutelbaron/current/640.jpg',
    quelle: 'https://www.foto-webcam.eu/webcam/windbeutelbaron/',
    ort: 'Schwarzwald, 62 km westlich', pflichtQuelle: true },
  { name: 'Brendturm · Furtwangen',
    url: 'https://panodata.panomax.com/cams/519/preview_og.jpg',
    quelle: 'https://brendturm.panomax.com/', ort: 'Schwarzwald, 83 km südwestlich' }
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
        <img src="${bild(c.url)}" alt="${c.name}" loading="lazy"
             referrerpolicy="no-referrer"
             onerror="this.closest('.cam').classList.add('cam-err')">
        <span class="cam-err-msg">Bild nicht abrufbar</span>
      </div>
      <figcaption>
        <span class="cam-name">${c.name}</span>
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

function renderSaved() {
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
  closeSheet('#placeSheet');
  $('#placeName').textContent = p.name;
  renderSaved();
  await refresh();
  if (radarReady) Radar.setCenter(p.lat, p.lon);
}

// ══ Laden & Aktualisieren ══════════════════════════════════
let busy = false;

async function refresh() {
  if (!place || busy) return;
  busy = true;
  document.body.classList.add('loading');
  $('#refreshBtn').classList.add('spin');
  const stamp = $('#footStamp');
  if (stamp) stamp.textContent = 'Daten werden geholt…';
  zeigeStand('lädt…');
  toast('Daten werden geholt…', 1500);

  // Unabhängig von den Zahlen — er soll auch dastehen, wenn Open-Meteo hakt
  loadDwdText(place.lat, place.lon);
  ladeStationen(place.lat, place.lon);
  renderPush();

  try {
    const [fc, aq, md, warn] = await Promise.all([
      loadForecast(place.lat, place.lon),
      loadAir(place.lat, place.lon),
      loadModels(place.lat, place.lon),
      loadWarnings()
    ]);
    data = fc; air = aq; modelData = md;
    store.set(LS.cache, { at: Date.now(), place, data: fc });

    renderHero();
    renderDayProgress();
    renderVerdict();
    renderWarnings(warn);
    renderHourly();
    renderSource();
    renderDaily();
    renderScrub();
    renderModels(md);
    renderTiles(aq);
    renderLayerPicker();
    renderCountdown();
    renderSky();
    renderCams();

    // Radarbilder mitziehen — sonst zeigt die Karte nach dem Aktualisieren
    // weiter den Stand vom Seitenaufruf.
    if (radarReady) {
      Radar.load()
        .then(() => renderScrub())     // neue Messzeiten in die Achse übernehmen
        .catch(e => console.warn('Radar:', e));
    }

    $('#footStamp').textContent =
      `Zuletzt aktualisiert: ${new Date().toLocaleTimeString('de-DE')} · ` +
      `Quelle: ${sourceOf(sourceId()).name}` +
      (veraltet ? ' · aus dem Zwischenspeicher' : umweg ? ' · über den Umweg geholt' : '');
    setzeStand(Date.now());
    toast(veraltet ? 'Der Wetterdienst antwortet gerade nicht — Daten aus dem Zwischenspeicher.'
                   : 'Aktualisiert.', veraltet ? 4000 : 1400);
    veraltet = false; umweg = false;
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
  } catch (e) {
    console.warn('Stationen:', e.message);
    karte.hidden = true;
  }
}

function renderStationen(zeilen) {
  // Die Aggregate heißen je nach Messintervall anders
  const wert = (w, feld) => w[`${feld}_10`] ?? w[`${feld}_30`] ?? w[`${feld}_60`] ?? null;
  const neueste = Math.max(...zeilen.map(z => new Date(z.w.timestamp).getTime()));
  $('#stationenStand').textContent = `gemessen ${hhmm(neueste)} Uhr`;

  $('#stationen').innerHTML = zeilen.map(({ station: s, w }) => {
    const wind = wert(w, 'wind_speed');
    const boe = wert(w, 'wind_gust_speed');
    const richtung = wert(w, 'wind_direction');
    const km = Math.round(s.distance / 1000);

    const rechts = [];
    if (w.cloud_cover != null) rechts.push(wolkenWort(w.cloud_cover));
    if (wind != null) rechts.push(`Wind ${richtung != null ? dirName(richtung) + ' ' : ''}${round(wind)} km/h`);
    if (boe != null && boe >= (wind ?? 0) + 5) rechts.push(`Böen ${round(boe)} km/h`);
    if (!rechts.length && w.relative_humidity != null) rechts.push(`Feuchte ${w.relative_humidity} %`);

    return `<div class="st-zeile">
      <span class="st-ort">
        <b>${s.station_name}</b>
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
  wolken: { name: 'Wolken', farbe: '#9aa8bb',
    text: 'Wie dicht der Himmel bedeckt ist. Je grauer die Fläche, desto geschlossener '
        + 'die Wolkendecke. Helle Stellen sind Lücken, durch die die Sonne kommt.' },
  temperatur: { name: 'Temperatur', farbe: '#ff9f6a',
    text: 'Blau ist kalt, grün mild, orange und rot heiß. Gut zu sehen, wo eine '
        + 'Kaltfront durchzieht oder wo es im Bergland kühler bleibt.' },
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

    return `<div class="tz-row${z.heim ? ' is-here' : ''}">
      <span class="tz-ort">${z.ort}</span>
      <span class="tz-sky" title="Sonne ${hoehe.toFixed(0)}° über dem Horizont">${himmel}</span>
      <span class="tz-zeit">${zeit}</span>
      <span class="tz-diff">${z.heim ? 'hier' : `${diff >= 0 ? '+' : ''}${diff} Std.`}</span>
      <span class="tz-datum">${datum}</span>
    </div>`;
  }).join('');
}

function openZonen() {
  $('#explainTitle').textContent = 'Zeit weltweit';
  $('#explainText').innerHTML = `
    <p style="margin:0 0 12px">Die Uhr oben wird einmal beim Start gegen die
      Serverzeit geprüft — falls das Gerät falsch geht, steht es dort.</p>
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
const pushArten = () => ({
  regen: store.get('wf.artRegen', true),
  warnungen: store.get('wf.artWarn', true)
});
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
                                ort: place.name, kreis: place.county, arten: pushArten() })
    }).catch(() => {});
  }

  const arten = pushArten();
  $('#artRegen').checked = arten.regen;
  $('#artWarnungen').checked = arten.warnungen;

  const gewaehlt = [arten.regen && 'Regen', arten.warnungen && 'Warnungen']
    .filter(Boolean).join(' + ');
  $('#pushState').textContent = an ? (gewaehlt || 'nichts gewählt') : 'aus';
  $('#pushToggle').textContent = an ? 'Ausschalten' : 'Einschalten';
  $('#pushToggle').classList.toggle('on', an);
  $('#pushToggle').disabled = !an && !arten.regen && !arten.warnungen;
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
        ort: place.name, kreis: place.county, arten: pushArten()
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

    $('#dwdRegion').textContent = region.name;
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
  ? `<p class="dwd-h">${a.replace(/:$/, '')}</p>`
  : `<p>${a}</p>`);

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

const NAV = [
  { id: 'nav-jetzt',   ziel: '.hero',        name: 'Jetzt' },
  { id: 'nav-stunden', ziel: '.card-hourly', name: 'Stündlich' },
  { id: 'nav-tage',    ziel: '#daily',       name: '10 Tage' },
  { id: 'nav-radar',   ziel: '.card-radar',  name: 'Radar & Zeit' },
  { id: 'nav-details', ziel: '#tiles',       name: 'Details' },
  { id: 'nav-sonne',   ziel: '.card-cd',     name: 'Sonne' },
  { id: 'nav-dwd',     ziel: '.card-dwd',    name: 'DWD' },
  { id: 'nav-bericht', ziel: '.card-brief',  name: 'Bericht' },
  { id: 'nav-news',    ziel: '.card-news',   name: 'News' }
];

/** Waagerechte Leiste unter dem Kopf: springt zum Abschnitt und hebt hervor,
    wo man gerade ist. Auf der langen Seite spart das viel Scrollen. */
function renderNav() {
  const bar = $('#nav');
  if (!bar) return;

  bar.innerHTML = NAV.map(n =>
    `<button class="nav-chip" data-ziel="${n.ziel}">${n.name}</button>`).join('');

  $$('.nav-chip', bar).forEach(b => b.addEventListener('click', () => {
    const el = document.querySelector(b.dataset.ziel);
    if (!el) return;
    const kopf = $('.topbar').offsetHeight + bar.offsetHeight + 8;
    const y = el.getBoundingClientRect().top + window.scrollY - kopf;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }));

  // Aktiven Abschnitt beim Scrollen mitführen
  const ziele = NAV.map(n => ({ ...n, el: document.querySelector(n.ziel) })).filter(z => z.el);
  const beob = new IntersectionObserver((eintraege) => {
    const sichtbar = eintraege.filter(e => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!sichtbar) return;
    const treffer = ziele.find(z => z.el === sichtbar.target);
    if (!treffer) return;
    $$('.nav-chip', bar).forEach(c => c.classList.toggle('on', c.dataset.ziel === treffer.ziel));
    const aktiv = bar.querySelector('.nav-chip.on');
    if (aktiv) aktiv.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, { rootMargin: '-90px 0px -60% 0px', threshold: [0.05, 0.3] });

  ziele.forEach(z => beob.observe(z.el));
}

/** Karte auf den ganzen Bildschirm ziehen. */
function toggleMapFull() {
  const karte = $('.card-radar');
  const an = karte.classList.toggle('is-full');
  document.body.classList.toggle('map-full', an);
  $('#mapFull').setAttribute('aria-label', an ? 'Karte verkleinern' : 'Karte vergrößern');
  setTimeout(() => Radar.map?.resize(), 220);
  if (an) karte.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// ══ Ereignisse ═════════════════════════════════════════════
function wire() {
  $('#placeBtn').addEventListener('click', () => { openSheet('#placeSheet'); $('#placeSearch').focus(); });
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
  [$('#topClock'), $('#footClock')].forEach(el => {
    if (!el) return;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('click', openZonen);
  });
  $('#pushToggle')?.addEventListener('click', pushUmschalten);
  // Häkchen wirken sofort — auch bei bereits laufendem Abo
  [['#artRegen', 'wf.artRegen'], ['#artWarnungen', 'wf.artWarn']].forEach(([sel, key]) => {
    $(sel)?.addEventListener('change', (e) => {
      store.set(key, e.target.checked);
      renderPush();
      if (!e.target.checked && !pushArten().regen && !pushArten().warnungen) {
        toast('Ohne Auswahl kommen keine Meldungen.', 3000);
      }
    });
  });
  $('#installBtn')?.addEventListener('click', installAnstossen);
  $('#radarLegend')?.addEventListener('click', openEbenenHilfe);
  $('#shareBtn')?.addEventListener('click', wetterTeilen);
  $('#impressumBtn')?.addEventListener('click', openImpressum);
  $('#datenschutzBtn')?.addEventListener('click', openDatenschutz);
  renderInstall();
  $('#pushTest')?.addEventListener('click', pushProbe);
  renderPush();
  $('#refreshBtn').addEventListener('click', refresh);

  // Datenquelle
  $('#modelPick').addEventListener('click', () => { renderSourceList(); openSheet('#modelSheet'); });
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

  // Beim Zurückkehren auf den Homescreen-Tab: still nachladen
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const c = store.get(LS.cache, null);
      if (!c || Date.now() - c.at > 6e5) refresh();
    }
  });
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
  News.init(hostApi);

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
  const ziele = [$('#topClock'), $('#footClock')].filter(Boolean);
  if (!ziele.length) return;
  let versatz = 0;

  fetch('./manifest.webmanifest', { method: 'HEAD', cache: 'no-store' })
    .then(res => {
      const serverzeit = res.headers.get('date');
      if (serverzeit) versatz = new Date(serverzeit).getTime() - Date.now();
    })
    .catch(() => {});

  const tick = () => {
    const t = new Date(Date.now() + versatz);
    const html = `<b>${t.toLocaleTimeString('de-DE')}</b> Uhr` +
      (Math.abs(versatz) > 30000
        ? ` · Gerät geht ${versatz > 0 ? 'nach' : 'vor'} (${Math.abs(Math.round(versatz / 1000))} s)`
        : '');
    ziele.forEach(el => { el.innerHTML = html; });
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
