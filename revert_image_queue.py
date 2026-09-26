import re
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

new_image_queue = """function enqueueServerImageTask(task) {
  logToBridge(`[Bridge] Chuyển task ảnh ${task.id} vào hàng đợi Đa Tab...`);
  
  let prompt = (task.prompt || '').trim();
  let seqStr = '';
  const matchSeq = prompt.match(/^(\\d{1,4})[\\.\\-_:\\s]/);
  if (matchSeq) {
    const num = parseInt(matchSeq[1], 10);
    seqStr = String(num).padStart(3, '0') + '.';
    prompt = prompt.replace(/^(\\d{1,4})[\\.\\-_:\\s]\\s*/, `${seqStr} `);
  } else {
    seqStr = Date.now().toString().slice(-4) + '.';
    prompt = `${seqStr} ${prompt}`;
  }
  task.prompt = prompt;
  task.seq = seqStr;

  const serverTask = { ...task, mediaType: 'image' };

  chrome.runtime.sendMessage({
    action: 'ADD_SERVER_TASK_TO_MULTI_TAB',
    task: serverTask
  }).catch(() => {});
}
"""

start_idx = None
end_idx = None
lines = bg.split('\n')

for i, line in enumerate(lines):
    if line.startswith('function enqueueServerImageTask(task) {'):
        start_idx = i
        break

if start_idx is not None:
    # We want to replace enqueueServerImageTask AND processServerImageQueue
    for i in range(start_idx, len(lines)):
        if '_isProcessingServerImageQueue = false;' in lines[i]:
            end_idx = i + 1 # include the closing brace line
            break
            
    if end_idx:
        new_content = '\n'.join(lines[:start_idx]) + '\n' + new_image_queue + '\n' + '\n'.join(lines[end_idx+1:])
        with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Reverted image queue")

