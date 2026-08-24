'use strict';

const LABS_BASE  = 'https://labs.google';
const API_BASE   = 'https://aisandbox-pa.googleapis.com';
const TOOL_NAME  = 'PINHOLE';

// ── Side panel on click ──────────────────────────────
chrome.action.onClicked.addListener(tab => chrome.sidePanel.open({ tabId: tab.id }));

// ── WebSocket Bridge (kết nối tới tool_video server) ──
const WS_URL = 'ws://localhost:7788';
let _ws = null;

function connectBridge() {
  try {
    _ws = new WebSocket(WS_URL);

    _ws.onopen = async () => {
      console.log('[Meo3] Bridge connected to tool_video server');
      _ws.send(JSON.stringify({ type: 'EXTENSION_HELLO' }));
      const tok = await getToken();
      if (tok) {
        _ws.send(JSON.stringify({ type: 'TOKEN_SYNC', token: tok }));
        console.log('[Meo3] Bridge: Synced initial token to server');
      }
    };

    _ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'GET_TOKEN') {
        const tok = await getToken();
        _ws.send(JSON.stringify({ type: 'TOKEN_RESULT', id: msg.id, token: tok, ok: !!tok }));
        return;
      }

      if (msg.type === 'SOLVE_CAPTCHA') {
        try {
          const token = await solveCaptcha(msg.action || 'IMAGE_GENERATION', 20000);
          _ws.send(JSON.stringify({ type: 'CAPTCHA_RESULT', id: msg.id, token, ok: !!token }));
        } catch (e) {
          _ws.send(JSON.stringify({ type: 'CAPTCHA_RESULT', id: msg.id, ok: false, error: e.message }));
        }
        return;
      }

      if (msg.type === 'DOWNLOAD_IMAGE') {
        const { id, mediaId, prompt, targetUrl } = msg;
        console.log(`[Meo3] Bridge: DOWNLOAD_IMAGE ${id} (${mediaId})`);
        try {
          const { base64, url } = await fetchMediaBase64(mediaId, targetUrl, 'image');

          // Lưu task vào danh sách của extension để hiển thị trên Sidepanel
          await saveTask({
            id: id || ('img_' + Date.now()),
            type: 'image',
            prompt: prompt || 'Server Image',
            status: 'done',
            operationName: mediaId,
            mediaId: mediaId,
            createdAt: Date.now(),
            url: url,
            thumbnailUrl: url
          });

          _ws.send(JSON.stringify({ type: 'IMAGE_RESULT', id, base64, ok: true }));
          console.log(`[Meo3] Bridge: IMAGE_RESULT sent for ${id} (${Math.round(base64.length / 1024)}KB)`);
        } catch (e) {
          console.error(`[Meo3] Bridge error for ${id}:`, e.message);
          _ws.send(JSON.stringify({ type: 'IMAGE_RESULT', id, ok: false, error: e.message }));
        }
      }

    };

    _ws.onerror = () => {}; // suppress noise
    _ws.onclose = () => {
      console.log('[Meo3] Bridge disconnected, retrying in 5s...');
      _ws = null;
      setTimeout(connectBridge, 5000);
    };
  } catch (e) {
    setTimeout(connectBridge, 5000);
  }
}
connectBridge();


// ── Token helpers ────────────────────────────────────
async function getToken() {
  const { oauthToken, tokenExpiry } = await chrome.storage.local.get(['oauthToken','tokenExpiry']);
  if (oauthToken && tokenExpiry && Date.now() < tokenExpiry) return oauthToken;
  return null;
}

async function requireToken() {
  const t = await getToken();
  if (!t) throw new Error('Chưa có token. Hãy dùng labs.google một chút để token được capture!');
  return t;
}

// ── reCAPTCHA solver ─────────────────────────────────
async function solveCaptcha(action = 'IMAGE_GENERATION', timeoutMs = 20000) {
  const allTabs = await chrome.tabs.query({});
  const labTab = allTabs.find(t => t.url && t.url.includes('labs.google'));
  if (!labTab) {
    console.warn('[Meo3] solveCaptcha: Không tìm thấy tab labs.google');
    return null;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: labTab.id },
      world: 'MAIN',
      func: async (act) => {
        const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
        let waited = 0;
        while ((!window.grecaptcha?.enterprise?.execute) && waited < 10000) {
          await new Promise(r => setTimeout(r, 200));
          waited += 200;
        }
        if (!window.grecaptcha?.enterprise?.execute) throw new Error('grecaptcha not ready');
        return await window.grecaptcha.enterprise.execute(SITE_KEY, { action: act });
      },
      args: [action]
    });
    const token = results?.[0]?.result || null;
    if (token) {
      console.log(`[Meo3] solveCaptcha success (len: ${token.length})`);
    }
    return token;
  } catch (e) {
    console.warn('[Meo3] solveCaptcha error:', e.message);
    return null;
  }
}

