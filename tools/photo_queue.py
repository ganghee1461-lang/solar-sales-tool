"""지붕 사진 판독 대기열. 중간에 끊겨도 이어서 할 수 있게 상태를 파일로 남긴다. (결과는 보관만 하고 웹에는 쓰지 않는다)
폴더: GIS 자료/지붕사진/  대상/<코드>.json(판독 대상), img/(자른 사진), 판독/전국/(묶음, 결과)

  python3 tools/photo_queue.py plan 43 100      충북(43)에서 남은 용량 100kW 이상 회사의 미판독 동을 용량 큰 회사부터 대기열에 올림
  python3 tools/photo_queue.py next 25 40       대기열에서 25묶음(묶음당 40장)을 꺼내 사진을 자르고 묶음 파일을 만듦 -> 묶음 번호 출력
  python3 tools/photo_queue.py merge            result_*.json 을 결과에 합치고 진행률 출력
  python3 tools/photo_queue.py recheck 30       1차에서 '있음' 또는 '확신 낮음'인 동을 2차 확인 묶음(묶음당 30장)으로 만듦
  python3 tools/photo_queue.py status           진행률
"""
import sys, os, json, glob, collections, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
B = os.path.expanduser('~/클로드코드/업무/GIS 자료/지붕사진'); T = os.path.join(B, '대상'); IMG = os.path.join(B, 'img'); Q = os.path.join(B, '판독/전국')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for d in (IMG, Q): os.makedirs(d, exist_ok=True)
QF = os.path.join(Q, '대기열.json'); RF = os.path.join(Q, '결과.jsonl'); SF = os.path.join(Q, '상태.json')

def load_results():
    r = {}
    if os.path.exists(RF):
        for l in open(RF, encoding='utf-8'):
            d = json.loads(l); r.setdefault(d['k'], {})[d['pass']] = d
    return r
def state(): return json.load(open(SF)) if os.path.exists(SF) else {'next_batch': 1, 'given': {}}
def save_state(s): json.dump(s, open(SF, 'w'))
def imgpath(k): return os.path.join(IMG, k.replace(':', '_') + '.jpg')

ORDER = ['43750', '43', '36', '30', '44', '41', '51', '47', '52']      # 판독 순서: 진천(정확도 확인용) -> 충북 -> 인근(세종, 대전, 충남, 경기, 강원, 경북, 전북) -> 나머지

def plan(sido, minkw):
    res = load_results(); q = []
    for f in sorted(glob.glob(os.path.join(T, ('' if sido == 'all' else sido) + '*.json'))):
        code = os.path.basename(f)[:-5]; ip = os.path.join(ROOT, 'data', code, 'info.json')
        if not os.path.exists(ip): continue
        G = json.load(open(ip, encoding='utf-8'))['groups']; rank = next((i for i, o in enumerate(ORDER) if code.startswith(o)), len(ORDER))
        for b in json.load(open(f, encoding='utf-8')):
            g = G[b['g']]; cap = g['a'] * 0.5 * 0.3
            if b['sol'] or g['st'] == 'on' or cap < minkw or b['k'] in res: continue
            q.append((rank, code if rank == len(ORDER) else '', -cap, code, b['k']))
    q.sort(); json.dump([[x[3], x[4]] for x in q], open(QF, 'w')); print('대기열', len(q), '동')

def crop_many(items):
    from crop_roofs import crop
    from concurrent.futures import ThreadPoolExecutor
    by = collections.defaultdict(list)
    for code, k in items: by[code].append(k)
    jobs = []
    for code, ks in by.items():
        tg = {b['k']: b for b in json.load(open(os.path.join(T, code + '.json'), encoding='utf-8'))}
        jobs += [(tg[k], imgpath(k)) for k in ks if not os.path.exists(imgpath(k))]
    def one(j):
        try: crop({'geometry': {'coordinates': [j[0]['ring']]}}, j[1]); return None
        except Exception as e: return str(e)
    with ThreadPoolExecutor(8) as ex: errs = [e for e in ex.map(one, jobs) if e]
    return len(jobs), errs

def make_batches(items, size, ps):
    s = state(); ids = []
    for i in range(0, len(items), size):
        bid = s['next_batch']; s['next_batch'] += 1; part = items[i:i + size]
        open(os.path.join(Q, 'batch_%05d.txt' % bid), 'w').write('\n'.join(imgpath(k) for _, k in part))
        s['given'][str(bid)] = {'pass': ps, 'keys': [k for _, k in part], 'ts': time.time()}; ids.append(bid)
    save_state(s); return ids

