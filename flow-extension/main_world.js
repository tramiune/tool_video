// main_world.js — Runs in MAIN world of Google Flow page
// Captures auth headers AND request bodies from Flow's own API calls

(function() {
  const _origFetch = window.fetch;
  
  // Restore cached auth immediately on page load ONLY IF FRESH (< 50 mins old)
  try {
    const savedTime = parseInt(sessionStorage.getItem("__flow_saved_auth_time") || localStorage.getItem("__flow_saved_auth_time") || "0", 10);
    const age = Date.now() - savedTime;
    if (savedTime > 0 && age < 50 * 60 * 1000) {
      window.__flowAuth = sessionStorage.getItem("__flow_saved_auth") || localStorage.getItem("__flow_saved_auth") || null;
      window.__flowAuthTime = savedTime;
    } else {
      window.__flowAuth = null;
      window.__flowAuthTime = 0;
      sessionStorage.removeItem("__flow_saved_auth");
      sessionStorage.removeItem("__flow_saved_auth_time");
      localStorage.removeItem("__flow_saved_auth");
      localStorage.removeItem("__flow_saved_auth_time");
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
      localStorage.removeItem("__flow_saved_auth");
      localStorage.removeItem("__flow_saved_auth_time");
      localStorage.removeItem("flow_auth_token");
    } catch (_) {}
  };

  function saveAuth(authVal) {
    if (!authVal || !authVal.startsWith("Bearer ya29")) return;
    window.__flowAuth = authVal;
    window.__flowAuthTime = Date.now();
    try {
      sessionStorage.setItem("__flow_saved_auth", authVal);
      sessionStorage.setItem("__flow_saved_auth_time", String(Date.now()));
      localStorage.setItem("__flow_saved_auth", authVal);
      localStorage.setItem("__flow_saved_auth_time", String(Date.now()));
    } catch (e) {}
  }

  // Hook XMLHttpRequest
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header && header.toLowerCase() === "authorization") {
      saveAuth(value);
    }
    return origSetRequestHeader.apply(this, arguments);
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

    // Capture video generation request body and headers
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
