/* Wetterfunk — Regenradar
   MapLibre GL mit Vektorkarte (OpenFreeMap, ohne Schlüssel) und echter
   Globus-Projektion: weit herausgezoomt sieht man die Erdkugel, beim
   Hineinzoomen geht sie fließend in die flache Karte über.
   Niederschlag kommt von RainViewer: 2 Stunden zurück, bis 30 Minuten voraus. */

const Radar = (() => {

  const API   = 'https://api.rainviewer.com/public/weather-maps.json';
  /* Helle, entsättigte Grundkarte wie bei den Radarbildern des DWD: fast
     weiß, nur Grenzen, Gewässer und Ortsnamen. Der Fehler zuvor war nicht die
     Helligkeit, sondern die bunte Straßenkarte — auf grünen Wäldern und gelben
     Straßen geht jede Wetterfarbe unter. Auf ruhigem Hellgrau knallen sie. */
  const STYLE = 'https://tiles.openfreemap.org/styles/positron';
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
  /** Welches Radarbild gerade sichtbar ist (-1 = keines). */
  let sichtbaresBild = -1;
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
      beschriftungLesbar();
      ready = true;
      if (frames.length) mountLayers();
      ladeDwdBild();
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('moveend', checkEchoes);

    /* Scheitert das Laden eines Bildes, blieb die Karte bisher stumm leer —
       und es sah aus, als gäbe es keine Vorhersage. Jetzt sagt sie es. */
    map.on('error', (e) => {
      /* Nur protokollieren. Die Meldung überschrieb früher die Zeitangabe
         auf der Karte — bei einem vorübergehenden Kachelfehler stand dann
         „ließ sich nicht laden", obwohl gleich darauf alles da war. */
      console.warn('Karte:', String(e?.error?.message || e?.error || ''));
    });
    map.on('moveend', () => els.onMoveEnd?.(map.getCenter(), map.getZoom()));
    // Das DWD-Detailbild gilt nur für den gezeigten Ausschnitt — nach dem
    // Verschieben neu holen, aber erst wenn die Bewegung zur Ruhe kommt.
    map.on('moveend', () => { clearTimeout(dwdTimer); dwdTimer = setTimeout(ladeDwdBild, 350); });
    map.getContainer().style.touchAction = 'none';

    wireControls();
    return map;
  }

  /* Das deutsche Radarkomposit des DWD: 1 km Auflösung, beliebig zoombar —
     deutlich schärfer als RainViewer, das kostenlos bei Zoom 7 endet.
     Haken: Der DWD malt regenfreie Flächen weiß aus, umrandet die
     Radarreichweite pink und legt einen grauen Datenrahmen darum. Als Kachel
     eingebunden verdeckt das die halbe Karte. Deshalb holen wir ein einzelnes
     Bild für den Ausschnitt, streichen diese Farben im Canvas heraus und
     hängen erst dann das Ergebnis in die Karte. */
  /* Über den eigenen Worker: Der DWD-Dienst braucht oft mehrere Sekunden und
     fällt zeitweise ganz aus. Gepuffert kommt dasselbe Bild sofort zurück. */
  const DWD_PX = 768;
  let dwdCanvas = null, dwdCtx = null, dwdLauf = 0, dwdSichtbar = false, dwdTimer = null;

  /* ── Fünf-Minuten-Nowcast des DWD ────────────────────────
     Das RV-Komposit („Analyse und Vorhersage") liefert 1-km-Radarbilder im
     Fünf-Minuten-Takt und reicht rund 90 Minuten voraus. Damit lässt sich
     ein Regengebiet minutengenau heranziehen sehen — die Frage, wegen der
     man aufs Radar schaut. Vorher zeigte die App dort Viertelstunden aus
     einem 20×20-Raster: viel zu grob, um zu erkennen, wann der Schauer den
     eigenen Ort erreicht.

     Die Bilder werden je Ausschnitt und Zeitpunkt zwischengespeichert; sie
     sind klein (2–20 kB) und liegen zusätzlich im Worker-Puffer. */
  const RV_SCHRITT = 5 * 60000;                 // Fünf-Minuten-Raster
  const RV_VORAUS = 90;                         // so weit reicht die Vorhersage
  const RV_ZURUECK = 60;                        // so weit zurück wird angeboten
  const rvBilder = new Map();                   // "bbox|zeit" → Daten-URL
  let rvLauf = 0, rvAktiv = false;

  /** Zeitpunkt auf das Fünf-Minuten-Raster des DWD legen. */
  const rvRaster = (ms) => Math.floor(ms / RV_SCHRITT) * RV_SCHRITT;
  const rvStempel = (ms) => new Date(rvRaster(ms)).toISOString().replace(/\.\d+Z$/, '.000Z');

  /** Reicht der Nowcast für diesen Zeitpunkt? */
  function rvMoeglich(ms) {
    if (!map || !inDeutschland(map.getBounds()) || map.getZoom() < 5.5) return false;
    const min = (ms - Date.now()) / 60000;
    return min >= -RV_ZURUECK - 5 && min <= RV_VORAUS;
  }

  /** Alle Zeitpunkte, die der Nowcast abdeckt — für den Zeitstrahl. */
  function rvZeiten() {
    if (!map || !inDeutschland(map.getBounds())) return [];
    const jetzt = rvRaster(Date.now());
    const aus = [];
    for (let m = -RV_ZURUECK; m <= RV_VORAUS; m += 5) aus.push(jetzt + m * 60000);
    return aus;
  }

  /** Deutschland grob — außerhalb lohnt der Abruf nicht. */
  const inDeutschland = (b) =>
    b.getEast() > 5.5 && b.getWest() < 15.5 && b.getNorth() > 47 && b.getSouth() < 55.5;

  function addDwdLayer() {
    if (dwdCanvas) return;
    dwdCanvas = document.createElement('canvas');
    dwdCanvas.width = dwdCanvas.height = DWD_PX;
    dwdCtx = dwdCanvas.getContext('2d', { willReadFrequently: true });
  }

  /** Weiß, Grau und das pinke Reichweitenband durchsichtig machen. */
  function dwdFiltern(bild) {
    dwdCtx.clearRect(0, 0, DWD_PX, DWD_PX);
    dwdCtx.drawImage(bild, 0, 0, DWD_PX, DWD_PX);
    const img = dwdCtx.getImageData(0, 0, DWD_PX, DWD_PX);
    const px = img.data;
    let farbig = 0;

    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (px[i + 3] === 0) continue;

      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const grau = max - min < 26;                       // weiß bis dunkelgrau
      const pink = r > 200 && b > 200 && g < 120;        // Reichweitenrand
      if (grau || pink) { px[i + 3] = 0; continue; }
      farbig++;
    }
    dwdCtx.putImageData(img, 0, 0);
    return farbig;
  }

  /** Bild für den aktuellen Ausschnitt holen, filtern, einhängen.
      Mit `zeitMs` das RV-Produkt für diesen Zeitpunkt, sonst das Messbild. */
  async function ladeDwdBild(zeitMs = null) {
    if (!ready || !map) return;
    const b = map.getBounds();
    if (!inDeutschland(b) || map.getZoom() < 5.5) { setzeDwdSichtbar(false); return; }

    addDwdLayer();
    const lauf = ++dwdLauf;

    // Bounding Box in Web-Mercator-Metern
    const sw = maplibregl.MercatorCoordinate.fromLngLat(b.getSouthWest());
    const ne = maplibregl.MercatorCoordinate.fromLngLat(b.getNorthEast());
    const M = 20037508.342789244;
    const zuM = (m) => [(m.x * 2 - 1) * M, (1 - m.y * 2) * M];
    const [x0, y0] = zuM(sw), [x1, y1] = zuM(ne);

    // Auf 2 km runden — sonst ergibt jede Mausbewegung eine neue Adresse
    // und der Zwischenspeicher im Worker greift nie.
    const r = (v) => (Math.round(v / 2000) * 2000).toFixed(0);
    const bbox = `${r(x0)},${r(y0)},${r(x1)},${r(y1)}`;
    const proxy = (localStorage.getItem('wf.proxy') || '').replace(/^"|"$/g, '')
      || 'https://wetterfunk.florian-s-thiel.workers.dev';
    const zeitTeil = zeitMs ? `&time=${encodeURIComponent(rvStempel(zeitMs))}` : '';
    const url = `${proxy.replace(/\/+$/, '')}/dwdradar?bbox=${bbox}&px=${DWD_PX}${zeitTeil}`;
    const speicherKey = `${bbox}|${zeitMs ? rvRaster(zeitMs) : 'jetzt'}`;

    // Ecken passend zur gerundeten Anfrage, sonst läge das Bild leicht versetzt
    const zuGrad = (mx, my) => {
      const lon = (mx / M) * 180;
      const lat = (Math.atan(Math.exp((my / M) * Math.PI)) * 360 / Math.PI) - 90;
      return [lon, lat];
    };
    const [gw, gs] = zuGrad(+r(x0), +r(y0));
    const [ge, gn] = zuGrad(+r(x1), +r(y1));

    const ecken = [[gw, gn], [ge, gn], [ge, gs], [gw, gs]];

    // Schon einmal geholt? Dann sofort zeigen, ohne Netz und ohne Filtern.
    const fertig = rvBilder.get(speicherKey);
    if (fertig) {
      if (!map.getSource('dwd')) {
        map.addSource('dwd', { type: 'image', url: fertig, coordinates: ecken });
        map.addLayer({ id: 'dwd-layer', type: 'raster', source: 'dwd',
          paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 200 } } },
          unterBeschriftung());
      } else {
        map.getSource('dwd').updateImage({ url: fertig, coordinates: ecken });
      }
      updateSharp();
      return;
    }

    try {
      const bild = await new Promise((ok, fehler) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => ok(i);
        i.onerror = () => fehler(new Error('DWD-Bild'));
        i.src = url;
      });
      if (lauf !== dwdLauf) return;              // inzwischen weitergeschoben

      dwdFiltern(bild);
      /* Blob statt Daten-Adresse — genau die Falle, die schon die
         Vorhersagebilder leer ließ: MapLibre bricht bei Base64-Adressen mit
         „Failed to fetch" ab, und die Karte bleibt ohne Bild. */
      const daten = await new Promise((ok) =>
        dwdCanvas.toBlob((b) => ok(b ? URL.createObjectURL(b) : null), 'image/png'));
      if (!daten) throw new Error('Bild konnte nicht erzeugt werden');
      if (lauf !== dwdLauf) { URL.revokeObjectURL(daten); return; }
      if (rvBilder.size > 120) leereNowcastSpeicher();
      rvBilder.set(speicherKey, daten);

      if (!map.getSource('dwd')) {
        map.addSource('dwd', { type: 'image', url: daten, coordinates: ecken });
        map.addLayer({ id: 'dwd-layer', type: 'raster', source: 'dwd',
          paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 200 } } },
          unterBeschriftung());
      } else {
        map.getSource('dwd').updateImage({ url: daten, coordinates: ecken });
      }
      updateSharp();
    } catch (e) {
      console.warn('DWD-Detailbild:', e.message);
      setzeDwdSichtbar(false);
    }
  }

  function setzeDwdSichtbar(an) {
    dwdSichtbar = an;
    if (map?.getLayer('dwd-layer')) map.setPaintProperty('dwd-layer', 'raster-opacity', an ? 0.9 : 0);
    if (els.sharp) els.sharp.hidden = !an;

    /* Früher lief hier eine Schleife über alle Bilder und setzte bei jedem
       Schritt dreizehn Deckkraft-Werte neu — dreizehn Neuzeichnungen der
       Karte je Einzelbild. Das reichte, um die Animation ins Stocken zu
       bringen. Jetzt wird nur das vorherige aus- und das neue eingeblendet. */
    const soll = !fcVisible && !an ? idx : -1;
    if (soll !== sichtbaresBild) {
      if (sichtbaresBild >= 0 && map?.getLayer(layerId(sichtbaresBild))) {
        map.setPaintProperty(layerId(sichtbaresBild), 'raster-opacity', 0);
      }
      if (soll >= 0 && map?.getLayer(layerId(soll))) {
        map.setPaintProperty(layerId(soll), 'raster-opacity', 0.8);
      }
      sichtbaresBild = soll;
    }
  }

  /** Scharfes DWD-Bild nur zeigen, wenn der aktuellste Messwert gemeint ist
      und gerade nichts abgespielt wird — sonst passt es nicht zur Animation. */
  function updateSharp() {
    if (!ready) return;
    const letzteMessung = frames.findIndex(f => f.kind === 'now');
    const istAktuell = idx === (letzteMessung > 0 ? letzteMessung - 1 : frames.length - 1);
    const moeglich = !!map.getSource('dwd') && inDeutschland(map.getBounds()) && map.getZoom() >= 5.5;
    setzeDwdSichtbar(istAktuell && !playing && !fcVisible && moeglich);
  }

  /** Temperaturzahlen an den Rasterpunkten — damit man auf der Karte sofort
      sieht, wie warm es wo ist, statt Farben deuten zu müssen. */
  /** Zahlen auf der Karte. Wo Regen fällt, steht die Menge in mm — die ist
      dort die interessantere Angabe; sonst die Temperatur. */
  /* Windpfeile: Pfeilzeichen als Schriftsymbol, gedreht in die Richtung, in
     die der Wind WEHT (meteorologische Angabe + 180°). Größe und Farbe nach
     Stärke — ein blasser kleiner Pfeil ist ein Lüftchen, ein roter großer
     ein Sturm. Kein Bild nötig, die Kartenschrift bringt das Zeichen mit. */
  function updateWind() {
    if (!ready || !map || !Forecast.ready()) return;
    const an = els.aktiveEbenen?.().has('wind');
    if (!an) {
      if (map.getLayer('wind-layer')) map.setLayoutProperty('wind-layer', 'visibility', 'none');
      return;
    }
    const zeit = els.currentTime?.();
    const h = Math.max(0, zeit ? Forecast.indexFor(zeit) : 0);
    const geo = {
      type: 'FeatureCollection',
      features: Forecast.windPoints(h).map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { rot: (p.richtung + 180) % 360, spd: Math.round(p.kmh) }
      }))
    };
    if (!map.getSource('wind')) {
      map.addSource('wind', { type: 'geojson', data: geo });
      map.addLayer({
        id: 'wind-layer', type: 'symbol', source: 'wind',
        layout: {
          'text-field': '↑',
          'text-font': ['Noto Sans Bold'],
          'text-rotate': ['get', 'rot'],
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
          'text-size': ['interpolate', ['linear'], ['get', 'spd'],
                        0, 13, 20, 18, 45, 25, 80, 32]
        },
        paint: {
          'text-color': ['step', ['get', 'spd'],
            '#5a7690', 12, '#2f8fd6', 30, '#8b3fd6', 55, '#e0342f'],
          'text-halo-color': 'rgba(255,255,255,.85)',
          'text-halo-width': 1.4
        }
      });
    } else {
      map.getSource('wind').setData(geo);
      map.setLayoutProperty('wind-layer', 'visibility', 'visible');
    }
  }

  function updateLabels() {
    updateWind();
    if (!ready || !map || !Forecast.ready()) return;
    const zeit = els.currentTime?.();
    const h = Math.max(0, zeit ? Forecast.indexFor(zeit) : 0);
    const temps = Forecast.points(h, 'temp');
    const regen = Forecast.points(h, 'precip');

    const geo = {
      type: 'FeatureCollection',
      features: temps.map((p, k) => {
        const mm = regen[k]?.wert ?? 0;
        const nass = mm >= 0.1;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: {
            t: nass ? `${(mm < 1 ? mm.toFixed(1) : String(Math.round(mm))).replace('.', ',')} mm`
                    : `${Math.round(p.wert)}°`,
            nass: nass ? 1 : 0,
            mm, grad: Math.round(p.wert), stunde: h
          }
        };
      })
    };

    if (!map.getSource('temps')) {
      map.addSource('temps', { type: 'geojson', data: geo });
      map.addLayer({
        id: 'temp-labels', type: 'symbol', source: 'temps',
        layout: {
          'text-field': ['get', 't'],
          'text-size': ['case', ['==', ['get', 'nass'], 1], 12.5, 11.5],
          'text-font': ['Noto Sans Bold'],
          'text-allow-overlap': false,
          'text-padding': 6
        },
        paint: {
          // Dunkle Schrift mit weißem Rand — auf der hellen Karte und über
          // farbigen Regenflächen gleichermaßen lesbar
          'text-color': ['case', ['==', ['get', 'nass'], 1], '#0d3a5c', '#22303f'],
          'text-halo-color': 'rgba(255,255,255,.9)',
          'text-halo-width': 1.8
        }
      });
      map.on('click', 'temp-labels', (e) => {
        const f = e.features?.[0]?.properties;
        if (f) els.onPointTap?.(f, e.lngLat);
      });
      map.on('mouseenter', 'temp-labels', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'temp-labels', () => { map.getCanvas().style.cursor = ''; });
    } else {
      map.getSource('temps').setData(geo);
    }
    map.setLayoutProperty('temp-labels', 'visibility',
      els.labelsOn?.() ? 'visible' : 'none');
  }

  /** Erste Beschriftungsebene des Kartenstils. Wetterflächen kommen darunter,
      damit Städtenamen und Straßen lesbar bleiben — sonst verschwindet die
      Orientierung unter einer geschlossenen Wolkendecke. */
  function unterBeschriftung() {
    const ebenen = map.getStyle()?.layers || [];
    const erste = ebenen.find(l => l.type === 'symbol');
    return erste ? erste.id : undefined;
  }

  /** Ortsnamen mit weißem Rand hinterlegen: Über einer Regen- oder
      Wolkenfläche gingen sie sonst unter. Dunkle Schrift auf hellem Rand
      bleibt auf jedem Untergrund lesbar — so macht es der DWD auch. */
  function beschriftungLesbar() {
    const ebenen = map.getStyle()?.layers || [];
    for (const l of ebenen) {
      if (l.type !== 'symbol') continue;
      // Je nach Kartenstil heißen die Ortsebenen "place_city" oder "label_city"
      if (!/^(place|label)_|water_name|state|country/i.test(l.id)) continue;
      try {
        map.setPaintProperty(l.id, 'text-color', '#1c2431');
        map.setPaintProperty(l.id, 'text-halo-color', 'rgba(255,255,255,.95)');
        map.setPaintProperty(l.id, 'text-halo-width', 2);
        map.setPaintProperty(l.id, 'text-halo-blur', 0.2);
      } catch { /* Ebene ohne Textfarbe */ }
    }
  }

  /** Standortpunkt als eigene Ebene, damit er auch auf der Kugel klebt. */
  function addHereMarker() {
    if (map.getSource('here')) return;
    map.addSource('here', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Point', coordinates: here } }
    });
    /* Der Punkt war blau — dieselbe Farbe wie leichter Regen, und mitten in
       einem blauen Regengebiet ging er unter. Jetzt ein kräftiges Magenta:
       Diese Farbe kommt in keiner Radarskala vor, also kann sie nie mit
       Niederschlag verwechselt werden. Dazu ein weißer Ring, damit er auch
       auf dunklen Gewitterflächen steht. */
    map.addLayer({
      id: 'here-halo', type: 'circle', source: 'here',
      paint: {
        'circle-radius': 15, 'circle-color': '#ff2d95', 'circle-opacity': .18,
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#ff2d95',
        'circle-stroke-opacity': .35
      }
    });
    map.addLayer({
      id: 'here-ring', type: 'circle', source: 'here',
      paint: {
        'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff'
      }
    });
    map.addLayer({
      id: 'here-dot', type: 'circle', source: 'here',
      paint: {
        'circle-radius': 5, 'circle-color': '#ff2d95',
        'circle-stroke-width': 1.5, 'circle-stroke-color': 'rgba(255,255,255,.9)'
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
    if (els.slider) { els.slider.max = String(frames.length - 1); els.slider.value = String(idx); }

    if (ready) mountLayers();
    renderLegend();
    renderTicks();
    return frames;
  }

  /** Je Frame eine Rasterquelle; umgeschaltet wird über die Deckkraft,
      damit die Animation nicht bei jedem Schritt nachladen muss. */
  function mountLayers() {
    sichtbaresBild = -1;
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
      }, unterBeschriftung());
    });
    show(idx);
  }

  // ── Frame anzeigen ───────────────────────────────────────
  function show(i) {
    if (!frames.length) return;
    idx = (i + frames.length) % frames.length;
    if (ready) updateSharp();
    if (els.slider) els.slider.value = String(idx);

    const f = frames[idx];
    const t = new Date(f.time * 1000);
    const hhmm = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (els.time) {
      els.time.textContent = f.kind === 'now' ? `${hhmm} · Prognose` : hhmm;
      els.time.classList.toggle('is-forecast', f.kind === 'now');
    }
    checkEchoes();
    onFrame(f);
  }

  const step = () => show(idx + 1);

  /** Zeitpunkte aller Radarbilder — daraus baut app.js den gemeinsamen Regler. */
  const frameTimes = () => frames.map(f => ({ t: f.time * 1000, kind: f.kind }));

  /** Das Bild zeigen, das dem Zeitpunkt am nächsten liegt. */
  function showAt(zeitMs) {
    if (!frames.length) return false;
    let best = 0, diff = Infinity;
    frames.forEach((f, i) => {
      const d = Math.abs(f.time * 1000 - zeitMs);
      if (d < diff) { diff = d; best = i; }
    });
    show(best);
    return true;
  }

  /** Zeitpunkt der aktuellsten echten Messung. */
  function lastMeasured() {
    const letzte = [...frames].reverse().find(f => f.kind === 'past');
    return letzte ? letzte.time * 1000 : null;
  }

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
    els.play?.classList.add('is-playing');
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
    els.play?.classList.remove('is-playing');
  }

  const toggle = () => (playing ? pause() : play());

  function wireControls() {
    els.play?.addEventListener('click', toggle);
    els.slider?.addEventListener('input', e => { pause(); show(+e.target.value); });
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
  /* Bei mehreren Ebenen übereinander ist sonst nicht zu erkennen, was ein
     rötlicher oder violetter Schatten bedeutet. Die Legende zeigt deshalb
     genau die Ebenen, die gerade eingeschaltet sind. */
  const LEGENDE = {
    wolken:     { farbe: '#9aa8bb', text: 'Wolken' },
    wind:       { farbe: '#2f8fd6', text: 'Windpfeile' },
    boeen:      { farbe: '#af5afa', text: 'Böen ab 45 km/h' },
    gewitter:   { farbe: '#ff3c3c', text: 'Gewitterneigung' },
    temperatur: { farbe: '#ff9f6a', text: 'Temperatur' }
  };

  function renderLegend() {
    if (!els.legend) return;
    const an = els.aktiveEbenen?.() || new Set(['regen']);
    const teile = [];

    if (an.has('regen')) {
      teile.push(`<span class="lg-eintrag"><span class="lg-bar"></span>
        <span class="lg-label">Regen: leicht → stark</span></span>`);
    }
    for (const [id, l] of Object.entries(LEGENDE)) {
      if (!an.has(id)) continue;
      teile.push(`<span class="lg-eintrag">
        <span class="lg-punkt" style="background:${l.farbe}"></span>
        <span class="lg-label">${l.text}</span></span>`);
    }
    els.legend.innerHTML = teile.join('');
    els.legend.hidden = !teile.length;
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
  /* PNG-Kodierung ist teuer. Beim Abspielen kommt dieselbe Stunde mehrfach
     dran (vier Viertelstunden-Schritte je Stunde), und beim zweiten Durchlauf
     ohnehin alles noch einmal. Ein kleiner Zwischenspeicher je Stunde und
     Ebenen-Kombination macht daraus eine einzige Kodierung. */
  const fcBilder = new Map();
  let fcZaehler = 0;                 // damit veraltete Bilder nicht nachträglich landen
  /* Die Rasterkennung gehört in den Schlüssel: Nach Zoomen oder Verschieben
     lädt die App ein neues Raster mit anderem Ausschnitt. Ein Bild des alten
     Rasters unter gleicher Stunde wäre sonst ein Treffer — und würde auf die
     neuen Eckkoordinaten gespannt, also die falsche Gegend zeigen. */
  const fcSchluessel = (h, ebenen) => `${Forecast.stamp()}|${h}|${[...ebenen].sort().join(',')}`;
  function leereNowcastSpeicher() {
    for (const u of rvBilder.values()) { try { URL.revokeObjectURL(u); } catch {} }
    rvBilder.clear();
  }

  function leereBildSpeicher() {
    // Blob-Adressen belegen Speicher, bis sie ausdrücklich freigegeben werden
    for (const u of fcBilder.values()) { try { URL.revokeObjectURL(u); } catch {} }
    fcBilder.clear();
  }

  /* Die erste Runde des Abspielens war die zäheste: Dort wird jedes Bild
     erstmalig kodiert. Deshalb die Stunden, die der Abspielknopf durchläuft,
     schon vorher in Leerlaufzeiten erzeugen — eine je Aufruf, damit nichts
     hakt. Läuft der Browser ohne requestIdleCallback, tut es ein Timer. */
  function vorwaermen(stunden, ebenen) {
    if (!Forecast.ready() || !ebenen?.size) return;
    const offen = stunden.filter(h => !fcBilder.has(fcSchluessel(h, ebenen)));
    if (!offen.length) return;
    /* Bewusst ein einfacher Timer statt requestIdleCallback: Der
       Leerlauf-Rückruf wird in Hintergrundfenstern ausgesetzt, und dann
       bliebe das Vorwärmen liegen — also genau dann, wenn man die Karte
       nach dem Zurückkehren zuerst antippt. 250 ms Abstand sind weit genug
       auseinander, dass eine Kodierung kein Wischen ins Stocken bringt. */
    const ruhig = (f) => setTimeout(f, 250);
    const naechstes = () => {
      const h = offen.shift();
      if (h == null) return;
      const bild = Forecast.frame(h, ebenen);
      if (bild) {
        bild.toBlob((blob) => {
          if (!blob) return;
          if (fcBilder.size > 120) leereBildSpeicher();
          fcBilder.set(fcSchluessel(h, ebenen), URL.createObjectURL(blob));
        }, 'image/png');
      }
      if (offen.length) ruhig(naechstes);
    };
    ruhig(naechstes);
  }

  /** Bild auf die Karte legen — Quelle anlegen oder austauschen. */
  function fcAnzeigen(url) {
    const ecken = Forecast.corners();
    if (!map.getSource('fc')) {
      map.addSource('fc', { type: 'image', url, coordinates: ecken });
      map.addLayer({ id: 'fc-layer', type: 'raster', source: 'fc',
        paint: { 'raster-opacity': 0.95, 'raster-resampling': 'linear' } }, unterBeschriftung());
    } else {
      map.getSource('fc').updateImage({ url, coordinates: ecken });
    }
    map.setLayoutProperty('fc-layer', 'visibility', 'visible');
  }

  function showForecast(hourIndex, ebenen) {
    if (!ready || !map || !Forecast.ready()) return false;

    const key = fcSchluessel(hourIndex, ebenen);
    const fertig = fcBilder.get(key);
    if (fertig) {
      fcAnzeigen(fertig);
      setRadarVisible(false);
      els.empty.hidden = true;
      return true;
    }

    const bild = Forecast.frame(hourIndex, ebenen);
    if (!bild) return false;

    /* Blob statt Daten-Adresse: Base64 bläht das PNG um ein Drittel auf, und
       das Gerät muss die Zeichenkette bei jedem Schritt erst zurückrechnen.
       Bilder von 90 kB als Text, mehrfach je Sekunde — auf dem Telefon ist
       das der Unterschied zwischen flüssig und gar nicht.

       Bild- statt Canvas-Quelle bleibt es trotzdem: Letztere lieferte je nach
       Gerät eine schwarze Fläche, weil MapLibre das Canvas im falschen
       Moment ausliest. */
    const laufendeNr = ++fcZaehler;
    bild.toBlob((blob) => {
      if (!blob) return;
      /* Aufheben immer — auch wenn der Finger inzwischen weiter ist. Sonst
         wäre beim Ziehen kein einziges Bild je im Speicher gelandet, weil
         jeder Rückruf von einem neueren überholt wird. Nur das Anzeigen
         bleibt dem jüngsten Bild vorbehalten. */
      const url = URL.createObjectURL(blob);
      if (fcBilder.size > 120) leereBildSpeicher();
      fcBilder.set(key, url);
      if (laufendeNr === fcZaehler) fcAnzeigen(url);
    }, 'image/png');

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

  /** Nowcast für einen Zeitpunkt zeigen. Gibt zurück, ob es geklappt hat. */
  function zeigeNowcast(zeitMs) {
    if (!rvMoeglich(zeitMs)) { rvAktiv = false; return false; }
    rvAktiv = true;
    // Grobe Ebenen ausblenden — der Nowcast ist genauer als beides
    if (map?.getLayer('fc-layer')) map.setLayoutProperty('fc-layer', 'visibility', 'none');
    if (sichtbaresBild >= 0 && map?.getLayer(layerId(sichtbaresBild))) {
      map.setPaintProperty(layerId(sichtbaresBild), 'raster-opacity', 0);
      sichtbaresBild = -1;
    }
    fcVisible = false;
    ladeDwdBild(zeitMs);
    if (map?.getLayer('dwd-layer')) map.setPaintProperty('dwd-layer', 'raster-opacity', 0.92);
    if (els.sharp) { els.sharp.hidden = false; els.sharp.textContent = 'DWD 1 km · 5 Min.'; }
    return true;
  }

  /** Bilder des Nowcasts still vorladen, damit das Abspielen flüssig läuft. */
  function nowcastVorwaermen() {
    const zeiten = rvZeiten();
    if (!zeiten.length) return;
    let i = 0;
    const naechstes = () => {
      if (i >= zeiten.length) return;
      const t = zeiten[i++];
      ladeDwdBild(t).finally(() => setTimeout(naechstes, 120));
    };
    setTimeout(naechstes, 400);
  }

  return { init, load, setCenter, play, pause, toggle, show, isPlaying,
           showForecast, showRadar, updateLabels, frameTimes, showAt, lastMeasured,
           leereBildSpeicher, vorwaermen,
           zeigeNowcast, nowcastVorwaermen, rvZeiten, rvMoeglich, leereNowcastSpeicher,
           get nowcastAktiv() { return rvAktiv; },
           updateLegend: renderLegend,
           get map() { return map; } };
})();
