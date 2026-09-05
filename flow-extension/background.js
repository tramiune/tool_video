// Flow Studio Bridge — Background Service Worker v3.3
// Uses captured auth token from Flow's own API calls (Isolated Per-Tab)
"use strict";

// ── Auth Token Management (Isolated Per-Tab) ──
// Map: tabId -> { auth: string, time: number }
const tabAuthTokens = new Map();
const MAX_TOKEN_AGE_MS = 50 * 60 * 1000; // 50 phút

// Dọn dẹp token khi tab đóng
chrome.tabs.onRemoved.addListener((tabId) => {
  tabAuthTokens.delete(tabId);
});

async function invalidateAuthToken(flowTab = null) {
  if (flowTab?.id) {
    tabAuthTokens.delete(flowTab.id);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: flowTab.id },
        world: "MAIN",
        func: () => {
          if (typeof window.__clearFlowAuth === "function") {
            window.__clearFlowAuth();
          } else {
            window.__flowAuth = null;
            window.__flowAuthTime = 0;
            try {
              sessionStorage.removeItem("__flow_saved_auth");
              sessionStorage.removeItem("__flow_saved_auth_time");
              sessionStorage.removeItem("flow_auth_token");
            } catch (_) {}
          }
        }
      });
    } catch (_) {}
  }
}

async function getFreshAuthToken(flowTab, allowExpired = false) {
  if (!flowTab?.id) return null;
  const tabId = flowTab.id;
  const now = Date.now();

  // 1. Kiểm tra trong memory map của tab này
  const cached = tabAuthTokens.get(tabId);
  if (cached?.auth && (allowExpired || (cached.time > 0 && now - cached.time < MAX_TOKEN_AGE_MS))) {
    return cached.auth;
  }

  // 2. Đọc từ world MAIN của chính flowTab này
  try {
    const authResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const auth = window.__flowAuth || sessionStorage.getItem("__flow_saved_auth") || "";
        const savedTime = window.__flowAuthTime || parseInt(sessionStorage.getItem("__flow_saved_auth_time") || "0", 10);
        return { auth, savedTime };
      }
    });
    const data = authResults?.[0]?.result;
    if (data?.auth && data.auth.startsWith("Bearer ya29")) {
      const age = now - (data.savedTime || 0);
      if (allowExpired || !data.savedTime || age < MAX_TOKEN_AGE_MS) {
        tabAuthTokens.set(tabId, { auth: data.auth, time: data.savedTime || now });
        return data.auth;
      }
    }
  } catch (e) {
    console.warn(`❌ Lỗi đọc auth từ Flow tab ${tabId}:`, e);
  }

  return null;
}

async function triggerTokenGenerationInTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        try {
          // Gửi request nội bộ bằng credentials của chính tab để Flow mint/send token ya29
          fetch("https://labs.google/fx/api/trpc/project.searchUserProjects?input=%7B%7D", { credentials: "include" }).catch(() => {});
          fetch("https://aisandbox-pa.googleapis.com/v1/flowWorkflows", { credentials: "include" }).catch(() => {});
        } catch (_) {}
      }
    });
  } catch (_) {}
}

async function refreshAuthByReloadingTab(flowTab, purpose = 'Flow Tab') {
  if (!flowTab?.id) return null;
  const tabId = flowTab.id;
  logToBridge(`[Auth Engine] Đang tìm kiếm Auth Token cho ${purpose} (Tab ID: ${tabId})...`);

  // Bước 1: Kiểm tra xem tab đã có token sẵn chưa
  let existingAuth = await getFreshAuthToken(flowTab);
  if (existingAuth) {
    logToBridge(`[Auth Engine] ✅ Đã có sẵn Auth Token hợp lệ cho ${purpose}!`);
    return existingAuth;
  }

  // Bước 2: Chủ động kích hoạt request nội bộ trong chính tab đó để sinh token (không cần reload ngay)
  logToBridge(`[Auth Engine] Chủ động kích hoạt phiên tạo token trong ${purpose}...`);
  await triggerTokenGenerationInTab(tabId);
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 600));
    const token = await getFreshAuthToken(flowTab);
    if (token) {
      logToBridge(`[Auth Engine] ✅ Kích hoạt thành công! Đã bắt được Auth Token từ ${purpose}!`);
      return token;
    }
  }

  // Bước 3: Nếu vẫn chưa có token -> F5 lại tab, nhưng TUYỆT ĐỐI KHÔNG XÓA TOKEN TRƯỚC ĐÓ
  logToBridge(`[Auth Engine] F5 ${purpose} để nạp lại phiên...`);
  try {
    await chrome.tabs.reload(tabId);
  } catch (e) {
    console.warn("Lỗi reload tab:", e);
  }

  // Đợi trang tải lại và chủ động kích hoạt lại
  const startTime = Date.now();
  while (Date.now() - startTime < 12000) {
    await new Promise(r => setTimeout(r, 800));
    const token = await getFreshAuthToken(flowTab);
    if (token) {
      logToBridge(`[Auth Engine] ✅ Đã bắt được Auth Token mới từ ${purpose}!`);
      return token;
    }
    // Cứ mỗi 3s thử kích hoạt lại 1 lần
    if ((Date.now() - startTime) % 3000 < 800) {
      await triggerTokenGenerationInTab(tabId);
    }
  }

  logToBridge(`[Auth Engine] ⚠️ Đã thử lấy token cho ${purpose} nhưng chưa bắt được. Vui lòng kiểm tra tab đã đăng nhập.`);
  return tabAuthTokens.get(tabId)?.auth || null;
}

const TRPC_BASE = "https://labs.google/fx/api/trpc";

const MODEL_NAMES = {
  "veo_3_1_t2v_lite_low_priority": "Veo 3.1 Lite (Lower Priority)",
  "veo_3_1_lite": "Veo 3.1 Lite",
  "veo_3_1_fast": "Veo 3.1 Fast",
  "veo_3_1_quality": "Veo 3.1 Quality",
  "abra": "Omni Flash",
};

// ── Message Handler ──
function handleMessage(req, sender, sendResponse) {
  console.log("📥 BG:", req.action, req);

  // Nhận token được bắt từ MAIN world qua content_script
  if (req.action === "FLOW_AUTH_CAPTURED") {
    if (sender?.tab?.id && req.auth) {
      const tabId = sender.tab.id;
      tabAuthTokens.set(tabId, { auth: req.auth, time: req.time || Date.now() });
      console.log(`[Auth Engine] Captured fresh auth token for tab ${tabId} (${req.auth.slice(0, 25)}...)`);
    }
    sendResponse({ success: true });
    return true;
  }

  // Nhận request batchexecute kiểu mới được bắt từ MAIN world

  if (req.action === "TEST_UI_STEP") {
    testUiStep(req.step, req).then(sendResponse).catch(e => sendResponse({success: false, error: e.message}));
    return true;
  }

  if (req.action === "FLOW_BATCHEXECUTE_CAPTURED") {
    const tabId = sender?.tab?.id || 'unknown';
    const rpcIds = req.rpcIds || 'batchexecute';
    const isL2jnw = rpcIds.includes('L2jnw') || JSON.stringify(req.fReq || '').includes('L2jnw');
    
    logToBridge(`[New API Captured] 🚀 Tab ${tabId} vừa gọi batchexecute: RPC [${rpcIds}]`);
    console.log(`🚀 [New API Captured Tab ${tabId}]: RPC [${rpcIds}]`, req);

    if (isL2jnw) {
      const summary = JSON.stringify(req.fReq).slice(0, 300);
      logToBridge(`[New API Captured] 🔥 TÓM ĐƯỢC CẤU TRÚC L2jnw (StreamGenerateContent): ${summary}...`);
      try {
        chrome.storage.local.set({
          captured_L2jnw: {
            url: req.url,
            at: req.at,
            fReq: req.fReq,
            time: req.time || Date.now()
          }
        });
      } catch (_) {}
    }

    sendResponse({ success: true });
    return true;
  }

  const handler = HANDLERS[req.action];
  if (!handler) { sendResponse({ success: false, error: "Unknown: " + req.action }); return true; }
  handler(req, sender)
    .then(r => { console.log("✅", r); sendResponse(r); })
    .catch(e => { console.error("❌", e); sendResponse({ success: false, error: e.message }); });
  return true;
}

chrome.runtime.onMessage.addListener(handleMessage);
chrome.runtime.onMessageExternal.addListener(handleMessage);

// ── Service Worker Permanent Keep-Alive Engine (Never Sleep) ──
let keepAliveTimer = null;
function ensureKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch (e) {}
  }, 10000);
}
ensureKeepAlive();

// Persistent port connections from tabs keep SW 100% active
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((msg) => {
    try { port.postMessage({ status: "alive" }); } catch (e) {}
  });
  port.onDisconnect.addListener(() => {
    ensureKeepAlive();
  });
});

// Alarms keep-alive fallback
try {
  if (chrome.alarms) {
    chrome.alarms.create("flowKeepAlive", { periodInMinutes: 0.25 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "flowKeepAlive") ensureKeepAlive();
    });
  }
} catch (e) {}

// Reset and wipe any previous proxy settings to Direct connection immediately
try {
  if (chrome.proxy && chrome.proxy.settings) {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      console.log("🧹 Chrome Proxy CLEARED completely!");
    });
    chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" }, () => {
      console.log("🌐 Chrome Proxy set to DIRECT!");
    });
  }
} catch (e) {
  console.warn("Proxy clear error:", e);
}

const HANDLERS = {
  PING:               async () => ({ success: true, version: "3.9" }),
  GET_PROJECT_VIDEOS: req => getProjectVideos(req.projectId),
  GET_DOWNLOAD_URL:   req => getDownloadUrl(req.mediaId),
  DOWNLOAD_VIDEO:     req => downloadVideo(req.mediaId, req.filename),
  CREATE_VIDEO:       req => createVideoAPI(req.prompt, req.projectId, req.model, req.aspectRatio, req.startImage, req.endImage),
  CREATE_VIDEO_UI:    req => createVideoUI(req.prompt, req.projectId, req.config),
  CREATE_IMAGE:       req => createImageAPI(req.prompt, req.projectId, req.model, req.aspectRatio, req.referenceImage),
  DELETE_VIDEO:       req => deleteVideo(req.workflowId, req.projectId, req.mediaId),
  UPLOAD_IMAGE:       req => uploadImage(req.projectId, req.imageUrl, req.imageBase64),
  RENAME_WORKFLOW_TO_UUID: req => renameWorkflowToUuid(req.projectId, req.mediaId),
  GET_TOOL_SERVER_STATUS:  async () => ({ connected: _toolServerConnected }),
  GET_LIVE_LOGS:           async () => ({ logs: _recentBridgeLogs }),
  CREATE_PROJECT:     req => createProject(req.title),
  GENERATE_TTS:       req => generateTTSAudio(req.text, req.lang, req.voiceIndex),
  GET_TTS_VOICES:     req => getTTSVoices(req.lang),
  GENERATE_AI_SCRIPT: req => generateAIScriptDynamic(req.topic, req.totalScenes, req.totalMinutes, req.lang, req.geminiApiKey),
  GET_FLOW_TABS_STATUS: async () => getFlowTabsStatus(),
};

// ══════════════════════════════════════
// Dedicated Flow Tab Manager (Dual-Tab Support: 1 Video, 1 Image)
// ══════════════════════════════════════
async function getFlowTab(purpose = 'video', targetProjectId = null) {
  const flowTabs = await chrome.tabs.query({ url: ["https://labs.google/*", "https://flow.google.com/*"] });
  if (!flowTabs.length) return null;
  if (flowTabs.length === 1) return flowTabs[0];

  // 1. If targetProjectId is explicitly provided, find tab whose URL matches it
  if (targetProjectId) {
    const match = flowTabs.find(t => t.url?.toLowerCase().includes(targetProjectId.toLowerCase()));
    if (match) return match;
  }

  // 2. Sắp xếp các tab theo thứ tự từ trái sang phải trong cửa sổ
  flowTabs.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));

  // Tab đầu tiên (bên trái) = Dành riêng cho VIDEO
  // Tab thứ hai (bên phải) = Dành riêng cho TẠO ẢNH
  if (purpose === 'image') {
    return flowTabs[1] || flowTabs[0];
  } else {
    return flowTabs[0];
  }
}

async function getFlowTabsStatus() {
  const flowTabs = await chrome.tabs.query({ url: ["https://labs.google/*", "https://flow.google.com/*"] });
  const videoTab = await getFlowTab('video');
  const imageTab = await getFlowTab('image');
  return {
    totalTabs: flowTabs.length,
    videoTabId: videoTab?.id || null,
    videoTabUrl: videoTab?.url || null,
    imageTabId: imageTab?.id || null,
    imageTabUrl: imageTab?.url || null
  };
}

// ══════════════════════════════════════
// 0. Create New Project
// ══════════════════════════════════════
async function createProject(title) {
  const flowTab = await getFlowTab('video');
  if (!flowTab) return { success: false, error: "Cần mở tab Google Flow!" };

  try {
    const now = new Date();
    const projectTitle = title || now.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    const results = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      args: [projectTitle],
      func: async (pTitle) => {
        try {
          const r = await fetch("https://labs.google/fx/api/trpc/project.createProject", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ json: { projectTitle: pTitle, toolName: "PINHOLE" } })
          });
          const txt = await r.text();
          if (!r.ok) return JSON.stringify({ error: "API " + r.status, body: txt.slice(0, 500) });
          return txt;
        } catch (e) { return JSON.stringify({ error: e.message }); }
      }
    });

    const raw = results?.[0]?.result;
    if (!raw) return { success: false, error: "Response rỗng" };
    let p; try { p = JSON.parse(raw); } catch { p = raw; }
    if (p?.error) return { success: false, error: p.error };

    // Extract projectId from response
    const projectId = p?.result?.data?.json?.projectId || 
                      p?.result?.data?.json?.id ||
                      p?.result?.data?.projectId || 
                      p?.result?.data?.id ||
                      (typeof p?.result?.data?.json === "string" ? p?.result?.data?.json : null) ||
                      p?.json?.projectId || 
                      p?.projectId || null;
    if (!projectId) return { success: false, error: "Không tìm thấy projectId trong response", raw: p };

    console.log("📁 New project created:", projectId, projectTitle);
    return { success: true, projectId, title: projectTitle };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════════
