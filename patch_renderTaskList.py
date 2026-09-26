with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'r') as f:
    js = f.read()

old_render = """  function renderTaskList(tasks) {
    const listEl = document.getElementById('bulkTaskList');
    const summaryEl = document.getElementById('bulkTaskSummary');
    if (!listEl || !tasks || !tasks.length) return;"""

new_render = """  function renderTaskList(tasks) {
    const listEl1 = document.getElementById('bulkTaskList');
    const listEl2 = document.getElementById('bulkVideoTaskList');
    const summaryEl1 = document.getElementById('bulkTaskSummary');
    const summaryEl2 = document.getElementById('bulkVideoTaskSummary');
    if (!tasks || !tasks.length) return;"""

js = js.replace(old_render, new_render)

old_update = """    if (summaryEl) summaryEl.textContent = `✅${done} ⚙️${proc} ⏳${pend} ❌${err}`;"""
new_update = """    if (summaryEl1) summaryEl1.textContent = `✅${done} ⚙️${proc} ⏳${pend} ❌${err}`;
    if (summaryEl2) summaryEl2.textContent = `✅${done} ⚙️${proc} ⏳${pend} ❌${err}`;"""
js = js.replace(old_update, new_update)

old_list = """    listEl.innerHTML = tasks.map(t => {"""
new_list = """    const html = tasks.map(t => {"""
js = js.replace(old_list, new_list)

old_end = """      </div>`;
    }).join('');
  }"""
new_end = """      </div>`;
    }).join('');
    if (listEl1) listEl1.innerHTML = html;
    if (listEl2) listEl2.innerHTML = html;
  }"""
js = js.replace(old_end, new_end)

with open('/Users/qtee/Documents/Tramiune/tool_video/flow-extension/sidepanel.js', 'w') as f:
    f.write(js)
print("Patched renderTaskList")
