import re
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

sp = sp.replace("""async function addServerTaskToMultiTab(task) {
  if (!task) return { success: false, error: "Task rỗng" };""", """async function addServerTaskToMultiTab(task) {
  if (!task) return { success: false, error: "Task rỗng" };
  // Deduplicate across multiple sidepanels
  if (_multiTabServerTasks.some(t => t.serverTaskId === task.id)) {
    return { success: true };
  }""")

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print("Patched sidepanel dedup")
