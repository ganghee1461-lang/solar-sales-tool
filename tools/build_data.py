"""지붕 태양광 후보 자료를 전국 시군구별로 만든다. 원본은 읽기만 하고 결과는 data/ 에 쓴다. 외부 API 를 쓰지 않는다.

입력 (모두 ~/클로드코드/업무/GIS 자료 아래)
  연속수치지형도-건물/가공/cand/<시군구>.jsonl   tools/extract_all.py 결과 (500㎡ 이상 공장형 건물)
  태양광시설-표준데이터/전국_원본/p*.json         전국태양광발전시설 표준데이터 (지자체 등록분)
  공장등록-전국/가공/<시도>_<시군구>.json         전국공장등록현황 (전화번호)
  도로명주소/원본/*도로명주소 한글_전체분.zip     도로명 코드와 이름, 지번과 도로명 대조
  태양광이용률-전력거래소/연도별_태양광이용률.json
출력
  data/regions.json, data/<코드>/info.json, data/<코드>/bldg.geojson, data/search/<시도코드>.json

실행:  python3 tools/build_data.py            (전국)
       python3 tools/build_data.py 43750 ...  (일부 시군구만 다시 만들 때. regions.json 은 전국 실행 때만 갱신)
"""
import json, math, os, sys, glob, re, collections, time, zipfile, pickle
import multiprocessing as mp

HOME = os.path.expanduser('~'); GIS = os.path.join(HOME, '클로드코드/업무/GIS 자료')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); OUT = os.path.join(ROOT, 'data')
CAND = os.path.join(GIS, '연속수치지형도-건물/가공/cand')
JUSO_ZIP = glob.glob(os.path.join(GIS, '도로명주소/원본/*도로명주소 한글_전체분.zip'))[0]
JCACHE = os.path.join(GIS, '도로명주소/가공'); os.makedirs(JCACHE, exist_ok=True)

USE_OK = {'BDS015', 'BDS016'}       # 공장, 창고시설
MIN_GROUP_AREA = 667.0              # 회사 전체 지붕이 이보다 작으면 싣지 않는다(설치 비율 50%, ㎡당 0.30kW 기준 100kW)
LINK_M = 500.0                      # 같은 이름 건물을 한 사업장으로 묶는 거리
CF_YEARS = 3                        # 이용률 평균에 쓰는 최근 연도 수
USE_PHOTO = True                    # 사진 판독(자가용 추정) 결과를 기존 태양광에 더한다 (2026-11-18 사용자 결정으로 켬)
_PHOTO = None
def photo_keys(code):
    """패널이 보이는 동의 고유번호. 상위 모델이 직접 확인한 시군구 파일(진천)이 있으면 그걸, 없으면 전국 판독에서 소네트까지 '있음'인 동."""
    global _PHOTO
    pp = os.path.join(GIS, '지붕사진/판독/패널있음_%s_고유번호.json' % code)
    if os.path.exists(pp): return set(json.load(open(pp, encoding='utf-8'))['패널있음'])
    if _PHOTO is None:
        last = {}
        rf = os.path.join(GIS, '지붕사진/판독/전국/결과.jsonl')
        if os.path.exists(rf):
            for l in open(rf, encoding='utf-8'):
                d = json.loads(l)
                if d['pass'] == 3: last[d['k']] = d['v']
        _PHOTO = {k for k, v in last.items() if v == 'Y'}
    return _PHOTO
KPX = {'11': '서울', '26': '부산', '27': '대구', '28': '인천', '29': '광주', '30': '대전', '31': '울산', '36': '세종', '41': '경기도', '43': '충청북도',
       '44': '충청남도', '46': '전라남도', '47': '경상북도', '48': '경상남도', '50': '제주도', '51': '강원도', '52': '전라북도'}
# 건물 자료는 광주·전남이 예전 코드(29, 46)이고 도로명주소 자료는 통합 코드(12)라서 이름으로 맞춘 대조표
OLD2NEW = {'29110': '12210', '29140': '12240', '29155': '12270', '29170': '12300', '29200': '12330', '46110': '12110', '46130': '12130', '46150': '12150',
           '46170': '12170', '46230': '12190', '46710': '12710', '46720': '12720', '46730': '12730', '46770': '12740', '46780': '12750', '46790': '12760',
           '46800': '12770', '46810': '12780', '46820': '12790', '46830': '12800', '46840': '12810', '46860': '12820', '46870': '12830', '46880': '12840',
           '46890': '12850', '46900': '12860', '46910': '12870'}