// 1. Get Project Videos & Images
// ══════════════════════════════════════
async function getProjectVideos(projectId) {
  if (!projectId) return { success: false, error: "Thiếu projectId" };
  const input = JSON.stringify({ json: { projectId } });
  const url = `${TRPC_BASE}/flow.projectInitialData?input=${encodeURIComponent(input)}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    if (res.status === 400) return { success: false, error: "Project ID không hợp lệ!" };
    if (res.status === 401 || res.status === 403) return { success: false, error: "Chưa đăng nhập Google Flow!" };
    return { success: false, error: `HTTP ${res.status}` };
  }
  const data = await res.json();
  const json = data?.result?.data?.json || {};
  const mediaList = json?.projectContents?.media || [];
  const workflows = json?.projectContents?.workflows || [];
  const projectName = json?.projectName || "Chưa đặt tên";
  const defaultModelKey = json?.agentInfo?.defaultGenerationSettings?.videoDefaults?.videoModelFamilyKey || "veo_3_1_lite";

  // Load locally deleted IDs as cache
  let localDeleted = [];
  try {
    const s = await chrome.storage.local.get("deletedWorkflowIds");
    localDeleted = s.deletedWorkflowIds || [];
  } catch {}
  const deletedSet = new Set(localDeleted);

  // Build mediaId -> workflowId map and detect archived workflows
  const mediaToWorkflow = {};
  const archivedWorkflowIds = new Set();
  const activeMediaIds = new Set();

  for (const wf of workflows) {
    const wfId = wf.name;
    const meta = wf.metadata || {};
    const isArchived = meta.archived === true || deletedSet.has(wfId);

    if (isArchived) {
      archivedWorkflowIds.add(wfId);
    }

    if (meta.primaryMediaId) {
      mediaToWorkflow[meta.primaryMediaId] = wfId;
      if (!isArchived) activeMediaIds.add(meta.primaryMediaId);
    }
    if (Array.isArray(meta.mediaIds)) {
      for (const mId of meta.mediaIds) {
        mediaToWorkflow[mId] = wfId;
        if (!isArchived) activeMediaIds.add(mId);
      }
    }
    if (Array.isArray(wf.media)) {
      for (const m of wf.media) {
        if (m.name) {
          mediaToWorkflow[m.name] = wfId;
          if (!isArchived) activeMediaIds.add(m.name);
        }
      }
    }
  }

  const videos = mediaList
    .filter(item => {
      // Filter out explicitly archived items or deleted IDs
      if (item.mediaMetadata?.archived === true) return false;
      if (deletedSet.has(item.name)) return false;

      const wfId = mediaToWorkflow[item.name];
      if (wfId && (archivedWorkflowIds.has(wfId) || deletedSet.has(wfId))) return false;

      const g = item.video?.generatedVideo || {};
      return g.prompt && g.prompt.length > 0;
    })
    .map(item => {
      const meta = item.mediaMetadata || {};
      const gen = item.video?.generatedVideo || {};
      const ctrl = meta.requestData?.videoGenerationRequestData?.videoModelControlInput || {};
      const rawModel = ctrl.videoModelName || defaultModelKey;
      let prompt = gen.prompt || "";
      const pm = prompt.match(/<prompt>([\s\S]*?)<\/prompt>/);
      if (pm) prompt = pm[1].trim();
      prompt = prompt.replace(/<[^>]+>/g, "").trim() || meta.mediaTitle || item.name;
      const mediaStatus = meta.mediaStatus || {};
      const genStatus = mediaStatus.mediaGenerationStatus || "";

      let status = "PROCESSING";
      if (genStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL" || genStatus === "SUCCESSFUL") {
        status = "COMPLETED";
      } else if (genStatus === "MEDIA_GENERATION_STATUS_FAILED" || genStatus === "FAILED") {
        status = "FAILED";
      } else if (genStatus === "MEDIA_GENERATION_STATUS_PENDING" || genStatus === "MEDIA_GENERATION_STATUS_IN_PROGRESS" || genStatus === "PENDING" || genStatus === "IN_PROGRESS") {
        status = "PROCESSING";
      } else {
        // Fallback: check if video has media output or fifeUrl
        if (gen.fifeUrl || gen.videoUrl || item.video?.fifeUrl || meta.playbackUrl) {
          status = "COMPLETED";
        } else {
          status = "PROCESSING";
        }
      }

      const workflowId = mediaToWorkflow[item.name] || item.name;
      return {
        mediaId: item.name,
        workflowId: workflowId,
        projectId: item.projectId,
        prompt,
        createTime: meta.createTime,
        status,
        failureReason: mediaStatus.failureReasons?.join(", ") || mediaStatus.error?.message || "",
        model: MODEL_NAMES[rawModel] || rawModel,
        resolution: (ctrl.videoResolution || "VIDEO_RESOLUTION_720P").replace("VIDEO_RESOLUTION_", ""),
        aspectRatio: (ctrl.videoAspectRatio || "").replace("VIDEO_ASPECT_RATIO_", "") || "LANDSCAPE",
      };
    })
    .sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === "PROCESSING") return -1;
        if (b.status === "PROCESSING") return 1;
        if (a.status === "COMPLETED") return -1;
        if (b.status === "COMPLETED") return 1;
      }
      return (b.createTime || "").localeCompare(a.createTime || "");
    });

  // Extract available images for Image-to-Video selection
  const images = mediaList
    .filter(item => {
      if (item.mediaMetadata?.archived === true || deletedSet.has(item.name)) return false;
      const wfId = mediaToWorkflow[item.name];
      if (wfId && (archivedWorkflowIds.has(wfId) || deletedSet.has(wfId))) return false;
      return !item.video?.generatedVideo?.prompt; // non-video media items are images
    })
    .map(item => {
      let prompt = item.image?.generatedImage?.prompt || item.mediaMetadata?.mediaTitle || item.name;
      prompt = prompt.replace(/<[^>]+>/g, "").trim();
      const wfId = mediaToWorkflow[item.name] || item.name;
      const meta = item.mediaMetadata || {};
      const mediaStatus = meta.mediaStatus || {};
      const genStatus = mediaStatus.mediaGenerationStatus || "";
      let status = "PROCESSING";
      if (genStatus.includes("SUCCESS") || item.image?.fifeUrl || meta.playbackUrl || meta.imageUrl) {
        status = "COMPLETED";
      } else if (genStatus.includes("FAIL")) {
        status = "FAILED";
      } else {
        status = "COMPLETED";
      }
      return {
        mediaId: item.name,
        workflowId: wfId,
        projectId: item.projectId || projectId,
        prompt: prompt || item.name.slice(0, 8),
        createTime: item.mediaMetadata?.createTime,
        status: status
      };
    })
    .sort((a, b) => (b.createTime || "").localeCompare(a.createTime || ""));

  const formattedWorkflows = workflows.map(wf => ({
    mediaId: wf.metadata?.primaryMediaId || wf.name,
    workflowId: wf.name,
    projectId: projectId,
    prompt: wf.metadata?.prompt || '',
    createTime: wf.metadata?.createTime || '',
    status: 'PROCESSING'
  }));

  return { success: true, projectId, projectName, defaultModel: MODEL_NAMES[defaultModelKey] || defaultModelKey, totalMedia: mediaList.length, totalVideos: videos.length, totalImages: images.length, videos, images, workflows: formattedWorkflows };
}

// ══════════════════════════════════════
// 2. Download
// ══════════════════════════════════════
async function getDownloadUrl(mediaId) {
  if (!mediaId) return { success: false, error: "Thiếu mediaId" };
  const flowTab = await getFlowTab('video');
  if (flowTab) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: flowTab.id },
        world: "MAIN",
        args: [mediaId],
        func: async (mId) => {
          try {
            const targetUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(mId)}&mediaUrlType=MEDIA_URL_TYPE_VIDEO`;
            const res = await fetch(targetUrl, { credentials: "include", redirect: "follow" });
            const finalUrl = res.url;
            if (finalUrl && !finalUrl.includes("getMediaUrlRedirect") && !finalUrl.includes("labs.google")) {
              return { ok: true, url: finalUrl };
            }
            try {
              const data = await res.json();
              const jsonUrl = data?.result?.data?.json?.url || data?.url || data?.redirectUrl;
              if (jsonUrl) return { ok: true, url: jsonUrl };
            } catch (_) {}
            return { ok: true, url: finalUrl };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        }
      });
      const res = results?.[0]?.result;
      if (res?.ok && res.url) {
        return { success: true, url: res.url, downloadUrl: res.url };
      }
    } catch (_) {}
  }

  const url = `${TRPC_BASE}/media.getMediaUrlRedirect?name=${mediaId}&mediaUrlType=MEDIA_URL_TYPE_VIDEO`;
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow" });
    const finalUrl = res.url || url;
    return { success: true, url: finalUrl, downloadUrl: finalUrl };
  } catch (err) {
    return { success: true, url, downloadUrl: url };
  }
}

async function downloadVideo(mediaId, filename) {
  if (!mediaId) return { success: false, error: "Thiếu mediaId" };
  const url = `${TRPC_BASE}/media.getMediaUrlRedirect?name=${mediaId}`;
  const fname = filename || `flow_video_${mediaId.slice(0, 8)}.mp4`;
  return new Promise(resolve => {
    chrome.downloads.download({ url, filename: fname, saveAs: false }, (id) => {
      resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : { success: true, message: "Đang tải...", downloadId: id });
    });
  });
}

// ══════════════════════════════════════
// 3. Create Video (Text-to-Video & Image-to-Video)
// ══════════════════════════════════════
async function createVideoAPI(prompt, projectId, model, aspectRatio, startImage, endImage) {
  if (!prompt && !startImage) return { success: false, error: "Cần nhập prompt hoặc chọn ảnh đầu vào!" };
  if (!projectId) return { success: false, error: "Thiếu projectId" };

  const flowTab = await getFlowTab('video', projectId);
  if (!flowTab) return { success: false, error: "Cần mở tab Google Flow và đăng nhập!" };
  let effectiveProjectId = projectId;
  if (!effectiveProjectId && flowTab.url) {
    const urlMatch = flowTab.url.match(/project\/([a-f0-9\-]{36})/i);
    if (urlMatch && urlMatch[1]) {
      effectiveProjectId = urlMatch[1];
    }
  }
  const modelKey = model || "veo_3_1_t2v_lite_low_priority";
  const aspectKey = aspectRatio || "VIDEO_ASPECT_RATIO_LANDSCAPE";

  // Step 1: Get captured auth token via scripting.executeScript (MAIN world)
  console.log("🔍 Getting captured auth token...");
  let authToken = null;
  try {
    const authResults = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      func: () => {
        return JSON.stringify({
          token: window.__flowAuth || null,
          age: window.__flowAuth ? (Date.now() - window.__flowAuthTime) : null
        });
      }
    });
    const authData = JSON.parse(authResults?.[0]?.result || "{}");
    authToken = authData.token;
  } catch (e) {
    console.error("❌ Auth read error:", e);
  }

  if (!authToken) {
    return { success: false, error: "Chưa bắt được Auth Token từ Google Flow. Hãy F5 lại tab Flow 1 lần nhé!" };
  }

  // Auto-upload startImage and endImage if they are URLs or Base64
  let startMediaId = startImage;
  let endMediaId = endImage;

  if (startImage && (startImage.startsWith("http://") || startImage.startsWith("https://") || startImage.startsWith("data:image"))) {
    console.log("📤 Auto-uploading start image to Flow...");
    const upRes = await uploadImage(projectId, startImage.startsWith("http") ? startImage : null, startImage.startsWith("data:") ? startImage : null);
    if (!upRes.success) return { success: false, error: "Lỗi tải ảnh đầu vào lên Flow: " + upRes.error };
    startMediaId = upRes.mediaId;
    console.log("✅ Start image uploaded, mediaId:", startMediaId);
  }

  if (endImage && (endImage.startsWith("http://") || endImage.startsWith("https://") || endImage.startsWith("data:image"))) {
    console.log("📤 Auto-uploading end image to Flow...");
    const upRes = await uploadImage(projectId, endImage.startsWith("http") ? endImage : null, endImage.startsWith("data:") ? endImage : null);
    if (!upRes.success) return { success: false, error: "Lỗi tải ảnh kết thúc lên Flow: " + upRes.error };
    endMediaId = upRes.mediaId;
    console.log("✅ End image uploaded, mediaId:", endMediaId);
  }

  // Step 2+3: reCAPTCHA + API all in MAIN world
  console.log("🚀 reCAPTCHA + API in MAIN world with Bearer auth...");
  try {
    const safePrompt = String(prompt || "");
    const safePid = String(effectiveProjectId || "");
    const safeModel = String(modelKey || "veo_3_1_t2v_lite_low_priority");
    const safeAuth = String(authToken || "");
    const safeAspect = String(aspectKey || "VIDEO_ASPECT_RATIO_PORTRAIT");
    const safeStart = startMediaId ? String(startMediaId) : null;
    const safeEnd = endMediaId ? String(endMediaId) : null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      args: [safePrompt, safePid, safeModel, safeAuth, safeAspect, safeStart, safeEnd],
      func: async (pt, pid, mk, auth, aspect, startImg, endImg) => {
        try {
          const ss = document.querySelectorAll('script[src*="recaptcha/enterprise.js"]');
          let sk = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
          for (const s of ss) {
            const m = (s.getAttribute("src") || "").match(/[?&]render=([^&]+)/);
            if (m && m[1]) { sk = m[1]; break; }
          }
          if (typeof grecaptcha === "undefined" || !grecaptcha.enterprise) {
            return JSON.stringify({ error: "grecaptcha not loaded" });
          }
          const tok = await new Promise((ok, no) => {
            grecaptcha.enterprise.ready(() => {
              grecaptcha.enterprise.execute(sk, { action: "VIDEO_GENERATION" }).then(ok).catch(no);
            });
          });

          // Determine route & modelKey for Text-to-Video vs Image-to-Video
          let route = "batchAsyncGenerateVideoText";
          let effectiveModel = mk;
          if (startImg || endImg) {
            effectiveModel = effectiveModel.replace("_t2v_", "_i2v_");
            if (!effectiveModel.includes("_i2v_") && effectiveModel.startsWith("veo_")) {
              effectiveModel = effectiveModel.replace("veo_3_1_", "veo_3_1_i2v_");
            }
          }

          const requestItem = {
            outputSpec: { resolution: "VIDEO_RESOLUTION_720P" },
            aspectRatio: aspect || "VIDEO_ASPECT_RATIO_PORTRAIT",
            textInput: { structuredPrompt: { parts: [{ text: pt || "" }] } },
            videoModelKey: effectiveModel,
            seed: Math.floor(Math.random() * 99999),
            metadata: {}
          };

          if (startImg && endImg) {
            route = "batchAsyncGenerateVideoStartAndEndImage";
            requestItem.startImage = typeof startImg === "string" ? { mediaId: startImg } : startImg;
            requestItem.endImage = typeof endImg === "string" ? { mediaId: endImg } : endImg;
          } else if (startImg) {
            route = "batchAsyncGenerateVideoStartImage";
            requestItem.startImage = typeof startImg === "string" ? { mediaId: startImg } : startImg;
          }


          const reqUrl = `https://aisandbox-pa.googleapis.com/v1/video:${route}`;
          const reqHeaders = { "Content-Type": "text/plain;charset=UTF-8", "Authorization": auth };
          const reqBody = {
              mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: "BLOCK_SILENCED_VIDEOS" },
              clientContext: {
                projectId: pid, tool: "PINHOLE", userPaygateTier: "PAYGATE_TIER_TWO",
                sessionId: ";" + Date.now(),
                recaptchaContext: { token: tok, applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" }
              },
              requests: [requestItem],
              useV2ModelConfig: true
          };

          // ===== DEBUG: So sánh với request thật =====
          console.log("🤖 [EXT REQUEST] URL:", reqUrl);
          console.log("🤖 [EXT REQUEST] Headers:", JSON.stringify(reqHeaders));
          const debugBody = JSON.stringify(reqBody).replace(/"token":"[^"]{50,}"/g, '"token":"<TOKEN>"');
          console.log("🤖 [EXT REQUEST] Body:", debugBody);
          // ==========================================

          const r = await fetch(reqUrl, {
            method: "POST",
            credentials: "include",
            headers: reqHeaders,
            body: JSON.stringify(reqBody)
          });
          const txt = await r.text();
          console.log("🤖 [EXT RESPONSE]", r.status, txt.slice(0, 500));
          if (!r.ok) return JSON.stringify({ error: "API " + r.status, body: txt.slice(0, 500) });
          return txt || "{}";
        } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }
      }
    });
    const raw = results?.[0]?.result;
    console.log("📦 Result:", raw);
    if (!raw) return { success: false, error: "Response rỗng" };
    let p; try { p = JSON.parse(raw); } catch { p = raw; }
    if (p?.error) return { success: false, error: p.error, detail: p.body };
    return { success: true, message: "✅ Đã tạo video! Chờ render...", apiResponse: p };
  } catch (e) {
    console.error("❌", e);
    return { success: false, error: "Lỗi kết nối Flow API: " + (e.message || String(e)) };
  }
}

