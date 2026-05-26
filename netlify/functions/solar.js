// netlify/functions/solar.js
exports.handler = async (event) => {
  const SERVICE_KEY = '91f8ffe040fc2d65517040949b7e88d6d5a382c577809c94bf144214e891d1d2';
  const { page } = event.queryStringParameters || {};
  const pageNo = parseInt(page) || 1;

  try {
    const url = `https://api.data.go.kr/openapi/tn_pubr_public_solar_gen_flct_api?serviceKey=${SERVICE_KEY}&pageNo=${pageNo}&numOfRows=1000&type=json`;
    const res = await fetch(url);
    const data = await res.json();
    const items = data.response?.body?.items || [];
    const total = parseInt(data.response?.body?.totalCount) || 0;

    const filtered = items.filter(p => p.latitude && p.longitude);

    const result = filtered.map(p => ({
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      capa: parseFloat(p.capa),
      status: p.oprtngSttsSeNm,
      roadAddr: p.lctnRoadNmAddr,
      lotAddr: p.lctnLotnoAddr,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      body: JSON.stringify({ points: result, total, page: pageNo }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
};
