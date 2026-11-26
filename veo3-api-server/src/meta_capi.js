const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { logger } = require('./utils');

const DEFAULT_MEO3_PIXEL_ID = '3081788372015433';
const CTX_FILE = path.join(__dirname, '..', 'meta_user_ctx.json');
const MAX_CTX_ENTRIES = 3000;

let ctxMap = {};
const sentPurchaseEventIds = new Set();

function loadCtxFile() {
  try {
    if (fs.existsSync(CTX_FILE)) {
      const raw = fs.readFileSync(CTX_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        ctxMap = parsed;
      }
    }
  } catch (err) {
    logger.warn(`[MetaCAPI] Failed to load context file: ${err.message}`);
  }
}

function persistCtxFile() {
  try {
    const keys = Object.keys(ctxMap);
    if (keys.length > MAX_CTX_ENTRIES) {
      keys
        .sort((a, b) => (ctxMap[a]?.updatedAt || 0) - (ctxMap[b]?.updatedAt || 0))
        .slice(0, keys.length - MAX_CTX_ENTRIES)
        .forEach((k) => delete ctxMap[k]);
    }
    const tmpFile = `${CTX_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(ctxMap), 'utf8');
    fs.renameSync(tmpFile, CTX_FILE);
  } catch (err) {
    logger.warn(`[MetaCAPI] Failed to persist context file: ${err.message}`);
  }
}

loadCtxFile();

function sha256(val) {
  const clean = String(val || '').trim().toLowerCase();
  if (!clean) return '';
  return crypto.createHash('sha256').update(clean, 'utf8').digest('hex');
}

function extractClientIp(req) {
  if (!req) return '';
  const headers = req.headers || {};
  for (const h of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']) {
    const raw = String(headers[h] || '').trim();
    if (raw) {
      const first = raw.split(',')[0].trim();
      if (first && first !== '127.0.0.1' && first !== '::1' && first !== 'localhost') {
        return first;
      }
    }
  }
  const remote = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
  if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== 'localhost') {
    return remote;
  }
  return '';
}

function saveUserContext({
  paymentCode = '',
  userId = '',
  email = '',
  fullName = '',
  fbp = '',
  fbc = '',
  clientIp = '',
  userAgent = '',
  sourceUrl = '',
} = {}) {
  const emailClean = String(email || '').trim().toLowerCase();
  const uidClean = String(userId || '').trim();
  const codeClean = String(paymentCode || '').trim().toUpperCase();
  const keys = [
    codeClean ? `code:${codeClean}` : '',
    uidClean ? `uid:${uidClean}` : '',
    emailClean ? `em:${emailClean}` : '',
  ].filter(Boolean);

  if (keys.length === 0) return;

  const now = Date.now();
  for (const key of keys) {
    const prev = ctxMap[key] || {};
    ctxMap[key] = {
      email: emailClean || prev.email || '',
      userId: uidClean || prev.userId || '',
      fullName: String(fullName || '').trim() || prev.fullName || '',
      fbp: String(fbp || '').trim() || prev.fbp || '',
      fbc: String(fbc || '').trim() || prev.fbc || '',
      clientIp: String(clientIp || '').trim() || prev.clientIp || '',
      userAgent: String(userAgent || '').trim() || prev.userAgent || '',
      sourceUrl: String(sourceUrl || '').trim() || prev.sourceUrl || 'https://meo3.cloud/',
      updatedAt: now,
    };
  }
  persistCtxFile();
}

function getUserContext({ paymentCode = '', userId = '', email = '' } = {}) {
  const codeClean = String(paymentCode || '').trim().toUpperCase();
  const uidClean = String(userId || '').trim();
  const emailClean = String(email || '').trim().toLowerCase();
  const lookupKeys = [
    codeClean ? `code:${codeClean}` : '',
    uidClean ? `uid:${uidClean}` : '',
    emailClean ? `em:${emailClean}` : '',
  ].filter(Boolean);

  const merged = {};
  for (const key of lookupKeys) {
    const row = ctxMap[key];
    if (!row) continue;
    for (const col of ['email', 'userId', 'fullName', 'fbp', 'fbc', 'clientIp', 'userAgent', 'sourceUrl']) {
      if (!merged[col] && row[col]) merged[col] = row[col];
    }
  }
  return merged;
}

async function sendMetaEvent({
  eventName,
  eventId,
  paymentCode = '',
  email = '',
  userId = '',
  fullName = '',
  fbp = '',
  fbc = '',
  clientIp = '',
  userAgent = '',
  eventSourceUrl = '',
  customData = null,
}) {
  const pixelId = String(
    process.env.MEO3_META_PIXEL_ID || process.env.META_PIXEL_ID || DEFAULT_MEO3_PIXEL_ID
  ).trim();
  const accessToken = String(
    process.env.MEO3_META_CAPI_ACCESS_TOKEN || process.env.META_CAPI_ACCESS_TOKEN || ''
  ).trim();

  if (!pixelId || !accessToken) {
    if (eventName === 'Purchase') {
      logger.warn(`[MetaCAPI] Missing MEO3_META_CAPI_ACCESS_TOKEN in .env — skipped server Purchase for ${eventId}`);
    }
    return false;
  }

  const ctx = getUserContext({ paymentCode: paymentCode || eventId, userId, email });
  const finalEmail = String(email || ctx.email || '').trim().toLowerCase();
  const finalUid = String(userId || ctx.userId || '').trim();
  const finalFullName = String(fullName || ctx.fullName || '').trim();
  const finalFbp = String(fbp || ctx.fbp || '').trim();
  const finalFbc = String(fbc || ctx.fbc || '').trim();
  const finalIp = String(clientIp || ctx.clientIp || '').trim();
  const finalUa = String(userAgent || ctx.userAgent || '').trim();
  const finalUrl = String(eventSourceUrl || ctx.sourceUrl || 'https://meo3.cloud/').trim();

  const userData = {
    country: [sha256('vn')],
  };
  if (finalEmail) userData.em = [sha256(finalEmail)];
  const extKey = finalUid || finalEmail;
  if (extKey) userData.external_id = [sha256(extKey)];
  if (finalFullName) {
    const parts = finalFullName.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      userData.fn = [sha256(parts[0])];
      if (parts.length > 1) userData.ln = [sha256(parts[parts.length - 1])];
    }
  }
  if (finalIp) userData.client_ip_address = finalIp;
  if (finalUa) userData.client_user_agent = finalUa;
  if (finalFbp) userData.fbp = finalFbp;
  if (finalFbc) userData.fbc = finalFbc;

  const eventPayload = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_source_url: finalUrl,
    user_data: userData,
  };
  if (eventId) eventPayload.event_id = String(eventId);
  if (customData && Object.keys(customData).length > 0) {
    eventPayload.custom_data = customData;
  }

  const url = `https://graph.facebook.com/v21.0/${pixelId}/events`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [eventPayload],
        access_token: accessToken,
      }),
    });
    const text = await resp.text().catch(() => '');
    if (!resp.ok) {
      logger.warn(`[MetaCAPI] Error sending ${eventName} (${eventId}) to pixel ${pixelId}: ${resp.status} ${text}`);
      return false;
    }
    logger.info(`[MetaCAPI] Sent ${eventName} (${eventId}) to pixel ${pixelId} (fbp=${Boolean(finalFbp)}, fbc=${Boolean(finalFbc)}, em=${Boolean(finalEmail)})`);
    return true;
  } catch (err) {
    logger.warn(`[MetaCAPI] Exception sending ${eventName} (${eventId}): ${err.message}`);
    return false;
  }
}

