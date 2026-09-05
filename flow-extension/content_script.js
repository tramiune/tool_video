// Flow Studio Bridge — Content Script (isolated world, labs.google)
// Communicates with main_world.js via CustomEvents

(function() {
  "use strict";
  // Forward auth token captured in MAIN world to background service worker
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.type !== "__FLOW_AUTH_CAPTURED") return;
    try {
      chrome.runtime.sendMessage({
        action: "FLOW_AUTH_CAPTURED",
        auth: event.data.auth,
        time: event.data.time
      });
    } catch (_) {}
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // Get auth token from MAIN world via CustomEvent
    if (msg.action === "GET_AUTH_TOKEN") {
      // Use chrome.scripting from background instead — just respond with instructions
      sendResponse({ success: false, error: "Use scripting.executeScript" });
      return true;
    }

    // Submit prompt via UI
    if (msg.action === "SUBMIT_PROMPT_UI") {
      submitPromptUI(msg.prompt || "")
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    if (msg.action === "PING") {
      sendResponse({ alive: true });
      return true;
    }
  });

  async function submitPromptUI(promptText) {
    const editor = document.querySelector("div[role='textbox'][data-slate-editor='true']")
                || document.querySelector("div[data-slate-editor='true']")
                || document.querySelector("div[contenteditable='true']")
                || document.querySelector("textarea[placeholder*='prompt' i]");
    if (!editor) return { success: false, error: "Không tìm thấy ô nhập prompt trên giao diện Flow!" };

    editor.focus();
    await sleep(100);

    const textTarget = editor.querySelector("[data-slate-string='true']") 
                    || editor.querySelector("[data-slate-leaf='true']") 
                    || editor.querySelector("[data-slate-node='text']") 
                    || editor;

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textTarget);
    sel.removeAllRanges();
    sel.addRange(range);

    try {
      editor.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward"
      }));
    } catch (_) {}
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    await sleep(50);

    try {
      editor.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: promptText
      }));
    } catch (_) {}

    document.execCommand("insertText", false, promptText);

    if (!editor.textContent || !editor.textContent.includes(promptText.slice(0, 5))) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", promptText);
        editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
      } catch (_) {}
    }

    try {
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: promptText }));
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}

    let submitBtn = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);

      const allBtns = Array.from(document.querySelectorAll("button"));
      for (const btn of allBtns) {
        const inner = (btn.innerHTML || "").toLowerCase();
        const text = (btn.textContent || "").trim().toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        
        const isSubmit = inner.includes("arrow_forward") || 
                         inner.includes("send") || 
                         text === "arrow_forward" || 
                         text === "send" ||
                         aria.includes("generate") || 
                         aria.includes("submit") || 
                         aria.includes("tạo");

        if (isSubmit) {
          submitBtn = btn;
          if (!btn.disabled && !btn.hasAttribute("disabled") && !btn.classList.contains("disabled")) {
            break;
          }
        }
      }

      if (submitBtn && !submitBtn.disabled) break;
    }

    if (submitBtn) {
      submitBtn.removeAttribute("disabled");
      submitBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      submitBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      submitBtn.click();
    }

    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));

    return { success: true, message: "Đã gõ prompt và kích hoạt nút Tạo thành công!" };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Keep long-lived Port connection to Service Worker from Flow tab
  let port = null;
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "flowTabBridge" });
      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connectPort, 1000);
      });
    } catch (e) {
      setTimeout(connectPort, 1000);
    }
  }
  connectPort();
  setInterval(() => {
    try {
      if (port) port.postMessage({ ping: 1 });
      else connectPort();
    } catch (e) { connectPort(); }
  }, 10000);

  console.log("🔌 Flow Studio content script active with Keep-Alive (isolated world)");
})();
