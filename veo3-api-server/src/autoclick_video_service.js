const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { logger } = require('./utils');
const { uploadToR2 } = require('./s3_uploader');
const { ensureActiveVideoProfileHasCredits, deductVideoCreditAndRotateIfNeeded } = require('./chrome_profile_manager');

// Đường dẫn script Python
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/autoclick_video_runner.py');

/**
 * Đảm bảo URL ảnh đầu vào có CORS header (nếu khác bucket meo3 R2 thì tải về và đẩy sang R2 của meo3)
 */
async function ensureCorsImageUrl(imgUrl, taskId, tag = 'start') {
  if (!imgUrl || typeof imgUrl !== 'string') return imgUrl;
  const r2PublicBase = process.env.R2_PUBLIC_URL || 'https://pub-6d69dc0dc47542f4ad0de11f34132785.r2.dev';
  if (imgUrl.startsWith(r2PublicBase)) return imgUrl;
  if (!imgUrl.startsWith('http')) return imgUrl;
  try {
    const res = await fetch(imgUrl);
    if (!res.ok) return imgUrl;
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const key = `meo3/inputs/${taskId}_${tag}_${Date.now()}.${ext}`;
    const newUrl = await uploadToR2(buf, key, ct);
    logger.info(`[AutoClick Video] Đã đồng bộ ảnh ${tag} sang R2 CORS: ${newUrl}`);
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
  const prompt = String(task.prompt || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const ratio = task.aspectRatio || '9:16';
  const stt = task.seq || (prompt.match(/^(\d{1,4})[\.\-_:\s]/)?.[1] || Date.now().toString().slice(-4));

  // Đảm bảo Chrome Profile đang mở làm Video còn đủ >= 10 credit (nếu hết tự động bật profile tiếp theo)
  try {
    await ensureActiveVideoProfileHasCredits();
  } catch (profErr) {
    logger.warn(`[AutoClick Video] Không thể kiểm tra/chuyển profile trước khi chạy: ${profErr.message}`);
  }

  logger.info(`[AutoClick Video] 🚀 Khởi chạy task ${taskId} (STT: ${stt}): "${prompt.slice(0, 40)}..."`);

  const args = [
    SCRIPT_PATH,
    '--prompt', prompt,
    '--stt', String(stt),
    '--ratio', ratio,
    '--timeout', '300' // 5 phút timeout
  ];

  if (task.startImage) {
    const safeStart = await ensureCorsImageUrl(task.startImage, taskId, 'start');
    args.push('--start-image', safeStart);
  }
  if (task.endImage) {
    const safeEnd = await ensureCorsImageUrl(task.endImage, taskId, 'end');
    args.push('--end-image', safeEnd);
  }

  return new Promise((resolve, reject) => {
    logger.info(`[AutoClick Video] Spawning: python3 ${args.join(' ')}`);
    const env = {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':10'
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
        try {
          await deductVideoCreditAndRotateIfNeeded(10);
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