// ══════════════════════════════════════
// Fallback: UI automation
// ══════════════════════════════════════
async function createVideoUI(prompt, projectId, config = {}) {
  // Tìm đúng Tab dành riêng cho Video
  const tab = await getFlowTab('video', projectId);
  if (!tab) return { success: false, error: "Cần mở ít nhất một tab Google Flow cho Video!" };

  // Focus vào tab Video để đảm bảo Slate editor nhận sự kiện phím
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 400));
  } catch (_) {}

  logToBridge(`[Flow Recon] Sử dụng Tab Video (ID: ${tab.id}) để thực hiện Auto Click...`);

  // Determine effective Project ID from tab URL or parameters
  const urlMatch = tab.url?.match(/project\/([a-zA-Z0-9_-]+)/);
  const effectiveProjectId = (urlMatch && urlMatch[1]) ? urlMatch[1] : projectId;

  // ──────────────────────────────────────────────
  // RECON STEP A: Snapshot Library Videos BEFORE Click
  // ──────────────────────────────────────────────
  let beforeIds = new Set();
  let beforeCount = 0;
  if (effectiveProjectId) {
    try {
      const beforeData = await getProjectVideos(effectiveProjectId);
      if (beforeData?.success) {
        const allMedia = [
          ...(beforeData.videos || []),
          ...(beforeData.images || []),
          ...(beforeData.workflows || [])
        ];
        beforeCount = allMedia.length;
        beforeIds = new Set();
        for (const m of allMedia) {
          if (m.mediaId) beforeIds.add(m.mediaId);
          if (m.workflowId) beforeIds.add(m.workflowId);
        }
        logToBridge(`[Flow Recon] Trước khi click: Đã có ${beforeCount} items (${beforeData.images?.length || 0} ảnh, ${beforeData.videos?.length || 0} video, ${beforeData.workflows?.length || 0} workflows) trong project ${effectiveProjectId.slice(0, 8)}...`);
      } else {
        logToBridge(`[Flow Recon] ⚠️ Lỗi getProjectVideos trước click: ${beforeData?.error || 'Lỗi'}`);
      }
    } catch (e) {
      logToBridge(`[Flow Recon] ⚠️ Lỗi khi snapshot thư viện trước click: ${e.message}`);
    }
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [prompt, config],
func: async (promptText, cfg) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        
        const queryDeep = (selector) => {
          const matches = [];
          const walk = (node) => {
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of node.children) {
              if (child.matches && child.matches(selector)) matches.push(child);
              walk(child);
            }
          };
          walk(document.body);
          return matches;
        };

        const queryScopeDeep = (scope, selector) => {
          if (!scope) return [];
          const matches = [];
          const walk = (node) => {
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of node.children) {
              if (child.matches && child.matches(selector)) matches.push(child);
              walk(child);
            }
          };
          walk(scope);
          return matches;
        };
        
        // ──────────────────────────────────────────────
        // STEP 1: Find Slate Editor & Composer Container
        // ──────────────────────────────────────────────
        const findDeepEditor = () => {
          const walk = (node) => {
            if (node.shadowRoot) {
              const res = walk(node.shadowRoot);
              if (res) return res;
            }
            for (const child of node.children) {
              if (child.tagName === 'TEXTAREA' || child.getAttribute('contenteditable') === 'true' || child.getAttribute('data-slate-editor') === 'true' || child.getAttribute('role') === 'textbox') {
                return child;
              }
              const res = walk(child);
              if (res) return res;
            }
            return null;
          };
          return walk(document.body);
        };

        const editor = document.querySelector("div[role='textbox'][data-slate-editor='true']")
                    || document.querySelector("div[data-slate-editor='true']")
                    || document.querySelector("div[contenteditable='true']")
                    || document.querySelector("textarea[placeholder*='prompt' i]")
                    || findDeepEditor();
                    
        if (!editor) return { success: false, error: "Không tìm thấy ô nhập prompt trên giao diện Flow!" };

        const composerButtons = queryDeep("button, [role='button']");
        
        // Identify submit button (arrow_forward icon)
        const submitBtn = composerButtons.find(b => {
          const inner = (b.innerHTML || "").toLowerCase();
          const t = (b.textContent || "").trim().toLowerCase();
          return inner.includes("arrow_forward") || inner.includes("send") || t === "arrow_forward" || t === "send";
        });

        // Identify settings chip button (e.g. "Video · 720p · 8s · x2" or "Nano Banana")
        // To avoid clicking the "Back" button or random header buttons, we must be more specific.
        // Chỉ tìm Settings Chip xung quanh khu vực của submitBtn (để tránh click nhầm vào các video trong danh sách)
        let settingsChip = null;
        if (submitBtn) {
           let parent = submitBtn;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn) return false;
                if (b.offsetParent === null) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                const h = (b.innerHTML || "").toLowerCase();
                // Ưu tiên nút có chứa các thông số cài đặt
                if (t.includes("video") || t.includes("ảnh") || t.includes("image") || t.match(/\b(720p|1080p|4k|giây|fps)\b/i) || t.match(/^\d+s/i)) {
                   return true;
                }
                return false;
             });
             
             if (candidate) {
               settingsChip = candidate;
               break;
             }
           }
           
           // Nếu vẫn không thấy bằng text, chọn một nút bất kỳ cạnh submitBtn không phải là nút "+" hay "add"
           if (!settingsChip) {
              parent = submitBtn;
              for (let i = 0; i < 8 && parent; i++) {
                 parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
                 if (!parent) break;
                 const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
                 const candidate = buttonsHere.find(b => b !== submitBtn && b.offsetParent !== null && !b.innerHTML.toLowerCase().includes("add") && (b.textContent || "").trim() !== "+");
                 if (candidate) {
                   settingsChip = candidate;
                   break;
                 }
              }
           }
        }


        // ──────────────────────────────────────────────
        // STEP 2: Configure Video Settings (Mode, Ratio, Duration, Count, Model)
        // ──────────────────────────────────────────────
        try {
          const targetRatio = cfg?.aspectRatio || "9:16";
          const targetDuration = cfg?.duration || "8s";
          const targetCount = cfg?.count || "x1";

          // Check visibility without offsetParent (fixed/portal elements have offsetParent == null!)
          const isElemVisible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden";
          };

          // Find active popover container
          const getPopover = () => {
            const candidates = queryDeep("div[role='dialog'], div[data-radix-popper-content-wrapper], div[class*='popover'], div");
            return candidates.find(d => {
              if (!isElemVisible(d)) return false;
              const t = d.textContent || "";
              // check if it's actually a dialog containing these options
              return (t.includes("9:16") || t.includes("16:9")) && (t.includes("Video") || t.includes("Hình ảnh") || t.includes("Khung hình")) && d.querySelectorAll("button, [role='tab'], [role='button']").length > 0;
            });
          };

          let popover = getPopover();

          // If not open, click the settings chip to open it
          if (!popover && settingsChip) {
            settingsChip.scrollIntoView({ block: "nearest" });
            settingsChip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            settingsChip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            settingsChip.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
            settingsChip.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            settingsChip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            settingsChip.click();
            await sleep(600); // Wait for popup animation
            popover = getPopover();
          }

          // Click option inside popover
          const clickInsidePopover = async (textMatch) => {
            const scope = popover || document;
            const elements = queryScopeDeep(scope, "[role='tab'], button, [role='button'], div, span").filter(el => isElemVisible(el));

            let match = elements.find(el => {
              const t = (el.textContent || "").trim();
              const aria = (el.getAttribute("aria-label") || "").trim();
              return t === textMatch || aria === textMatch;
            });

            if (!match) {
              match = elements.find(el => {
                const t = (el.textContent || "").trim().toLowerCase();
                const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
                return t.includes(textMatch.toLowerCase()) || aria.includes(textMatch.toLowerCase());
              });
            }

            if (match) {
              const clickable = match.closest("[role='tab'], button, [role='button']") || match;
              clickable.scrollIntoView({ block: "nearest" });
              clickable.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
              clickable.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
              clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
              clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              clickable.click();
              return true;
            }
            return false;
          };

          // Helper to trigger click with pointer + mouse events
          const triggerClick = (el) => {
            if (!el) return false;
            el.scrollIntoView({ block: "nearest" });
            el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            try { el.click(); } catch (_) {}
            return true;
          };

          // 1. Select Mode: "Video" vs "Hình ảnh"
          const modeScope = getPopover() || popover || document;
          const modeButtons = queryScopeDeep(modeScope, "[role='tab'], button, [role='button']").filter(isElemVisible);
          if (cfg?.mode === 'image' || cfg?.mode === 'Hình ảnh') {
            const imageBtn = modeButtons.find(b => {
              const t = (b.textContent || "").trim();
              return t === "Hình ảnh" || t.includes("Hình ảnh") || t.toLowerCase().includes("image");
            });
            if (imageBtn) triggerClick(imageBtn);
            await sleep(400);
          } else {
            const videoBtn = modeButtons.find(b => {
              const t = (b.textContent || "").trim();
              return (t === "Video" || t.includes("Video")) && !t.includes("Hình ảnh") && !t.includes("Khung hình");
            });
            if (videoBtn) triggerClick(videoBtn);
            await sleep(400);
          }

          // 1.1 If Khung hình (Frames / I2V) is requested, click "Khung hình" tab
          if (cfg?.isFrames || cfg?.startImage || cfg?.endImage) {
            const framesScope = getPopover() || popover || document;
            const submodeButtons = queryScopeDeep(framesScope, "[role='tab'], button, [role='button']").filter(isElemVisible);
            const framesBtn = submodeButtons.find(b => {
              const t = (b.textContent || "").trim();
              const id = b.getAttribute("id") || "";
              return t === "Khung hình" || t.includes("Khung hình") || id.endsWith("-trigger-VIDEO_FRAMES") || b.innerHTML.includes("crop_free");
            });
            if (framesBtn) {
              triggerClick(framesBtn);
              await sleep(400);
            }
          }

          // 2. Select Aspect Ratio (9:16 vs 16:9)
          const aspectScope = getPopover() || popover || document;
          const aspectButtons = queryScopeDeep(aspectScope, "[role='tab'], button, [role='button']").filter(isElemVisible);
          const aspectBtn = aspectButtons.find(b => {
            const t = (b.textContent || "").trim();
            const aria = (b.getAttribute("aria-label") || "").trim();
            if (targetRatio === "9:16") {
              return (t.includes("9:16") || aria.includes("9:16")) && !t.includes("16:9");
            } else {
              return (t.includes("16:9") || aria.includes("16:9")) && !t.includes("9:16");
            }
          });
          if (aspectBtn) triggerClick(aspectBtn);
          await sleep(400);

          // If in Video mode, configure Duration, Count & Video Model
          if (cfg?.mode !== 'image' && cfg?.mode !== 'Hình ảnh') {
            // 3. Select Duration: "8s"
            const durScope = getPopover() || popover || document;
            const durButtons = queryScopeDeep(durScope, "[role='tab'], button, [role='button']").filter(isElemVisible);
            const durBtn = durButtons.find(b => {
              const t = (b.textContent || "").trim();
              return (t === targetDuration || t.includes(targetDuration)) && !t.includes("4s") && !t.includes("6s") && !t.includes("10s");
            });
            if (durBtn) triggerClick(durBtn);
            await sleep(400);

            // 4. Select Count: "x1"
            const countScope = getPopover() || popover || document;
            const countButtons = queryScopeDeep(countScope, "[role='tab'], button, [role='button']").filter(isElemVisible);
            const countBtn = countButtons.find(b => {
              const t = (b.textContent || "").trim();
              return (t === targetCount || t.includes(targetCount) || t === "1x") && !t.includes("x2") && !t.includes("x3") && !t.includes("x4");
            });
            if (countBtn) triggerClick(countBtn);
            await sleep(400);

            // 5. Select Model: Veo 3.1 - Lite [Lower Priority]
            const scope = getPopover() || popover || document;
            const modelDropdown = queryScopeDeep(scope, "button, [role='combobox'], [role='button'], div").find(b => {
              if (!isElemVisible(b)) return false;
              const t = (b.textContent || "").trim().toLowerCase();
              const hasPopup = b.hasAttribute("aria-haspopup") || b.getAttribute("role") === "combobox";
              const isModelName = (t.includes("omni") || t.includes("veo") || t.includes("flash") || t.includes("lite") || t.includes("fast") || t.includes("quality")) && t.length < 40;
              const isExcluded = t.includes("9:16") || t.includes("16:9") || t.includes("8s") || t.includes("4s") || t.includes("6s") || t.includes("10s") || t.includes("x1") || t.includes("x2") || t.includes("x3") || t.includes("x4") || t.includes("video") || t.includes("hình ảnh") || t.includes("khung hình") || t.includes("thành phần") || t.includes("360p") || t.includes("720p");
              return (hasPopup || isModelName) && !isExcluded;
            });

            if (modelDropdown) {
              triggerClick(modelDropdown);
              await sleep(600);

              // Look for exact option across document root (Radix Portal)
              for (let attempt = 0; attempt < 20; attempt++) {
                await sleep(100);
                const candidates = queryDeep("[role='option'], [role='menuitem'], button, div, span, li").filter(el => isElemVisible(el));
                const targetOpt = candidates.find(el => {
                  const ot = (el.textContent || "").toLowerCase();
                  const matches = ot.includes("lower priority") || ot.includes("lite [lower priority]") || ot.includes("ưu tiên thấp");
                  // Exclude parent wrapper/containers that contain other option names
                  const isContainer = ot.includes("omni") || ot.includes("quality") || ot.includes("fast") || ot.length > 55;
                  return matches && !isContainer;
                });

                if (targetOpt) {
                  const clickable = targetOpt.closest("[role='option'], [role='menuitem'], button, li") || targetOpt;
                  triggerClick(clickable);
                  await sleep(500);
                  break;
                }
              }
            }
          }

          // 6. Close popup gracefully and focus editor
          await sleep(300);
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
          await sleep(300);

          // Click editor to guarantee outside-click dismissal of popover and gain focus
          try {
            editor.click();
            editor.focus();
          } catch (_) {}
          await sleep(300);

          // ──────────────────────────────────────────────
          // STEP 2.5: Attach Start / End Frames if in Khung Hình Mode
          // ──────────────────────────────────────────────
          if (cfg?.isFrames || cfg?.startImage || cfg?.endImage) {
            try {
              await sleep(500); // Allow frame slots to mount on editor

              // Locate frame slot buttons (Start: Bắt đầu, End: Kết thúc)
              // Locate frame slot buttons (Start: Bắt đầu, End: Kết thúc)
              const getFrameSlots = () => {
                let slots = Array.from(document.querySelectorAll("button, [role='button'], div[aria-haspopup='dialog']"))
                  .filter(el => {
                    if (!isElemVisible(el)) return false;
                    const t = (el.textContent || "").toLowerCase();
                    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
                    return t.includes("bắt đầu") || t.includes("kết thúc") 
                        || aria.includes("bắt đầu") || aria.includes("kết thúc")
                        || t.includes("start frame") || t.includes("end frame")
                        || aria.includes("start frame") || aria.includes("end frame")
                        || t === "start" || t === "end";
                  });
                if (!slots.length) {
                  const promptContainer = document.querySelector("form") || document.querySelector("div[class*='prompt']") || document;
                  slots = Array.from(promptContainer.querySelectorAll("button[aria-haspopup='dialog'], [role='button'][aria-haspopup='dialog'], div[type='button'][aria-haspopup='dialog']"))
                    .filter(isElemVisible);
                }
                return slots;
              };

              // Helper to pick/upload inside the media asset picker dialog
              const handleMediaDialog = async (imageQuery, preferIndex = 0) => {
                await sleep(600); // Wait for Radix dialog to open
                let dialog = queryDeep("div[role='dialog'][data-state='open']")[0] || queryDeep("div[role='dialog']")[0];
                if (!dialog) {
                  for (let waitDlg = 0; waitDlg < 6; waitDlg++) {
                    await sleep(250);
                    dialog = document.querySelector("div[role='dialog'][data-state='open']") || document.querySelector("div[role='dialog']");
                    if (dialog) break;
                  }
                }
                if (!dialog) return false;

                const cleanQuery = String(imageQuery || "").trim();
                const cleanLower = cleanQuery.toLowerCase();

                // Check if user specified numeric index or special keywords: "1", "ảnh 1", "top 1", "mới nhất"
                const isUuid = /^[a-f0-9\-]{36}$/i.test(cleanQuery);
                const isFirst = cleanQuery === "1" || cleanLower === "ảnh 1" || cleanLower === "top 1" || cleanLower === "mới nhất" || cleanLower === "latest" || cleanLower === "first";
                const isSecond = cleanQuery === "2" || cleanLower === "ảnh 2" || cleanLower === "top 2";
                const numMatch = cleanQuery.match(/^(\d+)$/);

                // Helper to get selectable tiles/options in dialog
                const getTiles = () => {
                  let list = queryScopeDeep(dialog, "[role='option'], [role='gridcell'], div[data-tile-id]")
                    .filter(isElemVisible);
                  if (!list.length) {
                    const imgs = queryScopeDeep(dialog, "img").filter(isElemVisible);
                    list = imgs.map(img => img.closest("button, [role='button'], [role='option'], [role='gridcell'], div[tabindex]")).filter(Boolean);
                  }
                  return list;
                };

                // Check if base64 file upload
                if (cleanQuery.startsWith("data:image")) {
                  const fileInput = queryScopeDeep(dialog, "input[type='file']")[0] || queryDeep("input[type='file']")[0];
                  if (fileInput) {
                    try {
                      const arr = cleanQuery.split(',');
                      const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
                      const bstr = atob(arr[1] || arr[0]);
                      let n = bstr.length;
                      const u8arr = new Uint8Array(n);
                      while (n--) u8arr[n] = bstr.charCodeAt(n);
                      const fileObj = new File([u8arr], "frame_" + Date.now() + ".jpg", { type: mime });
                      const dt = new DataTransfer();
                      dt.items.add(fileObj);
                      fileInput.files = dt.files;
                      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
                      await sleep(2500); // Wait upload to complete
                    } catch (e) {
                      console.warn("[Flow] File upload error:", e);
                    }
                  }
                } else if (isFirst || (!cleanQuery && preferIndex === 0)) {
                  // Direct 1st / newest item: DO NOT search, click 1st tile directly!
                  await sleep(400);
                  const tiles = getTiles();
                  if (tiles.length) {
                    triggerClick(tiles[0]);
                    await sleep(500);
                  }
                } else if (isSecond || (!cleanQuery && preferIndex === 1)) {
                  // Direct 2nd item: DO NOT search, click 2nd tile directly!
                  await sleep(400);
                  const tiles = getTiles();
                  if (tiles.length > 1) {
                    triggerClick(tiles[1]);
                    await sleep(500);
                  } else if (tiles.length) {
                    triggerClick(tiles[0]);
                    await sleep(500);
                  }
                } else if (numMatch && parseInt(numMatch[1], 10) > 0) {
                  // Direct N-th item
                  const idx = parseInt(numMatch[1], 10) - 1;
                  await sleep(400);
                  const tiles = getTiles();
                  if (tiles.length > idx) {
                    triggerClick(tiles[idx]);
                    await sleep(500);
                  } else if (tiles.length) {
                    triggerClick(tiles[0]);
                    await sleep(500);
                  }
                } else if (isUuid) {
                  // Direct Media ID (ảnh vừa upload): tìm theo tile ID/outerHTML nếu có, nếu không fallback theo preferIndex
                  await sleep(400);
                  const tiles = getTiles();
                  let targetTile = tiles.find(t => {
                    const id = (t.getAttribute("data-tile-id") || t.getAttribute("id") || t.getAttribute("data-media-id") || "").toLowerCase();
                    const html = (t.outerHTML || "").toLowerCase();
                    return id.includes(cleanLower) || html.includes(cleanLower);
                  });
                  if (!targetTile) {
                    targetTile = (tiles.length > preferIndex ? tiles[preferIndex] : (tiles.length > 0 ? tiles[0] : null));
                  }
                  if (targetTile) {
                    console.log(`[Flow Recon] Selected tile index ${tiles.indexOf(targetTile)} (prefer: ${preferIndex}) for UUID: ${cleanQuery}`);
                    triggerClick(targetTile);
                    await sleep(600);
                  }
                } else {
                  // Search by filename (e.g. 2.jpg), AI caption or Media ID
                  const searchInput = dialog.querySelector("#add-menu-input") 
                                   || dialog.querySelector("input[placeholder*='Tìm kiếm' i]")
                                   || dialog.querySelector("input[type='text']");
                  if (searchInput) {
                    searchInput.focus();
                    searchInput.value = cleanQuery;
                    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
                    searchInput.dispatchEvent(new Event("change", { bubbles: true }));
                    await sleep(700);
                  }

                  let tiles = getTiles();
                  let targetTile = tiles.find(t => {
                    const txt = (t.textContent || "").toLowerCase();
                    const id = (t.getAttribute("data-tile-id") || t.getAttribute("id") || t.getAttribute("data-media-id") || "").toLowerCase();
                    const html = (t.outerHTML || "").toLowerCase();
                    return txt.includes(cleanLower) || txt.includes(cleanLower.slice(0, 10)) || id.includes(cleanLower) || html.includes(cleanLower);
                  });

                  // IF search gave 0 results:
                  if (!targetTile) {
                    console.warn(`[Flow Recon] Search "${cleanQuery}" returned 0 matches, clearing search and picking asset at index ${preferIndex}...`);
                    if (searchInput) {
                      searchInput.value = "";
                      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
                      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
                      await sleep(500);
                    }
                    tiles = getTiles();
                    targetTile = (tiles.length > preferIndex ? tiles[preferIndex] : (tiles.length > 0 ? tiles[0] : null));
                  }

                  if (targetTile) {
                    triggerClick(targetTile);
                    await sleep(600);
                  }
                }

                // Check if "Include" button is needed
                const openDialog = document.querySelector("div[role='dialog'][data-state='open']");
                if (openDialog) {
                  const addBtn = queryScopeDeep(openDialog, "button").find(b => {
                    const t = (b.textContent || "").toLowerCase();
                    return t.includes("thêm") || t.includes("add") || t.includes("chọn") || t.includes("áp dụng");
                  });
                  if (addBtn) {
                    triggerClick(addBtn);
                    await sleep(500);
                  }
                }

                // Ensure dialog is closed before moving to next slot
                for (let waitClose = 0; waitClose < 10; waitClose++) {
                  const stillOpen = document.querySelector("div[role='dialog'][data-state='open']");
                  if (!stillOpen) break;
                  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
                  await sleep(200);
                }
                return true;
              };

              // 1. Attach Start Image (Bắt đầu)
              if (cfg?.startImage) {
                const slots = getFrameSlots();
                let startSlot = slots.find(s => {
                  const t = (s.textContent || "").toLowerCase();
                  const aria = (s.getAttribute("aria-label") || "").toLowerCase();
                  return (t.includes("bắt đầu") || aria.includes("bắt đầu") || t.includes("start")) && !t.includes("kết thúc") && !aria.includes("kết thúc");
                }) || slots[0];
                if (startSlot) {
                  console.log("[Flow Extension] Found Start frame slot, clicking...", startSlot);
                  triggerClick(startSlot);
                  const startIndex = (cfg?.startImage && cfg?.endImage) ? (cfg.startIndex ?? 1) : (cfg.startIndex ?? 0);
                  await handleMediaDialog(cfg.startImage, startIndex);
                  await sleep(800);
                }
              }

              // 2. Attach End Image (Kết thúc)
              if (cfg?.endImage) {
                await sleep(400);
                const slots = getFrameSlots();
                let endSlot = slots.find(s => {
                  const t = (s.textContent || "").toLowerCase();
                  const aria = (s.getAttribute("aria-label") || "").toLowerCase();
                  return (t.includes("kết thúc") || aria.includes("kết thúc") || t.includes("end")) && !t.includes("bắt đầu") && !aria.includes("bắt đầu");
                });
                if (!endSlot && slots.length > 1) {
                  endSlot = slots[slots.length - 1];
                }
                if (!endSlot) {
                  const allBtns = Array.from(document.querySelectorAll("button, [role='button'], div[type='button']")).filter(isElemVisible);
                  endSlot = allBtns.find(s => {
                    const t = (s.textContent || "").toLowerCase();
                    const aria = (s.getAttribute("aria-label") || "").toLowerCase();
                    return (t.includes("kết thúc") || aria.includes("kết thúc") || t.includes("end frame")) && !t.includes("bắt đầu");
                  });
                }
                if (endSlot) {
                  console.log("[Flow Extension] Found End frame slot, clicking...", endSlot);
                  triggerClick(endSlot);
                  const endIndex = cfg.endIndex ?? 0;
                  await handleMediaDialog(cfg.endImage, endIndex);
                  await sleep(800);
                }
              }
            } catch (frameErr) {
              console.warn("[Flow Extension] Frame attach error:", frameErr);
            }
          }
        } catch (confErr) {
          console.warn("[Flow Extension] Config error:", confErr);
        }

        // ──────────────────────────────────────────────
        // STEP 3: Clear Editor & Focus
        // ──────────────────────────────────────────────
        editor.focus();
        await sleep(100);

        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        await sleep(100);
        editor.focus();

        return { success: true, message: "Đã cấu hình và làm sạch ô nhập!" };
      }
    });

