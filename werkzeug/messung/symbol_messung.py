#!/usr/bin/env python3
"""Tagessymbol nachmessen: Vorhersage (Open-Meteo, archivierte Läufe) gegen
gemessene Sonne/Regen der DWD-Station (Bright Sky). Nur Stadtkoordinaten."""
import json, os, sys, urllib.request, urllib.parse
from datetime import date, datetime, timedelta
from collections import defaultdict

STG = "--stuttgart" in sys.argv   # Gegenprobe: Vorhersage genau am Ort der Sonnen-Messstation
LAT, LON = (48.8281, 9.2000) if STG else (48.52, 9.06)
PRE = "s_" if STG else ""
MIX = "--roh" not in sys.argv
HIER = os.path.dirname(os.path.abspath(__file__))
ZEITRAEUME = [("2023-11-01", "2024-10-31"), ("2024-11-01", "2025-10-31"), ("2025-11-01", "2026-11-13")]


def holen(url, name):
    os.makedirs(os.path.join(HIER, "cache"), exist_ok=True)
    pfad = os.path.join(HIER, "cache", name)   # Zwischenspeicher, nicht im Repo
    if os.path.exists(pfad):
        return json.load(open(pfad))
    with urllib.request.urlopen(url, timeout=90) as r:
        d = json.load(r)
    json.dump(d, open(pfad, "w"))
    return d


def vorhersage(von, bis):
    q = urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON, "start_date": von, "end_date": bis,
        "hourly": "precipitation,weather_code,sunshine_duration",
        "daily": "sunrise,sunset,precipitation_sum", "timezone": "Europe/Berlin"})
    return holen("https://historical-forecast-api.open-meteo.com/v1/forecast?" + q, f"{PRE}vh_{von}_{bis}.json")


MODELLE = ["icon_d2", "icon_eu", "ecmwf_ifs025", "gfs_seamless", "ukmo_seamless", "meteofrance_seamless"]


def sonnenMix(von, bis):
    """Wie die App: Mittelwert der Sonnensekunden aus mindestens drei Modellen."""
    q = urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON, "start_date": von, "end_date": bis,
        "hourly": "sunshine_duration", "models": ",".join(MODELLE), "timezone": "Europe/Berlin"})
    H = holen("https://historical-forecast-api.open-meteo.com/v1/forecast?" + q, f"{PRE}mix_{von}_{bis}.json")["hourly"]
    aus = {}
    for i, t in enumerate(H["time"]):
        w = [H[f"sunshine_duration_{m}"][i] for m in MODELLE if H.get(f"sunshine_duration_{m}") and H[f"sunshine_duration_{m}"][i] is not None]
        if len(w) >= 3:
            aus[t] = (sum(w) / len(w), len(w))
    return aus


def messung(von, bis):
    """Stundenwerte der Station, monatsweise geholt."""
    aus = {}
    a = date.fromisoformat(von)
    ende = date.fromisoformat(bis) + timedelta(days=1)
    while a < ende:
        b = min(ende, (a.replace(day=1) + timedelta(days=32)).replace(day=1))
        q = urllib.parse.urlencode({"lat": LAT, "lon": LON, "date": a.isoformat(),
                                    "last_date": b.isoformat(), "tz": "Europe/Berlin"})
        d = holen("https://api.brightsky.dev/weather?" + q, f"{PRE}ms_{a}_{b}.json")
        for w in d["weather"]:
            aus[w["timestamp"][:13]] = w   # 2026-11-01T07
        a = b
    return aus


