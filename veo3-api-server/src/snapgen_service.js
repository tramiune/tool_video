const fs = require('fs');
const path = require('path');
const { logger, sleep } = require('./utils');
const { uploadToR2 } = require('./s3_uploader');
const { applyWatermarkToFile } = require('./autoclick_video_service');
const { supabase } = require('./supabase_client');

const CONFIG_FILE = path.resolve(__dirname, '../config_mode.json');
const DEFAULT_SNAPGEN_KEY = 'geminiai-b8e229c1a6eedae3170fd926f387b464';

let _cachedProvider = null;
let _lastCheckTime = 0;

/**
 * Lấy provider hiện tại ('snapgen' hoặc 'autoclick').
 * Cache 5 giây để giảm tải query Supabase.
 */
async function getActiveGenerationProvider() {
  const now = Date.now();
  if (_cachedProvider && (now - _lastCheckTime < 5000)) {
    return _cachedProvider;
  }

  // 1. Đọc từ file cấu hình local trước nếu có
  if (!_cachedProvider && fs.existsSync(CONFIG_FILE)) {
    try {
      const localCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (localCfg?.provider) {
        _cachedProvider = localCfg.provider;
      }
    } catch (_) {}
  }

  // 2. Đồng bộ với Supabase
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('model')
      .eq('id', '__system_config__')
      .maybeSingle();

    if (data && data.model && (data.model === 'snapgen' || data.model === 'autoclick')) {
      _cachedProvider = data.model;
    }
  } catch (err) {
    // Không làm gián đoạn luồng nếu Supabase query lỗi
  }

  // Mặc định tạm thời là snapgen theo yêu cầu của user
  if (!_cachedProvider) {
    _cachedProvider = 'snapgen';
  }

  _lastCheckTime = now;
  return _cachedProvider;
}

/**
 * Đổi provider ('snapgen' hoặc 'autoclick') và lưu vào Supabase + file local
 */
async function setGenerationProvider(mode) {
  const normalized = mode === 'autoclick' ? 'autoclick' : 'snapgen';
  _cachedProvider = normalized;
  _lastCheckTime = Date.now();

  // Lưu file local
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ provider: normalized, updatedAt: Date.now() }, null, 2));
  } catch (err) {
    logger.warn(`[SnapGen] Không thể lưu config_mode.json: ${err.message}`);
  }

  // Đồng bộ Supabase
  try {
    const now = Date.now();
    await supabase.from('tasks').upsert({
      id: '__system_config__',
      type: 'config',
      status: 'active',
      prompt: 'generation_provider',
      model: normalized,
      app: 'all',
      created_at: now,
      updated_at: now
    });
    logger.success(`[SnapGen] Đã cập nhật chế độ tạo ảnh/video thành: ${normalized.toUpperCase()}`);
  } catch (err) {
    logger.warn(`[SnapGen] Lỗi khi lưu chế độ vào Supabase: ${err.message}`);
  }

  return normalized;
}

function getSnapGenApiKey() {
  return process.env.SNAPGEN_API_KEY || process.env.VIDEO_KEY || DEFAULT_SNAPGEN_KEY;
}

function getSnapGenBaseUrl() {
  return (process.env.VIDEO_URL || 'https://api.snapgen.ai/uapi/v1').replace(/\/+$/, '');
}

/**
 * Helper tải Buffer từ URL, Base64, hoặc file cục bộ
 */