// Kiểm tra lỗi từ executeScript
    if (results && results[0] && results[0].result && results[0].result.success === false) {
      logToBridge(`[Flow Recon] ⚠️ Lỗi UI: ${results[0].result.error}`);
      return { success: false, error: results[0].result.error };
    }

    // ──────────────────────────────────────────────
    // STEP 4: Native Hardware Typing & Enter via CDP (chrome.debugger)
    // ──────────────────────────────────────────────
    if (chrome.debugger) {
      try {
        await chrome.debugger.attach({ tabId: tab.id }, "1.3");
        
        // Single native insertText into focused editor
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", { text: prompt });
        await new Promise(r => setTimeout(r, 400));

        // Trusted Hardware Enter (pure keypress WITHOUT \r text so it submits instead of inserting newline!)
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
        await new Promise(r => setTimeout(r, 60));
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });

        // Also trigger submit button click if it's enabled as extra safety
        await new Promise(r => setTimeout(r, 400));
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              const walk = (node, matches) => {
                if (node.shadowRoot) walk(node.shadowRoot, matches);
                for (const child of node.children) {
                  walk(child, matches);
                  if (child.tagName === 'BUTTON' || child.getAttribute('role') === 'button') matches.push(child);
                }
              };
              const allBtns = [];
              walk(document.body, allBtns);

              for (const btn of allBtns) {
                const inner = (btn.innerHTML || "").toLowerCase();
                const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
                const title = (btn.getAttribute("title") || "").toLowerCase();
                let match = inner.includes("arrow_forward") || inner.includes("send") || aria.includes("submit") || aria.includes("generate") || aria.includes("tạo") || title.includes("generate") || inner.includes("magic");
                if (!match) {
                  for (const el of btn.querySelectorAll("*")) {
                    const t = (el.textContent || "").trim();
                    if (t === "arrow_forward" || t === "send" || t === "Generate" || t === "Tạo") {
                      match = true;
                      break;
                    }
                  }
                }
                if (match) {
                  btn.removeAttribute("disabled");
                  btn.click();
                  break;
                }
              }
            }
          });
        } catch (_) {}

        await chrome.debugger.detach({ tabId: tab.id });
      } catch (dbgErr) {
        console.warn("[Flow Extension] Debugger CDP fallback:", dbgErr);
        try { await chrome.debugger.detach({ tabId: tab.id }); } catch (_) {}
      }
    }

    // ──────────────────────────────────────────────
    // RECON STEP B: Snapshot Library Videos AFTER Click & Identify New Video
    // ──────────────────────────────────────────────
    let newVideo = null;
    if (effectiveProjectId) {
      logToBridge(`[Flow Recon] Bắt đầu theo dõi thư viện project ${effectiveProjectId.slice(0, 8)}...`);
      for (let attempt = 1; attempt <= 10; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 1 ? 2500 : 1500));
        try {
          const afterData = await getProjectVideos(effectiveProjectId);
          if (afterData?.success) {
            const allMedia = [
              ...(afterData.videos || []),
              ...(afterData.images || []),
              ...(afterData.workflows || [])
            ];
            // Find any media in afterData not present in beforeIds
            const diff = allMedia.filter(v => (v.mediaId && !beforeIds.has(v.mediaId)) || (v.workflowId && !beforeIds.has(v.workflowId)));
            if (diff.length > 0) {
              newVideo = diff.find(v => (v.prompt || "").toLowerCase().includes(prompt.slice(0, 15).toLowerCase())) || diff[0];
              const foundId = newVideo.mediaId || newVideo.workflowId;
              logToBridge(`[Flow Recon] Lần ${attempt}: Phát hiện media mới vừa tạo! ID: ${foundId}`);
              break;
            } else if (allMedia.length > beforeCount) {
              newVideo = allMedia[0];
              const foundId = newVideo.mediaId || newVideo.workflowId;
              logToBridge(`[Flow Recon] Lần ${attempt}: Số lượng media tăng (+${allMedia.length - beforeCount}), chọn: ${foundId}`);
              break;
            } else if (attempt % 3 === 0) {
              logToBridge(`[Flow Recon] Lần ${attempt}: Chưa thấy media mới xuất hiện (hiện có ${allMedia.length} items)...`);
            }
          } else {
            logToBridge(`[Flow Recon] Lần ${attempt} getProjectVideos trả về: ${afterData?.error || 'Không thành công'}`);
          }
        } catch (err) {
          console.warn(`[Flow Recon] Attempt ${attempt} fetch error:`, err);
        }
      }

      if (!newVideo) {
        logToBridge(`[Flow Recon] ⚠️ Không phát hiện media mới nào sau khi submit trên Flow`);
      }
    }

    if (newVideo) {
      const finalMediaId = newVideo.mediaId || newVideo.workflowId;
      return {
        success: true,
        message: `Đã tạo media mới: [${finalMediaId?.slice(0, 8)}...]`,
        newVideo: {
          mediaId: finalMediaId,
          workflowId: newVideo.workflowId || finalMediaId,
          prompt: newVideo.prompt,
          status: newVideo.status,
          model: newVideo.model,
          projectId: effectiveProjectId
        }
      };
    }

    return results?.[0]?.result || { success: true, message: "Đã thực thi click UI", newVideo: null };
  } catch (err) {
    return { success: false, error: "Lỗi tương tác UI: " + err.message };
  }
}

