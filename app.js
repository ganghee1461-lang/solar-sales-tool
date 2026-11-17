// ===== 설정 =====
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';   // 배경지도용(도메인 제한 키)
const LIST_MAX = 300;          // 목록에 한 번에 그리는 개수
const HIT_MAX = 8;             // 검색 결과 개수
const HOME_REGION = 'S:충청북도';   // 처음 열 때 보여줄 지역(충청북도 전체)

// ===== 상태 =====
let regions = [], region = null;           // 지역 목록, 지금 보는 지역
let meta = {}, groups = [], bldg = null;
const byGroup = new Map();                 // 묶음 번호 -> 건물 목록
let index = [], indexDone = false, indexBusy = null;   // 통합 검색 색인 [회사명, 주소, 지역코드, 번호, 면적]
let view = [], selected = null, base = 'base', popup = null;
const f = { emd: '', sol: 'exclude', minC: 100, util: 0.5, kw: 0.30, q: '' };   // q = 검색어(목록·지도를 거른다)   // kw = ㎡당 설비용량(0.30 = 3.3㎡당 1kW)

const $ = id => document.getElementById(id);
const num = (v, d = 0) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gname = g => g.nm || '이름 없음';
// 주소에서 지금 보는 지역 이름을 뗀다(도 전체를 볼 때는 도 이름만, 시군구를 볼 때는 시군구까지)
const short = a => { const p = region ? (region.all || region.name === region.sido ? region.sido : region.sido + ' ' + region.name) + ' ' : ''; return (a + ' ').startsWith(p) ? a.slice(p.length) : a; };
const idmap = new Map();   // '시군구코드:번호' -> 묶음 (검색 결과에서 찾아가기용)
const mobile = () => innerWidth <= 760;
const lc = s => String(s || '').toLowerCase();
const hitQ = g => !f.q || lc(g.nm).includes(f.q) || lc(g.ad).includes(f.q);   // 검색어가 회사명·주소에 있는지
// 지도를 맞출 때 여백: 폰에서 아래 패널이 올라와 있으면 그 높이만큼 비운다
const pad = () => mobile() && !$('side').classList.contains('hide') ? { top: 56, left: 16, right: 16, bottom: Math.min($('side').offsetHeight + 8, $('map').offsetHeight * 0.42) } : 40;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 받기: 실패하면 두 번 더 시도한다(폰 통신이 끊길 때 대비)
async function getJson(u) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return await r.json(); }
    catch (e) { if (i >= 2) throw e; await sleep(600 * (i + 1)); }
  }
}
// 여러 파일을 6개씩 나눠 받는다
async function pool(items, fn, n = 6) {
  const out = new Array(items.length); let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
  return out;
}
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

// ===== 지도 =====
function style(kind) {
  const t = n => `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/${n}/{z}/{y}/{x}.`;
  const src = {}, layers = [];
  if (kind === 'sat') {
    src.sat = { type: 'raster', tiles: [t('Satellite') + 'jpeg'], tileSize: 256, attribution: '© VWorld' };
    layers.push({ id: 'sat', type: 'raster', source: 'sat' });   // 도로·지명 겹침(Hybrid)은 쓰지 않는다
  } else {
    src.base = { type: 'raster', tiles: [t('Base') + 'png'], tileSize: 256, attribution: '© VWorld' };
    layers.push({ id: 'base', type: 'raster', source: 'base' });
  }
  return { version: 8, sources: src, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } }, ...layers] };
}
const map = new maplibregl.Map({ container: 'map', style: style('base'), center: [127.7, 36.3], zoom: 7, minZoom: 6, maxZoom: 19 });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

