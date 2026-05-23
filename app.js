// ============ 설정 ============
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';
const BUILDINGS_URL = 'buildings.geojson';
const SOLAR_API = '/.netlify/functions/solar';
const PARKING_API = '/.netlify/functions/parking';

// ============ 전역 상태 ============
let allBuildings = null;
let filteredBuildings = [];
let solarPoints = [];
let parkingPolys = [];
let bookmarks = JSON.parse(localStorage.getItem('bookmarks') || '{}');
let memos = JSON.parse(localStorage.getItem('memos') || '{}');
let currentFeatureId = null;

// 필터 상태
let filters = {
  sido: '',
  kind: '',
  minCapacity: 300,
  utilization: 0.5,
  kwPerSqm: 0.1,
};

const SIDO_CENTERS = {
  '서울': [126.978, 37.566, 11],
  '부산': [129.075, 35.179, 11],
  '대구': [128.601, 35.871, 11],
  '인천': [126.705, 37.456, 11],
  '광주': [126.852, 35.160, 11],
  '대전': [127.385, 36.350, 11],
  '울산': [129.311, 35.539, 11],
  '세종': [127.288, 36.480, 11],
  '경기': [127.108, 37.412, 9],
  '강원특별자치도': [128.155, 37.821, 8],
  '충북': [127.490, 36.628, 9],
  '충남': [126.800, 36.658, 9],
  '전북특별자치도': [127.108, 35.716, 9],
  '전남': [126.991, 34.819, 9],
  '경북': [128.890, 36.248, 8],
  '경남': [128.213, 35.460, 9],
  '제주': [126.500, 33.400, 10],
};

// ============ 지도 초기화 ============
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

// ============ 토스트 ============
function toast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ============ 로딩 ============
function setLoading(text) {
  const el = document.getElementById('loading');
  if (text) {
    document.getElementById('loadingText').textContent = text;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ============ 건물 데이터 로드 ============
async function loadBuildings() {
  setLoading('건물 데이터 로드 중... (42MB)');
  try {
    const res = await fetch(BUILDINGS_URL);
    const data = await res.json();

    // 시도 추출 + 좌표 계산
    const sidoSet = new Set();
    data.features.forEach((f, i) => {
      f.id = i;
      f.properties.capacity = (f.properties.area * filters.utilization * filters.kwPerSqm);

      // 중심점 계산
      const bbox = turf.bbox(f);
      f.properties._center = [(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2];

      // 시도 추측 (위경도 기반)
      const sido = guessSido(f.properties._center);
      f.properties.sido = sido;
      if (sido) sidoSet.add(sido);

      f.properties.installed = false;
    });

    allBuildings = data;
    populateSidoFilter([...sidoSet].sort());
    setupMapLayers();
    applyFilters();
    setLoading(null);
    toast(`${data.features.length.toLocaleString()}개 건물 로드 완료`);
  } catch (e) {
    console.error(e);
    setLoading(null);
    toast('데이터 로드 실패: ' + e.message, 4000);
  }
}

// 위경도로 시도 추측 (간단한 BBox 기반)
function guessSido(coord) {
  const [lng, lat] = coord;
  // 대도시 우선 체크 (좁은 영역)
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
    o.value = s; o.textContent = s.replace('특별자치도', '');
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
        ['get', 'installed'], '#ef4444',
        ['==', ['get', 'KIND'], 'BDK005'], '#10b981',
        '#3b82f6'
      ],
      'fill-opacity': 0.5,
    }
  });

  map.addLayer({
    id: 'buildings-line',
    type: 'line',
    source: 'buildings',
    paint: {
      'line-color': [
        'case',
        ['get', 'installed'], '#ef4444',
        ['==', ['get', 'KIND'], 'BDK005'], '#10b981',
        '#3b82f6'
      ],
      'line-width': 1.5,
    }
  });

  // 선택된 건물 강조
  map.addSource('selected', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'selected-outline',
    type: 'line',
    source: 'selected',
    paint: { 'line-color': '#fbbf24', 'line-width': 3 }
  });

  // 태양광 포인트
  map.addSource('solar', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'solar-points',
    type: 'circle',
    source: 'solar',
    paint: {
      'circle-radius': 5,
      'circle-color': '#ef4444',
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    }
  });

  // 주차장 폴리곤
  map.addSource('parking', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'parking-fill',
    type: 'fill',
    source: 'parking',
    paint: {
      'fill-color': [
        'case',
        ['get', 'installed'], '#f97316',
        '#10b981'
      ],
      'fill-opacity': 0.4,
    }
  });

  // POI 라벨
  map.addSource('poi', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'poi-labels',
    type: 'symbol',
    source: 'poi',
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-offset': [0, 1],
      'text-anchor': 'top',
      'text-font': ['Noto Sans CJK KR Regular'],
    },
    paint: {
      'text-color': '#fbbf24',
      'text-halo-color': '#000',
      'text-halo-width': 1.5,
    }
  });

  // 클릭 이벤트
  map.on('click', 'buildings-fill', e => {
    if (!e.features.length) return;
    const f = e.features[0];
    openBuildingPopup(f, e.lngLat);
  });

  map.on('mouseenter', 'buildings-fill', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'buildings-fill', () => map.getCanvas().style.cursor = '');

  // 줌 변경 시 POI 로드
  map.on('moveend', debounce(() => {
    if (document.getElementById('layerPOI').checked && map.getZoom() >= 13) {
      loadPOIInView();
    }
    if (document.getElementById('layerSolar').checked && map.getZoom() >= 11) {
      loadSolarInView();
    }
    if (document.getElementById('layerParking').checked && map.getZoom() >= 13) {
      loadParkingInView();
    }
  }, 600));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ============ 필터링 ============
