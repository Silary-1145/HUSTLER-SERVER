import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto"; // Required for SHA256 hashing

dotenv.config();

// Initialize the Express app
const app = express();
app.use(express.json());
app.use(cors());

// --- CRITICAL CHANGE FOR RENDER/CLOUD DEPLOYMENT ---
// Load Firebase service account key from environment variable.
// RENDER NOTE: You must set FIREBASE_SA_KEY_JSON as an environment variable in Render.
try {
  if (!process.env.FIREBASE_SA_KEY_JSON) {
      throw new Error("FIREBASE_SA_KEY_JSON environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SA_KEY_JSON);

  // Initialize Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://affinityhub-pro.firebaseio.com",
  });
} catch (error) {
  console.error("❌ Failed to initialize Firebase Admin SDK:", error.message);
  // Exit if initialization fails, as the server cannot function without DB access
  process.exit(1); 
}

const db = admin.firestore();

// --- TIMEWALL CONFIGURATION ---
const TIMEWALL_SECRET_KEY = '941746ef7e676324fdd4388476c5669b';
const TIMEWALL_TRANSACTIONS_COLLECTION = "timewall_transactions";
// --- END CONFIGURATION ---

// ======================
// ROOT / DOMAIN CHECK
// ======================
app.get("/", (req, res) => {
  res.send("<h1>HustlerHub backend live</h1>");
});

// =============================================
// OFFERWALL S2S POSTBACK — GET & POST (Original Logic)
// =============================================

// ✔ GET: domain verification (Original)
app.get("/api/offerwall-postback", async (req, res) => {
  console.log("📥 GET Postback received:", req.query);
  return res.status(200).send("OK");
});

// ✔ POST: handle real postback (Original)
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

// =============================================
// TIMEWALL POSTBACK — SECURE GET HANDLER (NEW)
// =============================================

app.get("/api/timewall-postback", async (req, res) => {
    // TimeWall sends postbacks via GET request with query parameters (macros)
    const { 
        userID, 
        transactionID, 
        revenue, 
        currencyAmount, 
        hash, 
        type 
    } = req.query;

    console.log("📥 TimeWall Postback received:", req.query);

    // 1. Basic Validation
    if (!userID || !transactionID || !revenue || !currencyAmount || !hash || !type) {
        console.error('TimeWall Postback: Missing required query parameters.');
        return res.status(400).send('Missing Parameter');
    }

    // 2. Hash Verification (Critical Security Check)
    const hashString = `${userID}${revenue}${TIMEWALL_SECRET_KEY}`;
    const localHash = crypto.createHash('sha256').update(hashString).digest('hex');
    
    if (localHash !== hash) {
        console.warn(`[TIMEWALL SECURITY] Hash mismatch for TXN: ${transactionID}. Received: ${hash}, Calculated: ${localHash}.`);
        return res.status(403).send('Hash Mismatch');
    }

    const amount = parseFloat(currencyAmount);

    // 3. Prevent duplicate transactions
    const transactionRef = db.collection(TIMEWALL_TRANSACTIONS_COLLECTION).doc(transactionID);
    const txSnap = await transactionRef.get();

    if (txSnap.exists) {
        console.log(`⚠️ TimeWall TXN ${transactionID} already processed.`);
        return res.status(200).send('OK'); // Return OK so TimeWall doesn't retry
    }

    // 4. Check if user exists
    const userRef = db.collection("users").doc(userID);
    const userSnap = await userRef.get();
    
    if (!userSnap.exists()) {
        console.warn(`⚠️ TimeWall User ${userID} not found in Firebase.`);
        return res.status(500).send('User Not Found'); 
    }

    try {
        await db.runTransaction(async (t) => {
            const currentBalance = userSnap.data().balance || 0;
            const newBalance = currentBalance + amount;

            // 5. Update user balance (Credit or Chargeback)
            t.update(userRef, { 
                balance: newBalance,
                lastOfferwallReward: new Date(),
                totalEarnings: admin.firestore.FieldValue.increment(amount)
            });
            
            // 6. Record transaction (to prevent future duplicates)
            t.set(transactionRef, {
                userID: userID,
                amount: amount, // Positive for credit, negative for chargeback
                type: type,
                received_at: new Date(),
                postback_payload: req.query,
            });
        });

        const action = amount > 0 ? 'Credited' : 'Chargeback';
        console.log(`✅ TimeWall TXN ${transactionID} (${action}) for ${userID}. Amount: ${amount}.`);
        
        // TimeWall expects HTTP 200 OK with the string "OK"
        return res.status(200).send('OK');

    } catch (error) {
        console.error("❌ TimeWall Postback Transaction Error:", error);
        // Return 500 to signal TimeWall to retry
        return res.status(500).send('Internal Server Error');
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
// Use process.env.PORT provided by hosting environment (Render)
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`📍 OFFERWALL POSTBACK URL: /api/offerwall-postback`);
  console.log(`📍 TIMEWALL POSTBACK URL: /api/timewall-postback`);
  console.log(`📍 HEALTH CHECK: /api/health`);
});

