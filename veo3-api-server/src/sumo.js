'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { db } = require('./firebase_worker');
const { uploadToR2 } = require('./s3_uploader');
const { logger, sleep } = require('./utils');
const { runChildTaskWithRetry, updateScene } = require('./autotool');

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_SUMO_SCENES = 6;
const MAX_SUMO_CHARACTERS = 3;
const IMAGE_TIMEOUT_MS = Number(process.env.AUTOTOOL_IMAGE_TIMEOUT_MS || 30 * 60 * 1000);
const VIDEO_TIMEOUT_MS = Number(process.env.AUTOTOOL_VIDEO_TIMEOUT_MS || 45 * 60 * 1000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.AUTOTOOL_DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const FFMPEG_TIMEOUT_MS = Number(process.env.AUTOTOOL_FFMPEG_TIMEOUT_MS || 10 * 60 * 1000);

const activeJobs = new Set();
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed']);

// ─── Character reference image URLs ──────────────────────────────────────────
const CHAR_REFS = {
  bin:     'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/bin_character.jpg',
  sumo:    'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/sumo_character.jpg',
  mother:  'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/mother_character.jpg',
  product: 'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/sumo_product.png',
};

// Detect which character refs to attach based on scene prompt content
function getSumoCharacterRefs(promptText) {
  const p = (promptText || '').toLowerCase();
  const refs = [];
  if (p.includes('bin'))                                                   refs.push(CHAR_REFS.bin);
  if (p.includes('sumo') || p.includes('deer') || p.includes('huu') ||
      p.includes('huou') || p.includes('h\u01b0\u01a1u'))                refs.push(CHAR_REFS.sumo);
  if (p.includes('mother') || p.includes('mom') || p.includes('m\u1eb9')) refs.push(CHAR_REFS.mother);
  if (p.includes('gac huou') || p.includes('g\u1ea1c h\u01b0\u01a1u') ||
      p.includes('pouch')    || p.includes('product') ||
      p.includes('package')  || p.includes('non sumo'))                   refs.push(CHAR_REFS.product);
  if (refs.length === 0) { refs.push(CHAR_REFS.bin, CHAR_REFS.sumo); }
  return refs;
}

// Build speaking note: vị trí nhân vật + chỉ rõ ai nói ai im miệng
function buildSpeakingNote(dialogue, imagePrompt) {
  const p = (imagePrompt || '').toLowerCase();
  const chars = [];
  if (p.includes('bin'))                                                           chars.push('Bin');
  if (p.includes('sumo') || p.includes('deer') || p.includes('huou') ||
      p.includes('hươu'))                                                          chars.push('Sumo');
  if (p.includes('mother') || p.includes('mom') || p.includes('mẹ'))             chars.push('Mom');
  if (chars.length === 0) chars.push('Bin', 'Sumo');

  const positions = ['on the LEFT side of frame', 'on the RIGHT side of frame', 'in the background center'];
  const charPos   = {};
  chars.forEach((c, i) => { charPos[c] = positions[i] || 'in frame'; });
  const posDesc = chars.map(c => `${c} ${charPos[c]}`).join(', ');

  const sp = (dialogue?.[0]?.speaker || '').toLowerCase();
  const speakerName = sp.includes('bin') ? 'Bin'
    : (sp.includes('sumo') || sp.includes('hươu') || sp.includes('huou')) ? 'Sumo'
    : (sp.includes('mẹ') || sp.includes('me') || sp.includes('mom') || sp.includes('mother')) ? 'Mom'
    : chars[0] || 'Bin';
  const listeners = chars.filter(c => c !== speakerName);

  return `Character positions: ${posDesc}. ONLY ${speakerName} speaks and moves lips in this scene.`
    + (listeners.length ? ` ${listeners.join(' and ')} listen(s) quietly with mouth closed, not speaking.` : '');
}


// ─── Shared helpers ───────────────────────────────────────────────────────────
function extractJson(content) {
  const text = String(content || '').trim();
  try { return JSON.parse(text); } catch (_) {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) try { return JSON.parse(fenced[1]); } catch (_) {}
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) return JSON.parse(text.slice(s, e + 1));
  throw new Error('Sumo AI did not return valid JSON: ' + text.slice(0, 300));
}

