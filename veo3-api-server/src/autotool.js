const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { db } = require('./firebase_worker');
const { uploadToR2 } = require('./s3_uploader');
const { logger, sleep } = require('./utils');

const activeJobs = new Set();
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed']);
const TASK_POLL_INTERVAL_MS = Number(process.env.AUTOTOOL_POLL_INTERVAL_MS || 5000);
const IMAGE_TIMEOUT_MS = Number(process.env.AUTOTOOL_IMAGE_TIMEOUT_MS || 30 * 60 * 1000);
const VIDEO_TIMEOUT_MS = Number(process.env.AUTOTOOL_VIDEO_TIMEOUT_MS || 45 * 60 * 1000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.AUTOTOOL_DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const FFMPEG_TIMEOUT_MS = Number(process.env.AUTOTOOL_FFMPEG_TIMEOUT_MS || 10 * 60 * 1000);

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
    throw error;
  }
}

function validatePlan(payload) {
  const episodeTitle = String(payload?.episodeTitle || '').trim();
  if (!episodeTitle) throw new Error('AutoTool AI must return an episodeTitle');
  if (!payload || !Array.isArray(payload.scenes) || payload.scenes.length < 3 || payload.scenes.length > 5) {
    throw new Error('AutoTool AI must return between 3 and 5 scenes');
  }

  const scenes = payload.scenes.map((scene, index) => {
    const imagePrompt = String(scene.imagePrompt || '').trim();
    const videoPrompt = String(scene.videoPrompt || '').trim();
    if (!imagePrompt || !videoPrompt) {
      throw new Error(`Scene ${index + 1} is missing imagePrompt or videoPrompt`);
    }
    return {
      index,
      title: String(scene.title || `Scene ${index + 1}`).trim().slice(0, 160),
      imagePrompt,
      videoPrompt,
      imageTaskId: null,
      imageUrl: null,
      videoTaskId: null,
      videoUrl: null,
      status: 'pending',
      error: null
    };
  });
  return { episodeTitle: episodeTitle.slice(0, 200), scenes };
}

async function generatePlan(job, priorEpisodeContext) {
  const baseUrl = (process.env.AUTOTOOL_AI_BASE_URL || 'http://127.0.0.1:8081').replace(/\/$/, '');
  const apiUrl = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const apiKey = process.env.AUTOTOOL_AI_API_KEY;
  if (!apiKey) throw new Error('AUTOTOOL_AI_API_KEY is not configured');

  const characters = Array.isArray(job.characters) ? job.characters : [];
  const characterInstructions = characters.length > 0
    ? characters.map((character, index) => (
      `Reference image ${index + 1}: ${character.name}, age ${character.age || 'unspecified'}, ${character.description || 'no additional description'}. Preserve this character's identity from the corresponding reference image.`
    )).join('\n')
    : `${(job.characterImageUrls || []).length} character reference image(s) are provided. Preserve identity and defining appearance consistently.`;
  const modeInstruction = job.mode === 'standalone'
    ? 'Create an independent, self-contained episode with a plot explicitly different from every recent plot below.'
    : 'Continue naturally from relevant recent episodes while creating a fresh new plot, not a repeat.';
  const prompt = [
    'Invent a fresh short-form vertical video episode matching the saved channel topic below.',
    modeInstruction,
    'Choose the appropriate number of scenes, with a minimum of 3 and a maximum of 5.',
    'Every scene will become one 8-second clip and must work visually within exactly 8 seconds.',
    'All compositions must be vertical 9:16.',
    characterInstructions,
    'imagePrompt must describe one strong still frame suitable for image generation.',
    'videoPrompt must describe motion, camera movement, action, and continuity from that still frame.',
    'Return strict JSON only, with no markdown or commentary, in this exact shape:',
    '{"episodeTitle":"...","scenes":[{"title":"...","imagePrompt":"...","videoPrompt":"..."}]}',
    `Saved channel topic: ${job.channelTopic || job.topic}`,
    priorEpisodeContext ? `Recent completed episodes:\n${priorEpisodeContext}` : 'There are no recent completed episodes.'
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AUTOTOOL_SCRIPT_TIMEOUT_MS || 120000));
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.AUTOTOOL_AI_MODEL || 'gemini-3.6-flash',
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a video director. Follow the requested JSON schema exactly.' },
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AutoTool AI request failed (${response.status}): ${body.slice(0, 500)}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    return validatePlan(extractJson(content));
  } finally {
    clearTimeout(timeout);
  }
}

