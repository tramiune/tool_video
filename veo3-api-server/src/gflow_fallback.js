/**
 * gflow_fallback.js
 * -----------------
 * Video generation via gflow-cli (drives real Flow UI via Playwright).
 * Supports both i2v (image+prompt) and t2v (text-only).
 *
 * 2 WORKERS chạy song song — mỗi worker bind với 1 folder + 1 profile riêng:
 *   Worker 0: gflow-cli/   + profile nick1
 *   Worker 1: gflow-cli-2/ + profile nick2
 *
 * Task dispatcher: chọn worker rảnh đầu tiên (round-robin nếu cả 2 rảnh).
 * Nếu cả 2 đều bận → queue vào worker có hàng đợi ngắn nhất.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const { logger } = require('./utils');

// ── Worker config ─────────────────────────────────────────────────────────────
const BASE = path.join(os.homedir(), 'Documents', 'Tramiune');
const UV_BIN = process.env.UV_BIN || path.join(os.homedir(), '.local', 'bin', 'uv');
const GFLOW_TIMEOUT_MS = parseInt(process.env.GFLOW_TIMEOUT_MS || '300000', 10); // 5 min
const GFLOW_MODEL = process.env.GFLOW_MODEL || 'veo-lite-lp';

const PROXY_URL = process.env.PROXY_URL || null; // e.g. http://user:pass@host:port

const WORKERS = [
  // --- DIRECT IP WORKER ---
  {
    id: 0,
    dir: process.env.GFLOW_DIR_1 || path.join(BASE, 'gflow-cli'),
    profile: process.env.GFLOW_PROFILE_1 || 'nick1',
    project: process.env.GFLOW_PROJECT_1 || null,
    proxy: null,  // direct connection
    running: false,
    queue: []
  }

  // --- ALL OTHER WORKERS DISABLED ---
];

// ── Per-worker FIFO queue ─────────────────────────────────────────────────────
function enqueueToWorker(worker, fn) {
  return new Promise((resolve, reject) => {
    worker.queue.push({ fn, resolve, reject });
    _drainWorker(worker);
  });
}

async function _drainWorker(worker) {
  if (worker.running || worker.queue.length === 0) return;
  worker.running = true;
  const { fn, resolve, reject } = worker.queue.shift();
  try {
    resolve(await fn());
  } catch (e) {
    reject(e);
  } finally {
    worker.running = false;
    _drainWorker(worker);
  }
}

// ── Dispatcher: pick freest worker ───────────────────────────────────────────
let _groupRoundRobin = {};

function pickWorker() {
  // Group workers by their proxy string
  const groups = {};
  for (const w of WORKERS) {
    const key = w.proxy || 'direct';
    if (!groups[key]) groups[key] = { key, workers: [], load: 0 };
    groups[key].workers.push(w);
    groups[key].load += w.queue.length + (w.running ? 1 : 0);
  }

  // Find the group with the minimum load
  const groupList = Object.values(groups).sort((a, b) => a.load - b.load);
  const bestGroup = groupList[0];

  // Within the best group, find the freest worker
  const sortedWorkers = bestGroup.workers.sort((a, b) => {
    const loadA = a.queue.length + (a.running ? 1 : 0);
    const loadB = b.queue.length + (b.running ? 1 : 0);
    return loadA - loadB;
  });

  // If there's a tie, use round-robin within the group
  const freestLoad = sortedWorkers[0].queue.length + (sortedWorkers[0].running ? 1 : 0);
  const candidates = sortedWorkers.filter(w => (w.queue.length + (w.running ? 1 : 0)) === freestLoad);
  
  if (!_groupRoundRobin[bestGroup.key]) _groupRoundRobin[bestGroup.key] = 0;
  const chosen = candidates[_groupRoundRobin[bestGroup.key] % candidates.length];
  _groupRoundRobin[bestGroup.key]++;
  
  return chosen;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = (() => {
      try { return path.extname(new URL(url).pathname) || '.jpg'; } catch { return '.jpg'; }
    })();
    const tmpFile = path.join(os.tmpdir(), `gflow_input_${Date.now()}${ext}`);
    const file = fs.createWriteStream(tmpFile);
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tmpFile)));
    }).on('error', reject);
  });
}

async function uploadMp4ToR2(localPath, taskId) {
  const { uploadToR2 } = require('./s3_uploader');
  const buffer = fs.readFileSync(localPath);
  const fileName = `meo3/videos/${taskId}_gflow_${Date.now()}.mp4`;
  logger.info(`[gflow] Uploading ${Math.round(buffer.length / 1024)}KB → R2: ${fileName}`);
  return uploadToR2(buffer, fileName, 'video/mp4');
}

async function uploadPngToR2(localPath, taskId) {
  const { uploadToR2 } = require('./s3_uploader');
  const buffer = fs.readFileSync(localPath);
  const fileName = `meo3/images/${taskId}_gflow_${Date.now()}.png`;
  logger.info(`[gflow] Uploading ${Math.round(buffer.length / 1024)}KB → R2: ${fileName}`);
  return uploadToR2(buffer, fileName, 'image/png');
}

// ── Core subprocess ───────────────────────────────────────────────────────────
function _spawnGflow(worker, baseCommand, subcommand, args, outDir) {
  return new Promise((resolve, reject) => {
    const projectArgs = worker.project ? ['--project', worker.project] : [];
    const outDirFlag = baseCommand === 'image' ? '--out' : '--out-dir';
    const allArgs = [
      'run', 'gflow',
      baseCommand, subcommand,
      '--profile', worker.profile,
      ...projectArgs,
      ...args,
      outDirFlag, outDir,
      '--json'
    ];

    logger.info(`[gflow:w${worker.id}] uv ${allArgs.join(' ')}`);

    const proc = spawn(UV_BIN, allArgs, {
      cwd: worker.dir,
      env: {
        ...process.env,
        GFLOW_CLI_LEASE_WAIT_SECONDS: '30',
        PATH: `${path.dirname(UV_BIN)}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        ...(worker.proxy ? { GFLOW_CLI_PROXY: worker.proxy } : {})
      }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d;
      const lines = d.toString().split('\n').filter(l => l.trim() && !l.trim().startsWith('{'));
      for (const line of lines) logger.info(`[gflow:w${worker.id}] ${line.trim()}`);
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
      const lines = d.toString().split('\n').filter(l => l.trim() && !l.trim().startsWith('{'));
      for (const line of lines) logger.info(`[gflow:w${worker.id}] ${line.trim()}`);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`gflow:w${worker.id} timed out after ${Math.round(GFLOW_TIMEOUT_MS / 60000)} min`));
    }, GFLOW_TIMEOUT_MS);

    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`gflow spawn error: ${err.message}`)); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`gflow:w${worker.id} exited code ${code}: ${stderr.slice(-300)}`));
        return;
      }

      // Parse JSON output (try full stdout first for multi-line JSON)
      try {
        const fullJsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (fullJsonMatch) {
          const result = JSON.parse(fullJsonMatch[0]);
          // Some structures might be { results: [{local_path: ...}] }
          let videoPath = result?.output || result?.path || result?.video || result?.local_path;
          if (!videoPath && Array.isArray(result?.results) && result.results.length > 0) {
            videoPath = result.results[0].local_path;
          }
          if (videoPath && fs.existsSync(videoPath)) { resolve(videoPath); return; }
        }
      } catch (e) {}

      // Fallback: try parsing line by line
      try {
        for (const line of stdout.trim().split('\n')) {
          if (!line.trim().startsWith('{')) continue;
          try {
            const result = JSON.parse(line);
            const videoPath = result?.output || result?.path || result?.video || result?.local_path;
            if (videoPath && fs.existsSync(videoPath)) { resolve(videoPath); return; }
          } catch(err){}
        }
      } catch (e) {}

      // Fallback: scan outDir
      try {
        const files = fs.readdirSync(outDir);
        let mediaFiles = [];
        if (baseCommand === 'image') {
          mediaFiles = files.filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'));
        } else {
          mediaFiles = files.filter(f => f.endsWith('.mp4'));
        }
        if (mediaFiles.length > 0) { resolve(path.join(outDir, mediaFiles[0])); return; }
      } catch (e) {}

      reject(new Error(`gflow:w${worker.id} no output found for ${baseCommand}. stdout: ${stdout.slice(-500)}`));
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate video via gflow-cli.
 * Dispatched to the freest worker automatically.
 *
 * @param {object} task  - { prompt, startImage, aspectRatio, id }
 * @returns {string}     - Public R2 URL of the generated mp4
 */

