import re

file_path = '/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js'
with open(file_path, 'r') as f:
    content = f.read()

# 1. Patch Image Task mapping
content = re.sub(
    r'serverTasks\.forEach\(t => _serverSttMap\.set\(t\.stt, \{ id: t\.id, mediaType: \'image\' \}\)\);\n\s*// Format prompts và chạy\n\s*const promptsText = serverTasks\.map\(t => {',
    r'''// Format prompts và chạy
    const promptsText = serverTasks.map(t => {
      let safePrompt = (t.prompt || '').replace(/\\r?\\n/g, ' ').replace(/\\|/g, '-');
      let line = `${t.ratio || '9:16'}|${safePrompt}`;
      if (t.referenceImages && t.referenceImages.length > 0) {
        line += '|' + t.referenceImages.join('|');
      }
      _serverSttMap.set(t.stt, { id: t.id, mediaType: 'image', originalLine: line });
      return line;
    }).join('\\n');
    /* removed old forEach */
    serverTasks.map(t => {''',
    content
)

# 2. Patch Video Task mapping
content = re.sub(
    r'serverTasks\.forEach\(t => _serverSttMap\.set\(t\.stt, \{ id: t\.id, mediaType: \'video\' \}\)\);\n\s*const promptsText = serverTasks\.map\(t => {',
    r'''const promptsText = serverTasks.map(t => {
        let safePrompt = (t.prompt || '').replace(/\\r?\\n/g, ' ').replace(/\\|/g, '-');
        let line = `${t.ratio || '9:16'}|${safePrompt}`;
        if (t.referenceImages && t.referenceImages.length > 0) {
          line += '|' + t.referenceImages.join('|');
        } else if (t.startImage) {
          line += '|' + t.startImage;
          if (t.endImage) line += '|' + t.endImage;
        }
        _serverSttMap.set(t.stt, { id: t.id, mediaType: 'video', originalLine: line });
        return line;
      }).join('\\n');
      /* removed old forEach */
      serverTasks.map(t => {''',
    content
)

# 3. Patch the error logging in startStatusPolling
target_error_log = r'''                } else if \(t\.status === 'error'\) \{
                  _serverSttMap\.delete\(stt\);
                  chrome\.runtime\.sendMessage\(\{ action: 'SIDEPANEL_BULK_DONE', taskId: taskId, stt: stt, mediaType: mt, ok: false, error: t\.error || 'error' \}\);
                \}'''

replacement_error_log = r'''                } else if (t.status === 'error') {
                  const promptLine = mapping.originalLine || 'Unknown prompt';
                  logFn(`❌ [Server] Task STT ${stt} (${mt}) lỗi: ${t.error || 'error'}\n   👉 Prompt truyền vào: ${promptLine}`);
                  _serverSttMap.delete(stt);
                  chrome.runtime.sendMessage({ action: 'SIDEPANEL_BULK_DONE', taskId: taskId, stt: stt, mediaType: mt, ok: false, error: `${t.error || 'error'} (Prompt: ${promptLine})` });
                }'''

content = re.sub(target_error_log, replacement_error_log, content)

with open(file_path, 'w') as f:
    f.write(content)

print("Patched sidepanel logs!")
