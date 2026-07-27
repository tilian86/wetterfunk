/* Wetterfunk — Cloudflare Worker
   Zwei Aufgaben:
     1. /rss?url=…  holt RSS-Feeds (der Browser darf das wegen CORS nicht selbst)
     2. /ai         reicht Anfragen an die Anthropic-API weiter, damit der
                    API-Schlüssel serverseitig bleibt und nicht im Browser liegt

   Einrichten:
     wrangler deploy
     wrangler secret put ANTHROPIC_API_KEY
   Danach die Worker-Adresse in den App-Einstellungen eintragen.
*/

// Nur diese Absender dürfen den Worker nutzen. Eigene Adresse ergänzen.
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
  'rss.sueddeutsche.de',
  'www.faz.net',
  'www.spiegel.de'
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

    // ── Anthropic-API weiterreichen ──────────────────────────
    if (url.pathname === '/ai' && request.method === 'POST') {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'ANTHROPIC_API_KEY ist im Worker nicht gesetzt' }, 500, origin);
      }
      const body = await request.text();

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body
      });

      return new Response(await res.text(), {
        status: res.status,
        headers: { ...cors(origin), 'content-type': 'application/json' }
      });
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
