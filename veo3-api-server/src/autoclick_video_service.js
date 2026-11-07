const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { logger } = require('./utils');
const { uploadToR2 } = require('./s3_uploader');
const {
  getActiveDisplay,
  ensureActiveVideoProfileHasCredits,
  ensureImageChromeWindowOpen,
  deductVideoCreditAndRotateIfNeeded
} = require('./chrome_profile_manager');

// Đường dẫn script Python
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/autoclick_video_runner.py');

// Hỗ trợ chạy song song tối đa 10 tác vụ Video (nửa màn hình trái) & 10 tác vụ Ảnh (nửa màn hình phải) cùng lúc.
// Bước click chuột & dán prompt (~3-4s) được khóa tuần tự qua /tmp/autoclick_video.lock trong autoclick_video_runner.py,
// còn bước chờ render & quét file <stt>.mp4 / <stt>.jpg chạy song song hoàn toàn!
const MAX_PARALLEL_VIDEO_TASKS = parseInt(process.env.VIDEO_CONCURRENCY || '10', 10);
const MAX_PARALLEL_IMAGE_TASKS = parseInt(process.env.IMAGE_CONCURRENCY || '10', 10);

let _activeVideoCount = 0;
const _videoWaitQueue = [];
let _consecutiveFlowErrors = 0;

let _activeImageCount = 0;
const _imageWaitQueue = [];

let _sttCounter = Math.floor(1000 + Math.random() * 8000);

function nextUniqueVideoStt() {
  _sttCounter = ((_sttCounter - 1000 + 1) % 8999) + 1000;
  return String(_sttCounter);
}

/**
 * Đóng dấu watermark góc dưới bên phải cho ảnh hoặc video (dành cho các gói < 299k).
 * Nếu có lỗi bất kỳ khi xử lý watermark, giữ nguyên file gốc để không làm hỏng task.
 */
