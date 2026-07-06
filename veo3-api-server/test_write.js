const { db } = require('./src/firebase_worker');

async function testWrite() {
  try {
    const docRef = await db.collection('tasks').add({
      userId: 'test_user',
      prompt: 'A test video from backend',
      type: 'video',
      status: 'pending',
      createdAt: Date.now()
    });
    console.log('Successfully wrote task:', docRef.id);
  } catch (err) {
    console.error('Write failed:', err);
  }
}

testWrite();
