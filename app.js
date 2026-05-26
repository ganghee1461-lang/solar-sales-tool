// v2
// ============ 설정 ============
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';
const BUILDINGS_URL = 'https://pub-9f412c718f774c63833a747a845a8a5c.r2.dev/buildings.geojson';
const SOLAR_API = '/solar';
const PARKING_API = '/parking';
const MIN_AREA = 3000;

// ============ 전역 상태 ============
let allBuildings = null;
let filteredBuildings = [];
let allParkings = [];
let filteredParkings = [];
let bookmarks = JSON.parse(localStorage.getItem('bookmarks_v2') || '{}');
let memos = JSON.parse(localStorage.getItem('memos_v2') || '{}');
let names = JSON.parse(localStorage.getItem('names_v2') || '{}');
let currentKey = null;
let currentTab = 'building';
let sortDesc = true;
let parkingLoaded = false;
let currentAddrTarget = null;

let filters = {
  sido: '',
  minCapacity: 100,
  utilization: 0.5,
  kwPerSqm: 0.1,
};

const SIDO_CENTERS = {
  '서울': [126.978, 37.566, 11], '부산': [129.075, 35.179, 11],
  '대구': [128.601, 35.871, 11], '인천': [126.705, 37.456, 11],
  '광주': [126.852, 35.160, 11], '대전': [127.385, 36.350, 11],
  '울산': [129.311, 35.539, 11], '세종': [127.288, 36.480, 11],
  '경기': [127.108, 37.412, 9], '강원특별자치도': [128.155, 37.821, 8],
  '충북': [127.490, 36.628, 9], '충남': [126.800, 36.658, 9],
  '전북특별자치도': [127.108, 35.716, 9], '전남': [126.991, 34.819, 9],
  '경북': [128.890, 36.248, 8], '경남': [128.213, 35.460, 9],
  '제주': [126.500, 33.400, 10],
};

// ============ 좌표 키 (안정적인 식별자) ============
function getKey(item) {
  if (item.properties) {
    const c = item.properties._center;
    return Array.isArray(c) ? c.join(',') : c;
  }
  return `p_${item.no}`; // 주차장
}

