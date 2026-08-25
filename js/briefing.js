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
             route: 'wf.route', key: 'wf.aikey', voice: 'wf.voice', rate: 'wf.rate',
             ttsPass: 'wf.ttsPass', kiStimme: 'wf.kiStimme', nutzeKI: 'wf.nutzeKI',
             berichte: 'wf.berichte' };

/* Berichte bleiben liegen. Vorher lebte der fertige Text nur in einer
   Variablen — wer die App kurz verließ, fand ihn nicht wieder, obwohl er
   Rechenzeit gekostet hatte. Jetzt landen die letzten zehn im Speicher des
   Geräts, mit Zeitstempel; beim Öffnen steht der jüngste wieder da. */
const BERICHTE_MAX = 10;
const BERICHTE_TAGE = 30;

function berichteLesen() {
  const alle = store.get(LS.berichte, []);
  if (!Array.isArray(alle)) return [];
  const grenze = Date.now() - BERICHTE_TAGE * 86400000;
  return alle.filter(b => b && typeof b.text === 'string' && b.t > grenze);
}

function berichtMerken(eintrag) {
  const alle = [eintrag, ...berichteLesen()].slice(0, BERICHTE_MAX);
  store.set(LS.berichte, alle);
  return alle;
}

/** Adresse des eigenen Cloudflare Workers. */
const DEFAULT_PROXY = 'https://wetterfunk.florian-s-thiel.workers.dev';
const proxyUrl = () => (store.get(LS.proxy, '') || DEFAULT_PROXY).replace(/\/+$/, '');

/** 'mac' = über die Bridge (Standard, kostenlos übers Max-Abo)
    'api' = direkt an die Anthropic-API mit eigenem Schlüssel (kostet).
    Es wird nie automatisch gewechselt — die Wahl trifft ausschließlich der Nutzer. */
const route = () => store.get(LS.route, 'mac');
const apiKey = () => store.get(LS.key, '');
const API_URL = 'https://api.anthropic.com/v1/messages';

/* Die Modellantwort verarbeitet DWD-Texte und Nachrichten — dort könnte
   eingeschleuster Code stehen. Vor dem Einsetzen ins Seitengerüst entschärfen. */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
- Beginne mit dem Wetter im Moment. Nur wenn amtliche Warnungen vorliegen, kommen die davor.
- Erwähne nie, dass etwas nicht vorliegt. Keine Sätze wie "Es liegen keine Warnungen vor" oder "Regen ist nicht zu erwarten" als Einstieg.
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
    berichtMerken({ t: Date.now(), text, label: viaLabel(model, out) });
    renderResult(model, out);
  } catch (e) {
    console.error(e);
    host.toast(`Bericht fehlgeschlagen: ${e.message}`.slice(0, 130));
  } finally {
    setBusy(false);
  }
}

// ══ Vorlesen ═══════════════════════════════════════════════
let speaking = false, voice = null, saetze = [], satzNr = 0, fremdKnopf = null;

/* ── KI-Stimme ──────────────────────────────────────────────
   Klingt deutlich natürlicher als die Systemstimmen, kostet aber pro Abruf.
   Der Schlüssel liegt im eigenen Worker, freigeschaltet wird mit einem
   Kennwort — sonst könnte jeder, der die Adresse kennt, auf fremde Rechnung
   sprechen lassen. */
const KI_STIMMEN = [
  { id: 'eve', name: 'Eve · weiblich, ruhig' },
  { id: 'ara', name: 'Ara · weiblich, wach' },
  { id: 'leo', name: 'Leo · männlich, warm' },
  { id: 'rex', name: 'Rex · männlich, kräftig' },
  { id: 'sal', name: 'Sal · neutral' }
];

let audioAus = null;          // laufende Wiedergabe
let kiAbbruch = null;         // hält das stückweise Vorlesen an

const kiAktiv = () => !!store.get(LS.ttsPass, '') && store.get(LS.nutzeKI, true);

/* prompt() blockiert den ganzen Seitenablauf und wird von installierten
   Web-Apps teils gar nicht angezeigt — deshalb ein eigenes Fenster. */
