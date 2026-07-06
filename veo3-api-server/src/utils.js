const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  magenta: '\x1b[35m'
};

function formatTime() {
  return new Date().toLocaleTimeString('vi-VN');
}

const logListeners = [];

const logger = {
  info: (msg) => {
    console.log(`${colors.dim}[${formatTime()}]${colors.reset} [INFO] ${msg}`);
    logListeners.forEach(cb => cb({ type: 'info', time: formatTime(), msg }));
  },
  success: (msg) => {
    console.log(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.green}[SUCCESS] ${msg}${colors.reset}`);
    logListeners.forEach(cb => cb({ type: 'success', time: formatTime(), msg }));
  },
  warn: (msg) => {
    console.log(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.yellow}[WARN] ⚠️ ${msg}${colors.reset}`);
    logListeners.forEach(cb => cb({ type: 'warn', time: formatTime(), msg }));
  },
  error: (msg, err) => {
    let detail = err ? `\nDetails: ${err.stack || err.message || err}` : '';
    console.error(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.red}[ERROR] ❌ ${msg}${detail}${colors.reset}`);
    logListeners.forEach(cb => cb({ type: 'error', time: formatTime(), msg: `${msg}${detail}` }));
  },
  debug: (msg) => {
    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
      console.log(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.magenta}[DEBUG] 🔍 ${msg}${colors.reset}`);
      logListeners.forEach(cb => cb({ type: 'debug', time: formatTime(), msg }));
    }
  },
  onLog: (cb) => {
    logListeners.push(cb);
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  logger,
  sleep
};
