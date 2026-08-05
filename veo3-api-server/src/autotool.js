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

async function ensureChildTask(taskId, data) {
  const taskRef = db.collection('tasks').doc(taskId);
  try {
    await taskRef.create(data);
  } catch (error) {
    if (error.code !== 6 && error.code !== 'already-exists') throw error;
  }
  return taskRef;
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
        const imageTaskId = scene.imageTaskId || `${jobId}_scene_${index + 1}_image`;
        const imageTaskRef = await ensureChildTask(imageTaskId, {
          userId: job.userId,
          email: job.userEmail || null,
          type: 'image',
          status: 'pending',
          prompt: `${scene.imagePrompt}\nVertical 9:16 composition. Preserve the exact identity and defining appearance of every referenced character.`,
          aspectRatio: '9:16',
          model: 'nano_banana_2',
          count: 1,
          referenceImages: job.characterImageUrls || [],
          autotoolJobId: jobId,
          sceneIndex: index,
          createdAt: Date.now()
        });
        await updateScene(jobRef, index, { imageTaskId, status: 'image_processing', error: null }, {
          status: 'generating',
          currentScene: index + 1,
          progress: Math.round((index * 2 / totalSteps) * 100)
        });
        imageUrl = await waitForTask(imageTaskRef, IMAGE_TIMEOUT_MS);
        await updateScene(jobRef, index, { imageUrl, status: 'image_completed' }, {
          progress: Math.round(((index * 2 + 1) / totalSteps) * 100)
        });
      }

      snapshot = await jobRef.get();
      job = snapshot.data();
      scene = job.scenes[index];
      if (!scene.videoUrl) {
        const videoTaskId = scene.videoTaskId || `${jobId}_scene_${index + 1}_video`;
        const videoTaskRef = await ensureChildTask(videoTaskId, {
          userId: job.userId,
          email: job.userEmail || null,
          type: 'video',
          status: 'pending',
          prompt: `${scene.videoPrompt}\nCreate one coherent 8-second vertical clip. Preserve the character identity from the start image without face, clothing, or body drift.`,
          aspectRatio: '9:16',
          model: 'veo_3_1_lite',
          count: 1,
          durationSeconds: 8,
          startImage: imageUrl,
          autotoolJobId: jobId,
          sceneIndex: index,
          createdAt: Date.now()
        });
        await updateScene(jobRef, index, { videoTaskId, status: 'video_processing', error: null });
        const videoUrl = await waitForTask(videoTaskRef, VIDEO_TIMEOUT_MS);
        await updateScene(jobRef, index, { videoUrl, status: 'completed' }, {
          progress: Math.round(((index * 2 + 2) / totalSteps) * 100)
        });
      }
    }

    snapshot = await jobRef.get();
    job = snapshot.data();
    if (job.finalUrl) {
      await jobRef.update({ status: 'completed', progress: 100, completedAt: Date.now(), updatedAt: Date.now() });
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

module.exports = { processAutoToolJob, resumeAutoToolJobs };
