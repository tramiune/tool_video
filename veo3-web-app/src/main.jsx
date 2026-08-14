import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import BrowserGate from './BrowserGate.jsx'
import SupportedApp from './SupportedApp.jsx'
import { isSupportedBrowser } from './browserSupport.js'

const rootContent = isSupportedBrowser()
  ? <SupportedApp />
  : <BrowserGate />

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {rootContent}
  </StrictMode>,
)
