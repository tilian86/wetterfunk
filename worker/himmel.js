/* Sonne und Mond für den Zeitplan des Workers.

   Dieselben Formeln wie in der App (js/app.js), hier noch einmal, weil der
   Worker kein Fenster und keinen Zugriff auf den Seitencode hat. Gerechnet
   wird immer in UTC — Zeitzonen kommen erst beim Formulieren der Meldung
   ins Spiel, und dafür liefert Open-Meteo den Versatz gleich mit.

   Genauigkeit: Sonne unter einer Bogenminute, Mond unter einem Zehntelgrad.
   Für „in 15 Minuten geht die Sonne auf" ist das um Größenordnungen mehr,
   als gebraucht wird. */

const RAD = Math.PI / 180;
const tage = (d) => (d - Date.UTC(2000, 0, 1, 12)) / 86400000;

/** Höhe der Sonne über dem Horizont, in Grad. */
export function sonnenHoehe(date, lat, lon) {
  const d = tage(date);
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = (280.459 + 0.98564736 * d) * RAD;
  const L = q + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) % 360) * RAD - ra;
  const la = lat * RAD;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)) / RAD;
}

/** Höhe des Mondes über dem Horizont, in Grad. */
export function mondHoehe(date, lat, lon) {
  const d = tage(date);
  const L = 218.316 + 13.176396 * d;
  const M = (134.963 + 13.064993 * d) * RAD;
  const Ms = (357.529 + 0.98560028 * d) * RAD;
  const D = (297.850 + 12.190749 * d) * RAD;
  const F = (93.272 + 13.229350 * d) * RAD;
  const lam = (L + 6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M)
    + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms)
    - 0.059 * Math.sin(2 * M - 2 * D) - 0.057 * Math.sin(M - 2 * D + Ms)
    + 0.053 * Math.sin(M + 2 * D) + 0.046 * Math.sin(2 * D - Ms)
    + 0.041 * Math.sin(M - Ms) - 0.035 * Math.sin(D)
    - 0.031 * Math.sin(M + Ms)) * RAD;
  const bet = (5.128 * Math.sin(F) + 0.281 * Math.sin(M + F)
    - 0.278 * Math.sin(F - M) - 0.173 * Math.sin(F - 2 * D)) * RAD;
  const e = 23.4397 * RAD;
  const dec = Math.asin(Math.sin(bet) * Math.cos(e) + Math.cos(bet) * Math.sin(e) * Math.sin(lam));
  const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(bet) * Math.sin(e), Math.cos(lam));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) % 360) * RAD - ra;
  const la = lat * RAD;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)) / RAD;
}

/** Beleuchteter Anteil der Mondscheibe, 0 bis 1, und der Name der Phase. */
export function mondPhase(date) {
  const d = tage(date);
  const M = (134.963 + 13.064993 * d) * RAD;
  const Ms = (357.529 + 0.98560028 * d) * RAD;
  const D = (297.850 + 12.190749 * d) * RAD;
  // Phasenwinkel nach der abgekürzten Reihe aus Meeus, Kapitel 48
  const i = (180 - D / RAD - 6.289 * Math.sin(M) + 2.100 * Math.sin(Ms)
    - 1.274 * Math.sin(2 * D - M) - 0.658 * Math.sin(2 * D)
    - 0.214 * Math.sin(2 * M) - 0.110 * Math.sin(D)) * RAD;
  const beleuchtet = (1 + Math.cos(i)) / 2;
  // Zunehmend oder abnehmend entscheidet die Elongation
  const elong = ((D / RAD % 360) + 360) % 360;
  const namen = ['Neumond', 'zunehmende Sichel', 'erstes Viertel', 'zunehmender Mond',
                 'Vollmond', 'abnehmender Mond', 'letztes Viertel', 'abnehmende Sichel'];
  return { beleuchtet, name: namen[Math.floor(elong / 45 + 0.5) % 8] };
}

/* Nullstellensuche: Zwischen zwei Minutenschritten liegt der genaue Zeitpunkt.
   Zehn Halbierungen bringen ihn auf unter eine Zehntelsekunde — mehr als
   genug, aber es kostet praktisch nichts. */
function genau(von, bis, f, ziel) {
  let a = von, b = bis;
  for (let k = 0; k < 10; k++) {
    const m = new Date((a.getTime() + b.getTime()) / 2);
    if ((f(a) - ziel) * (f(m) - ziel) <= 0) b = m; else a = m;
  }
  return new Date((a.getTime() + b.getTime()) / 2);
}

/** Aufgang, Höchststand und Untergang der Sonne im Fenster ab `von`.
    Gesucht wird in Zwei-Minuten-Schritten über `stunden` Stunden. */
export function sonnenTermine(von, lat, lon, stunden = 26) {
  const f = (t) => sonnenHoehe(t, lat, lon);
  const termine = [];
  let vorher = f(von), letzteHoehe = vorher, steigend = null;
  for (let m = 2; m <= stunden * 60; m += 2) {
    const t = new Date(von.getTime() + m * 60000);
    const jetzt = f(t);
    const vorherT = new Date(t.getTime() - 2 * 60000);

    // Aufgang und Untergang: Durchgang durch -0,833° (Refraktion am Horizont)
    if (vorher < -0.833 && jetzt >= -0.833) {
      termine.push({ art: 'aufgang', t: genau(vorherT, t, f, -0.833) });
    }
    if (vorher > -0.833 && jetzt <= -0.833) {
      termine.push({ art: 'untergang', t: genau(vorherT, t, f, -0.833) });
    }
    // Beginn der goldenen Stunde am Abend: Durchgang durch +6° nach unten
    if (vorher > 6 && jetzt <= 6) {
      termine.push({ art: 'gold', t: genau(vorherT, t, f, 6) });
    }
    // Höchststand: dort kippt die Höhe von steigend auf fallend
    const nunSteigend = jetzt > letzteHoehe;
    if (steigend === true && !nunSteigend && jetzt > 0) {
      termine.push({ art: 'hoechststand', t: vorherT, hoehe: vorher });
    }
    steigend = nunSteigend;
    letzteHoehe = vorher;
    vorher = jetzt;
  }
  return termine;
}

/** Aufgang des Mondes im Fenster ab `von`. */
export function mondTermine(von, lat, lon, stunden = 26) {
  const f = (t) => mondHoehe(t, lat, lon);
  const termine = [];
  let vorher = f(von);
  for (let m = 2; m <= stunden * 60; m += 2) {
    const t = new Date(von.getTime() + m * 60000);
    const jetzt = f(t);
    if (vorher < -0.5 && jetzt >= -0.5) {
      termine.push({ art: 'mondaufgang', t: genau(new Date(t.getTime() - 2 * 60000), t, f, -0.5) });
    }
    vorher = jetzt;
  }
  return termine;
}
