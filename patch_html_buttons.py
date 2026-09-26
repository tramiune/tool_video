with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.html', 'r', encoding='utf-8') as f:
    html = f.read()

import re
# We need to find the SECOND panel (the video one) and replace BulkAi with BulkVideo in its IDs
parts = html.split('<!-- TAB: BULK VIDEO STUDIO -->')
if len(parts) == 2:
    video_panel = parts[1]
    video_panel = video_panel.replace('btnBulkAi', 'btnBulkVideo')
    video_panel = video_panel.replace('bulkAi', 'bulkVideo')
    html = parts[0] + '<!-- TAB: BULK VIDEO STUDIO -->' + video_panel

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.html', 'w', encoding='utf-8') as f:
    f.write(html)
print("Patched HTML Buttons")