async function callSumoAI({ system, user, temperature = 0.9, maxRetries = 3 }) {
  const baseUrl = (process.env.AUTOTOOL_AI_BASE_URL || 'http://127.0.0.1:8081').replace(/\/$/, '');
  const apiUrl  = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const apiKey  = process.env.AUTOTOOL_AI_API_KEY;
  if (!apiKey) throw new Error('AUTOTOOL_AI_API_KEY is not configured');
  let lastErr = null;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: process.env.AUTOTOOL_AI_MODEL || 'gemini-2.5-pro',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature,
        }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Sumo AI (${res.status}): ${body.slice(0, 400)}`);
      const content = JSON.parse(body).choices?.[0]?.message?.content;
      if (!content) throw new Error('Sumo AI empty content');
      return extractJson(content);
    } catch (err) {
      lastErr = err;
      logger.warn(`[Sumo] AI attempt ${i}/${maxRetries}: ${err.message}`);
      if (i < maxRetries) await sleep(2000 * i);
    }
  }
  throw lastErr;
}

async function checkUrlExists(url) {
  if (!url || !url.startsWith('http')) return false;
  try { return (await fetch(url, { method: 'HEAD' })).status !== 404; } catch (_) { return false; }
}

async function downloadFile(url, dest) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } finally { clearTimeout(t); }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, FFMPEG_TIMEOUT_MS);
    proc.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-4000); });
    proc.on('error', e => { clearTimeout(t); reject(e); });
    proc.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr}`)); });
  });
}

async function concatenateSumoClips(jobId, clipPaths) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `sumo-${jobId}-`));
  try {
    const concatFile = path.join(tmp, 'concat.txt');
    const out        = path.join(tmp, 'final.mp4');
    await fsp.writeFile(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-movflags', '+faststart', out]);
    } catch (_) {
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
      ]);
    }
    return uploadToR2(await fsp.readFile(out), `meo3/sumo/${jobId}.mp4`, 'video/mp4');
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────
function buildSumoImagePrompt(job, scene, idx, refs = []) {
  const seq   = String(Number(idx) + 1).padStart(3, '0') + '.';

  // Build explicit mapping: tell the model exactly which pasted image = which character/product
  const refLines = [];
  refs.forEach((url, i) => {
    const n = i + 1;
    if (url.includes('bin_character'))    refLines.push(`[Pasted image ${n}] = BIN character — copy EXACTLY: face, body, blue-orange-white striped t-shirt, blue shorts, chubby cheeks, black hair.`);
    else if (url.includes('sumo_character')) refLines.push(`[Pasted image ${n}] = SUMO DEER character — copy EXACTLY: face, antlers, bright red superhero cape, red bow tie, stocky round body, thick short legs, wide torso, ALWAYS standing upright on TWO HIND LEGS only.`);
    else if (url.includes('mother_character')) refLines.push(`[Pasted image ${n}] = MOTHER character — copy EXACTLY: face, hair, clothing, warm expression.`);
    else if (url.includes('sumo_product')) refLines.push(`[Pasted image ${n}] = SUMO GẠC HƯƠU NON product packaging — reproduce the EXACT pouch design: same colors, logo text, layout, shape. This is a product prop in the scene, NOT a character.`);
  });

  const parts = [
    String(scene.imagePrompt || scene.description || '').trim(),
    job.baseImagePrompt ? `Environment: ${job.baseImagePrompt}` : '',
    '3D Pixar animated film style, vibrant, expressive, cute, warm natural lighting.',
    refLines.length > 0
      ? `REFERENCE IMAGES — use EACH pasted image as the EXACT design source: ${refLines.join(' ')} DO NOT alter face shape, clothing colors, clothing pattern, body proportions, species, or product design of any item above.`
      : 'CRITICAL: Characters must be IDENTICAL to their reference images in appearance, clothing, and proportions.',
    'Cinematic staging: natural varied postures with depth (foreground/midground/background). No stiff lineup.',
    'Single unified vertical 9:16 shot. Full-bleed. NO split screen, NO collage, NO panels, NO duplicate characters.',
    'No text, no subtitles, no name labels, no written words on screen.',
  ].filter(Boolean);
  return `${seq} ${parts.join(' ')}`;
}