SIDO_ALIAS = {'광주광역시': '전남광주통합특별시', '전라남도': '전남광주통합특별시'}

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
_E1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2)); _MU = A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256)
def to_ll(x, y):
    mu = (M0 + (y - FN) / K0) / _MU; e1 = _E1
    p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) \
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
    sp = math.sin(p1); N1 = A / math.sqrt(1 - E2 * sp * sp); T1 = math.tan(p1) ** 2; C1 = EP2 * math.cos(p1) ** 2
    R1 = A * (1 - E2) / (1 - E2 * sp * sp) ** 1.5; D = (x - FE) / (N1 * K0)
    lat = p1 - (N1 * math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
                                           + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720)
    lon = LON0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / math.cos(p1)
    return round(math.degrees(lon), 6), round(math.degrees(lat), 6)

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

def norm(s): return re.sub(r'\s+', '', s or '')
def core(s):
    """회사명 비교용: 법인 표기, 공장·사업장 꼬리말, 기호를 뗀 알맹이"""
    s = re.sub(r'\(주\)|㈜|주식회사|\(유\)|유한회사|\(합\)|\(자\)|농업회사법인|영농조합법인|\(사\)', '', s or '')
    s = re.sub(r'[\s\.\,\(\)\-·&]', '', s).lower()
    return re.sub(r'(제?\d+공장|[가-힣]{2}공장|[가-힣]{2}사업장|[가-힣]{2}지점|공장|사업장|지점|본사|물류센터)+$', '', s)
def same_name(a, b):
    a, b = core(a), core(b)
    return len(a) >= 2 and len(b) >= 2 and (a in b or b in a)

RE_ROAD = re.compile(r'(\S*(?:로|길))\s+(?:지하\s*)?(\d+)(?:-(\d+))?')
RE_JIBUN = re.compile(r'^\s*(\S+?[읍면동가])\s+(?:(\S+리)\s+)?(산\s*)?(\d+)(?:-(\d+))?')
RE_ROOF = re.compile(r'(주|부)\s*\d|[A-Za-z가-힣0-9]동(\s|,|$)|지붕|옥상|건물|공장|창고')

# ---------- 준비: 도로명주소, 공장등록, 태양광 목록 (한 번 읽어 전 지역이 함께 쓴다) ----------
def juso_lines(prefix):
    zf = zipfile.ZipFile(JUSO_ZIP)
    for n in zf.namelist():
        if os.path.basename(n).startswith(prefix):
            with zf.open(n) as f:
                for raw in f: yield raw.decode('cp949', 'ignore').rstrip('\r\n').split('|')

def load_juso_base():
    """도로명 코드->이름, 시군구 코드<->이름, 법정동 코드<->이름"""
    p = os.path.join(JCACHE, 'base2.pkl')
    if os.path.exists(p): return pickle.load(open(p, 'rb'))
    road = {}; sgg = {}; bjd = {}; remd = collections.defaultdict(collections.Counter)
    for c in juso_lines('rnaddrkor_'):
        if len(c) < 14: continue
        road[c[9]] = c[10]; sgg[c[1][:5]] = (c[2], c[3]); bjd[c[1]] = (c[4], c[5]); remd[c[9]][c[4]] += 1
    d = {'road': road, 'sgg': sgg, 'bjd': bjd, 'road_emd': {k: v.most_common(1)[0][0] for k, v in remd.items()}}; pickle.dump(d, open(p, 'wb')); return d

def addr_keys(sgg5, rest, J):
    """주소의 시군구 뒷부분 -> (도로명 열쇠, 지번 열쇠). 도로명 열쇠=(도로명코드, 본번, 부번), 지번 열쇠=(법정동코드, 산, 번지, 호)"""
    rk = jk = None
    m = RE_ROAD.search(rest)
    if m:
        rc = J['road_by_name'].get((sgg5, m.group(1)))
        if rc: rk = (rc, int(m.group(2)), int(m.group(3) or 0))
    m = RE_JIBUN.match(rest)
    if m:
        b = J['bjd_by_name'].get((sgg5, m.group(1), m.group(2) or ''))
        if b: jk = (b, 1 if m.group(3) else 0, int(m.group(4)), int(m.group(5) or 0))
    return rk, jk

