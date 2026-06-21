/**
 * GitHub Actions: 每日 WhatsApp 提醒推送
 * 
 * 环境变量:
 * - WA_CREDS_B64: base64 编码的 creds.json
 * - WA_GROUP_ID: WhatsApp 群组 ID
 * - JSONBLOB_ID: jsonblob.com blob ID
 */

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('baileys');
const fs = require('fs');
const https = require('https');
const path = require('path');
const NodeCache = require('node-cache');

const GROUP_ID = process.env.WA_GROUP_ID;
const JSONBLOB_ID = process.env.JSONBLOB_ID;
const SESSION_DIR = '/tmp/wa-session';

const CAT_ICONS = { school: '\u{1F3EB}', class: '\u{1F3A8}', special: '\u{2B50}', summer: '\u{2600}\u{FE0F}', routine: '\u{1F4C5}' };
const CAT_NAMES = { school: '學校面試', class: '興趣班', special: '特別日子', summer: '暑期安排', routine: '恆常日程' };
const DAY_NAMES = ['日','一','二','三','四','五','六'];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

function getDaysUntil(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target - today) / 86400000);
}

function getWeekDay(dateStr) {
  return DAY_NAMES[new Date(dateStr + 'T00:00:00').getDay()];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function getRecurringDates(r, today, maxDays) {
  const dates = [];
  const repeat = r.repeat || 'none';
  if (repeat === 'none') {
    const daysUntil = getDaysUntil(r.date);
    if (daysUntil >= 0 && daysUntil <= maxDays) dates.push(r.date);
    return dates;
  }
  if (repeat === 'daily') {
    const startDate = new Date(r.date + 'T00:00:00');
    const start = startDate > today ? startDate : today;
    for (let i = 0; i <= maxDays; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (key >= r.date) dates.push(key);
    }
    return dates;
  }
  if (repeat === 'weekly') {
    const days = r.repeatDays || [];
    for (let i = 0; i <= maxDays; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      if (days.includes(d.getDay())) {
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        if (key >= r.date) dates.push(key);
      }
    }
    return dates;
  }
  if (repeat === 'monthly') {
    const targetDay = r.repeatDayOfMonth || new Date(r.date + 'T00:00:00').getDate();
    for (let i = 0; i <= maxDays; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      if (d.getDate() === targetDay) {
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        if (key >= r.date) dates.push(key);
      }
    }
    return dates;
  }
  return dates;
}

function getRepeatText(r) {
  if (!r || r.repeat === 'none' || !r.repeat) return '';
  if (r.repeat === 'daily') return '每日重複';
  if (r.repeat === 'weekly') {
    const days = (r.repeatDays||[]).map(d => '星期'+DAY_NAMES[d]);
    return '每週 ' + days.join('、');
  }
  if (r.repeat === 'monthly') return '每月 ' + (r.repeatDayOfMonth||'??') + ' 日';
  return '';
}

function buildReminderMsg(r, daysUntil) {
  const icon = CAT_ICONS[r.category] || '\u{1F4CC}';
  const catName = CAT_NAMES[r.category] || '其他';
  const repeatText = getRepeatText(r);
  let prefix;
  if (daysUntil === 0) prefix = '\u{1F534} 今日';
  else if (daysUntil === 1) prefix = '\u{1F7E1} 明日';
  else if (daysUntil <= 3) prefix = `\u{1F7E0} ${daysUntil}日後`;
  else prefix = `\u{1F7E2} ${daysUntil}日後`;
  let msg = `${prefix} ${icon}【${catName}】${r.name}`;
  msg += `\n　　\u{1F4C5} ${formatDate(r._displayDate || r.date)}（星期${getWeekDay(r._displayDate || r.date)}）${r.time !== '00:00' ? ' ' + r.time : ''}`;
  if (repeatText) msg += `\n　　\u{1F501} ${repeatText}`;
  if (r.caregiver) msg += `\n　　\u{1F464} ${r.caregiver}`;
  if (r.note) msg += `\n　　\u{1F4DD} ${r.note}`;
  return msg;
}

function checkBirthdays(birthdays) {
  if (!birthdays || birthdays.length === 0) return [];
  const now = new Date();
  const upcoming = [];
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(now); d.setDate(d.getDate() + offset);
    const checkDate = `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    birthdays.forEach(b => {
      if (b.date === checkDate) upcoming.push({ ...b, daysAway: offset });
    });
  }
  return upcoming;
}

async function main() {
  console.log('=== Daily WhatsApp Reminder ===');

  // 1. Decode and write creds
  if (!process.env.WA_CREDS_B64) {
    console.error('WA_CREDS_B64 not set');
    process.exit(1);
  }
  const credsJson = Buffer.from(process.env.WA_CREDS_B64, 'base64').toString('utf8');
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, 'creds.json'), credsJson);
  console.log('[WA] creds.json written');

  // 2. Fetch data from jsonblob
  const dataUrl = `https://jsonblob.com/api/jsonBlob/${JSONBLOB_ID}`;
  const data = await httpsGet(dataUrl);
  if (!data || !data.reminders) {
    console.error('[DATA] Failed to fetch data from jsonblob');
    process.exit(1);
  }
  console.log(`[DATA] Loaded ${data.reminders.length} reminders, ${data.birthdays?.length || 0} birthdays`);

  // 3. Build reminder message
  const today = new Date(); today.setHours(0,0,0,0);
  const upcoming = [];
  for (const r of data.reminders) {
    const dates = getRecurringDates(r, today, 7);
    dates.forEach(date => {
      const daysUntil = getDaysUntil(date);
      if (daysUntil >= 0 && daysUntil <= 7) {
        upcoming.push({ ...r, _displayDate: date, daysUntil });
      }
    });
  }
  upcoming.sort((a, b) => a.daysUntil - b.daysUntil);

  const birthdayUpcoming = checkBirthdays(data.birthdays || []);

  if (upcoming.length === 0 && birthdayUpcoming.length === 0) {
    console.log('[CRON] No upcoming reminders in next 7 days. Exiting.');
    process.exit(0);
  }

  const dateStr = `${today.getFullYear()}/${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
  let summary = `\u{1F514} *家庭提醒 — ${dateStr}*\n`;

  if (birthdayUpcoming.length > 0) {
    summary += `\n\u{1F382} *生日提醒：*\n`;
    birthdayUpcoming.forEach(b => {
      if (b.daysAway === 0) summary += `\u{1F534} 今日係 *${b.name}* 生日！\u{1F389}\u{1F381}\n`;
      else if (b.daysAway === 1) summary += `\u{1F7E1} 明日係 *${b.name}* 生日！（${b.date}）\n`;
      else summary += `\u{1F7E2} ${b.daysAway}日後：*${b.name}* 生日（${b.date}）\n`;
    });
  }

  if (upcoming.length > 0) {
    summary += `\n\u{1F4CB} 未來7日共 ${upcoming.length} 項事項：\n`;
    upcoming.forEach(u => { summary += `\n${buildReminderMsg(u, u.daysUntil)}`; });
  }

  summary += `\n\n\u{1F310} 網頁查看：https://b791d247cb6640908835e5bd7d0454a9.app.codebuddy.work`;
  summary += `\n\u{1F4AC} WhatsApp 群組指令：+ 事項 / - 事項 / 提醒 / 幫助`;

  console.log('[MSG] Message prepared, length:', summary.length);

  // 4. Connect to WhatsApp
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const msgRetryCounter = new NodeCache();

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      logger: require('pino')({ level: 'silent' }),
      msgRetryCounterCache: msgRetryCounter,
      browser: ['Family Reminder', 'Chrome', '1.0.0']
    });

    let messageSent = false;
    const timeout = setTimeout(() => {
      if (!messageSent) {
        console.error('[WA] Timeout - could not send message in 60s');
        sock.end();
        reject(new Error('Timeout'));
      }
    }, 60000);

    sock.ev.on('creds.update', () => saveCreds());

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('[WA] Connected! Sending message...');
        try {
          await sock.sendMessage(GROUP_ID, { text: summary });
          console.log('[WA] Message sent successfully!');
          messageSent = true;
          clearTimeout(timeout);
          setTimeout(() => {
            sock.end();
            resolve();
          }, 2000);
        } catch(e) {
          console.error('[WA] Send failed:', e.message);
          clearTimeout(timeout);
          sock.end();
          reject(e);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[WA] Closed (code: ${statusCode})`);
        if (!messageSent && statusCode !== 517 && statusCode !== 410) {
          // Retry once
          console.log('[WA] Unexpected close, retrying...');
        } else if (!messageSent) {
          clearTimeout(timeout);
          reject(new Error(`Connection closed: ${statusCode}`));
        }
      }
    });
  });
}

main().then(() => {
  console.log('=== Done ===');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
