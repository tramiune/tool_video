with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

# Add clear debug log in the dedup check for IMAGE
bg = bg.replace(
    """function enqueueServerImageTask(task) {
  const p = (task.prompt || '').trim();
  if (_recentBgTaskIds.has(task.id) || _recentBgPrompts.has(p)) return;""",
    """function enqueueServerImageTask(task) {
  const p = (task.prompt || '').trim();
  if (_recentBgTaskIds.has(task.id) || _recentBgPrompts.has(p)) {
    console.warn('[DEDUP] ⛔ BLOCKED duplicate image task:', task.id);
    logToBridge('[Bridge] ⛔ BLOCKED trùng lặp task ảnh ' + task.id);
    return;
  }
  console.log('[DEDUP] ✅ PASSED image task:', task.id);"""
)

# Add clear debug log in the dedup check for VIDEO
bg = bg.replace(
    """function enqueueServerVideoTask(task) {
  const p = (task.prompt || '').trim();
  if (_recentBgTaskIds.has(task.id) || _recentBgPrompts.has(p)) return;""",
    """function enqueueServerVideoTask(task) {
  const p = (task.prompt || '').trim();
  if (_recentBgTaskIds.has(task.id) || _recentBgPrompts.has(p)) {
    console.warn('[DEDUP] ⛔ BLOCKED duplicate video task:', task.id);
    logToBridge('[Bridge] ⛔ BLOCKED trùng lặp task video ' + task.id);
    return;
  }
  console.log('[DEDUP] ✅ PASSED video task:', task.id);"""
)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
    f.write(bg)
print("✅ Added debug logs")
