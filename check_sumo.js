const { db } = require('./veo3-api-server/src/firebase_worker');
async function run() {
  const snap = await db.collection('drama_jobs').where('status', 'in', ['generating', 'concatenating', 'processing']).get();
  let count = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.channelType === 'sumo') {
      console.log(`Job ${doc.id} is stuck at ${data.status}`);
      count++;
    }
  }
  console.log(`Found ${count} stuck sumo jobs`);
  process.exit(0);
}
run();
