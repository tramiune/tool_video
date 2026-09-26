import re

# ═══ PATCH background.js ═══
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

# Add claim registry right after _recentBgPrompts
claim_code = """const _claimedMultiTabTasks = new Set();"""
if '_claimedMultiTabTasks' not in bg:
    bg = bg.replace(
        "const _recentBgPrompts = new Set();",
        "const _recentBgPrompts = new Set();\n" + claim_code
    )

# Add CLAIM_MULTI_TAB_TASK handler in handleMessage's action map
# Find the REPORT_TASK_STARTED handler and add claim handler before it
if 'CLAIM_MULTI_TAB_TASK' not in bg:
    bg = bg.replace(
        """  REPORT_TASK_STARTED: req => {""",
        """  CLAIM_MULTI_TAB_TASK: req => {
    const tid = req.serverTaskId;
    if (_claimedMultiTabTasks.has(tid)) return { claimed: false };
    _claimedMultiTabTasks.add(tid);
    setTimeout(() => _claimedMultiTabTasks.delete(tid), 600000); // 10 min TTL
    return { claimed: true };
  },
  REPORT_TASK_STARTED: req => {"""
    )

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
    f.write(bg)
print("✅ Patched background.js with CLAIM_MULTI_TAB_TASK")


# ═══ PATCH sidepanel.js ═══
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

# Replace the ADD_SERVER_TASK_TO_MULTI_TAB handler to claim first
old_handler = '''    if (msg.action === "ADD_SERVER_TASK_TO_MULTI_TAB") {
      addServerTaskToMultiTab(msg.task).then(res => {
        sendResponse(res);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }'''

new_handler = '''    if (msg.action === "ADD_SERVER_TASK_TO_MULTI_TAB") {
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
    }'''

sp = sp.replace(old_handler, new_handler)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print("✅ Patched sidepanel.js with claim mechanism")
