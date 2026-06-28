const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

async function fetchSportsMarkets() {
  const results = [];
  try {
    const r = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=100`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    if (!r.ok) { console.log("markets HTTP", r.status); return []; }
    const data = await r.json();
    if (!Array.isArray(data)) { console.log("markets not array"); return []; }
    // Filter to likely sports markets by checking tags or title keywords
    const sports = ["nba","mlb","nfl","nhl","ufc","mma","tennis","golf","soccer","boxing","playoff","championship","series","match","game","fight","tournament"];
    const filtered = data.filter(m => {
      const q = (m.question || m.title || "").toLowerCase();
      const tags = (m.tags || []).map(t => (t.label || t.slug || "").toLowerCase()).join(" ");
      return sports.some(s => q.includes(s) || tags.includes(s));
    });
    console.log(`[markets] total=${data.length} sports=${filtered.length}`);
    return filtered;
  } catch(e) { console.log("markets error:", e.message); return []; }
}

async function fetchRecentTrades(market) {
  // Try token IDs first (more reliable), fall back to conditionId
  const tokens = market.tokens || [];
  const trades = [];
  for (const token of tokens) {
    const tokenId = token.token_id || token.tokenId;
    if (!tokenId) continue;
    try {
      const r = await fetch(`${CLOB}/trades?market=${tokenId}&limit=20`);
      if (!r.ok) continue;
      const data = await r.json();
      if (data.data && data.data.length > 0) {
        trades.push(...data.data);
        console.log(`[trades] token ${tokenId.slice(0,8)}: ${data.data.length} trades`);
      }
    } catch {}
  }
  // Also try conditionId
  const conditionId = market.conditionId || market.condition_id;
  if (conditionId && trades.length === 0) {
    try {
      const r = await fetch(`${CLOB}/trades?market=${conditionId}&limit=20`);
      if (r.ok) {
        const data = await r.json();
        if (data.data) trades.push(...data.data);
      }
    } catch {}
  }
  return trades;
}

async function scoreWallet(address) {
  try {
    const r = await fetch(`${GAMMA}/positions?user=${address}&limit=200`);
    if (!r.ok) return null;
    const positions = await r.json();
    if (!Array.isArray(positions) || positions.length === 0) return null;
    const settled = positions.filter(p => p.redeemed === true || p.outcome != null);
    if (settled.length < 3) return null;
    const wins = settled.filter(p => p.winner === true || p.redeemed === true).length;
    const winRate = wins / settled.length;
    let totalCost = 0, totalReturn = 0;
    for (const p of settled) {
      const cost = parseFloat(p.initialValue || p.size || 0);
      const ret = parseFloat(p.currentValue || p.cashPnl || 0) + cost;
      totalCost += cost; totalReturn += ret;
    }
    const roi = totalCost > 0 ? (totalReturn - totalCost) / totalCost : 0;
    const totalVolume = positions.reduce((s, p) => s + parseFloat(p.initialValue || p.size || 0), 0);
    const grade = winRate >= 0.80 ? "🔥 SHARP" : winRate >= 0.65 ? "👀 WATCH" : "CASUAL";
    return { address, winRate, totalTrades: settled.length, totalVolume, roi, grade };
  } catch { return null; }
}

async function getLineMove(conditionId) {
  try {
    const r = await fetch(`${CLOB}/prices-history?market=${conditionId}&interval=1h&fidelity=1`);
    if (!r.ok) return "N/A";
    const data = await r.json();
    const history = data.history || [];
    if (history.length < 2) return "N/A";
    const prev = parseFloat(history[history.length - 2]?.p || 0);
    const curr = parseFloat(history[history.length - 1]?.p || 0);
    if (prev <= 0) return "N/A";
    const pct = ((curr - prev) / prev * 100).toFixed(1);
    return `${pct > 0 ? "+" : ""}${pct}% (1h)`;
  } catch { return "N/A"; }
}

async function sendDiscordAlert(market, trade, wallet, lineMove) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;
  const winPct = (wallet.winRate * 100).toFixed(0);
  const roiPct = (wallet.roi * 100).toFixed(1);
  const roiStr = wallet.roi > 0 ? `+${roiPct}%` : `${roiPct}%`;
  const side = (trade.side || "BUY").toUpperCase() === "BUY" ? "YES ✅" : "NO ❌";
  const size = Math.round(parseFloat(trade.size || trade.matched_amount || 0));
  const price = parseFloat(trade.price || 0);
  const conditionId = market.conditionId || market.condition_id;
  const walletShort = wallet.address.slice(0,8) + "..." + wallet.address.slice(-4);
  const embed = {
    title: `🐋 ${wallet.grade} WALLET ALERT`,
    description: `**${market.question || market.title || "Market"}**`,
    color: wallet.winRate >= 0.80 ? 0x00C48C : 0xF5A623,
    fields: [
      { name: "📊 TRADE", value: [`**Side:** ${side}`,`**Size:** $${size.toLocaleString()}`,`**Implied:** ${(price*100).toFixed(1)}%`,`**Line Δ:** ${lineMove}`].join("\n"), inline: true },
      { name: "🎯 WALLET", value: [`**Win rate:** ${winPct}%`,`**Trades:** ${wallet.totalTrades}`,`**ROI:** ${roiStr}`,`\`${walletShort}\``].join("\n"), inline: true },
      { name: "🔗 RESEARCH", value: `[Market](https://polymarket.com/event/${conditionId})  ·  [Wallet](https://polymarket.com/profile/${wallet.address})`, inline: false },
    ],
    footer: { text: `PolyWhale · ${new Date().toUTCString()}` },
    timestamp: new Date().toISOString(),
  };
  try {
    const r = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embeds: [embed] }) });
    return r.ok;
  } catch { return false; }
}

