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
    const keywords = ["nba","mlb","nfl","nhl","ufc","mma","tennis","golf","soccer","boxing","playoff","championship","series","match","game","fight","world series","home run"];
    const sports = data.filter(m => {
      const q = (m.question || m.title || "").toLowerCase();
      const tags = (m.tags || []).map(t => (t.label || t.slug || "").toLowerCase()).join(" ");
      return keywords.some(k => q.includes(k) || tags.includes(k));
    });
    console.log(`[markets] total=${data.length} sports=${sports.length}`);
    return sports;
  } catch(e) {
    console.log("markets error:", e.message);
    return [];
  }
}

async function fetchTradesForMarket(market) {
  const trades = [];
  try {
    // Get clobTokenIds from market object
    let tokenIds = [];
    if (market.clobTokenIds) {
      tokenIds = typeof market.clobTokenIds === "string"
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
    }
    // Fetch trades for each token
    for (const tokenId of tokenIds) {
      const r = await fetch(`${CLOB}/trades?token_id=${tokenId}&limit=20`);
      if (!r.ok) continue;
      const d = await r.json();
      if (d.data && d.data.length > 0) {
        trades.push(...d.data);
        console.log(`[trades] token ${String(tokenId).slice(0,10)}: ${d.data.length} trades`);
      }
    }
  } catch(e) {
    console.log("fetchTrades error:", e.message);
  }
  return trades;
}

async function scoreWallet(address) {
  try {
    // Use Data API for user trade history
    const r = await fetch(
      `${DATA}/activity?user=${address}&limit=100`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    if (!r.ok) {
      console.log(`wallet ${address.slice(0,8)} HTTP ${r.status}`);
      return null;
    }
    const data = await r.json();
    const activity = Array.isArray(data) ? data : (data.data || data.activity || []);
    console.log(`wallet ${address.slice(0,8)}: ${activity.length} activity records`);
    if (activity.length < 3) return null;

    // Score based on redeemed/winning positions
    const settled = activity.filter(a => a.type === "REDEEM" || a.redeemed === true || a.outcome != null);
    const wins = settled.filter(a => a.winner === true || a.redeemed === true || (a.cashPnl && parseFloat(a.cashPnl) > 0)).length;
    const totalTrades = Math.max(settled.length, 1);
    const winRate = wins / totalTrades;

    const totalVolume = activity.reduce((s, a) => s + parseFloat(a.size || a.amount || 0), 0);
    const grade = winRate >= 0.80 ? "🔥 SHARP" : winRate >= 0.65 ? "👀 WATCH" : "CASUAL";

    return { address, winRate, totalTrades, totalVolume, roi: 0, grade };
  } catch(e) {
    console.log("scoreWallet error:", e.message);
    return null;
  }
}

async function sendDiscordAlert(market, trade, wallet, lineMove) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) { console.log("no webhook url"); return false; }
  const winPct = (wallet.winRate * 100).toFixed(0);
  const side = (trade.side || "BUY").toUpperCase() === "BUY" ? "YES ✅" : "NO ❌";
  const size = Math.round(parseFloat(trade.size || 0));
  const price = parseFloat(trade.price || 0);
  const conditionId = market.conditionId || market.condition_id;
  const walletShort = wallet.address.slice(0,8) + "..." + wallet.address.slice(-4);
  const embed = {
    title: `🐋 ${wallet.grade} WALLET ALERT`,
    description: `**${market.question || market.title || "Market"}**`,
    color: wallet.winRate >= 0.80 ? 0x00C48C : 0xF5A623,
    fields: [
      { name: "📊 TRADE", value: [`**Side:** ${side}`, `**Size:** $${size.toLocaleString()}`, `**Implied:** ${(price*100).toFixed(1)}%`, `**Line Δ:** ${lineMove}`].join("\n"), inline: true },
      { name: "🎯 WALLET", value: [`**Win rate:** ${winPct}%`, `**Trades:** ${wallet.totalTrades}`, `**Volume:** $${Math.round(wallet.totalVolume).toLocaleString()}`, `\`${walletShort}\``].join("\n"), inline: true },
      { name: "🔗 RESEARCH", value: `[Market](https://polymarket.com/event/${conditionId})  ·  [Wallet](https://polymarket.com/profile/${wallet.address})`, inline: false },
    ],
    footer: { text: `PolyWhale · ${new Date().toUTCString()}` },
    timestamp: new Date().toISOString(),
  };
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    console.log("discord webhook status:", r.status);
    return r.ok;
  } catch(e) {
    console.log("discord error:", e.message);
    return false;
  }
}

const seenTradeIds = new Set();

export default async function handler(req, res) {
  const MIN_SIZE = parseFloat(process.env.MIN_SIZE || "500");
  const MIN_WIN_RATE = parseFloat(process.env.MIN_WIN_RATE || "0.55");
  const MIN_TRADES = parseInt(process.env.MIN_TRADES || "3");

  try {
    const markets = await fetchSportsMarkets();
    console.log(`[scan] ${markets.length} sports markets`);

    const fired = [];
    const walletCache = {};
    let totalTrades = 0, passedSize = 0, passedWallet = 0;

    for (const market of markets) {
      const trades = await fetchTradesForMarket(market);
      totalTrades += trades.length;

      for (const trade of trades) {
        const tradeId = trade.id || trade.transactionHash;
        if (!tradeId || seenTradeIds.has(tradeId)) continue;
        seenTradeIds.add(tradeId);

        const size = parseFloat(trade.size || 0);
        if (size < MIN_SIZE) continue;
        passedSize++;

        const address = trade.maker_address || trade.taker_address || trade.trader;
        if (!address) continue;

        let score = walletCache[address];
        if (!score) {
          score = await scoreWallet(address);
          if (score) walletCache[address] = score;
        }
        if (!score || score.winRate < MIN_WIN_RATE || score.totalTrades < MIN_TRADES) continue;
        passedWallet++;

        const lineMove = "N/A";
        const sent = await sendDiscordAlert(market, trade, score, lineMove);
        fired.push({
          market: (market.question || "").slice(0, 60),
          wallet: address.slice(0, 10) + "...",
          winRate: (score.winRate * 100).toFixed(0) + "%",
          size: "$" + size.toLocaleString(),
          grade: score.grade,
          sent,
        });
        await new Promise(r => setTimeout(r, 500));
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[scan] trades=${totalTrades} passedSize=${passedSize} passedWallet=${passedWallet} alerts=${fired.length}`);
    if (seenTradeIds.size > 5000) [...seenTradeIds].slice(0, 2500).forEach(id => seenTradeIds.delete(id));

    return res.status(200).json({
      ok: true, scanned: markets.length, totalTrades,
      passedSize, passedWallet, alertsFired: fired.length,
      alerts: fired, ts: new Date().toISOString(),
    });
  } catch(err) {
    console.log("[scan] error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
