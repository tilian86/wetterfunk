/* Wetterfunk — Gesprochener Wetterbericht
   Baut aus den geladenen Daten einen Prompt, lässt ihn von Claude formulieren
   und liest ihn mit der Systemstimme vor. API-Schlüssel bleibt auf dem Gerät. */

const Briefing = (() => {
'use strict';

const API = 'https://api.anthropic.com/v1/messages';

// Preise in $ je 1 Mio. Tokens (Stand Juli 2026)
const MODELS = [
  { id: 'claude-opus-5',  name: 'Opus 5',   note: 'beste Qualität', in: 5,  out: 25 },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', note: 'günstiger',      in: 3,  out: 15 },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', note: 'am günstigsten', in: 1, out: 5 }
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

const LS = { key: 'wf.aikey', proxy: 'wf.proxy', model: 'wf.model', parts: 'wf.parts', len: 'wf.len' };

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
async function generate() {
  const parts = selectedParts();
  if (!parts.length) { host.toast('Mindestens einen Punkt auswählen.'); return; }

  const key = store.get(LS.key, '');
  const proxy = store.get(LS.proxy, '');
  if (!key && !proxy) { openSettings(); host.toast('Zuerst API-Schlüssel eintragen.'); return; }

  const { system, user } = buildPrompt(parts, selectedLength());
  const model = selectedModel();

  const body = {
    model,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: user }]
  };

  const headers = { 'content-type': 'application/json' };
  let url = proxy || API;
  if (!proxy) {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  setBusy(true);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `${res.status} ${res.statusText}`);
    }
    const out = await res.json();

    if (out.stop_reason === 'refusal') {
      host.toast('Die Anfrage wurde abgelehnt.');
      return;
    }

    text = (out.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    if (!text) { host.toast('Keine Antwort erhalten.'); return; }

    renderResult(out.usage, model);
  } catch (e) {
    console.error(e);
    host.toast(`Bericht fehlgeschlagen: ${e.message}`.slice(0, 120));
  } finally {
    setBusy(false);
  }
}

function costOf(usage, modelId) {
  const m = MODELS.find(x => x.id === modelId) || MODELS[0];
  const inTok = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0)
              + (usage?.cache_creation_input_tokens ?? 0);
  const outTok = usage?.output_tokens ?? 0;
  return (inTok / 1e6) * m.in + (outTok / 1e6) * m.out;
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

function renderResult(usage, model) {
  const box = $('#bfResult');
  const cost = costOf(usage, model);
  const mName = (MODELS.find(m => m.id === model) || {}).name || model;

  box.innerHTML = `
    <p class="bf-text">${text.replace(/\n+/g, '</p><p class="bf-text">')}</p>
    <div class="bf-actions">
      <button class="bf-speak" id="bfSpeak">
        <svg viewBox="0 0 24 24" class="ico-speak"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19.5 5.5a9 9 0 0 1 0 13"/></svg>
        <svg viewBox="0 0 24 24" class="ico-stop"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
        <span id="bfSpeakLabel">Vorlesen</span>
      </button>
      <span class="bf-cost">${mName} · ${(cost * 100).toFixed(1)} Cent
        <i>${usage?.input_tokens ?? 0} + ${usage?.output_tokens ?? 0} Tokens</i></span>
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
function openSettings() {
  $('#bfKey').value = store.get(LS.key, '');
  $('#bfProxy').value = store.get(LS.proxy, '');
  const m = selectedModel();
  $('#bfModel').innerHTML = MODELS.map(x =>
    `<option value="${x.id}"${x.id === m ? ' selected' : ''}>${x.name} — ${x.note} ($${x.in}/$${x.out} je Mio. Tokens)</option>`
  ).join('');
  host.openSheet('#bfSheet');
}

function saveSettings() {
  const key = $('#bfKey').value.trim();
  const proxy = $('#bfProxy').value.trim();
  if (proxy && !/^https:\/\//i.test(proxy)) { host.toast('Proxy-Adresse muss mit https:// beginnen.'); return; }
  store.set(LS.key, key);
  store.set(LS.proxy, proxy);
  store.set(LS.model, $('#bfModel').value);
  host.closeSheet('#bfSheet');
  host.toast('Gespeichert.');
}

// ══ Start ══════════════════════════════════════════════════
function init(hostApi) {
  host = hostApi;
  renderChips();
  $('#bfGo').addEventListener('click', generate);
  $('#bfSettings').addEventListener('click', openSettings);
  $('#bfSave').addEventListener('click', saveSettings);
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

return { init };
})();
