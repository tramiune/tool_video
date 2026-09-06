// Flow Studio Bridge — Background Service Worker v3.3
// Uses captured auth token from Flow's own API calls (Isolated Per-Tab)
"use strict";

// ── Auth Token Management (Isolated Per-Tab) ──
// Map: tabId -> { auth: string, time: number }
const tabAuthTokens = new Map();
const MAX_TOKEN_AGE_MS = 50 * 60 * 1000; // 50 phút

// Map: tabId -> Array of captured media objects { mediaIds, workflows, videoUrls, primaryId, rpcId, time }
const _capturedMediaByTab = new Map();

// Dọn dẹp token & media cache khi tab đóng
chrome.tabs.onRemoved.addListener((tabId) => {
  tabAuthTokens.delete(tabId);
  _capturedMediaByTab.delete(tabId);
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
    
    // Chỉ log ra console của DevTools, không bắn vào Live Log / Server log tránh spam
    console.log(`🚀 [New API Captured Tab ${tabId}]: RPC [${rpcIds}]`, req);

    if (isL2jnw) {
      const summary = JSON.stringify(req.fReq).slice(0, 300);
      console.log(`[New API Captured] 🔥 TÓM ĐƯỢC CẤU TRÚC L2jnw (StreamGenerateContent): ${summary}...`);
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

  if (req.action === "FLOW_MEDIA_CAPTURED") {
    const tabId = sender?.tab?.id || 'unknown';
    const item = req.item || {};
    const primaryId = item.primaryId;

    if (!_capturedMediaByTab.has(tabId)) {
      _capturedMediaByTab.set(tabId, []);
    }
    const tabMedia = _capturedMediaByTab.get(tabId);
    tabMedia.unshift(item);
    if (tabMedia.length > 50) tabMedia.pop();

    if (primaryId) {
      console.log(`[Flow Recon] 🎯 Tóm được Media ID từ RPC [${item.rpcId || 'Boq'}]: ${primaryId}`);
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
  DOWNLOAD_VIDEO:     req => downloadVideo(req.mediaId, req.filename, req.videoUrl, req.cardIndex),
  CREATE_VIDEO:       req => createVideoAPI(req.prompt, req.projectId, req.model, req.aspectRatio, req.startImage, req.endImage),
  CREATE_VIDEO_UI:    req => createVideoUI(req.prompt, req.projectId, req.config),
  CREATE_IMAGE:       req => createImageAPI(req.prompt, req.projectId, req.model, req.aspectRatio, req.referenceImage),
  CREATE_IMAGE_UI:    req => createImageUI(req.prompt, req.projectId, req.config),
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
  DOWNLOAD_CARD_NATIVE: req => (req.mediaType === 'image'
    ? downloadImageCardDirect(req.tabId, req.query, req.prompt, req.mediaId, req.workflowId, req.imgSrc, req.projectId)
    : triggerNativeDownloadForCard(req.tabId, req.query, req.prompt, req.mediaId, req.workflowId, req.mediaType || 'video', req.projectId)),
  DOWNLOAD_IMAGE_CARD: req => downloadImageCardDirect(req.tabId, req.query, req.prompt, req.mediaId, req.workflowId, req.imgSrc, req.projectId),
  DOWNLOAD_IMAGE_CARD_NATIVE: req => downloadImageCardDirect(req.tabId, req.query, req.prompt, req.mediaId, req.workflowId, req.imgSrc, req.projectId),
  WAIT_AND_DOWNLOAD_CARD: req => waitAndDownloadCard(req.projectId, req.prompt, req.timeoutMs),
  CHECK_CARD_STATUS: req => checkCardStatus(req.projectId, req.query, req.prompt, req.mediaId, req.workflowId, req.mediaType || 'auto'),
  GET_MAX_SEQ: req => getMaxSeq(req.projectId),
  UPDATE_MAX_SEQ: req => updateMaxSeq(req.projectId, req.newMax),
  SCROLL_FLOW_TO_TOP: req => scrollFlowToTop(req.tabId, req.projectId),
  REPORT_TOOL_VIDEO_RESULT: req => reportToolVideoResult(req),
  GET_PENDING_SERVER_TASKS: () => getPendingServerTasks(),
  SCAN_FLOW_CARDS: req => scanFlowCards(req.tabId, req.projectId),
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
async function getProjectVideos(projectId, targetTab = null) {
  if (!projectId) return { success: false, error: "Thiếu projectId" };

  let data = null;
  const flowTab = targetTab || await getFlowTab('video', projectId);

  // 1. Quét trực tiếp media từ DOM và biến toàn cục của Flow tab (hoạt động 100% trên flow.google.com)
  if (flowTab?.id) {
    try {
      const execDom = await chrome.scripting.executeScript({
        target: { tabId: flowTab.id },
        world: "MAIN",
        func: () => {
          const videos = [];
          const images = [];
          const seen = new Set();

          // Lấy Project ID từ URL hiện tại để tránh nhầm với Media ID
          const pMatch = window.location.pathname.match(/project\/([a-f0-9\-]{36})/i);
          const currentProjectId = pMatch ? pMatch[1].toLowerCase() : null;

          // Helper trích xuất Prompt từ card container
          const extractPromptFromCard = (container) => {
            if (!container) return "";

            // 1. Kiểm tra title hoặc aria-label trên các thẻ con
            const titled = container.querySelectorAll("[title], [aria-label]");
            for (const el of titled) {
              for (const attr of ["title", "aria-label"]) {
                let val = (el.getAttribute(attr) || "").trim();
                if (val.length >= 3) {
                  if (/^(phát|play|xem|more|tuỳ chọn|menu|thêm|xoá|delete|download|tải|replay|undo|redo|chia sẻ|share|hoàn tác|đóng|close|options|actions|ô hiển thị)/i.test(val)) continue;
                  val = val.replace(/^(play_arrow|more_vert|replay)\s*/i, "").trim();
                  if (val.length >= 3 && !/^(play_arrow|more_vert)$/i.test(val)) {
                    if (val.toLowerCase().includes("video") || val.length > 8) return val;
                  }
                }
              }
            }

            // 2. Thu thập text nodes
            const candidates = [];
            const walk = (node) => {
              if (node.nodeType === Node.TEXT_NODE) {
                const t = (node.textContent || "").replace(/\s+/g, " ").trim();
                if (t.length >= 2) {
                  const cleaned = t
                    .replace(/^(play_arrow|replay|undo|redo|more_vert|refresh|arrow_forward|crop_free|close|add|check)\s*/i, "")
                    .replace(/\s*(play_arrow|replay|undo|redo|more_vert|refresh|arrow_forward|crop_free|close|add|check)$/i, "")
                    .trim();

                  if (cleaned.length >= 2 &&
                      !/^\d{1,3}%$/.test(cleaned) &&
                      !/^\d+(\.\d+)?s$/i.test(cleaned) &&
                      !/^(720p|1080p|4k|16:9|9:16|1:1)$/i.test(cleaned) &&
                      !/^[a-f0-9\-]{30,45}$/i.test(cleaned) &&
                      !/^(phát|play|video|ảnh|image|đang tạo|generating|hoàn tác|tuỳ chọn|more)$/i.test(cleaned)) {
                    candidates.push(cleaned);
                  }
                }
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') return;
                for (const child of node.childNodes) walk(child);
              }
            };
            walk(container);

            if (!candidates.length) return "";

            // Ưu tiên 1: Chuỗi bắt đầu bằng số thứ tự (VD: "001. tạo video...", "01. ...")
            const numberedMatch = candidates.find(c => /^\d+[\.\-_:\s]/.test(c) && c.length >= 4);
            if (numberedMatch) return numberedMatch;

            // Ưu tiên 2: Chuỗi có chữ "tạo video" hoặc "video"
            const vidMatch = candidates.find(c => /^(tạo\s+video|tạo)/i.test(c) || c.toLowerCase().includes("video"));
            if (vidMatch) return vidMatch;

            // Nếu không, lấy chuỗi có độ dài lớn nhất
            candidates.sort((a, b) => b.length - a.length);
            return candidates[0] || "";
          };

          // 1. Quét tất cả thẻ media của các card trên giao diện
          const allMedia = Array.from(document.querySelectorAll("img, video")).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
            const src = el.src || el.currentSrc || "";
            if (src.includes("googleusercontent.com/a/") || src.includes("avatar") || src.includes("profile")) return false;
            if (src.startsWith("data:image/svg")) return false;
            const r = el.getBoundingClientRect();
            return r.width > 60 && r.height > 60;
          });

          // 2. Tìm card container độc lập cho từng phần tử media
          const rawCards = [];
          const seenCardElements = new Set();

          for (const mediaEl of allMedia) {
            let card = mediaEl;
            let cur = mediaEl.parentElement;

            // Leo lên tìm phần tử cha lớn nhất mà vẫn chỉ chứa 1 card
            while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
              const childMedia = allMedia.filter(m => cur.contains(m));
              const distinctPos = new Set(childMedia.map(m => {
                const r = m.getBoundingClientRect();
                return `${Math.round(r.left / 25)},${Math.round((r.top + window.scrollY) / 35)}`;
              }));

              if (distinctPos.size > 1) {
                break;
              }
              card = cur;
              cur = cur.parentElement;
            }

            if (card && !seenCardElements.has(card)) {
              seenCardElements.add(card);
              const r = card.getBoundingClientRect();
              rawCards.push({
                card,
                mediaEl,
                top: r.top + window.scrollY,
                left: r.left + window.scrollX
              });
            }
          }

          // 3. Sắp xếp theo thứ tự hiển thị tự nhiên trên màn hình: Trên xuống dưới, Trái qua phải
          rawCards.sort((a, b) => {
            if (Math.abs(a.top - b.top) > 80) {
              return a.top - b.top;
            }
            return a.left - b.left;
          });

          // 4. Xử lý từng card
          rawCards.forEach((item, idx) => {
            const container = item.card;
            const mediaEl = item.mediaEl;

            // Đánh dấu DOM element để downloadVideo tìm lại chính xác 100% trong 0ms
            container.setAttribute("data-flow-index", String(idx));

            // Trích xuất Prompt
            const prompt = extractPromptFromCard(container);

            // Trích xuất ID
            let id = null;
            const dm = container.getAttribute("data-media-id") || container.getAttribute("data-workflow-id");
            if (dm && dm.length >= 15 && dm.length <= 45 && dm.toLowerCase() !== currentProjectId) {
              id = dm;
            }
            if (!id && container.id && container.id !== '_gd' && /^[a-f0-9\-]{30,45}$/i.test(container.id) && container.id.toLowerCase() !== currentProjectId) {
              id = container.id;
            }
            if (!id) {
              const m = container.outerHTML.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi);
              if (m) {
                const found = m.find(u => u.toLowerCase() !== currentProjectId);
                if (found) id = found;
              }
            }
            const imgSrc = mediaEl?.src || mediaEl?.currentSrc || "";
            if (!id) {
              const asbMatch = imgSrc.match(/\/asb\/([A-Za-z0-9_-]{12,})/);
              if (asbMatch) {
                id = "asb_" + asbMatch[1].slice(0, 16);
              }
            }
            if (!id) {
              id = "flow_card_" + (idx + 1);
            }

            container.setAttribute("data-flow-card-id", id);
            seen.add(id);

            // Kiểm tra thẻ <video> đã render
            const v = container.querySelector("video");
            const vSrc = v?.currentSrc || v?.src || v?.querySelector("source")?.src || null;
            const vidUrl = (vSrc && vSrc.includes("/asb/")) ? vSrc : null;

            // Kiểm tra trạng thái render (Đang tạo / % / Spinner)
            const txt = (container.textContent || "").toLowerCase();
            const pctMatch = txt.match(/\b(\d{1,3})%/);
            const pctVal = pctMatch ? parseInt(pctMatch[1], 10) : null;
            const isPctActive = pctVal !== null && pctVal < 100;
            const isGen = Boolean(container.querySelector("[role='progressbar'], svg.animate-spin, .spinner, [class*='spin'], [class*='progress']")) ||
                          txt.includes("đang tạo") ||
                          txt.includes("generating") ||
                          txt.includes("in progress");

            const isProcessing = Boolean(isPctActive || isGen);

            // Kiểm tra có phải Video hay Ảnh
            const hasPlay = Boolean(
              container.querySelector("button[aria-label*='Phát' i], button[aria-label*='Play' i], button[title*='Phát' i], [class*='play'], svg")
            ) || txt.includes("play_arrow") || txt.includes("play");
            const hasVideoText = prompt.toLowerCase().includes("video") || txt.includes("video") || /\b\d+s\b/i.test(txt);
            const isVideo = Boolean(v || vidUrl || hasPlay || hasVideoText || isProcessing || !prompt.toLowerCase().includes("ảnh"));

            const cleanPrompt = prompt || `Video Veo #${idx + 1}`;

            if (isVideo) {
              videos.push({
                mediaId: id,
                workflowId: id,
                cardIndex: idx,
                videoUrl: vidUrl,
                imageUrl: imgSrc,
                status: isProcessing ? 'PROCESSING' : 'COMPLETED',
                progress: pctVal !== null ? `${pctVal}%` : (isProcessing ? 'Đang tạo...' : ''),
                prompt: cleanPrompt,
                model: 'Veo 3.1',
                resolution: '720P'
              });
            } else {
              images.push({
                mediaId: id,
                workflowId: id,
                cardIndex: idx,
                imageUrl: imgSrc,
                status: isProcessing ? 'PROCESSING' : 'COMPLETED',
                prompt: prompt || `Ảnh Flow #${idx + 1}`,
                model: 'Imagen 3',
                resolution: '1080P'
              });
            }
          });

          // 5. Bổ sung từ window.__flowRecentMedia nếu có media từ RPC mà chưa thấy trên DOM
          const recent = window.__flowRecentMedia || [];
          for (const m of recent) {
            const id = m.primaryId || m.mediaIds?.[0];
            if (id && !seen.has(id)) {
              seen.add(id);
              const realAsb = m.videoUrls?.find(u => u && u.includes("/asb/")) || null;
              const isDone = Boolean((m.status === 'COMPLETED' || m.isSuccess) && realAsb);
              videos.push({
                mediaId: id,
                workflowId: id,
                cardIndex: videos.length,
                videoUrl: realAsb,
                status: isDone ? 'COMPLETED' : 'PROCESSING',
                progress: isDone ? '' : 'Đang xử lý...',
                prompt: `Video Veo #${videos.length + 1}`,
                model: 'Veo 3.1',
                resolution: '720P'
              });
            }
          }

          return { success: true, videos, images };
        }
      });

      const domRes = execDom?.[0]?.result;
      if (domRes?.success && (domRes.videos?.length > 0 || domRes.images?.length > 0)) {
        return {
          success: true,
          videos: domRes.videos || [],
          images: domRes.images || [],
          workflows: [],
          totalVideos: domRes.videos?.length || 0,
          totalImages: domRes.images?.length || 0,
          projectName: "Dự án Google Flow",
          defaultModel: "Veo 3.1 Lite"
        };
      }
    } catch (_) {}
  }

  // 2. Fallback: Nếu có labs.google tRPC data
  if (flowTab?.id) {
    try {
      const exec = await chrome.scripting.executeScript({
        target: { tabId: flowTab.id },
        world: "MAIN",
        args: [projectId, TRPC_BASE],
        func: async (pId, trpcBase) => {
          try {
            const inp = JSON.stringify({ json: { projectId: pId } });
            const u = `${trpcBase}/flow.projectInitialData?input=${encodeURIComponent(inp)}`;
            const r = await fetch(u, { credentials: "include" });
            if (!r.ok) return { ok: false, status: r.status };
            const j = await r.json();
            return { ok: true, data: j };
          } catch (e) {
            return { ok: false };
          }
        }
      });
      const tabRes = exec?.[0]?.result;
      if (tabRes?.ok && tabRes.data) {
        data = tabRes.data;
      }
    } catch (_) {}
  }

  if (!data) {
    // Không coi 401 từ labs.google là lỗi vì Google Flow hiện chạy trên flow.google.com
    return { success: true, videos: [], images: [], workflows: [] };
  }
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

async function downloadVideo(mediaId, filename, directUrl = null, cardIndex = -1) {
  if (!mediaId && !directUrl && cardIndex < 0) return { success: false, error: "Thiếu thông tin video cần tải" };
  const fname = filename || `flow_video_${(mediaId || 'download').slice(0, 8)}.mp4`;
  const mId = mediaId || '';
  const cIdx = typeof cardIndex === 'number' ? cardIndex : -1;

  let resolvedUrl = (directUrl && directUrl.startsWith("http") && !directUrl.includes("flow-content.google") && !directUrl.includes("labs.google")) ? directUrl : null;

  const flowTab = await getFlowTab('video');
  if (flowTab?.id) {
    try {
      const inTabRes = await chrome.scripting.executeScript({
        target: { tabId: flowTab.id },
        world: "MAIN",
        args: [mId, fname, resolvedUrl, cIdx],
        func: async (targetId, downloadName, customUrl, targetIndex) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          let targetUrl = null;

          // 1. Tìm thẻ card của CHÍNH XÁC video cần tải
          let card = null;

          // A. Tìm theo data-flow-card-id hoặc data-flow-index đã được gán sẵn
          if (targetId) {
            card = document.querySelector(`[data-flow-card-id="${targetId}"]`);
          }
          if (!card && targetIndex >= 0) {
            card = document.querySelector(`[data-flow-index="${targetIndex}"]`);
          }

          // B. Nếu chưa tìm được qua attribute, tìm lại theo danh sách media cards
          if (!card) {
            const allMedia = Array.from(document.querySelectorAll("img, video")).filter(el => {
              if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
              const src = el.src || el.currentSrc || "";
              if (src.includes("googleusercontent.com/a/") || src.includes("avatar")) return false;
              const r = el.getBoundingClientRect();
              return r.width > 60 && r.height > 60;
            });

            const cardMap = new Map();
            for (const m of allMedia) {
              let c = m;
              let cur = m.parentElement;
              while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
                const childMedia = allMedia.filter(x => cur.contains(x));
                const distinctPos = new Set(childMedia.map(x => {
                  const r = x.getBoundingClientRect();
                  return `${Math.round(r.left / 25)},${Math.round((r.top + window.scrollY) / 35)}`;
                }));
                if (distinctPos.size > 1) break;
                c = cur;
                cur = cur.parentElement;
              }
              const r = c.getBoundingClientRect();
              const posKey = `${Math.round((r.top + window.scrollY) / 80)}_${Math.round(r.left / 25)}`;
              if (!cardMap.has(posKey)) {
                cardMap.set(posKey, { card: c, top: r.top + window.scrollY, left: r.left + window.scrollX });
              }
            }

            const sorted = Array.from(cardMap.values()).sort((a, b) => {
              if (Math.abs(a.top - b.top) > 80) return a.top - b.top;
              return a.left - b.left;
            });

            if (targetIndex >= 0 && targetIndex < sorted.length) {
              card = sorted[targetIndex].card;
            } else if (targetId) {
              const matched = sorted.find(s => s.card.outerHTML.includes(targetId) || (s.card.querySelector("img, video")?.src || "").includes(targetId));
              if (matched) card = matched.card;
            }
          }

          if (card) {
            // Kiểm tra xem thẻ card này đã có <video> chưa
            let v = card.querySelector("video");
            let src = v?.currentSrc || v?.src || v?.querySelector("source")?.src;

            // Nếu card này CHƯA có thẻ video hoặc src chưa có /asb/, CHỈ hover vào card này để kích hoạt!
            if (!src || !src.startsWith("http") || !src.includes("/asb/")) {
              const hoverTarget = card.querySelector("img") || card;
              hoverTarget.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true }));
              hoverTarget.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, cancelable: true }));
              hoverTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
              hoverTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
              hoverTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));

              // Thử hover nút play nếu có
              const playBtn = card.querySelector("button[aria-label*='Phát' i], button[aria-label*='Play' i], button[title*='Phát' i], [class*='play'], svg");
              if (playBtn) {
                playBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                playBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              }

              // Đợi tối đa 2.5 giây để Google Flow render thẻ video và nạp stream /asb/
              for (let i = 0; i < 16; i++) {
                await sleep(150);
                v = card.querySelector("video");
                src = v?.currentSrc || v?.src || v?.querySelector("source")?.src;
                if (src && src.startsWith("http") && src.includes("/asb/")) break;
              }
            }

            if (src && src.startsWith("http") && src.includes("/asb/")) {
              targetUrl = src;
            }
          }

          // 2. Nếu vẫn chưa có targetUrl, quét tất cả các thẻ <video> có stream /asb/ trên trang
          if (!targetUrl) {
            const allVideos = Array.from(document.querySelectorAll("video"));
            for (const vid of allVideos) {
              const s = vid.currentSrc || vid.src || vid.querySelector("source")?.src;
              if (s && s.startsWith("http") && s.includes("/asb/")) {
                if ((card && card.contains(vid)) || allVideos.length === 1) {
                  targetUrl = s;
                  break;
                }
              }
            }
          }

          // 3. Fallback URL nếu hợp lệ từ tham số truyền vào
          if (!targetUrl && customUrl && customUrl.startsWith("http") && customUrl.includes("/asb/")) {
            targetUrl = customUrl;
          }

          return { url: targetUrl };
        }
      });

      const tabResult = inTabRes?.[0]?.result;
      if (tabResult?.url) {
        resolvedUrl = tabResult.url;
      }
    } catch (tabErr) {
      console.warn("[Download] In-tab scan error:", tabErr.message);
    }
  }

  // Tuyệt đối không fallback sang flow-content.google vì link đó trả về trang HTML lỗi 404/login
  if (!resolvedUrl || !resolvedUrl.startsWith('http') || !resolvedUrl.includes('/asb/')) {
    return {
      success: false,
      error: "Chưa bắt được link video .mp4 từ Google Flow cho video này. Bạn vui lòng rê chuột trực tiếp vào video trên trang Flow 1 giây rồi bấm lại 'Tải MP4' nhé!"
    };
  }

  // Tải trực tiếp bằng chrome.downloads trong Service Worker (Bypass CSP & CORS 100%)
  return new Promise(resolve => {
    chrome.downloads.download({ url: resolvedUrl, filename: fname, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        resolve({ success: false, error: chrome.runtime.lastError?.message || 'Không thể bắt đầu tải' });
      } else {
        resolve({ success: true, message: "Đã bắt đầu tải video .mp4 về máy!", downloadId });
      }
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
  const clickStartTime = Date.now();

  // ──────────────────────────────────────────────
  // RECON STEP A: Snapshot Library Videos BEFORE Click
  // ──────────────────────────────────────────────
  let beforeIds = new Set();
  let beforeCount = 0;
  if (effectiveProjectId) {
    try {
      const beforeData = await getProjectVideos(effectiveProjectId, tab);
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
        if (beforeCount > 0) {
          logToBridge(`[Flow Recon] Trước khi click: Đã có ${beforeCount} items (${beforeData.images?.length || 0} ảnh, ${beforeData.videos?.length || 0} video, ${beforeData.workflows?.length || 0} workflows) trong project ${effectiveProjectId.slice(0, 8)}...`);
        }
      }
    } catch (e) {
    }
  }

  // Snapshot toàn bộ Media ID đang có trong window.__flowRecentMedia và DOM TRƯỚC KHI BẤM CLICK để loại trừ 100%
  try {
    const preSnapshot = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const ids = [];
        const recent = window.__flowRecentMedia || [];
        for (const r of recent) {
          if (r.primaryId) ids.push(r.primaryId);
          if (r.mediaIds) ids.push(...r.mediaIds);
          if (r.workflows) ids.push(...r.workflows);
        }
        const domEls = document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id]");
        for (const el of domEls) {
          const m = el.getAttribute("data-media-id") || el.getAttribute("data-workflow-id") || el.getAttribute("data-id");
          if (m) ids.push(m);
        }
        return ids;
      }
    });
    if (preSnapshot?.[0]?.result) {
      preSnapshot[0].result.forEach(id => beforeIds.add(id));
    }
  } catch (_) {}

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
        // STEP 1: Find Editor & Composer Container
        // ──────────────────────────────────────────────
        const getDeepActiveElement = (root = document) => {
          if (root.activeElement && root.activeElement.shadowRoot) {
            return getDeepActiveElement(root.activeElement.shadowRoot);
          }
          return root.activeElement;
        };

        const isElemVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden";
        };

        // Tìm ô Slate Editor thực sự (div[contenteditable='true'][role='textbox'])
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

        let editor = document.querySelector("div[role='textbox'][data-slate-editor='true']")
                  || document.querySelector("div[data-slate-editor='true']")
                  || document.querySelector("div[contenteditable='true'][role='textbox']")
                  || document.querySelector("div[contenteditable='true']")
                  || findDeepEditor();

        if (!editor) return { success: false, error: "Không tìm thấy ô nhập prompt trên giao diện Flow!" };

        const composerButtons = queryDeep("button, [role='button']");
        
        // 1. Tìm nút Submit (hỗ trợ type=submit, aria-label, svg icon, text arrow/send)
        let submitBtn = composerButtons.find(b => {
          if (!isElemVisible(b)) return false;
          const inner = (b.innerHTML || "").toLowerCase();
          const t = (b.textContent || "").trim().toLowerCase();
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          if (b.getAttribute("type") === "submit") return true;
          if (aria.includes("tạo") || aria.includes("generate") || aria.includes("submit") || aria.includes("send") || aria.includes("gửi") || aria.includes("bắt đầu")) return true;
          return inner.includes("arrow_forward") || inner.includes("send") || t === "arrow_forward" || t === "send" ||
                 Boolean(b.querySelector("svg.lucide-arrow-right, svg.lucide-send, svg.lucide-arrow-up, svg[data-icon='send'], svg[data-icon='arrow-right'], svg[data-icon='arrow-up']"));
        });

        // Dự phòng: Tìm submitBtn từ editor (nút ngoài cùng bên phải trong khung soạn thảo)
        if (!submitBtn && editor) {
          let parent = editor;
          for (let i = 0; i < 8 && parent; i++) {
            parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
            if (!parent) break;
            const buttonsHere = queryScopeDeep(parent, "button, [role='button']").filter(b => isElemVisible(b));
            if (buttonsHere.length > 0) {
              const sorted = [...buttonsHere].sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
              const candidate = sorted.find(b => {
                const t = (b.textContent || "").trim().toLowerCase();
                const aria = (b.getAttribute("aria-label") || "").toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add") || aria.includes("tác nhân") || aria.includes("agent")) return false;
                if (t.includes("video") || t.includes("ảnh") || t.includes("image") || t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.match(/\b(720p|1080p|4k|giây|fps|16:9|9:16)\b/i) || t.match(/^\d+s/i)) return false;
                return true;
              });
              if (candidate) {
                submitBtn = candidate;
                break;
              }
            }
          }
        }

        // 2. Tìm Settings Chip
        let settingsChip = null;
        const isSettingChipText = (t) => {
          if (!t) return false;
          return t.includes("video") || t.includes("ảnh") || t.includes("image") || 
                 t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.includes("veo") ||
                 t.match(/\b(720p|1080p|4k|giây|fps|x[1-4]|16:9|9:16|1:1|4:3|3:4)\b/i) || t.match(/^\d+s/i);
        };

        // Cách A: Tìm anh em bên cạnh submitBtn
        if (submitBtn) {
           const sRect = submitBtn.getBoundingClientRect();
           let parent = submitBtn;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn || !isElemVisible(b)) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                return isSettingChipText(t);
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
                 const leftOfSubmit = buttonsHere.filter(b => {
                   if (b === submitBtn || !isElemVisible(b)) return false;
                   return b.getBoundingClientRect().left < sRect.left;
                 });
                 leftOfSubmit.sort((a, b) => Math.abs(sRect.left - a.getBoundingClientRect().right) - Math.abs(sRect.left - b.getBoundingClientRect().right));
                 const candidate = leftOfSubmit.find(b => {
                   const t = (b.textContent || "").trim().toLowerCase();
                   if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                   return true;
                 });
                 if (candidate) {
                   settingsChip = candidate;
                   break;
                 }
              }
           }
        }

        // Cách B: Tìm từ Editor đi lên các node cha của khung soạn thảo
        if (!settingsChip && editor) {
           let parent = editor;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn || !isElemVisible(b)) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                return isSettingChipText(t);
             });
             if (candidate) {
               settingsChip = candidate;
               break;
             }
           }
        }

        // Cách C: Quét toàn bộ nút trong vùng composer nửa dưới màn hình
        if (!settingsChip) {
          const candidates = composerButtons.filter(b => {
             if (b === submitBtn || !isElemVisible(b)) return false;
             if (b.closest("[data-media-id], [data-workflow-id], [class*='card'], [role='listitem']")) return false;
             const r = b.getBoundingClientRect();
             if (r.top < 120) return false;
             const t = (b.textContent || "").trim().toLowerCase();
             if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
             return isSettingChipText(t);
          });
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
            settingsChip = candidates[0];
          }
        }


        // Xóa prompt cũ trước khi cấu hình và đính kèm frame
        try {
          if (typeof editor.focus === 'function') editor.focus();
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
        } catch (_) {}

        // ──────────────────────────────────────────────
        // STEP 2: Configure Video Settings (Mode, Ratio, Duration, Count, Model)
        // ──────────────────────────────────────────────
        try {
          const targetRatio = cfg?.aspectRatio || "9:16";
          const targetDuration = cfg?.duration || "8s";
          const targetCount = cfg?.count || "x1";

          const safeClick = (el) => {
            if (!el) return false;
            el.scrollIntoView({ block: "nearest" });
            if (typeof el.click === "function") {
              el.click();
            } else {
              el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }
            return true;
          };

          const triggerClick = (el) => {
            if (!el) return false;
            const target = el.closest("button, [role='button'], [role='tab'], [role='radio'], [role='combobox'], [role='menuitem']") || el;
            target.scrollIntoView({ block: "nearest" });
            target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            if (typeof target.click === "function") {
              target.click();
            } else {
              target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }
            return true;
          };

          const safeToggle = async (el) => {
            if (!el) return;
            const target = el.closest("button, [role='combobox']") || el;
            target.scrollIntoView({ block: "nearest" });
            
            // Check if already expanded
            if (target.getAttribute("aria-expanded") === "true") return;
            
            // Try standard click
            try { target.click(); } catch (_) {}
            await sleep(300);
            
            if (target.getAttribute("aria-expanded") !== "true" && !document.querySelector("[role='listbox']")) {
                target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
                target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
                target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                if (typeof target.click === "function") target.click();
                else target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                await sleep(300);
            }
          };

          // Tìm tab "Video"
          const findVideoTabElement = () => {
            const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              if (r.width < 30 || r.height < 15) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

              const t = (el.textContent || "").trim();
              const aria = (el.getAttribute("aria-label") || "").trim();
              const id = (el.getAttribute("id") || "").toLowerCase();

              if (t.includes("Khung hình") || aria.includes("Khung hình") || t.includes("Hình ảnh") || aria.includes("Hình ảnh")) return false;
              if (t.includes("Video ·") || t.includes("giây") || t.includes("720p") || t.includes("1080p") || t.includes("fps")) return false;

              return t === "Video" || aria === "Video" || 
                     t.toLowerCase() === "video" || aria.toLowerCase() === "video" ||
                     id.endsWith("-trigger-video") || id.endsWith("-trigger-VIDEO") || 
                     (t.includes("Video") && t.length <= 10) ||
                     (aria.includes("Video") && aria.length <= 10);
            });

            if (candidates.length === 0) return null;

            let best = candidates.find(el => {
              const p = el.parentElement;
              if (p && (p.textContent.includes("Hình ảnh") || p.getAttribute("role") === "tablist")) return true;
              const gp = p?.parentElement;
              if (gp && (gp.textContent.includes("Hình ảnh") || gp.getAttribute("role") === "tablist")) return true;
              return false;
            });

            if (!best) {
              best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
            }

            return best.closest("[role='tab'], button, [role='button']") || best;
          };

          // Tìm tab "Hình ảnh"
          const findImageTabElement = () => {
            const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              if (r.width < 30 || r.height < 15) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

              const t = (el.textContent || "").trim();
              const aria = (el.getAttribute("aria-label") || "").trim();
              const id = (el.getAttribute("id") || "").toLowerCase();

              if (t.includes("Khung hình") || aria.includes("Khung hình")) return false;

              return t === "Hình ảnh" || aria === "Hình ảnh" || 
                     t.toLowerCase() === "image" || aria.toLowerCase() === "image" ||
                     id.endsWith("-trigger-image") || id.endsWith("-trigger-IMAGE") ||
                     (t.includes("Hình ảnh") && t.length <= 15) ||
                     (aria.includes("Hình ảnh") && aria.length <= 15);
            });

            if (candidates.length === 0) return null;

            let best = candidates.find(el => {
              const p = el.parentElement;
              if (p && (p.textContent.includes("Video") || p.getAttribute("role") === "tablist")) return true;
              const gp = p?.parentElement;
              if (gp && (gp.textContent.includes("Video") || gp.getAttribute("role") === "tablist")) return true;
              return false;
            });

            if (!best) {
              best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
            }

            return best.closest("[role='tab'], button, [role='button']") || best;
          };

          const isPopoverOpen = () => {
            if (findVideoTabElement() || findImageTabElement()) return true;
            const ratioBtn = queryDeep("button, [role='tab'], [role='radio']").find(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (el.textContent || "").trim();
              return t === "16:9" || t === "9:16";
            });
            return !!ratioBtn;
          };

          // Mở Popover 1 lần duy nhất (KHÔNG retry vì chip là toggle → click lần 2 sẽ đóng!)
          if (!isPopoverOpen() && settingsChip) {
            settingsChip.scrollIntoView({ block: "nearest" });
            settingsChip.click();
            await sleep(1000); // Đợi đủ lâu cho DOM render popover
          }

          // Helper to select the Video Tab
          const selectVideoTab = async () => {
            const tabEl = findVideoTabElement();
            if (tabEl) {
              const isActive = tabEl.getAttribute("data-state") === "active" || 
                               tabEl.getAttribute("aria-selected") === "true" ||
                               tabEl.classList.contains("active") ||
                               (tabEl.parentElement && tabEl.parentElement.getAttribute("data-state") === "active");
              if (!isActive) {
                safeClick(tabEl);
                await sleep(400);
              }
              return { success: true, el: tabEl };
            }
            return { success: false };
          };

          // Helper to select the Image Tab
          const selectImageTab = async () => {
            const tabEl = findImageTabElement();
            if (tabEl) {
              const isActive = tabEl.getAttribute("data-state") === "active" || 
                               tabEl.getAttribute("aria-selected") === "true" ||
                               tabEl.classList.contains("active") ||
                               (tabEl.parentElement && tabEl.parentElement.getAttribute("data-state") === "active");
              if (!isActive) {
                safeClick(tabEl);
                await sleep(400);
              }
              return { success: true, el: tabEl };
            }
            return { success: false };
          };

          // Helper to select the Khung hình (Frames) Tab
          const selectFramesTab = async () => {
            // Popover đã được mở từ trước → KHÔNG click lại chip (toggle sẽ đóng!)

            // Đảm bảo tab Video đã được kích hoạt trước
            await selectVideoTab();
            await sleep(400);

            const isFramesMatch = (el) => {
              if (!el) return false;
              const t = (el.textContent || "").trim();
              const tLower = t.toLowerCase();
              const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
              const id = (el.getAttribute("id") || "").toLowerCase();
              const dataVal = (el.getAttribute("data-value") || "").toLowerCase();
              const html = el.innerHTML || "";

              // Loại trừ các tab khác
              if (t === "Hình ảnh" || t === "Video" || aria === "video" || aria === "hình ảnh") return false;
              if (t === "Thành phần" || aria === "thành phần" || tLower.includes("thành phần") || aria.includes("thành phần")) return false;

              if (tLower === "khung hình" || tLower === "frames" || tLower === "frame") return true;
              if (aria === "khung hình" || aria === "frames" || aria.includes("khung hình") || aria.includes("frames")) return true;
              if (id.includes("video_frames") || id.includes("frames") || id.includes("frame")) return true;
              if (dataVal === "frames" || dataVal === "video_frames") return true;
              if (html.includes("crop_free") || tLower.includes("crop_free")) return true;
              if ((tLower.includes("khung hình") || tLower.includes("frames")) && t.length <= 25) return true;
              return false;
            };

            let target = null;
            let lastAvailable = "";

            for (let attempt = 0; attempt < 6; attempt++) {
              const allButtons = queryDeep("[role='tab'], button, [role='button']").filter(el => {
                if (!isElemVisible(el)) return false;
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                const r = el.getBoundingClientRect();
                return r.left >= 150;
              });

              target = allButtons.find(b => isFramesMatch(b));

              if (!target) {
                const subEls = queryDeep("span, div, svg, i, p").filter(el => {
                  if (!isElemVisible(el)) return false;
                  if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                  if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                  const r = el.getBoundingClientRect();
                  if (r.left < 150) return false;
                  const t = (el.textContent || "").trim();
                  return t.length <= 30 && isFramesMatch(el);
                });
                for (const sub of subEls) {
                  const pBtn = sub.closest("[role='tab'], button, [role='button']");
                  if (pBtn && isElemVisible(pBtn) && (!settingsChip || !settingsChip.contains(pBtn))) {
                    target = pBtn;
                    break;
                  }
                }
              }

              if (target) break;

              lastAvailable = allButtons.map(b => `[${b.tagName} role="${b.getAttribute("role")||""}" text="${(b.textContent||"").trim()}"]`).join(", ");
              await sleep(250);
            }

            if (target) {
              const clickable = target.closest("[role='tab'], button, [role='button']") || target;
              safeClick(clickable);
              await sleep(400);
              return { success: true, el: clickable };
            }

            return { success: false, available: lastAvailable };
          };

          // 1. Select Mode: "Video" vs "Hình ảnh"
          if (cfg?.mode === 'image' || cfg?.mode === 'Hình ảnh') {
            await selectImageTab();
            await sleep(400);
          } else {
            await selectVideoTab();
            await sleep(400);
          }

          // 1.5 If Khung hình (Frames / I2V) is requested, click "Khung hình" tab NOW
          if (cfg?.isFrames || cfg?.startImage || cfg?.endImage) {
            await selectFramesTab();
            await sleep(500);
          }

          // 2. Select Aspect Ratio (9:16 vs 16:9)
          const aspectButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
            if (!isElemVisible(el)) return false;
            if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
            if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
            const r = el.getBoundingClientRect();
            if (r.left < 150) return false;
            const t = (el.textContent || "").trim();
            return t.includes("16:9") || t.includes("9:16");
          });
          const aspectBtn = aspectButtons.find(b => {
            const t = (b.textContent || "").trim();
            const aria = (b.getAttribute("aria-label") || "").trim();
            const comb = t + " " + aria;
            if (targetRatio === "9:16") return comb.includes("9:16") && !comb.includes("16:9");
            return comb.includes("16:9");
          });
          if (aspectBtn) {
            safeClick(aspectBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || aspectBtn);
            await sleep(400);
          }

          // If in Video mode, configure Duration, Count & Video Model
          if (cfg?.mode !== 'image' && cfg?.mode !== 'Hình ảnh') {
            // 3. Select Duration: "8s"
            const durNum = targetDuration.replace(/\D/g, "");
            const durButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (el.textContent || "").trim().toLowerCase();
              return t.includes(durNum + "s") || t.includes(durNum + " giây") || t.includes(durNum + " sec") || t === durNum;
            });
            const durBtn = durButtons.find(b => {
              const t = (b.textContent || "").trim().toLowerCase();
              const others = ["4", "5", "6", "8", "10"].filter(x => x !== durNum);
              return !others.some(x => t.includes(x + "s") || t.includes(x + " giây"));
            });
            if (durBtn) {
              safeClick(durBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || durBtn);
              await sleep(400);
            }

            // 4. Select Count: "x1"
            const tc = targetCount.toLowerCase();
            const countButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (el.textContent || "").trim().toLowerCase();
              return t === tc || t.includes(tc) || (tc === "x1" && t === "1x");
            });
            const countBtn = countButtons.find(b => {
              const t = (b.textContent || "").trim().toLowerCase();
              const others = ["x1", "x2", "x3", "x4"].filter(x => x !== tc);
              return !others.some(x => t.includes(x));
            });
            if (countBtn) {
              safeClick(countBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || countBtn);
              await sleep(400);
            }

            // 5. Select Model:
            const modelDropdown = queryDeep("button, [role='combobox'], [role='button'], div").find(b => {
              if (!isElemVisible(b)) return false;
              if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
              if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              if (b.closest("[role='listbox'], [role='menu']")) return false; 
              const r = b.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (b.textContent || "").trim().toLowerCase();
              const isModelName = (t.includes("omni") || t.includes("veo") || t.includes("flash") || t.includes("lite") || t.includes("fast") || t.includes("quality")) && t.length < 50;
              const isExcluded = t.includes("9:16") || t.includes("16:9") || t.includes("8s") || t.includes("4s") || t.includes("6s") || t.includes("10s") || t.includes("video") || t.includes("hình ảnh") || t.includes("khung hình") || t.includes("thành phần");
              return isModelName && !isExcluded;
            });

            if (modelDropdown) {
              await safeToggle(modelDropdown);
              await sleep(400); // Give portal time to mount
            }

            const mTxt = (cfg?.model || "veo_3_1_lite_low_priority").toLowerCase();
            const isMatch = (el) => {
                if (el === modelDropdown || modelDropdown?.contains(el)) return false;
                const ot = (el.textContent || "").toLowerCase();
                if (ot.length > 80) return false;
                
                if (mTxt.includes("low_priority") || mTxt.includes("ưu tiên thấp")) {
                  return ot.includes("lower priority") || ot.includes("ưu tiên thấp") || ot.includes("lite [lower priority]") || ot.includes("lite (ưu tiên thấp)");
                }
                if (mTxt.includes("lite")) {
                  return (ot.includes("lite") && !ot.includes("lower priority") && !ot.includes("ưu tiên thấp"));
                }
                if (mTxt.includes("fast")) return ot.includes("fast") || ot.includes("nhanh");
                if (mTxt.includes("quality")) return ot.includes("quality") || ot.includes("chất lượng");
                if (mTxt.includes("abra") || mTxt.includes("omni")) return ot.includes("omni") || ot.includes("flash");
                return false;
            };

            let targetOpt = null;
            for (let attempt = 0; attempt < 15; attempt++) {
                const portalCandidates = queryDeep("[role='option'], [role='menuitem'], [role='tab'], button, div, span, li").filter(isElemVisible);
                const actualOptions = portalCandidates.filter(el => {
                  if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                  if (el === modelDropdown || modelDropdown?.contains(el)) return false;
                  if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                  if (el.hasAttribute("aria-haspopup") || el.getAttribute("role") === "combobox" || el.getAttribute("aria-expanded") === "true") return false;
                  return el.getAttribute("role") === "option" || el.getAttribute("role") === "menuitem" || el.closest("[role='listbox']");
                });
                if (actualOptions.length > 0) {
                  targetOpt = actualOptions.find(el => isMatch(el));
                  if (targetOpt) break;
                } else {
                  targetOpt = portalCandidates.find(el => {
                      if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                      if (el === modelDropdown || modelDropdown?.contains(el)) return false;
                      if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                      if (el.hasAttribute("aria-haspopup") || el.getAttribute("role") === "combobox" || el.getAttribute("aria-expanded") === "true") return false;
                      return isMatch(el);
                  });
                  if (targetOpt) break;
                }
                await sleep(100);
            }

            if (targetOpt) {
                const clickable = targetOpt.closest("[role='option'], [role='menuitem'], [role='tab'], button, li") || targetOpt;
                safeClick(clickable);
                await sleep(500);
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

              // Helper: Inject image via pure Auto Paste / DataTransfer into active editor
              const injectImageFile = async (imgData, filename = "frame.png") => {
                if (!imgData) return false;
                try {
                  let fileObj = null;
                  if (imgData.startsWith("data:") || imgData.startsWith("http://") || imgData.startsWith("https://") || imgData.startsWith("blob:")) {
                    const res = await fetch(imgData);
                    const blob = await res.blob();
                    fileObj = new File([blob], filename, { type: blob.type || "image/png" });
                  } else {
                    return false;
                  }

                  const dt = new DataTransfer();
                  dt.items.add(fileObj);

                  // 1. Thử chèn thẳng vào file input nếu có
                  const fileInputs = Array.from(document.querySelectorAll("input[type='file']"));
                  if (fileInputs.length > 0) {
                    try {
                      fileInputs[0].files = dt.files;
                      fileInputs[0].dispatchEvent(new Event("change", { bubbles: true }));
                    } catch (_) {}
                  }

                  // 2. Bắn Paste vào Active Element
                  const currentActive = getDeepActiveElement() || editor;
                  const pasteEvent = new ClipboardEvent("paste", {
                    clipboardData: dt,
                    bubbles: true,
                    cancelable: true
                  });
                  currentActive.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: false, metaKey: true, bubbles: true }));
                  currentActive.dispatchEvent(pasteEvent);

                  // 3. Thử Drop thẳng vào Active Element
                  const dropEvent = new DragEvent("drop", {
                    dataTransfer: dt,
                    bubbles: true,
                    cancelable: true
                  });
                  currentActive.dispatchEvent(dropEvent);
                  return true;
                } catch (e) {
                  console.warn("[Auto Paste Image Error]", e);
                  return false;
                }
              };

              // Helper to wait until Google Flow finishes uploading pasted image
              const waitForUploadToFinish = async (maxWaitMs = 25000) => {
                const startWait = Date.now();
                await sleep(800);
                while (Date.now() - startWait < maxWaitMs) {
                  const spinners = queryDeep("[role='progressbar'], [class*='spin'], [class*='loading'], svg.animate-spin, div[class*='spinner']").filter(isElemVisible);
                  if (spinners.length === 0 && (Date.now() - startWait >= 2000)) {
                    await sleep(600);
                    return true;
                  }
                  await sleep(400);
                }
                return false;
              };

              // 1. Attach Start Image (Bắt đầu)
              if (cfg?.startImage) {
                const pasted = await injectImageFile(cfg.startImage, `start_frame_${Date.now()}.png`);
                if (!pasted) {
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
                  }
                }
                await sleep(500); // Đợi ngắn trước khi paste end frame
              }

              // 2. Attach End Image (Kết thúc)
              if (cfg?.endImage) {
                await sleep(400);
                const pasted = await injectImageFile(cfg.endImage, `end_frame_${Date.now()}.png`);
                if (!pasted) {
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
                  }
                }
              }

              // 3. Đợi sau khi paste xong tất cả frame
              if (cfg?.startImage && cfg?.endImage) {
                await sleep(12000); // Có cả 2 frame → chờ 12s
              } else if (cfg?.startImage || cfg?.endImage) {
                await sleep(10000); // Chỉ 1 frame → chờ 10s
              }
            } catch (frameErr) {
              console.warn("[Flow Extension] Frame attach error:", frameErr);
            }
          }
        } catch (confErr) {
          console.warn("[Flow Extension] Config error:", confErr);
        }

        // ──────────────────────────────────────────────
        // STEP 3: Focus Editor & Type Prompt (Test B1)
        // ──────────────────────────────────────────────
        editor.scrollIntoView({ block: "center" });
        editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        editor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        editor.click();
        if (typeof editor.focus === 'function') editor.focus();
        editor.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
        await sleep(300);

        // Find non-void editable paragraph (avoiding image cards & placeholder)
        const editableParas = Array.from(editor.querySelectorAll("[data-slate-node='element'], p"))
          .filter(el => !el.closest("[data-slate-void='true']") && !el.hasAttribute("data-slate-void") && el.getAttribute("contenteditable") !== "false");
        const targetPara = editableParas.pop() || editor;

        targetPara.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        targetPara.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        targetPara.click();
        if (typeof targetPara.focus === 'function') targetPara.focus();
        await sleep(150);

        // Position cursor in editable leaf (excluding placeholder)
        try {
          const leaves = Array.from(targetPara.querySelectorAll("span[data-slate-string='true'], span[data-slate-leaf='true'], span[data-slate-zero-width]"))
            .filter(s => !s.closest("[contenteditable='false'], [data-slate-placeholder='true']"));
          const targetLeaf = leaves.pop() || targetPara;

          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(targetLeaf);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (selErr) {
          console.warn("[Flow Extension] Selection collapse error:", selErr);
        }
        await sleep(150);

        // Gõ prompt
        if (promptText) {
          editor.dispatchEvent(new InputEvent("beforeinput", {
            inputType: "insertText",
            data: promptText,
            bubbles: true,
            cancelable: true
          }));
          document.execCommand("insertText", false, promptText);
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(400);
        }

        // ──────────────────────────────────────────────
        // STEP 4: Submit Video (Click Arrow Button) (Test B3)
        // ──────────────────────────────────────────────
        // Đợi nút submit hết bị disabled do upload ảnh hoặc trạng thái chờ (tối đa 15s)
        let finalSubmit = null;
        for (let waitSubmit = 0; waitSubmit < 25; waitSubmit++) {
          const currentButtons = queryDeep("button, [role='button']").filter(isElemVisible);
          finalSubmit = currentButtons.find(b => {
            const inner = (b.innerHTML || "").toLowerCase();
            const t = (b.textContent || "").trim().toLowerCase();
            const aria = (b.getAttribute("aria-label") || "").toLowerCase();
            return inner.includes("arrow_forward") || inner.includes("send") || t === "arrow_forward" || t === "send" || aria.includes("tạo") || aria.includes("generate") || aria.includes("submit");
          }) || submitBtn;

          if (finalSubmit) {
            const isDisabled = finalSubmit.disabled || finalSubmit.getAttribute("aria-disabled") === "true";
            if (!isDisabled) {
              break; // Nút đã sẵn sàng bấm!
            }
          }
          await sleep(500);
        }

        const submitTimestamp = Date.now();
        if (finalSubmit) {
          finalSubmit.removeAttribute("disabled");
          finalSubmit.setAttribute("aria-disabled", "false");
          triggerClick(finalSubmit);
          await sleep(500);
        }

        const edRect = editor.getBoundingClientRect();
        const promptTyped = (editor.textContent || "").includes(promptText.slice(0, 8));

        // Snapshot toàn bộ Media ID đang có trong DOM trước khi bấm submit để loại trừ (kể cả ảnh frame vừa paste)
        const domMediaIdsBeforeSubmit = Array.from(document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id]"))
          .map(el => el.getAttribute("data-media-id") || el.getAttribute("data-workflow-id") || el.getAttribute("data-id"))
          .filter(Boolean);

        return {
          success: true,
          promptTyped: promptTyped,
          clickX: Math.round(edRect.left + 50),
          clickY: Math.round(edRect.bottom - 20),
          submitTimestamp: submitTimestamp,
          domMediaIdsBeforeSubmit: domMediaIdsBeforeSubmit,
          message: "Đã cấu hình, đính kèm ảnh, gõ prompt và click Submit!"
        };
      }
    });

