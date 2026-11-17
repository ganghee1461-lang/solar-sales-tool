// ===== 설정 =====
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';   // 배경지도용(도메인 제한 키)
const DATA = { info: 'data/jincheon.json', bldg: 'data/jincheon_bldg.geojson', solar: 'data/jincheon_solar.geojson' };
const LIST_MAX = 300;                       // 목록에 한 번에 그리는 개수
const DEFAULT_USES = ['BDS015', 'BDS016'];  // 처음에 켜 두는 용도: 공장, 창고시설

// ===== 상태 =====
let meta = {}, groups = [], bldg = null, solar = null;
let byGroup = new Map();                    // 묶음 번호 -> 건물 목록
let view = [];                              // 조건을 통과한 묶음
let selected = null, tab = 'all', base = 'base';
const f = { q: '', emd: '', sol: 'exclude', uses: new Set(DEFAULT_USES), minA: 500, minC: 0, util: 0.5, kw: 0.10 };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let bm = store.get('roofpv_bm'), memo = store.get('roofpv_memo');

const $ = id => document.getElementById(id);
const num = (v, d = 0) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2000); }
const gkey = g => g.c.join(',');            // 관심·메모 저장용 열쇠(대표 건물 좌표)
const gname = g => g.nm || '이름 없음';
const gaddr = g => g.road || g.jibun || ('진천군 ' + g.emd);

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
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), 'bottom-right');

