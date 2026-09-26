import re
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    bg = f.read()

new_video_queue = """function enqueueServerVideoTask(task) {
  logToBridge(`[Bridge] Chuyển task video ${task.id} vào hàng đợi Đa Tab...`);
  
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

  const serverTask = { ...task, mediaType: 'video' };

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
    if line.startswith('function enqueueServerVideoTask(task) {'):
        start_idx = i
        break

if start_idx is not None:
    # We want to replace enqueueServerVideoTask AND processServerVideoQueue
    for i in range(start_idx, len(lines)):
        if '_isProcessingServerVideoQueue = false;' in lines[i]:
            end_idx = i + 1 
            break
            
    if end_idx:
        new_content = '\n'.join(lines[:start_idx]) + '\n' + new_video_queue + '\n' + '\n'.join(lines[end_idx+1:])
        with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Reverted video queue")

