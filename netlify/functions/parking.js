// netlify/functions/parking.js
exports.handler = async (event) => {
  const SERVICE_KEY = '91f8ffe040fc2d65517040949b7e88d6d5a382c577809c94bf144214e891d1d2';
  const { minLng, minLat, maxLng, maxLat } = event.queryStringParameters || {};

  if (!minLng) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bbox required' }) };
  }

  try {
    // 한 번에 1000개씩, 최대 12페이지 (11,707개)
    const allItems = [];
    const totalPages = 12;

    for (let page = 1; page <= totalPages; page++) {
      const url = `https://api.data.go.kr/openapi/tn_pubr_prkplce_info_api?serviceKey=${SERVICE_KEY}&pageNo=${page}&numOfRows=1000&type=json&prkplceType=노외`;
      const res = await fetch(url);
      const data = await res.json();
      const items = data.response?.body?.items || [];
      if (!items.length) break;
      allItems.push(...items);
    }

    // bbox 필터 + 24면 이상
    const filtered = allItems.filter(p => {
      const lat = parseFloat(p.latitude);
      const lng = parseFloat(p.longitude);
      const cnt = parseInt(p.prkcmprt) || 0;
      if (!lat || !lng || cnt < 24) return false;
      return lng >= +minLng && lng <= +maxLng && lat >= +minLat && lat <= +maxLat;
    });

    const result = filtered.map(p => ({
      no: p.prkplceNo,
      name: p.prkplceNm,
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      count: parseInt(p.prkcmprt),
      roadAddr: p.rdnmadr,
      lotAddr: p.lnmadr,
      type: p.prkplceSe,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ parkings: result }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
