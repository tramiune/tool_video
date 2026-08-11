const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, exec } = require('child_process');

const { db } = require('./firebase_worker');
const { uploadToR2 } = require('./s3_uploader');
const { logger, sleep } = require('./utils');
const audioClient = require('./audio_client');

const {
  runChildTaskWithRetry,
  updateScene,
  waitForTask
} = require('./autotool');

const activeJobs = new Set();
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed']);
const TASK_POLL_INTERVAL_MS = Number(process.env.AUTOTOOL_POLL_INTERVAL_MS || 5000);
const IMAGE_TIMEOUT_MS = Number(process.env.AUTOTOOL_IMAGE_TIMEOUT_MS || 30 * 60 * 1000);
const VIDEO_TIMEOUT_MS = Number(process.env.AUTOTOOL_VIDEO_TIMEOUT_MS || 45 * 60 * 1000);
const AUDIO_TIMEOUT_MS = Number(process.env.DRAMA_AUDIO_TIMEOUT_MS || 10 * 60 * 1000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.AUTOTOOL_DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const FFMPEG_TIMEOUT_MS = Number(process.env.AUTOTOOL_FFMPEG_TIMEOUT_MS || 10 * 60 * 1000);

const DEFAULT_DRAMA_TOPIC = 'mẹ chồng nàng dâu';
const MAX_SCENES = 6;
const MAX_CHARACTERS = 3;

function extractJson(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`AI did not return valid JSON. Raw response: ${text.slice(0, 300)}`);
  }
}