// Kiểm tra lỗi từ executeScript
    if (results && results[0] && results[0].result && results[0].result.success === false) {
      logToBridge(`[Flow Recon] ⚠️ Lỗi UI: ${results[0].result.error}`);
      return { success: false, error: results[0].result.error };
    }

    // ──────────────────────────────────────────────
    // STEP 4B: Native Hardware Input & Enter via CDP (chrome.debugger)
    // ──────────────────────────────────────────────
    if (chrome.debugger) {
      try {
        await chrome.debugger.attach({ tabId: tab.id }, "1.3");
        await new Promise(r => setTimeout(r, 200));

        const uiRes = results?.[0]?.result;
        
        // 1. Kiểm tra xem prompt đã thực sự được gõ vào editor chưa
        let isPromptPresent = uiRes?.promptTyped;
        if (!isPromptPresent && prompt) {
          const checkText = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            args: [prompt],
            func: (pText) => {
              const ed = document.querySelector("div[role='textbox'][data-slate-editor='true']")
                      || document.querySelector("div[data-slate-editor='true']")
                      || document.querySelector("div[contenteditable='true']");
              const t = (ed?.textContent || "").trim();
              return t.includes(pText.slice(0, 8));
            }
          });
          isPromptPresent = checkText?.[0]?.result;
        }

        // 2. Nếu prompt CHƯA vào editor, dùng CDP Native Mouse Click & Input.insertText để gõ CHÍNH XÁC!
        if (!isPromptPresent && prompt) {
          logToBridge(`[Flow Recon] ✍️ Prompt chưa vào editor, kích hoạt CDP Native Hardware Input để gõ: "${prompt.slice(0, 30)}..."`);
          
          const clickX = uiRes?.clickX || 400;
          const clickY = uiRes?.clickY || 600;
          
          await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: clickX,
            y: clickY,
            button: "left",
            clickCount: 1
          });
          await new Promise(r => setTimeout(r, 60));
          await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: clickX,
            y: clickY,
            button: "left",
            clickCount: 1
          });
          await new Promise(r => setTimeout(r, 150));

          await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", {
            text: prompt
          });
          await new Promise(r => setTimeout(r, 400));
        }

        // 3. Trusted Hardware Enter (pure keypress WITHOUT \r text so it submits instead of inserting newline!)
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
        await new Promise(r => setTimeout(r, 400));

        // 4. Click Submit Button nếu vẫn còn hiển thị
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            const btns = Array.from(document.querySelectorAll("button, [role='button']"));
            const sBtn = btns.find(b => {
              const inner = (b.innerHTML || "").toLowerCase();
              const t = (b.textContent || "").trim().toLowerCase();
              return inner.includes("arrow_forward") || inner.includes("send") || t === "arrow_forward" || t === "send";
            });
            if (sBtn) {
              sBtn.removeAttribute("disabled");
              sBtn.setAttribute("aria-disabled", "false");
              sBtn.click();
            }
          }
        });

        await chrome.debugger.detach({ tabId: tab.id });
      } catch (dbgErr) {
        console.warn("[Flow Extension] Debugger CDP fallback:", dbgErr);
        try { await chrome.debugger.detach({ tabId: tab.id }); } catch (_) {}
      }
    }

    // ──────────────────────────────────────────────
    // RECON STEP B: Multi-Layer Recon to Identify Newly Created Video
    // ──────────────────────────────────────────────
    let newVideo = null;
    const effectiveSubmitTime = Date.now();

    // Snapshot ALL media IDs captured before or during image upload / submit to exclude them
    const preSubmitCapturedIds = new Set(beforeIds);
    if (results?.[0]?.result?.domMediaIdsBeforeSubmit) {
      for (const id of results[0].result.domMediaIdsBeforeSubmit) {
        preSubmitCapturedIds.add(id);
      }
    }
    const tabCapturedPre = tab?.id ? _capturedMediaByTab.get(tab.id) : null;
    if (tabCapturedPre) {
      for (const item of tabCapturedPre) {
        if (item.time <= effectiveSubmitTime + 400) {
          if (item.primaryId) preSubmitCapturedIds.add(item.primaryId);
          if (item.mediaIds) item.mediaIds.forEach(id => preSubmitCapturedIds.add(id));
          if (item.workflows) item.workflows.forEach(id => preSubmitCapturedIds.add(id));
        }
      }
    }
    logToBridge(`[Flow Recon] Bắt đầu theo dõi và nhận diện Media ID video mới (đã loại trừ ${preSubmitCapturedIds.size} IDs cũ & ảnh frame)...`);

    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 1 ? 1500 : 1200));

      // ── TẦNG 1: Kiểm tra Media ID bắt trực tiếp từ RPC response (YhhmEf, jwpduf, batchexecute) ──
      const tabCaptured = tab?.id ? _capturedMediaByTab.get(tab.id) : null;
      if (tabCaptured && tabCaptured.length > 0) {
        const fresh = tabCaptured.find(item => {
          if (!item.primaryId) return false;
          if (preSubmitCapturedIds.has(item.primaryId)) return false;
          if (item.mediaIds && item.mediaIds.some(id => preSubmitCapturedIds.has(id))) return false;
          return item.time >= effectiveSubmitTime - 500;
        });
        if (fresh && fresh.primaryId) {
          logToBridge(`[Flow Recon] Lần ${attempt}: 🎯 Bắt được Media ID video mới từ RPC [${fresh.rpcId || 'batchexecute'}]: ${fresh.primaryId}`);
          newVideo = {
            mediaId: fresh.primaryId,
            workflowId: fresh.workflows?.[0] || fresh.primaryId,
            videoUrl: fresh.videoUrls?.[0] || null,
            projectId: effectiveProjectId,
            prompt: prompt
          };
          break;
        }
      }

      // ── TẦNG 2: Kiểm tra biến toàn cục & DOM trực tiếp trên tab Flow ──
      try {
        const tabCheck = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          args: [effectiveSubmitTime, prompt, Array.from(preSubmitCapturedIds)],
          func: (startTime, promptText, excludedList) => {
            const excluded = new Set(excludedList || []);
            const recent = window.__flowRecentMedia || [];
            const fresh = recent.find(item => item.time >= startTime - 500 && item.primaryId && !excluded.has(item.primaryId));
            if (fresh && fresh.primaryId) {
              return { source: 'window.__flowRecentMedia', id: fresh.primaryId, videoUrl: fresh.videoUrls?.[0] || null };
            }

            // Check DOM attributes
            const allElements = document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id]");
            for (const el of allElements) {
              // LOẠI TRỪ: Các phần tử nằm trong composer, prompt editor, frame slot
              if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box'], [class*='frame-slot'], [class*='upload']")) {
                continue;
              }

              // LOẠI TRỪ: Thẻ chỉ chứa ảnh mà không có video/loading
              const hasVideo = el.querySelector("video");
              // Card mới tạo phải có spinner / chữ đang tạo HOẶC phải chứa nội dung prompt của task này!
              const promptSub = (promptText || "").trim().slice(0, 15).toLowerCase();
              const textMatchesPrompt = promptSub && text.includes(promptSub);

              if (!hasSpinner && !hasGeneratingText && !textMatchesPrompt) {
                continue; // Bỏ qua các card cũ đã hoàn thành từ trước
              }

              const mId = el.getAttribute("data-media-id");
              const wId = el.getAttribute("data-workflow-id") || el.getAttribute("data-id");
              const vEl = el.querySelector("video");
              const vUrl = vEl?.currentSrc || vEl?.src || null;
              if (mId && mId.length > 10 && !excluded.has(mId)) return { source: 'dom_data_media_id', id: mId, videoUrl: vUrl };
              if (wId && wId.length > 20 && /^[a-f0-9\-]{36}$/i.test(wId) && !excluded.has(wId)) return { source: 'dom_data_workflow_id', id: wId, videoUrl: vUrl };
            }

            // Check video elements
            const videos = document.querySelectorAll("video");
            for (const v of videos) {
              const src = v.currentSrc || v.src || "";
              if (src && !src.startsWith("blob:") && src.includes("http")) {
                const match = src.match(/media\/([a-f0-9\-]{36})/i) || src.match(/video\/([a-f0-9\-]{36})/i) || src.match(/name=([^&]+)/) || src.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
                if (match && !excluded.has(match[1])) return { source: 'dom_video_src', id: match[1], videoUrl: src };
              }
            }

            try {
              const savedId = sessionStorage.getItem('__flow_latest_media_id');
              const savedTime = parseInt(sessionStorage.getItem('__flow_latest_media_time') || '0', 10);
              if (savedId && savedTime >= startTime - 500 && !excluded.has(savedId)) {
                return { source: 'session_storage', id: savedId };
              }
            } catch (_) {}

            return null;
          }
        });

        const resCheck = tabCheck?.[0]?.result;
        if (resCheck?.id) {
          logToBridge(`[Flow Recon] Lần ${attempt}: 🎯 Tìm thấy Media ID từ ${resCheck.source}: ${resCheck.id}`);
          newVideo = {
            mediaId: resCheck.id,
            workflowId: resCheck.id,
            videoUrl: resCheck.videoUrl || null,
            projectId: effectiveProjectId,
            prompt: prompt
          };
          break;
        }
      } catch (domErr) {}

      // ── TẦNG 3: Fallback qua getProjectVideos (được fetch trong chính context của tab) ──
      try {
        const afterData = await getProjectVideos(effectiveProjectId, tab);
        if (afterData?.success) {
          // Chỉ kiểm tra danh sách videos, KHÔNG kiểm tra images để tránh bắt nhầm frame ảnh
          const allVideos = afterData.videos || [];
          const diff = allVideos.filter(v => {
            const id = v.mediaId || v.workflowId;
            return id && !preSubmitCapturedIds.has(id);
          });
          if (diff.length > 0) {
            newVideo = diff.find(v => (v.prompt || "").toLowerCase().includes(prompt.slice(0, 15).toLowerCase())) || diff[0];
            const foundId = newVideo.mediaId || newVideo.workflowId;
            logToBridge(`[Flow Recon] Lần ${attempt}: 🎯 Phát hiện video mới từ getProjectVideos: ${foundId}`);
            break;
          }
        }
      } catch (err) {}
    }

    if (!newVideo) {
      logToBridge(`[Flow Recon] ⚠️ Chưa tóm được ID ngay sau submit, sẽ theo dõi video theo Prompt & Thư viện...`);
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

    return results?.[0]?.result || {
      success: true,
      message: "Đã thực thi click UI",
      newVideo: {
        mediaId: null,
        prompt: prompt,
        projectId: effectiveProjectId
      }
    };
  } catch (err) {
    return { success: false, error: "Lỗi tương tác UI: " + err.message };
  }
}

