const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { logger } = require('./utils');

const CHROME_MAIN_DIR = path.join(os.homedir(), '.config', 'google-chrome');
const CHROME_BOXES_DIR = path.join(os.homedir(), 'chrome_boxes');
const PROFILES_STATE_FILE = path.join(__dirname, '../chrome_profiles.json');

// Tọa độ chuẩn của cửa sổ Video (y hệt veo3_002 hiện tại)
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

// Khoá toàn cục khi đang chuyển đổi Chrome Box để các task video sau phải chờ mở xong & ready 100%
let _switchingPromise = null;

/**
 * Kiểm tra trên màn hình DISPLAY=:10 xem nút "CHẠY THỦ CÔNG" màu trắng sáng tại (180, 733) / (273, 720) đã hiện lên chưa
 */
function isFlowBulkToolReadyOnScreen() {
  try {
    const pyCode = [
      'import subprocess, sys',
      'from PIL import Image',
      'subprocess.run(["scrot", "-o", "/tmp/check_flow_ready.png"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
      'im = Image.open("/tmp/check_flow_ready.png").convert("RGB")',
      'pts = [(180, 733), (273, 720), (273, 742), (350, 733)]',
      'bright = sum(1 for (x, y) in pts if x < im.width and y < im.height and all(c > 190 for c in im.getpixel((x, y))))',
      'print("READY" if bright >= 2 else "WAIT")'
    ].join('; ');
    const out = execSync(`DISPLAY=:10 python3 -c '${pyCode}'`, { encoding: 'utf8', timeout: 4000 }).trim();
    return out === 'READY';
  } catch (_) {
    return false;
  }
}

// Cấu hình mặc định cho các profile ban đầu khi migrate sang thư mục độc lập
const LEGACY_MIGRATION_MAP = [
  {
    legacyDir: 'Profile 4',
    boxId: 'veo3_002',
    defaultName: 'veo3_002',
    role: 'video',
    credits: 500,
    isActiveVideo: true,
    flowUrl: 'https://flow.google.com/project/8c0a4f08-ba0c-43e6-8332-6a417df9bbf3/tool/0b32ee5f-3fde-4235-b517-05c3709f1304'
  },
  {
    legacyDir: 'Profile 3',
    boxId: 'veo3_001',
    defaultName: 'veo3_001',
    role: 'video',
    credits: 500,
    isActiveVideo: false,
    flowUrl: 'https://flow.google.com/project/fbfd51c4-824f-4861-b862-fb2835fffe7e'
  },
  {
    legacyDir: 'Default',
    boxId: 'lan',
    defaultName: 'Lan',
    role: 'none',
    credits: 500,
    isActiveVideo: false,
    flowUrl: 'https://flow.google.com/project/d2bcc79b-57c1-4e16-ad78-05d4806f76bf/tool/0b32ee5f-3fde-4235-b517-05c3709f1304'
  }
];

function ensureBoxesDir() {
  if (!fs.existsSync(CHROME_BOXES_DIR)) {
    fs.mkdirSync(CHROME_BOXES_DIR, { recursive: true });
  }
}

/**
 * Tự động tách các profile cũ (Profile 4, Profile 3, Default) sang thư mục độc lập ~/chrome_boxes/<boxId>
 * mà vẫn giữ nguyên toàn bộ Cookie / phiên đăng nhập Google và tạo Client ID riêng biệt cho từng box.
 */
