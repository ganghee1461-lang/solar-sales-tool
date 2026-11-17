"""지붕 태양광 후보 자료를 지역(시군구)별로 만든다. 원본은 읽기만 하고 결과는 data/ 에 쓴다.

입력 (모두 ~/클로드코드/업무/GIS 자료 아래)
  연속수치지형도-건물/가공/<지역>_건물.jsonl      건물 도형 (extract 스크립트 결과)
  태양광시설-표준데이터/<지역>_원본_p*.json       기존 태양광 시설 (공공데이터포털)
  공장등록-전국/가공/<시도>_<시군구>.json          전국공장등록현황 (전화번호)
출력
  data/regions.json              지역 목록
  data/<코드>/info.json          회사(묶음) 목록
  data/<코드>/bldg.geojson       건물 도형
  data/<코드>/solar.geojson      기존 태양광 위치
  data/search/<시도코드>.json    통합 검색용 색인

실행:  KAKAO_KEY=... python3 tools/build_data.py
"""
import json, math, os, sys, glob, re, collections, urllib.request, urllib.parse, time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser('~')
GIS = os.path.join(HOME, '클로드코드/업무/GIS 자료')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data')
CACHE = os.path.join(GIS, '태양광시설-표준데이터/캐시')
KAKAO = os.environ.get('KAKAO_KEY', '')

# 지역을 추가하려면 여기에 한 줄을 더하고, 건물 추출본과 태양광 원본을 같은 이름 규칙으로 넣는다.
REGIONS = [
    {'code': '43750', 'sido': '충청북도', 'name': '진천군', 'bldg': '진천_사각범위_건물.jsonl', 'solar': '진천_원본_p*.json'},
]
MIN_AREA = 500.0                    # 동 단위 최소 지붕 면적(㎡)
KIND_OK = {'BDK004', 'BDK005'}      # 주택외건물, 무벽건물
USE_OK = {'BDS015', 'BDS016'}       # 공장, 창고시설
LINK_M = 500.0                      # 같은 이름 건물을 한 사업장으로 묶는 거리
NEAR_M = 50.0                       # 태양광 좌표가 건물 밖일 때 '근처'로 보는 거리
REG_NAME_M = 300.0                  # 공장등록 주소와 이름이 같은 건물을 찾는 거리
REG_ADDR_M = 30.0                   # 이름이 달라도 같은 곳으로 보는 거리
CF_YEARS = 3                        # 이용률 평균에 쓰는 최근 연도 수
SIDO_KPX = {'강원특별자치도': '강원도', '전북특별자치도': '전라북도', '제주특별자치도': '제주도', '세종특별자치시': '세종'}

def sido_cf(sido):
    """전력거래소 시도별 태양광 실적 이용률의 최근 3개년 평균"""
    d = json.load(open(os.path.join(GIS, '태양광이용률-전력거래소/연도별_태양광이용률.json'), encoding='utf-8'))['값']
    key = SIDO_KPX.get(sido, sido)
    if key not in d: key = re.sub(r'(특별시|광역시|특별자치시)$', '', key)
    ys = sorted(d[key])[-CF_YEARS:]; vals = [float(d[key][y]) for y in ys]
    return {'pct': round(sum(vals) / len(vals), 2), 'years': ys, 'vals': vals, 'area': key}

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
    if abs(a) < 1e-9: return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
    return cx / (3 * a), cy / (3 * a)
