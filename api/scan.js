async function fetchSportsMarkets() {
  const results = [];
  const keywords = ["MLB","NBA","NFL","UFC","soccer","tennis","golf","boxing","NHL"];
  for (const kw of keywords) {
    try {
      const r = await fetch(
        `${GAMMA}/markets?active=true&closed=false&limit=20&q=${kw}`,
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
      );
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data)) results.push(...data);
      }
    } catch {}
  }
  const seen = new Set();
  return results.filter(m => {
    const id = m.conditionId || m.condition_id;
    if (!id || seen.has(id)) return false;
    seen.add(id); return true;
  });
}