function ensureInitialBoxesMigrated() {
  ensureBoxesDir();
  let mainLocalState = {};
  const mainLocalStatePath = path.join(CHROME_MAIN_DIR, 'Local State');
  try {
    if (fs.existsSync(mainLocalStatePath)) {
      mainLocalState = JSON.parse(fs.readFileSync(mainLocalStatePath, 'utf8'));
    }
  } catch (err) {
    logger.warn(`[ProfileManager] Không thể đọc main Local State để migrate: ${err.message}`);
  }

  const infoCache = mainLocalState?.profile?.info_cache || {};

  for (const item of LEGACY_MIGRATION_MAP) {
    const srcProfileDir = path.join(CHROME_MAIN_DIR, item.legacyDir);
    const destBoxDir = path.join(CHROME_BOXES_DIR, item.boxId);
    const destDefaultDir = path.join(destBoxDir, 'Default');

    if (fs.existsSync(destDefaultDir)) {
      continue; // Đã migrate rồi
    }
    if (!fs.existsSync(srcProfileDir)) {
      continue;
    }

    try {
      logger.info(`[ProfileManager] 📦 Đang tách "${item.defaultName}" (${item.legacyDir}) sang thư mục độc lập: ${destBoxDir}`);
      fs.mkdirSync(destBoxDir, { recursive: true });

      // Copy dữ liệu profile sang Default của box mới
      execSync(`cp -a "${srcProfileDir}" "${destDefaultDir}"`, { timeout: 15000 });

      // Xoá các file lock tạm nếu có
      for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'LOCK']) {
        try { fs.unlinkSync(path.join(destBoxDir, lockName)); } catch (_) {}
        try { fs.unlinkSync(path.join(destDefaultDir, lockName)); } catch (_) {}
      }

      // Tạo Local State độc lập với Client ID riêng biệt nhưng giữ nguyên os_crypt để giữ Cookie đăng nhập
      const meta = infoCache[item.legacyDir] || {
        name: item.defaultName,
        user_name: '',
        gaia_name: ''
      };

      const isolatedLocalState = {
        os_crypt: mainLocalState.os_crypt || {},
        user_experience_metrics: {
          client_id: crypto.randomUUID(),
          client_id_timestamp: String(Math.floor(Date.now() / 1000)),
          reporting_enabled: false
        },
        profile: {
          info_cache: {
            Default: {
              ...meta,
              name: meta.name || item.defaultName
            }
          },
          last_used: 'Default',
          last_active_profiles: ['Default']
        }
      };

      fs.writeFileSync(
        path.join(destBoxDir, 'Local State'),
        JSON.stringify(isolatedLocalState, null, 2),
        'utf8'
      );

      // Đặt sẵn tọa độ cửa sổ chuẩn 002 trong Default/Preferences
      enforceBoxWindowPlacement(destBoxDir);
      logger.success(`[ProfileManager] ✅ Đã tách thành công "${item.defaultName}" → ${destBoxDir}`);
    } catch (err) {
      logger.error(`[ProfileManager] ❌ Lỗi tách box ${item.boxId}: ${err.message}`);
    }
  }
}

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

