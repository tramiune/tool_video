const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('./config');
const { logger, sleep } = require('./utils');
const captchaService = require('./captcha_service');
const browserManager = require('./browser_manager');
const apiClient = require('./api_client');
const { db, auth } = require('./firebase_worker');
const { uploadToR2, deleteFromR2 } = require('./s3_uploader');
const telegram = require('./telegram');
const audioClient = require('./audio_client');
const { processAutoToolJob, resumeAutoToolJobs, generateProjectIdea, generateCharacterSuggestions, generateStyleSuggestion, generateScenes, generateCharacterImage, validatePlan } = require('./autotool');
const drama = require('./drama');
const { UserVideoLimitProvider, PerUserVideoScheduler } = require('./video_scheduler');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Stream server logs to all connected WebSocket clients (dashboard UI)
logger.onLog((logData) => {
  io.emit('server_log', logData);
});

// Configure file uploads
const upload = multer({ dest: path.join(__dirname, '../uploads/'), limits: { files: 5, fileSize: 100 * 1024 * 1024 } });
const autoToolUpload = multer({
  dest: path.join(__dirname, '../uploads/'),
  limits: { files: 3, fileSize: 10 * 1024 * 1024 }
}).fields([{ name: 'characterImages', maxCount: 3 }]);

function parseAutoToolUpload(req, res, next) {
  autoToolUpload(req, res, error => {
    if (!error) return next();
    const files = Object.values(req.files || {}).flat();
    Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {}))).finally(() => {
      res.status(400).json({ error: error.message });
    });
  });
}

function parseAutoToolJsonField(value, fieldName) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    throw new Error(`${fieldName} must be a valid JSON array`);
  }
}

function validateAutoToolCharacters(value) {
  const characters = parseAutoToolJsonField(value, 'characters');
  if (characters.length < 1) throw new Error('At least 1 character is required');
  if (characters.length > 3) throw new Error('A maximum of 3 characters is allowed');

  return characters.map((character, index) => {
    if (!character || typeof character !== 'object' || Array.isArray(character)) {
      throw new Error(`Character ${index + 1} must be an object`);
    }
    if (typeof character.name !== 'string' || !character.name.trim()) {
      throw new Error(`Character ${index + 1} name is required`);
    }
    if (character.name.trim().length > 120) throw new Error(`Character ${index + 1} name is too long`);
    if (typeof character.age !== 'string' || character.age.trim().length > 100) {
      throw new Error(`Character ${index + 1} age must be a string of at most 100 characters`);
    }
    if (typeof character.description !== 'string' || character.description.trim().length > 2000) {
      throw new Error(`Character ${index + 1} description must be a string of at most 2000 characters`);
    }
    if (typeof character.imageUrl !== 'string') {
      throw new Error(`Character ${index + 1} imageUrl must be a string`);
    }
    const imageUrl = character.imageUrl.trim();
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      throw new Error(`Character ${index + 1} imageUrl must be an HTTP URL`);
    }
    return {
      name: character.name.trim(),
      age: character.age.trim(),
      description: character.description.trim(),
      imageUrl
    };
  });
}

// Task state store
const tasks = {};
const imageQueue = [];   // parallel image tasks

// Concurrency config (overridable via env for tuning)
const IMAGE_CONCURRENCY = parseInt(process.env.IMAGE_CONCURRENCY || '10', 10);
let activeImageWorkers = 0;

// ─── GLOBAL GENERATION GATE (anti-throttle / anti-quota-exhaustion) ───────────
// Google Flow throttles when the account sends too many generation requests in a
// short window (PUBLIC_ERROR_USER_REQUESTS_THROTTLED) and blocks models for the
// day once their daily quota is spent (PER_MODEL_DAILY_QUOTA_REACHED).
// Strategy:
//  1. Sliding-window rate limiter: never fire more than N generation triggers per
//     minute across ALL workers, so bursts don't trip Google's user throttle.
//  2. Circuit breaker: on any RESOURCE_EXHAUSTED / 429, open a global backoff
//     window; every worker waits for it to close before the next trigger.
//  3. Requeue instead of fail: throttled tasks go back to pending and retry after
//     the window, instead of dying and burning AutoTool retry attempts.
//  4. Daily-quota model blacklist: models that hit PER_MODEL_DAILY_QUOTA_REACHED
//     are skipped for the rest of the process lifetime (fallback chain moves on).

const RATE_WINDOW_MS = 60 * 1000;
const VIDEO_MAX_PER_WINDOW = parseInt(process.env.VIDEO_MAX_PER_MINUTE || '2', 10);
const IMAGE_MAX_PER_WINDOW = parseInt(process.env.IMAGE_MAX_PER_MINUTE || '4', 10);
const THROTTLE_MAX_BACKOFF_MS = parseInt(process.env.THROTTLE_MAX_BACKOFF_MS || (10 * 60 * 1000), 10);
const videoTriggerTimes = [];
const imageTriggerTimes = [];

const throttleState = {
  video: { until: 0, backoffMs: 30 * 1000 },
  image: { until: 0, backoffMs: 30 * 1000 }
};

const imageQuotaExhaustedModels = new Set();

function isThrottleError(error) {
  const raw = [error?.code, error?.message, error].filter(Boolean).map(String).join(' | ');
  return /RESOURCE_EXHAUSTED|USER_REQUESTS_THROTTLED|\b429\b|quota/i.test(raw);
}

function isDailyQuotaError(error) {
  return /PER_MODEL_DAILY_QUOTA_REACHED|DAILY_QUOTA|Resource has been exhausted/i.test(String(error?.message || ''));
}

function registerThrottle(type, error) {
  const state = throttleState[type];
  const now = Date.now();
  const wasActive = state.until > now;
  state.backoffMs = Math.min(wasActive ? state.backoffMs * 2 : 30 * 1000, THROTTLE_MAX_BACKOFF_MS);
  state.until = now + state.backoffMs;
  logger.warn(`[Throttle] ${type} circuit ${wasActive ? 'RE-OPENED' : 'OPENED'}: pausing ${type} for ${Math.round(state.backoffMs / 1000)}s (${String(error?.message || error).slice(0, 100)})`);
}

async function waitForThrottleGate(type) {
  const state = throttleState[type];
  while (state.until > Date.now()) {
    const waitMs = state.until - Date.now();
    logger.info(`[Throttle] ${type} circuit open, sleeping ${Math.round(waitMs / 1000)}s...`);
    await sleep(Math.min(waitMs, 15 * 1000));
  }
}

async function acquireGenerationSlot(type) {
  await waitForThrottleGate(type);
  const limit = type === 'video' ? VIDEO_MAX_PER_WINDOW : IMAGE_MAX_PER_WINDOW;
  const arr = type === 'video' ? videoTriggerTimes : imageTriggerTimes;
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  while (arr.length && arr[0] < windowStart) arr.shift();
  if (arr.length < limit) {
    arr.push(now);
    return;
  }
  const waitMs = arr[0] + RATE_WINDOW_MS - now;
  logger.info(`[RateLimit] ${type} slot full (${arr.length}/${limit} per minute), waiting ${Math.round(waitMs / 1000)}s...`);
  await sleep(Math.min(waitMs + 500, 15 * 1000));
  await acquireGenerationSlot(type);
}

// Requeue a task after a throttle/429 so it retries when Google calms down,
// instead of being marked failed and burning the user's / AutoTool's attempts.
async function requeueThrottledTask(task, type) {
  const retryCount = Number(task.retryCount) || 0;
  if (retryCount >= 10) {
    const failure = getFriendlyTaskFailure(
      new Error('Google đang giới hạn tài khoản vì quá nhiều yêu cầu. Hãy chờ một lúc rồi thử lại.'),
      type
    );
    task.status = 'failed';
    task.error = failure.message;
    task.errorCode = failure.code || 'THROTTLE_LIMIT';
    await task.docRef.update({ status: 'failed', error: failure.message, errorCode: task.errorCode });
    logger.warn(`[Throttle] ${type} task ${task.id} gave up after ${retryCount} requeues`);
    return;
  }
  task.status = 'pending';
  task.error = null;
  task.errorCode = null;
  task.retryCount = retryCount + 1;
  await task.docRef.update({
    status: 'pending',
    error: null,
    errorCode: null,
    retryCount: retryCount + 1,
    retriedAt: Date.now()
  });
  if (type === 'video') {
    videoScheduler.enqueue(task.id);
  } else {
    imageQueue.push(task.id);
  }
  logger.info(`[Throttle] ${type} task ${task.id} requeued after throttle (retry ${retryCount + 1})`);
}

// ─── SESSION CACHE (anti-account-sharing) ────────────────────────────────────
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const sessionCache = new Map(); // userId -> { sessionId, expiresAt }

function getSessionId(userId) {
  const cached = sessionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.sessionId;
  return null;
}

