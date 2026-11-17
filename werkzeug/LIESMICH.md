# Warngebiete neu bauen

`regionen/*.json` enthält die Umrisse der Warngebiete für Österreich,
Slowenien, Kroatien und Italien. Daraus bestimmt die App, in welchem
Warngebiet ein Ort liegt — MeteoAlarm liefert nämlich nur Gebietsnamen,
keine Grenzen.

Die Dateien liegen fertig im Verzeichnis und ändern sich fast nie. Neu
bauen muss man sie nur, wenn ein Land seine Warngebiete umschneidet:

```bash
cd werkzeug
python3 meer.py     # Maske "nah an der Adria" (braucht numpy, shapely, matplotlib)
python3 bau.py      # Umrisse je Land -> ../regionen/*.json
```

`bau.py` erwartet `gebiete.json` daneben — die Liste der aktuellen
Warngebietsnamen je Land. Die zieht man sich aus den MeteoAlarm-Feeds:
`https://feeds.meteoalarm.org/api/v1/warnings/feeds-<land>`.

Grenzen: geoBoundaries (CC BY 4.0), auf 1/1000 Grad gerundet und
delta-kodiert. Die Zuordnung der kroatischen Gespanschaften auf die sieben
Vorhersageregionen des DHMZ und die slowenischen Landesviertel stehen als
Tabellen oben in `bau.py`.

## messung/ — Tagessymbol und Sonnenstunden nachmessen

Vergleicht die Vorhersage der letzten drei Jahre (Open-Meteo Historical
Forecast) mit den DWD-Messungen (Bright Sky). Daraus stammen die Schwellen
in `daySymbol()` und die Eichkurve `sonneGeeicht()` in `js/app.js`.

```bash
cd werkzeug/messung
python3 symbol_messung.py               # Regensymbol gegen gemessene Sonne
python3 symbol_messung.py --stuttgart   # Gegenprobe am Ort der Sonnen-Station
python3 sonne_eichung.py --stuttgart    # Fehler der Sonnenstunden, roh und geeicht
python3 trocken_klassen.py              # trockene Tage je Sonnenanteil
python3 regen_phasen.py                 # Regen-Rat und Regenphasen gegen den Regenmesser
```

`regen_phasen.py` (17.11.2026) vergleicht die Viertelstundenwerte des
Modells mit den Zehn-Minuten-Werten des Regenmessers Rottenburg-Kiebingen.
Daraus stammen zwei Regeln: Eine einzelne trockene Viertelstunde trennt
keine Regenphasen (Worker, `regenLage`), und der Rat richtet sich auch nach
der Regensumme der Stunde ringsum (`stundenStaerke()` in `js/app.js`). Die
Messwerte muss man vorher von Hand holen — der Weg steht im Kopf der Datei.

Wichtig: Sonnenschein misst der DWD nur an wenigen Stationen. Für Tübingen
liefert Bright Sky die Werte von Stuttgart-Schnarrenberg (36 km). Deshalb
jede Schwelle auch mit `--stuttgart` prüfen — dort passen Vorhersage und
Messung zum selben Ort. Abrufe landen in `cache/` (nicht im Repo, ~35 MB).