const COLOR = ['match', ['get', 'st'], 'on', '#d92d20', 'near', '#f79009', '#2f6fed'];
function addLayers() {
  if (!bldg || map.getSource('b')) return;
  map.addSource('b', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'b-fill', type: 'fill', source: 'b', paint: { 'fill-color': COLOR, 'fill-opacity': base === 'sat' ? 0.3 : 0.5 } });
  map.addLayer({ id: 'b-line', type: 'line', source: 'b', paint: { 'line-color': COLOR, 'line-width': 1.2 } });
  map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#ffd60a', 'line-width': 4 } });
  map.addSource('s', { type: 'geojson', data: solar });
  map.addLayer({ id: 's-pt', type: 'circle', source: 's', minzoom: 11,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 6], 'circle-color': '#111', 'circle-stroke-color': '#ffd60a', 'circle-stroke-width': 1.5 },
    layout: { visibility: $('showSolar').checked ? 'visible' : 'none' } });
  drawMap();
}
map.on('load', addLayers);
map.on('click', 'b-fill', e => { const g = groups[e.features[0].properties.g]; if (g) select(g, false); });
map.on('click', 's-pt', e => {
  const p = e.features[0].properties;
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat)
    .setHTML(`<b>${esc(p.nm)}</b><br>${num(p.kw, 1)} kW · ${esc(p.yr)}년<br><span style="color:#667085">${esc(p.ad)}<br>위치 출처: ${esc(p.src)}</span>`).addTo(map);
});
['b-fill', 's-pt'].forEach(l => { map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer'); map.on('mouseleave', l, () => map.getCanvas().style.cursor = ''); });

function drawMap() {
  if (!map.getSource('b')) return;
  const ok = new Set(view.map(g => g.id));
  map.getSource('b').setData({ type: 'FeatureCollection', features: bldg.features.filter(x => ok.has(x.properties.g) && x.properties.a >= f.minA) });
  map.getSource('sel').setData({ type: 'FeatureCollection', features: selected ? byGroup.get(selected.id) : [] });
}

// ===== 계산과 조건 =====
function calc(g) {
  const bs = byGroup.get(g.id).filter(x => x.properties.a >= f.minA);
  g._n = bs.length; g._a = bs.reduce((s, x) => s + x.properties.a, 0);
  g._cap = g._a * f.util * f.kw;                       // kW
  g._cf = g.ey ? g.ey / 8760 : null;                   // 이용률
  g._gen = g.ey ? g._cap * g.ey / 1000 : null;         // 연간 발전량 MWh
}
function apply() {
  const q = f.q.trim().toLowerCase();
  groups.forEach(calc);
  view = groups.filter(g => {
    if (!g._n) return false;
    if (tab === 'bm' && !bm[gkey(g)]) return false;
    if (!f.uses.has(g.use)) return false;
    if (f.emd && g.emd !== f.emd) return false;
    if (f.sol === 'exclude' && g.solst !== 'none') return false;
    if (f.sol === 'only' && g.solst === 'none') return false;
    if (g._cap < f.minC) return false;
    if (q && !(gname(g) + ' ' + g.road + ' ' + g.jibun).toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => b._cap - a._cap);
  $('sumGroups').textContent = num(view.length);
  $('sumArea').textContent = num(view.reduce((s, g) => s + g._a, 0));
  $('sumCap').textContent = num(view.reduce((s, g) => s + g._cap, 0) / 1000, 1);
  $('cntAll').textContent = tab === 'all' ? num(view.length) : '';
  $('cntBm').textContent = num(Object.keys(bm).length);
  drawList(); drawMap();
  if (selected) showDetail(selected);
}
function drawList() {
  const tagOf = g => g.solst === 'on' ? '<span class="tag on">태양광 있음</span>' : g.solst === 'near' ? '<span class="tag near">근처 태양광</span>' : '';
  $('list').innerHTML = view.slice(0, LIST_MAX).map(g => `
    <li data-id="${g.id}" class="${selected && selected.id === g.id ? 'sel' : ''}">
      <div class="t"><span class="nm">${bm[gkey(g)] ? '★ ' : ''}${esc(gname(g))}</span><span class="cap">${num(g._cap)} kW</span></div>
      <div class="m"><span>${esc(g.emd)}</span><span>${g._n}동 · ${num(g._a)}㎡</span><span>${esc(meta.serv[g.use] || '')}</span>${tagOf(g)}</div>
    </li>`).join('') + (view.length > LIST_MAX ? `<li class="more">상위 ${LIST_MAX}곳만 표시 (전체 ${num(view.length)}곳, 엑셀에는 전부 포함)</li>` : '')
    + (view.length ? '' : '<li class="more">조건에 맞는 곳이 없습니다</li>');
}
$('list').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) select(groups[+li.dataset.id], true); });

// ===== 상세 =====
function select(g, fly) {
  selected = g; calc(g);
  if (fly) {
    const pts = byGroup.get(g.id).flatMap(x => x.geometry.coordinates[0]);
    const b = pts.reduce((r, p) => [Math.min(r[0], p[0]), Math.min(r[1], p[1]), Math.max(r[2], p[0]), Math.max(r[3], p[1])], [999, 999, -999, -999]);
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 90, maxZoom: 17.5, duration: 600 });
    if (innerWidth <= 760) $('side').classList.add('hide');
  }
  showDetail(g); drawMap();
  document.querySelectorAll('#list li').forEach(li => li.classList.toggle('sel', +li.dataset.id === g.id));
}
function showDetail(g) {
  const k = gkey(g), all = byGroup.get(g.id);
  const uses = Object.entries(g.uses).sort((a, b) => b[1] - a[1]).map(([u, a]) => `${esc(meta.serv[u] || u)} ${num(a)}㎡`).join(', ');
  const sol = g.sol.length ? `<h3>기존 태양광 (표준데이터 ${g.sol.length}건, 합계 ${num(g.solkw, 1)} kW)</h3><ul>` + g.sol.map(s =>
    `<li>${esc(s.nm)} · ${num(s.kw, 1)} kW · ${esc(s.yr)}년 · ${s.how === 'on' ? '좌표가 지붕 위' : '좌표가 50m 안'}</li>`).join('') + '</ul>'
    : '<h3>기존 태양광</h3><div class="note">표준데이터에서 이 건물과 겹치는 시설을 찾지 못했습니다. 자가용 설비는 목록에 없을 수 있으니 항공사진으로 한 번 더 확인하세요.</div>';
  $('detail').innerHTML = `
    <button class="x" aria-label="닫기">×</button>
    <h2>${esc(gname(g))}</h2>
    <div class="ad">${esc(gaddr(g))}</div>
    <table>
      <tr><td>건물</td><td>${g._n}동 (${num(f.minA)}㎡ 이상)${all.length !== g._n ? ' / 전체 ' + all.length + '동' : ''}</td></tr>
      <tr><td>지붕 면적</td><td>${num(g._a)} ㎡</td></tr>
      <tr><td>설치 가능 면적</td><td>${num(g._a * f.util)} ㎡</td></tr>
      <tr class="big"><td>추정 설비용량</td><td>${num(g._cap)} kW</td></tr>
      <tr><td>이용률</td><td>${g._cf ? num(g._cf * 100, 1) + ' %' : '확인 필요'}</td></tr>
      <tr><td>연간 발전량</td><td>${g._gen ? num(g._gen) + ' MWh' : '확인 필요'}</td></tr>
      <tr><td>하루 평균 발전시간</td><td>${g.ey ? num(g.ey / 365, 2) + ' 시간' : '확인 필요'}</td></tr>
    </table>
    <div class="note">용도: ${uses}</div>
    ${sol}
    <div class="acts">
      <button id="dBm" class="${bm[k] ? 'on' : ''}">★ 관심</button>
      <a target="_blank" rel="noopener" href="https://map.kakao.com/link/map/${encodeURIComponent(gname(g))},${g.c[1]},${g.c[0]}">카카오맵</a>
      <a target="_blank" rel="noopener" href="https://map.kakao.com/link/roadview/${g.c[1]},${g.c[0]}">로드뷰</a>
    </div>
    <textarea id="dMemo" placeholder="메모 (이 기기에만 저장)">${esc(memo[k] || '')}</textarea>
    <div class="note">회사 이름은 지도 표기에서 가져온 것이라 실제 소유자와 다를 수 있습니다. 용량은 추정치이며 지붕 하중, 그늘, 옥상 설비는 반영되지 않았습니다.</div>`;
  $('detail').hidden = false;
  $('detail').querySelector('.x').onclick = () => { $('detail').hidden = true; selected = null; drawMap(); drawList(); };
  $('dBm').onclick = () => { if (bm[k]) delete bm[k]; else bm[k] = 1; store.set('roofpv_bm', bm); toast(bm[k] ? '관심 목록에 추가' : '관심 해제'); apply(); };
  $('dMemo').oninput = e => { if (e.target.value) memo[k] = e.target.value; else delete memo[k]; store.set('roofpv_memo', memo); };
}

