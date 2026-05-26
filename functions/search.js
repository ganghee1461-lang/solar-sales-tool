export async function onRequest(context) {
  const url = new URL(context.request.url);
  const query = url.searchParams.get('query') || '';
  try {
    const res = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=10`,
      { headers: { 'Authorization': 'KakaoAK 68cb31d6651ad2e6c4ce8980fc005e2c' } }
    );
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