const seenTradeIds = new Set();

export default async function handler(req, res) {
  const MIN_SIZE = parseFloat(process.env.MIN_SIZE || "500");
  const MIN_WIN_RATE = parseFloat(process.env.MIN_WIN_RATE || "0.60");
  const MIN_TRADES = parseInt(process.env.MIN_TRADES || "3");

  try {
    const markets = await fetchSportsMarkets();
    console.log(`[scan] ${markets.length} sports markets`);

    const fired = [];
    const walletCache = {};
    let totalTrades = 0, passedSize = 0, passedWallet = 0;

    for (const market of markets) {
      const trades = await fetchRecentTrades(market);
      totalTrades += trades.length;

      for (const trade of trades) {
        const tradeId = trade.id || trade.transactionHash;
        if (!tradeId || seenTradeIds.has(tradeId)) continue;
        seenTradeIds.add(tradeId);

        const size = parseFloat(trade.size || trade.matched_amount || 0);
        if (size < MIN_SIZE) continue;
        passedSize++;

        const address = trade.maker_address || trade.taker_address;
        if (!address) continue;

        let score = walletCache[address];
        if (!score) { score = await scoreWallet(address); if (score) walletCache[address] = score; }
        if (!score || score.winRate < MIN_WIN_RATE || score.totalTrades < MIN_TRADES) continue;
        passedWallet++;

        const conditionId = market.conditionId || market.condition_id;
        const lineMove = await getLineMove(conditionId);
        const sent = await sendDiscordAlert(market, trade, score, lineMove);
        fired.push({ market: (market.question||"").slice(0,60), wallet: address.slice(0,10)+"...", winRate: (score.winRate*100).toFixed(0)+"%", size: "$"+size.toLocaleString(), grade: score.grade, sent });
        await new Promise(r => setTimeout(r, 500));
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[scan] trades=${totalTrades} passedSize=${passedSize} passedWallet=${passedWallet} alerts=${fired.length}`);
    if (seenTradeIds.size > 5000) [...seenTradeIds].slice(0,2500).forEach(id => seenTradeIds.delete(id));

    return res.status(200).json({ ok: true, scanned: markets.length, totalTrades, passedSize, passedWallet, alertsFired: fired.length, alerts: fired, ts: new Date().toISOString() });
  } catch (err) {
    console.log("[scan] error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
