(function () {
  const LOG_PREFIX = '[VEO3-CaptchaExt/Content]';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, '⚠️', ...args);
  }

  function error(...args) {
    console.error(LOG_PREFIX, '❌', ...args);
  }

  log('Initializing content script...');

  function getDOMParent() {
    return document.head || document.body || document.documentElement;
  }

  function injectScript(file, retries = 5) {
    return new Promise((resolve, reject) => {
      function attemptInject(count) {
        const parent = getDOMParent();
        if (!parent) {
          if (count < retries) {
            setTimeout(() => attemptInject(count + 1), 100);
          } else {
            reject(new Error(`No DOM parent available for ${file} after ${retries} retries`));
          }
          return;
        }

        const script = document.createElement('script');
        script.src = chrome.runtime.getURL(file);
        script.type = 'text/javascript';
        parent.appendChild(script);

        script.onload = () => {
          log(`Script injected: ${file}`);
          script.remove();
          resolve();
        };

        script.onerror = () => {
          script.remove();
          if (count < retries) {
            warn(`Script ${file} load failed, retrying (${count + 1}/${retries})...`);
            setTimeout(() => attemptInject(count + 1), 100);
          } else {
            error(`Failed to inject ${file} after ${retries} attempts`);
            reject(new Error(`Failed to inject ${file}`));
          }
        };
      }
      attemptInject(0);
    });
  }

  async function init() {
    try {
      await injectScript('socket.io.min.js');
      await injectScript('injected.js');
    } catch (err) {
      error('Injection failed:', err.message);
    }
  }

  // Handle messages from the injected script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'VEO3_GET_SETTINGS_REQUEST') {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
        if (chrome.runtime.lastError) {
          warn('GET_SETTINGS error:', chrome.runtime.lastError.message);
          return;
        }
        window.postMessage({ type: 'VEO3_GET_SETTINGS_RESPONSE', settings: settings || {} }, '*');
      });
    }

    if (event.data?.type === 'VEO3_STATUS') {
      try {
        chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', data: event.data.data });
      } catch (err) {
        // Ignored
      }
    }

    if (event.data?.type === 'VEO3_RELOAD_TAB_REQUEST') {
      try {
        chrome.runtime.sendMessage({ type: 'RELOAD_FLOW_TAB' });
      } catch (err) {
        // Fallback to direct window reload
        window.location.reload();
      }
    }
  });

  // Handle messages from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'COUNTDOWN_UPDATE') {
      window.postMessage({
        type: 'VEO3_COUNTDOWN_UPDATE',
        remainingSeconds: message.remainingSeconds,
        totalSeconds: message.totalSeconds
      }, '*');
    }
    if (message.type === 'GET_PAGE_INFO') {
      sendResponse({ url: window.location.href, title: document.title });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Keep extension active
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: 'KEEPALIVE' }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (err) {}
  }, 10000);

  log('Content script ready');
})();
