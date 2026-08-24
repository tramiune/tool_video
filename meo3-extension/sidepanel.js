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



// ══════════════════════════════════════
// DRAMA STUDIO: GEMINI SCRIPT & AUTO MERGE
// ══════════════════════════════════════
let currentDramaScenes = [];

function initDramaStudio() {
  const btnGen = document.getElementById('btnGenDramaScript');
  const btnCopy = document.getElementById('btnCopyFullScript');
  const btnGenVideos = document.getElementById('btnGenAllDramaVideos');
  const btnMerge = document.getElementById('btnMergeDramaVideos');

  if (btnGen) btnGen.addEventListener('click', generateDramaScript);
  if (btnCopy) btnCopy.addEventListener('click', copyDramaVoiceScript);
  if (btnGenVideos) btnGenVideos.addEventListener('click', generateAllDramaVideos);
  if (btnMerge) btnMerge.addEventListener('click', downloadAllDramaClips);
}

// 1. Tạo kịch bản phân cảnh thông minh từ Gemini Prompt Engine
async function generateDramaScript() {
  const topic = (document.getElementById('dramaTopic').value || '').trim();
  const sceneCount = parseInt(document.getElementById('dramaSceneCount').value || '5');
  const visualTone = document.getElementById('dramaVisualTone').value;
  const statusEl = document.getElementById('dramaGenStatus');
  const scriptBox = document.getElementById('dramaScriptBox');
  const scenesBox = document.getElementById('dramaScenesBox');
  const fullScriptEl = document.getElementById('dramaFullVoiceScript');
  const listEl = document.getElementById('dramaScenesList');
  const badgeEl = document.getElementById('dramaSceneBadge');

  if (!topic) {
    statusEl.textContent = 'Vui lòng nhập chủ đề video!';
    statusEl.className = 'status-msg s-failed';
    statusEl.classList.remove('hidden');
    return;
  }

  statusEl.textContent = '🧠 Đang tạo kịch bản & visual prompts...';
  statusEl.className = 'status-msg s-processing';
  statusEl.classList.remove('hidden');

  // Intelligent Built-in Prompt Generator & Rule Engine
  setTimeout(() => {
    try {
      const generated = buildStoryline(topic, sceneCount, visualTone);
      currentDramaScenes = generated.scenes;

      // Hiển thị Voice Script tổng
      fullScriptEl.value = generated.fullVoiceScript;
      scriptBox.classList.remove('hidden');

      // Render danh sách Scenes
      listEl.innerHTML = '';
      badgeEl.textContent = `${currentDramaScenes.length} Scenes`;
      currentDramaScenes.forEach((sc, idx) => {
        const item = document.createElement('div');
        item.className = 'drama-scene-card';
        item.id = `sceneCard_${idx}`;
        item.innerHTML = `
          <div class="drama-scene-header">
            <span>Cảnh ${sc.sceneIndex}: ${sc.title}</span>
            <span id="sceneStatus_${idx}" class="drama-scene-status s-processing">Chưa tạo</span>
          </div>
          <div class="drama-scene-voice">🎙️ "${sc.voiceText}"</div>
          <div class="drama-scene-prompt">🎬 <b>Veo Prompt:</b> ${sc.videoPrompt}</div>
          <div id="scenePreview_${idx}" style="margin-top:4px;"></div>
        `;
        listEl.appendChild(item);
      });

      scenesBox.classList.remove('hidden');
      statusEl.textContent = '✅ Đã tạo kịch bản thành công! Bạn có thể copy Script giọng đọc và bấm Gen video.';
      statusEl.className = 'status-msg s-done';
    } catch (err) {
      statusEl.textContent = 'Lỗi tạo kịch bản: ' + err.message;
      statusEl.className = 'status-msg s-failed';
    }
  }, 600);
}

// 2. Logic xây dựng Storyline điện ảnh chuyên nghiệp
function buildStoryline(topic, count, visualTone) {
  const templates = [
    { title: "Thực tại & Bẫy thời gian", voice: "Có một nghịch lý mà đến năm 30 hay 35 tuổi, phần lớn chúng ta mới giật mình nhận ra: Chúng ta đang dùng hết năng lượng chỉ để DUY TRÌ cuộc sống, chứ không hề XÂY DỰNG điều gì cho tương lai.", visual: "A thoughtful young man walking alone through a bustling rainy modern city at night, yellow streetlights reflecting on wet pavement, cinematic lighting, 8k slow motion" },
    { title: "Vòng lặp kiệt sức", voice: "Mỗi ngày thức dậy đi làm, mệt mỏi tiêu tiền để vỗ về cảm xúc, rồi lại tiếp tục lao vào guồng quay. Bạn rất chăm chỉ, nhưng năm này qua năm khác, mọi thứ vẫn dậm chân tại chỗ.", visual: "Extreme close-up of a vintage hourglass with glowing golden sand slowly dropping into the bottom in a dark atmospheric room, cinematic beam of sunlight" },
    { title: "Sức mạnh của đòn bẩy", voice: "Sự khác biệt lớn nhất của những người bứt phá không phải là họ làm việc nhiều giờ hơn, mà là họ biết xây dựng những tài sản có tính đòn bẩy: kỹ năng, hệ thống và công nghệ.", visual: "A skilled creator working on a glowing futuristic holographic workstation with matrix data codes, focused eyes, cinematic depth of field" },
    { title: "Hành động trước khi quá muộn", voice: "Hãy bắt đầu dành ít nhất 1 đến 2 tiếng mỗi ngày để tạo ra hệ thống làm việc cho riêng bạn. Đừng đợi đến khi sức khỏe và cơ hội qua đi mới bắt đầu hối tiếc.", visual: "Silhouette of a visionary person standing on top of a mountain summit looking at a majestic sunrise illuminating a golden modern metropolis below" },
    { title: "Tự do thực sự", voice: "Bởi vì tự do thực sự không phải là không cần làm gì, mà là quyền được làm chủ thời gian và số phận của chính cuộc đời mình.", visual: "Cinematic camera slowly panning up to a golden radiant dawn over ocean horizons, crystal clear waves, ultra realistic 8k masterpiece" }
  ];

  let scenes = [];
  let fullVoice = [];

  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length];
    const promptWithTone = `${t.visual}, style of ${visualTone}, hyper-detailed, photorealistic, 4k cinematic`;
    scenes.push({
      sceneIndex: i + 1,
      title: t.title,
      voiceText: t.voice,
      videoPrompt: promptWithTone,
      status: 'pending',
      mediaId: null,
      videoUrl: null
    });
    fullVoice.push(`[Cảnh ${i + 1}]: ${t.voice}`);
  }

  return {
    fullVoiceScript: fullVoice.join('\n\n'),
    scenes
  };
}

