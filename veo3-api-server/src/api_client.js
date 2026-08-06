const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./utils');
const config = require('./config');
const browserManager = require('./browser_manager');
const captchaService = require('./captcha_service');

const API_BASE = 'https://aisandbox-pa.googleapis.com';
const LABS_BASE = 'https://labs.google';

const IMAGE_MODELS = {
  nano_banana_pro: 'GEM_PIX_2',
  nano_banana_2: 'NARWHAL',
  imagen_4: 'IMAGEN_3_5',
  imagen_4_ref: 'R2I'
};

const IMAGE_ASPECT_RATIOS = {
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
  '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE',
  '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR'
};

const VIDEO_ASPECT_RATIOS = {
  '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  '4:3': 'VIDEO_ASPECT_RATIO_LANDSCAPE', // Fallback
  '3:4': 'VIDEO_ASPECT_RATIO_PORTRAIT',  // Fallback
  '1:1': 'VIDEO_ASPECT_RATIO_SQUARE'
};

const VIDEO_MODEL_KEYS = {
  veo_3_1_lite: {
    t2v: {
      default: 'veo_3_1_t2v_lite',
      landscape_4s: 'veo_3_1_t2v_lite_4s',
      landscape_6s: 'veo_3_1_t2v_lite_6s',
      portrait_4s: 'veo_3_1_t2v_portrait_lite_4s',
      portrait_6s: 'veo_3_1_t2v_portrait_lite_6s'
    },
    i2v: {
      default: 'veo_3_1_i2v_lite',
      landscape_4s: 'veo_3_1_i2v_s_lite_4s',
      landscape_6s: 'veo_3_1_i2v_s_lite_6s',
      portrait_4s: 'veo_3_1_i2v_s_lite_4s',
      portrait_6s: 'veo_3_1_i2v_s_lite_6s'
    },
    f2v: {
      default: 'veo_3_1_interpolation_lite',
      landscape_4s: 'veo_3_1_i2v_s_lite_4s_fl',
      landscape_6s: 'veo_3_1_i2v_s_lite_6s_fl',
      portrait_4s: 'veo_3_1_i2v_s_lite_4s_fl',
      portrait_6s: 'veo_3_1_i2v_s_lite_6s_fl'
    },
    r2v: { default: 'veo_3_1_r2v_lite' }
  },
  veo_3_1_fast: {
    t2v: {
      landscape_advanced: 'veo_3_1_t2v_fast_ultra',
      portrait_advanced: 'veo_3_1_t2v_fast_portrait_ultra',
      landscape: 'veo_3_1_t2v_fast',
      portrait: 'veo_3_1_t2v_fast_portrait',
      landscape_4s: 'veo_3_1_t2v_fast_4s',
      landscape_6s: 'veo_3_1_t2v_fast_6s',
      portrait_4s: 'veo_3_1_t2v_fast_portrait_4s',
      portrait_6s: 'veo_3_1_t2v_fast_portrait_6s'
    },
    i2v: {
      landscape_advanced: 'veo_3_1_i2v_s_fast_ultra',
      portrait_advanced: 'veo_3_1_i2v_s_fast_portrait_ultra',
      landscape: 'veo_3_1_i2v_s_fast',
      portrait: 'veo_3_1_i2v_s_fast_portrait',
      landscape_4s: 'veo_3_1_i2v_s_fast_4s',
      landscape_6s: 'veo_3_1_i2v_s_fast_6s',
      portrait_4s: 'veo_3_1_i2v_s_fast_portrait_4s',
      portrait_6s: 'veo_3_1_i2v_s_fast_portrait_6s'
    },
    f2v: {
      landscape_advanced: 'veo_3_1_i2v_s_fast_ultra_fl',
      portrait_advanced: 'veo_3_1_i2v_s_fast_portrait_ultra_fl',
      landscape: 'veo_3_1_i2v_s_fast_fl',
      portrait: 'veo_3_1_i2v_s_fast_portrait_fl',
      landscape_4s: 'veo_3_1_i2v_s_fast_4s_fl',
      landscape_6s: 'veo_3_1_i2v_s_fast_6s_fl',
      portrait_4s: 'veo_3_1_i2v_s_fast_portrait_4s_fl',
      portrait_6s: 'veo_3_1_i2v_s_fast_portrait_6s_fl'
    },
    r2v: {
      landscape_advanced: 'veo_3_1_r2v_fast_landscape_ultra',
      portrait_advanced: 'veo_3_1_r2v_fast_portrait_ultra',
      landscape: 'veo_3_1_r2v_fast_landscape',
      portrait: 'veo_3_1_r2v_fast_portrait'
    }
  },
  veo_3_1_quality: {
    t2v: {
      landscape: 'veo_3_1_t2v',
      portrait: 'veo_3_1_t2v_portrait',
      landscape_4s: 'veo_3_1_t2v_4s',
      landscape_6s: 'veo_3_1_t2v_6s',
      portrait_4s: 'veo_3_1_t2v_portrait_4s',
      portrait_6s: 'veo_3_1_t2v_portrait_6s'
    },
    i2v: {
      landscape: 'veo_3_1_i2v_s',
      portrait: 'veo_3_1_i2v_s_portrait',
      landscape_4s: 'veo_3_1_i2v_s_4s',
      landscape_6s: 'veo_3_1_i2v_s_6s',
      portrait_4s: 'veo_3_1_i2v_s_portrait_4s',
      portrait_6s: 'veo_3_1_i2v_s_portrait_6s'
    }
  },
  abra: {
    t2v: {
      default: 'abra_t2v_8s',
      landscape_4s: 'abra_t2v_4s',
      portrait_4s: 'abra_t2v_4s',
      landscape_6s: 'abra_t2v_6s',
      portrait_6s: 'abra_t2v_6s',
      landscape_8s: 'abra_t2v_8s',
      portrait_8s: 'abra_t2v_8s',
      landscape_10s: 'abra_t2v_10s',
      portrait_10s: 'abra_t2v_10s'
    },
    r2v: {
      default: 'abra_r2v_8s',
      landscape_4s: 'abra_r2v_4s',
      portrait_4s: 'abra_r2v_4s',
      landscape_6s: 'abra_r2v_6s',
      portrait_6s: 'abra_r2v_6s',
      landscape_8s: 'abra_r2v_8s',
      portrait_8s: 'abra_r2v_8s',
      landscape_10s: 'abra_r2v_10s',
      portrait_10s: 'abra_r2v_10s'
    },
    i2v: {
      default: 'abra_i2v_8s',
      landscape_4s: 'abra_i2v_4s',
      portrait_4s: 'abra_i2v_4s',
      landscape_6s: 'abra_i2v_6s',
      portrait_6s: 'abra_i2v_6s',
      landscape_8s: 'abra_i2v_8s',
      portrait_8s: 'abra_i2v_8s',
      landscape_10s: 'abra_i2v_10s',
      portrait_10s: 'abra_i2v_10s'
    }
  }
};

