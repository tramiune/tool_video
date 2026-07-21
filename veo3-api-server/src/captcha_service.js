const { EventEmitter } = require('events');
const crypto = require('crypto');
const { logger } = require('./utils');

class CaptchaService extends EventEmitter {
  constructor() {
    super();
    this.connectedClients = new Map(); // socketId -> clientMetadata
    this.pendingRequests = new Map();  // requestId -> { resolve, reject, timer }
  }

  attach(io) {
    this.io = io;

    io.on('connection', (socket) => {
      logger.info(`Extension connected: ${socket.id}`);
      
      // Store connection
      this.connectedClients.set(socket.id, {
        socket,
        browserType: 'unknown',
        userAgent: '',
        secChUa: '',
        secChUaPlatform: '',
        secChUaMobile: ''
      });

      socket.on('client:ready', (data) => {
        const client = this.connectedClients.get(socket.id);
        if (client) {
          client.browserType = data.browserType || 'unknown';
          client.userAgent = data.userAgent || '';
          client.secChUa = data.secChUa || '';
          client.secChUaPlatform = data.secChUaPlatform || '"Windows"';
          client.secChUaMobile = data.secChUaMobile || '?0';
        }
        logger.info(`Extension client ready [${socket.id.substring(0, 6)}]: ${data.browserType}`);
      });

      socket.on('client:sync-cookies', async (data) => {
        try {
          if (data && Array.isArray(data.cookies) && data.cookies.length > 0) {
            const fs = require('fs');
            const config = require('./config');
            const cookiesJson = JSON.stringify(data.cookies);
            fs.writeFileSync(config.COOKIE_FILE, cookiesJson, 'utf-8');
            logger.success(`Extracted & synced ${data.cookies.length} active cookies from Chrome extension client!`);
            
            try {
              const { db } = require('./firebase_worker');
              await db.collection('settings').doc('cookies').set({
                cookies: cookiesJson,
                updatedAt: Date.now()
              }, { merge: true });
            } catch (dbErr) {
              logger.warn("Could not sync extension cookies to Firestore:", dbErr.message);
            }

            // Automatically re-inject new cookies into browserManager so background Puppeteer stays fresh
            try {
              const browserManager = require('./browser_manager');
              if (browserManager.browser) {
                await browserManager.injectCookies();
                await browserManager.refreshSession();
              }
            } catch (bmErr) {
              logger.warn("Could not re-inject cookies into browserManager:", bmErr.message);
            }
          }
        } catch (err) {
          logger.warn("Error handling client:sync-cookies:", err.message);
        }
      });

      socket.on('client:token-captured', ({ token }) => {
        if (token && typeof token === 'string' && token.startsWith('ya29.')) {
          try {
            const browserManager = require('./browser_manager');
            if (browserManager.oauthToken !== token) {
              browserManager.oauthToken = token;
              browserManager.tokenCapturedAt = Date.now();
              logger.success(`Captured OAuth token from Extension client (length: ${token.length})`);
            }
          } catch (e) {}
        }
      });

      socket.on('client:captcha-solved', ({ requestId, token }) => {
        if (requestId && this.pendingRequests.has(requestId)) {
          const req = this.pendingRequests.get(requestId);
          clearTimeout(req.timer);
          this.pendingRequests.delete(requestId);
          req.resolve(token);
          logger.success(`reCAPTCHA solved for request: ${requestId} (${token.substring(0, 10)}...)`);
        }
      });

      socket.on('client:captcha-error', ({ requestId, error: errMsg }) => {
        logger.warn(`reCAPTCHA solver error: ${errMsg}`);
        if (requestId && this.pendingRequests.has(requestId)) {
          const req = this.pendingRequests.get(requestId);
          clearTimeout(req.timer);
          this.pendingRequests.delete(requestId);
          req.reject(new Error(errMsg));
        }
      });

      socket.on('disconnect', () => {
        this.connectedClients.delete(socket.id);
        logger.info(`Extension disconnected: ${socket.id} (remaining clients: ${this.connectedClients.size})`);
      });
    });
  }

  // Get a suitable extension client
  _pickClient() {
    const clients = [...this.connectedClients.values()];
    // Prioritize chrome over brave, or just grab the first available
    return clients.find(c => c.browserType === 'chrome') || clients[0] || null;
  }

  // A simple queue to prevent concurrent captcha requests from overwhelming the extension
  async _acquireLock() {
    while (this.isSolving) {
      await new Promise(r => setTimeout(r, 100));
    }
    this.isSolving = true;
  }

  // Request captcha solving via Chrome extension
  async solveCaptcha(action = 'IMAGE_GENERATION', timeoutMs = 45000) {
    await this._acquireLock();

    try {
      const client = this._pickClient();
      if (!client) {
        throw new Error('No Chrome extension clients connected. Open a Chrome tab at labs.google/fx/vi/tools/flow with the extension installed.');
      }

      const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      logger.info(`Requesting reCAPTCHA token (action: ${action}, client: ${client.socket.id.substring(0, 6)})`);

      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(new Error(`reCAPTCHA solving timed out (${timeoutMs / 1000}s)`));
          }
        }, timeoutMs);

        this.pendingRequests.set(requestId, { resolve, reject, timer });
        
        // Emit to client
        client.socket.emit('server:request-captcha', {
          requestId,
          action
        });
      });
    } finally {
      // Cooldown to ensure extension is ready for next captcha
      await new Promise(r => setTimeout(r, 500));
      this.isSolving = false;
    }
  }

  // Force page reload in all extension clients
  forceRefresh() {
    let count = 0;
    for (const client of this.connectedClients.values()) {
      client.socket.emit('server:reload-page', { delay: 200 });
      count++;
    }
    logger.info(`Force refreshed ${count} extension client(s)`);
    return count;
  }

  getHealth() {
    const clients = [...this.connectedClients.values()].map(c => ({
      id: c.socket.id.substring(0, 6),
      browserType: c.browserType
    }));
    return {
      status: 'ok',
      connectedClients: this.connectedClients.size,
      clients,
      pendingRequests: this.pendingRequests.size
    };
  }
}

module.exports = new CaptchaService();
