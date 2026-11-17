#!/usr/bin/env python3
"""Regen-Rat und Regenphasen nachmessen (17.11.2026).

Vergleicht die Viertelstundenwerte, mit denen Wächter und App rechnen
(Open-Meteo, 92 Tage zurück, Tübingen 48.50/9.00), mit dem Regenmesser
Rottenburg-Kiebingen (DWD, Zehn-Minuten-Werte, 4 km entfernt).

Zwei Fragen:
  A  Zerlegt eine einzelne trockene Viertelstunde im Modell einen Regen, der
     in Wahrheit durchläuft?  -> Lücken überbrücken ja/nein, wie lange?
  B  Sagt der Augenblickswert oder die Stundensumme besser voraus, ob in der
     Stunde ringsum wirklich >= 0,5 mm fallen (Grenze Kapuze / kleiner Schirm)?

Aufruf:  python3 regen_phasen.py
Daten:   cache/regen15_tue.json   (Open-Meteo minutely_15, past_days=92, timezone=GMT)
         cache/dwd10/produkt_zehn_min_rr_*_04294.txt
         (opendata.dwd.de … 10_minutes/precipitation/recent/10minutenwerte_nieder_04294_akt.zip)
"""
import glob, json, os, urllib.request
from datetime import datetime, timedelta

HIER = os.path.dirname(os.path.abspath(__file__))
C = os.path.join(HIER, "cache")
NASS = 0.05          # mm je Viertelstunde, wie im Worker
GRENZE = 0.5         # mm/h: darunter "Kapuze reicht", ab da "kleiner Schirm"


def modell():
    pfad = os.path.join(C, "regen15_tue.json")
    if not os.path.exists(pfad):
        u = ("https://api.open-meteo.com/v1/forecast?latitude=48.5&longitude=9.0&timezone=GMT"
             "&minutely_15=precipitation&past_days=92&forecast_days=1")
        with urllib.request.urlopen(u, timeout=90) as r:
            open(pfad, "wb").write(r.read())
    m = json.load(open(pfad))["minutely_15"]
    return [(datetime.fromisoformat(t), p) for t, p in zip(m["time"], m["precipitation"]) if p is not None]


def messer():
    """Zehn-Minuten-Summen, Zeitstempel = Ende des Abschnitts (UTC)."""
    dateien = glob.glob(os.path.join(C, "dwd10", "produkt_zehn_min_rr_*.txt"))
    if not dateien:
        raise SystemExit("Messwerte fehlen – siehe Kopf dieser Datei.")
    aus = {}
    for z in open(dateien[0]):
        f = z.split(";")
        if len(f) < 5 or not f[1].strip().isdigit():
            continue
        v = float(f[4])
        if v >= 0:
            aus[datetime.strptime(f[1].strip(), "%Y%m%d%H%M")] = v
    return aus


M = modell()
G = messer()
letzte = max(G)
M = [(t, p) for t, p in M if t + timedelta(hours=2) <= letzte]
T = [t for t, _ in M]
P = [p for _, p in M]
N = len(P)
print(f"Zeitraum {T[0]:%d.%m.%Y} – {T[-1]:%d.%m.%Y}, {N} Viertelstunden, "
      f"davon nass im Modell: {sum(p >= NASS for p in P)}")


