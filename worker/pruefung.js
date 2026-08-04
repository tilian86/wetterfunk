/* Wetterfunk — täglicher Prüflauf
   Wie gut war die Vorhersage von gestern? Einmal am Tag gemessen, in den
   Speicher gelegt, in der Funkzentrale sichtbar.

   Warum das MISST und nicht STELLT: In diesem Projekt gab es schon einmal
   eine Automatik, die sich selbst umstellte — sie wechselte täglich zum
   Modell, das zuletzt am besten lag. Nachgeprüft über 23 Tage war sie
   13 Prozent SCHLECHTER als das feste Modell. Sie sah klug aus und war es
   nicht; sie flog wieder raus.

   Was seitdem gilt: Zahlen sammeln sich von selbst an, geändert wird erst,
   wenn ein Vergleich über Wochen sagt, dass es besser wird. Eine Automatik,
   die sich ohne Nachweis nachjustiert, verschlechtert sich unbemerkt — und
   niemand merkt es, weil sie ja „lernt".

   Gemessen wird gegen das, was wirklich passiert ist:
   · Temperatur und Regen  → Messung der nächsten DWD-Station
   · Bewölkung             → Reanalyse (keine Station hier misst Wolken)  */

const TAG = 86400000;
const HALTBAR = 90 * 86400;          // Sekunden: drei Monate Verlauf genügen

