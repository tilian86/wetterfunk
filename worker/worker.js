/* Wetterfunk — Cloudflare Worker
   Zwei Aufgaben:
     1. /rss?url=…  holt RSS-Feeds (der Browser darf das wegen CORS nicht selbst)
     2. /ai         reicht Textanfragen an die Mac-Bridge weiter, die sie über
                    die Claude-CLI beantwortet — läuft damit über das Max-Abo
                    statt über bezahlte API-Tokens. Kein API-Schlüssel nötig.

   Ist der Mac aus, meldet /ai das ehrlich zurück; es gibt bewusst keinen
   kostenpflichtigen Ausweichweg.

   Einrichten:
     wrangler deploy
     wrangler secret put BRIDGE_URL      # https://…ts.net
     wrangler secret put BRIDGE_SECRET   # gleiches Geheimnis wie in der Bridge
*/

// Nur diese Absender dürfen den Worker nutzen.
const ALLOWED_ORIGINS = [
  'https://tilian86.github.io',
  'http://localhost:8099'
];

// Feeds, die abgerufen werden dürfen — verhindert, dass der Worker
// zum offenen Proxy für beliebige Adressen wird.
const ALLOWED_FEED_HOSTS = [
  'www.swr.de',
  'www.tagesschau.de',
  'www.deutschlandfunk.de',
  'newsfeed.zeit.de',
  'rss.sueddeutsche.de'
];

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400'
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Origin nicht erlaubt' }, 403, origin);
    }

    // ── RSS-Feed weiterreichen ───────────────────────────────
    if (url.pathname === '/rss') {
      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'Parameter url fehlt' }, 400, origin);

      let t;
      try { t = new URL(target); } catch { return json({ error: 'Ungültige Adresse' }, 400, origin); }
      if (t.protocol !== 'https:' || !ALLOWED_FEED_HOSTS.includes(t.hostname)) {
        return json({ error: `Feed-Host nicht erlaubt: ${t.hostname}` }, 403, origin);
      }

      const res = await fetch(t.toString(), {
        headers: { 'user-agent': 'Wetterfunk/1.0 (privater Feed-Abruf)' },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (!res.ok) return json({ error: `Feed antwortet ${res.status}` }, 502, origin);

      return new Response(await res.text(), {
        headers: {
          ...cors(origin),
          'content-type': 'text/xml; charset=utf-8',
          'cache-control': 'public, max-age=300'
        }
      });
    }

    // ── Text über die Mac-Bridge erzeugen ────────────────────
    if (url.pathname === '/ai' && request.method === 'POST') {
      if (!env.BRIDGE_URL || !env.BRIDGE_SECRET) {
        return json({ error: 'Bridge ist im Worker nicht konfiguriert' }, 500, origin);
      }

      let req;
      try { req = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      if (!req?.system || !req?.user) {
        return json({ error: 'system und user werden gebraucht' }, 400, origin);
      }

      const base = env.BRIDGE_URL.replace(/\/+$/, '');
      const headers = { 'x-bridge-secret': env.BRIDGE_SECRET, 'content-type': 'application/json' };

      // Erst kurz anklopfen: ist der Mac wach und die CLI gesund?
      try {
        const ping = await withTimeout(fetch(base + '/ping', { headers }), 4000);
        if (!ping.ok) throw new Error('Bridge antwortet nicht');
        const pj = await ping.json().catch(() => ({}));
        if (pj.cli === false) {
          return json({ error: 'Claude-CLI auf dem Mac gerade nicht nutzbar (Login abgelaufen?)' }, 503, origin);
        }
      } catch {
        return json({ error: 'Mac nicht erreichbar — läuft er gerade?' }, 503, origin);
      }

      try {
        const res = await withTimeout(fetch(base + '/generate', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: req.model || 'claude-opus-5',
            system: req.system,
            user: req.user,
            effort: req.effort || 'low'
          })
        }), 60000);

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.text) {
          return json({ error: data.error || 'Bridge lieferte keine Antwort' }, 502, origin);
        }
        return json({ text: data.text }, 200, origin);
      } catch {
        return json({ error: 'Zeitüberschreitung bei der Bridge' }, 504, origin);
      }
    }

    return json({ error: 'Unbekannter Pfad', paths: ['/rss?url=…', '/ai'] }, 404, origin);
  }
};

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(origin), 'content-type': 'application/json' }
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}