// ══════════════════════════════════════
// 4. Delete / Archive Video
// ══════════════════════════════════════
async function deleteVideo(workflowId, projectId, mediaId) {
  if (!projectId) return { success: false, error: "Thiếu projectId" };
  const targetId = workflowId || mediaId;
  if (!targetId) return { success: false, error: "Thiếu workflowId / mediaId để xoá" };

  const flowTab = await getFlowTab('video', projectId);
  if (!flowTab) return { success: false, error: "Cần mở tab Google Flow!" };

  // Get captured auth token
  let authToken = null;
  try {
    const authResults = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      func: () => JSON.stringify({ token: window.__flowAuth || null })
    });
    const authData = JSON.parse(authResults?.[0]?.result || "{}");
    authToken = authData.token;
  } catch (e) {
    console.error("❌ Auth read error:", e);
  }

  if (!authToken) return { success: false, error: "Chưa bắt được Auth token từ tab Flow. Hãy F5 lại tab Flow!" };

  console.log(`🗑️ Deleting workflow ${targetId} in project ${projectId}...`);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      args: [targetId, projectId, authToken],
      func: async (wfId, pId, auth) => {
        try {
          const res = await fetch(`https://aisandbox-pa.googleapis.com/v1/flowWorkflows/${wfId}`, {
            method: "PATCH",
            credentials: "include",
            headers: {
              "Content-Type": "text/plain;charset=UTF-8",
              "Authorization": auth
            },
            body: JSON.stringify({
              workflow: {
                name: wfId,
                projectId: pId,
                metadata: { archived: true }
              },
              updateMask: "metadata.archived"
            })
          });
          const txt = await res.text();
          if (!res.ok) return JSON.stringify({ error: "API " + res.status, body: txt.slice(0, 300) });
          return JSON.stringify({ ok: true, data: txt });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      }
    });

    const raw = results?.[0]?.result;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed?.error) return { success: false, error: parsed.error, detail: parsed.body };

    // Store in deleted list to filter out immediately
    try {
      const s = await chrome.storage.local.get("deletedWorkflowIds");
      const list = s.deletedWorkflowIds || [];
      if (workflowId && !list.includes(workflowId)) list.push(workflowId);
      if (mediaId && !list.includes(mediaId)) list.push(mediaId);
      await chrome.storage.local.set({ deletedWorkflowIds: list });
    } catch {}

    return { success: true, message: "Đã xoá video thành công!" };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════════
// 5. Upload Image to Flow (from URL or Base64)
// ══════════════════════════════════════
async function uploadImage(projectId, imageUrl, imageBase64, shouldReload = true, isRetry = false, tabType = 'video') {
  if (!projectId) return { success: false, error: "Thiếu projectId" };
  if (!imageUrl && !imageBase64) return { success: false, error: "Thiếu link ảnh hoặc dữ liệu ảnh" };

  let b64 = imageBase64;
  if (imageUrl && !b64) {
    try {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) return { success: false, error: `Không thể tải ảnh từ URL: HTTP ${imgRes.status}` };
      const blob = await imgRes.blob();
      const buf = await blob.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < u8.byteLength; i++) binary += String.fromCharCode(u8[i]);
      b64 = btoa(binary);
    } catch (e) {
      return { success: false, error: "Lỗi tải ảnh từ URL: " + e.message };
    }
  }

  if (b64 && b64.includes(",")) b64 = b64.split(",")[1];

  let flowTab = await getFlowTab(tabType, projectId);
  if (!flowTab) {
    flowTab = await getFlowTab('video', projectId) || await getFlowTab('image', projectId);
  }
  if (!flowTab) return { success: false, error: `Cần mở tab Google Flow cho ${tabType === 'video' ? 'Video' : 'Ảnh'}!` };

  // Ưu tiên Project ID từ URL của tab đang mở để upload chính xác vào project trên màn hình
  let effectiveProjectId = null;
  if (flowTab.url) {
    const urlMatch = flowTab.url.match(/project\/([a-f0-9\-]{36})/i);
    if (urlMatch && urlMatch[1]) {
      effectiveProjectId = urlMatch[1];
    }
  }
  if (!effectiveProjectId) {
    effectiveProjectId = projectId;
  }

  // ── Lấy token còn hạn (< 50 phút). Nếu chưa có hoặc đã hết hạn -> Tự động F5 tab để bắt token mới! ──
  let authToken = await getFreshAuthToken(flowTab);
  if (!authToken) {
    authToken = await refreshAuthByReloadingTab(flowTab, tabType === 'video' ? 'Tab Video' : 'Tab Tạo Ảnh');
  }

  if (!authToken) return { success: false, error: "Chưa bắt được Auth token từ tab Flow dù đã F5. Hãy kiểm tra tab Flow đã đăng nhập!" };

  try {
    const safeAuth = authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`;
    const results = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      args: [effectiveProjectId, b64, safeAuth],
      func: async (pId, b64Data, auth) => {
        try {
          const res = await fetch("https://aisandbox-pa.googleapis.com/v1/flow/uploadImage", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "text/plain;charset=UTF-8",
              "Authorization": auth
            },
            body: JSON.stringify({
              clientContext: { projectId: pId, tool: "PINHOLE" },
              imageBytes: b64Data
            })
          });
          const txt = await res.text();
          if (!res.ok) return JSON.stringify({ error: "Upload API " + res.status, status: res.status, body: txt });

          return txt;
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      }
    });

    const raw = results?.[0]?.result;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

    // ── XỬ LÝ LỖI 401: TỰ ĐỘNG XÓA TOKEN CŨ CỦA TAB NÀY, F5 TAB LẤY TOKEN MỚI VÀ RETRY 1 LẦN ──
    if (parsed?.error && (parsed.status === 401 || String(parsed.error).includes("401")) && !isRetry) {
      logToBridge(`[Upload Engine] ⚠️ Phát hiện lỗi 401 (Token hết hạn trên tab ${flowTab.id}), đang tự động lấy token mới và upload lại...`);
      await invalidateAuthToken(flowTab);
      await refreshAuthByReloadingTab(flowTab, tabType === 'video' ? 'Tab Video' : 'Tab Tạo Ảnh');
      return await uploadImage(projectId, imageUrl, b64, shouldReload, true, tabType);
    }

    if (parsed?.error) return { success: false, error: parsed.error, detail: parsed.body };

    const mediaId = parsed?.media?.name;
    if (shouldReload) {
      // Reload Flow tab so newly uploaded frames appear on Flow's UI immediately (dùng cho Video!)
      try {
        await chrome.tabs.reload(flowTab.id);
        await new Promise(r => setTimeout(r, 2000));
      } catch (reloadErr) {
        console.warn("[Flow Extension] Error reloading Flow tab:", reloadErr);
      }
    }

    return {
      success: true,
      mediaId,
      width: parsed?.media?.image?.dimensions?.width,
      height: parsed?.media?.image?.dimensions?.height,
      message: shouldReload ? "Đã tải ảnh lên Flow và reload lại trang Flow!" : "Đã tải ảnh lên Flow thành công!"
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function renameWorkflowToUuid(projectId, mediaId) {
  if (!projectId || !mediaId) return { success: false, error: "Thiếu projectId hoặc mediaId" };
  const flowTab = await getFlowTab('video', projectId);
  if (!flowTab) return { success: false, error: "Không tìm thấy tab Flow" };

  // Get project data to find the workflowId for this mediaId
  const pData = await getProjectVideos(projectId);
  let wfId = null;
  if (pData?.success && Array.isArray(pData.images)) {
    const target = pData.images.find(img => img.mediaId === mediaId);
    if (target?.workflowId) wfId = target.workflowId;
  }
  if (!wfId) wfId = mediaId; // fallback

  let authToken = await getFreshAuthToken(flowTab);
  if (!authToken) return { success: false, error: "Chưa có auth token từ tab Flow!" };

  const res = await chrome.scripting.executeScript({
    target: { tabId: flowTab.id },
    world: "MAIN",
    args: [wfId, projectId, mediaId, authToken],
    func: async (wId, pId, mId, auth) => {
      try {
        const patchRes = await fetch(`https://aisandbox-pa.googleapis.com/v1/flowWorkflows/${wId}`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            "Authorization": auth
          },
          body: JSON.stringify({
            workflow: {
              name: wId,
              projectId: pId,
              metadata: { displayName: mId }
            },
            updateMask: "metadata.displayName"
          })
        });
        const txt = await patchRes.text();
        return JSON.stringify({ ok: patchRes.ok, status: patchRes.status, body: txt.slice(0, 300) });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
  });

  const raw = res?.[0]?.result;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (parsed && !parsed.ok) {
    return { success: false, error: `Lỗi PATCH (${parsed.status}): ${parsed.body}` };
  }

  // Reload Flow tab so the renamed asset updates in Flow's UI immediately!
  try {
    await chrome.tabs.reload(flowTab.id);
  } catch (_) {}

  return { success: true, message: `Đã đổi tên ảnh trên Flow thành UUID: ${mediaId}` };
}