function applyFilters() {
  if (!allBuildings) return;

  filteredBuildings = allBuildings.features.filter(f => {
    const p = f.properties;
    p.capacity = (p.area * filters.utilization * filters.kwPerSqm);
    if (filters.sido && p.sido !== filters.sido) return false;
    if (filters.kind && p.KIND !== filters.kind) return false;
    if (p.capacity < filters.minCapacity) return false;
    return true;
  });

  // 지도에 표시
  map.getSource('buildings').setData({
    type: 'FeatureCollection',
    features: filteredBuildings,
  });

  renderResultsList();
}

function renderResultsList() {
  const list = document.getElementById('resultsList');
  const count = document.getElementById('resultCount');

  // 용량순 정렬
  const sorted = [...filteredBuildings].sort((a, b) => b.properties.capacity - a.properties.capacity);
  count.textContent = sorted.length.toLocaleString();

  // 최대 200개만 (성능)
  const items = sorted.slice(0, 200);

  list.innerHTML = items.map(f => {
    const p = f.properties;
    const isBookmarked = bookmarks[f.id];
    const kindLabel = p.KIND === 'BDK005' ? '무벽/축사' : '공장/창고';
    const kindClass = p.installed ? 'installed' : (p.KIND === 'BDK005' ? 'bdk005' : '');
    return `
      <div class="result-item ${currentFeatureId === f.id ? 'active' : ''}" data-id="${f.id}">
        <div class="result-row1">
          <span class="result-capacity">${p.capacity.toFixed(1)} kW ${isBookmarked ? '★' : ''}</span>
          <span class="result-kind ${kindClass}">${p.installed ? '기설치' : kindLabel}</span>
        </div>
        <div class="result-area">${p.area.toLocaleString(undefined, {maximumFractionDigits:0})} ㎡</div>
        <div class="result-sido">${p.sido || '미분류'}</div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.result-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = +el.dataset.id;
      const f = filteredBuildings.find(x => x.id === id);
      if (f) {
        flyToBuilding(f);
        openBuildingPopup(f, { lng: f.properties._center[0], lat: f.properties._center[1] });
      }
    });
  });

  updateBookmarkCount();
}

function flyToBuilding(f) {
  const [lng, lat] = f.properties._center;
  map.flyTo({ center: [lng, lat], zoom: 17, speed: 1.5 });
  currentFeatureId = f.id;

  // 강조
  map.getSource('selected').setData({
    type: 'FeatureCollection',
    features: [f]
  });
}

// ============ 팝업 ============
function openBuildingPopup(f, lngLat) {
  const p = f.properties;
  currentFeatureId = f.id;

  map.getSource('selected').setData({
    type: 'FeatureCollection',
    features: [f]
  });

  const isBookmarked = bookmarks[f.id];
  const memo = memos[f.id] || '';
  const installArea = (p.area * filters.utilization);
  const kindLabel = p.KIND === 'BDK005' ? '무벽/축사' : '공장/창고';

  const html = `
    <div class="popup-title">${p.installed ? '⚠ 기설치 건물' : '○ 영업 가능'} · ${kindLabel}</div>
    <div class="popup-row"><span>지역</span><strong>${p.sido || '-'}</strong></div>
    <div class="popup-row"><span>전체 면적</span><strong>${p.area.toFixed(0)} ㎡</strong></div>
    <div class="popup-row"><span>설치 가능 면적</span><strong>${installArea.toFixed(0)} ㎡</strong></div>
    <div class="popup-row"><span>추정 설비용량</span><strong>${p.capacity.toFixed(1)} kW</strong></div>
    <div class="popup-actions">
      <button id="bmToggle" class="${isBookmarked ? 'active' : ''}">★ ${isBookmarked ? '북마크 해제' : '북마크'}</button>
    </div>
    <textarea class="popup-memo" id="memoInput" placeholder="메모 입력...">${memo}</textarea>
  `;

  new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);

  setTimeout(() => {
    const bm = document.getElementById('bmToggle');
    const memo = document.getElementById('memoInput');
    if (bm) bm.addEventListener('click', () => toggleBookmark(f.id));
    if (memo) memo.addEventListener('input', e => {
      memos[f.id] = e.target.value;
      localStorage.setItem('memos', JSON.stringify(memos));
    });
  }, 100);
}

// ============ 북마크 ============
function toggleBookmark(id) {
  if (bookmarks[id]) delete bookmarks[id];
  else bookmarks[id] = true;
  localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
  renderResultsList();
  toast(bookmarks[id] ? '북마크 추가' : '북마크 해제');
}

function updateBookmarkCount() {
  document.getElementById('bmCount').textContent = Object.keys(bookmarks).length;
}

// ============ 엑셀 ============
function exportToExcel() {
  if (!filteredBuildings.length) {
    toast('내보낼 데이터가 없습니다');
    return;
  }

  const rows = filteredBuildings.map(f => {
    const p = f.properties;
    return {
      '지역': p.sido || '',
      '건물유형': p.KIND === 'BDK005' ? '무벽/축사' : '공장/창고',
      '면적(㎡)': Math.round(p.area),
      '설치가능면적(㎡)': Math.round(p.area * filters.utilization),
      '추정설비용량(kW)': +p.capacity.toFixed(1),
      '기설치여부': p.installed ? 'Y' : 'N',
      '북마크': bookmarks[f.id] ? 'Y' : 'N',
      '메모': memos[f.id] || '',
      '위도': p._center[1].toFixed(6),
      '경도': p._center[0].toFixed(6),
    };
  });

  rows.sort((a, b) => b['추정설비용량(kW)'] - a['추정설비용량(kW)']);

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '영업타겟');
  XLSX.writeFile(wb, `solar_targets_${new Date().toISOString().slice(0,10)}.xlsx`);
  toast(`${rows.length}건 엑셀 다운로드`);
}

// ============ 외부 API ============
async function loadSolarInView() {
  const b = map.getBounds();
  try {
    const url = `${SOLAR_API}?minLng=${b.getWest()}&minLat=${b.getSouth()}&maxLng=${b.getEast()}&maxLat=${b.getNorth()}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.points) return;

    solarPoints = data.points;
    map.getSource('solar').setData({
      type: 'FeatureCollection',
      features: solarPoints.map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: p,
      }))
    });

    // Point-in-Polygon으로 기설치 매칭
    markInstalledBuildings();
  } catch (e) {
    console.error('solar load fail', e);
  }
}

