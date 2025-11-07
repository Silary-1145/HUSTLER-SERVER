import express from "express";
import fetch from "node-fetch";
import md5 from "md5";
import cors from "cors";

const app = express();
app.use(cors());

// ⚠️ Your actual Banggood credentials (safe only for local/private use)
const APP_KEY = "aff690e12c32554";
const APP_SECRET = "940a5c164130147dac439db121423370";

// ✅ Optional root route for testing
app.get("/", (req, res) => {
  res.send("✅ Hustler Server is running! Try /api/products");
});

// 🔒 Signature generator (required by Banggood API)
function generateSign(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return md5(sorted + secret);
}

// 🧠 Product fetch route
app.get("/api/products", async (req, res) => {
  try {
    const { page = 1, category_id = 44, keyword = "" } = req.query;

    const params = {
      api_key: APP_KEY,
      lang: "en",
      currency: "USD",
      page,
      category_id,
    };

    if (keyword) params.keyword = keyword;

    const sign = generateSign(params, APP_SECRET);
    const query = new URLSearchParams({ ...params, api_signature: sign }).toString();

    const response = await fetch(`https://api.banggood.com/getProductList.html?${query}`);
    const text = await response.text();

    // Some Banggood endpoints return HTML errors — handle that safely
    try {
      const data = JSON.parse(text);
      res.json(data);
    } catch {
      console.error("⚠️ Banggood returned invalid JSON:", text.slice(0, 200));
      res.status(500).json({ error: "Banggood API returned invalid JSON" });
    }
  } catch (err) {
    console.error("🔥 Server Error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
