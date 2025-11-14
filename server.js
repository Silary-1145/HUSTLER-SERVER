import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// Needed to work with file paths in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase service account key
const serviceAccount = JSON.parse(
  fs.readFileSync(path.join(__dirname, "serviceAccountKey.json"), "utf8")
);

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://affinityhub-pro.firebaseio.com",
});

const db = admin.firestore();

// ======================
// ROOT / DOMAIN CHECK
// ======================
app.get("/", (req, res) => {
  res.send("<h1>HustlerHub backend live</h1>");
});

// =============================================
// OFFERWALL S2S POSTBACK — GET & POST
// =============================================

// ✔ GET: domain verification
app.get("/api/offerwall-postback", async (req, res) => {
  console.log("📥 GET Postback received:", req.query);
  return res.status(200).send("OK");
});

// ✔ POST: handle real postback
app.post("/api/offerwall-postback", async (req, res) => {
  try {
    const { user_id, reward, transaction_id, status } = req.body;

    console.log("📥 POST Postback received:", { user_id, reward, transaction_id, status });

    // Validate fields
    if (!user_id || !reward || !transaction_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Only process approved/completed offers
    if (status !== "completed" && status !== "approved") {
      return res.status(200).json({
        success: true,
        message: "Postback received but status inactive",
      });
    }

    // Check if user exists
    const userRef = db.collection("users").doc(user_id);
    const userSnap = await userRef.get();
    if (!userSnap.exists()) {
      console.warn(`⚠️ User ${user_id} not found in Firebase`);
      return res.status(404).json({ error: "User not found" });
    }

    // Check duplicate transaction
    const transactionRef = db.collection("offerwall_transactions").doc(transaction_id);
    const txSnap = await transactionRef.get();
    if (txSnap.exists()) {
      console.log(`⚠️ Transaction ${transaction_id} already processed`);
      return res.status(200).json({ success: true, message: "Duplicate transaction ignored" });
    }

    // Save transaction
    await transactionRef.set({
      user_id,
      reward: parseFloat(reward),
      status,
      received_at: new Date(),
      postback_payload: req.body,
    });

    // Credit user balance
    const currentBalance = userSnap.data().balance || 0;
    const newBalance = currentBalance + parseFloat(reward);

    await userRef.update({
      balance: newBalance,
      lastOfferwallReward: new Date(),
      totalEarnings: admin.firestore.FieldValue.increment(parseFloat(reward)),
    });

    console.log(`✅ Credited user ${user_id} +${reward} → new balance = ${newBalance}`);

    return res.status(200).json({
      success: true,
      message: "Reward credited successfully",
      user_id,
      amount: reward,
      new_balance: newBalance,
    });
  } catch (error) {
    console.error("❌ Postback error:", error);
    return res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

// ======================
// HEALTH CHECK
// ======================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// ======================
// TEST POSTBACK
// ======================
app.post("/api/test-postback", async (req, res) => {
  try {
    return res.json({
      test: true,
      message: "This is a test endpoint only.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ======================
// START SERVER
// ======================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`📍 POSTBACK URL: https://www.hustlerhub.website/api/offerwall-postback`);
  console.log(`📍 HEALTH CHECK: https://www.hustlerhub.website/api/health`);
});