function markInstalledBuildings() {
  if (!allBuildings || !solarPoints.length) return;
  const b = map.getBounds();

  // 화면 안 건물만
  allBuildings.features.forEach(f => {
    const [lng, lat] = f.properties._center;
    if (lng < b.getWest() || lng > b.getEast() || lat < b.getSouth() || lat > b.getNorth()) return;

    const has = solarPoints.some(p => {
      try {
        return turf.booleanPointInPolygon([p.lng, p.lat], f);
      } catch (e) { return false; }
    });
    if (has) f.properties.installed = true;
  });

  applyFilters();
}

async function loadParkingInView() {
  const b = map.getBounds();
  try {
    const url = `${PARKING_API}?minLng=${b.getWest()}&minLat=${b.getSouth()}&maxLng=${b.getEast()}&maxLat=${b.getNorth()}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (data.features) {
      parkingPolys = data.features;
      map.getSource('parking').setData({ type: 'FeatureCollection', features: parkingPolys });
    }
  } catch (e) { console.error('parking fail', e); }
}

// 브이월드 POI 검색 - 직접 호출 (CORS 허용)
async function loadPOIInView() {
  const b = map.getBounds();
  try {
    const url = `https://api.vworld.kr/req/data?service=data&version=2.0&request=GetFeature&format=json&size=100&page=1&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&geomFilter=BOX(${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()})`;

    // 브이월드는 POI를 일반 검색으로
    const poiUrl = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=100&page=1&type=PLACE&key=${VWORLD_KEY}&bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}&query=공장`;

    const res = await fetch(poiUrl);
    const data = await res.json();

    if (data.response?.result?.items) {
      const features = data.response.result.items.map(item => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [parseFloat(item.point.x), parseFloat(item.point.y)] },
        properties: { name: item.title }
      }));
      map.getSource('poi').setData({ type: 'FeatureCollection', features });
    }
  } catch (e) { console.error('poi fail', e); }
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

document.getElementById('kindFilter').addEventListener('change', e => {
  filters.kind = e.target.value;
  applyFilters();
});

const capSlider = document.getElementById('capSlider');
capSlider.addEventListener('input', e => {
  filters.minCapacity = +e.target.value;
  document.getElementById('capValue').textContent = `${e.target.value} kW`;
  applyFilters();
});

const utilSlider = document.getElementById('utilSlider');
utilSlider.addEventListener('input', e => {
  filters.utilization = +e.target.value / 100;
  document.getElementById('utilValue').textContent = `${e.target.value}%`;
  applyFilters();
});

const kwSlider = document.getElementById('kwSlider');
kwSlider.addEventListener('input', e => {
  filters.kwPerSqm = +e.target.value / 100;
  document.getElementById('kwValue').textContent = `${(e.target.value/100).toFixed(2)} kW`;
  applyFilters();
});

document.getElementById('exportBtn').addEventListener('click', exportToExcel);

document.getElementById('bookmarkBtn').addEventListener('click', () => {
  // 북마크된 것만 보기 토글
  const ids = Object.keys(bookmarks).map(Number);
  if (!ids.length) {
    toast('북마크가 없습니다');
    return;
  }
  const list = document.getElementById('resultsList');
  const items = allBuildings.features.filter(f => ids.includes(f.id));
  filteredBuildings = items;
  map.getSource('buildings').setData({ type: 'FeatureCollection', features: items });
  renderResultsList();
  toast(`북마크 ${items.length}건 표시`);
});

// 지도 타입 토글
document.querySelectorAll('.map-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.map-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const center = map.getCenter();
    const zoom = map.getZoom();
    const newStyle = btn.dataset.type === 'satellite' ? satelliteStyle : baseMapStyle;
    map.setStyle(newStyle);

    map.once('styledata', () => {
      map.setCenter(center);
      map.setZoom(zoom);
      setupMapLayers();
      if (allBuildings) applyFilters();
    });
  });
});

// 레이어 토글
document.getElementById('layerBuildings').addEventListener('change', e => {
  map.setLayoutProperty('buildings-fill', 'visibility', e.target.checked ? 'visible' : 'none');
  map.setLayoutProperty('buildings-line', 'visibility', e.target.checked ? 'visible' : 'none');
});
document.getElementById('layerSolar').addEventListener('change', e => {
  map.setLayoutProperty('solar-points', 'visibility', e.target.checked ? 'visible' : 'none');
  if (e.target.checked) loadSolarInView();
});
document.getElementById('layerParking').addEventListener('change', e => {
  map.setLayoutProperty('parking-fill', 'visibility', e.target.checked ? 'visible' : 'none');
  if (e.target.checked) loadParkingInView();
});
document.getElementById('layerPOI').addEventListener('change', e => {
  map.setLayoutProperty('poi-labels', 'visibility', e.target.checked ? 'visible' : 'none');
  if (e.target.checked) loadPOIInView();
});

// ============ 시작 ============
map.on('load', () => {
  loadBuildings();
});