function applyWatermarkToFile(filePath, watermarkText, mediaType = 'image') {
  const wmText = String(watermarkText || '').trim();
  if (!wmText || !filePath || !fs.existsSync(filePath)) return;

  const pyCode = `
import os, sys, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFont

file_path = sys.argv[1]
wm_text = sys.argv[2]
media_type = sys.argv[3]

def load_font(size):
    for fp in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ]:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                pass
    return ImageFont.load_default()

def make_badge(text, font_size):
    font = load_font(font_size)
    dummy = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    d = ImageDraw.Draw(dummy)
    bbox = d.textbbox((0, 0), text, font=font)
    tw = max(1, bbox[2] - bbox[0])
    th = max(1, bbox[3] - bbox[1])
    pad_x = max(10, int(font_size * 0.72))
    pad_y = max(6, int(font_size * 0.38))
    bw = tw + pad_x * 2
    bh = th + pad_y * 2
    badge = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    radius = bh // 2
    bd.rounded_rectangle([(0, 0), (bw - 1, bh - 1)], radius=radius, fill=(10, 14, 23, 148), outline=(255, 255, 255, 78), width=1)
    tx = pad_x - bbox[0]
    ty = pad_y - bbox[1]
    bd.text((tx + 1, ty + 1), text, font=font, fill=(0, 0, 0, 160))
    bd.text((tx, ty), text, font=font, fill=(255, 255, 255, 232))
    return badge

if media_type == "image":
    img = Image.open(file_path).convert("RGBA")
    w, h = img.size
    fsize = max(16, int(min(w, h) * 0.028))
    badge = make_badge(wm_text, fsize)
    bw, bh = badge.size
    mx = max(14, int(w * 0.022))
    my = max(14, int(h * 0.022))
    img.alpha_composite(badge, (max(0, w - bw - mx), max(0, h - bh - my)))
    ext = os.path.splitext(file_path)[1].lower()
    if ext in (".jpg", ".jpeg"):
        img.convert("RGB").save(file_path, "JPEG", quality=93)
    else:
        img.save(file_path)
elif media_type == "video":
    badge = make_badge(wm_text, 22)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as bf:
        badge_path = bf.name
    out_vid = file_path + ".wm.mp4"
    try:
        badge.save(badge_path, "PNG")
        cmd = [
            "ffmpeg", "-y",
            "-i", file_path,
            "-i", badge_path,
            "-filter_complex", "overlay=W-w-18:H-h-18",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
            "-c:a", "copy",
            out_vid
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        if res.returncode == 0 and os.path.exists(out_vid) and os.path.getsize(out_vid) > 1000:
            os.replace(out_vid, file_path)
    finally:
        if os.path.exists(badge_path):
            os.remove(badge_path)
        if os.path.exists(out_vid):
            os.remove(out_vid)
`;

  try {
    const res = spawnSync('python3', ['-c', pyCode, filePath, wmText, mediaType], { timeout: 95000 });
    if (res.status === 0) {
      logger.info(`[Watermark] ✅ Đã gắn watermark "${wmText}" (${mediaType}) vào ${path.basename(filePath)}`);
    } else {
      logger.warn(`[Watermark] Không thể gắn watermark (${mediaType}): ${(res.stderr || '').toString().slice(-200)}`);
    }
  } catch (err) {
    logger.warn(`[Watermark] Lỗi ngoại lệ khi gắn watermark (${mediaType}): ${err.message}`);
  }
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

function _acquireImageParallelSlot(taskId) {
  if (_activeImageCount < MAX_PARALLEL_IMAGE_TASKS) {
    _activeImageCount++;
    return Promise.resolve();
  }
  const waitPos = _imageWaitQueue.length + 1;
  logger.info(`[AutoClick Image] ⏳ Đang chạy đầy ${MAX_PARALLEL_IMAGE_TASKS} luồng ảnh song song, task ${taskId} chờ slot trống (hàng chờ #${waitPos})...`);
  return new Promise((resolve) => {
    _imageWaitQueue.push(resolve);
  });
}

function _releaseImageParallelSlot() {
  if (_imageWaitQueue.length > 0) {
    const nextResolve = _imageWaitQueue.shift();
    nextResolve();
  } else {
    _activeImageCount = Math.max(0, _activeImageCount - 1);
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
 * Tạo video tự động qua Python PyAutoGUI (Nửa màn hình bên trái: 0, 27, 800x873):
 * 1. Click (399, 588) -> Dán prompt -> Click (399, 729)
 * 2. Quét thư mục ~/Downloads tối đa 5 phút (300s) lấy <stt>.mp4
 * 3. Đọc file, upload lên R2 và xóa file trên máy
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
    const dlDir = path.join(os.homedir(), 'Downloads');
    const oldFile = path.join(dlDir, `${stt}.mp4`);
    if (fs.existsSync(oldFile)) {
      fs.unlinkSync(oldFile);
    }
  } catch (_) {}

  // Đảm bảo Chrome Profile đang mở làm Video còn đủ >= 10 credit
  try {
    await ensureActiveVideoProfileHasCredits({ allowWindowSwitch: _activeVideoCount <= 1 });
  } catch (profErr) {
    logger.warn(`[AutoClick Video] Không thể kiểm tra/chuyển profile trước khi chạy: ${profErr.message}`);
  }

  logger.info(`[AutoClick Video] 🚀 Khởi chạy task ${taskId} (STT: ${stt}, Ratio: ${ratio}, Active: ${_activeVideoCount}/${MAX_PARALLEL_VIDEO_TASKS}): "${prompt.slice(0, 40)}..."`);

  const args = [
    SCRIPT_PATH,
    '--mode', 'video',
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
    const activeDisp = typeof getActiveDisplay === 'function' ? getActiveDisplay() : ':11';
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
      logger.info(`[AutoClick Video Runner] ${msg}`);
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

        // 0. Đóng dấu watermark nếu task có watermarkText (dành cho các gói < 299k)
        if (task.watermarkText) {
          applyWatermarkToFile(filePath, task.watermarkText, 'video');
        }

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

/**
 * Tạo ảnh tự động qua Python PyAutoGUI (Nửa màn hình bên phải: 800, 27, 800x873):
 * 1. Click (995, 495) -> Dán prompt <ratio>|<stt>. <prompt>[|data:image/jpeg;base64,...] -> Click (995, 608)
 * 2. Quét thư mục ~/Downloads tối đa 3 phút (180s) lấy <stt>.jpg / .png
 * 3. Đọc file, upload lên R2 và xóa file trên máy
 *
 * @param {object} task { id, prompt, aspectRatio, referenceImages, referenceImage, seq }
 * @returns {Promise<{ mediaId: string, url: string, buffer: Buffer, filePath: string, r2Url: string }>}
 */
async function generateImageViaAutoClick(task) {
  const taskId = task.id || `img_${Date.now()}`;
  await _acquireImageParallelSlot(taskId);
  try {
    return await _executeSingleImageViaAutoClick(task, taskId);
  } finally {
    _releaseImageParallelSlot();
  }
}

async function _executeSingleImageViaAutoClick(task, taskId) {
  const prompt = String(task.prompt || '')
    .replace(/\|+/g, ' - ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rawRatio = String(task.aspectRatio || '9:16').trim().toLowerCase();
  let ratio = '9:16';
  if (rawRatio.includes('16:9') || rawRatio.includes('wide') || rawRatio.includes('landscape')) {
    ratio = '16:9';
  } else if (rawRatio.includes('1:1') || rawRatio.includes('square')) {
    ratio = '1:1';
  }

  const stt = String(task.seq || nextUniqueVideoStt());

  // Xoá trước các file ảnh trùng tên <stt>.jpg/.png cũ trong ~/Downloads nếu còn sót lại
  try {
    const dlDir = path.join(os.homedir(), 'Downloads');
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const oldFile = path.join(dlDir, `${stt}${ext}`);
      if (fs.existsSync(oldFile)) {
        fs.unlinkSync(oldFile);
      }
    }
  } catch (_) {}

  // Đảm bảo cửa sổ Chrome Làm Ảnh (Profile 6) ở nửa màn hình phải (800, 27, 800x873) đang mở sẵn sàng
  try {
    await ensureImageChromeWindowOpen();
  } catch (profErr) {
    logger.warn(`[AutoClick Image] Không thể kiểm tra cửa sổ Chrome Ảnh trước khi chạy: ${profErr.message}`);
  }

  logger.info(`[AutoClick Image] 🚀 Khởi chạy task ảnh ${taskId} (STT: ${stt}, Ratio: ${ratio}, Active: ${_activeImageCount}/${MAX_PARALLEL_IMAGE_TASKS}): "${prompt.slice(0, 40)}..."`);

  const args = [
    SCRIPT_PATH,
    '--mode', 'image',
    '--prompt', prompt,
    '--stt', String(stt),
    '--ratio', ratio,
    '--timeout', '180' // 3 phút timeout cho ảnh
  ];

  // Xử lý reference images (nếu có): nếu là chuỗi data:image dài, ghi ra file tạm /tmp để tránh giới hạn ARG_MAX
  const tempRefFiles = [];
  const rawRefs = Array.isArray(task.referenceImages) && task.referenceImages.length > 0
    ? task.referenceImages
    : (task.referenceImage ? [task.referenceImage] : []);

  for (let i = 0; i < rawRefs.length; i++) {
    const refItem = rawRefs[i];
    if (!refItem || typeof refItem !== 'string') continue;
    if (refItem.startsWith('data:image')) {
      try {
        const b64Part = refItem.split(',')[1] || refItem;
        const tmpFile = `/tmp/autoclick_ref_${taskId}_${i}_${Date.now()}.jpg`;
        fs.writeFileSync(tmpFile, Buffer.from(b64Part, 'base64'));
        tempRefFiles.push(tmpFile);
        args.push('--ref-image', tmpFile);
      } catch (e) {
        logger.warn(`[AutoClick Image] Không thể ghi tạm ref image ${i}: ${e.message}`);
      }
    } else {
      args.push('--ref-image', refItem);
    }
  }

  const cleanupTempRefs = () => {
    for (const f of tempRefFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  };

  return new Promise((resolve, reject) => {
    const activeDisp = typeof getActiveDisplay === 'function' ? getActiveDisplay() : ':11';
    logger.info(`[AutoClick Image] Spawning on DISPLAY=${activeDisp}: python3 ${args.join(' ')}`);
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
      logger.info(`[AutoClick Image Runner] ${msg}`);
    });

    proc.on('close', async (code) => {
      cleanupTempRefs();
      logger.info(`[AutoClick Image] Script kết thúc với exit code: ${code}`);

      if (code !== 0) {
        let errMsg = `AutoClick Image script failed (code ${code})`;
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.error) errMsg = parsed.error;
        } catch (_) {
          if (stderr) errMsg += `: ${stderr.slice(-300)}`;
        }
        logger.error(`[AutoClick Image] ❌ Task ảnh ${taskId} thất bại: ${errMsg}`);
        return reject(new Error(errMsg));
      }

      try {
        const result = JSON.parse(stdout.trim());
        const filePath = result.file_path;

        if (!filePath || !fs.existsSync(filePath)) {
          return reject(new Error(`File ảnh không tồn tại trên đĩa: ${filePath}`));
        }

        const fileSizeKB = (result.size / 1024).toFixed(1);
        logger.success(`[AutoClick Image] 🎉 Đã nhận ảnh từ máy tính: ${filePath} (${fileSizeKB} KB, sau ${result.elapsed}s)`);

        // 0. Đóng dấu watermark nếu task có watermarkText (dành cho các gói < 299k)
        if (task.watermarkText) {
          applyWatermarkToFile(filePath, task.watermarkText, 'image');
        }

        // 1. Đọc nội dung file ảnh
        const buffer = fs.readFileSync(filePath);

        // 2. Upload lên Cloudflare R2
        const ext = path.extname(filePath).toLowerCase() === '.png' ? '.png' : '.jpg';
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
        const fileName = `meo3/images/${taskId}_${Date.now()}${ext}`;
        logger.info(`[AutoClick Image] ☁️ Đang upload ảnh lên R2: ${fileName}...`);
        const r2Url = await uploadToR2(buffer, fileName, contentType);
        logger.success(`[AutoClick Image] ✅ Upload ảnh R2 hoàn tất: ${r2Url}`);

        // 3. Xoá file tạm trên máy tính
        try {
          fs.unlinkSync(filePath);
          logger.info(`[AutoClick Image] 🗑️ Đã xóa file ảnh tạm trên máy: ${filePath}`);
        } catch (delErr) {
          logger.warn(`[AutoClick Image] Không thể xoá file ảnh tạm: ${delErr.message}`);
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
        logger.error(`[AutoClick Image] Lỗi parse kết quả task ảnh ${taskId}: ${err.message}`);
        reject(err);
      }
    });

    proc.on('error', (err) => {
      cleanupTempRefs();
      logger.error(`[AutoClick Image] Lỗi khởi chạy tiến trình Python: ${err.message}`);
      reject(err);
    });
  });
}

module.exports = {
  generateVideoViaAutoClick,
  generateImageViaAutoClick
};
