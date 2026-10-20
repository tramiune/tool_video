const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const { logger } = require('./utils');

const CHROME_CONFIG_DIR = path.join(os.homedir(), '.config', 'google-chrome');
const LOCAL_STATE_PATH = path.join(CHROME_CONFIG_DIR, 'Local State');
const PROFILES_STATE_FILE = path.join(__dirname, '../chrome_profiles.json');

// Tọa độ chuẩn của cửa sổ Video (y hệt veo3_002 / Profile 4 hiện tại)
const VIDEO_WINDOW_PLACEMENT = {
  bottom: 933,
  left: -4,
  maximized: false,
  right: 504,
  top: 27,
  work_area_bottom: 900,
  work_area_left: 0,
  work_area_right: 1600,
  work_area_top: 27
};
const VIDEO_WIN_X = -4;
const VIDEO_WIN_Y = 27;
const VIDEO_WIN_W = 508;
const VIDEO_WIN_H = 906;

const DEFAULT_SEED = {
  'Profile 4': {
    role: 'video',
    credits: 500,
    isActiveVideo: true,
    flowUrl: 'https://flow.google.com/project/8c0a4f08-ba0c-43e6-8332-6a417df9bbf3/tool/0b32ee5f-3fde-4235-b517-05c3709f1304'
  },
  'Profile 3': {
    role: 'video',
    credits: 500,
    isActiveVideo: false,
    flowUrl: 'https://flow.google.com/project/fbfd51c4-824f-4861-b862-fb2835fffe7e'
  },
  'Default': {
    role: 'none',
    credits: 500,
    isActiveVideo: false,
    flowUrl: 'https://flow.google.com/project/d2bcc79b-57c1-4e16-ad78-05d4806f76bf/tool/0b32ee5f-3fde-4235-b517-05c3709f1304'
  },
  'Profile 6': {
    role: 'image',
    credits: 500,
    isActiveVideo: false,
    flowUrl: 'https://flow.google.com/project/4a4d000c-94ca-435d-911d-36d060f55222'
  }
};

function loadSavedState() {
  try {
    if (fs.existsSync(PROFILES_STATE_FILE)) {
      const raw = fs.readFileSync(PROFILES_STATE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.profiles)) {
        return data;
      }
    }
  } catch (err) {
    logger.warn(`[ProfileManager] Lỗi đọc chrome_profiles.json: ${err.message}`);
  }
  return null;
}

