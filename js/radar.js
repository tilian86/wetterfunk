/* Wetterfunk — Regenradar
   MapLibre GL mit Vektorkarte (OpenFreeMap, ohne Schlüssel) und echter
   Globus-Projektion: weit herausgezoomt sieht man die Erdkugel, beim
   Hineinzoomen geht sie fließend in die flache Karte über.
   Niederschlag kommt von RainViewer: 2 Stunden zurück, bis 30 Minuten voraus. */

const Radar = (() => {

  const API   = 'https://api.rainviewer.com/public/weather-maps.json';
  const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const COLOR = 8;          // kräftiges Schema — leichte und starke Zellen klar
                            // unterscheidbar, wichtiger als dezente Optik
  const OPTS  = '1_1';      // geglättet, mit Schnee
  const TILE  = 256;

  let map = null, ready = false;
  let frames = [];          // [{time, path, kind}]
  let idx = 0, timer = null, playing = false;
  let els = {};
  let host = 'https://tilecache.rainviewer.com';
  let onFrame = () => {};
  let here = null;

  const layerId = (i) => `rv-layer-${i}`;
  const sourceId = (i) => `rv-src-${i}`;

  // ── Karte aufbauen ───────────────────────────────────────
  function init(lat, lon, refs, frameCb) {
    els = refs;
    onFrame = frameCb || onFrame;
    here = [lon, lat];

    map = new maplibregl.Map({
      container: 'map',
      style: STYLE,
      center: here,
      zoom: 6.4,
      minZoom: 1.3,        // darunter hat die Vektorkarte keine Daten mehr
      maxZoom: 12,
      attributionControl: false,
      preserveDrawingBuffer: true,   // erlaubt Bildschirmfotos und Prüfung des Kartenbilds
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
      cooperativeGestures: false
    });

    // Globus: weit draußen Kugel, beim Hineinzoomen fließend flach
    map.on('style.load', () => {
      try { map.setProjection({ type: 'globe' }); } catch { /* ältere Fassung */ }
      addDwdLayer();
      addHereMarker();
      ready = true;
      if (frames.length) mountLayers();
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('moveend', checkEchoes);
    map.on('moveend', () => els.onMoveEnd?.(map.getCenter(), map.getZoom()));
    map.getContainer().style.touchAction = 'none';

    wireControls();
    return map;
  }

  /** Das deutsche Radarkomposit des DWD: 1 km Auflösung, beliebig zoombar.
      Deckt nur Deutschland ab und kennt keine Zeitschritte — deshalb liegt es
      als scharfe Ebene über dem aktuellsten Bild, während die Animation
      weiterhin von RainViewer kommt. */
  function addDwdLayer() {
    if (map.getSource('dwd')) return;
    const wms = 'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.1.1' +
      '&request=GetMap&layers=dwd:Radar_rv_product_1x1km_ger' +
      '&bbox={bbox-epsg-3857}&width=512&height=512&srs=EPSG:3857' +
      '&format=image/png&transparent=true&styles=';
    map.addSource('dwd', { type: 'raster', tiles: [wms], tileSize: 512 });
    map.addLayer({
      id: 'dwd-layer', type: 'raster', source: 'dwd',
      paint: {
        'raster-opacity': 0, 'raster-opacity-transition': { duration: 220 },
        'raster-saturation': 0.6, 'raster-contrast': 0.3
      }
    });
  }

  /** Scharfes DWD-Bild nur zeigen, wenn der aktuellste Messwert gemeint ist
      und gerade nichts abgespielt wird — sonst passt es nicht zur Animation. */
  function updateSharp() {
    if (!ready || !map.getLayer('dwd-layer')) return;
    const letzteMessung = frames.findIndex(f => f.kind === 'now');
    const istAktuell = idx === (letzteMessung > 0 ? letzteMessung - 1 : frames.length - 1);
    const an = istAktuell && !playing && !fcVisible;
    map.setPaintProperty('dwd-layer', 'raster-opacity', an ? 0.85 : 0);
    frames.forEach((_, n) => {
      if (map.getLayer(layerId(n))) {
        map.setPaintProperty(layerId(n), 'raster-opacity',
          !fcVisible && n === idx ? (an ? 0 : 0.8) : 0);
      }
    });
    if (els.sharp) els.sharp.hidden = !an;
  }

  /** Standortpunkt als eigene Ebene, damit er auch auf der Kugel klebt. */
  function addHereMarker() {
    if (map.getSource('here')) return;
    map.addSource('here', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Point', coordinates: here } }
    });
    map.addLayer({
      id: 'here-halo', type: 'circle', source: 'here',
      paint: {
        'circle-radius': 13, 'circle-color': '#6cc6ff', 'circle-opacity': .25,
        'circle-stroke-width': 0
      }
    });
    map.addLayer({
      id: 'here-dot', type: 'circle', source: 'here',
      paint: {
        'circle-radius': 5.5, 'circle-color': '#ffffff',
        'circle-stroke-width': 3, 'circle-stroke-color': '#2f9fe0'
      }
    });
  }

  function setCenter(lat, lon, fly = true) {
    here = [lon, lat];
    if (!map) return;
    map.getSource('here')?.setData({
      type: 'Feature', geometry: { type: 'Point', coordinates: here }
    });
    const z = Math.max(map.getZoom(), 6.4);
    fly ? map.flyTo({ center: here, zoom: z, duration: 900 })
        : map.jumpTo({ center: here, zoom: z });
  }

  // ── Frames laden ─────────────────────────────────────────
  async function load() {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw new Error('Radar nicht erreichbar');
    const data = await res.json();

    host = data.host || host;
    const past = (data.radar?.past || []).slice(-13).map(f => ({ ...f, kind: 'past' }));
    const now  = (data.radar?.nowcast || []).map(f => ({ ...f, kind: 'now' }));
    frames = [...past, ...now];
    if (!frames.length) throw new Error('Keine Radardaten');

    idx = Math.max(0, past.length - 1);          // aktuellste Messung, nicht die Prognose
    els.slider.max = String(frames.length - 1);
    els.slider.value = String(idx);

    if (ready) mountLayers();
    renderLegend();
    renderTicks();
    return frames;
  }

  /** Je Frame eine Rasterquelle; umgeschaltet wird über die Deckkraft,
      damit die Animation nicht bei jedem Schritt nachladen muss. */
  function mountLayers() {
    frames.forEach((f, i) => {
      if (map.getLayer(layerId(i))) map.removeLayer(layerId(i));
      if (map.getSource(sourceId(i))) map.removeSource(sourceId(i));

      map.addSource(sourceId(i), {
        type: 'raster',
        tiles: [`${host}${f.path}/${TILE}/{z}/{x}/{y}/${COLOR}/${OPTS}.png`],
        tileSize: TILE,
        // Über Zoom 7 liefert RainViewer kostenlos nur noch ein Bild mit
        // "Zoom Level Not Supported". Mit maxzoom skaliert MapLibre die
        // letzte echte Kachel hoch, statt den Platzhalter anzuzeigen.
        maxzoom: 7
      });
      map.addLayer({
        id: layerId(i), type: 'raster', source: sourceId(i),
        paint: {
          'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 },
          // Schwacher Regen kommt sonst fast farblos an — so bleibt der
          // Unterschied zwischen leicht und stark erkennbar.
          'raster-saturation': 0.75,
          'raster-contrast': 0.35
        }
      }, 'here-halo');
    });
    show(idx);
  }

  // ── Frame anzeigen ───────────────────────────────────────
  function show(i) {
    if (!frames.length) return;
    idx = (i + frames.length) % frames.length;
    if (ready) updateSharp();
    els.slider.value = String(idx);

    const f = frames[idx];
    const t = new Date(f.time * 1000);
    const hhmm = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    els.time.textContent = f.kind === 'now' ? `${hhmm} · Prognose` : hhmm;
    els.time.classList.toggle('is-forecast', f.kind === 'now');
    checkEchoes();
    onFrame(f);
  }

  const step = () => show(idx + 1);

  /** Markiert auf der Leiste, wo die Messung endet und die Prognose beginnt. */
  function renderTicks() {
    if (!els.ticks) return;
    const firstNow = frames.findIndex(f => f.kind === 'now');
    const pct = firstNow > 0 ? (firstNow / (frames.length - 1)) * 100 : null;
    els.ticks.innerHTML = pct == null ? '' :
      `<span class="tick-now" style="left:${pct.toFixed(1)}%"></span>`;
  }

  // ── Abspielen ────────────────────────────────────────────
  function play() {
    if (playing || !frames.length) return;
    playing = true;
    els.play.classList.add('is-playing');
    tick();
  }

  function tick() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!playing) return;
      if (idx === frames.length - 1) { show(0); timer = setTimeout(tick, 700); }
      else { step(); tick(); }
    }, idx === frames.length - 1 ? 900 : 420);
  }

  function pause() {
    playing = false;
    clearTimeout(timer);
    els.play.classList.remove('is-playing');
  }

  const toggle = () => (playing ? pause() : play());

  function wireControls() {
    els.play.addEventListener('click', toggle);
    els.slider.addEventListener('input', e => { pause(); show(+e.target.value); });
    els.locate?.addEventListener('click', () => els.onLocate?.());

    // Zwischen Standort und Erdkugel hin- und herspringen
    els.globe?.addEventListener('click', () => {
      if (!map) return;
      const weit = map.getZoom() < 3;
      weit ? map.flyTo({ center: here, zoom: 6.4, duration: 1400 })
           : map.flyTo({ center: here, zoom: 1.4, duration: 1600 });
      els.globe.classList.toggle('on', !weit);
    });
  }

  // ── Legende ──────────────────────────────────────────────
  function renderLegend() {
    if (!els.legend) return;
    els.legend.innerHTML = `
      <span class="lg-label">leicht</span>
      <span class="lg-bar"></span>
      <span class="lg-label">stark</span>`;
  }

  /** Eine leere Karte ist mehrdeutig — kein Regen oder nichts geladen?
      Wir schauen in die Kachel unter der Bildmitte und sagen es ausdrücklich. */
  let fcTimer = null;
  let fcVisible = false;
  let echoTimer = null;
  function checkEchoes() {
    clearTimeout(echoTimer);
    echoTimer = setTimeout(async () => {
      const note = els.empty;
      if (!note || !frames[idx] || !map) return;
      const f = frames[idx];
      const z = Math.max(3, Math.min(7, Math.round(map.getZoom())));
      const c = map.getCenter();
      const n = Math.pow(2, z);
      const x = Math.floor((c.lng + 180) / 360 * n);
      const latRad = c.lat * Math.PI / 180;
      const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);

      try {
        const img = await loadImage(`${host}${f.path}/256/${z}/${x}/${y}/${COLOR}/${OPTS}.png`);
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 64, 64);
        const px = ctx.getImageData(0, 0, 64, 64).data;
        let hits = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 12) hits++;
        note.hidden = hits > 3;
      } catch {
        note.hidden = true;         // im Zweifel nichts behaupten
      }
    }, 400);
  }

  const loadImage = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });

  const isPlaying = () => playing;

  // ── Flächenvorhersage über die Karte legen ───────────────
  /** Ab 30 Minuten reicht das Radar nicht mehr. Dann blenden wir die
      selbst gezeichnete Rastervorhersage ein — gröber, aber über fünf Tage. */
  function showForecast(hourIndex, ebenen) {
    if (!ready || !map || !Forecast.ready()) return false;
    const bild = Forecast.frame(hourIndex, ebenen);
    if (!bild) return false;

    if (!map.getSource('fc')) {
      map.addSource('fc', {
        type: 'canvas', canvas: bild,
        coordinates: Forecast.corners(),
        animate: true            // MapLibre liest das Canvas nur, solange es läuft
      });
      map.addLayer({ id: 'fc-layer', type: 'raster', source: 'fc',
        paint: { 'raster-opacity': 0.88, 'raster-resampling': 'linear' } }, 'here-halo');
    } else {
      // Kurz laufen lassen, damit das neu gezeichnete Bild übernommen wird,
      // danach anhalten — sonst rendert die Karte dauerhaft weiter.
      const src = map.getSource('fc');
      src.play();
      clearTimeout(fcTimer);
      fcTimer = setTimeout(() => { try { src.pause(); } catch {} }, 260);
    }
    map.setLayoutProperty('fc-layer', 'visibility', 'visible');
    setRadarVisible(false);
    els.empty.hidden = true;
    return true;
  }

  /** Zurück auf die Radarmessung. */
  function showRadar() {
    if (!ready || !map) return;
    if (map.getLayer('fc-layer')) map.setLayoutProperty('fc-layer', 'visibility', 'none');
    setRadarVisible(true);
    show(idx);
  }

  function setRadarVisible(on) {
    fcVisible = !on;
    updateSharp();
  }

  return { init, load, setCenter, play, pause, toggle, show, isPlaying,
           showForecast, showRadar, get map() { return map; } };
})();
