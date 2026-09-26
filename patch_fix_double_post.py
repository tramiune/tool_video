with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

# 1. Revert the claim mechanism - restore original handler
sp = sp.replace(
    '''    if (msg.action === "ADD_SERVER_TASK_TO_MULTI_TAB") {
      // Claim task from background first — only 1 sidepanel wins
      chrome.runtime.sendMessage(
        { action: 'CLAIM_MULTI_TAB_TASK', serverTaskId: msg.task.id },
        function(resp) {
          if (resp && resp.claimed) {
            addServerTaskToMultiTab(msg.task).then(res => {
              sendResponse(res);
            }).catch(err => {
              sendResponse({ success: false, error: err.message });
            });
          } else {
            sendResponse({ success: true, skipped: true });
          }
        }
      );
      return true;
    }''',
    '''    if (msg.action === "ADD_SERVER_TASK_TO_MULTI_TAB") {
      addServerTaskToMultiTab(msg.task).then(res => {
        sendResponse(res);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }'''
)

# 2. FIX THE REAL BUG: Remove the window.postMessage, keep ONLY iframe direct send
sp = sp.replace(
    """      func: function(msgType, line) {
        if (!window.__extProcessedTasks) window.__extProcessedTasks = new Set();
        if (window.__extProcessedTasks.has(line)) return;
        window.__extProcessedTasks.add(line);
        window.postMessage({ type: msgType, prompts: [line] }, '*');
        document.querySelectorAll('iframe').forEach(function(f) {
          try { f.contentWindow && f.contentWindow.postMessage({ type: msgType, prompts: [line] }, '*'); } catch(_) {}
        });
      }""",
    """      func: function(msgType, line) {
        var sent = false;
        document.querySelectorAll('iframe').forEach(function(f) {
          try { if (f.contentWindow) { f.contentWindow.postMessage({ type: msgType, prompts: [line] }, '*'); sent = true; } } catch(_) {}
        });
        if (!sent) window.postMessage({ type: msgType, prompts: [line] }, '*');
      }"""
)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print("✅ Fixed: removed double postMessage, now only sends to iframe directly")