def gemessen(von, bis):
    """Summe des Regenmessers in (von, bis]; None, wenn Werte fehlen."""
    s, t = 0.0, von + timedelta(minutes=10)
    t = t.replace(minute=t.minute // 10 * 10, second=0)
    n = 0
    while t <= bis:
        if t not in G:
            return None
        s += G[t]; n += 1
        t += timedelta(minutes=10)
    return s if n else None


# ── A: Lücken ───────────────────────────────────────────────
def phasen(luecke):
    """Phasen wie im Worker; bis zu `luecke` trockene Viertelstunden zwischen
    zwei nassen gelten als dieselbe Phase."""
    aus, i = [], 0
    while i < N:
        if P[i] < NASS:
            i += 1; continue
        j, ende = i, i
        while j < N:
            if P[j] >= NASS:
                ende = j; j += 1; continue
            k = j
            while k < N and P[k] < NASS and k - j < luecke:
                k += 1
            if k < N and P[k] >= NASS and k - j <= luecke and k > j:
                j = k; continue
            break
        aus.append((i, ende))
        i = ende + 1
    return aus


print("\nA  Phasen je nach überbrückter Lücke")
for L in (0, 1, 2, 3, 4):
    ph = phasen(L)
    print(f"   Lücke bis {L * 15:>2} Min.: {len(ph):>4} Phasen")

# Trockene Lücken zwischen nassen Viertelstunden, nach Länge: Hat der Messer
# in der Lücke Regen gemessen?
print("\n   Was maß der Regenmesser in den Modell-Lücken?")
ph0 = phasen(0)
nach_laenge = {}
for (a, b), (c, d) in zip(ph0, ph0[1:]):
    n = c - b - 1
    g = gemessen(T[b + 1] - timedelta(minutes=5), T[c] + timedelta(minutes=5))
    if g is None:
        continue
    nach_laenge.setdefault(min(n, 9), []).append(g)
for n in sorted(nach_laenge):
    w = nach_laenge[n]
    nass = sum(x >= 0.02 for x in w)
    name = f"{n * 15:>3} Min." if n < 9 else ">2 Std."
    print(f"   Lücke {name}: {len(w):>3} Fälle, davon Messer nass: {nass:>3} ({100 * nass / len(w):.0f} %)")

# Vergleich: beliebige trockene Viertelstunde, mindestens 2 h von Modellregen entfernt
fern = []
for i in range(8, N - 8):
    if all(P[k] < NASS for k in range(i - 8, i + 9)):
        g = gemessen(T[i] - timedelta(minutes=5), T[i] + timedelta(minutes=20))
        if g is not None:
            fern.append(g)
print(f"   Zum Vergleich, Viertelstunden fern von Modellregen: "
      f"{100 * sum(x >= 0.02 for x in fern) / len(fern):.1f} % nass ({len(fern)} Fälle)")

# ── B: Augenblick oder Stundensumme? ────────────────────────
print("\nB  Grenze Kapuze / kleiner Schirm (0,5 mm/h): was sagt die Stunde ringsum am Messer?")


def stunde_modell(i):
    """Stärkere der beiden Stunden um die Viertelstunde: die zurückliegende
    oder die kommende (je vier Viertelstunden, die aktuelle eingeschlossen)."""
    zurueck = sum(P[max(0, i - 3):i + 1])
    voraus = sum(P[i:i + 4])
    return max(zurueck, voraus)


faelle = []
for i in range(4, N - 4):
    if P[i] < NASS:
        continue
    g = gemessen(T[i] - timedelta(minutes=25), T[i] + timedelta(minutes=35))
    if g is None:
        continue
    faelle.append((P[i] * 4, stunde_modell(i), g))


def zeile(name, teil):
    if not teil:
        print(f"   {name}: keine Fälle"); return
    ja = sum(g >= GRENZE for _, _, g in teil)
    mittel = sum(g for _, _, g in teil) / len(teil)
    print(f"   {name}: {len(teil):>4} Viertelstunden · Messer ≥ 0,5 mm in der Stunde: "
          f"{100 * ja / len(teil):>3.0f} % · im Mittel {mittel:.2f} mm")


kap = [f for f in faelle if f[0] < GRENZE]
zeile("Augenblick sagt Kapuze                     ", kap)
zeile("  … und die Stundensumme auch (< 0,5 mm)   ", [f for f in kap if f[1] < GRENZE])
zeile("  … aber die Stundensumme sagt Schirm      ", [f for f in kap if f[1] >= GRENZE])
zeile("Augenblick sagt Schirm (≥ 0,5 mm/h)        ", [f for f in faelle if f[0] >= GRENZE])

for name, regel in (("Augenblick      ", lambda f: f[0] >= GRENZE),
                    ("max(Augenbl., Stunde)", lambda f: max(f[0], f[1]) >= GRENZE)):
    tp = sum(regel(f) and f[2] >= GRENZE for f in faelle)
    fp = sum(regel(f) and f[2] < GRENZE for f in faelle)
    fn = sum(not regel(f) and f[2] >= GRENZE for f in faelle)
    tn = sum(not regel(f) and f[2] < GRENZE for f in faelle)
    print(f"   Regel {name}: richtig {100 * (tp + tn) / len(faelle):.0f} % · "
          f"Schirm-Stunden erkannt {100 * tp / max(1, tp + fn):.0f} % · "
          f"Schirm zu Unrecht {100 * fp / max(1, tp + fp):.0f} %")

# ── C: lange schwache Phasen ────────────────────────────────
print("\nC  Phasen, die der Worker „ein paar Tropfen“ nennt (Spitze < 0,15 mm je Viertelstunde)")
for L in (0, 1):
    kurz, lang = [], []
    for a, b in phasen(L):
        if max(P[a:b + 1]) >= 0.15:
            continue
        g = gemessen(T[a] - timedelta(minutes=5), T[b] + timedelta(minutes=20))
        if g is None:
            continue
        dauer = (b - a + 1) * 15
        (lang if dauer >= 60 else kurz).append((dauer, g))
    for name, w in (("unter 1 Std.", kurz), ("ab 1 Std.   ", lang)):
        if not w:
            continue
        rate = sum(g for _, g in w) / (sum(d for d, _ in w) / 60)
        print(f"   Lücke {L * 15:>2} Min., Dauer {name}: {len(w):>3} Phasen · Messer im Mittel "
              f"{sum(g for _, g in w) / len(w):.2f} mm je Phase · {rate:.2f} mm/h")
