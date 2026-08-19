/* Wetterfunk — Flächenvorhersage
   Das Radar reicht nur 30 Minuten voraus. Für die Zeit danach holen wir ein
   Punktraster von Open-Meteo (9×9 über die Region, 120 Stunden) und zeichnen
   daraus selbst eine Karte: Regen als Farbfläche, Bewölkung als Schleier.
   Grober als echtes Radar — dafür über fünf Tage. */

const Forecast = (() => {
'use strict';

const API = 'https://api.open-meteo.com/v1/forecast';
// Immer 13×13 Punkte, aber die abgedeckte Fläche richtet sich nach dem Zoom:
// nah am Ort eng und fein (~20 km), auf der Kugel weit und grob — sonst wäre
// das Raster dort nur ein Fleck von wenigen Pixeln.
/* 20×20 = 400 Punkte. Mehr geht nicht: Ab etwa 625 Koordinaten lehnt
   Open-Meteo die Anfrage mit "URI Too Long" ab. Mit 13×13 war das Raster so
   grob, dass ganze Landstriche eine einzige Farbe hatten. */
const N = 20;
const STUFEN = [
  { abZoom: 6.5, lat: 1.4,  lon: 1.9,  name: 'sehrfein' }, // ~8 km Punktabstand
  { abZoom: 5.0, lat: 3.0,  lon: 4.2,  name: 'fein'  },    // ~17 km
  { abZoom: 3.5, lat: 8.0,  lon: 11.0, name: 'mittel' },   // ~45 km
  { abZoom: 0,   lat: 28.0, lon: 38.0, name: 'weit'   }    // ~160 km
];
const stufeFuer = (zoom) => STUFEN.find(s => zoom >= s.abZoom) || STUFEN[STUFEN.length - 1];
const CELL = 256;            // Zeichenfläche; wird von der Karte weichgezeichnet

let grid = null;             // { lat0, lon0, dLat, dLon, times, precip, cloud }
let canvas = null, ctx = null;

/* Welches Messfeld gehört zu welcher Kartenebene. Regen und Temperatur
   werden immer geholt: Sie stecken auch in den Zahlen auf der Karte. */
const FELDER = {
  regen:      'precipitation',
  wolken:     'cloud_cover',
  temperatur: 'temperature_2m',
  boeen:      'wind_gusts_10m',
  gewitter:   'cape',
  wind:       'wind_speed_10m'
};
/* Windpfeile brauchen zwei Felder: Stärke UND Richtung. Die Richtung hängt
   nicht in FELDER, weil sie allein keine Ebene ist. */
const WIND_RICHTUNG = 'wind_direction_10m';
const PFLICHT = ['precipitation', 'temperature_2m'];

/** Raster um den Ort herum laden. `zoom` bestimmt, wie weit es reicht,
    `ebenen` welche Messwerte gebraucht werden — 400 Punkte über fünf Tage
    mit allen Feldern wären zwei Megabyte, das dauert im Mobilfunk zu lang. */
async function load(lat, lon, zoom = 7, ebenen = null, sicht = null) {
  const stufe = stufeFuer(zoom);
  /* Das Raster muss den sichtbaren Ausschnitt abdecken, nicht eine feste
     Spanne um die Mitte — sonst endet die Vorhersage mitten im Bild an einer
     harten Kante. Etwas Rand, damit kleine Verschiebungen nicht sofort
     nachladen. */
  /* 1,6 statt 1,3 — und weiter unten die Mitte auf Spanne/8 statt /4 gerastet.
     Beides gehört zusammen: Mit 1,3 blieb je Seite ein Rand von 0,15
     Bildhöhen, das Rasten der Mitte verschob den Kasten aber um bis zu
     0,163 Bildhöhen. Der Versatz war also GRÖSSER als der Rand — bei rund
     5 % aller Kartenpositionen konnte das frisch geladene Raster den
     Ausschnitt gar nicht abdecken. covers() sagte „passt nicht", die App
     lud nach, bekam dasselbe Raster, und das endlos. Genau das war
     Florians „lädt immer nach": eine Schleife, die nie fertig wird.
     Nebenwirkung war, dass die Vorhersage-Ebene dabei dauernd neu
     eingeblendet wurde und das DWD-Radarbild verdeckte. */
  let SPAN_LAT = stufe.lat, SPAN_LON = stufe.lon;
  if (sicht) {
    SPAN_LAT = Math.min(80, Math.max(SPAN_LAT, (sicht.north - sicht.south) * 1.6));
    SPAN_LON = Math.min(150, Math.max(SPAN_LON, (sicht.east - sicht.west) * 1.6));
  }

  /* Auf ein festes Gitter rasten. 400 Punkte über fünf Tage sind ein teurer
     Abruf; ohne Rasten erzeugt jede kleine Kartenbewegung eine neue Adresse,
     der Zwischenspeicher greift nie und das Kontingent von Open-Meteo ist
     nach ein paar Minuten Herumschieben erschöpft. Gerastet landen benachbarte
     Ansichten auf derselben Anfrage — und damit im Cache. */
  const stufeAuf = (v, schritt) => Math.ceil(v / schritt) * schritt;
  SPAN_LAT = stufeAuf(SPAN_LAT, stufe.lat / 2);
  SPAN_LON = stufeAuf(SPAN_LON, stufe.lon / 2);
  /* Wieder /4 statt /8. Das Verfeinern auf /8 sollte die Abdeckung retten,
     hat aber die Zahl verschiedener Kästen vervierfacht — und damit die
     Treffer im Zwischenspeicher geviertelt, also VIERMAL so viele
     2,6-MB-Abrufe. Die Abdeckung trägt auch mit /4: nötig ist Spanne >=
     1,333 x Bildhöhe, wir laden 1,6 x. */
  const gitterLat = SPAN_LAT / 4, gitterLon = SPAN_LON / 4;
  const mitteLat = Math.round(lat / gitterLat) * gitterLat;
  const mitteLon = Math.round(lon / gitterLon) * gitterLon;

  const lat0 = mitteLat - SPAN_LAT / 2, lon0 = mitteLon - SPAN_LON / 2;
  const dLat = SPAN_LAT / (N - 1), dLon = SPAN_LON / (N - 1);

  const lats = [], lons = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      lats.push((lat0 + i * dLat).toFixed(3));
      lons.push((lon0 + j * dLon).toFixed(3));
    }
  }

  const gewuenscht = ebenen
    ? [...new Set([...PFLICHT, ...[...ebenen].map(e => FELDER[e]).filter(Boolean),
                   ...(ebenen.has('wind') ? [WIND_RICHTUNG] : [])])]
    : [...Object.values(FELDER), WIND_RICHTUNG];
  // Reihenfolge festhalten, sonst wechselt der Cache-Schlüssel bei gleicher Auswahl
  const felder = [...Object.values(FELDER), WIND_RICHTUNG].filter(f => gewuenscht.includes(f));

  const p = new URLSearchParams({
    latitude: lats.join(','), longitude: lons.join(','),
    hourly: felder.join(','),
    forecast_days: '5', timezone: 'auto'
  });

  // 400 Punkte auf einmal — die teuerste Anfrage der App. Eine Viertelstunde
  // vorhalten, sonst läuft man beim Herumschieben ins Abruflimit.
  const url = `${API}?${p}`;
  const key = `wf.fc:${url}`;
  let data = ausSpeicher(key);
  if (!data) {
    try {
      const alt = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (alt && Date.now() - alt.t < 15 * 60000) { data = alt.d; inSpeicher(key, data); }
    } catch {}
  }

  if (!data) {
    laufenderAbruf?.abort();
    const abbruch = new AbortController();
    laufenderAbruf = abbruch;
    let res = await fetch(url, { signal: abbruch.signal });
    // Steckt der eigene Anschluss im Abruflimit, über den Worker gehen
    if (res.status === 429) {
      const proxy = (localStorage.getItem('wf.proxy') || '').replace(/^"|"$/g, '')
        || 'https://wetterfunk.florian-s-thiel.workers.dev';
      res = await fetch(`${proxy.replace(/\/+$/, '')}/wetter?url=${encodeURIComponent(url)}`,
        { signal: abbruch.signal });
    }
    if (!res.ok) throw new Error(`Raster ${res.status}`);
    data = await res.json();
    if (laufenderAbruf === abbruch) laufenderAbruf = null;
    inSpeicher(key, data);
    beiRuhe(() => {
      try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data })); } catch {}
    });
  }
  if (!Array.isArray(data) || !data.length) throw new Error('Kein Raster erhalten');

  // Nicht angeforderte Felder fehlen in der Antwort — dann leere Reihen,
  // damit sample() nicht über undefined stolpert.
  const leer = () => data.map(() => []);
  const holen = (feld) => (data[0].hourly[feld] ? data.map(d => d.hourly[feld]) : leer());

  grid = {
    lat0, lon0, dLat, dLon,
    spanLat: SPAN_LAT, spanLon: SPAN_LON, stufe: stufe.name,
    mitte: [mitteLat, mitteLon], felder,
    times: data[0].hourly.time,
    precip: holen('precipitation'),
    cloud:  holen('cloud_cover'),
    temp:   holen('temperature_2m'),
    gusts:  holen('wind_gusts_10m'),
    cape:   holen('cape'),
    windS:  holen('wind_speed_10m'),
    windD:  holen(WIND_RICHTUNG)
  };

  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = CELL;
    // MapLibre liest Canvas-Quellen zuverlässig nur, wenn das Element im
    // Dokument hängt — unsichtbar, aber vorhanden.
    canvas.style.cssText = 'position:absolute;left:-9999px;top:0;pointer-events:none';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return grid;
}

