const fs = require('fs');
const path = require('path');
const { logger } = require('./utils');

const BASE_URL = 'https://audio.aidancing.net';
const VOICE_DEMO_LANG = 'vi';
const COOKIE_JAR_FILE = path.join(__dirname, '..', '.audio_cookies.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Minimal cookie jar: just keep a shared cookie string + a session list keyed by header.
let sharedCookie = '';
try {
  if (fs.existsSync(COOKIE_JAR_FILE)) {
    sharedCookie = fs.readFileSync(COOKIE_JAR_FILE, 'utf-8').trim() || '';
  }
} catch (e) {}

function persistCookie() {
  try {
    if (sharedCookie) fs.writeFileSync(COOKIE_JAR_FILE, sharedCookie);
  } catch (e) {}
}

async function request(method, endpoint, body = null, isForm = false) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json'
  };
  if (sharedCookie) headers['Cookie'] = sharedCookie;
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const url = `${BASE_URL}${endpoint}`;
  const init = { method, headers, redirect: 'follow' };
  if (body && !isForm) init.body = JSON.stringify(body);
  if (body && isForm) init.body = body;

  const res = await fetch(url, init);

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const sc of setCookies) {
    const part = sc.split(';')[0].trim();
    if (part) {
      const parts = sharedCookie ? sharedCookie.split('; ').filter(p => !p.startsWith(part.split('=')[0] + '=')) : [];
      parts.push(part);
      sharedCookie = parts.join('; ');
      persistCookie();
    }
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { statusCode: res.status, body: json, text };
}

// Create a new TTS/clone job
async function createJob(text, lang = VOICE_DEMO_LANG, voiceIndex = null) {
  const payload = { text, lang };
  if (voiceIndex !== null && voiceIndex !== undefined) payload.voiceIndex = voiceIndex;
  const res = await request('POST', '/jobs', payload);
  if (res.statusCode >= 300) {
    throw new Error(`Audio create job failed (${res.statusCode}): ${res.text.substring(0, 300)}`);
  }
  if (!res.body || !res.body.jobUid) {
    throw new Error(`Audio create job: missing jobUid: ${res.text.substring(0, 300)}`);
  }
  return res.body.jobUid;
}

// Start a job (used when no file upload, i.e. preset voice)
async function startJob(jobUid) {
  const res = await request('POST', `/jobs/${jobUid}/start`);
  if (res.statusCode >= 300) {
    throw new Error(`Audio start job failed (${res.statusCode}): ${res.text.substring(0, 300)}`);
  }
  return res.body || {};
}

// List all jobs of the shared session
async function listJobs() {
  const res = await request('GET', '/jobs');
  if (res.statusCode >= 300) {
    throw new Error(`Audio list jobs failed (${res.statusCode}): ${res.text.substring(0, 300)}`);
  }
  return Array.isArray(res.body) ? res.body : [];
}

const VOICE_CACHE = { data: null, fetchedAt: 0 };
const VOICE_CACHE_TTL = 30 * 60 * 1000;

// Fetch preset voices list (voice-demo/vi.txt -> "Name|url")
async function getVoices() {
  const now = Date.now();
  if (VOICE_CACHE.data && now - VOICE_CACHE.fetchedAt < VOICE_CACHE_TTL) {
    return VOICE_CACHE.data;
  }
  const res = await fetch(`${BASE_URL}/voice-demo/${VOICE_DEMO_LANG}.txt`, {
    headers: { 'User-Agent': UA }
  });
  const text = await res.text();
  if (res.status !== 200 || !text.trim()) {
    throw new Error(`Audio get voices failed (${res.status})`);
  }
  const voices = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      const sep = line.indexOf('|');
      if (sep === -1) return { name: line, url: null, voiceIndex: idx };
      return {
        name: line.substring(0, sep).trim(),
        url: line.substring(sep + 1).trim() || null,
        voiceIndex: idx
      };
    });
  VOICE_CACHE.data = voices;
  VOICE_CACHE.fetchedAt = now;
  return voices;
}

module.exports = { createJob, startJob, listJobs, getVoices, BASE_URL };