def tage():
    for von, bis in ZEITRAEUME:
        v = vorhersage(von, bis)
        m = messung(von, bis)
        mix = sonnenMix(von, bis)
        h, d = v["hourly"], v["daily"]
        jeTag = defaultdict(list)
        for i, t in enumerate(h["time"]):
            jeTag[t[:10]].append(i)
        for di, tag in enumerate(d["time"]):
            idx = [i for i in jeTag[tag] if 7 <= int(h["time"][i][11:13]) <= 20]
            if not idx or d["sunrise"][di] is None:
                continue
            auf = datetime.fromisoformat(d["sunrise"][di]).timestamp()
            unter = datetime.fromisoformat(d["sunset"][di]).timestamp()
            moeglich = 0
            for i in idx:
                e = datetime.fromisoformat(h["time"][i]).timestamp()
                moeglich += max(0, min(e, unter) - max(e - 3600, auf))
            if moeglich < 3600 or any(h["sunshine_duration"][i] is None for i in idx):
                continue
            roh = sum(h["sunshine_duration"][i] for i in idx)
            if MIX:
                if any(h["time"][i] not in mix for i in idx):
                    continue
                sonne = sum(mix[h["time"][i]][0] for i in idx)
            else:
                sonne = roh
            nass = [i for i in idx if (h["precipitation"][i] or 0) >= 0.1]
            tagRegen = sum(h["precipitation"][i] or 0 for i in idx)
            summe = d["precipitation_sum"][di] or 0
            mengen = defaultdict(float)
            for i in nass:
                mengen[h["weather_code"][i]] += h["precipitation"][i]
            top = max(mengen, key=mengen.get) if mengen else None
            # Messung
            ms, mr, mn, luecke = 0.0, 0.0, 0, False
            for i in idx:
                w = m.get(h["time"][i][:13])
                if not w or w.get("sunshine") is None:
                    luecke = True
                    break
                ms += w["sunshine"] * 60
                mr += w.get("precipitation") or 0
                mn += 1 if (w.get("precipitation") or 0) >= 0.1 else 0
            if luecke:
                continue
            yield dict(tag=tag, rohH=roh / 3600, anteil=min(1, sonne / moeglich), sonneH=sonne / 3600, hellH=moeglich / 3600,
                       nassAnteil=len(nass) / len(idx), nassN=len(nass), tagRegen=tagRegen, summe=summe, top=top,
                       mAnteil=min(1, ms / moeglich), mSonneH=ms / 3600, mRegen=mr, mNass=mn)



def familie(c):
    if c is None: return None
    if 51 <= c <= 55 or 61 <= c <= 65 or 80 <= c <= 82: return "regen"
    if c in (56, 57, 66, 67): return "gefrier"
    if 71 <= c <= 77 or c in (85, 86): return "schnee"
    if c >= 95: return "gewitter"
    return "trocken"


def nass(t):
    return (t["nassAnteil"] >= 0.2 or t["summe"] >= 1.5) and t["top"] is not None


def bildHeute(t):
    """Symbol, wie es die App heute zeichnet."""
    if nass(t):
        f = familie(t["top"])
        if f != "regen": return f
        if 80 <= t["top"] <= 82: return "sonne+regen"
        if t["anteil"] >= 0.54 and t["summe"] < 10: return "sonne+regen"
        return "regenwolke"
    a = t["anteil"]
    return "sonnig" if a >= 0.84 else "heiter" if a >= 0.70 else "wolkig" if a >= 0.54 else "trueb"


