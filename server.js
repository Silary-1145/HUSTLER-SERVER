import express from "express";
import fetch from "node-fetch";
import md5 from "md5";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config(); // Load .env variables

const app = express();
app.use(cors());

const APP_KEY = process.env.BG_aff690e12c32554;
const APP_SECRET = process.env.BG_940a5c164130147dac439db121423370;

function generateSign(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return md5(sorted + secret);
}

app.get("/api/products", async (req, res) => {
  try {
    const params = {
      api_key: APP_KEY,
      lang: "en",
      currency: "USD",
      page: 1,
      category_id: 44,
    };

    const sign = generateSign(params, APP_SECRET);
    const query = new URLSearchParams({ ...params, api_signature: sign }).toString();
    const response = await fetch(`https://api.banggood.com/getProductList.html?${query}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
