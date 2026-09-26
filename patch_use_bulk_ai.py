with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

# 1. Expose pasteAndRun and pasteAndRunVideo to window scope
sp = sp.replace(
    "  async function pasteAndRun(tabId, promptsText) {",
    "  window._bulkPasteAndRun = pasteAndRun;\n  async function pasteAndRun(tabId, promptsText) {"
)
sp = sp.replace(
    "  async function pasteAndRunVideo(tabOrTabs, promptsText) {",
    "  window._bulkPasteAndRunVideo = pasteAndRunVideo;\n  async function pasteAndRunVideo(tabOrTabs, promptsText) {"
)

# 2. Replace the executeScript injection in runMultiTabServerWorker 
#    with a direct call to the Bulk AI functions
old_inject = """    let line;
    if (task.mediaType === 'video') {
      line = `${ratio}|${fullPrompt}`;
      if (refImages.length > 0) line += '|' + refImages.join('|');
    } else {
      // Image: gửi format giống user gõ tay trên Extension (không có ratio|)
      line = fullPrompt;
      if (refImages.length > 0) line += '|' + refImages.join('|');
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.tabId, allFrames: false },
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

    const msgType = task.mediaType === 'video' ? 'BULK_ADD_VIDEO_TASKS' : 'BULK_ADD_TASKS';
    await chrome.scripting.executeScript({
      target: { tabId: tab.tabId, allFrames: false },
      world: 'MAIN',
      args: [msgType, line],
      func: function(msgType, line) {
        var sent = false;
        document.querySelectorAll('iframe').forEach(function(f) {
          try { if (f.contentWindow) { f.contentWindow.postMessage({ type: msgType, prompts: [line] }, '*'); sent = true; } } catch(_) {}
        });
        if (!sent) window.postMessage({ type: msgType, prompts: [line] }, '*');
      }
    });"""

new_inject = """    let line;
    if (task.mediaType === 'video') {
      line = `${ratio}|${fullPrompt}`;
      if (refImages.length > 0) line += '|' + refImages.join('|');
    } else {
      line = fullPrompt;
      if (refImages.length > 0) line += '|' + refImages.join('|');
    }

    // Inject status interceptor
    await chrome.scripting.executeScript({
      target: { tabId: tab.tabId, allFrames: false },
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

    // Gửi task qua ĐÚNG hàm Bulk AI (giống y hệt khi user bấm tay trên Extension)
    if (task.mediaType === 'video' && window._bulkPasteAndRunVideo) {
      await window._bulkPasteAndRunVideo(tab.tabId, line);
    } else if (window._bulkPasteAndRun) {
      await window._bulkPasteAndRun(tab.tabId, line);
    } else {
      // Fallback nếu Bulk AI chưa init
      const msgType = task.mediaType === 'video' ? 'BULK_ADD_VIDEO_TASKS' : 'BULK_ADD_TASKS';
      await chrome.scripting.executeScript({
        target: { tabId: tab.tabId, allFrames: false },
        world: 'MAIN',
        args: [msgType, line],
        func: function(msgType, line) {
          var sent = false;
          document.querySelectorAll('iframe').forEach(function(f) {
            try { if (f.contentWindow) { f.contentWindow.postMessage({ type: msgType, prompts: [line] }, '*'); sent = true; } } catch(_) {}
          });
          if (!sent) window.postMessage({ type: msgType, prompts: [line] }, '*');
        }
      });
    }"""

sp = sp.replace(old_inject, new_inject)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print("✅ runMultiTabServerWorker now uses Bulk AI's pasteAndRun/pasteAndRunVideo")