function frageKennwort() {
  return new Promise((fertig) => {
    const back = document.createElement('div');
    back.className = 'sheet-back open kw-back';
    back.innerHTML = `
      <div class="sheet kw-sheet" role="dialog" aria-label="Kennwort">
        <div class="sheet-top"><div class="sheet-grip"></div></div>
        <h3>KI-Stimme freischalten</h3>
        <p class="sheet-note">Die natürliche Stimme läuft über einen kostenpflichtigen
          Dienst. Mit dem Kennwort wird sie für dieses Gerät freigeschaltet — einmalig,
          danach bleibt sie an.</p>
        <input type="password" class="kw-feld" placeholder="Kennwort" autocomplete="off"
               enterkeyhint="go" inputmode="text">
        <div class="kw-knoepfe">
          <button class="kw-ab">Abbrechen</button>
          <button class="kw-ok">Freischalten</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const feld = back.querySelector('.kw-feld');
    setTimeout(() => feld.focus(), 120);

    const schliessen = (wert) => { back.remove(); fertig(wert); };
    back.querySelector('.kw-ok').onclick = () => schliessen(feld.value.trim());
    back.querySelector('.kw-ab').onclick = () => schliessen(null);
    back.onclick = (e) => { if (e.target === back) schliessen(null); };
    feld.onkeydown = (e) => { if (e.key === 'Enter') schliessen(feld.value.trim()); };
  });
}

async function kiFreischalten() {
  const eingabe = await frageKennwort();
  if (!eingabe) return;

  host?.toast('Kennwort wird geprüft…', 1500);
  try {
    const res = await fetch(`${proxyUrl()}/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Wetterfunk ist bereit.', passwort: eingabe, stimme: 'eve' })
    });
    if (res.status === 401) { host?.toast('Falsches Kennwort.'); return; }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      host?.toast(`Klappt nicht: ${d.error || res.status}`, 4000);
      return;
    }
    store.set(LS.ttsPass, eingabe);
    store.set(LS.nutzeKI, true);
    host?.toast('KI-Stimme freigeschaltet.');
    alleLeisten();
    // Gleich einmal hören, dass es geht
    const blob = await res.blob();
    new Audio(URL.createObjectURL(blob)).play().catch(() => {});
  } catch (e) {
    host?.toast(`Nicht erreichbar: ${e.message}`.slice(0, 120), 4000);
  }
}

/* Text in sprechbare Häppchen teilen. Das erste ist bewusst kurz: Die
   Erzeugung dauert etwa so lange wie der Text lang ist, und was zählt, ist
   die Zeit bis zum ersten Ton. Danach größere Stücke — die sind schon
   unterwegs, während das erste noch läuft. */
function inHaeppchen(inhalt) {
  const saetze = String(inhalt).split(/(?<=[.!?])\s+/).filter(Boolean);
  const teile = [];
  let puffer = '';
  for (const satz of saetze) {
    const ziel = teile.length === 0 ? 140 : 420;
    if (puffer && (puffer + ' ' + satz).length > ziel) { teile.push(puffer); puffer = satz; }
    else puffer = puffer ? `${puffer} ${satz}` : satz;
  }
  if (puffer) teile.push(puffer);
  return teile;
}

/** Ein Häppchen holen. Gibt eine Adresse auf das fertige Audio zurück. */
async function holeAudio(stueck) {
  const res = await fetch(`${proxyUrl()}/tts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: stueck,
      stimme: store.get(LS.kiStimme, 'eve'),
      // Serverseitig höchstens 1,5× — schneller regelt der Abspieler
      tempo: Math.min(1.5, store.get(LS.rate, 1)),
      passwort: store.get(LS.ttsPass, '')
    })
  });
  if (res.status === 401) { const e = new Error('kennwort'); e.code = 401; throw e; }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Fehler ${res.status}`);
  }
  return URL.createObjectURL(await res.blob());
}

/* Der ganze Bericht auf einmal dauert mehrere Sekunden, bis der erste Ton
   kommt. Deshalb stückweise: Das erste Häppchen wird abgespielt, während die
   nächsten schon unterwegs sind. */
async function speakKI(inhalt, aufKnopf) {
  stopSpeaking();
  fremdKnopf = aufKnopf || null;
  setSpeaking(true, 'lädt');

  const stuecke = inHaeppchen(inhalt);
  const geladen = new Array(stuecke.length).fill(null);
  let abgebrochen = false;
  kiAbbruch = () => { abgebrochen = true; };

  // Vorauslesen: höchstens zwei Häppchen gleichzeitig unterwegs
  let naechstesZuHolen = 0;
  let gespieltBis = 0;
  const nachladen = () => {
    while (naechstesZuHolen < stuecke.length && naechstesZuHolen < 2 + gespieltBis) {
      const n = naechstesZuHolen++;
      geladen[n] = holeAudio(stuecke[n]).catch(e => ({ fehler: e }));
    }
  };
  nachladen();

  try {
    for (let n = 0; n < stuecke.length; n++) {
      if (abgebrochen) return;
      const ergebnis = await geladen[n];
      if (abgebrochen) return;
      if (ergebnis?.fehler) throw ergebnis.fehler;

      setSpeaking(true);                       // ab jetzt läuft Ton
      await spieleAb(ergebnis);
      URL.revokeObjectURL(ergebnis);
      gespieltBis = n + 1;
      nachladen();
    }
    setSpeaking(false);
  } catch (e) {
    if (abgebrochen) return;
    if (e?.code === 401) {
      store.set(LS.ttsPass, '');
      host?.toast('Kennwort abgelaufen — bitte neu freischalten.', 4000);
      alleLeisten();
    } else {
      console.warn('KI-Stimme:', e);
      host?.toast(`Sprachausgabe: ${e.message}`.slice(0, 130), 4000);
    }
    setSpeaking(false);
  } finally {
    kiAbbruch = null;
  }
}

