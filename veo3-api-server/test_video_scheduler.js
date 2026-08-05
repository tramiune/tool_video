const assert = require('node:assert/strict');
const test = require('node:test');

const {
  UserVideoLimitProvider,
  PerUserVideoScheduler
} = require('./src/video_scheduler');

const waitFor = async (predicate, timeoutMs = 1000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for scheduler state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const createControlledRunner = () => {
  const started = [];
  const resolvers = new Map();
  return {
    started,
    runTask: taskId => new Promise(resolve => {
      started.push(taskId);
      resolvers.set(taskId, resolve);
    }),
    finish(taskId) {
      const resolve = resolvers.get(taskId);
      assert.ok(resolve, `${taskId} must be active before finishing`);
      resolvers.delete(taskId);
      resolve();
    }
  };
};

test('enforces Basic 1 stream while using free global slots for Premium', async () => {
  const users = { b1: 'basic', b2: 'basic', p1: 'premium', p2: 'premium', p3: 'premium' };
  const runner = createControlledRunner();
  const scheduler = new PerUserVideoScheduler({
    globalLimit: 3,
    getUserId: taskId => users[taskId],
    getUserLimit: async userId => userId === 'premium' ? 4 : 1,
    runTask: runner.runTask
  });

  ['b1', 'b2', 'p1', 'p2', 'p3'].forEach(taskId => scheduler.enqueue(taskId));
  await waitFor(() => runner.started.length === 3);
  assert.deepEqual(runner.started, ['b1', 'p1', 'p2']);
  assert.equal(scheduler.activeForUser('basic'), 1);

  runner.finish('b1');
  await waitFor(() => runner.started.includes('b2'));
  assert.equal(scheduler.activeForUser('basic'), 1);

  ['p1', 'p2', 'b2'].forEach(taskId => runner.finish(taskId));
  await waitFor(() => runner.started.includes('p3'));
  runner.finish('p3');
});

test('caps Premium at 4 streams and lets other users use remaining workers', async () => {
  const runner = createControlledRunner();
  const scheduler = new PerUserVideoScheduler({
    globalLimit: 6,
    getUserId: taskId => taskId.startsWith('p') ? 'premium' : taskId,
    getUserLimit: async userId => userId === 'premium' ? 4 : 1,
    runTask: runner.runTask
  });

  ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'basic-a', 'basic-b'].forEach(taskId => scheduler.enqueue(taskId));
  await waitFor(() => runner.started.length === 6);
  assert.deepEqual(runner.started, ['p1', 'p2', 'p3', 'p4', 'basic-a', 'basic-b']);
  assert.equal(scheduler.activeForUser('premium'), 4);
  assert.equal(scheduler.queuedCount, 2);

  runner.finish('p1');
  await waitFor(() => runner.started.includes('p5'));
  ['p2', 'p3', 'p4', 'p5', 'basic-a', 'basic-b'].forEach(taskId => runner.finish(taskId));
  await waitFor(() => runner.started.includes('p6'));
  runner.finish('p6');
});

test('does not queue a task twice', async () => {
  const runner = createControlledRunner();
  const scheduler = new PerUserVideoScheduler({
    globalLimit: 1,
    getUserId: () => 'user',
    getUserLimit: async () => 1,
    runTask: runner.runTask
  });

  assert.equal(scheduler.enqueue('task-1'), true);
  assert.equal(scheduler.enqueue('task-1'), false);
  await waitFor(() => runner.started.length === 1);
  runner.finish('task-1');
});

test('defers a retry for an active task until its cooldown finishes', async () => {
  const runner = createControlledRunner();
  const scheduler = new PerUserVideoScheduler({
    globalLimit: 4,
    getUserId: () => 'premium',
    getUserLimit: async () => 4,
    runTask: runner.runTask
  });

  scheduler.enqueue('retry-task');
  await waitFor(() => runner.started.length === 1);
  assert.equal(scheduler.enqueue('retry-task'), true);
  assert.equal(scheduler.enqueue('retry-task'), false);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runner.started.length, 1);

  runner.finish('retry-task');
  await waitFor(() => runner.started.length === 2);
  runner.finish('retry-task');
});

