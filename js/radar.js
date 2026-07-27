/* Wetterfunk — Regenradar
   Leaflet + RainViewer. Vergangenheit (2 h) + Nowcast (30 min), animiert. */

const Radar = (() => {

  const API = 'https://api.rainviewer.com/public/weather-maps.json';
  const COLOR = 4;          // Farbschema "The Weather Channel"
  const OPTS = '1_1';       // smooth_snow
  const TILE = 512;

  let map = null, marker = null;
  let frames = [];          // [{time, path, kind}]
  let layers = [];          // parallel zu frames
  let idx = 0, timer = null, playing = false;
  let els = {};
  let host = 'https://tilecache.rainviewer.com';
  let onFrame = () => {};

  // ── Karte aufbauen ───────────────────────────────────────
  function init(lat, lon, refs, frameCb) {
    els = refs;
    onFrame = frameCb || onFrame;

    map = L.map('map', {
      center: [lat, lon],
      zoom: 8,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      dragging: true,
      tap: false,                 // sonst schluckt Leaflets Tap-Emulation auf iOS das Ziehen
      touchZoom: true,
      doubleClickZoom: true,
      scrollWheelZoom: false,     // Seitenscrollen soll nicht in die Karte zoomen
      bounceAtZoomLimits: false
    });

    // Ziehen darf die Seite nicht mitscrollen
    const c = map.getContainer();
    c.style.touchAction = 'none';

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 12, minZoom: 4, detectRetina: true
    }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 12, minZoom: 4, detectRetina: true, pane: 'shadowPane'
    }).addTo(map);

    marker = L.marker([lat, lon], {
      icon: L.divIcon({ className: 'here-dot', html: '<span></span>', iconSize: [18, 18] }),
      interactive: false, keyboard: false
    }).addTo(map);

    map.on('moveend zoomend', checkEchoes);

    wireControls();
    return map;
  }

  function setCenter(lat, lon, fly = true) {
    if (!map) return;
    marker.setLatLng([lat, lon]);
    fly ? map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: .8 })
        : map.setView([lat, lon], 8);
  }

  // ── Frames laden ─────────────────────────────────────────
  async function load() {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw new Error('Radar nicht erreichbar');
    const data = await res.json();

    const past = (data.radar?.past || []).map(f => ({ ...f, kind: 'past' }));
    const now  = (data.radar?.nowcast || []).map(f => ({ ...f, kind: 'now' }));
    host = data.host || host;

    // Vergangenheit auf die letzten 2 h begrenzen
    const fresh = past.slice(-12);
    const next = frames = [...fresh, ...now];
    if (!next.length) throw new Error('Keine Radardaten');

    layers.forEach(l => map.removeLayer(l));
    layers = next.map(f => L.tileLayer(
      `${host}${f.path}/${TILE}/{z}/{x}/{y}/${COLOR}/${OPTS}.png`,
      { opacity: 0, zIndex: 400, maxZoom: 12, tileSize: TILE, zoomOffset: -1, className: 'radar-tile' }
    ).addTo(map));

    // Standard: der aktuellste echte Messwert, nicht die Vorhersage
    idx = Math.max(0, fresh.length - 1);
    els.slider.max = String(next.length - 1);
    els.slider.value = String(idx);
    show(idx);
    renderLegend();
    return next;
  }

  // ── Frame anzeigen ───────────────────────────────────────
  function show(i) {
    if (!layers.length) return;
    idx = (i + layers.length) % layers.length;
    layers.forEach((l, n) => l.setOpacity(n === idx ? 0.82 : 0));
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

  // ── Abspielen ────────────────────────────────────────────
  function play() {
    if (playing || !layers.length) return;
    playing = true;
    els.play.classList.add('is-playing');
    timer = setInterval(() => {
      // am Ende kurz stehenbleiben, dann von vorn
      if (idx === layers.length - 1) {
        clearInterval(timer);
        timer = setTimeout(() => { if (playing) { show(0); resume(); } }, 900);
      } else step();
    }, 420);
  }

  function resume() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (idx === layers.length - 1) {
        clearInterval(timer);
        timer = setTimeout(() => { if (playing) { show(0); resume(); } }, 900);
      } else step();
    }, 420);
  }

  function pause() {
    playing = false;
    clearInterval(timer); clearTimeout(timer);
    els.play.classList.remove('is-playing');
  }

  const toggle = () => (playing ? pause() : play());

  function wireControls() {
    els.play.addEventListener('click', toggle);
    els.slider.addEventListener('input', e => { pause(); show(+e.target.value); });
    els.locate?.addEventListener('click', () => els.onLocate?.());
  }

  // ── Legende ──────────────────────────────────────────────
  function renderLegend() {
    if (!els.legend) return;
    els.legend.innerHTML = `
      <span class="lg-label">leicht</span>
      <span class="lg-bar"></span>
      <span class="lg-label">stark</span>`;
  }

  /** Eine leere schwarze Karte ist mehrdeutig: kein Regen oder nicht geladen?
      Wir prüfen deshalb, ob im sichtbaren Bild überhaupt Echos stecken, und
      sagen es ausdrücklich. Geprüft wird eine Kachel aus der Bildmitte. */
  let echoTimer = null;
  function checkEchoes() {
    clearTimeout(echoTimer);
    echoTimer = setTimeout(async () => {
      const note = els.empty;
      if (!note || !frames[idx]) return;
      const f = frames[idx];
      const z = 5;
      const c = map.getCenter();
      const n = Math.pow(2, z);
      const x = Math.floor((c.lng + 180) / 360 * n);
      const latRad = c.lat * Math.PI / 180;
      const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);

      try {
        const url = `${host}${f.path}/256/${z}/${x}/${y}/${COLOR}/${OPTS}.png`;
        const img = await loadImage(url);
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
    }, 350);
  }

  const loadImage = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });

  /** Grober Regen-Check am Standort für den nächsten halben Tag ist Aufgabe der
      Vorhersage – hier nur: läuft gerade eine Animation? */
  const isPlaying = () => playing;

  return { init, load, setCenter, play, pause, toggle, show, isPlaying, get map() { return map; } };
})();