/** Ein Häppchen abspielen und warten, bis es zu Ende ist. */
function spieleAb(url) {
  return new Promise((fertig, fehler) => {
    audioAus = new Audio(url);
    // Über 1,5× regelt der Abspieler nach; ohne preservesPitch klingt es piepsig
    const wunsch = store.get(LS.rate, 1);
    audioAus.preservesPitch = true;
    audioAus.playbackRate = wunsch > 1.5 ? wunsch / 1.5 : 1;
    audioAus.onended = () => fertig();
    audioAus.onerror = () => fehler(new Error('Konnte nicht abspielen'));
    audioAus.play().catch(fehler);
  });
}

/** Apples Spaßstimmen tauchen in der Liste mit auf, taugen aber nicht
    zum Vorlesen — sie kommen ganz ans Ende. */
const SPASS = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Albert|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Bahh|Bells|Boing|Bubbles|Cellos)\b/i;

/** Alle deutschen Stimmen, beste zuerst. Ohne Zusatzdownload steht auf Apple-
    Geräten nur die alte "Anna" bereit — Premium/Enhanced klingen deutlich besser. */
function germanVoices() {
  const de = speechSynthesis.getVoices()
    .filter(v => v.lang?.toLowerCase().startsWith('de'))
    // Spaßstimmen ganz raus: Sie stehen sonst gleichwertig in der Liste und
    // machen aus dem Wetterbericht eine Karikatur.
    .filter(v => !SPASS.test(v.name));
  const rang = (v) => (/premium/i.test(v.name) ? 0
                     : /enhanced/i.test(v.name) ? 1
                     : /siri/i.test(v.name) ? 2
                     : v.localService ? 3 : 4);
  return de.sort((a, b) => rang(a) - rang(b) || a.name.localeCompare(b.name));
}

/** Stehen nur Basisstimmen bereit? Dann lohnt der Hinweis auf den Download. */
const nurBasisStimmen = () => !germanVoices().some(v => /premium|enhanced|siri/i.test(v.name));

function pickVoice() {
  const gespeichert = store.get(LS.voice, '');
  const alle = germanVoices();
  return alle.find(v => v.voiceURI === gespeichert) || alle[0] || null;
}

/** Sätze nacheinander sprechen statt alle auf einmal in die Schlange zu
    legen — iOS bricht lange Schlangen sonst mittendrin ab. */
function speakNext() {
  if (!speaking || satzNr >= saetze.length) { setSpeaking(false); return; }
  const u = new SpeechSynthesisUtterance(saetze[satzNr]);
  if (voice) u.voice = voice;
  u.lang = voice?.lang || 'de-DE';
  u.rate = store.get(LS.rate, 1);
  u.pitch = 1;
  u.onend = () => { satzNr++; speakNext(); };
  u.onerror = (e) => {
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    console.warn('Vorlesen:', e.error);
    satzNr++; speakNext();
  };
  speechSynthesis.speak(u);
}

function speak() {
  if (!text) return;
  if (speaking) { stopSpeaking(); return; }
  // Freigeschaltete KI-Stimme hat Vorrang vor der Systemstimme
  if (kiAktiv()) { speakKI(text, null); return; }
  if (!('speechSynthesis' in window)) { host.toast('Vorlesen wird nicht unterstützt.'); return; }

  speechSynthesis.cancel();
  voice = pickVoice();
  if (!voice) {
    host.toast('Keine deutsche Stimme gefunden. In den iOS-Einstellungen unter Bedienungshilfen → Gesprochene Inhalte eine laden.', 5000);
  }

  saetze = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  satzNr = 0;
  setSpeaking(true);

  // Direkt im Klick starten — sonst blockt iOS die Sprachausgabe
  speakNext();

  // Manche Geräte pausieren die Ausgabe unerwartet; alle paar Sekunden lösen
  clearInterval(speak._wach);
  speak._wach = setInterval(() => {
    if (!speaking) { clearInterval(speak._wach); return; }
    if (speechSynthesis.paused) speechSynthesis.resume();
  }, 3000);
}

