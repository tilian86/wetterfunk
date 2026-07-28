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
const N = 13;
const STUFEN = [
  { abZoom: 5.5, lat: 2.3,  lon: 3.1,  name: 'fein'  },   // ~20 km
  { abZoom: 3.5, lat: 7.0,  lon: 9.5,  name: 'mittel' },  // ~60 km
  { abZoom: 0,   lat: 26.0, lon: 34.0, name: 'weit'   }   // ~230 km
];
const stufeFuer = (zoom) => STUFEN.find(s => zoom >= s.abZoom) || STUFEN[STUFEN.length - 1];
const CELL = 128;            // Zeichenfläche; wird von der Karte weichgezeichnet

let grid = null;             // { lat0, lon0, dLat, dLon, times, precip, cloud }
let canvas = null, ctx = null;

/** Raster um den Ort herum laden. `zoom` bestimmt, wie weit es reicht. */
async function load(lat, lon, zoom = 7) {
  const stufe = stufeFuer(zoom);
  const SPAN_LAT = stufe.lat, SPAN_LON = stufe.lon;
  const lat0 = lat - SPAN_LAT / 2, lon0 = lon - SPAN_LON / 2;
  const dLat = SPAN_LAT / (N - 1), dLon = SPAN_LON / (N - 1);

  const lats = [], lons = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      lats.push((lat0 + i * dLat).toFixed(3));
      lons.push((lon0 + j * dLon).toFixed(3));
    }
  }

  const p = new URLSearchParams({
    latitude: lats.join(','), longitude: lons.join(','),
    hourly: 'precipitation,cloud_cover,temperature_2m,wind_gusts_10m,cape',
    forecast_days: '5', timezone: 'auto'
  });

  const res = await fetch(`${API}?${p}`);
  if (!res.ok) throw new Error(`Raster ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('Kein Raster erhalten');

  grid = {
    lat0, lon0, dLat, dLon,
    spanLat: SPAN_LAT, spanLon: SPAN_LON, stufe: stufe.name,
    mitte: [lat, lon],
    times: data[0].hourly.time,
    precip: data.map(d => d.hourly.precipitation),
    cloud:  data.map(d => d.hourly.cloud_cover),
    temp:   data.map(d => d.hourly.temperature_2m),
    gusts:  data.map(d => d.hourly.wind_gusts_10m),
    cape:   data.map(d => d.hourly.cape)
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

/** Farbskala für Niederschlag in mm/h — an das Radar angelehnt. */
function rainColor(mm) {
  if (mm < 0.08) return null;
  if (mm < 0.3)  return [ 96, 176, 232,  95];
  if (mm < 0.8)  return [ 60, 200, 170, 130];
  if (mm < 1.8)  return [110, 210,  90, 150];
  if (mm < 3.5)  return [255, 212,  38, 170];
  if (mm < 7)    return [255, 150,  50, 185];
  if (mm < 14)   return [240,  80,  60, 200];
  return              [205,  70, 200, 210];
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
        mischen(tempColor(sample(grid.temp, h, fy, fx)), 0.5);
      }
      if (ebenen.has('wolken')) {
        const cc = sample(grid.cloud, h, fy, fx);
        if (cc > 18) mischen([240, 245, 252], Math.min(0.55, (cc - 18) / 150));
      }
      if (ebenen.has('boeen')) {
        const w = sample(grid.gusts, h, fy, fx);
        if (w > 35) mischen([190, 120, 240], Math.min(0.6, (w - 35) / 70));
      }
      if (ebenen.has('gewitter')) {
        const cape = sample(grid.cape, h, fy, fx);
        if (cape > 300) mischen([255, 90, 90], Math.min(0.65, (cape - 300) / 1800));
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

/** Ist ein Punkt noch vom geladenen Raster abgedeckt? */
function covers(lat, lon, zoom) {
  if (!grid) return false;
  // Auch die Auflösungsstufe muss passen — sonst bleibt auf der Kugel
  // ein Fleck stehen oder nah dran wird es unnötig grob.
  if (zoom !== undefined && stufeFuer(zoom).name !== grid.stufe) return false;
  // Etwas Rand lassen, damit nicht bei jeder kleinen Bewegung neu geladen wird
  const randLat = grid.spanLat * 0.18, randLon = grid.spanLon * 0.18;
  return lat >= grid.lat0 + randLat && lat <= grid.lat0 + grid.spanLat - randLat
      && lon >= grid.lon0 + randLon && lon <= grid.lon0 + grid.spanLon - randLon;
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

/** Index der Stunde, die dem Zeitpunkt am nächsten liegt. */
function indexFor(date) {
  if (!grid) return -1;
  const t = date.getTime();
  let best = -1, diff = Infinity;
  for (let i = 0; i < grid.times.length; i++) {
    const d = Math.abs(new Date(grid.times[i]).getTime() - t);
    if (d < diff) { diff = d; best = i; }
  }
  return best;
}

return { load, frame, corners, ready, hours, indexFor, covers, points, stufeFuer,
         get canvas() { return canvas; } };
})();
