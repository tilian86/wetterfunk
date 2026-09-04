/* Amtliche Warnungen jenseits der deutschen Grenze
   ─────────────────────────────────────────────────
   In Deutschland warnt der DWD, und die App holt seine Meldungen direkt.
   Fährt man über die Grenze, schweigt der DWD — ausgerechnet dort, wo man
   das Wetter am wenigsten kennt.

   MeteoAlarm füllt die Lücke. Es ist kein eigener Wetterdienst, sondern
   das gemeinsame Sprachrohr der nationalen Dienste: Was hier ankommt,
   stammt von GeoSphere Austria, vom slowenischen ARSO oder vom kroatischen
   DHMZ — die amtliche Warnung des Landes, nur einheitlich verpackt. Das
   ist dort genau das, was der DWD hier ist.

   Zwei Genauigkeiten, je nachdem, was vorliegt:

   · Für Österreich, Slowenien, Kroatien und Italien liegen die Umrisse der
     Warngebiete in `regionen/*.json`. Aus den Koordinaten wird bestimmt, in
     welchem Bezirk man wirklich steht — 94 Bezirke in Österreich, nicht
     „irgendwo in Österreich“.
   · In den übrigen 31 Ländern gibt es die Warnungen des ganzen Landes, mit
     Angabe des Gebiets. Weniger genau, aber immer noch amtlich.

   Die Umrisse stammen von geoBoundaries (CC BY 4.0), auf 1/1000 Grad
   gerundet (gut 100 Meter) und mit Deltas gespeichert. Zusammen sind das
   weniger Bytes als ein einzelnes Foto, und geladen wird immer nur das
   Land, in dem man gerade steht. */

