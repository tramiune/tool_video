const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

async function run() {
  console.log("Searching for user containing 'traderfinn' in email...");
  const snapshot = await db.collection('users').get();
  
  let targetUserDoc = null;
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.email && data.email.toLowerCase().includes('traderfinn')) {
      targetUserDoc = doc;
    }
  });

  if (!targetUserDoc) {
    console.error("❌ Could not find any user with 'traderfinn' in their email.");
    console.log("Existing users in Firestore:");
    snapshot.forEach(doc => {
      console.log(`- ID: ${doc.id}, Email: ${doc.data().email}, Tier: ${doc.data().tier}`);
    });
    process.exit(1);
  }

  const userId = targetUserDoc.id;
  const userEmail = targetUserDoc.data().email;
  console.log(`Found matching user: ${userId} (${userEmail})`);

  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const newExpiry = Date.now() + thirtyDays;

  await targetUserDoc.ref.update({
    tier: 'basic_69k',
    expiryDate: newExpiry,
    updatedAt: Date.now()
  });

  console.log(`\n✅ SUCCESS: Upgraded user ${userEmail} to "basic_69k" (Basic Plan).`);
  console.log(`Expiry Date: ${new Date(newExpiry).toLocaleString('vi-VN')}`);
  process.exit(0);
}

run().catch(console.error);