async function _spawnAutoClickMacro(prompt, outDir, project, profile, macroType = 'video_916_onlyText') {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    // Nếu truyền tên macro (ví dụ image_916_onlytext), nó sẽ dùng file json tương ứng
    const macroPath = `/Users/qtee/Documents/Tramiune/auto_click/presets/${macroType}.json`;
    const pyScript = '/Users/qtee/Documents/Tramiune/auto_click/api_macro_runner.py';
    const args = ['--prompt', prompt, '--macro', macroPath, '--outdir', outDir, '--project', project || '', '--profile', profile || ''];
    
    logger.info(`[AutoClick] Spawning macro: python3.12 ${pyScript} ${args.join(' ')}`);
    const p = spawn('/opt/homebrew/bin/python3.12', [pyScript, ...args]);
    
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    
    p.on('close', code => {
      logger.info(`[AutoClick] exited with ${code}`);
      if (code !== 0) {
        logger.error(`[AutoClick] Stderr: ${stderr}`);
      }
      try {
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.includes('{"status"')) {
            const result = JSON.parse(line.substring(line.indexOf('{')));
            if (result.status === 'success') {
              resolve(result.video_path);
              return;
            } else {
              reject(new Error('AutoClick Macro Failed: ' + result.error));
              return;
            }
          }
        }
      } catch (e) {
         reject(new Error('Failed to parse AutoClick output: ' + stdout));
         return;
      }
      reject(new Error('No valid JSON in AutoClick output. stdout: ' + stdout));
    });
  });
}