async function getPriorEpisodeContext(jobId, userId) {
  if (!userId) return '';
  const snapshot = await db.collection('autotool_jobs').where('userId', '==', userId).get();
  return snapshot.docs
    .filter(document => document.id !== jobId && document.data().status === 'completed')
    .map(document => document.data())
    .sort((a, b) => (b.completedAt || b.createdAt || 0) - (a.completedAt || a.createdAt || 0))
    .slice(0, 10)
    .map(episode => {
      const scenes = (Array.isArray(episode.scenes) ? episode.scenes : []).map(scene => {
        const title = String(scene.title || 'Untitled scene').slice(0, 120);
        const imagePrompt = String(scene.imagePrompt || '').replace(/\s+/g, ' ').slice(0, 120);
        const videoPrompt = String(scene.videoPrompt || '').replace(/\s+/g, ' ').slice(0, 120);
        return `${title} [image: ${imagePrompt}; video: ${videoPrompt}]`;
      }).join(' | ');
      return `Episode ${episode.episodeNumber || '?'} - ${episode.episodeTitle || 'Untitled'}${scenes ? `: ${scenes}` : ''}`;
    })
    .join('\n');
}

async function updateScene(jobRef, sceneIndex, changes, jobChanges = {}) {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef);
    if (!snapshot.exists) throw new Error(`AutoTool job ${jobRef.id} no longer exists`);
    const scenes = snapshot.data().scenes || [];
    if (!scenes[sceneIndex]) throw new Error(`AutoTool scene ${sceneIndex + 1} no longer exists`);
    scenes[sceneIndex] = { ...scenes[sceneIndex], ...changes };
    transaction.update(jobRef, { scenes, updatedAt: Date.now(), ...jobChanges });
  });
}

async function waitForTask(taskRef, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await taskRef.get();
    if (!snapshot.exists) throw new Error(`Child task ${taskRef.id} was deleted`);
    const task = snapshot.data();
    if (task.status === 'completed') {
      if (!task.mediaUrl) throw new Error(`Child task ${taskRef.id} completed without mediaUrl`);
      return task.mediaUrl;
    }
    if (task.status === 'failed') throw new Error(task.error || `Child task ${taskRef.id} failed`);
    await sleep(TASK_POLL_INTERVAL_MS);
  }
  throw new Error(`Child task ${taskRef.id} timed out after ${Math.round(timeoutMs / 60000)} minutes`);
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

async function concatenateClips(jobId, videoUrls) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `autotool-${jobId}-`));
  try {
    const clipPaths = [];
    for (let index = 0; index < videoUrls.length; index++) {
      const clipPath = path.join(tempDir, `clip-${String(index).padStart(2, '0')}.mp4`);
      await downloadFile(videoUrls[index], clipPath);
      clipPaths.push(clipPath);
    }
    const concatPath = path.join(tempDir, 'concat.txt');
    const outputPath = path.join(tempDir, 'final.mp4');
    await fsp.writeFile(concatPath, clipPaths.map(clipPath => `file '${clipPath}'`).join('\n'));
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', outputPath]);
    } catch (error) {
      logger.warn(`[AutoTool] Stream-copy concat failed, retrying with transcoding: ${error.message}`);
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath
      ]);
    }
    const output = await fsp.readFile(outputPath);
    return uploadToR2(output, `meo3/autotool/${jobId}.mp4`, 'video/mp4');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Classify a child task failure so AutoTool can decide how to recover.