COLOR_PANEL = 0.02; COLOR_EDGE = 12      # 색 걸러내기 기준: 어두운 푸른색 픽셀 비율과 무늬(경계) 세기가 둘 다 이보다 낮으면 패널 없음으로 본다
                                          # (2026-11-18 판독 4,480동으로 검증: 패널 390동 중 3동(0.8%)을 놓치고 전체의 41%를 걸러냄)
def color_filter(items):
    """사진을 자른 뒤 색으로 먼저 걸러낸다. 걸러진 동은 결과에 pass 0 으로 적고, 남은 동만 돌려준다."""
    from roof_color import features
    rings = {}
    for code in {c for c, _ in items}:
        for b in json.load(open(os.path.join(T, code + '.json'), encoding='utf-8')): rings[b['k']] = b['ring']
    keep = []; drop = 0
    with open(RF, 'a', encoding='utf-8') as out:
        for c, k in items:
            if not os.path.exists(imgpath(k)): continue
            try: ft = features(imgpath(k), rings[k])
            except Exception: ft = None
            if ft and ft['panel'] < COLOR_PANEL and ft['edge'] < COLOR_EDGE:
                out.write(json.dumps({'k': k, 'pass': 0, 'v': 'N', 'cover': 0, 'conf': 'color', 'batch': 0}) + '\n'); drop += 1
            else: keep.append((c, k))
    return keep, drop

def nxt(nb, size):
    q = json.load(open(QF)); s = state(); res = load_results()
    out = {k for v in s['given'].values() if v['pass'] == 1 for k in v['keys']}
    pool = [x for x in q if x[1] not in res and x[1] not in out]; want = nb * size; ok = []; ncrop = ndrop = 0; pos = 0
    while len(ok) < want and pos < len(pool):
        chunk = pool[pos:pos + int((want - len(ok)) * 1.8) + 20]; pos += len(chunk)
        n, errs = crop_many(chunk); ncrop += n
        keep, drop = color_filter(chunk); ndrop += drop
        ok += keep
    extra = ok[want:]; ok = ok[:want]      # 넘친 것은 다음 차례에 다시 잡힌다
    ids = make_batches(ok, size, 1)
    print('자른 사진', ncrop, '| 색으로 걸러냄', ndrop, '| 1차 묶음', ids[0] if ids else '-', '~', ids[-1] if ids else '-', '(%d묶음, %d장)' % (len(ids), len(ok)))

def merge():
    s = state(); done = 0
    with open(RF, 'a', encoding='utf-8') as out:
        for bid, v in list(s['given'].items()):
            rp = os.path.join(Q, 'result_%05d.json' % int(bid))
            if not os.path.exists(rp): continue
            try: d = json.load(open(rp, encoding='utf-8'))
            except Exception as e: print('결과 파일 오류', bid, e); continue
            for i, k in enumerate(v['keys']):
                r = d.get(str(i + 1))
                if not isinstance(r, dict) or r.get('v') not in ('Y', 'N'): continue
                out.write(json.dumps({'k': k, 'pass': v['pass'], 'v': r['v'], 'cover': r.get('cover'), 'conf': r.get('conf'), 'batch': int(bid)}, ensure_ascii=False) + '\n')
            del s['given'][bid]; os.rename(rp, rp + '.done'); done += 1
    save_state(s); now = time.time()
    old = sorted(int(b) for b, v in s['given'].items() if now - v.get('ts', 0) > 900); new = sorted(int(b) for b, v in s['given'].items() if now - v.get('ts', 0) <= 900)
    print('합친 묶음', done, '| 15분 넘게 결과 없는 묶음(다시 맡길 것): 하이쿠', [b for b in old if s['given'][str(b)]['pass'] == 1], '/ 소네트', [b for b in old if s['given'][str(b)]['pass'] == 3], '| 아직 도는 중(건드리지 말 것):', new); status()

