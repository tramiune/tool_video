const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { logger } = require('./utils');
const { uploadToR2 } = require('./s3_uploader');
const { getActiveDisplay, ensureActiveVideoProfileHasCredits, deductVideoCreditAndRotateIfNeeded } = require('./chrome_profile_manager');

// Đường dẫn script Python
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/autoclick_video_runner.py');

// Hỗ trợ chạy song song tối đa 10 tác vụ Video cùng lúc (khớp với SONG SONG: 10 tác vụ trên Bulk AI Studio Pro).
// Bước click chuột & dán prompt (~4s) được khóa tuần tự qua /tmp/autoclick_video.lock trong autoclick_video_runner.py,
// còn bước chờ render & quét file <stt>.mp4 chạy song song hoàn toàn để 20 user submit liên tục không bị nghẽn!
const MAX_PARALLEL_VIDEO_TASKS = parseInt(process.env.VIDEO_CONCURRENCY || '10', 10);
let _activeVideoCount = 0;
const _videoWaitQueue = [];
let _consecutiveFlowErrors = 0;
let _sttCounter = Math.floor(1000 + Math.random() * 8000);

function nextUniqueVideoStt() {
  _sttCounter = ((_sttCounter - 1000 + 1) % 8999) + 1000;
  return String(_sttCounter);
}

function _acquireVideoParallelSlot(taskId) {
  if (_activeVideoCount < MAX_PARALLEL_VIDEO_TASKS) {
    _activeVideoCount++;
    return Promise.resolve();
  }
  const waitPos = _videoWaitQueue.length + 1;
  logger.info(`[AutoClick Video] ⏳ Đang chạy đầy ${MAX_PARALLEL_VIDEO_TASKS} luồng song song, task ${taskId} chờ slot trống (hàng chờ #${waitPos})...`);
  return new Promise((resolve) => {
    _videoWaitQueue.push(resolve);
  });
}

function _releaseVideoParallelSlot() {
  if (_videoWaitQueue.length > 0) {
    const nextResolve = _videoWaitQueue.shift();
    nextResolve();
  } else {
    _activeVideoCount = Math.max(0, _activeVideoCount - 1);
  }
}

/**
 * Chuẩn hóa buffer ảnh về đúng kích thước tỉ lệ mục tiêu (1280x720 cho 16:9 hoặc 720x1280 cho 9:16)
 * giúp Google Flow Video SDK không bị lỗi khi người dùng truyền ảnh dọc cho video ngang (hoặc ngược lại).
 */
function normalizeImageBufferForRatio(inputBuf, targetRatio = '9:16') {
  const isLandscape = String(targetRatio).includes('16:9') || String(targetRatio).toLowerCase().includes('wide');
  const tw = isLandscape ? 1280 : 720;
  const th = isLandscape ? 720 : 1280;
  const pyCode = `
import sys, io
from PIL import Image, ImageOps, ImageFilter, ImageEnhance

raw = sys.stdin.buffer.read()
im = Image.open(io.BytesIO(raw))
im = ImageOps.exif_transpose(im).convert("RGB")
w, h = im.size
tw, th = ${tw}, ${th}
src_ratio = w / float(h)
dst_ratio = tw / float(th)

# Nếu cùng chiều (ngang/dọc) và tỉ lệ chênh lệch <= 22% thì crop/fit nhẹ vào khung chuẩn
if abs(src_ratio - dst_ratio) / dst_ratio <= 0.22:
    out = ImageOps.fit(im, (tw, th), method=Image.Resampling.LANCZOS)
else:
    # Khác chiều (VD: ảnh dọc 9:16 tạo video ngang 16:9 hoặc ảnh vuông 1:1):
    # Tạo nền blur phủ kín khung chuẩn + đặt ảnh gốc sắc nét ở chính giữa để không mất chi tiết nhân vật
    bg = ImageOps.fit(im, (tw, th), method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(28))
    bg = ImageEnhance.Brightness(bg).enhance(0.85)
    fg = ImageOps.contain(im, (tw, th), method=Image.Resampling.LANCZOS)
    bg.paste(fg, ((tw - fg.width) // 2, (th - fg.height) // 2))
    out = bg

buf = io.BytesIO()
out.save(buf, format="JPEG", quality=92)
sys.stdout.buffer.write(buf.getvalue())
`;
  const res = spawnSync('python3', ['-c', pyCode], {
    input: inputBuf,
    maxBuffer: 25 * 1024 * 1024,
    timeout: 15000
  });
  if (res.status === 0 && res.stdout && res.stdout.length > 0) {
    return res.stdout;
  }
  const errText = res.stderr ? res.stderr.toString().trim() : `exit ${res.status}`;
  logger.warn(`[AutoClick Video] Không thể chuẩn hóa kích thước ảnh qua PIL (${errText}), dùng buffer gốc.`);
  return null;
}