def inside(x, y, rings):
    c = False
    for r in rings:
        j = len(r) - 1
        for i in range(len(r)):
            xi, yi = r[i]; xj, yj = r[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
            j = i
    return c
def dist_to(x, y, rings):
    if inside(x, y, rings): return 0.0
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
    err = None
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
    a = a.replace('번지', ' ')
    m = re.match(r'^(.*?(?:리|동|가|로|길)\s+(?:산\s*)?\d+(?:-\d+)?)', a)
    return m.group(1) if m else a
def geocode_many(addrs):
    """주소 목록 -> {주소: [경도, 위도] 또는 None}. 한 번 찾은 주소는 캐시에서 읽는다."""
    gc = cache_load('geocode.json'); todo = [a for a in dict.fromkeys(addrs) if a and a not in gc]
    if todo and KAKAO:
        def one(raw):
            r = kakao('search/address.json', query=clean_addr(raw)); doc = (r.get('documents') or [None])[0]
            return raw, ([float(doc['x']), float(doc['y'])] if doc else None)
        with ThreadPoolExecutor(6) as ex:
            for raw, v in ex.map(one, todo): gc[raw] = v
        cache_save('geocode.json', gc)
    return gc

def norm(s): return re.sub(r'\s+', '', s or '')
def core(s):
    """회사명 비교용: 법인 표기, 공장·사업장 꼬리말, 기호를 뗀 알맹이"""
    s = re.sub(r'\(주\)|㈜|주식회사|\(유\)|유한회사|\(합\)|\(자\)|농업회사법인|영농조합법인|\(사\)', '', s or '')
    s = re.sub(r'[\s\.\,\(\)\-·&]', '', s).lower()
    s = re.sub(r'(제?\d+공장|진천공장|진천사업장|진천지점|공장|사업장|지점|본사|물류센터)+$', '', s)
    return s
def same_name(a, b):
    a, b = core(a), core(b)
    return len(a) >= 2 and len(b) >= 2 and (a in b or b in a)

# ---------- 지역 하나 만들기 ----------
def build(reg):
    code = reg['code']; print('==', reg['sido'], reg['name'])
    allb = []
    for line in open(os.path.join(GIS, '연속수치지형도-건물/가공', reg['bldg']), encoding='utf-8'):
        r = json.loads(line)
        if r['attrs']['BJCD'].startswith(code): allb.append(r)
    for b in allb:
        xs = [p[0] for r in b['rings'] for p in r]; ys = [p[1] for r in b['rings'] for p in r]
        b['bb'] = (min(xs), min(ys), max(xs), max(ys)); b['c'] = centroid(b['rings'][0])
    cand = [b for b in allb if b['area_m2'] >= MIN_AREA and b['attrs']['KIND'] in KIND_OK]
    print('전체 건물', len(allb), '/ 500㎡ 이상 주택외·무벽', len(cand))

    # 1) 묶기: 지도 표기 이름이 같고 가까운 건물끼리
    keyed = collections.defaultdict(list)
    for i, b in enumerate(cand):
        a = b['attrs']; nm = norm(a['ANNO'] or a['NAME'])
        k = ('N', nm) if nm else ('R', a['RDNM'] + '-' + a['BONU'] + '-' + a['BUNU']) if a['RDNM'] else ('U', str(i))
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
    # 주용도가 공장·창고인 묶음만 남기고 면적 큰 순으로 번호를 매긴다
    def main_use(m):
        u = collections.Counter()
        for i in m: u[cand[i]['attrs']['SERV']] += cand[i]['area_m2']
        return max(u, key=u.get)
    groups = [g for g in groups if main_use(g[1]) in USE_OK]
    groups.sort(key=lambda g: -sum(cand[i]['area_m2'] for i in g[1]))
    for gid, (k, m) in enumerate(groups):
        for i in m: cand[i]['gid'] = gid
    gb = [b for b in cand if 'gid' in b]
    print('묶음', len(groups), '건물', len(gb), '면적', round(sum(b['area_m2'] for b in gb)))

    cell = 100.0
    def make_grid(items, pad):
        g = collections.defaultdict(list)
        for i, b in enumerate(items):
            for gx in range(int((b['bb'][0] - pad) // cell), int((b['bb'][2] + pad) // cell) + 1):
                for gy in range(int((b['bb'][1] - pad) // cell), int((b['bb'][3] + pad) // cell) + 1): g[(gx, gy)].append(i)
        return g
    grid_all = make_grid(allb, 0); grid_near = make_grid(gb, NEAR_M); grid_reg = make_grid(gb, REG_NAME_M)

    # 2) 기존 태양광
    sol = []
    for f in sorted(glob.glob(os.path.join(GIS, '태양광시설-표준데이터', reg['solar']))):
        d = json.load(open(f, encoding='utf-8')); d = d.get('response', d); x = d['body']['items']; sol += x['item'] if isinstance(x, dict) else x
    sdate = collections.Counter(s.get('crtrYmd') for s in sol).most_common(1)[0][0] if sol else ''
    gc = geocode_many([(s.get('lctnRoadNmAddr') or s.get('lctnLotnoAddr')) for s in sol if not s.get('latitude')])
    gsolar = collections.defaultdict(list); spts = []; stat = collections.Counter()
    for s in sol:
        raw = s.get('lctnRoadNmAddr') or s.get('lctnLotnoAddr') or ''
        if s.get('latitude'): lon, lat = float(s['longitude']), float(s['latitude'])
        elif gc.get(raw): lon, lat = gc[raw]
        else: stat['위치 못 찾음'] += 1; continue
        x, y = to_xy(lon, lat); hit = None; how = 'none'
        for i in grid_all.get((int(x // cell), int(y // cell)), []):
            b = allb[i]
            if b['bb'][0] <= x <= b['bb'][2] and b['bb'][1] <= y <= b['bb'][3] and inside(x, y, b['rings']):
                if 'gid' in b: hit = b; how = 'on'
                else: how = 'other'
                break
        if how == 'none':
            best = (NEAR_M + 1, None)
            for i in grid_near.get((int(x // cell), int(y // cell)), []):
                d = dist_to(x, y, gb[i]['rings'])
                if d < best[0]: best = (d, gb[i])
            if best[1] is not None: hit = best[1]; how = 'near'
        rec = {'nm': s.get('solarGenFcltNm', ''), 'kw': float(s.get('capa') or 0), 'yr': s.get('instlYr', '')}
        if hit is not None:
            gsolar[hit['gid']].append(dict(rec, how=how))
            if how == 'on': hit['sol'] = True          # 목록 좌표가 이 동 위에 있음
        stat[{'on': '후보 건물 위', 'near': '후보 건물 %dm 안' % NEAR_M, 'other': '후보 아닌 건물 위', 'none': '건물과 무관'}[how]] += 1
        spts.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]}, 'properties': dict(rec, ad=raw)})
    print('태양광', len(sol), dict(stat))

    # 2-1) 사진 판독 결과(목록에 없는 자가용 설비를 잡는다). 번호는 건물 순서라 동수가 다르면 쓰지 않는다
    pp = os.path.join(GIS, '지붕사진/판독/최종_%s.json' % code); nph = 0
    if os.path.exists(pp):
        ph = json.load(open(pp, encoding='utf-8'))
        if ph.get('건물수') == len(gb):
            for i, b in enumerate(gb):
                if ph['패널있음'].get(str(i)) == 'Y': b['ph'] = True; nph += 1
        else: print('  ! 사진 판독 파일의 동수가 달라 쓰지 않음', ph.get('건물수'), len(gb))
    print('  사진 판독 패널 있음', nph, '동 / 목록 좌표가 올라간 동', sum(1 for b in gb if b.get('sol')))

    # 3) 공장등록(전화번호) 연결
    rp = os.path.join(GIS, '공장등록-전국/가공', '%s_%s.json' % (reg['sido'], reg['name']))
    regs = json.load(open(rp, encoding='utf-8')) if os.path.exists(rp) else []
    gc = geocode_many([r.get('공장주소_지번') or r.get('공장주소') for r in regs])
    greg = collections.defaultdict(list); rstat = collections.Counter()
    for r in regs:
        pt = gc.get(r.get('공장주소_지번') or r.get('공장주소'))
        if not pt and r.get('공장주소'): pt = geocode_many([r['공장주소']]).get(r['공장주소'])
        if not pt: rstat['주소 위치 못 찾음'] += 1; continue
        x, y = to_xy(*pt); byname = (1e18, None); byaddr = (1e18, None)
        for i in grid_reg.get((int(x // cell), int(y // cell)), []):
            b = gb[i]; d = dist_to(x, y, b['rings'])
            if d <= REG_NAME_M and d < byname[0] and same_name(r['회사명'], b['attrs']['ANNO'] or b['attrs']['NAME']): byname = (d, b)
            if d <= REG_ADDR_M and d < byaddr[0]: byaddr = (d, b)
        hit, how = (byname[1], 'name') if byname[1] is not None else (byaddr[1], 'addr') if byaddr[1] is not None else (None, None)
        if hit is None: rstat['맞는 후보 건물 없음'] += 1; continue
        rstat['이름 일치' if how == 'name' else '주소 일치'] += 1
        tel = (r.get('전화번호') or '').strip()
        greg[hit['gid']].append({'nm': r['회사명'], 'tel': tel, 'own': r.get('보유구분', ''), 'how': how, 'ba': float(r.get('건축면적') or 0)})
    print('공장등록', len(regs), dict(rstat))

    # 4) 이용률: 전력거래소 실적(시도별, 최근 3개년 평균)
    cf = sido_cf(reg['sido'])
    centers = {}
    for gid, (k, m) in enumerate(groups):
        centers[gid] = to_ll(*cand[max(m, key=lambda i: cand[i]['area_m2'])]['c'])

    # 5) 주소 (묶음 대표 건물 위치)
    rg = cache_load('revgeo.json'); todo = [gid for gid in centers if '%f,%f' % centers[gid] not in rg]
    if todo and KAKAO:
        def rev(gid):
            lon, lat = centers[gid]; r = kakao('geo/coord2address.json', x=lon, y=lat); doc = (r.get('documents') or [None])[0]; v = None
            if doc: v = {'road': (doc.get('road_address') or {}).get('address_name', ''), 'jibun': (doc.get('address') or {}).get('address_name', '')}
            return '%f,%f' % (lon, lat), v
        with ThreadPoolExecutor(6) as ex:
            for key, v in ex.map(rev, todo):
                if v is not None: rg[key] = v
        cache_save('revgeo.json', rg)

    # 6) 쓰기
    G = []
    for gid, (k, m) in enumerate(groups):
        bs = [cand[i] for i in m]; big = max(bs, key=lambda b: b['area_m2']); lon, lat = centers[gid]
        ad = rg.get('%f,%f' % (lon, lat)) or {}; so = sorted(gsolar.get(gid, []), key=lambda s: -s['kw'])
        rr = sorted(greg.get(gid, []), key=lambda r: (r['how'] != 'name', not r['tel'], r['own'] != '자가', -r['ba']))
        mapnm = (big['attrs']['ANNO'] or big['attrs']['NAME']) if k[0] == 'N' else ''
        tok = (ad.get('jibun') or '').split()
        g = {'id': gid, 'nm': mapnm or (rr[0]['nm'] if rr else ''), 'emd': tok[2] if len(tok) > 2 else '', 'ad': ad.get('road') or ad.get('jibun') or '',
             'c': [lon, lat]}
        # 동 단위 판정: 목록 좌표가 올라갔거나 사진에 패널이 보이는 동은 설치된 것으로 보고, 남은 동만 후보 면적으로 센다
        inst = [b for b in bs if b.get('sol') or b.get('ph')]; rem = [b for b in bs if not (b.get('sol') or b.get('ph'))]
        on = [s for s in so if s['how'] == 'on']
        g.update({'n': len(rem), 'a': round(sum(b['area_m2'] for b in rem)), 'nt': len(bs), 'at': round(sum(b['area_m2'] for b in bs)),
                  'st': 'on' if not rem else 'part' if inst else 'none', 'sn': len(on), 'skw': round(sum(s['kw'] for s in on), 1),
                  'ph': sum(1 for b in inst if not b.get('sol')), 'nr': len(so) - len(on)})
        if rr:
            g['tel'] = rr[0]['tel']; g['own'] = rr[0]['own']
            if mapnm and not same_name(mapnm, rr[0]['nm']): g['telnm'] = rr[0]['nm']     # 번호 주인이 지도 표기와 다를 때만 표시
            if len(rr) > 1: g['regn'] = len(rr)
        G.append(g)
    feats = [{'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [[list(to_ll(x, y)) for x, y in r] for r in b['rings']]},
              'properties': {'g': b['gid'], 'st': 'on' if (b.get('sol') or b.get('ph')) else 'near' if G[b['gid']]['nr'] else 'none'}} for b in gb]
    od = os.path.join(OUT, code); os.makedirs(od, exist_ok=True)
    def dump(name, obj):
        p = os.path.join(od, name); json.dump(obj, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':')); print(' ', code + '/' + name, round(os.path.getsize(p) / 1e6, 2), 'MB')
    meta = {'code': code, 'sido': reg['sido'], 'name': reg['name'], 'cf': cf, 'solar_date': sdate, 'n_solar': len(sol),
            'check': {'n_bldg': len(gb), 'area': round(sum(b['area_m2'] for b in gb)), 'n_group': len(G), 'solar': dict(stat), 'reg': dict(rstat)}}
    dump('info.json', {'meta': meta, 'groups': G})
    dump('bldg.geojson', {'type': 'FeatureCollection', 'features': feats})
    dump('solar.geojson', {'type': 'FeatureCollection', 'features': spts})
    tel = sum(1 for g in G if g.get('tel')); print('  전화번호 있는 묶음', tel, '/', len(G), ' 이름 없는 묶음', sum(1 for g in G if not g['nm']))
    xs = [g['c'][0] for g in G]; ys = [g['c'][1] for g in G]
    short = lambda a: re.sub(r'^\S+\s+%s\s*' % re.escape(reg['name']), '', a)
    return ({'code': code, 'sido': reg['sido'], 'name': reg['name'], 'n': len(G), 'bbox': [min(xs), min(ys), max(xs), max(ys)]},
            [[g['nm'], short(g['ad']), code, g['id'], g['at']] for g in G])

def main():
    os.makedirs(os.path.join(OUT, 'search'), exist_ok=True)
    regions = []; index = collections.defaultdict(list)
    for reg in REGIONS:
        info, rows = build(reg); regions.append(info); index[reg['code'][:2]] += rows
    for sc, rows in index.items():
        p = os.path.join(OUT, 'search', sc + '.json'); json.dump(rows, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        print('search/%s.json' % sc, len(rows), '건', round(os.path.getsize(p) / 1e6, 2), 'MB')
    json.dump({'built': time.strftime('%Y-%m-%d'), 'regions': regions,
               'src': {'bldg': '브이월드 「건물」(국토지리정보원 연속수치지형도), 2026-10-01', 'solar': '전국태양광발전시설 표준데이터(공공데이터포털)',
                       'pv': '전력거래소 전력통계정보시스템(EPSIS) 신재생에너지 이용률', 'reg': '전국공장등록현황(한국산업단지공단), 2026-06 말'}},
              open(os.path.join(OUT, 'regions.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('regions.json', len(regions), '곳')

if __name__ == '__main__':
    main()