// ── Project helpers ──────────────────────────────────
async function getOrCreateProject(token) {
  // 1. Đọc project ID từ URL tab labs.google đang mở
  const allTabs = await chrome.tabs.query({});
  const tabs = allTabs.filter(t => t.url && t.url.includes('labs.google'));
  for (const tab of tabs) {
    const match = tab.url?.match(/\/project\/([a-f0-9-]{36})/i);
    if (match && match[1]) {
      await chrome.storage.local.set({ projectId: match[1] });
      return match[1];
    }
  }

  // 2. Lấy danh sách project tươi mới từ tài khoản hiện tại
  try {
    const input = JSON.stringify({ json: { pageSize: 20, toolName: TOOL_NAME, cursor: null } });
    const listRes = await fetch(`${LABS_BASE}/fx/api/trpc/project.searchUserProjects?input=${encodeURIComponent(input)}`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      credentials: 'include'
    });
    if (listRes.ok) {
      const data = await listRes.json();
      const projects = data?.result?.data?.json?.projects || [];
      if (projects.length > 0) {
        const pid = projects[0].id || projects[0].name;
        if (pid) {
          await chrome.storage.local.set({ projectId: pid });
          return pid;
        }
      }
    }
  } catch (e) {
    console.warn('[Meo3] searchUserProjects error:', e);
  }

  // 3. Tạo project mới nếu nick chưa có project nào
  try {
    const createRes = await fetch(`${LABS_BASE}/fx/api/trpc/project.createProject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      credentials: 'include',
      body: JSON.stringify({ json: { projectTitle: 'Meo3 Studio', toolName: TOOL_NAME } })
    });
    if (createRes.ok) {
      const cdata = await createRes.json();
      const pid = cdata?.result?.data?.json?.id || cdata?.result?.data?.json?.name;
      if (pid) {
        await chrome.storage.local.set({ projectId: pid });
        return pid;
      }
    }
  } catch (e) {
    console.warn('[Meo3] createProject error:', e);
  }

  // 4. Fallback cuối cùng: dùng cached ID nếu có
  const stored = await chrome.storage.local.get(['projectId']);
  return stored.projectId || null;
}


// ── aisandbox-pa API request ─────────────────────────
async function apiRequest(method, endpoint, body, token) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain;charset=UTF-8',
      'Origin': LABS_BASE,
      'Referer': `${LABS_BASE}/`
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'omit'
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch(_) { data = text; }
  if (!res.ok) throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// ── Upload image ─────────────────────────────────────
async function uploadImage(fileBytes, projectId, token) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(fileBytes)));
  const res = await apiRequest('POST', '/v1/flow/uploadImage', {
    clientContext: { projectId, tool: TOOL_NAME },
    imageBytes: base64
  }, token);
  const mediaId = res?.media?.name;
  if (!mediaId) throw new Error(`Upload failed: ${JSON.stringify(res)}`);
  return mediaId;
}

// ── Generate video ───────────────────────────────────
async function generateVideo({ prompt, startImageMediaId, endImageMediaId, aspectRatio, videoModel, projectId, token }) {
  const hasStart = !!startImageMediaId;
  const hasEnd   = !!endImageMediaId;

  let genType = 't2v';
  if (hasStart && hasEnd) genType = 'f2v';
  else if (hasStart) genType = 'i2v';

  const baseModel = videoModel || 'veo_3_1_lite_low_priority';
  let modelKey = baseModel;

  if (baseModel.includes('low_priority')) {
    if (genType === 't2v') modelKey = 'veo_3_1_t2v_lite_low_priority';
    else if (genType === 'f2v') modelKey = 'veo_3_1_interpolation_lite_low_priority';
    else modelKey = 'veo_3_1_i2v_lite_low_priority';
  } else if (baseModel === 'abra') {
    modelKey = 'abra';
  } else {
    if (genType === 't2v') modelKey = baseModel;
    else if (genType === 'f2v') modelKey = baseModel.replace('veo_3_1_', 'veo_3_1_interpolation_');
    else modelKey = baseModel.replace('veo_3_1_', 'veo_3_1_i2v_');
  }

  const ratioMap = {
    'VIDEO_ASPECT_RATIO_PORTRAIT':  'VIDEO_ASPECT_RATIO_PORTRAIT',
    'VIDEO_ASPECT_RATIO_LANDSCAPE': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    'VIDEO_ASPECT_RATIO_SQUARE':    'VIDEO_ASPECT_RATIO_SQUARE'
  };
  const ratio = ratioMap[aspectRatio] || 'VIDEO_ASPECT_RATIO_PORTRAIT';

  const req = {
    aspectRatio: ratio,
    seed: Math.floor(Math.random() * 2147483647),
    textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
    videoModelKey: modelKey,
    metadata: {}
  };
  if (hasStart) req.startImage = { mediaId: startImageMediaId, cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 } };
  if (hasEnd)   req.endImage   = { mediaId: endImageMediaId,   cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 } };

  const endpointMap = {
    t2v: '/v1/video:batchAsyncGenerateVideoText',
    i2v: '/v1/video:batchAsyncGenerateVideoStartImage',
    f2v: '/v1/video:batchAsyncGenerateVideoStartAndEndImage'
  };

  const batchId = crypto.randomUUID();

  const buildBody = (recaptchaToken) => ({
    mediaGenerationContext: { batchId },
    clientContext: {
      projectId, tool: TOOL_NAME,
      sessionId: ';' + Date.now(),
      userPaygateTier: 'PAYGATE_TIER_TWO',
      ...(recaptchaToken ? { recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' } } : {})
    },
    requests: [req],
    useV2ModelConfig: true
  });

  // Reactive captcha: thử không có token trước, nếu 403 thì solve + retry
  try {
    return await apiRequest('POST', endpointMap[genType], buildBody(null), token);
  } catch (e) {
    if (!e.message.includes('403')) throw e;
    let captchaToken = null;
    try { captchaToken = await solveCaptcha('VIDEO_GENERATION', 20000); } catch (_) {}
    return await apiRequest('POST', endpointMap[genType], buildBody(captchaToken), token);
  }
}


// ── Generate image (SYNCHRONOUS — trả về ảnh ngay) ────
const IMAGE_MODEL_NAMES = {
  'nano_banana_pro':  'GEM_PIX_2',
  'nano_banana_2':    'NARWHAL',
  'nano_banana_2_lite': 'HARBOR_SEAL'
};

async function generateImage({ prompt, referenceMediaId, imageModel, projectId, token }) {
  const batchId = crypto.randomUUID();
  const modelName = IMAGE_MODEL_NAMES[imageModel] || 'GEM_PIX_2';
  const imageInputs = referenceMediaId ? [{ name: referenceMediaId }] : [];

  const requests = [{
    imageModelName: modelName,
    imageAspectRatio: 'IMAGE_ASPECT_RATIO_PORTRAIT',
    structuredPrompt: { parts: [{ text: prompt }] },
    seed: Math.floor(Math.random() * 2147483647),
    imageInputs
  }];

  const buildBody = (recaptchaToken) => ({
    clientContext: {
      projectId, tool: TOOL_NAME, sessionId: ';' + Date.now(),
      ...(recaptchaToken ? { recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' } } : {})
    },
    mediaGenerationContext: { batchId },
    useNewMedia: true,
    requests
  });

  const endpoint = `/v1/projects/${projectId}/flowMedia:batchGenerateImages`;

  let data;
  try {
    data = await apiRequest('POST', endpoint, buildBody(null), token);
  } catch (e) {
    if (!e.message.includes('403')) throw e;
    let captchaToken = null;
    try { captchaToken = await solveCaptcha('IMAGE_GENERATION', 20000); } catch (_) {}
    data = await apiRequest('POST', endpoint, buildBody(captchaToken), token);
  }

  // Response trả về ảnh NGAY (synchronous) — extract URL trực tiếp
  const mediaItems = data?.media || [];
  const imageResults = mediaItems.map(item => {
    const url = item?.image?.generatedImage?.fifeUrl || null;
    const name = item?.name;
    return { name, url, status: url ? 'done' : 'failed' };
  });

  return { imageResults, raw: data };
}


// ── Check video status ────────────────────────────────
async function checkVideoStatus(mediaItems, token) {
  return await apiRequest('POST', '/v1/video:batchCheckAsyncVideoGenerationStatus', { media: mediaItems }, token);
}

// ── Check image status ────────────────────────────────
async function checkImageStatus(mediaItems, token) {
  return await apiRequest('POST', '/v1/image:batchCheckAsyncImageGenerationStatus', { media: mediaItems }, token);
}

// ── Get media download URL ────────────────────────────
async function getMediaUrl(mediaId, type, token) {
  const allTabs = await chrome.tabs.query({});
  const tab = allTabs.find(t => t.url && t.url.includes('labs.google'));
  const tabId = tab?.id;
  if (!tabId) return null;

  // Cả video và ảnh đều dùng FETCH_FROM_PAGE (ISOLATED world) — giống nhau
  const params = new URLSearchParams({ name: mediaId, mediaUrlType: type });
  const targetUrl = `${LABS_BASE}/fx/api/trpc/media.getMediaUrlRedirect?${params}`;
  try {
    const result = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 10000);
      chrome.tabs.sendMessage(tabId, { type: 'FETCH_FROM_PAGE', url: targetUrl }, res => {
        clearTimeout(t);
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(res);
      });
    });
    return result?.url || null;
  } catch (_) { return null; }
}

// ── Unified Media Binary Fetcher ──────────────────────
async function fetchMediaBase64(mediaId, directUrl = null, mediaType = 'image') {
  const tok = await getToken();
  const isVideo = mediaType === 'video';
  const urlType = isVideo ? 'MEDIA_URL_TYPE_VIDEO' : 'MEDIA_URL_TYPE_IMAGE';

  let downloadUrl = directUrl || null;
  if (!downloadUrl && mediaId) {
    downloadUrl = await getMediaUrl(mediaId, urlType, tok);
  }
  downloadUrl = downloadUrl || directUrl;
  if (!downloadUrl) throw new Error('Không lấy được link ảnh/video từ Google Flow');

  console.log(`[Meo3] Fetching media binary from: ${downloadUrl.substring(0, 60)}...`);

  // Service worker có host_permissions nên fetch thẳng binary không bị giới hạn CORS của web page
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Fetch binary HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  
  // Convert ArrayBuffer sang Base64
  let binary = '';
  const bytes = new Uint8Array(buf);
  const len = bytes.byteLength;
  const CHUNK_SIZE = 0x8000; // 32KB chunk để tránh stack overflow
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  const base64 = btoa(binary);
  const mime = isVideo ? 'video/mp4' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${base64}`;

  return { base64, dataUrl, url: downloadUrl };
}




// ── Task storage ──────────────────────────────────────
async function saveTask(task) {
  const { tasks = [] } = await chrome.storage.local.get('tasks');
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx >= 0) tasks[idx] = task; else tasks.unshift(task);
  await chrome.storage.local.set({ tasks: tasks.slice(0, 200) });
}

