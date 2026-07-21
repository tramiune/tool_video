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
    let finalAspectRatio = aspectRatio || '1:1';

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

// Proxy download to force attachment headers (works on mobile, ported from ai_web3)
app.get('/api/download', async (req, res) => {
  const fileUrl = req.query.url;
  const filename = req.query.filename || 'download';
  if (!fileUrl) return res.status(400).send('Missing url parameter');
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

      logger.info(`Automatically upgraded user ${userDoc.id} to tier ${pending.tier} via Webhook!`);
      processedCount++;
    }
    
    return res.json({ success: true, processed: processedCount });
  } catch (err) {
    logger.error('Error processing payment webhook', err);
    return res.status(500).json({ error: err.message });
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

    // Only use the forced Veo 3.1 Lite (Lower Priority) model without fallback as requested
    const videoModelsToTry = ['veo_3_1_lite'];

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

// Start Firestore Cookie Sync first
startCookieSyncListener().then(() => {
  // Start Firestore Listener
  startFirestoreListener();

  // Start periodic cleanup on startup and then every hour
  cleanupOldTasks();
  setInterval(cleanupOldTasks, 60 * 60 * 1000);

  // Initialize Browser Manager on start so it is warmed up
  browserManager.initialize().catch(err => {
    logger.warn(`Initial browser startup warning: ${err.message}. It will retry on the first API call.`);
  });

  // Schedule automatic 30-minute Google Flow tab refresh via Chrome extension
  const THIRTY_MINUTES_MS = 30 * 60 * 1000;
  setInterval(async () => {
    logger.info("[Scheduled Task] Emitting 30-minute tab refresh command to Chrome extension clients...");
    try {
      io.emit('refresh_flow_page');
      logger.info("[Scheduled Task] Successfully sent refresh_flow_page to extension clients");
    } catch (ioErr) {
      logger.warn("Could not emit refresh_flow_page to extension sockets:", ioErr.message);
    }
  }, THIRTY_MINUTES_MS);
});

server.listen(config.PORT, () => {
  logger.success(`VEO3 API Server (Worker Mode) running on port ${config.PORT}`);
  logger.info(`Web socket listener attached for Chrome Extension`);
});
