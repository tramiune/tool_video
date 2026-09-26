import re
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

bg = bg.replace("""function enqueueServerVideoTask(task) {""", """const _recentBgTaskIds = new Set();
function enqueueServerVideoTask(task) {
  if (_recentBgTaskIds.has(task.id)) return;
  _recentBgTaskIds.add(task.id);
  setTimeout(() => _recentBgTaskIds.delete(task.id), 10000); // 10s cooldown
""")

bg = bg.replace("""function enqueueServerImageTask(task) {""", """function enqueueServerImageTask(task) {
  if (_recentBgTaskIds.has(task.id)) return;
  _recentBgTaskIds.add(task.id);
  setTimeout(() => _recentBgTaskIds.delete(task.id), 10000); // 10s cooldown
""")

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
    f.write(bg)
print("Patched background dedup")
