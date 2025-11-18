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
  process.exit(1); 
}

const db = admin.firestore();

// ===================================
// --- OFFERWALL CONFIGURATIONS ---
// ===================================

// TimeWall
const TIMEWALL_SECRET_KEY = '4814741521aa9dd43b2e77f161e01556';
const TIMEWALL_TRANSACTIONS_COLLECTION = "timewall_transactions";
const TIMEWALL_ALLOWED_IPS = ['51.81.120.73', '142.111.248.18'];

// CPX-Research (⚠️ MUST BE CONFIGURED)
const CPX_SECRET_KEY = 'LZACawLFjUVcokjwAs6cC9yQ20o1UuXT'; 
const CPX_TRANSACTIONS_COLLECTION = "cpx_transactions";
// ⚠️ REPLACE these placeholder IPs with the official IPs provided by CPX-Research
const CPX_ALLOWED_IPS = ['188.40.3.73', '157.90.97.92']; 


// ======================
// ROOT / DOMAIN CHECK
// ======================
app.get("/", (req, res) => {
  res.send("<h1>HustlerHub backend live</h1>");
});

// =============================================
// OFFERWALL S2S POSTBACK — GENERIC POST HANDLER 
// =============================================

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
    if (txSnap.exists) {
      console.log(`⚠️ Transaction ${transaction_id} already processed`);
      return res.status(200).json({ success: true, message: "Duplicate transaction ignored" });
    }

    // Save transaction
    const rewardAmount = parseFloat(reward);
    await transactionRef.set({
      user_id,
      reward: rewardAmount,
      status,
      received_at: new Date(),
      postback_payload: req.body,
    });

    // Credit user balance
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(rewardAmount),
      lastOfferwallReward: new Date(),
      totalEarnings: admin.firestore.FieldValue.increment(rewardAmount),
    });

    console.log(`✅ Credited user ${user_id} +${reward} (Generic Offerwall)`);

    return res.status(200).json({
      success: true,
      message: "Reward credited successfully",
      user_id,
      amount: reward,
    });
  } catch (error) {
    console.error("❌ Postback error:", error);
    return res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

// =============================================
// TIMEWALL POSTBACK — SECURE GET HANDLER
// =============================================

app.get("/api/timewall-postback", async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.ip;

    // 1. IP WHITELISTING CHECK
    if (!TIMEWALL_ALLOWED_IPS.includes(clientIp)) {
        console.warn(`[SECURITY VIOLATION] IP ${clientIp} not whitelisted for TimeWall postback.`);
        return res.status(403).send('Forbidden');
    }

    const { userID, transactionID, revenue, currencyAmount, hash, type } = req.query;
    console.log("📥 TimeWall Postback received:", req.query);

    // 2. Basic Validation
    if (!userID || !transactionID || !revenue || !currencyAmount || !hash || !type) {
        console.error('TimeWall Postback: Missing required query parameters.');
        return res.status(400).send('Missing Parameter');
    }

    // 3. Hash Verification
    const hashString = `${userID}${revenue}${TIMEWALL_SECRET_KEY}`;
    const localHash = crypto.createHash('sha256').update(hashString).digest('hex');
    
    if (localHash !== hash) {
        console.warn(`[TIMEWALL SECURITY] Hash mismatch for TXN: ${transactionID}.`);
        return res.status(403).send('Hash Mismatch');
    }

    const amount = parseFloat(currencyAmount);

    // 4. Prevent duplicate and process transaction
    const transactionRef = db.collection(TIMEWALL_TRANSACTIONS_COLLECTION).doc(transactionID);
    const userRef = db.collection("users").doc(userID);

    try {
        await db.runTransaction(async (t) => {
            const userSnap = await t.get(userRef);
            const txSnap = await t.get(transactionRef);

            if (!userSnap.exists()) {
                throw new Error("User Not Found");
            }

            if (txSnap.exists) {
                console.log(`⚠️ TimeWall TXN ${transactionID} already processed.`);
                return; // Exit transaction gracefully
            }
            
            // Record transaction
            t.set(transactionRef, {
                userID: userID,
                amount: amount, 
                type: type,
                received_at: new Date(),
                postback_payload: req.query,
            });

            // Update user balance
            t.update(userRef, { 
                balance: admin.firestore.FieldValue.increment(amount),
                lastOfferwallReward: new Date(),
                totalEarnings: admin.firestore.FieldValue.increment(amount)
            });
        });

        const action = amount > 0 ? 'Credited' : 'Chargeback';
        console.log(`✅ TimeWall TXN ${transactionID} (${action}) for ${userID}. Amount: ${amount}.`);
        
        return res.status(200).send('OK');

    } catch (error) {
        if (error.message === "User Not Found") {
            return res.status(500).send('User Not Found');
        }
        console.error("❌ TimeWall Postback Transaction Error:", error);
        return res.status(500).send('Internal Server Error');
    }
});


