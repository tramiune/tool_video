const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { logger } = require('./utils');

const CHROME_MAIN_DIR = path.join(os.homedir(), '.config', 'google-chrome');
const CHROME_BOXES_DIR = path.join(os.homedir(), 'chrome_boxes');
const PROFILES_STATE_FILE = path.join(__dirname, '../chrome_profiles.json');

// ── Cấu hình Proxy Xoay cho Chrome Box Làm Video (Đã tắt theo yêu cầu) ──────────
const LOCAL_PROXY_HOST = '127.0.0.1';
const LOCAL_PROXY_PORT = 18888;
const VIDEO_PROXY_CONFIG = {
  enabled: false,
  resourceId: 'TC15489_51980',
  host: 'vnr-tc15489-51980.thuecloud.com',
  fallbackHost: '117.1.88.26',
  port: 20377,
  socks5Port: 24550,
  username: 'hmzeb_trade',
  password: 'g1VymWN6',
  apiKey: 'j2h015f3tcw540f3da8dfb067591228859b147e3da77735dc9f58d1',
  rotateUrl: 'https://api.thuecloud.com/getip/9250d6c3c62c09f45e8ffcc2989af94c7b1bfafb',
  cooldownSeconds: 240
};

let _localProxyServer = null;
let _proxyRuntimeState = {
  currentIp: '',
  lastRotatedAt: 0,
  nextRotateAllowedAt: 0,
  lastRotatedForBox: ''
};

function getProxyAuthHeader() {
  const token = Buffer.from(`${VIDEO_PROXY_CONFIG.username}:${VIDEO_PROXY_CONFIG.password}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Khởi chạy Local Proxy Forwarder tại 127.0.0.1:18888
 * Tự động gắn Proxy-Authorization Basic Auth vào mọi kết nối HTTPS CONNECT & HTTP
 * để Chrome Video không bao giờ hiện popup hỏi tài khoản/mật khẩu proxy.
 */
function ensureLocalProxyServer() {
  if (_localProxyServer) {
    return Promise.resolve(_localProxyServer);
  }

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const authHeader = getProxyAuthHeader();
      const options = {
        host: VIDEO_PROXY_CONFIG.host,
        port: VIDEO_PROXY_CONFIG.port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          'Proxy-Authorization': authHeader
        }
      };

      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', () => {
        try {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Proxy Bad Gateway');
        } catch (_) {}
      });

      req.pipe(proxyReq);
    });

    server.on('connect', (req, clientSocket, head) => {
      clientSocket.on('error', () => {});
      clientSocket.setNoDelay(true);

      const authHeader = getProxyAuthHeader();
      const targetUrl = req.url;

      const connectUpstream = (hostToUse, isRetry = false) => {
        const proxySocket = net.connect(VIDEO_PROXY_CONFIG.port, hostToUse);
        let settled = false;

        proxySocket.setNoDelay(true);
        proxySocket.setTimeout(15000);

        const cleanupOnFail = () => {
          if (settled) return;
          settled = true;
          try { proxySocket.destroy(); } catch (_) {}
          if (!isRetry) {
            setTimeout(() => connectUpstream(VIDEO_PROXY_CONFIG.fallbackHost, true), 600);
          } else {
            try {
              clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
              clientSocket.destroy();
            } catch (_) {}
          }
        };

        proxySocket.on('error', cleanupOnFail);
        proxySocket.on('timeout', cleanupOnFail);

        proxySocket.on('connect', () => {
          const connectMsg =
            `CONNECT ${targetUrl} HTTP/1.1\r\n` +
            `Host: ${targetUrl}\r\n` +
            `Proxy-Authorization: ${authHeader}\r\n` +
            `Proxy-Connection: keep-alive\r\n\r\n`;
          proxySocket.write(connectMsg);
        });

        let headerBuf = Buffer.alloc(0);
        const onData = (chunk) => {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const endIdx = headerBuf.indexOf('\r\n\r\n');
          if (endIdx === -1) return;

          proxySocket.removeListener('data', onData);
          proxySocket.setTimeout(0);
          settled = true;

          const statusLine = (headerBuf.slice(0, endIdx).toString('latin1').split('\r\n')[0] || '');
          if (statusLine.includes(' 200 ')) {
            try {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              const leftover = headerBuf.slice(endIdx + 4);
              if (leftover.length > 0) clientSocket.write(leftover);
              if (head && head.length > 0) proxySocket.write(head);
              proxySocket.pipe(clientSocket);
              clientSocket.pipe(proxySocket);
            } catch (_) {
              try { proxySocket.destroy(); } catch (_) {}
              try { clientSocket.destroy(); } catch (_) {}
            }
          } else {
            try { proxySocket.destroy(); } catch (_) {}
            if (!isRetry) {
              setTimeout(() => connectUpstream(VIDEO_PROXY_CONFIG.fallbackHost, true), 800);
            } else {
              try {
                clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                clientSocket.destroy();
              } catch (_) {}
            }
          }
        };

        proxySocket.on('data', onData);
      };

      connectUpstream(VIDEO_PROXY_CONFIG.host, false);
    });

    server.on('error', (err) => {
      logger.warn(`[VideoProxy] Local proxy forwarder error (${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}): ${err.message}`);
      resolve(null);
    });

    server.listen(LOCAL_PROXY_PORT, LOCAL_PROXY_HOST, () => {
      _localProxyServer = server;
      logger.success(`[VideoProxy] 🌐 Local Proxy Forwarder đã sẵn sàng tại http://${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT} → ${VIDEO_PROXY_CONFIG.host}:${VIDEO_PROXY_CONFIG.port}`);
      resolve(server);
    });
  });
}

