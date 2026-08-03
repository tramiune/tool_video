const config = require('./config');

const TELEGRAM_BOT_TOKEN = '8661695650:AAGk2wzokrrvBN7VMDjGl3OZsi4pfkVn7IE';
const TELEGRAM_CHAT_ID = '6067707939';

const MAX_LEN = 3800;

async function sendMessage(text) {
  const message = String(text).slice(0, MAX_LEN);
  try {
    const { gotScraping } = await import('got-scraping');
    await gotScraping({
      url: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      json: {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      },
      timeout: { request: 10000 }
    });
    return true;
  } catch (e) {
    console.error('[Telegram] send failed:', e.message);
    return false;
  }
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function notifyPayment(tx) {
  const lines = [
    '💰 <b>NẠP TIỀN THÀNH CÔNG</b>',
    `👤 User: <code>${esc(tx.userId)}</code>`,
    `📧 Email: <code>${esc(tx.email || '-')}</code>`,
    `🏷️ Tier: <b>${esc(tx.tier)}</b>`,
    `💵 Amount: <b>${Number(tx.amount || 0).toLocaleString('vi-VN')}đ</b>`,
    `🔢 Code: <code>${esc(tx.code || '-')}</code>`
  ];
  await sendMessage(lines.join('\n'));
}

async function notifyTaskComplete(task) {
  const type = task.type === 'video' ? '🎬' : '🖼️';
  const lines = [
    `${type} <b>TASK THÀNH CÔNG</b>`,
    `📛 ID: <code>${esc(task.taskId)}</code>`,
    `👤 User: <code>${esc(task.userId)}</code>`,
    `📧 Email: <code>${esc(task.email || '-')}</code>`,
    `📝 Prompt: <i>${esc((task.prompt || '').slice(0, 120))}</i>`,
    `🔗 <a href="${esc(task.url)}">Xem kết quả</a>`
  ];
  await sendMessage(lines.join('\n'));
}

async function notifyTaskFailed(task) {
  const type = task.type === 'video' ? '🎬' : '🖼️';
  const lines = [
    `${type} ⚠️ <b>TASK THẤT BẠI</b>`,
    `📛 ID: <code>${esc(task.taskId)}</code>`,
    `👤 User: <code>${esc(task.userId)}</code>`,
    `📧 Email: <code>${esc(task.email || '-')}</code>`,
    `📝 Prompt: <i>${esc((task.prompt || '').slice(0, 120))}</i>`,
    `❌ Error: <code>${esc((task.error || '').slice(0, 250))}</code>`
  ];
  await sendMessage(lines.join('\n'));
}

async function notifyError(label, error) {
  const lines = [
    `🚨 <b>${esc(label)}</b>`,
    `⚠️ ${esc(String(error && error.message || error).slice(0, 300))}`
  ];
  await sendMessage(lines.join('\n'));
}

module.exports = {
  sendMessage,
  notifyPayment,
  notifyTaskComplete,
  notifyTaskFailed,
  notifyError
};