// 색은 두 가지뿐: 후보(청록), 기존 태양광(빨강)
const COLOR = ['match', ['get', 'st'], 'on', '#d92d20', '#0b7a6b'];
const LINE = ['match', ['get', 'st'], 'on', '#7a271a', '#04443b'];
const LINE_SAT = ['match', ['get', 'st'], 'on', '#ff6b5e', '#19f0c8'];   // 항공사진용 밝은 색
const EMPTY = { type: 'FeatureCollection', features: [] };
const W = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 10, a, 14, b, 17, c];
function addLayers() {
  if (map.getSource('b')) return;
  const sat = base === 'sat';
  // 후보 건물
  map.addSource('b', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'b-fill', type: 'fill', source: 'b', paint: { 'fill-color': COLOR, 'fill-opacity': 0.4 } });
  if (sat) map.addLayer({ id: 'b-case', type: 'line', source: 'b', layout: { 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': W(1.6, 4, 5.5) } });
  map.addLayer({ id: 'b-line', type: 'line', source: 'b', layout: { 'line-join': 'round' }, paint: { 'line-color': sat ? LINE_SAT : LINE, 'line-width': W(0.6, sat ? 2 : 1.6, sat ? 3 : 2.4) } });
  // 기존 태양광이라 후보에서 빠진 동: 목록·합계에는 없고 지도에만 흐린 점선으로 남긴다
  map.addSource('x', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'x-fill', type: 'fill', source: 'x', paint: { 'fill-color': '#d92d20', 'fill-opacity': 0.1 } });
  map.addLayer({ id: 'x-line', type: 'line', source: 'x', layout: { 'line-join': 'round' },
    paint: { 'line-color': sat ? '#ff6b5e' : '#d92d20', 'line-opacity': 0.8, 'line-dasharray': [3, 2], 'line-width': W(0.5, 1.3, 2) } });
  // 회사 위치 점: 광역 전체처럼 건물 도형을 아직 안 받았거나 넓게 볼 때(확대 11 미만)
  map.addSource('p', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'p-dot', type: 'circle', source: 'p', maxzoom: 12,
    paint: { 'circle-color': '#0b7a6b', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.8, 11, 4.5], 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.6, 'circle-opacity': 0.9 } });
  // 선택한 곳: 진한 채움 + 노란 굵은 테두리
  map.addSource('sel', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': COLOR, 'fill-opacity': sat ? 0.35 : 0.85 } });
  map.addLayer({ id: 'sel-halo', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': '#fdb022', 'line-width': 5 } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': '#101828', 'line-width': 1.2 } });
  drawMap();
}
map.on('load', addLayers);
['b-fill', 'x-fill', 'p-dot'].forEach(l => {
  map.on('click', l, e => { const g = groups[e.features[0].properties.g]; if (g) select(g); });
  map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer'); map.on('mouseleave', l, () => map.getCanvas().style.cursor = '');
});

function drawMap() {
  if (!map.getSource('b') || !bldg) return;
  const ok = new Set(view.map(g => g.id));
  if (selected) ok.add(selected.id);
  const hide = f.sol === 'exclude';   // 기존 태양광 동을 후보에서 뺄지
  map.getSource('b').setData({ type: 'FeatureCollection', features: bldg.features.filter(x => ok.has(x.properties.g) && !(hide && x.properties.st === 'on')) });
  const emdOk = new Set(groups.filter(g => !f.emd || g.sub === f.emd).map(g => g.id));
  map.getSource('x').setData({ type: 'FeatureCollection', features: hide ? bldg.features.filter(x => x.properties.st === 'on' && emdOk.has(x.properties.g)) : [] });
  map.getSource('p').setData({ type: 'FeatureCollection', features: view.map(g => ({ type: 'Feature', geometry: { type: 'Point', coordinates: g.c }, properties: { g: g.id } })) });
  map.getSource('sel').setData(selected && byGroup.has(selected.id) ? { type: 'FeatureCollection', features: byGroup.get(selected.id) } : EMPTY);
  const sat = base === 'sat';
  map.setPaintProperty('b-fill', 'fill-opacity', selected ? (sat ? 0.08 : 0.14) : (sat ? 0.22 : 0.4));   // 선택한 곳이 있으면 나머지는 흐리게
  map.setPaintProperty('b-line', 'line-opacity', selected ? (sat ? 0.9 : 0.35) : 1);
}

// ===== 계산과 조건 =====
// 추정 용량은 "후보 지붕"(기존 태양광이 올라간 동을 뺀 나머지 지붕)만으로 계산한다
function calc(g) {
  g._cap = g.a * f.util * f.kw;                              // kW
  g._cf = meta.cf ? meta.cf.pct / 100 : null;                // 이용률(전력거래소 시도 실적)
  g._gen = g._cf ? g._cap * g._cf * 8760 / 1000 : null;      // 연간 발전량 MWh
}
// 전국 전체일 때 목록에 띄우는 광역별 요약(회사 수는 조건 적용 전)
const sidoRows = () => [...new Set(regions.map(r => r.sido))].map(s => { const p = regions.filter(r => r.sido === s); return { s, n: p.reduce((a, r) => a + r.n, 0), k: p.length }; }).sort((a, b) => b.n - a.n);
function apply() {
  $('basisNow').textContent = `${num(f.minC)}kW 이상 · ${Math.round(f.util * 100)}% · ${f.kw.toFixed(2)}kW/㎡`;
  if (region && region.nation) {
    view = []; const rows = sidoRows();
    $('list').innerHTML = rows.map((r, i) => `
      <li data-sido="${esc('S:' + r.s)}" class="sido">
        <span class="rk">${i + 1}</span><span class="nm">${esc(r.s)}</span><span class="cap">${num(r.n)}<small>곳</small></span>
        <span class="ad">시군구 ${r.k}곳</span>
        <span class="bar"><i style="width:${Math.max(2, r.n / rows[0].n * 100).toFixed(1)}%"></i></span>
      </li>`).join('');
    drawMap(); return;
  }
  groups.forEach(calc);
  view = groups.filter(g => {
    if (f.emd && g.sub !== f.emd) return false;
    if (!hitQ(g)) return false;
    if (f.sol === 'exclude' && g.st === 'on') return false;   // 모든 동에 태양광이 있는 곳만 뺀다
    return g._cap >= f.minC;                                  // 남은 지붕으로 낼 수 있는 용량이 기준 이상인 곳만
  }).sort((a, b) => b._cap - a._cap);
  drawList(); drawMap();
  if (selected && popup) popup.setHTML(card(selected));   // 기준을 바꾸면 팝업 숫자도 바로 바뀜
}
function drawList() {
  const max = view.length ? view[0]._cap : 1;
  // 검색 중이면 조건(용량 기준 등) 때문에 빠진 회사도 아래에 흐리게 보여준다
  const shown = new Set(view.map(g => g.id));
  const outs = f.q ? groups.filter(g => !shown.has(g.id) && (!f.emd || g.sub === f.emd) && hitQ(g)).sort((a, b) => b.a - a.a).slice(0, 30) : [];
  $('list').innerHTML = view.slice(0, LIST_MAX).map((g, i) => `
    <li data-id="${g.id}" class="${g.st === 'on' ? 'on' : ''}${selected && selected.id === g.id ? ' sel' : ''}">
      <span class="rk">${i + 1}</span>
      <span class="nm">${esc(gname(g))}</span>
      <span class="cap">${num(g._cap)}<small>kW</small></span>
      <span class="ad">${esc(short(g.ad))}</span>
      <span class="bar"><i style="width:${Math.max(2, g._cap / max * 100).toFixed(1)}%"></i></span>
    </li>`).join('')
    + (view.length > LIST_MAX ? `<li class="msg">${LIST_MAX} / ${num(view.length)}곳</li>` : '')
    + (view.length ? '' : '<li class="msg">결과 없음</li>')
    + (outs.length ? '<li class="msg sub">조건 밖</li>' + outs.map(g => `
    <li data-id="${g.id}" class="out${selected && selected.id === g.id ? ' sel' : ''}">
      <span class="rk">-</span>
      <span class="nm">${esc(gname(g))}<span class="tag">${g.st === 'on' ? '기존 태양광' : '조건 밖'}</span></span>
      <span class="cap">${num(g._cap)}<small>kW</small></span>
      <span class="ad">${esc(short(g.ad))}</span>
    </li>`).join('') : '');
}
$('list').addEventListener('click', e => {
  const s = e.target.closest('li[data-sido]'); if (s) return loadRegion(s.dataset.sido);
  const li = e.target.closest('li[data-id]'); if (li) select(groups[+li.dataset.id]);
});

// ===== 선택과 팝업 =====
function card(g) {
  const c = meta.cf, tip = c ? `전력거래소 실적 · ${c.area} ${c.years[0]}~${c.years[c.years.length - 1]}년 평균 (${c.vals.join(', ')})` : '';
  const tel = g.tel ? `<a href="tel:${esc(g.tel.replace(/[^0-9+]/g, ''))}">${esc(g.tel)}</a>${g.telnm ? `<small>${esc(g.telnm)}</small>` : ''}` : '';
  const ex = g.nt - g.n;   // 기존 태양광이 있는 동 수
  return `<h2>${esc(gname(g))}</h2>
    <div class="ad">${esc(short(g.ad))}</div>
    <div class="cap"><b>${num(g._cap)}</b><small>kW</small><span>추정 용량</span></div>
    <dl>
      <dt>후보 지붕</dt><dd>${num(g.a)}㎡ · ${g.n}동</dd>
      <dt>기존 태양광</dt>${ex ? `<dd class="red">${num(g.at - g.a)}㎡ · ${ex}동 제외<small>${[g.sn ? `판매용(등록) ${g.sn}건 · ${num(g.skw)}kW` : '', g.pn ? `사진 판독 ${g.pn}동` : ''].filter(Boolean).join('<br>')}</small></dd>` : '<dd class="off">없음</dd>'}
      <dt>이용률</dt><dd>${g._cf ? num(g._cf * 100, 1) + '%' : '-'}${tip ? `<button class="tip" data-tip="${esc(tip)}" aria-label="이용률 출처">i</button>` : ''}</dd>
      <dt>연 발전량</dt><dd>${g._gen ? num(g._gen) + ' MWh' : '-'}</dd>
      <dt>대표번호</dt>${tel ? `<dd>${tel}</dd>` : '<dd class="off">미확인</dd>'}
    </dl>`;
}
function bounds(g) {
  const pts = byGroup.get(g.id).flatMap(x => x.geometry.coordinates[0]);
  return pts.reduce((r, p) => [Math.min(r[0], p[0]), Math.min(r[1], p[1]), Math.max(r[2], p[0]), Math.max(r[3], p[1])], [999, 999, -999, -999]);
}
async function select(g) {
  if (!byGroup.has(g.id)) { try { await ensureGeom(g.rc); } catch (e) { return; } }
  if (!byGroup.has(g.id)) return;
  selected = g; calc(g);
  const b = bounds(g), m = mobile();
  if (m) $('side').classList.add('hide');
  // 팝업은 건물 바로 옆(PC는 오른쪽, 폰은 아래)에 붙인다
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: m ? { top: 70, bottom: 300, left: 30, right: 30 } : { top: 70, bottom: 70, left: 70, right: 400 }, maxZoom: 17.5, duration: 500 });
  if (popup) { popup.off('close', onPopupClose); popup.remove(); }
  popup = new maplibregl.Popup({ className: 'card', closeOnClick: false, focusAfterOpen: false, maxWidth: 'none', anchor: m ? 'top' : 'left', offset: 12 })
    .setLngLat(m ? [(b[0] + b[2]) / 2, b[1]] : [b[2], (b[1] + b[3]) / 2]).setHTML(card(g)).addTo(map);
  popup.on('close', onPopupClose);
  drawMap(); markList();
}
function onPopupClose() { selected = null; popup = null; drawMap(); markList(); }
function clearSelection() { if (popup) popup.remove(); }
function markList() {
  document.querySelectorAll('#list li[data-id]').forEach(li => li.classList.toggle('sel', !!selected && +li.dataset.id === selected.id));
  const el = document.querySelector('#list li.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}

// ===== 지역 =====
// 지역은 "도 전체"(코드가 'S:도이름') 또는 시군구 하나.
// 회사 목록(info.json)은 범위 전체를 받는다. 건물 도형(bldg.geojson)은 무거워서
//  시군구 하나면 바로 받고, 도 전체면 지도를 확대한 곳의 시군구만 그때그때 받는다.
const infoCache = new Map(), geomCache = new Map();
let parts = [], partOff = new Map(), geomDone = new Set(), loadSeq = 0;
async function fetchInfo(code) { if (!infoCache.has(code)) infoCache.set(code, await getJson(`data/${code}/info.json`)); return infoCache.get(code); }
async function ensureGeom(code) {
  if (geomDone.has(code) || !partOff.has(code)) return;
  const seq = loadSeq;
  if (!geomCache.has(code)) geomCache.set(code, getJson(`data/${code}/bldg.geojson`).catch(e => { geomCache.delete(code); throw e; }));   // 같은 파일을 두 번 받지 않게 받는 중인 것도 기억
  const gj = await geomCache.get(code);
  if (seq !== loadSeq || geomDone.has(code)) return;   // 그사이 다른 지역으로 옮겼으면 버린다
  const off = partOff.get(code);
  for (const x of gj.features) {
    const ft = { type: 'Feature', geometry: x.geometry, properties: { g: off + x.properties.g, st: x.properties.st } };
    bldg.features.push(ft); if (!byGroup.has(ft.properties.g)) byGroup.set(ft.properties.g, []); byGroup.get(ft.properties.g).push(ft);
  }
  geomDone.add(code); drawMap();
}
// 도 전체에서 지도를 확대하면 화면에 걸친 시군구의 건물 도형을 받는다
function geomInView() {
  if (!region || !region.all || map.getZoom() < 11) return;
  const v = map.getBounds(), w = v.getWest(), e = v.getEast(), s2 = v.getSouth(), n = v.getNorth();
  parts.filter(r => !geomDone.has(r.code) && r.bbox[0] <= e && r.bbox[2] >= w && r.bbox[1] <= n && r.bbox[3] >= s2).forEach(r => ensureGeom(r.code).catch(() => {}));
}
map.on('moveend', geomInView);
// 광역 · 시군구 · 읍면동 세 칸을 지금 범위에 맞게 채운다. 각 칸 맨 위는 '전체'
function fillScope() {
  const sido = region.nation ? '' : region.sido, sggs = sido ? regions.filter(r => r.sido === sido) : [], single = sggs.length === 1;
  $('sido').innerHTML = '<option value="ALL">전국 전체</option>' + [...new Set(regions.map(r => r.sido))].map(s => `<option value="${esc('S:' + s)}">${esc(s)}</option>`).join('');
  $('sido').value = sido ? 'S:' + sido : 'ALL';
  $('sgg').innerHTML = !sido ? '<option value="">시군구 전체</option>'
    : single ? `<option value="${sggs[0].code}">시군구 전체</option>`
    : `<option value="${esc('S:' + sido)}">시군구 전체</option>` + sggs.map(r => `<option value="${r.code}">${esc(r.name)}</option>`).join('');
  $('sgg').value = sido ? region.code : ''; $('sgg').disabled = !sido || single;
  const emds = region.nation || region.all ? [] : [...new Set(groups.map(g => g.sub).filter(Boolean))].sort();
  $('emd').innerHTML = '<option value="">읍면동 전체</option>' + emds.map(e => `<option>${esc(e)}</option>`).join('');
  $('emd').value = f.emd; $('emd').disabled = !emds.length;
}
// 지도를 회사 위치들에 맞춘다(읍면동을 골랐을 때)
function fitGroups(list) {
  if (!list.length) return;
  const b = list.reduce((r, g) => [Math.min(r[0], g.c[0]), Math.min(r[1], g.c[1]), Math.max(r[2], g.c[0]), Math.max(r[3], g.c[1])], [999, 999, -999, -999]);
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad(), maxZoom: 15, duration: 400 });
}
function resetSearch() { $('q').value = ''; $('hits').hidden = true; f.q = ''; }
function loadNation() {
  loadSeq++; parts = []; partOff = new Map(); geomDone = new Set();
  clearSelection(); resetSearch();
  region = { code: 'ALL', nation: true, name: '전국', sido: '', bbox: regions.reduce((b, r) => [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])], [999, 999, -999, -999]) };
  meta = {}; groups = []; byGroup.clear(); idmap.clear(); bldg = { type: 'FeatureCollection', features: [] }; f.emd = '';
  fillScope();
  history.replaceState(null, '', '#ALL'); store.set('roofpv_region', 'ALL');
  apply();
  map.fitBounds([[region.bbox[0], region.bbox[1]], [region.bbox[2], region.bbox[3]]], { padding: pad(), duration: 0 });
}
async function loadRegion(code) {
  code = decodeURIComponent(code || '');
  if (code === 'ALL') return loadNation();
  let sidoOf = code.startsWith('S:') ? code.slice(2) : null;
  const ps = sidoOf ? regions.filter(r => r.sido === sidoOf) : regions.filter(r => r.code === code);
  if (!ps.length) return loadRegion(HOME_REGION);
  if (sidoOf && ps.length === 1) sidoOf = null;   // 세종처럼 시군구가 하나뿐인 곳은 시군구로 연다
  const seq = ++loadSeq;
  resetSearch();
  $('list').innerHTML = '<li class="msg">불러오는 중…</li>';
  let data;
  try { data = await pool(ps, r => fetchInfo(r.code)); }
  catch (e) {
    if (seq !== loadSeq) return;
    $('list').innerHTML = `<li class="msg">불러오지 못했습니다<br><button class="retry" type="button">다시 시도</button></li>`;
    $('list').querySelector('.retry').onclick = () => loadRegion(code);
    return;
  }
  if (seq !== loadSeq) return;   // 기다리는 사이 다른 지역을 눌렀으면 버린다
  clearSelection();
  const all = !!sidoOf;
  region = all ? { code: 'S:' + sidoOf, sido: sidoOf, name: sidoOf, all: true, bbox: ps.reduce((b, r) => [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])], [999, 999, -999, -999]) } : ps[0];
  parts = ps; partOff = new Map(); geomDone = new Set();
  meta = data[0].meta; groups = []; byGroup.clear(); idmap.clear();
  data.forEach((d, i) => {
    const off = groups.length, r = ps[i]; partOff.set(r.code, off);
    d.groups.forEach(g => { const n = Object.assign({}, g, { id: off + g.id, sub: all ? r.name : g.emd, rc: r.code }); groups.push(n); idmap.set(r.code + ':' + g.id, n); });
  });
  bldg = { type: 'FeatureCollection', features: [] };
  f.emd = '';
  fillScope();
  history.replaceState(null, '', '#' + encodeURIComponent(region.code)); store.set('roofpv_region', region.code);
  apply();
  map.fitBounds([[region.bbox[0], region.bbox[1]], [region.bbox[2], region.bbox[3]]], { padding: pad(), duration: 0 });
  if (!all) ensureGeom(ps[0].code).catch(() => {}); else geomInView();
}

