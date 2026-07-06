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
const { db } = require('./firebase_worker');
const { uploadToR2, deleteFromR2 } = require('./s3_uploader');

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
const upload = multer({ dest: path.join(__dirname, '../uploads/') });

// Task state store
const tasks = {};
const imageQueue = [];   // parallel image tasks
const videoQueue = [];   // sequential video tasks

// Concurrency config
const IMAGE_CONCURRENCY = 3;  // up to 3 image tasks at once
let activeImageWorkers = 0;

const VIDEO_CONCURRENCY = 4;  // up to 4 video tasks at once
let activeVideoWorkers = 0;

app.use(cors());
app.use(express.json());

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
    
    await browserManager.injectCookies();
    await browserManager.refreshSession();

    res.json({ success: true, message: 'Cookies updated and injected successfully' });
  } catch (err) {
    res.status(500).json({ error: `Failed to update cookies: ${err.message}` });
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

      const match = content.match(/VE\d{5,6}/i) || content.match(/ME\d{5,6}/i);
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

      logger.info(`Automatically upgraded user ${userDoc.id} to tier ${pending.tier} via Webhook!`);
      processedCount++;
    }
    
    return res.json({ success: true, processed: processedCount });
  } catch (err) {
    logger.error('Error processing payment webhook', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── FIRESTORE WORKER LISTENER ──────────────────────────────────────────────

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
          
          if (!tasks[taskId]) {
            // Register local task
            tasks[taskId] = {
              id: taskId,
              docRef: doc.ref,
              status: 'queued',
              media: [],
              error: null,
              ...taskData
            };

            // Update Firestore to processing
            doc.ref.update({ status: 'processing' });

            if (taskData.type === 'video') {
              videoQueue.push(taskId);
              logger.info(`Task queued from Firestore: ${taskId} (type: video, prompt: "${taskData.prompt.substring(0, 20)}...")`);
              drainVideoQueue();
            } else {
              imageQueue.push(taskId);
              logger.info(`Task queued from Firestore: ${taskId} (type: image, prompt: "${taskData.prompt.substring(0, 20)}...")`);
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
async function processImageInput(imgInput) {
  if (!imgInput) return null;
  if (typeof imgInput === 'string' && imgInput.startsWith('http')) {
    logger.info(`Fetching image URL: ${imgInput}`);
    const res = await fetch(imgInput);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return await apiClient.uploadImage(buffer);
  } else if (typeof imgInput === 'string' && fs.existsSync(imgInput)) {
    const mediaId = await apiClient.uploadImage(imgInput);
    try { fs.unlinkSync(imgInput); } catch (e) {}
    return mediaId;
  }
  return imgInput; // Return as-is if it's already a mediaId or something else
}

async function runImageTask(taskId) {
  const task = tasks[taskId];
  if (!task) return;

  task.status = 'generating';
  logger.info(`[Image] Starting task: ${taskId} (active workers: ${activeImageWorkers})`);

  try {
    // Upload reference images if any (supports array task.referenceImages)
    if (Array.isArray(task.referenceImages) && task.referenceImages.length > 0) {
      const mediaIds = [];
      for (const imgInput of task.referenceImages) {
        const mediaId = await processImageInput(imgInput);
        if (mediaId) mediaIds.push(mediaId);
      }
      task.referenceImages = mediaIds;
    } else if (task.referenceImage) {
      // Legacy single reference image fallback
      const mediaId = await processImageInput(task.referenceImage);
      task.referenceImages = mediaId ? [mediaId] : [];
    }

    const chosenModel = task.model || 'imagen_4';
    const imageModels = ['imagen_4', 'nano_banana_pro', 'nano_banana_2'];
    // Ensure the chosen model is tried first, then fallbacks
    const imageModelsToTry = [chosenModel, ...imageModels.filter(m => m !== chosenModel)];

    let genRes = null;
    let lastError = null;

    for (const modelKey of imageModelsToTry) {
      try {
        logger.info(`[Image] Attempting generation with model: ${modelKey}`);
        genRes = await apiClient.generateImage(task.prompt, {
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
        logger.warn(`[Image] Model ${modelKey} failed: ${err.message}. Trying next fallback model...`);
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
          targetUrl = await apiClient.getMediaUrl(name);
        } catch (e) {
          finalMedia.push({ mediaId: name, status: 'failed', error: 'Could not capture URL' });
          continue;
        }
      }

      // Tải và Upload R2 thông qua Puppeteer để tránh 403 Forbidden
      try {
        logger.info(`Downloading image via browser context...`);
        const bufferArray = await browserManager.page.evaluate(async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          const buffer = await res.arrayBuffer();
          return Array.from(new Uint8Array(buffer));
        }, targetUrl);
        
        const buffer = Buffer.from(bufferArray);
        const fileName = `meo3/images/${taskId}_${Date.now()}.jpg`;
        const r2Url = await uploadToR2(buffer, fileName, 'image/jpeg');
        
        finalMedia.push({ mediaId: name, status: 'success', url: r2Url });
      } catch (e) {
        finalMedia.push({ mediaId: name, status: 'failed', error: `Upload R2 failed: ${e.message}` });
      }
    }

    task.media = finalMedia;
    task.status = 'completed';
    const successfulUrl = finalMedia.find(m => m.status === 'success')?.url || null;

    if (successfulUrl) {
      await task.docRef.update({ status: 'completed', mediaUrl: successfulUrl });
      logger.success(`[Image] Task ${taskId} completed and saved to Firestore! URL: ${successfulUrl}`);
    } else {
      throw new Error("No successful media generated");
    }

  } catch (err) {
    logger.error(`[Image] Task ${taskId} failed`, err);
    task.status = 'failed';
    task.error = err.message;
    await task.docRef.update({ status: 'failed', error: err.message });
  }

  // Anti-spam Cooldown: Sleep for 5 to 10 seconds to avoid triggering Google's UNUSUAL_ACTIVITY
  const cooldown = 5000 + Math.floor(Math.random() * 5000);
  logger.info(`[Image] Cooldown active. Waiting ${Math.round(cooldown/1000)}s before worker takes next task...`);
  await sleep(cooldown);
}

// ─── VIDEO WORKER (concurrent) ───────────────────────────────────────────────

function drainVideoQueue() {
  while (activeVideoWorkers < VIDEO_CONCURRENCY && videoQueue.length > 0) {
    const taskId = videoQueue.shift();
    activeVideoWorkers++;
    runVideoTask(taskId).finally(() => {
      activeVideoWorkers--;
      drainVideoQueue();
    });
  }
}

async function runVideoTask(taskId) {
  const task = tasks[taskId];
  if (!task) return;

  task.status = 'generating';
  logger.info(`[Video] Starting task execution: ${taskId} (active workers: ${activeVideoWorkers})`);

  try {
    // 1. Upload start/end images if they are filepaths or URLs
    task.startImage = await processImageInput(task.startImage);
    task.endImage = await processImageInput(task.endImage);

    const chosenModel = task.model || 'veo_3_1_lite';
    const videoModels = ['veo_3_1_lite', 'veo_3_1_fast', 'veo_3_1_quality'];
    // Ensure the chosen model is tried first, then fallbacks
    const videoModelsToTry = [chosenModel, ...videoModels.filter(m => m !== chosenModel)];

    let genRes = null;
    let lastError = null;

    for (const modelKey of videoModelsToTry) {
      try {
        logger.info(`[Video] Attempting generation with model: ${modelKey}`);
        genRes = await apiClient.generateVideo(task.prompt, {
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
      projectId: m.projectId || apiClient.projectId
    }));

    // 3. Poll for status
    logger.info(`Polling status for ${mediaToPoll.length} items...`);
    const pollRes = await apiClient.waitForVideos(mediaToPoll, {
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
        try {
          const projectId = item.projectId;
          const workflowId = item.workflowId;
          const downloadUrl = await apiClient.getMediaUrl(item.name, 'MEDIA_URL_TYPE_VIDEO', { projectId, workflowId });
          
          // Download buffer using browser context to avoid 403 Google blocks
          logger.info(`Downloading video via browser context...`);
          const bufferArray = await browserManager.page.evaluate(async (url) => {
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
        } catch (dlErr) {
          finalMedia.push({
            mediaId: item.name,
            status: 'url_failed',
            error: dlErr.message
          });
        }
      } else {
        finalMedia.push({
          mediaId: item.name,
          status: 'failed',
          error: item.mediaMetadata?.mediaStatus?.mediaGenerationFailureReason || 'Safety block or Google error'
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
      throw new Error("No successful video generated");
    }

  } catch (err) {
    logger.error(`[Video] Task ${taskId} failed`, err);
    task.status = 'failed';
    task.error = err.message;
    await task.docRef.update({ status: 'failed', error: err.message });
  }

  // Anti-spam Cooldown: Sleep for 5 to 10 seconds to avoid triggering Google's UNUSUAL_ACTIVITY
  const cooldown = 5000 + Math.floor(Math.random() * 5000);
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
      return;
    }

    logger.info(`Found ${snapshot.size} expired tasks. Starting media deletion from R2 & doc deletion from Firestore...`);
    const batch = db.batch();
    
    for (const doc of snapshot.docs) {
      const docData = doc.data();
      const filesToDelete = [];

      // Collect all media URLs
      if (docData.mediaUrl) {
        filesToDelete.push(docData.mediaUrl);
      }
      if (Array.isArray(docData.media)) {
        docData.media.forEach(item => {
          if (item.url) filesToDelete.push(item.url);
        });
      }

      // Delete files from R2
      for (const url of filesToDelete) {
        if (url && url.startsWith(process.env.R2_PUBLIC_BASE)) {
          const fileKey = url.replace(`${process.env.R2_PUBLIC_BASE}/`, '');
          
          // Safety guard: Only delete if key is in meo3 folders (meo3/videos/, meo3/images/, meo3/inputs/)
          const isOurFolder = fileKey.startsWith('meo3/videos/') || fileKey.startsWith('meo3/images/') || fileKey.startsWith('meo3/inputs/');
          
          if (isOurFolder) {
            try {
              await deleteFromR2(fileKey);
              logger.info(`Deleted file from Cloudflare R2: ${fileKey}`);
            } catch (r2Err) {
              logger.error(`Failed to delete ${fileKey} from R2:`, r2Err);
            }
          } else {
            logger.warn(`Skipped deleting R2 key "${fileKey}" - safety guard active (not inside meo3 folders).`);
          }
        }
      }

      // Add to Firestore batch delete
      batch.delete(doc.ref);
    }

    await batch.commit();
    logger.success(`Successfully deleted ${snapshot.size} expired tasks from Firestore and matching media files from Cloudflare R2.`);
  } catch (err) {
    logger.error('Error during expired tasks cleanup', err);
  }
}

// Start HTTP + Socket.io Server
captchaService.attach(io);

// Start Firestore Listener
startFirestoreListener();

// Start periodic cleanup on startup and then every hour
cleanupOldTasks();
setInterval(cleanupOldTasks, 60 * 60 * 1000);

// Initialize Browser Manager on start so it is warmed up
browserManager.initialize().catch(err => {
  logger.warn(`Initial browser startup warning: ${err.message}. It will retry on the first API call.`);
});

server.listen(config.PORT, () => {
  logger.success(`VEO3 API Server (Worker Mode) running on port ${config.PORT}`);
  logger.info(`Web socket listener attached for Chrome Extension`);
});
