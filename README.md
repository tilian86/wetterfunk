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

Wetter und Radar funktionieren ohne jede Einrichtung. Wetterbericht und Nachrichten
brauchen einen Anthropic-API-Schlüssel.

## Lokal starten

```bash
python3 -m http.server 8099
```

## Auf dem iPhone ablegen

Seite in Safari öffnen → Teilen → **Zum Home-Bildschirm**. Danach startet sie
ohne Browserleiste im Vollbild.

## Wetterbericht und Nachrichten einrichten

Zwei Wege — der zweite ist sicherer:

**A) Schlüssel direkt im Browser**
API-Schlüssel von console.anthropic.com in *Wetterbericht → Einstellungen* eintragen.
Er liegt dann im localStorage dieses Geräts. Nachrichten liefern so nur die SWR-Feeds,
weil tagesschau keinen direkten Browser-Abruf erlaubt (CORS).

**B) Cloudflare Worker** *(empfohlen)*
Der Schlüssel bleibt auf dem Server, und alle Feeds funktionieren.

```bash
cd worker
wrangler deploy
wrangler secret put ANTHROPIC_API_KEY
```

Danach in `worker/worker.js` die eigene Adresse in `ALLOWED_ORIGINS` eintragen,
neu deployen und die Worker-URL in den App-Einstellungen unter *Proxy-Adresse* hinterlegen.

Kosten: ein Wetterbericht liegt bei rund 1–3 Cent mit Opus 5, deutlich darunter mit
Sonnet 5 oder Haiku 4.5. Die tatsächlichen Kosten stehen nach jedem Abruf unter dem Text.

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
