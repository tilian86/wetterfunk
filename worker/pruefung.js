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
  /* Geholt wird nicht nur der Prüftag, sondern auch die 26 Tage davor:
     Daraus lernt die Prüfung dieselbe Ortskorrektur, die auch die App
     benutzt — sonst prüfte sie ein Verfahren, das niemand mehr sieht.
     `last_date` muss dabei der FOLGETAG sein; mit demselben Datum in
     beiden Feldern liefert Bright Sky genau eine Stunde. */
  const von = iso(Date.parse(tag) - 26 * TAG);
  const bis = iso(Date.parse(tag) + TAG);
  const d = await holJson(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}`
    + `&date=${von}&last_date=${bis}&tz=Europe/Berlin`, 30000);
  const alle = (d?.weather || []).filter(x => x.temperature != null);
  if (alle.filter(x => x.timestamp.startsWith(tag)).length < 12) return null;
  const karte = new Map();
  for (const x of alle) karte.set(x.timestamp.slice(0, 13), x);
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
    Math.ceil((Date.now() - Date.parse(tag)) / TAG) + 27));
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
  const tempMittelBei = (i) => {
    const w = MODELLE.map(x => feld('temperature_2m', x)[i]).filter(v => v != null)
      .sort((a, b) => a - b);
    if (w.length < 3) return null;
    return w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
  };

  /* Ortskorrektur wie in der App: je Tageszeit-Block der mittlere Fehler
     der 25 Tage VOR dem Prüftag — die Korrektur kennt nur Vergangenheit,
     sonst prüfte sie sich selbst. Für beide Grundlagen getrennt gelernt. */
  const block = (h) => Math.floor(h / 4);
  const lerne = (wertBei) => {
    const summen = Array.from({ length: 6 }, () => ({ s: 0, n: 0 }));
    for (let i = 0; i < H.time.length; i++) {
      const t = H.time[i];
      if (t.slice(0, 10) >= tag) continue;              // nur Vergangenheit
      const m = mess?.get(t.slice(0, 13));
      const v = wertBei(i);
      if (!m || v == null) continue;
      const b = block(+t.slice(11, 13));
      summen[b].s += v - m.temperature; summen[b].n++;
    }
    if (summen.reduce((a, x) => a + x.n, 0) < 60) return null;
    return summen.map(x => (x.n >= 8 ? x.s / x.n : 0));
  };
  const offsIcon = lerne((i) => feld('temperature_2m', 'icon_d2')[i]);
  const offsMittel = lerne(tempMittelBei);

  const tempFehler = [], tempFehlerMittel = [];
  const tempFehlerKorr = [], tempFehlerMittelKorr = [];
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
      const mittel = tempMittelBei(i);
      const b = block(+t.slice(11, 13));
      if (einzel != null) {
        tempFehler.push(Math.abs(einzel - m.temperature));
        if (offsIcon) tempFehlerKorr.push(Math.abs(einzel - offsIcon[b] - m.temperature));
      }
      if (mittel != null) {
        tempFehlerMittel.push(Math.abs(mittel - m.temperature));
        if (offsMittel) tempFehlerMittelKorr.push(Math.abs(mittel - offsMittel[b] - m.temperature));
      }

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
              einzelKorr: r2(mittelwert(tempFehlerKorr)),
              mittelwegKorr: r2(mittelwert(tempFehlerMittelKorr)),
              stunden: tempFehler.length },
    regen:  regenGesamt ? { quote: r2(regenRichtig / regenGesamt), stunden: regenGesamt,
                            verpasst: regenVerpasst, fehlalarm: regenFehlalarm } : null,
    himmel: himmelEinzel.length ? { einzel: r2(mittelwert(himmelEinzel)),
                                    mittelweg: r2(mittelwert(himmelMittel)),
                                    stunden: himmelEinzel.length } : null
  };
}

/* ── Meldungs-Bilanz ─────────────────────────────────────────
   Der Prüflauf oben misst das MODELL. Für den Nutzer zählt aber etwas
   anderes: Kam eine Meldung, als es regnete — und regnete es, als eine kam?
   Der 5. August (1,5 mm über Tübingen, keine Meldung) wäre oben unsichtbar
   geblieben. Der Wächter schreibt deshalb ein Tages-Journal (wach:<tag>):
   Radar-Beobachtungen am Ort (nur Übergänge nass/trocken), gesendete
   Regenmeldungen, unterdrückte Meldungen. Hieraus entsteht die Bilanz.

   Ehrlichkeit über die Grenzen: Beobachtet wird nur, wenn der Wächter aufs
   Radar schaut — bei angekündigtem Regen ohne fällige Meldung entstehen
   Lücken. Eine Phase ohne Gegenstimme wird nach einer Stunde geschlossen.
   Die Bilanz ist damit eine Untergrenze der Wahrheit, kein Ersatz für sie. */
export function meldungsBilanz(journal) {
  const je = new Map();
  for (const e of journal?.eintraege || []) {
    if (!je.has(e.o)) je.set(e.o, []);
    je.get(e.o).push(e);
  }
  const b = { phasen: 0, gemeldet: 0, verpasst: 0, leise: 0, ankuendigungen: 0,
              treffer: 0, fehlalarm: 0, unbewertet: 0,
              unterdrueckt: 0, unterdruecktFalsch: 0 };
  for (const evs of je.values()) {
    evs.sort((a, x) => a.t - x.t);
    const obs = evs.filter(e => e.art === 'obs');
    const meld = evs.filter(e => e.art === 'meldung');
    const still = evs.filter(e => e.art === 'unterdrueckt');

    // Regenphasen aus den Übergängen
    const phasen = [];
    let beginn = null;
    for (const x of obs) {
      if (x.nass && beginn == null) beginn = x.t;
      if (!x.nass && beginn != null) { phasen.push({ von: beginn, bis: x.t }); beginn = null; }
    }
    if (beginn != null) phasen.push({ von: beginn, bis: beginn + 36e5 });

    b.phasen += phasen.length;
    for (const ph of phasen) {
      // Ankündigung bis 150 Min vorher oder Meldung während der Phase
      const ok = meld.some(m => m.t >= ph.von - 150 * 60000 && m.t <= ph.bis);
      if (ok) { b.gemeldet++; continue; }
      /* Absichtliche Stille ist kein Versäumnis: Tropfen unter 0,6 mm/h
         werden bewusst nicht gemeldet. Seit die Beobachtungen die Menge
         tragen, lässt sich das unterscheiden — Phasen, deren stärkste
         gemessene Beobachtung Tropfen war, zählen als „leise", nicht als
         verpasst. Ohne Mengenangabe (ältere Einträge) bleibt es beim
         strengeren Urteil. */
      const mengen = obs.filter(x => x.nass && x.t >= ph.von && x.t <= ph.bis
                                     && typeof x.mm === 'number').map(x => x.mm);
      if (mengen.length && Math.max(...mengen) < 0.6) b.leise++;
      else b.verpasst++;
    }
    for (const m of meld.filter(x => x.typ === 'start')) {
      b.ankuendigungen++;
      const danach = obs.filter(x => x.t >= m.t && x.t <= m.t + 3 * 36e5);
      if (!danach.length) { b.unbewertet++; continue; }
      danach.some(x => x.nass) ? b.treffer++ : b.fehlalarm++;
    }
    for (const u of still) {
      b.unterdrueckt++;
      // Wurde es kurz nach der Unterdrückung doch nass, war sie falsch
      if (obs.some(x => x.nass && Math.abs(x.t - u.t) <= 45 * 60000)) b.unterdruecktFalsch++;
    }
  }
  return b;
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

  // Auch wenn die Station schweigt: Die Meldungs-Bilanz gibt es trotzdem
  const journal = await env.WF_PUSH.get(`wach:${tag}`, 'json');
  const meldungen = journal ? meldungsBilanz(journal) : null;
  if (!ergebnisse.length && !meldungen) return;

  await env.WF_PUSH.put(`pruef:${tag}`,
                        JSON.stringify({ tag, orte: ergebnisse, meldungen, stand: Date.now() }),
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
      tempEinzelKorr: schnitt(mit(o => o.temp?.einzelKorr)),
      tempAppVerfahren: schnitt(mit(o => o.temp?.mittelwegKorr)),
      regenQuote:     schnitt(mit(o => o.regen?.quote)),
      regenVerpasst:  mit(o => o.regen?.verpasst).reduce((a, b) => a + b, 0),
      regenFehlalarm: mit(o => o.regen?.fehlalarm).reduce((a, b) => a + b, 0),
      himmelEinzel:   schnitt(mit(o => o.himmel?.einzel)),
      himmelMittelweg: schnitt(mit(o => o.himmel?.mittelweg))
    },
    /* Summen statt Schnitt: „3 verpasste Phasen in 30 Tagen" ist die
       Aussage, nicht „0,1 pro Tag". */
    meldungen: (() => {
      const m = eintraege.map(e => e.meldungen).filter(Boolean);
      if (!m.length) return null;
      const summe = (f) => m.reduce((a, x) => a + (x[f] || 0), 0);
      return { tage: m.length, phasen: summe('phasen'), gemeldet: summe('gemeldet'),
               verpasst: summe('verpasst'), leise: summe('leise'),
               ankuendigungen: summe('ankuendigungen'),
               treffer: summe('treffer'), fehlalarm: summe('fehlalarm'),
               unbewertet: summe('unbewertet'), unterdrueckt: summe('unterdrueckt'),
               unterdruecktFalsch: summe('unterdruecktFalsch') };
    })()
  };
}
