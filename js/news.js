/* Wetterfunk — Nachrichtenlage
   Holt RSS-Feeds von lokal bis weltweit, lässt sie von Claude nach Wichtigkeit
   ordnen und zeigt sie hierarchisch. Feeds brauchen wegen CORS den Worker;
   nur der SWR liefert direkt an den Browser aus. */

const News = (() => {
'use strict';

const DEFAULT_PROXY = 'https://wetterfunk.florian-s-thiel.workers.dev';

/** Ebenen von nah nach fern. `direct: true` = ohne Worker abrufbar. */
const FEEDS = [
  { level: 'lokal', name: 'SWR Tübingen', direct: true,
    url: 'https://www.swr.de/~rss/swraktuell/baden-wuerttemberg/tuebingen/index.xml' },
  { level: 'regional', name: 'SWR Baden-Württemberg', direct: true,
    url: 'https://www.swr.de/~rss/swraktuell/baden-wuerttemberg/index.xml' },
  { level: 'bundesweit', name: 'tagesschau Inland', direct: false,
    url: 'https://www.tagesschau.de/inland/index~rss2.xml' },
  { level: 'weltweit', name: 'tagesschau Ausland', direct: false,
    url: 'https://www.tagesschau.de/ausland/index~rss2.xml' }
];

const LEVEL_LABEL = {
  lokal: 'Tübingen', regional: 'Baden-Württemberg',
  bundesweit: 'Deutschland', weltweit: 'International'
};
const LEVEL_ORDER = ['lokal', 'regional', 'bundesweit', 'weltweit'];

const LS = { count: 'wf.newsN', cache: 'wf.newsCache' };

let host = null, items = [], busy = false;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const proxyUrl = () => (store.get('wf.proxy', '') || DEFAULT_PROXY).replace(/\/+$/, '');
const model = () => store.get('wf.model', 'claude-opus-5');
const count = () => store.get(LS.count, 3);

// ══ Feeds holen ════════════════════════════════════════════
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß'
};

const strip = (s = '') => s
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    if (e[0] === '#') return String.fromCharCode(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ' ';
  })
  .replace(/\s+/g, ' ')
  .trim();

/** Ein RSS/Atom-Dokument in einfache Einträge zerlegen. */
function parseFeed(xml, feed) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  return [...doc.querySelectorAll('item, entry')].slice(0, 12).map(n => {
    const pick = (sel) => n.querySelector(sel)?.textContent || '';
    const link = pick('link') || n.querySelector('link')?.getAttribute('href') || '';
    const when = pick('pubDate') || pick('published') || pick('updated');
    return {
      level: feed.level,
      source: feed.name,
      title: strip(pick('title')),
      teaser: strip(pick('description') || pick('summary') || pick('content')).slice(0, 260),
      link: link.trim(),
      at: when ? new Date(when).getTime() : 0
    };
  }).filter(x => x.title);
}

