const { db } = require('./src/firebase_worker');

async function checkDrama() {
  console.log('--- LATEST DRAMA SCRIPTS ---');
  const scriptsSnap = await db.collection('drama_scripts')
    .orderBy('updatedAt', 'desc')
    .limit(5)
    .get();
    
  scriptsSnap.forEach(doc => {
    const data = doc.data();
    console.log(`Script ID: ${doc.id}`);
    console.log(`Title: ${data.title}`);
    console.log(`Status: ${data.status}`);
    console.log(`UpdatedAt: ${new Date(data.updatedAt).toISOString()}`);
    console.log('-----------------------------');
  });

  console.log('\n--- LATEST DRAMA JOBS ---');
  const jobsSnap = await db.collection('drama_jobs')
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
    
  jobsSnap.forEach(doc => {
    const data = doc.data();
    console.log(`Job ID: ${doc.id}`);
    console.log(`Script ID: ${data.scriptId}`);
    console.log(`Status: ${data.status}`);
    console.log(`Progress: ${data.progress}%`);
    console.log(`Error: ${JSON.stringify(data.error) || 'None'}`);
    console.log(`CreatedAt: ${new Date(data.createdAt).toISOString()}`);
    console.log('-----------------------------');
  });
  
  process.exit(0);
}

checkDrama().catch(console.error);
