// ===== 설정 =====
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';   // 배경지도용(도메인 제한 키)
const LIST_MAX = 300;    // 목록에 한 번에 그리는 개수
const HIT_MAX = 8;       // 검색 결과 개수

// ===== 상태 =====
let regions = [], region = null;           // 지역 목록, 지금 보는 지역
let meta = {}, groups = [], bldg = null, solar = null;
const byGroup = new Map();                 // 묶음 번호 -> 건물 목록
const cache = new Map();                   // 지역 코드 -> 받아 둔 자료
let index = null;                          // 통합 검색 색인 [회사명, 주소, 지역코드, 번호, 면적]
let view = [], selected = null, base = 'base', popup = null;
const f = { emd: '', sol: 'exclude', minC: 0, util: 0.5, kw: 0.30 };   // kw = ㎡당 설비용량(0.30 = 3.3㎡당 1kW)

const $ = id => document.getElementById(id);
const num = (v, d = 0) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gname = g => g.nm || '이름 없음';
const short = a => region ? a.replace(new RegExp('^\\S+\\s+' + region.name + '\\s*'), '') : a;
const mobile = () => innerWidth <= 760;
const getJson = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });

// ===== 지도 =====
function style(kind) {
  const t = n => `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/${n}/{z}/{y}/{x}.`;
  const src = {}, layers = [];
  if (kind === 'sat') {
    src.sat = { type: 'raster', tiles: [t('Satellite') + 'jpeg'], tileSize: 256, attribution: '© VWorld' };
    src.hyb = { type: 'raster', tiles: [t('Hybrid') + 'png'], tileSize: 256 };
    layers.push({ id: 'sat', type: 'raster', source: 'sat' }, { id: 'hyb', type: 'raster', source: 'hyb' });
  } else {
    src.base = { type: 'raster', tiles: [t('Base') + 'png'], tileSize: 256, attribution: '© VWorld' };
    layers.push({ id: 'base', type: 'raster', source: 'base' });
  }
  return { version: 8, sources: src, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } }, ...layers] };
}
const map = new maplibregl.Map({ container: 'map', style: style('base'), center: [127.7, 36.3], zoom: 7, minZoom: 6, maxZoom: 19 });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