function classifyFailure(failure) {
  const raw = [failure?.errorCode, failure?.error].filter(Boolean).map(String).join(' | ');
  if (!raw) return 'transient';
  // Content-policy / copyright / unsafe → rewrite the prompt to avoid the violation.
  if (/COPYRIGHT|IP_INPUT_IMAGE|IP_PROHIBITED|PROMINENT|PUBLIC_ERROR_SEXUAL|PUBLIC_ERROR_MINOR|DANGER_FILTER|UNSAFE|INAPPROPRIATE|SAFETY|FILTERED|CHILD_DANGER|AUDIO_FILTER|AUDIO_GENERATION_FILTERED/i.test(raw)) {
    return 'safety';
  }
  // Transient / recoverable → retry the same prompt.
  if (/INTERNAL|TIMED_OUT|TIMEOUT|timeout|Failed to enqueue|Failed to resolve media|UNUSUAL_ACTIVITY|reCAPTCHA|PERMISSION_DENIED|OAuth token|capture token|UNAUTHENTICATED|UNAUTHORIZED|\b401\b|QUOTA|RESOURCE_EXHAUSTED|\b429\b|Requested entity was not found|\bNOT_FOUND\b|\b404\b|VIDEO_DOWNLOAD_FAILED|IMAGE_URL_CAPTURE_FAILED|IMAGE_UPLOAD_R2_FAILED|Could not capture URL|Upload R2 failed|No successful media generated|Generation job finished with state: FAILED/i.test(raw)) {
    return 'transient';
  }
  return 'hard';
}

// Ask the AI to rephrase a rejected prompt so it keeps the creative intent but
// avoids the content-policy / copyright issue that caused the failure.
async function rewritePrompt({ mediaType, originalPrompt, failure, characters, attempt }) {
  const baseUrl = (process.env.AUTOTOOL_AI_BASE_URL || 'http://127.0.0.1:8081').replace(/\/$/, '');
  const apiUrl = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const apiKey = process.env.AUTOTOOL_AI_API_KEY;
  if (!apiKey) throw new Error('AUTOTOOL_AI_API_KEY is not configured');

  const characterInstructions = (Array.isArray(characters) && characters.length > 0)
    ? characters.map((character, index) => (
      `Character ${index + 1}: ${character.name}, age ${character.age || 'unspecified'}, ${character.description || 'no additional description'}. Preserve this character's identity from the reference image.`
    )).join('\n')
    : '';

  const prompt = [
    'A media generation prompt was rejected by the content policy.',
    `Rejected prompt: ${originalPrompt}`,
    `Failure reason: ${failure}`,
    'Rewrite the prompt so it keeps the same creative intent, scene, and visual outcome but completely avoids the flagged issue.',
    'Strict rules:',
    '- No real people, celebrities, or their likeness; use generic fictional characters only.',
    '- No trademarked characters, brands, logos, or copyrighted artwork/music/lyrics.',
    '- Keep it family-friendly: not explicit, not violent, not sensitive.',
    '- Keep 9:16 vertical framing and the same intended motion.',
    characterInstructions,
    'Return strict JSON only, with no markdown or commentary, in this exact shape: {"prompt":"..."}'
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AUTOTOOL_SCRIPT_TIMEOUT_MS || 120000));
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.AUTOTOOL_AI_MODEL || 'gemini-3.6-flash',
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You rewrite media prompts to avoid content policy violations. Follow the requested JSON schema exactly.' },
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AutoTool rewrite request failed (${response.status}): ${body.slice(0, 500)}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    const rewritten = String(parsed.prompt || '').trim();
    if (!rewritten) throw new Error('AutoTool rewrite returned an empty prompt');
    logger.success(`[AutoTool] Prompt đã viết lại (${mediaType}, lần ${attempt + 1}): ${rewritten.slice(0, 80)}...`);
    return rewritten;
  } finally {
    clearTimeout(timeout);
  }
}

const TERMINAL_CHILD_STATUSES = new Set(['completed', 'failed']);