// =============================================
// CPX-RESEARCH POSTBACK — SECURE GET HANDLER (FIXED)
// =============================================

app.get("/api/cpx-postback", async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.ip;

    // 1. IP WHITELISTING CHECK
    if (!CPX_ALLOWED_IPS.includes(clientIp)) {
        console.warn(`[SECURITY VIOLATION] IP ${clientIp} not whitelisted for CPX postback.`);
        return res.status(403).send('ERROR: ip not whitelisted'); // CPX specific error format
    }

    // FIX: Added 'amount_usd' to match CPX requirement
    const { user_id, trans_id, amount_local, amount_usd, hash, status } = req.query;
    console.log("📥 CPX Postback received:", req.query);

    // 2. Basic Validation - now validating for amount_usd as required
    if (!user_id || !trans_id || !amount_local || !amount_usd || !hash || !status) {
        console.error('CPX Postback: Missing required query parameters. Check if all macros are set.');
        return res.status(400).send('ERROR: missing parameters');
    }
    
    // 3. Signature Hash Verification (CRITICAL)
    const rawAmount = parseFloat(amount_local).toFixed(2); // Use amount_local now
    // ⚠️ IMPORTANT: Verify this hash string format with CPX documentation.
    const hashString = `${trans_id}:${user_id}:${rawAmount}:${status}:${CPX_SECRET_KEY}`; 
    const localHash = crypto.createHash('sha256').update(hashString).digest('hex');

    // FIX: Checking against 'hash' instead of 'signature'
    if (localHash !== hash) {
        console.warn(`[CPX SECURITY] Signature mismatch for TXN: ${trans_id}. Hash String: ${hashString}`);
        return res.status(403).send('ERROR: signature mismatch');
    }

    const isApproved = status === '1';
    const amount = parseFloat(amount_local); // Use amount_local for calculation
    const finalAmount = isApproved ? amount : -amount; // Credit (1) or Chargeback/Rejection (2)

    // Only process approved transactions and chargebacks
    if (!isApproved && status !== '2') {
        console.log(`CPX TXN ${trans_id}: Status (${status}) is passive. Ignoring.`);
        return res.status(200).send('OK'); // Return OK for status we don't handle (e.g., pending)
    }

    // 4. Prevent duplicate and process transaction
    const transactionRef = db.collection(CPX_TRANSACTIONS_COLLECTION).doc(trans_id);
    const userRef = db.collection("users").doc(user_id);

    try {
        await db.runTransaction(async (t) => {
            const userSnap = await t.get(userRef);
            const txSnap = await t.get(transactionRef);

            if (!userSnap.exists()) {
                throw new Error("User Not Found");
            }
            
            // Only skip if it's a duplicate approval (status=1). We must process chargebacks (status=2)
            if (txSnap.exists && isApproved) {
                console.log(`⚠️ CPX TXN ${trans_id} already processed (Approved).`);
                return; // Exit transaction gracefully
            }
            
            // Record transaction - including amount_usd for record-keeping
            t.set(transactionRef, {
                userID: user_id,
                amount: finalAmount, 
                amountUSD: parseFloat(amount_usd), // Storing USD amount
                status: status,
                received_at: new Date(),
                postback_payload: req.query,
            }, { merge: true }); // Use merge to allow updating a previous record (e.g., pending -> approved)

            // Update user balance
            t.update(userRef, { 
                balance: admin.firestore.FieldValue.increment(finalAmount),
                lastOfferwallReward: new Date(),
                totalEarnings: admin.firestore.FieldValue.increment(finalAmount)
            });
        });

        const action = isApproved ? 'Credited' : 'Chargeback/Debited';
        console.log(`✅ CPX TXN ${trans_id} (${action}) for ${user_id}. Amount: ${finalAmount}.`);
        
        return res.status(200).send('OK'); // CPX requires the string 'OK' on success

    } catch (error) {
        if (error.message === "User Not Found") {
            return res.status(500).send('ERROR: user not found'); 
        }
        console.error("❌ CPX Postback Transaction Error:", error);
        return res.status(500).send('ERROR: internal server error');
    }
});


// ======================
// HEALTH CHECK
// ======================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// ======================
// START SERVER
// ======================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`📍 OFFERWALL POSTBACK URL: /api/offerwall-postback`);
  console.log(`📍 TIMEWALL POSTBACK URL: /api/timewall-postback`);
  console.log(`📍 CPX-RESEARCH POSTBACK URL: /api/cpx-postback`);
  console.log(`📍 HEALTH CHECK: /api/health`);
});
