const { db } = require('./veo3-api-server/src/firebase_worker');
async function run() {
  const snap = await db.collection('tasks').where('status', '==', 'failed').get();
  const docs = snap.docs.map(d => ({id: d.id, ...d.data()}));
  docs.sort((a,b) => (b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0) - (a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0));
  for (const data of docs.slice(0, 5)) {
    console.log(`Task ${data.id}: ${data.error}`);
  }
  process.exit(0);
}
run();