def med(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else float("nan")


alle = list(tage())
WAHR = 0.30
def zeile(name, g):
    if not g: return
    ok = sum(1 for t in g if t["mAnteil"] >= WAHR)
    print(f"  {name:34} {len(g):4} Tage | gemessen Sonne Median {med([t['mSonneH'] for t in g]):4.1f} h (Anteil {med([t['mAnteil'] for t in g]):.2f}) | >=30 % Sonne: {ok:3} = {ok/len(g):4.0%} | Tagregen gemessen Median {med([t['mRegen'] for t in g]):.1f} mm")


print(f"{len(alle)} Tage, {alle[0]['tag']} bis {alle[-1]['tag']}")
rf = [t for t in alle if nass(t) and familie(t["top"]) == "regen" and t["summe"] < 10]
dunkel = lambda t: t["hellH"] < 10.5
print(f"Regentage (Regen/Niesel/Schauer, < 10 mm): {len(rf)}, davon dunkle Monate {sum(1 for t in rf if dunkel(t))}")
for W in (0.25, 0.30, 0.35):
    print(f"\n-- Sonne im Regensymbol ab Schwelle T; wahr = gemessen >= {W:.0%} der hellen Zeit Sonne --")
    for T in (0.40, 0.54, 0.60, 0.65, 0.70, 0.75, 0.80, 2):
        def treffer(g):
            return sum(1 for t in g if (t["anteil"] >= T) == (t["mAnteil"] >= W))
        mit = [t for t in rf if t["anteil"] >= T]
        jahre = []
        for von, bis in ZEITRAEUME:
            g = [t for t in rf if von <= t["tag"] <= bis]
            jahre.append(f"{treffer(g)/len(g):.0%}")
        d = [t for t in rf if dunkel(t)]; hl = [t for t in rf if not dunkel(t)]
        print(f"  T={T:.2f}: Treffer {treffer(rf)/len(rf):.0%} (je Jahr {' / '.join(jahre)}; dunkel {treffer(d)/len(d):.0%}, hell {treffer(hl)/len(hl):.0%}) | "
              f"mit Sonne gezeichnet {len(mit):3}, davon zu Recht {sum(1 for t in mit if t['mAnteil'] >= W):3}"
              f" | grau gezeichnet, aber sonnig: {sum(1 for t in rf if t['anteil'] < T and t['mAnteil'] >= W)}")
    # heutige Regel zum Vergleich: Sonne wenn Code 80-82 ODER Anteil >= 0.54
    h = sum(1 for t in rf if ((80 <= t["top"] <= 82) or t["anteil"] >= 0.54) == (t["mAnteil"] >= W))
    print(f"  heute (Code 80-82 oder >= 0.54): Treffer {h/len(rf):.0%}")

print("\n-- Sonnenstunden je Tag: Anzeige (ein Modell) gegen Modellmittel, alle Tage --")
for name, f in (("ein Modell (Anzeige heute)", lambda t: t["rohH"]), ("Mittel aus 6 Modellen", lambda t: t["sonneH"])):
    for gname, g in (("alle", alle), ("Regentage", [t for t in alle if nass(t)]), ("trockene", [t for t in alle if not nass(t)])):
        fe = [abs(f(t) - t["mSonneH"]) for t in g]; b = [f(t) - t["mSonneH"] for t in g]
        print(f"  {name:28} {gname:10} mittlerer Fehler {sum(fe)/len(fe):.2f} h, im Schnitt {sum(b)/len(b):+.2f} h")

print("\n-- Wenig Tagregen vorhergesagt (< 1 mm), graues Symbol: was fiel wirklich? --")
k = [t for t in rf if t["tagRegen"] < 1.0 and t["anteil"] < 0.70]
print(f"  {len(k)} Tage; gemessen trocken (< 0.2 mm): {sum(1 for t in k if t['mRegen'] < 0.2)}, 0.2-1 mm: {sum(1 for t in k if 0.2 <= t['mRegen'] < 1)}, >= 1 mm: {sum(1 for t in k if t['mRegen'] >= 1)}; Median {med([t['mRegen'] for t in k]):.1f} mm, nasse Stunden Median {med([t['mNass'] for t in k])}")
k2 = [t for t in rf if t["tagRegen"] >= 1.0 and t["anteil"] < 0.70]
print(f"  Vergleich >= 1 mm: {len(k2)} Tage; gemessen trocken: {sum(1 for t in k2 if t['mRegen'] < 0.2)}, 0.2-1 mm: {sum(1 for t in k2 if 0.2 <= t['mRegen'] < 1)}, >= 1 mm: {sum(1 for t in k2 if t['mRegen'] >= 1)}; Median {med([t['mRegen'] for t in k2]):.1f} mm, nasse Stunden Median {med([t['mNass'] for t in k2])}")

print("\n-- Regentage ab 10 mm: Sonne gemessen, nach vorhergesagtem Anteil --")
g10 = [t for t in alle if nass(t) and familie(t["top"]) == "regen" and t["summe"] >= 10]
for a, b in ((0, 0.54), (0.54, 0.65), (0.65, 2)):
    g = [t for t in g10 if a <= t["anteil"] < b]
    zeile(f"Anteil {a:.2f}-{b:.2f}", g)
    zeile("  davon Schauer-Code 80-82", [t for t in g if 80 <= t["top"] <= 82])
print("\n-- Neue Regel gesamt (T=0.65, Schauer-Code ohne Sonderrecht), Regentage < 10 mm --")
for T in (0.65,):
    neu = sum(1 for t in rf if (t["anteil"] >= T) == (t["mAnteil"] >= WAHR))
    alt = sum(1 for t in rf if ((80 <= t["top"] <= 82) or t["anteil"] >= 0.54) == (t["mAnteil"] >= WAHR))
    print(f"  {len(rf)} Tage: heute {alt} richtig ({alt/len(rf):.0%}), neu {neu} richtig ({neu/len(rf):.0%})")