function setSessionId(userId, sessionId) {
  sessionCache.set(userId, { sessionId, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
}

async function validateSession(userId, sessionId) {
  if (!userId || !sessionId) return false;
  const cached = sessionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.sessionId === sessionId;
  // Cache miss → fetch from Firestore
  try {
    const userSnap = await db.collection('users').doc(userId).get();
    const data = userSnap.exists ? userSnap.data() : {};
    const storedSessionId = data.sessionId || null;
    sessionCache.set(userId, { sessionId: storedSessionId, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
    return storedSessionId === sessionId;
  } catch (err) {
    logger.warn(`[Session] Failed to validate session for ${userId}: ${err.message}`);
    return false;
  }
}

const VIDEO_CONCURRENCY = parseInt(process.env.VIDEO_CONCURRENCY || '10', 10);
const TASK_RETRY_LIMIT = 3;
const userVideoLimits = new UserVideoLimitProvider({
  db,
  ttlMs: Number(process.env.USER_TIER_CACHE_TTL_MS || 2 * 60 * 1000),
  logger
});
const videoScheduler = new PerUserVideoScheduler({
  globalLimit: VIDEO_CONCURRENCY,
  getUserId: taskId => tasks[taskId]?.userId || 'anonymous',
  getUserLimit: userId => userVideoLimits.getLimit(userId),
  runTask: taskId => runVideoTask(taskId),
  onError: (error, taskId) => logger.error(`[Video] Scheduler error${taskId ? ` for ${taskId}` : ''}`, error)
});

// Round-robin across video nicks. The 2nd video nick is used only once its
// profile + cookies exist (so it's safe before the user logs it in).
let videoClientRR = 0;
function getVideoClients() {
  const list = [apiClient];
  if (fs.existsSync(config.VIDEO2_COOKIE_FILE) && fs.existsSync(config.VIDEO2_USER_DATA_DIR)) {
    list.push(apiClient.video2);
  }
  return list;
}
function nextVideoClient() {
  const list = getVideoClients();
  videoClientRR = (videoClientRR + 1) % list.length;
  return list[videoClientRR];
}

function getTaskFailureText(error) {
  return [error?.code, error?.message, error].filter(Boolean).map(String).join(' | ');
}

function getFriendlyTaskFailure(error, type = 'video') {
  const rawCode = getTaskFailureText(error) || 'TASK_FAILED';

  if (/CHILD_DANGER|PUBLIC_ERROR_MINOR/i.test(rawCode)) {
    return { code: rawCode, message: 'Nội dung có yếu tố người chưa thành niên không phù hợp. Hãy đổi ảnh hoặc nội dung.' };
  }
  if (/AUDIO_FILTER|AUDIO_GENERATION_FILTERED/i.test(rawCode)) {
    return { code: rawCode, message: 'Âm thanh bị bộ lọc từ chối. Hãy chỉnh prompt rồi thử lại.' };
  }
  if (/IP_INPUT_IMAGE|IP_PROHIBITED/i.test(rawCode)) {
    return { code: rawCode, message: 'Ảnh đầu vào có thể chứa nội dung được bảo hộ. Hãy đổi ảnh khác.' };
  }
  if (/PROMINENT/i.test(rawCode)) {
    return { code: rawCode, message: 'Ảnh có thể giống người nổi tiếng. Hãy đổi ảnh khác.' };
  }
  if (/PUBLIC_ERROR_SEXUAL/i.test(rawCode)) {
    return { code: rawCode, message: 'Nội dung có yếu tố nhạy cảm và bị bộ lọc từ chối. Hãy đổi ảnh hoặc prompt.' };
  }
  if (/DANGER_FILTER|UNSAFE|INAPPROPRIATE|SAFETY|MEDIA_GENERATION_STATUS_FILTERED/i.test(rawCode)) {
    return { code: rawCode, message: `${type === 'video' ? 'Video' : 'Ảnh'} bị bộ lọc an toàn từ chối. Hãy đổi ảnh hoặc nội dung.` };
  }
  if (/PUBLIC_ERROR_MODEL_ACCESS_DENIED/i.test(rawCode)) {
    return { code: rawCode, message: 'Mẫu AI này tạm thời không khả dụng với phiên đang dùng. Hãy thử lại sau giây lát.' };
  }
  if (/PUBLIC_ERROR_USER_REQUESTS_THROTTLED/i.test(rawCode)) {
    return { code: rawCode, message: 'Bạn đang gửi yêu cầu hơi nhanh. Hãy chờ vài giây rồi thử lại.' };
  }
  if (/Failed to enqueue generation/i.test(rawCode)) {
    return { code: rawCode, message: 'Hệ thống chưa tiếp nhận được lệnh tạo. Hãy bấm Thử lại.' };
  }
  if (/INVALID_ARGUMENT|invalid argument/i.test(rawCode)) {
    return { code: rawCode, message: 'Yêu cầu có tham số không hợp lệ (ảnh hoặc tỷ lệ). Hãy kiểm tra lại rồi thử.' };
  }
  if (/VIDEO_DOWNLOAD_FAILED|IMAGE_URL_CAPTURE_FAILED|IMAGE_UPLOAD_R2_FAILED|Could not capture URL|Upload R2 failed|No successful media generated/i.test(rawCode)) {
    return { code: rawCode, message: 'Tác phẩm đã xử lý nhưng máy chủ không lưu được kết quả. Hãy bấm Thử lại.' };
  }
  if (/Failed to resolve media download link/i.test(rawCode)) {
    return { code: rawCode, message: 'Video đã tạo xong nhưng không tải được về. Hãy bấm Thử lại.' };
  }
  if (/TIMED_OUT|TIMEOUT|timeout/i.test(rawCode)) {
    return { code: rawCode, message: 'Hệ thống xử lý quá thời gian. Hãy bấm Thử lại.' };
  }
  if (/Generation job finished with state: FAILED/i.test(rawCode)) {
    return { code: rawCode, message: 'Tiến trình tạo bị gián đoạn trên máy chủ. Hãy bấm Thử lại.' };
  }
  if (/UNUSUAL_ACTIVITY|reCAPTCHA|PERMISSION_DENIED/i.test(rawCode)) {
    return { code: rawCode, message: 'Hệ thống tạm thời bị Google giới hạn. Hãy chờ khoảng 30 giây rồi thử lại.' };
  }
  if (/OAuth token|capture token|UNAUTHENTICATED|UNAUTHORIZED|\b401\b/i.test(rawCode)) {
    return { code: rawCode, message: 'Phiên kết nối của máy chủ tạm thời bị gián đoạn. Hãy thử lại sau.' };
  }
  if (/QUOTA|RESOURCE_EXHAUSTED|\b429\b/i.test(rawCode)) {
    return { code: rawCode, message: 'Hạn mức của hệ thống đang tạm hết. Hãy thử lại sau.' };
  }
  if (/Requested entity was not found|\bNOT_FOUND\b|\b404\b/i.test(rawCode)) {
    return { code: rawCode, message: 'Mẫu AI tạm thời không khả dụng. Hãy thử lại sau.' };
  }
  if (/\bINTERNAL\b|Internal error|INTERNAL_ERROR/i.test(rawCode)) {
    return { code: rawCode, message: 'Hệ thống đang quá tải hoặc gặp sự cố nội bộ. Hãy bấm Thử lại.' };
  }
  return { code: rawCode, message: error?.message || String(error || 'Không tạo được tác phẩm. Hãy thử lại.') };
}

function isRetryableTaskFailure(task) {
  const rawCode = [task?.errorCode, task?.error].filter(Boolean).map(String).join(' | ');
  if (!rawCode) return false;
  if (/CHILD_DANGER|PUBLIC_ERROR_MINOR|AUDIO_FILTER|AUDIO_GENERATION_FILTERED|IP_INPUT_IMAGE|IP_PROHIBITED|PROMINENT|PUBLIC_ERROR_SEXUAL|DANGER_FILTER|UNSAFE|INAPPROPRIATE|SAFETY|MEDIA_GENERATION_STATUS_FILTERED/i.test(rawCode)) {
    return false;
  }
  return /INTERNAL|TIMED_OUT|TIMEOUT|timeout|VIDEO_DOWNLOAD_FAILED|IMAGE_URL_CAPTURE_FAILED|IMAGE_UPLOAD_R2_FAILED|Generation job finished with state: FAILED|Failed to enqueue generation|Failed to resolve media download link|UNUSUAL_ACTIVITY|reCAPTCHA|PERMISSION_DENIED|OAuth token|capture token|UNAUTHENTICATED|UNAUTHORIZED|\b401\b|QUOTA|RESOURCE_EXHAUSTED|\b429\b|Requested entity was not found|\bNOT_FOUND\b|\b404\b|Could not capture URL|Upload R2 failed|No successful media generated/i.test(rawCode);
}

// CORS: only allow same-origin (legacy UI) + the public web app domain.
// Never allow arbitrary origins to hit the API.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / non-browser requests
    const allowed = [
      'http://localhost:3456',
      'https://api.meo3.cloud',
      'https://tool-video.pages.dev',
      'https://meo3.cloud'
    ];
    if (allowed.includes(origin)) return callback(null, true);
    return callback(null, false); // don't set CORS headers → browser blocks
  }
}));
app.use(express.json());

// ─── LOCAL-ONLY GUARD ────────────────────────────────────────────────────────
// Sensitive endpoints that can modify Google sessions, burn credits, or upload
// files must only be reachable from the local Mac (or local network). The
// Cloudflare tunnel exposes the API to the internet, so any non-local request
// to these paths is rejected outright.
const LOCAL_ONLY_PATHS = [
  '/api/set-cookies',
  '/api/user-info',
  '/api/token-status',
  '/force-refresh',
  '/captcha',
  '/api/generate-video',
  '/api/generate-image'
];

// API-key protected endpoints: reachable through the tunnel but require a
// shared secret header (used by external scripts like ai_web3/aff).
const API_KEY_PATHS = ['/api/try-on'];
const TRY_ON_API_KEY = process.env.TRY_ON_API_KEY || '';

function isValidApiKey(req) {
  if (!TRY_ON_API_KEY) return false;
  return req.headers['x-api-key'] === TRY_ON_API_KEY
    || req.headers.authorization === TRY_ON_API_KEY
    || req.headers.authorization === `Bearer ${TRY_ON_API_KEY}`;
}

function isLocalRequest(req) {
  // Cloudflare tunnel runs on the same host, so remoteAddress is always
  // loopback. Real internet requests carry cf-connecting-ip / x-forwarded-for
  // headers injected by cloudflared — their presence means it's NOT local.
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) {
    return false;
  }
  const ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

app.use((req, res, next) => {
  if (LOCAL_ONLY_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ error: 'Forbidden: endpoint is local-only' });
    }
  }
  if (API_KEY_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) {
    if (!isValidApiKey(req)) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid X-API-Key' });
    }
  }
  next();
});

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

// Captcha service endpoints
app.get('/health', (req, res) => {
  res.json(captchaService.getHealth());
});

