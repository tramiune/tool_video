const config = require('./config');

const TELEGRAM_BOT_TOKEN = '8661695650:AAGk2wzokrrvBN7VMDjGl3OZsi4pfkVn7IE';
const TELEGRAM_CHAT_ID = '6067707939';

const MAX_LEN = 3800;

async function getTodayTotal() {
  try {
    const { db } = require('./firebase_worker');
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const snap = await db.collection('payments')
      .where('createdAt', '>=', startOfDay)
      .get();
    let total = 0;
    let count = 0;
    snap.forEach(d => {
      total += Number(d.data().amount || 0);
      count++;
    });
    return { total, count };
  } catch (e) {
    console.error('[Telegram] Failed to compute today total:', e.message);
    return { total: 0, count: 0 };
  }
}

async function sendMessage(text) {
  const message = String(text).slice(0, MAX_LEN);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] API error ${res.status}:`, body.slice(0, 200));
      return false;
    }
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
  const today = await getTodayTotal();
  const lines = [
    '💰 <b>NẠP TIỀN THÀNH CÔNG</b>',
    `👤 User: <code>${esc(tx.userId)}</code>`,
    `📧 Email: <code>${esc(tx.email || '-')}</code>`,
    `🏷️ Tier: <b>${esc(tx.tier)}</b>`,
    `💵 Amount: <b>${Number(tx.amount || 0).toLocaleString('vi-VN')}đ</b>`,
    `🔢 Code: <code>${esc(tx.code || '-')}</code>`,
    `📊 Tổng hôm nay: <b>${Number(today.total).toLocaleString('vi-VN')}đ</b> (${today.count} giao dịch)`
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
  notifyTaskFailed,
  notifyError
};
