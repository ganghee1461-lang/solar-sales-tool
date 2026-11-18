"""회사별 부가정보 받기: 건축물대장 표제부(건축HUB)와 계통 여유(한전 분산전원 연계정보)

쓰는 법:  python3 tools/fetch_extra.py 43770 [43750 ...]     (시군구 코드, 없으면 전부)
- 인증키는 저장소 밖 ~/클로드코드/업무/태양광 O&M/.keys/ 에서 읽는다(저장소에 올리지 않는다).
- 받은 원자료는 저장소 밖 ~/클로드코드/업무/GIS 자료/부가정보/ 에 쌓아 두고, 이미 받은 것은 다시 받지 않는다.
- 회사(건물 묶음)는 사진 판독 대상 목록(지붕사진/대상/<코드>.json: 건물 고유번호 -> 묶음 번호)으로 알아내고,
  건물의 도로명 번호를 도로명주소 자료로 지번(법정동코드 10자리, 산, 번지, 호)으로 바꾼다.
- 다 받은 뒤 build_data.py 를 다시 돌리면 팝업 자료(fac.json)에 들어간다.
"""
import os, sys, json, glob, time, zipfile, collections, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser('~'); GIS = os.path.join(HOME, '클로드코드/업무/GIS 자료')
KEYS = os.path.join(HOME, '클로드코드/업무/태양광 O&M/.keys')
CAND = os.path.join(GIS, '연속수치지형도-건물/가공/cand'); SPLIT = os.path.join(GIS, '도로명주소/가공/split')
TGT = os.path.join(GIS, '지붕사진/대상')
OUT = os.path.join(GIS, '부가정보'); BR = os.path.join(OUT, '건축물대장'); GR = os.path.join(OUT, '계통'); JB = os.path.join(OUT, '지번')
for d in (BR, GR, JB): os.makedirs(d, exist_ok=True)
JUSO_ZIP = glob.glob(os.path.join(GIS, '도로명주소/원본/*도로명주소 한글_전체분.zip'))[0]
LOTS_PER_GROUP = 3        # 묶음마다 큰 건물부터 지번 몇 곳까지 건축물대장을 받을지

def key(name): return open(os.path.join(KEYS, name)).read().strip()

NEW2OLD = {v: k for k, v in {'29110': '12210', '29140': '12240', '29155': '12270', '29170': '12300', '29200': '12330', '46110': '12110', '46130': '12130', '46150': '12150',
           '46170': '12170', '46230': '12190', '46710': '12710', '46720': '12720', '46730': '12730', '46770': '12740', '46780': '12750', '46790': '12760',
           '46800': '12770', '46810': '12780', '46820': '12790', '46830': '12800', '46840': '12810', '46860': '12820', '46870': '12830', '46880': '12840',
           '46890': '12850', '46900': '12860', '46910': '12870'}.items()}      # 전남광주: 건물 원자료는 옛 코드 이름으로 있다(build_data.py OLD2NEW 와 같게)
def cand_file(code):
    for p in (os.path.join(SPLIT, code + '.jsonl'), os.path.join(CAND, code + '.jsonl'), os.path.join(CAND, NEW2OLD.get(code, code) + '.jsonl')):
        if os.path.exists(p): return p
    return None

def targets(code):
    """묶음 번호 -> 큰 건물부터 도로명 열쇠 목록"""
    t = os.path.join(TGT, code + '.json'); c = cand_file(code)
    if not (os.path.exists(t) and c): return {}
    attrs = {}
    for l in open(c, encoding='utf-8'):
        b = json.loads(l); a = b['attrs']
        if a.get('RDNM'): attrs[b['k']] = (code + a['RDNM'], int(a['BONU'] or 0), int(a['BUNU'] or 0))
    g = collections.defaultdict(list)
    for b in json.load(open(t, encoding='utf-8')):
        if b['k'] in attrs: g[b['g']].append((b['a'], attrs[b['k']]))
    return {gid: [rk for _, rk in sorted(v, key=lambda x: -x[0])] for gid, v in g.items()}

def jibun_map(code, need):
    """도로명 열쇠 -> (법정동코드, 산, 번지, 호, 읍면동, 리). 시군구별로 저장해 둔다"""
    p = os.path.join(JB, code + '.json')
    m = {tuple(json.loads(k)): v for k, v in json.load(open(p)).items()} if os.path.exists(p) else None
    if m is not None and need <= set(m): return m
    m = {}; zf = zipfile.ZipFile(JUSO_ZIP); roads = {rk[0] for rk in need}
    for n in zf.namelist():
        if not os.path.basename(n).startswith('rnaddrkor_'): continue
        with zf.open(n) as f:
            for raw in f:
                c = raw.decode('cp949', 'ignore').rstrip('\r\n').split('|')
                if len(c) < 14 or c[9] not in roads: continue
                rk = (c[9], int(c[12] or 0), int(c[13] or 0))
                if rk in need and rk not in m: m[rk] = [c[1], int(c[6] or 0), int(c[7] or 0), int(c[8] or 0), c[4], c[5]]
    json.dump({json.dumps(list(k)): v for k, v in m.items()}, open(p, 'w'), ensure_ascii=False)
    return m

