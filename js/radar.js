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
      preferCanvas: true
    });

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
    const host = data.host || 'https://tilecache.rainviewer.com';

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

  /** Grober Regen-Check am Standort für den nächsten halben Tag ist Aufgabe der
      Vorhersage – hier nur: läuft gerade eine Animation? */
  const isPlaying = () => playing;

  return { init, load, setCenter, play, pause, toggle, show, isPlaying, get map() { return map; } };
})();
