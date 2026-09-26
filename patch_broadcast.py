import re

# 1. Patch background.js (for processServerVideoQueue)
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

bg = bg.replace("""    // 2. Tìm tab
    const allTabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    const bulkTab = allTabs.find(t => t.url?.includes('/tool/') && (t.url.includes('mode=EDIT') || t.url.includes('mode=APP')));
    if (!bulkTab) throw new Error('Không tìm thấy tab Bulk Video Studio');

    const tabId = bulkTab.id;
    logToBridge(`[BulkVideo] Gửi ${tasks.length} task video vào tab: ${bulkTab.title?.slice(0, 40)}`);""", """    // 2. Lấy tất cả tab Tool
    const allTabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    const toolTabs = allTabs.filter(t => t.url?.includes('/tool/') && (t.url.includes('mode=EDIT') || t.url.includes('mode=APP')));
    if (toolTabs.length === 0) throw new Error('Không tìm thấy tab Tool nào đang mở');
    
    logToBridge(`[BulkVideo] Gửi ${tasks.length} task video broadcast tới ${toolTabs.length} tabs...`);""")

bg = bg.replace("""    // 4. Inject interceptor
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: function() {
        if (window.__bulkStatusInterceptorActive) return;
        window.__bulkStatusInterceptorActive = true;
        window.__bulkStatusData = null;
        window.addEventListener('message', function(e) {
          if (e.data && (e.data.type === 'BULK_STATUS_UPDATE' || e.data.type === 'BULK_DONE')) {
            window.__bulkStatusData = e.data;
          }
        });
      }
    });

    // 5. Gửi lệnh
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      args: [promptLines],
      func: function(prompts) {
        window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*');
        document.querySelectorAll('iframe').forEach(function(f) {
          try { f.contentWindow && f.contentWindow.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*'); } catch(_) {}
        });
      }
    });""", """    // 4 & 5. Inject & Broadcast tới TẤT CẢ tool tabs
    for (const t of toolTabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: false },
          world: 'MAIN',
          func: function() {
            if (!window.__bulkStatusInterceptorActive) {
              window.__bulkStatusInterceptorActive = true;
              window.__bulkStatusData = null;
              window.addEventListener('message', function(e) {
                if (e.data && (e.data.type === 'BULK_STATUS_UPDATE' || e.data.type === 'BULK_DONE')) {
                  window.__bulkStatusData = e.data;
                }
              });
            }
          }
        });
        await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: false },
          world: 'MAIN',
          args: [promptLines],
          func: function(prompts) {
            window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*');
            document.querySelectorAll('iframe').forEach(function(f) {
              try { f.contentWindow && f.contentWindow.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*'); } catch(_) {}
            });
          }
        });
      } catch (err) {}
    }""")

bg = bg.replace("""        try {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            world: 'MAIN',
            func: function() { const d = window.__bulkStatusData; window.__bulkStatusData = null; return d; }
          });""", """        try {
          // Chỉ cần tìm xem tab nào có status update
          let data = null;
          for (const t of toolTabs) {
            try {
              const [res] = await chrome.scripting.executeScript({
                target: { tabId: t.id, allFrames: false },
                world: 'MAIN',
                func: function() { const d = window.__bulkStatusData; window.__bulkStatusData = null; return d; }
              });
              if (res?.result) { data = res.result; break; }
            } catch(e) {}
          }""")

# Comment out the old processServerVideoQueue entirely
old_video_queue = re.search(r'async function processServerVideoQueue\(\) \{\n  if \(_isProcessingServerQueue.*?_isProcessingServerQueue = false;\n\}', bg, re.DOTALL)
if old_video_queue:
    bg = bg.replace(old_video_queue.group(0), '/* OLD DOM PROCESS VIDEO QUEUE REMOVED */')

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
    f.write(bg)
print("Patched background.js broadcast")


# 2. Patch sidepanel.js (for Image Tool)
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

sp = sp.replace("""  async function findBulkTab() {
    let tabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    let toolTabs = tabs.filter(t => t.url && t.url.includes('/tool/') && (t.url.includes('mode=EDIT') || t.url.includes('mode=APP')));
    if (toolTabs.length === 0) return null;
    
    // Ưu tiên tab đang active (nếu user đang xem tab đó)
    let activeTabs = await chrome.tabs.query({ active: true });
    let activeToolTab = activeTabs.find(at => toolTabs.some(tt => tt.id === at.id));
    if (activeToolTab) return activeToolTab;
    
    // Nếu không có tab active, lấy tab đầu tiên
    return toolTabs[0];
  }""", """  async function findBulkTab() {
    let tabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    let toolTabs = tabs.filter(t => t.url && t.url.includes('/tool/') && (t.url.includes('mode=EDIT') || t.url.includes('mode=APP')));
    if (toolTabs.length === 0) return null;
    return toolTabs; // Trả về mảng để broadcast
  }""")

# Patch pasteAndRun
sp = sp.replace("""  async function pasteAndRun(tabId, promptsText) {
    const prompts = promptsText.split('\\n').map(l => l.trim()).filter(Boolean);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      args: [prompts],
      func: function(prompts) {
        window.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');
        var iframeCount = 0;
        document.querySelectorAll('iframe').forEach(function(iframe) {
          try { iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*'); iframeCount++; } catch(_) {}
        });
        return { ok: true, prompts: prompts.length, iframes: iframeCount };
      },
    });
    return res && res.result;
  }""", """  async function pasteAndRun(tabOrTabs, promptsText) {
    const prompts = promptsText.split('\\n').map(l => l.trim()).filter(Boolean);
    let tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs];
    let lastRes = null;
    for (const t of tabs) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: typeof t === 'object' ? t.id : t, allFrames: false },
          world: 'MAIN',
          args: [prompts],
          func: function(prompts) {
            window.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');
            var iframeCount = 0;
            document.querySelectorAll('iframe').forEach(function(iframe) {
              try { iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*'); iframeCount++; } catch(_) {}
            });
            return { ok: true, prompts: prompts.length, iframes: iframeCount };
          },
        });
        if (res && res.result) lastRes = res.result;
      } catch (err) {}
    }
    return lastRes;
  }""")

# Patch pasteAndRunVideo
sp = sp.replace("""  async function pasteAndRunVideo(tabId, promptsText) {
    const prompts = promptsText.split('\\n').map(l => l.trim()).filter(Boolean);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      args: [prompts],
      func: function(prompts) {
        window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*');
        var iframeCount = 0;
        document.querySelectorAll('iframe').forEach(function(iframe) {
          try { iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*'); iframeCount++; } catch(_) {}
        });
        return { ok: true, prompts: prompts.length, iframes: iframeCount };
      },
    });
    return res && res.result;
  }""", """  async function pasteAndRunVideo(tabOrTabs, promptsText) {
    const prompts = promptsText.split('\\n').map(l => l.trim()).filter(Boolean);
    let tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs];
    let lastRes = null;
    for (const t of tabs) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: typeof t === 'object' ? t.id : t, allFrames: false },
          world: 'MAIN',
          args: [prompts],
          func: function(prompts) {
            window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*');
            var iframeCount = 0;
            document.querySelectorAll('iframe').forEach(function(iframe) {
              try { iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*'); iframeCount++; } catch(_) {}
            });
            return { ok: true, prompts: prompts.length, iframes: iframeCount };
          },
        });
        if (res && res.result) lastRes = res.result;
      } catch(e) {}
    }
    return lastRes;
  }""")

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print("Patched sidepanel.js broadcast")
