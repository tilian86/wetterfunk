/* Wetterfunk — Wettersymbole
   Eigene SVGs, per CSS animiert. WMO-Codes → Symbol + Klartext. */

const WX = (() => {

  const svg = (inner, cls) =>
    `<svg class="wx ${cls}" viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;

  // ── Bausteine ──────────────────────────────────────────────
  const sun = (cx = 32, cy = 30, r = 11) => `
    <g class="wx-sun">
      <circle class="sun-core" cx="${cx}" cy="${cy}" r="${r}"/>
      <g class="sun-rays">${
        Array.from({ length: 8 }, (_, i) => {
          const a = (i * Math.PI) / 4;
          const x1 = cx + Math.cos(a) * (r + 4.5), y1 = cy + Math.sin(a) * (r + 4.5);
          const x2 = cx + Math.cos(a) * (r + 9),   y2 = cy + Math.sin(a) * (r + 9);
          return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
        }).join('')
      }</g>
    </g>`;

  const moon = (cx = 32, cy = 30, r = 12) => `
    <g class="wx-moon">
      <path class="moon-core" d="M${cx + r * 0.35} ${cy - r}
        a${r} ${r} 0 1 0 ${r * 0.72} ${r * 1.5}
        a${r * 0.82} ${r * 0.82} 0 1 1 ${-r * 0.72} ${-r * 1.5}z"/>
    </g>`;

  const cloud = (cls = 'cloud-main', dx = 0, dy = 0, s = 1) => `
    <g class="wx-cloud ${cls}" transform="translate(${dx} ${dy}) scale(${s})" style="transform-origin:32px 36px">
      <path class="cloud-body" d="M20.5 44.5h24a9.5 9.5 0 0 0 .9-18.96 13.5 13.5 0 0 0-25.6-3.1A9.7 9.7 0 0 0 20.5 44.5z"/>
    </g>`;

  const drops = (n = 3, heavy = false) => `
    <g class="wx-drops ${heavy ? 'heavy' : ''}">${
      Array.from({ length: n }, (_, i) =>
        `<line class="drop d${i}" x1="${23 + i * 8}" y1="48" x2="${21 + i * 8}" y2="56"/>`
      ).join('')
    }</g>`;

  const flakes = (n = 3) => `
    <g class="wx-flakes">${
      Array.from({ length: n }, (_, i) =>
        `<g class="flake f${i}" transform="translate(${23 + i * 8} 52)">
           <line x1="-3" y1="0" x2="3" y2="0"/>
           <line x1="-1.5" y1="-2.6" x2="1.5" y2="2.6"/>
           <line x1="1.5" y1="-2.6" x2="-1.5" y2="2.6"/>
         </g>`
      ).join('')
    }</g>`;

  const bolt = () => `<path class="wx-bolt" d="M33 45l-8 12h6l-2.5 10L38 54h-6.5L35 45z"/>`;

  const fogLines = () => `
    <g class="wx-fog">
      <line class="fg0" x1="14" y1="34" x2="50" y2="34"/>
      <line class="fg1" x1="17" y1="42" x2="47" y2="42"/>
      <line class="fg2" x1="13" y1="50" x2="51" y2="50"/>
    </g>`;

  /* ── Kräftige Familie: gefüllte Flächen statt Linien ────────
     Florians Wunsch nach dem Blick auf WetterOnline: „von der grafischen
     Gestaltung eingängiger". Gefüllte, kompakte Formen lesen sich bei
     kleiner Größe schneller als feine Striche. Beide Familien teilen sich
     Codes und Texte; nur die Zeichnung wechselt. Gestaltet wird über
     eigene kf-Klassen — die globale Regel `svg { stroke: currentColor }`
     schlägt Inline-Attribute, deshalb führt an Klassen kein Weg vorbei. */
  const sunF = (cx = 32, cy = 30, r = 11.5) => `
    <g>${Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4 + Math.PI / 8;
      const x1 = cx + Math.cos(a) * (r + 3.5), y1 = cy + Math.sin(a) * (r + 3.5);
      const x2 = cx + Math.cos(a) * (r + 9),   y2 = cy + Math.sin(a) * (r + 9);
      return `<line class="kf-strahl" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }).join('')}<circle class="kf-sonne" cx="${cx}" cy="${cy}" r="${r}"/></g>`;

  const moonF = (cx = 32, cy = 30, r = 12) => `
    <path class="kf-mond" d="M${cx + r * 0.35} ${cy - r}
      a${r} ${r} 0 1 0 ${r * 0.72} ${r * 1.5}
      a${r * 0.82} ${r * 0.82} 0 1 1 ${-r * 0.72} ${-r * 1.5}z"/>`;

  const cloudF = (cls = 'kf-wolke', dx = 0, dy = 0, sc = 1) => `
    <g transform="translate(${dx} ${dy}) scale(${sc})" style="transform-origin:32px 36px">
      <path class="${cls}" d="M20.5 44.5h24a9.5 9.5 0 0 0 .9-18.96 13.5 13.5 0 0 0-25.6-3.1A9.7 9.7 0 0 0 20.5 44.5z"/>
    </g>`;

  const dropsF = (n = 3) => Array.from({ length: n }, (_, i) =>
    `<line class="kf-tropfen" x1="${23 + i * 9}" y1="48" x2="${20.5 + i * 9}" y2="56.5"/>`).join('');

  const flakesF = (n = 3) => Array.from({ length: n }, (_, i) => `
    <g class="kf-flocke" transform="translate(${23 + i * 9} 52)">
      <line x1="-3.4" y1="0" x2="3.4" y2="0"/>
      <line x1="-1.7" y1="-3" x2="1.7" y2="3"/>
      <line x1="1.7" y1="-3" x2="-1.7" y2="3"/>
    </g>`).join('');

  const boltF = () => `<path class="kf-blitz" d="M34.5 43l-10.5 14.5h7l-3.5 12.5 11.5-16.5h-7l5-10.5z"/>`;

  const fogF = () => `
    <line class="kf-nebel" x1="15" y1="35" x2="49" y2="35"/>
    <line class="kf-nebel" x1="18" y1="43" x2="46" y2="43"/>
    <line class="kf-nebel" x1="14" y1="51" x2="50" y2="51"/>`;

  const shapesK = {
    clear_day:    () => svg(sunF(), 'kraeftig i-clear-day'),
    clear_night:  () => svg(moonF(), 'kraeftig i-clear-night'),
    few_day:      () => svg(sunF(24, 24, 9.5) + cloudF('kf-wolke', 3, 6, .92), 'kraeftig i-few-day'),
    few_night:    () => svg(moonF(25, 24, 9.5) + cloudF('kf-wolke', 3, 6, .92), 'kraeftig i-few-night'),
    part_day:     () => svg(sunF(21, 22, 9) + cloudF('kf-wolke', 4, 5, .98), 'kraeftig i-part-day'),
    part_night:   () => svg(moonF(22, 22, 9) + cloudF('kf-wolke', 4, 5, .98), 'kraeftig i-part-night'),
    overcast:     () => svg(cloudF('kf-wolke-hinten', -5, -4, .8) + cloudF('kf-wolke', 2, 2, 1), 'kraeftig i-overcast'),
    fog:          () => svg(cloudF('kf-wolke', 0, -6, .92) + fogF(), 'kraeftig i-fog'),
    drizzle:      () => svg(cloudF('kf-regenwolke', 0, -3, 1) + dropsF(2), 'kraeftig i-drizzle'),
    rain:         () => svg(cloudF('kf-regenwolke', 0, -3, 1) + dropsF(3), 'kraeftig i-rain'),
    showers:      () => svg(sunF(20, 20, 8) + cloudF('kf-regenwolke', 4, 1, .95) + dropsF(3), 'kraeftig i-showers'),
    freezing:     () => svg(cloudF('kf-regenwolke', 0, -3, 1) + dropsF(2) + flakesF(1), 'kraeftig i-freezing'),
    snow:         () => svg(cloudF('kf-wolke', 0, -3, 1) + flakesF(3), 'kraeftig i-snow'),
    thunder:      () => svg(cloudF('kf-gewitterwolke', 0, -5, 1) + boltF(), 'kraeftig i-thunder'),
    thunder_hail: () => svg(cloudF('kf-gewitterwolke', 0, -5, 1) + boltF() + flakesF(1), 'kraeftig i-thunder-hail')
  };

  /** Gewählter Stil — roh aus dem Speicher, weil icons.js vor app.js lädt
      und dessen store-Helfer nicht kennt. */
  function stil() {
    try { return JSON.parse(localStorage.getItem('wf.symbole')) === 'kraeftig' ? 'kraeftig' : 'fein'; }
    catch { return 'fein'; }
  }

  // ── Symbol-Zusammenbau ─────────────────────────────────────
  const shapes = {
    clear_day:    () => svg(sun(), 'i-clear-day'),
    clear_night:  () => svg(moon(), 'i-clear-night'),
    few_day:      () => svg(sun(25, 25, 9) + cloud('cloud-main', 3, 6, .92), 'i-few-day'),
    few_night:    () => svg(moon(25, 24, 9.5) + cloud('cloud-main', 3, 6, .92), 'i-few-night'),
    part_day:     () => svg(sun(22, 23, 8.5) + cloud('cloud-main', 4, 5, .98), 'i-part-day'),
    part_night:   () => svg(moon(22, 22, 9) + cloud('cloud-main', 4, 5, .98), 'i-part-night'),
    overcast:     () => svg(cloud('cloud-back', -5, -4, .8) + cloud('cloud-main', 2, 2, 1), 'i-overcast'),
    fog:          () => svg(cloud('cloud-main', 0, -6, .92) + fogLines(), 'i-fog'),
    drizzle:      () => svg(cloud('cloud-main', 0, -3, 1) + drops(3), 'i-drizzle'),
    rain:         () => svg(cloud('cloud-main', 0, -3, 1) + drops(3, true), 'i-rain'),
    showers:      () => svg(sun(21, 21, 7.5) + cloud('cloud-main', 4, 1, .95) + drops(3, true), 'i-showers'),
    freezing:     () => svg(cloud('cloud-main', 0, -3, 1) + drops(2, true) + flakes(1), 'i-freezing'),
    snow:         () => svg(cloud('cloud-main', 0, -3, 1) + flakes(3), 'i-snow'),
    thunder:      () => svg(cloud('cloud-main', 0, -5, 1) + bolt(), 'i-thunder'),
    thunder_hail: () => svg(cloud('cloud-main', 0, -5, 1) + bolt() + flakes(2), 'i-thunder-hail')
  };

  // ── WMO-Code → Symbol + Text ───────────────────────────────
  const CODES = {
    0:  { d: 'Klar',                    n: 'Klar',                  s: 'clear' },
    1:  { d: 'Überwiegend klar',        n: 'Überwiegend klar',      s: 'few' },
    2:  { d: 'Teilweise bewölkt',       n: 'Teilweise bewölkt',     s: 'part' },
    3:  { d: 'Bedeckt',                 n: 'Bedeckt',               s: 'overcast' },
    45: { d: 'Nebel',                   n: 'Nebel',                 s: 'fog' },
    48: { d: 'Gefrierender Nebel',      n: 'Gefrierender Nebel',    s: 'fog' },
    51: { d: 'Leichter Niesel',         n: 'Leichter Niesel',       s: 'drizzle' },
    53: { d: 'Niesel',                  n: 'Niesel',                s: 'drizzle' },
    55: { d: 'Starker Niesel',          n: 'Starker Niesel',        s: 'drizzle' },
    56: { d: 'Gefrierender Niesel',     n: 'Gefrierender Niesel',   s: 'freezing' },
    57: { d: 'Gefrierender Niesel',     n: 'Gefrierender Niesel',   s: 'freezing' },
    61: { d: 'Leichter Regen',          n: 'Leichter Regen',        s: 'rain' },
    63: { d: 'Regen',                   n: 'Regen',                 s: 'rain' },
    65: { d: 'Starker Regen',           n: 'Starker Regen',         s: 'rain' },
    66: { d: 'Gefrierender Regen',      n: 'Gefrierender Regen',    s: 'freezing' },
    67: { d: 'Gefrierender Regen',      n: 'Gefrierender Regen',    s: 'freezing' },
    71: { d: 'Leichter Schneefall',     n: 'Leichter Schneefall',   s: 'snow' },
    73: { d: 'Schneefall',              n: 'Schneefall',            s: 'snow' },
    75: { d: 'Starker Schneefall',      n: 'Starker Schneefall',    s: 'snow' },
    77: { d: 'Schneegriesel',           n: 'Schneegriesel',         s: 'snow' },
    80: { d: 'Leichte Schauer',         n: 'Leichte Schauer',       s: 'showers' },
    81: { d: 'Regenschauer',            n: 'Regenschauer',          s: 'showers' },
    82: { d: 'Kräftige Schauer',        n: 'Kräftige Schauer',      s: 'showers' },
    85: { d: 'Schneeschauer',           n: 'Schneeschauer',         s: 'snow' },
    86: { d: 'Kräftige Schneeschauer',  n: 'Kräftige Schneeschauer',s: 'snow' },
    95: { d: 'Gewitter',                n: 'Gewitter',              s: 'thunder' },
    96: { d: 'Gewitter mit Hagel',      n: 'Gewitter mit Hagel',    s: 'thunder_hail' },
    99: { d: 'Schweres Gewitter',       n: 'Schweres Gewitter',     s: 'thunder_hail' }
  };

  const info = (code) => CODES[code] || CODES[3];

  /** SVG-Markup für einen WMO-Code. isDay: 1/0 */
  function icon(code, isDay = 1) {
    const base = info(code).s;
    const key = ['clear', 'few', 'part', 'showers'].includes(base)
      ? (base === 'showers' ? 'showers' : base + (isDay ? '_day' : '_night'))
      : base;
    const familie = stil() === 'kraeftig' ? shapesK : shapes;
    return (familie[key] || familie.overcast)();
  }

  /** Kurztext für einen WMO-Code. */
  const text = (code, isDay = 1) => (isDay ? info(code).d : info(code).n);

  /** Grobe Wetterlage für die Hintergrundfärbung. */
  function mood(code, isDay) {
    const s = info(code).s;
    if (['thunder', 'thunder_hail'].includes(s)) return 'storm';
    if (['rain', 'drizzle', 'showers', 'freezing'].includes(s)) return 'rain';
    if (s === 'snow') return 'snow';
    if (s === 'fog') return 'fog';
    if (s === 'overcast') return 'cloudy';
    if (['part', 'few'].includes(s)) return isDay ? 'partly' : 'night';
    return isDay ? 'clear' : 'night';
  }

  /** Niederschlagsart für die Klartext-Zeile. */
  function precipWord(code) {
    const s = info(code).s;
    if (s === 'snow') return 'Schnee';
    if (['thunder', 'thunder_hail'].includes(s)) return 'Gewitter';
    if (s === 'drizzle') return 'Niesel';
    return 'Regen';
  }

  return { icon, text, mood, precipWord, info, stil };
})();
