// main_world.js — Runs in MAIN world of Google Flow page
// Captures auth headers AND request bodies from Flow's own API calls

(function() {
  const _origFetch = window.fetch;
  
  // Restore cached auth immediately on page load ONLY IF FRESH (< 50 mins old)
  // NOTE: Use sessionStorage ONLY so each tab maintains its own isolated auth context!
  try {
    const savedTime = parseInt(sessionStorage.getItem("__flow_saved_auth_time") || "0", 10);
    const age = Date.now() - savedTime;
    if (savedTime > 0 && age < 50 * 60 * 1000) {
      window.__flowAuth = sessionStorage.getItem("__flow_saved_auth") || null;
      window.__flowAuthTime = savedTime;
      if (window.__flowAuth) {
        setTimeout(() => {
          try {
            window.postMessage({
              type: "__FLOW_AUTH_CAPTURED",
              auth: window.__flowAuth,
              time: window.__flowAuthTime
            }, "*");
          } catch (_) {}
        }, 100);
      }
    } else {
      window.__flowAuth = null;
      window.__flowAuthTime = 0;
      sessionStorage.removeItem("__flow_saved_auth");
      sessionStorage.removeItem("__flow_saved_auth_time");
    }
  } catch (e) {
    window.__flowAuth = null;
    window.__flowAuthTime = 0;
  }
  window.__flowLastVideoRequest = null;

  window.__clearFlowAuth = function() {
    window.__flowAuth = null;
    window.__flowAuthTime = 0;
    try {
      sessionStorage.removeItem("__flow_saved_auth");
      sessionStorage.removeItem("__flow_saved_auth_time");
      sessionStorage.removeItem("flow_auth_token");
    } catch (_) {}
  };

  function saveAuth(authVal) {
    if (!authVal || !authVal.startsWith("Bearer ya29")) return;
    window.__flowAuth = authVal;
    window.__flowAuthTime = Date.now();
    try {
      sessionStorage.setItem("__flow_saved_auth", authVal);
      sessionStorage.setItem("__flow_saved_auth_time", String(Date.now()));
    } catch (e) {}

    // Broadcast to content_script so background knows auth for this tabId
    try {
      window.postMessage({
        type: "__FLOW_AUTH_CAPTURED",
        auth: authVal,
        time: window.__flowAuthTime
      }, "*");
    } catch (_) {}
  }

  // ══════════════════════════════════════
  // Helper to parse and log batchexecute & new Flow API calls
  // ══════════════════════════════════════
  function handleCapturedBatchexecute(url, body) {
    try {
      const urlStr = (typeof url === 'string') ? url : url?.toString() || '';
      const bodyStr = (typeof body === 'string') ? body : (body ? body.toString() : '');
      if (!urlStr && !bodyStr) return;

      let parsedFReq = null;
      if (bodyStr && bodyStr.includes('f.req=')) {
        const match = bodyStr.match(/f\.req=([^&]+)/);
        if (match && match[1]) {
          try {
            parsedFReq = JSON.parse(decodeURIComponent(match[1]));
          } catch (_) {}
        }
      }

      const atMatch = bodyStr.match(/at=([^&]+)/);
      const atToken = atMatch ? decodeURIComponent(atMatch[1]) : null;

      // Extract RPC IDs from URL or body
      let rpcIds = "";
      if (urlStr.includes('rpcids=')) {
        const rm = urlStr.match(/rpcids=([^&]+)/);
        if (rm) rpcIds = decodeURIComponent(rm[1]);
      } else if (Array.isArray(parsedFReq)) {
        rpcIds = parsedFReq.map(item => item?.[0]?.[0] || item?.[0]).filter(Boolean).join(',');
      }

      console.log(`🚀 [Captured Flow New API (${rpcIds || 'batchexecute'})]:`, urlStr);
      if (parsedFReq) {
        console.log('📦 [batchexecute payload]:', JSON.stringify(parsedFReq, null, 2));
      }

      // Check if it's L2jnw (StreamGenerateContent)
      if (rpcIds.includes('L2jnw') || bodyStr.includes('L2jnw')) {
        window.__flowLastL2jnw = {
          url: urlStr,
          at: atToken,
          fReq: parsedFReq,
          rawBody: bodyStr,
          time: Date.now()
        };
        console.log('🔥 [Captured L2jnw StreamGenerateContent!]:', parsedFReq);
      }

      window.postMessage({
        type: "__FLOW_BATCHEXECUTE_CAPTURED",
        url: urlStr,
        rpcIds: rpcIds,
        at: atToken,
        fReq: parsedFReq,
        time: Date.now()
      }, "*");
    } catch (err) {
      console.warn('Error in handleCapturedBatchexecute:', err);
    }
  }

  // Hook XMLHttpRequest (both setRequestHeader and open/send for batchexecute)
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header && header.toLowerCase() === "authorization") {
      saveAuth(value);
    }
    return origSetRequestHeader.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__flowUrl = (typeof url === 'string') ? url : url?.toString() || '';
    this.__flowMethod = method;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this.__flowUrl && (this.__flowUrl.includes('batchexecute') || this.__flowUrl.includes('FlowService') || this.__flowUrl.includes('upload'))) {
      handleCapturedBatchexecute(this.__flowUrl, body);
      this.addEventListener('load', () => {
        try {
          console.log(`📥 [XHR Response (${this.__flowUrl.slice(0, 60)})]:`, (this.responseText || '').slice(0, 600));
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  window.fetch = function(...args) {
    const [url, opts] = args;
    const urlStr = (typeof url === 'string') ? url : url?.url || '';

    // Capture auth from any request
    if (opts?.headers) {
      let authVal = null;
      if (opts.headers instanceof Headers) {
        authVal = opts.headers.get('Authorization') || opts.headers.get('authorization');
      } else if (typeof opts.headers === 'object') {
        authVal = opts.headers['Authorization'] || opts.headers['authorization'];
      }
      if (authVal) saveAuth(authVal);
    }

    // Capture new Flow Boq batchexecute / FlowService / upload requests
    if (urlStr.includes('batchexecute') || urlStr.includes('FlowService') || urlStr.includes('StreamGenerateContent') || urlStr.includes('upload')) {
      handleCapturedBatchexecute(urlStr, opts?.body);
      const resPromise = _origFetch.apply(this, args);
      resPromise.then(async (res) => {
        try {
          const clone = res.clone();
          const txt = await clone.text();
          console.log(`📥 [API Response (${urlStr.slice(0, 60)})]:`, txt.slice(0, 600));
        } catch (_) {}
      }).catch(() => {});
      return resPromise;
    }

    // Capture video generation request body and headers (legacy format)
    if (urlStr.includes('batchAsyncGenerateVideo') || urlStr.includes('batchGenerateImage')) {
      if (opts?.body) {
        try {
          const bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
          window.__flowLastVideoRequest = {
            url: urlStr,
            body: bodyStr,
            headers: opts.headers,
            time: Date.now()
          };
          // Log headers
          let hdrsObj = {};
          if (opts.headers instanceof Headers) {
            for (const [k, v] of opts.headers.entries()) hdrsObj[k] = v;
          } else {
            hdrsObj = opts.headers || {};
          }
          console.log('📦 Headers sent by Flow:', JSON.stringify(hdrsObj, null, 2));

          // Truncate long tokens for readable logging
          const truncated = bodyStr.replace(/"token":"[^"]{50,}"/g, '"token":"<TOKEN>"');
          console.log('📦 Captured request to:', urlStr);
          console.log('📦 Body:', truncated);
        } catch {}
      }
    }

    // Capture delete / archive / patch requests
    const method = (opts?.method || 'GET').toUpperCase();
    if (method === 'DELETE' || method === 'PATCH' || urlStr.includes('delete') || urlStr.includes('archive') || urlStr.includes('batchDelete') || urlStr.includes('flowWorkflows')) {
      console.log(`🗑️ Captured [${method}] to:`, urlStr);
      if (opts?.body) {
        console.log('🗑️ Body:', typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      }
    }

    return _origFetch.apply(this, args);
  };

  // ══════════════════════════════════════
  // Hook grecaptcha.enterprise.execute to see exact action & options Flow uses
  // ══════════════════════════════════════
  function hookRecaptcha() {
    if (window.grecaptcha?.enterprise?.execute && !window.__recaptchaHooked) {
      window.__recaptchaHooked = true;
      const origExecute = window.grecaptcha.enterprise.execute;
      window.grecaptcha.enterprise.execute = function(siteKey, options) {
        console.log('🔑 [Flow called reCAPTCHA]: siteKey =', siteKey, 'options =', JSON.stringify(options));
        window.__lastRecaptchaSiteKey = siteKey;
        window.__lastRecaptchaOptions = options;
        return origExecute.apply(this, arguments);
      };
      console.log('🔌 grecaptcha.enterprise.execute hooked successfully');
    }
  }

  setInterval(hookRecaptcha, 200);

  console.log('🔌 Flow auth & reCAPTCHA interceptor installed (MAIN world)');
})();
