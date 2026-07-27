#!/usr/bin/env bash
# Wetterfunk — Auslieferung vorbereiten
#
# GitHub Pages lässt Browser Dateien 10 Minuten zwischenspeichern
# (cache-control: max-age=600). Ohne Versionsmarke holt sich ein Gerät
# nach einem Update das neue index.html, aber noch das alte app.js —
# und die App bricht auseinander. Dieses Skript zählt die Marke an allen
# eingebundenen Dateien hoch und hält den Service Worker im Gleichschritt.
#
# Aufruf:  ./release.sh   (danach committen und pushen)

set -euo pipefail
cd "$(dirname "$0")"

alt=$(grep -oE 'js/app\.js\?v=[0-9]+' index.html | grep -oE '[0-9]+$' || echo 0)
neu=$((alt + 1))

# Versionsmarke an allen lokalen Skripten, Stilen und dem Manifest
perl -0pi -e "s{(href=\"(?:css|vendor)/[a-z0-9.-]+\.css)(\?v=\d+)?\"}{\$1?v=$neu\"}g" index.html
perl -0pi -e "s{(src=\"(?:js|vendor)/[a-z0-9.-]+\.js)(\?v=\d+)?\"}{\$1?v=$neu\"}g" index.html
perl -0pi -e "s{(href=\"manifest\.webmanifest)(\?v=\d+)?\"}{\$1?v=$neu\"}g" index.html

# Service-Worker-Cache mitziehen, sonst liefert er die alte Hülle aus
perl -0pi -e "s/wetterfunk-v\d+/wetterfunk-v$neu/" sw.js

echo "Version $alt → $neu"
grep -oE '(js|css|vendor)/[a-z0-9.-]+\.(js|css)\?v=[0-9]+' index.html | sed 's/^/  /'
grep -oE "wetterfunk-v[0-9]+" sw.js | head -1 | sed 's/^/  sw: /'