const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function holJson(url, ms = 20000) {
  const ab = new AbortController();
  const t = setTimeout(() => ab.abort(), ms);
  try {
    const r = await fetch(url, { signal: ab.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/* Die nächste Station, die gestern wirklich gemeldet hat. Ohne Messung
   keine Prüfung — dann fehlt der Tag lieber, als dass er geraten wird. */
async function messung(lat, lon, tag) {
  /* `last_date` muss der FOLGETAG sein. Mit demselben Datum in beiden
     Feldern liefert Bright Sky genau eine Stunde — Mitternacht — und die
     Prüfung fiel mangels Messwerten still aus. */
  const bis = iso(Date.parse(tag) + TAG);
  const d = await holJson(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}`
    + `&date=${tag}&last_date=${bis}&tz=Europe/Berlin`);
  const w = (d?.weather || []).filter(x => x.temperature != null && x.timestamp.startsWith(tag));
  if (w.length < 12) return null;
  const karte = new Map();
  for (const x of w) karte.set(x.timestamp.slice(0, 13), x);
  return karte;
}

const wolkenWort = (c) => (c < 25 ? 'sonnig' : c < 55 ? 'heiter' : c < 80 ? 'wolkig' : 'bedeckt');
const mittelwert = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const MODELLE = ['icon_d2', 'icon_eu', 'ecmwf_ifs025', 'gfs_seamless',
                 'ukmo_seamless', 'meteofrance_seamless'];

/** Ein Ort, ein Tag: Was war angesagt, was kam wirklich? */
export async function pruefeOrt(lat, lon, tag) {
  /* Wie weit muss der Rückblick reichen? Bis zum Prüftag, plus zwei Tage
     Luft. Mit fest eingetragenen zwei Tagen fehlte jeder Prüftag, der
     länger als gestern zurücklag — das Fenster reichte gar nicht dorthin. */
  const zurueck = Math.min(90, Math.max(2,
    Math.ceil((Date.now() - Date.parse(tag)) / TAG) + 2));
  const [vh, mess, wolken] = await Promise.all([
    holJson('https://previous-runs-api.open-meteo.com/v1/forecast?'
      + new URLSearchParams({
          latitude: String(lat), longitude: String(lon), timezone: 'Europe/Berlin',
          hourly: 'temperature_2m_previous_day1,precipitation_previous_day1,cloud_cover_previous_day1',
          models: MODELLE.join(','), past_days: String(zurueck), forecast_days: '1'
        }), 25000),
    messung(lat, lon, tag),
    holJson('https://archive-api.open-meteo.com/v1/archive?'
      + new URLSearchParams({
          latitude: String(lat), longitude: String(lon), timezone: 'Europe/Berlin',
          hourly: 'cloud_cover', start_date: tag, end_date: tag
        }), 25000)
  ]);
  if (!vh?.hourly?.time) return null;

  const H = vh.hourly;
  const feld = (art, m) => H[`${art}_previous_day1_${m}`] || [];

  const tempFehler = [], tempFehlerMittel = [];
  let regenRichtig = 0, regenGesamt = 0, regenVerpasst = 0, regenFehlalarm = 0;
  const himmelEinzel = [], himmelMittel = [];

  const wahrWolken = new Map();
  if (wolken?.hourly?.time) {
    wolken.hourly.time.forEach((t, i) => {
      const c = wolken.hourly.cloud_cover[i];
      if (c != null) wahrWolken.set(t.slice(0, 13), c);
    });
  }

  for (let i = 0; i < H.time.length; i++) {
    const t = H.time[i];
    if (!t.startsWith(tag)) continue;
    const k = t.slice(0, 13);

    // ── Temperatur und Regen gegen die Station
    const m = mess?.get(k);
    if (m) {
      const einzel = feld('temperature_2m', 'icon_d2')[i];
      const alle = MODELLE.map(x => feld('temperature_2m', x)[i]).filter(v => v != null);
      if (einzel != null) tempFehler.push(Math.abs(einzel - m.temperature));
      if (alle.length >= 3) tempFehlerMittel.push(Math.abs(median(alle) - m.temperature));

      const vorhergesagt = feld('precipitation', 'icon_d2')[i];
      if (vorhergesagt != null && m.precipitation != null) {
        const angesagt = vorhergesagt >= 0.15;
        const gefallen = m.precipitation >= 0.1;
        regenGesamt++;
        if (angesagt === gefallen) regenRichtig++;
        else if (gefallen) regenVerpasst++;
        else regenFehlalarm++;
      }
    }

    // ── Bewölkung gegen die Reanalyse
    const wahr = wahrWolken.get(k);
    if (wahr != null) {
      const einzel = feld('cloud_cover', 'icon_d2')[i];
      const alle = MODELLE.map(x => feld('cloud_cover', x)[i]).filter(v => v != null);
      if (einzel != null) himmelEinzel.push(wolkenWort(einzel) === wolkenWort(wahr) ? 1 : 0);
      if (alle.length >= 3) himmelMittel.push(wolkenWort(median(alle)) === wolkenWort(wahr) ? 1 : 0);
    }
  }

  if (!tempFehler.length && !himmelEinzel.length) return null;

  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    tag, lat, lon,
    station: mess ? mess.size : 0,
    temp:   { einzel: r2(mittelwert(tempFehler)), mittelweg: r2(mittelwert(tempFehlerMittel)),
              stunden: tempFehler.length },
    regen:  regenGesamt ? { quote: r2(regenRichtig / regenGesamt), stunden: regenGesamt,
                            verpasst: regenVerpasst, fehlalarm: regenFehlalarm } : null,
    himmel: himmelEinzel.length ? { einzel: r2(mittelwert(himmelEinzel)),
                                    mittelweg: r2(mittelwert(himmelMittel)),
                                    stunden: himmelEinzel.length } : null
  };
}

/** Der tägliche Lauf: gestern prüfen, Ergebnis ablegen. */
export async function taeglichePruefung(env) {
  const tag = iso(Date.now() - TAG);
  if (await env.WF_PUSH.get(`pruef:${tag}`)) return;      // schon gelaufen

  /* Geprüft wird dort, wo jemand die App benutzt — auf zwei Kilometer
     gerundet, damit derselbe Ort nicht mehrfach zählt. Höchstens zwei
     Orte: Der Lauf soll nicht mehr Arbeit machen als der Zweck hergibt. */
  const liste = await env.WF_PUSH.list({ prefix: 'abo:' });
  const orte = new Map();
  for (const k of liste.keys) {
    const e = await env.WF_PUSH.get(k.name, 'json');
    if (!e || typeof e.lat !== 'number') continue;
    orte.set(`${e.lat.toFixed(2)},${e.lon.toFixed(2)}`,
             { lat: e.lat, lon: e.lon, ort: e.ort || '' });
    if (orte.size >= 2) break;
  }
  if (!orte.size) orte.set('tübingen', { lat: 48.5216, lon: 9.0576, ort: 'Tübingen' });

  const ergebnisse = [];
  for (const o of orte.values()) {
    const r = await pruefeOrt(o.lat, o.lon, tag);
    if (r) ergebnisse.push({ ...r, ort: o.ort });
  }
  if (!ergebnisse.length) return;

  await env.WF_PUSH.put(`pruef:${tag}`, JSON.stringify({ tag, orte: ergebnisse, stand: Date.now() }),
                        { expirationTtl: HALTBAR });
}

/** Der gesammelte Verlauf für die Funkzentrale. */
export async function pruefVerlauf(env, tage = 30) {
  const liste = await env.WF_PUSH.list({ prefix: 'pruef:' });
  const namen = liste.keys.map(k => k.name).sort().slice(-tage);
  const eintraege = [];
  for (const n of namen) {
    const e = await env.WF_PUSH.get(n, 'json');
    if (e) eintraege.push(e);
  }

  /* Ein einzelner Tag schwankt stark — eine Woche Nebel verdirbt jede
     Kennzahl. Der Schnitt über alle vorliegenden Tage sagt mehr. */
  const alle = eintraege.flatMap(e => e.orte || []);
  const mit = (f) => alle.map(f).filter(v => v != null);
  const schnitt = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : null);

  return {
    tage: eintraege.length,
    verlauf: eintraege,
    schnitt: {
      tempEinzel:     schnitt(mit(o => o.temp?.einzel)),
      tempMittelweg:  schnitt(mit(o => o.temp?.mittelweg)),
      regenQuote:     schnitt(mit(o => o.regen?.quote)),
      regenVerpasst:  mit(o => o.regen?.verpasst).reduce((a, b) => a + b, 0),
      regenFehlalarm: mit(o => o.regen?.fehlalarm).reduce((a, b) => a + b, 0),
      himmelEinzel:   schnitt(mit(o => o.himmel?.einzel)),
      himmelMittelweg: schnitt(mit(o => o.himmel?.mittelweg))
    }
  };
}