// ===== 통합 검색 (회사·주소·지역) =====
// 색인은 시도별 파일이다. 전부 동시에 받고, 받는 대로(잠깐 모았다가) 검색 결과에 반영한다.
function loadIndex() {
  if (indexBusy) return indexBusy;
  let t = 0;
  const redraw = () => { clearTimeout(t); t = setTimeout(() => { if (region && region.nation && $('q').value.trim().length >= 2) search(); }, 150); };
  const sidos = [...new Set(regions.map(r => r.code.slice(0, 2)))];
  indexBusy = Promise.all(sidos.map(s => getJson(`data/search/${s}.json`).catch(() => []).then(rows => { for (const r of rows) index.push(r); redraw(); })))
    .then(() => { indexDone = true; redraw(); });
  return indexBusy;
}
// 검색은 위 세 칸으로 고른 범위 안에서만 한다.
//  광역·시군구를 골랐으면 → 검색어로 아래 목록과 지도를 바로 거른다. 드롭다운에는 '지역 이동' 제안만 뜬다.
//  전국 전체 → 목록이 광역 요약뿐이라 전국 색인(시도별 파일)에서 회사를 찾아 드롭다운으로 보여준다.
let hits = [], act = 0;
function search() {
  const q = $('q').value.trim().toLowerCase(), box = $('hits');
  const byRank = (s, r, k) => [...s.sort((a, b) => k(b) - k(a)), ...r.sort((a, b) => k(b) - k(a))];
  const nation = region.nation;
  if (!nation && f.q !== q) { f.q = q; apply(); }
  if (q.length < 2) { box.hidden = true; hits = []; return; }
  if (nation) {
    loadIndex();
    const rname = c => { const r = regions.find(x => x.code === c); return r ? (r.name === r.sido ? r.sido : r.sido.replace(/특별자치도|특별자치시|광역시|특별시|통합특별시/, '') + ' ' + r.name) : ''; };
    hits = [...new Set(regions.map(r => r.sido))].filter(x => lc(x).includes(q)).slice(0, 2).map(x => ({ type: 'region', r: { code: 'S:' + x, name: x, sido: '광역 이동', n: regions.filter(r => r.sido === x).reduce((a, r) => a + r.n, 0) } }))
      .concat(regions.filter(r => r.name !== r.sido && lc(r.sido + ' ' + r.name).includes(q)).slice(0, 3).map(r => ({ type: 'region', r })));
    const starts = [], rest = [];
    for (const row of index) { const n = lc(row[0]); if (n.startsWith(q)) starts.push(row); else if (n.includes(q) || lc(row[1]).includes(q)) rest.push(row); }
    hits = hits.concat(byRank(starts, rest, r => r[4]).slice(0, HIT_MAX).map(row => ({ type: 'co', row, sub: rname(row[2]) + ' ' + row[1] })));
  } else {
    // 범위 안의 하위 지역: 광역 전체면 시군구, 시군구면 읍면동
    hits = region.all
      ? regions.filter(r => r.sido === region.sido && lc(r.name).includes(q)).slice(0, 3).map(r => ({ type: 'region', r }))
      : [...new Set(groups.map(g => g.sub))].filter(e => e && e !== f.emd && lc(e).includes(q)).slice(0, 3).map(e => ({ type: 'emd', e, n: groups.filter(g => g.sub === e).length }));
    if (!hits.length) { box.hidden = true; return; }   // 회사는 아래 목록에서 바로 보이므로 드롭다운을 띄우지 않는다
  }
  act = 0;
  const row = (h, i) => {
    const c = i ? '' : 'act';
    if (h.type === 'region') return `<li data-i="${i}" class="${c}"><b>${esc(h.r.name)}</b><em>${num(h.r.n)}곳</em><small>${esc(h.r.sido)}</small></li>`;
    if (h.type === 'emd') return `<li data-i="${i}" class="${c}"><b>${esc(h.e)}</b><em>${num(h.n)}곳</em><small>${esc(region.name)}</small></li>`;
    return `<li data-i="${i}" class="${c}"><b>${esc(h.row[0] || '이름 없음')}</b><em>${num(h.row[4])}㎡</em><small>${esc(h.sub)}</small></li>`;
  };
  const wait = nation && !indexDone;
  box.innerHTML = (hits.length ? hits.map(row).join('') : (wait ? '' : '<li class="no">전국에서 찾는 곳이 없습니다</li>'))
    + (wait ? '<li class="no">전국 목록을 불러오는 중…</li>' : '');
  box.hidden = false;
}
async function pick(i) {
  const h = hits[i]; if (!h) return;
  $('q').blur();
  if (h.type === 'region') return loadRegion(h.r.code);   // 범위가 바뀌면 검색어는 비운다
  if (h.type === 'emd') { resetSearch(); f.emd = h.e; fillScope(); apply(); return fitGroups(groups.filter(g => g.sub === h.e)); }
  $('hits').hidden = true;
  const key = h.row[2] + ':' + h.row[3];
  if (!idmap.has(key)) await loadRegion(h.row[2]);      // 지금 보는 지역에 없으면 그 시군구로 이동
  if (idmap.has(key)) select(idmap.get(key));
}

