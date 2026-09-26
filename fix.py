with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r') as f:
    js = f.read()

js = js.replace('});\\n\\n    document.getElementById("btnBulkVideoClearLog")', '});\n\n    document.getElementById("btnBulkVideoClearLog")')

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w') as f:
    f.write(js)
