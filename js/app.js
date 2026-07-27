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
  source: 'wf.source'
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
    minutely_15: 'precipitation,weather_code',
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
  return fetchJSON(`${FORECAST}?${p}`);
}

function loadAir(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto',
    current: 'european_aqi,pm2_5,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,ragweed_pollen'
  });
  return fetchJSON(`${AIR}?${p}`).catch(() => null);
}

function loadModels(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '7',
    hourly: 'temperature_2m,precipitation',
    models: MODELS.map(m => m.id).join(',')
  });
  return fetchJSON(`${FORECAST}?${p}`).catch(() => null);
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

  const LEVELS = { 1: 'Wetterhinweis', 2: 'Wetterwarnung', 3: 'Markantes Wetter', 4: 'Unwetter', 5: 'Extremes Unwetter' };
  activeWarnings = uniq;

  box.innerHTML = uniq.map(w => `
    <details class="warn lvl-${w.level}">
      <summary>
        <svg class="warn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 1.8 21h20.4L12 3.5z"/><path d="M12 10v5" stroke-width="2"/><circle cx="12" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg>
        <span class="warn-txt">
          <b>${w.event || LEVELS[w.level] || 'Warnung'}</b>
          <i>${w.regionName} · bis ${hhmm(w.end)}</i>
        </span>
        <svg class="warn-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      </summary>
      <div class="warn-body">
        <p>${w.description || ''}</p>
        ${w.instruction ? `<p class="warn-instr">${w.instruction}</p>` : ''}
        <p class="warn-src">${LEVELS[w.level] || ''} · Deutscher Wetterdienst</p>
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
      ${mm >= 0.1 ? `<span class="h-mm">${mm.toFixed(1)}</span>` : '<span class="h-mm"></span>'}
    </div>`;
  }).join('');
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

