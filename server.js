import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto"; // Required for SHA256 hashing

dotenv.config();

const OFFERWALL_SECRET_KEY = process.env.KIWIWALL_SECRET_KEY;
const OFFERWALL_API_KEY = process.env.KIWIWALL_API_KEY;


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

const OFFERWALL_ALLOWED_IPS = [
  "41.90.172.220",
  "172.69.171.139",
  "10.24.141.154",

  // KiwiWall official IPs
  "34.193.235.172",
  "34.193.183.25",
  "34.193.22.64",
  "52.202.58.121",
  "52.202.36.208",
  "52.202.85.116"
];


const OFFERWALL_TRANSACTIONS_COLLECTION = "offerwall_transactions";

// ======================
// ROOT / DOMAIN CHECK
// ======================
app.get("/", (req, res) => {
  res.send("<h1>HustlerHub backend live</h1>");
});

app.get("/api/test", (req, res) => {
  console.log("🔥 TEST hit:", req.query);
  res.send("Test working!");
});


// =============================================
// OFFERWALL S2S POSTBACK — GENERIC POST HANDLER 
// =============================================

// ✔ POST: handle real postback (Original)
app.post("/api/offerwall-postback", async (req, res) => {
  try {
    const q = req.body;

    console.log("📥 UNIVERSAL POSTBACK:", q);

    // Auto-detect fields (supports 20+ offerwalls)
    const userId =
      q.user_id || q.uid || q.sub_id || q.player || q.user || q.userid;

    const reward =
      q.reward || q.amount || q.payout || q.credit || q.points || q.value;

    const transactionId =
      q.transaction_id ||
      q.tx_id ||
      q.trans_id ||
      q.oid ||
      q.offer_id ||
      q.event_id;

    const status =
      q.status || q.event || q.state || q.action || "completed";

    // Validate
    if (!userId || !reward || !transactionId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Only approve active statuses
    const approvedStatuses = ["completed", "approved", "1", "success", "ok"];

    const isApproved = approvedStatuses.includes(
      String(status).toLowerCase()
    );

    if (!isApproved) {
      console.log("ℹ️ Ignored passive postback (pending/failed)...");
      return res.status(200).json({ success: true });
    }

    // Check user exists
    const userRef = db.collection("users").doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists()) {
      console.warn(`⚠️ User not found: ${userId}`);
      return res.status(404).json({ error: "User not found" });
    }

    // Check duplicates
    const txRef = db.collection("offerwall_transactions").doc(transactionId);
    const txSnap = await txRef.get();

    if (txSnap.exists) {
      console.log("⚠️ Duplicate ignored.");
      return res.status(200).json({ success: true });
    }

    // Save transaction
    const amount = parseFloat(reward);
    await txRef.set({
      user_id: userId,
      amount,
      status: "completed",
      received_at: new Date(),
      raw: q,
    });

    // Credit user
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(amount),
      totalEarnings: admin.firestore.FieldValue.increment(amount),
      lastOfferwallReward: new Date(),
    });

    console.log(`✅ Credited user ${userId} +${amount}`);

    return res.status(200).json({ success: true, credited: amount });

  } catch (err) {
    console.error("❌ Universal Postback Error:", err);
    return res.status(500).json({ error: "Server error" });
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

// =============================================
// UNIVERSAL OFFERWALL POSTBACK (FIREBASE LOGIC)
// Works with KiwiWall, CPALead, MyLead, OfferToro, etc
// Returns ONLY "1" on success, "0" on failure
// =============================================
app.all("/api/offerwall-postback", async (req, res) => {
    try {
        // 1️⃣ IP Whitelist Check
        const clientIps = (req.headers["x-forwarded-for"] || req.ip)
            .split(",")
            .map(ip => ip.trim());

        const allowed = 
            OFFERWALL_ALLOWED_IPS.length === 0 ||
            clientIps.some(ip => OFFERWALL_ALLOWED_IPS.includes(ip));

        if (!allowed) {
            console.warn(`[SECURITY VIOLATION] IP ${clientIps.join(", ")} NOT whitelisted.`);
            return res.status(403).send("0"); // FAIL
        }

        // 2️⃣ Extract Postback Parameters (GET or POST)
        const params = req.method === "POST" ? req.body : req.query;

// KiwiWall compatibility mapping
let user_id = params.user_id || params.sub_id;     // KiwiWall → sub_id
let tx = params.tx || params.trans_id;             // KiwiWall → trans_id
let reward = params.reward || params.amount;       // KiwiWall → amount
let status = params.status;
let hash = params.hash || params.signature;        // KiwiWall → signature

console.log("📥 OFFERWALL POSTBACK RECEIVED:", params);

// Validate required fields AFTER mapping
if (!user_id || !tx || !reward) {
    console.error("❌ Missing required parameters.");
    return res.status(400).send("0");
}

        const amount = parseFloat(reward);
        if (isNaN(amount) || amount <= 0) {
            console.error("❌ Invalid reward amount.");
            return res.status(400).send("0");
        }

        // 3️⃣ Optional Hash Verification
        if (OFFERWALL_SECRET_KEY && hash) {
            const localHash = crypto.createHash("sha256")
                .update(`${user_id}${reward}${OFFERWALL_SECRET_KEY}`)
                .digest("hex");

            if (localHash !== hash) {
                console.warn(`❌ Hash mismatch for TX = ${tx}`);
                return res.status(403).send("0"); // FAIL
            }
        }

        // 4️⃣ Firestore References
        const userRef = db.collection("users").doc(user_id);
        const transactionRef = db.collection(OFFERWALL_TRANSACTIONS_COLLECTION).doc(tx);

        await db.runTransaction(async (t) => {
            const userSnap = await t.get(userRef);
            const txSnap = await t.get(transactionRef);

            // 5️⃣ Auto-create user if not found
            if (!userSnap.exists) {
                console.log(`⚠ Creating user ${user_id} automatically.`);
                t.set(userRef, {
                    balance: 0,
                    totalEarnings: 0,
                    createdAt: new Date(),
                });
            }

            // 6️⃣ Prevent duplicate TX
            if (txSnap.exists) {
                console.log(`⚠ Duplicate TX ${tx}, ignoring.`);
                return;
            }

            // 7️⃣ Record TX
            t.set(transactionRef, {
                userID: user_id,
                amount: amount,
                status: status || "approved",
                receivedAt: new Date(),
                payload: params,
            });

            // 8️⃣ Update User Balance
            t.update(userRef, {
                balance: admin.firestore.FieldValue.increment(amount),
                totalEarnings: admin.firestore.FieldValue.increment(amount),
                lastReward: new Date(),
            });
        });

        console.log(`✅ TX ${tx} credited: +${amount} to user ${user_id}`);
        return res.status(200).send("1"); // SUCCESS — KiwiWall requires this

    } catch (err) {
        console.error("❌ OFFERWALL POSTBACK ERROR:", err);
        return res.status(500).send("0"); // FAIL
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


















