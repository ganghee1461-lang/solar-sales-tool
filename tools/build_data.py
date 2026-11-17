"""진천군 지붕 태양광 후보 데이터를 만든다. (원본은 읽기만 하고, 결과는 data/ 폴더에 새로 쓴다)

입력
  1) 연속수치지형도 건물 추출본(jsonl)  : GIS 자료/연속수치지형도-건물/가공/진천_사각범위_건물.jsonl
  2) 전국태양광발전시설 표준데이터 원본  : GIS 자료/태양광시설-표준데이터/진천_원본_p*.json
출력
  data/jincheon.json          회사(묶음) 목록 + 기준 정보
  data/jincheon_bldg.geojson  건물 도형
  data/jincheon_solar.geojson 기존 태양광 시설 위치

실행
  KAKAO_KEY=... python3 tools/build_data.py
"""
import json, math, os, sys, glob, re, collections, urllib.request, urllib.parse, time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser('~')
GIS = os.path.join(HOME, '클로드코드/업무/GIS 자료')
SRC_BLDG = os.path.join(GIS, '연속수치지형도-건물/가공/진천_사각범위_건물.jsonl')
SRC_SOLAR = os.path.join(GIS, '태양광시설-표준데이터')
CACHE = os.path.join(GIS, '태양광시설-표준데이터/캐시')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data')
KAKAO = os.environ.get('KAKAO_KEY', '')

SGG = '43750'            # 진천군 법정동코드 앞 5자리
MIN_AREA = 500.0         # 동 단위 최소 지붕 면적(㎡)
KIND_OK = {'BDK004', 'BDK005'}   # 주택외건물, 무벽건물
LINK_M = 500.0           # 같은 이름 건물을 한 사업장으로 묶는 거리(m)
NEAR_M = 50.0            # 태양광 좌표가 건물 밖일 때 '근처'로 보는 거리(m)
EMD = {'43750250': '진천읍', '43750253': '덕산읍', '43750320': '초평면', '43750330': '문백면',
       '43750340': '백곡면', '43750350': '이월면', '43750370': '광혜원면'}
SERV = {'BDS000': '미분류', 'BDS001': '주택', 'BDS002': '근린생활시설', 'BDS003': '문화및집회시설', 'BDS004': '종교시설',
        'BDS005': '판매시설', 'BDS006': '운수시설', 'BDS007': '의료시설', 'BDS008': '교육연구시설', 'BDS009': '노유자시설',
        'BDS010': '수련시설', 'BDS011': '운동시설', 'BDS012': '업무시설', 'BDS013': '숙박시설', 'BDS014': '위락시설',
        'BDS015': '공장', 'BDS016': '창고시설', 'BDS017': '위험물저장및처리시설', 'BDS018': '자동차관련시설',
        'BDS019': '동물및식물관련시설', 'BDS020': '분뇨및쓰레기처리시설', 'BDS021': '교정및군사시설', 'BDS022': '방송통신시설',
        'BDS023': '발전시설', 'BDS024': '묘지관련시설', 'BDS025': '관광휴게시설', 'BDS026': '장례시설', 'BDS999': '기타시설'}

# ---------- 좌표 변환 (EPSG:5179 <-> 경위도, GRS80) ----------
A = 6378137.0; F = 1 / 298.257222101; K0 = 0.9996; LAT0 = math.radians(38); LON0 = math.radians(127.5); FE = 1e6; FN = 2e6
E2 = 2 * F - F * F; EP2 = E2 / (1 - E2)

def _M(p):
    return A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * p - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * math.sin(2 * p)
                + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * math.sin(4 * p) - (35 * E2 ** 3 / 3072) * math.sin(6 * p))
M0 = _M(LAT0)

