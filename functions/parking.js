export async function onRequest(context) {
  const SERVICE_KEY = '91f8ffe040fc2d65517040949b7e88d6d5a382c577809c94bf144214e891d1d2';
  const url = new URL(context.request.url);
  const page = url.searchParams.get('page') || '1';

  try {
    const apiUrl = `https://api.data.go.kr/openapi/tn_pubr_prkplce_info_api?serviceKey=${SERVICE_KEY}&pageNo=${page}&numOfRows=1000&type=json&prkplceType=노외`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    const items = data.response?.body?.items || [];
    const total = parseInt(data.response?.body?.totalCount) || 0;

    const filtered = items
      .filter(p => parseInt(p.prkcmprt) >= 24 && p.latitude && p.longitude)
      .map(p => ({
        no: p.prkplceNo,
        name: p.prkplceNm,
        lat: parseFloat(p.latitude),
        lng: parseFloat(p.longitude),
        count: parseInt(p.prkcmprt),
        roadAddr: p.rdnmadr,
        lotAddr: p.lnmadr,
      }));

    return new Response(JSON.stringify({ parkings: filtered, total, page: parseInt(page) }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