function renderDaily() {
  const d = data.daily;
  const lo = Math.min(...d.temperature_2m_min), hi = Math.max(...d.temperature_2m_max);
  const span = Math.max(1, hi - lo);
  const today = new Date().toDateString();

  $('#dailyRange').textContent = `${round(lo)}° bis ${round(hi)}°`;

  $('#daily').innerHTML = d.time.map((day, i) => {
    const isToday = new Date(day).toDateString() === today;
    const min = d.temperature_2m_min[i], max = d.temperature_2m_max[i];
    const left = ((min - lo) / span) * 100;
    const width = Math.max(6, ((max - min) / span) * 100);
    const prob = d.precipitation_probability_max[i] ?? 0;
    const mm = d.precipitation_sum[i] ?? 0;
    const sun = Math.round((d.sunshine_duration?.[i] ?? 0) / 3600);
    return `<div class="drow${isToday ? ' is-today' : ''}">
      <span class="d-day">${isToday ? 'Heute' : weekday(day)}</span>
      <span class="d-icon" title="${WX.text(daySymbol(i), 1)}">${WX.icon(daySymbol(i), 1)}</span>
      <span class="d-rain">${prob >= 20
        ? `<b>${prob}%</b>${mm >= 0.5 ? `<i>${mm.toFixed(mm < 10 ? 1 : 0)} mm</i>` : ''}`
        : `<span class="d-sun">${sun} Std.<i>Sonne</i></span>`}</span>
      <span class="d-min">${round(min)}°</span>
      <span class="d-track"><i class="d-fill" style="left:${left}%;width:${width}%"></i></span>
      <span class="d-max">${round(max)}°</span>
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

  const when = firstBad > 0 ? new Date(H.time[i0 + firstBad]) : null;
  $('#modelNote').innerHTML =
    `Temperaturverlauf der nächsten 5 Tage. Das farbige Band zeigt die Spannweite zwischen den Modellen — je schmaler, desto verlässlicher. ` +
    (when
      ? `Ab <b>${weekday(when)}</b> laufen sie deutlich auseinander (bis ${Math.round(Math.max(...spread))} °C Unterschied).`
      : `Über den ganzen Zeitraum bleiben sie dicht beieinander (max. ${Math.round(Math.max(...spread))} °C Unterschied).`) +
    ` Ø Abweichung heute ${near.toFixed(1)} °C, in 3–5 Tagen ${far.toFixed(1)} °C.`;
}

// ══ Rendering: Detail-Kacheln ══════════════════════════════
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

function tile(label, value, sub, extra = '', tone = '') {
  return `<div class="tile${tone ? ' t-' + tone : ''}">
    <span class="t-label">${label}</span>
    <span class="t-value">${value}</span>
    ${extra}
    <span class="t-sub">${sub || ''}</span>
  </div>`;
}

function renderTiles(air) {
  const c = data.current, h = data.hourly, d = data.daily;
  const i = nowIndex(h.time);
  const out = [];

  // Wind mit Kompassnadel
  const deg = c.wind_direction_10m;
  out.push(`<div class="tile">
    <span class="t-label">Wind</span>
    <div class="t-wind">
      <svg class="compass" viewBox="0 0 60 60" style="--deg:${deg}deg">
        <circle class="c-ring" cx="30" cy="30" r="24"/>
        ${[0, 90, 180, 270].map(a => `<text class="c-lbl" x="30" y="10" transform="rotate(${a} 30 30)">${['N','O','S','W'][a/90]}</text>`).join('')}
        <g class="c-needle"><path d="M30 12 L35 34 L30 30 L25 34 Z"/></g>
      </svg>
      <span class="t-windval"><b>${round(c.wind_speed_10m)}</b><i>km/h</i></span>
    </div>
    <span class="t-sub">aus ${dirName(deg)} · Böen ${round(c.wind_gusts_10m)} km/h</span>
  </div>`);

  // UV
  const uvNow = h.uv_index[i] ?? 0;
  const [, uvTxt, uvTone] = levelOf(UV_LEVELS, uvNow);
  out.push(tile('UV-Index', round(uvNow), `${uvTxt} · heute max. ${round(d.uv_index_max[0])}`,
    `<span class="t-meter"><i style="width:${clamp(uvNow / 11 * 100, 4, 100)}%"></i></span>`, uvTone));

  // Luftfeuchte + Taupunkt
  out.push(tile('Luftfeuchte', `${round(c.relative_humidity_2m)}%`,
    `Taupunkt ${round(h.dew_point_2m[i])}°`,
    `<span class="t-meter"><i style="width:${clamp(c.relative_humidity_2m, 4, 100)}%"></i></span>`));

  // Sonne
  const sr = new Date(d.sunrise[0]), ss = new Date(d.sunset[0]);
  const now = Date.now();
  const dayProg = clamp((now - sr) / (ss - sr), 0, 1);
  const sunH = Math.floor((d.sunshine_duration?.[0] ?? 0) / 3600);
  out.push(`<div class="tile t-wide">
    <span class="t-label">Sonne</span>
    <div class="sun-arc">
      <svg viewBox="0 0 200 74">
        <path class="arc-bg" d="M${ARC.x0} ${ARC.y} A ${ARC.rx} ${ARC.ry} 0 0 1 ${ARC.x1} ${ARC.y}"/>
        <path class="arc-fg" d="M${ARC.x0} ${ARC.y} A ${ARC.rx} ${ARC.ry} 0 0 1 ${ARC.x1} ${ARC.y}"
              style="--p:${dayProg};--len:${ARC.len.toFixed(1)}"/>
        <line class="arc-ground" x1="4" y1="${ARC.y}" x2="196" y2="${ARC.y}"/>
        <circle class="arc-sun" r="5.5"
          cx="${(ARC.cx - ARC.rx * Math.cos(Math.PI * dayProg)).toFixed(1)}"
          cy="${(ARC.y - ARC.ry * Math.sin(Math.PI * dayProg)).toFixed(1)}"/>
      </svg>
      <div class="arc-times"><span>↑ ${hhmm(sr)}</span><span>↓ ${hhmm(ss)}</span></div>
    </div>
    <span class="t-sub">${sunH} Std. Sonnenschein erwartet</span>
  </div>`);

  // Luftdruck
  const pTrend = h.time && data.hourly.temperature_2m ? '' : '';
  out.push(tile('Luftdruck', round(c.pressure_msl), 'hPa auf Meereshöhe', pTrend));

  // Sicht
  const vis = h.visibility?.[i];
  if (vis != null) {
    out.push(tile('Sicht', vis >= 10000 ? '>10' : (vis / 1000).toFixed(1),
      vis >= 10000 ? 'km · klare Sicht' : 'km'));
  }

  // Bewölkung
  out.push(tile('Bewölkung', `${round(c.cloud_cover)}%`,
    c.cloud_cover < 20 ? 'nahezu wolkenlos' : c.cloud_cover > 85 ? 'geschlossene Decke' : 'aufgelockert',
    `<span class="t-meter"><i style="width:${clamp(c.cloud_cover, 4, 100)}%"></i></span>`));

  // Luftqualität
  if (air?.current?.european_aqi != null) {
    const aqi = air.current.european_aqi;
    const [, aqiTxt, aqiTone] = levelOf(AQI_LEVELS, aqi);
    out.push(tile('Luftqualität', round(aqi), `${aqiTxt} · Feinstaub ${air.current.pm2_5?.toFixed(1)} µg/m³`,
      `<span class="t-meter"><i style="width:${clamp(aqi, 4, 100)}%"></i></span>`, aqiTone));
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
      out.push(`<div class="tile t-wide t-${pTone}">
        <span class="t-label">Pollen</span>
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
}

// ══ Webcams ════════════════════════════════════════════════
/** Kameras der Umgebung. Die großen Portale liefern ihre Bilder nur per
    JavaScript hinter einem Zustimmungsdialog aus — die lassen sich nicht
    einbetten, deshalb öffnen diese Einträge die jeweilige Seite. Trägt man
    eine direkte Bild-Adresse ein, wird sie stattdessen hier angezeigt. */
const CAM_PRESETS = [
  { name: 'Tübingen · Neckarfront', page: 'https://www.tuebingen-info.de/de/webcam',
    hint: 'Blick von der Touristinformation auf Neckarbrücke und Stiftskirche' },
  { name: 'Rottenburg · Marktplatz', page: 'https://www.rottenburg.de/webcam.11.htm',
    hint: 'Marktplatz und Eugen-Bolz-Platz' },
  { name: 'Reutlingen', page: 'https://www.reutlingen.de/webcam',
    hint: 'Stadtmitte' },
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
    <p class="cam-note">Diese Anbieter lassen sich nicht direkt einbetten — die Einträge öffnen
      die jeweilige Seite. Wer eine Kamera mit direkter Bild-Adresse kennt (endet auf
      <code>.jpg</code>), trägt sie über <b>＋ Hinzufügen</b> ein und sieht das Bild dann hier.</p>`;

  if (!cams.length) { box.innerHTML = presets; return; }
  const bust = Date.now();
  box.innerHTML = cams.map((c, i) => `
    <figure class="cam" data-i="${i}">
      <div class="cam-img">
        <img src="${c.url}${c.url.includes('?') ? '&' : '?'}_=${bust}" alt="${c.name}" loading="lazy"
             referrerpolicy="no-referrer"
             onerror="this.closest('.cam').classList.add('cam-err')">
        <span class="cam-err-msg">Bild nicht abrufbar</span>
      </div>
      <figcaption>${c.name}<button class="cam-del" data-i="${i}" aria-label="Entfernen">✕</button></figcaption>
    </figure>`).join('') + presets;

  $$('.cam-del', box).forEach(b => b.addEventListener('click', () => {
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
}
function closeSheet(id) {
  const s = $(id); s.classList.remove('open');
  setTimeout(() => (s.hidden = true), 260);
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
    renderVerdict();
    renderWarnings(warn);
    renderHourly();
    renderSource();
    renderDaily();
    renderModels(md);
    renderTiles(aq);
    renderCams();

    $('#footStamp').textContent =
      `Zuletzt aktualisiert: ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · ` +
      `Vorhersage: automatisch bestes Modell (in Deutschland DWD ICON-D2, 2 km)`;
    document.body.classList.remove('loading', 'error');
  } catch (err) {
    console.error(err);
    toast('Daten konnten nicht geladen werden. Offline?');
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

// ══ Ereignisse ═════════════════════════════════════════════
function wire() {
  $('#placeBtn').addEventListener('click', () => { openSheet('#placeSheet'); $('#placeSearch').focus(); });
  $('#placeClose').addEventListener('click', () => closeSheet('#placeSheet'));
  $('#placeSheet').addEventListener('click', e => { if (e.target.id === 'placeSheet') closeSheet('#placeSheet'); });
  $('#gpsBtn').addEventListener('click', useGPS);
  $('#refreshBtn').addEventListener('click', refresh);

  // Datenquelle
  $('#modelPick').addEventListener('click', () => { renderSourceList(); openSheet('#modelSheet'); });
  $('#modelClose').addEventListener('click', () => closeSheet('#modelSheet'));
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
    Radar.init(place.lat, place.lon, {
      slider: $('#radarSlider'), play: $('#playBtn'), time: $('#radarTime'),
      legend: $('#radarLegend'), locate: $('#radarLocate'), empty: $('#radarEmpty'),
      onLocate: () => Radar.setCenter(place.lat, place.lon)
    });
    await Radar.load();
    radarReady = true;
    $('#radarStamp').textContent = 'letzte 2 Std. + Prognose';
  } catch (e) {
    console.warn('Radar:', e);
    $('#radarStamp').textContent = 'nicht verfügbar';
    $('#map').innerHTML = '<p class="empty">Radardaten gerade nicht erreichbar.</p>';
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
})();
