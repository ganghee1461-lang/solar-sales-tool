"""전국 건물 원본(건물_001~010.zip)에서 지붕 태양광 후보가 될 수 있는 건물만 뽑아 시군구별 파일로 나눈다.
조건: 도형 면적 500㎡ 이상, 종류가 주택외건물(BDK004) 또는 무벽건물(BDK005)
출력: GIS 자료/연속수치지형도-건물/가공/cand/<시군구코드 5자리>.jsonl  (한 줄 = 건물 하나)
원본은 압축을 풀지 않고 읽기만 한다.  사용: python3 tools/extract_all.py
"""
import os, sys, zipfile, struct, json, glob, collections
from multiprocessing import Pool

BASE = os.path.expanduser('~/클로드코드/업무/GIS 자료/연속수치지형도-건물')
SRC = os.path.join(BASE, '원본'); TMP = os.path.join(BASE, '가공/cand_tmp'); OUT = os.path.join(BASE, '가공/cand')
MIN_AREA = 500.0; KIND_OK = {'BDK004', 'BDK005'}
KEEP = ('UFID', 'BJCD', 'NAME', 'KIND', 'SERV', 'ANNO', 'NMLY', 'RDNM', 'BONU', 'BUNU')

def area(pts, parts):
    s = 0.0
    for p in range(len(parts) - 1):
        a = 0.0; i0 = parts[p] * 2; i1 = parts[p + 1] * 2
        for i in range(i0, i1 - 2, 2): a += pts[i] * pts[i + 3] - pts[i + 2] * pts[i + 1]
        s += a / 2.0
    return abs(s)

def work(zpath):
    num = os.path.basename(zpath)[-7:-4]; outp = os.path.join(TMP, num + '.jsonl')
    if os.path.exists(outp + '.done'): return num, -1, -1
    zf = zipfile.ZipFile(zpath); names = {os.path.splitext(i.filename)[1].lower(): i for i in zf.infolist()}
    hits = {}; idx = 0
    with zf.open(names['.shp']) as f:
        f.read(100)
        while True:
            h = f.read(8)
            if len(h) < 8: break
            rec = f.read(struct.unpack('>i', h[4:8])[0] * 2)
            if rec[:4] in (b'\x05\x00\x00\x00', b'\x0f\x00\x00\x00', b'\x19\x00\x00\x00'):
                x0, y0, x1, y1 = struct.unpack('<4d', rec[4:36])
                if (x1 - x0) * (y1 - y0) >= MIN_AREA:       # 사각 범위가 500㎡ 미만이면 도형도 미만이므로 건너뜀
                    npart, npt = struct.unpack('<2i', rec[36:44])
                    parts = list(struct.unpack('<%di' % npart, rec[44:44 + 4 * npart])) + [npt]
                    o = 44 + 4 * npart; pts = struct.unpack('<%dd' % (2 * npt), rec[o:o + 16 * npt])
                    a = area(pts, parts)
                    if a >= MIN_AREA:
                        hits[idx] = (round(a, 1), [[[round(pts[2 * j], 2), round(pts[2 * j + 1], 2)] for j in range(parts[p], parts[p + 1])] for p in range(npart)])
            idx += 1
    total = idx; kept = 0
    with zf.open(names['.dbf']) as f, open(outp, 'w', encoding='utf-8') as out:
        hd = f.read(32); nrec, hlen, rlen = struct.unpack('<IHH', hd[4:12]); fd = f.read(hlen - 32); fields = []; o = 1
        for i in range(0, len(fd) - 1, 32):
            if fd[i] == 0x0D: break
            nm = fd[i:i + 11].split(b'\0')[0].decode('ascii', 'replace'); ln = fd[i + 16]; fields.append((nm, o, ln)); o += ln
        use = [x for x in fields if x[0] in KEEP]; kind = [x for x in fields if x[0] == 'KIND'][0]
        i = 0; CH = 8192
        while i < nrec:
            n = min(CH, nrec - i); buf = f.read(rlen * n)
            for j in range(n):
                h = hits.get(i + j)
                if h is None: continue
                r = buf[j * rlen:(j + 1) * rlen]
                if r[kind[1]:kind[1] + kind[2]].decode('ascii', 'replace').strip() not in KIND_OK: continue
                at = {}
                for nm, o, ln in use:
                    raw = r[o:o + ln]
                    try: at[nm] = raw.decode('utf-8').strip()
                    except UnicodeDecodeError: at[nm] = raw.decode('cp949', 'replace').strip()
                out.write(json.dumps({'k': '%s:%d' % (num, i + j), 'attrs': at, 'area_m2': h[0], 'rings': h[1]}, ensure_ascii=False) + '\n'); kept += 1
            i += n
    open(outp + '.done', 'w').close()
    return num, total, kept

if __name__ == '__main__':
    os.makedirs(TMP, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    zs = sorted(glob.glob(os.path.join(SRC, '*건물_*.zip')))
    with Pool(5) as p:
        for num, total, kept in p.imap_unordered(work, zs): print(num, '전체', total, '뽑음', kept, flush=True)
    # 시군구별로 나누기 (원본 파일 번호 순서 유지)
    fh = {}; cnt = collections.Counter()
    for f in sorted(glob.glob(os.path.join(TMP, '*.jsonl'))):
        for line in open(f, encoding='utf-8'):
            i = line.find('"BJCD": "'); sg = line[i + 9:i + 14]
            if sg not in fh: fh[sg] = open(os.path.join(OUT, sg + '.jsonl'), 'w', encoding='utf-8')
            fh[sg].write(line); cnt[sg] += 1
    for h in fh.values(): h.close()
    print('시군구 수', len(cnt), '건물 합계', sum(cnt.values()), '진천(43750)', cnt.get('43750'), flush=True)