app.get('/captcha', async (req, res) => {
  const action = req.query.action || 'IMAGE_GENERATION';
  try {
    const token = await captchaService.solveCaptcha(action);
    res.json({ captcha: token });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.post('/force-refresh', (req, res) => {
  const count = captchaService.forceRefresh();
  res.json({ refreshed: count });
});

// Rest API Endpoints
app.get('/api/token-status', async (req, res) => {
  const hasToken = !!browserManager.oauthToken;
  const age = browserManager.tokenCapturedAt ? Math.round((Date.now() - browserManager.tokenCapturedAt) / 1000) : 0;
  res.json({ hasToken, age });
});

app.get('/api/user-info', async (req, res) => {
  try {
    const projectId = await apiClient.ensureProject();
    const data = await apiClient.getProjectData(projectId);
    res.json({
      userTier: apiClient.userTier,
      paygateTier: apiClient.paygateTier,
      projectId: apiClient.projectId,
      modelConfig: data.modelConfig,
      userData: data.userData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set Cookies dynamically
app.post('/api/set-cookies', async (req, res) => {
  const { cookies } = req.body;
  if (!cookies) {
    return res.status(400).json({ error: 'Missing cookies parameter' });
  }

  try {
    const serialized = typeof cookies === 'string' ? cookies : JSON.stringify(cookies);
    fs.writeFileSync(config.COOKIE_FILE, serialized, 'utf-8');
    logger.info('Cookies updated successfully. Injecting into browser...');
    
    // Sync to Firestore
    try {
      await db.collection('settings').doc('cookies').set({
        cookies: serialized,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      logger.info('Cookies synced to Firestore settings/cookies');
    } catch (dbErr) {
      logger.warn('Failed to sync cookies to Firestore:', dbErr);
    }
    
    if (browserManager.browser && browserManager.cdp) {
      await browserManager.injectCookies();
      await browserManager.refreshSession();
    } else {
      logger.info('Browser not initialized yet. Cookies will be injected on startup.');
    }

    res.json({ success: true, message: 'Cookies updated and injected successfully' });
  } catch (err) {
    res.status(500).json({ error: `Failed to update cookies: ${err.message}` });
  }
});

// AI Image Tools endpoint: handles try-on, clean & extend 9:16, or swap face
app.post('/api/try-on', upload.fields([
  { name: 'personImage', maxCount: 1 },
  { name: 'garmentImage', maxCount: 1 }
]), async (req, res) => {
  const { userId, model, aspectRatio, description, preserve, toolType, bgPreset, bgCustom } = req.body;
  if (!req.files || !req.files['personImage']) {
    return res.status(400).json({ error: 'Missing personImage file' });
  }

  try {
    const personFile = req.files['personImage'][0];
    
    // Upload person to R2
    logger.info(`Image Tool: Uploading person image to R2...`);
    const personBuffer = fs.readFileSync(personFile.path);
    const personExt = path.extname(personFile.originalname) || '.jpg';
    const personKey = `meo3/inputs/${uuidv4()}${personExt}`;
    const personUrl = await uploadToR2(personBuffer, personKey, 'image/jpeg');
    
    // Delete temp person file
    try { fs.unlinkSync(personFile.path); } catch (e) {}

    let garmentUrl = null;
    if (req.files['garmentImage'] && req.files['garmentImage'][0]) {
      const garmentFile = req.files['garmentImage'][0];
      logger.info(`Image Tool: Uploading garment image to R2...`);
      const garmentBuffer = fs.readFileSync(garmentFile.path);
      const garmentExt = path.extname(garmentFile.originalname) || '.jpg';
      const garmentKey = `meo3/inputs/${uuidv4()}${garmentExt}`;
      garmentUrl = await uploadToR2(garmentBuffer, garmentKey, 'image/jpeg');
      
      // Delete temp garment file
      try { fs.unlinkSync(garmentFile.path); } catch (e) {}
    }

    let promptText;
    let refImages = [personUrl];
    let finalAspectRatio = aspectRatio || '9:16';

    if (toolType === 'clean_916') {
      // Tool 2: Clean and Extend to 9:16
      promptText = `Extend this image to a clean 9:16 vertical portrait. Keep the same person, face, hairstyle, body proportions, pose, dress, lighting, camera angle, and interior exactly as the original. Preserve the original composition and photorealistic quality. Remove all UI overlays, including text, logos, search bar, captions, hashtags, buttons, profile picture, like/comment/share icons, watermark, and any app interface. Naturally reconstruct the hidden background behind the removed elements, matching the surrounding wall panels, furniture, lighting, shadows, and perspective seamlessly. Do not change the woman's appearance, expression, makeup, clothing, or body shape. Do not add or remove objects except those hidden by the overlays. Ultra realistic, DSLR photography, high detail, sharp focus, soft natural skin texture, clean luxury interior, 8K.`;
      finalAspectRatio = '9:16';
    } else if (toolType === 'swap_face') {
      // Tool 3: Face swap
      promptText = `Keep the same hairstyle, makeup style, skin tone, age range, body proportions, pose, dress, lighting, camera angle, and luxury interior. Transform the face into a completely new fictional East Asian woman with a unique identity. Change all facial features, including eye shape, eyebrow shape, nose, lips, jawline, cheekbones, face contour, forehead, and facial proportions. Ensure she does not resemble the original person while maintaining the same beauty level and natural appearance. Keep the expression soft and elegant. Preserve the overall fashion vibe and aesthetic, but create a fresh, original identity. Ultra photorealistic, DSLR, 85mm lens, natural skin texture, high detail, realistic pores, soft lighting, 8K.`;
    } else if (toolType === 'change_bg') {
      // Tool 4: Change Background
      const bgDescription = (bgCustom && bgCustom.trim()) ? bgCustom.trim() : (bgPreset || 'a luxurious modern bedroom');
      promptText = `Edit Image A.

Image A is the original reference and the direct edit target.

Keep the same person exactly as in Image A:
- same face
- same hairstyle
- same makeup
- same glasses and accessories
- same skin tone
- same body proportions
- same pose
- same clothing
- same camera angle
- same framing
- same lighting direction
- same image quality and realism

Replace ONLY the background.

Create a new background: ${bgDescription}.

The new background must blend naturally with the subject using realistic perspective, shadows, reflections, color matching, and depth. Preserve the subject perfectly and do not change any facial features, expression, body shape, clothing details, or pose.

Do not modify the woman in any way. Do not change her identity. Do not add extra people. Do not alter her hands, arms, hair, outfit, or proportions. Only change the environment behind her.

Maintain an ultra-photorealistic DSLR look, natural skin texture, high detail, shallow depth of field, realistic indoor lighting, clean composition, and premium aesthetic. 8K.`
    } else if (toolType === 'brighten_skin') {
      // Tool 5: Brighten skin
      promptText = `Edit ONLY the skin tone of the person.

Increase the skin brightness significantly to achieve a fair, porcelain, Korean-style complexion while keeping it completely natural and realistic.

The skin should appear smooth, luminous, healthy, and evenly toned, with natural highlights and realistic skin texture. Avoid an overexposed, gray, plastic, or AI-generated look.

Do NOT modify anything else.

Keep exactly the same:
- Face and identity (highest priority)
- Facial proportions
- Eyes
- Nose
- Lips
- Eyebrows
- Hairstyle
- Hair color
- Makeup
- Facial expression
- Body shape and proportions
- Pose
- Hands and fingers
- Clothing
- Accessories
- Background
- Camera angle
- Framing
- Lighting direction
- Shadows
- Image composition
- Fabric texture
- Colors of all objects

Do not apply beauty filters, face reshaping, skin smoothing, body slimming, or any enhancement other than making the skin tone much fairer.

The final image should look exactly like the original photo, with the only visible difference being significantly fairer, brighter, naturally radiant skin.

Ultra photorealistic.
Natural skin texture.
DSLR quality.
8K.
Identity preservation is the highest priority.`;
    } else {
      // Tool 1: Virtual Try-On
      if (!garmentUrl) {
        return res.status(400).json({ error: 'Missing garmentImage file for tryon tool type' });
      }
      refImages.push(garmentUrl);
      
      const clothDesc = description ? description.trim() : 'clothing';
      const shouldPreserve = preserve === 'true' || preserve === true;
      if (shouldPreserve) {
        promptText = `A photo of the exact same person from input_file_0.png in the exact same pose, expression, hair and background, but wearing the exact ${clothDesc} from input_file_1.png. The clothing must look exactly identical to the garment in input_file_1.png, preserving every single detail, print, logo, pattern, texture, and color exactly as shown, without any modifications or additions, photorealistic, high quality`;
      } else {
        promptText = `A professional studio photo of the person in input_file_0.png wearing the exact ${clothDesc} from input_file_1.png. The clothing must look exactly identical to the garment in input_file_1.png, preserving every single detail, print, logo, pattern, texture, and color exactly as shown, without any modifications or additions, photorealistic, high quality`;
      }
    }

    // Save task to Firestore
    const taskData = {
      userId: userId || 'anonymous',
      type: 'image',
      status: 'pending',
      prompt: promptText,
      aspectRatio: finalAspectRatio,
      model: model || 'nano_banana_pro',
      referenceImages: refImages,
      createdAt: Date.now()
    };

    const docRef = await db.collection('tasks').add(taskData);
    logger.success(`Image Tool Task successfully created: ${docRef.id} (${toolType || 'tryon'})`);

    res.json({ success: true, taskId: docRef.id, status: 'queued' });
  } catch (err) {
    logger.error('Image Tool API failed', err);
    telegram.notifyError('Image Tool API failed', err).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── LEGACY WEB UI COMPAT ROUTES ────────────────────────────────────────────
// These mirror the old meo3 web server API so the legacy public/index.html
// (VEO3 Flow Studio) can create tasks that the Firestore worker processes.

app.post('/api/generate-video', upload.fields([{ name: 'startImage', maxCount: 1 }, { name: 'endImage', maxCount: 1 }]), async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const startImage = req.files?.startImage?.[0]?.path || null;
    const endImage = req.files?.endImage?.[0]?.path || null;

    const taskData = {
      userId: 'anonymous',
      type: 'video',
      status: 'pending',
      prompt,
      aspectRatio: String(req.body.aspectRatio || '16:9'),
      model: String(req.body.model || 'veo_3_1_lite'),
      count: parseInt(req.body.count, 10) || 1,
      durationSeconds: parseInt(req.body.durationSeconds, 10) || 8,
      startImage,
      endImage,
      createdAt: Date.now()
    };

    const docRef = await db.collection('tasks').add(taskData);
    logger.success(`Legacy video task created: ${docRef.id} ("${prompt.substring(0, 20)}...")`);
    res.json({ success: true, taskId: docRef.id, status: 'queued' });
  } catch (err) {
    logger.error('Legacy generate-video failed', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate-image', upload.single('referenceImage'), async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const referenceImage = req.file?.path || null;

    const taskData = {
      userId: 'anonymous',
      type: 'image',
      status: 'pending',
      prompt,
      aspectRatio: String(req.body.aspectRatio || '1:1'),
      model: String(req.body.model || 'nano_banana_pro'),
      count: parseInt(req.body.count, 10) || 1,
      referenceImages: referenceImage ? [referenceImage] : [],
      createdAt: Date.now()
    };

    const docRef = await db.collection('tasks').add(taskData);
    logger.success(`Legacy image task created: ${docRef.id} ("${prompt.substring(0, 20)}...")`);
    res.json({ success: true, taskId: docRef.id, status: 'queued' });
  } catch (err) {
    logger.error('Legacy generate-image failed', err);
    res.status(500).json({ error: err.message });
  }
});

// Legacy task status endpoint (maps Firestore statuses to legacy UI statuses)
app.get('/api/status/:taskId', async (req, res) => {
  try {
    const docRef = db.collection('tasks').doc(req.params.taskId);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const task = docSnap.data();
    const statusMap = { pending: 'queued', processing: 'generating' };
    res.json({
      id: docSnap.id,
      type: task.type || 'image',
      prompt: task.prompt || '',
      aspectRatio: task.aspectRatio || '1:1',
      model: task.model || '',
      status: statusMap[task.status] || task.status,
      progress: task.progress || null,
      error: task.error || null,
      media: task.media || (task.mediaUrl ? [{ mediaId: docSnap.id, status: 'success', url: task.mediaUrl }] : []),
      createdAt: task.createdAt || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retrieve task status and output details
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const docRef = db.collection('tasks').doc(req.params.id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json({ id: docSnap.id, ...docSnap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function requireUser(req, res, next) {
  try {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Missing Firebase ID token' });
    const decoded = await auth.verifyIdToken(match[1]);
    req.authUser = { uid: decoded.uid, email: decoded.email || null };

    // Session validation (anti-account-sharing)
    const sessionToken = req.headers['x-session-token'];
    if (sessionToken) {
      const valid = await validateSession(decoded.uid, sessionToken);
      if (!valid) {
        return res.status(401).json({ error: 'SESSION_EXPIRED', message: 'Tài khoản đang được đăng nhập ở thiết bị khác.' });
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
}

// ─── SESSION INIT (anti-account-sharing) ─────────────────────────────────────
app.post('/api/session/init', requireUser, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Missing sessionId' });
    }
    const userId = req.authUser.uid;
    await db.collection('users').doc(userId).set({ sessionId }, { merge: true });
    setSessionId(userId, sessionId);
    logger.info(`[Session] Initialized session for user ${userId}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('[Session] Init error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/retry', requireUser, async (req, res) => {
  try {
    const taskRef = db.collection('tasks').doc(req.params.id);
    let retriedTask;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(taskRef);
      if (!snapshot.exists) throw Object.assign(new Error('Task not found'), { statusCode: 404 });

      const task = snapshot.data();
      if (task.userId !== req.authUser.uid) {
        throw Object.assign(new Error('You cannot retry this task'), { statusCode: 403 });
      }
      if (task.status !== 'failed') {
        throw Object.assign(new Error('Only failed tasks can be retried'), { statusCode: 409 });
      }
      if (!isRetryableTaskFailure(task)) {
        throw Object.assign(new Error('Lỗi này cần đổi ảnh hoặc nội dung và không thể thử lại tự động.'), { statusCode: 400 });
      }

      const retryCount = Number(task.retryCount) || 0;
      if (retryCount >= TASK_RETRY_LIMIT) {
        throw Object.assign(new Error(`Task đã đạt giới hạn ${TASK_RETRY_LIMIT} lần thử lại.`), { statusCode: 429 });
      }

      const updates = {
        status: 'pending',
        mediaUrl: null,
        error: null,
        errorCode: null,
        retryCount: retryCount + 1,
        retriedAt: Date.now()
      };
      transaction.update(taskRef, updates);
      retriedTask = { ...task, ...updates };
    });

    logger.info(`Task ${taskRef.id} queued for retry (${retriedTask.retryCount}/${TASK_RETRY_LIMIT})`);
    return res.json({ success: true, taskId: taskRef.id, status: 'pending', retryCount: retriedTask.retryCount });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

async function requireAdmin(req, res, next) {
  try {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Missing Firebase ID token' });
    const decoded = await auth.verifyIdToken(match[1]);
    const userSnapshot = await db.collection('users').doc(decoded.uid).get();
    const userData = userSnapshot.exists ? userSnapshot.data() : {};
    const email = String(decoded.email || userData.email || '').toLowerCase();
    const ADMIN_EMAILS = ['traderfinn0312@gmail.com'];
    if (userData.isAdmin !== true && !ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.authUser = { uid: decoded.uid, email: decoded.email || userData.email || null };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
}

async function requireDramaAccess(req, res, next) {
  try {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Missing Firebase ID token' });
    const decoded = await auth.verifyIdToken(match[1]);
    const userSnapshot = await db.collection('users').doc(decoded.uid).get();
    const userData = userSnapshot.exists ? userSnapshot.data() : {};
    const email = String(decoded.email || userData.email || '').toLowerCase();
    const ADMIN_EMAILS = ['traderfinn0312@gmail.com'];
    const isAdmin = userData.isAdmin === true || ADMIN_EMAILS.includes(email);
    if (!isAdmin && userData.hasDramaAccess !== true) {
      return res.status(403).json({ error: 'Drama access authorization required' });
    }
    req.authUser = { uid: decoded.uid, email: decoded.email || userData.email || null, isAdmin };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
}

app.get('/api/autotool/profile', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('autotool_profiles').doc(req.authUser.uid).get();
    if (!snapshot.exists) return res.json({ profile: null });
    return res.json({ profile: { ...snapshot.data(), id: snapshot.id } });
  } catch (error) {
    logger.error('AutoTool profile lookup failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.put('/api/autotool/profile', requireAdmin, parseAutoToolUpload, async (req, res) => {
  const files = req.files?.characterImages || [];
  try {
    const channelTopic = String(req.body?.channelTopic || '').trim();
    if (!channelTopic) return res.status(400).json({ error: 'channelTopic is required' });
    if (channelTopic.length > 5000) return res.status(400).json({ error: 'channelTopic is too long' });

    const mode = req.body?.mode;
    if (mode !== 'series' && mode !== 'standalone') {
      return res.status(400).json({ error: 'mode must be series or standalone' });
    }

    let characters;
    let imageIndexes;
    try {
      characters = validateAutoToolCharacters(req.body?.characters);
      imageIndexes = parseAutoToolJsonField(req.body?.imageIndexes ?? '[]', 'imageIndexes');
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (imageIndexes.length !== files.length) {
      return res.status(400).json({ error: 'imageIndexes must match the uploaded characterImages files' });
    }
    if (files.some(file => !String(file.mimetype || '').startsWith('image/'))) {
      return res.status(400).json({ error: 'characterImages must contain only image files' });
    }
    if (imageIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= characters.length)) {
      return res.status(400).json({ error: 'Each imageIndexes value must identify an existing character' });
    }
    if (new Set(imageIndexes).size !== imageIndexes.length) {
      return res.status(400).json({ error: 'Each character may receive at most one uploaded image' });
    }
    const uploadedCharacterIndexes = new Set(imageIndexes);
    if (characters.some((character, index) => !character.imageUrl && !uploadedCharacterIndexes.has(index))) {
      return res.status(400).json({ error: 'Every character must have an image' });
    }

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const extension = path.extname(file.originalname) || '.jpg';
      const key = `meo3/autotool/characters/${req.authUser.uid}/${uuidv4()}${extension}`;
      const buffer = await fs.promises.readFile(file.path);
      characters[imageIndexes[fileIndex]].imageUrl = await uploadToR2(buffer, key, file.mimetype || 'image/jpeg');
    }
    if (characters.some(character => !character.imageUrl)) {
      return res.status(400).json({ error: 'Every character must have an image' });
    }

    const profileRef = db.collection('autotool_profiles').doc(req.authUser.uid);
    const profile = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(profileRef);
      const existing = snapshot.exists ? snapshot.data() : {};
      const now = Date.now();
      const data = {
        userId: req.authUser.uid,
        userEmail: req.authUser.email,
        channelTopic,
        mode,
        characters,
        characterImageUrls: characters.map(character => character.imageUrl),
        episodeCount: Number.isInteger(existing.episodeCount) ? existing.episodeCount : 0,
        createdAt: existing.createdAt ?? now,
        updatedAt: now
      };
      transaction.set(profileRef, data);
      return data;
    });
    return res.json({ success: true, profile: { ...profile, id: profileRef.id } });
  } catch (error) {
    logger.error('AutoTool profile update failed', error);
    return res.status(500).json({ error: error.message });
  } finally {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
  }
});

app.get('/api/autotool/jobs/:id', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('autotool_jobs').doc(req.params.id).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool job not found' });
    return res.json({ id: snapshot.id, ...snapshot.data() });
  } catch (error) {
    logger.error('AutoTool job lookup failed', error);
    return res.status(500).json({ error: error.message });
  }
});

// ─── AUTOTOOL PROJECTS (multi-project / multi-series) ──────────────────────
function normalizeAutoToolProject(raw) {
  const project = (raw && typeof raw === 'object') ? raw : {};
  const characters = Array.isArray(project.characters) ? project.characters.slice(0, 3) : [];
  return {
    name: String(project.name || '').trim().slice(0, 200),
    overview: String(project.overview || '').trim().slice(0, 3000),
    mode: project.mode === 'standalone' ? 'standalone' : 'series',
    characters: characters.map((character, index) => ({
      name: String(character?.name || '').trim().slice(0, 120) || `Character ${index + 1}`,
      age: String(character?.age ?? '').trim().slice(0, 100),
      description: String(character?.description || '').trim().slice(0, 2000),
      imageUrl: String(character?.imageUrl || '').trim()
    })),
    characterImageUrls: Array.isArray(project.characterImageUrls)
      ? project.characterImageUrls.map(url => String(url || '').trim())
      : characters.map(character => character.imageUrl),
    style: {
      artStyle: String(project.style?.artStyle || '').trim().slice(0, 500),
      colorPalette: String(project.style?.colorPalette || '').trim().slice(0, 500),
      mood: String(project.style?.mood || '').trim().slice(0, 500),
      lighting: String(project.style?.lighting || '').trim().slice(0, 500),
      camera: String(project.style?.camera || '').trim().slice(0, 500)
    },
    scenes: Array.isArray(project.scenes) ? project.scenes.slice(0, 6).map(scene => ({
      title: String(scene?.title || 'Scene').trim().slice(0, 160),
      imagePrompt: String(scene?.imagePrompt || '').trim(),
      videoPrompt: String(scene?.videoPrompt || '').trim()
    })) : [],
    episodeCount: Number(project.episodeCount) || 0,
    episodes: Array.isArray(project.episodes) ? project.episodes.slice(0, 50) : []
  };
}

app.get('/api/autotool/projects', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('autotool_projects').where('userId', '==', req.authUser.uid).get();
    const projects = snapshot.docs
      .map(document => ({ id: document.id, ...normalizeAutoToolProject(document.data()), updatedAt: document.data().updatedAt || 0 }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return res.json({ projects });
  } catch (error) {
    logger.error('AutoTool projects list failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/autotool/projects', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Project name is required' });
    if (name.length > 200) return res.status(400).json({ error: 'Project name is too long' });
    const ref = db.collection('autotool_projects').doc();
    const now = Date.now();
    const data = {
      ...normalizeAutoToolProject({ name }),
      userId: req.authUser.uid,
      userEmail: req.authUser.email,
      createdAt: now,
      updatedAt: now
    };
    await ref.set(data);
    logger.info(`[AutoTool] Created project "${name}" for ${req.authUser.email}`);
    return res.status(201).json({ success: true, project: { id: ref.id, ...data, updatedAt: now } });
  } catch (error) {
    logger.error('AutoTool project creation failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/autotool/projects/:id', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('autotool_projects').doc(req.params.id).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    const data = snapshot.data();
    if (data.userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });
    return res.json({ project: { id: snapshot.id, ...normalizeAutoToolProject(data), updatedAt: data.updatedAt || 0 } });
  } catch (error) {
    logger.error('AutoTool project lookup failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.put('/api/autotool/projects/:id', requireAdmin, parseAutoToolUpload, async (req, res) => {
  const files = req.files?.characterImages || [];
  try {
    const ref = db.collection('autotool_projects').doc(req.params.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    if (snapshot.data().userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });

    const current = snapshot.data();
    const next = {
      name: String(req.body?.name ?? current.name ?? '').trim().slice(0, 200),
      overview: String(req.body?.overview ?? current.overview ?? '').trim().slice(0, 3000),
      mode: req.body?.mode === 'standalone' || current.mode === 'standalone' ? 'standalone' : 'series',
      style: {
        artStyle: String(req.body?.artStyle ?? current.style?.artStyle ?? '').trim().slice(0, 500),
        colorPalette: String(req.body?.colorPalette ?? current.style?.colorPalette ?? '').trim().slice(0, 500),
        mood: String(req.body?.mood ?? current.style?.mood ?? '').trim().slice(0, 500),
        lighting: String(req.body?.lighting ?? current.style?.lighting ?? '').trim().slice(0, 500),
        camera: String(req.body?.camera ?? current.style?.camera ?? '').trim().slice(0, 500)
      },
      scenes: null
    };

    let characters = current.characters || [];
    if (req.body?.characters !== undefined) {
      try {
        characters = validateAutoToolCharacters(req.body.characters);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    if (req.body?.scenes !== undefined) {
      let scenes;
      try {
        scenes = typeof req.body.scenes === 'string' ? JSON.parse(req.body.scenes) : req.body.scenes;
        if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 6) {
          return res.status(400).json({ error: 'scenes must be a JSON array of 1-6 scenes' });
        }
        scenes = scenes.map(scene => ({
          title: String(scene?.title || 'Scene').trim().slice(0, 160),
          imagePrompt: String(scene?.imagePrompt || '').trim(),
          videoPrompt: String(scene?.videoPrompt || '').trim()
        }));
        if (scenes.some(scene => !scene.imagePrompt || !scene.videoPrompt)) {
          return res.status(400).json({ error: 'Every scene must have imagePrompt and videoPrompt' });
        }
        next.scenes = scenes;
      } catch (error) {
        return res.status(400).json({ error: `Invalid scenes JSON: ${error.message}` });
      }
    }

    let imageIndexes = [];
    if (req.body?.imageIndexes !== undefined) {
      try {
        imageIndexes = parseAutoToolJsonField(req.body.imageIndexes ?? '[]', 'imageIndexes');
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    if (imageIndexes.length !== files.length) {
      return res.status(400).json({ error: 'imageIndexes must match the uploaded characterImages files' });
    }
    if (files.some(file => !String(file.mimetype || '').startsWith('image/'))) {
      return res.status(400).json({ error: 'characterImages must contain only image files' });
    }
    if (imageIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= characters.length)) {
      return res.status(400).json({ error: 'Each imageIndexes value must identify an existing character' });
    }
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const extension = path.extname(file.originalname) || '.jpg';
      const key = `meo3/autotool/characters/${req.authUser.uid}/${uuidv4()}${extension}`;
      const buffer = await fs.promises.readFile(file.path);
      characters[imageIndexes[fileIndex]].imageUrl = await uploadToR2(buffer, key, file.mimetype || 'image/jpeg');
    }

    const data = {
      ...next,
      characters,
      characterImageUrls: characters.map(character => character.imageUrl),
      episodeCount: Number(current.episodeCount) || 0,
      episodes: Array.isArray(current.episodes) ? current.episodes : [],
      userId: current.userId,
      userEmail: current.userEmail,
      createdAt: current.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    data.scenes = next.scenes !== null ? next.scenes : (Array.isArray(current.scenes) ? current.scenes : []);
    await ref.set(data);
    logger.info(`[AutoTool] Saved project "${data.name}"`);
    return res.json({ success: true, project: { id: ref.id, ...normalizeAutoToolProject(data), updatedAt: data.updatedAt } });
  } catch (error) {
    logger.error('AutoTool project update failed', error);
    return res.status(500).json({ error: error.message });
  } finally {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
  }
});

app.delete('/api/autotool/projects/:id', requireAdmin, async (req, res) => {
  try {
    const ref = db.collection('autotool_projects').doc(req.params.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    if (snapshot.data().userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });
    await ref.delete();
    logger.info(`[AutoTool] Deleted project ${req.params.id}`);
    return res.json({ success: true });
  } catch (error) {
    logger.error('AutoTool project delete failed', error);
    return res.status(500).json({ error: error.message });
  }
});

// AI draft endpoints: each returns a rough draft the user can review & adjust.
app.post('/api/autotool/projects/:id/ai/idea', requireAdmin, async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic is required' });
    if (topic.length > 5000) return res.status(400).json({ error: 'topic is too long' });
    const draft = await generateProjectIdea({ topic });
    logger.success(`[AutoTool] AI drafted project idea from topic`);
    return res.json({ success: true, draft });
  } catch (error) {
    logger.error('AutoTool AI idea draft failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/autotool/projects/:id/ai/characters', requireAdmin, async (req, res) => {
  try {
    const ref = db.collection('autotool_projects').doc(req.params.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    if (snapshot.data().userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });
    const project = normalizeAutoToolProject(snapshot.data());
    const characters = await generateCharacterSuggestions(project);
    logger.success(`[AutoTool] AI suggested ${characters.length} character(s)`);
    return res.json({ success: true, characters });
  } catch (error) {
    logger.error('AutoTool AI character draft failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/autotool/projects/:id/ai/style', requireAdmin, async (req, res) => {
  try {
    const ref = db.collection('autotool_projects').doc(req.params.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    if (snapshot.data().userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });
    const project = normalizeAutoToolProject(snapshot.data());
    const style = await generateStyleSuggestion(project);
    logger.success(`[AutoTool] AI suggested a visual style`);
    return res.json({ success: true, style });
  } catch (error) {
    logger.error('AutoTool AI style draft failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/autotool/projects/:id/ai/scenes', requireAdmin, async (req, res) => {
  try {
    const ref = db.collection('autotool_projects').doc(req.params.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    if (snapshot.data().userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });
    const project = normalizeAutoToolProject(snapshot.data());
    if (!project.name || !project.overview) {
      return res.status(400).json({ error: 'Save the project overview before generating scenes' });
    }
    if (project.characters.some(character => !character.imageUrl)) {
      return res.status(400).json({ error: 'Every character needs an image (AI-generated or uploaded) before generating scenes' });
    }
    const priorContext = await getAutoToolEpisodeContext(req.authUser.uid, { ...project, id: req.params.id });
    const plan = await generateScenes(project, priorContext);
    await ref.update({ scenes: plan.scenes, episodeTitleDraft: plan.episodeTitle, updatedAt: Date.now() });
    logger.success(`[AutoTool] AI drafted ${plan.scenes.length} scene(s) for project "${project.name}"`);
    return res.json({ success: true, plan });
  } catch (error) {
    logger.error('AutoTool AI scene draft failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/autotool/projects/:id/ai/character-image', requireAdmin, async (req, res) => {
  const characterIndex = Number(req.body?.characterIndex);
  try {
    const ref = db.collection('autotool_projects').doc(req.params.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    if (snapshot.data().userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });
    const project = normalizeAutoToolProject(snapshot.data());
    if (!Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex >= project.characters.length) {
      return res.status(400).json({ error: 'characterIndex is out of range' });
    }
    const character = project.characters[characterIndex];
    if (!character.name) return res.status(400).json({ error: 'Character needs a name before generating an image' });
    const imageUrl = await generateCharacterImage(
      { ...project, id: req.params.id, userId: snapshot.data().userId },
      character,
      characterIndex
    );
    const currentCharacters = Array.isArray(snapshot.data().characters) ? snapshot.data().characters.map(c => ({ ...c })) : [];
    while (currentCharacters.length <= characterIndex) currentCharacters.push({});
    currentCharacters[characterIndex] = {
      ...currentCharacters[characterIndex],
      name: String(currentCharacters[characterIndex]?.name || character.name || '').trim().slice(0, 120),
      age: String(currentCharacters[characterIndex]?.age ?? character.age ?? '').trim().slice(0, 100),
      description: String(currentCharacters[characterIndex]?.description || character.description || '').trim().slice(0, 2000),
      imageUrl,
      imageStatus: 'generated'
    };
    await ref.update({
      characters: currentCharacters,
      characterImageUrls: currentCharacters.map(c => String(c?.imageUrl || '').trim()),
      updatedAt: Date.now()
    });
    logger.success(`[AutoTool] Saved generated character image for "${character.name}"`);
    return res.json({ success: true, imageUrl });
  } catch (error) {
    logger.error('AutoTool AI character image failed', error);
    return res.status(500).json({ error: error.message });
  }
});

async function getAutoToolEpisodeContext(userId, project) {
  if (!userId) return '';
  const snapshot = await db.collection('autotool_jobs')
    .where('projectId', '==', project.id)
    .limit(50)
    .get();
  return snapshot.docs
    .map(document => document.data())
    .filter(episode => episode.status === 'completed')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 10)
    .map(episode => {
      const scenes = (Array.isArray(episode.scenes) ? episode.scenes : []).map(scene => {
        const title = String(scene.title || 'Untitled scene').slice(0, 120);
        const imagePrompt = String(scene.imagePrompt || '').replace(/\s+/g, ' ').slice(0, 120);
        const videoPrompt = String(scene.videoPrompt || '').replace(/\s+/g, ' ').slice(0, 120);
        return `${title} [image: ${imagePrompt}; video: ${videoPrompt}]`;
      }).join(' | ');
      return `Episode ${episode.episodeNumber || '?'} - ${episode.episodeTitle || 'Untitled'}${scenes ? `: ${scenes}` : ''}`;
    })
    .join('\n');
}

app.post('/api/autotool/jobs', requireAdmin, async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || '').trim();
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const projectRef = db.collection('autotool_projects').doc(projectId);
    const projectSnapshot = await projectRef.get();
    if (!projectSnapshot.exists) return res.status(404).json({ error: 'AutoTool project not found' });
    const projectData = projectSnapshot.data();
    if (projectData.userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });

    const project = normalizeAutoToolProject(projectData);
    if (!project.name || !project.overview) {
      return res.status(400).json({ error: 'Complete the project idea before generating an episode' });
    }
    if (!Array.isArray(project.scenes) || project.scenes.length < 1) {
      return res.status(400).json({ error: 'Generate and save the scene plan before creating an episode' });
    }
    if (project.characters.some(character => !character.imageUrl)) {
      return res.status(400).json({ error: 'Every character needs an image before generating an episode' });
    }

    const jobRef = db.collection('autotool_jobs').doc();
    let episodeNumber;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(projectRef);
      if (!snapshot.exists) throw Object.assign(new Error('AutoTool project not found'), { statusCode: 404 });
      const current = snapshot.data();
      episodeNumber = (Number(current.episodeCount) || 0) + 1;
      const now = Date.now();
      transaction.update(projectRef, { episodeCount: episodeNumber, updatedAt: now });
      transaction.set(jobRef, {
        userId: req.authUser.uid,
        userEmail: req.authUser.email,
        projectId,
        projectName: project.name,
        channelTopic: project.overview,
        topic: project.name,
        mode: project.mode,
        characters: project.characters,
        characterImageUrls: project.characterImageUrls,
        scenes: project.scenes.map((scene, index) => ({
          index,
          title: scene.title,
          imagePrompt: scene.imagePrompt,
          videoPrompt: scene.videoPrompt,
          imageTaskId: null,
          imageUrl: null,
          videoTaskId: null,
          videoUrl: null,
          status: 'pending',
          error: null
        })),
        episodeNumber,
        episodeTitle: null,
        status: 'queued',
        progress: 0,
        currentScene: null,
        finalUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now
      });
    });
    processAutoToolJob(jobRef.id);
    return res.status(202).json({ success: true, jobId: jobRef.id, status: 'queued', episodeNumber });
  } catch (error) {
    logger.error('AutoTool job creation failed', error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ─── DRAMA SCRIPTS (mẹ chồng nàng dâu / family drama) ──────────────────────
app.get('/api/drama/scripts', requireDramaAccess, async (req, res) => {
  try {
    const snapshot = await db.collection('drama_scripts').where('userId', '==', req.authUser.uid).get();
    const scripts = snapshot.docs
      .map(document => ({ id: document.id, ...drama.normalizeDramaScript(document.data()), updatedAt: document.data().updatedAt || 0 }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return res.json({ scripts });
  } catch (error) {
    logger.error('Drama script list failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/drama/scripts', requireDramaAccess, async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').trim();
    
    // Auto-generate the full script content using Gemini on creation
    const draft = await drama.generateDramaScript({ topic });
    
    const ref = db.collection('drama_scripts').doc();
    const now = Date.now();
    const data = {
      userId: req.authUser.uid,
      userEmail: req.authUser.email,
      topic,
      ...drama.normalizeDramaScript(draft),
      status: 'draft',
      createdAt: now,
      updatedAt: now
    };
    await ref.set(data);
    logger.success(`[Drama] Created and generated script for ${req.authUser.email}: ${draft.title}`);
    return res.status(201).json({ success: true, script: { id: ref.id, ...data } });
  } catch (error) {
    logger.error('Drama script creation and generation failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/drama/scripts/:id/ai/generate', requireDramaAccess, async (req, res) => {
  try {
    const scriptRef = db.collection('drama_scripts').doc(req.params.id);
    const snapshot = await scriptRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama script not found' });
    const current = snapshot.data();
    if (current.userId !== req.authUser.uid) return res.status(403).json({ error: 'Forbidden' });

    const draft = await drama.generateDramaScript({
      topic: String(req.body?.topic || current.topic || '').trim()
    });
    const now = Date.now();
    const updated = {
      ...drama.normalizeDramaScript({ ...current, ...draft }),
      updatedAt: now
    };
    await scriptRef.update(updated);
    logger.success(`[Drama] AI script generated for ${req.authUser.email}: ${draft.title}`);
    return res.json({ success: true, script: { id: scriptRef.id, ...updated } });
  } catch (error) {
    logger.error('Drama AI script generation failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/drama/scripts/:id', requireDramaAccess, async (req, res) => {
  try {
    const snapshot = await db.collection('drama_scripts').doc(req.params.id).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama script not found' });
    if (snapshot.data().userId !== req.authUser.uid && !req.authUser.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json({ script: { id: snapshot.id, ...drama.normalizeDramaScript(snapshot.data()), updatedAt: snapshot.data().updatedAt || 0 } });
  } catch (error) {
    logger.error('Drama script lookup failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.put('/api/drama/scripts/:id', requireDramaAccess, async (req, res) => {
  try {
    const scriptRef = db.collection('drama_scripts').doc(req.params.id);
    const snapshot = await scriptRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama script not found' });
    const current = snapshot.data();
    if (current.userId !== req.authUser.uid && !req.authUser.isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const now = Date.now();
    const updated = {
      ...drama.normalizeDramaScript({ ...current, ...req.body }),
      status: String(req.body?.status || current.status || 'draft'),
      updatedAt: now
    };
    await scriptRef.update(updated);
    return res.json({ success: true, script: { id: scriptRef.id, ...updated } });
  } catch (error) {
    logger.error('Drama script update failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.delete('/api/drama/scripts/:id', requireDramaAccess, async (req, res) => {
  try {
    const scriptRef = db.collection('drama_scripts').doc(req.params.id);
    const snapshot = await scriptRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama script not found' });
    if (snapshot.data().userId !== req.authUser.uid && !req.authUser.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    await scriptRef.delete();
    return res.json({ success: true });
  } catch (error) {
    logger.error('Drama script delete failed', error);
    return res.status(500).json({ error: error.message });
  }
});

// Drama video job: creates an episode from an approved script.
app.post('/api/drama/scripts/:id/jobs', requireDramaAccess, async (req, res) => {
  try {
    const scriptRef = db.collection('drama_scripts').doc(req.params.id);
    const snapshot = await scriptRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama script not found' });
    const scriptData = snapshot.data();
    if (scriptData.userId !== req.authUser.uid && !req.authUser.isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const script = drama.normalizeDramaScript(scriptData);
    if (!script.title) return res.status(400).json({ error: 'Generate a script before creating a video' });
    if (!Array.isArray(script.scenes) || script.scenes.length < 1) {
      return res.status(400).json({ error: 'Generate and save the scene plan before creating a video' });
    }

    const jobRef = db.collection('drama_jobs').doc();
    let episodeNumber;
    await db.runTransaction(async transaction => {
      const transactionSnapshot = await transaction.get(scriptRef);
      if (!transactionSnapshot.exists) throw Object.assign(new Error('Drama script not found'), { statusCode: 404 });
      const current = transactionSnapshot.data();
      episodeNumber = (Number(current.episodeCount) || 0) + 1;
      const now = Date.now();
      transaction.update(scriptRef, { episodeCount: episodeNumber, updatedAt: now });
      transaction.set(jobRef, {
        userId: req.authUser.uid,
        userEmail: req.authUser.email,
        scriptId: req.params.id,
        title: script.title,
        characters: script.characters,
        baseImagePrompt: script.baseImagePrompt,
        scenes: script.scenes.map((scene, index) => ({
          index,
          title: scene.title,
          description: scene.description,
          imagePrompt: scene.imagePrompt,
          videoPrompt: scene.videoPrompt,
          dialogue: scene.dialogue,
          imageTaskId: scene.imageTaskId || null,
          imageUrl: scene.imageUrl || null,
          videoTaskId: scene.videoTaskId || null,
          videoUrl: scene.videoUrl || null,
          audioStatus: null,
          status: 'pending',
          error: null
        })),
        episodeNumber,
        status: 'queued',
        progress: 0,
        currentScene: null,
        finalUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now
      });
    });
    drama.processDramaJob(jobRef.id);
    return res.status(202).json({ success: true, jobId: jobRef.id, status: 'queued', episodeNumber });
  } catch (error) {
    logger.error('Drama job creation failed', error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Generate a single scene's still image or video independently. Persists the
// result (imageUrl / videoUrl + task status) back onto the script scene doc.
app.post('/api/drama/scripts/:id/scenes/:sceneIndex/:mediaType', requireDramaAccess, async (req, res) => {
  try {
    const sceneIndex = Number(req.params.sceneIndex);
    const mediaType = String(req.params.mediaType || '').toLowerCase();
    if (mediaType !== 'image' && mediaType !== 'video') {
      return res.status(400).json({ error: 'mediaType must be "image" or "video"' });
    }

    const scriptRef = db.collection('drama_scripts').doc(req.params.id);
    const snapshot = await scriptRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama script not found' });
    const scriptData = snapshot.data();
    if (scriptData.userId !== req.authUser.uid && !req.authUser.isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const script = drama.normalizeDramaScript(scriptData);
    if (!script.scenes[sceneIndex]) return res.status(400).json({ error: `Scene ${sceneIndex + 1} not found` });

    const result = await drama.startSceneMedia({
      scriptRef,
      script,
      sceneIndex,
      mediaType,
      userId: req.authUser.uid,
      userEmail: req.authUser.email
    });

    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    logger.error('Drama single scene media generation failed', error);
    const status = (error.message && error.message.includes('trước')) ? 400 : 500;
    return res.status(status).json({ error: error.message });
  }
});

app.get('/api/drama/scripts/:id/jobs/latest', requireDramaAccess, async (req, res) => {
  try {
    const scriptRef = db.collection('drama_scripts').doc(req.params.id);
    const scriptSnap = await scriptRef.get();
    if (!scriptSnap.exists) return res.status(404).json({ error: 'Drama script not found' });
    if (scriptSnap.data().userId !== req.authUser.uid && !req.authUser.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const snapshot = await db.collection('drama_jobs')
      .where('scriptId', '==', req.params.id)
      .get();
    if (snapshot.empty) return res.json({ job: null });
    
    // Sort in memory to avoid Firestore composite index requirement
    const jobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    return res.json({ job: jobs[0] });
  } catch (error) {
    logger.error('Drama latest job lookup failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/drama/jobs/:id', requireDramaAccess, async (req, res) => {
  try {
    const snapshot = await db.collection('drama_jobs').doc(req.params.id).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama job not found' });
    if (snapshot.data().userId !== req.authUser.uid && !req.authUser.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json({ id: snapshot.id, ...snapshot.data() });
  } catch (error) {
    logger.error('Drama job lookup failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/drama/jobs/:id/cancel', requireDramaAccess, async (req, res) => {
  try {
    const jobRef = db.collection('drama_jobs').doc(req.params.id);
    const snapshot = await jobRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Drama job not found' });
    const job = snapshot.data();
    if (job.userId !== req.authUser.uid && !req.authUser.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    if (job.status === 'completed' || job.status === 'failed') {
      return res.status(400).json({ error: 'Tác vụ đã kết thúc trước đó.' });
    }
    
    await jobRef.update({
      status: 'failed',
      error: 'Tác vụ bị người dùng dừng chạy.',
      updatedAt: Date.now()
    });
    
    return res.json({ success: true, message: 'Đã dừng tác vụ thành công.' });
  } catch (error) {
    logger.error('Drama job cancellation failed', error);
    return res.status(500).json({ error: error.message });
  }
});

// Local file upload endpoint: forwards files to R2 to store input assets in R2
app.post('/api/upload', upload.array('files'), async (req, res) => {
  try {
    const urls = [];
    for (const file of req.files) {
      const buffer = fs.readFileSync(file.path);
      const fileExt = path.extname(file.originalname) || '.jpg';
      const fileName = `meo3/inputs/${uuidv4()}${fileExt}`;
      
      // Determine content type
      let contentType = 'image/jpeg';
      if (fileExt.toLowerCase() === '.png') contentType = 'image/png';
      else if (fileExt.toLowerCase() === '.gif') contentType = 'image/gif';
      
      logger.info(`Uploading input file to R2: ${fileName}...`);
      const r2Url = await uploadToR2(buffer, fileName, contentType);
      urls.push(r2Url);
      
      // Delete temp local file
      try { fs.unlinkSync(file.path); } catch (e) {}
    }
    res.json({ success: true, filePaths: urls }); // Send R2 URLs back to frontend!
  } catch (err) {
    logger.error('R2 upload endpoint failed', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/video/merge', upload.array('videos', 15), async (req, res) => {
  const tempFiles = [];
  let listFilePath = null;
  let outputFilePath = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Không tìm thấy video để ghép." });
    }

    const files = req.files;
    files.forEach(f => tempFiles.push(f.path));

    const listContent = files.map(f => `file '${f.path}'`).join('\n');
    const uniqueId = uuidv4();
    listFilePath = path.join(__dirname, `../uploads/list_${uniqueId}.txt`);
    outputFilePath = path.join(__dirname, `../uploads/merged_${uniqueId}.mp4`);

    fs.writeFileSync(listFilePath, listContent);

    // Run ffmpeg concat demuxer
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFilePath,
      '-c', 'copy',
      outputFilePath
    ];

    logger.info(`Stitching ${files.length} videos using ffmpeg...`);
    
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      });
      child.on('error', (err) => {
        reject(err);
      });
    });

    // Upload the merged video to R2
    const fileBuffer = fs.readFileSync(outputFilePath);
    const fileName = `meo3/outputs/merged_${uniqueId}.mp4`;
    logger.info(`Uploading merged video to R2: ${fileName}...`);
    const r2Url = await uploadToR2(fileBuffer, fileName, 'video/mp4');

    res.json({ success: true, url: r2Url });

  } catch (err) {
    logger.error('Video merge endpoint failed', err);
    res.status(500).json({ error: err.message });
  } finally {
    tempFiles.forEach(p => {
      try { fs.unlinkSync(p); } catch (e) {}
    });
    if (listFilePath) {
      try { fs.unlinkSync(listFilePath); } catch (e) {}
    }
    if (outputFilePath) {
      try { fs.unlinkSync(outputFilePath); } catch (e) {}
    }
  }
});

// Proxy download to force attachment headers (works on mobile, ported from ai_web3)
// Only allows media from our own R2 bucket / audio upstream (prevents SSRF).
const ALLOWED_DOWNLOAD_HOSTS = [
  'pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev',
  'audio.aidancing.net'
];
app.get('/api/download', async (req, res) => {
  const fileUrl = req.query.url;
  const filename = req.query.filename || 'download';
  if (!fileUrl) return res.status(400).send('Missing url parameter');
  let host;
  try {
    host = new URL(fileUrl).hostname;
  } catch {
    return res.status(400).send('Invalid url');
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.includes(host)) {
    return res.status(403).send('Forbidden: url host not allowed');
  }
  try {
    const fetchResponse = await fetch(fileUrl);
    if (!fetchResponse.ok) throw new Error(`HTTP error ${fetchResponse.status}`);
    
    const contentType = fetchResponse.headers.get('Content-Type') || 'application/octet-stream';
    const contentLength = fetchResponse.headers.get('Content-Length');
    const acceptRanges = fetchResponse.headers.get('Accept-Ranges');
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    
    const safeName = filename.replace(/[^\w.\-()+ ]/g, '_').slice(0, 180);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(fetchResponse.body);
    nodeStream.pipe(res);
  } catch (err) {
    logger.error('Proxy download endpoint failed', err);
    res.status(500).send('Failed to download file');
  }
});

// Auto payment webhook (connects with Casso)
app.post('/api/payment-webhook', async (req, res) => {
  try {
    let transactions = [];
    if (req.body && req.body.data && Array.isArray(req.body.data)) {
      transactions = req.body.data;
    } else {
      transactions = [req.body];
    }

    let processedCount = 0;

    for (const tx of transactions) {
      const content = tx.content || tx.description || tx.transferContent || '';
      logger.info(`Received payment webhook. Content: "${content}", Amount: ${tx.amount}`);

      const match = content.match(/VE\d{5,6}/i);
      if (!match) {
        logger.warn(`No payment code found in content: "${content}"`);
        continue;
      }

      const paymentCode = match[0].toUpperCase();
      logger.info(`Matched payment code: ${paymentCode}`);

      const usersSnapshot = await db.collection('users')
        .where('pendingPayment.code', '==', paymentCode)
        .get();

      if (usersSnapshot.empty) {
        logger.warn(`No user found with pending payment code: ${paymentCode}`);
        continue;
      }

      const userDoc = usersSnapshot.docs[0];
      const userData = userDoc.data();
      const pending = userData.pendingPayment;
      
      // Verification: Check if amount matches
      if (tx.amount < pending.amount) {
         logger.warn(`Amount mismatch! Expected ${pending.amount}, got ${tx.amount}. Ignoring upgrade.`);
         continue;
      }

      let newExpiryDate = userData.expiryDate || Date.now();
      const isExpired = !userData.expiryDate || userData.expiryDate < Date.now();
      if (isExpired) {
        newExpiryDate = Date.now() + 30 * 24 * 60 * 60 * 1000;
      }

      await userDoc.ref.update({
        tier: pending.tier,
        expiryDate: newExpiryDate,
        pendingPayment: null,
        updatedAt: Date.now()
      });
      userVideoLimits.invalidate(userDoc.id);
      videoScheduler.scheduleDrain();

      logger.info(`Automatically upgraded user ${userDoc.id} to tier ${pending.tier} via Webhook!`);
      processedCount++;

      // Record payment + update stats for the admin panel
      try {
        const paymentDoc = await db.collection('payments').add({
          userId: userDoc.id,
          email: userData.email || null,
          tier: pending.tier,
          amount: Number(tx.amount || pending.amount || 0),
          code: paymentCode,
          source: 'webhook',
          createdAt: Date.now()
        });
        logger.info(`Payment recorded: ${paymentDoc.id}`);

        // Update aggregate stats (single doc, cheap read for admin)
        const statsRef = db.collection('stats').doc('payments');
        await db.runTransaction(async (t) => {
          const snap = await t.get(statsRef);
          const data = snap.exists ? snap.data() : {};
          const today = new Date();
          const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
          const isToday = data.date === todayStr;
          t.set(statsRef, {
            totalAmount: (data.totalAmount || 0) + Number(tx.amount || 0),
            totalCount: (data.totalCount || 0) + 1,
            todayAmount: isToday ? (data.todayAmount || 0) + Number(tx.amount || 0) : Number(tx.amount || 0),
            todayCount: isToday ? (data.todayCount || 0) + 1 : 1,
            date: todayStr,
            updatedAt: Date.now()
          });
        });
      } catch (payErr) {
        logger.error('Failed to record payment/stats:', payErr.message);
      }

      // Send Telegram notification
      telegram.notifyPayment({
        userId: userDoc.id,
        email: userData.email,
        tier: pending.tier,
        amount: tx.amount || pending.amount,
        code: paymentCode
      }).catch(e => logger.error('Telegram notifyPayment failed:', e.message));
    }
    
    return res.json({ success: true, processed: processedCount });
  } catch (err) {
    logger.error('Error processing payment webhook', err);
    telegram.notifyError('Payment webhook error', err).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
});

// ─── AUDIO (AI DANCING VOICE CLONE) API ────────────────────────────────────
// Daily usage quotas per tier (server-side enforcement)
const AUDIO_LIMITS = {
  free: 1,
  hocvien: 5,
  basic_69k: 5,
  standard_99k: 5,
  premium_169k: 50
};

function audioLimitFor(tier) {
  return AUDIO_LIMITS[tier] ?? AUDIO_LIMITS.free;
}

// Count audio jobs created by a user today (successful or in-progress)
async function getAudioUsageToday(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const snap = await db.collection('audio_tasks')
    .where('userId', '==', userId)
    .get();
  return snap.docs
    .filter(d => (d.data().status || '') !== 'failed' && (d.data().createdAt || 0) >= startOfDay.getTime())
    .length;
}

// List preset voices (cached by audioClient)
app.get('/api/audio/voices', async (req, res) => {
  try {
    const voices = await audioClient.getVoices();
    res.json({ voices, lang: 'vi', total: voices.length });
  } catch (err) {
    logger.error('Audio voices endpoint failed', err);
    res.status(500).json({ error: err.message });
  }
});

// Create + start an audio clone job. Enforces per-tier daily quota server-side.
app.post('/api/audio/generate', async (req, res) => {
  try {
    const { userId, userEmail, text, voiceIndex } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'Missing text' });
    if (voiceIndex === undefined || voiceIndex === null) return res.status(400).json({ error: 'Missing voiceIndex' });

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    let tier = userData.tier || 'free';
    if (tier !== 'free' && userData.expiryDate && userData.expiryDate < Date.now()) {
      tier = 'free';
    }

    const used = await getAudioUsageToday(userId);
    const limit = audioLimitFor(tier);
    if (used >= limit) {
      return res.status(429).json({
        error: `Bạn đã dùng hết ${limit} lượt tạo âm thanh hôm nay của gói hiện tại.`,
        limit,
        used,
        tier
      });
    }

    const jobUid = await audioClient.createJob(String(text).trim(), 'vi', Number(voiceIndex));
    await audioClient.startJob(jobUid);

    const docRef = await db.collection('audio_tasks').add({
      userId,
      userEmail: userEmail || null,
      text: String(text).trim().substring(0, 500),
      voiceIndex: Number(voiceIndex),
      jobUid,
      status: 'PROCESSING',
      outputUrl: null,
      error: null,
      tier,
      createdAt: Date.now()
    });

    logger.info(`[Audio] Created job ${jobUid} for user ${userId} (${used + 1}/${limit})`);
    res.json({ jobId: docRef.id, jobUid, used: used + 1, limit, tier });
  } catch (err) {
    logger.error('Audio generate endpoint failed', err);
    res.status(500).json({ error: err.message });
  }
});

// List user's audio tasks, refreshing any in-progress jobs from the upstream session
app.get('/api/audio/jobs', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const snap = await db.collection('audio_tasks')
      .where('userId', '==', userId)
      .get();
    const docs = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 50);

    let upstream = [];
    const activeDocs = docs.filter(d => {
      const s = d.status;
      return s === 'PROCESSING' || s === 'PENDING';
    });
    if (activeDocs.length > 0) {
      try {
        upstream = await audioClient.listJobs();
      } catch (e) {
        logger.warn(`[Audio] listJobs failed: ${e.message}`);
      }
    }

    const jobs = await Promise.all(docs.map(async (d) => {
      const data = d;
      let status = data.status;
      let outputUrl = data.outputUrl;

      if ((status === 'PROCESSING' || status === 'PENDING') && upstream.length > 0) {
        const match = upstream.find(j => j.jobUid === data.jobUid);
        if (match) {
          status = match.status;
          if (match.outputUrl) {
            outputUrl = match.outputUrl.startsWith('http')
              ? match.outputUrl
              : `${audioClient.BASE_URL}${match.outputUrl}`;
          }
          if (status !== data.status || outputUrl !== data.outputUrl) {
            try {
              await db.collection('audio_tasks').doc(d.id).update({ status, outputUrl, updatedAt: Date.now() });
            } catch (e) {}
          }
        }
      }

      return {
        id: d.id,
        jobUid: data.jobUid,
        text: data.text,
        voiceIndex: data.voiceIndex,
        status,
        outputUrl,
        error: data.error,
        tier: data.tier,
        createdAt: data.createdAt
      };
    }));

    const used = await getAudioUsageToday(userId);

    let tier = 'free';
    try {
      const u = await db.collection('users').doc(userId).get();
      const ud = u.exists ? u.data() : {};
      tier = ud.tier || 'free';
      if (tier !== 'free' && ud.expiryDate && ud.expiryDate < Date.now()) tier = 'free';
    } catch (e) {}

    res.json({ jobs, used, limit: audioLimitFor(tier), tier });
  } catch (err) {
    logger.error('Audio jobs endpoint failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── FIRESTORE COOKIE SYNC LISTENER ──────────────────────────────────────────

function startCookieSyncListener() {
  return new Promise((resolve) => {
    logger.info("Starting Firestore Listener for cookies...");
    let resolved = false;

    db.collection('settings').doc('cookies').onSnapshot(async (doc) => {
      let remoteCookiesUpdated = false;
      if (doc.exists) {
        const data = doc.data();
        const remoteCookies = data.cookies;
        
        if (remoteCookies) {
          // Read local cookies
          let localCookies = '';
          if (fs.existsSync(config.COOKIE_FILE)) {
            try {
              localCookies = fs.readFileSync(config.COOKIE_FILE, 'utf-8').trim();
            } catch (e) {
              logger.error("Failed to read local cookies file", e);
            }
          }
          
          // Compare and update if different
          if (remoteCookies !== localCookies) {
            logger.info("Cookies changed in Firestore. Updating local cookies.json...");
            try {
              fs.writeFileSync(config.COOKIE_FILE, remoteCookies, 'utf-8');
              remoteCookiesUpdated = true;
            } catch (err) {
              logger.error("Failed to update local cookies from Firestore", err);
            }
          }
        }
      } else {
        logger.warn("No cookies document found in settings collection in Firestore.");
      }

      if (!resolved) {
        resolved = true;
        resolve(); // Resolve on first snapshot so startup continues
      } else if (remoteCookiesUpdated) {
        // Subsequent update, apply dynamically
        logger.info("Re-injecting updated cookies and refreshing browser session...");
        try {
          await browserManager.injectCookies();
          await browserManager.refreshSession();
        } catch (err) {
          logger.error("Failed to refresh session with updated cookies:", err);
        }
      }
    }, (err) => {
      logger.error("Firestore cookies listener error:", err);
      if (!resolved) {
        resolved = true;
        resolve(); // Continue startup even if database listener fails
      }
    });
  });
}

// ─── FIRESTORE WORKER LISTENER ──────────────────────────────────────────────

async function rehydrateTasks() {
  try {
    const snap = await db.collection('tasks')
      .where('status', 'in', ['processing', 'pending'])
      .get();
    let vid = 0, img = 0;
    for (const doc of snap.docs) {
      const taskData = doc.data();
      const taskId = doc.id;
      if (tasks[taskId]) continue;
      tasks[taskId] = {
        id: taskId,
        docRef: doc.ref,
        status: taskData.status,
        media: [],
        error: null,
        ...taskData
      };
      if (taskData.type === 'video') {
        videoScheduler.enqueue(taskId);
        vid++;
      } else if (taskData.type === 'image') {
        imageQueue.push(taskId);
        img++;
      }
    }
    logger.info(`Rehydrated ${vid} video task(s), ${img} image task(s) from Firestore`);
    if (img > 0) drainImageQueue();
  } catch (err) {
    logger.error('Rehydrate tasks error: ', err);
  }
}

function startFirestoreListener() {
  logger.info("Starting Firestore Listener for tasks...");
  
  db.collection('tasks')
    .where('status', '==', 'pending')
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const doc = change.doc;
          const taskData = doc.data();
          const taskId = doc.id;
          
          if (!tasks[taskId] || tasks[taskId].status === 'failed') {
            // Register local task
            tasks[taskId] = {
              id: taskId,
              docRef: doc.ref,
              status: 'queued',
              media: [],
              error: null,
              ...taskData
            };

            if (taskData.type === 'video') {
              videoScheduler.enqueue(taskId);
              logger.info(`Task queued from Firestore: ${taskId} (type: video, prompt: "${String(taskData.prompt || '').substring(0, 20)}...")`);
            } else {
              imageQueue.push(taskId);
              logger.info(`Task queued from Firestore: ${taskId} (type: image, prompt: "${String(taskData.prompt || '').substring(0, 20)}...")`);
              drainImageQueue();
            }
          }
        }
      });
    }, (error) => {
      logger.error("Firestore listen error: ", error);
    });
}

// ─── IMAGE WORKER (concurrent) ──────────────────────────────────────────────

function drainImageQueue() {
  while (activeImageWorkers < IMAGE_CONCURRENCY && imageQueue.length > 0) {
    const taskId = imageQueue.shift();
    activeImageWorkers++;
    runImageTask(taskId).finally(() => {
      activeImageWorkers--;
      drainImageQueue(); // pick next task when a slot frees up
    });
  }
}

// Helper function to process image input (downloads URLs or uploads file paths)
async function processImageInput(imgInput, client = apiClient) {
  if (!imgInput) return null;
  if (typeof imgInput === 'string' && imgInput.startsWith('http')) {
    logger.info(`Fetching image URL: ${imgInput}`);
    const res = await fetch(imgInput);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return await client.uploadImage(buffer);
  } else if (typeof imgInput === 'string' && fs.existsSync(imgInput)) {
    const mediaId = await client.uploadImage(imgInput);
    try { fs.unlinkSync(imgInput); } catch (e) {}
    return mediaId;
  }
  return imgInput; // Return as-is if it's already a mediaId or something else
}

async function runImageTask(taskId) {
  const task = tasks[taskId];
  if (!task) return;

  const imageClient = apiClient.image;
  const imageBrowser = browserManager;

  try {
    await task.docRef.update({ status: 'processing' });
    task.status = 'generating';
    logger.info(`[Image] Starting task: ${taskId} (active workers: ${activeImageWorkers})`);

    // Upload reference images if any (supports array task.referenceImages)
    if (Array.isArray(task.referenceImages) && task.referenceImages.length > 0) {
      const mediaIds = [];
      for (const imgInput of task.referenceImages) {
        const mediaId = await processImageInput(imgInput, imageClient);
        if (mediaId) mediaIds.push(mediaId);
      }
      task.referenceImages = mediaIds;
    } else if (task.referenceImage) {
      // Legacy single reference image fallback
      const mediaId = await processImageInput(task.referenceImage, imageClient);
      task.referenceImages = mediaId ? [mediaId] : [];
    }

    const chosenModel = task.model || 'imagen_4';
    const imageModels = ['imagen_4', 'nano_banana_pro', 'nano_banana_2'];
    // Ensure the chosen model is tried first, then fallbacks (skip models that
    // already exhausted their daily quota so we don't waste attempts).
    const imageModelsToTry = [chosenModel, ...imageModels.filter(m => m !== chosenModel)]
      .filter(m => !imageQuotaExhaustedModels.has(m));

    let genRes = null;
    let lastError = null;

    for (const modelKey of imageModelsToTry) {
      try {
        await acquireGenerationSlot('image');
        logger.info(`[Image] Attempting generation with model: ${modelKey}`);
        genRes = await imageClient.generateImage(task.prompt, {
          aspectRatio: task.aspectRatio,
          model: modelKey,
          count: task.count,
          referenceImages: task.referenceImages
        });
        if (genRes && genRes.media && genRes.media.length > 0) {
          logger.success(`[Image] Generation succeeded with model: ${modelKey}`);
          break; // Successfully triggered and generated!
        }
      } catch (err) {
        if (isDailyQuotaError(err)) {
          imageQuotaExhaustedModels.add(modelKey);
          logger.warn(`[Image] Model ${modelKey} hit daily quota; blacklisting for today. Trying next fallback model...`);
        } else if (isThrottleError(err)) {
          registerThrottle('image', err);
          await requeueThrottledTask(task, 'image');
          return;
        } else {
          logger.warn(`[Image] Model ${modelKey} failed: ${err.message}. Trying next fallback model...`);
        }
        lastError = err;
      }
    }

    if (!genRes || !genRes.media || genRes.media.length === 0) {
      throw new Error(lastError ? lastError.message : "All image models failed to generate media");
    }

    const generatedImages = genRes.media || [];
    const finalMedia = [];

    for (const item of generatedImages) {
      const name = item.name;
      let targetUrl = item.image?.generatedImage?.fifeUrl || null;

      if (!targetUrl) {
        try {
          targetUrl = await imageClient.getMediaUrl(name);
        } catch (e) {
          const mediaStatus = item.mediaMetadata?.mediaStatus || {};
          const failureCode = [
            mediaStatus.error?.message,
            mediaStatus.mediaGenerationFailureReason,
            ...(mediaStatus.failureReasons || []),
            mediaStatus.mediaGenerationStatus,
            `IMAGE_URL_CAPTURE_FAILED: ${e.message}`
          ].filter(Boolean).join(', ');
          const failure = getFriendlyTaskFailure({ code: failureCode, message: failureCode }, 'image');
          finalMedia.push({ mediaId: name, status: 'failed', error: failure.message, errorCode: failure.code });
          continue;
        }
      }

      // Tải và Upload R2 thông qua Puppeteer để tránh 403 Forbidden (with retry)
      let lastImgErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) logger.info(`[Image] Download retry ${attempt}/3 for ${taskId}...`);

          logger.info(`Downloading image via browser context (attempt ${attempt}/3)...`);
          const bufferArray = await imageBrowser.page.evaluate(async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const buffer = await res.arrayBuffer();
            return Array.from(new Uint8Array(buffer));
          }, targetUrl);
          
          const buffer = Buffer.from(bufferArray);
          const fileName = `meo3/images/${taskId}_${Date.now()}.jpg`;
          const r2Url = await uploadToR2(buffer, fileName, 'image/jpeg');
          
          finalMedia.push({ mediaId: name, status: 'success', url: r2Url });
          lastImgErr = null;
          break;
        } catch (e) {
          lastImgErr = e;
          logger.warn(`[Image] Download attempt ${attempt}/3 failed: ${e.message}`);
          if (attempt < 3) await sleep(2000 * attempt);
        }
      }

      if (lastImgErr) {
        const failure = getFriendlyTaskFailure({
          code: `IMAGE_UPLOAD_R2_FAILED: ${lastImgErr.message}`,
          message: `IMAGE_UPLOAD_R2_FAILED: ${lastImgErr.message}`
        }, 'image');
        finalMedia.push({ mediaId: name, status: 'failed', error: failure.message, errorCode: failure.code });
      }
    }

    task.media = finalMedia;
    task.status = 'completed';
    const successfulUrl = finalMedia.find(m => m.status === 'success')?.url || null;

    if (successfulUrl) {
      await task.docRef.update({ status: 'completed', mediaUrl: successfulUrl });
      logger.success(`[Image] Task ${taskId} completed and saved to Firestore! URL: ${successfulUrl}`);
    } else {
      const failedItems = finalMedia.filter(media => media.status !== 'success');
      const priorityFailure = failedItems.find(media => !isRetryableTaskFailure(media)) || failedItems[0];
      const failureError = new Error(priorityFailure?.error || 'Không tạo được ảnh. Hãy thử lại.');
      failureError.code = [...new Set(failedItems.map(media => media.errorCode).filter(Boolean))].join(' | ')
        || 'NO_SUCCESSFUL_IMAGE';
      throw failureError;
    }

  } catch (err) {
    logger.error(`[Image] Task ${taskId} failed`, err);
    const failure = getFriendlyTaskFailure(err, 'image');
    task.status = 'failed';
    task.error = failure.message;
    task.errorCode = failure.code;
    await task.docRef.update({ status: 'failed', error: failure.message, errorCode: failure.code });

    // Send Telegram notification
    telegram.notifyTaskFailed({
      taskId,
      type: 'image',
      userId: task.userId,
      prompt: task.prompt,
      error: failure.message,
      errorCode: failure.code
    }).catch(e => logger.error('Telegram notifyTaskFailed (image) failed:', e.message));
  }

  // Anti-spam Cooldown: Sleep for 10 to 15 seconds to avoid triggering Google's UNUSUAL_ACTIVITY
  const cooldown = 10000 + Math.floor(Math.random() * 5000);
  logger.info(`[Image] Cooldown active. Waiting ${Math.round(cooldown/1000)}s before worker takes next task...`);
  await sleep(cooldown);
}

// ─── VIDEO WORKER (concurrent, with per-user tier limits) ────────────────────

function getVideoFailure(item) {
  const mediaStatus = item.mediaMetadata?.mediaStatus || {};
  const codes = [
    mediaStatus.error?.message,
    mediaStatus.mediaGenerationFailureReason,
    ...(mediaStatus.failureReasons || []),
    ...(mediaStatus.audioGenerationFailures || []),
    mediaStatus.mediaGenerationStatus
  ].filter(Boolean);
  const rawCode = codes.join(', ') || 'VIDEO_GENERATION_FAILED';
  return getFriendlyTaskFailure({ code: rawCode, message: rawCode }, 'video');
}

async function runVideoTask(taskId) {
  const task = tasks[taskId];
  if (!task) return;

  try {
    await task.docRef.update({ status: 'processing' });
    task.status = 'generating';
    const vc = nextVideoClient();
    logger.info(`[Video] Starting task execution: ${taskId} via nick ${vc.label} (active workers: ${videoScheduler.activeCount}, user workers: ${videoScheduler.activeForUser(task.userId || 'anonymous')})`);

    // 1. Upload start/end images if they are filepaths or URLs
    task.startImage = await processImageInput(task.startImage, vc);
    task.endImage = await processImageInput(task.endImage, vc);

    // Only use the forced Veo 3.1 Lite (Lower Priority) model without fallback as requested
    const videoModelsToTry = ['veo_3_1_lite'];

    // Stagger generation triggers with a small random delay so concurrent workers
    // don't fire reCAPTCHA + generation requests at the exact same instant
    // (avoids Google PUBLIC_ERROR_UNUSUAL_ACTIVITY blocks).
    const genDelay = 5000 + Math.floor(Math.random() * 5000);
    logger.info(`[Video] Staggering generation trigger by ${Math.round(genDelay/1000)}s...`);
    await sleep(genDelay);

    let genRes = null;
    let lastError = null;

    for (const modelKey of videoModelsToTry) {
      try {
        await acquireGenerationSlot('video');
        logger.info(`[Video] Attempting generation with model: ${modelKey}`);
        genRes = await vc.generateVideo(task.prompt, {
          aspectRatio: task.aspectRatio,
          model: modelKey,
          count: task.count,
          startImage: task.startImage,
          endImage: task.endImage,
          durationSeconds: task.durationSeconds,
          voice: task.voice
        });
        if (genRes && genRes.media && genRes.media.length > 0) {
          logger.success(`[Video] Generation request triggered with model: ${modelKey}`);
          break; // Successfully triggered!
        }
      } catch (err) {
        if (isThrottleError(err)) {
          registerThrottle('video', err);
          await requeueThrottledTask(task, 'video');
          return;
        }
        logger.warn(`[Video] Model ${modelKey} failed to trigger: ${err.message}. Trying next fallback model...`);
        lastError = err;
      }
    }

    if (!genRes || !genRes.media || genRes.media.length === 0) {
      throw new Error(lastError ? lastError.message : "All video models failed to trigger");
    }

    const rawMedia = genRes.media || [];
    if (rawMedia.length === 0) {
      throw new Error('Google Labs returned 0 media tasks to generate');
    }

    const mediaToPoll = rawMedia.map(m => ({
      name: m.name,
      projectId: m.projectId || vc.projectId
    }));

    // 3. Poll for status
    logger.info(`Polling status for ${mediaToPoll.length} items...`);
    const pollRes = await vc.waitForVideos(mediaToPoll, {
      onProgress: (statusData, elapsed) => {
        task.progress = `${elapsed}s elapsed`;
        logger.info(`[Video] Task ${taskId} polling progress: ${elapsed}s`);
      }
    });

    // 4. Resolve download links and upload to R2
    const finalMedia = [];
    for (const item of pollRes.media) {
      logger.info(`Media check response item: ${JSON.stringify(item)}`);
      const genStatus = item.mediaMetadata?.mediaStatus?.mediaGenerationStatus || 
                        item.mediaMetadata?.generationStatus || 
                        item.status?.state;
      if (genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || genStatus === 'GENERATION_STATUS_SUCCESSFUL' || genStatus === 'SUCCESSFUL') {
        const projectId = item.projectId;
        const workflowId = item.workflowId;
        const downloadUrl = await vc.getMediaUrl(item.name, 'MEDIA_URL_TYPE_VIDEO', { projectId, workflowId });

        // Download with retry (up to 3 attempts)
        let lastDlErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (attempt > 1) logger.info(`[Video] Download retry ${attempt}/3 for ${taskId}...`);

            logger.info(`Downloading video via browser context (attempt ${attempt}/3)...`);
            const bufferArray = await vc.browserManager.page.evaluate(async (url) => {
              const res = await fetch(url);
              if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
              const buffer = await res.arrayBuffer();
              return Array.from(new Uint8Array(buffer));
            }, downloadUrl);

            const buffer = Buffer.from(bufferArray);
            const fileName = `meo3/videos/${taskId}_${Date.now()}.mp4`;
            logger.info(`Uploading video to R2 as ${fileName} (Size: ${buffer.length} bytes)...`);
            const r2Url = await uploadToR2(buffer, fileName, 'video/mp4');

            finalMedia.push({
              mediaId: item.name,
              status: 'success',
              url: r2Url
            });
            lastDlErr = null;
            break;
          } catch (dlErr) {
            lastDlErr = dlErr;
            logger.warn(`[Video] Download attempt ${attempt}/3 failed: ${dlErr.message}`);
            if (attempt < 3) await sleep(3000 * attempt);
          }
        }

        if (lastDlErr) {
          finalMedia.push({
            mediaId: item.name,
            status: 'url_failed',
            error: 'Video đã tạo nhưng tải xuống thất bại. Hãy thử lại.',
            errorCode: `VIDEO_DOWNLOAD_FAILED: ${lastDlErr.message}`
          });
        }
      } else {
        const failure = getVideoFailure(item);
        finalMedia.push({
          mediaId: item.name,
          status: 'failed',
          error: failure.message,
          errorCode: failure.code
        });
      }
    }

    task.media = finalMedia;
    task.status = 'completed';
    const successfulUrl = finalMedia.find(m => m.status === 'success')?.url || null;

    if (successfulUrl) {
      await task.docRef.update({ status: 'completed', mediaUrl: successfulUrl });
      logger.success(`[Video] Task ${taskId} completed and saved to Firestore! URL: ${successfulUrl}`);
    } else {
      const failedItems = finalMedia.filter(media => media.status !== 'success');
      const priorityFailure = failedItems.find(media => media.errorCode?.includes('PROMINENT'))
        || failedItems.find(media => media.errorCode?.includes('IP_'))
        || failedItems[0];
      const failureError = new Error(priorityFailure?.error || 'Không tạo được video. Hãy thử lại.');
      failureError.code = [...new Set(failedItems.map(media => media.errorCode).filter(Boolean))].join(' | ');
      throw failureError;
    }

  } catch (err) {
    logger.error(`[Video] Task ${taskId} failed`, err);
    const failure = getFriendlyTaskFailure(err, 'video');
    task.status = 'failed';
    task.error = failure.message;
    task.errorCode = failure.code;
    await task.docRef.update({ status: 'failed', error: failure.message, errorCode: failure.code });

    // Send Telegram notification
    telegram.notifyTaskFailed({
      taskId,
      type: 'video',
      userId: task.userId,
      prompt: task.prompt,
      error: failure.message,
      errorCode: failure.code
    }).catch(e => logger.error('Telegram notifyTaskFailed (video) failed:', e.message));
  }

  // Anti-spam Cooldown: Sleep for 10 to 15 seconds to avoid triggering Google's UNUSUAL_ACTIVITY
  const cooldown = 10000 + Math.floor(Math.random() * 5000);
  logger.info(`[Video] Cooldown active. Waiting ${Math.round(cooldown/1000)}s before worker takes next task...`);
  await sleep(cooldown);
}


// Cleanup tasks older than 24 hours (1 day)
async function cleanupOldTasks() {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  logger.info(`Running periodic cleanup for tasks created before ${new Date(oneDayAgo).toISOString()}...`);
  try {
    const snapshot = await db.collection('tasks')
      .where('createdAt', '<', oneDayAgo)
      .get();
    
    if (snapshot.empty) {
      logger.info('No expired tasks to clean up.');
    } else {
      logger.info(`Found ${snapshot.size} expired tasks. Starting media deletion from R2 & doc deletion from Firestore...`);
      const batch = db.batch();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const filesToDelete = [];
        if (data.mediaUrl) filesToDelete.push(data.mediaUrl);
        if (data.startImage && typeof data.startImage === 'string') filesToDelete.push(data.startImage);
        if (data.endImage && typeof data.endImage === 'string') filesToDelete.push(data.endImage);
        if (data.media && Array.isArray(data.media)) {
          for (const m of data.media) {
            if (m.url) filesToDelete.push(m.url);
          }
        }

          // Delete files from R2
          for (const url of filesToDelete) {
            if (url && url.startsWith(process.env.R2_PUBLIC_BASE)) {
              const fileKey = url.replace(`${process.env.R2_PUBLIC_BASE}/`, '');
              const isOurFolder = fileKey.startsWith('meo3/videos/') || fileKey.startsWith('meo3/images/') || fileKey.startsWith('meo3/inputs/');
              if (isOurFolder) {
                try {
                  await deleteFromR2(fileKey);
                  logger.info(`Deleted file from Cloudflare R2: ${fileKey}`);
                } catch (r2Err) {
                }
              }
            }
          }

        // Add to Firestore batch delete
        batch.delete(doc.ref);
      }

      await batch.commit();
      logger.success(`Successfully deleted ${snapshot.size} expired tasks from Firestore and matching media files from Cloudflare R2.`);
    }

    // Clean up expired audio_tasks docs (media is hosted upstream on audio.aidancing.net,
    // so we only remove the Firestore records after 24h).
    const audioSnap = await db.collection('audio_tasks')
      .where('createdAt', '<', oneDayAgo)
      .get();
    if (!audioSnap.empty) {
      const audioBatch = db.batch();
      for (const doc of audioSnap.docs) {
        audioBatch.delete(doc.ref);
      }
      await audioBatch.commit();
      logger.success(`Successfully deleted ${audioSnap.size} expired audio_tasks from Firestore.`);
    }
  } catch (err) {
    logger.error('Error during expired tasks cleanup', err);
  }
}

function scheduleDailyCleanup(hour = 23, minute = 50) {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(hour, minute, 0, 0);
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const delay = nextRun.getTime() - now.getTime();
  logger.info(`Scheduled cleanup at ${nextRun.toString()} (in ${Math.round(delay / 60000)} minutes)`);

  setTimeout(() => {
    cleanupOldTasks().catch(err => logger.error('Scheduled cleanup failed', err));
    setInterval(() => {
      cleanupOldTasks().catch(err => logger.error('Scheduled cleanup failed', err));
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

// Start HTTP + Socket.io Server
captchaService.attach(io);

// Start Firestore Cookie Sync first
startCookieSyncListener().then(() => {
  // Rehydrate in-flight/queued tasks across restarts
  rehydrateTasks().then(() => {
    // Start Firestore Listener
    startFirestoreListener();
    resumeAutoToolJobs().catch(err => logger.error('[AutoTool] Resume failed', err));
    drama.resumeDramaJobs().catch(err => logger.error('[Drama] Resume failed', err));
  });

  // Run cleanup once per day at 23:50 server time
  scheduleDailyCleanup(23, 50);

  // Initialize Browser Manager on start so it is warmed up
  browserManager.initialize().catch(err => {
    logger.warn(`Initial browser startup warning: ${err.message}. It will retry on the first API call.`);
  });
  if (fs.existsSync(config.IMAGE_USER_DATA_DIR)) {
    browserManager.image.initialize().catch(err => {
      logger.warn(`Initial image browser startup warning: ${err.message}. It will retry on the first API call.`);
    });
  }

  // Warm up the 2nd video nick if its profile exists (login captured on first request)
  if (fs.existsSync(config.VIDEO2_USER_DATA_DIR)) {
    browserManager.video2.initialize().catch(err => {
      logger.warn(`Initial video2 browser startup warning: ${err.message}. It will retry on the first API call.`);
    });
  }

  // Schedule automatic 30-minute Google Flow tab refresh to keep session + cookies alive
  const THIRTY_MINUTES_MS = 30 * 60 * 1000;
  setInterval(async () => {
    logger.info("[Scheduled Task] Refreshing Google Flow session to keep cookies fresh...");
    try {
      await browserManager.refreshSession();
      logger.info("[Scheduled Task] Google Flow session refresh done");
    } catch (refreshErr) {
      logger.warn("[Scheduled Task] Google Flow session refresh failed:", refreshErr.message);
    }
  }, THIRTY_MINUTES_MS);
});

server.listen(config.PORT, () => {
  logger.success(`VEO3 API Server (Worker Mode) running on port ${config.PORT}`);
  logger.info(`Web socket listener attached for Chrome Extension`);
});