/** Eckpunkte der abgedeckten Fläche, im Uhrzeigersinn ab oben links. */
function corners() {
  if (!grid) return null;
  const { lat0, lon0, spanLat, spanLon } = grid;
  const lat1 = lat0 + spanLat, lon1 = lon0 + spanLon;
  return [[lon0, lat1], [lon1, lat1], [lon1, lat0], [lon0, lat0]];
}

const ready = () => !!grid;

/* Beim Zoomen feuert jede Stufe einen neuen Rasterabruf. Ohne Abbruch
   liefen mehrere 2,6-MB-Downloads gleichzeitig — sie nahmen den
   Kartenkacheln die Leitung weg, weshalb die Grundkarte weiß blieb.
   Jetzt bricht ein neuer Abruf den vorherigen ab. */
let laufenderAbruf = null;

/* Zwischenspeicher im Arbeitsspeicher, VOR dem sessionStorage.
   Der sessionStorage kostet bei jedem Zugriff das Zerlegen bzw.
   Zusammensetzen von rund 2,6 MB JSON — synchron auf dem Hauptthread, also
   genau dort, wo die Karte gezeichnet wird. Auf dem Handy sind das
   Hunderte Millisekunden Stillstand pro Rasterwechsel. Im Arbeitsspeicher
   liegt das fertige Objekt einfach da: kein Zerlegen, kein Warten.
   Vier Einträge reichen für Hin- und Herzoomen und bleiben bezahlbar. */
