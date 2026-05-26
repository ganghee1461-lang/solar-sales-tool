// netlify/functions/parking.js
exports.handler = async (event) => {
  const SERVICE_KEY = '91f8ffe040fc2d65517040949b7e88d6d5a382c577809c94bf144214e891d1d2';
  const { page } = event.queryStringParameters || {};
  const pageNo = parseInt(page) || 1;

  try {
    const url = `https://api.data.go.kr/openapi/tn_pubr_prkplce_info_api?serviceKey=${SERVICE_KEY}&pageNo=${pageNo}&numOfRows=1000&type=json&prkplceType=노외`;
    const res = await fetch(url);
    const data = await res.json();
    const items = data.response?.body?.items || [];
    const total = parseInt(data.response?.body?.totalCount) || 0;

    const filtered = items.filter(p => parseInt(p.prkcmprt) >= 24 && p.latitude && p.longitude);

    const result = filtered.map(p => ({
      no: p.prkplceNo,
      name: p.prkplceNm,
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      count: parseInt(p.prkcmprt),
      roadAddr: p.rdnmadr,
      lotAddr: p.lnmadr,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      body: JSON.stringify({ parkings: result, total, page: pageNo }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
