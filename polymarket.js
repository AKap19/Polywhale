// lib/polymarket.js

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

// ── All sports markets ───────────────────────────────────────────────────────
export async function fetchSportsMarkets() {
  const tags = [
    "sports","nba","mlb","nfl","nhl","soccer",
    "mls","ufc","mma","tennis","golf","boxing"
  ];
  const results = [];
  for (const tag of tags) {
    try {
      const r = await fetch(
        `${GAMMA}/markets?active=true&closed=false&tag_slug=${tag}&limit=50`,
        { headers: { Accept: "application/json" } }
      );
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data)) results.push(...data);
    } catch { continue; }
  }
  // Deduplicate
  const seen = new Set();
  return results.filter(m => {
    const id = m.conditionId || m.condition_id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ── Recent trades for a market ───────────────────────────────────────────────
export async function fetchRecentTrades(conditionId) {
  try {
    const r = await fetch(
      `${CLOB}/trades?market=${conditionId}&limit=25`,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return data.data || [];
  } catch { return []; }
}

// ── Wallet position history ──────────────────────────────────────────────────
export async function fetchWalletPositions(address) {
  try {
    const r = await fetch(
      `${GAMMA}/positions?user=${address}&limit=200`,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// ── Score wallet ─────────────────────────────────────────────────────────────
export async function scoreWallet(address) {
  const positions = await fetchWalletPositions(address);
  if (!positions.length) return null;

  const settled = positions.filter(p => p.redeemed === true || p.outcome != null);
  if (settled.length < 10) return null; // need enough history

  const wins = settled.filter(p => p.winner === true || p.redeemed === true).length;
  const totalTrades = settled.length;
  const winRate = wins / totalTrades;

  // ROI calculation
  let totalCost = 0, totalReturn = 0;
  for (const p of settled) {
    const cost = parseFloat(p.initialValue || p.size || 0);
    const ret  = parseFloat(p.currentValue || p.cashPnl || 0) + cost;
    totalCost   += cost;
    totalReturn += ret;
  }
  const roi = totalCost > 0 ? (totalReturn - totalCost) / totalCost : 0;
  const totalVolume = positions.reduce(
    (s, p) => s + parseFloat(p.initialValue || p.size || 0), 0
  );

  const grade = winRate >= 0.80 ? "🔥 SHARP"
              : winRate >= 0.65 ? "👀 WATCH"
              : "CASUAL";

  return { address, winRate, totalTrades, totalVolume, roi, grade };
}

// ── Price history for line move context ─────────────────────────────────────
export async function fetchPriceHistory(conditionId) {
  try {
    const r = await fetch(
      `${CLOB}/prices-history?market=${conditionId}&interval=1h&fidelity=1`,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return data.history || [];
  } catch { return []; }
}

// ── Build full trade context ─────────────────────────────────────────────────
export async function buildTradeContext(trade, market, walletScore) {
  const conditionId = market.conditionId || market.condition_id;
  const history = conditionId ? await fetchPriceHistory(conditionId) : [];

  let lineMove = "N/A";
  if (history.length >= 2) {
    const prev = parseFloat(history[history.length - 2]?.p || 0);
    const curr = parseFloat(history[history.length - 1]?.p || 0);
    if (prev > 0) {
      const movePct = ((curr - prev) / prev * 100).toFixed(1);
      lineMove = `${movePct > 0 ? "+" : ""}${movePct}% (1h)`;
    }
  }

  const side         = (trade.side || "BUY").toUpperCase() === "BUY" ? "YES" : "NO";
  const price        = parseFloat(trade.price || 0);
  const impliedProb  = (price * 100).toFixed(1) + "%";
  const size         = Math.round(parseFloat(trade.size || trade.matched_amount || 0));
  const tags         = (market.tags || []).map(t => t.label || t.slug).join(", ") || "Sports";

  return {
    market: {
      question: market.question || market.title || "Unknown market",
      url: `https://polymarket.com/event/${conditionId}`,
      category: tags,
    },
    trade: { side, size, price, impliedProb },
    wallet: walletScore,
    lineMove,
    walletUrl: `https://polymarket.com/profile/${walletScore.address}`,
  };
}