// Run one child image/video task for a scene with automatic recovery:
// - content-policy failures → AI rewrites the prompt and retries (max maxAttempts)
// - transient failures → retry the same prompt
// - hard failures → throw immediately
async function runChildTaskWithRetry({
  jobRef, job, sceneIndex, taskType, prompt, extraTaskData, timeoutMs,
  stageStatus, progressUpdate, maxAttempts = 3
}) {
  const jobId = jobRef.id;
  let currentPrompt = prompt;
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const taskId = `${jobId}_scene_${sceneIndex + 1}_${taskType}${attempt > 1 ? `_r${attempt}` : ''}`;
    const taskRef = db.collection('tasks').doc(taskId);

    let existing = null;
    try { existing = await taskRef.get(); } catch (error) { existing = null; }
    const doc = existing?.exists ? existing.data() : null;

    if (doc && doc.status === 'completed' && doc.mediaUrl) {
      await updateScene(jobRef, sceneIndex, { [`${taskType}Url`]: doc.mediaUrl, status: 'completed' });
      return { url: doc.mediaUrl, attempts: attempt, taskId };
    }

    if (doc && TERMINAL_CHILD_STATUSES.has(doc.status)) {
      // A previous run already ended this attempt; capture the failure and decide.
      lastFailure = { errorCode: doc.errorCode, error: doc.error || `${taskType} task failed` };
      const category = classifyFailure(lastFailure);
      if (attempt >= maxAttempts) {
        throw new Error(`${taskType} scene ${sceneIndex + 1} thất bại sau ${maxAttempts} lần: ${lastFailure.error}`);
      }
      if (category === 'hard') {
        throw new Error(`${taskType} scene ${sceneIndex + 1} thất bại: ${lastFailure.error}`);
      }
      if (category === 'safety') {
        logger.warn(`[AutoTool] Scene ${sceneIndex + 1} ${taskType} bị từ chối nội dung. Viết lại prompt...`);
        try {
          currentPrompt = await rewritePrompt({
            mediaType: taskType,
            originalPrompt: currentPrompt,
            failure: [lastFailure.errorCode, lastFailure.error].filter(Boolean).join(' | '),
            characters: job.characters || [],
            attempt
          });
        } catch (rewriteErr) {
          logger.warn(`[AutoTool] rewritePrompt thất bại: ${rewriteErr.message}. Giữ prompt cũ.`);
        }
      } else {
        logger.warn(`[AutoTool] Scene ${sceneIndex + 1} ${taskType} lỗi tạm thời. Thử lại...`);
      }
      await sleep(Math.min(5000 * attempt, 20000));
      continue;
    }

    if (!doc) {
      const data = { ...extraTaskData, prompt: currentPrompt };
      try {
        await taskRef.create(data);
      } catch (error) {
        if (error.code !== 6 && error.code !== 'already-exists') throw error;
      }
    } else if (doc.prompt !== currentPrompt) {
      await taskRef.update({ prompt: currentPrompt }).catch(() => {});
    }

    await updateScene(jobRef, sceneIndex, {
      [`${taskType}TaskId`]: taskId,
      status: stageStatus,
      error: null
    }, progressUpdate);

    try {
      const url = await waitForTask(taskRef, timeoutMs);
      return { url, attempts: attempt, taskId };
    } catch (error) {
      let failure = { errorCode: error.code, error: error.message };
      try {
        const snapshot = await taskRef.get();
        if (snapshot.exists) {
          const task = snapshot.data();
          failure = { errorCode: task.errorCode, error: task.error || error.message };
        }
      } catch (e) {}
      lastFailure = failure;
      const category = classifyFailure(failure);
      if (attempt >= maxAttempts) {
        throw new Error(`${taskType} scene ${sceneIndex + 1} thất bại sau ${maxAttempts} lần: ${failure.error}`);
      }
      if (category === 'hard') {
        throw new Error(`${taskType} scene ${sceneIndex + 1} thất bại: ${failure.error}`);
      }
      if (category === 'safety') {
        logger.warn(`[AutoTool] Scene ${sceneIndex + 1} ${taskType} bị từ chối nội dung: ${String(failure.error).slice(0, 120)}. Viết lại prompt...`);
        try {
          currentPrompt = await rewritePrompt({
            mediaType: taskType,
            originalPrompt: currentPrompt,
            failure: [failure.errorCode, failure.error].filter(Boolean).join(' | '),
            characters: job.characters || [],
            attempt
          });
        } catch (rewriteErr) {
          logger.warn(`[AutoTool] rewritePrompt thất bại: ${rewriteErr.message}. Giữ prompt cũ.`);
        }
      } else {
        logger.warn(`[AutoTool] Scene ${sceneIndex + 1} ${taskType} lỗi tạm thời: ${String(failure.error).slice(0, 120)}. Thử lại...`);
      }
      await sleep(Math.min(5000 * attempt, 20000));
    }
  }
  throw new Error(`[AutoTool] ${taskType} scene ${sceneIndex + 1} không thể hoàn thành: ${lastFailure?.error || 'unknown error'}`);
}

