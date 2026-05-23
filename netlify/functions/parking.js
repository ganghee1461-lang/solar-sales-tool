// 브이월드 주차장 폴리곤 프록시
const VWORLD_KEY = '12343DE1-7083-3969-A937-153DE6A043BE';

exports.handler = async (event) => {
  const { minLng, minLat, maxLng, maxLat } = event.queryStringParameters || {};

  if (!minLng) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bbox required' }) };
  }

  try {
    // 브이월드 WFS 주차장
    const url = `https://api.vworld.kr/req/wfs?service=wfs&version=1.1.0&request=GetFeature&typename=lt_p_uq128&srs=EPSG:4326&bbox=${minLat},${minLng},${maxLat},${maxLng}&maxFeatures=300&output=GML2&key=${VWORLD_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ features: [] }),
      };
    }

    const text = await res.text();
    // WFS XML → GeoJSON 간단 변환은 복잡하므로 일단 빈 결과
    // 추후 구현
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ features: [] }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message, features: [] }),
    };
  }
};