async function callDramaAI({ system, user, temperature = 0.8, maxRetries = 3 }) {
  const baseUrl = (process.env.AUTOTOOL_AI_BASE_URL || 'http://127.0.0.1:8081').replace(/\/$/, '');
  const apiUrl = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const apiKey = process.env.AUTOTOOL_AI_API_KEY;
  if (!apiKey) throw new Error('AUTOTOOL_AI_API_KEY is not configured');

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.AUTOTOOL_SCRIPT_TIMEOUT_MS || 180000));
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.AUTOTOOL_AI_MODEL || 'gemini-3.6-flash',
          temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Drama AI request failed (${response.status}): ${body.slice(0, 500)}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      try {
        return extractJson(content);
      } catch (parseError) {
        lastError = parseError;
        logger.warn(`[Drama] AI returned non-JSON on attempt ${attempt}: ${String(content || '').slice(0, 200)}`);
        if (attempt >= maxRetries) throw lastError;
        user += '\n\nQUAN TRỌNG: Phản hồi trước của bạn KHÔNG phải JSON hợp lệ. Hãy chỉ trả về MỘT đối tượng JSON thuần túy đúng schema yêu cầu, không mở đầu, không giải thích, không markdown.';
        await sleep(1000 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Drama AI call failed');
}

// ─── STEP 1: AI drafts the whole drama script ───────────────────────────────
// Produces: title, characters (name/age/role/description), base image prompt,
// and up to 6 scenes, each with a Vietnamese spoken dialogue.
async function generateDramaScript({ topic }) {
  const inputTopic = String(topic || '').trim();
  const themePrompt = inputTopic 
    ? `Hãy sáng tạo một kịch bản phim ngắn drama về chủ đề cụ thể: "${inputTopic}".`
    : 'Hãy tự sáng tạo ra một chủ đề drama gia đình Việt Nam ngẫu nhiên bất kỳ (mâu thuẫn mẹ chồng nàng dâu, ngoại tình, phân chia tài sản, sự vô cảm,...) thật kịch tính và viết kịch bản dựa trên chủ đề tự nghĩ đó.';

  const parsed = await callDramaAI({
    system: 'Bạn là biên kịch phim ngắn drama gia đình Việt Nam dạng dọc (9:16). '
      + 'Tuân thủ chính xác schema JSON được yêu cầu, không xuất thêm gì khác.',
    user: [
      themePrompt,
      'Kịch bản phải đánh trúng cảm xúc, có kịch tính, nhiều mâu thuẫn và cao trào, kiểu nội dung "mẹ chồng nàng dâu" hoặc drama gia đình dễ gây tranh cãi.',
      'Trả về JSON đúng dạng, không markdown, không chú thích, đúng hình dạng sau:',
      '{"title":"...","characters":[{"name":"...","age":"...","role":"...","description":"..."}],"baseImagePrompt":"...","scenes":[{"title":"...","description":"...","imagePrompt":"...","videoPrompt":"...","dialogue":[{"speaker":"...","text":"..."}]}]}',
      '- title: tiêu đề kịch bản, ngắn gọn, gây tò mò (tiếng Việt).',
      '- characters: 3 nhân vật, mỗi người có role (vd: "con dâu", "mẹ chồng", "chồng") và description ngắn.',
      '- baseImagePrompt: prompt tiếng Anh mô tả khung cảnh gốc + phong cách hình ảnh chung (vd: "A 3D Pixar-style modern Vietnamese house, cinematic lighting..."), vertical 9:16.',
      `- scenes: đúng ${MAX_SCENES} cảnh. Mỗi cảnh có title, description (tiếng Anh, mô tả hình ảnh khung hình), imagePrompt (prompt tiếng Anh cho khung hình đó), videoPrompt (prompt tiếng Anh mô tả chuyển động/hành động của clip 8 giây), và dialogue (mảng các câu thoại tiếng Việt, mỗi câu có speaker trùng tên nhân vật trong characters và text lời thoại).`,
      '- YÊU CẦU QUAN TRỌNG VỀ THOẠI (DIALOGUE):',
      '  * Bắt buộc cảnh nào cũng phải có thoại. Mảng dialogue của mỗi cảnh chỉ được phép chứa đúng 1 câu thoại duy nhất của 1 nhân vật (1 người nói duy nhất mỗi cảnh, không có đối thoại qua lại trong cùng 1 cảnh).',
      '  * Mỗi câu thoại phải đủ dài để đọc/nói chậm rãi trong khoảng 7 đến 8 giây (độ dài kịch bản thoại khoảng 25-35 từ tiếng Việt), diễn đạt sâu sắc, kịch tính, tránh thoại ngắn cụt lủn.',
      'YÊU CẦU QUAN TRỌNG VỀ PHỐI CẢNH & VỊ TRÍ NHÂN VẬT:',
      '- Cảnh 1 (Scene 1) PHẢI chứa đầy đủ tất cả các nhân vật trong characters cùng xuất hiện trong một khung hình (ví dụ: mô tả rõ cả Huy, Lan và bà mẹ đều đứng trong phòng khách). Mô tả chi tiết ngoại hình và trang phục của họ ngay trong Cảnh 1.',
      '- Các nhân vật tuyệt đối KHÔNG ĐƯỢC phép di chuyển đi đâu hết, không được di chuyển/chạy ra khỏi vị trí đứng ban đầu của họ xuyên suốt kịch bản. Ví dụ: Nếu Huy đứng ở rìa bên trái, Lan đứng ở rìa bên phải ở Cảnh 1, thì trong các cảnh 2, 3, 4, 5, 6 cả hai vẫn phải đứng yên tại vị trí đó (Huy rìa bên trái, Lan rìa bên phải), tuyệt đối không đi lại, không thay đổi vị trí đứng.',
      '- Trong baseImagePrompt, imagePrompt và videoPrompt của TẤT CẢ các cảnh, PHẢI mô tả cực kỳ rõ ràng vị trí đứng cố định sát hai bên rìa của từng nhân vật bằng tiếng Anh (ví dụ: "Huy is standing completely static on the far left side, Lan is standing completely static on the far right side. Both characters remain fixed in their spots, talking with subtle facial expressions and natural lip movements, without walking or shifting positions"). Giữ nguyên vị trí cực hạn cố định này nhất quán xuyên suốt các cảnh.',
      '- Khóa góc máy (Locked camera shot): mô tả camera tĩnh hoặc chuyển động cực kỳ nhẹ (static camera, locked medium shot), tuyệt đối không viết prompt dạng chuyển cảnh, cắt cảnh (no camera cuts, no camera angle changes, keep both characters in the frame at all times) để đảm bảo video ghép lại không bị giật, nhảy hình.'
    ].join('\n'),
    temperature: 0.9
  });

  const title = String(parsed.title || '').trim().slice(0, 200);
  if (!title) throw new Error('Drama AI returned an empty title');

  const characters = Array.isArray(parsed.characters) ? parsed.characters.slice(0, MAX_CHARACTERS) : [];
  if (characters.length < 2) throw new Error('Drama AI must return at least 2 characters');

  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes.slice(0, MAX_SCENES) : [];
  if (scenes.length < 3) throw new Error('Drama AI must return at least 3 scenes');

  return {
    title,
    characters: characters.map((character, index) => ({
      name: String(character?.name || '').trim().slice(0, 120) || `Nhân vật ${index + 1}`,
      age: String(character?.age ?? '').trim().slice(0, 100),
      role: String(character?.role || '').trim().slice(0, 120),
      description: String(character?.description || '').trim().slice(0, 2000),
      voiceIndex: character?.voiceIndex !== undefined && character?.voiceIndex !== null ? Number(character.voiceIndex) : index
    })),
    baseImagePrompt: String(parsed.baseImagePrompt || '').trim().slice(0, 3000),
    scenes: scenes.map((scene, index) => ({
      index,
      title: String(scene?.title || `Cảnh ${index + 1}`).trim().slice(0, 160),
      description: String(scene?.description || '').trim().slice(0, 3000),
      imagePrompt: String(scene?.imagePrompt || '').trim().slice(0, 3000),
      videoPrompt: String(scene?.videoPrompt || '').trim().slice(0, 3000),
      dialogue: Array.isArray(scene?.dialogue) ? scene.dialogue.slice(0, 4).map(line => ({
        speaker: String(line?.speaker || '').trim().slice(0, 120),
        text: String(line?.text || '').trim().slice(0, 600)
      })).filter(line => line.text) : []
    }))
  };
}

function normalizeDramaScript(raw) {
  const script = (raw && typeof raw === 'object') ? raw : {};
  const characters = Array.isArray(script.characters) ? script.characters.slice(0, MAX_CHARACTERS) : [];
  return {
    topic: String(script.topic || '').trim().slice(0, 300),
    title: String(script.title || '').trim().slice(0, 200),
    characters: characters.map((character, index) => ({
      name: String(character?.name || '').trim().slice(0, 120) || `Nhân vật ${index + 1}`,
      age: String(character?.age ?? '').trim().slice(0, 100),
      role: String(character?.role || '').trim().slice(0, 120),
      description: String(character?.description || '').trim().slice(0, 2000),
      voiceIndex: character?.voiceIndex !== undefined && character?.voiceIndex !== null ? Number(character.voiceIndex) : index
    })),
    baseImagePrompt: String(script.baseImagePrompt || '').trim().slice(0, 3000),
    scenes: Array.isArray(script.scenes) ? script.scenes.slice(0, MAX_SCENES).map((scene, index) => ({
      index,
      title: String(scene?.title || `Cảnh ${index + 1}`).trim().slice(0, 160),
      description: String(scene?.description || '').trim().slice(0, 3000),
      imagePrompt: String(scene?.imagePrompt || '').trim().slice(0, 3000),
      videoPrompt: String(scene?.videoPrompt || '').trim().slice(0, 3000),
      imageUrl: scene?.imageUrl || null,
      videoUrl: scene?.videoUrl || null,
      imageTaskId: scene?.imageTaskId || null,
      videoTaskId: scene?.videoTaskId || null,
      imageStatus: scene?.imageStatus || null,
      videoStatus: scene?.videoStatus || null,
      dialogue: Array.isArray(scene?.dialogue) ? scene.dialogue.slice(0, 4).map(line => ({
        speaker: String(line?.speaker || '').trim().slice(0, 120),
        text: String(line?.text || '').trim().slice(0, 600)
      })).filter(line => line.text) : []
    })) : []
  };
}

// ─── STEP 2: video job ──────────────────────────────────────────────────────
// For each scene: image → 8s video, then generate Vietnamese TTS for the
// dialogue and overlay it on the clip, then concatenate all clips.

async function waitForAudioOutput(jobUid) {
  const deadline = Date.now() + AUDIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const jobs = await audioClient.listJobs().catch(() => []);
    const match = jobs.find(job => job.jobUid === jobUid);
    if (match) {
      const status = String(match.status || '');
      if (/FAIL|ERROR/i.test(status)) {
        throw new Error(`Audio generation failed (${status})`);
      }
      if (match.outputUrl) {
        return match.outputUrl.startsWith('http')
          ? match.outputUrl
          : `${audioClient.BASE_URL}${match.outputUrl}`;
      }
    }
    await sleep(TASK_POLL_INTERVAL_MS);
  }
  throw new Error(`Audio generation timed out for ${jobUid}`);
}