async function generateVideoViaGflow(task) {
  const taskId = task.id || task.taskId || `gflow_${Date.now()}`;

  // Validate
  if (!fs.existsSync(UV_BIN)) {
    throw new Error(`uv not found at ${UV_BIN}`);
  }

  const worker = pickWorker();
  const queueLen = worker.queue.length + (worker.running ? 1 : 0);
  logger.info(`[gflow] Task ${taskId} → worker ${worker.id} (profile=${worker.profile}, queue=${queueLen})`);

  // Check worker profile exists
  const profileDir = path.join(
    os.homedir(), 'Library', 'Application Support', 'gflow-cli',
    `profile_${worker.profile}`
  );
  if (!fs.existsSync(profileDir)) {
    logger.warn(`[gflow:w${worker.id}] Profile not found: ${profileDir} — run: gflow auth login --profile ${worker.profile} --browser chrome`);
  }

  return enqueueToWorker(worker, async () => {
    const aspect = task.aspectRatio || '9:16';
    const prompt = task.prompt || 'animate this image naturally';
    const hasImage = !!(task.startImage);
    const mode = hasImage ? 'i2v' : 't2v';

    logger.info(`[gflow:w${worker.id}] Starting ${mode} task ${taskId} (model=${GFLOW_MODEL}, aspect=${aspect})`);

    const outDir = path.join(os.tmpdir(), `gflow_out_${taskId}`);
    fs.mkdirSync(outDir, { recursive: true });

    let tmpImagePath = null;
    let mp4Path = null;

    try {
      if (hasImage) {
        const imageInput = task.startImage;
        if (imageInput.startsWith('http')) {
          logger.info(`[gflow:w${worker.id}] Downloading image: ${imageInput}`);
          tmpImagePath = await downloadToTemp(imageInput);
        } else {
          tmpImagePath = imageInput;
        }
        mp4Path = await _spawnGflow(worker, 'video', 'i2v', [
          tmpImagePath, prompt,
          '--model', GFLOW_MODEL,
          '--aspect', aspect
        ], outDir);
      } else {
        const macroType = aspect === '16:9' ? 'video_169_onlyText' : 'video_916_onlyText';
        logger.info(`[gflow] Redirecting t2v to AutoClick Macro (${macroType})...`);
        mp4Path = await _spawnAutoClickMacro(prompt, outDir, worker.project, worker.profile, macroType);
      }

      logger.success(`[gflow:w${worker.id}] Video generated: ${mp4Path}`);

      const publicUrl = await uploadMp4ToR2(mp4Path, taskId);
      logger.success(`[gflow:w${worker.id}] Task ${taskId} uploaded: ${publicUrl}`);
      return publicUrl;

    } finally {
      if (tmpImagePath && tmpImagePath.startsWith(os.tmpdir())) {
        try { fs.unlinkSync(tmpImagePath); } catch (_) {}
      }
      if (mp4Path) {
        try { fs.unlinkSync(mp4Path); } catch (_) {}
      }
      try { fs.rmdirSync(outDir); } catch (_) {}
    }
  });
}