// Record a completed episode into its parent project so the wizard shows history.
async function recordEpisode(jobRef, job) {
  const projectId = job?.projectId;
  if (!projectId) return;
  const projectRef = db.collection('autotool_projects').doc(projectId);
  const snapshot = await projectRef.get();
  if (!snapshot.exists) return;
  const episodes = Array.isArray(snapshot.data().episodes) ? snapshot.data().episodes : [];
  const record = {
    number: job.episodeNumber || episodes.length + 1,
    title: job.episodeTitle || job.projectName || `Episode ${job.episodeNumber || episodes.length + 1}`,
    jobId: jobRef.id,
    finalUrl: job.finalUrl || null,
    completedAt: job.completedAt || Date.now()
  };
  const existingIndex = episodes.findIndex(episode => episode.jobId === jobRef.id);
  if (existingIndex !== -1) episodes[existingIndex] = record;
  else episodes.push(record);
  await projectRef.update({ episodes, updatedAt: Date.now() });
  logger.success(`[AutoTool] Episode history recorded for project ${projectId}`);
}

async function runJob(jobId) {
  const jobRef = db.collection('autotool_jobs').doc(jobId);
  let failedSceneIndex = null;
  try {
    let snapshot = await jobRef.get();
    if (!snapshot.exists || TERMINAL_JOB_STATUSES.has(snapshot.data().status)) return;
    let job = snapshot.data();

    if (!Array.isArray(job.scenes) || job.scenes.length === 0) {
      await jobRef.update({ status: 'planning', progress: 5, error: null, updatedAt: Date.now() });
      const priorEpisodeContext = await getPriorEpisodeContext(jobId, job.userId);
      const plan = await generatePlan(job, priorEpisodeContext);
      await jobRef.update({
        episodeTitle: plan.episodeTitle,
        scenes: plan.scenes,
        status: 'generating',
        progress: 10,
        updatedAt: Date.now()
      });
    }

    snapshot = await jobRef.get();
    job = snapshot.data();
    const totalSteps = job.scenes.length * 2 + 1;

    for (let index = 0; index < job.scenes.length; index++) {
      failedSceneIndex = index;
      snapshot = await jobRef.get();
      job = snapshot.data();
      let scene = job.scenes[index];
      let imageUrl = scene.imageUrl;

      if (!imageUrl) {
        const imageResult = await runChildTaskWithRetry({
          jobRef,
          job,
          sceneIndex: index,
          taskType: 'image',
          prompt: `${scene.imagePrompt}\nVertical 9:16 composition. Preserve the exact identity and defining appearance of every referenced character.`,
          extraTaskData: {
            userId: job.userId,
            email: job.userEmail || null,
            type: 'image',
            status: 'pending',
            aspectRatio: '9:16',
            model: 'nano_banana_2',
            count: 1,
            referenceImages: job.characterImageUrls || [],
            autotoolJobId: jobId,
            sceneIndex: index,
            createdAt: Date.now()
          },
          timeoutMs: IMAGE_TIMEOUT_MS,
          stageStatus: 'image_processing',
          progressUpdate: {
            status: 'generating',
            currentScene: index + 1,
            progress: Math.round((index * 2 / totalSteps) * 100)
          }
        });
        imageUrl = imageResult.url;
        await updateScene(jobRef, index, { imageUrl, status: 'image_completed' }, {
          progress: Math.round(((index * 2 + 1) / totalSteps) * 100)
        });
      }

      snapshot = await jobRef.get();
      job = snapshot.data();
      scene = job.scenes[index];
      if (!scene.videoUrl) {
        const videoResult = await runChildTaskWithRetry({
          jobRef,
          job,
          sceneIndex: index,
          taskType: 'video',
          prompt: `${scene.videoPrompt}\nCreate one coherent 8-second vertical clip. Preserve the character identity from the start image without face, clothing, or body drift.`,
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
            autotoolJobId: jobId,
            sceneIndex: index,
            createdAt: Date.now()
          },
          timeoutMs: VIDEO_TIMEOUT_MS,
          stageStatus: 'video_processing'
        });
        await updateScene(jobRef, index, { videoUrl: videoResult.url, status: 'completed' }, {
          progress: Math.round(((index * 2 + 2) / totalSteps) * 100)
        });
      }
    }

    snapshot = await jobRef.get();
    job = snapshot.data();
    if (job.finalUrl) {
      await jobRef.update({ status: 'completed', progress: 100, completedAt: Date.now(), updatedAt: Date.now() });
      await recordEpisode(jobRef, job).catch(() => {});
      return;
    }
    const videoUrls = job.scenes.map(scene => scene.videoUrl);
    if (videoUrls.some(url => !url)) throw new Error('Not all scenes have completed video URLs');
    await jobRef.update({ status: 'concatenating', currentScene: null, updatedAt: Date.now() });
    const finalUrl = await concatenateClips(jobId, videoUrls);
    await jobRef.update({
      status: 'completed',
      progress: 100,
      finalUrl,
      error: null,
      completedAt: Date.now(),
      updatedAt: Date.now()
    });
    const completedJob = { ...job, status: 'completed', progress: 100, finalUrl, completedAt: Date.now() };
    await recordEpisode(jobRef, completedJob).catch(() => {});
    logger.success(`[AutoTool] Job ${jobId} completed: ${finalUrl}`);
  } catch (error) {
    logger.error(`[AutoTool] Job ${jobId} failed`, error);
    const update = { status: 'failed', error: error.message, failedAt: Date.now(), updatedAt: Date.now() };
    await jobRef.set(update, { merge: true }).catch(() => {});
    if (failedSceneIndex !== null) {
      await updateScene(jobRef, failedSceneIndex, { status: 'failed', error: error.message }).catch(() => {});
    }
  }
}