(function () {
  'use strict';

  /* Versionsmarke aus dem eigenen Skript-Tag lesen. GitHub Pages lässt
     Dateien zehn Minuten im Browser liegen; ohne die Marke bekäme ein Gerät
     nach einer Korrektur der Umrisse noch tagelang die alten. */
  const MARKE = (document.currentScript?.src.match(/[?&]v=(\d+)/) || [, '1'])[1];

  const MIT_UMRISS = ['AT', 'SI', 'HR', 'IT'];
  const speicher = {};                    // je Land einmal laden, dann behalten

  /** Punkte sind als Deltas in 1/1000 Grad abgelegt — spart rund zwei
      Drittel gegenüber ausgeschriebenen Koordinaten. */
  function entpacke(flach) {
    const punkte = new Array(flach.length / 2);
    let x = flach[0], y = flach[1];
    punkte[0] = [x / 1000, y / 1000];
    for (let i = 2, k = 1; i < flach.length; i += 2, k++) {
      x += flach[i]; y += flach[i + 1];
      punkte[k] = [x / 1000, y / 1000];
    }
    return punkte;
  }

  /** Strahlenverfahren: Wie oft kreuzt ein Strahl nach rechts den Rand?
      Ungerade heißt drinnen. */
  function imRing(lon, lat, ring) {
    let drin = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if ((y1 > lat) !== (y2 > lat) &&
          lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) drin = !drin;
    }
    return drin;
  }

  /** Die Meeresmaske ist ein Bitmuster über der Adria: ein Bit je Zelle von
      zwei Hundertstel Grad, gesetzt, wenn dort binnen 25 km offenes Meer
      liegt. Zwölf Kilobyte für die Frage „bin ich an der Küste?“ — sonst
      bekäme man am Plitvicer See Warnungen für den Seegang. */
  function amWasser(maske, lat, lon) {
    if (!maske) return true;
    const ix = Math.floor((lon - maske.w) / maske.schritt);
    const iy = Math.floor((lat - maske.s) / maske.schritt);
    if (ix < 0 || iy < 0 || ix >= maske.nx || iy >= maske.ny) return false;
    if (!maske._bytes) {
      const roh = atob(maske.bits);
      const b = new Uint8Array(roh.length);
      for (let i = 0; i < roh.length; i++) b[i] = roh.charCodeAt(i);
      maske._bytes = b;
    }
    const n = iy * maske.nx + ix;
    return (maske._bytes[n >> 3] & (128 >> (n & 7))) !== 0;
  }

  async function ladeLand(cc) {
    const k = cc.toLowerCase();
    if (speicher[k] !== undefined) return speicher[k];
    try {
      const res = await fetch(`regionen/${k}.json?v=${MARKE}`);
      speicher[k] = res.ok ? await res.json() : null;
    } catch { speicher[k] = null; }
    return speicher[k];
  }

  /** Alle Warngebiete, in denen dieser Punkt liegt. Meist genau eines; an
      Stadtgrenzen können es zwei sein, an der Küste kommt das zugehörige
      Seegebiet dazu.

      Zurück kommen die Gebiete selbst, nicht bloß ihre Namen: Angezeigt wird
      der deutsche (`n`), gefiltert wird mit den Namen, unter denen das Land
      selbst meldet (`f`). Wien warnt zum Beispiel je Bezirk, hat aber eine
      Stadtgrenze — ein Gebiet, dreiundzwanzig Meldenamen. */
  async function treffer(cc, lat, lon) {
    const d = await ladeLand(cc);
    if (!d) return null;

    // Slowenien meldet nicht nach Bezirken, sondern für Landesviertel.
    if (d.kerne) {
      const [w, s, o, n] = d.bb;
      if (lon < w || lon > o || lat < s || lat > n) return [];
      if (!d.umriss.some(r => imRing(lon, lat, entpacke(r)))) return [];
      let bester = null, beste = Infinity;
      for (const g of d.kerne) {
        const dx = (g.kern[0] - lon) * Math.cos(lat * Math.PI / 180);
        const dy = g.kern[1] - lat;
        const e = dx * dx + dy * dy;
        if (e < beste) { beste = e; bester = g; }
      }
      const aus = bester ? [bester] : [];
      const [sw, ss, so, sn] = d.see.bb;
      if (lon >= sw && lon <= so && lat >= ss && lat <= sn && amWasser(d.meer, lat, lon)) {
        aus.push(d.see);
      }
      return aus;
    }

    const gefunden = [];
    for (const g of d.gebiete) {
      const [w, s, o, n] = g.bb;
      if (lon < w || lon > o || lat < s || lat > n) continue;
      if (g.see) {
        if (amWasser(d.meer, lat, lon)) gefunden.push(g);
      } else if (g.p.some(r => imRing(lon, lat, entpacke(r)))) {
        gefunden.push(g);
      }
    }
    if (gefunden.length) return gefunden;

    /* Am Seeufer und an der Küste schneidet die Vereinfachung der Umrisse
       schon mal ein paar hundert Meter ab. Dann gilt das nächstgelegene
       Gebiet, solange es nicht weiter als 20 km weg ist. */
    let nah = null, beste = Infinity;
    const cos = Math.cos(lat * Math.PI / 180);
    for (const g of d.gebiete) {
      if (g.see) continue;
      for (const r of g.p) {
        for (const [x, y] of entpacke(r)) {
          const dx = (x - lon) * cos, dy = y - lat;
          const e = dx * dx + dy * dy;
          if (e < beste) { beste = e; nah = g; }
        }
      }
    }
    return (Math.sqrt(beste) * 111 < 20 && nah) ? [nah] : [];
  }

  /** Nur die Anzeigenamen — zum Nachschauen und Prüfen. */
  const gebieteFuer = async (cc, lat, lon) =>
    (await treffer(cc, lat, lon))?.map(g => g.n) ?? null;

  const STUFE = { 2: 'Warnung (Gelb)', 3: 'Warnung (Orange)', 4: 'Unwetterwarnung (Rot)' };

  /* Wer im jeweiligen Land amtlich warnt. Steht hier fest, damit auch bei
     ruhiger Lage — wenn also gar keine Meldung kommt und niemand zu nennen
     wäre — der Name des Dienstes dastehen kann. Ohne den ist „nichts
     angezeigt“ nicht von „App kann das hier nicht“ zu unterscheiden. */
  const DIENSTE = {
    AT: 'GeoSphere Austria', SI: 'ARSO', HR: 'DHMZ', IT: 'Aeronautica Militare',
    HU: 'OMSZ', CH: 'MeteoSchweiz', FR: 'Météo-France', ES: 'AEMET', NL: 'KNMI',
    BE: 'KMI/IRM', LU: 'MeteoLux', CZ: 'ČHMÚ', PL: 'IMGW-PIB', SK: 'SHMÚ',
    DK: 'DMI', SE: 'SMHI', NO: 'MET Norway', FI: 'Ilmatieteen laitos',
    GR: 'HNMS', PT: 'IPMA', IE: 'Met Éireann', RO: 'ANM', BG: 'NIMH',
    RS: 'RHMZ Serbien', BA: 'FHMZ Bosnien', ME: 'ZHMS Montenegro',
    EE: 'Riigi Ilmateenistus', LV: 'LVĢMC', LT: 'LHMT', IS: 'Veðurstofa Íslands',
    MT: 'Malta Met Office', CY: 'Cyprus Met', MD: 'SHS Moldau', UA: 'UHMC',
    GB: 'Met Office'
  };

  /** Holt die Warnungen und bringt sie in dieselbe Form, in der die App die
      DWD-Meldungen anzeigt — so bleibt die Darstellung an einer Stelle. */
  async function warnungen(ort) {
    const cc = (ort?.country || '').toUpperCase();
    if (!cc || cc === 'DE') return null;

    let hier = null;
    if (MIT_UMRISS.includes(cc)) {
      hier = await treffer(cc, ort.lat, ort.lon);
      if (hier && !hier.length) return null;         // Punkt liegt nicht im Land
    }
    const gebiete = hier?.map(g => g.n) || null;
    const meldenamen = hier?.flatMap(g => g.f || [g.n]) || null;

    const proxy = (localStorage.getItem('wf.proxy') || '').replace(/^"|"$/g, '')
      || 'https://wetterfunk.florian-s-thiel.workers.dev';
    const p = new URLSearchParams({ land: cc });
    if (meldenamen) p.set('gebiete', meldenamen.join('|'));

    let d;
    try {
      const res = await fetch(`${proxy.replace(/\/+$/, '')}/auslandswarnungen?${p}`);
      d = await res.json();
      if (d.error) throw new Error(d.error);
    } catch (e) {
      console.warn('Auslandswarnungen:', e.message);
      return null;
    }

    const dienst = DIENSTE[cc] || d.warnungen?.find(w => w.sender)?.sender || '';
    return {
      fremd: true,
      time: d.stand,
      genau: !!gebiete,
      gebiete: gebiete || [],
      /* Das Land meldet unter eigenen Namen; hier steht der deutsche. */
      _namen: meldenamen,
      dienst,
      quelle: dienst ? `${dienst} über MeteoAlarm` : 'MeteoAlarm',
      fertig: (d.warnungen || []).map(w => ({
        /* Österreich und die Schweiz schreiben ihre Meldung selbst auf
           Deutsch — deren Wortlaut ist genauer als jede Übersetzung. Sonst
           steht nur die eingedeutschte Warnart da; der englische Titel
           („Yellow wind warning“) sagt nichts, was Stufe und Art nicht
           schon zeigen. */
        event: w.sprache === 'de' ? (w.event || w.artName) : w.artName,
        headline: w.headline,
        regionName: (gebiete
          ? [...new Set(w.gebiete.map(x => hier.find(g => (g.f || [g.n]).includes(x))?.n || x))]
          : w.gebiete).join(', '),
        description: w.description,
        instruction: w.instruction,
        start: w.start, end: w.end,
        level: w.stufe,
        stufeText: STUFE[w.stufe] || 'Warnung',
        /* Kroatien, Slowenien und Italien schicken ihren Fließtext nur auf
           Englisch. Art, Stufe und Zeitraum stehen trotzdem auf Deutsch —
           das ist das, was man im Vorbeifahren liest. */
        englisch: w.sprache === 'en'
      }))
    };
  }

  window.WF_AUSLAND = { warnungen, gebieteFuer };
})();