const speicher = new Map();
const SPEICHER_MAX = 4;

function ausSpeicher(key) {
  const e = speicher.get(key);
  if (!e) return null;
  if (Date.now() - e.t > 15 * 60000) { speicher.delete(key); return null; }
  speicher.delete(key); speicher.set(key, e);      // zuletzt benutzt nach hinten
  return e.d;
}

function inSpeicher(key, d) {
  speicher.set(key, { t: Date.now(), d });
  while (speicher.size > SPEICHER_MAX) speicher.delete(speicher.keys().next().value);
}

/** Das Schreiben in den sessionStorage in eine ruhige Minute schieben —
    es hält nur über einen Neustart der Seite, ist also nie dringend. */
const beiRuhe = (fn) => (window.requestIdleCallback || ((f) => setTimeout(f, 500)))(fn);
const hours = () => (grid ? grid.times.length : 0);

/** Wert an Rasterposition (Zeile i, Spalte j) für die Stunde h. */
const at = (arr, i, j, h) => arr[i * N + j]?.[h] ?? 0;

/** Bilinear zwischen den vier umliegenden Rasterpunkten mitteln. */
function sample(arr, h, fy, fx) {
  const y = fy * (N - 1), x = fx * (N - 1);
  const i0 = Math.min(N - 2, Math.floor(y)), j0 = Math.min(N - 2, Math.floor(x));
  const ty = y - i0, tx = x - j0;
  const a = at(arr, i0, j0, h),     b = at(arr, i0, j0 + 1, h);
  const c = at(arr, i0 + 1, j0, h), d = at(arr, i0 + 1, j0 + 1, h);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/* Farbskala für Niederschlag in mm/h — an Radarbilder angelehnt, aber
   deutlich kräftiger als zuvor. Die alten Werte waren so blass, dass auf der
   Karte kaum zu erkennen war, wo und wie stark es regnet. */
function rainColor(mm) {
  if (mm < 0.05) return null;
  if (mm < 0.2)  return [ 90, 200, 250, 150];   // Nieseln
  if (mm < 0.5)  return [ 45, 165, 245, 190];
  if (mm < 1.0)  return [ 40, 215, 190, 215];
  if (mm < 2.0)  return [ 90, 230,  90, 230];
  if (mm < 4.0)  return [250, 220,  40, 240];
  if (mm < 7.0)  return [255, 150,  40, 248];
  if (mm < 12)   return [245,  70,  55, 252];
  if (mm < 20)   return [215,  40, 130, 255];
  return              [180,  60, 230, 255];     // extremer Starkregen
}

/** Temperatur als Farbe: blau kalt, rot heiß. */
function tempColor(t) {
  const stufen = [
    [-15, [ 90, 110, 210]], [-5, [ 70, 160, 230]], [ 3, [ 90, 205, 215]],
    [ 10, [ 95, 200, 140]], [ 18, [220, 210,  90]], [ 25, [240, 160,  70]],
    [ 32, [235,  95,  70]], [ 40, [200,  60, 140]]
  ];
  let a = stufen[0], b = stufen[stufen.length - 1];
  for (let i = 0; i < stufen.length - 1; i++) {
    if (t >= stufen[i][0] && t <= stufen[i + 1][0]) { a = stufen[i]; b = stufen[i + 1]; break; }
  }
  const f = Math.max(0, Math.min(1, (t - a[0]) / Math.max(0.001, b[0] - a[0])));
  return [0, 1, 2].map(k => Math.round(a[1][k] + (b[1][k] - a[1][k]) * f));
}

/** Ein Bild für die gewählte Stunde zeichnen. Zeile 0 liegt im Norden.
    `ebenen` ist eine Menge aus 'regen', 'wolken', 'temperatur', 'boeen', 'gewitter'. */
function frame(h, ebenen = new Set(['regen', 'wolken'])) {
  if (!grid || h < 0 || h >= grid.times.length) return null;

  const img = ctx.createImageData(CELL, CELL);
  const px = img.data;

  for (let y = 0; y < CELL; y++) {
    const fy = 1 - y / (CELL - 1);           // Bildoberkante = größte Breite
    for (let x = 0; x < CELL; x++) {
      const fx = x / (CELL - 1);
      const o = (y * CELL + x) * 4;
      let r = 0, g = 0, b = 0, a = 0;

      const mischen = (c, alpha) => {
        const n = alpha + a * (1 - alpha);
        if (n <= 0) return;
        r = (c[0] * alpha + r * a * (1 - alpha)) / n;
        g = (c[1] * alpha + g * a * (1 - alpha)) / n;
        b = (c[2] * alpha + b * a * (1 - alpha)) / n;
        a = n;
      };

      // Von hinten nach vorn: Temperatur, Wolken, Böen, Gewitter, Regen
      if (ebenen.has('temperatur')) {
        mischen(tempColor(sample(grid.temp, h, fy, fx)), 0.55);
      }
      if (ebenen.has('wolken')) {
        /* Auf der hellen Karte muss die Wolkendecke abdunkeln, nicht
           aufhellen — dichter Himmel ist dunkler Himmel. Ein weißer Schleier
           auf fast weißem Grund wäre unsichtbar. */
        const cc = sample(grid.cloud, h, fy, fx);
        if (cc > 12) {
          const t = Math.min(1, (cc - 12) / 78);          // 12 % … 90 %
          const grau = 214 - t * 92;                       // dünn hell, dicht grau
          // Gedeckelt: Bei durchgehender Bewölkung war die Karte darunter
          // nicht mehr zu erkennen, damit fehlte jede Orientierung.
          mischen([grau, grau + 4, grau + 14], 0.14 + t * 0.34);
        }
      }
      if (ebenen.has('boeen')) {
        /* Erst ab 45 km/h einfärben — das ist Windstärke 6, ab da wird es
           spürbar. Bei 30 km/h war praktisch die halbe Karte lila, ohne dass
           das etwas bedeutet hätte. */
        const w = sample(grid.gusts, h, fy, fx);
        if (w > 45) mischen([175, 90, 250], Math.min(0.8, (w - 45) / 45));
      }
      if (ebenen.has('gewitter')) {
        /* CAPE misst, wie viel Energie in der Luft steckt. Im Sommer liegt sie
           fast überall über 250 — daran ist nichts besonderes. Erst ab etwa
           800 wird es labil genug für Gewitter, ab 2000 für kräftige. */
        const cape = sample(grid.cape, h, fy, fx);
        if (cape > 800) mischen([255, 60, 60], Math.min(0.8, (cape - 800) / 1400));
      }
      if (ebenen.has('regen')) {
        const c = rainColor(sample(grid.precip, h, fy, fx));
        if (c) mischen([c[0], c[1], c[2]], c[3] / 255);
      }

      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Deckt das geladene Raster den Ausschnitt ab — mit den nötigen Werten? */
function covers(lat, lon, zoom, ebenen = null, sicht = null) {
  if (!grid) return false;
  // Auch die Auflösungsstufe muss passen — sonst bleibt auf der Kugel
  // ein Fleck stehen oder nah dran wird es unnötig grob.
  if (zoom !== undefined && stufeFuer(zoom).name !== grid.stufe) return false;
  // Wurde eine Ebene neu eingeschaltet, fehlt ihr Messfeld noch
  if (ebenen && [...ebenen].some(e => FELDER[e] && !grid.felder.includes(FELDER[e]))) return false;
  if (ebenen?.has('wind') && !grid.felder.includes(WIND_RICHTUNG)) return false;

  const nord = grid.lat0 + grid.spanLat, ost = grid.lon0 + grid.spanLon;

  /* Wenn der sichtbare Ausschnitt bekannt ist, muss er ganz im Raster liegen —
     sonst bricht die Vorhersage am Bildrand mit einer sichtbaren Kante ab. */
  if (sicht) {
    return sicht.south >= grid.lat0 && sicht.north <= nord
        && sicht.west >= grid.lon0 && sicht.east <= ost;
  }
  // Etwas Rand lassen, damit nicht bei jeder kleinen Bewegung neu geladen wird
  const randLat = grid.spanLat * 0.18, randLon = grid.spanLon * 0.18;
  return lat >= grid.lat0 + randLat && lat <= nord - randLat
      && lon >= grid.lon0 + randLon && lon <= ost - randLon;
}

/** Messpunkte des Rasters mit Werten — für Beschriftungen auf der Karte. */
function points(h, feld = 'temp') {
  if (!grid) return [];
  const arr = grid[feld];
  if (!arr) return [];
  const out = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const v = arr[i * N + j]?.[h];
      if (v == null) continue;
      out.push({
        lat: grid.lat0 + i * grid.dLat,
        lon: grid.lon0 + j * grid.dLon,
        wert: v
      });
    }
  }
  return out;
}

/** Zeitreihe am nächstgelegenen Rasterpunkt — für Antippen auf der Karte. */
function series(lat, lon) {
  if (!grid) return null;
  const i = Math.max(0, Math.min(N - 1, Math.round((lat - grid.lat0) / grid.dLat)));
  const j = Math.max(0, Math.min(N - 1, Math.round((lon - grid.lon0) / grid.dLon)));
  const k = i * N + j;
  return {
    times: grid.times,
    precip: grid.precip[k] || [], cloud: grid.cloud[k] || [],
    temp: grid.temp[k] || [], gusts: grid.gusts[k] || []
  };
}

/** Index der Stunde, die dem Zeitpunkt am nächsten liegt. */
function indexFor(date) {
  if (!grid) return -1;
  /* Date ODER Millisekunden annehmen. Ein Aufruf mit einer Zahl warf
     „date.getTime is not a function" und riss den ganzen Zweig mit — beim
     Vorwärmen der Abspielstunden blieb das unbemerkt, weil der Fehler im
     .then() landete. */
  const t = typeof date === 'number' ? date : date.getTime();
  let best = -1, diff = Infinity;
  for (let i = 0; i < grid.times.length; i++) {
    const d = Math.abs(new Date(grid.times[i]).getTime() - t);
    if (d < diff) { diff = d; best = i; }
  }
  return best;
}

/** Windpfeile: jeder zweite Rasterpunkt, sonst wird die Karte zum Nadelkissen.
    Richtung ist meteorologisch — woher der Wind kommt. */
/** Windpfeile. Der Abstand richtet sich nach dem sichtbaren Ausschnitt:
    Fest jeder zweite Punkt (`i += 2`) hieß, dass die Pfeildichte am
    Bildschirm mit jeder Zoomstufe schwankte — herausgezoomt standen nur
    noch eine Handvoll Pfeile im Bild. Jetzt wird der Abstand so gewählt,
    dass quer über das Bild immer rund elf Pfeile liegen. */
function windPoints(h, sicht = null) {
  if (!grid || !grid.windS?.[0]?.length || !grid.windD?.[0]?.length) return [];
  let schritt = 2;
  if (sicht && grid.spanLat > 0 && grid.spanLon > 0) {
    const quer = N * (sicht.east - sicht.west) / grid.spanLon;
    const hoch = N * (sicht.north - sicht.south) / grid.spanLat;
    schritt = Math.max(1, Math.round(Math.max(quer, hoch) / 11));
  }
  const out = [];
  for (let i = 0; i < N; i += schritt) {
    for (let j = 0; j < N; j += schritt) {
      const s = grid.windS[i * N + j]?.[h];
      const d = grid.windD[i * N + j]?.[h];
      if (s == null || d == null) continue;
      out.push({ lat: grid.lat0 + i * grid.dLat, lon: grid.lon0 + j * grid.dLon,
                 kmh: s, richtung: d });
    }
  }
  return out;
}

/** Kennung des geladenen Rasters — ändert sich mit Ausschnitt, Auflösung
    und Feldern. Bilder aus einem anderen Raster dürfen nie wiederverwendet
    werden: Sie zeigten die falsche Gegend. */
function stamp() {
  return grid
    ? `${grid.mitte.join(',')}|${grid.stufe}|${grid.spanLat}x${grid.spanLon}|${grid.felder.join(',')}`
    : 'leer';
}

return { load, frame, corners, ready, hours, indexFor, covers, points, windPoints, stufeFuer, series, stamp,
         get canvas() { return canvas; } };
})();
