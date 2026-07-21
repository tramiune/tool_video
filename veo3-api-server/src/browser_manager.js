const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { logger } = require('./utils');
const config = require('./config');

puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.oauthToken = null;
    this.tokenCapturedAt = null;
    this.isLaunching = false;
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
      
      // Cleanup locks
      const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
      for (const file of lockFiles) {
        const p = path.join(config.USER_DATA_DIR, file);
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch (e) {}
        }
      }

      this.browser = await puppeteer.launch({
        headless: true, // Run headless since we just capture tokens
        executablePath: browserPath,
        userDataDir: config.USER_DATA_DIR,
        defaultViewport: { width: 1280, height: 900 },
        args: [
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
      });

      this.browser.on('disconnected', () => {
        logger.warn('Browser disconnected unexpectedly!');
        this.browser = null;
        this.page = null;
        this.cdp = null;
        this.oauthToken = null;
      });

      const pages = await this.browser.pages();
      this.page = await this.browser.newPage();
      
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

      // Inject cookies
      await this.injectCookies();

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
    if (!fs.existsSync(config.COOKIE_FILE)) {
      logger.warn(`Cookies file not found at ${config.COOKIE_FILE}. API calls will fail until cookies are set.`);
      return;
    }

    try {
      const content = fs.readFileSync(config.COOKIE_FILE, 'utf-8').trim();
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
    logger.info(`Navigating browser to trigger session refresh: ${config.TARGET_URL}`);
    try {
      await this.page.goto(config.TARGET_URL, { waitUntil: 'load', timeout: 30000 });
      
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
      if (this.oauthToken && cookies && cookies.length >= 15) {
        const cookiesJson = JSON.stringify(cookies);
        fs.writeFileSync(config.COOKIE_FILE, cookiesJson, 'utf-8');
        logger.success(`Extracted & updated ${cookies.length} refreshed cookies locally to cookies.json`);

        // Sync refreshed cookies to Firestore
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

module.exports = new BrowserManager();
