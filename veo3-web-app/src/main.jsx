import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import BrowserGate from './BrowserGate.jsx'
import SupportedApp from './SupportedApp.jsx'
import { isSupportedBrowser } from './browserSupport.js'

const isBypassedVisitor = () => {
  const params = new URLSearchParams(window.location.search);
  const utm = params.get('utm_source');
  const ref = params.get('ref');
  
  if (utm && /tiktok|facebook|fb/i.test(utm)) return true;
  if (ref && /tiktok|facebook/i.test(ref)) return true;
  
  const ua = navigator.userAgent || navigator.vendor || window.opera || '';
  if (/TikTok|FBAN|FBAV|Instagram|Messenger/i.test(ua)) return true;
  
  return false;
};

const rootContent = (isSupportedBrowser() || isBypassedVisitor())
  ? <SupportedApp />
  : <BrowserGate />

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {rootContent}
  </StrictMode>,
)