// ===== 조작 =====
function bind() {
  $('q').addEventListener('input', search);
  $('q').addEventListener('focus', () => { if (region && region.nation) loadIndex(); search(); });
  $('q').addEventListener('keydown', e => {
    const lis = [...document.querySelectorAll('#hits li[data-i]')];
    if (e.key === 'Enter') {   // 제안이 떠 있으면 그걸, 아니면 목록 첫 회사를 고른다
      e.preventDefault();
      if (!$('hits').hidden && hits.length) pick(act); else if (view.length) { $('q').blur(); select(view[0]); }
    }
    else if (e.key === 'Escape') { $('hits').hidden = true; }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && lis.length) {
      e.preventDefault(); act = (act + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
      lis.forEach((li, i) => li.classList.toggle('act', i === act));
    }
  });
  $('hits').addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  document.addEventListener('click', e => { if (!e.target.closest('#find')) $('hits').hidden = true; });
  $('sido').onchange = e => loadRegion(e.target.value);
  $('sgg').onchange = e => loadRegion(e.target.value);
  $('emd').onchange = e => {
    f.emd = e.target.value; resetSearch(); fillScope(); apply();
    if (f.emd) fitGroups(groups.filter(g => g.sub === f.emd)); else map.fitBounds([[region.bbox[0], region.bbox[1]], [region.bbox[2], region.bbox[3]]], { padding: pad(), duration: 400 });
  };
  $('solMode').onchange = e => { f.sol = e.target.value; apply(); };
  const sl = (id, out, set, fmt) => { $(id).oninput = e => { set(+e.target.value); $(out).textContent = fmt(+e.target.value); apply(); }; };
  sl('minC', 'vMinC', v => f.minC = v, v => num(v) + 'kW');
  sl('util', 'vUtil', v => f.util = v / 100, v => v + '%');
  sl('kw', 'vKw', v => f.kw = v / 100, v => (v / 100).toFixed(2) + 'kW');
  document.querySelectorAll('#basemap button').forEach(b => b.onclick = () => {
    if (base === b.dataset.base) return;
    base = b.dataset.base; document.querySelectorAll('#basemap button').forEach(x => x.classList.toggle('on', x === b));
    map.setStyle(style(base)); map.once('styledata', () => setTimeout(addLayers, 0));
  });
  $('toggleSide').onclick = () => $('side').classList.toggle('hide');
}

// ===== 시작 =====
(async function start() {
  try {
    regions = (await getJson('data/regions.json')).regions;
    bind();
    await loadRegion(location.hash.slice(1) || store.get('roofpv_region') || HOME_REGION);
    if (map.loaded()) addLayers();
  } catch (e) {
    $('list').innerHTML = `<li class="msg">자료를 불러오지 못했습니다: ${esc(e.message)}</li>`;
  }
})();