// ============ 지도 ============
const baseMapStyle = {
  version: 8,
  sources: {
    'vworld-base': {
      type: 'raster',
      tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Base/{z}/{y}/{x}.png`],
      tileSize: 256,
    }
  },
  layers: [{ id: 'base', type: 'raster', source: 'vworld-base' }]
};

const satelliteStyle = {
  version: 8,
  sources: {
    'vworld-sat': {
      type: 'raster',
      tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Satellite/{z}/{y}/{x}.jpeg`],
      tileSize: 256,
    },
    'vworld-hybrid': {
      type: 'raster',
      tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Hybrid/{z}/{y}/{x}.png`],
      tileSize: 256,
    }
  },
  layers: [
    { id: 'sat', type: 'raster', source: 'vworld-sat' },
    { id: 'hybrid', type: 'raster', source: 'vworld-hybrid' }
  ]
};

const map = new maplibregl.Map({
  container: 'map',
  style: baseMapStyle,
  center: [127.7669, 35.9078],
  zoom: 7,
  maxZoom: 18,
  minZoom: 6,
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

// ============ UI 헬퍼 ============
function toast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function setLoading(text) {
  const el = document.getElementById('loading');
  if (text) {
    document.getElementById('loadingText').textContent = text;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ============ 건물 로드 ============
async function loadBuildings() {
  setLoading('건물 데이터 로드 중...');
  try {
    const res = await fetch(BUILDINGS_URL);
    const data = await res.json();

    const sidoSet = new Set();
    data.features.forEach((f, i) => {
      f.id = i;
      const bbox = turf.bbox(f);
      f.properties._center = [(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2];
      f.properties.capacity = (f.properties.area * filters.utilization * filters.kwPerSqm);
      const sido = f.properties.sido || guessSido(f.properties._center);
      f.properties.sido = sido;
      if (sido) sidoSet.add(sido);
    });

    allBuildings = data;
    populateSidoFilter([...sidoSet].sort());
    setupMapLayers();
    applyFilters();
    setLoading(null);
    toast(`${data.features.length.toLocaleString()}개 건물 로드 완료`);
  } catch (e) {
    setLoading(null);
    toast('데이터 로드 실패: ' + e.message, 4000);
  }
}

function guessSido(coord) {
  const [lng, lat] = coord;
  if (lng >= 126.74 && lng <= 127.18 && lat >= 37.41 && lat <= 37.71) return '서울';
  if (lng >= 128.78 && lng <= 129.30 && lat >= 35.04 && lat <= 35.39) return '부산';
  if (lng >= 128.45 && lng <= 128.76 && lat >= 35.78 && lat <= 36.01) return '대구';
  if (lng >= 126.36 && lng <= 126.78 && lat >= 37.30 && lat <= 37.61) return '인천';
  if (lng >= 126.65 && lng <= 127.00 && lat >= 35.08 && lat <= 35.26) return '광주';
  if (lng >= 127.27 && lng <= 127.55 && lat >= 36.18 && lat <= 36.49) return '대전';
  if (lng >= 129.06 && lng <= 129.49 && lat >= 35.43 && lat <= 35.71) return '울산';
  if (lng >= 127.18 && lng <= 127.41 && lat >= 36.44 && lat <= 36.69) return '세종';
  if (lng >= 126.30 && lng <= 127.85 && lat >= 36.86 && lat <= 38.62) return '강원특별자치도';
  if (lng >= 126.37 && lng <= 127.97 && lat >= 36.90 && lat <= 38.30) return '경기';
  if (lng >= 127.43 && lng <= 128.65 && lat >= 36.00 && lat <= 37.25) return '충북';
  if (lng >= 125.99 && lng <= 127.65 && lat >= 35.95 && lat <= 37.07) return '충남';
  if (lng >= 126.30 && lng <= 127.90 && lat >= 35.30 && lat <= 36.10) return '전북특별자치도';
  if (lng >= 125.82 && lng <= 127.92 && lat >= 33.95 && lat <= 35.50) return '전남';
  if (lng >= 127.80 && lng <= 130.00 && lat >= 35.50 && lat <= 37.20) return '경북';
  if (lng >= 127.50 && lng <= 129.40 && lat >= 34.50 && lat <= 35.95) return '경남';
  if (lng >= 126.10 && lng <= 126.99 && lat >= 33.10 && lat <= 33.60) return '제주';
  return null;
}

function populateSidoFilter(sidos) {
  const sel = document.getElementById('sidoFilter');
  sidos.forEach(s => {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s.replace('특별자치도', '');
    sel.appendChild(o);
  });
}

// ============ 지도 레이어 ============
function setupMapLayers() {
  map.addSource('buildings', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'buildings-fill',
    type: 'fill',
    source: 'buildings',
    paint: {
      'fill-color': [
        'case',
        ['get', 'installed'], '#ff3b30',
        ['==', ['get', 'KIND'], 'BDK005'], '#34c759',
        '#007aff'
      ],
      'fill-opacity': 0.25,
    }
  });

  map.addLayer({
    id: 'buildings-line',
    type: 'line',
    source: 'buildings',
    paint: {
      'line-color': [
        'case',
        ['get', 'installed'], '#ff3b30',
        ['==', ['get', 'KIND'], 'BDK005'], '#34c759',
        '#007aff'
      ],
      'line-width': 1,
      'line-opacity': 0.5,
    }
  });

  map.addSource('selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'selected-outline',
    type: 'line',
    source: 'selected',
    paint: { 'line-color': '#ffd60a', 'line-width': 4 }
  });

  map.addSource('parking', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'parking-fill',
    type: 'fill',
    source: 'parking',
    paint: { 'fill-color': '#ffcc00', 'fill-opacity': 0.35 }
  });
  map.addLayer({
    id: 'parking-line',
    type: 'line',
    source: 'parking',
    paint: { 'line-color': '#b25e00', 'line-width': 1.5 }
  });

  // 건물 클릭
  map.on('click', 'buildings-fill', e => {
    if (!e.features.length) return;
    const clicked = e.features.reduce((max, f) =>
      f.properties.area > max.properties.area ? f : max, e.features[0]);
    const center = clicked.properties._center;
    const original = allBuildings.features.find(f =>
      f.properties._center === center ||
      JSON.stringify(f.properties._center) === center
    );
    openBuildingPopup(original || clicked, e.lngLat);
  });

  // 주차장 클릭
  map.on('click', 'parking-fill', e => {
    if (!e.features.length) return;
    const f = e.features[0];
    const parking = allParkings.find(p => p.no === f.properties.no);
    if (parking) openParkingPopup(parking, e.lngLat);
  });

  map.on('mouseenter', 'buildings-fill', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'buildings-fill', () => map.getCanvas().style.cursor = '');
  map.on('mouseenter', 'parking-fill', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'parking-fill', () => map.getCanvas().style.cursor = '');
}

// ============ 필터링 ============
function applyFilters() {
  if (!allBuildings) return;

  filteredBuildings = allBuildings.features.filter(f => {
    const p = f.properties;
    p.capacity = (p.area * filters.utilization * filters.kwPerSqm);
    if (p.area < MIN_AREA) return false;
    if (filters.sido && p.sido !== filters.sido) return false;
    if (p.capacity < filters.minCapacity) return false;
    return true;
  });

  map.getSource('buildings').setData({
    type: 'FeatureCollection',
    features: filteredBuildings,
  });

  if (currentTab === 'building' || currentTab === 'bookmark') renderResultsList();
  updateCounts();
}

function updateCounts() {
  document.getElementById('bldgCount').textContent = filteredBuildings.length.toLocaleString();
  document.getElementById('prkCount').textContent = filteredParkings.length.toLocaleString();
  document.getElementById('bmCount').textContent = Object.keys(bookmarks).length.toLocaleString();
}
// ============ 결과 리스트 ============
function renderResultsList() {
  const list = document.getElementById('resultsList');
  let items = [];

  if (currentTab === 'building') {
    items = [...filteredBuildings];
  } else if (currentTab === 'parking') {
    items = [...filteredParkings];
  } else if (currentTab === 'bookmark') {
    const bmKeys = Object.keys(bookmarks);
    items = [
      ...(allBuildings?.features.filter(f => bmKeys.includes(getKey(f))) || []),
      ...allParkings.filter(p => bmKeys.includes(getKey(p)))
    ];
  }

  // 정렬
  items.sort((a, b) => {
    const va = a.properties ? a.properties.capacity : (a.count || 0);
    const vb = b.properties ? b.properties.capacity : (b.count || 0);
    return sortDesc ? vb - va : va - vb;
  });

  const top = items.slice(0, 200);
  list.innerHTML = top.map(item => renderResultItem(item)).join('');
  attachResultListeners();
}

function renderResultItem(item) {
  const key = getKey(item);
  const isBldg = !!item.properties;
  const isBookmarked = bookmarks[key];
  const name = names[key] || '';

  if (isBldg) {
    const p = item.properties;
    const kindLabel = p.KIND === 'BDK005' ? '무벽/축사' : '공장/창고';
    const kindClass = p.installed ? 'installed' : (p.KIND === 'BDK005' ? 'bdk005' : '');
    return `
      <div class="result-item ${currentKey === key ? 'active' : ''}" data-key="${key}" data-type="building">
        <div class="result-name">
          <span class="star ${isBookmarked ? 'active' : ''}" data-action="bookmark">★</span>
          <input type="text" placeholder="수요처명 입력..." value="${escapeHtml(name)}" data-action="name">
          <button class="addr-btn" data-action="addr">주소</button>
        </div>
        <div class="result-row1">
          <span class="result-capacity">${p.capacity.toFixed(1)} kW</span>
          <span class="result-kind ${kindClass}">${p.installed ? '기설치' : kindLabel}</span>
        </div>
        <div class="result-area">${p.area.toLocaleString(undefined, {maximumFractionDigits:0})} ㎡</div>
        <div class="result-sido">${p.sido || '미분류'}</div>
      </div>
    `;
  } else {
    const installed = item.installed;
    return `
      <div class="result-item ${currentKey === key ? 'active' : ''}" data-key="${key}" data-type="parking">
        <div class="result-name">
          <span class="star ${isBookmarked ? 'active' : ''}" data-action="bookmark">★</span>
          <input type="text" placeholder="${escapeHtml(item.name)}" value="${escapeHtml(name)}" data-action="name">
        </div>
        <div class="result-row1">
          <span class="result-capacity">${item.count}면</span>
          <span class="result-kind parking ${installed ? 'installed' : ''}">${installed ? '기설치' : '주차장'}</span>
        </div>
        <div class="result-area">${item.roadAddr || item.lotAddr || ''}</div>
      </div>
    `;
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function attachResultListeners() {
  document.querySelectorAll('.result-item').forEach(el => {
    const key = el.dataset.key;
    const type = el.dataset.type;

    el.addEventListener('click', e => {
      if (e.target.dataset.action) return;
      const item = findItemByKey(key, type);
      if (item) {
        flyToItem(item);
        if (type === 'building') openBuildingPopup(item, { lng: item.properties._center[0], lat: item.properties._center[1] });
        else openParkingPopup(item, { lng: item.lng, lat: item.lat });
      }
    });

    el.querySelector('.star')?.addEventListener('click', e => {
      e.stopPropagation();
      toggleBookmark(key);
    });

    el.querySelector('input[data-action=name]')?.addEventListener('click', e => e.stopPropagation());
    el.querySelector('input[data-action=name]')?.addEventListener('input', e => {
      names[key] = e.target.value;
      localStorage.setItem('names_v2', JSON.stringify(names));
    });

    el.querySelector('.addr-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openAddrModal(key);
    });
  });
}

function findItemByKey(key, type) {
  if (type === 'building') return allBuildings.features.find(f => getKey(f) === key);
  return allParkings.find(p => getKey(p) === key);
}

function flyToItem(item) {
  const [lng, lat] = item.properties ? item.properties._center : [item.lng, item.lat];
  map.flyTo({ center: [lng, lat], zoom: 17, speed: 1.5 });
  currentKey = getKey(item);

  if (item.properties) {
    const center = item.properties._center;
    const original = allBuildings.features.find(f =>
      JSON.stringify(f.properties._center) === JSON.stringify(center)
    );
    map.getSource('selected').setData({ type: 'FeatureCollection', features: [original || item] });
  } else {
    const feature = allParkings.find(p => p.no === item.no)?.feature;
    if (feature) map.getSource('selected').setData({ type: 'FeatureCollection', features: [feature] });
  }
}

// ============ 팝업 ============
function openBuildingPopup(f, lngLat) {
  const p = f.properties;
  const key = getKey(f);
  currentKey = key;
  map.getSource('selected').setData({ type: 'FeatureCollection', features: [f] });

  const isBookmarked = bookmarks[key];
  const memo = memos[key] || '';
  const name = names[key] || '';
  const installArea = (p.area * filters.utilization);
  const kindLabel = p.KIND === 'BDK005' ? '무벽/축사' : '공장/창고';

  const html = `
    <div class="popup-title">${p.installed ? '⚠ 기설치' : '○ 영업가능'} · ${kindLabel}</div>
    <div class="popup-name-row">
      <input type="text" id="popName" placeholder="수요처명" value="${escapeHtml(name)}">
      <button id="popAddrBtn">주소</button>
    </div>
    <div class="popup-row"><span>지역</span><strong>${p.sido || '-'}</strong></div>
    <div class="popup-row"><span>전체 면적</span><strong>${p.area.toFixed(0)} ㎡</strong></div>
    <div class="popup-row"><span>설치 가능</span><strong>${installArea.toFixed(0)} ㎡</strong></div>
    <div class="popup-row"><span>추정 용량</span><strong>${p.capacity.toFixed(1)} kW</strong></div>
    <div class="popup-actions">
      <button id="popBm" class="${isBookmarked ? 'active' : ''}">★ ${isBookmarked ? '해제' : '북마크'}</button>
    </div>
    <textarea class="popup-memo" id="popMemo" placeholder="메모...">${escapeHtml(memo)}</textarea>
  `;

  new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
    .setLngLat(lngLat).setHTML(html).addTo(map);

  setTimeout(() => bindPopupEvents(key), 50);
}

function openParkingPopup(parking, lngLat) {
  const key = getKey(parking);
  currentKey = key;

  const isBookmarked = bookmarks[key];
  const memo = memos[key] || '';
  const name = names[key] || '';

  const html = `
    <div class="popup-title">🅿 주차장 ${parking.installed ? '· ⚠ 기설치' : ''}</div>
    <div class="popup-name-row">
      <input type="text" id="popName" placeholder="${escapeHtml(parking.name)}" value="${escapeHtml(name)}">
      <button id="popAddrBtn">주소</button>
    </div>
    <div class="popup-row"><span>주차면수</span><strong>${parking.count}면</strong></div>
    <div class="popup-row"><span>도로명</span><strong style="font-size:11px">${parking.roadAddr || '-'}</strong></div>
    <div class="popup-row"><span>지번</span><strong style="font-size:11px">${parking.lotAddr || '-'}</strong></div>
    <div class="popup-actions">
      <button id="popBm" class="${isBookmarked ? 'active' : ''}">★ ${isBookmarked ? '해제' : '북마크'}</button>
    </div>
    <textarea class="popup-memo" id="popMemo" placeholder="메모...">${escapeHtml(memo)}</textarea>
  `;

  new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
    .setLngLat(lngLat).setHTML(html).addTo(map);

  setTimeout(() => bindPopupEvents(key), 50);
}

function bindPopupEvents(key) {
  document.getElementById('popBm')?.addEventListener('click', () => {
    toggleBookmark(key);
    const btn = document.getElementById('popBm');
    if (btn) {
      btn.classList.toggle('active');
      btn.textContent = bookmarks[key] ? '★ 해제' : '★ 북마크';
    }
  });
  document.getElementById('popMemo')?.addEventListener('input', e => {
    memos[key] = e.target.value;
    localStorage.setItem('memos_v2', JSON.stringify(memos));
  });
  document.getElementById('popName')?.addEventListener('input', e => {
    names[key] = e.target.value;
    localStorage.setItem('names_v2', JSON.stringify(names));
    renderResultsList();
  });
  document.getElementById('popAddrBtn')?.addEventListener('click', () => openAddrModal(key));
}

// ============ 북마크 ============
function toggleBookmark(key) {
  if (bookmarks[key]) delete bookmarks[key];
  else bookmarks[key] = true;
  localStorage.setItem('bookmarks_v2', JSON.stringify(bookmarks));
  renderResultsList();
  updateCounts();
  toast(bookmarks[key] ? '북마크 추가' : '북마크 해제');
}

// ============ 주소 검색 모달 ============
function openAddrModal(key) {
  currentAddrTarget = key;
  document.getElementById('addressModal').classList.remove('hidden');
  document.getElementById('addrSearchInput').value = names[key] || '';
  document.getElementById('addrResults').innerHTML = '';
}

async function searchAddress() {
  const query = document.getElementById('addrSearchInput').value.trim();
  if (!query) return;
  const resultsEl = document.getElementById('addrResults');
  resultsEl.innerHTML = '검색 중...';

  try {
    const url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=10&page=1&type=PLACE&key=${VWORLD_KEY}&query=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    const data = await res.json();
    const items = data.response?.result?.items || [];

    if (!items.length) {
      resultsEl.innerHTML = '<div style="text-align:center;color:#86868b;padding:20px">검색 결과 없음</div>';
      return;
    }

    resultsEl.innerHTML = items.map((item, i) => `
      <div class="addr-result" data-idx="${i}">
        <div class="addr-result-title">${escapeHtml(item.title)}</div>
        <div class="addr-result-addr">${escapeHtml(item.address?.road || item.address?.parcel || '')}</div>
      </div>
    `).join('');

    resultsEl.querySelectorAll('.addr-result').forEach((el, i) => {
      el.addEventListener('click', () => {
        const item = items[i];
        names[currentAddrTarget] = item.title;
        localStorage.setItem('names_v2', JSON.stringify(names));
        document.getElementById('addressModal').classList.add('hidden');
        renderResultsList();
        toast('수요처명 저장됨');
      });
    });
  } catch (e) {
    resultsEl.innerHTML = '<div style="color:#ff3b30">검색 실패</div>';
  }
}

// ============ 태양광 로드 ============

// ============ 주차장 로드 ============
async function loadAllParking() {
  if (parkingLoaded) return;
  setLoading('주차장 데이터 로드 중...');
  try {
    const all = [];
    let page = 1;
    while (true) {
      const res = await fetch(`${PARKING_API}?page=${page}`);
      const data = await res.json();
      if (!data.parkings || !data.parkings.length) break;
      all.push(...data.parkings);
      const total = data.total || 0;
      setLoading(`주차장 로드 ${all.length}/${total}`);
      if (all.length >= total) break;
      page++;
      if (page > 50) break;
    }
    allParkings = all;
    parkingLoaded = true;
    setLoading('주차장 폴리곤 가져오는 중...');
    await loadParkingPolygons();
    setLoading(null);
    toast(`주차장 ${all.length}개 로드`);
  } catch (e) {
    setLoading(null);
    toast('주차장 로드 실패');
  }
}

// 위경도 → EPSG:900913 변환
function toMercator(lng, lat) {
  const x = lng * 20037508.34 / 180;
  let y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  y = y * 20037508.34 / 180;
  return [x, y];
}

async function fetchParkingPolygon(p) {
  try {
    const [x, y] = toMercator(p.lng, p.lat);
    const d = 5;
    const url = `https://api.vworld.kr/req/wfs?SERVICE=WFS&REQUEST=GetFeature&TYPENAME=lp_pa_cbnd_bonbun&BBOX=${x-d},${y-d},${x+d},${y+d}&VERSION=1.1.0&MAXFEATURES=1&SRSNAME=EPSG:900913&OUTPUT=application/json&KEY=${VWORLD_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.features || !data.features.length) return null;
    const feat = data.features[0];
    // Mercator → WGS84 변환
    feat.geometry = mercatorGeometryToWGS84(feat.geometry);
    feat.properties = { ...feat.properties, no: p.no };
    return feat;
  } catch { return null; }
}

