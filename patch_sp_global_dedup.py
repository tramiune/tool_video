import re
with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r', encoding='utf-8') as f:
    sp = f.read()

# Patch runMultiTabServerWorker
sp = sp.replace("""      func: function(msgType, line) {
        window.postMessage({ type: msgType, prompts: [line] }, '*');""", """      func: function(msgType, line) {
        if (!window.__extProcessedTasks) window.__extProcessedTasks = new Set();
        if (window.__extProcessedTasks.has(line)) return;
        window.__extProcessedTasks.add(line);
        window.postMessage({ type: msgType, prompts: [line] }, '*');""")

# Patch pasteAndRunVideo
sp = sp.replace("""          func: function(prompts) {
            window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts }, '*');""", """          func: function(prompts) {
            if (!window.__extProcessedTasks) window.__extProcessedTasks = new Set();
            let newPrompts = prompts.filter(p => !window.__extProcessedTasks.has(p));
            if (newPrompts.length === 0) return { ok: true, prompts: 0, iframes: 0 };
            newPrompts.forEach(p => window.__extProcessedTasks.add(p));
            
            window.postMessage({ type: 'BULK_ADD_VIDEO_TASKS', prompts: newPrompts }, '*');""")

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w', encoding='utf-8') as f:
    f.write(sp)
print("Patched global dedup in tab window")