// Download concurrency limiter: the GCS capture path opens a fresh Chrome page
// per video. Running too many at once overloads the browser and makes the
// CDP URL capture time out. Cap concurrent page-based downloads.
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DOWNLOAD_CONCURRENCY || '2', 10);
let activeDownloads = 0;
const downloadQueue = [];

function acquireDownloadSlot() {
  return new Promise((resolve) => {
    if (activeDownloads < DOWNLOAD_CONCURRENCY) {
      activeDownloads++;
      resolve();
    } else {
      downloadQueue.push(resolve);
    }
  });
}

function releaseDownloadSlot() {
  activeDownloads--;
  if (downloadQueue.length > 0) {
    const next = downloadQueue.shift();
    activeDownloads++;
    next();
  }
}

class ApiClient {
  constructor(options = {}) {
    this.projectId = null;
    this.userTier = 'SERVICE_TIER_ADVANCED';
    this.paygateTier = 'PAYGATE_TIER_TWO';
    this.sessionId = ';' + Date.now();
    this.browserManager = options.browserManager || browserManager;
    this.cookieFile = options.cookieFile || config.COOKIE_FILE;
    this.label = options.label || 'video';
  }

  // Load cookies and format as Cookie string for labs.google requests
  _getCookieHeader() {
    if (!fs.existsSync(this.cookieFile)) {
      throw new Error(`${this.cookieFile} not found`);
    }
    try {
      const content = fs.readFileSync(this.cookieFile, 'utf-8').trim();
      if (!content) return '';
      let cookies = [];
      if (content.startsWith('[')) {
        cookies = JSON.parse(content);
      } else {
        return content; // If already a string
      }
      return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      logger.error('Failed to format cookie header', e);
      return '';
    }
  }