def recheck(size):
    """2차 확인 묶음(소네트가 본다). 1차(하이쿠)가 '있음'이거나 '확신 낮음'인 동. 기록상 pass 번호는 3이다(2는 예전 하이쿠 2차)."""
    res = load_results(); s = state(); out = {k for v in s['given'].values() if v['pass'] == 3 for k in v['keys']}
    items = [(None, k) for k, r in res.items() if 1 in r and 3 not in r and k not in out and (r[1]['v'] == 'Y' or r[1]['conf'] == 'low')]
    ids = make_batches(items, size, 3); print('2차(소네트) 확인 묶음', ids[0] if ids else '-', '~', ids[-1] if ids else '-', '(%d묶음, %d장)' % (len(ids), len(items)))

def verify3(code, size):
    """상위 모델(소네트) 확인용 3차 묶음: 지정한 시군구에서 1차가 '있음'이거나 '확신 낮음'인 동"""
    keys = {b['k'] for b in json.load(open(os.path.join(T, code + '.json'), encoding='utf-8'))}; res = load_results(); s = state()
    out = {k for v in s['given'].values() if v['pass'] == 3 for k in v['keys']}
    items = [(None, k) for k in sorted(keys) if k in res and 1 in res[k] and 3 not in res[k] and k not in out and (res[k][1]['v'] == 'Y' or res[k][1]['conf'] == 'low')]
    ids = make_batches(items, size, 3); print('3차(상위 모델) 묶음', ids[0] if ids else '-', '~', ids[-1] if ids else '-', '(%d묶음, %d장)' % (len(ids), len(items)))

def status():
    res = load_results(); q = json.load(open(QF)) if os.path.exists(QF) else []
    c = collections.Counter()
    for k, r in res.items():
        if 0 in r and 1 not in r: c['색으로 걸러냄'] += 1
        if 1 in r: c['1차 완료'] += 1; c['1차 있음' if r[1]['v'] == 'Y' else '1차 없음'] += 1
        if 3 in r: c['소네트 확인 완료'] += 1; c['소네트도 있음(자가용 추정)' if r[3]['v'] == 'Y' else '소네트는 없음'] += 1
        if 2 in r: c['(예전) 하이쿠 2차 완료'] += 1; c['1·2차 모두 있음' if r[1]['v'] == 'Y' and r[2]['v'] == 'Y' else '1·2차 엇갈림' if r[1]['v'] != r[2]['v'] else '1·2차 모두 없음'] += 1
    print('대기열', len(q), '| 남은 1차', sum(1 for x in q if x[1] not in res), '|', dict(c))

def score():
    """진천은 상위 모델이 직접 확인한 정답이 있다. 하이쿠 판정(1차, 그리고 1·2차 모두 '있음')이 얼마나 맞는지 잰다."""
    truth = set(json.load(open(os.path.join(B, '판독/패널있음_43750_고유번호.json'), encoding='utf-8'))['패널있음'])
    keys = {b['k'] for b in json.load(open(os.path.join(T, '43750.json'), encoding='utf-8'))}; res = load_results()
    for name, ps, pred in (('1차만', 0, lambda r: r[1]['v'] == 'Y'), ('1·2차 모두 있음', 2, lambda r: r[1]['v'] == 'Y' and 2 in r and r[2]['v'] == 'Y'),
                           ('1차 하이쿠 + 3차 상위 모델', 3, lambda r: 3 in r and r[3]['v'] == 'Y')):
        ks = [k for k in keys if k in res and 1 in res[k] and (ps == 0 or res[k][1]['v'] == 'N' and res[k][1]['conf'] != 'low' or ps in res[k])]
        tp = sum(1 for k in ks if pred(res[k]) and k in truth); fp = sum(1 for k in ks if pred(res[k]) and k not in truth); fn = sum(1 for k in ks if not pred(res[k]) and k in truth)
        print('%s: 판독 %d동 | 있음 판정 %d (맞음 %d, 오판 %d) | 놓침 %d | 정밀도 %s 재현율 %s' % (name, len(ks), tp + fp, tp, fp, fn,
              '%.0f%%' % (100 * tp / (tp + fp)) if tp + fp else '-', '%.0f%%' % (100 * tp / (tp + fn)) if tp + fn else '-'))

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == 'plan': plan(a[1], float(a[2]))
    elif a[0] == 'next': nxt(int(a[1]), int(a[2]))
    elif a[0] == 'merge': merge()
    elif a[0] == 'recheck': recheck(int(a[1]))
    elif a[0] == 'score': score()
    elif a[0] == 'verify3': verify3(a[1], int(a[2]))
    else: status()