async function fetchFeeds() {
  return Promise.all(FEEDS.map(async (f) => {
    const url = `${proxyUrl()}/rss?url=${encodeURIComponent(f.url)}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      return { feed: f, items: parseFeed(await res.text(), f) };
    } catch (e) {
      console.warn('Feed', f.name, e);
      return { feed: f, items: [], failed: true };
    }
  }));
}

// ══ Auswerten lassen ═══════════════════════════════════════
/** JSON aus einer Antwort ziehen, auch wenn Text drumherum steht. */
function extractJson(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : s;
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Keine verwertbare Antwort');
  return JSON.parse(raw.slice(a, b + 1));
}

async function rank(pool, n) {
  const list = pool.map((x, i) =>
    `[${i}] (${x.level}, ${x.source}${x.at ? ', ' + new Date(x.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''})\n` +
    `${x.title}\n${x.teaser}`
  ).join('\n\n');

  const system =
`Du bist Nachrichtenredakteur für eine private App. Du bekommst Meldungen aus vier Ebenen: lokal (Tübingen), regional (Baden-Württemberg), bundesweit und weltweit.

Wähle die ${n} wichtigsten aus, damit man mit einem Blick Bescheid weiß.

Regeln:
- Wichtig heißt: betrifft viele Menschen, hat Folgen, ist neu. Nicht wichtig: Kurioses, Prominente, Sport-Randnotizen, Werbliches.
- Nicht jede Ebene muss vorkommen. Wenn lokal nichts Erwähnenswertes passiert ist, lass die Ebene weg.
- Fasse zusammen, schreibe nicht ab. Eigene, knappe Schlagzeile.
- Keine Dopplungen: dieselbe Sache aus mehreren Quellen nur einmal.
- "nr" ist immer die Nummer aus der Liste, damit der Verweis stimmt.
- Erfinde nichts. Nur was in den Meldungen steht.

Antworte ausschließlich mit diesem JSON, ohne Text davor oder danach, ohne Code-Zaun:
{"lage":"ein Satz zur Gesamtlage","meldungen":[{"nr":0,"ebene":"lokal|regional|bundesweit|weltweit","titel":"eigene Schlagzeile, höchstens neun Wörter","kern":"ein Satz mit dem Wesentlichen","relevanz":"sehr kurz, warum das wichtig ist"}]}`;

  // Gleicher Weg wie beim Wetterbericht (Mac oder API, je nach Einstellung)
  const out = await Briefing.ask(
    system,
    `Jetzt ist ${new Date().toLocaleString('de-DE')}.\n\nHier sind die Meldungen:\n\n${list}`,
    model()
  );
  return { parsed: extractJson(out.text), via: out.via };
}

// ══ Ablauf ═════════════════════════════════════════════════
async function load() {
  if (busy) return;
  busy = true;
  setBusy(true);

  try {
    const results = await fetchFeeds();
    const pool = results.flatMap(r => r.items)
      .filter(x => !x.at || Date.now() - x.at < 3 * 864e5)      // nichts älter als 3 Tage
      .sort((a, b) => b.at - a.at)
      .slice(0, 60);

    const failed = results.filter(r => r.failed).map(r => r.feed.name);

    if (!pool.length) {
      $('#newsResult').innerHTML =
        `<p class="empty">Keine Meldungen abrufbar. Läuft der Worker?</p>`;
      return;
    }

    const out = await rank(pool, count());
    items = (out.parsed.meldungen || [])
      .map(m => ({ ...m, src: pool[m.nr] }))
      .filter(m => m.src);

    if (!items.length) throw new Error('Keine Meldungen ausgewählt');

    render(out.parsed.lage, failed, out.via);
    store.set(LS.cache, { at: Date.now(), lage: out.parsed.lage, items });
  } catch (e) {
    console.error(e);
    host.toast(`Nachrichten fehlgeschlagen: ${e.message}`.slice(0, 120));
  } finally {
    busy = false;
    setBusy(false);
  }
}

// ══ Darstellung ════════════════════════════════════════════
function setBusy(on) {
  const b = $('#newsGo');
  if (!b) return;
  b.disabled = on;
  b.classList.toggle('is-busy', on);
  $('#newsGoLabel').textContent = on ? 'Wird gelesen…' : 'Nachrichtenlage laden';
}

const grouped = () => LEVEL_ORDER
  .map(lv => ({ lv, list: items.filter(m => m.ebene === lv) }))
  .filter(g => g.list.length);

function render(lage, failed, via) {
  $('#newsResult').innerHTML = `
    <p class="news-lage">${lage}</p>
    ${grouped().map(g => `
      <div class="news-group">
        <h3 class="news-level">${LEVEL_LABEL[g.lv]}</h3>
        ${g.list.map(m => `
          <a class="news-item" href="${m.src.link}" target="_blank" rel="noopener noreferrer">
            <span class="news-title">${m.titel}</span>
            <span class="news-kern">${m.kern}</span>
            <span class="news-meta"><b>${m.relevanz}</b> · ${m.src.source}${
              m.src.at ? ' · ' + new Date(m.src.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
          </a>`).join('')}
      </div>`).join('')}
    <div class="news-foot">
      <button class="bf-speak" id="newsSpeak">
        <svg viewBox="0 0 24 24" class="ico-speak"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19.5 5.5a9 9 0 0 1 0 13"/></svg>
        <svg viewBox="0 0 24 24" class="ico-stop"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
        <span id="newsSpeakLabel">Vorlesen</span>
      </button>
      <span class="bf-cost"><i>${via === 'api' ? 'über API' : 'über Max-Abo · keine Zusatzkosten'}</i></span>
    </div>
    ${failed?.length ? `<p class="news-hint">Nicht erreichbar: ${failed.join(', ')}.</p>` : ''}`;

  $('#newsSpeak').addEventListener('click', speak);
  setSpeaking(false);
}

// ══ Vorlesen ═══════════════════════════════════════════════
let speaking = false;

const speechText = () => grouped()
  .map(g => `${LEVEL_LABEL[g.lv]}. ` + g.list.map(m => `${m.titel}. ${m.kern}`).join(' '))
  .join(' ');

function speak() {
  if (!('speechSynthesis' in window) || !items.length) return;
  if (speaking) { speechSynthesis.cancel(); setSpeaking(false); return; }

  speechSynthesis.cancel();
  const voices = speechSynthesis.getVoices().filter(v => v.lang?.toLowerCase().startsWith('de'));
  const voice = voices.find(v => /premium|enhanced|siri/i.test(v.name)) || voices[0] || null;

  const chunks = speechText().split(/(?<=[.!?])\s+/).filter(Boolean);
  chunks.forEach((s, n) => {
    const u = new SpeechSynthesisUtterance(s);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'de-DE';
    if (n === chunks.length - 1) u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    speechSynthesis.speak(u);
  });
  setSpeaking(true);
}

function setSpeaking(on) {
  speaking = on;
  $('#newsSpeak')?.classList.toggle('is-speaking', on);
  const l = $('#newsSpeakLabel');
  if (l) l.textContent = on ? 'Stopp' : 'Vorlesen';
}

// ══ Start ══════════════════════════════════════════════════
function init(hostApi) {
  host = hostApi;

  const n = count();
  $('#newsCount').innerHTML = [3, 10].map(v =>
    `<button class="chip len${v === n ? ' on' : ''}" data-n="${v}">Top ${v}</button>`).join('');
  $$('#newsCount .chip').forEach(b => b.addEventListener('click', () => {
    store.set(LS.count, +b.dataset.n);
    $$('#newsCount .chip').forEach(x => x.classList.toggle('on', x === b));
  }));

  $('#newsGo').addEventListener('click', load);

  // Letzten Stand zeigen, solange er frisch genug ist
  const c = store.get(LS.cache, null);
  if (c?.items?.length && Date.now() - c.at < 36e5) {
    items = c.items;
    render(c.lage, []);
    $('#newsResult').insertAdjacentHTML('afterbegin',
      `<p class="news-hint">Stand ${new Date(c.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</p>`);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && speaking) { speechSynthesis.cancel(); setSpeaking(false); }
  });
}

return { init };
})();
