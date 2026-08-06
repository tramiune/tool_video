const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { logger } = require('./utils');
const config = require('./config');

puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.oauthToken = null;
    this.tokenCapturedAt = null;
    this.isLaunching = false;
    this.debugPort = options.debugPort || 9222;
    this.userDataDir = options.userDataDir || config.USER_DATA_DIR;
    this.cookieFile = options.cookieFile || config.COOKIE_FILE;
    this.targetUrl = options.targetUrl || config.TARGET_URL;
    this.label = options.label || 'video';
  }

  async initialize() {
    if (this.browser) return;
    if (this.isLaunching) {
      while (this.isLaunching) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return;
    }

    this.isLaunching = true;
    try {
      const browserPath = config.getBrowserPath();
      if (!browserPath) {
        throw new Error('No compatible browser (Brave, Chrome) found. Please specify BRAVE_PATH or CHROME_PATH.');
      }

      logger.info(`Launching browser at: ${browserPath}`);

      // On Mac/Linux, first try to connect to an already-running Chrome on the instance debug port
      if (process.platform === 'darwin' || process.platform === 'linux') {
        try {
          this.browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${this.debugPort}`,
            defaultViewport: { width: 1280, height: 900 }
          });
          logger.info(`[${this.label}] Connected to already-running Chrome on port ${this.debugPort} (preserving manual login)`);
        } catch (connErr) {
          logger.info(`[${this.label}] No existing Chrome on ${this.debugPort}, spawning a new one...`);
        }
      }

      // Cleanup locks
      const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
      for (const file of lockFiles) {
        const p = path.join(this.userDataDir, file);
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch (e) {}
        }
      }

      // Set DISPLAY env variable on Linux so Chrome knows to open on VNC :1
      if (process.platform === 'linux') {
        process.env.DISPLAY = process.env.DISPLAY || ':1';
      }

      const isLinux = process.platform === 'linux';
      const launchOptions = {
        headless: false,
        executablePath: browserPath,
        ignoreDefaultArgs: ['--disable-extensions'],
        defaultViewport: { width: 1280, height: 900 },
        args: [
          `--user-data-dir=${this.userDataDir}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--no-zygote',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-popup-blocking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-session-crashed-bubble',
          '--disable-blink-features=AutomationControlled',
          '--allow-insecure-localhost',
          '--ignore-certificate-errors',
          '--mute-audio',
          '--disable-gpu',
          '--disable-dev-shm-usage'
        ]
      };



      if (!this.browser && (isLinux || process.platform === 'darwin')) {
        logger.info(`[${this.label}] Spawning Google Chrome process manually via spawn to load extension from profile...`);
        const chromeArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          `--user-data-dir=${this.userDataDir}`,
          `--load-extension=${config.EXTENSION_DIR}`,
          `--disable-extensions-except=${config.EXTENSION_DIR}`,
          `--remote-debugging-port=${this.debugPort}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-popup-blocking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-session-crashed-bubble',
          '--disable-blink-features=AutomationControlled',
          '--allow-insecure-localhost',
          '--ignore-certificate-errors',
          '--mute-audio',
          '--no-activate',
          '--start-minimized',
          '--window-position=-2000,-2000',
          '--disable-gpu',
          'about:blank'
        ];
        
        const { spawn } = require('child_process');
        const spawnEnv = { ...process.env };
        if (process.platform === 'linux') {
          spawnEnv.DISPLAY = ':1';
        }
        const chromeProcess = spawn(browserPath, chromeArgs, {
          env: spawnEnv,
          detached: true,
          stdio: 'ignore'
        });
        chromeProcess.unref();
        
        // Wait a moment for Chrome to open port
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Connect Puppeteer to the running instance
        this.browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${this.debugPort}`,
          defaultViewport: { width: 1280, height: 900 }
        });
      } else if (!this.browser) {
        this.browser = await puppeteer.launch(launchOptions);
      }

      this.browser.on('disconnected', () => {
        logger.warn('Browser disconnected unexpectedly!');
        this.browser = null;
        this.page = null;
        this.cdp = null;
        this.oauthToken = null;
      });

      const pages = await this.browser.pages();
      this.page = await this.browser.newPage();
      
      // Log all browser console logs with deserialized arguments for debugging
      this.page.on('console', async (msg) => {
        const args = [];
        for (const arg of msg.args()) {
          try {
            const val = await arg.jsonValue();
            args.push(typeof val === 'object' ? JSON.stringify(val) : String(val));
          } catch (e) {
            args.push(arg.toString());
          }
        }
        logger.info(`[Browser Console] ${msg.text()} | Args: ${args.join(' | ')}`);
      });
      
      // Close initial blank pages
      for (const p of pages) {
        try { await p.close(); } catch (e) {}
      }

      this.cdp = await this.page.target().createCDPSession();
      
      // Enable Network interception in CDP
      await this.cdp.send('Network.enable');
      this.cdp.on('Network.requestWillBeSent', (event) => {
        const url = event.request.url;
        const headers = event.request.headers;
        const auth = headers.authorization || headers.Authorization;
        
        if (url.includes('aisandbox-pa.googleapis.com') && auth && auth.startsWith('Bearer ya29.')) {
          const newToken = auth.substring(7);
          if (this.oauthToken !== newToken) {
            this.oauthToken = newToken;
            this.tokenCapturedAt = Date.now();
            logger.success(`Captured OAuth token (length: ${this.oauthToken.length})`);
          }
        }
      });

      // Inject cookies (only if not on Linux VPS / Mac, to preserve persistent profile session)
      if (process.platform !== 'linux' && process.platform !== 'darwin') {
        await this.injectCookies();
      }

      // Navigate to Google Labs Flow to trigger OAuth token generation
      await this.refreshSession();

    } catch (err) {
      logger.error('Failed to launch browser', err);
      if (this.browser) {
        try { await this.browser.close(); } catch (e) {}
        this.browser = null;
      }
      throw err;
    } finally {
      this.isLaunching = false;
    }
  }

  async injectCookies() {
    if (!fs.existsSync(this.cookieFile)) {
      logger.warn(`Cookies file not found at ${this.cookieFile}. API calls will fail until cookies are set.`);
      return;
    }

    try {
      const content = fs.readFileSync(this.cookieFile, 'utf-8').trim();
      if (!content) return;

      let cookies = [];
      if (content.startsWith('[')) {
        cookies = JSON.parse(content);
      } else {
        // Parse raw Cookie string format: "name=value; name2=value2"
        cookies = content.split(/[;\n]/)
          .map(item => item.trim())
          .filter(item => item && item.includes('='))
          .map(item => {
            const index = item.indexOf('=');
            return {
              name: item.substring(0, index).trim(),
              value: item.substring(index + 1).trim(),
              domain: '.google.com',
              path: '/',
              secure: true,
              sameSite: 'Lax'
            };
          })
          .filter(c => c.name && c.value);
      }

      await this.cdp.send('Network.clearBrowserCookies');
      
      const domains = ['.google.com', 'google.com', 'labs.google', '.labs.google'];
      let count = 0;
      for (const cookie of cookies) {
        const targetDomains = cookie.domain ? [cookie.domain] : domains;
        for (const domain of targetDomains) {
          try {
            await this.cdp.send('Network.setCookie', {
              name: cookie.name,
              value: cookie.value,
              domain: domain,
              path: cookie.path || '/',
              secure: cookie.secure !== false,
              sameSite: cookie.sameSite || 'Lax',
              url: domain.includes('labs.google') ? 'https://labs.google' : 'https://accounts.google.com'
            });
            count++;
          } catch (e) {}
        }
      }
      logger.info(`Injected ${cookies.length} cookies into browser context`);
    } catch (err) {
      logger.error('Failed to inject cookies', err);
    }
  }

  async refreshSession() {
    if (!this.page) return;
    logger.info(`[${this.label}] Navigating browser to trigger session refresh: ${this.targetUrl}`);
    try {
      await this.page.goto(this.targetUrl, { waitUntil: 'load', timeout: 30000 });
      
      // Wait a moment for network requests to start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const currentUrl = this.page.url();
      if (currentUrl.includes('accounts.google.com')) {
        logger.error('Session expired: Google redirected browser to accounts.google.com! Please update your cookies.');
        this.oauthToken = null;
        return false;
      }

      // Extract fresh cookies from the browser session (only if session is fully authenticated)
      const cookies = await this.page.cookies();
      const hasLabsSession = cookies?.some(cookie => cookie.name === '__Secure-next-auth.session-token');
      if (this.oauthToken && hasLabsSession) {
        const cookiesJson = JSON.stringify(cookies);
        fs.writeFileSync(this.cookieFile, cookiesJson, 'utf-8');
        logger.success(`[${this.label}] Extracted & updated ${cookies.length} refreshed cookies locally to ${path.basename(this.cookieFile)}`);

        // Sync refreshed cookies to Firestore (only for the video profile, image profile keeps local only)
        if (this.label === 'video') {
          try {
            const { db } = require('./firebase_worker');
            await db.collection('settings').doc('cookies').set({
              cookies: cookiesJson,
              updatedAt: Date.now()
            }, { merge: true });
            logger.success("Synced refreshed cookies to Firestore settings/cookies");
          } catch (dbErr) {
            logger.warn("Could not sync refreshed cookies to Firestore:", dbErr.message);
          }
        }
      }
      return true;
    } catch (err) {
      logger.warn(`Navigation finished with warning/timeout (this is normal for heavy Labs page): ${err.message}`);
      return false;
    }
  }

  async getOAuthToken() {
    await this.initialize();
    
    // Check if token is available and validate it
    if (this.oauthToken) {
      const isValid = await this.validateToken(this.oauthToken);
      if (isValid) {
        return this.oauthToken;
      }
      logger.warn('Token in cache is invalid or expired. Attempting token capture/refresh...');
    }

    // Attempt 1: Reload via Puppeteer session
    await this.refreshSession();

    if (this.oauthToken) {
      const isValid = await this.validateToken(this.oauthToken);
      if (isValid) return this.oauthToken;
    }

    // Attempt 2: Request active Chrome Extension client to reload tab and capture fresh token
    try {
      const captchaService = require('./captcha_service');
      if (captchaService && captchaService.io) {
        captchaService.io.emit('refresh_flow_page');
        logger.info('Emitted refresh_flow_page to Chrome Extension to capture fresh ya29 token');
        
        // Wait up to 6 seconds for token capture from Extension socket
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (this.oauthToken) {
            const isValid = await this.validateToken(this.oauthToken);
            if (isValid) return this.oauthToken;
          }
        }
      }
    } catch (extErr) {
      logger.warn('Extension token capture fallback warning:', extErr.message);
    }

    if (this.oauthToken) {
      return this.oauthToken;
    }

    throw new Error('Failed to capture Google ya29 OAuth token. Please ensure cookies.json is valid and labs.google is accessible.');
  }

  // Validate OAuth Token directly using Google's credits endpoint
  validateToken(token) {
    return new Promise((resolve) => {
      const url = `https://aisandbox-pa.googleapis.com/v1/credits?key=${config.API_KEY}`;
      const req = https.request(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': '*/*',
          'Referer': 'https://labs.google/'
        },
        timeout: 5000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          resolve(res.statusCode === 200);
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  async shutdown() {
    if (this.browser) {
      logger.info('Shutting down browser context...');
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
      this.page = null;
      this.cdp = null;
      this.oauthToken = null;
    }
  }
}

const videoBrowser = new BrowserManager({
  label: 'video',
  debugPort: 9222,
  userDataDir: config.USER_DATA_DIR,
  cookieFile: config.COOKIE_FILE,
  targetUrl: config.TARGET_URL
});

const imageBrowser = new BrowserManager({
  label: 'image',
  debugPort: config.IMAGE_DEBUG_PORT,
  userDataDir: config.IMAGE_USER_DATA_DIR,
  cookieFile: config.IMAGE_COOKIE_FILE,
  targetUrl: config.IMAGE_TARGET_URL
});

// Backwards-compatible default export = video browser (existing code relies on it)
videoBrowser.image = imageBrowser;
module.exports = videoBrowser;
