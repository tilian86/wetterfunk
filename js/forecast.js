/* Wetterfunk — Flächenvorhersage
   Das Radar reicht nur 30 Minuten voraus. Für die Zeit danach holen wir ein
   Punktraster von Open-Meteo (9×9 über die Region, 120 Stunden) und zeichnen
   daraus selbst eine Karte: Regen als Farbfläche, Bewölkung als Schleier.
   Grober als echtes Radar — dafür über fünf Tage. */

const Forecast = (() => {
'use strict';

const API = 'https://api.open-meteo.com/v1/forecast';
const N = 9;                 // Rasterpunkte je Richtung
const SPAN_LAT = 3.4;        // abgedeckte Fläche in Grad
const SPAN_LON = 4.6;
const CELL = 96;             // Zeichenfläche; wird von der Karte weichgezeichnet

let grid = null;             // { lat0, lon0, dLat, dLon, times, precip, cloud }
let canvas = null, ctx = null;

/** Raster um den Ort herum laden. */
async function load(lat, lon) {
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
    hourly: 'precipitation,cloud_cover', forecast_days: '5', timezone: 'auto'
  });

  const res = await fetch(`${API}?${p}`);
  if (!res.ok) throw new Error(`Raster ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('Kein Raster erhalten');

  grid = {
    lat0, lon0, dLat, dLon,
    times: data[0].hourly.time,
    precip: data.map(d => d.hourly.precipitation),
    cloud: data.map(d => d.hourly.cloud_cover)
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
  const { lat0, lon0 } = grid;
  const lat1 = lat0 + SPAN_LAT, lon1 = lon0 + SPAN_LON;
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

/** Ein Bild für die gewählte Stunde zeichnen. Zeile 0 liegt im Norden. */
function frame(h) {
  if (!grid || h < 0 || h >= grid.times.length) return null;

  const img = ctx.createImageData(CELL, CELL);
  const px = img.data;

  for (let y = 0; y < CELL; y++) {
    const fy = 1 - y / (CELL - 1);           // Bildoberkante = größte Breite
    for (let x = 0; x < CELL; x++) {
      const fx = x / (CELL - 1);
      const o = (y * CELL + x) * 4;

      const mm = sample(grid.precip, h, fy, fx);
      const rain = rainColor(mm);
      if (rain) {
        px[o] = rain[0]; px[o + 1] = rain[1]; px[o + 2] = rain[2]; px[o + 3] = rain[3];
        continue;
      }
      // Kein Regen: Bewölkung als heller Schleier, damit man die Lage sieht
      const cc = sample(grid.cloud, h, fy, fx);
      if (cc > 18) {
        const a = Math.min(140, (cc - 18) * 1.7);
        px[o] = 240; px[o + 1] = 245; px[o + 2] = 252; px[o + 3] = a;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
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

return { load, frame, corners, ready, hours, indexFor, get canvas() { return canvas; } };
})();