function mercatorGeometryToWGS84(geom) {
  const convertCoord = ([x, y]) => {
    const lng = x / 20037508.34 * 180;
    let lat = y / 20037508.34 * 180;
    lat = 180 / Math.PI * (2 * Math.atan(Math.exp(lat * Math.PI / 180)) - Math.PI / 2);
    return [lng, lat];
  };
  const convertRing = ring => ring.map(convertCoord);
  if (geom.type === 'MultiPolygon') {
    geom.coordinates = geom.coordinates.map(poly => poly.map(convertRing));
  } else if (geom.type === 'Polygon') {
    geom.coordinates = geom.coordinates.map(convertRing);
  }
  return geom;
}

async function loadParkingPolygons() {
  const features = [];
  const BATCH = 5;
  for (let i = 0; i < allParkings.length; i += BATCH) {
    const batch = allParkings.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(fetchParkingPolygon));
    results.forEach((feat, j) => {
      if (feat) {
        allParkings[i+j].feature = feat;
        features.push(feat);
      }
    });
    setLoading(`주차장 폴리곤 ${Math.min(i+BATCH, allParkings.length)}/${allParkings.length}`);
  }
  filteredParkings = allParkings.filter(p => p.feature);
  matchParkingInstalled();
  map.getSource('parking').setData({ type: 'FeatureCollection', features });
  updateCounts();
  if (currentTab === 'parking' || currentTab === 'bookmark') renderResultsList();
}

