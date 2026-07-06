const { db } = require('./src/firebase_worker');

async function fixBrokenUrls() {
  const oldBase = 'https://pub-4496e76c4ba34c28980998855e485fbd.r2.dev';
  const newBase = 'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev';

  try {
    const snapshot = await db.collection('tasks').get();
    let updated = 0;
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.mediaUrl && data.mediaUrl.includes(oldBase)) {
        const newUrl = data.mediaUrl.replace(oldBase, newBase);
        await doc.ref.update({ mediaUrl: newUrl });
        console.log(`Updated task ${doc.id}`);
        updated++;
      }
    }
    
    console.log(`Successfully fixed ${updated} tasks!`);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

fixBrokenUrls();
