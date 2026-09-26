with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r') as f:
    js = f.read()

import re

old_func = re.search(r'async function findBulkTab\(\) \{.*?\n  \}', js, re.DOTALL).group(0)

new_func = """  async function findBulkTab() {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs[0] && activeTabs[0].url && activeTabs[0].url.includes('/tool/')) {
      return activeTabs[0];
    }
    const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    const activeToolTab = tabs.find(t => t.active && t.url && t.url.includes('/tool/'));
    if (activeToolTab) return activeToolTab;
    return tabs.find(t => t.url && t.url.includes('/tool/')) || null;
  }"""

js = js.replace(old_func, new_func)

# Fix the logging issue for Video Tab
js = js.replace("log('✅ Tab: '", "const logEl = document.getElementById('bulkVideoLog'); if(logEl) { logEl.style.display='block'; logEl.textContent += '[Sys] Tab: ' + (tab.title||'').slice(0,40) + '\\n'; } log('✅ Tab: '")

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w') as f:
    f.write(js)
print("Patched findBulkTab 2")