function processAutoToolJob(jobId) {
  if (activeJobs.has(jobId)) return false;
  activeJobs.add(jobId);
  runJob(jobId).finally(() => activeJobs.delete(jobId));
  return true;
}

async function resumeAutoToolJobs() {
  const snapshot = await db.collection('autotool_jobs').get();
  let resumed = 0;
  for (const document of snapshot.docs) {
    if (!TERMINAL_JOB_STATUSES.has(document.data().status) && processAutoToolJob(document.id)) resumed++;
  }
  logger.info(`[AutoTool] Resumed ${resumed} nonterminal job(s)`);
  return resumed;
}

// ─── Project Draft Helpers ─────────────────────────────────────────────────
// Generic helper for AutoTool AI JSON requests.
async function callAutoToolAI({ system, user, temperature = 0.7 }) {
  const baseUrl = (process.env.AUTOTOOL_AI_BASE_URL || 'http://127.0.0.1:8081').replace(/\/$/, '');
  const apiUrl = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const apiKey = process.env.AUTOTOOL_AI_API_KEY;
  if (!apiKey) throw new Error('AUTOTOOL_AI_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AUTOTOOL_SCRIPT_TIMEOUT_MS || 120000));
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
      throw new Error(`AutoTool AI request failed (${response.status}): ${body.slice(0, 500)}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    return extractJson(content);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeDraftCharacters(value) {
  const list = Array.isArray(value) ? value.slice(0, 3) : [];
  return list.map((character, index) => ({
    name: String(character?.name || '').trim().slice(0, 120) || `Character ${index + 1}`,
    age: String(character?.age ?? '').trim().slice(0, 100),
    description: String(character?.description || '').trim().slice(0, 2000),
    imageUrl: '',
    imageStatus: null
  }));
}

function normalizeStyle(value) {
  const style = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  return {
    artStyle: String(style.artStyle || '').trim().slice(0, 500),
    colorPalette: String(style.colorPalette || '').trim().slice(0, 500),
    mood: String(style.mood || '').trim().slice(0, 500),
    lighting: String(style.lighting || '').trim().slice(0, 500),
    camera: String(style.camera || '').trim().slice(0, 500)
  };
}

function styleSummary(style) {
  const s = (style && typeof style === 'object') ? style : {};
  return [s.artStyle, s.colorPalette, s.mood, s.lighting, s.camera].filter(Boolean).join(', ');
}

// Step 1: AI drafts the whole project (name, overview, mode, characters, style) from a topic.
async function generateProjectIdea({ topic }) {
  const parsed = await callAutoToolAI({
    system: 'You are a creative director for short-form vertical (9:16) video series. Follow the requested JSON schema exactly.',
    user: [
      'Based on this topic, invent a fresh short-form vertical video series project.',
      'Return strict JSON only, with no markdown or commentary, in this exact shape:',
      '{"name":"...","overview":"...","mode":"series","characters":[{"name":"...","age":"...","description":"..."}],"style":{"artStyle":"...","colorPalette":"...","mood":"...","lighting":"...","camera":"..."}}',
      'overview must be 1-3 sentences describing the series concept. mode must be "series" or "standalone".',
      'Invent 1-3 recurring characters with a short appearance/personality description for each.',
      'style describes the consistent visual direction of the whole series.',
      `Topic: ${String(topic || '').trim()}`
    ].join('\n'),
    temperature: 0.7
  });
  const name = String(parsed.name || '').trim().slice(0, 200);
  if (!name) throw new Error('AutoTool AI returned an empty project name');
  return {
    name,
    overview: String(parsed.overview || '').trim().slice(0, 3000),
    mode: parsed.mode === 'standalone' ? 'standalone' : 'series',
    characters: normalizeDraftCharacters(parsed.characters),
    style: normalizeStyle(parsed.style)
  };
}

// Step 2: AI suggests characters for an existing project.
async function generateCharacterSuggestions(project) {
  const parsed = await callAutoToolAI({
    system: 'You invent recurring characters for a short-form vertical video series. Follow the requested JSON schema exactly.',
    user: [
      'Invent 1-3 recurring characters that fit this series.',
      'Return strict JSON only, with no markdown, in this exact shape:',
      '{"characters":[{"name":"...","age":"...","description":"..."}]}',
      'description must describe appearance and personality in 1-2 sentences.',
      `Series: ${project.name || 'Untitled'}`,
      project.overview ? `Overview: ${project.overview}` : '',
      project.style ? `Visual style: ${styleSummary(project.style)}` : ''
    ].filter(Boolean).join('\n'),
    temperature: 0.7
  });
  return normalizeDraftCharacters(parsed.characters);
}

// Step 3: AI suggests a visual style for an existing project.
async function generateStyleSuggestion(project) {
  const parsed = await callAutoToolAI({
    system: 'You define the consistent visual style of a short-form vertical video series. Follow the requested JSON schema exactly.',
    user: [
      'Suggest a cohesive visual style for this series.',
      'Return strict JSON only, with no markdown, in this exact shape:',
      '{"style":{"artStyle":"...","colorPalette":"...","mood":"...","lighting":"...","camera":"..."}}',
      `Series: ${project.name || 'Untitled'}`,
      project.overview ? `Overview: ${project.overview}` : ''
    ].filter(Boolean).join('\n'),
    temperature: 0.7
  });
  return normalizeStyle(parsed.style);
}

// Step 4: AI drafts the episode plan (title + scenes) for a project using its full context.
async function generateScenes(project, priorEpisodeContext) {
  const characters = Array.isArray(project.characters) ? project.characters : [];
  const characterInstructions = characters.filter(c => c.name).length > 0
    ? characters.map((character, index) => (
      `Reference image ${index + 1}: ${character.name}, age ${character.age || 'unspecified'}, ${character.description || 'no additional description'}. Preserve this character's identity from the corresponding reference image.`
    )).join('\n')
    : `${(Array.isArray(project.characterImageUrls) ? project.characterImageUrls : []).length} character reference image(s) are provided. Preserve identity and defining appearance consistently.`;
  const style = styleSummary(project.style);
  const modeInstruction = project.mode === 'standalone'
    ? 'Create an independent, self-contained episode with a plot explicitly different from every recent plot below.'
    : 'Continue naturally from relevant recent episodes while creating a fresh new plot, not a repeat.';

  const parsed = await callAutoToolAI({
    system: 'You are a video director. Follow the requested JSON schema exactly.',
    user: [
      'Invent a fresh short-form vertical video episode for the series project below.',
      modeInstruction,
      'Choose the appropriate number of scenes, with a minimum of 3 and a maximum of 5.',
      'Every scene will become one 8-second clip and must work visually within exactly 8 seconds.',
      'All compositions must be vertical 9:16.',
      characterInstructions,
      style ? `Consistent visual style: ${style}` : '',
      'imagePrompt must describe one strong still frame suitable for image generation.',
      'videoPrompt must describe motion, camera movement, action, and continuity from that still frame.',
      'Return strict JSON only, with no markdown or commentary, in this exact shape:',
      '{"episodeTitle":"...","scenes":[{"title":"...","imagePrompt":"...","videoPrompt":"..."}]}',
      `Project name: ${project.name || 'Untitled'}`,
      project.overview ? `Overview: ${project.overview}` : '',
      priorEpisodeContext ? `Recent completed episodes:\n${priorEpisodeContext}` : 'There are no recent completed episodes.'
    ].filter(Boolean).join('\n'),
    temperature: 0.7
  });
  return validatePlan(parsed);
}

