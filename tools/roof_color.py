"""지붕 사진에서 색 특징을 뽑는다(모델을 쓰지 않는 사전 걸러내기용).
노란 선 안쪽(지붕) 픽셀만 보고, 태양광 패널처럼 어둡고 푸르거나 무채색인 픽셀의 비율 등을 계산한다."""
import os, sys, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw
import numpy as np
from crop_roofs import tile_xy, OUT_PX, PAD

def roof_mask(ring, size):
    """crop_roofs.crop 과 같은 계산으로 지붕 외곽선을 사진 좌표로 옮겨 마스크를 만든다"""
    lons = [p[0] for p in ring]; lats = [p[1] for p in ring]
    for z in (19, 18, 17, 16):
        x0, y1 = tile_xy(min(lons), min(lats), z); x1, y0 = tile_xy(max(lons), max(lats), z)
        w, h = (x1 - x0) * 256, (y1 - y0) * 256
        if max(w, h) <= 900 or z == 16: break
    pad = max(w, h) * PAD + 12
    px0, py0, px1, py1 = x0 * 256 - pad, y0 * 256 - pad, x1 * 256 + pad, y1 * 256 + pad
    cw, ch = int(px1 - int(px0 // 256) * 256) - int(px0 - int(px0 // 256) * 256), int(py1 - int(py0 // 256) * 256) - int(py0 - int(py0 // 256) * 256)
    s = min(1.0, OUT_PX / max(cw, ch))
    pts = [((tile_xy(lo, la, z)[0] * 256 - px0) * s, (tile_xy(lo, la, z)[1] * 256 - py0) * s) for lo, la in ring]
    m = Image.new('L', size, 0); ImageDraw.Draw(m).polygon(pts, fill=255)
    m = np.asarray(m) > 0
    # 노란 외곽선 자체는 빼기 위해 안쪽으로 3픽셀 줄인다
    from PIL import ImageFilter
    m2 = np.asarray(Image.fromarray((m * 255).astype('uint8')).filter(ImageFilter.MinFilter(7))) > 0
    return m2 if m2.sum() > 50 else m

def features(path, ring):
    im = Image.open(path).convert('RGB'); a = np.asarray(im).astype('int32'); m = roof_mask(ring, im.size)
    px = a[m]
    if len(px) < 30: return None
    r, g, b = px[:, 0], px[:, 1], px[:, 2]; mx = px.max(1); mn = px.min(1)
    dark = mx < 110                                   # 어두운 픽셀
    panel = dark & (b >= r - 8) & (b >= g - 12)        # 어둡고, 푸르거나 무채색(초록·갈색 제외)
    gray = np.asarray(im.convert('L')).astype('int32')
    gx = np.abs(np.diff(gray, axis=1))[:, :-0 or None]; gy = np.abs(np.diff(gray, axis=0))
    ed = np.zeros_like(gray); ed[:, 1:] += gx; ed[1:, :] += gy
    return {'dark': float(dark.mean()), 'panel': float(panel.mean()), 'bright': float((mn > 150).mean()),
            'mean': float(mx.mean()), 'edge': float(ed[m].mean()), 'pedge': float(ed[m][panel].mean()) if panel.sum() > 20 else 0.0}