def split_addr(addr, J):
    """'충청북도 청주시 흥덕구 ...' -> (시군구코드, 나머지)"""
    t = addr.split()
    if not t: return None, ''
    sido = SIDO_ALIAS.get(t[0], t[0])
    for n in (2, 1, 0):
        code = J['sgg_by_name'].get((sido, ' '.join(t[1:1 + n])))
        if code: return code, ' '.join(t[1 + n:])
    return None, ''

def prepare():
    J = load_juso_base()
    J['road_by_name'] = {(rc[:5], nm): rc for rc, nm in J['road'].items()}
    J['sgg_by_name'] = {v: k for k, v in J['sgg'].items()}
    J['bjd_by_name'] = {(k[:5], v[0], v[1]): k for k, v in J['bjd'].items()}
    J['emd8'] = {k[:8]: v[0] for k, v in J['bjd'].items()}      # 건물 자료의 법정동코드는 읍면 단위라 앞 8자리로 읍면동 이름을 찾는다
    J['road_in_sido'] = collections.defaultdict(set)
    for rc, nm in J['road'].items(): J['road_in_sido'][(J['sgg'][rc[:5]][0], nm)].add(rc)
    # 공장등록
    regs = collections.defaultdict(list); rstat = collections.Counter()
    for f in glob.glob(os.path.join(GIS, '공장등록-전국/가공/*_*.json')):
        if os.path.basename(f).startswith('_'): continue
        for r in json.load(open(f, encoding='utf-8')):
            sido = SIDO_ALIAS.get(r['시도명'], r['시도명']); code = J['sgg_by_name'].get((sido, r['시군구명'] or ''))
            rk = jk = None
            if code:
                def rest(a):
                    c2, rs = split_addr(a or '', J); return rs if c2 else ''
                rk, _ = addr_keys(code, rest(r.get('공장주소')), J); _, jk = addr_keys(code, rest(r.get('공장주소_지번')), J)
            else:
                m = RE_ROAD.search(r.get('공장주소') or ''); c = J['road_in_sido'].get((sido, m.group(1))) if m else None
                if c and len(c) == 1: rc = next(iter(c)); code = rc[:5]; rk = (rc, int(m.group(2)), int(m.group(3) or 0)); rstat['시군구 이름 바뀜·도로명으로 찾음'] += 1
                else: rstat['시군구 못 찾음'] += 1; MISS[(r['시도명'], r['시군구명'])] += 1; continue
            zone = (r.get('용도지역') or '').split('/')[-1].strip()
            uniq = lambda v: ', '.join(dict.fromkeys(x.strip() for x in str(v or '').split(',') if x.strip()))
            regs[code].append({'nm': r['회사명'], 'tel': (r.get('전화번호') or '').strip(), 'own': r.get('보유구분') or '', 'ba': float(r.get('건축면적') or 0), 'rk': rk, 'jk': jk,
                               # 팝업에 보여 줄 공장 정보(원문 그대로)
                               'f': {k: v for k, v in {'up': r.get('업종명') or '', 'pr': uniq(r.get('생산품')), 'sz': r.get('공장규모') or '', 'emp': int(float(r.get('종업원합계') or 0)),
                                     'dan': (r.get('단지명') or '').strip(), 'ip': r.get('공장구분') or '', 'yr': (r.get('최초등록일') or '')[:4], 'land': round(float(r.get('용지면적') or 0)),
                                     'zone': zone, 'jm': uniq(r.get('지목'))}.items() if v}})
            rstat['도로명 열쇠 있음' if rk else '도로명 열쇠 없음'] += 1
    print('공장등록', sum(len(v) for v in regs.values()), dict(rstat), flush=True)
    if MISS: print('  시군구 이름이 도로명주소 자료에 없는 곳', MISS.most_common(12), flush=True)
    # 태양광 목록
    sol = []
    for f in sorted(glob.glob(os.path.join(GIS, '태양광시설-표준데이터/전국_원본/p*.json'))):
        d = json.load(open(f, encoding='utf-8')); d = d.get('response', d); x = d['body']['items']; sol += x['item'] if isinstance(x, dict) else x
    pts = []; noxy = collections.defaultdict(list); sstat = collections.Counter(); sdate = collections.Counter()
    for s in sol:
        try: kw = float(s.get('capa') or 0)
        except ValueError: kw = 0.0; sstat['용량 값 오류(0으로 둠)'] += 1
        rec = (kw, s.get('solarGenFcltNm', ''), s.get('instlYr', '')); sdate[s.get('crtrYmd', '')] += 1
        if s.get('latitude') and s.get('longitude'):
            try: x, y = to_xy(float(s['longitude']), float(s['latitude']))
            except ValueError: sstat['좌표 오류'] += 1; continue
            pts.append((x, y, rec)); sstat['좌표 있음'] += 1
        else:
            raw = s.get('lctnRoadNmAddr') or s.get('lctnLotnoAddr') or ''
            code, rs = split_addr(raw, J)
            if not code: sstat['좌표 없음·주소 해석 실패'] += 1; continue
            rk, jk = addr_keys(code, rs, J)
            if rk or jk: noxy[code].append((rk, jk, rec)); sstat['좌표 없음·주소로 대조'] += 1
            else: sstat['좌표 없음·주소 해석 실패'] += 1
    print('태양광', len(sol), dict(sstat), flush=True)
    grid = collections.defaultdict(list)
    for i, (x, y, _) in enumerate(pts): grid[(int(x // 100), int(y // 100))].append(i)
    # 지번 -> 도로명 열쇠 (필요한 지번만 골라 담는다)
    need = {r['jk'] for v in regs.values() for r in v if r['jk'] and not r['rk']} | {jk for v in noxy.values() for rk, jk, _ in v if jk and not rk}
    cp = os.path.join(JCACHE, 'jmap_%d.pkl' % len(need))
    if os.path.exists(cp): jmap = pickle.load(open(cp, 'rb'))
    else:
        jmap = {}
        for c in juso_lines('rnaddrkor_'):
            if len(c) < 14: continue
            k = (c[1], int(c[6] or 0), int(c[7] or 0), int(c[8] or 0))
            if k in need: jmap[k] = (c[9], int(c[12] or 0), int(c[13] or 0))
        for c in juso_lines('jibun_rnaddrkor_'):
            if len(c) < 13: continue
            k = (c[1], int(c[6] or 0), int(c[7] or 0), int(c[8] or 0))
            if k in need and k not in jmap: jmap[k] = (c[9], int(c[11] or 0), int(c[12] or 0))
        pickle.dump(jmap, open(cp, 'wb'))
    print('지번 대조', len(jmap), '/', len(need), flush=True)
    cf = json.load(open(os.path.join(GIS, '태양광이용률-전력거래소/연도별_태양광이용률.json'), encoding='utf-8'))['값']
    return {'J': J, 'regs': regs, 'pts': pts, 'grid': grid, 'noxy': noxy, 'jmap': jmap, 'cf': cf, 'sdate': sdate.most_common(1)[0][0]}

# ---------- 부가정보(건축물대장, 계통 여유): tools/fetch_extra.py 가 받아 둔 것을 읽는다 ----------
EXTRA = os.path.join(GIS, '부가정보')
RE_SLATE = re.compile(r'슬레이트|스레트|슬레트|스레이트')
def load_jibun(code):
    p = os.path.join(EXTRA, '지번', code + '.json')
    return {tuple(json.loads(k)): v for k, v in json.load(open(p, encoding='utf-8')).items()} if os.path.exists(p) else {}
def extra_of(bs, jb, grids):
    """건물 묶음 -> (건축물대장 요약, 계통 조회 법정동코드). 큰 건물부터 3동의 지번을 본다(받을 때와 같은 기준)"""
    js = [jb[b['rk']] for b in sorted((b for b in bs if 'rk' in b), key=lambda b: -round(b['area_m2']))[:3] if b['rk'] in jb]
    if not js: return None, None
    items = []
    for lot in dict.fromkeys((j[0], j[1], j[2], j[3]) for j in js):
        p = os.path.join(EXTRA, '건축물대장', lot[0][:5], '%s_%d_%d_%d.json' % lot)
        if os.path.exists(p): items += json.load(open(p, encoding='utf-8'))
    fw = [i for i in items if i.get('mainPurpsCdNm') in ('공장', '창고시설')] or items      # 공장·창고 동이 있으면 그것만
    b = None
    if fw:
        yr = lambda i: (str(i.get('useAprDay') or '').strip()[:4])
        main = max(fw, key=lambda i: float(i.get('archArea') or 0)); ys = sorted(y for y in map(yr, fw) if len(y) == 4 and y.isdigit())
        b = {'y': yr(main) if yr(main).isdigit() else '', 'y0': ys[0] if ys else '', 'y1': ys[-1] if ys else '', 'st': (main.get('strctCdNm') or '').strip(),
             'rf': (main.get('etcRoof') or '').strip() or (main.get('roofCdNm') or '').strip(), 'n': len(fw),
             'sl': sum(1 for i in fw if RE_SLATE.search((i.get('roofCdNm') or '') + (i.get('etcRoof') or '')))}
        b = {k: v for k, v in b.items() if v}
    kb = js[0][0]
    if kb not in grids:
        p = os.path.join(EXTRA, '계통', kb + '.json'); g = None
        if os.path.exists(p):
            d = json.load(open(p, encoding='utf-8')); u = {}
            for r in d['rows']: u[(r['substNm'], r['mtrNo'], r['dlNm'])] = [r['substNm'], str(r['mtrNo']), r['dlNm'], int(r['vol1']), int(r['vol2']), int(r['vol3'])]
            if u: g = {'d': d['day'], 'n': (js[0][4] + ' ' + js[0][5]).strip(), 'l': list(u.values())}      # n = 조회한 읍면동·리 이름      # l = [변전소, 주변압기 번호, 선로, 변전소 여유, 주변압기 여유, 선로 여유(kW)]
        grids[kb] = g
    return b, kb if grids[kb] else None

MISS = collections.Counter()
P = None   # 준비한 자료 (작업 프로세스들이 함께 본다)

# ---------- 시군구 하나 만들기 ----------
def split_region(old, J):
    """행정구역이 나뉜 곳(인천 중·동·서구, 화성시): 건물의 도로명 번호가 어느 새 구에 있는지로 나누고,
    도로명이 없거나 여러 구에 걸친 건물은 가장 가까운 확정 건물의 구를 따른다. 결과는 임시 파일로 쓴다."""
    news = [k for k in J['sgg'] if k[:2] == old[:2] and not os.path.exists(os.path.join(CAND, k + '.jsonl')) and k not in OLD2NEW.values()]
    rows = [json.loads(l) for l in open(os.path.join(CAND, old + '.jsonl'), encoding='utf-8')]
    grid = collections.defaultdict(list); todo = []
    for b in rows:
        b['c'] = centroid(b['rings'][0]); rn = b['attrs']['RDNM']
        hit = [k for k in news if rn and (k + rn) in J['road']]
        if len(hit) == 1: b['new'] = hit[0]; grid[(int(b['c'][0] // 1000), int(b['c'][1] // 1000))].append(b)
        else: todo.append(b)
    for b in todo:
        gx, gy = int(b['c'][0] // 1000), int(b['c'][1] // 1000); best = None
        for r in range(0, 30):
            for x in range(gx - r, gx + r + 1):
                for y in range(gy - r, gy + r + 1):
                    if max(abs(x - gx), abs(y - gy)) != r: continue
                    for o in grid.get((x, y), ()):
                        d = math.hypot(o['c'][0] - b['c'][0], o['c'][1] - b['c'][1])
                        if best is None or d < best[0]: best = (d, o['new'])
            if best and best[0] <= r * 1000: break
        b['new'] = best[1] if best else news[0]
    return rows

def build(arg):
    old, path, code = arg
    J = P['J']; sido, sgname = J['sgg'].get(code, ('', ''))
    if not sido: return {'code': code, 'skip': '시군구 이름 없음'}
    cand = [json.loads(l) for l in open(path, encoding='utf-8')]
    for b in cand: b['c'] = centroid(b['rings'][0])
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
        if len(idxs) > 1:
            for x in range(len(idxs)):
                ax, ay = cand[idxs[x]]['c']
                for y in range(x + 1, len(idxs)):
                    bx, by = cand[idxs[y]]['c']
                    if abs(ax - bx) <= LINK_M and abs(ay - by) <= LINK_M and math.hypot(ax - bx, ay - by) <= LINK_M: par[find(idxs[x])] = find(idxs[y])
        cl = collections.defaultdict(list)
        for i in idxs: cl[find(i)].append(i)
        for m in cl.values(): groups.append((k, m))
    def main_use(m):
        u = collections.Counter()
        for i in m: u[cand[i]['attrs']['SERV']] += cand[i]['area_m2']
        return max(u, key=u.get)
    groups = [g for g in groups if main_use(g[1]) in USE_OK and sum(cand[i]['area_m2'] for i in g[1]) >= MIN_GROUP_AREA]   # 주용도가 공장·창고이고 지붕이 넓은 묶음만
    groups.sort(key=lambda g: -sum(cand[i]['area_m2'] for i in g[1]))
    for gid, (k, m) in enumerate(groups):
        for i in m: cand[i]['gid'] = gid
    gb = [b for b in cand if 'gid' in b]
    if not gb: return {'code': code, 'skip': '공장·창고 묶음 없음'}
    by_road = collections.defaultdict(list); by_bjd = collections.defaultdict(list); by_core = collections.defaultdict(list)
    for b in gb:
        a = b['attrs']
        if a['RDNM']: b['rk'] = (code + a['RDNM'], int(a['BONU'] or 0), int(a['BUNU'] or 0)); by_road[b['rk']].append(b)
        by_bjd[a['BJCD']].append(b)
        cn = core(a['ANNO'] or a['NAME'])
        if len(cn) >= 3: by_core[cn].append(b)
    # 2) 기존 태양광 (지자체 등록분): 좌표가 건물 안에 있으면 그 동, 좌표가 없으면 주소가 같은 가장 큰 동
    gsol = collections.defaultdict(list); pts = P['pts']; grid = P['grid']; seen = set()
    for b in gb:
        xs = [p[0] for p in b['rings'][0]]; ys = [p[1] for p in b['rings'][0]]; x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        for gx in range(int(x0 // 100), int(x1 // 100) + 1):
            for gy in range(int(y0 // 100), int(y1 // 100) + 1):
                for i in grid.get((gx, gy), ()):
                    if i in seen: continue
                    x, y, rec = pts[i]
                    if x0 <= x <= x1 and y0 <= y <= y1 and inside(x, y, b['rings']): seen.add(i); b['sol'] = True; gsol[b['gid']].append(rec)
    for rk, jk, rec in P['noxy'].get(code, ()):
        hit = by_road.get(rk or P['jmap'].get(jk))
        if hit: b = max(hit, key=lambda b: b['area_m2']); b['sol'] = True; gsol[b['gid']].append(rec)
    # 2-1) 사진 판독 결과(자가용 추정): 등록되지 않았지만 항공사진에 패널이 보이는 동
    if USE_PHOTO:
        ks = photo_keys(code)
        for b in gb:
            if b['k'] in ks and not b.get('sol'): b['ph'] = True
    # 3) 공장등록(전화번호): 도로명 주소가 같은 건물, 없으면 같은 법정동에서 이름이 같은 건물
    greg = collections.defaultdict(list); rs = collections.Counter()
    for r in P['regs'].get(code, ()):
        hit = by_road.get(r['rk'] or P['jmap'].get(r['jk'])); how = None
        if hit:
            nm = [b for b in hit if same_name(r['nm'], b['attrs']['ANNO'] or b['attrs']['NAME'])]
            b = max(nm or hit, key=lambda b: b['area_m2']); how = 'name' if nm else 'addr'
        elif r['jk']:
            nm = [b for b in by_bjd.get(r['jk'][0], ()) if same_name(r['nm'], b['attrs']['ANNO'] or b['attrs']['NAME'])]
            if nm: b = max(nm, key=lambda b: b['area_m2']); how = 'name'
        if not how:
            nm = by_core.get(core(r['nm']), ())
            if nm and len({b['gid'] for b in nm}) == 1: b = max(nm, key=lambda b: b['area_m2']); how = 'name'; rs['이름만 일치(시군구 안 유일)'] += 1
        if not how: rs['맞는 건물 없음'] += 1; continue
        rs['이름 일치' if how == 'name' else '주소 일치'] += 1
        greg[b['gid']].append(dict(r, how=how))
    # 4) 쓰기
    cfk = KPX.get(old[:2]); cv = P['cf'].get(cfk, {}); ys = sorted(cv)[-CF_YEARS:]; vals = [float(cv[y]) for y in ys]
    cf = {'pct': round(sum(vals) / len(vals), 2), 'years': ys, 'vals': vals, 'area': cfk} if vals else None
    G = []; jb = load_jibun(code); grids = {}
    for gid, (k, m) in enumerate(groups):
        bs = [cand[i] for i in m]; big = max(bs, key=lambda b: b['area_m2']); a = big['attrs']; lon, lat = to_ll(*big['c'])
        emd, ri = J['bjd'].get(a['BJCD'], ('', ''))
        if not emd: emd = J['emd8'].get(a['BJCD'][:8], '')
        if not emd and 'rk' in big: emd = J['road_emd'].get(big['rk'][0], '')      # 도로가 가장 많이 지나는 읍면동(근사)
        if 'rk' in big and big['rk'][0] in J['road']:
            ad = '%s %s %s %s %d%s' % (sido, sgname, emd if emd[-1:] in '읍면' else '', J['road'][big['rk'][0]], big['rk'][1], '-%d' % big['rk'][2] if big['rk'][2] else '')
        else: ad = '%s %s %s %s' % (sido, sgname, emd, ri)
        ad = re.sub(r'\s+', ' ', ad).strip()
        rr = sorted(greg.get(gid, []), key=lambda r: (r['how'] != 'name', not r['tel'], r['own'] != '자가', -r['ba']))
        mapnm = (a['ANNO'] or a['NAME']) if k[0] == 'N' else ''
        inst = [b for b in bs if b.get('sol') or b.get('ph')]; rem = [b for b in bs if not (b.get('sol') or b.get('ph'))]; so = gsol.get(gid, [])
        g = {'id': gid, 'nm': mapnm or (rr[0]['nm'] if rr else ''), 'emd': emd, 'ad': ad, 'c': [lon, lat],
             'n': len(rem), 'a': round(sum(b['area_m2'] for b in rem)), 'nt': len(bs), 'at': round(sum(b['area_m2'] for b in bs)),
             'st': 'on' if not rem else 'part' if inst else 'none', 'sn': len(so), 'skw': round(sum(s[0] for s in so), 1)}
        pn = sum(1 for b in bs if b.get('ph'))       # 사진 판독으로 더한 동 수
        if pn: g['pn'] = pn
        if rr:
            top = next((r for r in rr if r['tel']), rr[0])      # 번호가 있는 등록 건을 우선
            g['tel'] = top['tel']; g['own'] = top['own']
            g['f'] = top['f']                                     # 공장 정보(업종·규모·입지 등)
            if len(rr) > 1: g['fn'] = len(rr)                     # 이 건물 묶음에 등록된 공장 수
            if mapnm and not same_name(mapnm, top['nm']): g['telnm'] = top['nm']     # 번호 주인이 지도 표기와 다를 때만
        xb, xk = extra_of(bs, jb, grids)
        if xb or xk:
            g.setdefault('f', {}); g['f'] = dict(g['f'])
            if xb: g['f']['b'] = xb
            if xk: g['f']['kb'] = xk
        G.append(g)
    feats = [{'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [[list(to_ll(x, y)) for x, y in r] for r in b['rings']]},
              'properties': {'g': b['gid'], 'st': 'on' if (b.get('sol') or b.get('ph')) else 'none'}} for b in gb]
    od = os.path.join(OUT, code); os.makedirs(od, exist_ok=True)
    def dump(name, obj): json.dump(obj, open(os.path.join(od, name), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    fac = {g['id']: g.pop('f') for g in G if 'f' in g}
    if any(grids.values()): fac['_k'] = {k: v for k, v in grids.items() if v}      # 계통 여유는 리마다 한 번만 싣는다
    dump('info.json', {'meta': {'code': code, 'sido': sido, 'name': sgname, 'cf': cf, 'solar_date': P['sdate']}, 'groups': G})
    dump('fac.json', fac)
    dump('bldg.geojson', {'type': 'FeatureCollection', 'features': feats})
    # 사진 판독 대상 목록(저장소 밖): 건물 고유번호, 묶음, 면적, 등록 태양광 여부, 외곽선
    td = os.path.join(GIS, '지붕사진/대상'); os.makedirs(td, exist_ok=True)
    json.dump([{'k': b['k'], 'g': b['gid'], 'a': round(b['area_m2']), 'sol': bool(b.get('sol')), 'ring': f['geometry']['coordinates'][0]} for b, f in zip(gb, feats)],
              open(os.path.join(td, code + '.json'), 'w', encoding='utf-8'), separators=(',', ':'))
    xs = [g['c'][0] for g in G]; ys2 = [g['c'][1] for g in G]; pre = (sido + ' ' + sgname).strip() + ' '
    return {'code': code, 'sido': sido, 'name': sgname or sido, 'n': len(G), 'bbox': [min(xs), min(ys2), max(xs), max(ys2)],
            'rows': [[g['nm'], g['ad'][len(pre):] if (g['ad'] + ' ').startswith(pre) else g['ad'], code, g['id'], g['at']] for g in G],
            'stat': {'bldg': len(gb), 'area': sum(g['at'] for g in G), 'rem': sum(g['a'] for g in G), 'on': sum(1 for b in gb if b.get('sol')),
                     'tel': sum(1 for g in G if g.get('tel')), 'reg': dict(rs), 'st': dict(collections.Counter(g['st'] for g in G))}}

def main():
    global P
    t0 = time.time(); P = prepare(); print('준비 %.0f초' % (time.time() - t0), flush=True)
    olds = sorted(f[:-6] for f in os.listdir(CAND) if re.match(r'^\d{5}\.jsonl$', f))
    jobs = []; moved = collections.defaultdict(list)      # 새 구 코드 -> (옛 코드, 건물들). 옛 구 둘이 한 새 구로 합쳐지는 경우가 있어 모아서 쓴다
    for o in olds:
        code = OLD2NEW.get(o, o)
        if code in P['J']['sgg']: jobs.append((o, os.path.join(CAND, o + '.jsonl'), code))
        else:
            for b in split_region(o, P['J']): moved[b['new']].append((o, b))
    sd = os.path.join(JCACHE, 'split'); os.makedirs(sd, exist_ok=True)
    for k, lst in sorted(moved.items()):
        pth = os.path.join(sd, k + '.jsonl')
        with open(pth, 'w', encoding='utf-8') as f:
            for o, b in lst: f.write(json.dumps({x: b[x] for x in ('k', 'attrs', 'area_m2', 'rings')}, ensure_ascii=False) + '\n')
        jobs.append((lst[0][0], pth, k))
    only = set(sys.argv[1:]); todo = [j for j in jobs if not only or j[0] in only or j[2] in only]
    with mp.get_context('fork').Pool(min(8, os.cpu_count() or 4)) as pool: res = pool.map(build, todo, chunksize=1)
    ok = [r for r in res if 'skip' not in r]; print('건너뜀', [(r['code'], r['skip']) for r in res if 'skip' in r], flush=True)
    tot = collections.Counter(); reg = collections.Counter(); st = collections.Counter()
    for r in ok:
        for k in ('bldg', 'area', 'rem', 'on', 'tel'): tot[k] += r['stat'][k]
        reg.update(r['stat']['reg']); st.update(r['stat']['st']); tot['n'] += r['n']
    print('지역', len(ok), '묶음', tot['n'], '건물', tot['bldg'], '지붕', tot['area'], '㎡, 후보 지붕', tot['rem'], '㎡', flush=True)
    print('태양광 올라간 동', tot['on'], '묶음 상태', dict(st), '| 전화번호 묶음', tot['tel'], '공장등록 대조', dict(reg), flush=True)
    for r in ok:
        if r['code'] in ('43750',): print('진천 확인', r['n'], r['stat'], flush=True)
    if only: print('일부만 만들어서 regions.json 과 검색 색인은 그대로 둡니다'); return
    os.makedirs(os.path.join(OUT, 'search'), exist_ok=True); index = collections.defaultdict(list)
    for r in ok: index[r['code'][:2]] += r['rows']
    for sc, rows in index.items(): json.dump(rows, open(os.path.join(OUT, 'search', sc + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    regions = sorted(({k: r[k] for k in ('code', 'sido', 'name', 'n', 'bbox')} for r in ok), key=lambda r: (r['sido'], r['name']))
    json.dump({'built': time.strftime('%Y-%m-%d'), 'regions': regions,
               'src': {'bldg': '브이월드 「건물」(국토지리정보원 연속수치지형도), 2026-10-01', 'solar': '전국태양광발전시설 표준데이터(공공데이터포털), 지자체 등록분',
                       'cf': '전력거래소 전력통계정보시스템(EPSIS) 신재생에너지 이용률', 'reg': '전국공장등록현황(한국산업단지공단), 2026-06 말', 'addr': '도로명주소 한글 전체분(2026-10)'}},
              open(os.path.join(OUT, 'regions.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('끝 %.0f초' % (time.time() - t0), flush=True)

if __name__ == '__main__':
    main()