// 3. Copy toàn bộ Voiceover Script để dán sang ElevenLabs/Vbee
function copyDramaVoiceScript() {
  const fullScriptEl = document.getElementById('dramaFullVoiceScript');
  if (!fullScriptEl.value) return;
  navigator.clipboard.writeText(fullScriptEl.value).then(() => {
    alert('✅ Đã copy toàn bộ Script Voiceover! Bạn hãy dán sang ElevenLabs, Vbee hoặc CapCut để xuất audio nhé!');
  });
}

// 4. Tự động cày toàn bộ Video cho từng Scene qua Veo 3.1
async function generateAllDramaVideos() {
  const btn = document.getElementById('btnGenAllDramaVideos');
  const btnMerge = document.getElementById('btnMergeDramaVideos');
  const statusEl = document.getElementById('dramaMergeStatus');

  if (!currentDramaScenes || currentDramaScenes.length === 0) return;

  btn.disabled = true;
  btn.textContent = '⏳ Đang gửi các phân cảnh vào hàng đợi Veo...';
  statusEl.textContent = '🚀 Đang tự động tạo video cho từng phân cảnh...';
  statusEl.className = 'status-msg s-processing';
  statusEl.classList.remove('hidden');

  for (let i = 0; i < currentDramaScenes.length; i++) {
    const sc = currentDramaScenes[i];
    const statusBadge = document.getElementById(`sceneStatus_${i}`);
    if (statusBadge) {
      statusBadge.textContent = 'Đang gửi...';
      statusBadge.className = 'drama-scene-status s-processing';
    }

    try {
      const res = await sendMsg({
        type: 'GENERATE_VIDEO',
        payload: {
          prompt: sc.videoPrompt,
          aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT'
        }
      });

      const raw = res?.result;
      const mediaList = raw?.media || [];
      const mediaId = mediaList[0]?.name || null;
      sc.mediaId = mediaId;

      if (statusBadge) {
        statusBadge.textContent = 'Đang Render ⏳';
        statusBadge.className = 'drama-scene-status s-processing';
      }

      // Lưu vào hệ thống task chung để theo dõi
      await sendMsg({
        type: 'SAVE_TASK',
        task: {
          id: 'drama_' + Date.now() + '_' + i,
          type: 'video',
          prompt: `[Scene ${i+1}] ${sc.videoPrompt}`,
          status: 'processing',
          mediaId: mediaId,
          operationName: mediaId,
          createdAt: Date.now()
        }
      });

      // Nghỉ 2s giữa các scene để an toàn quota
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      if (statusBadge) {
        statusBadge.textContent = 'Lỗi gửi';
        statusBadge.className = 'drama-scene-status s-failed';
      }
    }
  }

  btn.disabled = false;
  btn.textContent = '🔄 Bấm để Tạo lại toàn bộ Scenes';
  btnMerge.classList.remove('hidden');
  statusEl.textContent = '✅ Toàn bộ Scenes đã được đưa vào hàng đợi Veo! Khi render xong bạn có thể bấm nút Tải Clips bên dưới.';
  statusEl.className = 'status-msg s-done';
}

// 5. Tải về trọn bộ video clips
async function downloadAllDramaClips() {
  const statusEl = document.getElementById('dramaMergeStatus');
  statusEl.textContent = '📥 Đang kiểm tra và tải các video scenes về máy...';
  statusEl.className = 'status-msg s-processing';
  statusEl.classList.remove('hidden');

  // Lấy các task đã hoàn thành
  const res = await sendMsg({ type: 'GET_TASKS' });
  const allTasks = res?.tasks || [];
  const dramaTasks = allTasks.filter(t => t.prompt && t.prompt.includes('[Scene ') && t.status === 'done' && t.url);

  if (dramaTasks.length === 0) {
    alert('Các video scenes đang trong quá trình render của Google Veo. Vui lòng đợi vài phút rồi bấm tải lại nhé!');
    return;
  }

  dramaTasks.forEach(t => {
    sendMsg({
      type: 'DOWNLOAD_FILE',
      url: t.url,
      mediaId: t.mediaId,
      mediaType: 'video'
    });
  });

  statusEl.textContent = `✅ Đã tải ${dramaTasks.length} video scenes về máy! Bạn hãy mở CapCut ghép với file Audio là xong 100%!`;
  statusEl.className = 'status-msg s-done';
}

// Initialize Drama Studio when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initDramaStudio();
});
