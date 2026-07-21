const DEFAULT_SETTINGS = {
  serverUrl: 'http://127.0.0.1:3456',
  clearGrecaptcha: false
};

let currentSettings = { ...DEFAULT_SETTINGS };

chrome.storage.local.get('settings', (res) => {
  if (res.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...res.settings };
    
    // Normalize localhost to 127.0.0.1
    if (currentSettings.serverUrl && currentSettings.serverUrl.includes('localhost')) {
      currentSettings.serverUrl = currentSettings.serverUrl.replace('localhost', '127.0.0.1');
      chrome.storage.local.set({ settings: currentSettings });
      console.log('[VEO3-BG] Migrated serverUrl localhost -> 127.0.0.1');
    }
    
    // Normalize port to 3456
    if (currentSettings.serverUrl && (currentSettings.serverUrl.includes(':3000') || currentSettings.serverUrl.includes(':3001'))) {
      currentSettings.serverUrl = currentSettings.serverUrl.replace(/:300[01]/, ':3456');
      chrome.storage.local.set({ settings: currentSettings });
      console.log('[VEO3-BG] Migrated serverUrl port -> 3456');
    }
    console.log('[VEO3-BG] Loaded settings:', currentSettings);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SETTINGS') {
    // Force port 3456 if not set correctly
    if (currentSettings.serverUrl && !currentSettings.serverUrl.includes(':3456')) {
      currentSettings.serverUrl = 'http://127.0.0.1:3456';
      chrome.storage.local.set({ settings: currentSettings });
    }
    sendResponse(currentSettings);
    return true; // Keep message channel open for async response
  }
  
  if (message.type === 'SAVE_SETTINGS') {
    currentSettings = { ...DEFAULT_SETTINGS, ...message.settings };
    chrome.storage.local.set({ settings: currentSettings });
    sendResponse({ ok: true });
    return true;
  }
  
  if (message.type === 'STATUS_UPDATE') {
    // Optional status logging
    return false;
  }

  if (message.type === 'RELOAD_FLOW_TAB') {
    chrome.tabs.query({ url: "https://labs.google/*" }, (tabs) => {
      if (tabs && tabs.length > 0) {
        tabs.forEach((tab) => {
          console.log('[VEO3-BG] Reloading Google Flow tab:', tab.id, tab.url);
          chrome.tabs.reload(tab.id);
        });
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'EXTRACT_COOKIES') {
    Promise.all([
      new Promise(res => chrome.cookies.getAll({ url: "https://labs.google/fx/vi/tools/flow" }, res)),
      new Promise(res => chrome.cookies.getAll({ domain: "labs.google" }, res)),
      new Promise(res => chrome.cookies.getAll({ domain: "google.com" }, res)),
      new Promise(res => chrome.cookies.getAll({ domain: "googleapis.com" }, res))
    ]).then(results => {
      const allCookies = [].concat(...results.map(r => r || []));
      const map = new Map();
      allCookies.forEach(c => {
        const key = `${c.name}:${c.domain}:${c.path}`;
        if (!map.has(key)) map.set(key, c);
      });
      const uniqueCookies = Array.from(map.values());
      const formatted = uniqueCookies.map(c => ({
        domain: c.domain,
        expirationDate: c.expirationDate || undefined,
        hostOnly: c.hostOnly || false,
        httpOnly: c.httpOnly || false,
        name: c.name,
        path: c.path || "/",
        sameSite: c.sameSite === 'no_restriction' ? 'no_restriction' : (c.sameSite === 'lax' ? 'lax' : (c.sameSite === 'strict' ? 'strict' : 'unspecified')),
        secure: c.secure || false,
        session: c.session || false,
        storeId: c.storeId || "0",
        value: c.value
      }));
      console.log(`[VEO3-BG] Extracted ${formatted.length} active cookies (Cookie-Editor format) from Chrome browser`);
      sendResponse({ cookies: formatted });
    });
    return true;
  }
});
