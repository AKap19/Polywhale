export default async function handler(req, res) {
  try {
    const r = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10");
    const data = await r.json();
    const count = Array.isArray(data) ? data.length : 0;
    console.log("markets fetched:", count);
    if (count > 0) console.log("first market:", data[0].question);
    return res.status(200).json({ ok: true, count, sample: data[0]?.question });
  } catch(e) {
    console.log("error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
