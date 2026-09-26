import re
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

bg = bg.replace("""const _recentBgTaskIds = new Set();""", """const _recentBgTaskIds = new Set();
const _recentBgPrompts = new Set();""")

bg = bg.replace("""function enqueueServerVideoTask(task) {
  if (_recentBgTaskIds.has(task.id)) return;
  _recentBgTaskIds.add(task.id);
  setTimeout(() => _recentBgTaskIds.delete(task.id), 10000); // 10s cooldown""", """function enqueueServerVideoTask(task) {
  const p = (task.prompt || '').trim();
  if (_recentBgTaskIds.has(task.id) || _recentBgPrompts.has(p)) return;
  _recentBgTaskIds.add(task.id);
  _recentBgPrompts.add(p);
  setTimeout(() => { _recentBgTaskIds.delete(task.id); _recentBgPrompts.delete(p); }, 10000); // 10s cooldown""")

bg = bg.replace("""function enqueueServerImageTask(task) {
  if (_recentBgTaskIds.has(task.id)) return;
  _recentBgTaskIds.add(task.id);
  setTimeout(() => _recentBgTaskIds.delete(task.id), 10000); // 10s cooldown""", """function enqueueServerImageTask(task) {
  const p = (task.prompt || '').trim();
  if (_recentBgTaskIds.has(task.id) || _recentBgPrompts.has(p)) return;
  _recentBgTaskIds.add(task.id);
  _recentBgPrompts.add(p);
  setTimeout(() => { _recentBgTaskIds.delete(task.id); _recentBgPrompts.delete(p); }, 10000); // 10s cooldown""")

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
    f.write(bg)
print("Patched prompt dedup in background")