// ===== 엑셀 =====
$('btnXlsx').onclick = () => {
  if (!view.length) return toast('내보낼 목록이 없습니다');
  const rows = view.map((g, i) => ({
    '순위': i + 1, '회사(지도 표기)': gname(g), '읍면': g.emd, '도로명주소': g.road, '지번주소': g.jibun, '주용도': meta.serv[g.use] || g.use,
    '동수': g._n, '지붕면적(㎡)': Math.round(g._a), '설치가능면적(㎡)': Math.round(g._a * f.util), '추정설비용량(kW)': Math.round(g._cap),
    '이용률(%)': g._cf ? +(g._cf * 100).toFixed(1) : '', '연간발전량(MWh)': g._gen ? Math.round(g._gen) : '',
    '기존태양광': g.solst === 'on' ? '있음(좌표가 지붕 위)' : g.solst === 'near' ? '근처(50m 안)' : '목록에 없음', '기존태양광용량(kW)': g.solkw || '',
    '관심': bm[gkey(g)] ? 'Y' : '', '메모': memo[gkey(g)] || '', '위도': g.c[1], '경도': g.c[0]
  }));
  const info = [['지역', meta.region], ['만든 날', meta.built], ['건물 자료', meta.bldg_src], ['태양광 자료', meta.solar_src], ['이용률 자료', meta.pv_src],
    ['동 최소 면적(㎡)', f.minA], ['설치 가능 비율', f.util], ['㎡당 설비용량(kW)', f.kw], ['행 수', rows.length],
    ['지붕면적 합계(㎡)', Math.round(view.reduce((s, g) => s + g._a, 0))], ['추정용량 합계(kW)', Math.round(view.reduce((s, g) => s + g._cap, 0))]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '후보');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), '기준');
  XLSX.writeFile(wb, `지붕태양광_진천_${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast(rows.length + '곳 저장');
};

// ===== 조작 =====
function bind() {
  $('q').oninput = e => { f.q = e.target.value; apply(); };
  $('emd').onchange = e => { f.emd = e.target.value; apply(); };
  $('solMode').onchange = e => { f.sol = e.target.value; apply(); };
  const sl = (id, out, set, fmt) => { $(id).oninput = e => { set(+e.target.value); $(out).textContent = fmt(+e.target.value); apply(); }; };
  sl('minA', 'vMinA', v => f.minA = v, v => num(v) + '㎡');
  sl('minC', 'vMinC', v => f.minC = v, v => num(v) + 'kW');
  sl('util', 'vUtil', v => f.util = v / 100, v => v + '%');
  sl('kw', 'vKw', v => f.kw = v / 100, v => (v / 100).toFixed(2) + 'kW');
  document.querySelectorAll('#tabs button[data-tab]').forEach(b => b.onclick = () => {
    tab = b.dataset.tab; document.querySelectorAll('#tabs button[data-tab]').forEach(x => x.classList.toggle('on', x === b)); apply();
  });
  document.querySelectorAll('#mapctl button').forEach(b => b.onclick = () => {
    base = b.dataset.base; document.querySelectorAll('#mapctl button').forEach(x => x.classList.toggle('on', x === b));
    map.setStyle(style(base)); map.once('styledata', () => setTimeout(addLayers, 0));
  });
  $('showSolar').onchange = e => map.getLayer('s-pt') && map.setLayoutProperty('s-pt', 'visibility', e.target.checked ? 'visible' : 'none');
  $('toggleSide').onclick = () => $('side').classList.toggle('hide');
}

// ===== 시작 =====
(async function start() {
  try {
    const [a, b, s] = await Promise.all(Object.values(DATA).map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); })));
    meta = a.meta; groups = a.groups; bldg = b; solar = s;
    bldg.features.forEach(x => { const g = x.properties.g; x.properties.st = groups[g].solst; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(x); });
    $('region').textContent = `${meta.region} · 건물 ${num(meta.n_bldg)}동 · 자료 ${meta.built}`;
    [...new Set(groups.map(g => g.emd))].sort().forEach(e => $('emd').insertAdjacentHTML('beforeend', `<option>${esc(e)}</option>`));
    const useArea = {}; groups.forEach(g => useArea[g.use] = (useArea[g.use] || 0) + g.a);
    $('uses').innerHTML = Object.keys(useArea).sort((x, y) => useArea[y] - useArea[x]).map(u =>
      `<button data-u="${u}" class="${f.uses.has(u) ? 'on' : ''}">${esc(meta.serv[u] || u)}</button>`).join('');
    $('uses').onclick = e => { const u = e.target.dataset.u; if (!u) return; f.uses.has(u) ? f.uses.delete(u) : f.uses.add(u); e.target.classList.toggle('on'); apply(); };
    $('src').innerHTML = `건물: ${esc(meta.bldg_src)}<br>기존 태양광: ${esc(meta.solar_src)}<br>이용률: ${esc(meta.pv_src)}`;
    bind(); apply();
    const cs = groups.map(g => g.c), bb = [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))];
    map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 30, duration: 0 });   // 처음 화면을 자료 범위에 맞춤
    if (map.loaded()) addLayers();
  } catch (e) {
    $('region').textContent = '자료를 불러오지 못했습니다: ' + e.message;
  }
})();
