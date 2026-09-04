// Flow Studio Bridge Content Script for localhost:3000
"use strict";

(function() {
  function announce() {
    window.postMessage({ type: "FLOW_BRIDGE_PONG", version: "3.9" }, "*");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === "FLOW_BRIDGE_PING") {
      announce();
      return;
    }

    if (event.data.type === "FLOW_BRIDGE_REQUEST") {
      const { reqId, action, data } = event.data;
      try {
        chrome.runtime.sendMessage({ action, ...(data || {}) }, (res) => {
          if (chrome.runtime.lastError) {
            window.postMessage({ type: "FLOW_BRIDGE_RESPONSE", reqId, success: false, error: chrome.runtime.lastError.message }, "*");
          } else {
            window.postMessage({ type: "FLOW_BRIDGE_RESPONSE", reqId, response: res }, "*");
          }
        });
      } catch (e) {
        window.postMessage({ type: "FLOW_BRIDGE_RESPONSE", reqId, success: false, error: e.message }, "*");
      }
    }
  });

  // Keep long-lived Port connection to Service Worker to prevent it from going Inactive
  let port = null;
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "flowBridge" });
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
    } catch (e) {
      connectPort();
    }
  }, 10000);

  announce();
  setInterval(announce, 2000);
  console.log("🔌 Flow Studio Bridge active on localhost:3000 (Keep-Alive enabled)");
})();
