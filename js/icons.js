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

  /* ── Runde Familie — nach Florians WetterOnline-Screenshots ──
     Der erste Versuch („kräftig") scheiterte am Ton: graublaue Wolken.
     Das Zielbild hat WEISSE, bauschige Wolken aus runden Bäuchen, warmes
     Gelb für Sonne UND Mond, sattes Blau für Tropfen. Genau das hier. */
  const sonneR = (cx = 32, cy = 30, r = 11) => `
    <g>${Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4 + Math.PI / 8;
      const x1 = cx + Math.cos(a) * (r + 3), y1 = cy + Math.sin(a) * (r + 3);
      const x2 = cx + Math.cos(a) * (r + 8.5), y2 = cy + Math.sin(a) * (r + 8.5);
      return `<line class="kw-strahl" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }).join('')}<circle class="kw-sonne" cx="${cx}" cy="${cy}" r="${r}"/></g>`;

  const mondR = (cx = 32, cy = 30, r = 12) => `
    <path class="kw-mond" d="M${cx + r * 0.35} ${cy - r}
      a${r} ${r} 0 1 0 ${r * 0.72} ${r * 1.5}
      a${r * 0.82} ${r * 0.82} 0 1 1 ${-r * 0.72} ${-r * 1.5}z"/>`;

  /** Bauschige Wolke aus runden Bäuchen — nicht die flache Linienwolke. */
  const wolkeR = (cls = 'kw-wolke', dx = 0, dy = 0, sc = 1) => `
    <g class="${cls}" transform="translate(${dx} ${dy}) scale(${sc})" style="transform-origin:32px 36px">
      <circle cx="23" cy="34.5" r="9.5"/>
      <circle cx="34.5" cy="28.5" r="12"/>
      <circle cx="44.5" cy="35.5" r="8.5"/>
      <rect x="13.5" y="34" width="39.5" height="11.5" rx="5.75"/>
    </g>`;

  const tropfenR = (n = 3) => Array.from({ length: n }, (_, i) =>
    `<line class="kw-tropfen" x1="${23 + i * 9}" y1="49" x2="${20.5 + i * 9}" y2="57"/>`).join('');

  const flockenR = (n = 3) => Array.from({ length: n }, (_, i) => `
    <g class="kw-flocke" transform="translate(${23 + i * 9} 53)">
      <line x1="-3.2" y1="0" x2="3.2" y2="0"/>
      <line x1="-1.6" y1="-2.8" x2="1.6" y2="2.8"/>
      <line x1="1.6" y1="-2.8" x2="-1.6" y2="2.8"/>
    </g>`).join('');

  const blitzR = () => `<path class="kw-blitz" d="M34.5 44l-10 14h6.6l-3.2 12 11-15.8h-6.6l4.6-10.2z"/>`;

  const nebelR = () => `
    <line class="kw-nebel" x1="15" y1="36" x2="49" y2="36"/>
    <line class="kw-nebel" x1="18" y1="44" x2="46" y2="44"/>
    <line class="kw-nebel" x1="14" y1="52" x2="50" y2="52"/>`;

  const shapesR = {
    clear_day:    () => svg(sonneR(), 'rund i-clear-day'),
    clear_night:  () => svg(mondR(), 'rund i-clear-night'),
    few_day:      () => svg(sonneR(23, 23, 9) + wolkeR('kw-wolke', 4, 5, .9), 'rund i-few-day'),
    few_night:    () => svg(mondR(24, 23, 9.5) + wolkeR('kw-wolke', 4, 5, .9), 'rund i-few-night'),
    part_day:     () => svg(sonneR(20, 21, 8.5) + wolkeR('kw-wolke', 4, 4, .96), 'rund i-part-day'),
    part_night:   () => svg(mondR(21, 21, 9) + wolkeR('kw-wolke', 4, 4, .96), 'rund i-part-night'),
    overcast:     () => svg(wolkeR('kw-wolke-hinten', -6, -6, .82) + wolkeR('kw-wolke', 2, 1, 1), 'rund i-overcast'),
    fog:          () => svg(wolkeR('kw-wolke', 0, -7, .9) + nebelR(), 'rund i-fog'),
    drizzle:      () => svg(wolkeR('kw-wolke', 0, -4, .98) + tropfenR(2), 'rund i-drizzle'),
    rain:         () => svg(wolkeR('kw-wolke', 0, -4, .98) + tropfenR(3), 'rund i-rain'),
    showers:      () => svg(sonneR(19, 19, 7.5) + wolkeR('kw-wolke', 4, 0, .94) + tropfenR(3), 'rund i-showers'),
    freezing:     () => svg(wolkeR('kw-wolke', 0, -4, .98) + tropfenR(2) + flockenR(1), 'rund i-freezing'),
    snow:         () => svg(wolkeR('kw-wolke', 0, -4, .98) + flockenR(3), 'rund i-snow'),
    thunder:      () => svg(wolkeR('kw-gewitterwolke', 0, -6, 1) + blitzR(), 'rund i-thunder'),
    thunder_hail: () => svg(wolkeR('kw-gewitterwolke', 0, -6, 1) + blitzR() + flockenR(1), 'rund i-thunder-hail')
  };

  /** Gewählter Stil — roh aus dem Speicher, icons.js lädt vor app.js. */
  function stil() {
    try { return JSON.parse(localStorage.getItem('wf.symbole')) === 'rund' ? 'rund' : 'fein'; }
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
    const familie = stil() === 'rund' ? shapesR : shapes;
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
