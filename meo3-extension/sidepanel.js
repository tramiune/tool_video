'use strict';

let currentFilter = 'all';
let fileData = {};
let tasks = [];
let pollIntervals = {};

// ── INIT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindTabs();
  bindModeToggles();
  bindUploadBoxes();
  bindFileInputs();
  bindButtons();
  bindFilters();
  checkToken();
  loadTasks();
  setInterval(loadTasks, 5000);
  setInterval(checkToken, 30000);
});

// ── TABS ──────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
      if (btn.dataset.tab === 'list') loadTasks();
    });
  });
}

// ── MODE TOGGLES ──────────────────────────────────────
function bindModeToggles() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      const mode = btn.dataset.mode;
      document.querySelectorAll(`.mode-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (group === 'video') {
        document.getElementById('videoSingle').classList.toggle('hidden', mode !== 'single');
        document.getElementById('videoBatch').classList.toggle('hidden', mode !== 'batch');
      } else {
        document.getElementById('imageSingle').classList.toggle('hidden', mode !== 'single');
        document.getElementById('imageBatch').classList.toggle('hidden', mode !== 'batch');
      }
    });
  });
}

// ── UPLOAD BOXES ──────────────────────────────────────
function bindUploadBoxes() {
  document.querySelectorAll('.upload-box[data-trigger]').forEach(box => {
    box.addEventListener('click', () => {
      document.getElementById(box.dataset.trigger).click();
    });
  });
}

function bindFileInputs() {
  const map = {
    startImageInput: ['startImagePreview', 'startImageData'],
    endImageInput:   ['endImagePreview',   'endImageData'],
    refImageInput:   ['refImagePreview',   'refImageData'],
  };
  Object.entries(map).forEach(([inputId, [previewId, dataKey]]) => {
    document.getElementById(inputId).addEventListener('change', function() {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const preview = document.getElementById(previewId);
        const img = document.createElement('img');
        img.src = e.target.result;
        img.className = 'preview-img';
        img.title = 'Click để xóa';
        img.addEventListener('click', ev => {
          ev.stopPropagation();
          document.getElementById(inputId).value = '';
          preview.innerHTML = '';
          preview.textContent = '📷 Upload';
          delete fileData[dataKey];
        });
        preview.innerHTML = '';
        preview.appendChild(img);
        // Store as array buffer
        const ar = new FileReader();
        ar.onload = e2 => { fileData[dataKey] = { buffer: Array.from(new Uint8Array(e2.target.result)), mimeType: file.type, name: file.name }; };
        ar.readAsArrayBuffer(file);
      };
      reader.readAsDataURL(file);
    });
  });
}

// ── BUTTONS ───────────────────────────────────────────
function bindButtons() {
  document.getElementById('btnCreateVideo').addEventListener('click', createVideo);
  document.getElementById('btnCreateImage').addEventListener('click', createImage);
  document.getElementById('btnRefresh').addEventListener('click', loadTasks);
}

function bindFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderTasks();
    });
  });
}

// ── MESSAGING ─────────────────────────────────────────
function sendMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, res => resolve(res || {})));
}

// ── TOKEN ─────────────────────────────────────────────
async function checkToken() {
  const res = await sendMsg({ type: 'GET_TOKEN' });
  const el = document.getElementById('tokenStatus');
  if (res.hasToken) { el.textContent = '✅ Đã kết nối'; el.style.color = '#bbf7d0'; }
  else              { el.textContent = '🔄 Chờ token...'; el.style.color = '#fde68a'; }
}

// ── UPLOAD ────────────────────────────────────────────
async function uploadFile(dataKey) {
  const fd = fileData[dataKey];
  if (!fd) return null;
  const res = await sendMsg({ type: 'UPLOAD_FILE', fileData: fd.buffer, mimeType: fd.mimeType, fileName: fd.name });
  if (res.error) throw new Error(res.error);
  return res.mediaId;
}

// ── CREATE VIDEO ──────────────────────────────────────
async function createVideo() {
  const isBatch = document.querySelector('.mode-btn.active[data-group="video"]')?.dataset.mode === 'batch';
  const prompts = isBatch
    ? document.getElementById('videoBatchPrompts').value.split('\n').map(s => s.trim()).filter(Boolean)
    : [document.getElementById('videoPrompt').value.trim()];
  if (!prompts[0]) return alert('Nhập prompt trước!');

  const btn = document.getElementById('btnCreateVideo');
  const statusEl = document.getElementById('videoStatus');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Đang tạo...';
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Đang upload ảnh...';

  try {
    const startImageMediaId = await uploadFile('startImageData');
    const endImageMediaId   = await uploadFile('endImageData');
    const aspectRatio = document.getElementById('videoRatio').value;

    for (let i = 0; i < prompts.length; i++) {
      statusEl.textContent = `Đang gửi ${i + 1}/${prompts.length}...`;
      const res = await sendMsg({ type: 'GENERATE_VIDEO', payload: { prompt: prompts[i], startImageMediaId, endImageMediaId, aspectRatio } });
      if (res.error) throw new Error(res.error);
      extractAndSaveTasks(res.result, prompts[i], 'video');
    }
    statusEl.textContent = `✅ Đã gửi ${prompts.length} task!`;
    document.getElementById('videoPrompt').value = '';
    document.querySelectorAll('.tab-btn[data-tab="list"]')[0].click();
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '▶ Tạo Video';
  }
}

// ── CREATE IMAGE ──────────────────────────────────────
async function createImage() {
  const isBatch = document.querySelector('.mode-btn.active[data-group="image"]')?.dataset.mode === 'batch';
  const prompts = isBatch
    ? document.getElementById('imageBatchPrompts').value.split('\n').map(s => s.trim()).filter(Boolean)
    : [document.getElementById('imagePrompt').value.trim()];
  if (!prompts[0]) return alert('Nhập prompt trước!');

  const btn = document.getElementById('btnCreateImage');
  const statusEl = document.getElementById('imageStatus');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Đang tạo...';
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Đang upload ảnh...';

  try {
    const referenceMediaId = await uploadFile('refImageData');
    const imageModel = document.getElementById('imageModel').value;

    for (let i = 0; i < prompts.length; i++) {
      statusEl.textContent = `Đang tạo ảnh ${i + 1}/${prompts.length}...`;
      const res = await sendMsg({ type: 'GENERATE_IMAGE', payload: { prompt: prompts[i], referenceMediaId, imageModel } });
      if (res.error) throw new Error(res.error);

      // Ảnh trả về ngay (synchronous) — lưu task là 'done' luôn
      const imageResults = res.result?.imageResults || [];
      if (imageResults.length === 0) throw new Error('Không nhận được ảnh từ API');

      for (const img of imageResults) {
        const task = {
          id: img.name || ('img_' + Date.now()),
          type: 'image',
          prompt: prompts[i],
          status: img.status,
          operationName: img.name,
          mediaId: img.name,          // Lưu mediaId để lấy fresh URL khi download
          createdAt: Date.now(),
          url: img.url,               // fifeUrl — chỉ dùng cho preview, có thể expire
          thumbnailUrl: img.url
        };
        tasks.unshift(task);
        await sendMsg({ type: 'SAVE_TASK', task });
      }
    }

    statusEl.textContent = `✅ Đã tạo xong ${prompts.length} ảnh!`;
    document.getElementById('imagePrompt').value = '';
    renderTasks();
    document.querySelectorAll('.tab-btn[data-tab="list"]')[0].click();
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🎨 Tạo Ảnh';
  }
}

// ── EXTRACT TASKS ─────────────────────────────────────
function extractAndSaveTasks(result, prompt, type) {
  // aisandbox-pa returns: { media: [{ name, projectId }] }  or { generationItems: [...] }
  const items = result?.media || result?.generationItems || result?.operations || result?.generatedMedia || [];
  const arr = Array.isArray(items) ? items : (result?.name ? [result] : []);

  if (arr.length === 0) {
    // Fallback: treat the whole result as one task if it has a name
    if (result?.name) arr.push(result);
    else { console.warn('No media items in response:', result); return; }
  }

  arr.forEach(item => {
    const opName = item.name;
    if (!opName) return;
    const task = {
      id: opName, type, prompt, status: 'processing',
      operationName: opName, projectId: item.projectId,
      createdAt: Date.now(), url: null, thumbnailUrl: null
    };
    tasks.unshift(task);
    sendMsg({ type: 'SAVE_TASK', task });
    startPolling(task);
  });
  renderTasks();
}

// ── POLLING ───────────────────────────────────────────
function startPolling(task) {
  if (pollIntervals[task.id]) return;
  pollIntervals[task.id] = setInterval(() => pollTask(task), 5000);
}

async function pollTask(task) {
  try {
    const mediaItems = [{ name: task.operationName, projectId: task.projectId }];
    const res = await sendMsg({ type: 'CHECK_STATUS', mediaItems, mediaType: task.type });
    if (res.error) return;

    const data = res.result;
    // Đúng format từ batchCheckAsyncVideoGenerationStatus
    const items = data?.media || data?.videoGenerationResults || [];

    for (const item of items) {
      // Đúng field name từ server: mediaMetadata.mediaStatus.mediaGenerationStatus
      const genStatus = item?.mediaMetadata?.mediaStatus?.mediaGenerationStatus
                     || item?.mediaMetadata?.generationStatus
                     || item?.status?.state
                     || item?.status;

      const isDone   = genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || genStatus === 'SUCCESSFUL';
      const isFailed = genStatus === 'MEDIA_GENERATION_STATUS_FAILED'     || genStatus === 'FAILED'
                    || genStatus === 'MEDIA_GENERATION_STATUS_FILTERED'    || genStatus === 'FILTERED';

      if (isDone) {
        const mediaId = item.name || task.operationName;
        const isVideo = task.type === 'video';

        // Lấy URL với retry
        let url = null;
        for (let i = 0; i < 3 && !url; i++) {
          const r = await sendMsg({ type: 'GET_MEDIA_URL', mediaId, mediaType: isVideo ? 'MEDIA_URL_TYPE_VIDEO' : 'MEDIA_URL_TYPE_IMAGE' });
          url = r.url;
          if (!url) await new Promise(ok => setTimeout(ok, 2000));
        }

        const thumbRes = await sendMsg({ type: 'GET_MEDIA_URL', mediaId, mediaType: 'MEDIA_URL_TYPE_THUMBNAIL' });

        task.status = url ? 'done' : 'failed';
        task.url = url;
        task.mediaId = mediaId;
        task.thumbnailUrl = thumbRes.url || url;
        if (!url) task.error = 'Không lấy được URL video';

        clearInterval(pollIntervals[task.id]); delete pollIntervals[task.id];
        await sendMsg({ type: 'SAVE_TASK', task }); renderTasks();

      } else if (isFailed) {
        task.status = 'failed';
        task.error = item?.mediaMetadata?.mediaStatus?.error?.message || 'Generation failed';
        clearInterval(pollIntervals[task.id]); delete pollIntervals[task.id];
        await sendMsg({ type: 'SAVE_TASK', task }); renderTasks();
      }
    }
  } catch (e) { console.warn('pollTask error:', e.message); }
}


// ── LIST ──────────────────────────────────────────────
async function loadTasks() {
  const res = await sendMsg({ type: 'GET_TASKS' });
  tasks = res.tasks || [];
  tasks.filter(t => t.status === 'processing').forEach(t => startPolling(t));
  renderTasks();
}

function renderTasks() {
  const filtered = tasks.filter(t => {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'processing') return t.status === 'processing';
    if (currentFilter === 'done') return t.status === 'done';
    if (currentFilter === 'failed') return t.status === 'failed';
    return t.type === currentFilter;
  });
  document.getElementById('taskCount').textContent = `${filtered.length} tasks`;
  const list = document.getElementById('taskList');

  // Smart diff — chỉ rebuild card nào thay đổi để tránh nháy
  const existingCards = new Map();
  list.querySelectorAll('[data-task-id]').forEach(el => existingCards.set(el.dataset.taskId, el));

  const newIds = new Set(filtered.map(t => t.id));

  // Xóa card không còn trong filtered
  existingCards.forEach((el, id) => { if (!newIds.has(id)) el.remove(); });

  filtered.forEach((t, idx) => {
    const sig = `${t.status}|${t.url || ''}|${t.thumbnailUrl || ''}|${t.error || ''}`;
    const existing = existingCards.get(t.id);
    const newCard = buildTaskCard(t);
    newCard.dataset.taskId = t.id;
    newCard.dataset.sig = sig;

    if (!existing) {
      // Card mới — chèn đúng vị trí
      const ref = list.children[idx];
      if (ref) list.insertBefore(newCard, ref);
      else list.appendChild(newCard);
    } else if (existing.dataset.sig !== sig) {
      // Card đã thay đổi trạng thái → replace
      existing.replaceWith(newCard);
    } else {
      // Không đổi → giữ nguyên, đảm bảo thứ tự đúng
      const ref = list.children[idx];
      if (ref !== existing) list.insertBefore(existing, ref || null);
    }
  });
}

function buildTaskCard(t) {
  const card = document.createElement('div');
  card.className = 'task-card';

  const time = new Date(t.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const icon = t.type === 'video' ? '🎬' : '🖼️';

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.innerHTML = `<span>${icon}</span><span>${time}</span>`;

  // Status badge
  const badge = document.createElement('span');
  if (t.status === 'processing') {
    badge.innerHTML = '<span class="spinner"></span>';
    badge.style.marginLeft = '4px';
  } else if (t.status === 'done') {
    badge.textContent = '✅ Xong'; badge.className = 's-done';
  } else {
    badge.textContent = '❌ Lỗi'; badge.className = 's-failed';
  }
  meta.appendChild(badge);

  // Nút xóa
  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑';
  delBtn.title = 'Xóa task';
  delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;margin-left:auto;opacity:0.5;padding:0 2px;';
  delBtn.addEventListener('click', () => deleteTask(t.id));
  meta.appendChild(delBtn);

  const prompt = document.createElement('div');
  prompt.className = 'task-prompt';
  prompt.textContent = t.prompt;

  card.appendChild(meta);
  card.appendChild(prompt);

  if (t.status === 'failed' && t.error) {
    const err = document.createElement('div');
    err.className = 'task-error';
    err.textContent = t.error;
    card.appendChild(err);
  }

  if (t.status === 'done' && t.url) {
    const preview = document.createElement('div');
    preview.className = 'task-preview';
    if (t.type === 'video') {
      const v = document.createElement('video');
      v.src = t.url; v.className = 'preview-video'; v.controls = true; v.muted = true;
      preview.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = t.thumbnailUrl || t.url; img.className = 'preview-img';
      img.addEventListener('click', () => window.open(t.url, '_blank'));
      preview.appendChild(img);
    }
    const dl = document.createElement('button');
    dl.textContent = '⬇ Tải về';
    dl.className = 'task-dl';
    dl.addEventListener('click', () => sendMsg({
      type: 'DOWNLOAD_FILE',
      url: t.url,
      mediaId: t.mediaId || t.operationName,
      mediaType: t.type
    }));
    card.appendChild(preview);
    card.appendChild(dl);
  }

  return card;
}

async function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  await sendMsg({ type: 'DELETE_TASK', id });
  renderTasks();
}

// Lắng nghe thay đổi từ storage (khi server hoặc background tạo/tải ảnh mới)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tasks) {
    tasks = changes.tasks.newValue || [];
    renderTasks();
  }
});