// ══════════════════════════════════════
// 6. Create Image (Text-to-Image & Image-to-Image)
// ══════════════════════════════════════
async function createImageAPI(prompt, projectId, model, aspectRatio, referenceImage, isRetry = false) {
  if (!prompt && !referenceImage) return { success: false, error: "Thiếu prompt hoặc ảnh tham chiếu" };

  const flowTab = await getFlowTab('image', projectId);
  if (!flowTab) return { success: false, error: "Cần mở ít nhất một tab Google Flow cho Tạo Ảnh!" };

  logToBridge(`[Image Engine] Sử dụng Tab Ảnh (ID: ${flowTab.id}) để gọi API...`);

  // Ưu tiên Project ID từ tab Flow đang mở để đồng bộ tuyệt đối với session của browser
  let effectiveProjectId = null;
  if (flowTab.url) {
    const urlMatch = flowTab.url.match(/project\/([a-f0-9\-]{36})/i);
    if (urlMatch && urlMatch[1]) {
      effectiveProjectId = urlMatch[1];
    }
  }
  if (!effectiveProjectId) {
    effectiveProjectId = projectId;
  }
  if (!effectiveProjectId) return { success: false, error: "Thiếu projectId" };

  const modelName = model || "NARWHAL";
  const aspectKey = aspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE";

  // Auto-upload referenceImage if it is a URL or Base64
  let refMediaId = referenceImage;
  const isBase64 = referenceImage && (referenceImage.startsWith("data:") || referenceImage.length > 500);
  const isUrl = referenceImage && (referenceImage.startsWith("http://") || referenceImage.startsWith("https://"));

  if (isUrl || isBase64) {
    logToBridge(`[Image Engine] Tải ảnh tham chiếu lên Google Flow (project ${effectiveProjectId.slice(0, 8)})...`);
    const upRes = await uploadImage(effectiveProjectId, isUrl ? referenceImage : null, isBase64 ? referenceImage : null, false);
    if (!upRes?.success || !upRes?.mediaId) {
      logToBridge(`[Image Engine] ⚠️ Lỗi tải ảnh tham chiếu: ${upRes?.error || 'Không có mediaId'}`);
      return { success: false, error: "Lỗi tải ảnh tham chiếu: " + (upRes?.error || 'Upload không thành công') };
    }
    refMediaId = upRes.mediaId;
    logToBridge(`[Image Engine] ✅ Ảnh tham chiếu đã tải lên thành công, Media ID: ${refMediaId}. Đợi 2s để Google Flow xử lý ảnh...`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Get captured auth token (< 50 phút). Nếu chưa có hoặc đã hết hạn -> Tự động F5 tab để bắt token mới!
  let authToken = await getFreshAuthToken(flowTab);
  if (!authToken) {
    authToken = await refreshAuthByReloadingTab(flowTab, 'Tab Tạo Ảnh');
  }

  if (!authToken) return { success: false, error: "Chưa bắt được Auth token từ tab Flow. Hãy kiểm tra tab Flow đã đăng nhập!" };

  const safePrompt = String(prompt || "");
  const safePid = String(effectiveProjectId || "");
  const safeModel = String(modelName || "NARWHAL");
  const safeAuth = String(authToken || "");
  const safeAspect = String(aspectKey || "IMAGE_ASPECT_RATIO_SQUARE");
  const safeRefImg = refMediaId ? String(refMediaId) : null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      args: [safePrompt, safePid, safeModel, safeAuth, safeAspect, safeRefImg],
      func: async (pt, pid, mk, auth, aspect, refImg) => {
        try {
          const ss = document.querySelectorAll('script[src*="recaptcha/enterprise.js"]');
          let sk = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
          for (const s of ss) {
            const m = (s.getAttribute("src") || "").match(/[?&]render=([^&]+)/);
            if (m && m[1]) { sk = m[1]; break; }
          }

          let tok = "";
          try {
            if (typeof grecaptcha !== "undefined" && grecaptcha?.enterprise) {
              tok = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Timeout chờ reCAPTCHA")), 12000);
                grecaptcha.enterprise.ready(() => {
                  grecaptcha.enterprise.execute(sk, { action: "IMAGE_GENERATION" })
                    .then(t => { clearTimeout(timer); resolve(t); })
                    .catch(err => { clearTimeout(timer); reject(err); });
                });
              });
            } else {
              return JSON.stringify({ error: "grecaptcha.enterprise chưa được tải trên tab Flow" });
            }
          } catch (e) {
            return JSON.stringify({ error: "Lỗi reCAPTCHA: " + (e.message || String(e)) });
          }

          if (!tok) {
            return JSON.stringify({ error: "Không lấy được token reCAPTCHA hợp lệ" });
          }

          const clientContext = {
            projectId: pid,
            tool: "PINHOLE",
            sessionId: ";" + Date.now(),
            recaptchaContext: {
              token: tok,
              applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB"
            }
          };

          const imageInputs = [];
          if (refImg) {
            imageInputs.push({
              imageInputType: "IMAGE_INPUT_TYPE_REFERENCE",
              name: refImg
            });
          }

          const requestItem = {
            clientContext: clientContext,
            imageModelName: mk || "NARWHAL",
            imageAspectRatio: aspect || "IMAGE_ASPECT_RATIO_LANDSCAPE",
            structuredPrompt: { parts: [{ text: pt || "" }] },
            seed: Math.floor(Math.random() * 999999),
            imageInputs: imageInputs
          };

          const url = `https://aisandbox-pa.googleapis.com/v1/projects/${pid}/flowMedia:batchGenerateImages`;
          const headers = {
            "Content-Type": "text/plain;charset=UTF-8"
          };
          if (auth) {
            headers["Authorization"] = auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;
          }

          let r = null;
          let lastErr = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              if (attempt > 1) {
                await new Promise(res => setTimeout(res, 2000));
              }
              r = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: headers,
                body: JSON.stringify({
                  clientContext: clientContext,
                  mediaGenerationContext: { batchId: crypto.randomUUID() },
                  useNewMedia: true,
                  requests: [requestItem]
                })
              });
              if (r.ok) break;
            } catch (fetchErr) {
              lastErr = fetchErr;
            }
          }

          if (!r) {
            return JSON.stringify({
              error: lastErr?.message || "Failed to fetch",
              detail: `fetch(${url}) thất bại sau 2 lần thử (refImg: ${refImg})`,
              url: url
            });
          }

          const txt = await r.text();
          console.log("🎨 Image API:", r.status, txt.slice(0, 300));
          if (!r.ok) return JSON.stringify({ error: "API " + r.status, status: r.status, body: txt.slice(0, 500) });
          return txt || "{}";
        } catch (e) {
          return JSON.stringify({ error: e.message || String(e), stack: e.stack, url: typeof url !== "undefined" ? url : "" });
        }
      }
    });

    const raw = results?.[0]?.result;
    console.log("📦 Image Result:", raw);
    if (!raw) return { success: false, error: "Response rỗng từ tab Flow" };
    let p; try { p = JSON.parse(raw); } catch { p = raw; }

    // ── XỬ LÝ LỖI 401: TỰ ĐỘNG XÓA TOKEN CŨ CỦA TAB NÀY, F5 TAB LẤY TOKEN MỚI VÀ RETRY 1 LẦN ──
    if (p?.error && (p.status === 401 || String(p.error).includes("401")) && !isRetry) {
      logToBridge(`[Image Engine] ⚠️ Phát hiện lỗi 401 (Token hết hạn trên tab ${flowTab.id}), đang tự động lấy token mới...`);
      await invalidateAuthToken(flowTab);
      await refreshAuthByReloadingTab(flowTab, 'Tab Tạo Ảnh');
      return await createImageAPI(prompt, projectId, model, aspectRatio, referenceImage, true);
    }

    if (p?.error) return { success: false, error: p.error, detail: p.body };

    const mediaList = p?.media || [];
    const mediaItem = mediaList[0] || {};
    const mediaId = mediaItem?.name || null;
    let fifeUrl = mediaItem?.image?.generatedImage?.fifeUrl || mediaItem?.image?.fifeUrl || mediaItem?.playbackUrl || null;
    if (!fifeUrl && mediaId) {
      fifeUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}`;
    }

    return {
      success: true,
      message: "✅ Đã tạo ảnh thành công!",
      mediaId: mediaId,
      imageUrl: fifeUrl,
      apiResponse: p
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════════
// 7. TTS Audio Generation Engine (AI Dancing Voice Clone)
// ══════════════════════════════════════
const AUDIO_BASE_URL = "https://audio.aidancing.net";

async function getTTSVoices(lang = "vi") {
  try {
    const res = await fetch(`${AUDIO_BASE_URL}/voice-demo/${lang || 'vi'}.txt`);
    if (!res.ok) return { success: false, error: "Lỗi tải danh sách giọng đọc: " + res.status };
    const text = await res.text();
    const voices = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map((line, idx) => {
        const sep = line.indexOf('|');
        if (sep === -1) return { name: line, voiceIndex: idx };
        return { name: line.substring(0, sep).trim(), url: line.substring(sep + 1).trim() || null, voiceIndex: idx };
      });
    return { success: true, voices };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function generateTTSAudio(text, lang = "vi", voiceIndex = 0) {
  if (!text || !text.trim()) return { success: false, error: "Thiếu nội dung thuyết minh" };

  try {
    // 1. Tạo Job TTS
    const createRes = await fetch(`${AUDIO_BASE_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        text: text.trim(),
        lang: lang || "vi",
        voiceIndex: Number(voiceIndex) || 0
      })
    });

    const createJson = await createRes.json();
    const jobUid = createJson?.jobUid;
    if (!jobUid) throw new Error("Không lấy được jobUid từ Audio Server: " + JSON.stringify(createJson));

    // 2. Kích hoạt chạy Job
    await fetch(`${AUDIO_BASE_URL}/jobs/${jobUid}/start`, {
      method: "POST",
      headers: { "Accept": "application/json" }
    });

    // 3. Polling chờ hoàn tất (tối đa 45 giây)
    let audioUrl = null;
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 1500));
      attempts++;

      const listRes = await fetch(`${AUDIO_BASE_URL}/jobs`, { headers: { "Accept": "application/json" } });
      if (listRes.ok) {
        const jobs = await listRes.json();
        if (Array.isArray(jobs)) {
          const match = jobs.find(j => j.jobUid === jobUid || j.uid === jobUid);
          if (match) {
            if (match.status === "DONE" || match.outputUrl) {
              audioUrl = match.outputUrl.startsWith("http") ? match.outputUrl : `${AUDIO_BASE_URL}${match.outputUrl}`;
              break;
            } else if (match.status === "ERROR" || match.status === "FAILED") {
              throw new Error("Lỗi sinh audio: " + (match.error || "Generation Failed"));
            }
          }
        }
      }
    }

    if (!audioUrl) throw new Error("Hết thời gian chờ sinh audio (Timeout)");

    return {
      success: true,
      jobUid,
      audioUrl,
      message: "✅ Đã tạo file audio giọng đọc thành công!"
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ══════════════════════════════════════
// 8. Gemini / OpenAI Dynamic Storyline & Prompt Generator
// ══════════════════════════════════════
async function generateAIScriptDynamic(topic, totalScenes = 40, totalMinutes = 10, lang = "vi", geminiApiKey = null) {
  const isEn = lang === "en";
  const totalSec = totalMinutes * 60;
  const avgSec = Math.max(3, Math.round((totalSec / totalScenes) * 10) / 10);
  const targetWords = Math.max(8, Math.round((avgSec - 1) * 2.4));

  const diversitySeed = Math.floor(Math.random() * 1000000);
  const promptText = `You are a world-class Financial Educator & Master Storyteller in the exact style of "Master Financial Literacy in 62 Minutes" by Alicia Invests (Clean Minimalist 2D Vector Motion Graphics).
Topic: "${topic}"
Random Unique Episode Seed: #${diversitySeed}

STRICT REQUIREMENTS:
1. Generate an array named "scenes" with EXACTLY ${totalScenes} distinct, brand-new scenes for a ${totalMinutes}-minute video (${totalSec} seconds total).
2. Each episode MUST BE 100% UNIQUE, fresh, and never duplicate previous ideas. Use creative analogies, realistic numbers, relatable everyday struggles, and breakthrough wealth strategies.
3. Each scene will be shown for exactly ${avgSec} seconds.
4. Every scene's "voiceText" MUST be written in ${isEn ? 'English' : 'Vietnamese'}, completely natural, fluent, and insightful, containing approximately ${targetWords} words (spoken naturally in ${avgSec - 1} seconds). DO NOT truncate sentences.
5. "imagePrompt" MUST describe 2D Flat Vector Infographic, Minimalist Modern Financial Motion Graphics, bold colors, 8k crisp details with specific camera angles (Wide, Close-up, Isometric, Cinematic).
6. Output ONLY a valid JSON object matching this exact structure:
{
  "scenes": [
    {
      "sceneIndex": 1,
      "title": "Act 1: Reality Check",
      "voiceText": "...",
      "imagePrompt": "..."
    }
  ]
}`;

  let lastApiError = null;

  // 1. Gọi trực tiếp Google Gemini API chính thức nếu có API Key (Serverless 100%)
  if (geminiApiKey && geminiApiKey.trim().length > 10) {
    const cleanKey = geminiApiKey.trim();
    // Ưu tiên gemini-1.5-flash và gemini-2.0-flash siêu tốc
    const modelCandidates = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];
    
    for (const modelName of modelCandidates) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 giây timeout

      try {
        const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${cleanKey}`;
        const gRes = await fetch(gUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.8
            }
          })
        });

        clearTimeout(timeoutId);

        if (gRes.ok) {
          const gData = await gRes.json();
          let rawTxt = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawTxt) {
            // Loại bỏ markdown block ```json ... ``` nếu có
            rawTxt = rawTxt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
            const parsed = JSON.parse(rawTxt);
            if (parsed?.scenes && Array.isArray(parsed.scenes) && parsed.scenes.length > 0) {
              return { success: true, scenes: parsed.scenes, source: "gemini_api_direct", model: modelName };
            }
          }
        } else {
          const errBody = await gRes.text();
          let errMsg = `HTTP ${gRes.status}`;
          try {
            const errJson = JSON.parse(errBody);
            errMsg = errJson?.error?.message || errMsg;
          } catch (_) {}
          lastApiError = `[${modelName}] ${errMsg}`;
          console.warn(`Gemini API Error with model ${modelName}:`, errMsg);
        }
      } catch (e) {
        clearTimeout(timeoutId);
        lastApiError = e.name === "AbortError" ? `Quá thời gian chờ (Timeout 20s) khi gọi ${modelName}` : e.message;
        console.warn(`Direct Gemini API fetch error (${modelName}):`, lastApiError);
      }
    }
  }

  return { success: false, error: lastApiError || "Không thể kết nối với Gemini API" };
}


// Allow clicking the extension icon to open the side panel
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}

// Forcibly set the sidepanel to the UI and open on action click
if (chrome.sidePanel) {
  chrome.sidePanel.setOptions({
    path: 'sidepanel.html',
    enabled: true
  }).catch(console.error);

  if (chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  }
}

// Explicit fallback listener when clicking extension icon
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      }
    } catch (e) {
      console.warn("Could not open sidePanel on action click:", e);
    }
  });
}

// ══════════════════════════════════════
// 8. Tool Video WebSocket Bridge (ws://localhost:7788)
// ══════════════════════════════════════
const TOOL_VIDEO_WS_URL = 'ws://localhost:7788';
let _toolWs = null;
let _toolServerConnected = false;
const _serverVideoQueue = [];
let _isProcessingServerQueue = false;

function connectToolVideoBridge() {
  if (_toolWs && (_toolWs.readyState === WebSocket.OPEN || _toolWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    _toolWs = new WebSocket(TOOL_VIDEO_WS_URL);

    _toolWs.onopen = async () => {
      console.log('[Tool Video Bridge] Connected to tool_video server on port 7788');
      _toolServerConnected = true;
      _toolWs.send(JSON.stringify({ type: 'EXTENSION_HELLO' }));
      chrome.runtime.sendMessage({ type: 'TOOL_SERVER_STATUS', connected: true }).catch(() => {});
    };

    _toolWs.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'TASK_GENERATE_VIDEO') {
        console.log(`[Tool Video Bridge] Received TASK_GENERATE_VIDEO: ${msg.id}`, msg);
        enqueueServerVideoTask(msg);
      }

      if (msg.type === 'TASK_GENERATE_IMAGE') {
        console.log(`[Tool Video Bridge] Received TASK_GENERATE_IMAGE: ${msg.id}`, msg);
        enqueueServerImageTask(msg);
      }
    };

    _toolWs.onerror = () => {};
    _toolWs.onclose = () => {
      _toolServerConnected = false;
      _toolWs = null;
      chrome.runtime.sendMessage({ type: 'TOOL_SERVER_STATUS', connected: false }).catch(() => {});
      setTimeout(connectToolVideoBridge, 5000);
    };
  } catch (e) {
    setTimeout(connectToolVideoBridge, 5000);
  }
}

// Keep connection alive with chrome.alarms
if (chrome.alarms) {
  chrome.alarms.create('keep_alive_tool_ws', { periodInMinutes: 0.2 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keep_alive_tool_ws') {
      if (!_toolWs || _toolWs.readyState !== WebSocket.OPEN) {
        connectToolVideoBridge();
      }
    }
  });
}
connectToolVideoBridge();

function enqueueServerVideoTask(task) {
  _serverVideoQueue.push(task);
  processServerVideoQueue();
}

const _recentBridgeLogs = [];

function logToBridge(msg) {
  const timeStr = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const logItem = { time: timeStr, message: msg, timestamp: Date.now() };

  _recentBridgeLogs.push(logItem);
  if (_recentBridgeLogs.length > 100) _recentBridgeLogs.shift();

  console.log(`[Tool Video Bridge] [${timeStr}] ${msg}`);

  // 1. Send to tool_video server over WebSocket
  if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
    try {
      _toolWs.send(JSON.stringify({ type: 'BRIDGE_LOG', message: msg, time: timeStr }));
    } catch (_) {}
  }

  // 2. Broadcast to Extension UI in real-time
  chrome.runtime.sendMessage({
    type: 'LIVE_LOG',
    log: logItem
  }).catch(() => {});
}

async function processServerVideoQueue() {
  if (_isProcessingServerQueue || !_serverVideoQueue.length) return;
  _isProcessingServerQueue = true;

  while (_serverVideoQueue.length > 0) {
    const task = _serverVideoQueue.shift();
    try {
      logToBridge(`Bắt đầu xử lý task video: ${task.id} (prompt: "${task.prompt.slice(0, 30)}...")`);
      
      let resolvedStartImage = task.startImage || null;
      let resolvedEndImage = task.endImage || null;

      const needsUploadStart = Boolean(task.startImage && (task.startImage.startsWith("http") || task.startImage.startsWith("data:") || task.startImage.length > 500));
      const needsUploadEnd = Boolean(task.endImage && (task.endImage.startsWith("http") || task.endImage.startsWith("data:") || task.endImage.length > 500));

      // Bước 1: Nếu có startImage -> Tải lên Google Flow và F5 tab Video
      if (needsUploadStart) {
        logToBridge(`[Video Engine] Tải ảnh đầu vào (startImage) lên Google Flow...`);
        const isUrl = task.startImage.startsWith("http://") || task.startImage.startsWith("https://");
        const isB64 = task.startImage.startsWith("data:") || task.startImage.length > 500;
        
        // F5 lại tab Video sau khi upload startImage theo yêu cầu của user
        const upRes = await uploadImage(task.projectId, isUrl ? task.startImage : null, isB64 ? task.startImage : null, true, false, 'video');
        if (!upRes?.success || !upRes?.mediaId) {
          throw new Error(`Lỗi upload ảnh đầu vào: ${upRes?.error || 'Không nhận được mediaId'}`);
        }
        resolvedStartImage = upRes.mediaId;
        logToBridge(`[Video Engine] ✅ Đã upload ảnh đầu vào (Media ID: ${resolvedStartImage}) và F5 lại tab Video! Đợi 3.5s...`);
        await new Promise(r => setTimeout(r, 3500));
      }

      // Bước 1.1: Nếu có endImage -> Tải lên Google Flow và F5 tab Video
      if (needsUploadEnd) {
        logToBridge(`[Video Engine] Tải ảnh kết thúc (endImage) lên Google Flow...`);
        const isUrl = task.endImage.startsWith("http://") || task.endImage.startsWith("https://");
        const isB64 = task.endImage.startsWith("data:") || task.endImage.length > 500;
        
        // F5 lại tab Video sau khi upload endImage
        const upRes = await uploadImage(task.projectId, isUrl ? task.endImage : null, isB64 ? task.endImage : null, true, false, 'video');
        if (!upRes?.success || !upRes?.mediaId) {
          throw new Error(`Lỗi upload ảnh kết thúc: ${upRes?.error || 'Không nhận được mediaId'}`);
        }
        resolvedEndImage = upRes.mediaId;
        logToBridge(`[Video Engine] ✅ Đã upload ảnh kết thúc (Media ID: ${resolvedEndImage}) và F5 lại tab Video! Đợi 3.5s...`);
        await new Promise(r => setTimeout(r, 3500));
      }

      const hasBoth = Boolean(resolvedStartImage && resolvedEndImage);
      const config = {
        aspectRatio: task.aspectRatio || '9:16',
        duration: '8s',
        count: 'x1',
        model: 'veo_3_1_lite_low_priority',
        isFrames: Boolean(resolvedStartImage || resolvedEndImage),
        hasBothFrames: hasBoth,
        startImage: resolvedStartImage,
        endImage: resolvedEndImage,
        // Start up trước -> index 1 trong thư viện; End up sau -> index 0 (mới nhất)
        startIndex: hasBoth ? 1 : 0,
        endIndex: 0
      };

      // Bước 2: Chạy Auto Click UI (chuyển Khung hình, gắn frame vừa upload, submit)
      logToBridge(`[Video Engine] Bắt đầu Auto Click: Cấu hình Khung hình, gắn ảnh và Submit...`);
      const res = await createVideoUI(task.prompt, task.projectId, config);
      if (!res?.success) {
        throw new Error(res?.error || 'Không thể click tạo video trên UI Flow');
      }

      const newVideo = res.newVideo;
      const mediaId = newVideo?.mediaId;
      logToBridge(`Task ${task.id} đã click submit thành công trên Flow! Media ID: ${mediaId}`);

      if (!mediaId) {
        throw new Error('Đã click nhưng không xác định được Media ID của video');
      }

      // 2. Spawn async poll & download worker for this mediaId in parallel
      pollAndDeliverVideo(task.id, mediaId, task.projectId || newVideo.projectId);

      // Stagger delay 4s before taking next task from queue
      await new Promise(r => setTimeout(r, 4000));
    } catch (err) {
      logToBridge(`Task ${task.id} lỗi khi click: ${err.message}`);
      if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
        _toolWs.send(JSON.stringify({
          type: 'VIDEO_RESULT',
          id: task.id,
          ok: false,
          error: err.message
        }));
      }
    }
  }

  _isProcessingServerQueue = false;
}

const _serverImageQueue = [];
let _isProcessingServerImageQueue = false;

function enqueueServerImageTask(task) {
  _serverImageQueue.push(task);
  processServerImageQueue();
}

async function processServerImageQueue() {
  if (_isProcessingServerImageQueue || !_serverImageQueue.length) return;
  _isProcessingServerImageQueue = true;

  while (_serverImageQueue.length > 0) {
    const task = _serverImageQueue.shift();
    try {
      logToBridge(`Bắt đầu tạo ảnh cho task: ${task.id} (prompt: "${(task.prompt || '').slice(0, 30)}...")`);

      const model = "NARWHAL";
      let aspect = "IMAGE_ASPECT_RATIO_LANDSCAPE";
      if (task.aspectRatio === '9:16' || task.aspectRatio?.includes('PORTRAIT')) {
        aspect = 'IMAGE_ASPECT_RATIO_PORTRAIT';
      } else if (task.aspectRatio === '16:9' || task.aspectRatio?.includes('LANDSCAPE')) {
        aspect = 'IMAGE_ASPECT_RATIO_LANDSCAPE';
      } else if (task.aspectRatio === '1:1' || task.aspectRatio?.includes('SQUARE')) {
        aspect = 'IMAGE_ASPECT_RATIO_SQUARE';
      }

      const prompt = task.prompt || '';

      // Gọi API tạo ảnh trực tiếp giống tab Tạo Ảnh (KHÔNG fallback sang Auto Click)
      logToBridge(`[Image Engine] Gọi API tạo ảnh cho task ${task.id}...`);
      const res = await createImageAPI(prompt, task.projectId, model, aspect, task.referenceImage);

      if (!res?.success || !res?.mediaId) {
        const detailStr = res?.detail ? ` (${res.detail})` : '';
        throw new Error((res?.error || 'Không nhận được Media ID từ Google Flow API') + detailStr);
      }

      const mediaId = res.mediaId;

      logToBridge(`🎉 Task ảnh ${task.id} thành công! Media ID: ${mediaId}. Đang tải file ảnh về máy...`);
      const fname = `flow_img_${Date.now()}_${mediaId.slice(0, 8)}.jpg`;
      const dlRes = await downloadFileToDisk(mediaId, fname);
      logToBridge(`✅ Đã tải xong ảnh về máy: ${dlRes.filePath} (${(dlRes.fileSize / 1024).toFixed(0)} KB)! Gửi cho tool_video...`);

      if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
        _toolWs.send(JSON.stringify({
          type: 'IMAGE_RESULT',
          id: task.id,
          mediaId: mediaId,
          filePath: dlRes.filePath,
          downloadUrl: dlRes.url,
          ok: true
        }));
      }

      try { chrome.downloads.erase({ id: dlRes.downloadId }); } catch (_) {}

      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      logToBridge(`❌ Task ảnh ${task.id} thất bại: ${err.message}`);
      if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
        _toolWs.send(JSON.stringify({
          type: 'IMAGE_RESULT',
          id: task.id,
          ok: false,
          error: err.message
        }));
      }
    }
  }

  _isProcessingServerImageQueue = false;
}

async function pollAndDeliverImage(taskId, mediaId, projectId) {
  logToBridge(`Bắt đầu theo dõi ảnh: task ${taskId}, mediaId: ${mediaId}`);
  const maxAttempts = 60; // Poll up to 4 minutes (every 4s)
  const pollInterval = 4000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollInterval));
    try {
      let isSuccess = false;
      let isFailed = false;
      let failMsg = '';

      // 1. Check project library contents
      const pData = await getProjectVideos(projectId);
      if (pData?.success) {
        const allItems = [...(pData.videos || []), ...(pData.images || [])];
        const item = allItems.find(v => v.mediaId === mediaId || v.workflowId === mediaId);
        if (item) {
          if (item.status === 'COMPLETED' || (item.createTime && attempt >= 2)) {
            isSuccess = true;
          } else if (item.status === 'FAILED') {
            isFailed = true;
            failMsg = item.failureReason || 'Tạo ảnh thất bại trên Google Flow';
          }
        }
      }

      if (isSuccess) {
        logToBridge(`🎉 Task ảnh ${taskId} (${mediaId}) HOÀN THÀNH! Đang tải ảnh về máy qua Chrome...`);
        const fname = `flow_img_${Date.now()}_${mediaId.slice(0, 8)}.jpg`;
        const dlRes = await downloadFileToDisk(mediaId, fname);
        logToBridge(`✅ Đã tải xong ảnh về máy: ${dlRes.filePath} (${(dlRes.fileSize / 1024).toFixed(0)} KB)! Gửi filePath cho tool_video...`);

        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'IMAGE_RESULT',
            id: taskId,
            mediaId: mediaId,
            filePath: dlRes.filePath,
            downloadUrl: dlRes.url,
            ok: true
          }));
        }

        try {
          chrome.downloads.erase({ id: dlRes.downloadId });
        } catch (_) {}
        return;
      }

      if (isFailed) {
        throw new Error(failMsg || 'Ảnh bị lỗi trên Flow');
      }

      if (attempt % 3 === 0) {
        logToBridge(`Task ảnh ${taskId} đang xử lý... [lần ${attempt}/${maxAttempts}]`);
      }
    } catch (pollErr) {
      if (attempt === maxAttempts) {
        logToBridge(`❌ Task ảnh ${taskId} thất bại sau ${maxAttempts} lần thử: ${pollErr.message}`);
        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'IMAGE_RESULT',
            id: taskId,
            ok: false,
            error: pollErr.message
          }));
        }
      }
    }
  }
}

async function checkVideoStatusOnFlow(mediaIds, projectId) {
  const flowTab = await getFlowTab('video', projectId);
  if (!flowTab) throw new Error("Không tìm thấy tab Google Flow đang mở!");

  let authToken = await getFreshAuthToken(flowTab);

  const results = await chrome.scripting.executeScript({
    target: { tabId: flowTab.id },
    world: "MAIN",
    args: [mediaIds, projectId, authToken],
    func: async (mIds, pId, auth) => {
      try {
        const payload = {
          media: mIds.map(id => ({ name: id, projectId: pId || null }))
        };
        const headers = {
          "Content-Type": "text/plain;charset=UTF-8"
        };
        if (auth) headers["Authorization"] = auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;

        const res = await fetch("https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(payload)
        });

        const txt = await res.text();
        return { ok: res.ok, status: res.status, body: txt };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
  });

  const res = results?.[0]?.result;
  if (!res) throw new Error("Không nhận được phản hồi từ tab Flow khi check status");
  if (!res.ok) throw new Error(`Status check HTTP ${res.status}: ${res.body || res.error}`);

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (_) {
    throw new Error(`Invalid JSON from status API: ${res.body}`);
  }
  return parsed;
}

function downloadFileToDisk(target, filename) {
  const url = (typeof target === 'string' && target.startsWith('http'))
    ? target
    : `${TRPC_BASE}/media.getMediaUrlRedirect?name=${encodeURIComponent(target)}`;
  const fname = filename || `flow_${Date.now()}.bin`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename: fname, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        return reject(new Error(chrome.runtime.lastError?.message || 'Không thể bắt đầu tải file'));
      }

      let timer = null;
      const timeout = setTimeout(() => {
        if (timer) clearInterval(timer);
        reject(new Error('Timeout quá 60s chờ tải video về máy'));
      }, 60000);

      timer = setInterval(() => {
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (!items || !items.length) {
            clearInterval(timer);
            clearTimeout(timeout);
            return reject(new Error('Không tìm thấy tiến trình download'));
          }
          const item = items[0];
          if (item.state === 'complete') {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve({
              downloadId: item.id,
              filePath: item.filename,
              fileSize: item.fileSize,
              url: item.url
            });
          } else if (item.state === 'interrupted') {
            clearInterval(timer);
            clearTimeout(timeout);
            reject(new Error(`Tải video bị gián đoạn: ${item.error || 'Lỗi không xác định'}`));
          }
        });
      }, 1000);
    });
  });
}
const downloadVideoFileToDisk = downloadFileToDisk;

async function pollAndDeliverVideo(taskId, mediaId, projectId) {
  logToBridge(`Bắt đầu theo dõi video: task ${taskId}, mediaId: ${mediaId}`);
  const maxAttempts = 120; // Poll up to 10-12 minutes (every 5s)
  const pollInterval = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollInterval));
    try {
      let isSuccess = false;
      let isFailed = false;
      let failMsg = '';

      // 1. Thử check qua API chuyên dụng batchCheckAsyncVideoGenerationStatus
      try {
        const data = await checkVideoStatusOnFlow([mediaId], projectId);
        const mediaList = data?.media || [];
        const item = mediaList.find(m => m.name === mediaId) || mediaList[0];

        if (item) {
          const genStatus = item.mediaMetadata?.mediaStatus?.mediaGenerationStatus || 
                            item.mediaMetadata?.generationStatus || 
                            item.status?.state || '';

          if (genStatus.includes('SUCCESS')) {
            isSuccess = true;
          } else if (genStatus.includes('FAIL') || genStatus.includes('FILTER')) {
            isFailed = true;
            failMsg = item.mediaMetadata?.mediaStatus?.errorMessage || item.failureReason || `Google Flow báo lỗi: ${genStatus}`;
          } else if (attempt % 4 === 0) {
            logToBridge(`Task ${taskId} đang render (${genStatus || 'PROCESSING'})... [lần ${attempt}/${maxAttempts}]`);
          }
        }
      } catch (checkErr) {
        // Warning only, continue to fallback
      }

      // 2. Fallback: Nếu API trên chưa trả về hoặc trả về rỗng, kiểm tra qua Thư viện project (getProjectVideos)
      if (!isSuccess && !isFailed) {
        try {
          const pData = await getProjectVideos(projectId);
          if (pData?.success && Array.isArray(pData.videos)) {
            const vid = pData.videos.find(v => v.mediaId === mediaId || v.workflowId === mediaId);
            if (vid) {
              if (vid.status === 'COMPLETED') {
                isSuccess = true;
              } else if (vid.status === 'FAILED') {
                isFailed = true;
                failMsg = vid.failureReason || 'Video thất bại trong thư viện Flow';
              } else if (attempt % 4 === 0) {
                logToBridge(`Task ${taskId} trạng thái thư viện: ${vid.status}... [lần ${attempt}/${maxAttempts}]`);
              }
            }
          }
        } catch (_) {}
      }

      if (isSuccess) {
        logToBridge(`🎉 Task ${taskId} (${mediaId}) HOÀN THÀNH! Đang tải video về máy thật qua Chrome...`);

        const dlRes = await downloadVideoFileToDisk(mediaId);
        logToBridge(`✅ Đã tải xong về máy: ${dlRes.filePath} (${(dlRes.fileSize / 1024 / 1024).toFixed(2)} MB)! Gửi filePath cho tool_video...`);

        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'VIDEO_RESULT',
            id: taskId,
            mediaId: mediaId,
            filePath: dlRes.filePath,
            downloadUrl: dlRes.url,
            ok: true
          }));
        }

        try {
          chrome.downloads.erase({ id: dlRes.downloadId });
        } catch (_) {}

        return;
      }

      if (isFailed) {
        logToBridge(`❌ Task ${taskId} THẤT BẠI: ${failMsg}`);
        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'VIDEO_RESULT',
            id: taskId,
            mediaId: mediaId,
            ok: false,
            error: failMsg
          }));
        }
        return;
      }

    } catch (e) {
      logToBridge(`Task ${taskId} chú ý: ${e.message}`);
      if (attempt >= maxAttempts) {
        logToBridge(`❌ Task ${taskId} timeout quá thời gian chờ!`);
        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'VIDEO_RESULT',
            id: taskId,
            mediaId: mediaId,
            ok: false,
            error: `Timeout: ${e.message}`
          }));
        }
        return;
      }
    }
  }

  // Timeout sau 10-12 phút
  logToBridge(`❌ Task ${taskId} timeout quá 10 phút không thấy hoàn thành.`);
  if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
    _toolWs.send(JSON.stringify({
      type: 'VIDEO_RESULT',
      id: taskId,
      mediaId: mediaId,
      ok: false,
      error: 'Timeout quá 10 phút chờ Google Flow render video'
    }));
  }
}


async function testUiStep(step, req) {
  const tab = await getFlowTab('video', req.projectId);
  if (!tab) return { success: false, error: "Cần mở ít nhất một tab Google Flow cho Video!" };
  
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 400));
  } catch (_) {}

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [step, req.prompt || ""],
      func: async (stepIdx, promptText) => {
        const queryDeep = (selector) => {
          const matches = [];
          const walk = (node) => {
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of node.children) {
              if (child.matches && child.matches(selector)) matches.push(child);
              walk(child);
            }
          };
          walk(document.body);
          return matches;
        };

        const queryScopeDeep = (scope, selector) => {
          if (!scope) return [];
          const matches = [];
          const walk = (node) => {
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of node.children) {
              if (child.matches && child.matches(selector)) matches.push(child);
              walk(child);
            }
          };
          walk(scope);
          return matches;
        };
        
        const findDeepEditor = () => {
          const walk = (node) => {
            if (node.shadowRoot) {
              const res = walk(node.shadowRoot);
              if (res) return res;
            }
            for (const child of node.children) {
              if (child.tagName === 'TEXTAREA' || child.getAttribute('contenteditable') === 'true' || child.getAttribute('data-slate-editor') === 'true' || child.getAttribute('role') === 'textbox') {
                return child;
              }
              const res = walk(child);
              if (res) return res;
            }
            return null;
          };
          return walk(document.body);
        };

        const editor = document.querySelector("div[role='textbox'][data-slate-editor='true']")
                    || document.querySelector("div[data-slate-editor='true']")
                    || document.querySelector("div[contenteditable='true']")
                    || document.querySelector("textarea[placeholder*='prompt' i]")
                    || findDeepEditor();
                    
        const composerButtons = queryDeep("button, [role='button']");
        
        const submitBtn = composerButtons.find(b => {
          const inner = (b.innerHTML || "").toLowerCase();
          const t = (b.textContent || "").trim().toLowerCase();
          return inner.includes("arrow_forward") || inner.includes("send") || t === "arrow_forward" || t === "send";
        });

        // Chỉ tìm Settings Chip xung quanh khu vực của submitBtn (để tránh click nhầm vào các video trong danh sách)
        let settingsChip = null;
        if (submitBtn) {
           let parent = submitBtn;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn) return false;
                if (b.offsetParent === null) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                // Ưu tiên nút có chứa các thông số cài đặt
                if (t.includes("video") || t.includes("ảnh") || t.includes("image") || t.match(/\b(720p|1080p|4k|giây|fps)\b/i) || t.match(/^\d+s/i)) {
                   return true;
                }
                return false;
             });
             
             if (candidate) {
               settingsChip = candidate;
               break;
             }
           }
           
           if (!settingsChip) {
              parent = submitBtn;
              for (let i = 0; i < 8 && parent; i++) {
                 parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
                 if (!parent) break;
                 const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
                 const candidate = buttonsHere.find(b => b !== submitBtn && b.offsetParent !== null && !b.innerHTML.toLowerCase().includes("add") && (b.textContent || "").trim() !== "+");
                 if (candidate) {
                   settingsChip = candidate;
                   break;
                 }
              }
           }
        }

        if (stepIdx === 1) {
          if (!editor) throw new Error("Không tìm thấy ô nhập prompt (Editor)");
          editor.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, promptText);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          return "Đã điền prompt thành công!";
        }

        if (stepIdx === 2) {
          if (!settingsChip) throw new Error("Không tìm thấy nút Settings Chip");
          settingsChip.click();
          return "Đã bấm nút Settings Chip!";
        }

        if (stepIdx === 3) {
          if (!submitBtn) throw new Error("Không tìm thấy nút Bắt Đầu (Submit)");
          submitBtn.click();
          return "Đã bấm Submit!";
        }

        return "Unknown step";
      }
    });

    return { success: true, message: results[0].result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
