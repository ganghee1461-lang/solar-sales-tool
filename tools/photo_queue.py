"""지붕 사진 판독 대기열. 중간에 끊겨도 이어서 할 수 있게 상태를 파일로 남긴다. (결과는 보관만 하고 웹에는 쓰지 않는다)
폴더: GIS 자료/지붕사진/  대상/<코드>.json(판독 대상), img/(자른 사진), 판독/전국/(묶음, 결과)

  python3 tools/photo_queue.py plan 43 100      충북(43)에서 남은 용량 100kW 이상 회사의 미판독 동을 용량 큰 회사부터 대기열에 올림
  python3 tools/photo_queue.py next 25 40       대기열에서 25묶음(묶음당 40장)을 꺼내 사진을 자르고 묶음 파일을 만듦 -> 묶음 번호 출력
  python3 tools/photo_queue.py merge            result_*.json 을 결과에 합치고 진행률 출력
  python3 tools/photo_queue.py recheck 30       1차에서 '있음' 또는 '확신 낮음'인 동을 2차 확인 묶음(묶음당 30장)으로 만듦
  python3 tools/photo_queue.py status           진행률
"""
import sys, os, json, glob, collections
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

def plan(sido, minkw):
    res = load_results(); q = []
    for f in sorted(glob.glob(os.path.join(T, sido + '*.json'))):
        code = os.path.basename(f)[:-5]; G = json.load(open(os.path.join(ROOT, 'data', code, 'info.json'), encoding='utf-8'))['groups']
        for b in json.load(open(f, encoding='utf-8')):
            g = G[b['g']]; cap = g['a'] * 0.5 * 0.3
            if b['sol'] or g['st'] == 'on' or cap < minkw or b['k'] in res: continue
            q.append((-cap, code, b['k']))
    q.sort(); json.dump([[c, k] for _, c, k in q], open(QF, 'w')); print('대기열', len(q), '동')

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
        s['given'][str(bid)] = {'pass': ps, 'keys': [k for _, k in part]}; ids.append(bid)
    save_state(s); return ids

def nxt(nb, size):
    q = json.load(open(QF)); s = state(); res = load_results()
    out = {k for v in s['given'].values() if v['pass'] == 1 for k in v['keys']}
    items = [x for x in q if x[1] not in res and x[1] not in out][:nb * size]
    n, errs = crop_many(items); ok = [x for x in items if os.path.exists(imgpath(x[1]))]
    ids = make_batches(ok, size, 1); print('자른 사진', n, '실패', len(errs), '| 1차 묶음', ids[0] if ids else '-', '~', ids[-1] if ids else '-', '(%d묶음, %d장)' % (len(ids), len(ok)))

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
    save_state(s); print('합친 묶음', done, '| 결과 없는 묶음(다시 돌려야 함)', sorted(int(b) for b in s['given'])); status()

def recheck(size):
    res = load_results(); s = state(); out = {k for v in s['given'].values() if v['pass'] == 2 for k in v['keys']}
    items = [(None, k) for k, r in res.items() if 1 in r and 2 not in r and k not in out and (r[1]['v'] == 'Y' or r[1]['conf'] == 'low')]
    ids = make_batches(items, size, 2); print('2차 확인 묶음', ids[0] if ids else '-', '~', ids[-1] if ids else '-', '(%d묶음, %d장)' % (len(ids), len(items)))

def status():
    res = load_results(); q = json.load(open(QF)) if os.path.exists(QF) else []
    c = collections.Counter()
    for k, r in res.items():
        if 1 in r: c['1차 완료'] += 1; c['1차 있음' if r[1]['v'] == 'Y' else '1차 없음'] += 1
        if 2 in r: c['2차 완료'] += 1; c['1·2차 모두 있음' if r[1]['v'] == 'Y' and r[2]['v'] == 'Y' else '1·2차 엇갈림' if r[1]['v'] != r[2]['v'] else '1·2차 모두 없음'] += 1
    print('대기열', len(q), '| 남은 1차', sum(1 for x in q if x[1] not in res), '|', dict(c))

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == 'plan': plan(a[1], float(a[2]))
    elif a[0] == 'next': nxt(int(a[1]), int(a[2]))
    elif a[0] == 'merge': merge()
    elif a[0] == 'recheck': recheck(int(a[1]))
    else: status()