async function loadImageBuffer(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    const str = input.trim();
    if (str.startsWith('http://') || str.startsWith('https://')) {
      const res = await fetch(str);
      if (!res.ok) throw new Error(`Không tải được ảnh từ URL: ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    }
    if (str.startsWith('data:image/')) {
      const base64Data = str.split(',')[1];
      return Buffer.from(base64Data, 'base64');
    }
    if (fs.existsSync(str)) {
      return fs.readFileSync(str);
    }
  }
  if (Buffer.isBuffer(input)) return input;
  return null;
}

/**
 * Tạo Video qua SnapGen API (Veo 3.1 Lite 8s)
 */
async function generateVideoViaSnapGen(task) {
  const apiKey = getSnapGenApiKey();
  const baseUrl = getSnapGenBaseUrl();
  const taskId = task.id || `task_${Date.now()}`;
  logger.info(`[SnapGen Video] Bắt đầu tạo video task ${taskId} (Veo 3.1 Lite 8s)...`);

  const fd = new FormData();
  fd.append('prompt', task.prompt || '');
  fd.append('model', 'veo-3.1-lite');
  fd.append('aspect_ratio', task.aspectRatio || '9:16');

  // Nếu có ảnh Start (ưu tiên Start Frame cố định) hoặc ảnh tham chiếu
  const startImgInput = task.startImage || task.image;
  const refImages = Array.isArray(task.referenceImages) ? task.referenceImages : (task.referenceImage ? [task.referenceImage] : []);

  if (startImgInput) {
    try {
      const buf = await loadImageBuffer(startImgInput);
      if (buf && buf.length > 0) {
        const blob = new Blob([buf], { type: 'image/jpeg' });
        fd.append('files', blob, 'start_image.jpg');
        fd.append('mode_image', 'frame');
        logger.info(`[SnapGen Video] Đã gắn ảnh Start Frame (mode_image: frame, ${(buf.length / 1024).toFixed(1)} KB)`);
      }
    } catch (imgErr) {
      logger.warn(`[SnapGen Video] Không thể đính kèm ảnh Start: ${imgErr.message}`);
    }
  } else if (refImages.length > 0) {
    try {
      const buf = await loadImageBuffer(refImages[0]);
      if (buf && buf.length > 0) {
        const blob = new Blob([buf], { type: 'image/jpeg' });
        fd.append('files', blob, 'ref_image.jpg');
        fd.append('mode_image', 'ingredient');
        logger.info(`[SnapGen Video] Đã gắn ảnh tham chiếu (mode_image: ingredient, ${(buf.length / 1024).toFixed(1)} KB)`);
      }
    } catch (refErr) {
      logger.warn(`[SnapGen Video] Không thể đính kèm ảnh tham chiếu: ${refErr.message}`);
    }
  }

  // 1. Submit task tới SnapGen API
  const submitUrl = `${baseUrl}/video-gen/veo`;
  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: fd
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    logger.error(`[SnapGen Video] Submit lỗi (${submitRes.status}): ${errText}`);
    if (submitRes.status === 503 || /maintenance/i.test(errText)) {
      throw new Error('Máy chủ AI đang bảo trì hoặc nâng cấp hệ thống. Vui lòng thử lại sau ít phút.');
    }
    throw new Error(`Máy chủ AI tạm thời chưa tiếp nhận được yêu cầu (${submitRes.status}). Vui lòng thử lại sau.`);
  }

  const submitData = await submitRes.json();
  const uuid = submitData.uuid;
  if (!uuid) {
    throw new Error('Hệ thống chưa tạo được mã xử lý cho tác phẩm. Vui lòng thử lại.');
  }
  logger.info(`[SnapGen Video] Task UUID: ${uuid} — bắt đầu polling kết quả...`);

  // 2. Polling lấy kết quả video
  const maxWaitMs = 360000; // 6 phút
  const startTime = Date.now();
  let videoDownloadUrl = null;

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(4000);
    let checkRes;
    try {
      checkRes = await fetch(`${baseUrl}/history/${uuid}`, {
        headers: { 'x-api-key': apiKey }
      });
    } catch (netErr) {
      continue;
    }

    if (!checkRes.ok) continue;
    const result = await checkRes.json();

    // status: 0 = pending, 1 = processing, 2 = success, 3 = failed
    if (result.status === 2) {
      videoDownloadUrl = result.generated_video?.[0]?.video_url || result.generated_video?.[0]?.file_download_url;
      logger.success(`[SnapGen Video] Render thành công task ${taskId} (UUID: ${uuid})`);
      break;
    } else if (result.status === 3 || result.status < 0) {
      const errMsg = result.error_message || '';
      if (result.error_code === 'PROMPT_CONTENT_POLICY_VIOLATION' || /restricted content|sexual content|content policy|policy violation/i.test(errMsg)) {
        throw new Error('Nội dung câu lệnh hoặc hình ảnh vi phạm tiêu chuẩn an toàn của hệ thống (nhạy cảm, bản quyền...). Vui lòng điều chỉnh lại prompt.');
      }
      throw new Error(errMsg || 'Quá trình kết xuất video gặp sự cố. Vui lòng thử lại.');
    }
  }

  if (!videoDownloadUrl) {
    throw new Error('Hệ thống xử lý quá thời gian chờ kết xuất video. Vui lòng bấm Thử lại.');
  }

  // 3. Tải video kết quả về file tạm
  logger.info(`[SnapGen Video] Đang tải file video MP4...`);
  const vRes = await fetch(videoDownloadUrl);
  if (!vRes.ok) throw new Error(`Không thể tải video từ máy chủ lưu trữ: ${vRes.statusText}`);
  const videoBuffer = Buffer.from(await vRes.arrayBuffer());

  const tmpVideoPath = `/tmp/snapgen_vid_${taskId}_${Date.now()}.mp4`;
  fs.writeFileSync(tmpVideoPath, videoBuffer);

  // 4. Đóng watermark nếu có yêu cầu
  if (task.watermarkText) {
    try {
      applyWatermarkToFile(tmpVideoPath, task.watermarkText, 'video');
    } catch (wmErr) {
      logger.warn(`[SnapGen Video] Watermark warning: ${wmErr.message}`);
    }
  }

  // 5. Upload lên Cloudflare R2
  const finalBuffer = fs.readFileSync(tmpVideoPath);
  try { fs.unlinkSync(tmpVideoPath); } catch (_) {}

  const r2Key = `meo3/videos/${taskId}_${Date.now()}.mp4`;
  const r2Url = await uploadToR2(finalBuffer, r2Key, 'video/mp4');
  logger.success(`[SnapGen Video] Đã upload R2 thành công: ${r2Url}`);

  return {
    r2Url,
    url: r2Url,
    mediaId: uuid,
    buffer: finalBuffer
  };
}

/**
 * Tạo Ảnh qua SnapGen API (Nano Banana Pro)
 */
async function generateImageViaSnapGen(task) {
  const apiKey = getSnapGenApiKey();
  const baseUrl = getSnapGenBaseUrl();
  const taskId = task.id || `task_${Date.now()}`;
  logger.info(`[SnapGen Image] Bắt đầu tạo ảnh task ${taskId} (Nano Banana Pro)...`);

  const fd = new FormData();
  fd.append('prompt', task.prompt || '');
  fd.append('model', 'nano-banana-pro');
  fd.append('aspect_ratio', task.aspectRatio || '9:16');

  // Đính kèm ảnh tham chiếu nếu có
  const refs = Array.isArray(task.referenceImages) ? task.referenceImages : (task.referenceImage ? [task.referenceImage] : []);
  if (refs.length > 0) {
    let attachedCount = 0;
    for (let i = 0; i < Math.min(refs.length, 3); i++) {
      try {
        const buf = await loadImageBuffer(refs[i]);
        if (buf && buf.length > 0) {
          const blob = new Blob([buf], { type: 'image/jpeg' });
          fd.append('files', blob, `ref_${i}.jpg`);
          attachedCount++;
        }
      } catch (refErr) {
        logger.warn(`[SnapGen Image] Không thể đính kèm ref image ${i}: ${refErr.message}`);
      }
    }
    if (attachedCount > 0) {
      logger.info(`[SnapGen Image] Đã gắn ${attachedCount} ảnh tham chiếu`);
    }
  }

  // 1. Submit task tới SnapGen API
  const submitUrl = `${baseUrl}/generate_image`;
  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: fd
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    logger.error(`[SnapGen Image] Submit lỗi (${submitRes.status}): ${errText}`);
    if (submitRes.status === 503 || /maintenance/i.test(errText)) {
      throw new Error('Máy chủ AI đang bảo trì hoặc nâng cấp hệ thống. Vui lòng thử lại sau ít phút.');
    }
    throw new Error(`Máy chủ AI tạm thời chưa tiếp nhận được yêu cầu tạo ảnh (${submitRes.status}). Vui lòng thử lại sau.`);
  }

  const submitData = await submitRes.json();
  const uuid = submitData.uuid;
  if (!uuid) {
    throw new Error('Hệ thống chưa tạo được mã xử lý ảnh. Vui lòng thử lại.');
  }
  logger.info(`[SnapGen Image] Task UUID: ${uuid} — bắt đầu polling...`);

  // 2. Polling lấy kết quả ảnh
  const maxWaitMs = 180000; // 3 phút
  const startTime = Date.now();
  let imageDownloadUrl = null;

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(3000);
    let checkRes;
    try {
      checkRes = await fetch(`${baseUrl}/history/${uuid}`, {
        headers: { 'x-api-key': apiKey }
      });
    } catch (netErr) {
      continue;
    }

    if (!checkRes.ok) continue;
    const result = await checkRes.json();

    if (result.status === 2) {
      imageDownloadUrl = result.generated_image?.[0]?.image_url || result.generated_image?.[0]?.file_download_url;
      logger.success(`[SnapGen Image] Sinh ảnh thành công task ${taskId} (UUID: ${uuid})`);
      break;
    } else if (result.status === 3 || result.status < 0) {
      const errMsg = result.error_message || '';
      if (result.error_code === 'PROMPT_CONTENT_POLICY_VIOLATION' || /restricted content|sexual content|content policy|policy violation/i.test(errMsg)) {
        throw new Error('Nội dung câu lệnh hoặc hình ảnh vi phạm tiêu chuẩn an toàn của hệ thống (nhạy cảm, bản quyền...). Vui lòng điều chỉnh lại prompt.');
      }
      throw new Error(errMsg || 'Quá trình tạo ảnh gặp sự cố. Vui lòng thử lại.');
    }
  }

  if (!imageDownloadUrl) {
    throw new Error('Hệ thống xử lý quá thời gian chờ tạo ảnh. Vui lòng bấm Thử lại.');
  }

  // 3. Tải ảnh kết quả về file tạm
  logger.info(`[SnapGen Image] Đang tải file ảnh...`);
  const imgRes = await fetch(imageDownloadUrl);
  if (!imgRes.ok) throw new Error(`Không thể tải ảnh từ máy chủ lưu trữ: ${imgRes.statusText}`);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

  const tmpImgPath = `/tmp/snapgen_img_${taskId}_${Date.now()}.png`;
  fs.writeFileSync(tmpImgPath, imgBuffer);

  // 4. Đóng watermark nếu có yêu cầu
  if (task.watermarkText) {
    try {
      applyWatermarkToFile(tmpImgPath, task.watermarkText, 'image');
    } catch (wmErr) {
      logger.warn(`[SnapGen Image] Watermark warning: ${wmErr.message}`);
    }
  }

  // 5. Upload lên Cloudflare R2
  const finalBuffer = fs.readFileSync(tmpImgPath);
  try { fs.unlinkSync(tmpImgPath); } catch (_) {}

  const r2Key = `meo3/images/${taskId}_${Date.now()}.png`;
  const r2Url = await uploadToR2(finalBuffer, r2Key, 'image/png');
  logger.success(`[SnapGen Image] Đã upload R2 thành công: ${r2Url}`);

  return {
    r2Url,
    url: r2Url,
    mediaId: uuid,
    buffer: finalBuffer
  };
}

module.exports = {
  getActiveGenerationProvider,
  setGenerationProvider,
  generateVideoViaSnapGen,
  generateImageViaSnapGen
};
