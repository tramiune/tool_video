import re

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Add the queue variables if not present
if "const _serverVideoQueue = [];" not in content:
    content = content.replace(
        "const _serverImageQueue = [];\nlet _isProcessingServerImageQueue = false;",
        "const _serverImageQueue = [];\nlet _isProcessingServerImageQueue = false;\nconst _serverVideoQueue = [];\nlet _isProcessingServerVideoQueue = false;"
    )

new_func = '''function enqueueServerVideoTask(task) {
  logToBridge(`[BulkVideo] Nhận task video ${task.id} — đẩy vào queue Bulk Video Studio...`);
  _serverVideoQueue.push(task);
  processServerVideoQueue();
}

async function processServerVideoQueue() {
  if (_isProcessingServerVideoQueue || !_serverVideoQueue.length) return;
  _isProcessingServerVideoQueue = true;

  const tasks = [];
  while (_serverVideoQueue.length > 0) tasks.push(_serverVideoQueue.shift());

  try {
    // 1. Format STT
    for (const task of tasks) {
      let prompt = (task.prompt || '').trim();
      let seqStr = '';
      const matchSeq = prompt.match(/^(\\d{1,4})[\\.\\-_:\\s]/);
      if (matchSeq) {
        const num = parseInt(matchSeq[1], 10);
        seqStr = String(num).padStart(3, '0') + '.';
        prompt = prompt.replace(/^(\\d{1,4})[\\.\\-_:\\s]\\s*/, `${seqStr} `);
      } else if (task.sceneIndex !== undefined && task.sceneIndex !== null && !isNaN(Number(task.sceneIndex))) {
        const num = Number(task.sceneIndex) + 1;
        seqStr = String(num).padStart(3, '0') + '.';
        prompt = `${seqStr} ${prompt}`;
        await updateMaxSeq(task.projectId, num, 'video');
      } else {
        const seqRes = await getMaxSeq(task.projectId, 'video');
        const nextSeq = (seqRes?.maxSeq || 0) + 1;
        await updateMaxSeq(task.projectId, nextSeq, 'video');
        seqStr = String(nextSeq).padStart(3, '0') + '.';
        prompt = `${seqStr} ${prompt}`;
      }
      task.prompt = prompt;
      task.seq = seqStr;
      task._stt = seqStr.replace('.', '').trim(); 
    }

    // 2. Tìm tab
    const allTabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
    const bulkTab = allTabs.find(t => t.url?.includes('/tool/') && (t.url.includes('mode=EDIT') || t.url.includes('mode=APP')));
    if (!bulkTab) throw new Error('Không tìm thấy tab Bulk Video Studio');

    const tabId = bulkTab.id;
    logToBridge(`[BulkVideo] Gửi ${tasks.length} task video vào tab: ${bulkTab.title?.slice(0, 40)}`);

    // 3. Format lines
    const promptLines = tasks.map(t => {
      const r = t.aspectRatio || '9:16';
      
      // Xử lý link ảnh
      let imgs = '';
      let refImages = [];
      if (Array.isArray(t.referenceImages) && t.referenceImages.length > 0) {
        refImages = t.referenceImages.filter(Boolean);
      } else if (t.referenceImage) {
        refImages = [t.referenceImage];
      } else if (t.startImage) {
        refImages = [t.startImage];
        if (t.endImage) refImages.push(t.endImage);
      }
      if (refImages.length > 0) {
        imgs = '|' + refImages.join('|');
      }

      return `${r}|${t.prompt}${imgs}`;
    });

    // 4. Inject interceptor
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: function() {
        if (window.__bulkStatusInterceptorActive) return;
        window.__bulkStatusInterceptorActive = true;
        window.__bulkStatusData = null;
        window.addEventListener('message', function(e) {
          if (e.data && (e.data.type === 'BULK_STATUS_UPDATE' || e.data.type === 'BULK_DONE')) {
            window.__bulkStatusData = e.data;
          }
        });
      }
    });

    // 5. Gửi lệnh
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      args: [promptLines],
      func: function(prompts) {
        window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*');
        document.querySelectorAll('iframe').forEach(function(f) {
          try { f.contentWindow && f.contentWindow.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*'); } catch(_) {}
        });
      }
    });
    logToBridge(`[BulkVideo] Đã gửi ${promptLines.length} prompts.`);

    const sttMap = {};
    tasks.forEach(t => { sttMap[t._stt] = t; });
    const doneStt = new Set();
    const MAX_WAIT = 20 * 60 * 1000; // 20 phút cho video
    const POLL_INTERVAL = 2000;
    const startTime = Date.now();

    await new Promise((resolve) => {
      const timer = setInterval(async () => {
        if (Date.now() - startTime > MAX_WAIT) {
          clearInterval(timer);
          for (const t of tasks) {
            if (!doneStt.has(t._stt)) {
              if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
                _toolWs.send(JSON.stringify({ type: 'VIDEO_RESULT', id: t.id, ok: false, error: 'Timeout 20 phút' }));
              }
            }
          }
          resolve();
          return;
        }
        try {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            world: 'MAIN',
            func: function() { const d = window.__bulkStatusData; window.__bulkStatusData = null; return d; }
          });
          const data = res?.result;
          if (!data || data.type !== 'BULK_STATUS_UPDATE' || !data.tasks) return;
          for (const toolTask of data.tasks) {
            const stt = (toolTask.stt || '').split('.')[0]?.trim();
            if (!stt || doneStt.has(stt)) continue;
            const origTask = sttMap[stt];
            if (!origTask) continue;
            if (toolTask.status === 'completed') {
              doneStt.add(stt);
              logToBridge(`✅ Task video ${origTask.id} (STT ${stt}) xong!`);
              if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
                _toolWs.send(JSON.stringify({ type: 'VIDEO_RESULT', id: origTask.id, filePath: `${stt}.mp4`, ok: true }));
              }
            } else if (toolTask.status === 'error') {
              doneStt.add(stt);
              logToBridge(`❌ Task video ${origTask.id} lỗi`);
              if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
                _toolWs.send(JSON.stringify({ type: 'VIDEO_RESULT', id: origTask.id, ok: false, error: toolTask.error || 'Tool error' }));
              }
            }
          }
          if (doneStt.size >= tasks.length) {
            clearInterval(timer);
            resolve();
          }
        } catch (_) {}
      }, POLL_INTERVAL);
    });

  } catch (err) {
    logToBridge(`❌ Lỗi BulkVideo: ${err.message}`);
    for (const t of tasks) {
      if (_toolWs && _toolWs.readyState === WebSocket.OPEN) {
        _toolWs.send(JSON.stringify({ type: 'VIDEO_RESULT', id: t.id, ok: false, error: err.message }));
      }
    }
  }

  _isProcessingServerVideoQueue = false;
}
'''

# Find old enqueueServerVideoTask
start_idx = None
end_idx = None
lines = content.split('\n')
for i, line in enumerate(lines):
    if line.startswith('async function enqueueServerVideoTask(task) {'):
        start_idx = i
        break

if start_idx is not None:
    depth = 0
    for i in range(start_idx, len(lines)):
        for ch in lines[i]:
            if ch == '{': depth += 1
            elif ch == '}': depth -= 1
        if depth == 0 and i > start_idx:
            end_idx = i
            break
            
    if end_idx:
        new_content = '\n'.join(lines[:start_idx]) + '\n' + new_func + '\n' + '\n'.join(lines[end_idx+1:])
        with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/background.js', 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Patched background.js")
