with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

# Fix: make CLAIM_MULTI_TAB_TASK async so handleMessage's .then() works
bg = bg.replace(
    """  CLAIM_MULTI_TAB_TASK: req => {
    const tid = req.serverTaskId;
    if (_claimedMultiTabTasks.has(tid)) return { claimed: false };
    _claimedMultiTabTasks.add(tid);
    setTimeout(() => _claimedMultiTabTasks.delete(tid), 600000); // 10 min TTL
    return { claimed: true };
  },""",
    """  CLAIM_MULTI_TAB_TASK: async (req) => {
    const tid = req.serverTaskId;
    if (_claimedMultiTabTasks.has(tid)) return { claimed: false };
    _claimedMultiTabTasks.add(tid);
    setTimeout(() => _claimedMultiTabTasks.delete(tid), 600000);
    return { claimed: true };
  },"""
)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
    f.write(bg)
print("✅ Fixed CLAIM handler to async")

# Now re-add claim mechanism in sidepanel
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

sp = sp.replace(
    '''    if (msg.action === "ADD_SERVER_TASK_TO_MULTI_TAB") {
      addServerTaskToMultiTab(msg.task).then(res => {
        sendResponse(res);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }''',
    '''    if (msg.action === "ADD_SERVER_TASK_TO_MULTI_TAB") {
      chrome.runtime.sendMessage(
        { action: 'CLAIM_MULTI_TAB_TASK', serverTaskId: msg.task.id },
        function(resp) {
          if (chrome.runtime.lastError) {
            addServerTaskToMultiTab(msg.task).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
            return;
          }
          if (resp && resp.claimed) {
            addServerTaskToMultiTab(msg.task).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
          } else {
            console.log('[MultiTab] Skipped duplicate task (claimed by another panel):', msg.task.id);
            sendResponse({ success: true, skipped: true });
          }
        }
      );
      return true;
    }'''
)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print("✅ Re-added claim mechanism in sidepanel")
