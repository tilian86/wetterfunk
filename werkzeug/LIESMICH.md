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
