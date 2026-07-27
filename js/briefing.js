/* Wetterfunk — Gesprochener Wetterbericht
   Baut aus den geladenen Daten einen Prompt, lässt ihn über die Mac-Bridge
   von der Claude-CLI formulieren (läuft übers Max-Abo, keine API-Kosten)
   und liest ihn mit der Systemstimme vor. */

const Briefing = (() => {
'use strict';

const MODELS = [
  { id: 'claude-opus-5',    name: 'Opus 5',    note: 'am gründlichsten' },
  { id: 'claude-sonnet-5',  name: 'Sonnet 5',  note: 'schneller' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', note: 'am schnellsten' }
];

const PARTS = [
  { id: 'now',      label: 'Jetzt & nächste Stunden', on: true },
  { id: 'today',    label: 'Rest des Tages',          on: true },
  { id: 'week',     label: 'Die nächsten Tage',       on: true },
  { id: 'warnings', label: 'Unwetterwarnungen',       on: true },
  { id: 'synoptic', label: 'Großwetterlage',          on: false },
  { id: 'models',   label: 'Wie sicher ist das?',     on: false },
  { id: 'air',      label: 'Pollen & Luftqualität',   on: false },
  { id: 'clothing', label: 'Was anziehen?',           on: false }
];

const LENGTHS = [
  { id: 'kurz',  label: 'Kurz',       words: 70,  hint: 'ca. 30 Sekunden' },
  { id: 'mittel', label: 'Mittel',    words: 160, hint: 'ca. 1 Minute' },
  { id: 'lang',  label: 'Ausführlich', words: 320, hint: 'ca. 2 Minuten' }
];

const LS = { proxy: 'wf.proxy', model: 'wf.model', parts: 'wf.parts', len: 'wf.len',
             route: 'wf.route', key: 'wf.aikey' };

/** Adresse des eigenen Cloudflare Workers. */
const DEFAULT_PROXY = 'https://wetterfunk.florian-s-thiel.workers.dev';
const proxyUrl = () => (store.get(LS.proxy, '') || DEFAULT_PROXY).replace(/\/+$/, '');

/** 'mac' = über die Bridge (Standard, kostenlos übers Max-Abo)
    'api' = direkt an die Anthropic-API mit eigenem Schlüssel (kostet).
    Es wird nie automatisch gewechselt — die Wahl trifft ausschließlich der Nutzer. */
const route = () => store.get(LS.route, 'mac');
const apiKey = () => store.get(LS.key, '');
const API_URL = 'https://api.anthropic.com/v1/messages';

let host = null;      // Zustand aus app.js
let text = '';        // letzter Bericht
let busy = false;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

const selectedParts = () => store.get(LS.parts, PARTS.filter(p => p.on).map(p => p.id));
const selectedLength = () => store.get(LS.len, 'mittel');
const selectedModel = () => store.get(LS.model, MODELS[0].id);
const hhmm = (d) => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const wd = (d) => new Date(d).toLocaleDateString('de-DE', { weekday: 'long' });
const r0 = (v) => (v == null ? '–' : Math.round(v));

// ══ Datenauszug für den Prompt ═════════════════════════════
/** Kompakte, ab jetzt beginnende Zusammenfassung — spart Tokens und Kosten. */
function buildFacts(parts) {
  const { place, data, air, models, warnings } = host.state();
  if (!data) return null;

  const now = new Date();
  const h = data.hourly, d = data.daily, c = data.current;
  const i0 = h.time.findIndex(t => new Date(t).getTime() + 36e5 > now.getTime());
  const i = Math.max(0, i0);

  const L = [];
  L.push(`ORT: ${place.name}${place.region ? ' (' + place.region + ')' : ''}`);
  L.push(`ZEITPUNKT: ${now.toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} Uhr`);

  L.push(`\nAKTUELL: ${r0(c.temperature_2m)}°C (gefühlt ${r0(c.apparent_temperature)}°C), ` +
    `${WX.text(c.weather_code, c.is_day)}, Wind ${r0(c.wind_speed_10m)} km/h aus ${r0(c.wind_direction_10m)}°, ` +
    `Böen ${r0(c.wind_gusts_10m)} km/h, Luftfeuchte ${r0(c.relative_humidity_2m)}%, ` +
    `Bewölkung ${r0(c.cloud_cover)}%, Luftdruck ${r0(c.pressure_msl)} hPa, ` +
    `Niederschlag gerade ${(c.precipitation ?? 0).toFixed(1)} mm/h`);

  if (parts.includes('now')) {
    const rows = [];
    for (let k = i; k < Math.min(i + 12, h.time.length); k++) {
      rows.push(`${hhmm(h.time[k])} ${r0(h.temperature_2m[k])}° ${WX.text(h.weather_code[k], h.is_day[k])} ` +
        `Regen ${h.precipitation_probability[k] ?? 0}%/${(h.precipitation[k] ?? 0).toFixed(1)}mm ` +
        `Wind ${r0(h.wind_speed_10m[k])}`);
    }
    L.push(`\nNÄCHSTE 12 STUNDEN:\n${rows.join('\n')}`);

    const m = data.minutely_15;
    if (m) {
      const mi = m.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 9e5);
      if (mi >= 0) {
        const near = m.time.slice(mi, mi + 8)
          .map((t, k) => `${hhmm(t)}:${(m.precipitation[mi + k] ?? 0).toFixed(2)}`).join(' ');
        L.push(`NIEDERSCHLAG FEIN (mm je 15 Min): ${near}`);
      }
    }
  }

  if (parts.includes('today')) {
    L.push(`\nHEUTE GESAMT: ${r0(d.temperature_2m_min[0])}° bis ${r0(d.temperature_2m_max[0])}°, ` +
      `Regen max. ${d.precipitation_probability_max[0] ?? 0}% / ${(d.precipitation_sum[0] ?? 0).toFixed(1)} mm, ` +
      `Wind bis ${r0(d.wind_speed_10m_max[0])} km/h (Böen ${r0(d.wind_gusts_10m_max[0])}), ` +
      `UV max. ${r0(d.uv_index_max[0])}, Sonne ${hhmm(d.sunrise[0])}–${hhmm(d.sunset[0])}, ` +
      `Sonnenschein ca. ${Math.round((d.sunshine_duration?.[0] ?? 0) / 3600)} Std.`);
  }

  if (parts.includes('week')) {
    const days = d.time.slice(1, 8).map((t, k) => {
      const n = k + 1;
      return `${wd(t)}: ${r0(d.temperature_2m_min[n])}–${r0(d.temperature_2m_max[n])}°, ` +
        `${WX.text(d.weather_code[n], 1)}, Regen ${d.precipitation_probability_max[n] ?? 0}%` +
        `${(d.precipitation_sum[n] ?? 0) >= 0.5 ? ` (${(d.precipitation_sum[n]).toFixed(1)} mm)` : ''}, ` +
        `Wind bis ${r0(d.wind_speed_10m_max[n])} km/h`;
    });
    L.push(`\nKOMMENDE TAGE:\n${days.join('\n')}`);
  }

  if (parts.includes('synoptic')) {
    // Druck- und Windentwicklung als Anhaltspunkt für die Großwetterlage
    const pNow = c.pressure_msl;
    const dirs = h.wind_speed_10m.slice(i, i + 48).filter((_, k) => k % 12 === 0).map(r0);
    L.push(`\nGROSSWETTERLAGE-INDIZIEN: Luftdruck jetzt ${r0(pNow)} hPa. ` +
      `Windgeschwindigkeit alle 12 Std. (48 Std. voraus): ${dirs.join(', ')} km/h. ` +
      `Windrichtung jetzt ${r0(c.wind_direction_10m)}°. ` +
      `Temperaturtrend Tageshöchstwerte: ${d.temperature_2m_max.slice(0, 7).map(r0).join(', ')}°. ` +
      `Höhe ${r0(data.elevation)} m.`);
  }

  if (parts.includes('models') && models?.hourly) {
    const H = models.hourly;
    const j0 = H.time.findIndex(t => new Date(t).getTime() + 36e5 > now.getTime());
    const j = Math.max(0, j0);
    const ids = ['icon_d2', 'icon_eu', 'ecmwf_ifs025', 'gfs_seamless'];
    const spread = [24, 48, 96].map(off => {
      const v = ids.map(id => H[`temperature_2m_${id}`]?.[j + off]).filter(x => x != null);
      return v.length > 1 ? `+${off}h: ${(Math.max(...v) - Math.min(...v)).toFixed(1)}°C Spanne` : null;
    }).filter(Boolean);
    L.push(`\nMODELLÜBEREINSTIMMUNG (DWD ICON-D2, ICON-EU, ECMWF, GFS): ${spread.join(', ')}`);
  }

  if (parts.includes('warnings')) {
    L.push(warnings?.length
      ? `\nAMTLICHE DWD-WARNUNGEN:\n${warnings.map(w =>
          `- ${w.event} (Stufe ${w.level}, ${w.regionName}, bis ${hhmm(w.end)}): ${w.description}`).join('\n')}`
      : `\nAMTLICHE DWD-WARNUNGEN: keine`);
  }

  if (parts.includes('air') && air?.current) {
    const a = air.current;
    const pollen = [['birch_pollen', 'Birke'], ['alder_pollen', 'Erle'], ['grass_pollen', 'Gräser'],
      ['mugwort_pollen', 'Beifuß'], ['ragweed_pollen', 'Ambrosia']]
      .map(([k, n]) => `${n} ${(a[k] ?? 0).toFixed(1)}`).join(', ');
    L.push(`\nLUFT: EU-Luftqualitätsindex ${r0(a.european_aqi)}, Feinstaub PM2.5 ${a.pm2_5?.toFixed(1)} µg/m³. ` +
      `Pollen (Körner/m³): ${pollen}`);
  }

  if (parts.includes('clothing')) {
    L.push(`\nFÜR KLEIDUNGSTIPP: Taupunkt ${r0(h.dew_point_2m?.[i])}°C, ` +
      `gefühlte Temperatur nächste 6 Std.: ${h.apparent_temperature.slice(i, i + 6).map(r0).join(', ')}°.`);
  }

  return L.join('\n');
}

// ══ Prompt ═════════════════════════════════════════════════
function buildPrompt(parts, lenId) {
  const len = LENGTHS.find(l => l.id === lenId) || LENGTHS[1];
  const wanted = PARTS.filter(p => parts.includes(p.id)).map(p => p.label);

  const system =
`Du bist Wettersprecher für eine private Wetter-App. Du bekommst Messdaten und Vorhersagen und sprichst daraus einen Wetterbericht.

Regeln:
- Schreibe reinen Fließtext zum Vorlesen. Keine Überschriften, keine Listen, keine Aufzählungszeichen, keine Sonderzeichen, kein Markdown.
- Schreibe Zahlen so, wie man sie spricht: "sechzehn Grad", "zwanzig Prozent", "gegen halb sechs". Keine Ziffern, keine Einheitenkürzel wie km/h oder °C.
- Beginne beim jetzigen Zeitpunkt. Sage nichts über bereits Vergangenes.
- Nenne konkrete Uhrzeiten, wenn sich etwas ändert. "Ab dem späten Nachmittag" ist gut, "irgendwann später" nicht.
- Sei nüchtern und sachlich. Kein Pathos, keine Floskeln wie "Petrus meint es gut". Keine Anrede, keine Begrüßung, keine Verabschiedung.
- Erfinde nichts. Was nicht in den Daten steht, kommt nicht vor.
- Wenn amtliche Warnungen vorliegen, nenne sie zuerst und deutlich.
- Ziel: ungefähr ${len.words} Wörter.`;

  const user =
`Sprich den Wetterbericht für diesen Ort. Behandle genau diese Punkte, in einer sinnvollen Reihenfolge:
${wanted.map(w => '- ' + w).join('\n')}

Hier sind die Daten:

${buildFacts(parts)}`;

  return { system, user };
}

// ══ API-Aufruf ═════════════════════════════════════════════
/** Schickt eine Textanfrage auf dem eingestellten Weg. Wird von Bericht und
    Nachrichten gemeinsam genutzt. */
async function ask(system, user, model, maxTokens = 4000) {
  if (route() === 'api') {
    const key = apiKey();
    if (!key) throw new Error('Kein API-Schlüssel hinterlegt');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        output_config: { effort: 'low' },
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out?.error?.message || `${res.status} ${res.statusText}`);
    if (out.stop_reason === 'refusal') throw new Error('Anfrage wurde abgelehnt');
    const txt = (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!txt) throw new Error('Leere Antwort');
    return { text: txt, usage: out.usage, via: 'api' };
  }

  const res = await fetch(`${proxyUrl()}/ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, system, user, effort: 'low' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.text) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return { text: data.text.trim(), via: 'mac' };
}

async function generate() {
  const parts = selectedParts();
  if (!parts.length) { host.toast('Mindestens einen Punkt auswählen.'); return; }

  const { system, user } = buildPrompt(parts, selectedLength());
  const model = selectedModel();

  setBusy(true);
  try {
    const out = await ask(system, user, model);
    text = out.text;
    if (!text) { host.toast('Keine Antwort erhalten.'); return; }
    renderResult(model, out);
  } catch (e) {
    console.error(e);
    host.toast(`Bericht fehlgeschlagen: ${e.message}`.slice(0, 130));
  } finally {
    setBusy(false);
  }
}

// ══ Vorlesen ═══════════════════════════════════════════════
let speaking = false, voice = null;

function pickVoice() {
  const all = speechSynthesis.getVoices();
  const de = all.filter(v => v.lang?.toLowerCase().startsWith('de'));
  // Bevorzugt hochwertige Stimmen, sonst die erste deutsche
  return de.find(v => /premium|enhanced|siri/i.test(v.name))
      || de.find(v => v.localService)
      || de[0] || null;
}

function speak() {
  if (!('speechSynthesis' in window)) { host.toast('Vorlesen wird nicht unterstützt.'); return; }
  if (!text) return;
  if (speaking) { stopSpeaking(); return; }

  voice = voice || pickVoice();
  speechSynthesis.cancel();

  // In Sätze zerlegen: iOS bricht lange Äußerungen sonst ab
  const chunks = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  chunks.forEach((sentence, n) => {
    const u = new SpeechSynthesisUtterance(sentence);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'de-DE';
    u.rate = 1.0; u.pitch = 1.0;
    if (n === chunks.length - 1) u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    speechSynthesis.speak(u);
  });
  setSpeaking(true);
}

function stopSpeaking() { speechSynthesis.cancel(); setSpeaking(false); }

function setSpeaking(on) {
  speaking = on;
  $('#bfSpeak')?.classList.toggle('is-speaking', on);
  const l = $('#bfSpeakLabel');
  if (l) l.textContent = on ? 'Stopp' : 'Vorlesen';
}

// ══ Darstellung ════════════════════════════════════════════
function setBusy(on) {
  busy = on;
  const b = $('#bfGo');
  if (!b) return;
  b.disabled = on;
  b.classList.toggle('is-busy', on);
  $('#bfGoLabel').textContent = on ? 'Wird geschrieben…' : 'Bericht erstellen';
}

const PRICES = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [3, 15], 'claude-haiku-4-5': [1, 5] };

/** Fußzeile unter dem Text: welcher Weg, welches Modell, ggf. was es gekostet hat. */
function viaLabel(model, out) {
  const mName = (MODELS.find(m => m.id === model) || {}).name || model;
  if (out?.via !== 'api') return `${mName} <i>über Max-Abo · keine Zusatzkosten</i>`;
  const [pin, pout] = PRICES[model] || PRICES['claude-opus-5'];
  const u = out.usage || {};
  const cost = ((u.input_tokens ?? 0) / 1e6) * pin + ((u.output_tokens ?? 0) / 1e6) * pout;
  return `${mName} <i>über API · ${(cost * 100).toFixed(1)} Cent</i>`;
}

function renderResult(model, out) {
  const box = $('#bfResult');

  box.innerHTML = `
    <p class="bf-text">${text.replace(/\n+/g, '</p><p class="bf-text">')}</p>
    <div class="bf-actions">
      <button class="bf-speak" id="bfSpeak">
        <svg viewBox="0 0 24 24" class="ico-speak"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19.5 5.5a9 9 0 0 1 0 13"/></svg>
        <svg viewBox="0 0 24 24" class="ico-stop"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
        <span id="bfSpeakLabel">Vorlesen</span>
      </button>
      <span class="bf-cost">${viaLabel(model, out)}</span>
    </div>`;

  $('#bfSpeak').addEventListener('click', speak);
  setSpeaking(false);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderChips() {
  const sel = selectedParts();
  $('#bfParts').innerHTML = PARTS.map(p =>
    `<button class="chip${sel.includes(p.id) ? ' on' : ''}" data-part="${p.id}">${p.label}</button>`
  ).join('');

  $$('#bfParts .chip').forEach(b => b.addEventListener('click', () => {
    const cur = selectedParts();
    const id = b.dataset.part;
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    store.set(LS.parts, next);
    b.classList.toggle('on');
  }));

  const len = selectedLength();
  $('#bfLen').innerHTML = LENGTHS.map(l =>
    `<button class="chip len${l.id === len ? ' on' : ''}" data-len="${l.id}">${l.label}<i>${l.hint}</i></button>`
  ).join('');

  $$('#bfLen .chip').forEach(b => b.addEventListener('click', () => {
    store.set(LS.len, b.dataset.len);
    $$('#bfLen .chip').forEach(x => x.classList.toggle('on', x === b));
  }));
}

// ══ Einstellungen ══════════════════════════════════════════
function renderRoute() {
  const r = route();
  $('#bfRoute').innerHTML = [
    { id: 'mac', label: 'Über den Mac', note: 'Max-Abo · kostenlos' },
    { id: 'api', label: 'Über die API', note: 'kostet pro Bericht' }
  ].map(o => `<button class="chip route${o.id === r ? ' on' : ''}" data-route="${o.id}">
      ${o.label}<i>${o.note}</i></button>`).join('');

  $$('#bfRoute .chip').forEach(b => b.addEventListener('click', () => {
    store.set(LS.route, b.dataset.route);
    $$('#bfRoute .chip').forEach(x => x.classList.toggle('on', x === b));
    $('#bfKeyField').hidden = b.dataset.route !== 'api';
    $('#bfCheck').hidden = b.dataset.route !== 'mac';
    $('#bfStatus').hidden = b.dataset.route !== 'mac';
    if (b.dataset.route === 'mac') checkBridge();
  }));

  $('#bfKeyField').hidden = r !== 'api';
  $('#bfCheck').hidden = r !== 'mac';
  $('#bfStatus').hidden = r !== 'mac';
}

function openSettings() {
  $('#bfProxy').value = store.get(LS.proxy, '');
  $('#bfProxy').placeholder = DEFAULT_PROXY;
  $('#bfKey').value = apiKey();
  const m = selectedModel();
  $('#bfModel').innerHTML = MODELS.map(x =>
    `<option value="${x.id}"${x.id === m ? ' selected' : ''}>${x.name} — ${x.note}</option>`
  ).join('');
  renderRoute();
  if (route() === 'mac') checkBridge();
  host.openSheet('#bfSheet');
}

/** Zeigt in den Einstellungen an, ob der Mac gerade antwortet. */
async function checkBridge() {
  const el = $('#bfStatus');
  if (!el) return;
  el.className = 'bridge-status wait';
  el.textContent = 'Prüfe Verbindung zum Mac…';
  try {
    const res = await fetch(`${proxyUrl()}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', system: 'Antworte mit genau einem Wort.', user: 'Sag OK.' })
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.text) {
      el.className = 'bridge-status ok';
      el.textContent = '✓ Mac antwortet — Berichte laufen übers Max-Abo.';
    } else {
      el.className = 'bridge-status bad';
      el.textContent = `✕ ${d.error || 'Keine Antwort'}`;
    }
  } catch (e) {
    el.className = 'bridge-status bad';
    el.textContent = `✕ Worker nicht erreichbar (${e.message})`;
  }
}

