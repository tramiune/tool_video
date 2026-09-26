const { db } = require('./veo3-api-server/src/firebase_worker');
async function run() {
  const snap = await db.collection('tasks').where('status', 'in', ['processing', 'queued', 'generating', 'rendering']).get();
  let count = 0;
  for (const doc of snap.docs) {
    await doc.ref.update({ status: 'pending' });
    count++;
  }
  console.log(`Reset ${count} stuck tasks to pending`);
  process.exit(0);
}
run();