const COLOR = ['match', ['get', 'st'], 'on', '#d92d20', 'near', '#f79009', '#0b7a6b'];
const LINE = ['match', ['get', 'st'], 'on', '#7a271a', 'near', '#93370d', '#04443b'];
const LINE_SAT = ['match', ['get', 'st'], 'on', '#ff6b5e', 'near', '#ffb020', '#19f0c8'];   // 항공사진용 밝은 색
const EMPTY = { type: 'FeatureCollection', features: [] };
function addLayers() {
  if (map.getSource('b')) return;
  const sat = base === 'sat';
  map.addSource('b', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'b-fill', type: 'fill', source: 'b', paint: { 'fill-color': COLOR, 'fill-opacity': 0.4 } });
  // 항공사진에서는 검은 바탕선 위에 밝은 색 선을 올려 흰 지붕·외벽과 구분한다
  if (sat) map.addLayer({ id: 'b-case', type: 'line', source: 'b', layout: { 'line-join': 'round' },
    paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 4, 17, 5.5] } });
  map.addLayer({ id: 'b-line', type: 'line', source: 'b', layout: { 'line-join': 'round' },
    paint: { 'line-color': sat ? LINE_SAT : LINE, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, sat ? 2 : 1.6, 17, sat ? 3 : 2.4] } });
  // 기존 태양광이라 후보에서 빠진 곳: 목록·합계에는 없고 지도에만 흐린 테두리로 남긴다
  map.addSource('x', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'x-fill', type: 'fill', source: 'x', paint: { 'fill-color': COLOR, 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'x-line', type: 'line', source: 'x', layout: { 'line-join': 'round' },
    paint: { 'line-color': sat ? LINE_SAT : COLOR, 'line-opacity': 0.75, 'line-dasharray': [3, 2], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 1.3, 17, 2] } });
  map.addSource('s', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 's-pt', type: 'circle', source: 's', minzoom: 13,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 5], 'circle-color': '#101828', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  // 선택한 곳: 진한 채움 + 노란 굵은 테두리
  map.addSource('sel', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': COLOR, 'fill-opacity': sat ? 0.35 : 0.85 } });
  map.addLayer({ id: 'sel-halo', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': '#fdb022', 'line-width': 5 } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': '#101828', 'line-width': 1.2 } });
  drawMap();
}
map.on('load', addLayers);
['b-fill', 'x-fill'].forEach(l => map.on('click', l, e => { const g = groups[e.features[0].properties.g]; if (g) select(g); }));
['b-fill', 'x-fill'].forEach(l => { map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer'); map.on('mouseleave', l, () => map.getCanvas().style.cursor = ''); });

function drawMap() {
  if (!map.getSource('b') || !bldg) return;
  const ok = new Set(view.map(g => g.id));
  if (selected) ok.add(selected.id);
  map.getSource('b').setData({ type: 'FeatureCollection', features: bldg.features.filter(x => ok.has(x.properties.g)) });
  const ex = new Set(f.sol === 'exclude' ? groups.filter(g => g.st === 'on' && !ok.has(g.id) && (!f.emd || g.emd === f.emd)).map(g => g.id) : []);
  map.getSource('x').setData({ type: 'FeatureCollection', features: bldg.features.filter(x => ex.has(x.properties.g)) });
  map.getSource('s').setData(solar);
  map.getSource('sel').setData(selected ? { type: 'FeatureCollection', features: byGroup.get(selected.id) } : EMPTY);
  // 선택한 곳이 있으면 나머지는 흐리게
  const sat = base === 'sat';
  map.setPaintProperty('b-fill', 'fill-opacity', selected ? (sat ? 0.08 : 0.14) : (sat ? 0.22 : 0.4));
  map.setPaintProperty('b-line', 'line-opacity', selected ? (sat ? 0.9 : 0.35) : 1);
}

// ===== 계산과 조건 =====
function calc(g) {
  g._cap = g.a * f.util * f.kw;                   // 추정 설비용량 kW
  g._cf = meta.cf.pct / 100;                      // 이용률(전력거래소 시도 실적)
  g._gen = g._cap * g._cf * 8760 / 1000;          // 연간 발전량 MWh
}
function apply() {
  groups.forEach(calc);
  view = groups.filter(g => {
    if (f.emd && g.emd !== f.emd) return false;
    // '근처 태양광'은 실제로 없는 경우가 많아 후보로 남기고, 지붕 위에 확인된 곳만 제외한다
    if (f.sol === 'exclude' && g.st === 'on') return false;
    if (f.sol === 'only' && g.st !== 'on') return false;
    return g._cap >= f.minC;
  }).sort((a, b) => b._cap - a._cap);
  $('sN').textContent = num(view.length);
  $('sCap').textContent = num(view.reduce((s, g) => s + g._cap, 0) / 1000, 1);
  $('sGen').textContent = num(view.reduce((s, g) => s + (g._gen || 0), 0) / 1000, 1);
  $('basisNow').textContent = `${Math.round(f.util * 100)}% · ${f.kw.toFixed(2)}kW/㎡` + (f.minC ? ` · ${num(f.minC)}kW 이상` : '');
  drawList(); drawMap();
  if (selected && popup) popup.setHTML(card(selected));   // 기준을 바꾸면 팝업 숫자도 바로 바뀜
}
function drawList() {
  const max = view.length ? view[0]._cap : 1;
  const tag = g => g.st === 'on' ? '<span class="tag on">기존 태양광</span>' : g.st === 'near' ? '<span class="tag near">근처 태양광</span>' : '';
  $('list').innerHTML = view.slice(0, LIST_MAX).map((g, i) => `
    <li data-id="${g.id}" class="${g.st}${selected && selected.id === g.id ? ' sel' : ''}">
      <span class="rk">${i + 1}</span>
      <span class="nm">${esc(gname(g))}${tag(g)}</span>
      <span class="cap">${num(g._cap)}<small>kW</small></span>
      <span class="ad">${esc(short(g.ad))}</span>
      <span class="ar">${num(g.a)}㎡ · ${g.n}동</span>
      <span class="bar"><i style="width:${Math.max(2, g._cap / max * 100).toFixed(1)}%"></i></span>
    </li>`).join('')
    + (view.length > LIST_MAX ? `<li class="msg">용량 큰 순으로 ${LIST_MAX}곳까지 표시 (전체 ${num(view.length)}곳)</li>` : '')
    + (view.length ? '' : '<li class="msg">조건에 맞는 곳이 없습니다</li>');
}
$('list').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) select(groups[+li.dataset.id]); });

// ===== 선택과 팝업 =====
function card(g) {
  const c = meta.cf, tip = `전력거래소 실적 · ${c.area} ${c.years[0]}~${c.years[c.years.length - 1]}년 평균 (${c.vals.join(', ')})`;
  const tel = g.tel ? `<a href="tel:${esc(g.tel.replace(/[^0-9+]/g, ''))}">${esc(g.tel)}</a>${g.telnm ? `<small>${esc(g.telnm)}</small>` : ''}` : '';
  return `<h2>${esc(gname(g))}</h2>
    <div class="ad">${esc(short(g.ad))}</div>
    <div class="cap"><b>${num(g._cap)}</b><small>kW</small><span>추정 용량</span></div>
    <dl>
      <dt>지붕</dt><dd>${num(g.a)}㎡ · ${g.n}동</dd>
      <dt>이용률</dt><dd>${g._cf ? num(g._cf * 100, 1) + '%' : '-'}${tip ? `<button class="tip" data-tip="${esc(tip)}" aria-label="이용률 출처">i</button>` : ''}</dd>
      <dt>연 발전량</dt><dd>${g._gen ? num(g._gen) + ' MWh' : '-'}</dd>
      <dt>기존 태양광</dt>${g.sn ? `<dd>${g.sn}건 · ${num(g.skw)}kW</dd>` : '<dd class="off">목록에 없음</dd>'}
      <dt>대표번호</dt>${tel ? `<dd>${tel}</dd>` : '<dd class="off">미확인</dd>'}
    </dl>`;
}
function bounds(g) {
  const pts = byGroup.get(g.id).flatMap(x => x.geometry.coordinates[0]);
  return pts.reduce((r, p) => [Math.min(r[0], p[0]), Math.min(r[1], p[1]), Math.max(r[2], p[0]), Math.max(r[3], p[1])], [999, 999, -999, -999]);
}
function select(g) {
  selected = g; calc(g);
  const b = bounds(g), m = mobile();
  if (m) $('side').classList.add('hide');
  // 팝업은 건물 바로 옆(PC는 오른쪽, 폰은 아래)에 붙인다
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: m ? { top: 70, bottom: 300, left: 30, right: 30 } : { top: 70, bottom: 70, left: 70, right: 330 }, maxZoom: 17.5, duration: 500 });
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
async function loadRegion(code) {
  const r = regions.find(x => x.code === code) || regions[0];
  if (!cache.has(r.code)) {
    const [a, b, s] = await Promise.all(['info.json', 'bldg.geojson', 'solar.geojson'].map(n => getJson(`data/${r.code}/${n}`)));
    cache.set(r.code, { a, b, s });
  }
  const d = cache.get(r.code);
  clearSelection();
  region = r; meta = d.a.meta; groups = d.a.groups; bldg = d.b; solar = d.s;
  byGroup.clear();
  bldg.features.forEach(x => { const g = x.properties.g; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(x); });
  $('region').value = r.code;
  f.emd = '';
  $('emd').innerHTML = '<option value="">읍면동 전체</option>' + [...new Set(groups.map(g => g.emd).filter(Boolean))].sort().map(e => `<option>${esc(e)}</option>`).join('');
  history.replaceState(null, '', '#' + r.code);
  apply();
  map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 40, duration: 0 });
}

