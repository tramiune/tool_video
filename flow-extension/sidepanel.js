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

      // LẤY STT LỚN NHẤT ĐÃ CÓ TRONG PROJECT ĐỂ TỰ ĐỘNG TĂNG TIẾP (KHÔNG BAO GIỜ TRÙNG)
      let startSeq = 1;
      try {
        const seqRes = await callExt("GET_MAX_SEQ", { projectId });
        if (seqRes?.success && typeof seqRes.maxSeq === 'number' && seqRes.maxSeq > 0) {
          startSeq = seqRes.maxSeq + 1;
        }
      } catch (_) {}

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

        // TỰ ĐỘNG ĐÁNH SỐ THỨ TỰ TIẾP THEO (KHÔNG TRÙNG LẶP)
        const currentNum = startSeq + idx;
        const seqIndex = String(currentNum).padStart(3, '0') + ".";
        let seqStr = seqIndex;
        const matchSeq = prompt.match(/^(\d+[\.\-_:\s])/);
        if (matchSeq) {
          seqStr = matchSeq[1].trim();
        } else {
          prompt = `${seqIndex} ${prompt}`;
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

      // Quét card trước khi check status → đánh dấu STT
      try { await callExt('SCAN_FLOW_CARDS', { projectId }); } catch (_) {}

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
  // Helper tính STT tự động cho Auto Click UI (001., 002., 044...)
  // ──────────────────────────
  async function getNextSeqForUiTask(task, projectId) {
    let prompt = (task?.prompt || '').trim();
    let seqStr = "";

    // 1. Nếu prompt đã có STT ở đầu (ví dụ: "001. ...", "44. ...")
    const matchSeq = prompt.match(/^(\d{1,4})[\.\-_:\s]/);
    if (matchSeq) {
      const num = parseInt(matchSeq[1], 10);
      seqStr = String(num).padStart(3, '0') + ".";
      prompt = prompt.replace(/^(\d{1,4})[\.\-_:\s]\s*/, `${seqStr} `);
      callExt("UPDATE_MAX_SEQ", { projectId, newMax: num }).catch(() => {});
      return { seqStr, prompt };
    }

    // 2. Nếu task có sceneIndex (từ kịch bản drama)
    if (task?.sceneIndex !== undefined && task?.sceneIndex !== null && !isNaN(Number(task?.sceneIndex))) {
      const num = Number(task.sceneIndex) + 1;
      seqStr = String(num).padStart(3, '0') + ".";
      prompt = `${seqStr} ${prompt}`;
      callExt("UPDATE_MAX_SEQ", { projectId, newMax: num }).catch(() => {});
      return { seqStr, prompt };
    }

    // 3. Tự động lấy STT tiếp theo lớn nhất (không trùng lặp)
    let maxLocalSeq = 0;
    for (const t of uiBatchTasks) {
      if (t.seq) {
        const n = parseInt(t.seq.replace(/[^0-9]/g, ""), 10);
        if (!isNaN(n) && n > maxLocalSeq) maxLocalSeq = n;
      }
    }

    let serverMaxSeq = 0;
    try {
      const seqRes = await callExt("GET_MAX_SEQ", { projectId });
      if (seqRes?.success && typeof seqRes.maxSeq === 'number') {
        serverMaxSeq = seqRes.maxSeq;
      }
    } catch (_) {}

    const nextNum = Math.max(maxLocalSeq, serverMaxSeq) + 1;
    seqStr = String(nextNum).padStart(3, '0') + ".";
    prompt = `${seqStr} ${prompt}`;
    callExt("UPDATE_MAX_SEQ", { projectId, newMax: nextNum }).catch(() => {});
    return { seqStr, prompt };
  }

  // Thêm task từ tool_video server vào thẳng danh sách Auto Click UI
  
  async function addServerImageTaskToUiBatch(task) {
    if (!task) return { success: false, error: "Task rỗng" };
    const projectId = task.projectId || document.getElementById("projectId")?.value || document.getElementById("imageProjectId")?.value || "";
    
    // Tạo STT ảnh
    let maxLocalSeq = 0;
    for (const t of uiImgBatchTasks) {
      if (t.seq) {
        const n = parseInt(t.seq.replace(/[^0-9]/g, ""), 10);
        if (!isNaN(n) && n > maxLocalSeq) maxLocalSeq = n;
      }
    }

    let startSeq = 1;
    try {
      const seqRes = await callExt("GET_MAX_SEQ", { projectId, mediaType: "image" });
      if (seqRes?.success && typeof seqRes.maxSeq === 'number' && seqRes.maxSeq > 0) {
        startSeq = seqRes.maxSeq + 1;
      }
    } catch (_) {}

    const nextNum = Math.max(startSeq, maxLocalSeq + 1);
    const seqStr = String(nextNum).padStart(3, '0') + ".";
    const prompt = `${seqStr} ${task.prompt}`;
    
    callExt("UPDATE_MAX_SEQ", { projectId, newMax: nextNum, mediaType: "image" }).catch(() => {});

    const newTask = {
      id: uiImgBatchTasks.length + 1,
      serverTaskId: task.id,
      projectId: projectId,
      seq: seqStr,
      prompt: prompt,
      referenceImage: task.referenceImage || task.startImage || "",
      referenceImages: task.referenceImages || [],
      model: task.model || "imagen_3",
      aspectRatio: task.aspectRatio || "9:16",
      status: "PENDING",
      downloadStatus: "Chờ submit...",
      error: null
    };

    uiImgBatchTasks.push(newTask);
    renderUiImageBatchUI();

    if (typeof window.switchTab === "function") {
      window.switchTab("click-ui-image");
    }

    toast(`📥 [tool_video] Đã thêm task ảnh ${seqStr} vào Auto Click UI!`, "info");

    triggerUiImageBatchProcessing();

    return { success: true, taskId: newTask.id, seq: seqStr };
  }

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
    let lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    
    const finalLines = [];
    for (let i = 0; i < lines.length; i++) {
        finalLines.push(lines[i]);
        if ((i + 1) % 10 === 0) {
            finalLines.push("chim_moi_con_ga");
        }
    }
    lines = finalLines;

    if (!lines.length && !uiBatchTasks.some(t => t.status === "PENDING")) {
      toast("Nhập ít nhất 1 prompt hoặc có task chờ!", "error");
      return;
    }

    const projectId = document.getElementById("projectId")?.value || document.getElementById("projectId2")?.value || "";

    if (lines.length > 0) {
      let maxLocalSeq = 0;
      for (const t of uiBatchTasks) {
        if (t.seq) {
          const n = parseInt(t.seq.replace(/[^0-9]/g, ""), 10);
          if (!isNaN(n) && n > maxLocalSeq) maxLocalSeq = n;
        }
      }

      let startSeq = 1;
      try {
        const seqRes = await callExt("GET_MAX_SEQ", { projectId });
        if (seqRes?.success && typeof seqRes.maxSeq === 'number' && seqRes.maxSeq > 0) {
          startSeq = seqRes.maxSeq + 1;
        }
      } catch (_) {}

      startSeq = Math.max(startSeq, maxLocalSeq + 1);

      const baseId = uiBatchTasks.length;
      const newTasks = lines.map((line, i) => {
        let isDecoy = (line === "chim_moi_con_ga");
        let prompt = isDecoy ? "tạo video con gà" : line;
        let startImage = "";
        let endImage = "";
        let isFrames = false;

        if (!isDecoy && line.includes("|")) {
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

        // TỰ ĐỘNG ĐÁNH SỐ THỨ TỰ TIẾP THEO (KHÔNG TRÙNG LẶP)
        const currentNum = startSeq + i;
        const seqIndex = String(currentNum).padStart(3, '0') + ".";
        let seqStr = seqIndex;
        const matchSeq = prompt.match(/^(\d+[\.\-_:\s])/);
        if (matchSeq) {
          seqStr = matchSeq[1].trim();
        } else {
          prompt = `${seqIndex} ${prompt}`;
        }

        return {
          id: baseId + i + 1,
          seq: seqStr,
          prompt: prompt,
          startImage: startImage,
          endImage: endImage,
          isFrames: isFrames,
          isDecoy: isDecoy,
          status: "PENDING",
          downloadStatus: "Chờ submit...",
          error: null
        };
      });

      uiBatchTasks = [...uiBatchTasks, ...newTasks];
      callExt("UPDATE_MAX_SEQ", { projectId, newMax: startSeq + lines.length - 1 }).catch(() => {});

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

  
  
  function triggerUiImageBatchProcessing() {
    isUiImgBatchRunning = true;
    const startBtn = document.getElementById("btnUiStartBatchImage");
    const stopBtn = document.getElementById("btnUiStopBatchImage");
    if (startBtn) startBtn.style.display = "none";
    if (stopBtn) stopBtn.style.display = "inline-flex";

    const projectId = document.getElementById("projectId")?.value || document.getElementById("imageProjectId")?.value || "";
    const autoDownload = document.getElementById("uiImgAutoDownload")?.checked !== false;

    renderUiImageBatchUI();

    if (!isImgSubmitWorkerActive) {
      isImgSubmitWorkerActive = true;
      processUiImageBatchQueue(projectId, autoDownload).finally(() => {
        isImgSubmitWorkerActive = false;
      });
    }
    if (!isImgDownloadWorkerActive && autoDownload) {
      isImgDownloadWorkerActive = true;
      runUiImageDownloadWorker(projectId).finally(() => {
        isImgDownloadWorkerActive = false;
      });
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
            isFrames: task.isDecoy ? false : (task.isFrames || config.isFrames),
            startImage: task.isDecoy ? "" : (task.startImage || config.startImage),
            endImage: task.isDecoy ? "" : (task.endImage || config.endImage)
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

        // Quét card trước khi check status → đánh dấu STT
        try { await callExt('SCAN_FLOW_CARDS', { projectId }); } catch (_) {}

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
  let isImgSubmitWorkerActive = false;
  let isImgDownloadWorkerActive = false;
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

    // LẤY STT LỚN NHẤT ĐÃ CÓ TRONG PROJECT ĐỂ TỰ ĐỘNG TĂNG TIẾP (KHÔNG BAO GIỜ TRÙNG)
    let startSeq = 1;
    if (autoSeq) {
      try {
        const seqRes = await callExt("GET_MAX_SEQ", { projectId, mediaType: "image" });
        if (seqRes?.success && typeof seqRes.maxSeq === 'number' && seqRes.maxSeq > 0) {
          startSeq = seqRes.maxSeq + 1;
        }
      } catch (_) {}
    }

    uiImgBatchTasks = lines.map((line, i) => {
      let prompt = line;
      let seqStr = "";

      if (autoSeq) {
        const currentNum = startSeq + i;
        const seqIndex = String(currentNum).padStart(3, '0') + ".";
        seqStr = seqIndex;
        const matchSeq = prompt.match(/^(\d+[\.\-_:\s])/);
        if (matchSeq) {
          seqStr = matchSeq[1].trim();
        } else {
          prompt = `${seqIndex} ${prompt}`;
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
      callExt("UPDATE_MAX_SEQ", { projectId, newMax: startSeq + lines.length - 1, mediaType: "image" }).catch(() => {});
    }

    toast(`🚀 Bắt đầu Auto Click Ảnh (${uiImgBatchTasks.length} ảnh) ${autoDownload ? 'kèm Tự động tải về' : ''}!`, "info");
    triggerUiImageBatchProcessing();
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
        let currentConfig = { ...config };
      if (task.referenceImages && task.referenceImages.length > 0) {
        currentConfig.mode = "frames";
        currentConfig.isFrames = true;
        currentConfig.referenceImages = task.referenceImages;
      } else if (task.referenceImage) {
        currentConfig.mode = "frames";
        currentConfig.isFrames = true;
        currentConfig.startImage = task.referenceImage;
      }
      if (task.aspectRatio) {
        currentConfig.aspectRatio = task.aspectRatio;
      }
      const res = await callExt("CREATE_IMAGE_UI", { prompt: task.prompt, projectId, config: currentConfig });
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

      // Quét card trước khi check status → đánh dấu STT
      try { await callExt('SCAN_FLOW_CARDS', { projectId, purpose: "image" }); } catch (_) {}

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
              if (task.serverTaskId) {
                callExt("REPORT_TOOL_IMAGE_RESULT", { id: task.serverTaskId, ok: true, filePath: dlRes.filename || dlRes.filePath, mediaId: task.mediaId }).catch(() => {});
              }
            } else {
              task.status = "WARNING";
              task.downloadStatus = `Lỗi tải: ${dlRes?.error || 'timeout'}`;
              toast(`⚠️ [#${task.id}] Ảnh tạo xong nhưng lỗi tải: ${dlRes?.error}`, "warning");
              if (task.serverTaskId) {
                callExt("REPORT_TOOL_IMAGE_RESULT", { id: task.serverTaskId, ok: false, error: dlRes?.error || 'Lỗi tải ảnh' }).catch(() => {});
              }
            }
            renderUiImageBatchUI();
          } else if (statusRes?.status === 'FAILED') {
            task.status = "ERROR";
            task.error = statusRes.error || "Tạo ảnh thất bại trên Flow";
            task.downloadStatus = statusRes.error || "Tạo ảnh thất bại trên Flow";
            toast(`❌ [#${task.id}] ${task.error} (${task.seq || ''})`, "error");
            if (task.serverTaskId) {
              callExt("REPORT_TOOL_IMAGE_RESULT", { id: task.serverTaskId, ok: false, error: task.error }).catch(() => {});
            }
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
    

    // ═══ CARD SCANNER TOGGLE ═══
    let _cardScannerInterval = null;
    bindClick('btnToggleCardScanner', async () => {
      const btn = document.getElementById('btnToggleCardScanner');
      const logEl = document.getElementById('testStepLog');

      if (_cardScannerInterval) {
        // TẮT scanner
        clearInterval(_cardScannerInterval);
        _cardScannerInterval = null;
        btn.textContent = '🔍 Bật Quét STT Card (3s/lần)';
        btn.style.background = 'linear-gradient(135deg, #6c5ce7, #00cec9)';
        logEl.textContent = '⏹️ Đã tắt scanner.';
        // Xóa badge trên Flow
        try {
          const flowTabs = await chrome.tabs?.query?.({ url: ["https://labs.google/*", "https://flow.google.com/*"] }) || [];
          // Gọi qua background để xóa badge
          await callExt('SCAN_FLOW_CARDS', { tabId: null, projectId: document.getElementById('projectId')?.value || '' });
        } catch (_) {}
        return;
      }

      // BẬT scanner
      btn.textContent = '⏹️ Đang quét... (Bấm để tắt)';
      btn.style.background = 'linear-gradient(135deg, #e74c3c, #c0392b)';
      logEl.textContent = '🔍 Bắt đầu quét card...';

      const doScan = async () => {
        try {
          const pid = document.getElementById('projectId')?.value || '';
          const r = await callExt('SCAN_FLOW_CARDS', { projectId: pid });
          if (r.success) {
            const lines = [`🔍 Quét ${new Date().toLocaleTimeString()} — Tìm thấy ${r.count} card:`];
            for (const c of (r.cards || [])) {
              const icon = c.status === 'rendering' ? '⏳' : c.status === 'failed' ? '❌' : '✅';
              lines.push(`  ${icon} ${c.seq}: ${c.text}`);
            }
            logEl.textContent = lines.join('\n');
          } else {
            logEl.textContent = `❌ Lỗi: ${r.error}`;
          }
        } catch (e) {
          logEl.textContent = `❌ Exception: ${e.message}`;
        }
      };

      await doScan();
      _cardScannerInterval = setInterval(doScan, 3000);
    });

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

  let _serverPaused = false;

  async function updateToolServerStatus() {
    try {
      const res = await callExt("GET_TOOL_SERVER_STATUS");
      const dot = document.getElementById("toolServerDot");
      const text = document.getElementById("toolServerText");
      if (dot && text) {
        if (_serverPaused) {
          dot.style.background = "#ff9800";
          text.style.color = "#ff9800";
          text.textContent = "Server: TẮT";
        } else if (res?.connected) {
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

  // Toggle server on/off khi click
  const serverStatusEl = document.getElementById("toolServerStatus");
  if (serverStatusEl) {
    serverStatusEl.addEventListener("click", async () => {
      _serverPaused = !_serverPaused;
      await callExt("TOGGLE_TOOL_SERVER", { paused: _serverPaused });
      updateToolServerStatus();
    });
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
    if (msg.action === "ADD_SERVER_IMAGE_TASK_TO_UI_BATCH") {
      addServerImageTaskToUiBatch(msg.task).then(res => {
        sendResponse(res);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }
    if (msg.action === "ADD_SERVER_TASK_TO_MULTI_TAB") {
      addServerTaskToMultiTab(msg.task).then(res => {
        sendResponse(res);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
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

// ══════════════════════════════════════════════════════════════
// MULTI-TAB MANAGER
// ══════════════════════════════════════════════════════════════
const _multiTabRegistry = []; // { tabId, role: 'video'|'image', title, url, projectId, index }

async function loadMultiTabRoles() {
  try {
    const data = await chrome.storage.local.get('multiTabRoles');
    return data.multiTabRoles || {};
  } catch { return {}; }
}

async function saveMultiTabRoles(roles) {
  try { await chrome.storage.local.set({ multiTabRoles: roles }); } catch {}
}

async function refreshMultiTabList() {
  const container = document.getElementById('multiTabList');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text2); font-size:11px; text-align:center; padding:10px;">⏳ Đang quét...</div>';

  try {
    const tabs = await chrome.tabs.query({ url: ["*://flow.google.com/*", "*://labs.google/*"] });
    if (tabs.length === 0) {
      container.innerHTML = '<div style="color:var(--accent); font-size:11px; text-align:center; padding:10px; background:var(--surface2); border-radius:6px;">❌ Chưa mở tab Google Flow nào!</div>';
      updateMultiTabSummary();
      return;
    }

    // Sort by window position then tab index
    for (const tab of tabs) {
      try {
        const win = await chrome.windows.get(tab.windowId);
        tab._winLeft = win.left || 0;
      } catch { tab._winLeft = 0; }
    }
    tabs.sort((a, b) => {
      if (a.windowId !== b.windowId) return a._winLeft - b._winLeft;
      return a.index - b.index;
    });

    // Load saved roles
    const savedRoles = await loadMultiTabRoles();

    // Build registry
    _multiTabRegistry.length = 0;
    tabs.forEach((tab, i) => {
      let projectId = '';
      try {
        const u = new URL(tab.url);
        const parts = u.pathname.split('/');
        if (parts.length > 2 && parts[1] === 'project') projectId = parts[2];
      } catch {}

      // Default: last tab = image, rest = video
      const defaultRole = (i === tabs.length - 1 && tabs.length > 1) ? 'image' : 'video';
      const role = savedRoles[tab.id] || defaultRole;

      _multiTabRegistry.push({
        tabId: tab.id,
        role,
        title: tab.title || '',
        url: tab.url || '',
        projectId,
        index: i,
        windowId: tab.windowId
      });
    });

    // Render UI
    let html = '';
    _multiTabRegistry.forEach((entry, i) => {
      const isVideo = entry.role === 'video';
      const roleLabel = isVideo ? '🎥 Video' : '🖼️ Ảnh';
      const roleColor = isVideo ? '#00e5ff' : '#e91e63';
      const roleBg = isVideo ? 'rgba(0, 229, 255, 0.1)' : 'rgba(233, 30, 99, 0.1)';
      const otherRole = isVideo ? 'image' : 'video';
      const otherLabel = isVideo ? '🖼️ Ảnh' : '🎥 Video';

      const projShort = entry.projectId ? entry.projectId.slice(0, 8) + '...' : 'N/A';
      const isActive = tab => tab.active;

      html += `
        <div style="background:var(--surface2); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="font-weight:bold; font-size:12px; color:white; display:flex; align-items:center; gap:6px;">
              Tab ${i + 1}
              <span style="font-size:9px; color:var(--text2); background:var(--bg); padding:1px 5px; border-radius:4px;">ID: ${entry.tabId}</span>
            </div>
            <button class="btn btn-sm btnToggleRole" data-tab-id="${entry.tabId}" data-current-role="${entry.role}"
              style="font-size:10px; font-weight:bold; color:${roleColor}; background:${roleBg}; border:1px solid ${roleColor}; padding:2px 8px; border-radius:12px; cursor:pointer; transition: all 0.2s;">
              ${roleLabel}
            </button>
          </div>
          <div style="font-size:10px; color:var(--text2); display:flex; gap:6px; flex-wrap:wrap;">
            <span style="background:var(--bg); padding:2px 6px; border-radius:4px; color:var(--accent2);">Project: ${projShort}</span>
          </div>
          <div style="font-size:10px; color:var(--text2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${entry.title}">
            📑 ${entry.title}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
    updateMultiTabSummary();

    // Bind toggle role buttons
    container.querySelectorAll('.btnToggleRole').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tabId = parseInt(btn.dataset.tabId);
        const currentRole = btn.dataset.currentRole;
        const newRole = currentRole === 'video' ? 'image' : 'video';

        // Update registry
        const entry = _multiTabRegistry.find(e => e.tabId === tabId);
        if (entry) entry.role = newRole;

        // Save to storage
        const roles = await loadMultiTabRoles();
        roles[tabId] = newRole;
        await saveMultiTabRoles(roles);

        // Re-render
        refreshMultiTabList();
      });
    });

  } catch (err) {
    container.innerHTML = `<div style="color:var(--red); font-size:11px;">Lỗi: ${err.message}</div>`;
  }
}

function updateMultiTabSummary() {
  const videoCount = _multiTabRegistry.filter(t => t.role === 'video').length;
  const imageCount = _multiTabRegistry.filter(t => t.role === 'image').length;
  const totalCount = _multiTabRegistry.length;
  const elV = document.getElementById('multiTabVideoCount');
  const elI = document.getElementById('multiTabImageCount');
  const elT = document.getElementById('multiTabTotalCount');
  if (elV) elV.textContent = videoCount;
  if (elI) elI.textContent = imageCount;
  if (elT) elT.textContent = totalCount;
}

// Auto-refresh when switching to multi-tab panel
const origSwitchTab = window.switchTab;
window.switchTab = function(tabName) {
  origSwitchTab(tabName);
  if (tabName === 'multi-tab') {
    refreshMultiTabList();
  }
};

// ──────────────────────────────────────────────────────────
// monitorAndDownloadMultiTab: Sau submit, chờ 10s
// Quét mỗi 10s: còn % → đang render. Hết % → tải. Có video về = OK.
// ──────────────────────────────────────────────────────────
async function monitorAndDownloadMultiTab(tabId, timestamp, prompt, projectId, logEl) {
  const log = (msg) => {
    const t = new Date().toLocaleTimeString();
    if (logEl) logEl.textContent += `[${t}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const query = timestamp + '.';
  const maxAttempts = 24; // 24 x 15s = 6 phút
  const pollInterval = 15000;

  log(`⏳ Chờ 15s cho Flow bắt đầu render...`);
  await new Promise(r => setTimeout(r, 15000));

  for (let i = 1; i <= maxAttempts; i++) {
    log(`🔍 Quét lần ${i}/${maxAttempts}...`);

    try {
      // Check: còn % trên màn hình không?
      const checkRes = await callExt('CHECK_PERCENT_ON_SCREEN', { tabId });
      
      if (checkRes?.hasPercent) {
        log(`🔄 Đang render... (thấy "${checkRes.percentText}" trên màn hình)`);
      } else {
        // Hết % → Chờ 5s rồi kích hoạt tải
        log(`✅ Không còn % trên màn hình. Chờ 5s rồi kích hoạt tải...`);
        await new Promise(r => setTimeout(r, 5000));

        log(`🖱️ Đang chuột phải vào card và bấm Tải xuống...`);
        const dlRes = await callExt('RIGHT_CLICK_AND_DOWNLOAD', { tabId });

        if (dlRes?.success) {
          log(`🎉 THÀNH CÔNG! ${dlRes.message || 'Đã có file tải về máy.'}`);
          return { success: true, filename: dlRes.filename, filePath: dlRes.filePath || dlRes.filename };
        } else {
          log(`❌ ${dlRes?.error || 'Có lỗi xảy ra vui lòng thử lại'}`);
          return { success: false, error: 'Có lỗi xảy ra vui lòng thử lại' };
        }
      }
    } catch (err) {
      log(`⚠️ Lỗi quét: ${err.message}`);
    }

    if (i < maxAttempts) {
      await new Promise(r => setTimeout(r, pollInterval));
    }
  }

  log(`❌ Timeout 6 phút! Video chưa xong.`);
  return { success: false, error: 'Timeout after 6 minutes' };
}

// ──────────────────────────────────────────────────────────
// Theo dõi quá trình tạo Ảnh trên Tab Đa Tab & Auto Tải về
// Quét mỗi 5s: còn %/loading → đang render. Hết % → chờ 3s rồi chuột phải tải về
// ──────────────────────────────────────────────────────────
async function monitorAndDownloadImageMultiTab(tabId, timestamp, prompt, projectId, logEl) {
  const log = (msg) => {
    const t = new Date().toLocaleTimeString();
    if (logEl) logEl.textContent += `[${t}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const maxAttempts = 20; // 20 x 5s = 100s
  const pollInterval = 5000;

  log(`⏳ Chờ 6s cho Flow bắt đầu tạo ảnh...`);
  await new Promise(r => setTimeout(r, 6000));

  for (let i = 1; i <= maxAttempts; i++) {
    log(`🔍 Quét ảnh lần ${i}/${maxAttempts}...`);

    try {
      const checkRes = await callExt('CHECK_PERCENT_ON_SCREEN', { tabId });
      
      if (checkRes?.hasPercent) {
        log(`🔄 Đang tạo ảnh... (thấy "${checkRes.percentText}" trên màn hình)`);
      } else {
        log(`✅ Ảnh đã hoàn tất (không còn % loading). Chờ 3s rồi kích hoạt tải...`);
        await new Promise(r => setTimeout(r, 3000));

        log(`🖱️ Đang chuột phải vào card ảnh và bấm Tải xuống...`);
        const dlRes = await callExt('RIGHT_CLICK_AND_DOWNLOAD', { tabId });

        if (dlRes?.success) {
          log(`🎉 THÀNH CÔNG! ${dlRes.message || 'Đã có file ảnh tải về máy.'}`);
          return { success: true, filename: dlRes.filename, filePath: dlRes.filePath || dlRes.filename };
        } else {
          log(`❌ ${dlRes?.error || 'Có lỗi xảy ra vui lòng thử lại'}`);
          return { success: false, error: 'Có lỗi xảy ra vui lòng thử lại' };
        }
      }
    } catch (err) {
      log(`⚠️ Lỗi quét ảnh: ${err.message}`);
    }

    if (i < maxAttempts) {
      await new Promise(r => setTimeout(r, pollInterval));
    }
  }

  log(`❌ Timeout 100s! Ảnh chưa xong.`);
  return { success: false, error: 'Timeout after 100 seconds' };
}

// ══════════════════════════════════════════════════════════════
// MULTI-TAB SERVER QUEUE MANAGER (Nhiệm vụ từ tool_video)
// ══════════════════════════════════════════════════════════════
const _multiTabServerTasks = []; // { id, serverTaskId, mediaType, prompt, aspectRatio, ... }
const _busyMultiTabs = new Set(); // tabIds currently executing a task
let _isProcessingMultiTabQueue = false;

function renderMultiTabServerTasksUI() {
  const listEl = document.getElementById('multiTabServerTaskList');
  const badgeEl = document.getElementById('multiTabServerTaskBadge');
  if (!listEl) return;

  const total = _multiTabServerTasks.length;
  const pending = _multiTabServerTasks.filter(t => t.status === 'PENDING').length;
  const running = _multiTabServerTasks.filter(t => t.status === 'RUNNING' || t.status === 'RENDERING' || t.status === 'DOWNLOADING').length;
  const done = _multiTabServerTasks.filter(t => t.status === 'DONE').length;

  if (badgeEl) {
    badgeEl.textContent = `${done}/${total} task (${running} đang chạy, ${pending} chờ)`;
  }

  if (_multiTabServerTasks.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text2); font-size:11px; text-align:center; padding:8px;">Chưa có task nào từ server...</div>';
    return;
  }

  listEl.innerHTML = _multiTabServerTasks.map((t, idx) => {
    const isVideo = t.mediaType === 'video';
    const typeLabel = isVideo ? '🎥 Video' : '🖼️ Ảnh';
    const typeColor = isVideo ? '#00e5ff' : '#e91e63';

    let statusColor = 'var(--text2)';
    let statusText = '⏳ Chờ tab';
    if (t.status === 'RUNNING') {
      statusColor = '#00e5ff';
      statusText = t.statusDetail || '🔄 Đang gửi...';
    } else if (t.status === 'RENDERING') {
      statusColor = '#ff9800';
      statusText = t.statusDetail || '⏳ Đang render...';
    } else if (t.status === 'DOWNLOADING') {
      statusColor = '#00bcd4';
      statusText = '📥 Đang tải...';
    } else if (t.status === 'DONE') {
      statusColor = 'var(--green)';
      statusText = `✅ Xong ${t.filename ? '(' + t.filename + ')' : ''}`;
    } else if (t.status === 'ERROR') {
      statusColor = 'var(--red)';
      statusText = `❌ Lỗi: ${t.error || 'Thất bại'}`;
    }

    const tabLabel = t.tabId ? `Tab ${t.tabIndex || t.tabId}` : 'Chưa gán';

    return `
      <div style="background:var(--bg); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:6px 8px; font-size:11px; display:flex; flex-direction:column; gap:3px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-weight:bold; color:white;">#${idx + 1}</span>
            <span style="font-size:9px; font-weight:bold; padding:1px 5px; border-radius:4px; color:${typeColor}; background:rgba(255,255,255,0.06);">${typeLabel}</span>
            <span style="font-size:9px; color:var(--text2);">${tabLabel}</span>
          </div>
          <span style="font-size:10px; font-weight:bold; color:${statusColor};">${statusText}</span>
        </div>
        <div style="color:var(--text2); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${t.prompt}">
          ${t.prompt}
        </div>
      </div>
    `;
  }).join('');
}

async function addServerTaskToMultiTab(task) {
  if (!task) return { success: false, error: "Task rỗng" };

  const isVideo = task.mediaType === 'video' || (!task.mediaType && Boolean(task.duration || task.startImage || task.endImage));
  const mediaType = isVideo ? 'video' : 'image';

  const newTask = {
    id: _multiTabServerTasks.length + 1,
    serverTaskId: task.id,
    mediaType,
    projectId: task.projectId || '',
    prompt: task.prompt || '',
    aspectRatio: task.aspectRatio || (mediaType === 'video' ? '9:16' : '16:9'),
    startImage: task.startImage || null,
    endImage: task.endImage || null,
    referenceImage: task.referenceImage || null,
    referenceImages: Array.isArray(task.referenceImages) ? task.referenceImages : (task.referenceImage ? [task.referenceImage] : []),
    status: 'PENDING',
    statusDetail: 'Chờ tab rảnh...',
    tabId: null,
    tabIndex: null,
    filename: null,
    error: null,
    createdAt: Date.now()
  };

  _multiTabServerTasks.push(newTask);
  renderMultiTabServerTasksUI();

  // Tự động chuyển qua tab Đa Tab để người dùng theo dõi
  if (typeof window.switchTab === "function") {
    window.switchTab("multi-tab");
  }

  toast(`📥 [tool_video] Nhận task ${mediaType === 'video' ? 'Video' : 'Ảnh'} (${task.id || newTask.id}) vào Đa Tab!`, "info");

  // Kích hoạt worker pool xử lý hàng đợi
  triggerMultiTabServerQueueProcessing();

  return { success: true, taskId: newTask.id };
}

async function triggerMultiTabServerQueueProcessing() {
  if (_isProcessingMultiTabQueue) return;
  _isProcessingMultiTabQueue = true;

  try {
    if (_multiTabRegistry.length === 0) {
      await refreshMultiTabList();
    }

    if (_multiTabRegistry.length === 0) {
      console.warn('[MultiTab Server] Chưa có tab Flow nào!');
      return;
    }

    // Duyệt qua các task PENDING
    const pendingTasks = _multiTabServerTasks.filter(t => t.status === 'PENDING');
    if (pendingTasks.length === 0) return;

    for (const task of pendingTasks) {
      // Tìm tab phù hợp theo role và đang rảnh (!busy)
      let availableTab = _multiTabRegistry.find(t => t.role === task.mediaType && !_busyMultiTabs.has(t.tabId));

      // Fallback: nếu cần tab Ảnh nhưng chưa tab nào có vai trò Ảnh và có tab Video rảnh đang mở > 1 tab
      if (!availableTab && task.mediaType === 'image') {
        const imageTabs = _multiTabRegistry.filter(t => t.role === 'image');
        if (imageTabs.length === 0) {
          const idleVideoTab = _multiTabRegistry.find(t => t.role === 'video' && !_busyMultiTabs.has(t.tabId));
          if (idleVideoTab && _multiTabRegistry.length > 1) {
            idleVideoTab.role = 'image';
            availableTab = idleVideoTab;
            refreshMultiTabList();
          }
        }
      }

      if (availableTab) {
        _busyMultiTabs.add(availableTab.tabId);
        task.status = 'RUNNING';
        task.tabId = availableTab.tabId;
        task.tabIndex = availableTab.index + 1;
        task.statusDetail = `Tab ${task.tabIndex} đang gửi...`;
        renderMultiTabServerTasksUI();

        // Chạy worker bất đồng bộ cho task này trên tab được gán (không await ở đây để các tab khác có thể nhận song song!)
        runMultiTabServerWorker(task, availableTab);
      }
    }
  } finally {
    _isProcessingMultiTabQueue = false;
  }
}

async function runMultiTabServerWorker(task, tab) {
  const logEl = task.mediaType === 'video' 
    ? (document.getElementById('multiTabCreateLog') || document.getElementById('multiTabImgLog'))
    : (document.getElementById('multiTabImgLog') || document.getElementById('multiTabCreateLog'));

  const log = (msg) => {
    const t = new Date().toLocaleTimeString();
    if (logEl) {
      logEl.style.display = 'block';
      logEl.textContent += `[${t}] [Tab ${tab.index + 1}] ${msg}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  const ts = Date.now().toString().slice(-4);
  const fullPrompt = `${ts}. ${task.prompt}`;
  log(`🚀 Bắt đầu xử lý task #${task.id} (${task.mediaType === 'video' ? 'Video' : 'Ảnh'}): "${fullPrompt.slice(0, 40)}..."`);

  try {
    if (task.mediaType === 'video') {
      // 1. Submit Video
      task.statusDetail = 'Đang submit...';
      renderMultiTabServerTasksUI();

      const createRes = await callExt('CREATE_VIDEO_MULTI_TAB', {
        prompt: fullPrompt,
        tabId: tab.tabId,
        aspectRatio: task.aspectRatio || '9:16',
        startImageDataUrl: task.startImage || null,
        endImageDataUrl: task.endImage || null
      });

      if (!createRes?.success) {
        throw new Error(createRes?.error || 'Lỗi khi tạo video trên tab');
      }

      // 2. Theo dõi render & Tải về
      task.status = 'RENDERING';
      task.statusDetail = '⏳ Đang render...';
      renderMultiTabServerTasksUI();
      log(`✅ Đã submit video. Bắt đầu theo dõi render...`);

      // Báo server biết task đã submit → server reset timeout từ lúc này
      if (task.serverTaskId) {
        callExt('REPORT_TASK_STARTED', { id: task.serverTaskId }).catch(() => {});
      }

      const dlResult = await monitorAndDownloadMultiTab(
        tab.tabId, ts, fullPrompt, tab.projectId, logEl
      );

      if (dlResult?.success) {
        task.status = 'DONE';
        const fullFilePath = dlResult.filePath || dlResult.filename || 'video.mp4';
        task.filename = dlResult.filename || fullFilePath;
        task.statusDetail = `✅ Xong: ${task.filename}`;
        renderMultiTabServerTasksUI();
        log(`🎉 Hoàn tất Video! File: ${task.filename}`);

        // Báo kết quả về server tool_video
        if (task.serverTaskId) {
          callExt('REPORT_TOOL_VIDEO_RESULT', {
            id: task.serverTaskId,
            ok: true,
            filePath: fullFilePath
          }).catch(e => console.error('Lỗi gửi REPORT_TOOL_VIDEO_RESULT:', e));
        }
      } else {
        throw new Error(dlResult?.error || 'Lỗi tải video');
      }

    } else {
      // Xử lý Ảnh
      // 1. Chuẩn hóa referenceImages
      let refImages = [];
      if (Array.isArray(task.referenceImages) && task.referenceImages.length > 0) {
        refImages = task.referenceImages.filter(Boolean);
      } else if (task.referenceImage) {
        refImages = [task.referenceImage];
      } else if (task.startImage) {
        refImages = [task.startImage];
      }

      task.statusDetail = 'Đang submit ảnh...';
      renderMultiTabServerTasksUI();

      const createRes = await callExt('CREATE_IMAGE_MULTI_TAB', {
        prompt: fullPrompt,
        tabId: tab.tabId,
        aspectRatio: task.aspectRatio || '16:9',
        referenceImages: refImages
      });

      if (!createRes?.success) {
        throw new Error(createRes?.error || 'Lỗi khi tạo ảnh trên tab');
      }

      // 2. Theo dõi & Tải ảnh
      task.status = 'RENDERING';
      task.statusDetail = '⏳ Đang render ảnh...';
      renderMultiTabServerTasksUI();
      log(`✅ Đã submit ảnh. Bắt đầu theo dõi render...`);

      // Báo server biết task đã submit → server reset timeout từ lúc này
      if (task.serverTaskId) {
        callExt('REPORT_TASK_STARTED', { id: task.serverTaskId }).catch(() => {});
      }

      const dlResult = await monitorAndDownloadImageMultiTab(
        tab.tabId, ts, fullPrompt, tab.projectId, logEl
      );

      if (dlResult?.success) {
        task.status = 'DONE';
        const fullFilePath = dlResult.filePath || dlResult.filename || 'image.jpg';
        task.filename = dlResult.filename || fullFilePath;
        task.statusDetail = `✅ Xong: ${task.filename}`;
        renderMultiTabServerTasksUI();
        log(`🎉 Hoàn tất Ảnh! File: ${task.filename}`);

        // Báo kết quả về server tool_video
        if (task.serverTaskId) {
          callExt('REPORT_TOOL_IMAGE_RESULT', {
            id: task.serverTaskId,
            ok: true,
            filePath: fullFilePath
          }).catch(e => console.error('Lỗi gửi REPORT_TOOL_IMAGE_RESULT:', e));
        }
      } else {
        throw new Error(dlResult?.error || 'Lỗi tải ảnh');
      }
    }
  } catch (err) {
    task.status = 'ERROR';
    task.error = err.message;
    task.statusDetail = `❌ ${err.message}`;
    renderMultiTabServerTasksUI();
    log(`❌ Task #${task.id} thất bại: ${err.message}`);

    if (task.serverTaskId) {
      const reportAction = task.mediaType === 'video' ? 'REPORT_TOOL_VIDEO_RESULT' : 'REPORT_TOOL_IMAGE_RESULT';
      callExt(reportAction, {
        id: task.serverTaskId,
        ok: false,
        error: err.message
      }).catch(e => console.error(`Lỗi gửi ${reportAction}:`, e));
    }
  } finally {
    // Giải phóng tab để tab này có thể nhận task tiếp theo!
    _busyMultiTabs.delete(tab.tabId);
    triggerMultiTabServerQueueProcessing();
  }
}

// Bind refresh button
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnRefreshMultiTabs');
  if (btn) btn.addEventListener('click', refreshMultiTabList);

  // Ratio button toggle
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('multiTabRatioBtn')) {
      document.querySelectorAll('.multiTabRatioBtn').forEach(b => {
        b.classList.remove('active');
        b.style.borderColor = 'var(--border)';
        b.style.background = '';
      });
      e.target.classList.add('active');
      e.target.style.borderColor = 'var(--accent)';
    }
  });

  // Create Video button
  const createBtn = document.getElementById('btnCreateVideoMultiTab');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const prompt = document.getElementById('multiTabPrompt')?.value?.trim();
      if (!prompt) { alert('Nhập prompt đã sếp ơi!'); return; }

      const ratioBtn = document.querySelector('.multiTabRatioBtn.active');
      const ratio = ratioBtn?.dataset?.ratio || '9:16';

      // Tìm tab video rảnh
      if (_multiTabRegistry.length === 0) {
        await refreshMultiTabList();
      }
      const videoTab = _multiTabRegistry.find(t => t.role === 'video');
      if (!videoTab) {
        alert('Không có tab nào được gán vai trò Video! Hãy quét tab và gán vai trò trước.');
        return;
      }

      // Generate timestamp
      const ts = Date.now().toString().slice(-4);
      const fullPrompt = `${ts}. ${prompt}`;

      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) {
        logEl.style.display = 'block';
        logEl.textContent = `⏳ [${new Date().toLocaleTimeString()}] Đang gửi "${fullPrompt.slice(0, 50)}..." tới Tab ${videoTab.tabId}...\n`;
      }

      createBtn.disabled = true;
      createBtn.textContent = '⏳ Đang xử lý...';

      try {
        const res = await callExt('CREATE_VIDEO_MULTI_TAB', {
          prompt: fullPrompt,
          tabId: videoTab.tabId,
          aspectRatio: ratio
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ [${new Date().toLocaleTimeString()}] Thành công! ${res.message}\n`;

          // Bắt đầu monitor + auto download
          createBtn.textContent = '🔍 Đang theo dõi render...';
          const dlResult = await monitorAndDownloadMultiTab(
            videoTab.tabId, ts, prompt, videoTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filePath || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ [${new Date().toLocaleTimeString()}] Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ [${new Date().toLocaleTimeString()}] Exception: ${err.message}\n`;
      }

      createBtn.disabled = false;
      createBtn.textContent = '🚀 Tạo Video';
    });
  }

  // Test Start Frame button
  const testFrameBtn = document.getElementById('btnTestStartFrame');
  if (testFrameBtn) {
    testFrameBtn.addEventListener('click', async () => {
      if (_multiTabRegistry.length === 0) await refreshMultiTabList();
      const videoTab = _multiTabRegistry.find(t => t.role === 'video');
      if (!videoTab) { alert('Không có tab Video! Quét tab trước.'); return; }

      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) { logEl.style.display = 'block'; logEl.textContent = '⏳ Đang đọc ảnh start frame...\n'; }
      testFrameBtn.disabled = true;
      testFrameBtn.textContent = '⏳ Đang xử lý...';

      try {
        // Đọc ảnh từ extension folder → data URL
        const imgUrl = chrome.runtime.getURL('test_start_frame.jpg');
        const resp = await fetch(imgUrl);
        const blob = await resp.blob();
        const dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });

        if (logEl) logEl.textContent += `✅ Đã đọc ảnh (${(blob.size / 1024).toFixed(0)} KB). Gửi tới Tab ${videoTab.tabId}...\n`;

        const ts = Date.now().toString().slice(-4);
        const prompt = `${ts}. cho cô gái này nhảy điệu nhảy sôi động cháy bỏng`;

        const ratioBtn = document.querySelector('.multiTabRatioBtn.active');
        const selectedRatio = ratioBtn?.dataset?.ratio || '16:9';

        const res = await callExt('CREATE_VIDEO_MULTI_TAB', {
          prompt,
          tabId: videoTab.tabId,
          aspectRatio: selectedRatio,
          startImageDataUrl: dataUrl
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ ${res.message}\n`;

          // Bắt đầu monitor + auto download
          testFrameBtn.textContent = '🔍 Đang theo dõi render...';
          const dlResult = await monitorAndDownloadMultiTab(
            videoTab.tabId, ts, prompt, videoTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filePath || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      testFrameBtn.disabled = false;
      testFrameBtn.textContent = '🧪 Test: Start Frame (Cô gái nhảy)';
    });
  }

  // Test Start + End Frame button
  const testStartEndBtn = document.getElementById('btnTestStartEndFrame');
  if (testStartEndBtn) {
    testStartEndBtn.addEventListener('click', async () => {
      if (_multiTabRegistry.length === 0) await refreshMultiTabList();
      const videoTab = _multiTabRegistry.find(t => t.role === 'video');
      if (!videoTab) { alert('Không có tab Video! Quét tab trước.'); return; }

      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) { logEl.style.display = 'block'; logEl.textContent = '⏳ Đang đọc 2 ảnh...\n'; }
      testStartEndBtn.disabled = true;
      testStartEndBtn.textContent = '⏳ Đang xử lý...';

      try {
        // Đọc cả 2 ảnh
        const loadImg = async (name) => {
          const url = chrome.runtime.getURL(name);
          const resp = await fetch(url);
          const blob = await resp.blob();
          return new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        };

        const startDataUrl = await loadImg('test_start_frame.jpg');
        const endDataUrl = await loadImg('test_end_frame.jpg');
        if (logEl) logEl.textContent += `✅ Đã đọc 2 ảnh. Gửi tới Tab ${videoTab.tabId}...\n`;

        const ts = Date.now().toString().slice(-4);
        const prompt = `${ts}. cô gái biến hình thành chiến binh H9 Gunner với hiệu ứng ánh sáng neon`;

        const ratioBtn = document.querySelector('.multiTabRatioBtn.active');
        const selectedRatio = ratioBtn?.dataset?.ratio || '16:9';

        const res = await callExt('CREATE_VIDEO_MULTI_TAB', {
          prompt,
          tabId: videoTab.tabId,
          aspectRatio: selectedRatio,
          startImageDataUrl: startDataUrl,
          endImageDataUrl: endDataUrl
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ ${res.message}\n`;
          testStartEndBtn.textContent = '🔍 Đang theo dõi render...';
          const dlResult = await monitorAndDownloadMultiTab(
            videoTab.tabId, ts, prompt, videoTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filePath || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      testStartEndBtn.disabled = false;
      testStartEndBtn.textContent = '🧪 Test: Start + End Frame (Cô gái → H9 Gunner)';
    });
  }

  // Test: Prompt 16:9 (Không ảnh)
  const test169Btn = document.getElementById('btnTestPrompt169');
  if (test169Btn) {
    test169Btn.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) logEl.style.display = 'block';

      if (_multiTabRegistry.length === 0) await refreshMultiTabList();
      const videoTab = _multiTabRegistry.find(t => t.role === 'video');
      if (!videoTab) { alert('Không có tab Video!'); return; }

      test169Btn.disabled = true;
      test169Btn.textContent = '⏳ Đang tạo video 16:9...';

      const ts = Date.now().toString().slice(-4);
      const prompt = `${ts}. siêu xe thể thao màu đen bóng lao vun vút trên đường cao tốc ven biển lúc hoàng hôn, góc máy cinematic 4k`;

      if (logEl) logEl.textContent += `\n[${new Date().toLocaleTimeString()}] 🎬 Bắt đầu test video 16:9 (chỉ prompt) trên Tab ${videoTab.tabId}...\n`;

      try {
        const res = await callExt('CREATE_VIDEO_MULTI_TAB', {
          prompt,
          tabId: videoTab.tabId,
          aspectRatio: '16:9',
          startImageDataUrl: null,
          endImageDataUrl: null
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ ${res.message}\n`;
          test169Btn.textContent = '🔍 Đang theo dõi render...';
          const dlResult = await monitorAndDownloadMultiTab(
            videoTab.tabId, ts, prompt, videoTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filename || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      test169Btn.disabled = false;
      test169Btn.textContent = '🧪 Test: Prompt 16:9 (Không ảnh)';
    });
  }

  // Debug: Vẽ vùng trên STT
  const drawBtn = document.getElementById('btnDrawAboveSTT');
  if (drawBtn) {
    drawBtn.addEventListener('click', async () => {
      if (_multiTabRegistry.length === 0) await refreshMultiTabList();
      const videoTab = _multiTabRegistry.find(t => t.role === 'video');
      if (!videoTab) { alert('Không có tab Video!'); return; }

      await callExt('DRAW_ABOVE_STT', { tabId: videoTab.tabId });
    });
  }

  // Test: Bấm nút Tải xuống
  const testDlBtn = document.getElementById('btnTestClickDownload');
  if (testDlBtn) {
    testDlBtn.addEventListener('click', async () => {
      if (_multiTabRegistry.length === 0) await refreshMultiTabList();
      const videoTab = _multiTabRegistry.find(t => t.role === 'video');
      if (!videoTab) { alert('Không có tab Video!'); return; }

      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) { logEl.style.display = 'block'; logEl.textContent += `[${new Date().toLocaleTimeString()}] 📥 Đang thử bấm nút Tải xuống trên Tab ${videoTab.tabId}...\n`; }

      const res = await callExt('TEST_CLICK_DOWNLOAD', { tabId: videoTab.tabId });
      if (res?.success) {
        if (logEl) logEl.textContent += `[${new Date().toLocaleTimeString()}] ✅ ${res.message}\n`;
      } else {
        if (logEl) logEl.textContent += `[${new Date().toLocaleTimeString()}] ❌ ${res?.error || 'Không tìm thấy nút tải'}\n`;
      }
    });
  }

  // Test: Chuột phải card & Tải xuống
  const rightClickDlBtn = document.getElementById('btnRightClickAndDownload');
  if (rightClickDlBtn) {
    rightClickDlBtn.addEventListener('click', async () => {
      if (_multiTabRegistry.length === 0) await refreshMultiTabList();
      const videoTab = _multiTabRegistry.find(t => t.role === 'video');
      if (!videoTab) { alert('Không có tab Video!'); return; }

      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) { logEl.style.display = 'block'; logEl.textContent += `[${new Date().toLocaleTimeString()}] 🖱️ Chuột phải card & bấm Tải xuống trên Tab ${videoTab.tabId}...\n`; }

      const res = await callExt('RIGHT_CLICK_AND_DOWNLOAD', { tabId: videoTab.tabId });
      if (res?.success) {
        if (logEl) logEl.textContent += `[${new Date().toLocaleTimeString()}] ✅ ${res.message}\n`;
      } else {
        if (logEl) logEl.textContent += `[${new Date().toLocaleTimeString()}] ❌ ${res?.error || 'Không tải được'}\n`;
      }
    });
  }

  // ── Debug: Vẽ vòng tròn lên nút Tải / 50px trên nút Tải ──
  const drawScript = (offsetY) => async () => {
    if (_multiTabRegistry.length === 0) await refreshMultiTabList();
    const videoTab = _multiTabRegistry.find(t => t.role === 'video') || _multiTabRegistry[0];
    if (!videoTab) { alert('Không có tab nào!'); return; }

    const logEl = document.getElementById('multiTabCreateLog');
    if (logEl) logEl.style.display = 'block';

    const res = await chrome.scripting.executeScript({
      target: { tabId: videoTab.tabId },
      world: 'ISOLATED',
      args: [offsetY],
      func: (yOffset) => {
        // Tìm nút download (↓) trong card gần nhất — ưu tiên card cuối cùng
        const isDownloadBtn = (el) => {
          if (!el || el.tagName !== 'BUTTON') return false;
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          const html = (el.innerHTML || '').toLowerCase();
          return aria.includes('download') || aria.includes('tải') ||
                 title.includes('download') || title.includes('tải') ||
                 text === 'download' || text === 'tải xuống' ||
                 html.includes('download') ||
                 html.includes('file_download') || html.includes('save_alt') ||
                 // Material icon text
                 text === 'file_download' || text === 'save_alt' ||
                 // SVG path check for download arrow shape (path d contains M with vertical line)
                 (el.querySelector('svg') !== null && (
                   aria.includes('download') || title.includes('download') ||
                   // First button in the action row below a card (heuristic)
                   false
                 ));
        };

        // Lấy tất cả button nhìn thấy được
        const allBtns = Array.from(document.querySelectorAll('button')).filter(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        let dlBtn = allBtns.find(isDownloadBtn);

        // Fallback: tìm nhóm 3 nút liền nhau (download/redo/delete) dưới card
        // → lấy nút đầu tiên của nhóm đó
        if (!dlBtn) {
          // Tìm nút có SVG và nằm trong row nhỏ (width 20-50px)
          const smallBtns = allBtns.filter(b => {
            const r = b.getBoundingClientRect();
            return r.width >= 20 && r.width <= 60 && r.height >= 20 && r.height <= 60 &&
                   b.querySelector('svg, [class*="icon"], [class*="material"]');
          });

          // Tìm nhóm 3 nút gần nhau theo chiều ngang (cùng y ± 5px)
          for (let i = 0; i < smallBtns.length - 1; i++) {
            const r1 = smallBtns[i].getBoundingClientRect();
            const r2 = smallBtns[i+1]?.getBoundingClientRect();
            const r3 = smallBtns[i+2]?.getBoundingClientRect();
            if (r2 && r3 &&
                Math.abs(r1.top - r2.top) < 10 &&
                Math.abs(r1.top - r3.top) < 10 &&
                r2.left > r1.right - 10 &&
                r3.left > r2.right - 10) {
              dlBtn = smallBtns[i]; // nút đầu = download
              break;
            }
          }
        }

        if (!dlBtn) return { success: false, error: 'Không tìm thấy nút Tải' };

        const rect = dlBtn.getBoundingClientRect();
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2) + yOffset; // yOffset = 0 hoặc -50

        // Vẽ vòng tròn
        const circle = document.createElement('div');
        const color = yOffset === 0 ? '#00e5ff' : '#ff4444';
        const label = yOffset === 0 ? '🔵 Nút Tải' : '🔴 +50px trên';
        circle.style.cssText = `
          position:fixed; left:${cx - 14}px; top:${cy - 14}px;
          width:28px; height:28px; border-radius:50%;
          background:${color}55; border:3px solid ${color};
          z-index:9999999; pointer-events:none;
          box-shadow:0 0 12px ${color};
        `;

        // Label
        const lbl = document.createElement('div');
        lbl.style.cssText = `
          position:fixed; left:${cx + 16}px; top:${cy - 10}px;
          background:${color}; color:#000; font-size:11px; font-weight:bold;
          padding:2px 6px; border-radius:4px; z-index:9999999; pointer-events:none;
          white-space:nowrap;
        `;
        lbl.textContent = `${label} (${cx}, ${cy})`;

        document.body.appendChild(circle);
        document.body.appendChild(lbl);
        setTimeout(() => { circle.remove(); lbl.remove(); }, 5000);

        return { success: true, cx, cy, btnText: (dlBtn.innerText || '').trim().slice(0, 20) };
      }
    });

    const result = res?.[0]?.result;
    if (logEl) {
      const msg = result?.success
        ? `✅ Vẽ tại (${result.cx}, ${result.cy}) — btn: "${result.btnText || '?'}"`
        : `❌ ${result?.error || 'Lỗi'}`;
      logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  const drawOnBtn = document.getElementById('btnDrawOnDownloadBtn');
  if (drawOnBtn) drawOnBtn.addEventListener('click', drawScript(0));

  const drawAboveBtn = document.getElementById('btnDrawAboveDownloadBtn');
  if (drawAboveBtn) drawAboveBtn.addEventListener('click', drawScript(-70));


  // ──────────────────────────────────────────────────────────
  const btnBatch10 = document.getElementById('btnBatch10Tasks');
  if (btnBatch10) {
    btnBatch10.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) logEl.style.display = 'block';

      const log = (msg) => {
        const t = new Date().toLocaleTimeString();
        if (logEl) logEl.textContent += `[${t}] ${msg}\n`;
        logEl.scrollTop = logEl.scrollHeight;
      };

      // 1. Quét danh sách Tab
      log('🔍 Đang kiểm tra danh sách tab Google Flow...');
      await refreshMultiTabList();

      const videoTabs = _multiTabRegistry.filter(t => t.role === 'video');
      if (videoTabs.length === 0) {
        alert('Không tìm thấy tab nào có vai trò "Video"! Vui lòng mở ít nhất 1 tab Google Flow và gán vai trò Video.');
        return;
      }

      log(`✅ Tìm thấy ${videoTabs.length} tab Video (ID: ${videoTabs.map(t => t.tabId).join(', ')})`);

      btnBatch10.disabled = true;
      btnBatch10.textContent = '⏳ Đang chạy 10 Task Đa Tab...';

      const ratioBtn = document.querySelector('.multiTabRatioBtn.active');
      const selectedRatio = ratioBtn?.dataset?.ratio || '16:9';
      log(`🎯 Tỉ lệ áp dụng cho 10 Task: ${selectedRatio}`);

      // 2. Tải 2 ảnh test sẵn vào bộ nhớ (Base64 DataURL)
      let startImgDataUrl = null;
      let endImgDataUrl = null;
      try {
        const sRes = await fetch(chrome.runtime.getURL('test_start_frame.jpg'));
        const sBlob = await sRes.blob();
        startImgDataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(sBlob); });
      } catch (e) { log(`⚠️ Không load được test_start_frame.jpg: ${e.message}`); }

      try {
        const eRes = await fetch(chrome.runtime.getURL('test_end_frame.jpg'));
        const eBlob = await eRes.blob();
        endImgDataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(eBlob); });
      } catch (e) { log(`⚠️ Không load được test_end_frame.jpg: ${e.message}`); }

      // 3. Danh sách 10 task đa dạng đủ các thể loại và tỉ lệ (16:9 & 9:16)
      const tasks = [
        { id: 1, type: 'text', typeName: '📝 Text', ratio: '16:9', color: '#00e5ff', prompt: 'con mèo con lông trắng đuổi theo cuộn len đỏ trong phòng khách' },
        { id: 2, type: 'start', typeName: '🎬 Start', ratio: '9:16', color: '#e91e63', prompt: 'cô gái nhảy điệu nhảy hiphop sôi động trên đường phố đêm neon rực rỡ' },
        { id: 3, type: 'start_end', typeName: '🎭 Start+End', ratio: '16:9', color: '#9c27b0', prompt: 'cô gái biến hình thành chiến binh H9 Gunner với hiệu ứng ánh sáng neon' },
        { id: 4, type: 'text', typeName: '📝 Text', ratio: '9:16', color: '#00e5ff', prompt: 'siêu xe thể thao màu đen bóng lao vun vút trên đường cao tốc ven biển hoàng hôn' },
        { id: 5, type: 'start', typeName: '🎬 Start', ratio: '16:9', color: '#e91e63', prompt: 'cô gái xoay người mỉm cười trước ống kính máy quay phong cách điện ảnh 4k' },
        { id: 6, type: 'text', typeName: '📝 Text', ratio: '16:9', color: '#00e5ff', prompt: 'chú chó shiba inu đeo kính râm ngồi trên thuyền lướt sóng vui nhộn' },
        { id: 7, type: 'start_end', typeName: '🎭 Start+End', ratio: '9:16', color: '#9c27b0', prompt: 'cô gái trang bị áo giáp công nghệ cao H9 Gunner sẵn sàng chiến đấu' },
        { id: 8, type: 'start', typeName: '🎬 Start', ratio: '9:16', color: '#e91e63', prompt: 'cô gái dạo bước dưới cơn mưa rào mùa hạ, ánh đèn phản chiếu lấp lánh' },
        { id: 9, type: 'text', typeName: '📝 Text', ratio: '16:9', color: '#00e5ff', prompt: 'phi thuyền không gian khổng lồ bay xuyên qua vành đai tiểu hành tinh rực sáng' },
        { id: 10, type: 'start_end', typeName: '🎭 Start+End', ratio: '9:16', color: '#9c27b0', prompt: 'hiệu ứng hạt ánh sáng biến đổi từ cô gái sang người máy H9 Gunner ma mị' }
      ];

      // 4. Render danh sách 10 task lên giao diện
      const statusContainer = document.getElementById('batch10StatusContainer');
      const taskListEl = document.getElementById('batch10TaskList');
      const progressBadge = document.getElementById('batch10ProgressBadge');
      if (statusContainer) statusContainer.style.display = 'block';
      if (progressBadge) progressBadge.textContent = `0/${tasks.length}`;

      if (taskListEl) {
        taskListEl.innerHTML = tasks.map(t => `
          <div id="batch10_row_${t.id}" style="background:var(--bg); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:bold; color:white;">#${t.id}</span>
                <span style="font-size:9px; padding:1px 5px; border-radius:4px; font-weight:bold; background:rgba(255,255,255,0.08); color:${t.color};">${t.typeName}</span>
                <span style="font-size:9px; padding:1px 5px; border-radius:4px; font-weight:bold; background:${t.ratio === '16:9' ? 'rgba(0,229,255,0.12)' : 'rgba(255,152,0,0.12)'}; color:${t.ratio === '16:9' ? '#00e5ff' : '#ff9800'};">${t.ratio}</span>
                <span id="batch10_tab_${t.id}" style="font-size:9px; color:var(--text2);">⏳ Đang chờ...</span>
              </div>
              <div style="font-size:10px; color:var(--text2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${t.prompt}">
                ${t.prompt}
              </div>
            </div>
            <div id="batch10_status_${t.id}" style="font-size:10px; font-weight:bold; color:var(--text2); white-space:nowrap;">
              ⏳ Chờ
            </div>
          </div>
        `).join('');
      }

      // 5. Worker Pool chia tab quản lý
      const queue = [...tasks];
      let completedCount = 0;

      const runWorkerForTab = async (tab, workerIdx) => {
        const tabLabel = `Tab ${tab.index + 1}`;
        while (queue.length > 0) {
          const task = queue.shift();

          const statusEl = document.getElementById(`batch10_status_${task.id}`);
          const tabEl = document.getElementById(`batch10_tab_${task.id}`);
          const rowEl = document.getElementById(`batch10_row_${task.id}`);

          if (tabEl) {
            tabEl.textContent = `📌 ${tabLabel} (ID: ${tab.tabId})`;
            tabEl.style.color = 'var(--accent2)';
          }
          if (statusEl) {
            statusEl.textContent = '🔄 Đang gửi...';
            statusEl.style.color = '#00e5ff';
          }
          if (rowEl) rowEl.style.borderColor = '#00e5ff';

          const sImg = (task.type === 'start' || task.type === 'start_end') ? startImgDataUrl : null;
          const eImg = (task.type === 'start_end') ? endImgDataUrl : null;
          const timestamp = Date.now().toString().slice(-4);
          const fullPrompt = `${timestamp}. ${task.prompt}`;
          const taskRatio = task.ratio || '16:9';

          log(`[${tabLabel}] 🚀 Bắt đầu Task #${task.id} (${task.typeName}, ${taskRatio}): "${fullPrompt.slice(0, 35)}..."`);

          try {
            // Bước 1: Tạo Video trên tab được phân bổ
            const createRes = await callExt('CREATE_VIDEO_MULTI_TAB', {
              prompt: fullPrompt,
              tabId: tab.tabId,
              aspectRatio: taskRatio,
              startImageDataUrl: sImg,
              endImageDataUrl: eImg
            });

            if (!createRes?.success) {
              throw new Error(createRes?.error || 'Lỗi khi tạo video');
            }

            if (statusEl) {
              statusEl.textContent = '⏳ Đang render...';
              statusEl.style.color = '#ff9800';
            }
            log(`[${tabLabel}] ✅ Đã submit Task #${task.id}. Đang theo dõi...`);

            // Bước 2: Quét % → Hết % → Chờ 5s → Chuột phải tải → Chờ 5s kiểm tra file
            const monRes = await monitorAndDownloadMultiTab(tab.tabId, timestamp, fullPrompt, tab.projectId, logEl);

            if (monRes?.success) {
              if (statusEl) {
                statusEl.textContent = '✅ Xong';
                statusEl.style.color = 'var(--green)';
              }
              if (rowEl) rowEl.style.borderColor = 'rgba(16,185,129,0.4)';
              log(`[${tabLabel}] 🎉 HOÀN TẤT Task #${task.id} (${monRes.filename || 'Đã có file'})!`);
            } else {
              if (statusEl) {
                statusEl.textContent = '❌ Lỗi tải';
                statusEl.style.color = 'var(--accent)';
              }
              if (rowEl) rowEl.style.borderColor = 'rgba(244,67,54,0.4)';
              log(`[${tabLabel}] ❌ Task #${task.id} thất bại: ${monRes?.error || 'Có lỗi xảy ra'}`);
            }
          } catch (taskErr) {
            if (statusEl) {
              statusEl.textContent = '❌ Thất bại';
              statusEl.style.color = 'var(--accent)';
            }
            if (rowEl) rowEl.style.borderColor = 'rgba(244,67,54,0.4)';
            log(`[${tabLabel}] ❌ Task #${task.id} gặp lỗi: ${taskErr.message}`);
          }

          completedCount++;
          if (progressBadge) progressBadge.textContent = `${completedCount}/${tasks.length}`;
        }
      };

      // Chạy song song các Worker trên tất cả các tab Video đang mở
      log(`⚡ Chia đều 10 task chạy trên ${videoTabs.length} tab song song...`);
      await Promise.all(videoTabs.map((tab, idx) => runWorkerForTab(tab, idx)));

      log(`🏁 TẤT CẢ 10 TASK ĐÃ ĐƯỢC XỬ LÝ XONG! (${completedCount}/${tasks.length})`);
      btnBatch10.disabled = false;
      btnBatch10.textContent = '⚡ Chạy Test 10 Task Đa Tab (Đủ loại: Text, Start, Start+End)';
    });
  }

  // ──────────────────────────────────────────────────────────
  // Test Tạo Ảnh Đa Tab (Prompt 9:16, 16:9, 1 Ref, Nhiều Ref)
  // ──────────────────────────────────────────────────────────
  const loadLocalImageAsDataUrl = async (filename) => {
    const url = chrome.runtime.getURL(filename);
    const resp = await fetch(url);
    const blob = await resp.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  };

  const getImageTargetTab = async () => {
    if (_multiTabRegistry.length === 0) await refreshMultiTabList();
    const imgTab = _multiTabRegistry.find(t => t.role === 'image') || _multiTabRegistry[0];
    return imgTab;
  };

  // 1. Test Ảnh: Prompt 9:16 (Không ảnh)
  const testImg916Btn = document.getElementById('btnTestImgPrompt916');
  if (testImg916Btn) {
    testImg916Btn.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabImgLog') || document.getElementById('multiTabCreateLog');
      if (logEl) logEl.style.display = 'block';

      const imgTab = await getImageTargetTab();
      if (!imgTab) { alert('Không có tab Google Flow nào! Vui lòng mở hoặc quét tab.'); return; }

      testImg916Btn.disabled = true;
      testImg916Btn.textContent = '⏳ Đang tạo ảnh 9:16...';

      const ts = Date.now().toString().slice(-4);
      const prompt = `${ts}. chân dung nghệ thuật cô gái Á Đông mặc áo dài trắng truyền thống giữa vườn hoa sen mùa hạ, ánh sáng vàng chiều tà dịu dàng, chi tiết 8k cực nét`;

      if (logEl) logEl.textContent += `\n[${new Date().toLocaleTimeString()}] 🖼️ Bắt đầu test tạo ảnh 9:16 (chỉ prompt) trên Tab ${imgTab.tabId}...\n`;

      try {
        const res = await callExt('CREATE_IMAGE_MULTI_TAB', {
          prompt,
          tabId: imgTab.tabId,
          aspectRatio: '9:16',
          referenceImages: []
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ ${res.message}\n`;
          testImg916Btn.textContent = '🔍 Đang theo dõi tạo ảnh...';
          const dlResult = await monitorAndDownloadImageMultiTab(
            imgTab.tabId, ts, prompt, imgTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filename || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      testImg916Btn.disabled = false;
      testImg916Btn.textContent = '🖼️ Test Ảnh: Prompt 9:16 (Không ảnh)';
    });
  }

  // 2. Test Ảnh: Prompt 16:9 (Không ảnh)
  const testImg169Btn = document.getElementById('btnTestImgPrompt169');
  if (testImg169Btn) {
    testImg169Btn.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabImgLog') || document.getElementById('multiTabCreateLog');
      if (logEl) logEl.style.display = 'block';

      const imgTab = await getImageTargetTab();
      if (!imgTab) { alert('Không có tab Google Flow nào! Vui lòng mở hoặc quét tab.'); return; }

      testImg169Btn.disabled = true;
      testImg169Btn.textContent = '⏳ Đang tạo ảnh 16:9...';

      const ts = Date.now().toString().slice(-4);
      const prompt = `${ts}. phong cảnh kỳ vĩ dãy núi Alps phủ tuyết trắng phản chiếu trên mặt hồ pha lê tĩnh lặng lúc bình minh rực rỡ, góc máy rộng cinematic`;

      if (logEl) logEl.textContent += `\n[${new Date().toLocaleTimeString()}] 🖼️ Bắt đầu test tạo ảnh 16:9 (chỉ prompt) trên Tab ${imgTab.tabId}...\n`;

      try {
        const res = await callExt('CREATE_IMAGE_MULTI_TAB', {
          prompt,
          tabId: imgTab.tabId,
          aspectRatio: '16:9',
          referenceImages: []
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ ${res.message}\n`;
          testImg169Btn.textContent = '🔍 Đang theo dõi tạo ảnh...';
          const dlResult = await monitorAndDownloadImageMultiTab(
            imgTab.tabId, ts, prompt, imgTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filename || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      testImg169Btn.disabled = false;
      testImg169Btn.textContent = '🖼️ Test Ảnh: Prompt 16:9 (Không ảnh)';
    });
  }

  // 3. Test Ảnh: 1 Ảnh Tham Chiếu
  const testImg1RefBtn = document.getElementById('btnTestImg1Ref');
  if (testImg1RefBtn) {
    testImg1RefBtn.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabImgLog') || document.getElementById('multiTabCreateLog');
      if (logEl) { logEl.style.display = 'block'; logEl.textContent += `⏳ Đang đọc ảnh tham chiếu...\n`; }

      const imgTab = await getImageTargetTab();
      if (!imgTab) { alert('Không có tab Google Flow nào! Vui lòng mở hoặc quét tab.'); return; }

      testImg1RefBtn.disabled = true;
      testImg1RefBtn.textContent = '⏳ Đang xử lý...';

      try {
        const startDataUrl = await loadLocalImageAsDataUrl('test_start_frame.jpg');
        if (logEl) logEl.textContent += `✅ Đã đọc ảnh tham chiếu (test_start_frame.jpg). Gửi tới Tab ${imgTab.tabId}...\n`;

        const ts = Date.now().toString().slice(-4);
        const prompt = `${ts}. chân dung nghệ thuật sang trọng lấy cảm hứng từ nhân vật trong ảnh tham chiếu, ánh sáng studio nghệ thuật chuyên nghiệp`;

        const res = await callExt('CREATE_IMAGE_MULTI_TAB', {
          prompt,
          tabId: imgTab.tabId,
          aspectRatio: '9:16',
          referenceImageDataUrl: startDataUrl,
          referenceImages: [startDataUrl]
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ ${res.message}\n`;
          testImg1RefBtn.textContent = '🔍 Đang theo dõi tạo ảnh...';
          const dlResult = await monitorAndDownloadImageMultiTab(
            imgTab.tabId, ts, prompt, imgTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filename || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      testImg1RefBtn.disabled = false;
      testImg1RefBtn.textContent = '🖼️ Test Ảnh: 1 Ảnh Tham Chiếu';
    });
  }

  // 4. Test Ảnh: Nhiều Ảnh Tham Chiếu (2 ảnh)
  const testImgMultiRefBtn = document.getElementById('btnTestImgMultiRef');
  if (testImgMultiRefBtn) {
    testImgMultiRefBtn.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabImgLog') || document.getElementById('multiTabCreateLog');
      if (logEl) {
        logEl.style.display = 'block';
        logEl.textContent += `\n[${new Date().toLocaleTimeString()}] 🖼️ Bắt đầu test tạo ảnh: Nhiều Ảnh Tham Chiếu (2 ảnh)...\n`;
        logEl.textContent += `⏳ Đang đọc 2 ảnh tham chiếu (test_start_frame.jpg + test_end_frame.jpg)...\n`;
      }

      const imgTab = await getImageTargetTab();
      if (!imgTab) { alert('Không có tab Google Flow nào! Vui lòng mở hoặc quét tab.'); return; }

      testImgMultiRefBtn.disabled = true;
      testImgMultiRefBtn.textContent = '⏳ Đang xử lý...';

      try {
        const [img1, img2] = await Promise.all([
          loadLocalImageAsDataUrl('test_start_frame.jpg'),
          loadLocalImageAsDataUrl('test_end_frame.jpg')
        ]);
        if (logEl) logEl.textContent += `✅ Đã đọc 2 ảnh tham chiếu. Gửi tới Tab ${imgTab.tabId} (Ctrl+V nạp cả 2 ảnh cùng lúc)...\n`;

        const ts = Date.now().toString().slice(-4);
        const prompt = `${ts}. sự kết hợp phong cách: nhân vật nữ từ ảnh 1 khoác trang phục chiến binh tương lai từ ảnh 2, ánh sáng neon cyberpunk`;

        const res = await callExt('CREATE_IMAGE_MULTI_TAB', {
          prompt,
          tabId: imgTab.tabId,
          aspectRatio: '16:9',
          referenceImageDataUrl: img1,
          secondImageDataUrl: img2,
          referenceImages: [img1, img2]
        });

        if (res?.success) {
          if (logEl) logEl.textContent += `✅ ${res.message}\n`;
          testImgMultiRefBtn.textContent = '🔍 Đang theo dõi tạo ảnh...';
          const dlResult = await monitorAndDownloadImageMultiTab(
            imgTab.tabId, ts, prompt, imgTab.projectId, logEl
          );
          if (dlResult?.success) {
            if (logEl) logEl.textContent += `🎉 HOÀN TẤT! File: ${dlResult.filename || 'OK'}\n`;
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      testImgMultiRefBtn.disabled = false;
      testImgMultiRefBtn.textContent = '🖼️ Test Ảnh: Nhiều Ảnh Tham Chiếu (2 ảnh)';
    });
  }

  // 5. Test Chỉ Dán (Ctrl+V) 2 Ảnh (Không Submit)
  const testPaste2ImagesBtn = document.getElementById('btnTestPaste2Images');
  if (testPaste2ImagesBtn) {
    testPaste2ImagesBtn.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabImgLog') || document.getElementById('multiTabCreateLog');
      if (logEl) {
        logEl.style.display = 'block';
        logEl.textContent = `[${new Date().toLocaleTimeString()}] 🧪 Bắt đầu test dán 2 ảnh (Không Submit)...\n`;
      }

      const imgTab = await getImageTargetTab();
      if (!imgTab) { alert('Không có tab Google Flow nào! Vui lòng mở hoặc quét tab.'); return; }

      testPaste2ImagesBtn.disabled = true;
      testPaste2ImagesBtn.textContent = '⏳ Đang test dán 2 ảnh...';

      try {
        const [img1, img2] = await Promise.all([
          loadLocalImageAsDataUrl('test_start_frame.jpg'),
          loadLocalImageAsDataUrl('test_end_frame.jpg')
        ]);
        if (logEl) logEl.textContent += `✅ Đã đọc 2 file ảnh local. Gửi lệnh tới Tab ${imgTab.tabId}...\n`;

        const res = await callExt('TEST_PASTE_TWO_IMAGES', {
          tabId: imgTab.tabId,
          img1,
          img2,
          delayBetween: 2000
        });

        if (res?.success) {
          if (logEl) {
            logEl.textContent += `\n--- KẾT QUẢ TEST DÁN 2 ẢNH ---\n`;
            if (Array.isArray(res.logs)) {
              logEl.textContent += res.logs.join('\n') + '\n';
            } else {
              logEl.textContent += `${res.message || 'OK'}\n`;
            }
          }
        } else {
          if (logEl) logEl.textContent += `❌ Lỗi: ${res?.error || 'Unknown'}\n`;
        }
      } catch (err) {
        if (logEl) logEl.textContent += `❌ Exception: ${err.message}\n`;
      }

      testPaste2ImagesBtn.disabled = false;
      testPaste2ImagesBtn.textContent = '🧪 Test Chỉ Dán (Ctrl+V) 2 Ảnh (Không Submit)';
    });
  }


  // ──────────────────────────────────────────────────────────
  // Test 100 Task Đa Tab (Video + Ảnh đan xen, đủ loại + vi phạm)
  // ──────────────────────────────────────────────────────────
  const btnBatch100 = document.getElementById('btnBatch100Tasks');
  if (btnBatch100) {
    btnBatch100.addEventListener('click', async () => {
      const logEl = document.getElementById('multiTabCreateLog');
      if (logEl) logEl.style.display = 'block';

      const log = (msg) => {
        const t = new Date().toLocaleTimeString();
        if (logEl) { logEl.textContent += `[${t}] ${msg}\n`; logEl.scrollTop = logEl.scrollHeight; }
      };

      log('🔍 Đang quét tab Google Flow...');
      await refreshMultiTabList();

      const allTabs = _multiTabRegistry;
      if (allTabs.length === 0) {
        alert('Không tìm thấy tab nào! Vui lòng mở ít nhất 1 tab Google Flow và quét tab trước.');
        return;
      }

      btnBatch100.disabled = true;
      btnBatch100.textContent = '⏳ Đang chạy 100 Task...';

      // Tải ảnh test
      let startImgDataUrl = null;
      let endImgDataUrl = null;
      try {
        const sRes = await fetch(chrome.runtime.getURL('test_start_frame.jpg'));
        const sBlob = await sRes.blob();
        startImgDataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(sBlob); });
      } catch (e) { log(`⚠️ Không load được test_start_frame.jpg: ${e.message}`); }
      try {
        const eRes = await fetch(chrome.runtime.getURL('test_end_frame.jpg'));
        const eBlob = await eRes.blob();
        endImgDataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(eBlob); });
      } catch (e) { log(`⚠️ Không load được test_end_frame.jpg: ${e.message}`); }

      // ── 100 TASK: Video & Ảnh đan xen, đủ loại tỉ lệ, có vi phạm ──
      // type: 'video_text' | 'video_start' | 'video_start_end' | 'image_text' | 'image_1ref' | 'image_2ref' | 'violate'
      const tasks100 = [
        // ── VIDEO TEXT ──
        { id:1,  mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'con mèo trắng mũm mĩm chạy đuổi theo chuồn chuồn trong vườn hoa rực rỡ ánh nắng sáng' },
        { id:2,  mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'chân dung thiếu nữ Á Đông mặc áo dài hồng thêu hoa sen, ánh sáng vàng dịu buổi chiều tà' },
        { id:3,  mediaType:'video', type:'video_start',    ratio:'9:16', prompt:'cô gái nhảy hiphop sôi động trên đường phố đêm Tokyo đèn neon rực rỡ' },
        { id:4,  mediaType:'image', type:'image_1ref',     ratio:'16:9',  prompt:'phong cách tranh sơn dầu Ấn tượng, cô gái trong ảnh đứng bên dòng sông Seine lúc hoàng hôn' },
        { id:5,  mediaType:'video', type:'video_text',     ratio:'16:9',  prompt:'phi thuyền vũ trụ khổng lồ lao qua vành đai tiểu hành tinh lấp lánh, góc quay sử thi' },
        { id:6,  mediaType:'image', type:'image_2ref',     ratio:'16:9', prompt:'kết hợp phong cách trang phục từ 2 nhân vật trong ảnh tham chiếu, ánh sáng studio chuyên nghiệp' },
        { id:7,  mediaType:'video', type:'video_start_end',ratio:'16:9', prompt:'cô gái biến hình thành chiến binh H9 Gunner hiệu ứng ánh sáng điện neon' },
        { id:8,  mediaType:'image', type:'image_text',     ratio:'9:16',  prompt:'phong cảnh núi Alps phủ tuyết phản chiếu trên mặt hồ băng bình minh, góc rộng cinematic 8k' },
        { id:9,  mediaType:'video', type:'video_text',     ratio:'9:16', prompt:'sóng biển xanh cuộn lên bãi cát trắng mịn hoàng hôn đỏ rực, quay chậm siêu đẹp' },
        { id:10, mediaType:'image', type:'image_1ref',     ratio:'9:16', prompt:'nhân vật trong ảnh mặc trang phục hoàng gia thời Nguyễn, nền kiến trúc cung đình Huế' },
        // ── VI PHẠM NHÓM 1 ──
        { id:11, mediaType:'video', type:'violate',        ratio:'16:9', prompt:'cảnh bạo lực súng đạn người bắn nhau chảy máu trên đường phố thực tế cực kỳ gory' },
        { id:12, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'bầu trời đêm đầy sao Milky Way chụp từ đỉnh núi cao, phơi sáng dài cinematic photography' },
        { id:13, mediaType:'video', type:'video_start',    ratio:'16:9', prompt:'cô gái xoay người dưới ánh mắt trời chiều, tóc bay lãng mạn phong cách điện ảnh Hàn' },
        { id:14, mediaType:'image', type:'image_2ref',     ratio:'16:9',  prompt:'blend 2 nhân vật thành 1 người mặc áo khoác cyberpunk, nền thành phố tương lai' },
        { id:15, mediaType:'video', type:'video_text',     ratio:'9:16',  prompt:'chú chó Golden Retriever chạy vui vẻ trên bãi cỏ xanh sáng sớm, độ phân giải 4K' },
        { id:16, mediaType:'image', type:'image_text',     ratio:'16:9', prompt:'thành phố tương lai năm 2150 nhìn từ trên cao, xe bay tự lái luồng sáng neon xanh tím' },
        { id:17, mediaType:'video', type:'video_start_end',ratio:'9:16', prompt:'biến đổi cô gái thành nữ chiến binh không gian với giáp kim loại phát sáng' },
        { id:18, mediaType:'image', type:'image_1ref',     ratio:'9:16',  prompt:'tái tạo nhân vật trong ảnh theo phong cách anime Ghibli, màu sắc pastel nhẹ nhàng' },
        { id:19, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'đoàn tàu cao tốc lao qua cánh đồng hoa anh đào Nhật Bản mùa xuân, ánh sáng golden hour' },
        { id:20, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'nữ ninja mặc kimono đen đứng trên mái ngói dưới trăng rằm, hoa anh đào bay xung quanh' },
        // ── VIDEO START FRAME ──
        { id:21, mediaType:'video', type:'video_start',    ratio:'16:9',  prompt:'cô gái đang nhảy múa dừng lại và mỉm cười nhìn vào máy quay, phong cách MV Kpop' },
        { id:22, mediaType:'image', type:'image_2ref',     ratio:'16:9', prompt:'cảnh phòng khách nội thất sang trọng tích hợp phong cách từ 2 ảnh tham chiếu' },
        { id:23, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'rừng Amazon lúc bình minh, ánh sáng xuyên qua tán lá, chim thú thức giấc, quay chậm 4K' },
        { id:24, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'cô gái tóc dài ngồi đọc sách bên cửa sổ mưa rơi, ánh đèn ấm áp cozy aesthetic' },
        // ── VI PHẠM NHÓM 2 ──
        { id:25, mediaType:'video', type:'violate',        ratio:'9:16', prompt:'nội dung khiêu dâm rõ ràng, cảnh người lớn 18+ không kiểm duyệt' },
        { id:26, mediaType:'video', type:'video_start',    ratio:'9:16', prompt:'cô gái dạo bước dưới mưa hè, ánh đèn phố phản chiếu lấp lánh, máy quay theo sau' },
        { id:27, mediaType:'image', type:'image_1ref',     ratio:'9:16', prompt:'nhân vật trong ảnh xuất hiện trong cảnh hoàng cung cổ đại Trung Hoa, áo bào vàng' },
        { id:28, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'siêu xe Ferrari đỏ lao vun vút trên đường đèo Tây Nguyên, cảnh quay flycam đẹp' },
        { id:29, mediaType:'image', type:'image_text',     ratio:'16:9',  prompt:'robot AI thế hệ mới hình người đứng giữa thành phố hiện đại, mắt phát sáng xanh' },
        { id:30, mediaType:'video', type:'video_start_end',ratio:'16:9',  prompt:'người phụ nữ biến thành tiên nữ với cánh trắng và hào quang vàng lung linh' },
        { id:31, mediaType:'image', type:'image_2ref',     ratio:'9:16', prompt:'thiết kế trang phục kết hợp văn hóa 2 nhân vật từ 2 ảnh, vẽ concept art chuyên nghiệp' },
        { id:32, mediaType:'video', type:'video_text',     ratio:'9:16',  prompt:'bão tuyết khổng lồ ập vào thành phố hiện đại, flycam bắt từ trên cao' },
        { id:33, mediaType:'image', type:'image_text',     ratio:'16:9', prompt:'hoàng hôn trên hoang mạc Sahara, đoàn lạc đà silhouette trên nền trời đỏ cam rực' },
        // ── VIDEO TEXT NHIỀU TỈ LỆ ──
        { id:34, mediaType:'video', type:'video_text',     ratio:'9:16', prompt:'streamer game ngồi trước màn hình, reaction hài hước khi thắng trận, phong cách vlog' },
        { id:35, mediaType:'image', type:'image_1ref',     ratio:'16:9', prompt:'chuyển thể nhân vật trong ảnh thành chiến binh cyberpunk 2077, thành phố tương lai' },
        { id:36, mediaType:'video', type:'video_start',    ratio:'16:9', prompt:'cô gái vươn tay đón nắng sáng trên ban công, tóc bay nhẹ, phong cách lifestyle quảng cáo' },
        { id:37, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'búp bê chibi anime dễ thương ngồi trên đám mây bông, màu sắc pastel dreamcore' },
        { id:38, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'cảnh đại dương sâu thẳm, đàn cá phát sáng bơi lượn xung quanh rạn san hô, 4K HDR' },
        // ── VI PHẠM NHÓM 3 ──
        { id:39, mediaType:'video', type:'violate',        ratio:'16:9', prompt:'tuyên truyền khủng bố, hướng dẫn chế tạo vũ khí giết người hàng loạt' },
        { id:40, mediaType:'image', type:'image_2ref',     ratio:'9:16',  prompt:'thiết kế phòng khách kết hợp phong cách từ 2 ảnh tham chiếu, ánh sáng ấm cúng tối giản' },
        { id:41, mediaType:'video', type:'video_start_end',ratio:'16:9', prompt:'cảnh sáng sớm, nhân vật thức dậy và nhìn ra cửa sổ thấy bình minh rực rỡ' },
        { id:42, mediaType:'image', type:'image_text',     ratio:'16:9',  prompt:'logo thương hiệu cà phê hiện đại tối giản màu nâu vàng, style flat design chuyên nghiệp' },
        { id:43, mediaType:'video', type:'video_text',     ratio:'9:16', prompt:'vũ công ballet quay vòng dưới ánh đèn sân khấu, hiệu ứng hạt sáng lung linh' },
        { id:44, mediaType:'image', type:'image_1ref',     ratio:'9:16', prompt:'nhân vật trong ảnh trở thành nhân vật trong truyện tranh manga Nhật Bản, mực đen trắng' },
        { id:45, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'cảnh bếp Việt Nam, bà nội nấu phở, khói bốc thơm nghi ngút, ánh đèn vàng ấm cúng' },
        { id:46, mediaType:'image', type:'image_text',     ratio:'16:9', prompt:'thác nước khổng lồ Niagara Falls chụp từ flycam drone lúc bình minh, màu sắc tươi sáng' },
        { id:47, mediaType:'video', type:'video_start',    ratio:'16:9',  prompt:'cô gái cúi nhặt hoa và ngước nhìn lên mỉm cười, phong cách MV âm nhạc lãng mạn' },
        { id:48, mediaType:'image', type:'image_2ref',     ratio:'9:16', prompt:'thiết kế nhân vật hero kết hợp trang bị từ 2 ảnh tham chiếu, concept art game' },
        { id:49, mediaType:'video', type:'video_text',     ratio:'9:16',  prompt:'phố cổ Hội An về đêm đèn lồng rực rỡ, ánh đèn phản chiếu trên mặt sông Thu Bồn' },
        { id:50, mediaType:'image', type:'image_text',     ratio:'9:16',  prompt:'cô gái mặc váy hoa đứng giữa cánh đồng hướng dương mùa hè, chụp ảnh lifestyle đẹp' },
        // ── VI PHẠM NHÓM 4 ──
        { id:51, mediaType:'video', type:'violate',        ratio:'9:16', prompt:'hướng dẫn tổng hợp ma túy tại nhà, công thức chất cấm methamphetamine chi tiết' },
        { id:52, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'rừng thông Đà Lạt sáng sớm sương mờ, ánh nắng lọc qua tán cây, cảnh quay cinematic' },
        { id:53, mediaType:'image', type:'image_1ref',     ratio:'9:16',  prompt:'nhân vật trong ảnh đứng trước cổng Vạn Lý Trường Thành mùa lá vàng, ảnh du lịch' },
        { id:54, mediaType:'video', type:'video_start_end',ratio:'9:16', prompt:'cô gái từ từ quay người lại và mỉm cười rạng rỡ nhìn thẳng vào ống kính' },
        { id:55, mediaType:'image', type:'image_text',     ratio:'16:9', prompt:'poster phim sci-fi rừng đại dương ngoài vũ trụ, tàu vũ trụ đổ bộ, ánh sáng epic' },
        { id:56, mediaType:'video', type:'video_text',     ratio:'16:9',  prompt:'em bé đang tập đi những bước đầu tiên, bố mẹ hỗ trợ, ánh sáng gia đình ấm cúng' },
        { id:57, mediaType:'image', type:'image_2ref',     ratio:'16:9', prompt:'bố cục ảnh gia đình trong phòng khách, phong cách trang trí kết hợp từ 2 ảnh tham chiếu' },
        { id:58, mediaType:'video', type:'video_start',    ratio:'9:16', prompt:'vận động viên chạy marathon đang về đích, biểu cảm cố gắng hết sức mình, slow motion' },
        { id:59, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'poster concert K-pop đầy màu sắc, ánh đèn sân khấu, hình ảnh idol trên backdrop' },
        { id:60, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'ngôi nhà cổ Nhật Bản giữa rừng tre, tuyết nhẹ rơi, hồ nước tĩnh lặng, không khí zen' },
        // ── VIDEO START + ẢNH XEN KẼ ──
        { id:61, mediaType:'image', type:'image_1ref',     ratio:'16:9',  prompt:'nhân vật trong ảnh biến thành nhân vật trong thế giới Minecraft pixel art style' },
        { id:62, mediaType:'video', type:'video_start_end',ratio:'16:9', prompt:'thuyền rồng đua trên sông, người chèo đồng loạt gõ trống, quay từ trên cao' },
        { id:63, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'chiếc tách cà phê bốc khói trên bàn gỗ cạnh cửa sổ mưa, aesthetic cozy mùa đông' },
        { id:64, mediaType:'video', type:'video_text',     ratio:'9:16', prompt:'tiktoker trẻ quay vlog street food Hà Nội, ăn bún bò Huế, phản ứng thật tự nhiên' },
        { id:65, mediaType:'image', type:'image_2ref',     ratio:'9:16', prompt:'thiết kế bìa sách kết hợp phong cách từ 2 ảnh tham chiếu, typography hiện đại' },
        // ── VI PHẠM NHÓM 5 ──
        { id:66, mediaType:'video', type:'violate',        ratio:'16:9', prompt:'đánh người vị thành niên dưới 18 tuổi bạo lực học đường trẻ em bị tổn thương' },
        { id:67, mediaType:'video', type:'video_start',    ratio:'16:9', prompt:'diễn viên bước vào khung hình từ bên trái, đứng nhìn ra biển, tóc bay trong gió' },
        { id:68, mediaType:'image', type:'image_text',     ratio:'9:16',  prompt:'bản đồ chiến lược game chiến thuật, quân cờ vua hoàng kim trên nền nhung đỏ' },
        { id:69, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'tiểu đoàn quân sự diễu hành qua quảng trường lớn, máy bay chiến đấu bay trên đầu' },
        { id:70, mediaType:'image', type:'image_1ref',     ratio:'16:9', prompt:'nhân vật trong ảnh đứng trước bức tranh Mona Lisa trong bảo tàng Louvre' },
        { id:71, mediaType:'video', type:'video_start_end',ratio:'9:16', prompt:'cảnh đêm trở thành bình minh, thành phố từ tối tăm đến sáng rực rỡ time-lapse' },
        { id:72, mediaType:'image', type:'image_2ref',     ratio:'16:9',  prompt:'mascot thương hiệu kết hợp tính cách của 2 nhân vật trong ảnh tham chiếu' },
        { id:73, mediaType:'video', type:'video_text',     ratio:'16:9',  prompt:'quán phở truyền thống 5 giờ sáng, khói bốc nghi ngút, hàng người xếp hàng, Hà Nội' },
        { id:74, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'illustration digital art: thám tử mặc áo khoác trong đêm mưa thành phố noir atmosphere' },
        { id:75, mediaType:'video', type:'video_start',    ratio:'9:16',  prompt:'nhân vật đang ngồi đọc sách đột ngột ngẩng đầu lên và tươi cười khi ai đó bước vào' },
        // ── NHÓM ĐA DẠNG CUỐI ──
        { id:76, mediaType:'image', type:'image_text',     ratio:'16:9', prompt:'ảnh cưới romantic golden hour, cặp đôi dưới vòm hoa lavender Provence nước Pháp' },
        { id:77, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'show diễn thời trang haute couture Paris Fashion Week, người mẫu sải bước tự tin' },
        { id:78, mediaType:'image', type:'image_1ref',     ratio:'9:16', prompt:'portrait nhân vật trong ảnh theo phong cách tranh Van Gogh, màu sắc đậm nét cọ' },
        { id:79, mediaType:'video', type:'video_start_end',ratio:'16:9', prompt:'lữ khách mỏi mệt về đến nhà, mở cửa, thấy gia đình chờ đợi, khoảnh khắc ấm lòng' },
        // ── VI PHẠM NHÓM 6 ──
        { id:80, mediaType:'image', type:'violate',        ratio:'9:16', prompt:'ảnh deepfake lãnh đạo quốc gia làm điều sai trái, thông tin sai lệch gây mất ổn định' },
        { id:81, mediaType:'video', type:'video_text',     ratio:'9:16', prompt:'bartender pha cocktail điêu luyện, lửa bùng cháy, ánh đèn bar mờ ảo lung linh' },
        { id:82, mediaType:'image', type:'image_2ref',     ratio:'9:16',  prompt:'cảnh quan môi trường kết hợp yếu tố thiên nhiên từ 2 ảnh tham chiếu, ảnh nature' },
        { id:83, mediaType:'video', type:'video_start',    ratio:'16:9', prompt:'người chơi guitar acoustic bên đống lửa trại đêm khuya, ánh lửa nhảy múa thơ mộng' },
        { id:84, mediaType:'image', type:'image_text',     ratio:'16:9',  prompt:'icon app mobile design: ví tiền kỹ thuật số crypto, gradient tím xanh, style iOS flat' },
        { id:85, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'cảnh quay drone từ trên cao bờ biển Maldives, nước trong xanh san hô đẹp, golden hour' },
        { id:86, mediaType:'image', type:'image_1ref',     ratio:'16:9', prompt:'nhân vật trong ảnh làm phi công ngồi trong buồng lái máy bay chiến đấu F-22' },
        { id:87, mediaType:'video', type:'video_start_end',ratio:'9:16', prompt:'hạt mầm nảy mầm thành cây xanh tươi tốt, time-lapse thiên nhiên tươi đẹp' },
        { id:88, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'cửa hàng bánh ngọt Pháp boutique pâtisserie, bánh macaron đầy màu sắc trên kệ sang trọng' },
        // ── VI PHẠM NHÓM 7 ──
        { id:89, mediaType:'video', type:'violate',        ratio:'16:9', prompt:'nội dung phân biệt chủng tộc kích động hận thù dân tộc rõ ràng và trực tiếp' },
        { id:90, mediaType:'video', type:'video_text',     ratio:'9:16',  prompt:'đầu bếp nổi tiếng trình diễn nấu bò Wellington tuyệt hảo trong bếp nhà hàng Michelin' },
        { id:91, mediaType:'image', type:'image_2ref',     ratio:'16:9', prompt:'infographic so sánh sản phẩm dựa trên 2 ảnh tham chiếu, layout hiện đại rõ ràng' },
        { id:92, mediaType:'video', type:'video_start',    ratio:'9:16', prompt:'nhân vật mở mắt trong môi trường ảo diệu kỳ, xung quanh là những tòa tháp pha lê' },
        { id:93, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'phòng ngủ aesthetic Hàn Quốc, tông màu trắng be nhẹ nhàng, cây xanh nhỏ, đèn fairy light' },
        { id:94, mediaType:'video', type:'video_text',     ratio:'16:9', prompt:'buổi bình minh trên đỉnh Fansipan, mây trắng bồng bềnh dưới chân, không khí trong lành' },
        { id:95, mediaType:'image', type:'image_1ref',     ratio:'9:16',  prompt:'nhân vật trong ảnh xuất hiện trong khung cảnh truyện tranh DC Comics, action pose' },
        { id:96, mediaType:'video', type:'video_start_end',ratio:'16:9',  prompt:'cây đào Tết từ nụ hoa đến hoa nở rộ rực rỡ, time-lapse mùa xuân Việt Nam' },
        { id:97, mediaType:'image', type:'image_text',     ratio:'9:16', prompt:'illustration khu phố cổ Hà Nội năm 1930, xe kéo, phụ nữ áo dài đội nón lá, phong cách retro' },
        { id:98, mediaType:'video', type:'video_text',     ratio:'9:16', prompt:'lễ hội đèn lồng Hội An, hàng nghìn đèn lồng thả xuống sông, cảnh quay drone lung linh' },
        { id:99, mediaType:'image', type:'image_2ref',     ratio:'16:9', prompt:'thiết kế giao diện website kết hợp màu sắc từ 2 ảnh tham chiếu, UI modern clean' },
        { id:100,mediaType:'video', type:'video_start_end',ratio:'16:9', prompt:'cảnh kết phim lãng mạn, 2 nhân vật bước về phía ánh sáng cuối đường hầm cùng nhau' },
      ];

      // Render danh sách 100 task lên UI
      const statusContainer = document.getElementById('batch100StatusContainer');
      const taskListEl = document.getElementById('batch100TaskList');
      const progressBadge = document.getElementById('batch100ProgressBadge');
      const doneCountEl = document.getElementById('batch100DoneCount');
      const failCountEl = document.getElementById('batch100FailCount');
      const violateCountEl = document.getElementById('batch100ViolateCount');
      const runningCountEl = document.getElementById('batch100RunningCount');

      if (statusContainer) statusContainer.style.display = 'block';
      if (progressBadge) progressBadge.textContent = `0/100`;

      let doneCount = 0, failCount = 0, violateCount = 0, runningCount = 0;
      const updateStats = () => {
        if (doneCountEl) doneCountEl.textContent = doneCount;
        if (failCountEl) failCountEl.textContent = failCount;
        if (violateCountEl) violateCountEl.textContent = violateCount;
        if (runningCountEl) runningCountEl.textContent = runningCount;
        if (progressBadge) progressBadge.textContent = `${doneCount + failCount + violateCount}/100`;
      };

      const typeColors = {
        video_text:     '#00e5ff',
        video_start:    '#e91e63',
        video_start_end:'#9c27b0',
        image_text:     '#06d6a0',
        image_1ref:     '#f72585',
        image_2ref:     '#7b2cbf',
        violate:        '#ff5722',
      };
      const typeNames = {
        video_text:     '🎥 Vid Text',
        video_start:    '🎬 Vid+Start',
        video_start_end:'🎭 Vid+S+E',
        image_text:     '🖼️ Img Text',
        image_1ref:     '🖼️ Img+1Ref',
        image_2ref:     '🖼️ Img+2Ref',
        violate:        '⚠️ Vi Phạm',
      };

      if (taskListEl) {
        taskListEl.innerHTML = tasks100.map(t => `
          <div id="b100_row_${t.id}" style="background:var(--bg); border:1px solid rgba(255,255,255,0.05); border-radius:5px; padding:5px 8px; display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <div style="display:flex; flex-direction:column; gap:1px; flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:5px;">
                <span style="font-weight:bold; color:white; min-width:24px;">#${t.id}</span>
                <span style="font-size:9px; padding:1px 4px; border-radius:3px; font-weight:bold; background:rgba(255,255,255,0.08); color:${typeColors[t.type]};">${typeNames[t.type]}</span>
                <span style="font-size:9px; padding:1px 4px; border-radius:3px; font-weight:bold; background:rgba(255,255,255,0.06); color:${t.mediaType==='video'?'#00e5ff':'#e91e63'};">${t.ratio}</span>
                <span id="b100_tab_${t.id}" style="font-size:9px; color:var(--text2);">⏳</span>
              </div>
              <div style="font-size:9px; color:var(--text2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${t.prompt}">${t.prompt.slice(0,60)}...</div>
            </div>
            <div id="b100_status_${t.id}" style="font-size:9px; font-weight:bold; color:var(--text2); white-space:nowrap;">⏳ Chờ</div>
          </div>
        `).join('');
      }

      // Worker pool: tách queue theo role — tab Video chỉ nhận task video, tab Ảnh chỉ nhận task ảnh
      const videoTabs100 = allTabs.filter(t => t.role === 'video');
      const imageTabs100 = allTabs.filter(t => t.role === 'image');

      const videoQueue = tasks100.filter(t => t.mediaType === 'video' || t.type === 'violate');
      const imageQueue = tasks100.filter(t => t.mediaType === 'image' && t.type !== 'violate');

      log(`✅ ${videoTabs100.length} tab Video (${videoQueue.length} task video/vi phạm) | ${imageTabs100.length} tab Ảnh (${imageQueue.length} task ảnh)`);

      if (videoTabs100.length === 0 && videoQueue.length > 0) {
        log('⚠️ Không có tab Video! Các task video sẽ bị bỏ qua. Gán role Video cho ít nhất 1 tab.');
      }
      if (imageTabs100.length === 0 && imageQueue.length > 0) {
        log('⚠️ Không có tab Ảnh! Các task ảnh sẽ bị bỏ qua. Gán role Ảnh cho ít nhất 1 tab.');
      }

      const runWorker100 = async (tab) => {
        const tabLabel = `Tab${tab.index + 1}`;
        // Mỗi tab chỉ kéo task từ queue đúng role của nó
        const myQueue = tab.role === 'image' ? imageQueue : videoQueue;

        while (myQueue.length > 0) {
          const task = myQueue.shift();
          const statusEl = document.getElementById(`b100_status_${task.id}`);
          const tabEl = document.getElementById(`b100_tab_${task.id}`);
          const rowEl = document.getElementById(`b100_row_${task.id}`);


          if (tabEl) { tabEl.textContent = `📌${tabLabel}`; tabEl.style.color = 'var(--accent2)'; }
          if (statusEl) { statusEl.textContent = '🔄 Gửi...'; statusEl.style.color = '#60a5fa'; }
          if (rowEl) rowEl.style.borderColor = '#60a5fa';

          runningCount++;
          updateStats();

          const ts = Date.now().toString().slice(-4);
          const fullPrompt = `${ts}. ${task.prompt}`;

          // Xác định startImg / endImg theo loại task
          const sImg = (task.type === 'video_start' || task.type === 'video_start_end') ? startImgDataUrl : null;
          const eImg = (task.type === 'video_start_end') ? endImgDataUrl : null;

          log(`[${tabLabel}] 🚀 Task #${task.id} (${typeNames[task.type]}, ${task.ratio}): "${task.prompt.slice(0,35)}..."`);

          try {
            let createRes;
            if (task.mediaType === 'video' || task.type === 'violate') {
              // Vi phạm test bằng video (để thấy flow handle lỗi)
              createRes = await callExt('CREATE_VIDEO_MULTI_TAB', {
                prompt: fullPrompt,
                tabId: tab.tabId,
                aspectRatio: task.ratio,
                startImageDataUrl: sImg,
                endImageDataUrl: eImg
              });
            } else {
              // Ảnh
              const refs = [];
              if (task.type === 'image_1ref' || task.type === 'image_2ref') refs.push(startImgDataUrl);
              if (task.type === 'image_2ref') refs.push(endImgDataUrl);
              createRes = await callExt('CREATE_IMAGE_MULTI_TAB', {
                prompt: fullPrompt,
                tabId: tab.tabId,
                aspectRatio: task.ratio,
                referenceImages: refs.filter(Boolean)
              });
            }

            if (!createRes?.success) throw new Error(createRes?.error || 'Lỗi tạo');

            if (statusEl) { statusEl.textContent = '⏳ Render...'; statusEl.style.color = '#fbbf24'; }
            if (rowEl) rowEl.style.borderColor = '#fbbf24';

            // Monitor & Download
            const monRes = task.mediaType === 'image' && task.type !== 'violate'
              ? await monitorAndDownloadImageMultiTab(tab.tabId, ts, fullPrompt, tab.projectId, logEl)
              : await monitorAndDownloadMultiTab(tab.tabId, ts, fullPrompt, tab.projectId, logEl);

            runningCount--;

            if (monRes?.success) {
              doneCount++;
              if (statusEl) { statusEl.textContent = '✅ Xong'; statusEl.style.color = '#4ade80'; }
              if (rowEl) rowEl.style.borderColor = 'rgba(74,222,128,0.4)';
              log(`[${tabLabel}] ✅ #${task.id} XONG: ${monRes.filename || 'OK'}`);
            } else {
              const isViolation = monRes?.error && (monRes.error.includes('vi phạm') || monRes.error.includes('không thành công') || monRes.error.includes('policy'));
              if (isViolation || task.type === 'violate') {
                violateCount++;
                if (statusEl) { statusEl.textContent = '⚠️ Vi phạm'; statusEl.style.color = '#fbbf24'; }
                if (rowEl) rowEl.style.borderColor = 'rgba(251,191,36,0.4)';
                log(`[${tabLabel}] ⚠️ #${task.id} VI PHẠM: ${monRes?.error || 'Chính sách'}`);
              } else {
                failCount++;
                if (statusEl) { statusEl.textContent = '❌ Lỗi'; statusEl.style.color = '#f87171'; }
                if (rowEl) rowEl.style.borderColor = 'rgba(248,113,113,0.4)';
                log(`[${tabLabel}] ❌ #${task.id} LỖI: ${monRes?.error || 'Thất bại'}`);
              }
            }
          } catch (err) {
            runningCount = Math.max(0, runningCount - 1);
            const isViolation = err.message && (err.message.includes('vi phạm') || err.message.includes('policy') || task.type === 'violate');
            if (isViolation) {
              violateCount++;
              if (statusEl) { statusEl.textContent = '⚠️ Vi phạm'; statusEl.style.color = '#fbbf24'; }
              if (rowEl) rowEl.style.borderColor = 'rgba(251,191,36,0.4)';
            } else {
              failCount++;
              if (statusEl) { statusEl.textContent = '❌ Lỗi'; statusEl.style.color = '#f87171'; }
              if (rowEl) rowEl.style.borderColor = 'rgba(248,113,113,0.4)';
            }
            log(`[${tabLabel}] ❌ #${task.id} Exception: ${err.message}`);
          }

          updateStats();
        }
      };

      // Chỉ launch worker cho tab có queue tương ứng không rỗng
      const workers = [
        ...videoTabs100.map(tab => runWorker100(tab)),
        ...imageTabs100.map(tab => runWorker100(tab)),
      ];
      await Promise.all(workers);

      log(`🏁 HOÀN TẤT 100 TASK! ✅${doneCount} Xong | ❌${failCount} Lỗi | ⚠️${violateCount} Vi phạm`);
      btnBatch100.disabled = false;
      btnBatch100.textContent = '🚀 Chạy Test 100 Task (Video + Ảnh đan xen, đủ loại + vi phạm)';
    });
  }

  // Lấy các task Đa Tab từ server tool_video đang chờ trong background nếu có
  callExt('GET_PENDING_MULTI_TAB_SERVER_TASKS').then(res => {
    if (res?.success && Array.isArray(res.tasks) && res.tasks.length > 0) {
      for (const t of res.tasks) {
        addServerTaskToMultiTab(t);
      }
    }
  }).catch(() => {});
});

})();
