/* POST /api/translate — proxy free MyMemory for CORS-safe TTS translation.
   Body: { q, source?, target? }  →  { translatedText }
   No API keys. Subject to MyMemory public rate limits. */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    var body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    var q = String(body.q || "").trim().slice(0, 450);
    var source = String(body.source || "en").split("-")[0].toLowerCase();
    var target = String(body.target || "en").split("-")[0].toLowerCase();
    if (!q) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing q" }));
    }
    if (source === target) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ translatedText: q }));
    }

    var url =
      "https://api.mymemory.translated.net/get?q=" +
      encodeURIComponent(q) +
      "&langpair=" +
      encodeURIComponent(source + "|" + target);
    var upstream = await fetch(url);
    var data = await upstream.json();
    var out = data && data.responseData && data.responseData.translatedText;
    if (!out || /MYMEMORY WARNING/i.test(out)) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "Upstream translate failed", detail: data && data.responseDetails }));
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ translatedText: String(out) }));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err && err.message ? err.message : "translate error" }));
  }
};
