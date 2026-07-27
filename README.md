# Wetterfunk

Wetter-App für den iOS-Homescreen. Kein Konto, keine Tracker, keine Cookies.
Alles läuft im Browser; der Standort verlässt das Gerät nur als Koordinate an die Wetterdienste.

## Was drin ist

| Bereich | Quelle |
|---|---|
| Vorhersage (10 Tage, 48 Std., 15-Min-Regen) | Open-Meteo, automatisch bestes Modell — in Deutschland **DWD ICON-D2** (2 km) |
| Modellvergleich | ICON-D2, ICON-EU, ECMWF, GFS — zeigt, ab wann die Modelle uneinig werden |
| Regenradar | RainViewer, animiert: letzte 2 Std. + 30-Min-Prognose |
| Unwetterwarnungen | Deutscher Wetterdienst, amtlich |
| Luftqualität & Pollen | Open-Meteo Air Quality (CAMS) |
| Karte | CARTO / OpenStreetMap |
| Webcams | selbst eingetragene Bild-Adressen |
| Gesprochener Wetterbericht | Claude API + Systemstimme des Geräts |
| Nachrichtenlage | SWR + tagesschau (RSS), sortiert von Claude |

Live: **https://tilian86.github.io/wetterfunk/**

## Kein API-Schlüssel

Wetter und Radar laufen komplett ohne Einrichtung.

Wetterbericht und Nachrichten werden **auf dem Mac von der Claude-CLI geschrieben** und
laufen damit über das Max-Abo — kein API-Schlüssel, keine Zusatzkosten. Der Weg:

```
Browser  →  Cloudflare Worker  →  Tailscale Funnel  →  Mac-Bridge  →  Claude-CLI
```

Genutzt wird dieselbe Bridge wie bei Sprechfunk (`~/Projects/apps/sprechfunk/bridge/`,
LaunchAgent auf Port 8790). Sie ist generisch: `POST /generate` mit `{model, system, user, effort}`.

**Voraussetzung: der Mac läuft und ist online.** Ist er aus, sagt die App das klar —
es gibt bewusst keinen kostenpflichtigen Ausweichweg.

## Lokal starten

```bash
python3 -m http.server 8099
```

## Auf dem iPhone ablegen

Seite in Safari öffnen → Teilen → **Zum Home-Bildschirm**. Danach startet sie
ohne Browserleiste im Vollbild.

## Worker

Läuft unter `https://wetterfunk.florian-s-thiel.workers.dev` und macht zweierlei:
`/rss?url=…` holt Feeds (der Browser darf das wegen CORS nicht selbst) und
`/ai` reicht Textanfragen an die Bridge weiter.

```bash
cd worker
wrangler deploy
wrangler secret put BRIDGE_URL      # https://macbook-pro.<tailnet>.ts.net
wrangler secret put BRIDGE_SECRET   # gleicher Wert wie in bridge/secret.txt
```

Neue Absender müssen in `ALLOWED_ORIGINS`, neue Feeds in `ALLOWED_FEED_HOSTS` —
sonst wäre der Worker ein offener Proxy.

## Aufbau

```
index.html            Aufbau der Seite
css/style.css         Design, Wetterstimmungen, Animationen
js/app.js             Daten laden, Rendern, Ortswahl
js/icons.js           Wettersymbole (eigene SVGs) + WMO-Codes
js/radar.js           Leaflet + RainViewer
js/briefing.js        Gesprochener Wetterbericht
js/news.js            Nachrichtenlage
sw.js                 Service Worker (Programmhülle offline)
worker/               Cloudflare Worker: RSS-Proxy + API-Weiterleitung
vendor/               Leaflet (lokal, damit kein CDN mitliest)
```