/**
 * Đảm bảo URL ảnh đầu vào có CORS header và đúng tỉ lệ khung hình (16:9 / 9:16) tương ứng với video
 */
async function ensureCorsImageUrl(imgUrl, taskId, tag = 'start', targetRatio = '9:16') {
  if (!imgUrl || typeof imgUrl !== 'string') return imgUrl;
  if (!imgUrl.startsWith('http')) return imgUrl;
  try {
    const res = await fetch(imgUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return imgUrl;
    const ab = await res.arrayBuffer();
    const rawBuf = Buffer.from(ab);
    const normalizedBuf = normalizeImageBufferForRatio(rawBuf, targetRatio);
    const finalBuf = normalizedBuf || rawBuf;
    const ct = normalizedBuf ? 'image/jpeg' : (res.headers.get('content-type') || 'image/jpeg');
    const ext = normalizedBuf ? 'jpg' : (ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg');
    const key = `meo3/inputs/${taskId}_${tag}_${Date.now()}.${ext}`;
    const newUrl = await uploadToR2(finalBuf, key, ct);
    logger.info(`[AutoClick Video] Đã chuẩn hóa & đồng bộ ảnh ${tag} (${targetRatio}) sang R2 CORS: ${newUrl}`);
    return newUrl;
  } catch (e) {
    logger.warn(`[AutoClick Video] Không thể chuyển ảnh ${tag} sang R2 CORS (${e.message}), giữ nguyên URL cũ.`);
    return imgUrl;
  }
}

/**
 * Tạo video tự động qua Python PyAutoGUI:
 * 1. Double Click (439, 578) -> Gõ prompt -> Click (440, 729)
 * 2. Đợi 30s
 * 3. Quét thư mục ~/Downloads tối đa 5 phút (300s)
 * 4. Đọc file, upload lên R2 và xóa file trên máy
 * 
 * @param {object} task { id, prompt, aspectRatio, startImage, endImage, seq }
 * @returns {Promise<{ mediaId: string, url: string, buffer: Buffer, filePath: string }>}
 */
async function generateVideoViaAutoClick(task) {
  const taskId = task.id || `vid_${Date.now()}`;
  await _acquireVideoParallelSlot(taskId);
  try {
    return await _executeSingleVideoViaAutoClick(task, taskId);
  } finally {
    _releaseVideoParallelSlot();
  }
}

async function _executeSingleVideoViaAutoClick(task, taskId) {
  const prompt = String(task.prompt || '')
    .replace(/\|+/g, ' - ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rawRatio = String(task.aspectRatio || '9:16').trim();
  const ratio = (rawRatio.includes('16:9') || rawRatio.toLowerCase().includes('wide')) ? '16:9' : '9:16';
  const stt = String(task.seq || nextUniqueVideoStt());

  // Xoá trước file trùng tên <stt>.mp4 cũ trong ~/Downloads nếu còn sót lại
  try {
    const dlDir = path.join(require('os').homedir(), 'Downloads');
    const oldFile = path.join(dlDir, `${stt}.mp4`);
    if (fs.existsSync(oldFile)) {
      fs.unlinkSync(oldFile);
    }
  } catch (_) {}

  // Đảm bảo Chrome Profile đang mở làm Video còn đủ >= 10 credit (nếu hết tự động bật profile tiếp theo khi không có task khác đang chạy dở)
  try {
    await ensureActiveVideoProfileHasCredits({ allowWindowSwitch: _activeVideoCount <= 1 });
  } catch (profErr) {
    logger.warn(`[AutoClick Video] Không thể kiểm tra/chuyển profile trước khi chạy: ${profErr.message}`);
  }

  logger.info(`[AutoClick Video] 🚀 Khởi chạy task ${taskId} (STT: ${stt}, Ratio: ${ratio}, Active: ${_activeVideoCount}/${MAX_PARALLEL_VIDEO_TASKS}): "${prompt.slice(0, 40)}..."`);

  const args = [
    SCRIPT_PATH,
    '--prompt', prompt,
    '--stt', String(stt),
    '--ratio', ratio,
    '--timeout', '300' // 5 phút timeout
  ];

  if (task.startImage) {
    const safeStart = await ensureCorsImageUrl(task.startImage, taskId, 'start', ratio);
    args.push('--start-image', safeStart);
  }
  if (task.endImage) {
    const safeEnd = await ensureCorsImageUrl(task.endImage, taskId, 'end', ratio);
    args.push('--end-image', safeEnd);
  }

  return new Promise((resolve, reject) => {
    const activeDisp = typeof getActiveDisplay === 'function' ? getActiveDisplay() : ':10';
    logger.info(`[AutoClick Video] Spawning on DISPLAY=${activeDisp}: python3 ${args.join(' ')}`);
    const env = {
      ...process.env,
      DISPLAY: activeDisp
    };
    const proc = spawn('python3', args, { env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      stderr += msg + '\n';
      logger.info(`[AutoClick Runner] ${msg}`);
    });

    proc.on('close', async (code) => {
      logger.info(`[AutoClick Video] Script kết thúc với exit code: ${code}`);

      if (code !== 0) {
        let errMsg = `AutoClick script failed (code ${code})`;
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.error) errMsg = parsed.error;
        } catch (_) {
          if (stderr) errMsg += `: ${stderr.slice(-300)}`;
        }
        logger.error(`[AutoClick Video] ❌ Task ${taskId} thất bại: ${errMsg}`);
        if (code === 2 || errMsg.includes('FLOW_TASK_ERROR')) {
          _consecutiveFlowErrors += 1;
          logger.warn(`[AutoClick Video] ⚠️ Liên tiếp ${_consecutiveFlowErrors}/2 task bị báo LỖI trực tiếp trên Google Flow.`);
          if (_consecutiveFlowErrors >= 2 && _activeVideoCount <= 1) {
            _consecutiveFlowErrors = 0;
            logger.info(`[AutoClick Video] 🔍 Kiểm tra lại số dư Flow thực tế trên Google One xem nick có thực sự hết credit không...`);
            try {
              await deductVideoCreditAndRotateIfNeeded(0, { allowWindowSwitch: _activeVideoCount <= 1 });
            } catch (rotErr) {
              logger.error(`[AutoClick Video] Lỗi kiểm tra/xoay Chrome Box: ${rotErr.message}`);
            }
          }
        }
        return reject(new Error(errMsg));
      }

      try {
        const result = JSON.parse(stdout.trim());
        const filePath = result.file_path;

        if (!filePath || !fs.existsSync(filePath)) {
          return reject(new Error(`File không tồn tại trên đĩa: ${filePath}`));
        }

        const fileSizeMB = (result.size / 1024 / 1024).toFixed(2);
        logger.success(`[AutoClick Video] 🎉 Đã nhận video từ máy tính: ${filePath} (${fileSizeMB} MB, sau ${result.elapsed}s)`);

        // 1. Đọc nội dung file
        const buffer = fs.readFileSync(filePath);

        // 2. Upload lên Cloudflare R2
        const fileName = `meo3/videos/${taskId}_${Date.now()}.mp4`;
        logger.info(`[AutoClick Video] ☁️ Đang upload lên R2: ${fileName}...`);
        const r2Url = await uploadToR2(buffer, fileName, 'video/mp4');
        logger.success(`[AutoClick Video] ✅ Upload R2 hoàn tất: ${r2Url}`);

        // 3. Xoá file trên máy tính
        try {
          fs.unlinkSync(filePath);
          logger.info(`[AutoClick Video] 🗑️ Đã xóa file video tạm trên máy: ${filePath}`);
        } catch (delErr) {
          logger.warn(`[AutoClick Video] Không thể xoá file tạm: ${delErr.message}`);
        }

        // 4. Trừ 10 credit của Chrome Profile Video hiện tại & tự động đổi sang profile mới nếu hết credit
        _consecutiveFlowErrors = 0;
        try {
          await deductVideoCreditAndRotateIfNeeded(10, { allowWindowSwitch: _activeVideoCount <= 1 });
        } catch (rotErr) {
          logger.warn(`[AutoClick Video] Lỗi trừ credit / chuyển profile: ${rotErr.message}`);
        }

        resolve({
          mediaId: taskId,
          url: r2Url,
          buffer,
          filePath,
          r2Url,
          filename: result.filename
        });
      } catch (err) {
        logger.error(`[AutoClick Video] Lỗi parse kết quả task ${taskId}: ${err.message}`);
        reject(err);
      }
    });

    proc.on('error', (err) => {
      logger.error(`[AutoClick Video] Lỗi khởi chạy tiến trình Python: ${err.message}`);
      reject(err);
    });
  });
}

module.exports = {
  generateVideoViaAutoClick
};
