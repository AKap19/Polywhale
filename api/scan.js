const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";
const DATA  = "https://data-api.polymarket.com";

export default async function handler(req, res) {
  const MIN_SIZE = parseFloat(process.env.MIN_SIZE || "500");
  const MIN_WIN_RATE = parseFloat(process.env.MIN_WIN_RATE || "0.55");
  const MIN_TRADES = parseInt(process.env.MIN_TRADES || "3");

  try {
    // Get top 100 markets by volume
    const r = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false`
    );
    const markets = await r.json();
    console.log(`[scan] ${markets.length} markets`);

    const fired = [];
    const walletCache = {};
    let totalTrades = 0, passedSize = 0, passedWallet = 0;

    for (const market of markets) {
      // Get token IDs from market
      let tokenIds = [];
      if (market.clobTokenIds) {
        tokenIds = typeof market.clobTokenIds === "string"
          ? JSON.parse(market.clobTokenIds)
          : market.clobTokenIds;
      }

      for (const tokenId of tokenIds) {
        let trades = [];
        try {
          const tr = await fetch(`${CLOB}/trades?token_id=${tokenId}&limit=20`);
          if (tr.ok) {
            const td = await tr.json();
            trades = td.data || [];
            if (trades.length > 0) console.log(`[trades] ${market.question?.slice(0,30)}: ${trades.length}`);
          }
        } catch {}

        totalTrades += trades.length;

        for (const trade of trades) {
          const size = parseFloat(trade.size || 0);
          if (size < MIN_SIZE) continue;
          passedSize++;

          const address = trade.maker_address || trade.taker_address || trade.trader;
          if (!address) continue;

          let score = walletCache[address];
          if (!score) {
            try {
              const wr = await fetch(`${DATA}/activity?user=${address}&limit=100`);
              if (wr.ok) {
                const wd = await wr.json();
                const activity = Array.isArray(wd) ? wd : (wd.data || []);
                if (activity.length >= MIN_TRADES) {
                  const wins = activity.filter(a => parseFloat(a.cashPnl || 0) > 0).length;
                  const winRate = wins / activity.length;
                  const totalVolume = activity.reduce((s,a) => s + parseFloat(a.size || 0), 0);
                  const grade = winRate >= 0.80 ? "🔥 SHARP" : winRate >= 0.65 ? "👀 WATCH" : "CASUAL";
                  score = { address, winRate, totalTrades: activity.length, totalVolume, grade };
                  walletCache[address] = score;
                  console.log(`wallet ${address.slice(0,8)}: ${(winRate*100).toFixed(0)}% (${activity.length} trades)`);
                }
              }
            } catch {}
          }

          if (!score || score.winRate < MIN_WIN_RATE) continue;
          passedWallet++;

          // Send Discord alert
          const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
          let sent = false;
          if (webhookUrl) {
            const side = (trade.side||"BUY").toUpperCase() === "BUY" ? "YES ✅" : "NO ❌";
            const condId = market.conditionId || market.condition_id;
            const embed = {
              title: `🐋 ${score.grade} WALLET ALERT`,
              description: `**${market.question || "Market"}**`,
              color: score.winRate >= 0.80 ? 0x00C48C : 0xF5A623,
              fields: [
                { name: "📊 TRADE", value: [`**Side:** ${side}`, `**Size:** $${Math.round(size).toLocaleString()}`, `**Implied:** ${(parseFloat(trade.price||0)*100).toFixed(1)}%`].join("\n"), inline: true },
                { name: "🎯 WALLET", value: [`**Win rate:** ${(score.winRate*100).toFixed(0)}%`, `**Trades:** ${score.totalTrades}`, `\`${address.slice(0,8)}...${address.slice(-4)}\``].join("\n"), inline: true },
                { name: "🔗 RESEARCH", value: `[Market](https://polymarket.com/event/${condId})  ·  [Wallet](https://polymarket.com/profile/${address})`, inline: false },
              ],
              footer: { text: `PolyWhale · ${new Date().toUTCString()}` },
              timestamp: new Date().toISOString(),
            };
            try {
              const dr = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embeds: [embed] }) });
              sent = dr.ok;
              console.log(`discord: ${dr.status}`);
            } catch(e) { console.log("discord err:", e.message); }
          }

          fired.push({ market: (market.question||"").slice(0,50), wallet: address.slice(0,10)+"...", winRate: (score.winRate*100).toFixed(0)+"%", size: "$"+Math.round(size).toLocaleString(), grade: score.grade, sent });
          await new Promise(r => setTimeout(r, 300));
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[scan] trades=${totalTrades} passedSize=${passedSize} passedWallet=${passedWallet} alerts=${fired.length}`);
    return res.status(200).json({ ok: true, scanned: markets.length, totalTrades, passedSize, passedWallet, alertsFired: fired.length, alerts: fired });

  } catch(err) {
    console.log("[scan] error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
