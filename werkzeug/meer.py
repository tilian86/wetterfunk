# -*- coding: utf-8 -*-
"""Baut eine Maske 'nah an der Adria' (<=25 km) als Bitmuster."""
import json, os, base64, urllib.request
import numpy as np
from shapely.geometry import shape
from shapely.ops import unary_union
from matplotlib.path import Path

LAENDER = ['HRV','BIH','MNE','ITA','SVN','ALB','GRC']
W,S,O,N, SCHRITT = 12.8, 41.7, 19.4, 46.3, 0.02
KM = 25.0

def hol(iso):
    p = f'{iso}_ADM0.json'
    if not os.path.exists(p):
        u = json.load(urllib.request.urlopen(
            f'https://www.geoboundaries.org/api/current/gbOpen/{iso}/ADM0/', timeout=60))['simplifiedGeometryGeoJSON']
        urllib.request.urlretrieve(u, p)
    return json.load(open(p))

land = unary_union([shape(f['geometry']).buffer(0)
                    for iso in LAENDER for f in hol(iso)['features']])
print('Landmasse vereint')

nx = int(round((O-W)/SCHRITT)); ny = int(round((N-S)/SCHRITT))
gx = W + (np.arange(nx)+0.5)*SCHRITT
gy = S + (np.arange(ny)+0.5)*SCHRITT
XX, YY = np.meshgrid(gx, gy)
punkte = np.column_stack([XX.ravel(), YY.ravel()])

istLand = np.zeros(len(punkte), bool)
teile = land.geoms if land.geom_type == 'MultiPolygon' else [land]
for pol in teile:
    xs, ys = pol.exterior.xy
    if max(xs) < W or min(xs) > O or max(ys) < S or min(ys) > N: continue
    m = Path(np.column_stack([xs, ys])).contains_points(punkte)
    for loch in pol.interiors:
        hx, hy = loch.xy
        m &= ~Path(np.column_stack([hx, hy])).contains_points(punkte)
    istLand |= m
roh = (~istLand).reshape(ny, nx)
# nur die zusammenhaengende Adria behalten - Binnenseen zaehlen nicht als Meer
start = (int((43.0-S)/SCHRITT), int((15.5-W)/SCHRITT))
meer = np.zeros_like(roh); rand = [start]; meer[start] = True
while rand:
    neu = []
    for y, x in rand:
        for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
            a, b = y+dy, x+dx
            if 0 <= a < ny and 0 <= b < nx and roh[a,b] and not meer[a,b]:
                meer[a,b] = True; neu.append((a,b))
    rand = neu
print(f'Gitter {nx}x{ny} · offene Adria {meer.sum()} von {roh.sum()} Wasserzellen')

# Ausweiten um 25 km -> 'nah am Wasser'
rlat = KM/111.0/SCHRITT
rlon = KM/(111.0*np.cos(np.radians(44)))/SCHRITT
nah = np.zeros_like(meer)
for dy in range(-int(rlat)-1, int(rlat)+2):
    for dx in range(-int(rlon)-1, int(rlon)+2):
        if (dy/rlat)**2 + (dx/rlon)**2 > 1: continue
        nah |= np.roll(np.roll(meer, dy, 0), dx, 1)
print(f'nah am Wasser: {nah.sum()} Zellen ({nah.mean()*100:.0f} %)')

bits = np.packbits(nah.ravel())
maske = {'w': W, 's': S, 'schritt': SCHRITT, 'nx': nx, 'ny': ny,
         'bits': base64.b64encode(bits.tobytes()).decode()}
json.dump(maske, open('meermaske.json','w'), separators=(',',':'))
print(f"Maske {os.path.getsize('meermaske.json')/1024:.1f} KB")

def test(la, lo):
    ix = int((lo-W)/SCHRITT); iy = int((la-S)/SCHRITT)
    if not (0 <= ix < nx and 0 <= iy < ny): return False
    return bool(nah[iy, ix])
for name, la, lo in [('Split',43.508,16.440),('Plitvicer Seen',44.881,15.616),('Zagreb',45.813,15.978),
                     ('Knin',44.041,16.197),('Delnice',45.401,14.801),('Makarska',43.297,17.017),
                     ('Insel Hvar',43.173,16.442),('Rovinj',45.081,13.638),('Koper',45.548,13.730),
                     ('Ljubljana',46.056,14.506),('Dubrovnik',42.650,18.092),('Mostar (BA)',43.343,17.808)]:
    print(f'  {name:<16} nah am Wasser: {test(la,lo)}')