// ============ 엑셀 ============
function exportToExcel() {
  let items = [];
  if (currentTab === 'building') items = filteredBuildings;
  else if (currentTab === 'parking') items = filteredParkings;
  else {
    const keys = Object.keys(bookmarks);
    items = [
      ...(allBuildings?.features.filter(f => keys.includes(getKey(f))) || []),
      ...allParkings.filter(p => keys.includes(getKey(p)))
    ];
  }

  if (!items.length) { toast('내보낼 데이터 없음'); return; }

  const rows = items.map(item => {
    const key = getKey(item);
    if (item.properties) {
      const p = item.properties;
      return {
        '구분': '지붕형', '수요처명': names[key] || '', '지역': p.sido || '',
        '건물유형': p.KIND === 'BDK005' ? '무벽/축사' : '공장/창고',
        '면적(㎡)': Math.round(p.area),
        '설치가능면적(㎡)': Math.round(p.area * filters.utilization),
        '추정설비용량(kW)': +p.capacity.toFixed(1),
        '기설치여부': p.installed ? 'Y' : 'N',
        '북마크': bookmarks[key] ? 'Y' : 'N',
        '메모': memos[key] || '',
        '위도': p._center[1].toFixed(6), '경도': p._center[0].toFixed(6),
      };
    } else {
      return {
        '구분': '주차장형', '수요처명': names[key] || item.name,
        '주차면수': item.count, '도로명주소': item.roadAddr || '',
        '지번주소': item.lotAddr || '', '기설치여부': item.installed ? 'Y' : 'N',
        '북마크': bookmarks[key] ? 'Y' : 'N', '메모': memos[key] || '',
        '위도': item.lat, '경도': item.lng,
      };
    }
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '영업타겟');
  XLSX.writeFile(wb, `solar_targets_${new Date().toISOString().slice(0,10)}.xlsx`);
  toast(`${rows.length}건 다운로드`);
}

// ============ 이벤트 바인딩 ============
document.getElementById('sidoFilter').addEventListener('change', e => {
  filters.sido = e.target.value;
  applyFilters();
  if (e.target.value && SIDO_CENTERS[e.target.value]) {
    const [lng, lat, z] = SIDO_CENTERS[e.target.value];
    map.flyTo({ center: [lng, lat], zoom: z });
  }
});

document.getElementById('capSlider').addEventListener('input', e => {
  filters.minCapacity = +e.target.value;
  document.getElementById('capValue').textContent = `${e.target.value} kW`;
  applyFilters();
});

document.getElementById('utilSlider').addEventListener('input', e => {
  filters.utilization = +e.target.value / 100;
  document.getElementById('utilValue').textContent = `${e.target.value}%`;
  applyFilters();
});

document.getElementById('kwSlider').addEventListener('input', e => {
  filters.kwPerSqm = +e.target.value / 100;
  document.getElementById('kwValue').textContent = `${(e.target.value/100).toFixed(2)} kW`;
  applyFilters();
});

document.getElementById('exportBtn').addEventListener('click', exportToExcel);

document.getElementById('sortBtn').addEventListener('click', () => {
  sortDesc = !sortDesc;
  document.getElementById('sortBtn').textContent = sortDesc ? '설비용량 ↓' : '설비용량 ↑';
  renderResultsList();
});

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    renderResultsList();
  });
});

