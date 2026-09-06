(function() {
  "use strict";

  // ══════════════════════════════════════
  // ══════════════════════════════════════
  // EXTENSION ID — lấy từ chrome://extensions/ hoặc localStorage
  // ══════════════════════════════════════
  let EXT_ID = new URLSearchParams(window.location.search).get("extId") || localStorage.getItem("flowExtId") || "kklcohedgnbeeabadindiggflndepkch";

  // Helper: get delay ms from select value, supports random ranges
  function getDelay(selectId, fallback) {
    const val = document.getElementById(selectId)?.value || "";
    if (val === "random_6_10") return 6000 + Math.floor(Math.random() * 4001); // 6000-10000ms
    return parseInt(val, 10) || fallback;
  }

  window.changeExtensionId = function() {
    const current = localStorage.getItem("flowExtId") || EXT_ID;
    const newId = prompt("Nhập Extension ID của Profile này (xem tại chrome://extensions/):", current);
    if (newId && newId.trim()) {
      localStorage.setItem("flowExtId", newId.trim());
      EXT_ID = newId.trim();
      toast("Đã lưu Extension ID: " + EXT_ID.slice(0, 8) + "...", "success");
      checkConnection();
    }
  };

  // ──────────────────────────
  // Dual-Channel Extension Communication
  // (Kênh 1: Auto-Bridge qua Content Script - Không cần ID)
  // (Kênh 2: Direct messaging qua chrome.runtime.sendMessage)
  // ──────────────────────────
  let hasBridge = false;
  let bridgeVersion = "3.9";

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === "FLOW_BRIDGE_PONG") {
      hasBridge = true;
      bridgeVersion = e.data.version || "3.9";
      const dot = document.getElementById("connDot");
      const txt = document.getElementById("connText");
      if (dot && txt) {
        dot.classList.add("ok");
        txt.textContent = "Extension v" + bridgeVersion + " (Auto Bridge) — Connected ✅";
      }
    }
  });

  // Lắng nghe cập nhật trạng thái download trực tiếp từ background
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.action === "DOWNLOAD_STATUS_UPDATE") {
        const logEl = document.getElementById("testStepLog");
        if (logEl && (logEl.textContent.includes(msg.query) || logEl.textContent.includes("B8.Full"))) {
          logEl.textContent += `\n[Trạng thái] ${msg.status}: ${msg.progress || ''}`;
          logEl.scrollTop = logEl.scrollHeight;
        }

        // Cập nhật cho batchTasks và uiBatchTasks nếu có query cụ thể
        if (msg.query && msg.query.trim()) {
          const qClean = msg.query.trim().toLowerCase();

          if (typeof batchTasks !== 'undefined' && Array.isArray(batchTasks)) {
            const t = batchTasks.find(x => (x.status === "RENDERING" || x.status === "SUBMITTED") && (
              (x.seq && x.seq.toLowerCase().includes(qClean)) ||
              (x.prompt && x.prompt.toLowerCase().includes(qClean))
            ));
            if (t) {
              t.status = msg.status === 'READY' ? 'DOWNLOADING' : 'RENDERING';
              t.downloadStatus = msg.status === 'READY' ? 'Render xong! Đang tải 720p...' : (msg.progress || 'Đang render...');
              renderQueueUI();
            }
          }

          if (typeof uiBatchTasks !== 'undefined' && Array.isArray(uiBatchTasks)) {
            const t = uiBatchTasks.find(x => (x.status === "RENDERING" || x.status === "SUBMITTED") && (
              (x.seq && x.seq.toLowerCase().includes(qClean)) ||
              (x.prompt && x.prompt.toLowerCase().includes(qClean))
            ));
            if (t) {
              t.status = msg.status === 'READY' ? 'DOWNLOADING' : 'RENDERING';
              t.downloadStatus = msg.status === 'READY' ? 'Render xong! Đang tải 720p...' : (msg.progress || 'Đang render...');
              renderUiBatchUI();
            }
          }
        }

        // Cập nhật cho Single UI Create nếu đang theo dõi
        const singleDlEl = document.getElementById("uiSingleDlStatus");
        if (singleDlEl) {
          singleDlEl.innerHTML = `⏳ <b>${msg.status === 'READY' ? 'Render xong! Đang tải 720p...' : (msg.progress || 'Đang render...')}</b>`;
        }
      }
    });
  }

    function callExt(action, data = {}) {
    return new Promise((resolve, reject) => {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action, ...data }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } else {
        reject(new Error("chrome.runtime.sendMessage is not available."));
      }
    });
  }

  // ──────────────────────────
  // UI Mutex Lock (Điều phối tránh va chạm chuột giữa Luồng Submit và Luồng Tải)
  // ──────────────────────────
  let isUiLockBusy = false;
  async function acquireUiLock(timeoutMs = 25000) {
    const start = Date.now();
    while (isUiLockBusy) {
      if (Date.now() - start > timeoutMs) {
        console.warn("[UI Lock] Timeout, tự động giải phóng lock!");
        isUiLockBusy = false;
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    isUiLockBusy = true;
  }
  function releaseUiLock() {
    isUiLockBusy = false;
  }

  // ──────────────────────────
  // Connection Check
  // ──────────────────────────
  async function checkConnection() {
    const dot = document.getElementById("connDot");
    const txt = document.getElementById("connText");
    window.postMessage({ type: "FLOW_BRIDGE_PING" }, "*");

    try {
      const r = await callExt("PING");
      if (r?.success) {
        dot.classList.add("ok");
        txt.textContent = "Extension v" + (r.version || bridgeVersion || "?") + " — Connected ✅";
        return true;
      }
    } catch (e) {
      console.warn("Connection check notice:", e.message);
    }
    if (!hasBridge) {
      dot.classList.remove("ok");
      txt.textContent = "Extension chưa kết nối! (F5 lại hoặc đổi ID ⚙️)";
      return false;
    }
    return true;
  }

  // ──────────────────────────
  // Tab Switching
  // ──────────────────────────
  window.switchTab = function(tabName) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + tabName));
    const id1 = document.getElementById("projectId")?.value;
    const id2 = document.getElementById("projectId2")?.value;
    const id3 = document.getElementById("batchProjectId")?.value;
    const id4 = document.getElementById("imageProjectId")?.value;
    const id5 = document.getElementById("batchImageProjectId")?.value;
    const currentId = id1 || id2 || id3 || id4 || id5;
    if (document.getElementById("projectId")) document.getElementById("projectId").value = currentId;
    if (document.getElementById("projectId2")) document.getElementById("projectId2").value = currentId;
    if (document.getElementById("batchProjectId")) document.getElementById("batchProjectId").value = currentId;
    if (document.getElementById("imageProjectId")) document.getElementById("imageProjectId").value = currentId;
    if (document.getElementById("batchImageProjectId")) document.getElementById("batchImageProjectId").value = currentId;
    if (tabName === "library") { fetchVideos(); togglePoll(true); }
    else { togglePoll(false); }
  };

  // ──────────────────────────
  // Create Image (Tạo Ảnh)
  // ──────────────────────────
  window.createImage = async function() {
    const prompt = document.getElementById("imagePromptInput").value.trim();
    const projectId = document.getElementById("imageProjectId").value.trim();
    const model = document.getElementById("imageModel").value;
    const aspectRatio = document.getElementById("imageAspect").value;
    const referenceImage = document.getElementById("refImage").value.trim() || null;
    const btn = document.getElementById("btnCreateImage");
    const st = document.getElementById("imageCreateStatus");
    const resDiv = document.getElementById("imageResult");

    if (!prompt && !referenceImage) { toast("Nhập prompt hoặc chọn ảnh tham chiếu!", "error"); return; }
    if (!projectId) { toast("Nhập Project ID!", "error"); return; }

    btn.disabled = true;
    resDiv.innerHTML = "";
    st.innerHTML = '<div class="status-msg loading">🎨 Đang tạo ảnh với Google Imagen...</div>';

    try {
      const res = await callExt("CREATE_IMAGE", { prompt, projectId, model, aspectRatio, referenceImage });
      console.log("CREATE_IMAGE response:", res);

      if (res?.success) {
        const mediaId = res.mediaId;
        const imgUrl = mediaId ? `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}` : null;
        st.innerHTML = `<div class="status-msg ok">✅ Đã tạo ảnh thành công!</div>`;
        toast("Tạo ảnh thành công! 🎨", "success");

        if (imgUrl) {
          resDiv.innerHTML = `
            <div style="background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:14px; text-align:center;">
              <img src="${imgUrl}" style="max-width:100%; max-height:400px; border-radius:8px; object-fit:contain; margin-bottom:10px;" alt="Generated Image" />
              <div style="display:flex; justify-content:center; gap:10px;">
                <button class="btn btn-sm btn-green" data-action="downloadImage" data-id="${mediaId}">⬇️ Tải Ảnh Về Máy</button>
                <button class="btn btn-sm" style="background:var(--surface2);" data-action="copyId" data-id="${mediaId}">📋 Copy Media ID</button>
              </div>
            </div>
          `;
        }
      } else {
        st.innerHTML = `<div class="status-msg err">❌ ${res?.error || "Lỗi tạo ảnh"}</div>`;
        toast(res?.error || "Lỗi tạo ảnh", "error");
      }
    } catch (e) {
      st.innerHTML = `<div class="status-msg err">❌ ${e.message}</div>`;
      toast(e.message, "error");
    } finally {
      btn.disabled = false;
    }
  };

  window.downloadImageDirect = async function(mediaId) {
    toast("Đang tải ảnh về máy...", "info");
    try {
      const res = await callExt("DOWNLOAD_VIDEO", { mediaId, filename: `flow_image_${mediaId.slice(0, 8)}.png` });
      if (res?.success) {
        toast("Đã bắt đầu tải ảnh về máy! ⬇️", "success");
      } else {
        const url = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;
        window.open(url, "_blank");
      }
    } catch (e) {
      const url = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;
      window.open(url, "_blank");
    }
  };

  window.copyMediaId = function(mediaId) {
    navigator.clipboard.writeText(mediaId);
    toast("Đã copy Media ID: " + mediaId, "success");
  };

  // ══════════════════════════════════════
  // Batch Image Queue Engine (Tạo Ảnh Hàng Loạt)
  // ══════════════════════════════════════
  let batchImageTasks = [];
  let isBatchImageRunning = false;
  let activeImageWorkers = 0;

  window.startBatchImageQueue = async function() {
    const rawInput = document.getElementById("batchImageInput").value.trim();
    const projectId = document.getElementById("batchImageProjectId").value.trim();
    const defaultModel = document.getElementById("batchImageModel").value;
    const defaultAspect = document.getElementById("batchImageAspect").value;
    const concurrency = 1;

    if (!projectId) { toast("Nhập Project ID!", "error"); return; }

    if (!batchImageTasks.length || batchImageTasks.every(t => t.status === "SUCCESS" || t.status === "ERROR")) {
      if (!rawInput) { toast("Nhập danh sách prompts tạo ảnh!", "error"); return; }

      const lines = rawInput.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("//") && !l.startsWith("#"));
      if (!lines.length) { toast("Không có dòng prompt hợp lệ nào!", "error"); return; }

      batchImageTasks = lines.map((line, idx) => {
        let prompt = line;
        let referenceImage = null;
        if (line.includes("|")) {
          const parts = line.split("|").map(p => p.trim());
          if (parts.length >= 2) {
            referenceImage = parts[0];
            prompt = parts.slice(1).join(" | ");
          }
        }
        return {
          id: idx + 1,
          prompt,
          referenceImage,
          projectId,
          model: defaultModel,
          aspectRatio: defaultAspect,
          status: "PENDING",
          mediaId: null,
          error: null,
          workerId: null,
          retryCount: 0
        };
      });
    }

    isBatchImageRunning = true;
    document.getElementById("btnStartBatchImage").disabled = true;
    document.getElementById("btnStopBatchImage").disabled = false;
    document.getElementById("batchImageInput").disabled = true;

    renderImageQueueUI();
    toast(`🚀 Bắt đầu hàng đợi ảnh với ${concurrency} luồng!`, "success");

    activeImageWorkers = 0;

    for (let i = 1; i <= concurrency; i++) {
      runImageQueueWorker(i);
      await new Promise(r => setTimeout(r, (i - 1) * 1500));
    }
  };

  window.stopBatchImageQueue = function() {
    isBatchImageRunning = false;
    document.getElementById("btnStartBatchImage").disabled = false;
    document.getElementById("btnStopBatchImage").disabled = true;
    document.getElementById("batchImageInput").disabled = false;
    toast("🛑 Đã dừng hàng đợi tạo ảnh!", "info");
    renderImageQueueUI();
  };

  window.clearBatchImageQueue = function() {
    if (isBatchImageRunning) {
      toast("Hãy dừng hàng đợi trước khi xoá!", "error");
      return;
    }
    batchImageTasks = [];
    document.getElementById("batchImageInput").disabled = false;
    renderImageQueueUI();
    toast("Đã xoá hàng đợi tạo ảnh!", "info");
  };

  window.retryFailedImageTasks = function() {
    if (isBatchImageRunning) return;
    const failed = batchImageTasks.filter(t => t.status === "ERROR");
    if (!failed.length) { toast("Không có task lỗi nào để thử lại!", "info"); return; }

    failed.forEach(t => {
      t.status = "PENDING";
      t.error = null;
      t.retryCount = 0;
    });

    toast(`🔄 Đang chuẩn bị thử lại ${failed.length} task lỗi...`, "info");
    window.startBatchImageQueue();
  };

  async function runImageQueueWorker(workerId) {
    activeImageWorkers++;
    let imgSuccessCount = 0;

    while (isBatchImageRunning) {
      const task = batchImageTasks.find(t => t.status === "PENDING");
      if (!task) break;

      task.status = "RUNNING";
      task.workerId = workerId;
      renderImageQueueUI();

      try {
        const res = await callExt("CREATE_IMAGE", {
          prompt: task.prompt,
          projectId: task.projectId,
          model: task.model,
          aspectRatio: task.aspectRatio,
          referenceImage: task.referenceImage
        });

        if (res?.success) {
          task.status = "SUCCESS";
          task.mediaId = res.mediaId || "Đã tạo";
          task.error = null;
          imgSuccessCount++;

          // Tự động tạo và chuyển sang Project mới sau mỗi 10 ảnh thành công
          if (imgSuccessCount > 0 && imgSuccessCount % 10 === 0 && isBatchImageRunning) {
            toast(`📁 Đã xong ${imgSuccessCount} ảnh. Đang tự tạo Project mới...`, "info");
            try {
              const pRes = await callExt("CREATE_PROJECT", {});
              if (pRes?.success && pRes?.projectId) {
                const newPid = pRes.projectId;
                toast(`✨ Đã tạo Project mới: ${newPid.slice(0, 8)}...`, "success");
                ["projectId", "projectId2", "batchProjectId", "imageProjectId", "batchImageProjectId"].forEach(id => {
                  const el = document.getElementById(id);
                  if (el) el.value = newPid;
                });
                batchImageTasks.forEach(t => {
                  if (t.status === "PENDING") {
                    t.projectId = newPid;
                  }
                });
              } else {
                toast(`⚠️ Không tạo được project mới: ${pRes?.error || ""}`, "warning");
              }
            } catch (err) {
              console.error("Lỗi tạo project mới:", err);
            }
          }
        } else {
          const errStr = (res?.error || "") + " " + (res?.detail || "");
          const isBlock = errStr.includes("429") || errStr.includes("UNUSUAL") || errStr.includes("Too Many");
          task.status = "ERROR";
          task.error = res?.error || "Lỗi tạo ảnh";

          if (isBlock && isBatchImageRunning) {
            for (let c = 600; c > 0 && isBatchImageRunning; c--) {
              task.error = `⛔ API lỗi — Tạm dừng 10 phút (còn ${Math.floor(c/60)}:${String(c%60).padStart(2,'0')})`;
              renderImageQueueUI();
              await new Promise(r => setTimeout(r, 1000));
            }
            task.status = "PENDING";
            task.error = null;
          }
        }
      } catch (e) {
        task.status = "ERROR";
        task.error = e.message;
      }

      renderImageQueueUI();

      // Cooldown: sau 20 task thành công, nghỉ 1-2 phút
      if (imgSuccessCount > 0 && imgSuccessCount % 20 === 0 && isBatchImageRunning) {
        const cooldown = 60 + Math.floor(Math.random() * 61); // 60-120s
        for (let c = cooldown; c > 0 && isBatchImageRunning; c--) {
          toast(`😴 Đã xong ${imgSuccessCount} ảnh — Nghỉ ngơi (còn ${c}s)`, "info");
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      await new Promise(r => setTimeout(r, getDelay("batchImageDelay", 3000)));
    }
    activeImageWorkers--;
    if (activeImageWorkers <= 0 && isBatchImageRunning) {
      window.stopBatchImageQueue();
      toast("🎉 Đã hoàn thành tất cả tác vụ tạo ảnh trong hàng đợi!", "success");
    }
  }

  function renderImageQueueUI() {
    const total = batchImageTasks.length;
    const pending = batchImageTasks.filter(t => t.status === "PENDING").length;
    const running = batchImageTasks.filter(t => t.status === "RUNNING").length;
    const success = batchImageTasks.filter(t => t.status === "SUCCESS").length;
    const error = batchImageTasks.filter(t => t.status === "ERROR").length;

    document.getElementById("imgStatTotal").textContent = total;
    document.getElementById("imgStatPending").textContent = pending;
    document.getElementById("imgStatRunning").textContent = running;
    document.getElementById("imgStatSuccess").textContent = success;
    document.getElementById("imgStatError").textContent = error;

    const completed = success + error;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    document.getElementById("imageQueueProgressFill").style.width = pct + "%";

    const listEl = document.getElementById("imageQueueTaskList");
    if (!total) {
      listEl.innerHTML = '<div style="color:var(--text2); font-size:12px; text-align:center; padding:16px;">Hàng đợi trống. Hãy nhập danh sách prompt và bấm Bắt đầu.</div>';
      return;
    }

    listEl.innerHTML = batchImageTasks.map(t => {
      let statusBadge = "";
      let itemClass = "queue-item";
      let imgPreview = "";

      if (t.status === "PENDING") {
        statusBadge = '<span style="color:var(--text2); font-size:12px;">⏳ Chờ</span>';
      } else if (t.status === "RUNNING") {
        itemClass += " running";
        statusBadge = `<span class="worker-tag worker-1">⚡ Luồng ${t.workerId || 1} đang tạo...</span>`;
      } else if (t.status === "SUCCESS") {
        itemClass += " success";
        statusBadge = '<span style="color:var(--green); font-weight:700; font-size:12px;">✅ Xong</span>';
        if (t.mediaId && t.mediaId.startsWith("media")) {
          const imgUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${t.mediaId}`;
          imgPreview = `
            <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
              <img src="${imgUrl}" style="width:48px; height:48px; border-radius:6px; object-fit:cover; border:1px solid var(--border);" />
              <button class="btn btn-sm btn-green" data-action="downloadImage" data-id="${t.mediaId}">⬇️ Tải Ảnh</button>
              <button class="btn btn-sm" style="background:var(--surface2);" data-action="copyId" data-id="${t.mediaId}">📋 Copy ID</button>
            </div>
          `;
        }
      } else if (t.status === "ERROR") {
        itemClass += " error";
        statusBadge = `<span style="color:var(--red); font-size:12px;" title="${t.error}">❌ Lỗi: ${t.error || "Thất bại"}</span>`;
      }

      return `
        <div class="${itemClass}">
          <div style="flex:1; overflow:hidden;">
            <div style="font-weight:600; font-size:12px; margin-bottom:2px; color:var(--text);">
              #${t.id}. ${t.prompt.slice(0, 100)}${t.prompt.length > 100 ? "..." : ""}
            </div>
            ${t.referenceImage ? `<div style="font-size:10px; color:var(--accent2); margin-bottom:4px;">🖼️ Tham chiếu: ${t.referenceImage.slice(0, 40)}...</div>` : ""}
            ${imgPreview}
          </div>
          <div>${statusBadge}</div>
        </div>
      `;
    }).join("");
  }

  // ──────────────────────────
  // Batch Video Queue Engine (2+ Luồng Song Song)
  // ──────────────────────────
  let batchTasks = [];
  let isBatchRunning = false;

  window.startBatchQueue = async function() {
    const rawInput = document.getElementById("batchInput").value.trim();
    const projectId = document.getElementById("batchProjectId").value.trim();
    const defaultModel = document.getElementById("batchModel").value;
    const defaultAspect = document.getElementById("batchAspectRatio").value;
    const autoDownload = document.getElementById("batchAutoDownload")?.checked !== false;

    if (!projectId) { toast("Nhập Project ID!", "error"); return; }

    // If queue is empty or all completed, parse input
    if (!batchTasks.length || batchTasks.every(t => t.status === "SUCCESS" || t.status === "ERROR")) {
      if (!rawInput) { toast("Nhập danh sách prompts!", "error"); return; }

      const lines = rawInput.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("//") && !l.startsWith("#"));
      if (!lines.length) { toast("Không có dòng prompt hợp lệ nào!", "error"); return; }

      // TỰ ĐỘNG ĐÁNH UNIX TIMESTAMP 10 SỐ ĐẦU PROMPT (KHÔNG TRÙNG LẶP)
      const baseTimestamp = Math.floor(Date.now() / 1000);
      let nextTimestamp = baseTimestamp;
      const existingSeqs = new Set(batchTasks.map(t => (t.seq || '').replace(/[^0-9]/g, '')).filter(Boolean));

      batchTasks = lines.map((line, idx) => {
        const parts = line.split("|").map(p => p.trim());
        let prompt = "", startImage = null, endImage = null;

        if (parts.length === 1) {
          prompt = parts[0];
        } else if (parts.length === 2) {
          if (parts[0].startsWith("http") || parts[0].includes(".png") || parts[0].includes(".jpg") || parts[0].length > 30) {
            startImage = parts[0];
            prompt = parts[1];
          } else {
            prompt = parts[0];
            endImage = parts[1];
          }
        } else if (parts.length >= 3) {
          startImage = parts[0];
          prompt = parts[1];
          endImage = parts[2];
        }

        // TỰ ĐỘNG ĐÁNH UNIX TIMESTAMP 10 SỐ (KHÔNG TRÙNG LẶP)
        let seqStr = "";
        const matchTimestamp = prompt.match(/^(\d{9,14})[\.\-_:\s]/);
        if (matchTimestamp) {
          seqStr = matchTimestamp[1] + ".";
          prompt = prompt.replace(/^(\d{9,14})[\.\-_:\s]\s*/, `${seqStr} `);
        } else {
          prompt = prompt.replace(/^\d{1,4}[\.\-_:\s]\s*/, '');
          while (existingSeqs.has(String(nextTimestamp))) {
            nextTimestamp++;
          }
          seqStr = `${nextTimestamp}.`;
          existingSeqs.add(String(nextTimestamp));
          prompt = `${seqStr} ${prompt}`;
          nextTimestamp++;
        }

        return {
          id: idx + 1,
          seq: seqStr,
          prompt,
          startImage,
          endImage,
          projectId,
          model: defaultModel,
          aspectRatio: defaultAspect,
          status: "PENDING",
          downloadStatus: "Chờ submit...",
          workerId: null,
          mediaId: null,
          error: null,
          retryCount: 0
        };
      });

      // Lưu STT lớn nhất mới vào storage
      callExt("UPDATE_MAX_SEQ", { projectId, newMax: startSeq + lines.length - 1 }).catch(() => {});
    }

    isBatchRunning = true;
    document.getElementById("btnStartBatch").style.display = "none";
    document.getElementById("btnPauseBatch").style.display = "inline-flex";
    toast(`🚀 [2 Luồng Song Song] Bắt đầu: Luồng Submit & ${autoDownload ? 'Luồng Tải 720p song song' : 'Không tải'}!`, "info");

    renderQueueUI();

    const submitWorker = runBatchSubmitWorker(projectId);
    const downloadWorker = autoDownload ? runBatchDownloadWorker(projectId) : Promise.resolve();

    await Promise.all([submitWorker, downloadWorker]);

    isBatchRunning = false;
    document.getElementById("btnStartBatch").style.display = "inline-flex";
    document.getElementById("btnPauseBatch").style.display = "none";
    renderQueueUI();
    toast("🎉 Hàng đợi đã xử lý xong tất cả các task!", "success");
  };

  window.retryFailedTasks = function() {
    batchTasks.forEach(t => {
      if (t.status === "ERROR" || t.status === "WARNING") {
        t.status = "PENDING";
        t.downloadStatus = "Chờ submit...";
        t.error = null;
        t.retryCount = (t.retryCount || 0) + 1;
      }
    });
    startBatchQueue();
  };

  window.pauseBatchQueue = function() {
    isBatchRunning = false;
    document.getElementById("btnStartBatch").style.display = "inline-flex";
    document.getElementById("btnPauseBatch").style.display = "none";
    toast("⏸️ Đã tạm dừng hàng đợi!", "info");
    renderQueueUI();
  };

  window.clearBatchQueue = function() {
    if (isBatchRunning && !confirm("Hàng đợi đang chạy. Bạn có chắc chắn muốn huỷ không?")) return;
    isBatchRunning = false;
    batchTasks = [];
    document.getElementById("btnStartBatch").style.display = "inline-flex";
    document.getElementById("btnPauseBatch").style.display = "none";
    renderQueueUI();
    toast("🗑️ Đã xoá hàng đợi!", "info");
  };

  async function runBatchSubmitWorker(projectId) {
    let videoSuccessCount = 0;

    for (let i = 0; i < batchTasks.length; i++) {
      if (!isBatchRunning) break;
      const task = batchTasks[i];
      if (task.status !== "PENDING") continue;

      task.status = "SUBMITTING";
      task.downloadStatus = "Đang gửi API...";
      renderQueueUI();

      try {
        const res = await callExt("CREATE_VIDEO", {
          prompt: task.prompt,
          projectId: task.projectId || projectId,
          model: task.model,
          aspectRatio: task.aspectRatio,
          startImage: task.startImage,
          endImage: task.endImage
        });

        if (res?.success) {
          task.mediaId = res.apiResponse?.media?.[0]?.name || "Đã gửi";
          task.submittedAt = Date.now();
          task.error = null;
          videoSuccessCount++;

          const autoDownload = document.getElementById("batchAutoDownload")?.checked !== false;
          if (autoDownload) {
            task.status = "SUBMITTED";
            task.downloadStatus = "Đã gửi Flow! Đang chờ render...";
          } else {
            task.status = "SUCCESS";
            task.downloadStatus = "Hoàn thành (Không tải)";
          }
          toast(`✅ [#${task.id}] Đã submit Flow: ${task.seq}`, "success");

          // Tự động tạo và chuyển sang Project mới sau mỗi 10 video thành công
          if (videoSuccessCount > 0 && videoSuccessCount % 10 === 0 && isBatchRunning) {
            toast(`📁 Đã xong ${videoSuccessCount} video. Đang tự tạo Project mới...`, "info");
            try {
              const pRes = await callExt("CREATE_PROJECT", {});
              if (pRes?.success && pRes?.projectId) {
                const newPid = pRes.projectId;
                toast(`✨ Đã tạo Project mới: ${newPid.slice(0, 8)}... Các video tiếp theo sẽ vào đây!`, "success");
                ["projectId", "projectId2", "batchProjectId", "imageProjectId", "batchImageProjectId"].forEach(id => {
                  const el = document.getElementById(id);
                  if (el) el.value = newPid;
                });
                batchTasks.forEach(t => {
                  if (t.status === "PENDING") {
                    t.projectId = newPid;
                  }
                });
              } else {
                toast(`⚠️ Không tạo được project mới: ${pRes?.error || ""}`, "warning");
              }
            } catch (err) {
              console.error("Lỗi tạo project mới:", err);
            }
          }
        } else {
          const errStr = (res?.error || "") + " " + (res?.detail || "");
          const isBlock = errStr.includes("429") || errStr.includes("UNUSUAL") || errStr.includes("Too Many");
          task.status = "ERROR";
          task.error = res?.error || "Lỗi tạo video";
          task.downloadStatus = `Lỗi submit: ${task.error}`;
          toast(`❌ [#${task.id}] ${task.error}`, "error");

          if (isBlock && isBatchRunning) {
            for (let c = 600; c > 0 && isBatchRunning; c--) {
              task.error = `⛔ API lỗi — Tạm dừng 10 phút (còn ${Math.floor(c/60)}:${String(c%60).padStart(2,'0')})`;
              renderQueueUI();
              await new Promise(r => setTimeout(r, 1000));
            }
            task.status = "PENDING";
            task.error = null;
          }
        }
      } catch (e) {
        task.status = "ERROR";
        task.error = e.message;
        task.downloadStatus = `Lỗi: ${e.message}`;
      }

      renderQueueUI();

      // Cooldown: sau 20 task thành công, nghỉ 1-2 phút
      if (videoSuccessCount > 0 && videoSuccessCount % 20 === 0 && isBatchRunning) {
        const cooldown = 60 + Math.floor(Math.random() * 61); // 60-120s
        for (let c = cooldown; c > 0 && isBatchRunning; c--) {
          toast(`😴 Đã xong ${videoSuccessCount} video — Nghỉ ngơi (còn ${c}s)`, "info");
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Delay between jobs
      if (i < batchTasks.length - 1 && isBatchRunning) {
        await new Promise(r => setTimeout(r, getDelay("batchDelay", 2000)));
      }
    }
  }

  async function runBatchDownloadWorker(projectId) {
    while (isBatchRunning) {
      const activeTasks = batchTasks.filter(t => t.status === "SUBMITTED" || t.status === "RENDERING");
      const hasUnsubmitted = batchTasks.some(t => t.status === "PENDING" || t.status === "SUBMITTING");

      if (!activeTasks.length) {
        if (!hasUnsubmitted) {
          // Tất cả các task đã hoàn thành hoặc thất bại
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      for (const task of activeTasks) {
        if (!isBatchRunning) break;

        try {
          const targetPid = task.projectId || projectId;
          const statusRes = await callExt("CHECK_CARD_STATUS", {
            projectId: targetPid,
            query: task.seq || task.prompt,
            prompt: task.prompt,
            seq: task.seq,
            mediaId: task.mediaId,
            workflowId: task.workflowId,
            mediaType: 'video'
          });
          if (statusRes?.status === 'RENDERING') {
            if (statusRes.mediaId && (!task.mediaId || task.mediaId !== statusRes.mediaId)) {
              console.log(`[Batch Worker] Cập nhật real mediaId cho task #${task.id} (${task.seq}): ${statusRes.mediaId}`);
              task.mediaId = statusRes.mediaId;
            }
            const curProg = statusRes.progress || '';
            if (task.lastProgress !== curProg) {
              task.lastProgress = curProg;
              task.lastProgressAt = Date.now();
            }
            task.missingCount = 0;
            task.status = "RENDERING";
            task.downloadStatus = `Đang render (${curProg || '...'})`;
            renderQueueUI();

            // Timeout kẹt % render quá 75 giây
            if (task.lastProgressAt && (Date.now() - task.lastProgressAt > 75000)) {
              console.warn(`[Batch Worker] Task #${task.id} bị kẹt ở tiến độ "${curProg}" quá 75s`);
              task.status = "ERROR";
              task.error = `Kẹt tiến độ render (${curProg || 'đứng im'}) quá 75s - Thất bại`;
              task.downloadStatus = task.error;
              toast(`⚠️ [#${task.id}] Render đứng im ở ${curProg} quá 75s (${task.seq || ''})`, "warning");
              renderQueueUI();
              continue;
            }
          } else if (statusRes?.status === 'READY') {
            if (statusRes.mediaId && (!task.mediaId || task.mediaId !== statusRes.mediaId)) {
              task.mediaId = statusRes.mediaId;
            }
            const elapsed = Date.now() - (task.submittedAt || 0);
            if (elapsed < 15000) {
              task.status = "RENDERING";
              task.downloadStatus = "Khởi tạo render...";
              renderQueueUI();
              continue;
            }
            task.status = "DOWNLOADING";
            task.downloadStatus = "Render xong! Đang tải 720p...";
            renderQueueUI();

            toast(`🎯 [#${task.id}] Card ${task.seq} render xong! Đang tải 720p...`, "info");

            await acquireUiLock();
            let dlRes = null;
            try {
              dlRes = await callExt("DOWNLOAD_CARD_NATIVE", {
                query: task.seq || task.prompt,
                prompt: task.prompt,
                seq: task.seq,
                mediaId: task.mediaId,
                workflowId: task.workflowId,
                mediaType: 'video',
                projectId: targetPid
              });
              if (!dlRes?.success) {
                console.warn(`[Batch Worker] Thử lại tải 720p lần 2 cho task #${task.id}...`);
                await new Promise(r => setTimeout(r, 1200));
                dlRes = await callExt("DOWNLOAD_CARD_NATIVE", {
                  query: task.seq || task.prompt,
                  prompt: task.prompt,
                  seq: task.seq,
                  mediaId: task.mediaId,
                  workflowId: task.workflowId,
                  mediaType: 'video',
                  projectId: targetPid
                });
              }
            } finally {
              releaseUiLock();
              callExt("SCROLL_FLOW_TO_TOP", { projectId: targetPid }).catch(() => {});
            }

            if (dlRes?.isStillRendering) {
              console.log(`[Batch Worker] Task #${task.id} vẫn đang render trên Flow (menu chỉ có nút Xoá), tiếp tục chờ...`);
              task.status = "RENDERING";
              task.downloadStatus = "Đang kết xuất video (chờ nút Tải xuống)...";
              task.lastProgressAt = Date.now();
              renderQueueUI();
              continue;
            }

            if (dlRes?.success) {
              task.status = "SUCCESS";
              task.downloadStatus = `Đã tải 720p (${dlRes.filename || 'OK'})`;
              toast(`📥 [#${task.id}] Đã tải xong video 720p (${task.seq})!`, "success");
            } else {
              task.status = "WARNING";
              task.downloadStatus = `Lỗi tải: ${dlRes?.error || 'timeout'}`;
              toast(`⚠️ [#${task.id}] Video tạo xong nhưng lỗi tải: ${dlRes?.error}`, "warning");
            }
            renderQueueUI();
          } else if (statusRes?.status === 'FAILED') {
            task.status = "ERROR";
            task.error = statusRes.error || "Render thất bại trên Flow";
            task.downloadStatus = statusRes.error || "Render thất bại trên Flow";
            toast(`❌ [#${task.id}] ${task.error} (${task.seq || ''})`, "error");
            renderQueueUI();
          } else if (task.status === "RENDERING") {
            // Thẻ đã từng rendering nhưng hiện tại không tìm thấy (Flow xoá hoặc chuyển sang lỗi)
            task.missingCount = (task.missingCount || 0) + 1;
            if (task.missingCount >= 4) {
              task.status = "ERROR";
              task.error = "Vi phạm chính sách / Thẻ render không thành công trên Flow";
              task.downloadStatus = task.error;
              toast(`❌ [#${task.id}] ${task.error} (${task.seq || ''})`, "error");
              renderQueueUI();
              continue;
            }
          }

          // Global Render Timeout: Quá 4 phút kể từ khi submit
          const totalElapsed = Date.now() - (task.submittedAt || Date.now());
          if (totalElapsed > 240000 && (task.status === "RENDERING" || task.status === "SUBMITTED")) {
            task.status = "ERROR";
            task.error = "Quá thời gian render (> 4 phút)";
            task.downloadStatus = task.error;
            toast(`⏱️ [#${task.id}] Hết thời gian chờ render (> 4 phút) (${task.seq || ''})`, "error");
            renderQueueUI();
            continue;
          }
        } catch (e) {
          console.warn(`[Batch Download Worker] Lỗi kiểm tra task ${task.id}:`, e);
        }
      }

      await new Promise(r => setTimeout(r, 3000));
    }
  }

  function renderQueueUI() {
    const total = batchTasks.length;
    const pending = batchTasks.filter(t => t.status === "PENDING").length;
    const running = batchTasks.filter(t => t.status === "SUBMITTING" || t.status === "RUNNING" || t.status === "SUBMITTED" || t.status === "RENDERING" || t.status === "DOWNLOADING").length;
    const success = batchTasks.filter(t => t.status === "SUCCESS").length;
    const warning = batchTasks.filter(t => t.status === "WARNING").length;
    const error = batchTasks.filter(t => t.status === "ERROR").length;
    const doneCount = success + warning + error;

    if (document.getElementById("statTotal")) document.getElementById("statTotal").textContent = total;
    if (document.getElementById("statPending")) document.getElementById("statPending").textContent = pending;
    if (document.getElementById("statRunning")) document.getElementById("statRunning").textContent = running;
    if (document.getElementById("statSuccess")) document.getElementById("statSuccess").textContent = success;
    if (document.getElementById("statError")) document.getElementById("statError").textContent = error;

    const retryBtn = document.getElementById("btnRetryFailed");
    if (retryBtn) retryBtn.style.display = ((error > 0 || warning > 0) && !isBatchRunning) ? "inline-flex" : "none";

    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    if (document.getElementById("queueProgressFill")) document.getElementById("queueProgressFill").style.width = pct + "%";

    const listEl = document.getElementById("queueTaskList");
    if (!listEl) return;
    if (!total) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--text2);font-size:12px;padding:20px;">Chưa có task nào trong hàng đợi.</div>';
      return;
    }

    listEl.innerHTML = batchTasks.map(t => {
      let statusBadge = '<span style="color:var(--text2);font-size:11px;">⏳ Chờ...</span>';
      let itemClass = "";
      if (t.status === "SUBMITTING" || t.status === "RUNNING") {
        itemClass = "running";
        const retryNote = t.retryCount > 0 ? ` (Thử lại L${t.retryCount})` : "";
        statusBadge = `<span class="worker-tag" style="background:rgba(255, 153, 0, 0.2); color:#ff9800; border:1px solid rgba(255, 153, 0, 0.4);">⚡ Đang gửi...${retryNote}</span>`;
      } else if (t.status === "SUBMITTED") {
        itemClass = "running";
        statusBadge = `<span class="worker-tag" style="background:rgba(108, 92, 231, 0.2); color:var(--accent2); border:1px solid rgba(108, 92, 231, 0.4);">⏳ Đã gửi (Chờ render...)</span>`;
      } else if (t.status === "RENDERING") {
        itemClass = "running";
        statusBadge = `<span class="worker-tag" style="background:rgba(0, 229, 255, 0.2); color:var(--accent2); border:1px solid rgba(0, 229, 255, 0.4);">⏳ ${esc(t.downloadStatus || 'Đang render...')}</span>`;
      } else if (t.status === "DOWNLOADING") {
        itemClass = "running";
        statusBadge = `<span class="worker-tag" style="background:rgba(255, 0, 127, 0.2); color:#ff007f; border:1px solid rgba(255, 0, 127, 0.4);">📥 Đang tải 720p...</span>`;
      } else if (t.status === "SUCCESS") {
        itemClass = "success";
        const successLabel = t.downloadStatus ? `✅ ${esc(t.downloadStatus)}` : `✅ Đã gửi Flow (${t.mediaId ? t.mediaId.slice(0,8) : 'OK'})`;
        statusBadge = `<span style="color:var(--green);font-size:11px;font-weight:700;">${successLabel}</span>`;
      } else if (t.status === "WARNING") {
        itemClass = "error";
        statusBadge = `<span style="color:var(--yellow);font-size:11px;" title="${esc(t.downloadStatus || t.error)}">⚠️ ${esc(t.downloadStatus?.slice(0, 50) || 'Cảnh báo tải')}</span>`;
      } else if (t.status === "ERROR") {
        itemClass = "error";
        statusBadge = `<span style="color:var(--red);font-size:11px;font-weight:600;" title="${esc(t.error)}">❌ ${esc(t.error?.slice(0, 50) || 'Lỗi')}</span>`;
      }

      const imgInfo = [];
      if (t.startImage) imgInfo.push(`🖼️ Start: ${esc(t.startImage.slice(0, 25))}`);
      if (t.endImage) imgInfo.push(`🏁 End: ${esc(t.endImage.slice(0, 25))}`);
      const imgLine = imgInfo.length ? `<div style="font-size:10px;color:var(--text2);margin-top:2px;">${imgInfo.join(" | ")}</div>` : "";

      return `<div class="queue-item ${itemClass}">
        <div style="flex:1; overflow:hidden;">
          <div style="font-size:12px; font-weight:600; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">#${t.id}. ${esc(t.prompt)}</div>
          ${imgLine}
        </div>
        <div style="white-space:nowrap;">
          ${statusBadge}
        </div>
      </div>`;
    }).join("");
  }

  // ──────────────────────────
  // Create Video
  // ──────────────────────────
  window.createVideo = async function() {
    const prompt = document.getElementById("promptInput").value.trim();
    const projectId = document.getElementById("projectId").value.trim();
    const model = document.getElementById("videoModel").value;
    const aspectRatio = document.getElementById("aspectRatio").value;
    const startImage = document.getElementById("startImage").value.trim() || null;
    const endImage = document.getElementById("endImage").value.trim() || null;
    const btn = document.getElementById("btnCreate");
    const st = document.getElementById("createStatus");

    if (!prompt && !startImage) { toast("Nhập prompt hoặc chọn ảnh đầu vào!", "error"); return; }
    if (!projectId) { toast("Nhập Project ID!", "error"); return; }

    btn.disabled = true;

    // Step-by-step progress
    st.innerHTML = '<div class="status-msg loading">🔑 Bước 1/3: Đang lấy reCAPTCHA token từ Google Flow...</div>';

    try {
      await new Promise(r => setTimeout(r, 300));
      st.innerHTML = '<div class="status-msg loading">📡 Bước 2/3: Đang gọi API tạo video...</div>';

      const res = await callExt("CREATE_VIDEO", { prompt, projectId, model, aspectRatio, startImage, endImage });
      console.log("CREATE_VIDEO response:", JSON.stringify(res, null, 2));

      if (res?.success) {
        // Show response details for debugging
        const apiInfo = res.apiResponse ? `<pre style="font-size:11px;color:var(--text2);margin-top:8px;max-height:120px;overflow:auto;background:var(--bg);padding:8px;border-radius:6px;">${JSON.stringify(res.apiResponse, null, 2)}</pre>` : "";
        st.innerHTML = `<div class="status-msg ok">✅ Video đã được gửi tạo! Chờ render...${apiInfo}</div>`;
        toast("Video đang được render! 🎬", "success");

        // Auto-switch to Library tab after 2s
        setTimeout(() => {
          document.getElementById("projectId2").value = projectId;
          switchTab("library");
          const pollCheckbox = document.getElementById("autoPoll");
          if (!pollCheckbox.checked) { pollCheckbox.checked = true; togglePoll(true); }
        }, 2000);
      } else {
        st.innerHTML = `<div class="status-msg err">❌ ${res?.error || "Lỗi"}<pre style="font-size:11px;color:var(--text2);margin-top:8px;max-height:120px;overflow:auto;background:var(--bg);padding:8px;border-radius:6px;">Response: ${JSON.stringify(res, null, 2)}</pre></div>`;
        toast(res?.error || "Lỗi tạo video", "error");
      }
    } catch (e) {
      st.innerHTML = `<div class="status-msg err">❌ ${e.message}</div>`;
      toast(e.message, "error");
    } finally { btn.disabled = false; }
  };

  window.handleFileSelect = async function(inputEl, targetInputId) {
    const file = inputEl.files?.[0];
    if (!file) return;

    const targetInput = document.getElementById(targetInputId);
    const projectId = document.getElementById("imageProjectId")?.value || document.getElementById("projectId")?.value || document.getElementById("batchProjectId")?.value;

    toast(`⏳ Đang tải ảnh "${file.name}" lên Flow...`, "info");
    targetInput.value = `⏳ Đang tải ảnh ${file.name}...`;

    const reader = new FileReader();
    reader.onload = async function(e) {
      const base64Data = e.target.result;
      try {
        const res = await callExt("UPLOAD_IMAGE", { projectId, imageBase64: base64Data });
        if (res?.success && res.mediaId) {
          targetInput.value = res.mediaId;
          toast(`✅ Đã tải ảnh lên Flow thành công! (Media ID: ${res.mediaId.slice(0, 8)}...)`, "success");
        } else {
          targetInput.value = base64Data;
          toast(`Đã chọn ảnh "${file.name}"!`, "success");
        }
      } catch (err) {
        targetInput.value = base64Data;
        toast(`Đã chọn ảnh "${file.name}"!`, "success");
      }
    };
    reader.readAsDataURL(file);
  };

  // ──────────────────────────
  // Fetch Videos
  // ──────────────────────────
  window.fetchVideos = async function(silent) {
    let projectId = document.getElementById("projectId2").value.trim();
    const btn = document.getElementById("btnFetch");
    const grid = document.getElementById("videoGrid");

    try {
      const tabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/*"] });
      const currentTab = tabs.find(t => t.active) || tabs[0];
      const urlMatch = currentTab?.url?.match(/project\/([a-f0-9\-]{36})/i);
      if (urlMatch && urlMatch[1]) {
        projectId = urlMatch[1];
        if (document.getElementById("projectId2")) document.getElementById("projectId2").value = projectId;
      }
    } catch (_) {}

    if (!projectId) { if (!silent) toast("Nhập Project ID!", "error"); return; }
    if (!silent) btn.disabled = true;

    try {
      const res = await callExt("GET_PROJECT_VIDEOS", { projectId });
      if (res?.success) {
        renderProjectInfo(res);
        renderVideos(res.videos || []);
        document.getElementById("lastUpdate").textContent = "Cập nhật: " + new Date().toLocaleTimeString("vi-VN");
      } else {
        if (!silent) grid.innerHTML = `<div class="empty-state"><div class="icon">❌</div><p>${res?.error || "Lỗi"}</p></div>`;
        toast(res?.error || "Lỗi lấy video", "error");
      }
    } catch (e) {
      if (!silent) grid.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${e.message}</p></div>`;
    } finally { btn.disabled = false; }
  };

  function renderProjectInfo(d) {
    document.getElementById("projectInfo").innerHTML = `
      <div class="project-info" style="margin-top:14px;">
        <div class="info-item"><div class="info-label">Tên Project</div><div class="info-value accent">${esc(d.projectName)}</div></div>
        <div class="info-item"><div class="info-label">Model mặc định</div><div class="info-value">${esc(d.defaultModel)}</div></div>
        <div class="info-item"><div class="info-label">🎬 Video</div><div class="info-value green">${d.totalVideos || 0}</div></div>
        <div class="info-item"><div class="info-label">🖼️ Hình ảnh</div><div class="info-value" style="color:var(--text2)">${d.totalImages || 0}</div></div>
      </div>`;
  }
  let allVideos = [];

  function renderVideos(videos) {
    allVideos = videos;
    filterVideos();
  }

  window.filterVideos = function() {
    const filter = (document.getElementById("promptFilter").value || "").toLowerCase().trim();
    const filtered = filter ? allVideos.filter(v => (v.prompt || "").toLowerCase().includes(filter) || (v.mediaId || "").toLowerCase().includes(filter)) : allVideos;
    renderVideoCards(filtered, allVideos.length);
  };

  function renderVideoCards(videos, total) {
    const grid = document.getElementById("videoGrid");
    const filter = (document.getElementById("promptFilter").value || "").trim();
    if (!videos.length) {
      grid.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>${filter ? `Không tìm thấy video với "${esc(filter)}" (${total} tổng)` : 'Chưa có video nào.'}</p></div>`;
      return;
    }
    const countInfo = filter ? `<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">🔍 ${videos.length}/${total} video khớp</div>` : "";
    grid.innerHTML = videos.map((v, idx) => {
      const done = v.status === "COMPLETED";
      const failed = v.status === "FAILED";
      const numPrefix = String(idx + 1).padStart(2, "0");
      const progressLabel = v.progress ? ` (${v.progress})` : "";
      const statusBadge = done
        ? '<span class="v-tag done">✅ Xong</span>'
        : failed
        ? `<span class="v-tag" style="background:rgba(239,68,68,0.2);color:#ef4444;" title="${esc(v.failureReason)}">❌ Thất bại</span>`
        : `<span class="v-tag pending">⏳ Đang render${progressLabel}...</span>`;

      const displayPrompt = (v.prompt && v.prompt !== "Video Veo" && v.prompt !== "Flow Media") 
        ? v.prompt 
        : `Video Veo #${idx + 1}`;

      return `<div class="video-card" style="padding:10px; border-radius:8px; background:var(--surface, #1e2029); margin-bottom:8px; border:1px solid var(--border, #2a2d3d);">
        <div class="v-prompt" style="font-size:13px;font-weight:600;line-height:1.4;margin-bottom:6px;" title="${esc(v.prompt)}">
          <span style="color:var(--accent);font-weight:700;margin-right:6px;font-size:14px;">#${idx + 1}</span>
          <span style="color:#ffffff;">${esc(displayPrompt)}</span>
        </div>
        <div class="v-id" style="font-size:10px;color:var(--text2, #888);font-family:monospace;margin-bottom:8px;">ID: ${v.mediaId}</div>
        <div class="v-tags" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">
          <span class="v-tag model">🤖 ${esc(v.model || "Veo 3.1")}</span>
          <span class="v-tag res">📺 ${esc(v.resolution || "720P")}</span>
          ${statusBadge}
        </div>
        <div class="v-actions" style="display:flex; gap:6px;">
          ${(() => {
            const hasNumPrefix = /^\d+[\.\-_]/.test(displayPrompt.trim());
            const fileSlug = hasNumPrefix
              ? esc(displayPrompt).replace(/'/g, '').slice(0, 35)
              : `${numPrefix}_${esc(displayPrompt).replace(/'/g, '').slice(0, 30)}`;
            return done ? `<button class="btn btn-green btn-sm" data-action="downloadVid" data-id="${v.mediaId}" data-url="${v.videoUrl || ''}" data-index="${v.cardIndex !== undefined ? v.cardIndex : idx}" data-prompt="${fileSlug}">📥 Tải MP4 (#${idx + 1})</button>` : `<span class="btn btn-sm" style="background:var(--border);color:var(--text2);cursor:not-allowed;">⏳ Chờ${progressLabel}...</span>`;
          })()}
          <button class="btn btn-sm btn-delete-vid" data-action="deleteVid" data-workflow="${v.workflowId || v.mediaId}" data-project="${v.projectId}" data-media="${v.mediaId}" data-prompt="${esc(displayPrompt).replace(/'/g,'').slice(0,30)}">🗑️ Xoá</button>
        </div>
      </div>`;
    }).join("");
    grid.innerHTML = countInfo + grid.innerHTML;
  }

  window.downloadVid = async function(mediaId, promptSlug, directUrl = null, cardIndex = -1) {
    toast("📥 Đang chuẩn bị tải video...", "info");
    try {
      const item = (allVideos || []).find(x => x.mediaId === mediaId || x.workflowId === mediaId);
      const effectiveUrl = directUrl || item?.videoUrl || null;
      const effectiveIdx = (typeof cardIndex === 'number' && cardIndex >= 0) ? cardIndex : (allVideos ? allVideos.findIndex(x => x.mediaId === mediaId) : -1);
      const filename = (promptSlug || mediaId.slice(0,8)).replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF _-]/g, "").trim().replace(/\s+/g, "_").slice(0, 50) + ".mp4";
      const res = await callExt("DOWNLOAD_VIDEO", { mediaId, filename, videoUrl: effectiveUrl, cardIndex: effectiveIdx });
      if (res?.success) {
        toast("✅ " + (res.message || "Video đang được tải về!"), "success");
      } else {
        toast("❌ " + (res?.error || "Lỗi tải video"), "error");
      }
    } catch (e) {
      toast("❌ " + e.message, "error");
    }
  };

  window.deleteVid = async function(workflowId, projectId, mediaId, promptSlug) {
    if (!confirm(`Bạn có chắc chắn muốn xoá video "${promptSlug || mediaId.slice(0,8)}" khỏi Google Flow không?`)) return;
    toast("🗑️ Đang xoá video khỏi Flow...", "info");
    try {
      const res = await callExt("DELETE_VIDEO", { workflowId, projectId, mediaId });
      if (res?.success) {
        toast("✅ Đã xoá video khỏi Flow!", "success");
        setTimeout(() => fetchVideos(true), 800);
      } else {
        toast("❌ " + (res?.error || "Lỗi xoá video"), "error");
      }
    } catch (e) {
      toast("❌ " + e.message, "error");
    }
  };

  function esc(s) { const d = document.createElement("div"); d.textContent = s||""; return d.innerHTML; }

  // ──────────────────────────
  // Auto-Polling
  // ──────────────────────────
  let pollTimer = null, cdTimer = null, cdVal = 10;

  window.togglePoll = function(on) {
    clearInterval(pollTimer); clearInterval(cdTimer);
    const span = document.getElementById("countdown");
    const cb = document.getElementById("autoPoll");
    if (cb) cb.checked = on;
    if (on) {
      cdVal = 10; span.textContent = "(10s)";
      cdTimer = setInterval(() => { cdVal--; if (cdVal<=0) cdVal=10; span.textContent=`(${cdVal}s)`; }, 1000);
      pollTimer = setInterval(() => fetchVideos(true), 10000);
    } else { span.textContent = "(tắt)"; }
  };

  // ──────────────────────────
  // Toast
  // ──────────────────────────
  function toast(msg, type="info") {
    const c = document.getElementById("toasts");
    const t = document.createElement("div");
    t.className = "toast " + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity="0"; setTimeout(()=>t.remove(),300); }, 3500);
  }

  // ──────────────────────────
  // Init
  // ──────────────────────────
  
  // Setup Event Listeners — run immediately since script is at end of body
  // ──────────────────────────
  // 6. Auto Click UI (Đơn Lẻ & Hàng Loạt)
  // ──────────────────────────
  let isUiBatchRunning = false;
  let isSubmitWorkerActive = false;
  let isDownloadWorkerActive = false;
  let uiBatchTasks = [];

  function getUiConfig() {
    const mode = document.getElementById("uiConfigMode")?.value || "prompt";
    const startImage = document.getElementById("uiStartImage")?.value?.trim() || "";
    const endImage = document.getElementById("uiEndImage")?.value?.trim() || "";
    return {
      mode: mode,
      isFrames: mode === "frames" || Boolean(startImage || endImage),
      startImage: startImage,
      endImage: endImage,
      aspectRatio: document.getElementById("uiConfigRatio")?.value || "9:16",
      duration: document.getElementById("uiConfigDuration")?.value || "8s",
      count: document.getElementById("uiConfigCount")?.value || "x1",
      model: document.getElementById("uiConfigModel")?.value || "veo_3_1_lite_low_priority"
    };
  }

  // Single UI Click
  async function submitSingleUi() {
    const prompt = document.getElementById("uiPromptInput")?.value?.trim();
    const config = getUiConfig();
    if (!prompt && !config.startImage) { toast("Nhập nội dung prompt hoặc chọn ảnh khung hình!", "error"); return; }

    const btn = document.getElementById("btnUiSubmitSingle");
    const resDiv = document.getElementById("uiSingleResult");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Đang kiểm tra thư viện & click tạo trên tab Flow..."; }
    if (resDiv) {
      resDiv.innerHTML = '<div style="color:var(--accent2); font-size:11px; padding:6px 0;">🔍 Đang snapshot thư viện & thực hiện click tạo trên tab Flow...</div>';
    }

    try {
      const projectId = document.getElementById("projectId")?.value || document.getElementById("projectId2")?.value || "";
      const res = await callExt("CREATE_VIDEO_UI", { prompt: prompt || "", projectId, config });
      if (res?.success) {
        toast(`✅ ${res.message || "Đã tạo video trên tab Flow!"}`, "success");
        if (res.newVideo && resDiv) {
          resDiv.innerHTML = `
            <div style="background:var(--bg); border:1px solid var(--accent); border-radius:8px; padding:10px 12px; font-size:12px; margin-top:8px;">
              <div style="font-weight:700; color:var(--accent2); margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
                <span>✨ Video Vừa Được Tạo:</span>
                <span class="v-tag pending" style="margin:0; font-size:10px;">⏳ ${esc(res.newVideo.status || "Đang xử lý")}</span>
              </div>
              <div style="color:var(--text); margin-bottom:4px; font-size:11px; line-height:1.4;"><b>Prompt:</b> ${esc(res.newVideo.prompt)}</div>
              <div style="color:var(--text2); font-size:10px; margin-bottom:8px; word-break:break-all;"><b>Media ID:</b> <code>${res.newVideo.mediaId}</code></div>
              <div style="display:flex; justify-content:flex-end;">
                <button class="btn btn-sm btn-green" id="btnGoToLibAfterCreate" style="font-size:10px; padding:4px 8px;">📚 Xem Ngay Trong Thư Viện</button>
              </div>
            </div>
          `;
          document.getElementById("btnGoToLibAfterCreate")?.addEventListener("click", () => {
            switchTab("library");
          });
        } else if (resDiv) {
          resDiv.innerHTML = `<div style="color:var(--green); font-size:11px; padding:6px 0;">✅ ${esc(res.message || "Đã gửi lệnh tạo video")}</div>`;
        }

        // Auto refresh library data
        if (typeof fetchVideos === "function") fetchVideos(true);

        const autoDownload = document.getElementById("uiSingleAutoDownload")?.checked !== false;
        if (autoDownload) {
          if (btn) btn.textContent = "⏳ Đang chờ video render trên Flow để tải 720p...";
          const statusDiv = document.createElement("div");
          statusDiv.id = "uiSingleDlStatus";
          statusDiv.style.cssText = "color:var(--accent2); font-size:11px; margin-top:8px; padding:6px 8px; background:rgba(0,229,255,0.08); border-radius:6px; border:1px solid rgba(0,229,255,0.2);";
          statusDiv.innerHTML = "⏳ Đang theo dõi tiến độ render của video trên Flow...";
          if (resDiv) resDiv.appendChild(statusDiv);

          toast("⏳ Đang chờ video render để tự động tải 720p gốc...", "info");
          try {
            const dlRes = await callExt("WAIT_AND_DOWNLOAD_CARD", {
              projectId,
              prompt: prompt || "",
              timeoutMs: 600000
            });
            if (dlRes?.success) {
              toast(`📥 Đã tải thành công video 720p!`, "success");
              statusDiv.style.borderColor = "rgba(0,214,143,0.4)";
              statusDiv.style.background = "rgba(0,214,143,0.08)";
              statusDiv.innerHTML = `🎉 <b>Đã tải video 720p gốc:</b> ${esc(dlRes.filename || 'flow_video.mp4')}<div style="font-size:10px; color:var(--text2); margin-top:2px;">Kiểm tra thư mục Downloads của máy tính.</div>`;
            } else {
              toast(`⚠️ Video đã tạo nhưng lỗi tải: ${dlRes?.error}`, "warning");
              statusDiv.style.borderColor = "rgba(255,212,59,0.4)";
              statusDiv.innerHTML = `⚠️ <b>Cảnh báo tải:</b> ${esc(dlRes?.error || 'timeout')}`;
            }
          } catch (dlErr) {
            statusDiv.innerHTML = `❌ <b>Lỗi tải:</b> ${esc(dlErr.message)}`;
          }
        }
      } else {
        toast(`❌ ${res?.error || "Không thể tương tác tab Flow"}`, "error");
        if (resDiv) resDiv.innerHTML = `<div style="color:var(--red); font-size:11px; padding:6px 0;">❌ ${esc(res?.error || "Lỗi tương tác")}</div>`;
      }
    } catch (e) {
      toast(`❌ Lỗi: ${e.message}`, "error");
      if (resDiv) resDiv.innerHTML = `<div style="color:var(--red); font-size:11px; padding:6px 0;">❌ ${esc(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🚀 Config & Click Tạo Trên Tab Flow"; }
    }
  }

  // ──────────────────────────
  // Helper tính Timestamp tự động cho Auto Click UI (Unix timestamp 10 số)
  // ──────────────────────────
  async function getNextSeqForUiTask(task, projectId) {
    let prompt = (task?.prompt || '').trim();
    let seqStr = "";

    // 1. Nếu prompt đã có Unix Timestamp (9-14 chữ số, ví dụ: "1725631530. ...")
    const matchTimestamp = prompt.match(/^(\d{9,14})[\.\-_:\s]/);
    if (matchTimestamp) {
      seqStr = matchTimestamp[1] + ".";
      prompt = prompt.replace(/^(\d{9,14})[\.\-_:\s]\s*/, `${seqStr} `);
      return { seqStr, prompt };
    }

    // 2. Xóa STT ngắn cũ nếu có (ví dụ: "001. ...", "024. ...") để thay bằng Unix Timestamp
    prompt = prompt.replace(/^\d{1,4}[\.\-_:\s]\s*/, '');

    // 3. Tự động sinh Unix Timestamp 10 số (đảm bảo không trùng với các task đang có trong hàng đợi)
    const nowSec = Math.floor(Date.now() / 1000);
    let targetSec = nowSec;
    const existingSeqs = new Set(uiBatchTasks.map(t => (t.seq || '').replace(/[^0-9]/g, '')).filter(Boolean));
    while (existingSeqs.has(String(targetSec))) {
      targetSec++;
    }
    seqStr = `${targetSec}.`;
    prompt = `${seqStr} ${prompt}`;
    return { seqStr, prompt };
  }

  // Thêm task từ tool_video server vào thẳng danh sách Auto Click UI
  async function addServerTaskToUiBatch(task) {
    if (!task) return { success: false, error: "Task rỗng" };
    const projectId = task.projectId || document.getElementById("projectId")?.value || document.getElementById("projectId2")?.value || "";
    const { seqStr, prompt } = await getNextSeqForUiTask(task, projectId);

    const newTask = {
      id: uiBatchTasks.length + 1,
      serverTaskId: task.id,
      projectId: projectId,
      seq: seqStr,
      prompt: prompt,
      startImage: task.startImage || "",
      endImage: task.endImage || "",
      isFrames: Boolean(task.startImage || task.endImage),
      aspectRatio: task.aspectRatio || "9:16",
      duration: task.duration || "8s",
      model: task.model || "veo_3_1_lite_low_priority",
      count: "x1",
      status: "PENDING",
      downloadStatus: "Chờ submit...",
      error: null
    };

    uiBatchTasks.push(newTask);
    renderUiBatchUI();

    // Tự động chuyển qua tab Auto Click UI để người dùng theo dõi
    if (typeof window.switchTab === "function") {
      window.switchTab("click-ui");
    }

    toast(`📥 [tool_video] Đã thêm task ${seqStr} vào Auto Click UI!`, "info");

    // Kích hoạt ngay các worker xử lý hàng đợi
    triggerUiBatchProcessing();

    return { success: true, taskId: newTask.id, seq: seqStr };
  }

  // Batch UI Click Queue (2 Luồng Song Song: Submit riêng - Tải kết quả riêng)
  async function startUiBatchQueue() {
    const raw = document.getElementById("uiBatchPromptInput")?.value || "";
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length && !uiBatchTasks.some(t => t.status === "PENDING")) {
      toast("Nhập ít nhất 1 prompt hoặc có task chờ!", "error");
      return;
    }

    const projectId = document.getElementById("projectId")?.value || document.getElementById("projectId2")?.value || "";

    if (lines.length > 0) {
      const baseId = uiBatchTasks.length;
      const baseTimestamp = Math.floor(Date.now() / 1000);
      let nextTimestamp = baseTimestamp;
      const existingSeqs = new Set(uiBatchTasks.map(t => (t.seq || '').replace(/[^0-9]/g, '')).filter(Boolean));

      const newTasks = lines.map((line, i) => {
        let prompt = line;
        let startImage = "";
        let endImage = "";
        let isFrames = false;

        if (line.includes("|")) {
          const parts = line.split("|").map(p => p.trim());
          if (parts.length === 2) {
            startImage = parts[0];
            prompt = parts[1];
            isFrames = true;
          } else if (parts.length >= 3) {
            startImage = parts[0];
            endImage = parts[1];
            prompt = parts.slice(2).join(" | ");
            isFrames = true;
          }
        }

        // TỰ ĐỘNG ĐÁNH UNIX TIMESTAMP 10 SỐ (KHÔNG TRÙNG LẶP)
        let seqStr = "";
        const matchTimestamp = prompt.match(/^(\d{9,14})[\.\-_:\s]/);
        if (matchTimestamp) {
          seqStr = matchTimestamp[1] + ".";
          prompt = prompt.replace(/^(\d{9,14})[\.\-_:\s]\s*/, `${seqStr} `);
        } else {
          prompt = prompt.replace(/^\d{1,4}[\.\-_:\s]\s*/, '');
          while (existingSeqs.has(String(nextTimestamp))) {
            nextTimestamp++;
          }
          seqStr = `${nextTimestamp}.`;
          existingSeqs.add(String(nextTimestamp));
          prompt = `${seqStr} ${prompt}`;
          nextTimestamp++;
        }

        return {
          id: baseId + i + 1,
          seq: seqStr,
          prompt: prompt,
          startImage: startImage,
          endImage: endImage,
          isFrames: isFrames,
          status: "PENDING",
          downloadStatus: "Chờ submit...",
          error: null
        };
      });

      uiBatchTasks = [...uiBatchTasks, ...newTasks];

      const inputEl = document.getElementById("uiBatchPromptInput");
      if (inputEl) inputEl.value = "";
    }

    triggerUiBatchProcessing();
  }

  function stopUiBatchQueue() {
    isUiBatchRunning = false;
    const startBtn = document.getElementById("btnUiStartBatch");
    const stopBtn = document.getElementById("btnUiStopBatch");
    if (startBtn) startBtn.style.display = "inline-flex";
    if (stopBtn) stopBtn.style.display = "none";
    toast("🛑 Đã dừng Auto Click hàng loạt.", "info");
    renderUiBatchUI();
  }

  function checkUiBatchCompletion() {
    if (!isSubmitWorkerActive && !isDownloadWorkerActive) {
      const stillActive = uiBatchTasks.some(t => t.status === "PENDING" || t.status === "SUBMITTING" || t.status === "SUBMITTED" || t.status === "RENDERING" || t.status === "DOWNLOADING");
      if (!stillActive && isUiBatchRunning) {
        isUiBatchRunning = false;
        const startBtn = document.getElementById("btnUiStartBatch");
        const stopBtn = document.getElementById("btnUiStopBatch");
        if (startBtn) startBtn.style.display = "inline-flex";
        if (stopBtn) stopBtn.style.display = "none";
        renderUiBatchUI();
        toast("🎉 Đã hoàn thành tất cả các task Auto Click & Tải video!", "success");
      }
    }
  }

  function triggerUiBatchProcessing() {
    isUiBatchRunning = true;
    const startBtn = document.getElementById("btnUiStartBatch");
    const stopBtn = document.getElementById("btnUiStopBatch");
    if (startBtn) startBtn.style.display = "none";
    if (stopBtn) stopBtn.style.display = "inline-flex";

    const delayMs = parseInt(document.getElementById("uiClickDelay")?.value || "5000", 10);
    const config = getUiConfig();
    const projectId = document.getElementById("projectId")?.value || document.getElementById("projectId2")?.value || "";
    const autoDownload = document.getElementById("uiBatchAutoDownload")?.checked !== false;

    renderUiBatchUI();

    if (!isSubmitWorkerActive) {
      runUiSubmitWorker(projectId, config, delayMs);
    }
    if (!isDownloadWorkerActive && autoDownload) {
      runUiDownloadWorker(projectId);
    }
  }

  async function runUiSubmitWorker(projectId, config, delayMs) {
    if (isSubmitWorkerActive) return;
    isSubmitWorkerActive = true;

    try {
      while (isUiBatchRunning) {
        const task = uiBatchTasks.find(t => t.status === "PENDING");
        if (!task) break;

        task.status = "SUBMITTING";
        task.downloadStatus = "Đang gõ & submit...";
        renderUiBatchUI();

        try {
          const taskConfig = {
            ...config,
            ...(task.aspectRatio ? { aspectRatio: task.aspectRatio } : {}),
            ...(task.duration ? { duration: task.duration } : {}),
            ...(task.model ? { model: task.model } : {}),
            isFrames: task.isFrames || config.isFrames,
            startImage: task.startImage || config.startImage,
            endImage: task.endImage || config.endImage
          };

          // Chờ UI Lock để không xung đột thao tác chuột với luồng tải
          await acquireUiLock();
          let res = null;
          try {
            res = await callExt("CREATE_VIDEO_UI", { prompt: task.prompt, projectId: task.projectId || projectId, config: taskConfig });
          } finally {
            releaseUiLock();
          }

          if (res?.success) {
            task.mediaId = res.newVideo?.mediaId || null;
            task.workflowId = res.newVideo?.workflowId || null;
            task.submittedAt = Date.now();
            task.status = "SUBMITTED";
            task.downloadStatus = "Đã gửi Flow! Đang chờ render...";
            toast(`✅ [#${task.id}] Đã submit: ${task.seq}`, "success");
            if (typeof fetchVideos === "function") fetchVideos(true);
          } else {
            task.status = "ERROR";
            task.error = res?.error || "Lỗi tương tác UI";
            task.downloadStatus = `Lỗi submit: ${task.error}`;
            toast(`❌ [#${task.id}] ${task.error}`, "error");

            if (task.serverTaskId) {
              callExt("REPORT_TOOL_VIDEO_RESULT", {
                id: task.serverTaskId,
                ok: false,
                error: task.error
              }).catch(() => {});
            }
          }
        } catch (err) {
          task.status = "ERROR";
          task.error = err.message;
          task.downloadStatus = `Lỗi: ${err.message}`;

          if (task.serverTaskId) {
            callExt("REPORT_TOOL_VIDEO_RESULT", {
              id: task.serverTaskId,
              ok: false,
              error: err.message
            }).catch(() => {});
          }
        }

        renderUiBatchUI();

        // Delay giữa các lần submit (chống throttle Flow)
        if (isUiBatchRunning && uiBatchTasks.some(t => t.status === "PENDING")) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    } finally {
      isSubmitWorkerActive = false;
      checkUiBatchCompletion();
    }
  }

  async function runUiDownloadWorker(projectId) {
    if (isDownloadWorkerActive) return;
    isDownloadWorkerActive = true;

    try {
      while (isUiBatchRunning) {
        const activeTasks = uiBatchTasks.filter(t => t.status === "SUBMITTED" || t.status === "RENDERING");
        const hasUnsubmitted = uiBatchTasks.some(t => t.status === "PENDING" || t.status === "SUBMITTING");

        if (!activeTasks.length) {
          if (!hasUnsubmitted) {
            // Tất cả các task đã hoàn thành hoặc thất bại
            break;
          }
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        for (const task of activeTasks) {
          if (!isUiBatchRunning) break;

          try {
            const statusRes = await callExt("CHECK_CARD_STATUS", {
              projectId: task.projectId || projectId,
              query: task.seq || task.prompt,
              prompt: task.prompt,
              seq: task.seq,
              mediaId: task.mediaId,
              workflowId: task.workflowId,
              mediaType: 'video'
            });

            if (statusRes?.status === 'RENDERING') {
              if (statusRes.mediaId && (!task.mediaId || task.mediaId !== statusRes.mediaId)) {
                console.log(`[Ui Worker] Cập nhật real mediaId cho task #${task.id} (${task.seq}): ${statusRes.mediaId}`);
                task.mediaId = statusRes.mediaId;
              }
              const curProg = statusRes.progress || '';
              if (task.lastProgress !== curProg) {
                task.lastProgress = curProg;
                task.lastProgressAt = Date.now();
              }
              task.missingCount = 0;
              task.status = "RENDERING";
              task.downloadStatus = `Đang render (${curProg || '...'})`;
              renderUiBatchUI();

              // Timeout kẹt % render quá 75 giây
              if (task.lastProgressAt && (Date.now() - task.lastProgressAt > 75000)) {
                console.warn(`[Ui Worker] Task #${task.id} bị kẹt ở tiến độ "${curProg}" quá 75s`);
                task.status = "ERROR";
                task.error = `Kẹt tiến độ render (${curProg || 'đứng im'}) quá 75s - Thất bại`;
                task.downloadStatus = task.error;
                toast(`⚠️ [#${task.id}] Render đứng im ở ${curProg} quá 75s (${task.seq || ''})`, "warning");

                if (task.serverTaskId) {
                  callExt("REPORT_TOOL_VIDEO_RESULT", {
                    id: task.serverTaskId,
                    ok: false,
                    error: task.error
                  }).catch(() => {});
                }
                renderUiBatchUI();
                continue;
              }
            } else if (statusRes?.status === 'READY') {
              if (statusRes.mediaId && (!task.mediaId || task.mediaId !== statusRes.mediaId)) {
                task.mediaId = statusRes.mediaId;
              }
              const elapsed = Date.now() - (task.submittedAt || 0);
              if (elapsed < 15000) {
                task.status = "RENDERING";
                task.downloadStatus = "Khởi tạo render...";
                renderUiBatchUI();
                continue;
              }
              task.status = "DOWNLOADING";
              task.downloadStatus = "Render xong! Đang tải 720p...";
              renderUiBatchUI();

              toast(`🎯 [#${task.id}] Card ${task.seq} render xong! Đang tải 720p...`, "info");

              await acquireUiLock();
              let dlRes = null;
              try {
                dlRes = await callExt("DOWNLOAD_CARD_NATIVE", {
                  query: task.seq || task.prompt,
                  prompt: task.prompt,
                  seq: task.seq,
                  mediaId: task.mediaId,
                  workflowId: task.workflowId,
                  mediaType: 'video',
                  projectId: task.projectId || projectId
                });
                if (!dlRes?.success) {
                  console.warn(`[Ui Worker] Thử lại tải 720p lần 2 cho task #${task.id}...`);
                  await new Promise(r => setTimeout(r, 1200));
                  dlRes = await callExt("DOWNLOAD_CARD_NATIVE", {
                    query: task.seq || task.prompt,
                    prompt: task.prompt,
                    seq: task.seq,
                    mediaId: task.mediaId,
                    workflowId: task.workflowId,
                    mediaType: 'video',
                    projectId: task.projectId || projectId
                  });
                }
              } finally {
                releaseUiLock();
                callExt("SCROLL_FLOW_TO_TOP", { projectId: task.projectId || projectId }).catch(() => {});
              }

              if (dlRes?.isStillRendering) {
                console.log(`[Ui Worker] Task #${task.id} vẫn đang render trên Flow (menu chỉ có nút Xoá), tiếp tục chờ...`);
                task.status = "RENDERING";
                task.downloadStatus = "Đang kết xuất video (chờ nút Tải xuống)...";
                task.lastProgressAt = Date.now();
                renderUiBatchUI();
                continue;
              }

              if (dlRes?.success) {
                task.status = "SUCCESS";
                task.downloadStatus = `Đã tải 720p (${dlRes.filename || 'OK'})`;
                toast(`📥 [#${task.id}] Đã tải xong video 720p (${task.seq})!`, "success");

                // BÁO CHO TOOL_VIDEO (veo3-api-server)
                if (task.serverTaskId) {
                  const resolvedPath = dlRes.filePath || dlRes.filename || dlRes.downloadItem?.filename;
                  console.log(`[Ui Worker] Báo VIDEO_RESULT về server cho task ${task.serverTaskId}: filePath=${resolvedPath}`);
                  callExt("REPORT_TOOL_VIDEO_RESULT", {
                    id: task.serverTaskId,
                    ok: true,
                    filePath: resolvedPath,
                    mediaId: task.mediaId
                  }).catch(e => console.error("Lỗi gửi REPORT_TOOL_VIDEO_RESULT:", e));
                }
              } else {
                task.status = "WARNING";
                task.downloadStatus = `Lỗi tải: ${dlRes?.error || 'timeout'}`;
                toast(`⚠️ [#${task.id}] Video tạo xong nhưng lỗi tải: ${dlRes?.error}`, "warning");

                if (task.serverTaskId) {
                  callExt("REPORT_TOOL_VIDEO_RESULT", {
                    id: task.serverTaskId,
                    ok: false,
                    error: dlRes?.error || 'Lỗi tải video'
                  }).catch(() => {});
                }
              }
              renderUiBatchUI();
            } else if (statusRes?.status === 'FAILED') {
              task.status = "ERROR";
              task.error = statusRes.error || "Render thất bại trên Flow";
              task.downloadStatus = statusRes.error || "Render thất bại trên Flow";
              toast(`❌ [#${task.id}] ${task.error} (${task.seq || ''})`, "error");

              if (task.serverTaskId) {
                callExt("REPORT_TOOL_VIDEO_RESULT", {
                  id: task.serverTaskId,
                  ok: false,
                  error: task.error
                }).catch(() => {});
              }
              renderUiBatchUI();
            } else if (task.status === "RENDERING") {
              // Thẻ đã từng rendering nhưng hiện tại không tìm thấy (Flow xoá hoặc chuyển sang lỗi)
              task.missingCount = (task.missingCount || 0) + 1;
              if (task.missingCount >= 4) {
                task.status = "ERROR";
                task.error = "Vi phạm chính sách / Thẻ render không thành công trên Flow";
                task.downloadStatus = task.error;
                toast(`❌ [#${task.id}] ${task.error} (${task.seq || ''})`, "error");

                if (task.serverTaskId) {
                  callExt("REPORT_TOOL_VIDEO_RESULT", {
                    id: task.serverTaskId,
                    ok: false,
                    error: task.error
                  }).catch(() => {});
                }
                renderUiBatchUI();
                continue;
              }
            }

            // Global Render Timeout: Quá 4 phút kể từ khi submit
            const totalElapsed = Date.now() - (task.submittedAt || Date.now());
            if (totalElapsed > 240000 && (task.status === "RENDERING" || task.status === "SUBMITTED")) {
              task.status = "ERROR";
              task.error = "Quá thời gian render (> 4 phút)";
              task.downloadStatus = task.error;
              toast(`⏱️ [#${task.id}] Hết thời gian chờ render (> 4 phút) (${task.seq || ''})`, "error");

              if (task.serverTaskId) {
                callExt("REPORT_TOOL_VIDEO_RESULT", {
                  id: task.serverTaskId,
                  ok: false,
                  error: task.error
                }).catch(() => {});
              }
              renderUiBatchUI();
              continue;
            }
          } catch (e) {
            console.warn(`[Download Worker] Lỗi kiểm tra task ${task.id}:`, e);
          }
        }

        await new Promise(r => setTimeout(r, 3000));
      }
    } finally {
      isDownloadWorkerActive = false;
      checkUiBatchCompletion();
    }
  }

  async function processUiBatchQueue() {
    triggerUiBatchProcessing();
  }

  function renderUiBatchUI() {
    const total = uiBatchTasks.length;
    const pending = uiBatchTasks.filter(t => t.status === "PENDING").length;
    const running = uiBatchTasks.filter(t => t.status === "SUBMITTING" || t.status === "SUBMITTED" || t.status === "RENDERING" || t.status === "DOWNLOADING").length;
    const success = uiBatchTasks.filter(t => t.status === "SUCCESS").length;
    const warning = uiBatchTasks.filter(t => t.status === "WARNING").length;
    const error = uiBatchTasks.filter(t => t.status === "ERROR").length;
    const doneCount = success + warning + error;

    if (document.getElementById("uiStatTotal")) document.getElementById("uiStatTotal").textContent = total;
    if (document.getElementById("uiStatPending")) document.getElementById("uiStatPending").textContent = pending;
    if (document.getElementById("uiStatRunning")) document.getElementById("uiStatRunning").textContent = running;
    if (document.getElementById("uiStatSuccess")) document.getElementById("uiStatSuccess").textContent = success;
    if (document.getElementById("uiStatError")) document.getElementById("uiStatError").textContent = error;

    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    if (document.getElementById("uiQueueProgressFill")) document.getElementById("uiQueueProgressFill").style.width = pct + "%";

    const listEl = document.getElementById("uiBatchQueueList");
    if (!listEl) return;
    if (!total) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--text2);font-size:12px;padding:16px;">Chưa có prompt nào trong hàng đợi Auto Click.</div>';
      return;
    }

    listEl.innerHTML = uiBatchTasks.map(t => {
      let statusBadge = '<span style="color:var(--text2);font-size:11px;">⏳ Chờ submit...</span>';
      let itemClass = "";
      if (t.status === "SUBMITTING") {
        itemClass = "running";
        statusBadge = '<span class="worker-tag" style="background:rgba(255, 153, 0, 0.2); color:#ff9800; border:1px solid rgba(255, 153, 0, 0.4);">⚡ Đang gõ & submit...</span>';
      } else if (t.status === "SUBMITTED") {
        itemClass = "running";
        statusBadge = '<span class="worker-tag" style="background:rgba(108, 92, 231, 0.2); color:var(--accent2); border:1px solid rgba(108, 92, 231, 0.4);">⏳ Đã gửi (Chờ render...)</span>';
      } else if (t.status === "RENDERING") {
        itemClass = "running";
        statusBadge = `<span class="worker-tag" style="background:rgba(0, 229, 255, 0.2); color:var(--accent2); border:1px solid rgba(0, 229, 255, 0.4);">⏳ ${esc(t.downloadStatus || 'Đang render...')}</span>`;
      } else if (t.status === "DOWNLOADING") {
        itemClass = "running";
        statusBadge = '<span class="worker-tag" style="background:rgba(255, 0, 127, 0.2); color:#ff007f; border:1px solid rgba(255, 0, 127, 0.4);">📥 Đang tải 720p...</span>';
      } else if (t.status === "SUCCESS") {
        itemClass = "success";
        const successLabel = t.downloadStatus ? `✅ ${esc(t.downloadStatus)}` : '✅ Đã Hoàn Thành';
        statusBadge = `<span style="color:var(--green);font-size:11px;font-weight:700;">${successLabel}</span>`;
      } else if (t.status === "WARNING") {
        itemClass = "error";
        statusBadge = `<span style="color:var(--yellow);font-size:11px;" title="${esc(t.downloadStatus || t.error)}">⚠️ ${esc(t.downloadStatus?.slice(0, 50) || 'Cảnh báo tải')}</span>`;
      } else if (t.status === "ERROR") {
        itemClass = "error";
        statusBadge = `<span style="color:var(--red);font-size:11px;font-weight:600;" title="${esc(t.error)}">❌ ${esc(t.error?.slice(0, 50) || 'Lỗi')}</span>`;
      }

      const mediaInfo = t.mediaId ? `<div style="font-size:10px; color:var(--accent2); margin-top:2px;">🆔 <code>${esc(t.mediaId.slice(0, 16))}...</code></div>` : '';
      const frameInfo = t.startImage ? `<div style="font-size:10px; color:var(--green); margin-top:2px;">🖼️ Khung: <code>${esc(t.startImage)}</code>${t.endImage ? ' ➔ <code>' + esc(t.endImage) + '</code>' : ''}</div>` : '';
      return `<div class="queue-item ${itemClass}">
        <div style="flex:1; overflow:hidden;">
          <div style="font-size:12px; font-weight:600; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">#${t.id}. ${esc(t.prompt)}</div>
          ${frameInfo}
          ${mediaInfo}
        </div>
        <div style="white-space:nowrap;">
          ${statusBadge}
        </div>
      </div>`;
    }).join("");
  }

  // ──────────────────────────
  // Auto Click UI CHO ẢNH (Image Auto Click)
  // ──────────────────────────
  let isUiImgBatchRunning = false;
  let uiImgBatchTasks = [];

  function getUiImageConfig() {
    return {
      aspectRatio: document.getElementById("uiImgConfigRatio")?.value || "9:16",
      model: document.getElementById("uiImgConfigModel")?.value || "banana_pro",
      count: document.getElementById("uiImgConfigCount")?.value || "x1"
    };
  }

  // Single Image UI Click
  async function submitSingleImageUi() {
    const prompt = document.getElementById("uiImgPromptInput")?.value?.trim();
    const config = getUiImageConfig();
    if (!prompt) { toast("Nhập nội dung prompt tạo ảnh!", "error"); return; }

    const btn = document.getElementById("btnUiSubmitSingleImage");
    const resDiv = document.getElementById("uiSingleImageResult");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Đang cấu hình & click tạo ảnh trên Flow..."; }
    if (resDiv) {
      resDiv.innerHTML = '<div style="color:var(--accent2); font-size:11px; padding:6px 0;">🔍 Đang gửi lệnh cấu hình và click tạo ảnh trên tab Flow...</div>';
    }

    try {
      const projectId = document.getElementById("projectId")?.value || document.getElementById("imageProjectId")?.value || "";
      const res = await callExt("CREATE_IMAGE_UI", { prompt, projectId, config });
      if (res?.success) {
        toast(`✅ ${res.message || "Đã tạo ảnh trên tab Flow!"}`, "success");
        if (resDiv) {
          resDiv.innerHTML = `<div style="color:var(--green); font-size:11px; background:rgba(0,214,143,0.08); border-radius:6px; padding:8px 10px; border:1px solid rgba(0,214,143,0.2);">✅ ${esc(res.message || "Đã gửi lệnh tạo ảnh thành công")}</div>`;
        }
        if (typeof fetchVideos === "function") fetchVideos(true);
      } else {
        toast(`❌ ${res?.error || "Lỗi tương tác tab Flow"}`, "error");
        if (resDiv) resDiv.innerHTML = `<div style="color:var(--red); font-size:11px; padding:6px 0;">❌ ${esc(res?.error || "Lỗi tương tác")}</div>`;
      }
    } catch (e) {
      toast(`❌ Lỗi: ${e.message}`, "error");
      if (resDiv) resDiv.innerHTML = `<div style="color:var(--red); font-size:11px; padding:6px 0;">❌ ${esc(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🚀 Config & Click Tạo Ảnh Trên Tab Flow"; }
    }
  }

  // Batch Image UI Click Queue (Auto Click Ảnh Hàng Loạt)
  async function startUiImageBatchQueue() {
    if (isUiImgBatchRunning) return;
    const raw = document.getElementById("uiBatchImgPromptInput")?.value || "";
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) { toast("Nhập ít nhất 1 prompt tạo ảnh!", "error"); return; }

    const projectId = document.getElementById("projectId")?.value || document.getElementById("imageProjectId")?.value || "";
    const autoSeq = document.getElementById("uiImgAutoSeq")?.checked ?? true;
    const autoDownload = document.getElementById("uiImgAutoDownload")?.checked ?? true;

    // TỰ ĐỘNG ĐÁNH UNIX TIMESTAMP 10 SỐ ĐẦU PROMPT (KHÔNG TRÙNG LẶP)
    const baseTimestamp = Math.floor(Date.now() / 1000);
    let nextTimestamp = baseTimestamp;
    const existingSeqs = new Set(uiImgBatchTasks.map(t => (t.seq || '').replace(/[^0-9]/g, '')).filter(Boolean));

    uiImgBatchTasks = lines.map((line, i) => {
      let prompt = line;
      let seqStr = "";

      if (autoSeq) {
        const matchTimestamp = prompt.match(/^(\d{9,14})[\.\-_:\s]/);
        if (matchTimestamp) {
          seqStr = matchTimestamp[1] + ".";
          prompt = prompt.replace(/^(\d{9,14})[\.\-_:\s]\s*/, `${seqStr} `);
        } else {
          prompt = prompt.replace(/^\d{1,4}[\.\-_:\s]\s*/, '');
          while (existingSeqs.has(String(nextTimestamp))) {
            nextTimestamp++;
          }
          seqStr = `${nextTimestamp}.`;
          existingSeqs.add(String(nextTimestamp));
          prompt = `${seqStr} ${prompt}`;
          nextTimestamp++;
        }
      } else {
        const matchSeq = prompt.match(/^(\d+[\.\-_:\s])/);
        if (matchSeq) seqStr = matchSeq[1].trim();
      }

      return {
        id: i + 1,
        seq: seqStr,
        prompt: prompt,
        status: "PENDING",
        downloadStatus: autoDownload ? "Chờ submit..." : "Chờ tạo...",
        submittedAt: null,
        error: null
      };
    });

    if (autoSeq) {
      callExt("UPDATE_MAX_SEQ", { projectId, newMax: startSeq + lines.length - 1 }).catch(() => {});
    }

    isUiImgBatchRunning = true;
    const startBtn = document.getElementById("btnUiStartBatchImage");
    const stopBtn = document.getElementById("btnUiStopBatchImage");
    if (startBtn) startBtn.style.display = "none";
    if (stopBtn) stopBtn.style.display = "inline-flex";

    renderUiImageBatchUI();
    toast(`🚀 Bắt đầu Auto Click Ảnh (${uiImgBatchTasks.length} ảnh) ${autoDownload ? 'kèm Tự động tải về' : ''}!`, "info");

    // 1. Chạy Luồng Submit tuần tự
    processUiImageBatchQueue(projectId, autoDownload);

    // 2. Chạy Luồng Download Worker ngầm song song (nếu bật Tự động tải)
    if (autoDownload) {
      runUiImageDownloadWorker(projectId);
    }
  }

  function stopUiImageBatchQueue() {
    isUiImgBatchRunning = false;
    const startBtn = document.getElementById("btnUiStartBatchImage");
    const stopBtn = document.getElementById("btnUiStopBatchImage");
    if (startBtn) startBtn.style.display = "inline-flex";
    if (stopBtn) stopBtn.style.display = "none";
    toast("🛑 Đã dừng Auto Click Ảnh hàng loạt.", "info");
    renderUiImageBatchUI();
  }

  async function processUiImageBatchQueue(projectId, autoDownload = true) {
    const delayMs = parseInt(document.getElementById("uiImgClickDelay")?.value || "5000", 10);
    const config = getUiImageConfig();

    for (let i = 0; i < uiImgBatchTasks.length; i++) {
      if (!isUiImgBatchRunning) break;
      const task = uiImgBatchTasks[i];
      if (task.status !== "PENDING") continue;

      task.status = "RUNNING";
      task.downloadStatus = "Đang điền prompt & submit...";
      renderUiImageBatchUI();

      try {
        const res = await callExt("CREATE_IMAGE_UI", { prompt: task.prompt, projectId, config });
        if (res?.success) {
          task.submittedAt = Date.now();
          if (autoDownload) {
            task.status = "SUBMITTED";
            task.downloadStatus = "Đã gửi Flow! Đang chờ tạo ảnh...";
            toast(`✅ [#${task.id}] Đã submit ảnh ${task.seq || ''}! Đang chờ tạo...`, "success");
          } else {
            task.status = "SUCCESS";
            task.downloadStatus = "Hoàn thành (Không tải)";
            toast(`✅ [#${task.id}] Đã click tạo ảnh: ${task.prompt.slice(0, 30)}...`, "success");
          }
        } else {
          task.status = "ERROR";
          task.error = res?.error || "Lỗi tạo ảnh";
          task.downloadStatus = `Lỗi submit: ${task.error}`;
          toast(`❌ [#${task.id}] ${task.error}`, "error");
        }
      } catch (err) {
        task.status = "ERROR";
        task.error = err.message;
        task.downloadStatus = `Lỗi: ${err.message}`;
      }

      renderUiImageBatchUI();

      // Delay giữa các lần click
      if (i < uiImgBatchTasks.length - 1 && isUiImgBatchRunning) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    if (!autoDownload) {
      isUiImgBatchRunning = false;
      const startBtn = document.getElementById("btnUiStartBatchImage");
      const stopBtn = document.getElementById("btnUiStopBatchImage");
      if (startBtn) startBtn.style.display = "inline-flex";
      if (stopBtn) stopBtn.style.display = "none";
      renderUiImageBatchUI();
      toast("🎉 Hoàn tất Auto Click Ảnh hàng loạt!", "success");
      if (typeof fetchVideos === "function") fetchVideos(true);
    }
  }

  async function runUiImageDownloadWorker(projectId) {
    while (isUiImgBatchRunning) {
      const activeTasks = uiImgBatchTasks.filter(t => t.status === "SUBMITTED" || t.status === "RENDERING");
      const hasUnsubmitted = uiImgBatchTasks.some(t => t.status === "PENDING" || t.status === "RUNNING");

      if (!activeTasks.length) {
        if (!hasUnsubmitted) {
          // Tất cả các task đã hoàn thành hoặc thất bại
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      for (const task of activeTasks) {
        if (!isUiImgBatchRunning) break;

        try {
          const statusRes = await callExt("CHECK_CARD_STATUS", {
            projectId,
            query: task.seq || task.prompt,
            prompt: task.prompt,
            seq: task.seq,
            mediaType: 'image'
          });

          if (statusRes?.status === 'RENDERING') {
            const curProg = statusRes.progress || '';
            task.status = "RENDERING";
            task.downloadStatus = `Đang render (${curProg || '...'})`;
            renderUiImageBatchUI();
          } else if (statusRes?.status === 'READY') {
            task.status = "DOWNLOADING";
            task.downloadStatus = "Tạo xong! Đang tải ảnh về máy...";
            renderUiImageBatchUI();
            toast(`🎯 [#${task.id}] Ảnh ${task.seq || ''} tạo xong! Đang tải về...`, "info");

            await acquireUiLock();
            let dlRes = null;
            try {
              dlRes = await callExt("DOWNLOAD_IMAGE_CARD", {
                projectId,
                query: task.seq || task.prompt,
                prompt: task.prompt,
                seq: task.seq,
                imgSrc: statusRes?.imgSrc || null
              });
            } finally {
              releaseUiLock();
              callExt("SCROLL_FLOW_TO_TOP", { projectId }).catch(() => {});
            }

            if (dlRes?.success) {
              task.status = "SUCCESS";
              task.downloadStatus = `Đã tải (${dlRes.filename || 'OK'})`;
              toast(`📥 [#${task.id}] Đã tải xong ảnh (${task.seq || ''})!`, "success");
            } else {
              task.status = "WARNING";
              task.downloadStatus = `Lỗi tải: ${dlRes?.error || 'timeout'}`;
              toast(`⚠️ [#${task.id}] Ảnh tạo xong nhưng lỗi tải: ${dlRes?.error}`, "warning");
            }
            renderUiImageBatchUI();
          } else if (statusRes?.status === 'FAILED') {
            task.status = "ERROR";
            task.error = statusRes.error || "Tạo ảnh thất bại trên Flow";
            task.downloadStatus = statusRes.error || "Tạo ảnh thất bại trên Flow";
            toast(`❌ [#${task.id}] ${task.error} (${task.seq || ''})`, "error");
            renderUiImageBatchUI();
          }
        } catch (e) {
          console.warn(`[Image Download Worker] Error checking task #${task.id}:`, e);
        }

        await new Promise(r => setTimeout(r, 1200));
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    if (!uiImgBatchTasks.some(t => t.status === "PENDING" || t.status === "RUNNING" || t.status === "SUBMITTED" || t.status === "RENDERING")) {
      isUiImgBatchRunning = false;
      const startBtn = document.getElementById("btnUiStartBatchImage");
      const stopBtn = document.getElementById("btnUiStopBatchImage");
      if (startBtn) startBtn.style.display = "inline-flex";
      if (stopBtn) stopBtn.style.display = "none";
      renderUiImageBatchUI();
      toast("🎉 Hoàn tất Auto Click và Tải Ảnh hàng loạt!", "success");
      if (typeof fetchVideos === "function") fetchVideos(true);
    }
  }

  function renderUiImageBatchUI() {
    const total = uiImgBatchTasks.length;
    const pending = uiImgBatchTasks.filter(t => t.status === "PENDING").length;
    const running = uiImgBatchTasks.filter(t => t.status === "RUNNING" || t.status === "SUBMITTED" || t.status === "RENDERING" || t.status === "DOWNLOADING").length;
    const success = uiImgBatchTasks.filter(t => t.status === "SUCCESS").length;
    const error = uiImgBatchTasks.filter(t => t.status === "ERROR" || t.status === "WARNING").length;

    const elTotal = document.getElementById("uiImgStatTotal");
    const elPending = document.getElementById("uiImgStatPending");
    const elRunning = document.getElementById("uiImgStatRunning");
    const elSuccess = document.getElementById("uiImgStatSuccess");
    const elError = document.getElementById("uiImgStatError");
    const elFill = document.getElementById("uiImgQueueProgressFill");

    if (elTotal) elTotal.textContent = total;
    if (elPending) elPending.textContent = pending;
    if (elRunning) elRunning.textContent = running;
    if (elSuccess) elSuccess.textContent = success;
    if (elError) elError.textContent = error;

    const doneCount = success + error;
    const pct = total ? Math.round((doneCount / total) * 100) : 0;
    if (elFill) elFill.style.width = pct + "%";

    const listDiv = document.getElementById("uiBatchImgQueueList");
    if (!listDiv) return;

    listDiv.innerHTML = uiImgBatchTasks.map(t => {
      let badgeClass = "badge-muted";
      let badgeText = "⏳ Chờ...";
      if (t.status === "RUNNING") {
        badgeClass = "badge-primary";
        badgeText = "⚡ Đang submit...";
      } else if (t.status === "SUBMITTED" || t.status === "RENDERING") {
        badgeClass = "badge-primary";
        badgeText = `⏳ ${esc(t.downloadStatus || 'Đang tạo ảnh...')}`;
      } else if (t.status === "DOWNLOADING") {
        badgeClass = "badge-primary";
        badgeText = "📥 Đang tải ảnh...";
      } else if (t.status === "SUCCESS") {
        badgeClass = "badge-success";
        badgeText = t.downloadStatus?.includes("Đã tải") ? `✅ ${esc(t.downloadStatus)}` : "✅ Hoàn thành";
      } else if (t.status === "WARNING") {
        badgeClass = "badge-warning";
        badgeText = `⚠️ ${esc(t.downloadStatus || 'Cảnh báo tải')}`;
      } else if (t.status === "ERROR") {
        badgeClass = "badge-danger";
        badgeText = "❌ Lỗi";
      }

      return `
        <div style="background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px 10px; margin-bottom:6px; font-size:11px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
            <span style="font-weight:700; color:var(--text);">${t.seq ? `<b style="color:var(--accent2);">${esc(t.seq)}</b> ` : ''}#${t.id}</span>
            <span class="badge ${badgeClass}" style="font-size:10px; padding:2px 6px;">${badgeText}</span>
          </div>
          <div style="color:var(--text2); word-break:break-word;">${esc(t.prompt)}</div>
          ${t.error ? `<div style="color:var(--red); font-size:10px; margin-top:2px;">⚠️ ${esc(t.error)}</div>` : ''}
        </div>
      `;
    }).join("");
  }

  function setupEventListeners() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    
    const bindClick = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    
    bindClick('btnSelectStartFile', () => document.getElementById('startFile').click());
    bindClick('btnSelectEndFile', () => document.getElementById('endFile').click());
    bindClick('btnSelectRefFile', () => document.getElementById('refFile').click());
    

    bindClick('btnTestStep1', async () => {
      const p = document.getElementById("testStepPrompt").value;
      const pid = document.getElementById("projectId").value;
      document.getElementById("testStepLog").textContent = "⏳ Đang chạy Bước 1...";
      const r = await callExt("TEST_UI_STEP", { step: 1, prompt: p, projectId: pid });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    });
    bindClick('btnTestStep2', async () => {
      const pid = document.getElementById("projectId").value;
      document.getElementById("testStepLog").textContent = "⏳ Đang chạy Bước 2...";
      const r = await callExt("TEST_UI_STEP", { step: 2, projectId: pid });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    });
    bindClick('btnTestStep3', async () => {
      const pid = document.getElementById("projectId").value;
      document.getElementById("testStepLog").textContent = "⏳ Đang chạy Bước 3...";
      const r = await callExt("TEST_UI_STEP", { step: 3, projectId: pid });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    });


    const runTest4 = async (subStep, label) => {
      const pid = document.getElementById("projectId").value;
      const config = getUiConfig();
      document.getElementById("testStepLog").textContent = `⏳ Đang chạy Bước ${subStep} (${label})...`;
      const r = await callExt("TEST_UI_STEP", { step: subStep, projectId: pid, config });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    };

    bindClick('btnTestStep4_0', () => runTest4(4.0, "Bấm Tab Video"));
    bindClick('btnTestStep4_0_frames', () => runTest4(4.05, "Bấm Tab Khung Hình"));
    bindClick('btnTestStep4_1', () => runTest4(4.1, "Tỷ lệ"));
    bindClick('btnTestStep4_2', () => runTest4(4.2, "Thời lượng"));
    bindClick('btnTestStep4_3', () => runTest4(4.3, "Số lượng"));
    bindClick('btnTestStep4_4', () => runTest4(4.4, "Model Video"));
    bindClick('btnTestStep4_6', () => runTest4(4.6, "Quét Upload"));
    bindClick('btnTestStep4_7', () => runTest4(4.7, "Focus Text"));
    bindClick('btnTestStep4_8', () => runTest4(4.8, "Auto Paste"));
    bindClick('btnTestStep4', () => runTest4(4, "All Config"));
    bindClick('btnTestStep5', () => runTest4(5.0, "Quét Media ID & DOM"));
    bindClick('btnTestOldApi', () => runTest4(6.0, "Test API Cũ (tRPC flow.projectInitialData)"));
    bindClick('btnTestDownload', () => runTest4(7.0, "Test Tải Video Trực Tiếp Trên Tab Flow"));
    bindClick('btnTestRightClick', async () => {
      const pid = document.getElementById("projectId")?.value || "";
      const query = document.getElementById("testRightClickQuery")?.value || "001.";
      document.getElementById("testStepLog").textContent = `⏳ Đang tìm và click chuột phải vào card "${query}" trên tab Flow...`;
      const r = await callExt("TEST_UI_STEP", { step: 8.0, projectId: pid, query });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    });

    bindClick('btnTestHoverDownload', async () => {
      const pid = document.getElementById("projectId")?.value || "";
      const query = document.getElementById("testRightClickQuery")?.value || "001.";
      document.getElementById("testStepLog").textContent = `⏳ Đang di chuột vào mục "Tải xuống" cho card "${query}"...`;
      const r = await callExt("TEST_UI_STEP", { step: 8.1, projectId: pid, query });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    });

    bindClick('btnTestHover720p', async () => {
      const pid = document.getElementById("projectId")?.value || "";
      const query = document.getElementById("testRightClickQuery")?.value || "001.";
      document.getElementById("testStepLog").textContent = `⏳ Đang di chuột vào "720p (Kích thước gốc)" cho card "${query}"...`;
      const r = await callExt("TEST_UI_STEP", { step: 8.2, projectId: pid, query });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    });

    bindClick('btnTestClick720p', async () => {
      const pid = document.getElementById("projectId")?.value || "";
      const query = document.getElementById("testRightClickQuery")?.value || "001.";
      document.getElementById("testStepLog").textContent = `⏳ Đang rê chuột và bấm tải 720p cho card "${query}"...`;
      const r = await callExt("TEST_UI_STEP", { step: 8.3, projectId: pid, query });
      document.getElementById("testStepLog").textContent = r.success ? ("✅ " + r.message) : ("❌ Lỗi: " + r.error);
    });

    bindClick('btnTestFullDownloadFlow', async () => {
      const pid = document.getElementById("projectId")?.value || "";
      const query = document.getElementById("testRightClickQuery")?.value || "001.";
      const logEl = document.getElementById("testStepLog");
      logEl.textContent = `⏳ [B8.Full] Bắt đầu luồng kiểm tra tự động:\n- Card tìm kiếm: "${query}"\n- Trạng thái: Đang theo dõi card trên tab Flow...\n(Nếu video đang render sẽ chờ đến khi render xong ➔ Tự động Click phải ➔ Rê Tải xuống ➔ Rê 720p ➔ Bấm tải 720p gốc)`;

      try {
        const r = await callExt("WAIT_AND_DOWNLOAD_CARD", {
          projectId: pid,
          prompt: query,
          timeoutMs: 600000
        });
        if (r?.success) {
          logEl.textContent += `\n\n🎉 THÀNH CÔNG 100%! Đã kích hoạt tải video 720p gốc:\n📁 File: ${r.filename || 'flow_video.mp4'}\n💡 Kiểm tra danh sách download của Chrome!`;
          toast(`📥 Đã tải thành công video 720p cho "${query}"!`, "success");
        } else {
          logEl.textContent += `\n\n❌ Thất bại: ${r?.error || "Không tải được video"}`;
          toast(`❌ Lỗi tải: ${r?.error}`, "error");
        }
      } catch (err) {
        logEl.textContent += `\n\n❌ Exception: ${err.message}`;
        toast(`❌ Lỗi: ${err.message}`, "error");
      }
    });

    const runTestImg = async (subStep, label) => {
      const pid = document.getElementById("projectId")?.value || "";
      const ratio = document.getElementById("testImgRatio")?.value || "9:16";
      const model = document.getElementById("testImgModel")?.value || "banana_pro";
      const count = document.getElementById("testImgCount")?.value || "x1";
      const prompt = document.getElementById("testStepPrompt")?.value || "A majestic golden eagle soaring above misty mountains at sunrise, ultra high quality, 8k";

      document.getElementById("testStepLog").textContent = `⏳ [Image UI] Đang chạy ${label} (Tỉ lệ: ${ratio}, Model: ${model}, Số lượng: ${count})...`;
      try {
        const r = await callExt("TEST_UI_STEP", {
          step: subStep,
          projectId: pid,
          prompt,
          config: {
            aspectRatio: ratio,
            model,
            count
          }
        });
        document.getElementById("testStepLog").textContent = r.success ? ("✅ " + (r.message || r.result || "Thành công!")) : ("❌ Lỗi: " + r.error);
        if (r.success) {
          toast(`✅ [Image Test] ${label} thành công!`, "success");
        } else {
          toast(`❌ [Image Test] ${r.error}`, "error");
        }
      } catch (err) {
        document.getElementById("testStepLog").textContent = `❌ Exception: ${err.message}`;
        toast(`❌ Lỗi: ${err.message}`, "error");
      }
    };

    bindClick('btnTestImgTab', () => runTestImg("img_tab", "Bấm Tab Hình ảnh"));
    bindClick('btnTestImgRatio', () => runTestImg("img_ratio", "Chọn Tỉ lệ Ảnh"));
    bindClick('btnTestImgCount', () => runTestImg("img_count", "Chọn Số lượng Ảnh"));
    bindClick('btnTestImgModel', () => runTestImg("img_model", "Chọn Model Ảnh"));
    bindClick('btnTestImgAllConfig', () => runTestImg("img_all_config", "Toàn Bộ Config Ảnh"));
    bindClick('btnTestImgFullCreate', () => runTestImg("img_full_create", "Tạo Hoàn Chỉnh 1 Ảnh"));
    
    bindClick('btnCreate', createVideo);


    bindClick('btnStartBatch', startBatchQueue);
    bindClick('btnRetryFailed', retryFailedTasks);
    bindClick('btnPauseBatch', pauseBatchQueue);
    bindClick('btnClearBatch', clearBatchQueue);
    
    bindClick('btnCreateImage', createImage);
    bindClick('btnStartBatchImage', startBatchImageQueue);
    bindClick('btnStopBatchImage', stopBatchImageQueue);
    bindClick('btnRetryBatchImage', retryFailedImageTasks);
    bindClick('btnClearBatchImage', clearBatchImageQueue);
    
    bindClick('btnUiSubmitSingle', submitSingleUi);
    bindClick('btnUiStartBatch', startUiBatchQueue);
    bindClick('btnUiStopBatch', stopUiBatchQueue);
    bindClick('btnUiSubmitSingleImage', submitSingleImageUi);
    bindClick('btnUiStartBatchImage', startUiImageBatchQueue);
    bindClick('btnUiStopBatchImage', stopUiImageBatchQueue);
    bindClick('btnSelectUiStartFile', () => document.getElementById('uiStartFile')?.click());
    bindClick('btnSelectUiEndFile', () => document.getElementById('uiEndFile')?.click());
    bindClick('btnLoadProjectImages', () => loadProjectImages());

    bindClick('btnRenameFlowImageToUuid', async () => {
      const mediaId = document.getElementById("uiStartImage")?.value?.trim();
      if (!mediaId) { toast("Chưa có Media ID trong ô Ảnh Bắt Đầu!", "error"); return; }
      const projectId = document.getElementById("projectId")?.value || document.getElementById("projectId2")?.value || "";
      toast(`⏳ Đang gán tên hiển thị ảnh trên Flow thành UUID...`, "info");
      const res = await callExt("RENAME_WORKFLOW_TO_UUID", { projectId, mediaId });
      if (res?.success) {
        toast(`✅ Đã gán tên ảnh trên Flow thành UUID! Hãy F5 lại tab Flow để thấy ngay.`, "success");
        if (typeof loadProjectImages === "function") loadProjectImages();
      } else {
        toast(`❌ Lỗi: ${res?.error || "Không thể đổi tên"}`, "error");
      }
    });

    const uiSf = document.getElementById('uiStartFile');
    if (uiSf) uiSf.addEventListener('change', function() { handleFileSelect(this, 'uiStartImage'); });
    const uiEf = document.getElementById('uiEndFile');
    if (uiEf) uiEf.addEventListener('change', function() { handleFileSelect(this, 'uiEndImage'); });

    const uiMode = document.getElementById('uiConfigMode');
    if (uiMode) {
      uiMode.addEventListener('change', function() {
        const box = document.getElementById('uiFrameInputsBox');
        if (box) {
          box.style.display = this.value === 'frames' ? 'block' : 'none';
          if (this.value === 'frames') loadProjectImages();
        }
      });
    }

    bindClick('btnFetch', fetchVideos);

    const autoPoll = document.getElementById('autoPoll');
    if (autoPoll) autoPoll.addEventListener('change', (e) => togglePoll(e.target.checked));
    
    const promptFilter = document.getElementById('promptFilter');
    if (promptFilter) promptFilter.addEventListener('input', filterVideos);

    const sf = document.getElementById('startFile');
    if (sf) sf.addEventListener('change', function() { handleFileSelect(this, 'startImage') });
    const ef = document.getElementById('endFile');
    if (ef) ef.addEventListener('change', function() { handleFileSelect(this, 'endImage') });
    const rf = document.getElementById('refFile');
    if (rf) rf.addEventListener('change', function() { handleFileSelect(this, 'refImage') });

    // Delegated click for dynamic elements
    document.body.addEventListener('click', (e) => {
      const pickBtn = e.target.closest('[data-pick-frame]');
      if (pickBtn) {
        const targetType = pickBtn.dataset.pickFrame;
        const targetTitle = pickBtn.dataset.title;
        if (targetType === "start") {
          const inp = document.getElementById("uiStartImage");
          if (inp) inp.value = targetTitle;
          toast(`Đã chọn ảnh bắt đầu: "${targetTitle}"`, "success");
        } else {
          const inp = document.getElementById("uiEndImage");
          if (inp) inp.value = targetTitle;
          toast(`Đã chọn ảnh kết thúc: "${targetTitle}"`, "success");
        }
        return;
      }

      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      
      if (action === 'downloadImage') downloadImageDirect(btn.dataset.id);
      if (action === 'copyId') copyMediaId(btn.dataset.id);
      if (action === 'downloadVid') downloadVid(btn.dataset.id, btn.dataset.prompt, btn.dataset.url, parseInt(btn.dataset.index, 10));
      if (action === 'deleteVid') deleteVid(btn.dataset.workflow, btn.dataset.project, btn.dataset.media, btn.dataset.prompt);
    });
  }

  window.loadProjectImages = async function() {
    const projectId = document.getElementById("projectId")?.value || document.getElementById("projectId2")?.value || document.getElementById("batchProjectId")?.value || "";
    const listDiv = document.getElementById("uiProjectImagesList");
    if (!listDiv) return;
    if (!projectId) { listDiv.innerHTML = '<span style="color:var(--text2);">Chưa có Project ID</span>'; return; }

    listDiv.innerHTML = '<span style="color:var(--accent2); font-size:10px;">⏳ Đang đọc danh sách ảnh...</span>';
    try {
      const res = await callExt("GET_PROJECT_VIDEOS", { projectId });
      if (res?.success && Array.isArray(res.images) && res.images.length) {
        listDiv.innerHTML = res.images.slice(0, 15).map((img, idx) => {
          const title = img.mediaTitle || img.prompt || img.mediaId;
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface2); padding:3px 6px; border-radius:4px; font-size:10px;">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:170px;" title="${esc(title)}">
                <b>#${idx + 1}.</b> ${esc(title)}
              </span>
              <div style="display:flex; gap:3px;">
                <button class="btn btn-sm btn-green" type="button" data-pick-frame="start" data-title="${esc(title)}" style="font-size:9px; padding:1px 5px;">🟢 Start</button>
                <button class="btn btn-sm" type="button" data-pick-frame="end" data-title="${esc(title)}" style="font-size:9px; padding:1px 5px; background:var(--border);">🔴 End</button>
              </div>
            </div>
          `;
        }).join("");
      } else {
        listDiv.innerHTML = '<span style="color:var(--text2); font-size:10px;">Chưa có ảnh nào trong project</span>';
      }
    } catch (e) {
      listDiv.innerHTML = `<span style="color:var(--red); font-size:10px;">Lỗi: ${esc(e.message)}</span>`;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupEventListeners);
  } else {
    setupEventListeners();
  }

  async function updateToolServerStatus() {
    try {
      const res = await callExt("GET_TOOL_SERVER_STATUS");
      const dot = document.getElementById("toolServerDot");
      const text = document.getElementById("toolServerText");
      if (dot && text) {
        if (res?.connected) {
          dot.style.background = "var(--green)";
          text.style.color = "var(--green)";
          text.textContent = "Server: Online (7788)";
        } else {
          dot.style.background = "var(--text2)";
          text.style.color = "var(--text2)";
          text.textContent = "Server: Offline";
        }
      }
    } catch (_) {}
  }

  // ──────────────────────────
  // Live Activity Log
  // ──────────────────────────
  function appendLiveLog(logItem) {
    const list = document.getElementById("liveLogList");
    if (!list) return;

    if (list.querySelector("div[style*='italic']")) {
      list.innerHTML = "";
    }

    const row = document.createElement("div");
    row.style.lineHeight = "1.4";
    row.style.wordBreak = "break-word";
    row.style.fontSize = "11px";

    let color = "#cbd5e1";
    if (logItem.message.includes("✅") || logItem.message.includes("🎉") || logItem.message.includes("HOÀN THÀNH")) {
      color = "var(--green)";
    } else if (logItem.message.includes("❌") || logItem.message.includes("lỗi") || logItem.message.includes("Lỗi") || logItem.message.includes("thất bại")) {
      color = "var(--red)";
    } else if (logItem.message.includes("Bắt đầu") || logItem.message.includes("Media ID")) {
      color = "var(--accent2)";
    } else if (logItem.message.includes("render") || logItem.message.includes("chú ý")) {
      color = "#f59e0b";
    }

    row.innerHTML = `<span style="color:#64748b; font-size:10px; margin-right:6px;">[${esc(logItem.time || "")}]</span><span style="color:${color};">${esc(logItem.message || "")}</span>`;
    list.appendChild(row);

    while (list.children.length > 100) {
      list.removeChild(list.firstChild);
    }

    list.scrollTop = list.scrollHeight;
  }

  async function loadInitialLiveLogs() {
    try {
      const res = await callExt("GET_LIVE_LOGS");
      if (res?.logs && Array.isArray(res.logs) && res.logs.length > 0) {
        const list = document.getElementById("liveLogList");
        if (list) list.innerHTML = "";
        res.logs.forEach(appendLiveLog);
      }
    } catch (_) {}
  }

  const btnClearLog = document.getElementById("btnClearLiveLog");
  if (btnClearLog) {
    btnClearLog.addEventListener("click", () => {
      const list = document.getElementById("liveLogList");
      if (list) list.innerHTML = '<div style="color:var(--text2); font-style:italic;">Đã xoá nhật ký. Đang chờ hoạt động mới...</div>';
    });
  }

  const btnToggleLog = document.getElementById("btnToggleLiveLog");
  if (btnToggleLog) {
    btnToggleLog.addEventListener("click", function() {
      const list = document.getElementById("liveLogList");
      if (!list) return;
      if (list.style.display === "none") {
        list.style.display = "flex";
        this.textContent = "Thu gọn ▼";
      } else {
        list.style.display = "none";
        this.textContent = "Mở rộng ▲";
      }
    });
  }

  async function autoSyncProjectIdFromActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ url: ["https://labs.google/*", "https://flow.google.com/*"] });
      if (tabs?.length) {
        const matchTab = tabs.find(t => t.url && t.url.match(/project\/([a-f0-9\-]{36})/i)) || tabs[0];
        if (matchTab?.url) {
          const m = matchTab.url.match(/project\/([a-f0-9\-]{36})/i);
          if (m && m[1]) {
            const currentPid = m[1];
            ["projectId", "projectId2", "batchProjectId", "imageProjectId", "batchImageProjectId"].forEach(id => {
              const el = document.getElementById(id);
              if (el) el.value = currentPid;
            });
          }
        }
      }
    } catch (_) {}
  }

  async function initConnection() {
    const ok = await checkConnection();
    if (ok) toast("Extension đã kết nối!", "success");
    else toast("Extension chưa kết nối! Reload extension rồi F5 trang này.", "error");

    autoSyncProjectIdFromActiveTab();
    updateToolServerStatus();
    loadInitialLiveLogs();
    setInterval(updateToolServerStatus, 3000);
    window.addEventListener('focus', autoSyncProjectIdFromActiveTab);

    // Tự động kiểm tra và nạp các task từ tool_video gửi lúc Sidepanel chưa mở
    try {
      const res = await callExt("GET_PENDING_SERVER_TASKS");
      if (res?.success && Array.isArray(res.tasks) && res.tasks.length > 0) {
        for (const t of res.tasks) {
          await addServerTaskToUiBatch(t);
        }
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConnection);
  } else {
    initConnection();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "TOOL_SERVER_STATUS") {
      updateToolServerStatus();
    }
    if (msg.type === "LIVE_LOG" && msg.log) {
      appendLiveLog(msg.log);
    }
    if (msg.action === "ADD_SERVER_TASK_TO_UI_BATCH") {
      addServerTaskToUiBatch(msg.task).then(res => {
        sendResponse(res);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // Phản hồi async
    }
  });

})();