async function sendPurchase({ paymentCode, amount, tier, email = '', userId = '', fullName = '' }) {
  const code = String(paymentCode || '').trim().toUpperCase();
  const val = Math.round(Number(amount || 0));
  if (!code || val <= 0) return false;

  if (sentPurchaseEventIds.has(code)) {
    logger.info(`[MetaCAPI] Purchase ${code} already sent in this session, skipping duplicate.`);
    return false;
  }
  sentPurchaseEventIds.add(code);
  if (sentPurchaseEventIds.size > 5000) {
    const firstKey = sentPurchaseEventIds.values().next().value;
    if (firstKey) sentPurchaseEventIds.delete(firstKey);
  }

  const pkgId = String(tier || 'meo3_package').trim();
  return sendMetaEvent({
    eventName: 'Purchase',
    eventId: code,
    paymentCode: code,
    email,
    userId,
    fullName,
    eventSourceUrl: 'https://meo3.cloud/',
    customData: {
      value: val,
      currency: 'VND',
      content_name: pkgId,
      content_type: 'product',
      content_ids: [pkgId],
      num_items: 1,
      contents: [{ id: pkgId, quantity: 1, item_price: val }],
      order_id: code,
    },
  });
}

module.exports = {
  extractClientIp,
  saveUserContext,
  getUserContext,
  sendMetaEvent,
  sendPurchase,
};
