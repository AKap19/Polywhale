// lib/discord.js
// Sends rich embed alerts to your Discord channel via webhook

export async function sendDiscordAlert(ctx) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("DISCORD_WEBHOOK_URL not set");
    return false;
  }

  const { market, trade, wallet, lineMove, walletUrl } = ctx;
  const winPct  = (wallet.winRate * 100).toFixed(0);
  const roiPct  = (wallet.roi * 100).toFixed(1);
  const roiStr  = roiPct > 0 ? `+${roiPct}%` : `${roiPct}%`;
  const volStr  = `$${Math.round(wallet.totalVolume).toLocaleString()}`;
  const sideEmoji = trade.side === "YES" ? "🟢" : "🔴";

  // Discord embed — shows as a rich card in your channel
  const embed = {
    title: `🐋 ${wallet.grade} WALLET ALERT`,
    description: `**${market.question}**`,
    color: wallet.winRate >= 0.80 ? 0x00C48C   // green for SHARP
         : wallet.winRate >= 0.65 ? 0xF5A623   // amber for WATCH
         : 0x5A6A82,
    fields: [
      {
        name: "TRADE",
        value: [
          `${sideEmoji} **Side:** ${trade.side}`,
          `💰 **Size:** $${trade.size.toLocaleString()}`,
          `📊 **Implied prob:** ${trade.impliedProb}`,
          `📈 **Line move:** ${lineMove}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "WALLET",
        value: [
          `🎯 **Win rate:** ${winPct}% (${wallet.totalTrades} trades)`,
          `💹 **ROI:** ${roiStr}`,
          `🔢 **Volume:** ${volStr}`,
          `\`${wallet.address.slice(0,8)}...${wallet.address.slice(-4)}\``,
        ].join("\n"),
        inline: true,
      },
      {
        name: "RESEARCH",
        value: [
          `[📋 View Market](${market.url})`,
          `[👤 Wallet History](${walletUrl})`,
          `🏷️ ${market.category}`,
        ].join("  ·  "),
        inline: false,
      },
    ],
    footer: {
      text: `PolyWhale Scanner · ${new Date().toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", timeZoneName: "short"
      })}`,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error("Discord webhook error:", err);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Discord fetch error:", err.message);
    return false;
  }
}
