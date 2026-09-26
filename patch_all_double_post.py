with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

count = 0

# FIX 1: pasteAndRun for images (line ~2807)
old1 = """      func: (prompts) => {
          // 1) Gửi cho chính window (nếu tool là main frame)
          window.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');
          // 2) Gửi cho tất cả iframes
          let iframeCount = 0;
          document.querySelectorAll('iframe').forEach(iframe => {
            try {
              iframe.contentWindow?.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');
              iframeCount++;
            } catch (_) {}
          });"""
new1 = """      func: (prompts) => {
          // Gửi CHỈ cho iframes (tránh đúp do Flow relay)
          let iframeCount = 0;
          document.querySelectorAll('iframe').forEach(iframe => {
            try {
              iframe.contentWindow?.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');
              iframeCount++;
            } catch (_) {}
          });
          if (iframeCount === 0) window.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');"""
if old1 in sp:
    sp = sp.replace(old1, new1)
    count += 1

# FIX 2: pasteAndRunVideo (line ~5684)
old2 = """          func: function(prompts) {
            if (!window.__extProcessedTasks) window.__extProcessedTasks = new Set();
            let newPrompts = prompts.filter(p => !window.__extProcessedTasks.has(p));
            if (newPrompts.length === 0) return { ok: true, prompts: 0, iframes: 0 };
            newPrompts.forEach(p => window.__extProcessedTasks.add(p));
            
            window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts: newPrompts }, '*');
            var iframeCount = 0;
            document.querySelectorAll('iframe').forEach(function(iframe) {
              try { iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*'); iframeCount++; } catch(_) {}
            });
            return { ok: true, prompts: prompts.length, iframes: iframeCount };"""
new2 = """          func: function(prompts) {
            var iframeCount = 0;
            document.querySelectorAll('iframe').forEach(function(iframe) {
              try { if (iframe.contentWindow) { iframe.contentWindow.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts: prompts }, '*'); iframeCount++; } } catch(_) {}
            });
            if (iframeCount === 0) window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts: prompts }, '*');
            return { ok: true, prompts: prompts.length, iframes: iframeCount };"""
if old2 in sp:
    sp = sp.replace(old2, new2)
    count += 1

# FIX 3: Also fix any remaining BULK_ADD_TASKS double-post patterns (line ~5706)
old3 = """        window.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');
        var iframeCount = 0;
        document.querySelectorAll('iframe').forEach(function(iframe) {
          try { iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*'); iframeCount++; } catch(_) {}
        });"""
new3 = """        var iframeCount = 0;
        document.querySelectorAll('iframe').forEach(function(iframe) {
          try { if (iframe.contentWindow) { iframe.contentWindow.postMessage({ type: 'BULK_ADD_TASKS', prompts: prompts }, '*'); iframeCount++; } } catch(_) {}
        });
        if (iframeCount === 0) window.postMessage({ type: 'BULK_ADD_TASKS', prompts }, '*');"""
if old3 in sp:
    sp = sp.replace(old3, new3)
    count += 1

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print(f"✅ Fixed {count} double-postMessage patterns")
