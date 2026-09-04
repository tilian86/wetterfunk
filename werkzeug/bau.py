# -*- coding: utf-8 -*-
"""Baut je Land eine kompakte Regionsdatei fuer Wetterfunk.
Quelle: geoBoundaries (CC BY 4.0) + eigene Zuordnung auf die MeteoAlarm-Warngebiete."""
import json, re, os, unicodedata, urllib.request

def norm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = s.replace('sankt ', 'st ').replace('st.', 'st ')
    return re.sub(r'[^a-z0-9]', '', s)

# ---- Kroatien: 21 Gespanschaften -> 7 Landregionen des DHMZ -------------
HR_DE = {
  'Zagreb region':'Region Zagreb', 'Karlovac region':'Region Karlovac',
  'Gospic region':'Region Gospić', 'Osijek region':'Region Osijek',
  'Rijeka region':'Region Rijeka', 'Split region':'Region Split',
  'Dubrovnik region':'Region Dubrovnik',
  'West Istrian coast region':'Westistrische Küste', 'Kvarner i Kvarneric region':'Kvarner-Bucht',
  'Velebit channel region':'Velebit-Kanal', 'North Dalmatia region':'Norddalmatien',
  'Middle Dalmatia region':'Mitteldalmatien', 'South Dalmatia region':'Süddalmatien',
}
SI_DE = {
  'Slovenia / North-West':'Slowenien Nordwest', 'Slovenia / North-East':'Slowenien Nordost',
  'Slovenia / Central':'Slowenien Mitte', 'Slovenia / South-West':'Slowenien Südwest',
  'Slovenia / South-East':'Slowenien Südost', 'Slovenia / Sea':'Slowenische Küste',
}
SI_SLO = {
  'Slovenia / North-West':'Slovenija / severozahod', 'Slovenia / North-East':'Slovenija / severovzhod',
  'Slovenia / Central':'Slovenija / osrednja', 'Slovenia / South-West':'Slovenija / jugozahod',
  'Slovenia / South-East':'Slovenija / jugovzhod', 'Slovenia / Sea':'Slovenija / morje',
}
HR_LAND = {
  'Zagreb region':      ['City of Zagreb','Zagreb County','Krapina-Zagorje','Varaždin','Međimurje',
                         'Koprivnica-Križevci','Bjelovar-Bilogora','Sisak-Moslavina'],
  'Karlovac region':    ['Karlovac'],
  'Gospic region':      ['Lika-Senj'],
  'Osijek region':      ['Virovitica-Podravina','Požega-Slavonia','Brod-Posavina','Osijek-Baranja','Vukovar-Syrmia'],
  'Rijeka region':      ['Primorje-Gorski Kotar','Istria'],
  'Split region':       ['Split-Dalmatia','Šibenik-Knin','Zadar County'],
  'Dubrovnik region':   ['Dubrovnik-Neretva'],
}
# Seegebiete als Kuestenkaesten (Nord->Sued), teils aus MeteoAlarm-Boxen gemessen
HR_SEE = [
  ('West Istrian coast region', [13.20,44.75,14.05,45.62]),
  ('Kvarner i Kvarneric region',[13.95,44.35,15.05,45.42]),
  ('Velebit channel region',    [14.60,44.13,15.63,45.22]),
  ('North Dalmatia region',     [14.45,43.45,15.95,44.60]),
  ('Middle Dalmatia region',    [15.19,42.75,17.74,43.55]),
  ('South Dalmatia region',     [15.99,42.18,18.54,43.05]),
]
# ---- Slowenien: 5 Landesteile als Schwerpunkte + Meer -------------------
SI_KERN = [('Slovenia / North-West',14.05,46.35),('Slovenia / North-East',15.65,46.50),
           ('Slovenia / Central',14.65,46.05),('Slovenia / South-West',14.21,45.78),
           ('Slovenia / South-East',15.17,45.80)]
SI_SEE  = ('Slovenia / Sea', [13.35,45.38,13.92,45.66])

def hol(iso, lvl):
    p = f'{iso}_{lvl}.json'
    if not os.path.exists(p):
        u = json.load(urllib.request.urlopen(
            f'https://www.geoboundaries.org/api/current/gbOpen/{iso}/{lvl}/', timeout=60))['simplifiedGeometryGeoJSON']
        urllib.request.urlretrieve(u, p)
    return json.load(open(p))

def ringe(geom):
    t, c = geom['type'], geom['coordinates']
    return [r[0] for r in c] if t == 'MultiPolygon' else [c[0]]

def presse(rs, mindest):
    """runden auf 1/1000 Grad, Dubletten raus, Winzlinge weg, delta-kodiert"""
    aus = []
    for r in rs:
        p = []
        for x, y in r:
            q = (round(x * 1000), round(y * 1000))
            if not p or p[-1] != q: p.append(q)
        if len(p) < 4: continue
        xs = [a for a, _ in p]; ys = [b for _, b in p]
        if (max(xs)-min(xs)) * (max(ys)-min(ys)) < mindest * 1e6: continue
        flach = [xs[0], ys[0]]
        for i in range(1, len(p)):
            flach += [xs[i]-xs[i-1], ys[i]-ys[i-1]]
        aus.append(flach)
    return aus

