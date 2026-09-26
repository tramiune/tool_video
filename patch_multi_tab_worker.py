import re

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    js = f.read()

new_func = """async function runMultiTabServerWorker(task, tab) {
  const logEl = task.mediaType === 'video' 
    ? (document.getElementById('multiTabCreateLog') || document.getElementById('multiTabImgLog'))
    : (document.getElementById('multiTabImgLog') || document.getElementById('multiTabCreateLog'));

  const log = (msg) => {
    const t = new Date().toLocaleTimeString();
    if (logEl) {
      logEl.style.display = 'block';
      logEl.textContent += `[${t}] [Tab ${tab.index + 1}] ${msg}\\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  // Format STT
  const stt = task.seq ? task.seq.replace('.', '').trim() : Date.now().toString().slice(-4);
  let prompt = (task.prompt || '').trim();
  prompt = prompt.replace(/^(\\d{1,4})[\\.\\-_:\\s]\\s*/, '');
  const fullPrompt = `${stt}. ${prompt}`;
  log(`🚀 Bắt đầu xử lý task #${task.id} (${task.mediaType === 'video' ? 'Video' : 'Ảnh'}): "${fullPrompt.slice(0, 40)}..."`);

  try {
    task.statusDetail = 'Đang submit vào Custom UI...';
    renderMultiTabServerTasksUI();

    const ratio = task.aspectRatio || (task.mediaType === 'video' ? '9:16' : '1:1');
    let refImages = [];
    if (Array.isArray(task.referenceImages) && task.referenceImages.length > 0) {
      refImages = task.referenceImages.filter(Boolean);
    } else if (task.referenceImage) {
      refImages = [task.referenceImage];
    } else if (task.startImage) {
      refImages = [task.startImage];
      if (task.endImage) refImages.push(task.endImage);
    }
    
    let line = `${ratio}|${fullPrompt}`;
    if (refImages.length > 0) line += '|' + refImages.join('|');

    await chrome.scripting.executeScript({
      target: { tabId: tab.tabId, allFrames: false },
      world: 'MAIN',
      func: function() {
        if (!window.__bulkStatusInterceptorActive) {
          window.__bulkStatusInterceptorActive = true;
          window.__bulkStatusData = null;
          window.addEventListener('message', function(e) {
            if (e.data && (e.data.type === 'BULK_STATUS_UPDATE' || e.data.type === 'BULK_DONE')) {
              window.__bulkStatusData = e.data;
            }
          });
        }
      }
    });

    const msgType = task.mediaType === 'video' ? 'BULK_ADD_VIDEO_TASKS' : 'BULK_ADD_TASKS';
    await chrome.scripting.executeScript({
      target: { tabId: tab.tabId, allFrames: false },
      world: 'MAIN',
      args: [msgType, line],
      func: function(msgType, line) {
        window.postMessage({ type: msgType, prompts: [line] }, '*');
        document.querySelectorAll('iframe').forEach(function(f) {
          try { f.contentWindow && f.contentWindow.postMessage({ type: msgType, prompts: [line] }, '*'); } catch(_) {}
        });
      }
    });

    task.status = 'RENDERING';
    task.statusDetail = '⏳ Đang render...';
    renderMultiTabServerTasksUI();
    log(`✅ Đã gửi lệnh. Chờ kết quả...`);

    if (task.serverTaskId) {
      chrome.runtime.sendMessage({ action: 'REPORT_TASK_STARTED', id: task.serverTaskId }).catch(() => {});
    }

    const startTime = Date.now();
    const MAX_WAIT = (task.mediaType === 'video' ? 15 : 5) * 60 * 1000;
    
    let isDone = false;
    let finalError = null;

    while (Date.now() - startTime < MAX_WAIT) {
      await new Promise(r => setTimeout(r, 2000));

      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.tabId, allFrames: false },
        world: 'MAIN',
        func: function() { const d = window.__bulkStatusData; window.__bulkStatusData = null; return d; }
      }).catch(() => [null]);

      const data = res?.result;
      if (!data || !data.tasks) continue;

      const myToolTask = data.tasks.find(t => {
        const tStt = (t.stt || '').split('.')[0]?.trim();
        return tStt === stt;
      });

      if (myToolTask) {
        if (myToolTask.status === 'completed') {
          isDone = true;
          break;
        } else if (myToolTask.status === 'error') {
          finalError = myToolTask.error || 'Lỗi từ Custom UI';
          break;
        }
      }
    }

    if (!isDone && !finalError) {
      throw new Error(`Timeout sau ${MAX_WAIT / 60000} phút`);
    }
    if (finalError) {
      throw new Error(finalError);
    }

    task.status = 'DONE';
    const ext = task.mediaType === 'video' ? 'mp4' : 'jpg';
    task.filename = `${stt}.${ext}`;
    task.statusDetail = `✅ Xong: ${task.filename}`;
    renderMultiTabServerTasksUI();
    log(`🎉 Hoàn tất! File: ${task.filename}`);

    if (task.serverTaskId) {
      const reportAction = task.mediaType === 'video' ? 'REPORT_TOOL_VIDEO_RESULT' : 'REPORT_TOOL_IMAGE_RESULT';
      chrome.runtime.sendMessage({
        action: reportAction,
        id: task.serverTaskId,
        ok: true,
        filePath: task.filename,
        mediaType: task.mediaType
      }).catch(e => console.error('Lỗi gửi kết quả:', e));
    }

  } catch (err) {
    task.status = 'ERROR';
    task.error = err.message || 'Lỗi không xác định';
    task.statusDetail = '❌ Lỗi';
    renderMultiTabServerTasksUI();
    log(`❌ Thất bại: ${task.error}`);

    if (task.serverTaskId) {
      const reportAction = task.mediaType === 'video' ? 'REPORT_TOOL_VIDEO_RESULT' : 'REPORT_TOOL_IMAGE_RESULT';
      chrome.runtime.sendMessage({
        action: reportAction,
        id: task.serverTaskId,
        ok: false,
        error: task.error,
        mediaType: task.mediaType
      }).catch(() => {});
    }
  } finally {
    _busyMultiTabs.delete(tab.tabId);
    triggerMultiTabServerQueueProcessing(); 
  }
}
"""

start_idx = None
end_idx = None
lines = js.split('\n')

for i, line in enumerate(lines):
    if 'async function runMultiTabServerWorker(task, tab) {' in line:
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
            
    if end_idx is not None:
        new_content = '\n'.join(lines[:start_idx]) + '\n' + new_func + '\n' + '\n'.join(lines[end_idx+1:])
        with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Patched sidepanel.js runMultiTabServerWorker")
    else:
        print("Could not find end of runMultiTabServerWorker")
else:
    print("Could not find start of runMultiTabServerWorker")