function stopSpeaking() {
  speaking = false;
  clearInterval(speak._wach);
  try { speechSynthesis.cancel(); } catch {}
  if (kiAbbruch) { kiAbbruch(); kiAbbruch = null; }
  if (audioAus) { audioAus.pause(); audioAus.currentTime = 0; audioAus = null; }
  setSpeaking(false);
}

function setSpeaking(on, zustand = null) {
  speaking = on;
  const laden = zustand === 'lädt';
  $('#bfSpeak')?.classList.toggle('is-speaking', on);
  const l = $('#bfSpeakLabel');
  if (l) l.textContent = laden ? 'Stimme lädt…' : on ? 'Stopp' : 'Vorlesen';
  // Ein von außen angemeldeter Knopf (etwa am amtlichen Bericht) zeigt denselben Zustand
  if (fremdKnopf) {
    fremdKnopf.classList.toggle('is-speaking', on);
    const t = fremdKnopf.querySelector('span');
    if (t) t.textContent = laden ? 'Stimme lädt…' : on ? 'Stopp' : (t.dataset.ruhe || 'Vorlesen');
    if (!on) fremdKnopf = null;
  }
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
  zeigeBericht(viaLabel(model, out), true);
}

/** Wann wurde der Bericht geschrieben? */
function alterWort(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 2) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const d = new Date(t);
  const heute = d.toDateString() === new Date().toDateString();
  const uhr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (heute) return `heute ${uhr} Uhr`;
  return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}, ${uhr} Uhr`;
}

/** Den Bericht anzeigen — frisch erzeugt oder aus dem Speicher geholt.
    `springen` nur beim frischen, sonst würde die Seite beim Öffnen
    ungefragt nach unten rutschen. */
function zeigeBericht(label, springen, stand = Date.now(), pos = 0) {
  const box = $('#bfResult');
  if (!box) return;
  const alle = berichteLesen();

  box.innerHTML = `
    <p class="bf-text">${esc(text).replace(/\n+/g, '</p><p class="bf-text">')}</p>
    <div class="bf-actions">
      <button class="bf-speak" id="bfSpeak">
        <svg viewBox="0 0 24 24" class="ico-speak"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19.5 5.5a9 9 0 0 1 0 13"/></svg>
        <svg viewBox="0 0 24 24" class="ico-stop"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
        <span id="bfSpeakLabel">Vorlesen</span>
      </button>
      <span class="bf-cost">${label} <i>· ${esc(alterWort(stand))}</i></span>
    </div>
    <div class="bf-voice" id="bfVoiceBar"></div>
    ${alle.length > 1 ? `<div class="bf-verlauf">Frühere Berichte: ${
      alle.map((b, i) => `<button class="bf-alt${i === pos ? ' ist-da' : ''}" data-nr="${i}">${
        esc(alterWort(b.t))}</button>`).join('')}</div>` : ''}`;

  $('#bfSpeak').addEventListener('click', speak);
  box.querySelectorAll('.bf-alt').forEach(k => k.addEventListener('click', () => {
    const b = berichteLesen()[+k.dataset.nr];
    if (!b) return;
    if (speaking) stopSpeaking();
    text = b.text;
    zeigeBericht(b.label || '', false, b.t, +k.dataset.nr);
  }));
  renderVoiceBar();
  setSpeaking(false);
  if (springen) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Beim Start den zuletzt geschriebenen Bericht wieder hinstellen. */
function letztenBerichtZeigen() {
  const alle = berichteLesen();
  if (!alle.length) return;
  text = alle[0].text;
  zeigeBericht(alle[0].label || '', false, alle[0].t, 0);
}

const RATES = [0.8, 1, 1.2, 1.5, 2];

/** Stimme und Tempo einstellen. Die Liste steht erst bereit, wenn der Browser
    die Stimmen geladen hat — deshalb zusätzlich auf `voiceschanged` hören. */
function renderVoiceBar(ziel) {
  const bar = ziel || $('#bfVoiceBar');
  if (!bar) return;
  bar.classList.add('bf-voice');
  const stimmen = germanVoices();
  if (!stimmen.length) { bar.innerHTML = '<span class="bf-hint">Stimmen werden geladen…</span>'; return; }

  const aktiv = pickVoice();
  const tempo = store.get(LS.rate, 1);
  const kiAn = !!store.get(LS.ttsPass, '');
  bar.innerHTML = `
    <label class="bf-voice-pick">
      <span>Stimme</span>
      <select>
        ${kiAn ? `<optgroup label="KI-Stimmen">
          ${KI_STIMMEN.map(s => `<option value="ki:${s.id}"${
            store.get(LS.kiStimme, 'eve') === s.id && store.get(LS.nutzeKI, true)
              ? ' selected' : ''}>${s.name}</option>`).join('')}
        </optgroup>` : ''}
        <optgroup label="Systemstimmen">
        ${stimmen.map(v => `<option value="${esc(v.voiceURI)}"${
          v.voiceURI === aktiv?.voiceURI && !(kiAn && store.get(LS.nutzeKI, true))
            ? ' selected' : ''}>${v.name.replace(/\s*\(.*?\)/, '')}</option>`).join('')}
        </optgroup>
      </select>
    </label>
    <div class="bf-rate" role="group" aria-label="Sprechtempo">
      <span>Tempo</span>
      ${RATES.map(r => `<button type="button" data-rate="${r}" class="${r === tempo ? 'on' : ''}">${String(r).replace('.', ',')}×</button>`).join('')}
    </div>
    ${kiAn
      ? `<button type="button" class="bf-kiaus">KI-Stimme abmelden</button>`
      : `<button type="button" class="bf-kian">🎙 KI-Stimme freischalten</button>`}
    ${nurBasisStimmen() && !kiAn ? `<p class="bf-voicehint">
      Klingt blechern? Es ist die alte Systemstimme. Eine natürliche gibt es gratis:
      <b>Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen → Deutsch</b>
      und dort eine Premium-Stimme laden. Danach hier auswählen.
    </p>` : ''}`;

  $('.bf-voice-pick select', bar).addEventListener('change', (e) => {
    const wert = e.target.value;
    if (wert.startsWith('ki:')) {
      store.set(LS.nutzeKI, true);
      store.set(LS.kiStimme, wert.slice(3));
    } else {
      store.set(LS.nutzeKI, false);
      store.set(LS.voice, wert);
      voice = pickVoice();
    }
    if (speaking) stopSpeaking();
    alleLeisten();
  });
  $('.bf-kian', bar)?.addEventListener('click', kiFreischalten);
  $('.bf-kiaus', bar)?.addEventListener('click', () => {
    store.set(LS.ttsPass, '');
    store.set(LS.nutzeKI, false);
    host?.toast('KI-Stimme abgemeldet.');
    alleLeisten();
  });
  $$('.bf-rate button', bar).forEach(b => b.addEventListener('click', () => {
    store.set(LS.rate, Number(b.dataset.rate));
    // Neues Tempo greift ab dem laufenden Satz
    if (speaking) { const n = satzNr; speechSynthesis.cancel(); satzNr = n; speakNext(); }
    alleLeisten();
  }));
}

/** Es kann mehrere Leisten geben (eigener Bericht, amtlicher Bericht) —
    eine Änderung muss überall sichtbar werden. */
const alleLeisten = () => $$('.bf-voice').forEach(b => renderVoiceBar(b));

if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener?.('voiceschanged', () => { voice = null; alleLeisten(); });
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
  letztenBerichtZeigen();
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

/* ── Vorlesen von außen ─────────────────────────────────────
   Auch der amtliche DWD-Bericht soll gesprochen werden können — mit
   derselben Stimme und demselben Tempo wie der eigene Bericht. */
function speakText(inhalt, aufKnopf) {
  if (fremdKnopf === aufKnopf && speaking) { stopSpeaking(); return; }
  if (kiAktiv()) { speakKI(String(inhalt), aufKnopf); return; }
  if (!('speechSynthesis' in window)) { host?.toast('Vorlesen wird nicht unterstützt.'); return; }

  speechSynthesis.cancel();
  voice = pickVoice();
  saetze = String(inhalt).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  satzNr = 0;
  fremdKnopf = aufKnopf || null;
  setSpeaking(true);
  speakNext();

  clearInterval(speak._wach);
  speak._wach = setInterval(() => {
    if (!speaking) { clearInterval(speak._wach); return; }
    if (speechSynthesis.paused) speechSynthesis.resume();
  }, 3000);
}

return { init, ask, speakText, voiceControls: renderVoiceBar, isSpeaking: () => speaking };
// ask wird auch vom Nachrichten-Modul genutzt
})();
