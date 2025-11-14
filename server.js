const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json'); // Download from Firebase Console

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://affinityhub-pro.firebaseio.com"
});

const db = admin.firestore();

// OfferWall S2S Postback Endpoint
app.post('/api/offerwall-postback', async (req, res) => {
  try {
    const { user_id, reward, transaction_id, status } = req.body;

    console.log('📥 Postback received:', { user_id, reward, transaction_id, status });

    // Validate required fields
    if (!user_id || !reward || !transaction_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Only process completed/approved offers
    if (status !== 'completed' && status !== 'approved') {
      return res.status(200).json({ 
        success: true, 
        message: 'Postback received but status not approved yet' 
      });
    }

    // Step 1: Verify user exists in Firebase
    const userRef = db.collection('users').doc(user_id);
    const userSnap = await userRef.get();

    if (!userSnap.exists()) {
      console.warn(`⚠️ User ${user_id} not found in Firebase`);
      return res.status(404).json({ error: 'User not found' });
    }

    // Step 2: Check if transaction already processed (prevent duplicates)
    const transactionRef = db.collection('offerwall_transactions').doc(transaction_id);
    const txSnap = await transactionRef.get();

    if (txSnap.exists()) {
      console.log(`⚠️ Transaction ${transaction_id} already processed`);
      return res.status(200).json({ 
        success: true, 
        message: 'Transaction already processed',
        transaction_id 
      });
    }

    // Step 3: Record the transaction
    await transactionRef.set({
      user_id,
      reward: parseFloat(reward),
      status,
      received_at: new Date(),
      postback_payload: req.body
    });

    // Step 4: Update user balance in Firebase
    const currentBalance = userSnap.data().balance || 0;
    const newBalance = currentBalance + parseFloat(reward);

    await userRef.update({
      balance: newBalance,
      lastOfferwallReward: new Date(),
      totalEarnings: admin.firestore.FieldValue.increment(parseFloat(reward))
    });

    console.log(`✅ Reward credited: ${user_id} +Ksh ${reward} (new balance: ${newBalance})`);

    return res.status(200).json({
      success: true,
      message: 'Reward credited successfully',
      user_id,
      amount: reward,
      transaction_id,
      new_balance: newBalance
    });

  } catch (error) {
    console.error('❌ Postback processing error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Test endpoint (for development only - remove in production)
app.post('/api/test-postback', async (req, res) => {
  try {
    const testPayload = {
      user_id: req.body.user_id || 'test_user_123',
      reward: 10.50,
      transaction_id: `test_${Date.now()}`,
      status: 'completed'
    };

    // Call the postback handler
    const mockReq = { body: testPayload };
    const mockRes = {
      status: (code) => ({
        json: (data) => {
          res.status(code).json({ test: true, ...data });
        }
      })
    };

    return res.json({ test: true, message: 'Test endpoint - use production postback URL in OfferWall settings' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📍 Postback URL: http://localhost:${PORT}/api/offerwall-postback`);
});