function fetchJsonUrl(urlStr, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString('utf8'); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          resolve({ raw: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

function checkCurrentProxyIp() {
  try {
    const authUrl = `http://${VIDEO_PROXY_CONFIG.username}:${VIDEO_PROXY_CONFIG.password}@${VIDEO_PROXY_CONFIG.host}:${VIDEO_PROXY_CONFIG.port}`;
    const out = execSync(`curl -s --max-time 6 -x "${authUrl}" "https://api.ipify.org?format=json"`, {
      encoding: 'utf8',
      timeout: 7500
    }).trim();
    const parsed = JSON.parse(out);
    if (parsed && parsed.ip) {
      _proxyRuntimeState.currentIp = parsed.ip;
      return parsed.ip;
    }
  } catch (_) {}
  return '';
}

async function waitForProxyReadyAndGetIp(maxAttempts = 6) {
  for (let i = 1; i <= maxAttempts; i++) {
    const ip = checkCurrentProxyIp();
    if (ip) return ip;
    await new Promise(r => setTimeout(r, 1800));
  }
  return _proxyRuntimeState.currentIp || '';
}

/**
 * Xoay IP Proxy trước khi mở Chrome Box làm Video.
 * Tự động tuân thủ thời gian chờ 240s của ThueCloud để tuyệt đối không bị khoá tài khoản vì spam.
 */
async function rotateVideoProxyIp(boxId = '') {
  if (!VIDEO_PROXY_CONFIG.enabled) {
    return { rotated: false, ip: '' };
  }

  await ensureLocalProxyServer();

  // Đọc trạng thái cooldown đã lưu từ chrome_profiles.json nếu vừa khởi động lại server
  try {
    const saved = loadSavedState();
    if (saved && saved.proxyState) {
      if (saved.proxyState.nextRotateAllowedAt > _proxyRuntimeState.nextRotateAllowedAt) {
        _proxyRuntimeState.nextRotateAllowedAt = saved.proxyState.nextRotateAllowedAt;
      }
      if (saved.proxyState.lastRotatedAt > _proxyRuntimeState.lastRotatedAt) {
        _proxyRuntimeState.lastRotatedAt = saved.proxyState.lastRotatedAt;
      }
      if (!_proxyRuntimeState.currentIp && saved.proxyState.currentIp) {
        _proxyRuntimeState.currentIp = saved.proxyState.currentIp;
      }
    }
  } catch (_) {}

  const now = Date.now();
  if (now < _proxyRuntimeState.nextRotateAllowedAt) {
    const remainSec = Math.ceil((_proxyRuntimeState.nextRotateAllowedAt - now) / 1000);
    if (remainSec <= 12) {
      logger.info(`[VideoProxy] ⏳ Chờ nốt ${remainSec}s cooldown để xoay IP mới cho "${boxId}"...`);
      await new Promise(r => setTimeout(r, (remainSec + 1) * 1000));
    } else {
      const currentIp = await waitForProxyReadyAndGetIp(2);
      logger.info(`[VideoProxy] 🛡️ Proxy vừa xoay IP gần đây (còn ${remainSec}s cooldown chống spam ThueCloud). Dùng IP Proxy hiện tại: ${currentIp || 'đang kết nối'} cho "${boxId}"`);
      return { rotated: false, ip: currentIp, cooldownRemainingSec: remainSec };
    }
  }

  try {
    logger.info(`[VideoProxy] 🔄 Đang gọi API xoay IP Proxy ThueCloud cho Chrome Box "${boxId}"...`);
    const res = await fetchJsonUrl(VIDEO_PROXY_CONFIG.rotateUrl, 12000);

    if (res && res.proxy) {
      if (res.proxy.portHttp) VIDEO_PROXY_CONFIG.port = Number(res.proxy.portHttp) || VIDEO_PROXY_CONFIG.port;
      if (res.proxy.username) VIDEO_PROXY_CONFIG.username = res.proxy.username;
      if (res.proxy.password) VIDEO_PROXY_CONFIG.password = res.proxy.password;
      if (res.proxy.hostIp) VIDEO_PROXY_CONFIG.fallbackHost = res.proxy.hostIp;
    }

    if (res && (res.status === 'success' || res.statusCode === 200)) {
      const cooldownSec = Number(res?.proxy?.timeChangeAllowInSeconds) || VIDEO_PROXY_CONFIG.cooldownSeconds || 240;
      _proxyRuntimeState.lastRotatedAt = Date.now();
      _proxyRuntimeState.nextRotateAllowedAt = Date.now() + (cooldownSec + 3) * 1000;
      _proxyRuntimeState.lastRotatedForBox = boxId;

      // Sau khi gọi đổi IP thành công, đợi mạng PPPoE của proxy kết nối lại (khoảng 3-6s) rồi lấy IP mới
      await new Promise(r => setTimeout(r, 3000));
      const newIp = await waitForProxyReadyAndGetIp(6);
      logger.success(`[VideoProxy] ✅ Đổi IP Proxy thành công cho "${boxId}" → IP mới: ${newIp || 'OK'} (${res.message || ''})`);
      return { rotated: true, ip: newIp, cooldownRemainingSec: cooldownSec };
    }

    // Nếu nhà mạng báo cần đợi thêm X giây
    const errMsg = String(res?.error || res?.message || '');
    const waitMatch = errMsg.match(/đợi\s+(\d+)\s+giây/i);
    if (waitMatch) {
      const waitSec = parseInt(waitMatch[1], 10);
      _proxyRuntimeState.nextRotateAllowedAt = Date.now() + (waitSec + 3) * 1000;

      if (waitSec <= 12) {
        logger.info(`[VideoProxy] ⏳ Đợi nốt ${waitSec}s theo yêu cầu ThueCloud rồi xoay IP...`);
        await new Promise(r => setTimeout(r, (waitSec + 2) * 1000));
        const retryRes = await fetchJsonUrl(VIDEO_PROXY_CONFIG.rotateUrl, 12000);
        if (retryRes && (retryRes.status === 'success' || retryRes.statusCode === 200)) {
          const cd = Number(retryRes?.proxy?.timeChangeAllowInSeconds) || 240;
          _proxyRuntimeState.lastRotatedAt = Date.now();
          _proxyRuntimeState.nextRotateAllowedAt = Date.now() + (cd + 3) * 1000;
          _proxyRuntimeState.lastRotatedForBox = boxId;
          await new Promise(r => setTimeout(r, 3000));
          const newIp = await waitForProxyReadyAndGetIp(6);
          logger.success(`[VideoProxy] ✅ Đổi IP Proxy thành công cho "${boxId}" → IP mới: ${newIp || 'OK'}`);
          return { rotated: true, ip: newIp, cooldownRemainingSec: cd };
        }
      }

      const currentIp = await waitForProxyReadyAndGetIp(2);
      logger.info(`[VideoProxy] ⏳ Proxy đang trong thời gian chờ ${waitSec}s của ThueCloud, dùng IP Proxy hiện tại: ${currentIp || 'OK'}`);
      return { rotated: false, ip: currentIp, cooldownRemainingSec: waitSec };
    }

    const fallbackIp = await waitForProxyReadyAndGetIp(2);
    logger.warn(`[VideoProxy] ⚠️ Phản hồi xoay IP: ${JSON.stringify(res).slice(0, 200)} | IP hiện tại: ${fallbackIp}`);
    return { rotated: false, ip: fallbackIp };
  } catch (err) {
    const fallbackIp = await waitForProxyReadyAndGetIp(2);
    logger.warn(`[VideoProxy] ⚠️ Không thể gọi API xoay IP (${err.message}), dùng IP Proxy hiện tại: ${fallbackIp}`);
    return { rotated: false, ip: fallbackIp };
  }
}

// Chỉ khởi động Local Proxy Forwarder nếu bật VIDEO_PROXY_CONFIG.enabled
if (VIDEO_PROXY_CONFIG.enabled) {
  ensureLocalProxyServer().catch(() => {});
}

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
 * Tự động phát hiện màn hình XRDP đang hoạt động (:10, :11, ...)
 */
function getActiveDisplay() {
  try {
    const sockDir = '/run/xrdp/sockdir';
    if (fs.existsSync(sockDir)) {
      const files = fs.readdirSync(sockDir);
      const dispNums = files
        .map(f => {
          const m = f.match(/^xrdp_display_(\d+)$/);
          return m ? parseInt(m[1], 10) : null;
        })
        .filter(n => n !== null)
        .sort((a, b) => b - a);
      if (dispNums.length > 0) {
        return `:${dispNums[0]}`;
      }
    }
    const x11Dir = '/tmp/.X11-unix';
    if (fs.existsSync(x11Dir)) {
      const files = fs.readdirSync(x11Dir);
      const dispNums = files
        .map(f => {
          const m = f.match(/^X(\d+)$/);
          return m ? parseInt(m[1], 10) : null;
        })
        .filter(n => n !== null && n >= 10)
        .sort((a, b) => b - a);
      if (dispNums.length > 0) {
        return `:${dispNums[0]}`;
      }
    }
  } catch (_) {}
  return ':10';
}

/**
 * Kiểm tra trên màn hình XRDP đang hoạt động xem nút "CHẠY THỦ CÔNG" màu trắng sáng tại (180, 733) / (273, 720) đã hiện lên chưa
 */
function isFlowBulkToolReadyOnScreen() {
  try {
    const disp = getActiveDisplay();
    const pyCode = [
      'import subprocess, sys',
      'from PIL import Image',
      'subprocess.run(["scrot", "-o", "/tmp/check_flow_ready.png"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
      'im = Image.open("/tmp/check_flow_ready.png").convert("RGB")',
      'pts = [(180, 733), (273, 720), (273, 742), (350, 733)]',
      'bright = sum(1 for (x, y) in pts if x < im.width and y < im.height and all(c > 190 for c in im.getpixel((x, y))))',
      'print("READY" if bright >= 2 else "WAIT")'
    ].join('; ');
    const out = execSync(`DISPLAY=${disp} python3 -c '${pyCode}'`, { encoding: 'utf8', timeout: 4000 }).trim();
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
  const migratedMarker = path.join(CHROME_BOXES_DIR, '.migrated_done');
  if (fs.existsSync(migratedMarker)) {
    return;
  }
  const saved = loadSavedState();
  const deletedSet = new Set(Array.isArray(saved?.deletedBoxes) ? saved.deletedBoxes : []);

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
    if (deletedSet.has(item.boxId)) {
      continue;
    }
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
      proxyIp: prev?.proxyIp || '',
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
    deletedBoxes: Array.isArray(existingState?.deletedBoxes) ? existingState.deletedBoxes : [],
    proxyState: {
      ...(existingState?.proxyState || {}),
      ..._proxyRuntimeState,
      currentIp: _proxyRuntimeState.currentIp || existingState?.proxyState?.currentIp || '',
      resourceId: VIDEO_PROXY_CONFIG.resourceId,
      host: VIDEO_PROXY_CONFIG.host,
      port: VIDEO_PROXY_CONFIG.port
    },
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
 * Lấy danh sách cửa sổ Chrome đang mở trên màn hình XRDP đang hoạt động
 */
function getOpenChromeWindows() {
  try {
    const disp = getActiveDisplay();
    const out = execSync(`DISPLAY=${disp} wmctrl -lG`, { encoding: 'utf8', timeout: 3000 });
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

  const disp = getActiveDisplay();
  const boxId = targetProfile.profileDir;
  const boxDir = targetProfile.userDataDir || path.join(CHROME_BOXES_DIR, boxId);
  const flowUrl = (targetProfile.flowUrl || 'https://flow.google.com/').trim();

  logger.info(`[ProfileManager] 🔄 Đang chuyển sang Chrome Box độc lập "${targetProfile.name}" (${boxDir}) trên DISPLAY=${disp} → ${flowUrl}`);

  // 1. Đóng cửa sổ Chrome bên trái (x < 250) nếu đang mở
  const beforeWins = getOpenChromeWindows();
  const imageWinIds = new Set();

  for (const win of beforeWins) {
    if (win.x < 250) {
      try {
        logger.info(`[ProfileManager] 🗑️ Đóng cửa sổ Video cũ: ${win.winId} (${win.title}) tại x=${win.x}, y=${win.y}`);
        execSync(`DISPLAY=${disp} wmctrl -ic ${win.winId}`, { timeout: 3000 });
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

  // 3.5. Xoay IP Proxy ThueCloud & đảm bảo Local Proxy Forwarder (127.0.0.1:18888) đang chạy
  const proxyResult = await rotateVideoProxyIp(boxId);

  // 4. Khởi chạy Chrome với --user-data-dir độc lập + Proxy Xoay + cờ tối ưu chống lag trên VPS
  const args = [
    `--user-data-dir=${boxDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-smooth-scrolling',
    '--wm-window-animations-disabled',
    '--animation-duration-scale=0',
    '--disable-gpu-vsync',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    `--window-position=${VIDEO_WIN_X},${VIDEO_WIN_Y}`,
    `--window-size=${VIDEO_WIN_W},${VIDEO_WIN_H}`
  ];

  if (VIDEO_PROXY_CONFIG.enabled) {
    args.push(`--proxy-server=http://${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}`);
    args.push('--proxy-bypass-list=127.0.0.1;localhost;<local>');
  }

  args.push(flowUrl);

  // Dùng double-fork qua sh -c "... &" + setsid để Chrome được gán PPID = 1 (systemd)
  // Nhờ đó khi pm2 restart veo3-server, PM2 treekill sẽ KHÔNG BAO GIỜ tắt cửa sổ Chrome Video!
  const escapedArgs = args.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  execSync(`DISPLAY=${disp} sh -c "setsid /opt/google/chrome/chrome ${escapedArgs} >/dev/null 2>&1 < /dev/null &"`, {
    env: { ...process.env, DISPLAY: disp },
    timeout: 5000
  });

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
      execSync(`DISPLAY=${disp} wmctrl -ir ${newWin.winId} -b remove,maximized_vert,maximized_horz`, { timeout: 3000 });
      execSync(`DISPLAY=${disp} wmctrl -ir ${newWin.winId} -e 0,${VIDEO_WIN_X},${VIDEO_WIN_Y},${VIDEO_WIN_W},${VIDEO_WIN_H}`, { timeout: 3000 });
      execSync(`DISPLAY=${disp} xdotool windowActivate ${newWin.winId}`, { timeout: 3000 });
      logger.success(`[ProfileManager] ✅ Đã mở Chrome Box "${targetProfile.name}" (${newWin.winId}) qua Proxy IP ${proxyResult.ip || _proxyRuntimeState.currentIp || 'Active'} tại đúng vị trí 002 (${VIDEO_WIN_X}, ${VIDEO_WIN_Y}, ${VIDEO_WIN_W}x${VIDEO_WIN_H})`);
    } catch (e) {
      logger.warn(`[ProfileManager] Không thể resize cửa sổ mới ${newWin.winId}: ${e.message}`);
    }
  } else {
    logger.warn(`[ProfileManager] ⚠️ Không tìm thấy winId mới sau khi bật Chrome Box ${boxId}`);
  }

  // 6. Cập nhật trạng thái isActiveVideo & IP Proxy hiện tại
  const state = getProfilesState();
  for (const p of state.profiles) {
    p.isActiveVideo = (p.profileDir === boxId);
    if (p.isActiveVideo) {
      p.lastUsedAt = new Date().toISOString();
      if (proxyResult.ip || _proxyRuntimeState.currentIp) {
        p.proxyIp = proxyResult.ip || _proxyRuntimeState.currentIp;
      }
    }
  }
  state.proxyState = {
    ...(state.proxyState || {}),
    ..._proxyRuntimeState,
    currentIp: proxyResult.ip || _proxyRuntimeState.currentIp || state?.proxyState?.currentIp || '',
    resourceId: VIDEO_PROXY_CONFIG.resourceId,
    host: VIDEO_PROXY_CONFIG.host,
    port: VIDEO_PROXY_CONFIG.port
  };
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
    // Kiểm tra xem cửa sổ Video bên trái (x < 250) có đang thực sự mở trên màn hình không
    const openWins = getOpenChromeWindows();
    const hasVideoWinOpen = openWins.some(w => w.x < 250);
    if (!hasVideoWinOpen) {
      logger.info(`[ProfileManager] 🖥️ Không thấy cửa sổ Chrome Video bên trái trên màn hình, tự động bật lại "${active.name}"...`);
      await switchVideoChromeWindow(active);
    }
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

/**
 * Xoá 1 Chrome Box độc lập khỏi hệ thống & ổ cứng VPS
 */
async function deleteChromeBox({ profileDir }) {
  const cleanId = String(profileDir || '').trim();
  if (!cleanId) {
    throw new Error('Thiếu tên thư mục profile cần xoá');
  }
  if (cleanId === 'Profile 6' || cleanId.includes('..') || cleanId.includes('/')) {
    throw new Error('Không thể xoá Profile Làm Ảnh cố định (Profile 6)!');
  }

  const state = getProfilesState();
  const target = state.profiles.find(p => p.profileDir === cleanId);
  const wasActiveVideo = Boolean(target && target.isActiveVideo);
  const boxDir = path.join(CHROME_BOXES_DIR, cleanId);

  logger.info(`[ProfileManager] 🗑️ Đang xoá Chrome Box "${cleanId}" (${boxDir})...`);

  // 1. Tắt tiến trình Chrome của box này nếu đang mở
  try {
    execSync(`pkill -f "${boxDir}" 2>/dev/null || true`, { timeout: 3000 });
  } catch (_) {}

  await new Promise(r => setTimeout(r, 500));

  // 2. Xoá thư mục trên ổ cứng
  try {
    if (fs.existsSync(boxDir)) {
      fs.rmSync(boxDir, { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn(`[ProfileManager] Lỗi xoá thư mục ${boxDir}: ${err.message}`);
  }

  // 3. Đánh dấu đã migrate để không tự copy lại các box mặc định cũ
  try {
    fs.writeFileSync(path.join(CHROME_BOXES_DIR, '.migrated_done'), new Date().toISOString(), 'utf8');
  } catch (_) {}

  // 4. Cập nhật state
  const deletedBoxes = Array.isArray(state.deletedBoxes) ? state.deletedBoxes : [];
  if (!deletedSetContains(deletedBoxes, cleanId)) {
    deletedBoxes.push(cleanId);
  }
  state.deletedBoxes = deletedBoxes;
  state.profiles = state.profiles.filter(p => p.profileDir !== cleanId);
  saveState(state);

  // 5. Nếu vừa xoá đúng nick đang mở làm Video, tự động bật nick Video tiếp theo
  if (wasActiveVideo) {
    const nextVideo = state.profiles.find(p => p.role === 'video' && p.credits >= 10)
                   || state.profiles.find(p => p.role === 'video');
    if (nextVideo) {
      try {
        return await switchVideoChromeWindow(nextVideo);
      } catch (err) {
        logger.warn(`[ProfileManager] Không thể tự bật nick Video kế tiếp sau khi xoá: ${err.message}`);
      }
    }
  }

  return scanChromeProfiles();
}

function deletedSetContains(arr, id) {
  return Array.isArray(arr) && arr.includes(id);
}

// Tự động kiểm tra ngay khi khởi động server: nếu cửa sổ Chrome Video bên trái đang đóng thì tự bật lại ngay
setTimeout(() => {
  ensureActiveVideoProfileHasCredits().catch(() => {});
}, 2000);

module.exports = {
  getActiveDisplay,
  scanChromeProfiles,
  getProfilesState,
  updateProfileConfig,
  createChromeBox,
  deleteChromeBox,
  switchVideoChromeWindow,
  ensureActiveVideoProfileHasCredits,
  deductVideoCreditAndRotateIfNeeded,
  getOpenChromeWindows
};
