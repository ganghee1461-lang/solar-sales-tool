// ===== 설정 =====
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';   // 배경지도용(도메인 제한 키)
const LIST_MAX = 300;          // 목록에 한 번에 그리는 개수
const HIT_MAX = 8;             // 검색 결과 개수
const HOME_REGION = 'S:충청북도';   // 처음 열 때 보여줄 지역(충청북도 전체)

// ===== 상태 =====
let regions = [], region = null;           // 지역 목록, 지금 보는 지역
let meta = {}, groups = [], bldg = null;
const byGroup = new Map();                 // 묶음 번호 -> 건물 목록
const cache = new Map();                   // 지역 코드 -> 받아 둔 자료
let index = [], indexDone = false, indexBusy = null;   // 통합 검색 색인 [회사명, 주소, 지역코드, 번호, 면적]
let view = [], selected = null, base = 'base', popup = null;
const f = { emd: '', sol: 'exclude', minC: 100, util: 0.5, kw: 0.30 };   // kw = ㎡당 설비용량(0.30 = 3.3㎡당 1kW)

const $ = id => document.getElementById(id);
const num = (v, d = 0) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gname = g => g.nm || '이름 없음';
// 주소에서 지금 보는 지역 이름을 뗀다(도 전체를 볼 때는 도 이름만, 시군구를 볼 때는 시군구까지)
const short = a => { const p = region ? (region.all || region.name === region.sido ? region.sido : region.sido + ' ' + region.name) + ' ' : ''; return (a + ' ').startsWith(p) ? a.slice(p.length) : a; };
const idmap = new Map();   // '시군구코드:번호' -> 묶음 (검색 결과에서 찾아가기용)
const mobile = () => innerWidth <= 760;
const getJson = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

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
  // 선택한 곳: 진한 채움 + 노란 굵은 테두리
  map.addSource('sel', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': COLOR, 'fill-opacity': sat ? 0.35 : 0.85 } });
  map.addLayer({ id: 'sel-halo', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': '#fdb022', 'line-width': 5 } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': '#101828', 'line-width': 1.2 } });
  drawMap();
}
map.on('load', addLayers);
['b-fill', 'x-fill'].forEach(l => {
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
  map.getSource('sel').setData(selected ? { type: 'FeatureCollection', features: byGroup.get(selected.id) } : EMPTY);
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
function apply() {
  groups.forEach(calc);
  view = groups.filter(g => {
    if (f.emd && g.sub !== f.emd) return false;
    if (f.sol === 'exclude' && g.st === 'on') return false;   // 모든 동에 태양광이 있는 곳만 뺀다
    if (f.sol === 'only' && g.st === 'none') return false;
    return g._cap >= f.minC;                                  // 남은 지붕으로 낼 수 있는 용량이 기준 이상인 곳만
  }).sort((a, b) => b._cap - a._cap);
  $('sN').textContent = num(view.length);
  $('sCap').textContent = num(view.reduce((s, g) => s + g._cap, 0) / 1000, 1);
  $('sGen').textContent = num(view.reduce((s, g) => s + (g._gen || 0), 0) / 1000, 1);
  $('basisNow').textContent = `${num(f.minC)}kW 이상 · ${Math.round(f.util * 100)}% · ${f.kw.toFixed(2)}kW/㎡`;
  drawList(); drawMap();
  if (selected && popup) popup.setHTML(card(selected));   // 기준을 바꾸면 팝업 숫자도 바로 바뀜
}
function drawList() {
  const max = view.length ? view[0]._cap : 1;
  $('list').innerHTML = view.slice(0, LIST_MAX).map((g, i) => `
    <li data-id="${g.id}" class="${g.st === 'on' ? 'on' : ''}${selected && selected.id === g.id ? ' sel' : ''}">
      <span class="rk">${i + 1}</span>
      <span class="nm">${esc(gname(g))}</span>
      <span class="cap">${num(g._cap)}<small>kW</small></span>
      <span class="ad">${esc(short(g.ad))}</span>
      <span class="ar">${num(g.a)}㎡ · ${g.n}동${g.nt > g.n ? ` <em>기존 ${g.nt - g.n}동 제외</em>` : ''}</span>
      <span class="bar"><i style="width:${Math.max(2, g._cap / max * 100).toFixed(1)}%"></i></span>
    </li>`).join('')
    + (view.length > LIST_MAX ? `<li class="msg">용량 큰 순으로 ${LIST_MAX}곳까지 표시 (전체 ${num(view.length)}곳)</li>` : '')
    + (view.length ? '' : '<li class="msg">조건에 맞는 곳이 없습니다</li>');
}
$('list').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) select(groups[+li.dataset.id]); });

// ===== 선택과 팝업 =====
function card(g) {
  const c = meta.cf, tip = c ? `전력거래소 실적 · ${c.area} ${c.years[0]}~${c.years[c.years.length - 1]}년 평균 (${c.vals.join(', ')})` : '';
  const tel = g.tel ? `<a href="tel:${esc(g.tel.replace(/[^0-9+]/g, ''))}">${esc(g.tel)}</a>${g.telnm ? `<small>${esc(g.telnm)}</small>` : ''}` : '';
  const ex = g.nt - g.n;   // 기존 태양광이 있는 동 수
  return `<h2>${esc(gname(g))}</h2>
    <div class="ad">${esc(short(g.ad))}</div>
    <div class="cap"><b>${num(g._cap)}</b><small>kW</small><span>${ex ? '남은 지붕 기준' : '추정 용량'}</span></div>
    <dl>
      <dt>후보 지붕</dt><dd>${num(g.a)}㎡ · ${g.n}동</dd>
      <dt>기존 태양광</dt>${ex ? `<dd class="red">${num(g.at - g.a)}㎡ · ${ex}동 제외<small>판매용(등록) ${g.sn}건 · ${num(g.skw)}kW</small></dd>` : '<dd class="off">등록 없음</dd>'}
      <dt>이용률</dt><dd>${g._cf ? num(g._cf * 100, 1) + '%' : '-'}${tip ? `<button class="tip" data-tip="${esc(tip)}" aria-label="이용률 출처">i</button>` : ''}</dd>
      <dt>연 발전량</dt><dd>${g._gen ? num(g._gen) + ' MWh' : '-'}</dd>
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
// 지역은 "도 전체"(코드가 'S:도이름') 또는 시군구 하나. 도 전체는 그 도의 시군구 자료를 모두 받아 하나로 합친다.
async function fetchRegion(code) {
  if (!cache.has(code)) {
    const [a, b] = await Promise.all(['info.json', 'bldg.geojson'].map(n => getJson(`data/${code}/${n}`)));
    cache.set(code, { a, b });
  }
  return cache.get(code);
}
async function loadRegion(code) {
  code = decodeURIComponent(code || '');
  const sidoOf = code.startsWith('S:') ? code.slice(2) : null;
  let parts = sidoOf ? regions.filter(r => r.sido === sidoOf) : regions.filter(r => r.code === code);
  if (!parts.length) return loadRegion(HOME_REGION);
  $('list').innerHTML = '<li class="msg">불러오는 중…</li>';
  const data = await Promise.all(parts.map(r => fetchRegion(r.code)));
  clearSelection();
  const all = !!sidoOf;
  region = all ? { code: 'S:' + sidoOf, sido: sidoOf, name: sidoOf, all: true, bbox: parts.reduce((b, r) => [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])], [999, 999, -999, -999]) } : parts[0];
  meta = data[0].a.meta; groups = []; byGroup.clear(); idmap.clear();
  const feats = [];
  data.forEach((d, i) => {
    const off = groups.length, r = parts[i];
    d.a.groups.forEach(g => { const n = Object.assign({}, g, { id: off + g.id, sub: all ? r.name : g.emd }); groups.push(n); idmap.set(r.code + ':' + g.id, n); });
    d.b.features.forEach(x => { const ft = { type: 'Feature', geometry: x.geometry, properties: { g: off + x.properties.g, st: x.properties.st } }; feats.push(ft); if (!byGroup.has(ft.properties.g)) byGroup.set(ft.properties.g, []); byGroup.get(ft.properties.g).push(ft); });
  });
  bldg = { type: 'FeatureCollection', features: feats };
  $('region').value = region.code;
  f.emd = '';
  $('emd').innerHTML = `<option value="">${all ? '시군구' : '읍면동'} 전체</option>` + [...new Set(groups.map(g => g.sub).filter(Boolean))].sort().map(e => `<option>${esc(e)}</option>`).join('');
  history.replaceState(null, '', '#' + encodeURIComponent(region.code)); store.set('roofpv_region', region.code);
  apply();
  map.fitBounds([[region.bbox[0], region.bbox[1]], [region.bbox[2], region.bbox[3]]], { padding: 40, duration: 0 });
}

// ===== 통합 검색 (회사·주소·지역) =====
// 색인은 시도별 파일이다. 지금 보는 시도부터 받고 나머지는 이어서 받는다. 받는 대로 검색 결과에 반영된다.
function loadIndex() {
  if (indexBusy) return indexBusy;
  const cur = region ? (regions.find(r => r.sido === region.sido) || { code: '' }).code.slice(0, 2) : '', sidos = [...new Set(regions.map(r => r.code.slice(0, 2)))].sort((a, b) => (b === cur) - (a === cur));
  indexBusy = (async () => {
    for (const s of sidos) { index = index.concat(await getJson(`data/search/${s}.json`).catch(() => [])); if (!$('hits').hidden || $('q').value.trim().length >= 2) search(); }
    indexDone = true; if ($('q').value.trim().length >= 2) search();
  })();
  return indexBusy;
}
let hits = [], act = 0;
function search() {
  const q = $('q').value.trim().toLowerCase(), box = $('hits');
  if (q.length < 2) { box.hidden = true; return; }
  loadIndex();
  const rname = c => { const r = regions.find(x => x.code === c); return r ? (r.name === r.sido ? r.sido : r.sido.replace(/특별자치도|특별자치시|광역시|특별시|통합특별시/, '') + ' ' + r.name) : ''; };
  hits = [...new Set(regions.map(r => r.sido))].filter(x => x.toLowerCase().includes(q)).slice(0, 2).map(x => ({ type: 'region', r: { code: 'S:' + x, name: x + ' 전체', sido: '도 단위로 보기', n: regions.filter(r => r.sido === x).reduce((a, r) => a + r.n, 0) } }))
    .concat(regions.filter(r => (r.sido + ' ' + r.name).toLowerCase().includes(q)).slice(0, 3).map(r => ({ type: 'region', r })));
  const starts = [], rest = [];
  for (const row of index) {
    const n = row[0].toLowerCase();
    if (n.startsWith(q)) starts.push(row); else if (n.includes(q) || row[1].toLowerCase().includes(q)) rest.push(row);
  }
  const byArea = (a, b) => b[4] - a[4];
  hits = hits.concat([...starts.sort(byArea), ...rest.sort(byArea)].slice(0, HIT_MAX).map(row => ({ type: 'co', row })));
  act = 0;
  box.innerHTML = (hits.length ? hits.map((h, i) => h.type === 'region'
    ? `<li data-i="${i}" class="${i ? '' : 'act'}"><b>${esc(h.r.name)}</b><em>지역 이동</em><small>${esc(h.r.sido)} · 회사 ${num(h.r.n)}곳</small></li>`
    : `<li data-i="${i}" class="${i ? '' : 'act'}"><b>${esc(h.row[0] || '이름 없음')}</b><em>${num(h.row[4])}㎡</em><small>${esc(rname(h.row[2]))} ${esc(h.row[1])}</small></li>`).join('')
    : `<li class="no">${indexDone ? '찾는 곳이 없습니다' : ''}</li>`) + (indexDone ? '' : '<li class="no">전국 목록을 불러오는 중…</li>');
  box.hidden = false;
}
async function pick(i) {
  const h = hits[i]; if (!h) return;
  $('hits').hidden = true; $('q').value = ''; $('q').blur();
  if (h.type === 'region') return loadRegion(h.r.code);
  const key = h.row[2] + ':' + h.row[3];
  if (!idmap.has(key)) await loadRegion(h.row[2]);      // 지금 보는 지역에 없으면 그 시군구로 이동
  if (idmap.has(key)) select(idmap.get(key));
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
    const sidos = [...new Set(regions.map(r => r.sido))];
    $('region').innerHTML = sidos.map(s => `<optgroup label="${esc(s)}"><option value="S:${esc(s)}">${esc(s)} 전체</option>` + regions.filter(r => r.sido === s && r.name !== s).map(r => `<option value="${r.code}">${esc(r.name)}</option>`).join('') + '</optgroup>').join('');
    bind();
    await loadRegion(location.hash.slice(1) || store.get('roofpv_region') || HOME_REGION);
    if (map.loaded()) addLayers();
  } catch (e) {
    $('list').innerHTML = `<li class="msg">자료를 불러오지 못했습니다: ${esc(e.message)}</li>`;
  }
})();