function buildSumoVideoPrompt(job, scene, idx) {
  const seq  = String(Number(idx) + 1).padStart(3, '0') + '.';
  const dlg  = Array.isArray(scene.dialogue) ? scene.dialogue : [];
  const speakingNote = buildSpeakingNote(dlg, scene.imagePrompt || '');
  const parts = [
    String(scene.videoPrompt || scene.description || '').trim(),
    'Duration: exactly 8 seconds. Vertical 9:16.',
    'IMPORTANT: Chu huou Sumo must ONLY stand and walk on TWO LEGS.',
    speakingNote,
    dlg.length ? `Dialogue (lip sync only the speaker above): ${dlg.map(l => `${l.speaker}: "${l.text}"`).join(' ')}` : '',
    'One coherent 8-second continuous vertical 9:16 clip. Locked static camera, no cuts, no split screen.',
  ].filter(Boolean);
  return `${seq} ${parts.join(' ')}`;
}


// ─── AI script generation ─────────────────────────────────────────────────────
async function generateSumoScript({ topic, episodeNumber = 1 } = {}) {
  const inputTopic = String(topic || '').trim();
  const themePrompt = inputTopic
    ? `Hãy sáng tạo một kịch bản phim hoạt hình 3D Pixar vui nhộn, giáo dục trẻ em về chủ đề: "${inputTopic}". Toàn bộ lời thoại và mô tả phải viết bằng Tiếng Việt CÓ DẤU.`
    : 'Hãy tự sáng tạo chủ đề kịch bản hoạt hình giáo dục trẻ em 3D Pixar ngẫu nhiên (lười ăn rau, uống nước, tiêu hóa, vitamin, ngủ đủ giấc, vận động, ăn uống đa dạng...). Toàn bộ lời thoại và mô tả phải viết bằng Tiếng Việt CÓ DẤU.';

  const locationSeeds = ['bếp ma thuật','khu vườn bí ẩn','siêu thị rau củ khổng lồ','rừng trái cây','vũ trụ dinh dưỡng','camping trong rừng','thế giới trong giấc mơ','công viên nước','tiệm bánh phép thuật','tàu vũ trụ'];
  const moodSeeds = ['hài hước bất ngờ','phiêu lưu kỳ thú','bí ẩn vui nhộn','cuộc thi hào hứng','thám tử điều tra','lễ hội đặc biệt','thử thách vượt chướng ngại'];
  const randomLocation = locationSeeds[(episodeNumber + Math.floor(Math.random() * 3)) % locationSeeds.length];
  const randomMood = moodSeeds[Math.floor(Math.random() * moodSeeds.length)];

  const system = 'Bạn là nhà biên kịch phim hoạt hình 3D Pixar xuất chúng, sáng tạo cho trẻ em Việt Nam 9:16. Tuân thủ JSON schema chính xác và LUÔN LUÔN trả về Tiếng Việt CÓ DẤU (Accented Vietnamese).';

  const userLines = [
    themePrompt,
    `ĐÂY LÀ TẬP ${episodeNumber}. Nội dung PHẢI HOÀN TOÀN KHÁC với các tập trước. Bối cảnh gợi ý: "${randomLocation}". Phong cách: "${randomMood}". Không lặp lại tình huống, địa điểm, hay chi tiết hài hước của các tập trước.`,
    'KỊCH BẢN ĐẶC BIỆT SÁNG TẠO, DÍ DỎM. Dùng 3 nhân vật: bé Bin (5 tuổi, áo kẻ sọc xanh-cam-trắng, quần đùi xanh), chú hươu Sumo (đi 2 chân, áo choàng đỏ, thắt nơ đỏ), nhân vật phụ (Mẹ HOẶC bạn học).',
    'Bối cảnh đa dạng (không rập khuôn picnic): bếp ma thuật, quầy trái cây, rừng rau củ, camping, thế giới mơ...',
    'Lời thoại hài hước: ví dạ dày như đoàn tàu cần nhiên liệu nhiều màu, vitamin như siêu anh hùng...',
    'Cảnh 5 tùy chọn: bài học giáo dục HOẶC giới thiệu sản phẩm Gạc Hươu Non SUMO tự nhiên.',
    'CẤU TRÚC 6 CẢNH:',
    '- Cảnh 1 (Hook): Bin làm gì ngộ nghĩnh/lười. Nhân vật phụ ngạc nhiên. Sumo xuất hiện.',
    '- Cảnh 2 (Thắc mắc): Bin hỏi ngây thơ. Sumo giải thích bằng ví von hài hước.',
    '- Cảnh 3 (Hậu quả): Sumo mô tả hậu quả kịch tính nhẹ (tế bào đình công, bụng kêu cứu...).',
    '- Cảnh 4 (Giải pháp): Sumo tổ chức trò chơi/thử thách. Bin hào hứng.',
    '- Cảnh 5 (Bài học/SP): Giáo dục hoặc giới thiệu sản phẩm tự nhiên.',
    '- Cảnh 6 (Kết + CTA): Bin pose cute cùng Sumo, hỏi khán giả câu vui để kích comment.',
    'BỐ CỤC ĐIỆN ẢNH: KHÔNG đứng hàng ngang. Tư thế đa dạng (ngồi/đứng/tựa). Chiều sâu khung hình. Camera tĩnh, không cắt cảnh. Khung đơn 9:16. Không text/subtitle.',
    'Sumo LUÔN đi 2 chân. Mỗi cảnh có góc máy KHÁC NHAU (close-up/medium/wide).',
    'QUAN TRỌNG - Sản phẩm: Khi cảnh có sản phẩm Gạc Hươu Non SUMO, Sumo phải cầm hoặc đưa GÓI POUCH/TÚI MỀM (giống gói Bin uống bằng ống hút), KHÔNG PHẢI hũ/jar/tub/hộp tròn. imagePrompt phải viết rõ: Sumo holds a soft POUCH product bag.',
    'imagePrompt PHẢI ghi rõ vị trí từng nhân vật: On the LEFT side..., On the RIGHT side..., in the CENTER.... Mỗi cảnh AI tự chọn vị trí hợp lý theo bố cục.',
    'videoPrompt: mô tả chuyển động KHÔNG chứa dialogue.',
    `JSON không markdown: {"title":"...","characters":[{"name":"...","age":"...","role":"...","description":"..."}],"baseImagePrompt":"...","scenes":[{"title":"...","description":"...","imagePrompt":"...","videoPrompt":"...","dialogue":[{"speaker":"...","text":"..."}]}]}`,
    `Dùng ${MAX_SUMO_SCENES} cảnh. dialogue: PHẢI VIẾT BẰNG TIẾNG VIỆT CÓ DẤU, 1 câu/cảnh, 25-35 từ xấp xỉ 8 giây.`,
  ];
  const user = userLines.join('\n');

  const parsed = await callSumoAI({ system, user, temperature: 0.95 });
  const title = String(parsed.title || '').trim().slice(0, 200);
  if (!title) throw new Error('Sumo AI returned empty title');
  const characters = Array.isArray(parsed.characters) ? parsed.characters.slice(0, MAX_SUMO_CHARACTERS) : [];
  if (characters.length < 2) throw new Error('Sumo AI must return at least 2 characters');
  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes.slice(0, MAX_SUMO_SCENES) : [];
  if (scenes.length < 3) throw new Error('Sumo AI must return at least 3 scenes');

  return {
    title,
    characters: characters.map((c, i) => ({
      name: String(c?.name || '').trim().slice(0, 120) || `NV ${i + 1}`,
      age: String(c?.age ?? '').trim().slice(0, 100),
      role: String(c?.role || '').trim().slice(0, 120),
      description: String(c?.description || '').trim().slice(0, 2000),
      voiceIndex: c?.voiceIndex != null ? Number(c.voiceIndex) : i,
    })),
    baseImagePrompt: String(parsed.baseImagePrompt || '').trim().slice(0, 3000),
    scenes: scenes.map((s, i) => ({
      index: i,
      title: String(s?.title || `Cảnh ${i + 1}`).trim().slice(0, 160),
      description: String(s?.description || '').trim().slice(0, 3000),
      imagePrompt: String(s?.imagePrompt || '').trim().slice(0, 3000),
      videoPrompt: String(s?.videoPrompt || '').trim().slice(0, 3000),
      dialogue: Array.isArray(s?.dialogue)
        ? s.dialogue.slice(0, 4).map(l => ({ speaker: String(l?.speaker || '').trim().slice(0, 120), text: String(l?.text || '').trim().slice(0, 600) })).filter(l => l.text)
        : [],
    })),
  };
}