function detectLastFlowUrlFromSessions(sessionsDir) {
  try {
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
 * Đọc thông tin email / tên từ 1 thư mục Chrome Box độc lập (~/chrome_boxes/<boxId>)
 */
function readBoxAccountInfo(boxDir, boxId) {
  let name = boxId;
  let email = '';
  let gaiaName = '';

  const isGenericName = (n) => !n || ['Person 1', 'Bạn', 'Your Chrome', 'Default'].includes(String(n).trim());

  // 1. Đọc từ Local State của box
  const lsPath = path.join(boxDir, 'Local State');
  try {
    if (fs.existsSync(lsPath)) {
      const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
      const defInfo = ls?.profile?.info_cache?.Default || {};
      if (!isGenericName(defInfo.name)) {
        name = defInfo.name;
      }
      email = defInfo.user_name || '';
      gaiaName = defInfo.gaia_name || '';
    }
  } catch (_) {}

  // 2. Đọc bổ sung từ Default/Preferences (account_info) nếu user vừa mới đăng nhập xong
  const prefPath = path.join(boxDir, 'Default', 'Preferences');
  try {
    if (fs.existsSync(prefPath)) {
      const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      const accList = pref?.account_info || [];
      if (Array.isArray(accList) && accList.length > 0) {
        const acc = accList[0];
        if (!email && acc.email) email = acc.email;
        if (!gaiaName && acc.full_name) gaiaName = acc.full_name;
      }
      const profName = pref?.profile?.name;
      if (name === boxId && !isGenericName(profName)) {
        name = profName;
      }
    }
  } catch (_) {}

  return { name, email, gaiaName };
}

/**
 * Quét danh sách tất cả các Chrome Box độc lập trong ~/chrome_boxes/*
 * + giữ lại Profile 6 (Thi Hang - Làm Ảnh) đang chạy cố định
 */
function scanChromeProfiles() {
  ensureInitialBoxesMigrated();

  const existingState = loadSavedState();
  const existingMap = new Map();
  if (existingState && Array.isArray(existingState.profiles)) {
    for (const p of existingState.profiles) {
      existingMap.set(p.profileDir, p);
      // Hỗ trợ map từ tên cũ nếu vừa chuyển từ Profile 4 -> veo3_002
      if (p.profileDir === 'Profile 4') existingMap.set('veo3_002', p);
      if (p.profileDir === 'Profile 3') existingMap.set('veo3_001', p);
      if (p.profileDir === 'Default') existingMap.set('lan', p);
    }
  }

  const profiles = [];

  // 1. Quét tất cả thư mục trong ~/chrome_boxes
  const entries = fs.readdirSync(CHROME_BOXES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const boxId = entry.name;
    const boxDir = path.join(CHROME_BOXES_DIR, boxId);
    const prev = existingMap.get(boxId);
    const seed = LEGACY_MIGRATION_MAP.find(m => m.boxId === boxId) || {};

    const info = readBoxAccountInfo(boxDir, seed.defaultName || prev?.name || boxId);
    const detectedUrl = detectLastFlowUrlFromSessions(path.join(boxDir, 'Default', 'Sessions'));
    const flowUrl = (prev?.flowUrl !== undefined && prev.flowUrl !== '')
      ? prev.flowUrl
      : (seed.flowUrl || detectedUrl || 'https://flow.google.com/');

    profiles.push({
      profileDir: boxId,
      userDataDir: boxDir,
      isIsolatedBox: true,
      name: prev?.customName || info.name || boxId,
      email: info.email || prev?.email || '',
      gaiaName: info.gaiaName || prev?.gaiaName || '',
      role: prev?.role || seed.role || 'video',
      credits: typeof prev?.credits === 'number' ? prev.credits : (typeof seed.credits === 'number' ? seed.credits : 500),
      flowUrl,
      isActiveVideo: Boolean(prev ? prev.isActiveVideo : seed.isActiveVideo),
      lastUsedAt: prev?.lastUsedAt || null
    });
  }

  // 2. Giữ Profile 6 (Làm Ảnh cố định) từ ~/.config/google-chrome/Profile 6
  const imgProfDir = path.join(CHROME_MAIN_DIR, 'Profile 6');
  if (fs.existsSync(imgProfDir)) {
    let imgMeta = { name: 'Thi Hang', user_name: 'thihangvan1521@gmail.com', gaia_name: 'Thi Hang Van' };
    try {
      const ls = JSON.parse(fs.readFileSync(path.join(CHROME_MAIN_DIR, 'Local State'), 'utf8'));
      if (ls?.profile?.info_cache?.['Profile 6']) {
        imgMeta = ls.profile.info_cache['Profile 6'];
      }
    } catch (_) {}

    const prevImg = existingMap.get('Profile 6');
    profiles.push({
      profileDir: 'Profile 6',
      userDataDir: CHROME_MAIN_DIR,
      isIsolatedBox: false,
      name: imgMeta.name || 'Thi Hang',
      email: imgMeta.user_name || '',
      gaiaName: imgMeta.gaia_name || '',
      role: prevImg?.role || 'image',
      credits: typeof prevImg?.credits === 'number' ? prevImg.credits : 500,
      flowUrl: prevImg?.flowUrl || 'https://flow.google.com/project/4a4d000c-94ca-435d-911d-36d060f55222',
      isActiveVideo: false,
      lastUsedAt: prevImg?.lastUsedAt || null
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
  ensureInitialBoxesMigrated();
  const saved = loadSavedState();
  if (saved && Array.isArray(saved.profiles) && saved.profiles.length > 0 && saved.profiles.some(p => p.isIsolatedBox)) {
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
 * Ghi cấu hình vị trí cửa sổ chuẩn của 002 vào Default/Preferences của Chrome Box
 */
function enforceBoxWindowPlacement(boxDir) {
  try {
    const defaultDir = path.join(boxDir, 'Default');
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    const prefPath = path.join(defaultDir, 'Preferences');
    let pref = {};
    if (fs.existsSync(prefPath)) {
      try {
        pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      } catch (_) {
        pref = {};
      }
    }
    if (!pref.browser) pref.browser = {};
    pref.browser.window_placement = { ...VIDEO_WINDOW_PLACEMENT };
    if (!pref.download) pref.download = {};
    pref.download.default_directory = path.join(os.homedir(), 'Downloads');
    pref.download.prompt_for_download = false;
    fs.writeFileSync(prefPath, JSON.stringify(pref), 'utf8');
  } catch (err) {
    logger.warn(`[ProfileManager] Không thể ghi window_placement cho ${boxDir}: ${err.message}`);
  }
}

/**
 * Đóng mọi cửa sổ Video bên trái (x < 250) + tắt tiến trình của các Chrome Box cũ trong ~/chrome_boxes/
 * (Tuyệt đối KHÔNG đụng vào tiến trình ~/.config/google-chrome của nick Làm Ảnh bên phải!)
 * Sau đó bật Chrome Box mới với --user-data-dir riêng tại đúng vị trí 002 (-4, 27, 508x906)
 */
async function switchVideoChromeWindow(targetProfile) {
  if (_switchingPromise) {
    try { await _switchingPromise; } catch (_) {}
  }
  _switchingPromise = _doSwitchVideoChromeWindow(targetProfile);
  try {
    return await _switchingPromise;
  } finally {
    _switchingPromise = null;
  }
}

async function _doSwitchVideoChromeWindow(targetProfile) {
  if (!targetProfile || !targetProfile.profileDir) {
    throw new Error('Target profile không hợp lệ');
  }

  const boxId = targetProfile.profileDir;
  const boxDir = targetProfile.userDataDir || path.join(CHROME_BOXES_DIR, boxId);
  const flowUrl = (targetProfile.flowUrl || 'https://flow.google.com/').trim();

  logger.info(`[ProfileManager] 🔄 Đang chuyển sang Chrome Box độc lập "${targetProfile.name}" (${boxDir}) → ${flowUrl}`);

  // 1. Đóng cửa sổ Chrome bên trái (x < 250) nếu đang mở
  const beforeWins = getOpenChromeWindows();
  const imageWinIds = new Set();

  for (const win of beforeWins) {
    if (win.x < 250) {
      try {
        logger.info(`[ProfileManager] 🗑️ Đóng cửa sổ Video cũ: ${win.winId} (${win.title}) tại x=${win.x}, y=${win.y}`);
        execSync(`DISPLAY=:10 wmctrl -ic ${win.winId}`, { timeout: 3000 });
      } catch (_) {}
    } else {
      imageWinIds.add(win.winId);
    }
  }

  // 2. Tắt sạch các tiến trình Chrome thuộc ~/chrome_boxes/ (đảm bảo không còn box cũ chạy ngầm)
  try {
    execSync(`pkill -f "${CHROME_BOXES_DIR}/" 2>/dev/null || true`, { timeout: 3000 });
  } catch (_) {}

  await new Promise(r => setTimeout(r, 1500));

  // 3. Xoá lock file cũ và ép vị trí cửa sổ chuẩn 002
  for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(boxDir, lockName)); } catch (_) {}
  }
  enforceBoxWindowPlacement(boxDir);

  // 4. Khởi chạy Chrome với --user-data-dir độc lập hoàn toàn
  const args = [
    `--user-data-dir=${boxDir}`,
    '--no-first-run',
    '--no-default-browser-check',
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

  // 5. Chờ cửa sổ mới xuất hiện và đặt chính xác vào (-4, 27, 508x906)
  let newWin = null;
  for (let i = 0; i < 18; i++) {
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
      logger.success(`[ProfileManager] ✅ Đã mở Chrome Box "${targetProfile.name}" (${newWin.winId}) tại đúng vị trí 002 (${VIDEO_WIN_X}, ${VIDEO_WIN_Y}, ${VIDEO_WIN_W}x${VIDEO_WIN_H})`);
    } catch (e) {
      logger.warn(`[ProfileManager] Không thể resize cửa sổ mới ${newWin.winId}: ${e.message}`);
    }
  } else {
    logger.warn(`[ProfileManager] ⚠️ Không tìm thấy winId mới sau khi bật Chrome Box ${boxId}`);
  }

  // 6. Cập nhật trạng thái isActiveVideo
  const state = getProfilesState();
  for (const p of state.profiles) {
    p.isActiveVideo = (p.profileDir === boxId);
    if (p.isActiveVideo) {
      p.lastUsedAt = new Date().toISOString();
    }
  }
  saveState(state);

  // 7. Chờ giao diện Flow & nút "CHẠY THỦ CÔNG" thật sự hiển thị READY trên màn hình (tối đa 35s)
  logger.info(`[ProfileManager] ⏳ Đang chờ giao diện Flow Tool của "${targetProfile.name}" tải xong (READY)...`);
  let ready = false;
  for (let attempt = 1; attempt <= 24; attempt++) {
    await new Promise(r => setTimeout(r, 1500));
    if (isFlowBulkToolReadyOnScreen()) {
      ready = true;
      logger.success(`[ProfileManager] 🎉 Giao diện Flow Tool của "${targetProfile.name}" đã READY (sau ${attempt * 1.5}s)!`);
      break;
    }
  }
  if (!ready) {
    logger.warn(`[ProfileManager] ⚠️ Đã chờ 36s nhưng chưa thấy nút CHẠY THỦ CÔNG sáng lên, tiếp tục...`);
  } else {
    await new Promise(r => setTimeout(r, 1500));
  }
  return state;
}

/**
 * Tạo 1 Chrome Box độc lập mới tinh (~/chrome_boxes/<boxId>) với Client ID riêng
 */
async function createChromeBox({ name, credits = 500, role = 'video', flowUrl = 'https://flow.google.com/', openNow = true }) {
  ensureBoxesDir();
  const cleanName = String(name || '').trim() || `veo3_${Date.now().toString().slice(-3)}`;
  const boxId = cleanName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || `box_${Date.now()}`;

  const boxDir = path.join(CHROME_BOXES_DIR, boxId);
  const defaultDir = path.join(boxDir, 'Default');

  if (fs.existsSync(boxDir)) {
    throw new Error(`Thư mục Chrome Box "${boxId}" đã tồn tại!`);
  }

  fs.mkdirSync(defaultDir, { recursive: true });

  // Tạo Local State độc lập với Client ID mới hoàn toàn
  const isolatedLocalState = {
    user_experience_metrics: {
      client_id: crypto.randomUUID(),
      client_id_timestamp: String(Math.floor(Date.now() / 1000)),
      reporting_enabled: false
    },
    profile: {
      info_cache: {
        Default: {
          name: cleanName,
          user_name: '',
          gaia_name: ''
        }
      },
      last_used: 'Default',
      last_active_profiles: ['Default']
    }
  };

  fs.writeFileSync(path.join(boxDir, 'Local State'), JSON.stringify(isolatedLocalState, null, 2), 'utf8');
  enforceBoxWindowPlacement(boxDir);

  const state = getProfilesState();
  const newProfile = {
    profileDir: boxId,
    userDataDir: boxDir,
    isIsolatedBox: true,
    name: cleanName,
    customName: cleanName,
    email: '',
    gaiaName: '',
    role: role || 'video',
    credits: Number(credits) || 500,
    flowUrl: String(flowUrl || 'https://flow.google.com/').trim(),
    isActiveVideo: false,
    lastUsedAt: null
  };

  state.profiles.push(newProfile);
  saveState(state);

  if (openNow && newProfile.role === 'video') {
    return await switchVideoChromeWindow(newProfile);
  }
  return state;
}

async function ensureActiveVideoProfileHasCredits() {
  // Nếu đang trong quá trình chuyển đổi Chrome Box thì bắt buộc chờ chuyển & load trang READY xong
  if (_switchingPromise) {
    logger.info('[ProfileManager] ⏳ Đang chờ quá trình chuyển đổi Chrome Box hoàn tất...');
    try { await _switchingPromise; } catch (_) {}
  }

  const state = getProfilesState();
  let active = state.profiles.find(p => p.role === 'video' && p.isActiveVideo);

  if (active && active.credits >= 10) {
    return active;
  }

  const nextProfile = state.profiles.find(
    p => p.role === 'video' && p.credits >= 10 && (!active || p.profileDir !== active.profileDir)
  ) || state.profiles.find(p => p.role === 'video' && p.credits >= 10);

  if (!nextProfile) {
    logger.warn('[ProfileManager] ⚠️ Không còn Chrome Box làm Video nào có đủ >= 10 credit!');
    return active || null;
  }

  if (!active || active.profileDir !== nextProfile.profileDir) {
    await switchVideoChromeWindow(nextProfile);
  }
  return nextProfile;
}

async function deductVideoCreditAndRotateIfNeeded(cost = 10) {
  const state = getProfilesState();
  let active = state.profiles.find(p => p.role === 'video' && p.isActiveVideo)
            || state.profiles.find(p => p.role === 'video');

  if (!active) return null;

  const oldCredits = typeof active.credits === 'number' ? active.credits : 0;
  active.credits = Math.max(0, oldCredits - cost);
  active.lastUsedAt = new Date().toISOString();
  saveState(state);

  logger.info(`[ProfileManager] 💳 Đã trừ ${cost} credit của Chrome Box "${active.name}" (${active.profileDir}): ${oldCredits} → ${active.credits}`);

  if (active.credits < 10) {
    const nextCandidate = state.profiles.find(
      p => p.role === 'video' && p.profileDir !== active.profileDir && p.credits >= 10
    );
    if (nextCandidate) {
      logger.info(`[ProfileManager] 🔄 Chrome Box "${active.name}" đã hết credit (${active.credits} < 10). Tự động chuyển sang "${nextCandidate.name}" (${nextCandidate.credits} credits)...`);
      try {
        await switchVideoChromeWindow(nextCandidate);
      } catch (err) {
        logger.error(`[ProfileManager] ❌ Lỗi tự động chuyển Chrome Box Video: ${err.message}`);
      }
    } else {
      logger.warn(`[ProfileManager] ⚠️ Chrome Box "${active.name}" đã hết credit (${active.credits}), nhưng không còn Chrome Box Video dự phòng nào có >= 10 credit!`);
    }
  }

  return active;
}

async function updateProfileConfig({ profileDir, role, credits, flowUrl, activateNow }) {
  const state = getProfilesState();
  const target = state.profiles.find(p => p.profileDir === profileDir);
  if (!target) {
    throw new Error(`Không tìm thấy profile: ${profileDir}`);
  }

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
  createChromeBox,
  switchVideoChromeWindow,
  ensureActiveVideoProfileHasCredits,
  deductVideoCreditAndRotateIfNeeded,
  getOpenChromeWindows
};