document.querySelectorAll('.map-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.map-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const center = map.getCenter();
    const zoom = map.getZoom();
    const newStyle = btn.dataset.type === 'satellite' ? satelliteStyle : baseMapStyle;
    map.setStyle(newStyle);
    map.once('styledata', () => {
      map.setCenter(center); map.setZoom(zoom);
      setupMapLayers();
      if (allBuildings) applyFilters();
    });
  });
});

document.getElementById('layerBuildings').addEventListener('change', e => {
  const v = e.target.checked ? 'visible' : 'none';
  map.setLayoutProperty('buildings-fill', 'visibility', v);
  map.setLayoutProperty('buildings-line', 'visibility', v);
});

document.getElementById('layerParking').addEventListener('change', e => {
  const v = e.target.checked ? 'visible' : 'none';
  map.setLayoutProperty('parking-fill', 'visibility', v);
  map.setLayoutProperty('parking-line', 'visibility', v);
  if (e.target.checked && !parkingLoaded) loadAllParking();
});

document.getElementById('closeAddrModal').addEventListener('click', () => {
  document.getElementById('addressModal').classList.add('hidden');
});

document.getElementById('addrSearchBtn').addEventListener('click', searchAddress);
document.getElementById('addrSearchInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') searchAddress();
});

// ============ 시작 ============
map.on('load', () => {
  loadBuildings();
});
