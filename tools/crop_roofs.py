"""후보 건물마다 항공사진을 지붕 크기에 맞춰 잘라 저장한다(태양광 패널 판독용).
- 사진: 브이월드 항공사진 타일(받은 타일은 캐시에 보관)
- 출력: GIS 자료/지붕사진/<지역코드>/<건물번호>.jpg  (노란 선 = 판독 대상 지붕 외곽)
사용: python3 tools/crop_roofs.py <지역코드> [건물번호 ...]   (번호를 안 주면 전체)
"""
import sys, os, json, math, io, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw

KEY = '12343DE1-7083-3969-A937-153DE6A043BE'
HOME = os.path.expanduser('~'); ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(HOME, '클로드코드/업무/GIS 자료/지붕사진'); TILES = os.path.join(BASE, 'tiles')
OUT_PX = 448; PAD = 0.18

def tile_xy(lon, lat, z):
    n = 2 ** z; x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y
def get_tile(z, x, y):
    p = os.path.join(TILES, f'{z}_{x}_{y}.jpg')
    if not os.path.exists(p):
        req = urllib.request.Request(f'https://api.vworld.kr/req/wmts/1.0.0/{KEY}/Satellite/{z}/{y}/{x}.jpeg',
                                     headers={'Referer': 'https://solar-sales-tool.pages.dev/', 'User-Agent': 'Mozilla/5.0'})
        for t in range(3):
            try:
                data = urllib.request.urlopen(req, timeout=30).read(); break
            except Exception as e:
                data = None; err = e
        if not data: raise RuntimeError(f'타일 실패 {z}/{x}/{y}: {err}')
        tmp = p + '.%d.tmp' % os.getpid() + str(id(data)); open(tmp, 'wb').write(data); os.replace(tmp, p)   # 다 받은 뒤에 이름을 바꿔 깨진 타일을 막는다
    return Image.open(p).convert('RGB')

def crop(feat, path):
    ring = feat['geometry']['coordinates'][0]
    lons = [p[0] for p in ring]; lats = [p[1] for p in ring]
    for z in (19, 18, 17, 16):
        x0, y1 = tile_xy(min(lons), min(lats), z); x1, y0 = tile_xy(max(lons), max(lats), z)
        w, h = (x1 - x0) * 256, (y1 - y0) * 256
        if max(w, h) <= 900 or z == 16: break
    pad = max(w, h) * PAD + 12
    px0, py0, px1, py1 = x0 * 256 - pad, y0 * 256 - pad, x1 * 256 + pad, y1 * 256 + pad
    tx0, ty0, tx1, ty1 = int(px0 // 256), int(py0 // 256), int(px1 // 256), int(py1 // 256)
    canvas = Image.new('RGB', ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1): canvas.paste(get_tile(z, tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))
    img = canvas.crop((int(px0 - tx0 * 256), int(py0 - ty0 * 256), int(px1 - tx0 * 256), int(py1 - ty0 * 256)))
    s = OUT_PX / max(img.size); 
    if s < 1: img = img.resize((max(1, round(img.size[0] * s)), max(1, round(img.size[1] * s))), Image.LANCZOS)
    else: s = 1.0
    d = ImageDraw.Draw(img)
    for r in feat['geometry']['coordinates']:
        pts = [((tile_xy(lo, la, z)[0] * 256 - px0) * s, (tile_xy(lo, la, z)[1] * 256 - py0) * s) for lo, la in r]
        d.line(pts + pts[:1], fill=(255, 221, 0), width=2)
    img.save(path, quality=85)

def main():
    code = sys.argv[1]; ids = [int(a) for a in sys.argv[2:]]
    feats = json.load(open(os.path.join(ROOT, 'data', code, 'bldg.geojson'), encoding='utf-8'))['features']
    out = os.path.join(BASE, code); os.makedirs(out, exist_ok=True); os.makedirs(TILES, exist_ok=True)
    todo = [i for i in (ids or range(len(feats))) if not os.path.exists(os.path.join(out, f'{i}.jpg'))]
    def one(i):
        try: crop(feats[i], os.path.join(out, f'{i}.jpg')); return None
        except Exception as e: return f'{i}: {e}'
    with ThreadPoolExecutor(8) as ex: errs = [e for e in ex.map(one, todo) if e]
    print('자른 사진', len(todo) - len(errs), '실패', len(errs), errs[:3])

if __name__ == '__main__':
    main()
