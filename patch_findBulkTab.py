with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r') as f:
    js = f.read()

old_func = """  async function findBulkTab() {
    const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    return tabs.find(t => t.url && t.url.includes('/tool/')) || null;
  }"""

new_func = """  async function findBulkTab() {
    const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    const activeToolTab = tabs.find(t => t.active && t.url && t.url.includes('/tool/'));
    if (activeToolTab) return activeToolTab;
    return tabs.find(t => t.url && t.url.includes('/tool/')) || null;
  }"""

js = js.replace(old_func, new_func)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w') as f:
    f.write(js)
print("Patched findBulkTab")
