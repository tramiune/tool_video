const { db } = require('./src/firebase_worker');

async function checkTasks() {
  const snapshot = await db.collection('tasks')
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
    
  if (snapshot.empty) {
    console.log('No tasks found.');
    return;
  }
  
  snapshot.forEach(doc => {
    const data = doc.data();
    console.log(`Task ID: ${doc.id}`);
    console.log(`Type: ${data.type}`);
    console.log(`Status: ${data.status}`);
    console.log(`Prompt: ${data.prompt}`);
    console.log(`Error: ${data.error || 'None'}`);
    console.log(`Created At: ${new Date(data.createdAt).toISOString()}`);
    console.log('-----------------------------');
  });
  
  process.exit(0);
}

checkTasks().catch(console.error);