async function checkUrlExists(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.status !== 404;
  } catch (error) {
    logger.warn(`[Drama] Error checking URL existence for ${url}: ${error.message}`);
    return false;
  }
}

async function generateDialogueAudio(text, voiceIndex = 0) {
  const jobUid = await audioClient.createJob(text, 'vi', Number(voiceIndex));
  await audioClient.startJob(jobUid);
  logger.info(`[Drama] TTS job ${jobUid} started for ${String(text).slice(0, 40)}...`);
  return waitForAudioOutput(jobUid);
}

async function downloadFile(url, destination) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(destination, buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL');
      reject(new Error('ffmpeg concatenation timed out'));
    }, FFMPEG_TIMEOUT_MS);
    childProcess.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    childProcess.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    childProcess.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

function getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
    exec(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`, (err, stdout) => {
      if (err) {
        logger.error(`[Drama] Failed to get audio duration: ${err.message}`);
        resolve(0);
      } else {
        const dur = parseFloat(stdout.trim());
        resolve(isNaN(dur) ? 0 : dur);
      }
    });
  });
}

// Overlay an audio file on top of a silent video clip (audio length matches clip).
// If speech ends before 8 seconds, freeze the last frame for the remaining duration to lock character.
async function muxAudioIntoTemp(clipPath, audioPath, outputPath) {
  try {
    const D = await getAudioDuration(audioPath);
    logger.info(`[Drama] Muxing audio/video. Audio duration: ${D.toFixed(2)}s`);

    if (D > 0 && D < 8) {
      const padDur = 8 - D;
      // Trim video at D seconds, clone the last frame (tpad stop_mode=clone) for the remaining (8-D) seconds,
      // and pad the audio with silence so the output is exactly 8 seconds long.
      await runFfmpeg([
        '-y', '-i', clipPath, '-i', audioPath,
        '-filter_complex', `[0:v]trim=end=${D.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${padDur.toFixed(3)}[v];[1:a]apad=pad_dur=${padDur.toFixed(3)}[a]`,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart', outputPath
      ]);
    } else {
      await runFfmpeg([
        '-y', '-i', clipPath, '-i', audioPath,
        '-filter_complex', '[1:a]apad=pad_dur=1[a]',
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart', outputPath
      ]);
    }
  } catch (error) {
    logger.warn(`[Drama] Complex mux failed (${error.message}), retrying with simple shortest mux...`);
    try {
      await runFfmpeg([
        '-y', '-i', clipPath, '-i', audioPath,
        '-filter_complex', '[1:a]apad=pad_dur=1[a]',
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart', outputPath
      ]);
    } catch (fallbackError) {
      logger.error(`[Drama] Fallback mux also failed: ${fallbackError.message}`);
      throw fallbackError;
    }
  }
}

// If a scene has multiple dialogue lines, merge them into one audio track.
async function mergeDialogues(clipPath, dialogue, tempDir, sceneIndex) {
  if (!Array.isArray(dialogue) || dialogue.length === 0) return null;
  const audioPaths = [];
  for (let lineIndex = 0; lineIndex < dialogue.length; lineIndex++) {
    const line = dialogue[lineIndex];
    if (!line.text) continue;
    const audioPath = path.join(tempDir, `scene${sceneIndex}-line${lineIndex}.wav`);
    const url = await generateDialogueAudio(line.text, line.voiceIndex ?? 0);
    await downloadFile(url, audioPath);
    audioPaths.push(audioPath);
  }
  if (audioPaths.length === 0) return null;
  if (audioPaths.length === 1) return audioPaths[0];

  const mergedPath = path.join(tempDir, `scene${sceneIndex}-merged.m4a`);
  const listPath = path.join(tempDir, `scene${sceneIndex}-list.txt`);
  await fsp.writeFile(listPath, audioPaths.map(audioPath => `file '${audioPath}'`).join('\n'));
  try {
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'aac', '-b:a', '128k', mergedPath]);
  } catch (error) {
    logger.warn(`[Drama] Audio merge failed (${error.message}), retrying with resample...`);
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-ar', '24000', '-ac', '1',
      '-c:a', 'aac', '-b:a', '128k', mergedPath
    ]);
  }
  return mergedPath;
}

async function concatenateClips(jobId, clipPaths) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `drama-${jobId}-`));
  try {
    const concatPath = path.join(tempDir, 'concat.txt');
    const outputPath = path.join(tempDir, 'final.mp4');
    await fsp.writeFile(concatPath, clipPaths.map(clipPath => `file '${clipPath}'`).join('\n'));
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', outputPath]);
    } catch (error) {
      logger.warn(`[Drama] Stream-copy concat failed (${error.message}), retrying with transcoding...`);
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath
      ]);
    }
    const output = await fsp.readFile(outputPath);
    return uploadToR2(output, `meo3/drama/${jobId}.mp4`, 'video/mp4');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runDramaJob(jobId) {
  const jobRef = db.collection('drama_jobs').doc(jobId);
  let failedSceneIndex = null;
  try {
    let snapshot = await jobRef.get();
    if (!snapshot.exists || TERMINAL_JOB_STATUSES.has(snapshot.data().status)) return;
    let job = snapshot.data();

    const totalSteps = job.scenes.length * 3;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `drama-${jobId}-`));
    const clipPaths = [];

    try {
      // Combined Phase 1 & 2: Process scenes sequentially.
      // Scene 1 generates a still image via AI.
      // Scenes N (N > 1) extract the last frame of Scene N-1 video as their still image.
      // All scene videos are generated with startImage = scene still, endImage = null.
      for (let index = 0; index < job.scenes.length; index++) {
        failedSceneIndex = index;
        snapshot = await jobRef.get();
        job = snapshot.data();
        if (job.status === 'failed') {
          logger.info(`[Drama] Job ${jobId} aborted in step 1 of scene ${index + 1} due to cancellation.`);
          return;
        }
        let scene = job.scenes[index];

        // 1. Get or generate the start image for this scene
        let imageUrl = scene.imageUrl;
        const imgExists = await checkUrlExists(imageUrl);
        if (!imageUrl || !imgExists) {
          imageUrl = null; // force regeneration if missing or deleted
          if (index === 0) {
            // Scene 1: Generate initial still image
            const imageResult = await runChildTaskWithRetry({
              jobRef,
              job: { ...job, characters: job.characters || [] },
              sceneIndex: index,
              taskType: 'image',
              prompt: buildScenePrompt(job, scene, 'image'),
              extraTaskData: {
                userId: job.userId,
                email: job.userEmail || null,
                type: 'image',
                status: 'pending',
                aspectRatio: '9:16',
                model: 'nano_banana_2',
                count: 1,
                referenceImages: [],
                dramaJobId: jobId,
                sceneIndex: index,
                createdAt: Date.now()
              },
              timeoutMs: IMAGE_TIMEOUT_MS,
              stageStatus: 'image_processing',
              progressUpdate: {
                status: 'generating',
                currentScene: index + 1,
                progress: Math.round(((index * 2) / (job.scenes.length * 2)) * 100)
              }
            });
            imageUrl = imageResult.url;
            scene.imageUrl = imageUrl;
            await updateScene(jobRef, index, { imageUrl, status: 'image_completed' }, {
              progress: Math.round(((index * 2 + 0.5) / (job.scenes.length * 2)) * 100)
            });
          } else {
            // Scene N (N > 1): Extract last frame from previous scene's video
            const prevScene = job.scenes[index - 1];
            if (!prevScene || !prevScene.videoUrl) {
              throw new Error(`Cảnh ${index} chưa có video để trích xuất frame cuối`);
            }
            logger.info(`[Drama] Extracting last frame from scene ${index} video: ${prevScene.videoUrl}`);
            const prevVideoPath = path.join(tempDir, `prev-clip-${index}.mp4`);
            const lastFramePath = path.join(tempDir, `last-frame-${index}.png`);
            
            await downloadFile(prevScene.videoUrl, prevVideoPath);
            await runFfmpeg([
              '-y',
              '-sseof', '-0.1',
              '-i', prevVideoPath,
              '-vframes', '1',
              '-q:v', '2',
              lastFramePath
            ]);
            
            const lastFrameBuffer = await fsp.readFile(lastFramePath);
            imageUrl = await uploadToR2(lastFrameBuffer, `meo3/images/${jobId}_scene_${index + 1}_image.png`, 'image/png');
            scene.imageUrl = imageUrl;
            await updateScene(jobRef, index, { imageUrl, status: 'image_completed' }, {
              progress: Math.round(((index * 2 + 0.5) / (job.scenes.length * 2)) * 100)
            });
            logger.success(`[Drama] Scene ${index + 1} image extracted and uploaded: ${imageUrl}`);
          }
        }

        // 2. Generate video for this scene
        snapshot = await jobRef.get();
        job = snapshot.data();
        if (job.status === 'failed') {
          logger.info(`[Drama] Job ${jobId} aborted in step 2 of scene ${index + 1} due to cancellation.`);
          return;
        }
        let videoUrl = scene.videoUrl;
        const vidExists = await checkUrlExists(videoUrl);
        if (!videoUrl || !vidExists) {
          const videoResult = await runChildTaskWithRetry({
            jobRef,
            job: { ...job, characters: job.characters || [] },
            sceneIndex: index,
            taskType: 'video',
            prompt: buildScenePrompt(job, scene, 'video'),
            extraTaskData: {
              userId: job.userId,
              email: job.userEmail || null,
              type: 'video',
              status: 'pending',
              aspectRatio: '9:16',
              model: 'veo_3_1_lite',
              count: 1,
              durationSeconds: 8,
              startImage: imageUrl,
              endImage: null,
              dramaJobId: jobId,
              sceneIndex: index,
              createdAt: Date.now()
            },
            timeoutMs: VIDEO_TIMEOUT_MS,
            stageStatus: 'video_processing',
            progressUpdate: {
              status: 'generating',
              currentScene: index + 1,
              progress: Math.round(((index * 2 + 1) / (job.scenes.length * 2)) * 100)
            }
          });
          scene.videoUrl = videoResult.url;
          await updateScene(jobRef, index, { videoUrl: videoResult.url, status: 'video_completed' }, {
            progress: Math.round(((index * 2 + 2) / (job.scenes.length * 2)) * 100)
          });
        }
      }

      // Phase 3: dialogue TTS bypassed. Direct clip compilation using Veo3 native audio.
      for (let index = 0; index < job.scenes.length; index++) {
        failedSceneIndex = index;
        snapshot = await jobRef.get();
        job = snapshot.data();
        if (job.status === 'failed') {
          logger.info(`[Drama] Job ${jobId} aborted in Phase 3 scene ${index + 1} due to cancellation.`);
          return;
        }
        const scene = job.scenes[index];
        const clipPath = path.join(tempDir, `clip-${String(index).padStart(2, '0')}.mp4`);
        await downloadFile(scene.videoUrl, clipPath);
        clipPaths.push(clipPath);
        await updateScene(jobRef, index, { audioStatus: 'none', status: 'completed' });
      }

      snapshot = await jobRef.get();
      job = snapshot.data();
      if (job.finalUrl) {
        await jobRef.update({ status: 'completed', progress: 100, completedAt: Date.now(), updatedAt: Date.now() });
        await recordDramaEpisode(jobRef, job).catch(() => {});
        return;
      }
      if (clipPaths.some(clipPath => !clipPath)) throw new Error('Not all scenes have completed video clips');
      await jobRef.update({ status: 'concatenating', currentScene: null, updatedAt: Date.now() });
      const finalUrl = await concatenateClips(jobId, clipPaths);
      await jobRef.update({
        status: 'completed',
        progress: 100,
        finalUrl,
        error: null,
        completedAt: Date.now(),
        updatedAt: Date.now()
      });
      const completedJob = { ...job, status: 'completed', progress: 100, finalUrl, completedAt: Date.now() };
      await recordDramaEpisode(jobRef, completedJob).catch(() => {});
      logger.success(`[Drama] Job ${jobId} completed: ${finalUrl}`);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    logger.error(`[Drama] Job ${jobId} failed`, error);
    const update = { status: 'failed', error: error.message, failedAt: Date.now(), updatedAt: Date.now() };
    await jobRef.set(update, { merge: true }).catch(() => {});
    if (failedSceneIndex !== null) {
      await updateScene(jobRef, failedSceneIndex, { status: 'failed', error: error.message }).catch(() => {});
    }
  }
}

function resolveVoiceIndex(characters, speakerName) {
  const name = String(speakerName || '').trim().toLowerCase();
  const character = characters.find(character => String(character.name || '').trim().toLowerCase() === name);
  if (character && character.voiceIndex !== undefined && character.voiceIndex !== null) {
    return Number(character.voiceIndex);
  }
  const index = characters.findIndex(character => String(character.name || '').trim().toLowerCase() === name);
  return index >= 0 ? index : 0;
}

function getCharacterPositionLabel(job, scene, speakerName) {
  const name = String(speakerName || '').trim().toLowerCase();
  const characters = Array.isArray(job.characters) ? job.characters : [];
  const charObj = characters.find(c => String(c.name || '').trim().toLowerCase() === name);
  
  // 1. Determine descriptor (gender/age)
  let descriptor = 'person';
  if (charObj) {
    const role = String(charObj.role || '').toLowerCase();
    const desc = String(charObj.description || '').toLowerCase();
    const charName = String(charObj.name || '').toLowerCase();
    
    if (role.includes('mẹ') || role.includes('bà') || charName.includes('bà') || desc.includes('bà') || desc.includes('elderly woman') || desc.includes('old woman')) {
      descriptor = 'elderly woman';
    } else if (role.includes('con dâu') || role.includes('vợ') || charName.includes('lan') || role.includes('nữ') || desc.includes('young woman') || desc.includes('girl')) {
      descriptor = 'young woman';
    } else if (role.includes('chồng') || role.includes('con trai') || charName.includes('huy') || role.includes('nam') || desc.includes('young man') || desc.includes('boy')) {
      descriptor = 'young man';
    } else if (role.includes('bố') || role.includes('cha') || role.includes('ông') || desc.includes('elderly man') || desc.includes('old man')) {
      descriptor = 'elderly man';
    } else if (role.includes('nữ') || desc.includes('woman') || desc.includes('female')) {
      descriptor = 'woman';
    } else if (role.includes('nam') || desc.includes('man') || desc.includes('male')) {
      descriptor = 'man';
    }
  }

  // 2. Find position (left or right)
  const fullText = [
    scene.videoPrompt,
    scene.imagePrompt,
    scene.description,
    job.baseImagePrompt
  ].filter(Boolean).join(' ').toLowerCase();

  let position = '';
  const nameIdx = fullText.indexOf(name);
  if (nameIdx >= 0) {
    const windowText = fullText.slice(Math.max(0, nameIdx - 40), Math.min(fullText.length, nameIdx + 60));
    if (windowText.includes('left')) {
      position = 'on the far left side';
    } else if (windowText.includes('right')) {
      position = 'on the far right side';
    }
  }

  if (!position) {
    if (fullText.includes(`${name} is standing on the left`) || fullText.includes(`${name} on the left`)) {
      position = 'on the far left side';
    } else if (fullText.includes(`${name} is standing on the right`) || fullText.includes(`${name} on the right`)) {
      position = 'on the far right side';
    }
  }

  if (!position && charObj) {
    const charIdx = characters.indexOf(charObj);
    position = charIdx === 0 ? 'on the far left side' : 'on the far right side';
  }

  return `the ${descriptor} standing ${position || 'on the far right side'}`;
}

function buildScenePrompt(job, scene, mediaType) {
  const baseImagePrompt = String(job.baseImagePrompt || '').trim();
  const characters = Array.isArray(job.characters) ? job.characters.filter(c => String(c.name || '').trim()) : [];
  const characterLines = characters.map(character => {
    const role = String(character.role || '').trim();
    const description = String(character.description || '').trim();
    const name = String(character.name || '').trim();
    return `- ${name}${role ? ` (${role})` : ''}${description ? `: ${description}` : ''}`;
  });

  const dialogues = Array.isArray(scene.dialogue) ? scene.dialogue : [];
  const dialogueLines = dialogues.map(line => {
    const positionLabel = getCharacterPositionLabel(job, scene, line.speaker);
    return `- [${positionLabel}]: "${line.text}"`;
  }).join('\n');

  const parts = [];
  if (mediaType === 'image') {
    parts.push(String(scene.imagePrompt || scene.description || '').trim());
    if (baseImagePrompt) {
      parts.push(`Setting (keep identical in every frame): ${baseImagePrompt}`);
    }
    if (characterLines.length > 0) {
      parts.push(`Recurring characters (keep their face, body, clothing and appearance EXACTLY identical across all scenes):\n${characterLines.join('\n')}`);
      if (scene.index === 0) {
        parts.push('Important: All of the listed characters MUST be present and visible together in this single image.');
      }
    }
    parts.push('Vertical 9:16 composition. Photorealistic Vietnamese family drama.');
  } else {
    parts.push(String(scene.videoPrompt || scene.description || '').trim());
    if (baseImagePrompt) {
      parts.push(`Setting (keep identical in every frame): ${baseImagePrompt}`);
    }
    if (characterLines.length > 0) {
      parts.push(`Recurring characters (keep their face, body, clothing and appearance EXACTLY identical across all scenes):\n${characterLines.join('\n')}`);
    }
    if (dialogueLines) {
      parts.push(`Important: Character Dialogues (make sure their lips move/talk and their expressions match this dialogue):\n${dialogueLines}`);
    }
    parts.push('Important: Both characters must remain completely static in their spots. Absolutely no walking, no shifting places, no running out of their positions. Keep the actors fixed in their positions, only their mouths and subtle facial expressions move.');
    parts.push('Create one coherent 8-second vertical clip. Photorealistic Vietnamese family drama, natural movement.');
  }
  return parts.join('\n');
}

// ─── SINGLE-SCENE MEDIA GENERATION ─────────────────────────────────────────
// Generate just one scene's still image or video independently, persisting the
// result (imageUrl/videoUrl) back onto the drama_scripts scene document.
function sceneTaskId(scriptId, sceneIndex, mediaType) {
  return `${scriptId}_scene_${sceneIndex + 1}_${mediaType}`;
}

// Validates the request, marks the scene as processing, then spawns the
// generation in the background. Returns immediately with the deterministic
// taskId so the frontend can poll the script doc / task for progress.
async function startSceneMedia({
  scriptRef, script, sceneIndex, mediaType, userId, userEmail
}) {
  const scene = script.scenes[sceneIndex];
  if (!scene) throw new Error(`Cảnh ${sceneIndex + 1} không tồn tại`);

  const taskId = sceneTaskId(scriptRef.id, sceneIndex, mediaType);

  if (mediaType === 'video' && !scene.imageUrl) {
    throw new Error('Cảnh chưa có ảnh. Vui lòng tạo ảnh cho cảnh này trước.');
  }

  await updateScene(scriptRef, sceneIndex, {
    [`${mediaType}TaskId`]: taskId,
    [`${mediaType}Status`]: 'processing',
    status: `${mediaType}_processing`,
    error: null
  });

  generateSceneMedia({ scriptRef, script, sceneIndex, mediaType, userId, userEmail })
    .catch((error) => {
      logger.error(`[Drama] Scene ${sceneIndex + 1} ${mediaType} failed: ${error.message}`);
    });

  return { taskId, mediaType, status: 'processing' };
}

async function generateSceneMedia({
  scriptRef, script, sceneIndex, mediaType, userId, userEmail
}) {
  const scene = script.scenes[sceneIndex];
  if (!scene) throw new Error(`Cảnh ${sceneIndex + 1} không tồn tại`);

  const job = {
    ...script,
    characters: script.characters || [],
    baseImagePrompt: script.baseImagePrompt || ''
  };

  try {
    if (mediaType === 'image') {
      const imageResult = await runChildTaskWithRetry({
        jobRef: scriptRef,
        job,
        sceneIndex,
        taskType: 'image',
        prompt: buildScenePrompt(job, scene, 'image'),
        extraTaskData: {
          userId,
          email: userEmail || null,
          type: 'image',
          status: 'pending',
          aspectRatio: '9:16',
          model: 'nano_banana_2',
          count: 1,
          referenceImages: [],
          dramaScriptId: scriptRef.id,
          sceneIndex,
          createdAt: Date.now()
        },
        timeoutMs: IMAGE_TIMEOUT_MS,
        stageStatus: 'image_processing'
      });
      await updateScene(scriptRef, sceneIndex, {
        imageUrl: imageResult.url,
        imageStatus: 'completed',
        status: 'completed'
      });
      return { url: imageResult.url, taskId: imageResult.taskId, mediaType };
    }
    const videoResult = await runChildTaskWithRetry({
      jobRef: scriptRef,
      job,
      sceneIndex,
      taskType: 'video',
      prompt: buildScenePrompt(job, scene, 'video'),
      extraTaskData: {
        userId,
        email: userEmail || null,
        type: 'video',
        status: 'pending',
        aspectRatio: '9:16',
        model: 'veo_3_1_lite',
        count: 1,
        durationSeconds: 8,
        startImage: scene.imageUrl,
        endImage: null,
        dramaScriptId: scriptRef.id,
        sceneIndex,
        createdAt: Date.now()
      },
      timeoutMs: VIDEO_TIMEOUT_MS,
      stageStatus: 'video_processing'
    });
    await updateScene(scriptRef, sceneIndex, {
      videoUrl: videoResult.url,
      videoStatus: 'completed',
      status: 'completed'
    });
    return { url: videoResult.url, taskId: videoResult.taskId, mediaType };
  } catch (error) {
    await updateScene(scriptRef, sceneIndex, {
      [`${mediaType}Status`]: 'failed',
      status: 'failed',
      error: error.message
    }).catch(() => {});
    throw error;
  }
}

async function recordDramaEpisode(jobRef, job) {
  const scriptId = job?.scriptId;
  if (!scriptId) return;
  const scriptRef = db.collection('drama_scripts').doc(scriptId);
  const snapshot = await scriptRef.get();
  if (!snapshot.exists) return;
  const episodes = Array.isArray(snapshot.data().episodes) ? snapshot.data().episodes : [];
  const record = {
    number: job.episodeNumber || episodes.length + 1,
    title: job.title || `Tập ${job.episodeNumber || episodes.length + 1}`,
    jobId: jobRef.id,
    finalUrl: job.finalUrl || null,
    completedAt: job.completedAt || Date.now()
  };
  const existingIndex = episodes.findIndex(episode => episode.jobId === jobRef.id);
  if (existingIndex !== -1) episodes[existingIndex] = record;
  else episodes.push(record);
  await scriptRef.update({ episodes, updatedAt: Date.now() });
  logger.success(`[Drama] Episode history recorded for script ${scriptId}`);
}

function processDramaJob(jobId) {
  if (activeJobs.has(jobId)) return false;
  activeJobs.add(jobId);
  runDramaJob(jobId).finally(() => activeJobs.delete(jobId));
  return true;
}

async function resumeDramaJobs() {
  const snapshot = await db.collection('drama_jobs').get();
  let resumed = 0;
  for (const document of snapshot.docs) {
    if (!TERMINAL_JOB_STATUSES.has(document.data().status) && processDramaJob(document.id)) resumed++;
  }
  logger.info(`[Drama] Resumed ${resumed} nonterminal job(s)`);
  return resumed;
}

module.exports = {
  generateDramaScript,
  normalizeDramaScript,
  processDramaJob,
  resumeDramaJobs,
  startSceneMedia,
  buildScenePrompt,
  sceneTaskId,
  MAX_SCENES,
  MAX_CHARACTERS
};