function normalizeSumoScript(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  return {
    topic: String(s.topic || '').trim().slice(0, 300),
    title: String(s.title || '').trim().slice(0, 200),
    channelType: 'sumo',
    characters: Array.isArray(s.characters) ? s.characters.slice(0, MAX_SUMO_CHARACTERS).map((c, i) => ({
      name: String(c?.name || '').trim().slice(0, 120) || `NV ${i + 1}`,
      age: String(c?.age ?? '').trim().slice(0, 100),
      role: String(c?.role || '').trim().slice(0, 120),
      description: String(c?.description || '').trim().slice(0, 2000),
      voiceIndex: c?.voiceIndex != null ? Number(c.voiceIndex) : i,
    })) : [],
    baseImagePrompt: String(s.baseImagePrompt || '').trim().slice(0, 3000),
    scenes: Array.isArray(s.scenes) ? s.scenes.slice(0, MAX_SUMO_SCENES).map((sc, i) => ({
      index: i,
      title: String(sc?.title || `Cảnh ${i + 1}`).trim().slice(0, 160),
      description: String(sc?.description || '').trim().slice(0, 3000),
      imagePrompt: String(sc?.imagePrompt || '').trim().slice(0, 3000),
      videoPrompt: String(sc?.videoPrompt || '').trim().slice(0, 3000),
      imageUrl: sc?.imageUrl || null,
      videoUrl: sc?.videoUrl || null,
      imageStatus: sc?.imageStatus || null,
      videoStatus: sc?.videoStatus || null,
      imageTaskId: sc?.imageTaskId || null,
      videoTaskId: sc?.videoTaskId || null,
      status: sc?.status || null,
      dialogue: Array.isArray(sc?.dialogue)
        ? sc.dialogue.slice(0, 4).map(l => ({ speaker: String(l?.speaker || '').trim().slice(0, 120), text: String(l?.text || '').trim().slice(0, 600), voiceIndex: l?.voiceIndex != null ? Number(l.voiceIndex) : 0 })).filter(l => l.text)
        : [],
    })) : [],
  };
}

