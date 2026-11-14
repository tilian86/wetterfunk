import io, contextlib, sys
with contextlib.redirect_stdout(io.StringIO()):
    import symbol_messung as m
tr = [t for t in m.alle if not m.nass(t)]
print(f"{'Stuttgart' if m.STG else 'Tuebingen'}: {len(tr)} trockene Tage; Sonnenanteil = Mittel aus 6 Modellen (wie das Symbol)")
for a, b in ((0, .2), (.2, .3), (.3, .4), (.4, .47), (.47, .54), (.54, .62), (.62, .70), (.70, .84), (.84, 2)):
    g = [t for t in tr if a <= t["anteil"] < b]
    if not g: continue
    ma = sorted(t["mAnteil"] for t in g)
    print(f"  Anteil {a:.2f}-{b:.2f}: {len(g):3} Tage | gemessen Sonne Median {m.med([t['mSonneH'] for t in g]):4.1f} h, Anteil Median {m.med(ma):.2f}, Mittel {sum(ma)/len(ma):.2f} | "
          f"<10 % Sonne: {sum(1 for x in ma if x < .10)/len(ma):4.0%}  >=20 %: {sum(1 for x in ma if x >= .20)/len(ma):4.0%}  >=30 %: {sum(1 for x in ma if x >= .30)/len(ma):4.0%}  >=50 %: {sum(1 for x in ma if x >= .50)/len(ma):4.0%}")
