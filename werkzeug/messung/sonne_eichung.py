#!/usr/bin/env python3
"""Sonnenstunden-Anzeige eichen: vorhergesagter Anteil (ein Modell, wie angezeigt)
gegen gemessenen Anteil der Station."""
import io, contextlib, sys, json
with contextlib.redirect_stdout(io.StringIO()):
    import symbol_messung as m
alle = m.alle
for t in alle:
    t["r"] = min(1, t["rohH"] / t["hellH"])
print(f"{len(alle)} Tage ({'Stuttgart' if m.STG else 'Tuebingen-Vorhersage, Sonne Stuttgart'})")
KANTEN = [0, .05, .15, .25, .35, .45, .55, .65, .75, .85, .95, 1.01]
print("  Vorhersage-Anteil      Tage  vorhergesagt  gemessen Mittel  Median   dunkel(Mittel)  hell(Mittel)")
stuetz = []
for a, b in zip(KANTEN, KANTEN[1:]):
    g = [t for t in alle if a <= t["r"] < b]
    if not g: continue
    mr = sum(t["r"] for t in g) / len(g); mm = sum(t["mAnteil"] for t in g) / len(g)
    d = [t["mAnteil"] for t in g if t["hellH"] < 10.5]; hl = [t["mAnteil"] for t in g if t["hellH"] >= 10.5]
    stuetz.append((round(mr, 3), round(mm, 3)))
    print(f"  {a:.2f}-{b:.2f}            {len(g):4}     {mr:.2f}          {mm:.2f}         {m.med([t['mAnteil'] for t in g]):.2f}     "
          f"{(sum(d)/len(d) if d else float('nan')):.2f} ({len(d):3})      {(sum(hl)/len(hl) if hl else float('nan')):.2f} ({len(hl):3})")
print("Stuetzpunkte:", json.dumps(stuetz))

def stueckweise(punkte):
    p = [(0, 0)] + sorted(punkte) + [(1.0001, max(y for _, y in punkte))]
    def f(r):
        for (x0, y0), (x1, y1) in zip(p, p[1:]):
            if x0 <= r <= x1:
                return y0 + (y1 - y0) * (r - x0) / (x1 - x0) if x1 > x0 else y0
        return p[-1][1]
    return f

def fehler(g, f):
    fe = [abs(f(t["r"]) * t["hellH"] - t["mSonneH"]) for t in g]
    b = [f(t["r"]) * t["hellH"] - t["mSonneH"] for t in g]
    return sum(fe) / len(fe), sum(b) / len(b)

def stuetzen(g):
    aus = []
    for a, b in zip(KANTEN, KANTEN[1:]):
        k = [t for t in g if a <= t["r"] < b]
        if len(k) >= 5:
            aus.append((sum(t["r"] for t in k) / len(k), sum(t["mAnteil"] for t in k) / len(k)))
    return aus

roh = lambda r: r
print("\nFehler der Sonnenstunden (mittlerer Fehler, Schieflage):")
print("  roh, alle Tage:              %.2f h, %+.2f h" % fehler(alle, roh))
print("  geeicht (selbe Tage):        %.2f h, %+.2f h" % fehler(alle, stueckweise(stuetzen(alle))))
for von, bis in m.ZEITRAEUME:
    lern = [t for t in alle if not (von <= t["tag"] <= bis)]
    test = [t for t in alle if von <= t["tag"] <= bis]
    f = stueckweise(stuetzen(lern))
    print(f"  Jahr {von[:7]}..: roh %.2f h (%+.2f) -> geeicht an den anderen Jahren %.2f h (%+.2f)" % (fehler(test, roh) + fehler(test, f)))
if len(sys.argv) > 1 and sys.argv[-1].startswith("["):
    f = stueckweise([tuple(p) for p in json.loads(sys.argv[-1])])
    print("  mit fremden Stuetzpunkten:   %.2f h, %+.2f h" % fehler(alle, f))
    for name, g in (("dunkle Monate", [t for t in alle if t["hellH"] < 10.5]), ("helle Monate", [t for t in alle if t["hellH"] >= 10.5])):
        print(f"    {name}: roh %.2f h (%+.2f) -> %.2f h (%+.2f)" % (fehler(g, roh) + fehler(g, f)))
    for a, b in ((0, 2), (2, 5), (5, 8), (8, 20)):
        g = [t for t in alle if a <= t["rohH"] < b]
        print(f"    Anzeige {a}-{b} h ({len(g)} Tage): gemessen Mittel {sum(t['mSonneH'] for t in g)/len(g):.1f} h; roh %.2f h (%+.2f) -> %.2f h (%+.2f)" % (fehler(g, roh) + fehler(g, f)))