def get(url, params, tries=6):
    q = urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            req = urllib.request.Request(url + '?' + q, headers={'User-Agent': 'Mozilla/5.0', 'Accept': '*/*'})   # 한전 서버는 파이썬 기본 접속을 404로 막는다
            with urllib.request.urlopen(req, timeout=30) as r: txt = r.read().decode('utf-8', 'ignore')
            try: return json.loads(txt)
            except ValueError:
                if i == tries - 1: raise Stop('응답이 JSON 이 아님(하루 한도 초과일 수 있음): ' + txt[:200])
                time.sleep(10)
        except Stop: raise
        except urllib.error.HTTPError as e:
            if e.code == 404: return None          # 한전은 맞는 주소가 없으면 404 를 준다
            if i == tries - 1: raise
            time.sleep(20 if e.code == 429 else 2 + i * 3)   # 429 = 요청이 너무 잦음 -> 넉넉히 쉰다
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 + i * 3)

class Stop(Exception): pass

def fetch_br(lot, k):
    """지번 한 곳의 표제부 전부. 저장: 건축물대장/<시군구>/<법정동>_<산>_<번>_<지>.json"""
    bjd, san, bun, ho = lot
    d = os.path.join(BR, bjd[:5]); os.makedirs(d, exist_ok=True); p = os.path.join(d, '%s_%d_%d_%d.json' % (bjd, san, bun, ho))
    if os.path.exists(p): return False
    items = []; page = 1
    while True:
        r = get('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo',
                {'serviceKey': k, 'sigunguCd': bjd[:5], 'bjdongCd': bjd[5:], 'platGbCd': str(san), 'bun': '%04d' % bun, 'ji': '%04d' % ho,
                 'numOfRows': '100', 'pageNo': str(page), '_type': 'json'})
        if r is None: raise Stop('건축물대장 주소 없음(404)')
        h = r.get('response', {}).get('header', {})
        if h.get('resultCode') != '00': raise Stop('건축물대장 응답 %s %s' % (h.get('resultCode'), h.get('resultMsg')))
        body = r['response']['body']; it = (body.get('items') or {}).get('item') or []
        items += it if isinstance(it, list) else [it]
        if page * 100 >= int(body.get('totalCount') or 0): break
        page += 1
    keep = ('mainAtchGbCdNm', 'dongNm', 'bldNm', 'archArea', 'totArea', 'strctCdNm', 'etcStrct', 'mainPurpsCdNm', 'etcPurps',
            'roofCdNm', 'etcRoof', 'grndFlrCnt', 'heit', 'useAprDay', 'regstrKindCdNm')
    json.dump([{x: i.get(x) for x in keep} for i in items], open(p, 'w', encoding='utf-8'), ensure_ascii=False)
    return True

def fetch_grid(bjd, emd, ri, k):
    """리(도시는 동) 하나의 배전선로 목록. 저장: 계통/<법정동코드>.json"""
    p = os.path.join(GR, bjd + '.json')
    if os.path.exists(p) and not (bjd[:5] in NEW2OLD and not json.load(open(p, encoding='utf-8'))['rows']): return False
    sg = NEW2OLD.get(bjd[:5], bjd[:5])      # 한전은 전남광주를 옛 코드(전남 46, 광주 29)로 받는다
    # 읍으로 승격된 곳은 한전 자료에 옛 이름(면)으로 남아 있기도 해서 바꿔 가며 찾는다
    names = [emd] + ([emd[:-1] + '면'] if emd.endswith('읍') else [emd[:-1] + '읍'] if emd.endswith('면') else [])
    rows = []
    for nm in names:
        prm = {'metroCd': sg[:2], 'cityCd': sg[2:5], 'addrLidong': nm, 'apiKey': k, 'returnType': 'json'}
        if ri: prm['addrLi'] = ri
        r = get('https://bigdata.kepco.co.kr/openapi/v1/dispersedGeneration.do', prm)
        if r is None: continue
        rows = r.get('data')
        if rows is None: raise Stop('한전 응답 이상: %s' % str(r)[:200])
        if len(rows) > 500: rows = []        # 조건이 안 먹으면 전국 목록이 온다 -> 없음으로 둔다
        if rows: break
    json.dump({'day': time.strftime('%Y-%m-%d'), 'rows': rows}, open(p, 'w', encoding='utf-8'), ensure_ascii=False)
    return True

def main():
    codes = sys.argv[1:] or sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(TGT, '[0-9]*.json')))
    kb, kg = key('datagokr_api.txt'), key('kepco_api.txt'); st = collections.Counter(); t0 = time.time()
    for code in codes:
        T = targets(code)
        need = {rk for v in T.values() for rk in v[:LOTS_PER_GROUP]}
        J = jibun_map(code, need)
        lots = {}; grids = {}
        for gid, rks in T.items():
            for rk in rks[:LOTS_PER_GROUP]:
                j = J.get(rk)
                if j: lots[tuple(j[:4])] = 1; grids[j[0]] = (j[4], j[5])
        st['묶음'] += len(T); st['지번 찾음'] += sum(1 for v in T.values() if any(J.get(rk) for rk in v[:LOTS_PER_GROUP]))
        try:
            for bjd, (emd, ri) in grids.items(): st['계통 받음'] += fetch_grid(bjd, emd, ri, kg)
            if os.environ.get('GRID_ONLY'): lots = {}      # 계통만 먼저 받을 때
            with ThreadPoolExecutor(2) as ex: st['대장 받음'] += sum(ex.map(lambda lot: fetch_br(lot, kb), list(lots)))
        except Stop as e:
            print('멈춤:', e, dict(st), flush=True); return
        print(code, '묶음', len(T), '지번', len(lots), '리', len(grids), dict(st), '%.0f초' % (time.time() - t0), flush=True)

if __name__ == '__main__': main()