  // Retry wrapper for HTTP/2 stream errors (Google closes streams with
  // NGHTTP2_ENHANCE_YOUR_CALM when too many run concurrently on one session).
  async _retryH2(fn, attempts = 4) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err || '');
        if (!/NGHTTP2_ENHANCE_YOUR_CALM|NGHTTP2_|stream closed|ECONNRESET|ETIMEDOUT/i.test(msg)) throw err;
        if (i >= attempts) break;
        const waitMs = 2000 * i + Math.floor(Math.random() * 1000);
        logger.warn(`HTTP/2 stream error, retry ${i}/${attempts - 1} in ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }

  // Base HTTP request to Google Labs TRPC endpoints using labs session cookies
  async _labsRequest(method, endpoint, body = null) {
    const { gotScraping } = await import('got-scraping');
    const cookieStr = this._getCookieHeader();

    const headers = {
      'Content-Type': 'application/json',
      'Origin': LABS_BASE,
      'Referer': `${LABS_BASE}/fx/vi/tools/flow`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': cookieStr
    };

    const url = `${LABS_BASE}${endpoint}`;
    logger.debug(`Labs HTTP Request: ${method} ${url}`);

    const options = {
      url,
      method,
      headers,
      responseType: 'text',
      followRedirect: false,
      throwHttpErrors: false
    };

    if (body) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await this._retryH2(() => gotScraping(options));
    
    let parsedBody = response.body;
    try {
      if (response.body) {
        parsedBody = JSON.parse(response.body);
      }
    } catch (e) {}

    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      return { status: response.statusCode, redirectUrl: response.headers.location, body: parsedBody };
    }
    if (response.statusCode !== 200) {
      throw new Error(`Labs API error ${response.statusCode}: ${JSON.stringify(parsedBody)}`);
    }
    return { status: 200, body: parsedBody };
  }

  // Base HTTP request to Google aisandbox-pa backend using ya29 Bearer OAuth token
  async _apiRequest(method, endpoint, body = null) {
    const { gotScraping } = await import('got-scraping');
    const token = await this.browserManager.getOAuthToken();

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain;charset=UTF-8',
      'Origin': LABS_BASE,
      'Referer': `${LABS_BASE}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    const url = `${API_BASE}${endpoint}`;
    logger.debug(`API Gateway Request: ${method} ${url}`);

    const options = {
      url,
      method,
      headers,
      responseType: 'json',
      throwHttpErrors: false
    };

    if (body) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await this._retryH2(() => gotScraping(options));
    if (response.statusCode !== 200) {
      throw new Error(`API Gateway error ${response.statusCode}: ${JSON.stringify(response.body)}`);
    }
    return response.body;
  }

  _isCaptchaRelatedError(err) {
    const msg = String(err?.message || err || '');
    return /reCAPTCHA|UNUSUAL_ACTIVITY|PERMISSION_DENIED|PUBLIC_ERROR_UNUSUAL_ACTIVITY/i.test(msg);
  }

  _applyCaptchaContext(baseContext, token) {
    if (!token) return baseContext;
    return {
      ...baseContext,
      recaptchaContext: {
        token,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
      }
    };
  }

  // Ensure VEO3 project exists in Google Labs Flow
  async ensureProject() {
    if (this.projectId) return this.projectId;

    try {
      const input = { 
        json: { pageSize: 20, toolName: config.TOOL_NAME, cursor: null },
        meta: { values: { cursor: ['undefined'] } }
      };
      const res = await this._labsRequest('GET', `/fx/api/trpc/project.searchUserProjects?input=${encodeURIComponent(JSON.stringify(input))}`);
      
      const projects = res.body?.result?.data?.json?.result?.projects || [];
      if (projects.length > 0) {
        this.projectId = projects[0].projectId;
        logger.info(`Reusing existing project: ${projects[0].projectTitle} (${this.projectId})`);
        await this.getProjectData(this.projectId);
        return this.projectId;
      }
    } catch (err) {
      logger.warn(`Failed to list projects: ${err.message}. Attempting to create one.`);
    }

    // Create a new project if none exist
    logger.info('Creating a new VEO3 project...');
    const projectTitle = `API Project ${new Date().toLocaleDateString('vi-VN')}`;
    const createInput = { json: { projectTitle, toolName: config.TOOL_NAME } };
    const createRes = await this._labsRequest('POST', '/fx/api/trpc/project.createProject', createInput);
    
    this.projectId = createRes.body?.result?.data?.json?.result?.projectId;
    if (!this.projectId) {
      throw new Error(`Failed to create project: ${JSON.stringify(createRes.body)}`);
    }
    
    logger.success(`Created project: ${projectTitle} (${this.projectId})`);
    await this.getProjectData(this.projectId);
    return this.projectId;
  }

  async getProjectData(projectId) {
    const input = { json: { projectId } };
    const res = await this._labsRequest('GET', `/fx/api/trpc/flow.projectInitialData?input=${encodeURIComponent(JSON.stringify(input))}`);
    
    const flowData = res.body?.result?.data?.json;
    if (flowData?.userData) {
      this.userTier = flowData.userData.serviceTier || this.userTier;
      this.paygateTier = flowData.userData.paygateTier || this.paygateTier;
    }
    return flowData;
  }

  // Upload an image reference to Google Flow
  async uploadImage(imageBufferOrFilePath, extension = '.png') {
    const projectId = await this.ensureProject();
    let fileBuffer;

    if (typeof imageBufferOrFilePath === 'string') {
      if (!fs.existsSync(imageBufferOrFilePath)) {
        throw new Error(`Upload file not found: ${imageBufferOrFilePath}`);
      }
      fileBuffer = fs.readFileSync(imageBufferOrFilePath);
    } else if (Buffer.isBuffer(imageBufferOrFilePath)) {
      fileBuffer = imageBufferOrFilePath;
    } else {
      throw new Error('Image source must be a file path string or Buffer');
    }

    const base64Bytes = fileBuffer.toString('base64');
    logger.info(`Uploading image reference (${Math.round(fileBuffer.length / 1024)} KB)...`);

    const payload = {
      clientContext: { projectId, tool: config.TOOL_NAME },
      imageBytes: base64Bytes
    };

    const res = await this._apiRequest('POST', '/v1/flow/uploadImage', payload);
    const mediaId = res?.media?.name;
    if (!mediaId) {
      throw new Error(`No mediaId in upload response: ${JSON.stringify(res)}`);
    }
    logger.success(`Uploaded image mediaId: ${mediaId}`);
    return mediaId;
  }

  _resolveVideoModelKey(model, genType, aspectRatio, userTier, durationSeconds) {
    // Force the use of veo_3_1_lite (Lower Priority) as requested
    const forcedModel = 'veo_3_1_lite';
    const modelFamily = VIDEO_MODEL_KEYS[forcedModel];
    if (!modelFamily) throw new Error(`Unknown video model family: ${forcedModel}`);

    const genModes = modelFamily[genType];
    if (!genModes) throw new Error(`Video family ${forcedModel} doesn't support ${genType}`);

    const isPortrait = aspectRatio.includes('PORTRAIT') || aspectRatio === '9:16' || aspectRatio === '3:4';
    const orient = isPortrait ? 'portrait' : 'landscape';
    const isAdvanced = userTier === 'SERVICE_TIER_ADVANCED';

    let resolvedKey = '';
    // Check duration specific key
    if (durationSeconds && ['t2v', 'i2v', 'f2v', 'r2v'].includes(genType)) {
      const durationKey = `${orient}_${durationSeconds}s`;
      const sharedKey = `landscape_${durationSeconds}s`;
      if (genModes[durationKey]) resolvedKey = genModes[durationKey];
      else if (genModes[sharedKey]) resolvedKey = genModes[sharedKey];
    }

    if (!resolvedKey) {
      if (genModes[`${orient}_advanced`] && isAdvanced) {
        resolvedKey = genModes[`${orient}_advanced`];
      } else {
        resolvedKey = genModes[orient] || genModes.default;
      }
    }

    // Force lower priority suffix for Google Flow compatibility
    if (resolvedKey && !resolvedKey.endsWith('_low_priority')) {
      resolvedKey = `${resolvedKey}_low_priority`;
    }
    return resolvedKey;
  }

  // Generate Image
  async generateImage(prompt, options = {}) {
    const projectId = await this.ensureProject();
    const reactiveCaptcha = process.env.REACTIVE_CAPTCHA_MODE === '1';

    const modelName = IMAGE_MODELS[options.model || 'nano_banana_2'] || 'NARWHAL';
    const ratioName = IMAGE_ASPECT_RATIOS[options.aspectRatio || '16:9'] || 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    const count = Math.max(1, Math.min(options.count || 2, 4));
    const seed = options.seed || Math.floor(Math.random() * 2147483647);
    const batchId = crypto.randomUUID();

    const imageInputs = [];
    if (options.referenceImage) {
      imageInputs.push({ name: options.referenceImage });
    }
    if (Array.isArray(options.referenceImages)) {
      options.referenceImages.forEach(img => {
        if (img) imageInputs.push({ name: img });
      });
    }

    const baseClientContext = {
      projectId,
      tool: config.TOOL_NAME,
      sessionId: this.sessionId
    };

    const requests = Array.from({ length: count }, (_, i) => ({
      imageModelName: modelName,
      imageAspectRatio: ratioName,
      structuredPrompt: { parts: [{ text: prompt }] },
      seed: seed + i,
      imageInputs
    }));

    const buildPayload = (recaptchaToken = null) => {
      const clientContext = this._applyCaptchaContext(baseClientContext, recaptchaToken);
      return {
        clientContext,
        mediaGenerationContext: { batchId },
        useNewMedia: true,
        requests
      };
    };

    const url = `/v1/projects/${projectId}/flowMedia:batchGenerateImages`;
    logger.info(`Sending image generation request for: "${prompt.substring(0, 30)}..."`);
    if (!reactiveCaptcha) {
      const recaptchaToken = await captchaService.solveCaptcha('IMAGE_GENERATION', 45000, this.browserManager);
      return await this._apiRequest('POST', url, buildPayload(recaptchaToken));
    }

    try {
      return await this._apiRequest('POST', url, buildPayload());
    } catch (err) {
      if (!this._isCaptchaRelatedError(err)) throw err;
      logger.info('[Image] Captcha requested by Google, solving and retrying once...');
      const recaptchaToken = await captchaService.solveCaptcha('IMAGE_GENERATION', 45000, this.browserManager);
      return await this._apiRequest('POST', url, buildPayload(recaptchaToken));
    }
  }

  // Generate Video (returns tasks to poll)
  async generateVideo(prompt, options = {}) {
    const projectId = await this.ensureProject();
    const reactiveCaptcha = process.env.REACTIVE_CAPTCHA_MODE === '1';

    const ratioName = VIDEO_ASPECT_RATIOS[options.aspectRatio || '16:9'] || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
    const count = Math.max(1, Math.min(options.count || 2, 2)); // Google usually supports up to 2
    const seed = options.seed || Math.floor(Math.random() * 2147483647);
    const batchId = crypto.randomUUID();

    const hasStart = !!options.startImage;
    const hasEnd = !!options.endImage;
    const hasRefs = Array.isArray(options.referenceImages) && options.referenceImages.length > 0;

    let genType = 't2v';
    if (hasStart && hasEnd) genType = 'f2v';
    else if (hasStart) genType = 'i2v';
    else if (hasRefs) genType = 'r2v';

    const modelName = options.model || 'veo_3_1_fast';
    const modelKey = this._resolveVideoModelKey(modelName, genType, ratioName, this.userTier, options.durationSeconds);

    const baseClientContext = {
      projectId,
      tool: config.TOOL_NAME,
      sessionId: this.sessionId,
      userPaygateTier: this.paygateTier
    };

    const requests = Array.from({ length: count }, (_, i) => {
      const req = {
        aspectRatio: ratioName,
        seed: seed + i,
        textInput: {
          structuredPrompt: {
            parts: [{ text: prompt }]
          }
        },
        videoModelKey: modelKey,
        metadata: {}
      };

      if (hasStart) {
        req.startImage = {
          mediaId: options.startImage,
          cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 }
        };
      }
      if (genType === 'f2v' && hasEnd) {
        req.endImage = {
          mediaId: options.endImage,
          cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 }
        };
      } else if (hasEnd) {
        logger.warn(`endImage provided but ${genType} endpoint doesn't support it; ignoring end frame`);
      }
      if (hasRefs) {
        req.referenceImages = options.referenceImages.map(ref => 
          typeof ref === 'string' 
            ? { mediaId: ref, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET' }
            : { imageUsageType: 'IMAGE_USAGE_TYPE_ASSET', ...ref }
        );
      }
      if (options.voice && options.voice !== 'none') {
        req.referenceAudio = [{ mediaId: options.voice }];
      }

      return req;
    });

    const buildPayload = (recaptchaToken = null) => {
      const clientContext = this._applyCaptchaContext(baseClientContext, recaptchaToken);
      return {
        mediaGenerationContext: { batchId },
        clientContext,
        requests,
        useV2ModelConfig: true
      };
    };

    const endpoints = {
      t2v: '/v1/video:batchAsyncGenerateVideoText',
      i2v: '/v1/video:batchAsyncGenerateVideoStartImage',
      r2v: '/v1/video:batchAsyncGenerateVideoReferenceImages',
      f2v: '/v1/video:batchAsyncGenerateVideoStartAndEndImage'
    };

    const url = endpoints[genType];
    logger.info(`Sending video generation request (${genType}, model: ${modelKey}) for: "${prompt.substring(0, 30)}..."`);
    if (!reactiveCaptcha) {
      const recaptchaToken = await captchaService.solveCaptcha('VIDEO_GENERATION', 45000, this.browserManager);
      return await this._apiRequest('POST', url, buildPayload(recaptchaToken));
    }

    try {
      return await this._apiRequest('POST', url, buildPayload());
    } catch (err) {
      if (!this._isCaptchaRelatedError(err)) throw err;
      logger.info('[Video] Captcha requested by Google, solving and retrying once...');
      const recaptchaToken = await captchaService.solveCaptcha('VIDEO_GENERATION', 45000, this.browserManager);
      return await this._apiRequest('POST', url, buildPayload(recaptchaToken));
    }
  }

  // Poll status of generated media items
  async checkVideoStatus(mediaItems) {
    const payload = {
      media: mediaItems.map(item => ({
        name: typeof item === 'string' ? item : item.name,
        projectId: (typeof item === 'string' ? null : item.projectId) || this.projectId
      }))
    };

    const res = await this._apiRequest('POST', '/v1/video:batchCheckAsyncVideoGenerationStatus', payload);
    return res;
  }

  // Poll for completion of multiple media tasks
  async waitForVideos(mediaItems, options = {}) {
    const intervalMs = options.intervalMs || 4000;
    const timeoutMs = options.timeoutMs || 500000; // 500s timeout
    const onProgress = options.onProgress;
    const startTime = Date.now();
    let lastNonEmpty = null;
    let emptyStreak = 0;

    while (true) {
      const res = await this.checkVideoStatus(mediaItems);
      const media = res.media || [];
      let allFinished = true;

      if (media.length === 0) {
        // Google's batch check returns an empty media array once all items have
        // finished, dropping the completed items. Keep the last non-empty result
        // so we can still resolve/download the generated videos.
        emptyStreak++;
        if (lastNonEmpty && emptyStreak <= 3) {
          if (onProgress) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            onProgress(res, elapsed);
          }
          await new Promise(resolve => setTimeout(resolve, intervalMs));
          continue;
        }
        return lastNonEmpty || res;
      }

      emptyStreak = 0;
      lastNonEmpty = res;

      for (const item of media) {
        const genStatus = item.mediaMetadata?.mediaStatus?.mediaGenerationStatus || 
                          item.mediaMetadata?.generationStatus || 
                          item.status?.state;

        const isFinal = genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || 
                        genStatus === 'MEDIA_GENERATION_STATUS_FAILED' || 
                        genStatus === 'MEDIA_GENERATION_STATUS_FILTERED' ||
                        genStatus === 'SUCCESSFUL' || 
                        genStatus === 'FAILED' || 
                        genStatus === 'FILTERED';

        if (!isFinal) {
          allFinished = false;
        }
      }

      if (allFinished) return res;

      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Polling timeout waiting for video generation');
      }

      if (onProgress) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        onProgress(res, elapsed);
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  // Capture real GCS video URL by opening an isolated page and
  // intercepting the network response containing storage.googleapis.com video URL via CDP.
  async getVideoGcsUrl(mediaId, projectId, workflowId) {
    await acquireDownloadSlot();
    try {
      return await this._getVideoGcsUrlInner(mediaId, projectId, workflowId);
    } finally {
      releaseDownloadSlot();
    }
  }

  async _getVideoGcsUrlInner(mediaId, projectId, workflowId) {
    const browser = this.browserManager.browser;
    if (!browser) throw new Error('No browser context available');

    const editUrl = projectId && workflowId
      ? `${LABS_BASE}/fx/vi/tools/flow/project/${projectId}/edit/${workflowId}`
      : null;

    if (!editUrl) {
      throw new Error('projectId and workflowId are required for GCS URL capture');
    }

    logger.info(`Opening isolated page to capture GCS URL for ${mediaId.substring(0, 8)}...`);

    let capturedUrl = null;

    for (let attempt = 1; attempt <= 3 && !capturedUrl; attempt++) {
      if (attempt > 1) logger.info(`Retrying GCS URL capture (attempt ${attempt}/3)...`);
      let page = null;
      let cdp = null;

      try {
        page = await browser.newPage();
        
        // Inherit cookies from the main page
        if (this.browserManager.page) {
          const cookies = await this.browserManager.page.cookies();
          await page.setCookie(...cookies);
        }

        cdp = await page.target().createCDPSession();
        await cdp.send('Network.enable');

        const onResponse = (event) => {
          const url = event.response?.url || '';
          const ct = (event.response?.headers?.['content-type'] || event.response?.headers?.['Content-Type'] || '').toLowerCase();
          const isVideoOrGcs = (ct.startsWith('video/') || ct.includes('mp4') || ct.includes('webm')) ||
                               (url.includes('storage.googleapis.com') && url.includes('ai-sandbox-videofx'));
          if (isVideoOrGcs && !capturedUrl && !url.includes('gstatic.com')) {
            capturedUrl = url;
          }
        };

        cdp.on('Network.responseReceived', onResponse);

        // Navigate to base domain to ensure first-party cookie context, then inject iframe
        await page.goto(`${LABS_BASE}/fx/vi/tools/flow`, { waitUntil: 'domcontentloaded' });
        await page.evaluate((src) => {
          const iframe = document.createElement('iframe');
          iframe.src = src;
          document.body.appendChild(iframe);
        }, editUrl);

        // Wait up to 45s for CDP to intercept the video URL
        let waited = 0;
        while (!capturedUrl && waited < 45000) {
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }

        // If the iframe did not fetch the video, force a reload of the iframe once mid-attempt
        if (!capturedUrl && waited > 10000) {
          try {
            await page.evaluate((src) => {
              const existing = document.querySelector('iframe');
              if (existing) existing.remove();
              const iframe = document.createElement('iframe');
              iframe.src = src;
              document.body.appendChild(iframe);
            }, editUrl);
            // Keep waiting a bit more after the reload
            const extraWaitStart = Date.now();
            while (!capturedUrl && (Date.now() - extraWaitStart) < 25000) {
              await new Promise(r => setTimeout(r, 500));
            }
          } catch (reloadErr) {
            logger.warn(`Iframe reload error during GCS capture: ${reloadErr.message}`);
          }
        }
      } catch (err) {
        logger.warn(`Isolated page GCS capture error: ${err.message}`);
      } finally {
        if (cdp) {
          try { await cdp.detach(); } catch(e){}
        }
        if (page) {
          try { await page.close(); } catch(e){}
        }
      }
    }

    if (capturedUrl) {
      logger.success(`Captured GCS video URL via isolated CDP: ${capturedUrl.substring(0, 60)}...`);
      return capturedUrl;
    }

    return null;
  }

  // Resolve the signed download URL for media
  async getMediaUrl(mediaId, type = 'MEDIA_URL_TYPE_THUMBNAIL', { projectId, workflowId } = {}) {
    // Resolve via browser context first (avoids "Request Header Or Cookie Too Large" 400 errors).
    // Chrome handles cookies per-domain automatically instead of dumping all cookies into one header.
    if (this.browserManager.page) {
      try {
        const params = new URLSearchParams({ name: mediaId, mediaUrlType: type }).toString();
        const url = `${LABS_BASE}/fx/api/trpc/media.getMediaUrlRedirect?${params}`;
        const finalUrl = await this.browserManager.page.evaluate(async (targetUrl) => {
          try {
            const res = await fetch(targetUrl, {
              method: 'GET',
              credentials: 'include',
              redirect: 'follow',
              headers: { Accept: 'application/json, */*' }
            });
            if (!res.ok) return null;
            // If the request got redirected to the actual file URL, use it directly
            if (res.url && res.url !== targetUrl && !res.url.includes('getMediaUrlRedirect')) {
              return res.url;
            }
            // Otherwise parse the JSON body (trpc shape: result.data.json.url or body.url)
            try {
              const body = await res.json();
              const fileUrl = body?.result?.data?.json?.url || body?.url || body?.redirectUrl;
              return (typeof fileUrl === 'string' && fileUrl.startsWith('http')) ? fileUrl : null;
            } catch (e) {
              return null;
            }
          } catch (e) {
            return null;
          }
        }, url);
        if (finalUrl && finalUrl.startsWith('http')) {
          logger.success(`Resolved ${type} via browser context: ${finalUrl.substring(0, 60)}...`);
          return finalUrl;
        }
      } catch (err) {
        logger.warn(`Browser context resolve failed: ${err.message}`);
      }
    }

    // For video type: use iframe+CDP capture to get actual GCS storage URL (last resort)
    if (type === 'MEDIA_URL_TYPE_VIDEO' && projectId && workflowId) {
      try {
        const gcsUrl = await this.getVideoGcsUrl(mediaId, projectId, workflowId);
        if (gcsUrl) return gcsUrl;
      } catch (err) {
        logger.warn(`iframe+CDP GCS capture failed: ${err.message}.`);
      }
    }

    throw new Error(`Failed to resolve media download link for ${mediaId}`);
  }
}

const videoApiClient = new ApiClient({
  label: 'video',
  browserManager,
  cookieFile: config.COOKIE_FILE
});

const imageApiClient = new ApiClient({
  label: 'image',
  browserManager: browserManager.image,
  cookieFile: config.IMAGE_COOKIE_FILE
});

videoApiClient.image = imageApiClient;
module.exports = videoApiClient;
