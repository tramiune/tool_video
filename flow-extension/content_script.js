// Flow Studio Bridge — Content Script (isolated world, labs.google)
// Communicates with main_world.js via CustomEvents

(function() {
  "use strict";
  // Forward auth token captured in MAIN world to background service worker
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === "__FLOW_AUTH_CAPTURED") {
      try {
        chrome.runtime.sendMessage({
          action: "FLOW_AUTH_CAPTURED",
          auth: event.data.auth,
          time: event.data.time
        });
      } catch (_) {}
    }
    if (event.data.type === "__FLOW_BATCHEXECUTE_CAPTURED") {
      try {
        chrome.runtime.sendMessage({
          action: "FLOW_BATCHEXECUTE_CAPTURED",
          url: event.data.url,
          rpcIds: event.data.rpcIds,
          at: event.data.at,
          fReq: event.data.fReq,
          time: event.data.time
        });
      } catch (_) {}
    }
    if (event.data.type === "__FLOW_MEDIA_CAPTURED") {
      try {
        chrome.runtime.sendMessage({
          action: "FLOW_MEDIA_CAPTURED",
          item: event.data.item
        });
      } catch (_) {}
    }
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

  // ── Floating circular action button ──────────────────────────────────────────
  function injectFloatingButton() {
    if (document.getElementById('fsp-fab')) return;

    const btn = document.createElement('div');
    btn.id = 'fsp-fab';
    btn.innerHTML = `
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    `;

    Object.assign(btn.style, {
      position:             'fixed',
      bottom:               '150px',
      left:                 '50%',
      transform:            'translateX(-50%)',
      zIndex:               '2147483647',
      width:                '52px',
      height:               '52px',
      borderRadius:         '50%',
      background:           'rgba(30, 30, 40, 0.82)',
      backdropFilter:       'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      border:               '1.5px solid rgba(255,255,255,0.15)',
      boxShadow:            '0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3)',
      display:              'flex',
      alignItems:           'center',
      justifyContent:       'center',
      cursor:               'pointer',
      userSelect:           'none',
      transition:           'transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease',
      opacity:              '0.85',
    });

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateX(-50%) scale(1.1)';
      btn.style.opacity   = '1';
      btn.style.boxShadow = '0 6px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'translateX(-50%) scale(1)';
      btn.style.opacity   = '0.85';
      btn.style.boxShadow = '0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3)';
    });
    btn.addEventListener('mousedown', () => {
      btn.style.transform = 'translateX(-50%) scale(0.94)';
    });
    btn.addEventListener('mouseup', () => {
      btn.style.transform = 'translateX(-50%) scale(1.1)';
    });

    btn.addEventListener('click', () => {
      // TODO: gắn action vào đây
      chrome.runtime.sendMessage({ action: 'FAB_CLICKED' }).catch(() => {});
    });

    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFloatingButton);
  } else {
    injectFloatingButton();
  }

  // Re-inject nếu SPA navigate làm mất button
  new MutationObserver(() => {
    if (!document.getElementById('fsp-fab')) injectFloatingButton();
  }).observe(document.body, { childList: true, subtree: false });

})();

