// api/scan.js
// Runs every 5 minutes via Vercel cron
// Scans all Polymarket sports markets for sharp wallet activity

import {
  fetchSportsMarkets,
  fetchRecentTrades,
  scoreWallet,
  buildTradeContext,
} from "../lib/polymarket.js";
import { sendDiscordAlert } from "../lib/discord.js";

const MIN_SIZE     = parseInt(process.env.MIN_SIZE      || "1000");
const MIN_WIN_RATE = parseFloat(process.env.MIN_WIN_RATE || "0.65");
const MIN_TRADES   = parseInt(process.env.MIN_TRADES    || "10");

// Dedup trades within a server instance lifetime
const seenTradeIds = new Set();

export default async function handler(req, res) {
  console.log(`[polywhale] Scan at ${new Date().toISOString()}`);

  try {
    const markets = await fetchSportsMarkets();
    console.log(`[polywhale] ${markets.length} sports markets found`);

    const fired    = [];
    const walletCache = {};

    for (const market of markets) {
      const conditionId = market.conditionId || market.condition_id;
      if (!conditionId) continue;

      const trades = await fetchRecentTrades(conditionId);

      for (const trade of trades) {
        // Dedup
        const tradeId = trade.id || trade.transactionHash;
        if (!tradeId || seenTradeIds.has(tradeId)) continue;
        seenTradeIds.add(tradeId);

        // Size filter
        const size = parseFloat(trade.size || trade.matched_amount || 0);
        if (size < MIN_SIZE) continue;

        // Wallet address
        const address = trade.maker_address || trade.taker_address;
        if (!address) continue;

        // Score wallet (cached)
        let score = walletCache[address];
        if (!score) {
          score = await scoreWallet(address);
          if (score) walletCache[address] = score;
        }
        if (!score) continue;

        // Win rate + trade count filter
        if (score.winRate < MIN_WIN_RATE) continue;
        if (score.totalTrades < MIN_TRADES) continue;

        // Build context + send alert
        const ctx = await buildTradeContext(trade, market, score);
        const sent = await sendDiscordAlert(ctx);

        fired.push({
          market: ctx.market.question,
          wallet: address.slice(0, 10) + "...",
          winRate: (score.winRate * 100).toFixed(0) + "%",
          size: "$" + size.toLocaleString(),
          grade: score.grade,
          sent,
        });

        console.log(
          `[polywhale] Alert fired: ${score.grade} | $${size} | ${ctx.market.question.slice(0, 50)}`
        );

        // Small delay between alerts to avoid Discord rate limits
        await new Promise(r => setTimeout(r, 500));
      }

      // Polite delay between markets
      await new Promise(r => setTimeout(r, 150));
    }

    // Trim seen set
    if (seenTradeIds.size > 5000) {
      [...seenTradeIds].slice(0, 2500).forEach(id => seenTradeIds.delete(id));
    }

    return res.status(200).json({
      ok: true,
      scanned: markets.length,
      alertsFired: fired.length,
      alerts: fired,
      ts: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[polywhale] Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