// ══════════════════════════════════════
// 3b. Create Image via UI Automation (Tab: Auto Click Ảnh)
// ══════════════════════════════════════
async function createImageUI(prompt, projectId, config = {}) {
  // Tìm tab Flow cho Ảnh (hoặc tab Flow bất kỳ đang mở)
  const tab = await getFlowTab('image', projectId) || await getFlowTab('video', projectId);
  if (!tab) return { success: false, error: "Cần mở ít nhất một tab Google Flow để tạo ảnh!" };

  try {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 400));
  } catch (_) {}

  logToBridge(`[Flow Recon] Sử dụng Tab (ID: ${tab.id}) để thực hiện Auto Click Ảnh...`);

  const urlMatch = tab.url?.match(/project\/([a-zA-Z0-9_-]+)/);
  const effectiveProjectId = (urlMatch && urlMatch[1]) ? urlMatch[1] : projectId;

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

        const isElemVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden";
        };

        const safeClick = (el) => {
          if (!el) return false;
          el.scrollIntoView({ block: "nearest" });
          if (typeof el.click === "function") {
            el.click();
          } else {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          return true;
        };

        const triggerPointerClick = (el) => {
          if (!el) return false;
          el.scrollIntoView({ block: "nearest" });
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          if (typeof el.click === "function") {
            el.click();
          } else {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          return true;
        };

        // 1. Tìm ô Editor
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

        let editor = document.querySelector("div[role='textbox'][data-slate-editor='true']")
                  || document.querySelector("div[data-slate-editor='true']")
                  || document.querySelector("div[contenteditable='true'][role='textbox']")
                  || document.querySelector("div[contenteditable='true']")
                  || findDeepEditor();

        if (!editor) return { success: false, error: "Không tìm thấy ô nhập prompt trên giao diện Flow!" };

        // 2. Tìm nút Submit (hỗ trợ type=submit, aria-label, svg icon, text arrow/send)
        const composerButtons = queryDeep("button, [role='button']");
        let submitBtn = composerButtons.find(b => {
          if (!isElemVisible(b)) return false;
          const inner = (b.innerHTML || "").toLowerCase();
          const t = (b.textContent || "").trim().toLowerCase();
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          if (b.getAttribute("type") === "submit") return true;
          if (aria.includes("tạo") || aria.includes("generate") || aria.includes("submit") || aria.includes("send") || aria.includes("gửi") || aria.includes("bắt đầu")) return true;
          return inner.includes("arrow_forward") || inner.includes("send") || t === "arrow_forward" || t === "send" ||
                 Boolean(b.querySelector("svg.lucide-arrow-right, svg.lucide-send, svg.lucide-arrow-up, svg[data-icon='send'], svg[data-icon='arrow-right'], svg[data-icon='arrow-up']"));
        });

        // Dự phòng: Tìm submitBtn từ editor (nút ngoài cùng bên phải trong khung soạn thảo)
        if (!submitBtn && editor) {
          let parent = editor;
          for (let i = 0; i < 8 && parent; i++) {
            parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
            if (!parent) break;
            const buttonsHere = queryScopeDeep(parent, "button, [role='button']").filter(b => isElemVisible(b));
            if (buttonsHere.length > 0) {
              const sorted = [...buttonsHere].sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
              const candidate = sorted.find(b => {
                const t = (b.textContent || "").trim().toLowerCase();
                const aria = (b.getAttribute("aria-label") || "").toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add") || aria.includes("tác nhân") || aria.includes("agent")) return false;
                if (t.includes("video") || t.includes("ảnh") || t.includes("image") || t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.match(/\b(720p|1080p|4k|giây|fps|16:9|9:16)\b/i) || t.match(/^\d+s/i)) return false;
                return true;
              });
              if (candidate) {
                submitBtn = candidate;
                break;
              }
            }
          }
        }

        // 3. Tìm Settings Chip (nằm cạnh submitBtn hoặc dưới ô prompt)
        let settingsChip = null;
        const isSettingChipText = (t) => {
          if (!t) return false;
          return t.includes("video") || t.includes("ảnh") || t.includes("image") || 
                 t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.includes("veo") ||
                 t.match(/\b(720p|1080p|4k|giây|fps|x[1-4]|16:9|9:16|1:1|4:3|3:4)\b/i) || t.match(/^\d+s/i);
        };

        // Cách A: Tìm anh em bên cạnh submitBtn
        if (submitBtn) {
           const sRect = submitBtn.getBoundingClientRect();
           let parent = submitBtn;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn || !isElemVisible(b)) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                return isSettingChipText(t);
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
                 const leftOfSubmit = buttonsHere.filter(b => {
                   if (b === submitBtn || !isElemVisible(b)) return false;
                   return b.getBoundingClientRect().left < sRect.left;
                 });
                 leftOfSubmit.sort((a, b) => Math.abs(sRect.left - a.getBoundingClientRect().right) - Math.abs(sRect.left - b.getBoundingClientRect().right));
                 const candidate = leftOfSubmit.find(b => {
                   const t = (b.textContent || "").trim().toLowerCase();
                   if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                   return true;
                 });
                 if (candidate) {
                   settingsChip = candidate;
                   break;
                 }
              }
           }
        }

        // Cách B: Tìm từ Editor đi lên các node cha của khung soạn thảo
        if (!settingsChip && editor) {
           let parent = editor;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn || !isElemVisible(b)) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                return isSettingChipText(t);
             });
             if (candidate) {
               settingsChip = candidate;
               break;
             }
           }
        }

        // Cách C: Quét toàn bộ nút trong vùng composer nửa dưới màn hình
        if (!settingsChip) {
          const candidates = composerButtons.filter(b => {
             if (b === submitBtn || !isElemVisible(b)) return false;
             if (b.closest("[data-media-id], [data-workflow-id], [class*='card'], [role='listitem']")) return false;
             const r = b.getBoundingClientRect();
             if (r.top < 120) return false;
             const t = (b.textContent || "").trim().toLowerCase();
             if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
             return isSettingChipText(t);
          });
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
            settingsChip = candidates[0];
          }
        }

        // Tìm tab "Hình ảnh"
        const findImageTabElement = () => {
          const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
            if (!isElemVisible(el)) return false;
            if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
            const r = el.getBoundingClientRect();
            if (r.left < 150) return false;
            if (r.width < 30 || r.height < 15) return false;
            if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

            const t = (el.textContent || "").trim();
            const aria = (el.getAttribute("aria-label") || "").trim();
            const id = (el.getAttribute("id") || "").toLowerCase();

            if (t.includes("Khung hình") || aria.includes("Khung hình")) return false;

            return t === "Hình ảnh" || aria === "Hình ảnh" || 
                   t.toLowerCase() === "image" || aria.toLowerCase() === "image" ||
                   id.endsWith("-trigger-image") || id.endsWith("-trigger-IMAGE") ||
                   (t.includes("Hình ảnh") && t.length <= 15) ||
                   (aria.includes("Hình ảnh") && aria.length <= 15);
          });

          if (candidates.length === 0) return null;

          let best = candidates.find(el => {
            const p = el.parentElement;
            if (p && (p.textContent.includes("Video") || p.getAttribute("role") === "tablist")) return true;
            const gp = p?.parentElement;
            if (gp && (gp.textContent.includes("Video") || gp.getAttribute("role") === "tablist")) return true;
            return false;
          });

          if (!best) {
            best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
          }

          return best.closest("[role='tab'], button, [role='button']") || best;
        };

        const isPopoverOpen = () => {
          if (findImageTabElement()) return true;
          const ratioBtn = queryDeep("button, [role='tab'], [role='radio']").find(el => {
            if (!isElemVisible(el)) return false;
            if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
            if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
            const r = el.getBoundingClientRect();
            if (r.left < 150) return false;
            const t = (el.textContent || "").trim();
            return t === "16:9" || t === "9:16";
          });
          return !!ratioBtn;
        };

        // ──────────────────────────────────────────────
        // BƯỚC 1: Điền Prompt vào Editor
        // ──────────────────────────────────────────────
        editor.scrollIntoView({ block: "center" });
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, promptText || "");
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(350);

        // ──────────────────────────────────────────────
        // BƯỚC 2: Mở Cài Đặt (DÙNG CHÍNH TEST B2: click nút settingsChip)
        // ──────────────────────────────────────────────
        if (!isPopoverOpen() && settingsChip) {
          settingsChip.click(); // Đúng như Test B2!
          await sleep(600);
          if (!isPopoverOpen()) {
            settingsChip.click();
            await sleep(600);
          }
        }

        // ──────────────────────────────────────────────
        // BƯỚC 3: Chọn Tab "Hình ảnh"
        // ──────────────────────────────────────────────
        const tabEl = findImageTabElement();
        if (tabEl) {
          const isActive = tabEl.getAttribute("data-state") === "active" || 
                           tabEl.getAttribute("aria-selected") === "true" ||
                           tabEl.classList.contains("active") ||
                           (tabEl.parentElement && tabEl.parentElement.getAttribute("data-state") === "active");
          if (!isActive) {
            safeClick(tabEl);
            await sleep(400);
          }
        }

        // ──────────────────────────────────────────────
        // BƯỚC 4: Chọn Tỉ Lệ Ảnh
        // ──────────────────────────────────────────────
        const targetRatio = (cfg?.aspectRatio || "9:16").trim();
        const ratioButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
          if (!isElemVisible(el)) return false;
          if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
          if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
          const r = el.getBoundingClientRect();
          if (r.left < 150) return false;
          const t = (el.textContent || "").trim();
          return t.includes("16:9") || t.includes("4:3") || t.includes("1:1") || t.includes("3:4") || t.includes("9:16");
        });

        const targetRBtn = ratioButtons.find(b => {
          const t = (b.textContent || "").trim();
          const aria = (b.getAttribute("aria-label") || "").trim();
          const combined = t + " " + aria;
          if (targetRatio === "9:16") return combined.includes("9:16") && !combined.includes("16:9");
          if (targetRatio === "16:9") return combined.includes("16:9");
          if (targetRatio === "1:1") return combined.includes("1:1");
          if (targetRatio === "4:3") return combined.includes("4:3") && !combined.includes("3:4");
          if (targetRatio === "3:4") return combined.includes("3:4") && !combined.includes("4:3");
          return combined.includes(targetRatio);
        });

        if (targetRBtn) {
          safeClick(targetRBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || targetRBtn);
          await sleep(350);
        }

        // ──────────────────────────────────────────────
        // BƯỚC 5: Chọn Model Ảnh (Nano Banana)
        // ──────────────────────────────────────────────
        const targetModel = cfg?.model || "banana_pro";
        
        const isMatch = (text, requestedModel) => {
          const tl = (text || "").toLowerCase().trim();
          const req = (requestedModel || "banana_pro").toLowerCase().trim();
          if (req.includes("lite") || req.includes("2_lite") || req.includes("2 lite")) {
            return tl.includes("lite");
          }
          if (req.includes("banana 2") || req.includes("banana_2")) {
            return (tl.includes("banana 2") || tl.includes("nano banana 2")) && !tl.includes("lite");
          }
          // Default / banana_pro
          return (tl.includes("pro") || tl.includes("banana pro")) && !tl.includes("banana 2") && !tl.includes("lite");
        };

        const findModelDropdown = () => {
          const candidates = queryDeep("button, [role='combobox'], [role='button']").filter(b => {
            if (!isElemVisible(b)) return false;
            if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
            if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
            if (b.closest("[role='listbox'], [role='menu']")) return false;
            const r = b.getBoundingClientRect();
            if (r.left < 150 || r.width < 50 || r.height < 20) return false;
            const t = (b.textContent || "").trim().toLowerCase();
            const isModel = (t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.includes("imagen")) && t.length < 50;
            const isExcluded = t.includes("16:9") || t.includes("9:16") || t.includes("1:1") || t.includes("4:3") || t.includes("3:4") || t.includes("x1") || t.includes("x2") || t.includes("x3") || t.includes("x4") || t.includes("video") || t.includes("hình ảnh");
            return isModel && !isExcluded;
          });
          if (candidates.length > 0) return candidates[0];

          const divCandidates = queryDeep("div[role='button'], div").filter(b => {
            if (!isElemVisible(b)) return false;
            if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
            if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
            if (b.closest("[role='listbox'], [role='menu']")) return false;
            const r = b.getBoundingClientRect();
            if (r.left < 150 || r.width < 50 || r.height < 20) return false;
            const t = (b.textContent || "").trim().toLowerCase();
            const isModel = (t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.includes("imagen")) && t.length < 50;
            const isExcluded = t.includes("16:9") || t.includes("9:16") || t.includes("1:1") || t.includes("4:3") || t.includes("3:4") || t.includes("x1") || t.includes("x2") || t.includes("x3") || t.includes("x4") || t.includes("video") || t.includes("hình ảnh");
            return isModel && !isExcluded;
          });
          if (divCandidates.length > 0) {
            const best = divCandidates.find(d => d.getAttribute("role") === "button") || divCandidates[divCandidates.length - 1];
            return best.closest("button, [role='combobox'], [role='button']") || best;
          }
          return null;
        };

        const modelDropdown = findModelDropdown();
        let selectedModelText = targetModel;

        if (modelDropdown) {
          const currentText = (modelDropdown.textContent || "").trim();
          selectedModelText = currentText;

          if (!isMatch(currentText, targetModel)) {
            const btn = modelDropdown.closest("button, [role='combobox'], [role='button']") || modelDropdown;
            btn.scrollIntoView({ block: "nearest" });

            // Click mở dropdown (chỉ 1 lần native click như Test B2)
            btn.click();
            await sleep(400);

            const checkMenuOpen = () => {
              const items = queryDeep("[role='option'], [role='menuitem'], li, button, div, span").filter(isElemVisible);
              return items.some(el => {
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el === modelDropdown || modelDropdown.contains(el)) return false;
                const t = (el.textContent || "").trim();
                return t.length >= 4 && t.length <= 35 && (t.includes("Banana") || t.includes("Nano"));
              });
            };

            if (!checkMenuOpen()) {
              btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              await sleep(400);
            }

            let targetOpt = null;
            for (let attempt = 0; attempt < 15; attempt++) {
              const portalCandidates = queryDeep("[role='option'], [role='menuitem'], button, [role='button'], li, div, span").filter(isElemVisible);
              const actualOptions = portalCandidates.filter(el => {
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el === modelDropdown || modelDropdown.contains(el)) return false;
                if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                const t = (el.textContent || "").trim();
                if (t.length < 4 || t.length > 35) return false;
                const tl = t.toLowerCase();
                return tl.includes("banana") || tl.includes("nano");
              });

              if (actualOptions.length > 0) {
                targetOpt = actualOptions.find(el => isMatch((el.textContent || "").trim(), targetModel));
                if (targetOpt) break;
              }
              await sleep(150);
            }

            if (targetOpt) {
              const clickable = targetOpt.closest("[role='option'], [role='menuitem'], button, [role='button'], li") || targetOpt;
              triggerPointerClick(clickable);
              await sleep(400);
              selectedModelText = (clickable.textContent || "").trim();
            }
          }
        }

        // ──────────────────────────────────────────────
        // BƯỚC 6: Chọn Số Lượng Ảnh
        // ──────────────────────────────────────────────
        const targetCount = (cfg?.count || "x1").toLowerCase().trim();
        const countButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(b => {
          if (!isElemVisible(b)) return false;
          if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
          if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
          const r = b.getBoundingClientRect();
          if (r.left < 150) return false;
          const t = (b.textContent || "").trim().toLowerCase();
          return t === "x1" || t === "x2" || t === "x3" || t === "x4" || t === "1x" || t === "2x" || t === "3x" || t === "4x";
        });

        const countBtn = countButtons.find(b => {
          const t = (b.textContent || "").trim().toLowerCase();
          if (targetCount === "x1" || targetCount === "1x") return t === "x1" || t === "1x";
          if (targetCount === "x2" || targetCount === "2x") return t === "x2" || t === "2x";
          if (targetCount === "x3" || targetCount === "3x") return t === "x3" || t === "3x";
          if (targetCount === "x4" || targetCount === "4x") return t === "x4" || t === "4x";
          return t === targetCount;
        });

        if (countBtn) {
          safeClick(countBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || countBtn);
          await sleep(350);
        }

        // ──────────────────────────────────────────────
        // BƯỚC 7: Đóng Popover Cài Đặt
        // ──────────────────────────────────────────────
        await sleep(300);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        await sleep(300);
        try {
          if (editor) {
            editor.click();
            editor.focus();
          }
        } catch (_) {}
        await sleep(200);
        if (isPopoverOpen() && settingsChip) {
          settingsChip.click();
          await sleep(300);
        }

        // ──────────────────────────────────────────────
        // BƯỚC 8: Bấm Nút Submit Tạo Ảnh (CHỈ CLICK 1 LẦN DUY NHẤT)
        // ──────────────────────────────────────────────
        if (!submitBtn) return { success: false, error: "Không tìm thấy nút Submit tạo ảnh" };

        for (let waitSub = 0; waitSub < 15; waitSub++) {
          const isDisabled = submitBtn.disabled || submitBtn.getAttribute("aria-disabled") === "true";
          if (!isDisabled) break;
          await sleep(200);
        }

        submitBtn.removeAttribute("disabled");
        submitBtn.setAttribute("aria-disabled", "false");
        submitBtn.click(); // Đúng chuẩn Test B3: Click đúng 1 lần duy nhất!
        await sleep(500);

        return {
          success: true,
          message: `Đã cấu hình [${targetRatio} | ${selectedModelText || targetModel} | ${targetCount}], điền prompt và bấm Submit tạo ảnh!`,
          config: {
            aspectRatio: targetRatio,
            model: selectedModelText || targetModel,
            count: targetCount
          }
        };
      }
    });

    const res = results?.[0]?.result;
    if (res && res.success === false) {
      return { success: false, error: res.error };
    }

    return res || { success: true, message: "Đã thực thi tạo ảnh trên Flow!" };
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

let _pendingServerVideoTasks = [];

function getPendingServerTasks() {
  const tasks = [..._pendingServerVideoTasks];
  _pendingServerVideoTasks = [];
  return { success: true, tasks };
}

function reportToolVideoResult(req) {
  if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
    _toolWs.send(JSON.stringify({
      type: 'VIDEO_RESULT',
      id: req.id,
      ok: Boolean(req.ok),
      filePath: req.filePath || null,
      error: req.error || null,
      mediaId: req.mediaId || null
    }));
    logToBridge(`[Bridge] Đã gửi VIDEO_RESULT về tool_video: ID=${req.id}, OK=${req.ok}, filePath=${req.filePath || 'none'}`);
    return { success: true };
  }
  return { success: false, error: "WebSocket to tool_video not connected" };
}

function enqueueServerVideoTask(task) {
  logToBridge(`[Bridge] Chuyển task video ${task.id} vào hàng đợi Auto Click UI trên Sidepanel...`);

  chrome.runtime.sendMessage({
    action: 'ADD_SERVER_TASK_TO_UI_BATCH',
    task: task
  }).then(res => {
    if (!res?.success) {
      _pendingServerVideoTasks.push(task);
    }
  }).catch(() => {
    _pendingServerVideoTasks.push(task);
  });

  // Tự động mở Sidepanel nếu có thể
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => {
      if (tabs.length && tabs[0].windowId) {
        chrome.sidePanel.open({ windowId: tabs[0].windowId }).catch(() => {});
      }
    }).catch(() => {});
  }
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
      // ĐẢM BẢO ĐÁNH SỐ THỨ TỰ 001., 002. ĐẦU PROMPT
      let prompt = (task.prompt || '').trim();
      let seqStr = "";
      const matchSeq = prompt.match(/^(\d{1,4})[\.\-_:\s]/);
      if (matchSeq) {
        const num = parseInt(matchSeq[1], 10);
        seqStr = String(num).padStart(3, '0') + ".";
        prompt = prompt.replace(/^(\d{1,4})[\.\-_:\s]\s*/, `${seqStr} `);
      } else if (task.sceneIndex !== undefined && task.sceneIndex !== null && !isNaN(Number(task.sceneIndex))) {
        const num = Number(task.sceneIndex) + 1;
        seqStr = String(num).padStart(3, '0') + ".";
        prompt = `${seqStr} ${prompt}`;
        await updateMaxSeq(task.projectId, num);
      } else {
        const seqRes = await getMaxSeq(task.projectId);
        const nextSeq = (seqRes?.maxSeq || 0) + 1;
        await updateMaxSeq(task.projectId, nextSeq);
        seqStr = String(nextSeq).padStart(3, '0') + ".";
        prompt = `${seqStr} ${prompt}`;
      }
      task.prompt = prompt;
      task.seq = seqStr;

      logToBridge(`Bắt đầu xử lý task video cho tool_video: ${task.id} (prompt: "${(task.prompt || '').slice(0, 30)}...")`);
      
      const hasFrames = Boolean(task.startImage || task.endImage || task.isFrames);
      const config = {
        aspectRatio: task.aspectRatio || '9:16',
        duration: task.duration || '8s',
        count: task.count || 'x1',
        model: task.model || 'veo_3_1_lite_low_priority',
        isFrames: hasFrames,
        hasBothFrames: Boolean(task.startImage && task.endImage),
        startImage: task.startImage || null,
        endImage: task.endImage || null
      };

      // Thực thi Pure Auto Click UI (chọn tab Video/Khung hình, cấu hình thông số, dán ảnh, gõ prompt, submit)
      logToBridge(`[Video Engine] Thực thi Pure Auto Click UI cho task ${task.id}...`);
      const res = await createVideoUI(task.prompt, task.projectId, config);
      if (!res?.success) {
        throw new Error(res?.error || 'Không thể click tạo video trên UI Flow');
      }

      const newVideo = res.newVideo;
      const mediaId = newVideo?.mediaId || null;
      logToBridge(`Task ${task.id} đã click submit thành công trên Flow! ${mediaId ? 'Media ID: ' + mediaId : 'Tiến hành theo dõi trạng thái qua prompt & thư viện...'}`);

      // 2. Spawn async poll & download worker for this task in parallel (chuyển cả prompt để fallback)
      pollAndDeliverVideo(task.id, mediaId, task.projectId || newVideo?.projectId, task.prompt);

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
      // ĐẢM BẢO ĐÁNH SỐ THỨ TỰ 001., 002. ĐẦU PROMPT
      let prompt = (task.prompt || '').trim();
      let seqStr = "";
      const matchSeq = prompt.match(/^(\d{1,4})[\.\-_:\s]/);
      if (matchSeq) {
        const num = parseInt(matchSeq[1], 10);
        seqStr = String(num).padStart(3, '0') + ".";
        prompt = prompt.replace(/^(\d{1,4})[\.\-_:\s]\s*/, `${seqStr} `);
      } else if (task.sceneIndex !== undefined && task.sceneIndex !== null && !isNaN(Number(task.sceneIndex))) {
        const num = Number(task.sceneIndex) + 1;
        seqStr = String(num).padStart(3, '0') + ".";
        prompt = `${seqStr} ${prompt}`;
        await updateMaxSeq(task.projectId, num);
      } else {
        const seqRes = await getMaxSeq(task.projectId);
        const nextSeq = (seqRes?.maxSeq || 0) + 1;
        await updateMaxSeq(task.projectId, nextSeq);
        seqStr = String(nextSeq).padStart(3, '0') + ".";
        prompt = `${seqStr} ${prompt}`;
      }
      task.prompt = prompt;
      task.seq = seqStr;

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
  let url = target;
  if (!url || typeof url !== 'string' || !url.startsWith('http') || url.includes('labs.google')) {
    const mId = target || '';
    url = `https://flow-content.google/video/${encodeURIComponent(mId)}`;
  }
  const fname = filename || `flow_${Date.now()}.mp4`;

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
            // Kiểm tra tính hợp lệ: Nếu Chrome tải về file lỗi .xml, .html (NoSuchKey/404) hoặc dung lượng quá nhỏ
            if (item.filename?.endsWith('.xml') || item.filename?.endsWith('.html') || (item.fileSize && item.fileSize < 5000)) {
              clearInterval(timer);
              clearTimeout(timeout);
              try { chrome.downloads.erase({ id: item.id }); } catch (_) {}
              return reject(new Error(`File tải về từ Flow không phải video (${item.filename}, ${item.fileSize} bytes) - video chưa sẵn sàng`));
            }
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

// ══════════════════════════════════════════════════════════════════
// Direct Image Download Automation (Extract Original High-Res Image & Download Instantly)
// ══════════════════════════════════════════════════════════════════
async function downloadImageCardDirect(tabId, query = "001.", promptText = "", mediaId = "", workflowId = "", fallbackImgSrc = null, projectId = "") {
  let targetTabId = tabId;
  if (!targetTabId) {
    const tab = await getFlowTab('image', projectId) || await getFlowTab('video', projectId);
    targetTabId = tab?.id;
  }
  if (!targetTabId) return { success: false, error: "Không tìm thấy tab Google Flow đang mở" };

  try {
    // 1. Focus tab Flow
    try {
      await chrome.tabs.update(targetTabId, { active: true });
    } catch (_) {}

    // 2. Tìm thẻ card và trích xuất URL ảnh chất lượng cao gốc từ DOM của Tab
    const extractRes = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      world: "MAIN",
      args: [query, promptText || "", mediaId || "", workflowId || "", fallbackImgSrc || ""],
      func: async (q, pText, mId, wId, fbSrc) => {
        const cleanQuery = (q || "001.").trim().toLowerCase();
        const numOnly = cleanQuery.replace(/[^0-9]/g, "");
        const targetMediaId = (mId || "").trim();
        const targetWorkflowId = (wId || "").trim();
        const promptFull = (pText || "").trim().toLowerCase();

        let matchedCard = null;

        // ƯU TIÊN 1: Theo Media ID / Workflow ID
        if (targetMediaId || targetWorkflowId) {
          const all = Array.from(document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id], div[class*='card'], div[class*='item'], img"));
          for (const el of all) {
            const elMId = el.getAttribute("data-media-id") || "";
            const elWId = el.getAttribute("data-workflow-id") || el.getAttribute("data-id") || "";
            const src = el.src || el.currentSrc || "";
            if ((targetMediaId && (elMId === targetMediaId || src.includes(targetMediaId))) ||
                (targetWorkflowId && (elWId === targetWorkflowId || src.includes(targetWorkflowId)))) {
              let cur = el;
              while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
                const r = cur.getBoundingClientRect();
                if (r.width > 480 || r.height > 650) break;
                cur = cur.parentElement;
              }
              matchedCard = cur;
              break;
            }
          }
        }

        // ƯU TIÊN 2: Theo text STT / query
        if (!matchedCard) {
          const candidateTextEls = Array.from(
            document.querySelectorAll("p, span, div, h1, h2, h3, h4, button, b, strong, [aria-label]")
          ).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
            const t = (el.innerText || el.textContent || "").trim().toLowerCase();
            const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
            const combined = t + " " + aria;
            if (!combined.trim()) return false;
            if (combined.includes(cleanQuery)) return true;
            if (numOnly && cleanQuery.includes(".") && combined.includes(numOnly)) return true;
            return false;
          });

          if (candidateTextEls.length > 0) {
            candidateTextEls.sort((a, b) => (a.innerText || a.textContent || "").length - (b.innerText || b.textContent || "").length);
            const promptEl = candidateTextEls[0];
            let card = promptEl;
            let cur = promptEl.parentElement;
            while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
              const r = cur.getBoundingClientRect();
              if (r.width > 480 || r.height > 650) break;
              card = cur;
              cur = cur.parentElement;
            }
            matchedCard = card;
          }
        }

        // ƯU TIÊN 3: Semantic keywords của prompt
        if (!matchedCard && promptFull) {
          const words = promptFull.replace(/^\d+[\.\-_:\s]+/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 4);
          if (words.length > 0) {
            const cards = Array.from(document.querySelectorAll("div, [role='listitem']")).filter(el => {
              if (el.closest("[data-slate-editor], form, [class*='composer']")) return false;
              const r = el.getBoundingClientRect();
              return r.width >= 100 && r.width <= 480 && r.height >= 120 && r.height <= 650 && Boolean(el.querySelector("img"));
            });
            let bestCard = null;
            let maxScore = 0;
            for (const c of cards) {
              const cText = (c.innerText || c.textContent || "").toLowerCase();
              const score = words.filter(w => cText.includes(w)).length;
              if (score > maxScore && score >= 1) {
                maxScore = score;
                bestCard = c;
              }
            }
            if (bestCard) matchedCard = bestCard;
          }
        }

        // Tìm ảnh thật trong card
        let targetImg = null;
        let imgSrc = fbSrc || null;

        if (matchedCard) {
          matchedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // ─── INJECT PERSISTENT SEQ BADGE (IMAGE) ───
          try {
            const seqDisplay = cleanQuery.replace(/[\.\-_:\s]+$/g, '').trim();
            if (seqDisplay) {
              const _mRect = matchedCard.getBoundingClientRect();
              if (_mRect.width > 450 || _mRect.height > 500) throw new Error('skip');
              const pos = getComputedStyle(matchedCard).position;
              if (pos === 'static') matchedCard.style.position = 'relative';
              matchedCard.style.outline = '3px solid #10b981';
              matchedCard.style.outlineOffset = '-1px';
              matchedCard.setAttribute('data-flow-seq', seqDisplay);
              matchedCard.setAttribute('data-flow-seq-status', 'READY');
              let badge = matchedCard.querySelector('[data-flow-seq-badge]');
              if (!badge) {
                badge = document.createElement('div');
                badge.setAttribute('data-flow-seq-badge', 'true');
                badge.style.cssText = 'position:absolute;top:6px;left:6px;z-index:9999;padding:3px 10px;border-radius:6px;font-family:"SF Mono",Consolas,monospace;font-size:13px;font-weight:800;color:#fff;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,0.5);box-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1.4;letter-spacing:0.5px;';
                matchedCard.appendChild(badge);
              }
              badge.style.background = 'rgba(16,185,129,0.92)';
              badge.textContent = `✅ ${seqDisplay}`;
            }
          } catch (_badgeErr) {}

          const imgs = Array.from(matchedCard.querySelectorAll("img")).filter(img => {
            const s = img.src || img.currentSrc || "";
            if (!s || s.startsWith("data:image/svg") || s.includes("avatar") || s.includes("icon")) return false;
            return (img.naturalWidth > 80 && img.naturalHeight > 80) || (img.width > 80 && img.height > 80);
          });
          imgs.sort((a, b) => ((b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0)) - ((a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0)));
          if (imgs.length > 0) {
            targetImg = imgs[0];
            imgSrc = targetImg.currentSrc || targetImg.src;
          }
        }

        if (!imgSrc && fbSrc) imgSrc = fbSrc;
        if (!imgSrc) return { success: false, error: `Không tìm thấy ảnh của card "${cleanQuery}"` };

        // Chuẩn hóa URL ảnh chất lượng cao gốc (=s0)
        let highResUrl = imgSrc;
        if (highResUrl.includes("googleusercontent.com")) {
          if (/=[swh]\d+.*$/i.test(highResUrl)) {
            highResUrl = highResUrl.replace(/=[swh]\d+.*$/i, '=s0');
          } else if (!highResUrl.includes("=")) {
            highResUrl = highResUrl + "=s0";
          }
        }

        // Tải blob và đổi thành Data URL ngay trong context trang Flow (100% bypass CORS)
        try {
          let resp = await fetch(highResUrl, { credentials: 'include' });
          if (!resp.ok && highResUrl !== imgSrc) {
            resp = await fetch(imgSrc, { credentials: 'include' });
          }
          if (resp.ok) {
            const blob = await resp.blob();
            const dataUrl = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(blob);
            });
            if (dataUrl) {
              return { success: true, dataUrl, originalUrl: imgSrc, highResUrl };
            }
          }
        } catch (fetchErr) {
          console.warn("[downloadImageCardDirect] Fetch blob lỗi, fallback sang direct URL:", fetchErr);
        }

        return { success: true, dataUrl: null, originalUrl: imgSrc, highResUrl };
      }
    });

    const res = extractRes?.[0]?.result;
    if (!res?.success) {
      return { success: false, error: res?.error || "Không lấy được dữ liệu ảnh" };
    }

    const cleanSlug = (promptText || query).replace(/^\d+[\.\-_:\s]+/g, "").replace(/[^\p{L}\p{N}\s]/gu, '').trim().slice(0, 40).replace(/\s+/g, '_');
    const cleanSeq = (query || "").replace(/[^0-9]/g, '');
    const filename = `${cleanSeq ? cleanSeq + '_' : ''}${cleanSlug || 'image'}.png`;

    const downloadTarget = res.dataUrl || res.highResUrl || res.originalUrl;
    if (!downloadTarget) {
      return { success: false, error: "URL ảnh rỗng" };
    }

    // Trigger download qua Chrome Downloads API
    const downloadId = await chrome.downloads.download({
      url: downloadTarget,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    return {
      success: true,
      downloadId: downloadId,
      filename: filename
    };
  } catch (err) {
    return { success: false, error: "Lỗi tải ảnh: " + err.message };
  }
}