function buildCharacterImagePrompt(project, character) {
  const style = styleSummary(project.style);
  return [
    'Create a character reference portrait for a short-form vertical video series.',
    `Character: ${character.name || 'Unnamed'}`,
    character.age ? `Age: ${character.age}` : '',
    character.description ? `Appearance and personality: ${character.description}` : '',
    style ? `Overall visual style: ${style}` : '',
    'High quality, consistent identity, single character, centered, vertical 9:16 composition, complete character design, no text, no watermark.'
  ].filter(Boolean).join('\n');
}

// Generate a character portrait image via the normal image task pipeline.
async function generateCharacterImage(project, character, characterIndex) {
  if (!project || !project.userId) throw new Error('Project has no owner');
  const taskRef = db.collection('tasks').doc(`autotool_char_${Date.now()}_${characterIndex}`);
  const prompt = buildCharacterImagePrompt(project, character);
  await taskRef.set({
    userId: project.userId,
    type: 'image',
    status: 'pending',
    prompt,
    aspectRatio: '9:16',
    model: 'nano_banana_2',
    count: 1,
    referenceImages: [],
    autotoolProjectId: project.id || null,
    createdAt: Date.now()
  });
  logger.info(`[AutoTool] Generating character image for "${character.name}"...`);
  const mediaUrl = await waitForTask(taskRef, IMAGE_TIMEOUT_MS);
  logger.success(`[AutoTool] Character image ready for "${character.name}": ${mediaUrl.substring(0, 60)}...`);
  return mediaUrl;
}

module.exports = {
  processAutoToolJob,
  resumeAutoToolJobs,
  generateProjectIdea,
  generateCharacterSuggestions,
  generateStyleSuggestion,
  generateScenes,
  generateCharacterImage,
  validatePlan,
  runChildTaskWithRetry,
  updateScene,
  waitForTask,
  classifyFailure
};
