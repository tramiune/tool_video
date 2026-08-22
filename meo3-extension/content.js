// Guard chống inject nhiều lần
if (!window.__meo3Injected) {
  window.__meo3Injected = true;

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_) {}
  }

  // Inject interceptor vào MAIN world
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('interceptor.js');
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  // Lắng nghe từ MAIN world
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.type === 'MEO3_MEDIA_URL_CACHED')
      safeSend({ type: 'CACHE_MEDIA_URL', mediaId: e.data.mediaId, url: e.data.url, isThumb: e.data.isThumb });
    if (e.data?.type === 'MEO3_TOKEN' && e.data.token)
      safeSend({ type: 'STORE_TOKEN', token: e.data.token });
    if (e.data?.type === 'MEO3_CAPTCHA_RESULT')
      safeSend({ type: 'CAPTCHA_RESULT', requestId: e.data.requestId, token: e.data.token, error: e.data.error });
    if (e.data?.type === 'MEO3_VIDEO_URL_RESULT')
      safeSend({ type: 'VIDEO_URL_RESULT', requestId: e.data.requestId, url: e.data.url, error: e.data.error });
  });

  // Nhận message từ background — bọc try/catch để tránh crash khi extension reload
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'SOLVE_CAPTCHA') {
        window.postMessage({ type: 'MEO3_SOLVE_CAPTCHA', requestId: msg.requestId, action: msg.action }, '*');
      }
      if (msg.type === 'FETCH_FROM_PAGE') {
        fetch(msg.url, { credentials: 'include', redirect: 'follow', headers: { Accept: 'application/json, */*' } })
          .then(async res => {
            const finalUrl = res.url;
            if (finalUrl && !finalUrl.includes('labs.google') && !finalUrl.includes('getMediaUrlRedirect')) {
              sendResponse({ url: finalUrl }); return;
            }
            try {
              const body = await res.json();
              const url = body?.result?.data?.json?.url || body?.url || body?.redirectUrl || null;
              sendResponse({ url, debug: { status: res.status, finalUrl } });
            } catch (e) {
              sendResponse({ url: null, debug: { status: res.status, finalUrl, err: e.message } });
            }
          })
          .catch(e => sendResponse({ error: e.message }));
        return true;
      }
      if (msg.type === 'CAPTURE_VIDEO_URL') {
        window.postMessage({ type: 'MEO3_CAPTURE_VIDEO', requestId: msg.requestId, mediaId: msg.mediaId }, '*');
      }
    });
  } catch (e) {
    // chrome.runtime bị invalidate — reload tự động nếu user F5
    console.warn('[Meo3] Extension context invalidated, please reload page');
  }
}
