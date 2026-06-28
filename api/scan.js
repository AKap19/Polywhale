export default async function handler(req, res) {
  try {
    // Fetch high-volume markets sorted by activity
    const r = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false"
    );
    const data = await r.json();
    const count = Array.isArray(data) ? data.length : 0;
    // Log first 5 market titles so we can see what we're getting
    const titles = data.slice(0,5).map(m => m.question || m.title);
    console.log("markets:", count);
    console.log("top5:", JSON.stringify(titles));
    return res.status(200).json({ ok: true, count, top5: titles });
  } catch(e) {
    console.log("error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