/**
 * Generate image via gflow-cli.
 * Dispatched to the freest worker automatically.
 *
 * @param {object} task  - { prompt, referenceImages, aspectRatio, id, model }
 * @returns {string}     - Public R2 URL of the generated png
 */
async function generateImageViaGflow(task) {
  const taskId = task.id || task.taskId || `gflow_${Date.now()}`;
  
  if (!fs.existsSync(UV_BIN)) {
    throw new Error(`uv not found at ${UV_BIN}`);
  }

  const worker = pickWorker();
  const queueLen = worker.queue.length + (worker.running ? 1 : 0);
  logger.info(`[gflow] Image Task ${taskId} → worker ${worker.id} (profile=${worker.profile}, queue=${queueLen})`);

  const profileDir = path.join(
    os.homedir(), 'Library', 'Application Support', 'gflow-cli',
    `profile_${worker.profile}`
  );
  if (!fs.existsSync(profileDir)) {
    logger.warn(`[gflow:w${worker.id}] Profile not found: ${profileDir}`);
  }

  return enqueueToWorker(worker, async () => {
    const aspect = task.aspectRatio || '9:16';
    const prompt = task.prompt || 'a nice picture';
    const refs = Array.isArray(task.referenceImages) ? task.referenceImages : (task.referenceImage ? [task.referenceImage] : []);
    const hasImage = refs.length > 0;
    const mode = hasImage ? 'i2i' : 't2i';
    // Use requested model (e.g. nano2, nano-pro, imagen4) or fallback to nano2
    const model = task.model === 'imagen_4' ? 'imagen4' : (task.model || 'nano2');

    logger.info(`[gflow:w${worker.id}] Starting ${mode} image task ${taskId} (model=${model}, aspect=${aspect})`);

    const outDir = path.join(os.tmpdir(), `gflow_out_${taskId}`);
    fs.mkdirSync(outDir, { recursive: true });

    let tmpImagePaths = [];
    let pngPath = null;

    try {
      if (hasImage) {
        for (const ref of refs) {
          if (ref.startsWith('http')) {
            logger.info(`[gflow:w${worker.id}] Downloading image: ${ref}`);
            const p = await downloadToTemp(ref);
            tmpImagePaths.push(p);
          } else {
            tmpImagePaths.push(ref);
          }
        }
        
        const gflowArgs = [prompt, '--model', model, '--aspect', aspect];
        for (const p of tmpImagePaths) {
          gflowArgs.push('--ref', p);
        }
        
        pngPath = await _spawnGflow(worker, 'image', 'i2i', gflowArgs, outDir);
      } else {
        const macroType = aspect === '16:9' ? 'image_169_onlyText' : 'image_916_onlytext';
        logger.info(`[gflow] Redirecting t2i to AutoClick Macro (${macroType})...`);
        pngPath = await _spawnAutoClickMacro(prompt, outDir, worker.project, worker.profile, macroType);
      }

      logger.success(`[gflow:w${worker.id}] Image generated: ${pngPath}`);

      const publicUrl = await uploadPngToR2(pngPath, taskId);
      logger.success(`[gflow:w${worker.id}] Task ${taskId} uploaded: ${publicUrl}`);
      return publicUrl;

    } finally {
      for (const p of tmpImagePaths) {
        if (p && p.startsWith(os.tmpdir())) {
          try { fs.unlinkSync(p); } catch (_) {}
        }
      }
      if (pngPath) {
        try { fs.unlinkSync(pngPath); } catch (_) {}
      }
      try { fs.rmdirSync(outDir); } catch (_) {}
    }
  });
}

// ── Status helper (for health check) ─────────────────────────────────────────
function getGflowStatus() {
  return WORKERS.map(w => ({
    worker: w.id,
    profile: w.profile,
    running: w.running,
    queued: w.queue.length
  }));
}

module.exports = { generateVideoViaGflow, generateImageViaGflow, getGflowStatus };