function saveState(state) {
  try {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(PROFILES_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[ProfileManager] Lỗi lưu chrome_profiles.json: ${err.message}`);
  }
}

function detectLastFlowUrl(profileDir) {
  try {
    const sessionsDir = path.join(CHROME_CONFIG_DIR, profileDir, 'Sessions');
    if (!fs.existsSync(sessionsDir)) return '';
    const out = execSync(
      `strings "${sessionsDir}"/* 2>/dev/null | grep -Eo 'https://flow\\.google\\.com/project/[a-zA-Z0-9_/-]+' | tail -n 10`,
      { encoding: 'utf8', timeout: 3000 }
    );
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    const toolLine = lines.reverse().find(l => l.includes('/tool/'));
    return toolLine || lines[0] || '';
  } catch (_) {
    return '';
  }
}

/**
 * Quét danh sách Chrome Profiles từ Local State (chỉ chạy khi bấm Refresh hoặc khởi tạo lần đầu)
 */
function scanChromeProfiles() {
  const existingState = loadSavedState();
  const existingMap = new Map();
  if (existingState && Array.isArray(existingState.profiles)) {
    for (const p of existingState.profiles) {
      existingMap.set(p.profileDir, p);
    }
  }

  let infoCache = {};
  try {
    if (fs.existsSync(LOCAL_STATE_PATH)) {
      const ls = JSON.parse(fs.readFileSync(LOCAL_STATE_PATH, 'utf8'));
      infoCache = ls?.profile?.info_cache || {};
    }
  } catch (err) {
    logger.error(`[ProfileManager] Không thể đọc Local State: ${err.message}`);
  }

  const profiles = [];
  const dirs = Object.keys(infoCache);

  for (const dir of dirs) {
    const meta = infoCache[dir] || {};
    const prev = existingMap.get(dir);
    const seed = DEFAULT_SEED[dir] || {};

    const detectedUrl = detectLastFlowUrl(dir);
    const flowUrl = (prev?.flowUrl !== undefined && prev.flowUrl !== '')
      ? prev.flowUrl
      : (seed.flowUrl || detectedUrl || 'https://flow.google.com/');

    profiles.push({
      profileDir: dir,
      name: meta.name || dir,
      email: meta.user_name || '',
      gaiaName: meta.gaia_name || '',
      role: prev?.role || seed.role || 'none', // 'video' | 'image' | 'none'
      credits: typeof prev?.credits === 'number' ? prev.credits : (typeof seed.credits === 'number' ? seed.credits : 500),
      flowUrl,
      isActiveVideo: Boolean(prev ? prev.isActiveVideo : seed.isActiveVideo),
      lastUsedAt: prev?.lastUsedAt || null
    });
  }

  // Đảm bảo chỉ có tối đa 1 profile isActiveVideo = true
  let activeFound = false;
  for (const p of profiles) {
    if (p.role !== 'video') {
      p.isActiveVideo = false;
    } else if (p.isActiveVideo) {
      if (!activeFound) activeFound = true;
      else p.isActiveVideo = false;
    }
  }
  if (!activeFound) {
    const firstVideo = profiles.find(p => p.role === 'video' && p.credits >= 10) || profiles.find(p => p.role === 'video');
    if (firstVideo) firstVideo.isActiveVideo = true;
  }

  const newState = {
    profiles,
    updatedAt: new Date().toISOString()
  };
  saveState(newState);
  return newState;
}

function getProfilesState() {
  const saved = loadSavedState();
  if (saved && Array.isArray(saved.profiles) && saved.profiles.length > 0) {
    return saved;
  }
  return scanChromeProfiles();
}

/**
 * Lấy danh sách cửa sổ Chrome đang mở trên DISPLAY=:10
 */
function getOpenChromeWindows() {
  try {
    const out = execSync('DISPLAY=:10 wmctrl -lG', { encoding: 'utf8', timeout: 3000 });
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    const wins = [];
    for (const line of lines) {
      if (!line.toLowerCase().includes('google chrome')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 7) continue;
      const winId = parts[0];
      const x = parseInt(parts[2], 10);
      const y = parseInt(parts[3], 10);
      const w = parseInt(parts[4], 10);
      const h = parseInt(parts[5], 10);
      const title = parts.slice(7).join(' ');
      wins.push({ winId, x, y, w, h, title });
    }
    return wins;
  } catch (_) {
    return [];
  }
}

/**
 * Ghi cấu hình vị trí cửa sổ chuẩn của 002 vào Preferences của profile trước khi mở
 */
function enforceProfileWindowPlacement(profileDir) {
  try {
    const prefPath = path.join(CHROME_CONFIG_DIR, profileDir, 'Preferences');
    if (!fs.existsSync(prefPath)) return;
    const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    if (!pref.browser) pref.browser = {};
    pref.browser.window_placement = { ...VIDEO_WINDOW_PLACEMENT };
    fs.writeFileSync(prefPath, JSON.stringify(pref), 'utf8');
  } catch (err) {
    logger.warn(`[ProfileManager] Không thể ghi window_placement cho ${profileDir}: ${err.message}`);
  }
}

/**
 * Đóng cửa sổ Chrome làm Video bên trái (x < 250), giữ nguyên cửa sổ làm Ảnh bên phải (x >= 250)
 * và mở Chrome Profile mới vào đúng link Flow + đúng tọa độ của 002 (-4, 27, 508x906)
 */
async function switchVideoChromeWindow(targetProfile) {
  if (!targetProfile || !targetProfile.profileDir) {
    throw new Error('Target profile không hợp lệ');
  }

  const profileDir = targetProfile.profileDir;
  const flowUrl = (targetProfile.flowUrl || 'https://flow.google.com/').trim();

  logger.info(`[ProfileManager] 🔄 Đang chuyển cửa sổ Video sang profile "${targetProfile.name}" (${profileDir}) → ${flowUrl}`);

  // 1. Tìm các cửa sổ Chrome hiện tại
  const beforeWins = getOpenChromeWindows();
  const imageWinIds = new Set();

  for (const win of beforeWins) {
    // Cửa sổ bên trái (x < 250) là cửa sổ Video (002 hiện tại ở x = -4, w = 508)
    // Cửa sổ bên phải (x >= 250, ví dụ x = 515) là cửa sổ Ảnh -> giữ nguyên tuyệt đối!
    if (win.x < 250) {
      try {
        logger.info(`[ProfileManager] 🗑️ Đóng cửa sổ Video cũ: ${win.winId} (${win.title}) tại x=${win.x}, y=${win.y}`);
        execSync(`DISPLAY=:10 wmctrl -ic ${win.winId}`, { timeout: 3000 });
      } catch (e) {
        logger.warn(`[ProfileManager] Lỗi đóng cửa sổ ${win.winId}: ${e.message}`);
      }
    } else {
      imageWinIds.add(win.winId);
    }
  }

  // Chờ 1.5s cho cửa sổ cũ đóng hẳn
  await new Promise(r => setTimeout(r, 1500));

  // 2. Cập nhật window_placement trong Preferences của profile mới giống hệt 002
  enforceProfileWindowPlacement(profileDir);

  // 3. Mở cửa sổ Chrome mới của profileDir vào đúng link Flow
  const args = [
    `--profile-directory=${profileDir}`,
    '--new-window',
    `--window-position=${VIDEO_WIN_X},${VIDEO_WIN_Y}`,
    `--window-size=${VIDEO_WIN_W},${VIDEO_WIN_H}`,
    flowUrl
  ];

  const child = spawn('/opt/google/chrome/chrome', args, {
    env: { ...process.env, DISPLAY: ':10' },
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // 4. Đợi cửa sổ mới xuất hiện và ép chính xác vị trí/kích thước bằng wmctrl + xdotool
  let newWin = null;
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    const currentWins = getOpenChromeWindows();
    newWin = currentWins.find(w => !imageWinIds.has(w.winId));
    if (newWin) break;
  }

  if (newWin) {
    try {
      execSync(`DISPLAY=:10 wmctrl -ir ${newWin.winId} -b remove,maximized_vert,maximized_horz`, { timeout: 3000 });
      execSync(`DISPLAY=:10 wmctrl -ir ${newWin.winId} -e 0,${VIDEO_WIN_X},${VIDEO_WIN_Y},${VIDEO_WIN_W},${VIDEO_WIN_H}`, { timeout: 3000 });
      execSync(`DISPLAY=:10 xdotool windowActivate ${newWin.winId}`, { timeout: 3000 });
      logger.success(`[ProfileManager] ✅ Đã mở & đặt cửa sổ "${targetProfile.name}" (${newWin.winId}) tại đúng vị trí (${VIDEO_WIN_X}, ${VIDEO_WIN_Y}, ${VIDEO_WIN_W}x${VIDEO_WIN_H})`);
    } catch (e) {
      logger.warn(`[ProfileManager] Không thể resize cửa sổ mới ${newWin.winId}: ${e.message}`);
    }
  } else {
    logger.warn(`[ProfileManager] ⚠️ Không tìm thấy winId mới sau khi bật Chrome cho ${profileDir}`);
  }

  // 5. Cập nhật trạng thái isActiveVideo trong chrome_profiles.json
  const state = getProfilesState();
  for (const p of state.profiles) {
    p.isActiveVideo = (p.profileDir === profileDir);
    if (p.isActiveVideo) {
      p.lastUsedAt = new Date().toISOString();
    }
  }
  saveState(state);

  // Chờ thêm 4s để trang Flow & Bulk AI Studio Pro load xong
  await new Promise(r => setTimeout(r, 4000));
  return state;
}

/**
 * Kiểm tra trước khi chạy Video: nếu profile đang active đã hết credit (< 10), tự động chuyển sang profile Video kế tiếp còn credit
 */
async function ensureActiveVideoProfileHasCredits() {
  const state = getProfilesState();
  let active = state.profiles.find(p => p.role === 'video' && p.isActiveVideo);

  if (active && active.credits >= 10) {
    return active;
  }

  // Tìm profile 'video' tiếp theo có credits >= 10
  const nextProfile = state.profiles.find(
    p => p.role === 'video' && p.credits >= 10 && (!active || p.profileDir !== active.profileDir)
  ) || state.profiles.find(p => p.role === 'video' && p.credits >= 10);

  if (!nextProfile) {
    logger.warn('[ProfileManager] ⚠️ Không còn Chrome Profile làm Video nào có đủ >= 10 credit!');
    return active || null;
  }

  if (!active || active.profileDir !== nextProfile.profileDir) {
    await switchVideoChromeWindow(nextProfile);
  }
  return nextProfile;
}

/**
 * Gọi sau mỗi khi 1 video hoàn thành:
 * - Trừ 10 credit của profile Video đang active
 * - Nếu sau khi trừ mà credits < 10 -> tự động tắt cửa sổ cũ và bật profile Video kế tiếp!
 */
async function deductVideoCreditAndRotateIfNeeded(cost = 10) {
  const state = getProfilesState();
  let active = state.profiles.find(p => p.role === 'video' && p.isActiveVideo)
            || state.profiles.find(p => p.role === 'video');

  if (!active) return null;

  const oldCredits = typeof active.credits === 'number' ? active.credits : 0;
  active.credits = Math.max(0, oldCredits - cost);
  active.lastUsedAt = new Date().toISOString();
  saveState(state);

  logger.info(`[ProfileManager] 💳 Đã trừ ${cost} credit của profile "${active.name}" (${active.profileDir}): ${oldCredits} → ${active.credits}`);

  if (active.credits < 10) {
    const nextCandidate = state.profiles.find(
      p => p.role === 'video' && p.profileDir !== active.profileDir && p.credits >= 10
    );
    if (nextCandidate) {
      logger.info(`[ProfileManager] 🔄 Profile "${active.name}" đã hết credit (${active.credits} < 10). Tự động chuyển sang "${nextCandidate.name}" (${nextCandidate.credits} credits)...`);
      try {
        await switchVideoChromeWindow(nextCandidate);
      } catch (err) {
        logger.error(`[ProfileManager] ❌ Lỗi tự động chuyển profile Video: ${err.message}`);
      }
    } else {
      logger.warn(`[ProfileManager] ⚠️ Profile "${active.name}" đã hết credit (${active.credits}), nhưng không còn profile Video dự phòng nào có >= 10 credit!`);
    }
  }

  return active;
}

/**
 * Cập nhật thông tin 1 hoặc nhiều profile từ Admin
 */
async function updateProfileConfig({ profileDir, role, credits, flowUrl, activateNow }) {
  const state = getProfilesState();
  const target = state.profiles.find(p => p.profileDir === profileDir);
  if (!target) {
    throw new Error(`Không tìm thấy profile: ${profileDir}`);
  }

  // Nếu chọn role === 'image', đảm bảo mỗi lần chỉ có 1 profile làm ảnh (hoặc giữ nguyên)
  if (role !== undefined) {
    if (role === 'image') {
      for (const p of state.profiles) {
        if (p.profileDir !== profileDir && p.role === 'image') {
          p.role = 'none';
        }
      }
    }
    target.role = role;
    if (role !== 'video' && target.isActiveVideo) {
      target.isActiveVideo = false;
    }
  }

  if (credits !== undefined && !Number.isNaN(Number(credits))) {
    target.credits = Math.max(0, Number(credits));
  }

  if (flowUrl !== undefined) {
    target.flowUrl = String(flowUrl).trim();
  }

  saveState(state);

  // Nếu bấm kích hoạt ngay hoặc chưa có profile video nào active
  if (activateNow && target.role === 'video') {
    return await switchVideoChromeWindow(target);
  }

  const hasActiveVideo = state.profiles.some(p => p.role === 'video' && p.isActiveVideo && p.credits >= 10);
  if (!hasActiveVideo) {
    const nextVideo = state.profiles.find(p => p.role === 'video' && p.credits >= 10);
    if (nextVideo) {
      return await switchVideoChromeWindow(nextVideo);
    }
  }

  return state;
}

module.exports = {
  scanChromeProfiles,
  getProfilesState,
  updateProfileConfig,
  switchVideoChromeWindow,
  ensureActiveVideoProfileHasCredits,
  deductVideoCreditAndRotateIfNeeded,
  getOpenChromeWindows
};
