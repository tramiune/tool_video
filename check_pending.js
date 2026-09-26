const { db } = require('./veo3-api-server/src/firebase_worker');
async function run() {
  const snap = await db.collection('tasks').where('status', '==', 'pending').get();
  console.log(`Found ${snap.size} pending tasks`);
  process.exit(0);
}
run();
