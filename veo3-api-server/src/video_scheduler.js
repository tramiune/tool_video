const VIDEO_LIMITS_BY_TIER = Object.freeze({
  free: 1,
  hocvien: 1,
  basic_69k: 1,
  standard_99k: 1,
  premium_169k: 1,
  premium_199k: 1
});

class UserVideoLimitProvider {
  constructor({ db, ttlMs = 2 * 60 * 1000, now = () => Date.now(), logger = null }) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.now = now;
    this.logger = logger;
    this.cache = new Map();
    this.pendingReads = new Map();
    this.versions = new Map();
  }

  async getLimit(userId) {
    if (!userId || userId === 'anonymous') return VIDEO_LIMITS_BY_TIER.free;

    const now = this.now();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > now) return cached.limit;
    if (this.pendingReads.has(userId)) return this.pendingReads.get(userId);

    const version = this.versions.get(userId) || 0;
    const pending = this.loadLimit(userId, now, version);
    pending.finally(() => {
      if (this.pendingReads.get(userId) === pending) this.pendingReads.delete(userId);
    });
    this.pendingReads.set(userId, pending);
    return pending;
  }

  async loadLimit(userId, now, version) {
    try {
      const snapshot = await this.db.collection('users').doc(userId).get();
      const data = snapshot.exists ? snapshot.data() : {};
      const expiryDate = typeof data.expiryDate?.toMillis === 'function'
        ? data.expiryDate.toMillis()
        : Number(data.expiryDate || 0);
      const tier = data.tier === 'free' || (expiryDate > now && VIDEO_LIMITS_BY_TIER[data.tier]) ? data.tier : 'free';
      const limit = VIDEO_LIMITS_BY_TIER[tier] || VIDEO_LIMITS_BY_TIER.free;
      const expiresAt = expiryDate > now ? Math.min(now + this.ttlMs, expiryDate) : now + this.ttlMs;
      if ((this.versions.get(userId) || 0) !== version) return this.getLimit(userId);
      this.cache.set(userId, { tier, limit, expiresAt });
      return limit;
    } catch (error) {
      this.logger?.warn?.(`[Video] Could not load tier for ${userId}; using 1 stream: ${error.message}`);
      if ((this.versions.get(userId) || 0) !== version) return this.getLimit(userId);
      this.cache.set(userId, {
        tier: 'free',
        limit: VIDEO_LIMITS_BY_TIER.free,
        expiresAt: now + Math.min(this.ttlMs, 30 * 1000)
      });
      return VIDEO_LIMITS_BY_TIER.free;
    }
  }

  invalidate(userId) {
    this.cache.delete(userId);
    this.pendingReads.delete(userId);
    this.versions.set(userId, (this.versions.get(userId) || 0) + 1);
  }
}

class PerUserVideoScheduler {
  constructor({ globalLimit, getUserId, getUserLimit, runTask, onError = () => {}, delayMs = 15000 }) {
    this.globalLimit = Math.max(1, Number(globalLimit) || 1);
    this.getUserId = getUserId;
    this.getUserLimit = getUserLimit;
    this.runTask = runTask;
    this.onError = onError;
    this.delayMs = delayMs;
    this.queue = [];
    this.queuedIds = new Set();
    this.activeIds = new Set();
    this.rerunIds = new Set();
    this.activeByUser = new Map();
    this.draining = false;
  }

  get activeCount() {
    return this.activeIds.size;
  }

  get queuedCount() {
    return this.queue.length;
  }

  activeForUser(userId) {
    return this.activeByUser.get(userId) || 0;
  }

  enqueue(taskId) {
    if (!taskId || this.queuedIds.has(taskId) || this.rerunIds.has(taskId)) return false;
    if (this.activeIds.has(taskId)) {
      this.rerunIds.add(taskId);
      return true;
    }
    this.queue.push(taskId);
    this.queuedIds.add(taskId);
    this.scheduleDrain();
    return true;
  }

  scheduleDrain() {
    void this.drain().catch(error => this.onError(error, null));
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.activeCount < this.globalLimit && this.queue.length > 0) {
        const selection = await this.findEligibleTask();
        if (!selection) break;

        const [taskId] = this.queue.splice(selection.index, 1);
        this.queuedIds.delete(taskId);
        this.activeIds.add(taskId);
        this.activeByUser.set(selection.userId, this.activeForUser(selection.userId) + 1);

        // Run the task concurrently
        Promise.resolve()
          .then(() => this.runTask(taskId))
          .catch(error => this.onError(error, taskId))
          .finally(() => {
            this.activeIds.delete(taskId);
            const remaining = this.activeForUser(selection.userId) - 1;
            if (remaining > 0) this.activeByUser.set(selection.userId, remaining);
            else this.activeByUser.delete(selection.userId);
            if (this.rerunIds.delete(taskId) && !this.queuedIds.has(taskId)) {
              this.queue.push(taskId);
              this.queuedIds.add(taskId);
            }
            this.scheduleDrain();
          });

        // Delay between dispatches (like a conveyor belt) to avoid API spam/403
        if (this.delayMs > 0 && (this.queue.length > 0 || this.activeCount < this.globalLimit)) {
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async findEligibleTask() {
    for (let index = 0; index < this.queue.length; index++) {
      const taskId = this.queue[index];
      const userId = this.getUserId(taskId) || 'anonymous';
      let userLimit = VIDEO_LIMITS_BY_TIER.free;
      try {
        userLimit = Math.max(1, Number(await this.getUserLimit(userId)) || 1);
      } catch (error) {
        this.onError(error, taskId);
      }
      if (this.activeForUser(userId) < userLimit) return { index, userId };
    }
    return null;
  }
}

module.exports = {
  VIDEO_LIMITS_BY_TIER,
  UserVideoLimitProvider,
  PerUserVideoScheduler
};
