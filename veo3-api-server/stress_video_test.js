const { db } = require('./src/firebase_worker');

const COUNT = parseInt(process.argv[2] || '10', 10);
const STAGGER_MS = parseInt(process.argv[3] || '0', 10);
const TAG = process.argv[4] || 'burst';
const PROMPT = 'a cute orange cat sitting on a sunny windowsill, looking at the camera, photorealistic, cinematic lighting';
const POLL_INTERVAL = 5000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`[TEST] Creating ${COUNT} video tasks (tag=${TAG}, stagger=${STAGGER_MS}ms)...`);
  const taskIds = [];
  for (let i = 0; i < COUNT; i++) {
    const docRef = await db.collection('tasks').add({
      userId: `stress_${TAG}`,
      type: 'video',
      status: 'pending',
      prompt: `${PROMPT}. Variation number ${i + 1}`,
      model: 'veo_3_1_lite',
      aspectRatio: '16:9',
      count: 1,
      durationSeconds: 4,
      testTag: TAG,
      createdAt: Date.now()
    });
    taskIds.push(docRef.id);
    console.log(`[TEST] Created task ${i + 1}/${COUNT}: ${docRef.id}`);
    if (STAGGER_MS > 0 && i < COUNT - 1) await sleep(STAGGER_MS);
  }

  console.log(`\n[TEST] ${COUNT} tasks submitted. Monitoring status...`);
  const startTime = Date.now();
  const statusMap = {};
  let lastPrint = '';

  while (true) {
    const batch = db.batch();
    const snapshots = [];
    for (const id of taskIds) {
      const ref = db.collection('tasks').doc(id);
      const doc = await ref.get();
      snapshots.push(doc);
    }

    let done = 0;
    let ok = 0, fail = 0;
    const lines = [];
    for (const doc of snapshots) {
      if (!doc.exists) { done++; fail++; lines.push(`${doc.id.slice(0,8)} MISSING`); continue; }
      const t = doc.data();
      const elapsed = Math.round((Date.now() - (t.createdAt || startTime)) / 1000);
      lines.push(`${doc.id.slice(0,8)} | ${String(t.status).padEnd(10)} | ${elapsed}s`);
      if (t.status === 'completed') { done++; ok++; }
      else if (t.status === 'failed') { done++; fail++; }
      else if (t.status === 'missing') { done++; fail++; }
    }
    const print = lines.join('\n');
    if (print !== lastPrint) {
      console.log(`\n--- t=${Math.round((Date.now()-startTime)/1000)}s (ok=${ok} fail=${fail} pending=${COUNT-done}) ---\n${print}`);
      lastPrint = print;
    }

    if (done >= COUNT) {
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n[RESULT] tag=${TAG} | ok=${ok}/${COUNT} | fail=${fail} | total_time=${totalTime}s`);
      console.log(`[RESULT] success_rate=${(ok/COUNT*100).toFixed(0)}% | avg_per_task=${(totalTime/COUNT).toFixed(0)}s`);
      process.exit(ok >= COUNT ? 0 : 1);
    }

    await sleep(POLL_INTERVAL);
  }
}

main().catch(e => { console.error('[TEST] Fatal:', e); process.exit(1); });
