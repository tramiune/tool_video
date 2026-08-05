const IN_APP_BROWSER_PATTERN = /TikTok|FBAV|FBAN|Instagram|Messenger|Line\/|WhatsApp|Telegram|MicroMessenger|Twitter|LinkedInApp|Zalo/i;
const CHROMIUM_VARIANT_PATTERN = /Edg|Edge|OPR|Opera|SamsungBrowser|Vivaldi|MiuiBrowser|YaBrowser|DuckDuckGo/i;

export const isInAppUserAgent = (userAgent) => (
  IN_APP_BROWSER_PATTERN.test(userAgent) || /; wv\)/i.test(userAgent)
);

export const isSupportedUserAgent = (userAgent, { standalone = false, brave = false } = {}) => {
  const isChrome = /Chrome|CriOS/i.test(userAgent)
    && !CHROMIUM_VARIANT_PATTERN.test(userAgent)
    && !brave;
  const isSafari = /Safari/i.test(userAgent)
    && !/Chrome|CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent)
    && !CHROMIUM_VARIANT_PATTERN.test(userAgent);

  return standalone || (!isInAppUserAgent(userAgent) && (isChrome || isSafari));
};

export const isSupportedBrowser = () => {
  const userAgent = navigator.userAgent || navigator.vendor || '';
  const standalone = navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches;
  return isSupportedUserAgent(userAgent, { standalone, brave: Boolean(navigator.brave) });
};
