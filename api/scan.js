const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";
const DATA  = "https://data-api.polymarket.com";

async function fetchSportsMarkets() {
  try {
    const r = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=100`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    if (!r.ok) { console.log("markets HTTP", r.status); return []; }
    const data = await r.json();
    if (!Array.isArray(data)) { console.log("markets not array"); return []; }
    console.log(`[markets] total=${data.length}`);
    return data;
  } catch(e) {
    console.log("markets error:", e.message);
    return [];
  }
}

async function fetchTradesForMarket(market) {
  const trades = [];
  try {
    let tokenIds = [];
    if (market.clobTokenIds) {
      tokenIds = typeof market.clobTokenIds === "string"
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
    }
    for (const tokenId of tokenIds) {
      const r = await fetch(`