// ===== 통합 검색 (회사·주소·지역) =====
async function loadIndex() {
  if (index) return index;
  const sidos = [...new Set(regions.map(r => r.code.slice(0, 2)))];
  index = (await Promise.all(sidos.map(s => getJson(`data/search/${s}.json`).catch(() => [])))).flat();
  return index;
}
let hits = [], act = 0;
async function search() {
  const q = $('q').value.trim().toLowerCase(), box = $('hits');
  if (q.length < 2) { box.hidden = true; return; }
  const ix = await loadIndex();
  if ($('q').value.trim().toLowerCase() !== q) return;   // 그사이 글자가 바뀌었으면 버림
  const rname = c => { const r = regions.find(x => x.code === c); return r ? r.name : ''; };
  hits = regions.filter(r => (r.sido + ' ' + r.name).toLowerCase().includes(q)).slice(0, 3).map(r => ({ type: 'region', r }));
  const starts = [], rest = [];
  for (const row of ix) {
    const n = row[0].toLowerCase();
    if (n.startsWith(q)) starts.push(row); else if (n.includes(q) || row[1].toLowerCase().includes(q)) rest.push(row);
  }
  const byArea = (a, b) => b[4] - a[4];
  hits = hits.concat([...starts.sort(byArea), ...rest.sort(byArea)].slice(0, HIT_MAX).map(row => ({ type: 'co', row })));
  act = 0;
  box.innerHTML = hits.length ? hits.map((h, i) => h.type === 'region'
    ? `<li data-i="${i}" class="${i ? '' : 'act'}"><b>${esc(h.r.name)}</b><em>지역 이동</em><small>${esc(h.r.sido)} · 후보 ${num(h.r.n)}곳</small></li>`
    : `<li data-i="${i}" class="${i ? '' : 'act'}"><b>${esc(h.row[0] || '이름 없음')}</b><em>${num(h.row[4])}㎡</em><small>${esc(rname(h.row[2]))} ${esc(h.row[1])}</small></li>`).join('')
    : '<li class="no">찾는 곳이 없습니다</li>';
  box.hidden = false;
}
async function pick(i) {
  const h = hits[i]; if (!h) return;
  $('hits').hidden = true; $('q').value = ''; $('q').blur();
  if (h.type === 'region') return loadRegion(h.r.code);
  if (!region || region.code !== h.row[2]) await loadRegion(h.row[2]);
  select(groups[h.row[3]]);
}

