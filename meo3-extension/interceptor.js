(function() {
  // ── Wrap fetch để capture Bearer token ──────────────
  const _fetch = window.fetch;
  window.fetch = function(...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const opts = args[1] || {};
      let auth = '';
      if (opts.headers instanceof Headers) auth = opts.headers.get('Authorization') || '';
      else if (opts.headers) auth = opts.headers['Authorization'] || opts.headers['authorization'] || '';
      if (auth.startsWith('Bearer ya29.') && url.includes('googleapis.com')) {
        window.postMessage({ type: 'MEO3_TOKEN', token: auth.slice(7) }, '*');
      }
    } catch(_) {}
    return _fetch.apply(this, args);
  };

  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...a) { this.__url = a[1] || ''; return _open.apply(this, a); };
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (name.toLowerCase() === 'authorization' && value.startsWith('Bearer ya29.') && (this.__url||'').includes('googleapis.com')) {
      window.postMessage({ type: 'MEO3_TOKEN', token: value.slice(7) }, '*');
    }
    return _setHeader.apply(this, arguments);
  };

  // ── Giải reCAPTCHA khi extension yêu cầu ────────────
  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.type !== 'MEO3_SOLVE_CAPTCHA') return;
    const { requestId, action } = e.data;
    try {
      // Chờ grecaptcha sẵn sàng
      let waited = 0;
      while ((!window.grecaptcha?.enterprise?.execute) && waited < 10000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
      }
      if (!window.grecaptcha?.enterprise?.execute) throw new Error('grecaptcha not available');
      const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action });
      window.postMessage({ type: 'MEO3_CAPTCHA_RESULT', requestId, token }, '*');
    } catch (err) {
      window.postMessage({ type: 'MEO3_CAPTCHA_RESULT', requestId, error: err.message }, '*');
    }
  });
})();

// ── Capture video URL qua <video> element ─────────────
window.addEventListener('message', async (e) => {
  if (e.source !== window || e.data?.type !== 'MEO3_CAPTURE_VIDEO') return;
  const { requestId, mediaId } = e.data;
  const LABS = 'https://labs.google';

  try {
    const redirectUrl = `${LABS}/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}&mediaUrlType=MEDIA_URL_TYPE_VIDEO`;

    // Dùng fetch để lấy URL (trong MAIN world — có cookie đúng)
    const res = await fetch(redirectUrl, { credentials: 'include', redirect: 'follow', headers: { Accept: 'application/json, */*' } });
    // Nếu redirect → dùng res.url
    if (res.url && !res.url.includes('getMediaUrlRedirect') && !res.url.includes('labs.google')) {
      window.postMessage({ type: 'MEO3_VIDEO_URL_RESULT', requestId, url: res.url }, '*');
      return;
    }
    // Thử parse JSON
    try {
      const body = await res.json();
      const url = body?.result?.data?.json?.url || body?.url || null;
      if (url) { window.postMessage({ type: 'MEO3_VIDEO_URL_RESULT', requestId, url }, '*'); return; }
    } catch(_) {}

    // Fallback: dùng <video> element để trigger và capture URL qua XHR intercept
    window.postMessage({ type: 'MEO3_VIDEO_URL_RESULT', requestId, url: redirectUrl, isRedirectUrl: true }, '*');
  } catch(err) {
    window.postMessage({ type: 'MEO3_VIDEO_URL_RESULT', requestId, error: err.message }, '*');
  }
});

// ── Debug: Capture tất cả API calls để tìm media list endpoint ──
const _origFetch2 = window.fetch;
window.fetch = async function(...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  const res = await _origFetch2.apply(this, args);
  if (url && url.includes('labs.google') && url.includes('trpc')) {
    try {
      const clone = res.clone();
      const body = await clone.json().catch(() => null);
      const json = body?.result?.data?.json;
      if (json && typeof json === 'object') {
        const keys = Object.keys(json);
        // Chỉ log khi có media/workflows/items
        if (keys.some(k => ['media','workflows','items','content','assets'].includes(k))) {
          window.postMessage({ type: 'MEO3_TRPC_MEDIA', url, keys, count: json.media?.length || json.workflows?.length || 0, data: json }, '*');
        }
      }
    } catch (_) {}
  }
  return res;
};