async function getTasks() {
  const { tasks = [] } = await chrome.storage.local.get('tasks');
  return tasks;
}

// ── Message handler ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STORE_TOKEN' && msg.token) {
    chrome.storage.local.set({ oauthToken: msg.token, tokenExpiry: Date.now() + 55 * 60 * 1000 });
    if (_ws && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ type: 'TOKEN_SYNC', token: msg.token }));
    }
    return;
  }
  // VIDEO_URL_RESULT được relay từ content script → các listener trong getMediaUrl sẽ bắt
  if (msg.type === 'VIDEO_URL_RESULT' || msg.type === 'CAPTCHA_RESULT') {
    return; // Không cần sendResponse — các promise listener trong getMediaUrl/solveCaptcha sẽ xử lý
  }
  handleMessage(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg) {
  const token = await getToken();

  switch (msg.type) {
    case 'GET_TOKEN':
      return { token, hasToken: !!token };

    case 'UPLOAD_FILE': {
      const tok = await requireToken();
      const projectId = await getOrCreateProject(tok);
      const mediaId = await uploadImage(msg.fileData, projectId, tok);
      return { mediaId };
    }

    case 'GENERATE_VIDEO': {
      const tok = await requireToken();
      const projectId = await getOrCreateProject(tok);
      const result = await generateVideo({ ...msg.payload, projectId, token: tok });
      return { result };
    }

    case 'GENERATE_IMAGE': {
      const tok = await requireToken();
      const projectId = await getOrCreateProject(tok);
      const result = await generateImage({ ...msg.payload, projectId, token: tok });
      return { result };
    }

    case 'CHECK_STATUS': {
      const tok = token || await requireToken();
      const { mediaItems, mediaType } = msg;
      const result = mediaType === 'image'
        ? await checkImageStatus(mediaItems, tok)
        : await checkVideoStatus(mediaItems, tok);
      return { result };
    }

    case 'GET_MEDIA_URL': {
      const tok = token || await requireToken();
      const url = await getMediaUrl(msg.mediaId, msg.mediaType, tok);
      return { url };
    }

    case 'SAVE_TASK':
      await saveTask(msg.task);
      return { ok: true };

    case 'GET_TASKS':
      return { tasks: await getTasks() };

    case 'DELETE_TASK': {
      const { tasks: all = [] } = await chrome.storage.local.get('tasks');
      await chrome.storage.local.set({ tasks: all.filter(t => t.id !== msg.id) });
      return { ok: true };
    }

    case 'DOWNLOAD_FILE': {
      const ext = msg.mediaType === 'video' ? 'mp4' : 'jpg';
      const filename = 'meo3_' + Date.now() + '.' + ext;
      try {
        const { dataUrl } = await fetchMediaBase64(msg.mediaId, msg.url, msg.mediaType);
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      } catch (e) {
        // Fallback: direct download
        chrome.downloads.download({ url: msg.url, filename, saveAs: false });
      }
      return { ok: true };
    }

    default:
      throw new Error(`Unknown: ${msg.type}`);
  }
}
