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