def gebiet(name, emma, rs, mindest):
    p = presse(rs, mindest)
    if not p: return None
    xs = [x for r in rs for x, _ in r]; ys = [y for r in rs for _, y in r]
    return {'n': name, 'e': emma, 'bb': [round(min(xs),3), round(min(ys),3), round(max(xs),3), round(max(ys),3)], 'p': p}

warn = json.load(open('gebiete.json'))
raus = {}

# --- Oesterreich: alle 94 Bezirke + Wiens 23 Bezirke auf die Stadtgrenze -
WIEN = ['Innere Stadt','Leopoldstadt','Landstraße','Wieden','Margareten','Mariahilf','Neubau',
        'Josefstadt','Alsergrund','Favoriten','Simmering','Meidling','Hietzing','Penzing',
        'Rudolfsheim-Fünfhaus','Ottakring','Hernals','Währing','Döbling','Brigittenau',
        'Floridsdorf','Donaustadt','Liesing']
d = hol('AUT','ADM2')
g = []
for f in d['features']:
    amt = f['properties']['shapeName']
    rs = ringe(f['geometry'])
    if norm(amt) == norm('Wien(Stadt)'):
        # Wien warnt je Bezirk, hat aber eine Stadtgrenze. Ein Gebiet mit
        # 23 Filternamen — sonst stuende dieselbe Meldung dreiundzwanzigmal da.
        e = gebiet('Wien', 'AT9', rs, 0.0004)
        if e:
            e['f'] = ['Wien ' + b for b in WIEN]
            g.append(e)
        continue
    # Schreibweise der Warnungen bevorzugen, sonst die des Grenzbestands
    passt = next((w for w in warn['AT'] if norm(w) == norm(amt)), amt)
    e = gebiet(passt, warn['AT'].get(passt), rs, 0.0004)
    if e: g.append(e)
    else: print('AT leer:', amt)
raus['at'] = {'land':'AT','gebiete':g}

# --- Kroatien ------------------------------------------------------------
d = hol('HRV','ADM1')
poly = {f['properties']['shapeName']: ringe(f['geometry']) for f in d['features']}
g = []
for name, teile in HR_LAND.items():
    rs = [r for t in teile for r in poly.get(t, [])]
    fehlt = [t for t in teile if t not in poly]
    if fehlt: print('HR fehlende Gespanschaft:', fehlt)
    e = gebiet(HR_DE.get(name, name), warn['HR'].get(name), rs, 0.00005)   # Inseln behalten
    if e: e['f'] = [name]; g.append(e)
for name, bb in HR_SEE:
    w,s,o,n = bb
    g.append({'n':HR_DE.get(name, name),'f':[name],'e':warn['HR'].get(name),'bb':bb,'see':1,
              'p':presse([[(w,s),(o,s),(o,n),(w,n),(w,s)]], 0)})
raus['hr'] = {'land':'HR','gebiete':g,'meer':json.load(open('meermaske.json'))}

# --- Slowenien: Landesumriss, per naechstem Kern aufgeteilt --------------
d = hol('SVN','ADM1')
umriss = [r for f in d['features'] for r in ringe(f['geometry'])]
xs = [x for r in umriss for x,_ in r]; ys = [y for r in umriss for _,y in r]
g = [{'n':SI_DE[n],'f':[n, SI_SLO[n]],'e':None,'kern':[round(kx,3),round(ky,3)]}
     for n,kx,ky in SI_KERN]
raus['si'] = {'land':'SI','bb':[round(min(xs),3),round(min(ys),3),round(max(xs),3),round(max(ys),3)],
              'umriss':presse(umriss,0.0004),'kerne':g,
              'see':{'n':SI_DE[SI_SEE[0]],'f':[SI_SEE[0], SI_SLO[SI_SEE[0]]],'bb':SI_SEE[1]},'meer':json.load(open('meermaske.json'))}

# --- Italien: 20 Regionen ------------------------------------------------
d = hol('ITA','ADM2')
g = []
for f in d['features']:
    amt = f['properties']['shapeName']
    passt = next((w for w in warn['IT'] if norm(w)[:6] == norm(amt)[:6]), amt)
    e = gebiet(passt, warn['IT'].get(passt), ringe(f['geometry']), 0.0004)
    if e: g.append(e)
raus['it'] = {'land':'IT','gebiete':g}

os.makedirs('regionen', exist_ok=True)
for k, v in raus.items():
    p = f'regionen/{k}.json'
    json.dump(v, open(p,'w'), separators=(',',':'), ensure_ascii=False)
    anz = len(v.get('gebiete', v.get('kerne', [])))
    print(f'{k}: {anz} Gebiete · {os.path.getsize(p)/1024:.0f} KB')