// ══════════════════════════════════════════════════════════════════
// Native UI Download Automation (Right Click Card -> Hover Download -> Hover 720p -> Click 720p)
// ══════════════════════════════════════════════════════════════════
async function triggerNativeDownloadForCard(tabId, query = "001.", promptText = "", mediaId = "", workflowId = "", mediaType = "video", projectId = "") {
  let targetTabId = tabId;

  if (!targetTabId) {
    const tab = (mediaType === 'image') ? (await getFlowTab('image', projectId) || await getFlowTab('video', projectId)) : (await getFlowTab('video', projectId) || await getFlowTab('image', projectId));
    targetTabId = tab?.id;
  }
  if (!targetTabId) return { success: false, error: "Không tìm thấy tab Google Flow đang mở" };

  // NẾU LÀ ẢNH: Tải trực tiếp bằng downloadImageCardDirect siêu tốc, không cần qua menu chuột phải
  if (mediaType === 'image') {
    return downloadImageCardDirect(targetTabId, query, promptText, mediaId, workflowId, null, projectId);
  }

  let cdpAttached = false;
  const ensureCdp = async () => {
    if (!cdpAttached) {
      try {
        await chrome.debugger.attach({ tabId: targetTabId }, "1.3");
        cdpAttached = true;
      } catch (err) {
        if (err.message?.includes("Already attached")) cdpAttached = true;
      }
    }
  };

  try {
    // 1. Focus tab
    try {
      await chrome.tabs.update(targetTabId, { active: true });
      await new Promise(r => setTimeout(r, 300));
    } catch (_) {}

    // 2. Đóng panel / popover nếu đang mở
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      world: "MAIN",
      func: () => {
        const bottomPanels = Array.from(document.querySelectorAll("[class*='config'], [class*='popover'], [class*='panel'], [class*='dialog']")).filter(el => {
          const r = el.getBoundingClientRect();
          return r.top > window.innerHeight - 350 && r.height > 100 && r.width > 200;
        });
        if (bottomPanels.length > 0) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        }
      }
    });
    await new Promise(r => setTimeout(r, 200));

    // 3. B8.0: Click chuột phải vào card khớp với query / Media ID / Prompt
    const r0 = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      world: "MAIN",
      args: [query, promptText || "", mediaId || "", workflowId || "", mediaType || "video"],
      func: async (q, pText, mId, wId, mType = "video") => {
        const cleanQuery = (q || "001.").trim().toLowerCase();
        const numOnly = cleanQuery.replace(/[^0-9]/g, "");
        const targetMediaId = (mId || "").trim();
        const targetWorkflowId = (wId || "").trim();
        const promptFull = (pText || "").trim().toLowerCase();
        const isVideoTask = (mType === 'video' || mType === 'auto');

        const removeDiacritics = (str) => {
          return (str || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d")
            .replace(/Đ/g, "D")
            .toLowerCase();
        };

        const cleanQueryNoAccents = removeDiacritics(cleanQuery);
        const promptFullNoAccents = removeDiacritics(promptFull);
        const seqRegex = numOnly ? new RegExp(`(^|[^0-9])${numOnly}([\\.\\-_:\\s]|$)`) : null;

        // Helper nhận diện thẻ video
        function isCardVideo(el) {
          if (!el) return false;
          if (el.querySelector("video")) return true;
          if (el.querySelector("svg.lucide-play, [data-icon*='play'], button[aria-label*='phát' i], button[aria-label*='play' i]")) return true;
          const text = (el.innerText || el.textContent || "");
          if (text.includes("▶") || text.includes("►") || text.includes("play_arrow")) return true;
          if (/\b\d+s\b/i.test(text) || /\b\d+\s*giây\b/i.test(text)) return true;
          if (/\b(720p|1080p|4k)\b/i.test(text)) return true;
          if (el.querySelector("[role='progressbar'], svg.animate-spin, .animate-spin")) return true;
          if (/\b\d+\s*%/i.test(text)) return true;
          if (/đang\s*(tạo|kết\s*xuất)|generating/i.test(text)) return true;
          return false;
        }

        // Helper nhận diện thẻ ảnh start_frame / end_frame / input asset
        function isCardImageAsset(el) {
          if (!el) return false;
          const text = (el.innerText || el.textContent || "").toLowerCase();
          if (isCardVideo(el)) return false;
          if (text.includes("start_fra") || text.includes("end_fra") || text.includes("start frame") || text.includes("end frame") ||
              /\.(png|jpg|jpeg|webp)\b/i.test(text) || text.includes("frame_")) {
            return true;
          }
          if (el.querySelector("svg.lucide-image, [data-icon*='image'], [aria-label*='ảnh' i]")) {
            return true;
          }
          return false;
        }

        // Helper leo lên container cha của thẻ card
        function getCardContainer(el) {
          if (!el) return null;
          let card = el;
          let cur = el.parentElement;
          while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
            const r = cur.getBoundingClientRect();
            if (r.width > 550 || r.height > 850 || r.width > window.innerWidth * 0.8) break;

            const curText = cur.textContent || "";
            const seqMatches = curText.match(/\b\d{3}[\.\-_:\s]/g) || [];
            const uniqueSeqs = new Set(seqMatches.map(s => s.trim()));
            if (uniqueSeqs.size > 1) break;

            card = cur;

            if (cur.parentElement) {
              const parentRole = cur.parentElement.getAttribute("role") || "";
              const isContainer = cur.getAttribute("role") === "listitem" || parentRole === "list" || parentRole === "grid";
              if (isContainer) {
                card = cur;
                break;
              }
            }
            cur = cur.parentElement;
          }
          return card;
        }

        const stopWords = new Set(["video", "tạo", "tao", "make", "create", "shot", "scene", "with", "from", "that", "this", "over", "into", "onto", "under", "about", "close", "realistic", "cinematic", "high", "detail", "4k", "8k"]);
        const pWords = promptFullNoAccents
          ? promptFullNoAccents.replace(/^\d+[\.\-_:\s]+/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w))
          : [];

        // Hệ thống chấm điểm card thông minh
        function scoreCard(card) {
          if (!card) return -999999;
          const isImgAsset = isCardImageAsset(card);
          const isVid = isCardVideo(card);

          if (isVideoTask) {
            if (isImgAsset) return -999999; // BẢO VỆ TUYỆT ĐỐI: Loại bỏ hoàn toàn card ảnh start_frame / end_frame / asset!
          } else if (mType === 'image') {
            if (isVid) return -999999;
          }

          let score = 0;
          if (isVideoTask && isVid) score += 10000;
          if (mType === 'image' && isImgAsset) score += 5000;

          const cardText = (card.innerText || card.textContent || "").trim();
          const cardTextLower = cardText.toLowerCase();
          const cardTextNoAccents = removeDiacritics(cardTextLower);

          if (isVideoTask && (cardTextLower.includes("start_fra") || cardTextLower.includes("end_fra") || cardTextLower.includes("frame_"))) {
            score -= 8000;
          }

          if (promptFull && (cardTextLower.includes(promptFull) || (promptFullNoAccents && cardTextNoAccents.includes(promptFullNoAccents)))) {
            score += 6000;
          }
          if (seqRegex && (seqRegex.test(cardTextLower) || seqRegex.test(cardTextNoAccents))) {
            score += 4000;
          } else if (cleanQuery && (cardTextLower.includes(cleanQuery) || (cleanQueryNoAccents && cardTextNoAccents.includes(cleanQueryNoAccents)))) {
            score += 3000;
          }

          for (const w of pWords) {
            if (cardTextNoAccents.includes(w)) score += 500;
          }

          if (card.querySelector("[role='progressbar'], svg.animate-spin, .animate-spin") || /\b\d+\s*%/i.test(cardText)) {
            score += 2000;
          }
          if (card.querySelector("video, svg.lucide-play, button[aria-label*='phát' i], button[aria-label*='play' i]") || /\b\d+s\b/i.test(cardText)) {
            score += 3000;
          }

          return score;
        }

        let matchedCard = null;

        // ƯU TIÊN 0: Tìm card đã được highlight bởi scanner hoặc checkCardStatus
        // → Nhanh nhất, chính xác nhất vì card đã được xác định từ trước!
        const seqDisplay = cleanQuery.replace(/[\.\-_:\s]+$/g, '').trim();
        if (seqDisplay) {
          // Tìm cả 2 loại badge: scanner (data-flow-scan-seq) và poll (data-flow-seq)
          const badgedCards = Array.from(document.querySelectorAll(
            `[data-flow-scan-seq="${seqDisplay}"], [data-flow-seq="${seqDisplay}"]`
          ));
          if (badgedCards.length > 0) {
            const readyCard = badgedCards.find(c =>
              c.getAttribute('data-flow-seq-status') === 'READY' ||
              c.getAttribute('data-flow-scan-seq')
            );
            matchedCard = readyCard || badgedCards[0];
          }
        }

        // ƯU TIÊN 1: Tìm chính xác theo Media ID hoặc Workflow ID (UUID)
        if (!matchedCard && (targetMediaId || targetWorkflowId)) {
          const allMediaAndCards = Array.from(
            document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id], div[class*='card'], img, video")
          );
          for (const el of allMediaAndCards) {
            const elMId = el.getAttribute("data-media-id") || "";
            const elWId = el.getAttribute("data-workflow-id") || el.getAttribute("data-id") || "";
            const src = el.src || el.currentSrc || "";
            if ((targetMediaId && (elMId === targetMediaId || src.includes(targetMediaId))) ||
                (targetWorkflowId && (elWId === targetWorkflowId || src.includes(targetWorkflowId)))) {
              const card = getCardContainer(el);
              if (card && scoreCard(card) > 0) {
                matchedCard = card;
                break;
              }
            }
          }
        }

        // ƯU TIÊN 2: Tìm text element chứa query hoặc STT hoặc prompt
        if (!matchedCard) {
          const candidateTextEls = Array.from(
            document.querySelectorAll("p, span, div, h1, h2, h3, h4, h5, h6, button, b, strong, [aria-label], [title]")
          ).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) {
              return false;
            }
            const t = (el.innerText || el.textContent || "").trim().toLowerCase();
            const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();
            const combined = t + " " + aria;
            if (!combined.trim()) return false;
            const combNoAccents = removeDiacritics(combined);
            if (combined.includes(cleanQuery) || (cleanQueryNoAccents && combNoAccents.includes(cleanQueryNoAccents))) return true;
            if (seqRegex && cleanQuery.includes(".") && (seqRegex.test(combined) || seqRegex.test(combNoAccents))) return true;
            if (promptFullNoAccents && (combined.includes(promptFull) || combNoAccents.includes(promptFullNoAccents))) return true;
            return false;
          });

          if (candidateTextEls.length > 0) {
            const uniqueCards = Array.from(new Set(candidateTextEls.map(el => getCardContainer(el)).filter(Boolean)));
            uniqueCards.sort((a, b) => scoreCard(b) - scoreCard(a));
            if (uniqueCards.length > 0 && scoreCard(uniqueCards[0]) > 0) {
              matchedCard = uniqueCards[0];
            }
          }
        }

        // ƯU TIÊN 3: Tìm theo từ khoá Prompt (Semantic Keywords Matching hỗ trợ tiếng Việt không dấu)
        if (!matchedCard && promptFull && pWords.length > 0) {
          const potentialCards = Array.from(document.querySelectorAll("div, [role='listitem']")).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.width > 480 || r.height < 150 || r.height > 650) return false;
            return Boolean(el.querySelector("video, img"));
          });

          const scoredCards = potentialCards
            .map(c => ({ card: c, score: scoreCard(c) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score);

          if (scoredCards.length > 0) {
            matchedCard = scoredCards[0].card;
          }
        }

        // Fallback tìm theo media nếu chưa tìm ra
        if (!matchedCard) {
          const allMedia = Array.from(document.querySelectorAll("img, video")).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
            const src = el.src || el.currentSrc || "";
            if (src.includes("googleusercontent.com/a/") || src.includes("avatar")) return false;
            const r = el.getBoundingClientRect();
            return r.width > 60 && r.height > 60;
          });

          for (const m of allMedia) {
            const cur = getCardContainer(m);
            if (cur && scoreCard(cur) > 0) {
              matchedCard = cur;
              break;
            }
          }
        }

        if (!matchedCard) return { success: false, error: `Không tìm thấy card chứa "${cleanQuery}" trên màn hình Flow` };

        // BẢO VỆ CHỐNG TẢI NHẦM ẢNH START FRAME / ASSET:
        if (isVideoTask && isCardImageAsset(matchedCard)) {
          return { success: false, error: "Thẻ phát hiện là ảnh start frame / asset chứ không phải video. Đang đợi thẻ video..." };
        }

        // Kiểm tra nếu card này là thẻ báo lỗi / vi phạm chính sách (chỉ khi KHÔNG có thumbnail/video thật)
        const hasRealImg = Array.from(matchedCard.querySelectorAll("img")).some(img => {
          const src = img.src || img.currentSrc || "";
          if (!src || src.startsWith("data:image/svg") || src.includes("avatar")) return false;
          return (img.naturalWidth > 80 && img.naturalHeight > 80) || (img.width > 80 && img.height > 80 && !src.includes("placeholder"));
        });
        const hasRealVideo = Array.from(matchedCard.querySelectorAll("video")).some(v => {
          const src = v.currentSrc || v.src || v.querySelector("source")?.src || "";
          return Boolean(src) || v.readyState > 0 || v.duration > 0;
        });

        if (!hasRealImg && !hasRealVideo) {
          const cardTxt = (matchedCard.innerText || matchedCard.textContent || "").toLowerCase();
          const hasErrKeywords = cardTxt.includes("không thành công") || cardTxt.includes("vi phạm chính sách") || cardTxt.includes("chính sách của chúng tôi") || cardTxt.includes("bạn chưa bị tính phí");
          const hasAlert = Boolean(matchedCard.querySelector("svg.lucide-alert-triangle, [data-icon*='alert']"));
          const hasTrash = Boolean(matchedCard.querySelector("button[aria-label*='xoá' i], button[aria-label*='trash' i], svg.lucide-trash"));
          if (hasErrKeywords || (hasAlert && hasTrash)) {
            return { success: false, error: "Card bị lỗi vi phạm chính sách / không thành công (không có video để tải)" };
          }
        }

        matchedCard.scrollIntoView({ behavior: 'auto', block: 'center' });

        // ─── INJECT PERSISTENT SEQ BADGE (READY - đang tải) ───
        try {
          const seqDisplay = cleanQuery.replace(/[\.\-_:\s]+$/g, '').trim();
          if (seqDisplay) {
            const _mRect = matchedCard.getBoundingClientRect();
            if (_mRect.width > 450 || _mRect.height > 500) throw new Error('skip');
            const pos = getComputedStyle(matchedCard).position;
            if (pos === 'static') matchedCard.style.position = 'relative';
            matchedCard.style.outline = '3px solid #10b981';
            matchedCard.style.outlineOffset = '-1px';
            matchedCard.setAttribute('data-flow-seq', seqDisplay);
            matchedCard.setAttribute('data-flow-seq-status', 'READY');
            let badge = matchedCard.querySelector('[data-flow-seq-badge]');
            if (!badge) {
              badge = document.createElement('div');
              badge.setAttribute('data-flow-seq-badge', 'true');
              badge.style.cssText = 'position:absolute;top:6px;left:6px;z-index:9999;padding:3px 10px;border-radius:6px;font-family:"SF Mono",Consolas,monospace;font-size:13px;font-weight:800;color:#fff;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,0.5);box-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1.4;letter-spacing:0.5px;';
              matchedCard.appendChild(badge);
            }
            badge.style.background = 'rgba(16,185,129,0.92)';
            badge.textContent = `✅ ${seqDisplay}`;
          }
        } catch (_badgeErr) {}

        // Đợi layout ổn định sau khi scroll
        await new Promise(res => setTimeout(res, 150));

        const clickTarget = matchedCard.querySelector("video") || matchedCard.querySelector("img") || matchedCard;
        const rect = clickTarget.getBoundingClientRect();
        const clientX = Math.round(rect.left + rect.width / 2);
        const clientY = Math.round(rect.top + rect.height / 2);
        const opts = { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2, clientX, clientY };
        clickTarget.dispatchEvent(new MouseEvent('mousedown', opts));
        clickTarget.dispatchEvent(new MouseEvent('mouseup', opts));
        clickTarget.dispatchEvent(new MouseEvent('contextmenu', opts));

        const imgEl = matchedCard.querySelector("img");
        const imgSrc = imgEl ? (imgEl.currentSrc || imgEl.src) : null;
        const hasPlayIcon = Boolean(
          matchedCard.querySelector("svg.lucide-play, svg[data-icon*='play'], [class*='play'], button[aria-label*='phát' i], button[aria-label*='play' i]") ||
          Array.from(matchedCard.querySelectorAll("svg, button, div, span")).some(el => {
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            const t = (el.textContent || "").trim().toLowerCase();
            return aria.includes("play") || aria.includes("phát") || t.match(/^\d+s$/i) || t.match(/^\d+\s*giây$/i) || t.includes("720p") || t.includes("1080p");
          })
        );
        const isVideoCard = Boolean(matchedCard.querySelector("video")) || hasPlayIcon;

        return { success: true, clientX, clientY, imgSrc, isVideoCard };
      }
    });

    if (!r0?.[0]?.result?.success) {
      return { success: false, error: r0?.[0]?.result?.error || "Không click phải được vào card" };
    }

    const { clientX, clientY, imgSrc, isVideoCard } = r0[0].result;
    const isImage = (mediaType === 'image') || (mediaType === 'auto' && !isVideoCard && Boolean(imgSrc));

    if (isImage) {
      return downloadImageCardDirect(targetTabId, query, promptText, mediaId, workflowId, imgSrc, projectId);
    }

    // 4. B8.1: Tìm mục "Tải xuống" (Thử lại tối đa 3 giây kèm backup click CDP)
    let dlPos = null;
    let isStillRenderingOnFlow = false;

    for (let attempt = 1; attempt <= 12; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 1 ? 400 : 250));

      const r1 = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        world: "MAIN",
        func: () => {
          const all = Array.from(document.querySelectorAll("*")).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.width > 380 || r.height > 90) return false;
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = (el.innerText || el.textContent || "").trim();
            if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
            return t === "Tải xuống" || t.startsWith("Tải xuống") || t === "Download" || t.startsWith("Download") || t.toLowerCase().includes("tải xuống");
          });

          if (all.length > 0) {
            const exact = all.find(el => (el.innerText || el.textContent || "").trim() === "Tải xuống") || all[0];
            const row = exact.closest("[role='menuitem'], button, [class*='item'], li, div[tabindex]") || exact;
            const rect = row.getBoundingClientRect();
            row.style.outline = '3px solid #00e5ff';
            row.style.boxShadow = '0 0 20px #00e5ff';
            ['mouseenter', 'mouseover', 'mousemove'].forEach(evt => {
              row.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
            });
            return {
              type: 'DOWNLOAD',
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              right: Math.round(rect.right),
              left: Math.round(rect.left)
            };
          }

          // Kiểm tra nếu menu chuột phải đã mở nhưng chỉ có nút "Xoá" (Flow đang xử lý, chưa xong)
          const hasDeleteBtn = Array.from(document.querySelectorAll("*")).some(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.width > 380 || r.height > 90) return false;
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = (el.innerText || el.textContent || "").trim().toLowerCase();
            return (t === "xóa" || t === "xoá" || t === "delete") && Boolean(el.closest("[role='menu'], [role='menuitem'], [class*='menu'], [class*='popover'], ul"));
          });

          if (hasDeleteBtn) {
            // Đóng menu chuột phải để không làm kẹt giao diện
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            return { type: 'STILL_RENDERING' };
          }

          return null;
        }
      });

      const res = r1?.[0]?.result;
      if (res?.type === 'DOWNLOAD') {
        dlPos = res;
        break;
      }
      if (res?.type === 'STILL_RENDERING') {
        isStillRenderingOnFlow = true;
        break;
      }

      // Nếu sau 2 lần (~650ms) chưa thấy menu chuột phải, gửi thêm CDP hardware right-click bổ trợ
      if (attempt === 2 || attempt === 5) {
        try {
          await ensureCdp();
          await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
            type: "mousePressed", button: "right", buttons: 2, x: clientX, y: clientY, clickCount: 1
          });
          await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
            type: "mouseReleased", button: "right", buttons: 0, x: clientX, y: clientY
          });
        } catch (_) {}
      }
    }

    if (isStillRenderingOnFlow) {
      return { success: false, isStillRendering: true, error: "Thẻ vẫn đang render trên Flow (menu chuột phải chỉ có nút Xoá)" };
    }

    if (!dlPos) {
      return { success: false, error: "Không tìm thấy mục 'Tải xuống' trong menu chuột phải" };
    }

    await ensureCdp();
    await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: dlPos.x,
      y: dlPos.y
    });

    // 5. B8.2: Tìm chính xác dòng "720p (Kích thước gốc)" kèm vòng lặp thử lại tối đa 3 giây
    let opt720 = null;
    for (let subAttempt = 1; subAttempt <= 12; subAttempt++) {
      await new Promise(r => setTimeout(r, subAttempt === 1 ? 350 : 250));

      // Mỗi vài lần thử mà submenu chưa mở, kích hoạt lại hover bằng cả CDP, DOM mouse và click
      if (subAttempt === 2 || subAttempt === 4 || subAttempt === 7) {
        try {
          await ensureCdp();
          const targetX = (subAttempt % 2 === 0 && dlPos.right) ? (dlPos.right - 15) : dlPos.x;
          await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: targetX,
            y: dlPos.y
          });
        } catch (_) {}

        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
              const all = Array.from(document.querySelectorAll("*")).filter(el => {
                const t = (el.innerText || el.textContent || "").trim();
                return t === "Tải xuống" || t.startsWith("Tải xuống");
              });
              if (all.length > 0) {
                const exact = all[0];
                const row = exact.closest("[role='menuitem'], button, [class*='item'], li, div[tabindex]") || exact;
                ['mouseenter', 'mouseover', 'mousemove', 'pointerenter', 'pointerover'].forEach(evt => {
                  row.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                });
              }
            }
          });
        } catch (_) {}
      }

      // Nếu sau 3 lần vẫn chưa thấy submenu mở, click trực tiếp vào dòng "Tải xuống" để buộc mở submenu
      if (subAttempt === 3 || subAttempt === 6) {
        try {
          await ensureCdp();
          await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
            type: "mousePressed", button: "left", buttons: 1, x: dlPos.x, y: dlPos.y, clickCount: 1
          });
          await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
            type: "mouseReleased", button: "left", buttons: 0, x: dlPos.x, y: dlPos.y
          });
        } catch (_) {}

        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
              const all = Array.from(document.querySelectorAll("*")).filter(el => {
                const t = (el.innerText || el.textContent || "").trim();
                return t === "Tải xuống" || t.startsWith("Tải xuống");
              });
              if (all.length > 0) {
                const exact = all[0];
                const row = exact.closest("[role='menuitem'], button, [class*='item'], li, div[tabindex]") || exact;
                if (typeof row.click === 'function') row.click();
              }
            }
          });
        } catch (_) {}
      }

      const r2 = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        world: "MAIN",
        func: () => {
          const allEls = Array.from(document.querySelectorAll("*")).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.height > 180) return false;
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = (el.innerText || el.textContent || "").trim();
            if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
            if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
            return t.includes("720p") || t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
          });

          let opt = null;
          if (allEls.length > 0) {
            allEls.sort((a, b) => {
              const ta = (a.innerText || a.textContent || "");
              const tb = (b.innerText || b.textContent || "");
              const aGoc = ta.includes("Kích thước gốc") || ta.toLowerCase().includes("gốc") || ta.toLowerCase().includes("original") ? 1 : 0;
              const bGoc = tb.includes("Kích thước gốc") || tb.toLowerCase().includes("gốc") || tb.toLowerCase().includes("original") ? 1 : 0;
              if (aGoc !== bGoc) return bGoc - aGoc;
              const aBtn = a.tagName === 'BUTTON' || a.getAttribute('role') === 'menuitem' ? 1 : 0;
              const bBtn = b.tagName === 'BUTTON' || b.getAttribute('role') === 'menuitem' ? 1 : 0;
              if (aBtn !== bBtn) return bBtn - aBtn;
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return (rb.width * rb.height) - (ra.width * ra.height);
            });
            opt = allEls[0];
          }

          if (!opt) {
            const directText = Array.from(document.querySelectorAll("*")).filter(el => {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0 || r.height > 140) return false;
              if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
              const t = (el.innerText || el.textContent || "").trim();
              if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
              if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
              return t.includes("Kích thước gốc") || t.toLowerCase().includes("original") || t.includes("720p");
            });
            if (directText.length > 0) {
              let cur = directText[0];
              while (cur && cur.parentElement && cur.parentElement !== document.body) {
                const p = cur.parentElement;
                const pr = p.getBoundingClientRect();
                const pt = (p.innerText || p.textContent || "").trim();
                if (pr.height > 120 || pt.includes("270p") || pt.includes("1080p") || pt.includes("4K")) {
                  break;
                }
                cur = p;
                if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'menuitem') break;
              }
              opt = cur;
            }
          }

          if (!opt) return null;
          const rect = opt.getBoundingClientRect();
          opt.style.outline = '4px solid #00e676';
          opt.style.boxShadow = '0 0 25px rgba(0, 230, 118, 0.95)';
          opt.style.backgroundColor = 'rgba(0, 230, 118, 0.25)';
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            text: (opt.innerText || opt.textContent || "").replace(/\s+/g, ' ').trim()
          };
        }
      });

      opt720 = r2?.[0]?.result;
      if (opt720) break;
    }

    if (!opt720) {
      return { success: false, error: "Không tìm thấy dòng '720p (Kích thước gốc)' trong submenu" };
    }

    // B8.2: Rê chuột vào 720p
    await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: opt720.x,
      y: opt720.y
    });

    // Dừng 650ms để đăng ký hover
    await new Promise(r => setTimeout(r, 650));

    // Lắng nghe chrome.downloads.onCreated
    let onCreatedListener = null;
    const dlPromise = new Promise((resolve) => {
      onCreatedListener = (item) => {
        resolve(item);
      };
      chrome.downloads.onCreated.addListener(onCreatedListener);
    });

    // B8.3: Click 720p bằng CDP Hardware Mouse
    await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: opt720.x,
      y: opt720.y,
      button: "left",
      clickCount: 1
    });
    await new Promise(r => setTimeout(r, 80));
    await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: opt720.x,
      y: opt720.y,
      button: "left",
      clickCount: 1
    });

    // Chờ xem CDP click có kích hoạt download không (tối đa 3s)
    let downloadedItem = await Promise.race([
      dlPromise,
      new Promise(r => setTimeout(() => r(null), 3000))
    ]);

    // Chỉ nếu sau 3s CDP mouse click chưa tạo download, mới chạy fallback JS click (tránh click đúp gây tải nhiều lần)
    if (!downloadedItem) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          world: "MAIN",
          func: () => {
            const allEls = Array.from(document.querySelectorAll("*")).filter(el => {
              const r = el.getBoundingClientRect();
              if (r.width < 50 || r.width > 350 || r.height < 18 || r.height > 180) return false;
              if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
              const t = (el.innerText || el.textContent || "").trim();
              if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
              if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
              return t.includes("720p") || t.includes("Kích thước gốc");
            });
            if (allEls.length > 0 && typeof allEls[0].click === 'function') allEls[0].click();
          }
        });
      } catch (_) {}

      downloadedItem = await Promise.race([
        dlPromise,
        new Promise(r => setTimeout(() => r(null), 5000))
      ]);
    }

    if (onCreatedListener) {
      chrome.downloads.onCreated.removeListener(onCreatedListener);
    }

    if (!downloadedItem) {
      try {
        const recents = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
        if (recents?.length && (Date.now() - new Date(recents[0].startTime).getTime() < 12000)) {
          downloadedItem = recents[0];
        }
      } catch (_) {}
    }

    // Chờ cho file tải xong hoàn tất (state === 'complete') để lấy đường dẫn file .mp4 thực tế trên ổ cứng
    if (downloadedItem?.id) {
      const finalItem = await new Promise((res) => {
        let checkTimer = setInterval(async () => {
          try {
            const items = await chrome.downloads.search({ id: downloadedItem.id });
            if (items && items[0]) {
              if (items[0].state === 'complete' || items[0].state === 'interrupted') {
                clearInterval(checkTimer);
                res(items[0]);
              }
            }
          } catch (_) {}
        }, 600);
        setTimeout(() => {
          clearInterval(checkTimer);
          res(downloadedItem);
        }, 50000); // Chờ tối đa 50s để tải xong
      });
      if (finalItem) downloadedItem = finalItem;
    }

    const isSuccess = Boolean(downloadedItem && downloadedItem.filename && !downloadedItem.filename.endsWith('.crdownload') && downloadedItem.state !== 'interrupted');
    const resolvedPath = downloadedItem?.filename || 'flow_video.mp4';
    return {
      success: isSuccess,
      downloadItem: downloadedItem,
      filename: resolvedPath,
      filePath: resolvedPath
    };
  } finally {
    // Tự động cuộn trang Google Flow lên đầu sau khi tải xong / hoàn tất thao tác
    try {
      await scrollFlowToTop(targetTabId);
    } catch (_) {}

    if (cdpAttached) {
      try { await chrome.debugger.detach({ tabId: targetTabId }); } catch (_) {}
    }
  }
}

async function scrollFlowToTop(tabId = null, projectId = null) {
  let targetTabId = tabId;
  if (!targetTabId) {
    const tab = await getFlowTab('video', projectId);
    targetTabId = tab?.id;
  }
  if (!targetTabId) return { success: false };

  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      world: "MAIN",
      func: () => {
        try {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
          const scrollables = Array.from(document.querySelectorAll("*")).filter(el => {
            return el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200;
          });
          scrollables.forEach(s => {
            try { s.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { s.scrollTop = 0; }
          });
        } catch (_) {}
      }
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getMaxSeq(projectId) {
  let maxSeq = 0;

  // 1. Kiểm tra từ storage đã lưu cho projectId này
  const pKey = projectId || 'default';
  const storageKey = `flow_last_seq_${pKey}`;
  try {
    const stored = await chrome.storage.local.get([storageKey]);
    if (stored[storageKey] && typeof stored[storageKey] === 'number') {
      maxSeq = Math.max(maxSeq, stored[storageKey]);
    }
  } catch (_) {}

  // 2. Quét DOM của tab Flow đang mở để tìm số STT lớn nhất hiện có
  try {
    const flowTab = await getFlowTab('image', projectId) || await getFlowTab('video', projectId);
    if (flowTab?.id) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: flowTab.id },
        world: "MAIN",
        func: () => {
          const numbers = [];
          const allTextEls = Array.from(document.querySelectorAll("p, span, div, h1, h2, h3, h4, h5, h6, button, [title], [aria-label]"));
          for (const el of allTextEls) {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) continue;
            const text = ((el.innerText || el.textContent || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("aria-label") || "")).trim();
            const matches = text.match(/\b(\d{1,4})[\.\-_:\s]/g);
            if (matches) {
              for (const m of matches) {
                const num = parseInt(m.replace(/\D/g, ''), 10);
                if (num > 0 && num < 10000) {
                  numbers.push(num);
                }
              }
            }
          }
          return numbers.length > 0 ? Math.max(...numbers) : 0;
        }
      });
      const domMax = res?.[0]?.result;
      if (typeof domMax === 'number' && domMax > maxSeq) {
        maxSeq = domMax;
      }
    }
  } catch (err) {
    console.warn("[getMaxSeq] Lỗi quét DOM:", err);
  }

  return { success: true, maxSeq };
}

