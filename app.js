// ===== 설정 =====
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';   // 배경지도용(도메인 제한 키)
const DATA = { info: 'data/jincheon.json', bldg: 'data/jincheon_bldg.geojson', solar: 'data/jincheon_solar.geojson' };
const LIST_MAX = 300;   // 목록에 한 번에 그리는 개수

// ===== 상태 =====
let meta = {}, groups = [], bldg = null, solar = null;
const byGroup = new Map();   // 묶음 번호 -> 건물 목록
let view = [], selected = null, base = 'base';
const f = { q: '', emd: '', sol: 'exclude', minC: 0, util: 0.5, kw: 0.10 };

const $ = id => document.getElementById(id);
const num = (v, d = 0) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gname = g => g.nm || '이름 없음';
const gaddr = g => g.road || g.jibun || ('충청북도 진천군 ' + g.emd);
const short = a => a.replace(/^충청북도\s*진천군\s*/, '').replace(/^충북\s*진천군\s*/, '');

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
const map = new maplibregl.Map({ container: 'map', style: style('base'), center: [127.44, 36.87], zoom: 10.5, minZoom: 8, maxZoom: 19 });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

const COLOR = ['match', ['get', 'st'], 'on', '#d92d20', 'near', '#f79009', '#0b7a6b'];
const LINE = ['match', ['get', 'st'], 'on', '#7a271a', 'near', '#93370d', '#04443b'];   // 경계선용 짙은 색
function addLayers() {
  if (!bldg || map.getSource('b')) return;
  const sat = base === 'sat';
  map.addSource('b', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'b-fill', type: 'fill', source: 'b', paint: { 'fill-color': COLOR, 'fill-opacity': sat ? 0.22 : 0.4 } });
  // 건물 경계선: 일반지도에서는 짙은 색 굵은 선, 항공사진에서는 흰 선
  map.addLayer({ id: 'b-line', type: 'line', source: 'b', layout: { 'line-join': 'round' },
    paint: { 'line-color': sat ? '#ffffff' : LINE, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1.6, 17, 2.4] } });
  map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#fdb022', 'line-width': 3.5 } });
  map.addSource('s', { type: 'geojson', data: solar });
  map.addLayer({ id: 's-pt', type: 'circle', source: 's', minzoom: 12,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 6], 'circle-color': '#101828', 'circle-stroke-color': '#fdb022', 'circle-stroke-width': 1.5 } });
  drawMap();
}
map.on('load', addLayers);
map.on('click', 'b-fill', e => { const g = groups[e.features[0].properties.g]; if (g) select(g, false); });
map.on('click', 's-pt', e => {
  const p = e.features[0].properties;
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat)
    .setHTML(`<b>${esc(p.nm)}</b><br>${num(p.kw, 1)} kW · ${esc(p.yr)}년<br><span style="color:#667085">${esc(p.ad)}</span>`).addTo(map);
});
['b-fill', 's-pt'].forEach(l => { map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer'); map.on('mouseleave', l, () => map.getCanvas().style.cursor = ''); });

function drawMap() {
  if (!map.getSource('b')) return;
  const ok = new Set(view.map(g => g.id));
  map.getSource('b').setData({ type: 'FeatureCollection', features: bldg.features.filter(x => ok.has(x.properties.g)) });
  map.getSource('sel').setData({ type: 'FeatureCollection', features: selected ? byGroup.get(selected.id) : [] });
}

// ===== 계산과 조건 =====
function calc(g) {
  g._cap = g.a * f.util * f.kw;                   // 추정 설비용량 kW
  g._cf = g.ey ? g.ey / 8760 : null;              // 이용률
  g._gen = g.ey ? g._cap * g.ey / 1000 : null;    // 연간 발전량 MWh
}
function apply() {
  const q = f.q.trim().toLowerCase();
  groups.forEach(calc);
  view = groups.filter(g => {
    if (f.emd && g.emd !== f.emd) return false;
    if (f.sol === 'exclude' && g.solst !== 'none') return false;
    if (f.sol === 'only' && g.solst === 'none') return false;
    if (g._cap < f.minC) return false;
    if (q && !(gname(g) + ' ' + g.road + ' ' + g.jibun).toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => b._cap - a._cap);
  $('sN').textContent = num(view.length);
  $('sCap').textContent = num(view.reduce((s, g) => s + g._cap, 0) / 1000, 1);
  $('sGen').textContent = num(view.reduce((s, g) => s + (g._gen || 0), 0) / 1000, 1);
  $('basisNow').textContent = `${Math.round(f.util * 100)}% · ${f.kw.toFixed(2)}kW/㎡` + (f.minC ? ` · ${num(f.minC)}kW 이상` : '');
  drawList(); drawMap();
  if (selected) showDetail(selected);
}
function drawList() {
  const max = view.length ? view[0]._cap : 1;
  const tag = g => g.solst === 'on' ? '<span class="tag on">기존 태양광</span>' : g.solst === 'near' ? '<span class="tag near">근처 태양광</span>' : '';
  $('list').innerHTML = view.slice(0, LIST_MAX).map((g, i) => `
    <li data-id="${g.id}" class="${g.solst}${selected && selected.id === g.id ? ' sel' : ''}">
      <span class="rk">${i + 1}</span>
      <span class="nm">${esc(gname(g))}${tag(g)}</span>
      <span class="cap">${num(g._cap)}<small>kW</small></span>
      <span class="ad">${esc(short(gaddr(g)))}</span>
      <span class="ar">${num(g.a)}㎡ · ${g.n}동</span>
      <span class="bar"><i style="width:${Math.max(2, g._cap / max * 100).toFixed(1)}%"></i></span>
    </li>`).join('')
    + (view.length > LIST_MAX ? `<li class="msg">용량 큰 순으로 ${LIST_MAX}곳까지 표시 (전체 ${num(view.length)}곳)</li>` : '')
    + (view.length ? '' : '<li class="msg">조건에 맞는 곳이 없습니다</li>');
}
$('list').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) select(groups[+li.dataset.id], true); });

// ===== 상세 카드 =====
function select(g, fly) {
  selected = g; calc(g);
  if (fly) {
    const pts = byGroup.get(g.id).flatMap(x => x.geometry.coordinates[0]);
    const b = pts.reduce((r, p) => [Math.min(r[0], p[0]), Math.min(r[1], p[1]), Math.max(r[2], p[0]), Math.max(r[3], p[1])], [999, 999, -999, -999]);
    const mobile = innerWidth <= 760;
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: mobile ? { top: 60, left: 30, right: 30, bottom: 330 } : { top: 80, left: 80, bottom: 80, right: 380 }, maxZoom: 17.5, duration: 600 });
    if (mobile) $('side').classList.add('hide');
  }
  showDetail(g); drawMap();
  document.querySelectorAll('#list li[data-id]').forEach(li => li.classList.toggle('sel', +li.dataset.id === g.id));
}
function showDetail(g) {
  const sol = g.sol.length
    ? `<h3>기존 태양광 ${g.sol.length}건 · ${num(g.solkw, 1)} kW</h3><ul>` + g.sol.map(s =>
        `<li><b>${esc(s.nm)}</b> ${num(s.kw, 1)} kW, ${esc(s.yr)}년 (${s.how === 'on' ? '좌표가 지붕 위' : '좌표가 50m 안'})</li>`).join('') + '</ul>'
    : '<h3>기존 태양광</h3><p>공개 목록에서 찾지 못했습니다. 자가용 설비는 목록에 없을 수 있어 항공사진 확인이 필요합니다.</p>';
  $('detail').innerHTML = `
    <button class="x" aria-label="닫기">×</button>
    <h2>${esc(gname(g))}</h2>
    <div class="ad">${esc(gaddr(g))}</div>
    <div class="hero"><span>추정 설비용량</span><b>${num(g._cap)}<small>kW</small></b></div>
    <div class="kv">
      <div><span>지붕 면적</span><b>${num(g.a)} ㎡</b></div>
      <div><span>건물</span><b>${g.n}동</b></div>
      <div><span>이용률</span><b>${g._cf ? num(g._cf * 100, 1) + ' %' : '확인 필요'}</b></div>
      <div><span>연간 발전량</span><b>${g._gen ? num(g._gen) + ' MWh' : '확인 필요'}</b></div>
    </div>
    <h3>이용률 출처</h3>
    <p>${g.ey ? `PVGIS 5.3 (PVGIS-ERA5 기상자료, 2005~2023년 평균). 이 위치의 연간 발전량 ${num(g.ey)} kWh/kW를 8,760시간으로 나눈 값입니다. 경사 ${meta.pv_tilt}도, 정남향, 손실 ${meta.pv_loss}%를 가정했습니다.` : '이 위치의 값을 받지 못했습니다.'}</p>
    ${sol}
    <p class="warn">회사 이름은 지도 표기라 실제 소유자와 다를 수 있습니다. 용량은 추정치이며 지붕 하중, 그늘, 옥상 설비는 반영되지 않았습니다.</p>`;
  $('detail').hidden = false;
  $('detail').querySelector('.x').onclick = () => { $('detail').hidden = true; selected = null; drawMap(); drawList(); };
}

// ===== 조작 =====
function bind() {
  $('q').oninput = e => { f.q = e.target.value; apply(); };
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
    const [a, b, s] = await Promise.all(Object.values(DATA).map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); })));
    meta = a.meta; groups = a.groups; bldg = b; solar = s;
    bldg.features.forEach(x => { const g = x.properties.g; x.properties.st = groups[g].solst; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(x); });
    [...new Set(groups.map(g => g.emd))].sort().forEach(e => $('emd').insertAdjacentHTML('beforeend', `<option>${esc(e)}</option>`));
    bind(); apply();
    const cs = groups.map(g => g.c), bb = [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))];
    map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 30, duration: 0 });   // 처음 화면을 자료 범위에 맞춤
    if (map.loaded()) addLayers();
  } catch (e) {
    $('list').innerHTML = `<li class="msg">자료를 불러오지 못했습니다: ${esc(e.message)}</li>`;
  }
})();
