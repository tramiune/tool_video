const { db } = require('./src/firebase_worker');

async function test() {
  const snapshot = await db.collection('tasks').get();
  console.log('Total tasks:', snapshot.size);
  snapshot.forEach(doc => {
    console.log(doc.id, '=>', doc.data());
  });
}

test();
