// 공공데이터포털 태양광 발전시설 정보 프록시
const SOLAR_KEY = '91f8ffe040fc2d65517040949b7e88d6d5a382c577809c94bf144214e891d1d2';

exports.handler = async (event) => {
  const { minLng, minLat, maxLng, maxLat } = event.queryStringParameters || {};

  if (!minLng) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bbox required' }) };
  }

  try {
    // 공공데이터포털 태양광 발전시설 API
    // tn_pubr_public_solar_gen_flct_api : 한국에너지공단 등록 태양광 발전시설
    let allPoints = [];
    let pageNo = 1;
    const numOfRows = 1000;

    while (pageNo <= 5) {  // 최대 5페이지
      const url = `https://api.odcloud.kr/api/15102796/v1/uddi:5e0f37ca-6e30-46f5-9ad3-bd16d4bd84a3?page=${pageNo}&perPage=${numOfRows}&serviceKey=${SOLAR_KEY}`;

      const res = await fetch(url);
      if (!res.ok) break;

      const data = await res.json();
      const items = data.data || [];

      // bbox 필터링 + 좌표 추출
      items.forEach(item => {
        const lat = parseFloat(item['위도'] || item.lat || item.latitude);
        const lng = parseFloat(item['경도'] || item.lng || item.longitude);
        if (isNaN(lat) || isNaN(lng)) return;
        if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) return;

        allPoints.push({
          lat, lng,
          name: item['발전소명'] || item.name || '',
          capacity: parseFloat(item['설비용량'] || item.capacity || 0),
        });
      });

      if (items.length < numOfRows) break;
      pageNo++;
    }

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
      body: JSON.stringify({ points: allPoints, count: allPoints.length }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message, points: [] }),
    };
  }
};