def to_xy(lon, lat):
    p = math.radians(lat); l = math.radians(lon)
    N = A / math.sqrt(1 - E2 * math.sin(p) ** 2); T = math.tan(p) ** 2; C = EP2 * math.cos(p) ** 2; a = (l - LON0) * math.cos(p)
    x = FE + K0 * N * (a + (1 - T + C) * a ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * a ** 5 / 120)
    y = FN + K0 * (_M(p) - M0 + N * math.tan(p) * (a * a / 2 + (5 - T + 9 * C + 4 * C * C) * a ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * a ** 6 / 720))
    return x, y

def to_ll(x, y):
    M = M0 + (y - FN) / K0
    mu = M / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) \
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
    N1 = A / math.sqrt(1 - E2 * math.sin(p1) ** 2); T1 = math.tan(p1) ** 2; C1 = EP2 * math.cos(p1) ** 2
    R1 = A * (1 - E2) / (1 - E2 * math.sin(p1) ** 2) ** 1.5; D = (x - FE) / (N1 * K0)
    lat = p1 - (N1 * math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
                                           + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720)
    lon = LON0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / math.cos(p1)
    return round(math.degrees(lon), 6), round(math.degrees(lat), 6)

# ---------- 도형 계산 ----------
def centroid(ring):
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]; x1, y1 = ring[i + 1]; c = x0 * y1 - x1 * y0
        a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
    if abs(a) < 1e-9:
        return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
    return cx / (3 * a), cy / (3 * a)