async function recordSumoEpisode(jobRef, job) {
  if (!job.scriptId || !job.finalUrl) return;
  const ref = db.collection('drama_scripts').doc(job.scriptId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const episodes = Array.isArray(snap.data().episodes) ? snap.data().episodes : [];
  episodes.push({ jobId: jobRef.id, finalUrl: job.finalUrl, createdAt: Date.now() });
  await ref.update({ episodes, episodeCount: episodes.length, updatedAt: Date.now() });
}

// ─── Main job runner (independent image per scene) ───────────────────────────
async function runSumoJob(jobId) {
  const jobRef = db.collection('drama_jobs').doc(jobId);
  let failedIdx = null;
  try {
    let snap = await jobRef.get();
    if (!snap.exists || TERMINAL_JOB_STATUSES.has(snap.data().status)) return;
    let job = snap.data();
    const isAdmin = job.isAdmin === true;
    const totalSteps = job.scenes.length * 2;
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `sumo-${jobId}-`));
    // Pre-allocate clips array to preserve scene order when running in parallel
    const clips = new Array(job.scenes.length).fill(null);

    // Helper: process a single scene (image → video → download clip)
    const processScene = async (idx) => {
      snap = await jobRef.get(); job = snap.data();
      if (job.status === 'failed') return;
      let scene = job.scenes[idx];

      // STEP 1: gen image independently
      let imgUrl = scene.imageUrl;
      if (!imgUrl || !(await checkUrlExists(imgUrl))) {
        const refs = getSumoCharacterRefs(scene.imagePrompt);
        logger.info(`[Sumo] Scene ${idx + 1}: gen image with ${refs.length} ref(s)${isAdmin ? ' [admin/parallel]' : ''}`);
        const r = await runChildTaskWithRetry({
          jobRef, job: { ...job, characters: job.characters || [] },
          sceneIndex: idx, taskType: 'startImage',
          prompt: buildSumoImagePrompt(job, scene, idx, refs),
          extraTaskData: { userId: job.userId, email: job.userEmail || null, isAdmin, type: 'image', status: 'pending', aspectRatio: '9:16', model: 'nano_banana_2', count: 1, referenceImages: refs },
          timeoutMs: IMAGE_TIMEOUT_MS, stageStatus: 'image_processing',
          progressUpdate: { status: 'generating', currentScene: idx + 1, progress: Math.round((idx * 2 / totalSteps) * 100) },
        });
        imgUrl = r.url; scene.imageUrl = imgUrl;
        await updateScene(jobRef, idx, { imageUrl: imgUrl, startImageUrl: imgUrl, imageStatus: 'completed', startImageStatus: 'completed', status: 'image_completed' }, { progress: Math.round(((idx * 2 + 0.8) / totalSteps) * 100) });
        logger.success(`[Sumo] Scene ${idx + 1} image: ${imgUrl}`);
      }

      // STEP 2: gen video
      snap = await jobRef.get(); job = snap.data();
      if (job.status === 'failed') return;
      scene = job.scenes[idx];
      let vidUrl = scene.videoUrl;
      if (!vidUrl || !(await checkUrlExists(vidUrl))) {
        logger.info(`[Sumo] Scene ${idx + 1}: gen video`);
        const r = await runChildTaskWithRetry({
          jobRef, job: { ...job, characters: job.characters || [] },
          sceneIndex: idx, taskType: 'video',
          prompt: buildSumoVideoPrompt(job, scene, idx),
          extraTaskData: { userId: job.userId, email: job.userEmail || null, isAdmin, type: 'video', status: 'pending', aspectRatio: '9:16', model: 'veo_3_1_lite', count: 1, durationSeconds: 8, startImage: imgUrl },
          timeoutMs: VIDEO_TIMEOUT_MS, stageStatus: 'video_processing',
          progressUpdate: { status: 'generating', currentScene: idx + 1, progress: Math.round(((idx * 2 + 1) / totalSteps) * 100) },
        });
        vidUrl = r.url; scene.videoUrl = vidUrl;
        await updateScene(jobRef, idx, { videoUrl: vidUrl, videoStatus: 'completed', status: 'video_completed' }, { progress: Math.round(((idx * 2 + 1.8) / totalSteps) * 100) });
        logger.success(`[Sumo] Scene ${idx + 1} video: ${vidUrl}`);
      }

      const clip = path.join(tmpDir, `clip-${String(idx).padStart(2, '0')}.mp4`);
      await downloadFile(vidUrl, clip);
      clips[idx] = clip;
      await updateScene(jobRef, idx, { status: 'completed' });
    };

    try {
      if (isAdmin) {
        // Admin: all scenes run in parallel for maximum speed
        logger.info(`[Sumo] Job ${jobId} running ${job.scenes.length} scenes in PARALLEL (admin)`);
        await Promise.all(job.scenes.map((_, idx) => processScene(idx).catch(err => {
          failedIdx = idx;
          throw err;
        })));
      } else {
        // Regular user: sequential scene processing
        for (let idx = 0; idx < job.scenes.length; idx++) {
          failedIdx = idx;
          await processScene(idx);
        }
      }

      snap = await jobRef.get(); job = snap.data();
      if (job.finalUrl) {
        await jobRef.update({ status: 'completed', progress: 100, completedAt: Date.now(), updatedAt: Date.now() });
        await recordSumoEpisode(jobRef, job).catch(() => {});
        return;
      }
      await jobRef.update({ status: 'concatenating', currentScene: null, updatedAt: Date.now() });
      const finalUrl = await concatenateSumoClips(jobId, clips.filter(Boolean));
      await jobRef.update({ status: 'completed', progress: 100, finalUrl, error: null, completedAt: Date.now(), updatedAt: Date.now() });
      await recordSumoEpisode(jobRef, { ...job, finalUrl }).catch(() => {});
      logger.success(`[Sumo] Job ${jobId} done: ${finalUrl}`);
    } finally { await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
  } catch (err) {
    logger.error(`[Sumo] Job ${jobId} failed`, err);
    await jobRef.set({ status: 'failed', error: err.message, failedAt: Date.now(), updatedAt: Date.now() }, { merge: true }).catch(() => {});
    if (failedIdx !== null) await updateScene(jobRef, failedIdx, { status: 'failed', error: err.message }).catch(() => {});
  }
}

function processSumoJob(jobId) {
  if (activeJobs.has(jobId)) return false;
  activeJobs.add(jobId);
  runSumoJob(jobId).finally(() => activeJobs.delete(jobId));
  return true;
}

async function resumeSumoJobs() {
  const snap = await db.collection('drama_jobs').where('channelType', '==', 'sumo').get();
  let n = 0;
  for (const doc of snap.docs) {
    if (!TERMINAL_JOB_STATUSES.has(doc.data().status) && processSumoJob(doc.id)) n++;
  }
  logger.info(`[Sumo] Resumed ${n} job(s)`);
  return n;
}

module.exports = {
  generateSumoScript,
  normalizeSumoScript,
  getSumoCharacterRefs,
  buildSumoImagePrompt,
  buildSumoVideoPrompt,
  processSumoJob,
  resumeSumoJobs,
  MAX_SUMO_SCENES,
  MAX_SUMO_CHARACTERS,
};
