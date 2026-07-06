const path = require('path');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '..');

module.exports = {
  PORT: parseInt(process.env.PORT || '3456', 10),
  
  // Google Labs VEO3 Site details
  TARGET_URL: 'https://labs.google/fx/vi/tools/flow',
  SITE_KEY: '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV',
  API_KEY: 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY',
  TOOL_NAME: 'PINHOLE',

  // Cookies and Cache filepaths
  COOKIE_FILE: path.join(ROOT_DIR, 'cookies.json'),
  TOKEN_CACHE_FILE: path.join(ROOT_DIR, '.token_cache.json'),
  USER_DATA_DIR: path.join(os.homedir(), 'Veo3Data', '.api-brave-profile'),

  // Browser path resolution (Mac/Windows default search)
  getBrowserPath: () => {
    if (process.env.BRAVE_PATH) return process.env.BRAVE_PATH;
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

    const platform = os.platform();
    if (platform === 'darwin') {
      // MacOS paths
      const paths = [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      ];
      const fs = require('fs');
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
    } else if (platform === 'win32') {
      // Windows paths
      const paths = [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
      ];
      const fs = require('fs');
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }
};