async function updateMaxSeq(projectId, newMax) {
  const pKey = projectId || 'default';
  const storageKey = `flow_last_seq_${pKey}`;
  try {
    const stored = await chrome.storage.local.get([storageKey]);
    const current = stored[storageKey] || 0;
    if (newMax > current) {
      await chrome.storage.local.set({ [storageKey]: newMax });
    }
  } catch (_) {}
  return { success: true };
}
// ══════════════════════════════════════
// SCAN FLOW CARDS: Quét toàn bộ card trên màn hình, nhận diện STT, gắn badge
// ══════════════════════════════════════
async function scanFlowCards(tabId, projectId) {
  try {
    let targetTabId = tabId;
    if (!targetTabId) {
      const flowTab = await getFlowTab('video', projectId);
      if (!flowTab?.id) return { success: false, error: 'Không tìm thấy tab Flow' };
      targetTabId = flowTab.id;
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      world: "MAIN",
      func: () => {
        const BADGE_CSS = 'position:absolute;top:6px;left:6px;z-index:9999;padding:3px 10px;border-radius:6px;font-family:"SF Mono",Consolas,monospace;font-size:13px;font-weight:800;color:#fff;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,0.5);box-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1.4;letter-spacing:0.5px;';
        const SEQ_REGEX = /(?:^|\s)(\d{1,4})[\.\-_:\s]/;
        const statusColors = {
          'rendering': { bg: 'rgba(0,229,255,0.92)', outline: '#00e5ff', emoji: '⏳' },
          'ready':     { bg: 'rgba(16,185,129,0.92)', outline: '#10b981', emoji: '✅' },
          'failed':    { bg: 'rgba(239,68,68,0.92)',  outline: '#ef4444', emoji: '❌' }
        };

        // Lịch sử: lưu thumbnail URL → seq (persist trên window)
        if (!window.__flowScanHistory) window.__flowScanHistory = new Map();

        // Helper: lấy fingerprint của card (thumbnail URL cắt ngắn)
        const getCardFingerprint = (el) => {
          const vid = el.querySelector('video');
          const vidSrc = vid?.currentSrc || vid?.src || vid?.querySelector('source')?.src || '';
          if (vidSrc) return vidSrc.split('?')[0].slice(-60);
          const imgs = Array.from(el.querySelectorAll('img')).filter(img => {
            const s = img.src || img.currentSrc || '';
            return s && !s.startsWith('data:image/svg') && !s.includes('avatar') && !s.includes('icon');
          }).sort((a, b) => ((b.naturalWidth||b.width||0)*(b.naturalHeight||b.height||0)) - ((a.naturalWidth||a.width||0)*(a.naturalHeight||a.height||0)));
          if (imgs.length > 0) return (imgs[0].currentSrc || imgs[0].src).split('?')[0].slice(-60);
          return '';
        };

        // Helper: xác định trạng thái card
        const getCardStatus = (el) => {
          const t = (el.innerText || el.textContent || '').toLowerCase();
          if (el.querySelector("[role='progressbar'], svg.animate-spin, .animate-spin") || /\b\d+\s*%/i.test(t) || t.includes('đang tạo') || t.includes('generating')) return 'rendering';
          if (t.includes('không thành công') || t.includes('vi phạm chính sách') || t.includes('failed')) return 'failed';
          return 'ready';
        };

        // Helper: gắn badge lên card
        const applyBadge = (card, seq, status) => {
          const colors = statusColors[status];
          const pos = getComputedStyle(card).position;
          if (pos === 'static') card.style.position = 'relative';
          card.style.outline = `3px solid ${colors.outline}`;
          card.style.outlineOffset = '-1px';
          card.setAttribute('data-flow-scan-seq', seq);
          const badge = document.createElement('div');
          badge.setAttribute('data-flow-scan-badge', 'true');
          badge.style.cssText = BADGE_CSS;
          badge.style.background = colors.bg;
          badge.textContent = `${colors.emoji} ${seq}`;
          card.appendChild(badge);
        };

        // ═══ BƯỚC 1: Thu thập tất cả card-like elements ═══
        const allElements = document.querySelectorAll('div, [role="listitem"]');
        const validCards = [];

        for (const el of allElements) {
          if (el.closest('[data-slate-editor], form, [class*="composer"], [class*="input-container"], [class*="prompt-box"]')) continue;
          if (el.hasAttribute('data-flow-scan-badge')) continue;

          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.width > 400 || r.height < 100 || r.height > 450) continue;
          if (r.top > window.innerHeight || r.bottom < 0) continue;

          const hasMedia = el.querySelector('video') || Array.from(el.querySelectorAll('img')).some(img => {
            const src = img.src || img.currentSrc || '';
            if (!src || src.startsWith('data:image/svg') || src.includes('avatar') || src.includes('icon')) return false;
            return (img.naturalWidth > 60 && img.naturalHeight > 60) || (img.width > 60 && img.height > 60);
          });
          const hasProgress = el.querySelector("[role='progressbar'], svg.animate-spin, .animate-spin") || /\b\d+\s*%/i.test(el.textContent || '');
          if (!hasMedia && !hasProgress) continue;

          const text = (el.innerText || el.textContent || '').trim();
          const seqMatch = text.match(SEQ_REGEX);
          const seq = seqMatch ? seqMatch[1].padStart(3, '0') : null;
          const fingerprint = getCardFingerprint(el);

          validCards.push({ el, seq, text: text.slice(0, 60), fingerprint, rect: { w: r.width, h: r.height } });
        }

        // ═══ BƯỚC 2: Xóa badge cũ ═══
        document.querySelectorAll('[data-flow-scan-badge]').forEach(b => b.remove());
        document.querySelectorAll('[data-flow-scan-seq]').forEach(c => {
          c.removeAttribute('data-flow-scan-seq');
          c.style.outline = '';
          c.style.outlineOffset = '';
        });

        // ═══ BƯỚC 3: Gán STT — từ text HOẶC từ lịch sử (cho card bị paraphrase) ═══
        const seqMap = new Map(); // seq → { el, text, ... }

        for (const c of validCards) {
          let seq = c.seq;

          // Nếu text không có STT → tìm trong lịch sử qua fingerprint
          if (!seq && c.fingerprint) {
            seq = window.__flowScanHistory.get(c.fingerprint) || null;
          }
          if (!seq) continue;

          // Lưu vào lịch sử (fingerprint → seq)
          if (c.fingerprint) {
            window.__flowScanHistory.set(c.fingerprint, seq);
          }

          // Tránh trùng parent
          const parentWithSeq = c.el.parentElement?.closest('[data-flow-scan-seq]');
          if (parentWithSeq && parentWithSeq.getAttribute('data-flow-scan-seq') === seq) continue;

          // Deduplicate: chọn element nhỏ nhất
          const existing = seqMap.get(seq);
          if (!existing || (c.rect.w * c.rect.h < existing.rect.w * existing.rect.h)) {
            seqMap.set(seq, c);
          }
        }

        // ═══ BƯỚC 4: Gắn badge ═══
        const labeled = [];
        for (const [seq, c] of seqMap) {
          const status = getCardStatus(c.el);
          applyBadge(c.el, seq, status);
          labeled.push({ seq, status, text: c.text.slice(0, 40) });
        }

        return { success: true, count: labeled.length, cards: labeled, historySize: window.__flowScanHistory.size };
      }
    });

    return result?.[0]?.result || { success: false, error: 'No result' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function checkCardStatus(projectId, query = "001.", promptText = "", mediaId = "", workflowId = "", mediaType = "auto") {
  const cleanQ = (query || "001.").trim().toLowerCase();
  const flowTab = (mediaType === 'image')
    ? (await getFlowTab('image', projectId) || await getFlowTab('video', projectId))
    : (await getFlowTab('video', projectId) || await getFlowTab('image', projectId));

  if (!flowTab?.id) {
    return { status: 'NO_TAB', error: "Không tìm thấy tab Google Flow đang mở!" };
  }

  try {
    const checkRes = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      world: "MAIN",
      args: [cleanQ, promptText || "", mediaId || "", workflowId || "", mediaType || "auto"],
      func: (q, pText, mId, wId, mType = "auto") => {
        const cleanQuery = (q || "001.").trim().toLowerCase();
        const numOnly = cleanQuery.replace(/[^0-9]/g, "");
        const targetMediaId = (mId || "").trim();
        const targetWorkflowId = (wId || "").trim();
        const promptFull = (pText || "").trim().toLowerCase();
        const isVideoTask = (mType === 'video' || mType === 'auto');

        const removeDiacritics = (str) => {
          return (str || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d")
            .replace(/Đ/g, "D")
            .toLowerCase();
        };

        const cleanQueryNoAccents = removeDiacritics(cleanQuery);
        const promptFullNoAccents = removeDiacritics(promptFull);
        const seqRegex = numOnly ? new RegExp(`(^|[^0-9])${numOnly}([\\.\\-_:\\s]|$)`) : null;

        // Helper nhận diện thẻ video
        function isCardVideo(el) {
          if (!el) return false;
          if (el.querySelector("video")) return true;
          if (el.querySelector("svg.lucide-play, [data-icon*='play'], button[aria-label*='phát' i], button[aria-label*='play' i]")) return true;
          const text = (el.innerText || el.textContent || "");
          if (text.includes("▶") || text.includes("►") || text.includes("play_arrow")) return true;
          if (/\b\d+s\b/i.test(text) || /\b\d+\s*giây\b/i.test(text)) return true;
          if (/\b(720p|1080p|4k)\b/i.test(text)) return true;
          if (el.querySelector("[role='progressbar'], svg.animate-spin, .animate-spin")) return true;
          if (/\b\d+\s*%/i.test(text)) return true;
          if (/đang\s*(tạo|kết\s*xuất)|generating/i.test(text)) return true;
          return false;
        }

        // Helper nhận diện thẻ ảnh start_frame / end_frame / input asset
        function isCardImageAsset(el) {
          if (!el) return false;
          const text = (el.innerText || el.textContent || "").toLowerCase();
          if (isCardVideo(el)) return false;
          if (text.includes("start_fra") || text.includes("end_fra") || text.includes("start frame") || text.includes("end frame") ||
              /\.(png|jpg|jpeg|webp)\b/i.test(text) || text.includes("frame_")) {
            return true;
          }
          if (el.querySelector("svg.lucide-image, [data-icon*='image'], [aria-label*='ảnh' i]")) {
            return true;
          }
          return false;
        }

        // Helper: Nhận diện chính xác 100% thẻ card bị Thất bại / Vi phạm chính sách
        function isCardFailed(el) {
          if (!el) return false;

          // BẢO VỆ TUYỆT ĐỐI: Thẻ đã có ảnh thumbnail thật hoặc video thì 100% KHÔNG PHẢI THẺ LỖI!
          const hasRealImg = Array.from(el.querySelectorAll("img")).some(img => {
            const src = img.src || img.currentSrc || "";
            if (!src || src.startsWith("data:image/svg") || src.includes("avatar")) return false;
            return (img.naturalWidth > 80 && img.naturalHeight > 80) || (img.width > 80 && img.height > 80 && !src.includes("placeholder"));
          });
          const hasRealVideo = Array.from(el.querySelectorAll("video")).some(v => {
            const src = v.currentSrc || v.src || v.querySelector("source")?.src || "";
            return Boolean(src) || v.readyState > 0 || v.duration > 0;
          });
          if (hasRealImg || hasRealVideo) {
            return false;
          }

          const text = (el.innerText || el.textContent || "").toLowerCase();
          
          // Thẻ có icon Play ▶ hoặc thời lượng video (ví dụ: 8s) thì 100% không phải thẻ lỗi
          if (text.includes("▶") || text.includes("►") || text.includes("play_arrow") || /\b\d+s\b/i.test(text) || text.includes("giây")) {
            return false;
          }
          
          // 1. Phải có text báo lỗi hoặc vi phạm chính sách rõ ràng
          const hasErrorKeywords = (
            text.includes("không thành công") ||
            text.includes("vi phạm chính sách") ||
            text.includes("chính sách của chúng tôi") ||
            text.includes("trẻ vị thành niên") ||
            text.includes("gây hại") ||
            text.includes("bạn chưa bị tính phí") ||
            text.includes("something went wrong") ||
            text.includes("generation failed")
          );

          // 2. Icon cảnh báo tam giác ⚠️
          const hasAlertIcon = Boolean(
            el.querySelector("svg.lucide-alert-triangle, svg.lucide-alert-circle, [data-icon*='alert'], svg[class*='alert'], path[d*='M10.29 3.86L1.82 18']")
          );

          // 3. Nút xoá / thùng rác đặc trưng của thẻ lỗi
          const hasTrash = Boolean(
            el.querySelector("button[aria-label*='xoá' i], button[aria-label*='xóa' i], button[aria-label*='delete' i], button[aria-label*='trash' i], button[aria-label*='thùng rác' i], svg.lucide-trash, svg.lucide-trash-2, [data-icon*='trash']")
          );

          return hasErrorKeywords || (hasAlertIcon && hasTrash);
        }

        // Helper trích xuất câu báo lỗi chi tiết
        function getCardErrorMessage(el) {
          const text = (el?.innerText || el?.textContent || "").trim();
          if (text.includes("trẻ vị thành niên")) {
            return "Vi phạm chính sách: Trẻ vị thành niên";
          }
          if (text.includes("vi phạm chính sách") || text.includes("chính sách")) {
            return "Vi phạm chính sách nội dung Flow";
          }
          if (text.includes("gây hại")) {
            return "Nội dung gây hại (Flow từ chối tạo)";
          }
          if (text.includes("Không thành công") || text.includes("không thành công")) {
            return "Không thành công trên Flow (Có 3 nút: Thử lại, Sử dụng lại, Xoá)";
          }
          if (text.toLowerCase().includes("failed")) {
            return "Flow generation failed";
          }
          return "Render không thành công trên Flow";
        }

        // Helper leo lên container cha của thẻ card
        function getCardContainer(el) {
          if (!el) return null;
          let card = el;
          let cur = el.parentElement;
          while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
            const r = cur.getBoundingClientRect();
            if (r.width > 550 || r.height > 850 || r.width > window.innerWidth * 0.8) break;

            const curText = cur.textContent || "";
            const seqMatches = curText.match(/\b\d{3}[\.\-_:\s]/g) || [];
            const uniqueSeqs = new Set(seqMatches.map(s => s.trim()));
            if (uniqueSeqs.size > 1) break;

            card = cur;

            if (cur.parentElement) {
              const parentRole = cur.parentElement.getAttribute("role") || "";
              const isCardContainer = cur.getAttribute("role") === "listitem" || parentRole === "list" || parentRole === "grid";
              if (isCardContainer) {
                card = cur;
                break;
              }
            }
            cur = cur.parentElement;
          }
          return card;
        }

        const stopWords = new Set(["video", "tạo", "tao", "make", "create", "shot", "scene", "with", "from", "that", "this", "over", "into", "onto", "under", "about", "close", "realistic", "cinematic", "high", "detail", "4k", "8k"]);
        const pWords = promptFullNoAccents
          ? promptFullNoAccents.replace(/^\d+[\.\-_:\s]+/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w))
          : [];

        // Hệ thống chấm điểm card thông minh
        function scoreCard(card) {
          if (!card) return -999999;
          const isImgAsset = isCardImageAsset(card);
          const isVid = isCardVideo(card);

          if (isVideoTask) {
            if (isImgAsset) return -999999; // BẢO VỆ TUYỆT ĐỐI: Loại bỏ hoàn toàn card ảnh start_frame / end_frame / asset!
          } else if (mType === 'image') {
            if (isVid) return -999999;
          }

          let score = 0;
          if (isVideoTask && isVid) score += 10000;
          if (mType === 'image' && isImgAsset) score += 5000;

          const cardText = (card.innerText || card.textContent || "").trim();
          const cardTextLower = cardText.toLowerCase();
          const cardTextNoAccents = removeDiacritics(cardTextLower);

          if (isVideoTask && (cardTextLower.includes("start_fra") || cardTextLower.includes("end_fra") || cardTextLower.includes("frame_"))) {
            score -= 8000;
          }

          if (promptFull && (cardTextLower.includes(promptFull) || (promptFullNoAccents && cardTextNoAccents.includes(promptFullNoAccents)))) {
            score += 6000;
          }
          if (seqRegex && (seqRegex.test(cardTextLower) || seqRegex.test(cardTextNoAccents))) {
            score += 4000;
          } else if (cleanQuery && (cardTextLower.includes(cleanQuery) || (cleanQueryNoAccents && cardTextNoAccents.includes(cleanQueryNoAccents)))) {
            score += 3000;
          }

          for (const w of pWords) {
            if (cardTextNoAccents.includes(w)) score += 500;
          }

          if (card.querySelector("[role='progressbar'], svg.animate-spin, .animate-spin") || /\b\d+\s*%/i.test(cardText)) {
            score += 2000;
          }
          if (card.querySelector("video, svg.lucide-play, button[aria-label*='phát' i], button[aria-label*='play' i]") || /\b\d+s\b/i.test(cardText)) {
            score += 3000;
          }

          return score;
        }

        let matched = null;

        // ƯU TIÊN 0: Tìm card đã được highlight bởi scanner hoặc lần poll trước
        const seqDisplay = cleanQuery.replace(/[\.\-_:\s]+$/g, '').trim();
        if (seqDisplay) {
          const badgedCards = Array.from(document.querySelectorAll(
            `[data-flow-scan-seq="${seqDisplay}"], [data-flow-seq="${seqDisplay}"]`
          ));
          if (badgedCards.length > 0) {
            matched = badgedCards[0];
          }
        }

        // ƯU TIÊN 1: Tìm chính xác theo Media ID hoặc Workflow ID (UUID)
        if (!matched && (targetMediaId || targetWorkflowId)) {
          const allMediaAndCards = Array.from(
            document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id], div[class*='card'], img, video")
          );
          for (const el of allMediaAndCards) {
            const elMId = el.getAttribute("data-media-id") || "";
            const elWId = el.getAttribute("data-workflow-id") || el.getAttribute("data-id") || "";
            const src = el.src || el.currentSrc || "";
            if ((targetMediaId && (elMId === targetMediaId || src.includes(targetMediaId))) ||
                (targetWorkflowId && (elWId === targetWorkflowId || src.includes(targetWorkflowId)))) {
              const card = getCardContainer(el);
              if (card && scoreCard(card) > 0) {
                matched = card;
                break;
              }
            }
          }
        }

        // ƯU TIÊN 2: Tìm text element chứa query hoặc STT hoặc prompt (hỗ trợ cả tiếng Việt không dấu)
        if (!matched) {
          const candidateTextEls = Array.from(
            document.querySelectorAll("p, span, div, h1, h2, h3, h4, h5, h6, button, b, strong, [aria-label], [title]")
          ).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) {
              return false;
            }
            const t = (el.innerText || el.textContent || "").trim().toLowerCase();
            const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();
            const combined = t + " " + aria;
            if (!combined.trim()) return false;
            const combNoAccents = removeDiacritics(combined);
            if (combined.includes(cleanQuery) || (cleanQueryNoAccents && combNoAccents.includes(cleanQueryNoAccents))) return true;
            if (seqRegex && cleanQuery.includes(".") && (seqRegex.test(combined) || seqRegex.test(combNoAccents))) return true;
            if (promptFullNoAccents && (combined.includes(promptFull) || combNoAccents.includes(promptFullNoAccents))) return true;
            return false;
          });

          if (candidateTextEls.length > 0) {
            const uniqueCards = Array.from(new Set(candidateTextEls.map(el => getCardContainer(el)).filter(Boolean)));
            uniqueCards.sort((a, b) => scoreCard(b) - scoreCard(a));
            if (uniqueCards.length > 0 && scoreCard(uniqueCards[0]) > 0) {
              matched = uniqueCards[0];
            }
          }
        }

        // ƯU TIÊN 3: Tìm theo từ khoá Prompt (Semantic Keywords Matching)
        // Khi video render xong, Google Flow tự động tóm tắt prompt thành tên ngắn (VD: "Tao video con meo con")
        if (!matched && promptFull && pWords.length > 0) {
          const potentialCards = Array.from(document.querySelectorAll("div, [role='listitem']")).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.width > 480 || r.height < 150 || r.height > 650) return false;
            return Boolean(el.querySelector("video, img"));
          });

          const scoredCards = potentialCards
            .map(c => ({ card: c, score: scoreCard(c) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score);

          if (scoredCards.length > 0) {
            matched = scoredCards[0].card;
          }
        }

        // ƯU TIÊN 4: Tìm thẻ lỗi / vi phạm chính sách của CHÍNH TASK NÀY
        // TUYỆT ĐỐI KHÔNG BẮT NHẦM CÁC THẺ LỖI CŨ TỪ CÁC LẦN CHẠY TRƯỚC VÀ KHÔNG BẮT THẺ ẢNH START_FRAME
        if (!matched && (cleanQuery || promptFull || targetMediaId)) {
          const allFailedCards = Array.from(
            document.querySelectorAll("div, [role='listitem'], [data-id], [data-media-id], [data-workflow-id]")
          ).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.width > 480 || r.height < 150 || r.height > 650) return false;
            if (isVideoTask && isCardImageAsset(el)) return false;
            return isCardFailed(el);
          });

          for (const fc of allFailedCards) {
            const visibleText = (fc.innerText || "").toLowerCase();
            const visibleNoAccents = removeDiacritics(visibleText);
            const htmlStr = fc.outerHTML || "";

            // 4a. Khớp theo Media ID chính xác
            if (targetMediaId && (htmlStr.includes(targetMediaId) || visibleText.includes(targetMediaId.toLowerCase()))) {
              matched = fc;
              break;
            }
            // 4b. Khớp theo chuỗi query đầy đủ trong visible text
            if (cleanQuery && (visibleText.includes(cleanQuery) || (cleanQueryNoAccents && visibleNoAccents.includes(cleanQueryNoAccents)))) {
              matched = fc;
              break;
            }
            // 4c. Khớp theo STT chính xác với ranh giới từ (chỉ trong visibleText, không tìm trong outerHTML/dataset)
            if (seqRegex && cleanQuery.includes(".") && (seqRegex.test(visibleText) || seqRegex.test(visibleNoAccents))) {
              matched = fc;
              break;
            }
            // 4d. Khớp theo từ khóa quan trọng nếu thẻ lỗi có ghi lại prompt
            if (promptFull) {
              const stopWords = new Set(["video", "tạo", "tao", "make", "create"]);
              const words = removeDiacritics(promptFull).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
              const hits = words.filter(w => visibleNoAccents.includes(w)).length;
              if (words.length >= 2 && hits >= 2) {
                matched = fc;
                break;
              }
            }
          }
        }

        if (!matched) return { status: 'WAITING_CARD' };

        // BẢO VỆ CHỐNG NHẦM ẢNH START FRAME: Nếu là video task và thẻ là ảnh asset -> tiếp tục đợi thẻ video!
        if (isVideoTask && isCardImageAsset(matched)) {
          return { status: 'WAITING_CARD' };
        }

        // ─── 1. XÁC ĐỊNH TRẠNG THÁI ───
        let cardStatus = 'READY';
        let statusExtra = {};

        const text = (matched.textContent || "").trim();
        const lowerText = text.toLowerCase();
        const isGenerating = Boolean(matched.querySelector("[role='progressbar'], svg.animate-spin, .animate-spin"));
        const pctMatch = text.match(/(\d+)\s*%/);
        const hasGenText = lowerText.includes("đang tạo") || lowerText.includes("generating") || lowerText.includes("đang kết xuất");
        const hasSingleCancelBtn = Boolean(matched.querySelector("button[aria-label*='hủy' i]"));

        if (pctMatch || isGenerating || hasGenText || hasSingleCancelBtn) {
          cardStatus = 'RENDERING';
          statusExtra = { progress: pctMatch ? `${pctMatch[1]}%` : "Đang render..." };
        } else if (isCardFailed(matched)) {
          cardStatus = 'FAILED';
          statusExtra = { error: getCardErrorMessage(matched) };
        } else {
          const matchedMediaId = matched?.getAttribute("data-media-id") || matched?.getAttribute("data-workflow-id") || targetMediaId;
          const videoEl = matched?.querySelector("video");
          const videoUrl = videoEl?.currentSrc || videoEl?.src || "";
          statusExtra = { mediaId: matchedMediaId, videoUrl };
        }

        // ─── 2. INJECT PERSISTENT SEQ BADGE ───
        try {
          if (seqDisplay) {
            // Guard: Không badge lên container quá lớn (chắc chắn không phải card đơn lẻ)
            const _mRect = matched.getBoundingClientRect();
            if (_mRect.width > 450 || _mRect.height > 500) throw new Error('skip_badge_too_large');

            const BADGE_CSS = 'position:absolute;top:6px;left:6px;z-index:9999;padding:3px 10px;border-radius:6px;font-family:"SF Mono",Consolas,monospace;font-size:13px;font-weight:800;color:#fff;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,0.5);box-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1.4;letter-spacing:0.5px;';
            const badgeColors = {
              'RENDERING': { bg: 'rgba(0,229,255,0.92)',  outline: '#00e5ff', emoji: '⏳' },
              'READY':     { bg: 'rgba(16,185,129,0.92)', outline: '#10b981', emoji: '✅' },
              'FAILED':    { bg: 'rgba(239,68,68,0.92)',  outline: '#ef4444', emoji: '❌' }
            };
            const colors = badgeColors[cardStatus] || badgeColors['RENDERING'];

            // Đảm bảo card có relative positioning cho badge overlay
            const pos = getComputedStyle(matched).position;
            if (pos === 'static') matched.style.position = 'relative';

            // Viền khoanh vùng card theo trạng thái
            matched.style.outline = `3px solid ${colors.outline}`;
            matched.style.outlineOffset = '-1px';

            // Đánh dấu card với data attribute
            matched.setAttribute('data-flow-seq', seqDisplay);
            matched.setAttribute('data-flow-seq-status', cardStatus);

            // Tạo hoặc cập nhật badge
            let badge = matched.querySelector('[data-flow-seq-badge]');
            if (!badge) {
              badge = document.createElement('div');
              badge.setAttribute('data-flow-seq-badge', 'true');
              badge.style.cssText = BADGE_CSS;
              matched.appendChild(badge);
            }
            badge.style.background = colors.bg;
            badge.textContent = `${colors.emoji} ${seqDisplay}`;

            // ─── LƯU SEQ VÀO MAP PERSISTENT (trên window) ───
            if (!window.__flowSeqMap) window.__flowSeqMap = new Map();
            window.__flowSeqMap.set(seqDisplay, {
              cleanQuery, numOnly, status: cardStatus
            });

            // ─── MUTATION OBSERVER THÔNG MINH: TÌM LẠI CARD KHI FLOW RE-RENDER ───
            if (!window.__flowSeqObserver) {
              let _reapplyTimer = null;

              const _applyBadgeToCard = (card, seq, st) => {
                // Guard: container quá lớn → không phải card đơn lẻ
                const _r = card.getBoundingClientRect();
                if (_r.width > 450 || _r.height > 500) return;

                const cMap = { 'RENDERING': 'rgba(0,229,255,0.92)', 'READY': 'rgba(16,185,129,0.92)', 'FAILED': 'rgba(239,68,68,0.92)' };
                const eMap = { 'RENDERING': '⏳', 'READY': '✅', 'FAILED': '❌' };
                const oMap = { 'RENDERING': '#00e5ff', 'READY': '#10b981', 'FAILED': '#ef4444' };
                const cPos = getComputedStyle(card).position;
                if (cPos === 'static') card.style.position = 'relative';
                card.style.outline = `3px solid ${oMap[st] || oMap['RENDERING']}`;
                card.style.outlineOffset = '-1px';
                card.setAttribute('data-flow-seq', seq);
                card.setAttribute('data-flow-seq-status', st);
                let b = card.querySelector('[data-flow-seq-badge]');
                if (!b) {
                  b = document.createElement('div');
                  b.setAttribute('data-flow-seq-badge', 'true');
                  b.style.cssText = 'position:absolute;top:6px;left:6px;z-index:9999;padding:3px 10px;border-radius:6px;font-family:"SF Mono",Consolas,monospace;font-size:13px;font-weight:800;color:#fff;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,0.5);box-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1.4;letter-spacing:0.5px;';
                  card.appendChild(b);
                }
                b.style.background = cMap[st] || cMap['RENDERING'];
                b.textContent = `${eMap[st] || '⏳'} ${seq}`;
              };

              const _getCardContainer = (el) => {
                if (!el) return null;
                let card = el, cur = el.parentElement;
                while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
                  const r = cur.getBoundingClientRect();
                  if (r.width > 450 || r.height > 500 || r.width > window.innerWidth * 0.5) break;
                  const curText = cur.textContent || '';
                  const seqMatches = curText.match(/\b\d{3}[\.\-_:\s]/g) || [];
                  if (new Set(seqMatches.map(s => s.trim())).size > 1) break;
                  card = cur;
                  if (cur.parentElement) {
                    const pr = cur.parentElement.getAttribute('role') || '';
                    if (cur.getAttribute('role') === 'listitem' || pr === 'list' || pr === 'grid') break;
                  }
                  cur = cur.parentElement;
                }
                return card;
              };

              const _reapplyAllLabels = () => {
                if (!window.__flowSeqMap || window.__flowSeqMap.size === 0) return;
                window.__flowSeqMap.forEach((info, seq) => {
                  // Card còn tồn tại và có badge → skip
                  const existing = document.querySelector(`[data-flow-seq="${seq}"]`);
                  if (existing && existing.querySelector('[data-flow-seq-badge]')) return;
                  // Card còn tồn tại nhưng mất badge → gắn lại
                  if (existing) { _applyBadgeToCard(existing, seq, info.status); return; }

                  // Card bị xóa → tìm lại bằng text content
                  const sRegex = info.numOnly ? new RegExp(`(^|[^0-9])${info.numOnly}([\\.\\-_:\\s]|$)`) : null;
                  const textEls = document.querySelectorAll('p, span, div, h1, h2, h3, h4, h5, h6, b, strong');
                  for (const el of textEls) {
                    if (el.closest('[data-slate-editor], form, [class*="composer"], [class*="input-container"]')) continue;
                    // Bỏ qua element đã là badge
                    if (el.hasAttribute('data-flow-seq-badge')) continue;
                    const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (!t) continue;
                    if (t.includes(info.cleanQuery) || (sRegex && sRegex.test(t))) {
                      const card = _getCardContainer(el);
                      if (!card) continue;
                      // Tránh gắn trùng lên card đã có seq khác
                      const cardSeq = card.getAttribute('data-flow-seq');
                      if (cardSeq && cardSeq !== seq) continue;
                      _applyBadgeToCard(card, seq, info.status);
                      break;
                    }
                  }
                });
              };

              window.__flowSeqObserver = new MutationObserver(() => {
                clearTimeout(_reapplyTimer);
                _reapplyTimer = setTimeout(_reapplyAllLabels, 300);
              });
              const listContainer = document.querySelector('[role="list"], [role="grid"], main') || document.body;
              window.__flowSeqObserver.observe(listContainer, { childList: true, subtree: true });
            }
          }
        } catch (_badgeErr) {}

        return { status: cardStatus, ...statusExtra };
      }
    });

    return checkRes?.[0]?.result || { status: 'WAITING_CARD' };
  } catch (err) {
    return { status: 'ERROR', error: err.message };
  }
}

async function waitAndDownloadCard(projectId, promptText, timeoutMs = 600000) {
  const seqMatch = promptText ? promptText.trim().match(/^(\d+[\.\-_:\s])/i) : null;
  const query = seqMatch ? seqMatch[1].toLowerCase() : (promptText ? promptText.slice(0, 20).toLowerCase() : "001.");

  const flowTab = await getFlowTab('video', projectId);
  if (!flowTab?.id) {
    return { success: false, error: "Không tìm thấy tab Google Flow đang mở!" };
  }

  logToBridge(`[Auto Download] Bắt đầu theo dõi card "${query}" để tải 720p...`);
  const startTime = Date.now();
  const pollInterval = 3500;
  let lastProgress = "";

  // Quét 1 lần trước khi bắt đầu poll → đánh dấu tất cả card hiện có
  try { await scanFlowCards(flowTab.id, projectId); } catch (_) {}

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, pollInterval));

    // Quét lại trước khi check → cập nhật badge cho card mới/thay đổi
    try { await scanFlowCards(flowTab.id, projectId); } catch (_) {}

    const cardInfo = await checkCardStatus(projectId, query, promptText, "", "", 'video');
    const cardStatus = cardInfo?.status;

    if (cardStatus === 'RENDERING') {
      const prog = cardInfo.progress || "Đang render...";
      if (prog !== lastProgress) {
        lastProgress = prog;
        logToBridge(`[Auto Download] Card "${query}" đang render (${prog})...`);
        chrome.runtime.sendMessage({
          action: "DOWNLOAD_STATUS_UPDATE",
          query,
          status: 'RENDERING',
          progress: prog
        }).catch(() => {});
      }
    } else if (cardStatus === 'READY') {
      logToBridge(`[Auto Download] 🎉 Card "${query}" đã render xong! Bắt đầu tải 720p native...`);
      chrome.runtime.sendMessage({
        action: "DOWNLOAD_STATUS_UPDATE",
        query,
        status: 'READY',
        progress: "Render hoàn tất! Đang kích hoạt tải 720p..."
      }).catch(() => {});

      // Đợi 1s cho thẻ video hiển thị ổn định
      await new Promise(r => setTimeout(r, 1000));
      const dlResult = await triggerNativeDownloadForCard(flowTab.id, query, promptText, cardInfo?.mediaId || "", "", 'video', projectId);
      return dlResult;
    } else if (cardStatus === 'FAILED') {
      logToBridge(`[Auto Download] ❌ Card "${query}" render thất bại!`);
      return { success: false, error: cardInfo?.error || "Render thất bại trên Flow" };
    }
  }

  return { success: false, error: "Quá thời gian chờ render (timeout)" };
}

const _activeDeliveries = new Set();
const _completedDeliveries = new Set();

