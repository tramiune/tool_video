with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r') as f:
    js = f.read()

old_list2 = """      } else if (msg?.action === 'BULK_STATUS_UPDATE') {
        const tasks = msg.tasks || [];
        const listEl = document.getElementById('bulkTaskList');
        const summaryEl = document.getElementById('bulkTaskSummary');
        const badge = document.getElementById('bulkAiStatusBadge');
        if (!listEl) return;"""

new_list2 = """      } else if (msg?.action === 'BULK_STATUS_UPDATE') {
        const tasks = msg.tasks || [];
        renderTaskList(tasks);
        return;"""

js = js.replace(old_list2, new_list2)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w') as f:
    f.write(js)
print("Patched listener")
