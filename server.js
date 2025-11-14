import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// Load Firebase service account
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://affinityhub-pro.firebaseio.com",
});

const db = admin.firestore();

// OFFERWALL S2S POSTBACK
app.post("/api/offerwall-postback", async (req, res) => {
  try {
    const { user_id, reward, transaction_id, status } = req.body;

    console.log("📥 Postback received:", {
      user_id,
      reward,
      transaction_id,
      status,
    });

    if (!user_id || !reward || !transaction_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (status !== "completed" && status !== "approved") {
      return res.status(200).json({
        success: true,
        message: "Postback received but status not approved",
      });
    }

    // Check if user exists
    const userRef = db.collection("users").doc(user_id);
    const userSnap = await userRef.get();

    if (!userSnap.exists()) {
      console.warn(`⚠️ User ${user_id} not found`);
      return res.status(404).json({ error: "User not found" });
    }

    // Prevent duplicate transactions
    const txRef = db.collection("offerwall_transactions").doc(transaction_id);
    const txSnap = await txRef.get();

    if (txSnap.exists()) {
      return res.status(200).json({
        success: true,
        message: "Transaction already processed",
        transaction_id,
      });
    }

    // Save transaction
    await txRef.set({
      user_id,
      reward: parseFloat(reward),
      status,
      received_at: new Date(),
      postback_payload: req.body,
    });

    // Credit user
    const currentBalance = userSnap.data().balance || 0;
    const newBalance = currentBalance + parseFloat(reward);

    await userRef.update({
      balance: newBalance,
      lastOfferwallReward: new Date(),
      totalEarnings: admin.firestore.FieldValue.increment(
        parseFloat(reward)
      ),
    });

    console.log(
      `✅ Credited user ${user_id} +Ksh ${reward} (new balance: ${newBalance})`
    );

    return res.status(200).json({
      success: true,
      message: "Reward credited successfully",
      user_id,
      amount: reward,
      transaction_id,
      new_balance: newBalance,
    });
  } catch (error) {
    console.error("❌ Postback error:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// TEST ENDPOINT
app.post("/api/test-postback", async (req, res) => {
  try {
    const testPayload = {
      user_id: req.body.user_id || "test_user_123",
      reward: 10.5,
      transaction_id: `test_${Date.now()}`,
      status: "completed",
    };

    return res.json({
      test: true,
      message: "Test OK. Use /api/offerwall-postback in live environment.",
      payload: testPayload,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Postback URL: https://your-domain.com/api/offerwall-postback`);
});