test('enforces Standard at 2 streams', async () => {
  const runner = createControlledRunner();
  const scheduler = new PerUserVideoScheduler({
    globalLimit: 6,
    getUserId: () => 'standard',
    getUserLimit: async () => 2,
    runTask: runner.runTask
  });

  ['s1', 's2', 's3'].forEach(taskId => scheduler.enqueue(taskId));
  await waitFor(() => runner.started.length === 2);
  assert.deepEqual(runner.started, ['s1', 's2']);
  assert.equal(scheduler.queuedCount, 1);
  runner.finish('s1');
  await waitFor(() => runner.started.includes('s3'));
  runner.finish('s2');
  runner.finish('s3');
});

test('tier provider caches reads, coalesces concurrent reads, and supports invalidation', async () => {
  let reads = 0;
  let userData = { tier: 'basic_69k', expiryDate: 20000 };
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => {
          reads++;
          await new Promise(resolve => setTimeout(resolve, 5));
          return { exists: true, data: () => userData };
        }
      })
    })
  };
  const provider = new UserVideoLimitProvider({ db, ttlMs: 1000, now: () => 10000 });

  const [first, second] = await Promise.all([provider.getLimit('user-1'), provider.getLimit('user-1')]);
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(reads, 1);
  assert.equal(await provider.getLimit('user-1'), 1);
  assert.equal(reads, 1);

  userData = { tier: 'premium_169k', expiryDate: 20000 };
  provider.invalidate('user-1');
  assert.equal(await provider.getLimit('user-1'), 4);
  assert.equal(reads, 2);
});

test('tier provider falls back to Free for expired or unknown tiers', async () => {
  const records = {
    expired: { tier: 'premium_169k', expiryDate: 9999 },
    missingExpiry: { tier: 'premium_169k' },
    unknown: { tier: 'custom', expiryDate: 20000 },
    standard: { tier: 'standard_99k', expiryDate: 20000 }
  };
  const db = {
    collection: () => ({
      doc: userId => ({ get: async () => ({ exists: true, data: () => records[userId] }) })
    })
  };
  const provider = new UserVideoLimitProvider({ db, now: () => 10000 });

  assert.equal(await provider.getLimit('expired'), 1);
  assert.equal(await provider.getLimit('missingExpiry'), 1);
  assert.equal(await provider.getLimit('unknown'), 1);
  assert.equal(await provider.getLimit('standard'), 2);
  assert.equal(await provider.getLimit('anonymous'), 1);
});

test('an invalidated in-flight read cannot overwrite a newer tier', async () => {
  let reads = 0;
  let resolveFirstRead;
  const snapshot = data => ({ exists: true, data: () => data });
  const db = {
    collection: () => ({
      doc: () => ({
        get: () => {
          reads++;
          if (reads === 1) {
            return new Promise(resolve => { resolveFirstRead = () => resolve(snapshot({ tier: 'basic_69k', expiryDate: 20000 })); });
          }
          return Promise.resolve(snapshot({ tier: 'premium_169k', expiryDate: 20000 }));
        }
      })
    })
  };
  const provider = new UserVideoLimitProvider({ db, now: () => 10000 });

  const staleRead = provider.getLimit('user-1');
  await waitFor(() => reads === 1);
  provider.invalidate('user-1');
  assert.equal(await provider.getLimit('user-1'), 4);
  resolveFirstRead();
  assert.equal(await staleRead, 4);
  assert.equal(await provider.getLimit('user-1'), 4);
  assert.equal(reads, 2);
});

test('temporarily caches the safe limit when Firestore is unavailable', async () => {
  let reads = 0;
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => {
          reads++;
          throw new Error('Firestore unavailable');
        }
      })
    })
  };
  const provider = new UserVideoLimitProvider({ db, now: () => 10000 });

  assert.equal(await provider.getLimit('user-1'), 1);
  assert.equal(await provider.getLimit('user-1'), 1);
  assert.equal(reads, 1);
});
