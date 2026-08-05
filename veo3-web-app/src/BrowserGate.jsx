import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { isInAppUserAgent } from './browserSupport';

const copyCurrentUrl = async () => {
  const currentUrl = window.location.href;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(currentUrl);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = currentUrl;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy command failed');
};

export default function BrowserGate() {
  const [copyState, setCopyState] = useState('idle');
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isInApp = isInAppUserAgent(ua);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const handleCopy = async () => {
    try {
      await copyCurrentUrl();
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2500);
    } catch (error) {
      console.error('Copy current URL failed:', error);
      setCopyState('failed');
    }
  };

  const handleOpenBrowser = () => {
    const currentUrl = window.location.href;
    void copyCurrentUrl().catch(() => {});

    if (isAndroid) {
      const parsed = new URL(currentUrl);
      const intent = `intent://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
        + `#Intent;scheme=${parsed.protocol.replace(':', '')};package=com.android.chrome;`
        + `S.browser_fallback_url=${encodeURIComponent(currentUrl)};end`;
      window.location.assign(intent);
      return;
    }

    if (isIOS) {
      const withoutProtocol = currentUrl.replace(/^https?:\/\//, '');
      const safariWindow = window.open(`x-safari-https://${withoutProtocol}`, '_blank');
      if (!safariWindow) window.location.assign(`googlechromes://${withoutProtocol}`);
      return;
    }

    handleCopy();
  };

  const primaryLabel = isAndroid
    ? 'Mở bằng Chrome'
    : isIOS
      ? 'Mở bằng Safari / Chrome'
      : 'Sao chép để mở bằng Chrome / Safari';

  return (
    <main className="browser-gate" role="dialog" aria-modal="true" aria-labelledby="browser-gate-title">
      <div className="browser-gate__glow browser-gate__glow--blue" />
      <div className="browser-gate__glow browser-gate__glow--violet" />
      <section className="browser-gate__card">
        <div className="browser-gate__brand">
          <img src="/logo.png" alt="meo3" />
          <span>meo3</span>
        </div>

        <div className="browser-gate__browser-mark" aria-hidden="true">
          <span />
        </div>

        <p className="browser-gate__eyebrow">TRÌNH DUYỆT KHÔNG ĐƯỢC HỖ TRỢ</p>
        <h1 id="browser-gate-title">Mở meo3 bằng Chrome hoặc Safari</h1>
        <p className="browser-gate__description">
          Để đăng nhập và tạo video ổn định, bạn vui lòng mở đúng trang này bằng Chrome hoặc Safari.
          {isInApp && ' Bạn đang dùng trình duyệt bên trong ứng dụng.'}
        </p>

        <div className="browser-gate__url-note">
          Link quảng cáo và toàn bộ mã theo dõi sẽ được giữ nguyên khi sao chép.
        </div>

        <div className="browser-gate__actions">
          <button type="button" className="browser-gate__primary" onClick={handleOpenBrowser}>
            <ExternalLink size={18} />
            {primaryLabel}
          </button>
          <button type="button" className="browser-gate__copy" onClick={handleCopy}>
            {copyState === 'copied' ? <Check size={18} /> : <Copy size={18} />}
            {copyState === 'copied' ? 'Đã sao chép link hiện tại' : copyState === 'failed' ? 'Không thể sao chép, hãy thử lại' : 'Sao chép link hiện tại'}
          </button>
        </div>

        <p className="browser-gate__help">
          {isIOS
            ? 'Nếu không tự mở: bấm nút Chia sẻ hoặc dấu •••, sau đó chọn “Mở trong Safari”.'
            : isAndroid
              ? 'Nếu không tự mở: bấm dấu ••• ở góc màn hình, chọn “Mở bằng Chrome”.'
              : 'Dán link vừa sao chép vào Chrome hoặc Safari để tiếp tục.'}
        </p>
      </section>
    </main>
  );
}