def inside(x, y, rings):
    c = False
    for r in rings:
        j = len(r) - 1
        for i in range(len(r)):
            xi, yi = r[i]; xj, yj = r[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                c = not c
            j = i
    return c

def dist_to(x, y, rings):
    best = 1e18
    for r in rings:
        for i in range(len(r) - 1):
            x0, y0 = r[i]; x1, y1 = r[i + 1]; dx = x1 - x0; dy = y1 - y0
            t = 0 if dx == dy == 0 else max(0, min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
            d = math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
            if d < best: best = d
    return best

# ---------- 외부 조회(캐시) ----------
def cache_load(name):
    p = os.path.join(CACHE, name)
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

def cache_save(name, d):
    os.makedirs(CACHE, exist_ok=True)
    json.dump(d, open(os.path.join(CACHE, name), 'w', encoding='utf-8'), ensure_ascii=False)

def http_json(url, headers=None, tries=3):
    for t in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            err = e; time.sleep(1.5 * (t + 1))
    return {'_error': str(err)}

def kakao(path, **q):
    return http_json('https://dapi.kakao.com/v2/local/' + path + '?' + urllib.parse.urlencode(q), {'Authorization': 'KakaoAK ' + KAKAO})

def clean_addr(a):
    """'충청북도 진천군 문백면 문덕리 285-16 A동' -> 첫 지번까지만"""
    m = re.match(r'^(.*?(?:리|동|가|로|길)\s+(?:산\s*)?\d+(?:-\d+)?)', a)
    return m.group(1) if m else a

# ---------- 1. 건물 ----------
def main():
    os.makedirs(OUT, exist_ok=True)
    allb = []
    for line in open(SRC_BLDG, encoding='utf-8'):
        r = json.loads(line)
        if r['attrs']['BJCD'].startswith(SGG): allb.append(r)
    print('진천군 전체 건물', len(allb))
    for b in allb:
        xs = [p[0] for r in b['rings'] for p in r]; ys = [p[1] for r in b['rings'] for p in r]
        b['bb'] = (min(xs), min(ys), max(xs), max(ys)); b['c'] = centroid(b['rings'][0])
    cand = [b for b in allb if b['area_m2'] >= MIN_AREA and b['attrs']['KIND'] in KIND_OK]
    chk = [b for b in allb if b['area_m2'] >= MIN_AREA and b['attrs']['SERV'] in ('BDS015', 'BDS016')]
    chk_in = [b for b in chk if b['attrs']['KIND'] in KIND_OK]
    print('후보(500㎡ 이상, 주택외·무벽)', len(cand), round(sum(b['area_m2'] for b in cand)))
    print('검증: 공장+창고 500㎡ 이상', len(chk), round(sum(b['area_m2'] for b in chk)), '/ 그중 후보 포함', len(chk_in), round(sum(b['area_m2'] for b in chk_in)))

    # ---------- 2. 묶기 ----------
    def norm(s): return re.sub(r'\s+', '', s)
    keyed = collections.defaultdict(list)
    for i, b in enumerate(cand):
        a = b['attrs']; nm = norm(a['ANNO'] or a['NAME'])
        if nm: k = ('N', nm)
        elif a['RDNM']: k = ('R', a['RDNM'] + '-' + a['BONU'] + '-' + a['BUNU'])
        else: k = ('U', str(i))
        keyed[k].append(i)
    groups = []
    for k, idxs in keyed.items():
        par = {i: i for i in idxs}
        def find(i):
            while par[i] != i: par[i] = par[par[i]]; i = par[i]
            return i
        for x in range(len(idxs)):
            for y in range(x + 1, len(idxs)):
                a, b = cand[idxs[x]], cand[idxs[y]]
                if math.hypot(a['c'][0] - b['c'][0], a['c'][1] - b['c'][1]) <= LINK_M: par[find(idxs[x])] = find(idxs[y])
        cl = collections.defaultdict(list)
        for i in idxs: cl[find(i)].append(i)
        for m in cl.values(): groups.append((k, m))
    groups.sort(key=lambda g: -sum(cand[i]['area_m2'] for i in g[1]))
    for gid, (k, m) in enumerate(groups):
        for i in m: cand[i]['gid'] = gid
    print('묶음 수', len(groups), '(이름 있음', sum(1 for g in groups if g[0][0] == 'N'), ')')

    # ---------- 3. 기존 태양광 ----------
    sol = []
    for f in sorted(glob.glob(os.path.join(SRC_SOLAR, '진천_원본_p*.json'))):
        d = json.load(open(f, encoding='utf-8')); d = d.get('response', d); x = d['body']['items']; sol += x['item'] if isinstance(x, dict) else x
    print('태양광 시설', len(sol), '용량합', round(sum(float(s.get('capa') or 0) for s in sol), 1))
    gc = cache_load('geocode.json')
    todo = [s for s in sol if not s.get('latitude') and (s.get('lctnRoadNmAddr') or s.get('lctnLotnoAddr')) not in gc]
    if todo and KAKAO:
        def geo(s):
            raw = s.get('lctnRoadNmAddr') or s.get('lctnLotnoAddr'); r = kakao('search/address.json', query=clean_addr(raw))
            doc = (r.get('documents') or [None])[0]
            return raw, ([float(doc['x']), float(doc['y'])] if doc else None)
        with ThreadPoolExecutor(6) as ex:
            for raw, v in ex.map(geo, todo): gc[raw] = v
        cache_save('geocode.json', gc)
    cell = 100.0; grid = collections.defaultdict(list); cgrid = collections.defaultdict(list)
    for i, b in enumerate(allb):
        for gx in range(int(b['bb'][0] // cell), int(b['bb'][2] // cell) + 1):
            for gy in range(int(b['bb'][1] // cell), int(b['bb'][3] // cell) + 1): grid[(gx, gy)].append(i)
    for i, b in enumerate(cand):
        for gx in range(int((b['bb'][0] - NEAR_M) // cell), int((b['bb'][2] + NEAR_M) // cell) + 1):
            for gy in range(int((b['bb'][1] - NEAR_M) // cell), int((b['bb'][3] + NEAR_M) // cell) + 1): cgrid[(gx, gy)].append(i)
    gsolar = collections.defaultdict(list); spts = []; stat = collections.Counter()
    for s in sol:
        raw = s.get('lctnRoadNmAddr') or s.get('lctnLotnoAddr') or ''
        if s.get('latitude'): lon, lat, src = float(s['longitude']), float(s['latitude']), '원본 좌표'
        elif gc.get(raw): lon, lat, src = gc[raw][0], gc[raw][1], '주소로 찾은 좌표'
        else: stat['위치 못 찾음'] += 1; continue
        x, y = to_xy(lon, lat); hit = None; how = None
        for i in grid.get((int(x // cell), int(y // cell)), []):
            b = allb[i]
            if b['bb'][0] <= x <= b['bb'][2] and b['bb'][1] <= y <= b['bb'][3] and inside(x, y, b['rings']):
                hit = b; how = 'on'; break
        if hit is not None and 'gid' not in hit: stat['후보 아닌 건물 위'] += 1; hit = None; how = 'other'
        if hit is None and how != 'other':
            best = (NEAR_M + 1, None)
            for i in cgrid.get((int(x // cell), int(y // cell)), []):
                d = dist_to(x, y, cand[i]['rings'])
                if d < best[0]: best = (d, cand[i])
            if best[1] is not None and best[0] <= NEAR_M: hit = best[1]; how = 'near'
        rec = {'nm': s.get('solarGenFcltNm', ''), 'kw': float(s.get('capa') or 0), 'yr': s.get('instlYr', ''), 'ad': raw, 'src': src}
        roof = bool(re.search(r'(주|부)\s*\d|[A-Za-z가-힣]동(\s|,|$)|지붕|옥상', raw.split('리')[-1] if '리' in raw else raw))
        rec['roof'] = roof
        if hit is not None and how in ('on', 'near'):
            gsolar[hit['gid']].append(dict(rec, how=how)); stat['후보 건물 위' if how == 'on' else '후보 건물 %dm 이내' % NEAR_M] += 1
        elif how != 'other': stat['건물과 무관(땅 설치 등)'] += 1
        spts.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]},
                     'properties': dict(rec, m=(how if how in ('on', 'near') else 'none'))})
    print('태양광 매칭', dict(stat))

    # ---------- 4. 이용률 (PVGIS, 0.05도 격자) ----------
    pv = cache_load('pvgis.json'); step = 0.05
    def cellkey(lon, lat): return '%.2f,%.2f' % (round(lon / step) * step, round(lat / step) * step)
    centers = {}
    for gid, (k, m) in enumerate(groups):
        big = max(m, key=lambda i: cand[i]['area_m2']); centers[gid] = to_ll(*cand[big]['c'])
    need = sorted({cellkey(*c) for c in centers.values()} - set(pv))
    def pvcalc(key):
        lon, lat = key.split(',')
        r = http_json('https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=%s&lon=%s&peakpower=1&loss=14&angle=10&aspect=0&outputformat=json' % (lat, lon))
        try: return key, r['outputs']['totals']['fixed']['E_y']
        except Exception: return key, None
    if need:
        with ThreadPoolExecutor(4) as ex:
            for key, v in ex.map(pvcalc, need):
                if v: pv[key] = v
        cache_save('pvgis.json', pv)
    print('이용률 격자', len(pv), '값 범위', min(pv.values()), max(pv.values()))

    # ---------- 5. 주소 (묶음 대표 건물 위치) ----------
    rg = cache_load('revgeo.json')
    todo = [gid for gid in centers if '%f,%f' % centers[gid] not in rg]
    if todo and KAKAO:
        def rev(gid):
            lon, lat = centers[gid]; r = kakao('geo/coord2address.json', x=lon, y=lat)
            doc = (r.get('documents') or [None])[0]; v = None
            if doc: v = {'road': (doc.get('road_address') or {}).get('address_name', ''), 'jibun': (doc.get('address') or {}).get('address_name', '')}
            return '%f,%f' % (lon, lat), v
        with ThreadPoolExecutor(6) as ex:
            for key, v in ex.map(rev, todo):
                if v is not None: rg[key] = v
        cache_save('revgeo.json', rg)

    # ---------- 6. 쓰기 ----------
    G = []
    for gid, (k, m) in enumerate(groups):
        bs = [cand[i] for i in m]; big = max(bs, key=lambda b: b['area_m2']); lon, lat = centers[gid]
        uses = collections.Counter()
        for b in bs: uses[b['attrs']['SERV']] += b['area_m2']
        ad = rg.get('%f,%f' % (lon, lat)) or {}
        ey = pv.get(cellkey(lon, lat))
        so = sorted(gsolar.get(gid, []), key=lambda s: -s['kw'])
        G.append({'id': gid, 'nm': (big['attrs']['ANNO'] or big['attrs']['NAME']) if k[0] == 'N' else '', 'emd': EMD.get(big['attrs']['BJCD'][:8], ''),
                  'road': ad.get('road', ''), 'jibun': ad.get('jibun', ''), 'c': [lon, lat], 'n': len(bs), 'a': round(sum(b['area_m2'] for b in bs)),
                  'use': max(uses, key=uses.get), 'uses': {u: round(v) for u, v in uses.items()}, 'ey': ey,
                  'sol': so, 'solst': ('on' if any(s['how'] == 'on' for s in so) else 'near' if so else 'none'), 'solkw': round(sum(s['kw'] for s in so), 1)})
    # 주용도가 공장·창고시설인 묶음만 싣는다(번호는 용량 큰 순으로 다시 매김)
    G = [g for g in G if g['use'] in ('BDS015', 'BDS016')]
    remap = {g['id']: i for i, g in enumerate(G)}
    for g in G: g['id'] = remap[g['id']]
    cand_all = cand; cand = [b for b in cand if b['gid'] in remap]
    for b in cand: b['gid'] = remap[b['gid']]
    feats = []
    for b in cand:
        coords = [[list(to_ll(x, y)) for x, y in r] for r in b['rings']]
        feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': coords},
                      'properties': {'g': b['gid'], 'a': round(b['area_m2']), 's': b['attrs']['SERV'], 'k': b['attrs']['KIND'], 'f': b['attrs']['NMLY'], 'n': b['attrs']['ANNO'] or b['attrs']['NAME']}})
    meta = {'region': '충청북도 진천군', 'built': time.strftime('%Y-%m-%d'),
            'bldg_src': '브이월드 「건물」(국토지리정보원 연속수치지형도 N3A_B0010000), 갱신일 2026-10-01',
            'solar_src': '전국태양광발전시설 표준데이터(공공데이터포털), 진천군 기준일 2026-07-20, %d건' % len(sol),
            'pv_src': 'PVGIS 5.3 (PVGIS-ERA5, 2005~2023), 경사 10도·정남·손실 14% 가정',
            'min_area': MIN_AREA, 'near_m': NEAR_M, 'link_m': LINK_M, 'serv': SERV,
            'n_bldg': len(cand), 'area': round(sum(b['area_m2'] for b in cand)), 'n_group': len(G), 'pv_tilt': 10, 'pv_loss': 14, 'solar_match': dict(stat),
            'check_factory_wh': {'n': len(chk_in), 'area': round(sum(b['area_m2'] for b in chk_in))}}
    def dump(name, obj):
        p = os.path.join(OUT, name); json.dump(obj, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':')); print(name, round(os.path.getsize(p) / 1e6, 2), 'MB')
    dump('jincheon.json', {'meta': meta, 'groups': G})
    dump('jincheon_bldg.geojson', {'type': 'FeatureCollection', 'features': feats})
    dump('jincheon_solar.geojson', {'type': 'FeatureCollection', 'features': spts})
    st = collections.Counter(g['solst'] for g in G)
    print('묶음별 기존 태양광', dict(st), ' 주소 채움', sum(1 for g in G if g['road'] or g['jibun']), '/', len(G))
    for g in G[:8]: print(g['nm'] or '(이름 없음)', g['emd'], g['n'], g['a'], g['ey'], g['solst'], g['solkw'], g['road'] or g['jibun'])

if __name__ == '__main__':
    main()
