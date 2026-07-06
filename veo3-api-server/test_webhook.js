const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

async function runTest() {
  console.log("1. Fetching first user from users collection in Firestore...");
  const usersSnap = await db.collection('users').limit(1).get();
  
  if (usersSnap.empty) {
    console.error("No users found in Firestore. Please log in on the frontend first!");
    process.exit(1);
  }

  const userDoc = usersSnap.docs[0];
  const userId = userDoc.id;
  const userEmail = userDoc.data().email;
  console.log(`Found user: ${userId} (${userEmail})`);

  const mockCode = `ME${Math.floor(100000 + Math.random() * 900000)}`;
  console.log(`2. Injecting pending payment into user profile: Code: ${mockCode}, Tier: premium_169k`);

  await userDoc.ref.update({
    pendingPayment: {
      code: mockCode,
      tier: 'premium_169k',
      amount: 169000,
      createdAt: Date.now()
    }
  });

  console.log(`3. Sending simulated SePay webhook payload to http://localhost:3456/api/payment-webhook...`);
  
  const payload = JSON.stringify({
    gateway: "OCB",
    amount: 169000,
    content: `Simulated transaction matching ${mockCode}`
  });

  const http = require('http');
  const req = http.request({
    hostname: 'localhost',
    port: 3456,
    path: '/api/payment-webhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', async () => {
      console.log(`4. Webhook response: ${data}`);
      
      console.log("5. Re-fetching user doc from Firestore to verify tier upgrade...");
      const updatedSnap = await userDoc.ref.get();
      const updatedData = updatedSnap.data();
      
      console.log(`Result user tier: "${updatedData.tier}"`);
      console.log(`Result user expiry: ${updatedData.expiryDate ? new Date(updatedData.expiryDate).toISOString() : 'None'}`);
      console.log(`Result pending payment state: ${JSON.stringify(updatedData.pendingPayment)}`);
      
      if (updatedData.tier === 'premium_169k') {
        console.log("\n✅ SUCCESS: Webhook auto-payment upgrade worked perfectly!");
      } else {
        console.error("\n❌ FAILED: Tier was not upgraded.");
      }
      process.exit(0);
    });
  });

  req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
    process.exit(1);
  });

  req.write(payload);
  req.end();
}

runTest().catch(console.error);