// ===== 조작 =====
function bind() {
  $('q').addEventListener('input', search);
  $('q').addEventListener('focus', () => { loadIndex(); search(); });
  $('q').addEventListener('keydown', e => {
    const lis = [...document.querySelectorAll('#hits li[data-i]')];
    if (e.key === 'Enter') { e.preventDefault(); pick(act); }
    else if (e.key === 'Escape') { $('hits').hidden = true; }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && lis.length) {
      e.preventDefault(); act = (act + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
      lis.forEach((li, i) => li.classList.toggle('act', i === act));
    }
  });
  $('hits').addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  document.addEventListener('click', e => { if (!e.target.closest('#find')) $('hits').hidden = true; });
  $('region').onchange = e => loadRegion(e.target.value);
  $('emd').onchange = e => { f.emd = e.target.value; apply(); };
  $('solMode').onchange = e => { f.sol = e.target.value; apply(); };
  const sl = (id, out, set, fmt) => { $(id).oninput = e => { set(+e.target.value); $(out).textContent = fmt(+e.target.value); apply(); }; };
  sl('util', 'vUtil', v => f.util = v / 100, v => v + '%');
  sl('kw', 'vKw', v => f.kw = v / 100, v => (v / 100).toFixed(2) + 'kW');
  sl('minC', 'vMinC', v => f.minC = v, v => num(v) + 'kW');
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
    const sidos = [...new Set(regions.map(r => r.sido))];
    $('region').innerHTML = sidos.map(s => `<optgroup label="${esc(s)}">` + regions.filter(r => r.sido === s).map(r => `<option value="${r.code}">${esc(r.name)}</option>`).join('') + '</optgroup>').join('');
    bind();
    await loadRegion(location.hash.slice(1));
    if (map.loaded()) addLayers();
  } catch (e) {
    $('list').innerHTML = `<li class="msg">자료를 불러오지 못했습니다: ${esc(e.message)}</li>`;
  }
})();
