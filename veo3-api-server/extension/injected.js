(async function () {
  const LOG_PREFIX = '[VEO3-CaptchaExt/Injected]';
  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const DEFAULT_SERVER_URL = 'http://127.0.0.1:3456';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, '⚠️', ...args);
  }

  function error(...args) {
    console.error(LOG_PREFIX, '❌', ...args);
  }

  function success(...args) {
    console.log(LOG_PREFIX, '✅', ...args);
  }

  log('Starting injected script...');

  // Setup UI elements (Countdown / badge status)
  function createStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #veo3-captcha-badge {
        position: fixed; bottom: 24px; right: 24px; min-width: 140px;
        height: 76px; border-radius: 12px;
        background: linear-gradient(135deg, #5b7cfa 0%, #748ffc 100%);
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; color: white; z-index: 999999;
        font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(91,124,250,0.4);
        transition: all .3s ease; padding: 12px 16px; gap: 4px;
        border: 1px solid rgba(255,255,255,0.2);
        backdrop-filter: blur(8px); cursor: default;
      }
      #veo3-captcha-badge.hidden { display: none; }
      #veo3-captcha-badge:hover { transform: translateY(-2px); }
      #veo3-captcha-badge-label { font-size: 10px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .8px; opacity: .85; }
      #veo3-captcha-badge-time { font-size: 32px; font-weight: 700;
        line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -1px; }
      #veo3-captcha-badge.warn { background: linear-gradient(135deg,#ffa500,#ff8c00); }
      #veo3-captcha-badge.danger { background: linear-gradient(135deg,#ff4757,#ff3838); }
    `;
    document.head.appendChild(style);
  }

  function createBadge() {
    if (document.getElementById('veo3-captcha-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'veo3-captcha-badge';
    badge.className = 'hidden';
    badge.innerHTML = `
      <div id="veo3-captcha-badge-label">Reload in</div>
      <div id="veo3-captcha-badge-time">--</div>
    `;
    document.body?.appendChild(badge);
  }

  function updateBadge(remainingSeconds, totalSeconds) {
    const badge = document.getElementById('veo3-captcha-badge');
    if (!badge) return;
    if (remainingSeconds <= 0) {
      badge.className = 'hidden';
      return;
    }
    badge.className = '';
    const ratio = remainingSeconds / totalSeconds;
    badge.classList.toggle('warn', ratio <= 0.6 && ratio > 0.3);
    badge.classList.toggle('danger', ratio <= 0.3);
    document.getElementById('veo3-captcha-badge-time').textContent =
      String(Math.max(0, remainingSeconds)).padStart(2, '0') + 's';
  }

  function getSocketLibrary() {
    if (!window.io) {
      throw new Error('Socket.IO not loaded — check content.js injection order');
    }
    return window.io;
  }

  async function waitForGrecaptcha(timeoutMs = 30000) {
    log('Waiting for grecaptcha.enterprise...');
    const step = 500;
    for (let elapsed = 0; elapsed < timeoutMs; elapsed += step) {
      if (window.grecaptcha?.enterprise?.execute) {
        success('grecaptcha.enterprise ready');
        return;
      }
      await sleep(step);
    }
    throw new Error('reCAPTCHA Enterprise not available after 30s');
  }

  async function solveRecaptcha(action = 'IMAGE_GENERATION') {
    log(`Solving reCAPTCHA (action: ${action})...`);
    const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action });
    success(`Token obtained (${token.length} chars)`);
    try {
      localStorage.removeItem('_grecaptcha');
    } catch (e) {}
    return token;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  try {
    createStyle();
    if (document.body) createBadge();
    else document.addEventListener('DOMContentLoaded', createBadge);

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.type === 'VEO3_COUNTDOWN_UPDATE') {
        updateBadge(event.data.remainingSeconds, event.data.totalSeconds);
      }
    });

    function requestSettings() {
      const retries = 5;
      function attempt(count) {
        return new Promise((resolve) => {
          const timeout = 1000 + count * 500;
          const timer = setTimeout(() => {
            window.removeEventListener('message', handleResponse);
            if (count < retries - 1) {
              warn(`Settings request timed out (attempt ${count + 1}/${retries}), retrying...`);
              resolve(attempt(count + 1));
            } else {
              warn(`Settings request failed after ${retries} attempts, using fallback URL`);
              resolve({ serverUrl: DEFAULT_SERVER_URL });
            }
          }, timeout);

          const handleResponse = (event) => {
            if (event.source !== window || event.data?.type !== 'VEO3_GET_SETTINGS_RESPONSE') return;
            clearTimeout(timer);
            window.removeEventListener('message', handleResponse);
            resolve(event.data.settings || {});
          };

          window.addEventListener('message', handleResponse);
          window.postMessage({ type: 'VEO3_GET_SETTINGS_REQUEST' }, '*');
        });
      }
      return attempt(0);
    }

    const settings = await requestSettings();
    const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;
    log(`Server URL: ${serverUrl}`);

    const io = getSocketLibrary();
    success('Socket.IO library ready');

    const socket = io(serverUrl, {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });

    let connectionAttempts = 0;
    let lastActivityAt = Date.now();
    let keepAliveTimer = null;

    function startKeepAliveCheck() {
      stopKeepAliveCheck();
      keepAliveTimer = setInterval(() => {
        if (!socket.connected) return;
        const elapsed = Date.now() - lastActivityAt;
        if (elapsed > 45000) {
          warn(`No server activity for ${Math.round(elapsed / 1000)}s — forcing reconnect`);
          socket.disconnect();
          setTimeout(() => socket.connect(), 1000);
        }
      }, 10000);
    }

    function stopKeepAliveCheck() {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    }

    socket.on('connect', () => {
      connectionAttempts++;
      lastActivityAt = Date.now();
      success(`Connected (socket: ${socket.id}, attempt #${connectionAttempts}, transport: ${socket.io.engine?.transport?.name || 'unknown'})`);
      
      const userAgent = navigator.userAgent || '';
      const isHeadless = navigator.webdriver === true || userAgent.includes('HeadlessChrome');
      const browserType = isHeadless ? 'brave' : 'chrome';

      let secChUa = '';
      let secChUaPlatform = '"Windows"';
      let secChUaMobile = '?0';

      if (navigator.userAgentData) {
        if (navigator.userAgentData.brands) {
          secChUa = navigator.userAgentData.brands
            .map((brand) => `"${brand.brand}";v="${brand.version}"`)
            .join(', ');
        }
        if (navigator.userAgentData.platform) {
          secChUaPlatform = `"${navigator.userAgentData.platform}"`;
        }
        secChUaMobile = navigator.userAgentData.mobile ? '?1' : '?0';
      }

      socket.emit('client:ready', {
        timestamp: new Date().toISOString(),
        browserType,
        userAgent,
        secChUa,
        secChUaPlatform,
        secChUaMobile,
      });

      // Extract & Sync active browser cookies to server
      const handleCookiesResponse = (event) => {
        if (event.source !== window || event.data?.type !== 'VEO3_EXTRACT_COOKIES_RESPONSE') return;
        window.removeEventListener('message', handleCookiesResponse);
        const cookies = event.data.cookies;
        if (cookies && cookies.length > 0) {
          socket.emit('client:sync-cookies', { cookies });
          log(`Synced ${cookies.length} active browser cookies to server`);
        }
      };
      window.addEventListener('message', handleCookiesResponse);
      window.postMessage({ type: 'VEO3_EXTRACT_COOKIES_REQUEST' }, '*');

      startKeepAliveCheck();
    });

    socket.onAny(() => {
      lastActivityAt = Date.now();
    });

    socket.on('disconnect', (reason) => {
      warn(`Disconnected: ${reason}`);
      stopKeepAliveCheck();
      if (reason === 'io server disconnect') {
        log('Server-initiated disconnect — reconnecting in 2s...');
        setTimeout(() => socket.connect(), 2000);
      }
    });

    socket.on('connect_error', (err) => {
      connectionAttempts++;
      if (connectionAttempts <= 5 || connectionAttempts % 10 === 0) {
        warn(`Connection error (attempt #${connectionAttempts}): ${err.message}`);
      }
    });

    // Listen to solve captcha request from server
    socket.on('server:request-captcha', async (data) => {
      log('Received captcha request:', data);
      const action = data?.action || 'IMAGE_GENERATION';
      try {
        await waitForGrecaptcha();
        const token = await solveRecaptcha(action);
        socket.emit('client:captcha-solved', {
          requestId: data?.requestId,
          token: token,
          timestamp: new Date().toISOString(),
        });
        log(`Token sent to server for requestId: ${data?.requestId}`);
      } catch (err) {
        const errMsg = err?.message || 'Unknown reCAPTCHA solver error';
        error(`Failed to solve captcha: ${errMsg}`);
        socket.emit('client:captcha-error', {
          requestId: data?.requestId,
          error: errMsg,
        });
      }
    });

    // Handle server-triggered page refresh command
    socket.on('refresh_flow_page', () => {
      log('Received refresh_flow_page command from server. Requesting tab reload via extension background...');
      window.postMessage({ type: 'VEO3_RELOAD_TAB_REQUEST' }, '*');
    });

    // Local safety interval to reload Google Flow tab (every 30 seconds)
    setInterval(() => {
      log('30-second timer reached. Requesting tab reload via extension background...');
      window.postMessage({ type: 'VEO3_RELOAD_TAB_REQUEST' }, '*');
    }, 30 * 1000);
  } catch (err) {
    error('Initialization failed:', err.message);
  }
})();