async function pollAndDeliverVideo(taskId, mediaId, projectId, promptText = '') {
  if (!taskId) return;
  if (_completedDeliveries.has(taskId)) {
    logToBridge(`Task ${taskId} đã hoàn thành và gửi file trước đó, bỏ qua.`);
    return;
  }
  if (_activeDeliveries.has(taskId)) {
    logToBridge(`Task ${taskId} đang trong tiến trình theo dõi/tải, không chạy trùng lặp.`);
    return;
  }
  _activeDeliveries.add(taskId);

  logToBridge(`Bắt đầu theo dõi video: task ${taskId}${mediaId ? ', mediaId: ' + mediaId : ''}${promptText ? ', prompt: "' + promptText.slice(0, 30) + '..."' : ''}`);
  const maxAttempts = 120; // Poll up to 10-12 minutes (every 5s)
  const pollInterval = 5000;
  const pollStartTime = Date.now();
  let finalMediaId = mediaId || null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollInterval));
    try {
      let isSuccess = false;
      let isFailed = false;
      let failMsg = '';
      let directDownloadTarget = null;

      const flowTab = await getFlowTab('video', projectId);
      if (!flowTab?.id) {
        if (attempt % 6 === 0) logToBridge(`Task ${taskId} đang đợi tab Flow sẵn sàng...`);
        continue;
      }

      // ── BƯỚC 1: Quét trạng thái thẻ bằng checkCardStatus (đồng bộ 100% cơ chế Tab Auto Click UI) ──
      try {
        // Quét card trước → đánh dấu STT cho checkCardStatus dùng
        try { await scanFlowCards(flowTab.id, projectId); } catch (_) {}
        const cardInfo = await checkCardStatus(projectId, promptText, promptText, finalMediaId, null, 'video');
        if (cardInfo) {
          if (cardInfo.mediaId && !finalMediaId) finalMediaId = cardInfo.mediaId;
          if (cardInfo.status === 'READY') {
            isSuccess = true;
            if (cardInfo.videoUrl) directDownloadTarget = cardInfo.videoUrl;
          } else if (cardInfo.status === 'FAILED') {
            isFailed = true;
            failMsg = cardInfo.error || 'Video tạo thất bại trên Flow';
          } else if (cardInfo.status === 'RENDERING') {
            if (attempt % 3 === 0) {
              logToBridge(`Task ${taskId} đang render trên Flow (${cardInfo.progress || 'RENDERING'})... [lần ${attempt}/${maxAttempts}]`);
            }
          }
        }
      } catch (domErr) {
        console.warn("[pollAndDeliverVideo] Lỗi checkCardStatus:", domErr);
      }

      // ── BƯỚC 2: Fallback kiểm tra thư viện project (getProjectVideos) ──
      if (!isSuccess && !isFailed) {
        try {
          const pData = await getProjectVideos(projectId, flowTab);
          if (pData?.success && Array.isArray(pData.videos) && pData.videos.length > 0) {
            const vid = pData.videos.find(v => 
              (finalMediaId && (v.mediaId === finalMediaId || v.workflowId === finalMediaId)) ||
              (promptText && v.prompt && v.prompt.toLowerCase().includes(promptText.slice(0, 15).toLowerCase()))
            );
            if (vid) {
              if (vid.mediaId && !finalMediaId) finalMediaId = vid.mediaId;
              if (vid.status === 'COMPLETED') {
                isSuccess = true;
                if (vid.videoUrl) directDownloadTarget = vid.videoUrl;
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

      // ── BƯỚC 3: Xử lý khi video HOÀN THÀNH ──
      if (isSuccess) {
        logToBridge(`🎉 Task ${taskId} (${finalMediaId || 'Flow Video'}) HOÀN THÀNH! Đang lấy video về máy...`);

        let videoBase64 = null;
        let videoSize = 0;
        let downloadedFilePath = null;

        // ── Cách 0: Thử tải trực tiếp Native 720p qua UI Flow (CDP Hardware Mouse) ──
        if (flowTab?.id) {
          try {
            logToBridge(`[Download] Thử tải video 720p gốc qua Native UI cho "${promptText?.slice(0, 20)}"...`);
            const nativeRes = await triggerNativeDownloadForCard(flowTab.id, promptText, promptText, finalMediaId, null, 'video', projectId);
            if (nativeRes?.success && nativeRes?.filename && !nativeRes.filename.endsWith('.crdownload')) {
              downloadedFilePath = nativeRes.filename;
              videoSize = nativeRes.downloadItem?.fileSize || 0;
              logToBridge(`[Download] ✅ Native UI tải thành công duy nhất: ${downloadedFilePath}`);
            }
          } catch (nativeErr) {
            console.warn("[Flow Extension] Native download error in pollAndDeliverVideo:", nativeErr.message);
          }
        }

        // ── Cách 1: Tải trực tiếp qua chrome.downloads bằng mediaId CHỈ KHI Cách 0 CHƯA TẢI ĐƯỢC ──
        if (!downloadedFilePath && finalMediaId) {
          try {
            logToBridge(`[Download] Thử tải file trực tiếp qua chrome.downloads cho media: ${finalMediaId}...`);
            const dlRes = await downloadVideoFileToDisk(finalMediaId);
            if (dlRes?.filePath && !dlRes.filePath.endsWith('.crdownload')) {
              downloadedFilePath = dlRes.filePath;
              videoSize = dlRes.fileSize || 0;
              logToBridge(`[Download] ✅ Tải file thành công: ${downloadedFilePath} (${(videoSize / 1024 / 1024).toFixed(2)} MB)`);
              try { chrome.downloads.erase({ id: dlRes.downloadId }); } catch (_) {}
            }
          } catch (dlErr) {
            console.warn("[Flow Extension] downloadVideoFileToDisk by mediaId error:", dlErr.message);
          }
        }

        // ── Cách 2: In-Tab Fetch (Lấy blob từ thẻ <video> đang chiếu trên tab hoặc redirect trong tab) ──
        if (!downloadedFilePath) {
          try {
            logToBridge(`[Download] Thử trích xuất video trực tiếp từ ngữ cảnh tab Flow...`);
            const tabFetchRes = await chrome.scripting.executeScript({
              target: { tabId: flowTab.id },
              world: "MAIN",
              args: [finalMediaId, directDownloadTarget],
              func: async (mId, fallbackUrl) => {
                try {
                  // A. Quét tất cả thẻ <video> đang hiển thị trên trang (hỗ trợ cả blob: URLs và direct URLs)
                  const vids = Array.from(document.querySelectorAll("video"));
                  for (const v of vids) {
                    const s = v.currentSrc || v.src || v.querySelector("source")?.src;
                    if (s) {
                      try {
                        const r = await fetch(s);
                        if (r.ok) {
                          const b = await r.blob();
                          if (b && b.size > 20000) {
                            const reader = new FileReader();
                            const base64 = await new Promise((res, rej) => {
                              reader.onload = () => res(reader.result.split(",")[1]);
                              reader.onerror = rej;
                              reader.readAsDataURL(b);
                            });
                            return { success: true, base64, size: b.size, source: 'video_blob' };
                          }
                        }
                      } catch (_) {}
                    }
                  }

                  // B. Thử fetch redirect endpoint bên trong tab với cookies
                  if (mId) {
                    try {
                      const redUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mId}&mediaUrlType=MEDIA_URL_TYPE_VIDEO`;
                      const r = await fetch(redUrl, { credentials: "include", redirect: "follow" });
                      if (r.ok) {
                        const b = await r.blob();
                        if (b && b.size > 20000) {
                          const reader = new FileReader();
                          const base64 = await new Promise((res, rej) => {
                            reader.onload = () => res(reader.result.split(",")[1]);
                            reader.onerror = rej;
                            reader.readAsDataURL(b);
                          });
                          return { success: true, base64, size: b.size, source: 'trpc_redirect_blob' };
                        }
                      }
                    } catch (_) {}
                  }

                  // C. Thử click nút Download trên card trong giao diện
                  const cards = Array.from(document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id]"));
                  const matchedCard = (mId ? cards.find(c => (c.getAttribute("data-media-id") || c.getAttribute("data-workflow-id")) === mId) : null) || cards[0];
                  if (matchedCard) {
                    const dlBtn = matchedCard.querySelector("button[aria-label*='Tải'], button[aria-label*='Download'], button[title*='Tải'], button[title*='Download'], svg[data-icon='download']");
                    if (dlBtn) {
                      const clickable = dlBtn.closest("button") || dlBtn;
                      clickable.click();
                      return { success: true, clickedDownload: true };
                    }
                  }

                  return { success: false, error: "Không tìm thấy dữ liệu video trên trang" };
                } catch (e) {
                  return { success: false, error: e.message };
                }
              }
            });

            const tabRes = tabFetchRes?.[0]?.result;
            if (tabRes?.success) {
              if (tabRes.base64) {
                videoBase64 = tabRes.base64;
                videoSize = tabRes.size;
                logToBridge(`[Download] ✅ Lấy xong video trực tiếp từ tab qua ${tabRes.source}!`);
              } else if (tabRes.clickedDownload) {
                logToBridge(`[Download] Đã click nút Tải xuống trên UI Flow, chờ nhận file...`);
                await new Promise(r => setTimeout(r, 3000));
                const recentDls = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
                const recentItem = recentDls.find(d => d.state === 'complete' && Date.now() - new Date(d.startTime).getTime() < 30000);
                if (recentItem) {
                  downloadedFilePath = recentItem.filename;
                  videoSize = recentItem.fileSize || 0;
                  logToBridge(`[Download] ✅ Bắt được file tải từ UI: ${downloadedFilePath}`);
                }
              }
            }
          } catch (fetchErr) {
            console.warn("[Flow Extension] In-tab extraction error:", fetchErr);
          }
        }

        // ── Cách 3: Thử tải qua directDownloadTarget nếu có link HTTP hợp lệ CHỈ KHI CHƯA CÓ FILE ──
        if (!downloadedFilePath && !videoBase64 && directDownloadTarget && directDownloadTarget.startsWith("http")) {
          try {
            const dlRes = await downloadVideoFileToDisk(directDownloadTarget);
            if (dlRes?.filePath && !dlRes.filePath.endsWith('.crdownload')) {
              downloadedFilePath = dlRes.filePath;
              videoSize = dlRes.fileSize || videoSize;
              try { chrome.downloads.erase({ id: dlRes.downloadId }); } catch (_) {}
            }
          } catch (dlErr) {
            console.warn("[Flow Extension] directDownloadTarget fallback error:", dlErr.message);
          }
        }

        if (!videoBase64 && !downloadedFilePath) {
          logToBridge(`⚠️ Task ${taskId} đã READY nhưng chưa lấy được file trong lần thử ${attempt}. Chờ 3s thử lại...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        const sizeMb = (videoSize / 1024 / 1024).toFixed(2);
        logToBridge(`✅ Đã lấy xong video (${sizeMb} MB)! Gửi kết quả về cho tool_video...`);

        _completedDeliveries.add(taskId);
        _activeDeliveries.delete(taskId);

        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'VIDEO_RESULT',
            id: taskId,
            mediaId: finalMediaId,
            filePath: downloadedFilePath,
            base64: videoBase64,
            downloadUrl: directDownloadTarget,
            ok: true
          }));
        }

        return;
      }

      if (isFailed) {
        logToBridge(`❌ Task ${taskId} THẤT BẠI: ${failMsg}`);
        _completedDeliveries.add(taskId);
        _activeDeliveries.delete(taskId);
        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'VIDEO_RESULT',
            id: taskId,
            mediaId: finalMediaId,
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
        _completedDeliveries.add(taskId);
        _activeDeliveries.delete(taskId);
        if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
          _toolWs.send(JSON.stringify({
            type: 'VIDEO_RESULT',
            id: taskId,
            mediaId: finalMediaId,
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
  _completedDeliveries.add(taskId);
  _activeDeliveries.delete(taskId);
  if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
    _toolWs.send(JSON.stringify({
      type: 'VIDEO_RESULT',
      id: taskId,
      mediaId: finalMediaId,
      ok: false,
      error: 'Timeout quá 10 phút chờ Google Flow render video'
    }));
  }
}


async function testUiStep(step, req) {
  const isImageStep = typeof step === 'string' && step.startsWith("img_");
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = null;
  if (activeTab && activeTab.url && (activeTab.url.includes("labs.google") || activeTab.url.includes("flow.google.com"))) {
    tab = activeTab;
  } else {
    tab = await getFlowTab(isImageStep ? 'image' : 'video', req.projectId);
  }
  if (!tab) return { success: false, error: "Cần mở ít nhất một tab Google Flow!" };
  
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 400));
  } catch (_) {}

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [step, req.prompt || req.query || "", req.config || {}],
      func: async (stepIdx, promptText, cfg) => {
        try {
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
                    
        const isElemVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden";
        };

        const composerButtons = queryDeep("button, [role='button']");
        
        const triggerClick = (el) => {
          if (!el) return false;
          const target = el.closest("button, [role='button'], [role='tab'], [role='radio'], [role='combobox'], [role='menuitem']") || el;
          target.scrollIntoView({ block: "nearest" });
          target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          if (typeof target.click === "function") {
            target.click();
          } else {
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          return true;
        };

        const safeClick = (el) => {
          if (!el) return false;
          el.scrollIntoView({ block: "nearest" });
          if (typeof el.click === "function") {
            el.click();
          } else {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          return true;
        };

        // 1. Tìm nút Submit (hỗ trợ type=submit, aria-label, svg icon, text arrow/send)
        let submitBtn = composerButtons.find(b => {
          if (!isElemVisible(b)) return false;
          const inner = (b.innerHTML || "").toLowerCase();
          const t = (b.textContent || "").trim().toLowerCase();
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          if (b.getAttribute("type") === "submit") return true;
          if (aria.includes("tạo") || aria.includes("generate") || aria.includes("submit") || aria.includes("send") || aria.includes("gửi") || aria.includes("bắt đầu")) return true;
          return inner.includes("arrow_forward") || inner.includes("send") || t === "arrow_forward" || t === "send" ||
                 Boolean(b.querySelector("svg.lucide-arrow-right, svg.lucide-send, svg.lucide-arrow-up, svg[data-icon='send'], svg[data-icon='arrow-right'], svg[data-icon='arrow-up']"));
        });

        // Dự phòng: Tìm submitBtn từ editor (nút ngoài cùng bên phải trong khung soạn thảo)
        if (!submitBtn && editor) {
          let parent = editor;
          for (let i = 0; i < 8 && parent; i++) {
            parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
            if (!parent) break;
            const buttonsHere = queryScopeDeep(parent, "button, [role='button']").filter(b => isElemVisible(b));
            if (buttonsHere.length > 0) {
              const sorted = [...buttonsHere].sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
              const candidate = sorted.find(b => {
                const t = (b.textContent || "").trim().toLowerCase();
                const aria = (b.getAttribute("aria-label") || "").toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add") || aria.includes("tác nhân") || aria.includes("agent")) return false;
                if (t.includes("video") || t.includes("ảnh") || t.includes("image") || t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.match(/\b(720p|1080p|4k|giây|fps|16:9|9:16)\b/i) || t.match(/^\d+s/i)) return false;
                return true;
              });
              if (candidate) {
                submitBtn = candidate;
                break;
              }
            }
          }
        }

        // 2. Tìm Settings Chip (nằm cạnh submitBtn hoặc dưới ô prompt)
        let settingsChip = null;
        const isSettingChipText = (t) => {
          if (!t) return false;
          return t.includes("video") || t.includes("ảnh") || t.includes("image") || 
                 t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.includes("veo") ||
                 t.match(/\b(720p|1080p|4k|giây|fps|x[1-4]|16:9|9:16|1:1|4:3|3:4)\b/i) || t.match(/^\d+s/i);
        };

        // Cách A: Tìm anh em bên cạnh submitBtn
        if (submitBtn) {
           const sRect = submitBtn.getBoundingClientRect();
           let parent = submitBtn;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn || !isElemVisible(b)) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                return isSettingChipText(t);
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
                 const leftOfSubmit = buttonsHere.filter(b => {
                   if (b === submitBtn || !isElemVisible(b)) return false;
                   return b.getBoundingClientRect().left < sRect.left;
                 });
                 leftOfSubmit.sort((a, b) => Math.abs(sRect.left - a.getBoundingClientRect().right) - Math.abs(sRect.left - b.getBoundingClientRect().right));
                 const candidate = leftOfSubmit.find(b => {
                   const t = (b.textContent || "").trim().toLowerCase();
                   if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                   return true;
                 });
                 if (candidate) {
                   settingsChip = candidate;
                   break;
                 }
              }
           }
        }

        // Cách B: Tìm từ Editor đi lên các node cha của khung soạn thảo
        if (!settingsChip && editor) {
           let parent = editor;
           for (let i = 0; i < 8 && parent; i++) {
             parent = parent.parentNode || (parent.getRootNode && parent.getRootNode().host);
             if (!parent) break;
             const buttonsHere = queryScopeDeep(parent, "button, [role='button']");
             const candidate = buttonsHere.find(b => {
                if (b === submitBtn || !isElemVisible(b)) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
                return isSettingChipText(t);
             });
             if (candidate) {
               settingsChip = candidate;
               break;
             }
           }
        }

        // Cách C: Quét toàn bộ nút trong vùng composer nửa dưới màn hình
        if (!settingsChip) {
          const candidates = composerButtons.filter(b => {
             if (b === submitBtn || !isElemVisible(b)) return false;
             if (b.closest("[data-media-id], [data-workflow-id], [class*='card'], [role='listitem']")) return false;
             const r = b.getBoundingClientRect();
             if (r.top < 120) return false;
             const t = (b.textContent || "").trim().toLowerCase();
             if (t.includes("tác nhân") || t.includes("agent") || t === "+" || b.innerHTML.toLowerCase().includes("add")) return false;
             return isSettingChipText(t);
          });
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
            settingsChip = candidates[0];
          }
        }

        // Helper tìm tab Video
        const findVideoTabElement = () => {
          const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
            if (!isElemVisible(el)) return false;
            if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
            const r = el.getBoundingClientRect();
            if (r.left < 150) return false;
            if (r.width < 30 || r.height < 15) return false;
            if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

            const t = (el.textContent || "").trim();
            const aria = (el.getAttribute("aria-label") || "").trim();
            const id = (el.getAttribute("id") || "").toLowerCase();

            if (t.includes("Khung hình") || aria.includes("Khung hình") || t.includes("Hình ảnh") || aria.includes("Hình ảnh")) return false;
            if (t.includes("Video ·") || t.includes("giây") || t.includes("720p") || t.includes("1080p") || t.includes("fps")) return false;

            return t === "Video" || aria === "Video" || 
                   t.toLowerCase() === "video" || aria.toLowerCase() === "video" ||
                   id.endsWith("-trigger-video") || id.endsWith("-trigger-VIDEO") || 
                   (t.includes("Video") && t.length <= 10) ||
                   (aria.includes("Video") && aria.length <= 10);
          });

          if (candidates.length === 0) return null;

          let best = candidates.find(el => {
            const p = el.parentElement;
            if (p && (p.textContent.includes("Hình ảnh") || p.getAttribute("role") === "tablist")) return true;
            const gp = p?.parentElement;
            if (gp && (gp.textContent.includes("Hình ảnh") || gp.getAttribute("role") === "tablist")) return true;
            return false;
          });

          if (!best) {
            best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
          }

          return best.closest("[role='tab'], button, [role='button']") || best;
        };

        // Helper tìm tab Hình ảnh
        const findImageTabElement = () => {
          const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
            if (!isElemVisible(el)) return false;
            if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
            const r = el.getBoundingClientRect();
            if (r.left < 150) return false;
            if (r.width < 30 || r.height < 15) return false;
            if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

            const t = (el.textContent || "").trim();
            const aria = (el.getAttribute("aria-label") || "").trim();
            const id = (el.getAttribute("id") || "").toLowerCase();

            if (t.includes("Khung hình") || aria.includes("Khung hình")) return false;

            return t === "Hình ảnh" || aria === "Hình ảnh" || 
                   t.toLowerCase() === "image" || aria.toLowerCase() === "image" ||
                   id.endsWith("-trigger-image") || id.endsWith("-trigger-IMAGE") ||
                   (t.includes("Hình ảnh") && t.length <= 15) ||
                   (aria.includes("Hình ảnh") && aria.length <= 15);
          });

          if (candidates.length === 0) return null;

          let best = candidates.find(el => {
            const p = el.parentElement;
            if (p && (p.textContent.includes("Video") || p.getAttribute("role") === "tablist")) return true;
            const gp = p?.parentElement;
            if (gp && (gp.textContent.includes("Video") || gp.getAttribute("role") === "tablist")) return true;
            return false;
          });

          if (!best) {
            best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
          }

          return best.closest("[role='tab'], button, [role='button']") || best;
        };

        // Kiểm tra xem Popover đã mở chưa
        const isPopoverOpen = () => {
          if (findVideoTabElement() || findImageTabElement()) return true;
          const ratioBtn = queryDeep("button, [role='tab'], [role='radio']").find(el => {
            if (!isElemVisible(el)) return false;
            if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
            if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
            const r = el.getBoundingClientRect();
            if (r.left < 150) return false;
            const t = (el.textContent || "").trim();
            return t === "16:9" || t === "9:16";
          });
          return !!ratioBtn;
        };

        // Mở popover an toàn nếu chưa mở
        const ensurePopoverOpen = async () => {
          if (isPopoverOpen()) return true;
          if (!settingsChip) throw new Error("Không tìm thấy nút Settings Chip để mở bảng cài đặt");
          const targetChip = settingsChip.closest("button, [role='button']") || settingsChip;
          targetChip.scrollIntoView({ block: "nearest" });
          targetChip.click();
          await sleep(600);
          if (!isPopoverOpen()) {
            targetChip.click();
            await sleep(600);
          }
          return isPopoverOpen();
        };

        if (stepIdx === 1) {
          if (!editor) throw new Error("Không tìm thấy ô nhập prompt (Editor)");
          editor.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, promptText);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          return "Đã điền prompt thành công!";
        }

        if (stepIdx === 2) {
          if (!settingsChip) {
            if (isPopoverOpen()) {
              return "Bảng cài đặt (Popover) hiện đang mở sẵn trên giao diện Flow!";
            }
            throw new Error("Không tìm thấy nút Settings Chip");
          }
          const targetChip = settingsChip.closest("button, [role='button']") || settingsChip;
          targetChip.scrollIntoView({ block: "nearest" });

          // Bấm 1 lần duy nhất bằng native .click()
          targetChip.click();
          await sleep(600);

          // Nếu popover chưa mở (ví dụ trước đó đang mở nên bị tắt, hoặc click lần 1 chưa ăn), bấm thêm 1 lần để đảm bảo popover mở
          if (!isPopoverOpen()) {
            targetChip.click();
            await sleep(600);
          }

          return isPopoverOpen()
            ? `✅ Đã bấm Settings Chip và mở Popover thành công! ("${targetChip.textContent.trim().slice(0, 35)}")`
            : `Đã bấm Settings Chip! ("${targetChip.textContent.trim().slice(0, 35)}")`;
        }

        if (stepIdx === 3) {
          if (!submitBtn) throw new Error("Không tìm thấy nút Bắt Đầu (Submit)");
          submitBtn.removeAttribute("disabled");
          submitBtn.setAttribute("aria-disabled", "false");
          triggerClick(submitBtn);
          return `Đã bấm Submit! ("${(submitBtn.getAttribute('aria-label') || submitBtn.textContent || 'Submit').trim().slice(0, 35)}")`;
        }

        
        if (stepIdx === 4.6) {
                const results = [];
                // Find file inputs
                const fileInputs = Array.from(document.querySelectorAll("input[type='file']"));
                results.push(`TÌM THẤY ${fileInputs.length} THẺ <input type="file">`);
                fileInputs.forEach((fi, i) => {
                    results.push(`[File ${i}] id: ${fi.id}, accept: ${fi.accept}, style: ${fi.getAttribute('style')}`);
                });
                
                // Find frame buttons
                const slots = Array.from(document.querySelectorAll("button, [role='button'], div[aria-haspopup='dialog']"))
                  .filter(el => {
                    const t = (el.textContent || "").toLowerCase();
                    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
                    return t.includes("bắt đầu") || t.includes("kết thúc") 
                        || aria.includes("bắt đầu") || aria.includes("kết thúc")
                        || t.includes("start frame") || t.includes("end frame")
                        || aria.includes("start frame") || aria.includes("end frame")
                        || t === "start" || t === "end" || t.includes("khung hình bắt đầu") || t.includes("khung hình kết thúc");
                  });
                results.push(`\nTÌM THẤY ${slots.length} NÚT KHUNG HÌNH`);
                slots.forEach((s, i) => {
                    results.push(`[Nút ${i}] text: ${s.textContent.trim().substring(0,20)}, outerHTML: ${s.outerHTML.substring(0, 150)}`);
                });
                
                return results.join("\n");
            }

            if (stepIdx === 4.7 || stepIdx === 4.8) {
                // Hàm lấy element đang được focus (kể cả trong Shadow DOM)
                const getDeepActiveElement = (root = document) => {
                    if (root.activeElement && root.activeElement.shadowRoot) {
                        return getDeepActiveElement(root.activeElement.shadowRoot);
                    }
                    return root.activeElement;
                };

                const isElemVisible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden";
                };

                // 1. Tìm element chứa chữ "Bạn muốn tạo" hoặc là ProseMirror
                const candidates = queryDeep("*").filter(e => {
                    if (!isElemVisible(e)) return false;
                    const r = e.getBoundingClientRect();
                    if (r.top < 150) return false; // Bỏ qua thanh tìm kiếm ở trên cùng
                    
                    const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                    const text = (e.textContent || "").toLowerCase();
                    const isEditable = e.isContentEditable || e.tagName === "TEXTAREA" || e.tagName === "INPUT";
                    
                    return ph.includes("bạn muốn tạo") || text.includes("bạn muốn tạo") || e.classList.contains("ProseMirror") || isEditable;
                });
                
                // Lọc những thằng có khả năng nhất
                let targetEl = candidates.find(e => {
                    const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                    return ph.includes("bạn muốn tạo") || e.classList.contains("ProseMirror");
                });
                
                if (!targetEl) targetEl = candidates.find(e => (e.textContent || "").toLowerCase().includes("bạn muốn tạo"));
                if (!targetEl && candidates.length > 0) targetEl = candidates[candidates.length - 1]; // Lấy thằng cuối cùng (thường ở dưới cùng)

                if (!targetEl) throw new Error("Không tìm thấy bất kỳ ô chữ nào để click vào!");

                // Cực kỳ bạo lực để focus: Click thẳng vào phần tử đó để browser tự focus!
                targetEl.scrollIntoView({ block: "center" });
                targetEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                targetEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                targetEl.click();
                if (typeof targetEl.focus === 'function') targetEl.focus();
                
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                await sleep(400);

                // Lấy đúng phần tử ĐANG ĐƯỢC FOCUS sau cú click
                let activeEl = getDeepActiveElement() || targetEl;

                if (stepIdx === 4.7) {
                    return "Đã click vào vùng có chữ 'Bạn muốn tạo...'. Con trỏ có đang nháy ở đó không? Nếu có, bạn thử Command+V bằng tay ngay nhé!";
                }

                if (stepIdx === 4.8) {
                    // Red 10x10 pixel PNG
                    const base64Img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5mB/1w4q3bAAAAAElFTkSuQmCC";
                    const res = await fetch(base64Img);
                    const blob = await res.blob();
                    const file = new File([blob], "test-auto-paste.png", { type: "image/png" });
                    
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    
                    // Thử chèn thẳng vào file input nếu có
                    const fileInputs = Array.from(document.querySelectorAll("input[type='file']"));
                    if (fileInputs.length > 0) {
                        fileInputs[0].files = dt.files;
                        fileInputs[0].dispatchEvent(new Event("change", { bubbles: true }));
                    }

                    // Bắn Paste vào Active Element
                    const pasteEvent = new ClipboardEvent("paste", {
                        clipboardData: dt,
                        bubbles: true,
                        cancelable: true
                    });
                    
                    activeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: false, metaKey: true, bubbles: true }));
                    activeEl.dispatchEvent(pasteEvent);
                    
                    // Thử Drop thẳng vào Active Element
                    const dropEvent = new DragEvent("drop", {
                        dataTransfer: dt,
                        bubbles: true,
                        cancelable: true
                    });
                    activeEl.dispatchEvent(dropEvent);
                    
                    return "Đã bắn lệnh Paste/Drop trực tiếp vào phần tử đang focus (" + activeEl.tagName + ") và tiêm file ẩn. Bạn chờ xem ảnh có lên không nhé.";
                }
            }


        
        if (Math.floor(Number(stepIdx)) === 4 || String(stepIdx).startsWith("4") || stepIdx === "4.0_frames" || stepIdx === "4.0b") {
          if (!isPopoverOpen() && !settingsChip) throw new Error("Không tìm thấy nút Settings Chip để mở bảng cài đặt");

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

          const safeClick = (el) => {
            if (!el) return false;
            el.scrollIntoView({ block: "nearest" });
            if (typeof el.click === "function") {
              el.click();
            } else {
              el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }
            return true;
          };

          const safeToggle = async (el) => {
            if (!el) return;
            const target = el.closest("button, [role='combobox']") || el;
            target.scrollIntoView({ block: "nearest" });
            
            // Check if already expanded
            if (target.getAttribute("aria-expanded") === "true") return;
            
            // Try standard click
            try { target.click(); } catch (_) {}
            await sleep(300);
            
            if (target.getAttribute("aria-expanded") !== "true" && !document.querySelector("[role='listbox']")) {
                target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
                target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
                target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                if (typeof target.click === "function") target.click();
                else target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                await sleep(300);
            }
          };

          // Tìm tab "Video"
          const findVideoTabElement = () => {
            const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              if (r.width < 30 || r.height < 15) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

              const t = (el.textContent || "").trim();
              const aria = (el.getAttribute("aria-label") || "").trim();
              const id = (el.getAttribute("id") || "").toLowerCase();

              if (t.includes("Khung hình") || aria.includes("Khung hình") || t.includes("Hình ảnh") || aria.includes("Hình ảnh")) return false;
              if (t.includes("Video ·") || t.includes("giây") || t.includes("720p") || t.includes("1080p") || t.includes("fps")) return false;

              return t === "Video" || aria === "Video" || 
                     t.toLowerCase() === "video" || aria.toLowerCase() === "video" ||
                     id.endsWith("-trigger-video") || id.endsWith("-trigger-VIDEO") || 
                     (t.includes("Video") && t.length <= 10) ||
                     (aria.includes("Video") && aria.length <= 10);
            });

            if (candidates.length === 0) return null;

            let best = candidates.find(el => {
              const p = el.parentElement;
              if (p && (p.textContent.includes("Hình ảnh") || p.getAttribute("role") === "tablist")) return true;
              const gp = p?.parentElement;
              if (gp && (gp.textContent.includes("Hình ảnh") || gp.getAttribute("role") === "tablist")) return true;
              return false;
            });

            if (!best) {
              best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
            }

            return best.closest("[role='tab'], button, [role='button']") || best;
          };

          // Tìm tab "Hình ảnh"
          const findImageTabElement = () => {
            const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              if (r.width < 30 || r.height < 15) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

              const t = (el.textContent || "").trim();
              const aria = (el.getAttribute("aria-label") || "").trim();
              const id = (el.getAttribute("id") || "").toLowerCase();

              if (t.includes("Khung hình") || aria.includes("Khung hình")) return false;

              return t === "Hình ảnh" || aria === "Hình ảnh" || 
                     t.toLowerCase() === "image" || aria.toLowerCase() === "image" ||
                     id.endsWith("-trigger-image") || id.endsWith("-trigger-IMAGE") ||
                     (t.includes("Hình ảnh") && t.length <= 15) ||
                     (aria.includes("Hình ảnh") && aria.length <= 15);
            });

            if (candidates.length === 0) return null;

            let best = candidates.find(el => {
              const p = el.parentElement;
              if (p && (p.textContent.includes("Video") || p.getAttribute("role") === "tablist")) return true;
              const gp = p?.parentElement;
              if (gp && (gp.textContent.includes("Video") || gp.getAttribute("role") === "tablist")) return true;
              return false;
            });

            if (!best) {
              best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
            }

            return best.closest("[role='tab'], button, [role='button']") || best;
          };

          const isPopoverOpen = () => {
            if (findVideoTabElement() || findImageTabElement()) return true;
            const ratioBtn = queryDeep("button, [role='tab'], [role='radio']").find(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (el.textContent || "").trim();
              return t === "16:9" || t === "9:16";
            });
            return !!ratioBtn;
          };

          // Mở popover an toàn nếu chưa mở
          const ensurePopoverOpen = async () => {
            if (!isPopoverOpen() && settingsChip) {
              settingsChip.scrollIntoView({ block: "nearest" });
              settingsChip.click();
              await sleep(600);
              if (!isPopoverOpen()) {
                settingsChip.click();
                await sleep(600);
              }
            }
          };

          // Helper to select the Video Tab
          const selectVideoTab = async () => {
            await ensurePopoverOpen();
            const tabEl = findVideoTabElement();
            if (tabEl) {
              const isActive = tabEl.getAttribute("data-state") === "active" || 
                               tabEl.getAttribute("aria-selected") === "true" ||
                               tabEl.classList.contains("active") ||
                               (tabEl.parentElement && tabEl.parentElement.getAttribute("data-state") === "active");
              if (!isActive) {
                safeClick(tabEl);
                await sleep(400);
              }
              return { success: true, el: tabEl };
            }
            return { success: false };
          };

          // Helper to select the Image Tab
          const selectImageTab = async () => {
            await ensurePopoverOpen();
            const tabEl = findImageTabElement();
            if (tabEl) {
              const isActive = tabEl.getAttribute("data-state") === "active" || 
                               tabEl.getAttribute("aria-selected") === "true" ||
                               tabEl.classList.contains("active") ||
                               (tabEl.parentElement && tabEl.parentElement.getAttribute("data-state") === "active");
              if (!isActive) {
                safeClick(tabEl);
                await sleep(400);
              }
              return { success: true, el: tabEl };
            }
            return { success: false };
          };

          // Helper to select the Khung hình (Frames) Tab
          const selectFramesTab = async () => {
            await ensurePopoverOpen();
            // Đảm bảo tab Video đã được kích hoạt trước
            await selectVideoTab();
            await sleep(400);

            const isFramesMatch = (el) => {
              if (!el) return false;
              const t = (el.textContent || "").trim();
              const tLower = t.toLowerCase();
              const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
              const id = (el.getAttribute("id") || "").toLowerCase();
              const dataVal = (el.getAttribute("data-value") || "").toLowerCase();
              const html = el.innerHTML || "";

              // Loại trừ các tab khác
              if (t === "Hình ảnh" || t === "Video" || aria === "video" || aria === "hình ảnh") return false;
              if (t === "Thành phần" || aria === "thành phần" || tLower.includes("thành phần") || aria.includes("thành phần")) return false;

              if (tLower === "khung hình" || tLower === "frames" || tLower === "frame") return true;
              if (aria === "khung hình" || aria === "frames" || aria.includes("khung hình") || aria.includes("frames")) return true;
              if (id.includes("video_frames") || id.includes("frames") || id.includes("frame")) return true;
              if (dataVal === "frames" || dataVal === "video_frames") return true;
              if (html.includes("crop_free") || tLower.includes("crop_free")) return true;
              if ((tLower.includes("khung hình") || tLower.includes("frames")) && t.length <= 25) return true;
              return false;
            };

            let target = null;
            let lastAvailable = "";

            for (let attempt = 0; attempt < 6; attempt++) {
              const allButtons = queryDeep("[role='tab'], button, [role='button']").filter(el => {
                if (!isElemVisible(el)) return false;
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                const r = el.getBoundingClientRect();
                return r.left >= 150;
              });

              target = allButtons.find(b => isFramesMatch(b));

              if (!target) {
                const subEls = queryDeep("span, div, svg, i, p").filter(el => {
                  if (!isElemVisible(el)) return false;
                  if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                  if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                  const r = el.getBoundingClientRect();
                  if (r.left < 150) return false;
                  const t = (el.textContent || "").trim();
                  return t.length <= 30 && isFramesMatch(el);
                });
                for (const sub of subEls) {
                  const pBtn = sub.closest("[role='tab'], button, [role='button']");
                  if (pBtn && isElemVisible(pBtn) && (!settingsChip || !settingsChip.contains(pBtn))) {
                    target = pBtn;
                    break;
                  }
                }
              }

              if (target) break;

              lastAvailable = allButtons.map(b => `[${b.tagName} role="${b.getAttribute("role")||""}" text="${(b.textContent||"").trim()}"]`).join(", ");
              await sleep(250);
            }

            if (target) {
              const clickable = target.closest("[role='tab'], button, [role='button']") || target;
              safeClick(clickable);
              await sleep(400);
              return { success: true, el: clickable };
            }

            return { success: false, available: lastAvailable };
          };

          if (stepIdx === 4.0 || stepIdx === "4.0") {
            const res = await selectVideoTab();
            if (res.success) {
              return `Đã bấm sang Tab Video thành công! (Tag: <${res.el.tagName.toLowerCase()}> text="${res.el.textContent.trim()}")`;
            }
            throw new Error("Không tìm thấy nút Tab Video trong bảng Popover!");
          }

          if (stepIdx === 4.05 || stepIdx === "4.05" || stepIdx === "4.0_frames" || stepIdx === "4.0b") {
            const res = await selectFramesTab();
            if (res.success) {
              return `Đã bấm sang Tab Khung hình thành công! (Tag: <${res.el.tagName.toLowerCase()}> text="${res.el.textContent.trim()}")`;
            }
            throw new Error("Không tìm thấy nút Tab Khung hình trong Popover! Các nút hiện có: " + (res.available || "Không tìm thấy"));
          }

          if (stepIdx === 4) {
            // 1. Select Mode: "Video" vs "Hình ảnh"
            if (cfg?.mode === 'image' || cfg?.mode === 'Hình ảnh') {
              await selectImageTab();
              await sleep(400);
            } else {
              await selectVideoTab();
              await sleep(400);
            }
          }

          if (stepIdx === 4 || stepIdx === 4.1) {
            await ensurePopoverOpen();
            // 2. Select Aspect Ratio (9:16 vs 16:9)
            const aspectButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (el.textContent || "").trim();
              return t.includes("16:9") || t.includes("9:16");
            });
            const aspectBtn = aspectButtons.find(b => {
              const t = (b.textContent || "").trim();
              const aria = (b.getAttribute("aria-label") || "").trim();
              const comb = t + " " + aria;
              if (targetRatio === "9:16") return comb.includes("9:16") && !comb.includes("16:9");
              return comb.includes("16:9");
            });
            if (aspectBtn) {
              safeClick(aspectBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || aspectBtn);
              await sleep(400);
            }
            if (stepIdx === 4.1) {
              return `Đã chọn Tỷ lệ ${targetRatio} thành công!`;
            }
          }

          // If in Video mode, configure Duration, Count & Video Model
          if (cfg?.mode !== 'image' && cfg?.mode !== 'Hình ảnh') {
            if (stepIdx === 4 || stepIdx === 4.2) {
              await ensurePopoverOpen();
              // 3. Select Duration: "8s"
              const durNum = targetDuration.replace(/\D/g, "");
              const durButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
                if (!isElemVisible(el)) return false;
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                const r = el.getBoundingClientRect();
                if (r.left < 150) return false;
                const t = (el.textContent || "").trim().toLowerCase();
                return t.includes(durNum + "s") || t.includes(durNum + " giây") || t.includes(durNum + " sec") || t === durNum;
              });
              const durBtn = durButtons.find(b => {
                const t = (b.textContent || "").trim().toLowerCase();
                const others = ["4", "5", "6", "8", "10"].filter(x => x !== durNum);
                return !others.some(x => t.includes(x + "s") || t.includes(x + " giây"));
              });
              if (durBtn) {
                safeClick(durBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || durBtn);
                await sleep(400);
              }
              if (stepIdx === 4.2) {
                return `Đã chọn Thời lượng ${targetDuration} thành công!`;
              }
            }

            if (stepIdx === 4 || stepIdx === 4.3) {
              await ensurePopoverOpen();
              // 4. Select Count: "x1"
              const tc = targetCount.toLowerCase();
              const countButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
                if (!isElemVisible(el)) return false;
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                const r = el.getBoundingClientRect();
                if (r.left < 150) return false;
                const t = (el.textContent || "").trim().toLowerCase();
                return t === tc || t.includes(tc) || (tc === "x1" && t === "1x");
              });
              const countBtn = countButtons.find(b => {
                const t = (b.textContent || "").trim().toLowerCase();
                const others = ["x1", "x2", "x3", "x4"].filter(x => x !== tc);
                return !others.some(x => t.includes(x));
              });
              if (countBtn) {
                safeClick(countBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || countBtn);
                await sleep(400);
              }
              if (stepIdx === 4.3) {
                return `Đã chọn Số lượng ${targetCount} thành công!`;
              }
            }

            if (stepIdx === 4 || stepIdx === 4.4) {
              await ensurePopoverOpen();
              if (stepIdx === 4.4) {
                // Đảm bảo tab Video đã được chọn
                await selectVideoTab();
                await sleep(300);
              }

              // 5. Select Model: Veo 3.1 - Lite [Lower Priority]
              const modelDropdown = queryDeep("button, [role='combobox'], [role='button'], div").find(b => {
                if (!isElemVisible(b)) return false;
                if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
                if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                if (b.closest("[role='listbox'], [role='menu']")) return false; 
                const r = b.getBoundingClientRect();
                if (r.left < 150) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                const isModelName = (t.includes("omni") || t.includes("veo") || t.includes("flash") || t.includes("lite") || t.includes("fast") || t.includes("quality")) && t.length < 50;
                const isExcluded = t.includes("9:16") || t.includes("16:9") || t.includes("8s") || t.includes("4s") || t.includes("6s") || t.includes("10s") || t.includes("video") || t.includes("hình ảnh") || t.includes("khung hình") || t.includes("thành phần");
                return isModelName && !isExcluded;
              });

              if (modelDropdown) {
                await safeToggle(modelDropdown);
                await sleep(400); // Give portal time to mount
              }

              const mTxt = (cfg?.model || "veo_3_1_lite_low_priority").toLowerCase();
              const isMatch = (el) => {
                if (el === modelDropdown || modelDropdown?.contains(el)) return false;
                const ot = (el.textContent || "").toLowerCase();
                if (ot.length > 80) return false;
                
                if (mTxt.includes("low_priority") || mTxt.includes("ưu tiên thấp")) {
                  return ot.includes("lower priority") || ot.includes("ưu tiên thấp") || ot.includes("lite [lower priority]") || ot.includes("lite (ưu tiên thấp)");
                }
                if (mTxt.includes("lite")) {
                  return (ot.includes("lite") && !ot.includes("lower priority") && !ot.includes("ưu tiên thấp"));
                }
                if (mTxt.includes("fast")) return ot.includes("fast") || ot.includes("nhanh");
                if (mTxt.includes("quality")) return ot.includes("quality") || ot.includes("chất lượng");
                if (mTxt.includes("abra") || mTxt.includes("omni")) return ot.includes("omni") || ot.includes("flash");
                return false;
              };

              let targetOpt = null;
              let foundOptions = [];
              for (let attempt = 0; attempt < 15; attempt++) {
                const portalCandidates = queryDeep("[role='option'], [role='menuitem'], [role='tab'], button, div, span, li").filter(isElemVisible);
                const actualOptions = portalCandidates.filter(el => {
                  if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                  if (el === modelDropdown || modelDropdown?.contains(el)) return false;
                  if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                  if (el.hasAttribute("aria-haspopup") || el.getAttribute("role") === "combobox" || el.getAttribute("aria-expanded") === "true") return false;
                  return el.getAttribute("role") === "option" || el.getAttribute("role") === "menuitem" || el.closest("[role='listbox']");
                });
                if (actualOptions.length > 0) {
                  foundOptions = actualOptions.map(o => (o.textContent || "").trim()).filter(Boolean);
                  targetOpt = actualOptions.find(el => isMatch(el));
                  if (targetOpt) break;
                } else {
                  targetOpt = portalCandidates.find(el => {
                    if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                    if (el === modelDropdown || modelDropdown?.contains(el)) return false;
                    if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                    if (el.hasAttribute("aria-haspopup") || el.getAttribute("role") === "combobox" || el.getAttribute("aria-expanded") === "true") return false;
                    return isMatch(el);
                  });
                  if (targetOpt) break;
                }
                await sleep(100);
              }

              if (targetOpt) {
                const clickable = targetOpt.closest("[role='option'], [role='menuitem'], [role='tab'], button, li") || targetOpt;
                safeClick(clickable);
                await sleep(500);
                if (stepIdx === 4.4) {
                  return `Đã chọn Model Video thành công: "${(clickable.textContent || "").trim()}"!`;
                }
              } else if (stepIdx === 4.4) {
                const optsSummary = foundOptions.length > 0 ? foundOptions.join(" | ") : "Không mở được menu model hoặc không tìm thấy options";
                throw new Error(`Không chọn được model '${cfg?.model}'. Các options trong dropdown: ${optsSummary}`);
              }
            }
          }

          if (stepIdx === 4) {
            // 5.5 If Khung hình (Frames / I2V) is requested, click "Khung hình" tab
            if (cfg?.isFrames || cfg?.startImage || cfg?.endImage) {
              await selectFramesTab();
              await sleep(500);
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

          }
          // ──────────────────────────────────────────────
} catch(e) { throw e; }

          return `Đã test xong Bước ${stepIdx}! (Ratio: ${targetRatio}, Model: ${cfg?.model}, Dur: ${targetDuration}, Cnt: ${targetCount})`;
        }

        // ══════════════════════════════════════════════════════════
        // CÁC BƯỚC TEST CHO TẠO ẢNH (IMAGE UI: img_tab, img_ratio, img_model, img_count, img_all_config, img_full_create)
        // ══════════════════════════════════════════════════════════
        if (typeof stepIdx === 'string' && stepIdx.startsWith("img_")) {
          if (!isPopoverOpen() && !settingsChip) throw new Error("Không tìm thấy nút Settings Chip để mở bảng cài đặt ảnh");

          const isElemVisible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden";
          };

          const triggerClick = (el) => {
            if (!el) return false;
            const target = el.closest("button, [role='button'], [role='tab'], [role='radio'], [role='combobox'], [role='menuitem']") || el;
            target.scrollIntoView({ block: "nearest" });
            target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            if (typeof target.click === "function") {
              target.click();
            } else {
              target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }
            return true;
          };

          // Tìm tab "Hình ảnh" đang hiển thị trên giao diện
          const findImageTabElement = () => {
            const candidates = queryDeep("[role='tab'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              if (r.width < 30 || r.height < 15) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;

              const t = (el.textContent || "").trim();
              const aria = (el.getAttribute("aria-label") || "").trim();
              const id = (el.getAttribute("id") || "").toLowerCase();

              // Loại bỏ nút Khung hình
              if (t.includes("Khung hình") || aria.includes("Khung hình")) return false;

              // Khớp chính xác hoặc chứa 'Hình ảnh'/'Image'
              return t === "Hình ảnh" || aria === "Hình ảnh" || 
                     t.toLowerCase() === "image" || aria.toLowerCase() === "image" ||
                     id.endsWith("-trigger-image") || id.endsWith("-trigger-IMAGE") ||
                     (t.includes("Hình ảnh") && t.length <= 15) ||
                     (aria.includes("Hình ảnh") && aria.length <= 15);
            });

            if (candidates.length === 0) return null;

            // Ưu tiên phần tử có cha/anh em chứa "Video" hoặc role="tab"
            let best = candidates.find(el => {
              const p = el.parentElement;
              if (p && (p.textContent.includes("Video") || p.getAttribute("role") === "tablist")) return true;
              const gp = p?.parentElement;
              if (gp && (gp.textContent.includes("Video") || gp.getAttribute("role") === "tablist")) return true;
              return false;
            });

            if (!best) {
              best = candidates.find(el => el.getAttribute("role") === "tab" || el.tagName === "BUTTON") || candidates[0];
            }

            return best.closest("[role='tab'], button, [role='button']") || best;
          };

          // Kiểm tra xem Popover Settings có đang mở không
          const isPopoverOpen = () => {
            if (findImageTabElement()) return true;
            const ratioBtn = queryDeep("button, [role='tab'], [role='radio']").find(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (el.textContent || "").trim();
              return t === "16:9" || t === "9:16";
            });
            return !!ratioBtn;
          };

          // Mở popover an toàn: Chỉ click settingsChip nếu popover CHƯA mở
          const ensurePopoverOpen = async () => {
            if (isPopoverOpen()) {
              return true;
            }
            if (!settingsChip) throw new Error("Không tìm thấy nút Settings Chip");

            const targetChip = settingsChip.closest("button, [role='button']") || settingsChip;
            targetChip.scrollIntoView({ block: "nearest" });
            targetChip.click();
            await sleep(600);

            if (isPopoverOpen()) return true;

            // Thử click lần 2 nếu lần đầu chưa ăn
            await sleep(300);
            targetChip.click();
            await sleep(600);

            if (isPopoverOpen()) return true;

            const visibleTexts = queryDeep("button, [role='tab'], [role='button']").filter(b => {
              if (!isElemVisible(b)) return false;
              const r = b.getBoundingClientRect();
              return r.left >= 150 && r.width > 20;
            }).map(b => (b.textContent || b.getAttribute("aria-label") || b.tagName).trim().substring(0, 30)).filter(Boolean);

            throw new Error(`Đã bấm Settings Chip nhưng Popover không mở. Các nút đang hiển thị: [${visibleTexts.slice(0, 10).join(" | ")}]`);
          };

          // 1. Hàm chọn Tab "Hình ảnh"
          const selectImageTab = async () => {
            await ensurePopoverOpen();
            await sleep(300);

            const tab = findImageTabElement();
            if (!tab) {
              const visibleTexts = queryDeep("button, [role='tab'], [role='button'], div, span").filter(b => {
                if (!isElemVisible(b)) return false;
                const r = b.getBoundingClientRect();
                return r.left >= 150 && r.width > 20;
              }).map(b => (b.textContent || "").trim()).filter(t => t.length > 1 && t.length < 30);
              throw new Error(`Không tìm thấy Tab 'Hình ảnh' trong bảng Cài đặt. Các nút trên màn hình: [${visibleTexts.slice(0, 15).join(" | ")}]`);
            }

            const isActive = tab.getAttribute("data-state") === "active" || 
                             tab.getAttribute("aria-selected") === "true" ||
                             tab.classList.contains("active") ||
                             (tab.parentElement && tab.parentElement.getAttribute("data-state") === "active");

            if (isActive) {
              return { success: true, el: tab, alreadyActive: true };
            }

            triggerClick(tab);
            await sleep(400);
            return { success: true, el: tab };
          };

          // 2. Hàm chọn Tỉ lệ Ảnh (16:9, 4:3, 1:1, 3:4, 9:16)
          const selectImageRatio = async (ratioStr = "9:16") => {
            await selectImageTab();
            await sleep(300);

            const cleanTarget = (ratioStr || "9:16").trim();

            const ratioButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(el => {
              if (!isElemVisible(el)) return false;
              if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
              if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = el.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (el.textContent || "").trim();
              return t.includes("16:9") || t.includes("4:3") || t.includes("1:1") || t.includes("3:4") || t.includes("9:16");
            });

            const target = ratioButtons.find(b => {
              const t = (b.textContent || "").trim();
              const aria = (b.getAttribute("aria-label") || "").trim();
              const combined = t + " " + aria;
              if (cleanTarget === "9:16") return combined.includes("9:16") && !combined.includes("16:9");
              if (cleanTarget === "16:9") return combined.includes("16:9");
              if (cleanTarget === "1:1") return combined.includes("1:1");
              if (cleanTarget === "4:3") return combined.includes("4:3") && !combined.includes("3:4");
              if (cleanTarget === "3:4") return combined.includes("3:4") && !combined.includes("4:3");
              return combined.includes(cleanTarget);
            });

            if (target) {
              const clickable = target.closest("[role='tab'], [role='radio'], button, [role='button']") || target;
              triggerClick(clickable);
              await sleep(350);
              return { success: true, text: (clickable.textContent || "").trim() };
            }

            const available = ratioButtons.map(b => (b.textContent || "").trim()).filter(Boolean);
            return { success: false, error: `Không tìm thấy nút tỉ lệ ${cleanTarget}. Có sẵn: [${available.join(", ")}]` };
          };

          // 3. Hàm chọn Model Ảnh (Nano Banana Pro, Nano Banana 2, Nano Banana 2 Lite)
          const selectImageModel = async (modelKey = "banana_pro") => {
            await selectImageTab();
            await sleep(300);

            const isMatch = (text, requestedModel) => {
              const tl = (text || "").toLowerCase().trim();
              const req = (requestedModel || "banana_pro").toLowerCase().trim();
              if (req.includes("lite") || req.includes("2_lite") || req.includes("2 lite")) {
                return tl.includes("lite");
              }
              if (req.includes("banana 2") || req.includes("banana_2")) {
                return (tl.includes("banana 2") || tl.includes("nano banana 2")) && !tl.includes("lite");
              }
              return (tl.includes("pro") || tl.includes("banana pro")) && !tl.includes("banana 2") && !tl.includes("lite");
            };

            const findModelDropdown = () => {
              const candidates = queryDeep("button, [role='combobox'], [role='button']").filter(b => {
                if (!isElemVisible(b)) return false;
                if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
                if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                if (b.closest("[role='listbox'], [role='menu']")) return false;
                const r = b.getBoundingClientRect();
                if (r.left < 150 || r.width < 50 || r.height < 20) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                const isModel = (t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.includes("imagen")) && t.length < 50;
                const isExcluded = t.includes("16:9") || t.includes("9:16") || t.includes("1:1") || t.includes("4:3") || t.includes("3:4") || t.includes("x1") || t.includes("x2") || t.includes("x3") || t.includes("x4") || t.includes("video") || t.includes("hình ảnh");
                return isModel && !isExcluded;
              });
              if (candidates.length > 0) return candidates[0];

              const divCandidates = queryDeep("div[role='button'], div").filter(b => {
                if (!isElemVisible(b)) return false;
                if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
                if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                if (b.closest("[role='listbox'], [role='menu']")) return false;
                const r = b.getBoundingClientRect();
                if (r.left < 150 || r.width < 50 || r.height < 20) return false;
                const t = (b.textContent || "").trim().toLowerCase();
                const isModel = (t.includes("banana") || t.includes("nano") || t.includes("pro") || t.includes("lite") || t.includes("imagen")) && t.length < 50;
                const isExcluded = t.includes("16:9") || t.includes("9:16") || t.includes("1:1") || t.includes("4:3") || t.includes("3:4") || t.includes("x1") || t.includes("x2") || t.includes("x3") || t.includes("x4") || t.includes("video") || t.includes("hình ảnh");
                return isModel && !isExcluded;
              });
              if (divCandidates.length > 0) {
                const best = divCandidates.find(d => d.getAttribute("role") === "button") || divCandidates[divCandidates.length - 1];
                return best.closest("button, [role='combobox'], [role='button']") || best;
              }
              return null;
            };

            const modelDropdown = findModelDropdown();
            if (!modelDropdown) {
              return { success: false, error: "Không tìm thấy nút Dropdown Model Ảnh (Nano Banana)" };
            }

            const currentText = (modelDropdown.textContent || "").trim();
            if (isMatch(currentText, modelKey)) {
              return { success: true, text: currentText, alreadySelected: true };
            }

            const btn = modelDropdown.closest("button, [role='combobox'], [role='button']") || modelDropdown;
            btn.scrollIntoView({ block: "nearest" });

            // Click mở menu dropdown 1 lần duy nhất
            btn.click();
            await sleep(400);

            const checkMenuOpen = () => {
              const items = queryDeep("[role='option'], [role='menuitem'], li, button, div, span").filter(isElemVisible);
              return items.some(el => {
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el === modelDropdown || modelDropdown.contains(el)) return false;
                const t = (el.textContent || "").trim();
                return t.length >= 4 && t.length <= 35 && (t.includes("Banana") || t.includes("Nano"));
              });
            };

            if (!checkMenuOpen()) {
              btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              await sleep(400);
            }

            let targetOpt = null;
            let foundOptions = [];
            for (let attempt = 0; attempt < 15; attempt++) {
              const portalCandidates = queryDeep("[role='option'], [role='menuitem'], button, [role='button'], li, div, span").filter(isElemVisible);
              const actualOptions = portalCandidates.filter(el => {
                if (settingsChip && (el === settingsChip || settingsChip.contains(el))) return false;
                if (el === modelDropdown || modelDropdown.contains(el)) return false;
                if (el.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
                const t = (el.textContent || "").trim();
                if (t.length < 4 || t.length > 35) return false;
                const tl = t.toLowerCase();
                return tl.includes("banana") || tl.includes("nano");
              });

              if (actualOptions.length > 0) {
                foundOptions = actualOptions.map(o => (o.textContent || "").trim());
                targetOpt = actualOptions.find(el => isMatch((el.textContent || "").trim(), modelKey));
                if (targetOpt) break;
              }
              await sleep(150);
            }

            if (targetOpt) {
              const clickable = targetOpt.closest("[role='option'], [role='menuitem'], button, [role='button'], li") || targetOpt;
              clickable.scrollIntoView({ block: "nearest" });
              clickable.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
              clickable.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
              clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
              if (typeof clickable.click === "function") {
                clickable.click();
              } else {
                clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              }
              await sleep(400);
              return { success: true, text: (clickable.textContent || "").trim() };
            }
            return { success: false, error: `Không tìm thấy option khớp với '${modelKey}'. Menu hiện có: ${foundOptions.join(" | ") || 'trống'}` };
          };

          // 4. Hàm chọn Số lượng Ảnh (x1, x2, x3, x4)
          const selectImageCount = async (countStr = "x1") => {
            await selectImageTab();
            await sleep(250);

            const tc = (countStr || "x1").toLowerCase().trim();
            const countButtons = queryDeep("[role='tab'], [role='radio'], button, [role='button'], div, span").filter(b => {
              if (!isElemVisible(b)) return false;
              if (settingsChip && (b === settingsChip || settingsChip.contains(b))) return false;
              if (b.closest("[data-media-id], [data-workflow-id], [class*='card']")) return false;
              const r = b.getBoundingClientRect();
              if (r.left < 150) return false;
              const t = (b.textContent || "").trim().toLowerCase();
              return t === "x1" || t === "x2" || t === "x3" || t === "x4" || t === "1x" || t === "2x" || t === "3x" || t === "4x";
            });

            const countBtn = countButtons.find(b => {
              const t = (b.textContent || "").trim().toLowerCase();
              if (tc === "x1" || tc === "1x") return t === "x1" || t === "1x";
              if (tc === "x2" || tc === "2x") return t === "x2" || t === "2x";
              if (tc === "x3" || tc === "3x") return t === "x3" || t === "3x";
              if (tc === "x4" || tc === "4x") return t === "x4" || t === "4x";
              return t === tc;
            });

            if (countBtn) {
              const clickable = countBtn.closest("[role='tab'], [role='radio'], button, [role='button']") || countBtn;
              triggerClick(clickable);
              await sleep(350);
              return { success: true, text: (clickable.textContent || "").trim() };
            }
            const available = countButtons.map(b => (b.textContent || "").trim()).filter(Boolean);
            return { success: false, error: `Không tìm thấy nút số lượng ${countStr}. Có sẵn: [${available.join(", ")}]` };
          };

          // 5. Đóng popover
          const closePopover = async () => {
            await sleep(300);
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
            await sleep(300);
            try {
              if (editor) {
                editor.click();
                editor.focus();
              }
            } catch (_) {}
            await sleep(200);
            // Nếu popover vẫn còn mở, bấm lại settingsChip để đóng
            if (isPopoverOpen() && settingsChip) {
              triggerClick(settingsChip);
              await sleep(300);
            }
          };

          if (stepIdx === "img_tab") {
            const r = await selectImageTab();
            if (r.success) {
              return `Đã bấm sang Tab "Hình ảnh" thành công! (<${r.el.tagName.toLowerCase()}> text="${r.el.textContent.trim()}")`;
            }
            throw new Error(r.error || "Không tìm thấy Tab 'Hình ảnh' trong Popover Settings!");
          }

          if (stepIdx === "img_ratio") {
            const targetR = cfg?.aspectRatio || "9:16";
            const r = await selectImageRatio(targetR);
            if (r.success) return `Đã chọn Tỉ lệ ảnh thành công: "${r.text}"!`;
            throw new Error(r.error || `Không chọn được tỉ lệ ${targetR}`);
          }

          if (stepIdx === "img_count") {
            const targetC = cfg?.count || "x1";
            const r = await selectImageCount(targetC);
            if (r.success) return `Đã chọn Số lượng ảnh thành công: "${r.text}"!`;
            throw new Error(r.error || `Không chọn được số lượng ${targetC}`);
          }

          if (stepIdx === "img_model") {
            const targetM = cfg?.model || "banana_pro";
            const r = await selectImageModel(targetM);
            if (r.success) return `Đã chọn Model ảnh thành công: "${r.text}"!`;
            throw new Error(r.error || `Không chọn được model ${targetM}`);
          }

          if (stepIdx === "img_all_config") {
            const targetR = cfg?.aspectRatio || "9:16";
            const targetM = cfg?.model || "banana_pro";
            const targetC = cfg?.count || "x1";

            const log = [];

            // 1. Mở Cài đặt nếu chưa mở
            await ensurePopoverOpen();
            log.push("Mở Cài đặt");
            await sleep(350);

            // 2. Chọn Tab "Hình ảnh"
            const rTab = await selectImageTab();
            if (!rTab.success) throw new Error("Bước chọn Tab: " + (rTab.error || "Không bấm được Tab Hình ảnh"));
            log.push(rTab.alreadyActive ? "Tab: Hình ảnh (đã bật sẵn)" : "Tab: Hình ảnh (vừa chọn)");
            await sleep(350);

            // 3. Chọn Tỉ lệ
            const rR = await selectImageRatio(targetR);
            if (!rR.success) throw new Error(`Bước chọn Tỉ lệ: ${rR.error || 'Lỗi chọn tỉ lệ ' + targetR}`);
            log.push(`Tỉ lệ: ${rR.text || targetR}`);
            await sleep(350);

            // 4. Chọn Model
            const rM = await selectImageModel(targetM);
            if (!rM.success) throw new Error(`Bước chọn Model: ${rM.error || 'Lỗi chọn model ' + targetM}`);
            log.push(`Model: ${rM.text || targetM}`);
            await sleep(350);

            // 5. Chọn Số lượng
            const rC = await selectImageCount(targetC);
            if (!rC.success) throw new Error(`Bước chọn Số lượng: ${rC.error || 'Lỗi chọn số lượng ' + targetC}`);
            log.push(`Số lượng: ${rC.text || targetC}`);
            await sleep(350);

            // 6. Đóng popover
            await closePopover();

            return `🎉 Hoàn tất cấu hình Ảnh thành công! [${log.join(" | ")}]`;
          }

          if (stepIdx === "img_full_create") {
            if (!editor) throw new Error("Không tìm thấy ô nhập prompt (Editor)");
            const promptToUse = promptText || "A majestic golden eagle soaring above misty mountains at sunrise, ultra high quality, 8k";
            
            // 1. Điền prompt
            editor.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, promptToUse);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(400);

            // 2. Chạy cấu hình
            const targetR = cfg?.aspectRatio || "9:16";
            const targetM = cfg?.model || "banana_pro";
            const targetC = cfg?.count || "x1";

            await ensurePopoverOpen();
            await sleep(350);

            const rTab = await selectImageTab();
            if (!rTab.success) throw new Error("Không bấm được Tab Hình ảnh");
            await sleep(350);

            const rR = await selectImageRatio(targetR);
            if (!rR.success) throw new Error(rR.error || `Không chọn được Tỉ lệ ${targetR}`);
            await sleep(350);

            const rM = await selectImageModel(targetM);
            if (!rM.success) throw new Error(rM.error || `Không chọn được Model ${targetM}`);
            await sleep(350);

            const rC = await selectImageCount(targetC);
            if (!rC.success) throw new Error(rC.error || `Không chọn được Số lượng ${targetC}`);
            await sleep(350);

            await closePopover();
            await sleep(400);

            // 3. Click Submit
            if (!submitBtn) throw new Error("Không tìm thấy nút Submit");
            for (let waitSub = 0; waitSub < 15; waitSub++) {
              const isDisabled = submitBtn.disabled || submitBtn.getAttribute("aria-disabled") === "true";
              if (!isDisabled) break;
              await sleep(200);
            }
            submitBtn.removeAttribute("disabled");
            submitBtn.setAttribute("aria-disabled", "false");
            submitBtn.click(); // Đúng chuẩn Test B3: Chỉ 1 click duy nhất!

            return `🚀 Đã điền prompt, cấu hình [${targetR} | ${rM.text || targetM} | ${targetC}] và bấm nút Submit tạo ảnh trên Flow!`;
          }
        }

        if (stepIdx === 5 || stepIdx === 5.0 || stepIdx === "5.0" || stepIdx === "5") {
          const info = [];
          info.push(`🌐 URL Tab: ${window.location.href}`);

          // 1. Check window.__flowRecentMedia (captured from RPCs)
          const recent = window.__flowRecentMedia || [];
          info.push(`📡 Captured RPC Media: ${recent.length} lượt`);
          if (recent.length > 0) {
            recent.slice(0, 3).forEach((m, idx) => {
              info.push(`  [RPC ${idx+1}] RPC: [${m.rpcId || 'batchexecute'}], Primary ID: ${m.primaryId}`);
              if (m.mediaIds?.length) info.push(`   Media IDs: ${m.mediaIds.join(', ')}`);
              if (m.workflows?.length) info.push(`   Workflows: ${m.workflows.join(', ')}`);
              if (m.videoUrls?.length) info.push(`   Video URLs: ${m.videoUrls.join(', ')}`);
            });
          }

          // 2. Check DOM Elements for media IDs
          const allElements = document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id]");
          info.push(`🔍 DOM Elements có ID: ${allElements.length} phần tử`);
          allElements.forEach((el, i) => {
            if (i < 5) {
              info.push(`  [DOM ${i+1}] <${el.tagName.toLowerCase()}> media-id="${el.getAttribute('data-media-id') || ''}" workflow-id="${el.getAttribute('data-workflow-id') || ''}" id="${el.getAttribute('data-id') || ''}"`);
            }
          });

          // 3. Check video elements
          const videos = document.querySelectorAll("video");
          info.push(`🎬 Thẻ <video>: ${videos.length} video`);
          videos.forEach((v, i) => {
            if (i < 3) info.push(`  [Video ${i+1}] src: ${v.currentSrc || v.src || '(chưa có src)'}`);
          });

          // 4. Test fetch in tab
          try {
            const urlMatch = window.location.href.match(/project\/([a-zA-Z0-9_-]+)/);
            if (urlMatch) {
              const pId = urlMatch[1];
              const inp = JSON.stringify({ json: { projectId: pId } });
              const res = await fetch(`https://labs.google/fx/api/trpc/flow.projectInitialData?input=${encodeURIComponent(inp)}`, { credentials: "include" });
              info.push(`📋 In-Tab tRPC flow.projectInitialData: HTTP ${res.status}`);
              if (res.ok) {
                const d = await res.json();
                const mList = d?.result?.data?.json?.projectContents?.media || [];
                info.push(`  -> Thành công! Có ${mList.length} media items trong dự án!`);
              }
            }
          } catch (tErr) {
            info.push(`📋 In-Tab tRPC test: Lỗi ${tErr.message}`);
          }

          return info.join("\n");
        }

        if (stepIdx === 6 || stepIdx === 6.0 || stepIdx === "6.0" || stepIdx === "6") {
          const info = [];
          info.push(`🌐 URL Tab: ${window.location.href}`);
          const urlMatch = window.location.href.match(/project\/([a-zA-Z0-9_-]+)/);
          const pId = urlMatch ? urlMatch[1] : null;

          if (!pId) {
            return "❌ Tab hiện tại không ở trong trang dự án (không tìm thấy Project ID trong URL)!";
          }

          info.push(`🆔 Project ID: ${pId}`);
          info.push(`──────────────────────────────────────────`);

          // 1. Test In-Tab tRPC: flow.projectInitialData
          try {
            const inp = JSON.stringify({ json: { projectId: pId } });
            const u = `https://labs.google/fx/api/trpc/flow.projectInitialData?input=${encodeURIComponent(inp)}`;
            info.push(`📡 [1] Test Gọi tRPC flow.projectInitialData...`);
            const res = await fetch(u, { credentials: "include" });
            info.push(`   ➔ HTTP Status: ${res.status} (${res.statusText})`);
            const txt = await res.text();
            if (res.ok) {
              try {
                const j = JSON.parse(txt);
                const mList = j?.result?.data?.json?.projectContents?.media || [];
                info.push(`   ✅ THÀNH CÔNG! Trả về ${mList.length} media items trong project!`);
              } catch (_) {
                info.push(`   ⚠️ Phản hồi không phải JSON: ${txt.slice(0, 150)}`);
              }
            } else {
              info.push(`   ❌ Google trả về lỗi (${res.status}): ${txt.slice(0, 200)}`);
            }
          } catch (e) {
            info.push(`   ❌ Network/CORS Error: ${e.message}`);
          }

          info.push(`──────────────────────────────────────────`);

          // 2. Test In-Tab batchCheckAsyncVideoGenerationStatus
          try {
            info.push(`📡 [2] Test Gọi batchCheckAsyncVideoGenerationStatus...`);
            const payload = { media: [{ name: "test-id", projectId: pId }] };
            const res2 = await fetch("https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "text/plain;charset=UTF-8" },
              body: JSON.stringify(payload)
            });
            info.push(`   ➔ HTTP Status: ${res2.status} (${res2.statusText})`);
            const txt2 = await res2.text();
            if (res2.ok) {
              info.push(`   ✅ API hoạt động!`);
            } else {
              info.push(`   ❌ Google từ chối (${res2.status}): ${txt2.slice(0, 200)}`);
            }
          } catch (e2) {
            info.push(`   ❌ Network/CORS Error: ${e2.message}`);
          }

          info.push(`──────────────────────────────────────────`);

          // 3. Test getMediaUrlRedirect
          try {
            info.push(`📡 [3] Test Gọi media.getMediaUrlRedirect...`);
            const u3 = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=test-media-id&mediaUrlType=MEDIA_URL_TYPE_VIDEO`;
            const res3 = await fetch(u3, { credentials: "include", redirect: "follow" });
            info.push(`   ➔ HTTP Status: ${res3.status} (${res3.statusText}), Final URL: ${res3.url?.slice(0, 60)}...`);
            const txt3 = await res3.text();
            if (res3.ok) {
              info.push(`   ✅ API chuyển hướng thành công!`);
            } else {
              info.push(`   ❌ Google từ chối (${res3.status}): ${txt3.slice(0, 150)}`);
            }
          } catch (e3) {
            info.push(`   ❌ Network/CORS Error: ${e3.message}`);
          }

          return info.join("\n");
        }

        if (stepIdx === 7 || stepIdx === 7.0 || stepIdx === "7.0" || stepIdx === "7") {
          const info = [];
          info.push(`🌐 URL Tab: ${window.location.href}`);
          info.push(`──────────────────────────────────────────`);

          // 1. Quét TẤT CẢ các thẻ <video> đang có trên toàn bộ trang
          let vids = Array.from(document.querySelectorAll("video"));
          
          // Nếu chưa có thẻ <video>, thử tự động hover vào tất cả các card để kích hoạt Google Flow nạp video
          if (vids.length === 0) {
            info.push(`⚠️ Chưa có thẻ <video> nào trong DOM. Đang tự động rê chuột (hover) vào các card video...`);
            const cards = Array.from(document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id], .container, img.image"));
            for (const c of cards) {
              c.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
              c.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            }
            // Đợi 1 giây để Angular/Wiz render thẻ video
            await new Promise(r => setTimeout(r, 1000));
            vids = Array.from(document.querySelectorAll("video"));
          }

          info.push(`🎬 Phát hiện ${vids.length} thẻ <video> đang hiển thị trên trang:`);
          
          const foundUrls = [];
          vids.forEach((v, i) => {
            const s = v.currentSrc || v.src || v.querySelector("source")?.src || "";
            if (s && s.startsWith("http")) foundUrls.push(s);
            info.push(`  [Video ${i + 1}] src: ${s.slice(0, 80)}...`);
            info.push(`     duration: ${v.duration}s | readyState: ${v.readyState}`);
          });

          // 2. Nếu vẫn chưa có thẻ <video>, lấy URL từ window.__flowRecentMedia (các video đã render)
          if (foundUrls.length === 0) {
            info.push(`\n📡 Tìm URL dự phòng từ window.__flowRecentMedia...`);
            const recent = window.__flowRecentMedia || [];
            for (const r of recent) {
              if (r.videoUrls?.length) {
                for (const u of r.videoUrls) {
                  if (u && u.startsWith("http") && !foundUrls.includes(u)) {
                    foundUrls.push(u);
                  }
                }
              }
            }
            info.push(`   -> Tìm thấy ${foundUrls.length} URL video từ RPC gần nhất.`);
          }

          // 3. Nếu vẫn chưa có, quét các thẻ có ID trong project
          if (foundUrls.length === 0) {
            const idElements = Array.from(document.querySelectorAll("[data-media-id], [data-workflow-id], [data-id]"));
            for (const el of idElements) {
              const id = el.getAttribute("data-media-id") || el.getAttribute("data-workflow-id") || el.getAttribute("data-id");
              if (id && /^[a-f0-9\-]{36}$/i.test(id)) {
                foundUrls.push(`https://flow-content.google/video/${id}`);
              }
            }
            info.push(`   -> Tạo ${foundUrls.length} link chuẩn flow-content.google từ ID trên DOM.`);
          }

          return {
            log: info.join("\n"),
            videoUrls: foundUrls
          };
        }

        // Shared Helpers for Step 8.x
        const findCardByQuery = (q) => {
          const allMedia = Array.from(document.querySelectorAll("img, video")).filter(el => {
            if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
            const src = el.src || el.currentSrc || "";
            if (src.includes("googleusercontent.com/a/") || src.includes("avatar")) return false;
            const r = el.getBoundingClientRect();
            return r.width > 60 && r.height > 60;
          });

          const cardCandidates = [];
          for (const m of allMedia) {
            let c = m;
            let cur = m.parentElement;
            while (cur && cur !== document.body && cur.tagName !== 'MAIN') {
              const childMedia = allMedia.filter(x => cur.contains(x));
              const distinctPos = new Set(childMedia.map(x => {
                const r = x.getBoundingClientRect();
                return `${Math.round(r.left / 25)},${Math.round((r.top + window.scrollY) / 35)}`;
              }));
              if (distinctPos.size > 1) break;
              c = cur;
              cur = cur.parentElement;
            }
            if (c && !cardCandidates.includes(c)) {
              cardCandidates.push(c);
            }
          }

          let matched = cardCandidates.find(card => {
            const t = (card.textContent || "").toLowerCase();
            const titled = Array.from(card.querySelectorAll("[title], [aria-label]")).map(el => (el.getAttribute("title") || el.getAttribute("aria-label") || "").toLowerCase()).join(" ");
            return t.includes(q.toLowerCase()) || titled.includes(q.toLowerCase());
          });

          if (!matched) {
            const allElementsWithText = Array.from(document.querySelectorAll("button, span, p, div")).filter(el => {
              if (el.closest("[data-slate-editor], form, [class*='composer'], [class*='input-container'], [class*='prompt-box']")) return false;
              const directText = (el.innerText || el.textContent || "").trim();
              return directText.includes(q);
            });
            if (allElementsWithText.length > 0) {
              matched = allElementsWithText[0].closest(".container, [class*='card']") || allElementsWithText[0].parentElement;
            }
          }
          return matched;
        };

        const dispatchRightClick = async (target) => {
          const rect = target.getBoundingClientRect();
          const clientX = Math.round(rect.left + rect.width / 2);
          const clientY = Math.round(rect.top + rect.height / 2);
          const mouseOpts = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 2,
            buttons: 2,
            clientX,
            clientY,
            screenX: window.screenX + clientX,
            screenY: window.screenY + clientY
          };
          target.dispatchEvent(new PointerEvent('pointerover', mouseOpts));
          target.dispatchEvent(new PointerEvent('pointerenter', mouseOpts));
          target.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
          target.dispatchEvent(new MouseEvent('mouseenter', mouseOpts));
          target.dispatchEvent(new MouseEvent('mousemove', mouseOpts));
          target.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
          target.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          await sleep(50);
          target.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
          target.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          target.dispatchEvent(new MouseEvent('contextmenu', mouseOpts));
          return { clientX, clientY };
        };

        // Helper to close stray config panel if open from bottom prompt
        const closeConfigPanelIfOpen = async () => {
          const configPanels = Array.from(document.querySelectorAll("[role='dialog'], [class*='popover'], [class*='panel']")).filter(el => {
            const t = el.textContent || "";
            return t.includes("Khung hình") && t.includes("Thành phần") && t.includes("Hình ảnh");
          });
          if (configPanels.length > 0) {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            await sleep(250);
          }
        };

        const findDownloadMenuItem = () => {
          // Find open context menus on card
          const candidateMenus = Array.from(document.querySelectorAll("[role='menu'], [class*='menu'], [class*='context'], [class*='popover'], [class*='cdk-overlay']")).filter(el => {
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = el.textContent || "";
            return t.includes("Sao chép") || t.includes("Đổi tên") || t.includes("Chia sẻ") || t.includes("Chuyển vào thùng rác");
          });

          for (const m of candidateMenus) {
            const items = Array.from(m.querySelectorAll("*")).filter(el => {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0 || r.width > 350 || r.height > 80) return false;
              const t = (el.innerText || el.textContent || "").trim();
              if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
              return t === "Tải xuống" || t.startsWith("Tải xuống") || t === "Download" || t.startsWith("Download");
            });
            if (items.length > 0) {
              const exact = items.find(el => (el.innerText || el.textContent || "").trim() === "Tải xuống") || items[0];
              return exact.closest("[role='menuitem'], button, [class*='item'], li, div[tabindex]") || exact;
            }
          }

          // Fallback: search anywhere except bottom composer
          const all = Array.from(document.querySelectorAll("*")).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.width > 350 || r.height > 80) return false;
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = (el.innerText || el.textContent || "").trim();
            if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
            return t === "Tải xuống" || t.startsWith("Tải xuống") || t === "Download" || t.startsWith("Download");
          });

          if (all.length > 0) {
            const exact = all.find(el => (el.innerText || el.textContent || "").trim() === "Tải xuống") || all[0];
            return exact.closest("[role='menuitem'], button, [class*='item'], li, div[tabindex]") || exact;
          }
          return null;
        };

        const findDownload720pOption = () => {
          // 1. All elements on page matching exact 720p row criteria
          const allEls = Array.from(document.querySelectorAll("*")).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 50 || r.width > 350 || r.height < 18 || r.height > 75) return false;
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = (el.innerText || el.textContent || "").trim();
            if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
            // CRITICAL: A single 720p menu row MUST NOT contain other resolution names!
            if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
            return t.includes("720p") || t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
          });

          if (allEls.length > 0) {
            allEls.sort((a, b) => {
              const ta = (a.innerText || a.textContent || "");
              const tb = (b.innerText || b.textContent || "");
              const aGoc = ta.includes("Kích thước gốc") || ta.toLowerCase().includes("gốc") || ta.toLowerCase().includes("original") ? 1 : 0;
              const bGoc = tb.includes("Kích thước gốc") || tb.toLowerCase().includes("gốc") || tb.toLowerCase().includes("original") ? 1 : 0;
              if (aGoc !== bGoc) return bGoc - aGoc;
              const aBtn = a.tagName === 'BUTTON' || a.getAttribute('role') === 'menuitem' ? 1 : 0;
              const bBtn = b.tagName === 'BUTTON' || b.getAttribute('role') === 'menuitem' ? 1 : 0;
              if (aBtn !== bBtn) return bBtn - aBtn;
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return (rb.width * rb.height) - (ra.width * ra.height);
            });
            return allEls[0];
          }

          // 2. Fallback: Search from "Kích thước gốc" text and walk up safely
          const directText = Array.from(document.querySelectorAll("*")).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.height > 60) return false;
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = (el.innerText || el.textContent || "").trim();
            if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
            if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
            return t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
          });

          if (directText.length > 0) {
            let cur = directText[0];
            while (cur && cur.parentElement && cur.parentElement !== document.body) {
              const p = cur.parentElement;
              const pr = p.getBoundingClientRect();
              const pt = (p.innerText || p.textContent || "").trim();
              if (pr.height > 75 || pt.includes("270p") || pt.includes("1080p") || pt.includes("4K")) {
                break; // Stop before ascending to container!
              }
              cur = p;
              if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'menuitem') {
                break;
              }
            }
            return cur;
          }

          return null;
        };

        const dispatchHover = (target, color = '#00e5ff') => {
          const rect = target.getBoundingClientRect();
          const clientX = Math.round(rect.left + rect.width / 2);
          const clientY = Math.round(rect.top + rect.height / 2);
          const opts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX,
            clientY,
            screenX: window.screenX + clientX,
            screenY: window.screenY + clientY
          };
          target.dispatchEvent(new PointerEvent('pointerover', opts));
          target.dispatchEvent(new PointerEvent('pointerenter', opts));
          target.dispatchEvent(new MouseEvent('mouseover', opts));
          target.dispatchEvent(new MouseEvent('mouseenter', opts));
          target.dispatchEvent(new PointerEvent('pointermove', opts));
          target.dispatchEvent(new MouseEvent('mousemove', opts));

          // Visual highlight
          target.style.outline = `4px solid ${color}`;
          target.style.boxShadow = `0 0 25px ${color}`;
          target.style.backgroundColor = color === '#00e676' ? 'rgba(0, 230, 118, 0.25)' : 'rgba(0, 229, 255, 0.2)';
          target.style.transition = 'all 0.2s ease';
          return { clientX, clientY, rect };
        };

        const dispatchClick = (target) => {
          const rect = target.getBoundingClientRect();
          const clientX = Math.round(rect.left + rect.width / 2);
          const clientY = Math.round(rect.top + rect.height / 2);
          const opts = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            buttons: 1,
            clientX,
            clientY,
            screenX: window.screenX + clientX,
            screenY: window.screenY + clientY
          };
          target.dispatchEvent(new PointerEvent('pointerdown', opts));
          target.dispatchEvent(new MouseEvent('mousedown', opts));
          target.dispatchEvent(new PointerEvent('pointerup', opts));
          target.dispatchEvent(new MouseEvent('mouseup', opts));
          target.dispatchEvent(new MouseEvent('click', opts));
          if (typeof target.click === 'function') target.click();
          return { clientX, clientY, rect };
        };

        const findSubmenuOptions = () => {
          const allElements = Array.from(document.querySelectorAll("*")).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.width > 300 || r.height > 80) return false;
            if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
            const t = (el.innerText || el.textContent || "").trim();
            if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
            return t.includes("270p") || t.includes("720p") || t.includes("1080p") || t.includes("4K");
          });

          const distinctRows = [];
          for (const el of allElements) {
            const row = el.closest("[role='menuitem'], button, [class*='item'], li, div[tabindex]") || el;
            const r = row.getBoundingClientRect();
            if (r.width > 30 && r.height > 15 && !distinctRows.includes(row)) {
              distinctRows.push(row);
            }
          }
          return distinctRows;
        };

        // STEP 8.0: Click Chuột Phải vào Card
        if (stepIdx === 8 || stepIdx === 8.0 || stepIdx === "8.0" || stepIdx === "8") {
          const query = (promptText || "001.").trim();
          const info = [];
          info.push(`🌐 URL Tab: ${window.location.href}`);
          info.push(`🔍 Tìm kiếm card có từ khoá: "${query}"`);
          info.push(`──────────────────────────────────────────`);

          await closeConfigPanelIfOpen();

          const matchedCard = findCardByQuery(query);
          if (!matchedCard) {
            info.push(`❌ Không tìm thấy card nào chứa "${query}" trên màn hình!`);
            info.push(`💡 Bạn hãy kiểm tra xem card có hiển thị chữ "${query}" trên tab Flow không.`);
            return info.join("\n");
          }

          matchedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          matchedCard.style.outline = '4px dashed #ff007f';
          matchedCard.style.boxShadow = '0 0 25px rgba(255, 0, 127, 0.9)';
          matchedCard.style.transition = 'all 0.3s ease';

          const clickTarget = matchedCard.querySelector("video") || matchedCard.querySelector("img") || matchedCard;
          const { clientX, clientY } = await dispatchRightClick(clickTarget);

          info.push(`🎯 Đã định vị chính xác card:`);
          info.push(`   Text: "${(matchedCard.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)}..."`);
          info.push(`   Toạ độ: X=${clientX}, Y=${clientY}`);
          info.push(`   Thẻ nhận click: <${clickTarget.tagName.toLowerCase()}> (đã tạo VIỀN HỒNG PHÁT SÁNG trên tab Flow)`);
          info.push(`🖱️ Đã bắn thành công sự kiện: contextmenu (button: 2 / Chuột phải)`);

          await sleep(400);
          const openMenus = Array.from(document.querySelectorAll("[role='menu'], [role='menuitem'], [class*='menu'], [class*='dropdown'], [class*='popover'], [class*='context']")).filter(m => {
            const r = m.getBoundingClientRect();
            return r.width > 10 && r.height > 10;
          });

          if (openMenus.length > 0) {
            info.push(`📋 Menu xuất hiện (${openMenus.length} phần tử):`);
            openMenus.slice(0, 6).forEach((m, i) => {
              info.push(`   [${i+1}] ${m.textContent.trim().slice(0, 40)}`);
            });
          }

          const v = matchedCard.querySelector("video");
          const vSrc = v?.currentSrc || v?.src;
          if (vSrc) {
            info.push(`🎬 Thẻ <video> có link: ${vSrc.slice(0, 65)}...`);
          }

          return info.join("\n");
        }

        // STEP 8.1: Rê Chuột (Hover) Vào Mục "Tải xuống"
        if (stepIdx === 8.1 || stepIdx === "8.1") {
          const query = (promptText || "001.").trim();
          const info = [];
          info.push(`🌐 URL Tab: ${window.location.href}`);
          info.push(`🎯 Thao tác: Di chuột (Hover) vào mục "Tải xuống"`);
          info.push(`──────────────────────────────────────────`);

          await closeConfigPanelIfOpen();

          let dlItem = findDownloadMenuItem();
          if (!dlItem) {
            info.push(`ℹ️ Context menu chưa mở, đang tự động click chuột phải vào card "${query}"...`);
            const card = findCardByQuery(query);
            if (!card) {
              info.push(`❌ Không tìm thấy card nào chứa "${query}" trên màn hình!`);
              return { log: info.join("\n") };
            }
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const clickTarget = card.querySelector("video") || card.querySelector("img") || card;
            await dispatchRightClick(clickTarget);
            await sleep(450);
            dlItem = findDownloadMenuItem();
          }

          if (!dlItem) {
            info.push(`❌ Không tìm thấy mục "Tải xuống" trong menu chuột phải của card!`);
            return { log: info.join("\n") };
          }

          const coords = dispatchHover(dlItem);
          info.push(`🎯 Đã tìm thấy mục: "Tải xuống" tại toạ độ X=${coords.clientX}, Y=${coords.clientY}`);
          info.push(`✨ Đã tô VIỀN XANH CYAN phát sáng vào mục "Tải xuống" trên tab Flow!`);

          return {
            log: info.join("\n"),
            needCdpHover: { x: coords.clientX, y: coords.clientY },
            checkSubmenuAfterHover: true
          };
        }

        // STEP 8.2: Rê Chuột (Hover) Vào "720p (Kích thước gốc)"
        if (stepIdx === 8.2 || stepIdx === "8.2") {
          const query = (promptText || "001.").trim();
          const info = [];
          info.push(`🌐 URL Tab: ${window.location.href}`);
          info.push(`🎯 Thao tác: Di chuột (Hover) vào dòng "720p (Kích thước gốc)"`);
          info.push(`──────────────────────────────────────────`);

          await closeConfigPanelIfOpen();

          // 1. Kiểm tra xem Submenu Tải Xuống có sẵn 720p chưa
          const opt720 = findDownload720pOption();
          if (opt720) {
            const coords = dispatchHover(opt720, '#00e676');
            const optText = (opt720.innerText || opt720.textContent || '').replace(/\s+/g, ' ').trim();
            info.push(`🎯 Đã phát hiện Submenu Tải Xuống đang mở sẵn!`);
            info.push(`🎯 Định vị lựa chọn: "${optText}" tại X=${coords.clientX}, Y=${coords.clientY}`);
            info.push(`✨ Đã tô VIỀN XANH LÁ phát sáng trên tab Flow!`);
            return {
              log: info.join("\n"),
              needCdpHover720: { x: coords.clientX, y: coords.clientY, text: optText }
            };
          }

          // 2. Nếu chưa mở submenu: tìm "Tải xuống" trong context menu
          let dlItem = findDownloadMenuItem();
          if (!dlItem) {
            info.push(`ℹ️ Context menu chưa mở, đang tự động click chuột phải vào card "${query}"...`);
            const card = findCardByQuery(query);
            if (!card) {
              info.push(`❌ Không tìm thấy card nào chứa "${query}" trên màn hình!`);
              return { log: info.join("\n") };
            }
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const clickTarget = card.querySelector("video") || card.querySelector("img") || card;
            await dispatchRightClick(clickTarget);
            await sleep(450);
            dlItem = findDownloadMenuItem();
          }

          if (!dlItem) {
            info.push(`❌ Không tìm thấy mục "Tải xuống" trong menu chuột phải của card!`);
            return { log: info.join("\n") };
          }

          const dlCoords = dispatchHover(dlItem, '#00e5ff');
          info.push(`🎯 Đã định vị mục "Tải xuống" tại X=${dlCoords.clientX}, Y=${dlCoords.clientY}`);
          info.push(`🖱️ Đang rê chuột vào "Tải xuống" để mở submenu, sau đó sẽ rê tiếp vào "720p (Kích thước gốc)"...`);

          return {
            log: info.join("\n"),
            needCdpHover: { x: dlCoords.clientX, y: dlCoords.clientY },
            thenHover720: true
          };
        }

        // STEP 8.3: Bấm Chọn "720p (Kích thước gốc)" để Tải Video (Rê chuột lại trước ➔ Click)
        if (stepIdx === 8.3 || stepIdx === "8.3") {
          const query = (promptText || "001.").trim();
          const info = [];
          info.push(`🌐 URL Tab: ${window.location.href}`);
          info.push(`🎯 Thao tác: Di chuột vào "720p (Kích thước gốc)" ➔ Bấm Click tải video`);
          info.push(`──────────────────────────────────────────`);

          await closeConfigPanelIfOpen();

          // 1. Kiểm tra xem Submenu Tải Xuống có sẵn 720p chưa
          const opt720 = findDownload720pOption();
          if (opt720) {
            const coords = dispatchHover(opt720, '#00e676');
            const optText = (opt720.innerText || opt720.textContent || '').replace(/\s+/g, ' ').trim();
            info.push(`🎯 Đã phát hiện Submenu Tải Xuống đang mở sẵn!`);
            info.push(`🎯 Định vị lựa chọn: "${optText}" tại X=${coords.clientX}, Y=${coords.clientY}`);
            info.push(`✨ Đã tô VIỀN XANH LÁ phát sáng! Chuẩn bị rê con trỏ chuột đến và click...`);
            return {
              log: info.join("\n"),
              needCdpHoverThenClick720: { x: coords.clientX, y: coords.clientY, text: optText }
            };
          }

          // 2. Nếu chưa mở submenu: tìm "Tải xuống" trong context menu
          let dlItem = findDownloadMenuItem();
          if (!dlItem) {
            info.push(`ℹ️ Context menu chưa mở, đang tự động click chuột phải vào card "${query}"...`);
            const card = findCardByQuery(query);
            if (!card) {
              info.push(`❌ Không tìm thấy card nào chứa "${query}" trên màn hình!`);
              return { log: info.join("\n") };
            }
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const clickTarget = card.querySelector("video") || card.querySelector("img") || card;
            await dispatchRightClick(clickTarget);
            await sleep(450);
            dlItem = findDownloadMenuItem();
          }

          if (!dlItem) {
            info.push(`❌ Không tìm thấy mục "Tải xuống" trong menu chuột phải của card!`);
            return { log: info.join("\n") };
          }

          const dlCoords = dispatchHover(dlItem, '#00e5ff');
          info.push(`🎯 Đã định vị mục "Tải xuống" tại X=${dlCoords.clientX}, Y=${dlCoords.clientY}`);
          info.push(`🖱️ Đang rê chuột vào "Tải xuống" để mở submenu, sau đó sẽ rê vào "720p" và click tải...`);

          return {
            log: info.join("\n"),
            needCdpHover: { x: dlCoords.clientX, y: dlCoords.clientY },
            thenClick720WithHover: true
          };
        }

        return "Unknown step";
        } catch (scriptErr) {
          return { error: scriptErr?.message || String(scriptErr) };
        }
      }
    });

    const resObj = results?.[0]?.result;
    if (resObj && typeof resObj === 'object' && resObj.error) {
      return { success: false, error: resObj.error };
    }
    if (resObj && typeof resObj === 'object' && resObj.log) {
      const logs = [resObj.log];
      let cdpAttached = false;

      const ensureCdp = async () => {
        if (!cdpAttached) {
          try {
            await chrome.debugger.attach({ tabId: tab.id }, "1.3");
            cdpAttached = true;
          } catch (err) {
            if (err.message?.includes("Already attached")) cdpAttached = true;
          }
        }
      };

      try {
        // 1. Rê chuột thật bằng CDP Native Hardware Mouse (cho mục "Tải xuống" nếu cần)
        if (resObj.needCdpHover) {
          await ensureCdp();
          if (cdpAttached) {
            logs.push(`🖱️ [CDP Hardware] Đang rê con trỏ chuột tới "Tải xuống" (X=${resObj.needCdpHover.x}, Y=${resObj.needCdpHover.y})...`);
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: resObj.needCdpHover.x,
              y: resObj.needCdpHover.y
            });
            await new Promise(r => setTimeout(r, 450));
          }
        }

        // 2. Kiểm tra submenu sau khi hover (cho B8.1)
        if (resObj.checkSubmenuAfterHover) {
          const checkRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              const els = Array.from(document.querySelectorAll("*")).filter(el => {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0 || r.width > 300 || r.height > 80) return false;
                const t = (el.innerText || el.textContent || "").trim();
                return t.includes("270p") || t.includes("720p") || t.includes("1080p") || t.includes("4K");
              });
              const distinct = [];
              for (const el of els) {
                const row = el.closest("[role='menuitem'], button, [class*='item'], li, div[tabindex]") || el;
                if (!distinct.includes(row)) distinct.push(row);
              }
              return distinct.map(r => (r.innerText || r.textContent || "").replace(/\s+/g, ' ').trim());
            }
          });
          const subList = checkRes?.[0]?.result || [];
          if (subList.length > 0) {
            logs.push(`\n📋 🎉 ĐÃ MỞ SUBMENU TẢI XUỐNG THÀNH CÔNG!`);
            logs.push(`   Phát hiện ${subList.length} lựa chọn độ phân giải:`);
            subList.forEach((it, i) => logs.push(`   [${i+1}] ${it}`));
            logs.push(`\n👉 Bạn có thể bấm "Test B8.2: Rê 720p Gốc" để kiểm tra di chuột!`);
          } else {
            logs.push(`ℹ️ Con trỏ chuột đã nằm ngay trên "Tải xuống". Bạn hãy nhìn tab Flow xem submenu đã mở chưa.`);
          }
        }

        // 3. Rê chuột trực tiếp vào 720p (cho B8.2 khi submenu mở sẵn)
        if (resObj.needCdpHover720) {
          await ensureCdp();
          if (cdpAttached) {
            logs.push(`🖱️ [CDP Hardware] Đang di chuyển con trỏ chuột đến dòng "${resObj.needCdpHover720.text}" (X=${resObj.needCdpHover720.x}, Y=${resObj.needCdpHover720.y})...`);
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: resObj.needCdpHover720.x,
              y: resObj.needCdpHover720.y
            });
            logs.push(`\n🎉 THÀNH CÔNG! Con trỏ chuột đã di chuyển chính xác vào dòng "720p (Kích thước gốc)"!`);
            logs.push(`✨ Ô này đang được tô VIỀN XANH LÁ phát sáng trên màn hình Flow.`);
            logs.push(`👉 Bạn có thể bấm "Test B8.3: Bấm Tải 720p" để tải video về.`);
          }
        }

        // 4. Rê chuột vào 720p sau khi vừa mở submenu (cho B8.2 khi submenu lúc đầu chưa mở)
        if (resObj.thenHover720) {
          await new Promise(r => setTimeout(r, 450));
          const get720Res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              let opt = null;
              const allEls = Array.from(document.querySelectorAll("*")).filter(el => {
                const r = el.getBoundingClientRect();
                if (r.width < 50 || r.width > 350 || r.height < 18 || r.height > 75) return false;
                if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
                const t = (el.innerText || el.textContent || "").trim();
                if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
                if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
                return t.includes("720p") || t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
              });

              if (allEls.length > 0) {
                allEls.sort((a, b) => {
                  const ta = (a.innerText || a.textContent || "");
                  const tb = (b.innerText || b.textContent || "");
                  const aGoc = ta.includes("Kích thước gốc") || ta.toLowerCase().includes("gốc") || ta.toLowerCase().includes("original") ? 1 : 0;
                  const bGoc = tb.includes("Kích thước gốc") || tb.toLowerCase().includes("gốc") || tb.toLowerCase().includes("original") ? 1 : 0;
                  if (aGoc !== bGoc) return bGoc - aGoc;
                  const aBtn = a.tagName === 'BUTTON' || a.getAttribute('role') === 'menuitem' ? 1 : 0;
                  const bBtn = b.tagName === 'BUTTON' || b.getAttribute('role') === 'menuitem' ? 1 : 0;
                  if (aBtn !== bBtn) return bBtn - aBtn;
                  const ra = a.getBoundingClientRect();
                  const rb = b.getBoundingClientRect();
                  return (rb.width * rb.height) - (ra.width * ra.height);
                });
                opt = allEls[0];
              }

              if (!opt) {
                const directText = Array.from(document.querySelectorAll("*")).filter(el => {
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 || r.height === 0 || r.height > 60) return false;
                  if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
                  const t = (el.innerText || el.textContent || "").trim();
                  if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
                  if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
                  return t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
                });
                if (directText.length > 0) {
                  let cur = directText[0];
                  while (cur && cur.parentElement && cur.parentElement !== document.body) {
                    const p = cur.parentElement;
                    const pr = p.getBoundingClientRect();
                    const pt = (p.innerText || p.textContent || "").trim();
                    if (pr.height > 75 || pt.includes("270p") || pt.includes("1080p") || pt.includes("4K")) {
                      break;
                    }
                    cur = p;
                    if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'menuitem') break;
                  }
                  opt = cur;
                }
              }

              if (!opt) return null;
              const rect = opt.getBoundingClientRect();
              opt.style.outline = '4px solid #00e676';
              opt.style.boxShadow = '0 0 25px rgba(0, 230, 118, 0.95)';
              opt.style.backgroundColor = 'rgba(0, 230, 118, 0.25)';
              opt.style.transition = 'all 0.2s ease';
              const cx = Math.round(rect.left + rect.width / 2);
              const cy = Math.round(rect.top + rect.height / 2);
              const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
              opt.dispatchEvent(new PointerEvent('pointerover', opts));
              opt.dispatchEvent(new PointerEvent('pointerenter', opts));
              opt.dispatchEvent(new MouseEvent('mouseover', opts));
              opt.dispatchEvent(new MouseEvent('mouseenter', opts));
              opt.dispatchEvent(new PointerEvent('pointermove', opts));
              opt.dispatchEvent(new MouseEvent('mousemove', opts));
              return { x: cx, y: cy, text: (opt.innerText || opt.textContent || "").replace(/\s+/g, ' ').trim() };
            }
          });

          const opt720 = get720Res?.[0]?.result;
          if (opt720) {
            await ensureCdp();
            if (cdpAttached) {
              logs.push(`🖱️ [CDP Hardware] Đang di chuyển con trỏ chuột đến "${opt720.text}" (X=${opt720.x}, Y=${opt720.y})...`);
              await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: opt720.x,
                y: opt720.y
              });
              logs.push(`\n🎉 THÀNH CÔNG! Con trỏ chuột đã di chuyển chính xác vào dòng "720p (Kích thước gốc)"!`);
              logs.push(`✨ Ô này đang được tô VIỀN XANH LÁ phát sáng trên màn hình Flow.`);
            }
          } else {
            logs.push(`❌ Chưa thấy lựa chọn "720p (Kích thước gốc)" xuất hiện trong submenu sau khi rê chuột.`);
          }
        }

        // 5. Rê chuột rồi Click 720p (cho B8.3)
        let clickTargetCoord = null;
        if (resObj.needCdpHoverThenClick720) {
          clickTargetCoord = resObj.needCdpHoverThenClick720;
        } else if (resObj.thenClick720WithHover) {
          await new Promise(r => setTimeout(r, 450));
          const get720Res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              let opt = null;
              const allEls = Array.from(document.querySelectorAll("*")).filter(el => {
                const r = el.getBoundingClientRect();
                if (r.width < 50 || r.width > 350 || r.height < 18 || r.height > 75) return false;
                if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
                const t = (el.innerText || el.textContent || "").trim();
                if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
                if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
                return t.includes("720p") || t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
              });

              if (allEls.length > 0) {
                allEls.sort((a, b) => {
                  const ta = (a.innerText || a.textContent || "");
                  const tb = (b.innerText || b.textContent || "");
                  const aGoc = ta.includes("Kích thước gốc") || ta.toLowerCase().includes("gốc") || ta.toLowerCase().includes("original") ? 1 : 0;
                  const bGoc = tb.includes("Kích thước gốc") || tb.toLowerCase().includes("gốc") || tb.toLowerCase().includes("original") ? 1 : 0;
                  if (aGoc !== bGoc) return bGoc - aGoc;
                  const aBtn = a.tagName === 'BUTTON' || a.getAttribute('role') === 'menuitem' ? 1 : 0;
                  const bBtn = b.tagName === 'BUTTON' || b.getAttribute('role') === 'menuitem' ? 1 : 0;
                  if (aBtn !== bBtn) return bBtn - aBtn;
                  const ra = a.getBoundingClientRect();
                  const rb = b.getBoundingClientRect();
                  return (rb.width * rb.height) - (ra.width * ra.height);
                });
                opt = allEls[0];
              }

              if (!opt) {
                const directText = Array.from(document.querySelectorAll("*")).filter(el => {
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 || r.height === 0 || r.height > 60) return false;
                  if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
                  const t = (el.innerText || el.textContent || "").trim();
                  if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
                  if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
                  return t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
                });
                if (directText.length > 0) {
                  let cur = directText[0];
                  while (cur && cur.parentElement && cur.parentElement !== document.body) {
                    const p = cur.parentElement;
                    const pr = p.getBoundingClientRect();
                    const pt = (p.innerText || p.textContent || "").trim();
                    if (pr.height > 75 || pt.includes("270p") || pt.includes("1080p") || pt.includes("4K")) {
                      break;
                    }
                    cur = p;
                    if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'menuitem') break;
                  }
                  opt = cur;
                }
              }

              if (!opt) return null;
              const rect = opt.getBoundingClientRect();
              opt.style.outline = '4px solid #00e676';
              opt.style.boxShadow = '0 0 25px rgba(0, 230, 118, 0.95)';
              opt.style.backgroundColor = 'rgba(0, 230, 118, 0.25)';
              opt.style.transition = 'all 0.2s ease';
              const cx = Math.round(rect.left + rect.width / 2);
              const cy = Math.round(rect.top + rect.height / 2);
              const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
              opt.dispatchEvent(new PointerEvent('pointerover', opts));
              opt.dispatchEvent(new PointerEvent('pointerenter', opts));
              opt.dispatchEvent(new MouseEvent('mouseover', opts));
              opt.dispatchEvent(new MouseEvent('mouseenter', opts));
              opt.dispatchEvent(new PointerEvent('pointermove', opts));
              opt.dispatchEvent(new MouseEvent('mousemove', opts));
              return { x: cx, y: cy, text: (opt.innerText || opt.textContent || "").replace(/\s+/g, ' ').trim() };
            }
          });
          clickTargetCoord = get720Res?.[0]?.result;
        }

        if (clickTargetCoord) {
          await ensureCdp();
          if (cdpAttached) {
            // Bước 1: RÊ CHUỘT LẠI VÀO 720P
            logs.push(`🖱️ [Bước 1/2: Di Chuột] Đang rê con trỏ chuột đến dòng 720p (X=${clickTargetCoord.x}, Y=${clickTargetCoord.y})...`);
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: clickTargetCoord.x,
              y: clickTargetCoord.y
            });
            // Tạm dừng 650ms để người dùng và trình duyệt nhìn thấy con trỏ chuột dừng tại 720p
            await new Promise(r => setTimeout(r, 650));

            // Bước 2: BẤM CLICK CHUỘT TRÁI THẬT
            logs.push(`🖱️ [Bước 2/2: Click] Đang gửi click chuột trái thật vào "720p (Kích thước gốc)"...`);
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: clickTargetCoord.x,
              y: clickTargetCoord.y,
              button: "left",
              clickCount: 1
            });
            await new Promise(r => setTimeout(r, 80));
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: clickTargetCoord.x,
              y: clickTargetCoord.y,
              button: "left",
              clickCount: 1
            });
            logs.push(`🎉 Đã bấm click chuột thật vào "720p (Kích thước gốc)"!`);

            // Fallback: gọi trực tiếp .click() trên phần tử để đảm bảo 100%
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: "MAIN",
                func: () => {
                  const allEls = Array.from(document.querySelectorAll("*")).filter(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width < 50 || r.width > 350 || r.height < 18 || r.height > 75) return false;
                    if (el.closest("form, [class*='composer'], [class*='prompt-box'], [class*='input-container']")) return false;
                    const t = (el.innerText || el.textContent || "").trim();
                    if (t.includes("giây") || t.includes("crop") || t.includes("Video ·")) return false;
                    if (t.includes("270p") || t.includes("1080p") || t.includes("4K")) return false;
                    return t.includes("720p") || t.includes("Kích thước gốc") || t.toLowerCase().includes("original");
                  });
                  if (allEls.length > 0) {
                    allEls.sort((a, b) => {
                      const ta = (a.innerText || a.textContent || "");
                      const tb = (b.innerText || b.textContent || "");
                      const aGoc = ta.includes("Kích thước gốc") || ta.toLowerCase().includes("gốc") || ta.toLowerCase().includes("original") ? 1 : 0;
                      const bGoc = tb.includes("Kích thước gốc") || tb.toLowerCase().includes("gốc") || tb.toLowerCase().includes("original") ? 1 : 0;
                      if (aGoc !== bGoc) return bGoc - aGoc;
                      const aBtn = a.tagName === 'BUTTON' || a.getAttribute('role') === 'menuitem' ? 1 : 0;
                      const bBtn = b.tagName === 'BUTTON' || b.getAttribute('role') === 'menuitem' ? 1 : 0;
                      if (aBtn !== bBtn) return bBtn - aBtn;
                      const ra = a.getBoundingClientRect();
                      const rb = b.getBoundingClientRect();
                      return (rb.width * rb.height) - (ra.width * ra.height);
                    });
                    if (typeof allEls[0].click === 'function') allEls[0].click();
                  }
                }
              });
            } catch (_) {}
          }

          // Bước 3: Lắng nghe xem Chrome Downloads có bắt đầu tải file không
          logs.push(`⏳ Đang kiểm tra xem Chrome có bắt đầu tải video .mp4 về không...`);
          const dlPromise = new Promise((resolve) => {
            const listener = (item) => {
              chrome.downloads.onCreated.removeListener(listener);
              resolve(item);
            };
            chrome.downloads.onCreated.addListener(listener);
            setTimeout(() => {
              chrome.downloads.onCreated.removeListener(listener);
              resolve(null);
            }, 5000);
          });

          const startedDl = await dlPromise;
          if (startedDl) {
            logs.push(`\n🎉 THÀNH CÔNG 100%! Trình duyệt Chrome đã nhận lệnh và bắt đầu tải file!`);
            logs.push(`📁 File: ${startedDl.filename || 'Google Flow Video'}`);
            logs.push(`🌐 URL: ${startedDl.url ? startedDl.url.slice(0, 75) + '...' : ''}`);
            logs.push(`💡 Bạn hãy kiểm tra khay download của Chrome.`);
          } else {
            logs.push(`\n✅ Đã gửi lệnh click hoàn tất! Nếu video cần xử lý trước khi xuất, file sẽ bắt đầu tải về sau ít giây.`);
          }
        }
      } finally {
        if (cdpAttached) {
          try { await chrome.debugger.detach({ tabId: tab.id }); } catch (_) {}
        }
      }

      // Xử lý download url cũ (nếu có từ step 7)
      if (resObj.videoUrls?.length > 0) {
        const targetVideoUrl = resObj.videoUrls[0];
        logs.push(`\n──────────────────────────────────────────`);
        logs.push(`📥 [Extension Background] Đang gửi lệnh tải trực tiếp qua chrome.downloads...`);
        logs.push(`   Link: ${targetVideoUrl.slice(0, 85)}...`);

        try {
          const dlPromise = new Promise((resolve, reject) => {
            chrome.downloads.download({
              url: targetVideoUrl,
              filename: `flow_video_${Date.now()}.mp4`,
              saveAs: false
            }, (downloadId) => {
              if (chrome.runtime.lastError || !downloadId) {
                return reject(new Error(chrome.runtime.lastError?.message || 'Lỗi bắt đầu download'));
              }

              let timer = null;
              const timeout = setTimeout(() => {
                if (timer) clearInterval(timer);
                resolve({ downloadId, status: 'TIMEOUT' });
              }, 15000);

              timer = setInterval(() => {
                chrome.downloads.search({ id: downloadId }, (items) => {
                  if (items && items.length > 0) {
                    const it = items[0];
                    if (it.state === 'complete') {
                      clearInterval(timer);
                      clearTimeout(timeout);
                      resolve({ downloadId, status: 'COMPLETE', item: it });
                    } else if (it.state === 'interrupted') {
                      clearInterval(timer);
                      clearTimeout(timeout);
                      resolve({ downloadId, status: 'FAILED', error: it.error });
                    }
                  }
                });
              }, 500);
            });
          });

          const dlResult = await dlPromise;
          if (dlResult.status === 'COMPLETE') {
            const it = dlResult.item;
            const mb = it.fileSize ? (it.fileSize / 1024 / 1024).toFixed(2) + " MB" : "đã xong";
            logs.push(`🎉 THÀNH CÔNG 100%! chrome.downloads đã tải xong video!`);
            logs.push(`📁 File: ${it.filename}`);
            logs.push(`📊 Dung lượng: ${mb} | MIME: ${it.mime}`);
            logs.push(`💡 Bạn hãy kiểm tra thư mục Downloads, video .mp4 đã về máy!`);
          } else if (dlResult.status === 'FAILED') {
            logs.push(`⚠️ chrome.downloads báo lỗi: ${dlResult.error}`);
          } else {
            logs.push(`⏳ Download ID ${dlResult.downloadId} đang tiếp tục chạy ngầm...`);
          }
        } catch (dlErr) {
          logs.push(`❌ Lỗi chrome.downloads: ${dlErr.message}`);
        }
      }

      return { success: true, message: logs.join("\n") };
    }

    return { success: true, message: results[0].result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