function saveSettings() {
  const proxy = $('#bfProxy').value.trim();
  if (proxy && !/^https:\/\//i.test(proxy)) { host.toast('Adresse muss mit https:// beginnen.'); return; }
  const key = $('#bfKey').value.trim();
  if (route() === 'api' && !key) { host.toast('Für den API-Weg wird ein Schlüssel gebraucht.'); return; }
  store.set(LS.proxy, proxy);
  store.set(LS.key, key);
  store.set(LS.model, $('#bfModel').value);
  host.closeSheet('#bfSheet');
  host.toast(route() === 'api' ? 'Gespeichert — läuft jetzt über die API.' : 'Gespeichert.');
}

// ══ Start ══════════════════════════════════════════════════
function init(hostApi) {
  host = hostApi;
  renderChips();
  $('#bfGo').addEventListener('click', generate);
  $('#bfSettings').addEventListener('click', openSettings);
  $('#bfSave').addEventListener('click', saveSettings);
  $('#bfCheck').addEventListener('click', checkBridge);
  $('#bfClose').addEventListener('click', () => host.closeSheet('#bfSheet'));
  $('#bfSheet').addEventListener('click', e => { if (e.target.id === 'bfSheet') host.closeSheet('#bfSheet'); });

  // Stimmenliste wird auf iOS asynchron gefüllt
  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); };
    voice = pickVoice();
  }
  // Beim Verlassen der Seite nicht weiterreden
  document.addEventListener('visibilitychange', () => { if (document.hidden && speaking) stopSpeaking(); });
}

return { init, ask };   // ask wird auch vom Nachrichten-Modul genutzt
})();
