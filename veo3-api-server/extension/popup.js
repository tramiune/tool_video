let SERVER = 'http://127.0.0.1:3456';

chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
  if (chrome.runtime.lastError || !settings?.serverUrl) return;
  SERVER = settings.serverUrl;
  
  const inputUrl = document.getElementById('input-url');
  if (inputUrl) {
    inputUrl.value = SERVER;
  }
  
  const footer = document.querySelector('.footer');
  if (footer) {
    try {
      const url = new URL(SERVER);
      footer.textContent = 'labs.google/fx/vi/tools/flow → port ' + (url.port || '80');
    } catch (e) {}
  }
  checkHealth();
});

function setStatus(dotId, statusId, color, text) {
  const dot = document.getElementById(dotId);
  const status = document.getElementById(statusId);
  if (dot) {
    dot.className = 'dot';
    if (color) dot.classList.add(color);
  }
  if (status) {
    status.textContent = text;
  }
}

async function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(SERVER + '/health', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const count = data.connectedClients ?? 0;
    setStatus(
      'server-dot',
      'server-status',
      'green',
      count > 0 ? `${count} client(s)` : '0 clients — open Chrome!'
    );
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      setStatus('server-dot', 'server-status', 'yellow', 'Timeout');
    } else {
      setStatus('server-dot', 'server-status', 'red', 'Not running');
    }
  }
}

function checkPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      setStatus('page-dot', 'page-status', 'yellow', 'No tab access');
      return;
    }
    const activeTab = tabs && tabs[0];
    if (!activeTab) {
      setStatus('page-dot', 'page-status', 'yellow', 'No active tab');
      return;
    }
    if (activeTab.url && activeTab.url.includes('labs.google')) {
      setStatus('page-dot', 'page-status', 'green', '✅ labs.google');
    } else {
      setStatus('page-dot', 'page-status', 'yellow', 'Open labs.google!');
    }
  });
}

document.getElementById('btn-test').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test');
  btn.textContent = '⏳ Solving...';
  btn.disabled = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(SERVER + '/captcha?action=IMAGE_GENERATION', { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (data.captcha) {
      btn.textContent = '✅ ' + data.captcha.substring(0, 8) + '...';
    } else {
      btn.textContent = '❌ ' + (data.error || 'No token');
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      btn.textContent = '❌ Timeout (30s)';
    } else {
      btn.textContent = '❌ ' + err.message;
    }
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = '🧪 Test Captcha';
    }, 3000);
  }
});

document.getElementById('btn-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh');
  try {
    await fetch(SERVER + '/force-refresh', { method: 'POST' });
    btn.textContent = '✅ Refreshed';
  } catch (e) {
    btn.textContent = '❌ Error';
  } finally {
    setTimeout(() => {
      btn.textContent = '🔄 Force Refresh';
    }, 2000);
  }
});

document.getElementById('btn-save').addEventListener('click', () => {
  const inputUrl = document.getElementById('input-url');
  if (!inputUrl) return;
  const newUrl = inputUrl.value.trim();
  if (!newUrl) return;

  chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: { serverUrl: newUrl }
  }, (res) => {
    if (res?.ok) {
      const btnSave = document.getElementById('btn-save');
      btnSave.textContent = '✅';
      btnSave.style.background = '#22c55e';
      setTimeout(() => {
        btnSave.textContent = 'Lưu';
        btnSave.style.background = '';
        location.reload();
      }, 1000);
    }
  });
});

checkHealth();
checkPage();
setInterval(checkHealth, 5000);
setInterval(checkPage, 3000);
