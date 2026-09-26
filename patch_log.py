with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r') as f:
    js = f.read()

import re

# Add logVideo function
log_video_func = """  function logVideo(msg) {
    const el = document.getElementById('bulkVideoLog');
    if (el) {
      el.style.display = 'block';
      el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\\n`;
      el.scrollTop = el.scrollHeight;
    }
  }
"""
js = js.replace('  function log(msg) {', log_video_func + '  function log(msg) {')

# Replace log( with logVideo( inside btnBulkVideoPasteRun block
video_paste_block = re.search(r"document\.getElementById\('btnBulkVideoPasteRun'\).*?}\);", js, re.DOTALL)
if video_paste_block:
    modified_block = video_paste_block.group(0).replace("log(", "logVideo(")
    js = js.replace(video_paste_block.group(0), modified_block)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w') as f:
    f.write(js)
print("Patched logVideo")
