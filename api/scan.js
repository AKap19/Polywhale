const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

async function fetchSportsMarkets() {
  const tags = ["sports","nba","mlb","nfl","nhl","soccer","mls","ufc","mma","tennis","golf","boxing"];
  const results = [];
  for (const tag of tags) {
    try {
      const r = await fetch(`${GAMMA}/markets?active=true&closed=false&tag_slug=${tag}&limit=50`);
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data)) results.push(...data);
    } catch { continue; }
  }
  const seen = new Set();
  return results.filter(m => {
    const id = m.conditionId || m.condition_id;
    if (!id || seen.has(id)) return false;
    seen.add(id); return true;
  });
}

async function fetchRecentTrades(conditionId) {
  try {
    const r = await fetch(`${CLOB}/trades?market=${conditionId}&limit=25`);
    if (!r.ok) return [];
    const data = await r.json();
    return data.data || [];
  } catch { return []; }
}

async function scoreWallet(address) {
  try {
    const r = await fetch(`${GAMMA}/positions?user=${address}&limit=200`);
    if (!r.ok) return null;
    const positions = await r.json();
    if (!Array.isArray(positions)) return null;
    const settled = positions.filter(p => p.redeemed === true || p.outcome != null);
    if (settled.length < 10) return null;
    const wins = settled.filter(p => p.winner === true || p.redeemed === true).length;
    const totalTrades = settled.length;
    const winRate = wins / totalTrades;
    let totalCost = 0, totalReturn = 0;
    for (const p of settled) {
      const cost = parseFloat(p.initialValue || p.size || 0);
      const ret  = parseFloat(p.currentValue || p.cashPnl || 0) + cost;
      totalCost += cost; totalReturn += ret;
    }
    const roi = totalCost > 0 ? (totalReturn - totalCost) / totalCost : 0;
    const totalVolume = positions.reduce((s, p) => s + parseFloat(p.initialValue || p.size || 0), 0);
    const grade = winRate >= 0.80 ? "🔥 SHARP" : winRate >= 0.65 ? "👀 WATCH" : "CASUAL";
    return { address, winRate, totalTrades, totalVolume, roi, grade };
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
  const side   = (trade.side || "BUY").toUpperCase() === "BUY" ? "YES ✅" : "NO ❌";
  const size   = Math.round(parseFloat(trade.size || trade.matched_amount || 0));
  const price  = parseFloat(trade.price || 0);
  const conditionId = market.conditionId || market.condition_id;
  const tags   = (market.tags || []).map(t => t.label || t.slug).join(", ") || "Sports";
  const walletShort = wallet.address.slice(0,8) + "..." + wallet.address.slice(-4);
  const embed = {
    title: `🐋 ${wallet.grade} WALLET ALERT`,
    description: `**${market.question || market.title || "Sports Market"}**`,
    color: wallet.winRate >= 0.80 ? 0x00C48C : 0xF5A623,
    fields: [
      { name: "📊 TRADE", value: [`**Side:** ${side}`,`**Size:** $${size.toLocaleString()}`,`**Implied prob:** ${(price*100).toFixed(1)}%`,`**Line move:** ${lineMove}`].join("\n"), inline: true },
      { name: "🎯 WALLET", value: [`**Win rate:** ${winPct}% (${wallet.totalTrades} trades)`,`**ROI:** ${roiStr}`,`**Volume:** $${Math.round(wallet.totalVolume).toLocaleString()}`,`\`${walletShort}\``].join("\n"), inline: true },
      { name: "🔗 RESEARCH", value: [`[View Market](https://polymarket.com/event/${conditionId})`,`[Wallet History](https://polymarket.com/profile/${wallet.address})`,`**Category:** ${tags}`].join("  ·  "), inline: false },
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
  const MIN_SIZE     = parseInt(process.env.MIN_SIZE      || "1000");
  const MIN_WIN_RATE = parseFloat(process.env.MIN_WIN_RATE || "0.65");
  const MIN_TRADES   = parseInt(process.env.MIN_TRADES    || "5");
  try {
    const markets = await fetchSportsMarkets();
    const fired = [];
    const walletCache = {};
    for (const market of markets) {
      const conditionId = market.conditionId || market.condition_id;
      if (!conditionId) continue;
      const trades = await fetchRecentTrades(conditionId);
      for (const trade of trades) {
        const tradeId = trade.id || trade.transactionHash;
        if (!tradeId || seenTradeIds.has(tradeId)) continue;
        seenTradeIds.add(tradeId);
        const size = parseFloat(trade.size || trade.matched_amount || 0);
        if (size < MIN_SIZE) continue;
        const address = trade.maker_address || trade.taker_address;
        if (!address) continue;
        let score = walletCache[address];
        if (!score) { score = await scoreWallet(address); if (score) walletCache[address] = score; }
        if (!score) continue;
        if (score.winRate < MIN_WIN_RATE) continue;
        if (score.totalTrades < MIN_TRADES) continue;
        const lineMove = await getLineMove(conditionId);
        const sent = await sendDiscordAlert(market, trade, score, lineMove);
        fired.push({ market: (market.question||"").slice(0,60), wallet: address.slice(0,10)+"...", winRate: (score.winRate*100).toFixed(0)+"%", size: "$"+size.toLocaleString(), grade: score.grade, sent });
        await new Promise(r => setTimeout(r, 500));
      }
      await new Promise(r => setTimeout(r, 150));
    }
    if (seenTradeIds.size > 5000) [...seenTradeIds].slice(0,2500).forEach(id => seenTradeIds.delete(id));
    return res.status(200).json({ ok: true, scanned: markets.length, alertsFired: fired.length, alerts: fired, ts: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
