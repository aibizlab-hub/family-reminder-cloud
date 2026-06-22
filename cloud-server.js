/**
 * 家庭提醒系統 - 雲端三合一服務器
 * API + WhatsApp 監聽 + 網頁 + 每日自動提醒
 *
 * 部署在 Render.com 免費版
 * 數據持久化：jsonblob.com
 * Session 持久化：jsonblob.com (只存 creds.json)
 */

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('baileys');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const qrcode = require('qrcode');
const NodeCache = require('node-cache');

// ===== 常數 =====
const PORT = process.env.PORT || 3000;
const GROUP_ID = '85262218999-1474211595@g.us';
const DATA_FILE = path.join(__dirname, 'data.json');
const SESSION_DIR = path.join('/tmp', 'wa-session');
const CLOUD_DATA_URL = 'https://jsonblob.com/api/jsonBlob/019ee8ad-ccec-7046-97c1-72cc323fb503';
const CLOUD_CREDS_URL = 'https://jsonblob.com/api/jsonBlob/019ee8ca-5e4d-7487-a0d8-1f95a25c0afa';
const WEB_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const CAT_ICONS = { school: '\u{1F3EB}', class: '\u{1F3A8}', special: '\u{2B50}', summer: '\u{2600}\u{FE0F}', routine: '\u{1F4C5}' };
const CAT_NAMES = { school: '\u{5B78}\u{6821}\u{9762}\u{8A66}', class: '\u{8208}\u{8DA3}\u{73ED}', special: '\u{7279}\u{5225}\u{65E5}\u{5B50}', summer: '\u{6691}\u{671F}\u{5B89}\u{6392}', routine: '\u{6052}\u{5E38}\u{65E5}\u{7A0B}' };
const DAY_NAMES = ['\u{65E5}','\u{4E00}','\u{4E8C}','\u{4E09}','\u{56DB}','\u{4E94}','\u{516D}'];
const CAREGIVERS = ['EPPIE', 'KEN', 'COFFE', '\u{674F}\u{82B1}\u{6751}'];

// ===== 全域狀態 =====
let sock = null;
let currentQR = null;
let waConnected = false;
let lastReminderDate = null;

// ===== HTTP 工具 =====
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

function httpsPut(url, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const opts = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(url, opts, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ===== 數據管理 =====
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) { console.error('[DATA] 讀取失敗:', e.message); }
  return {
    reminders: [],
    birthdays: [
      { name: 'EPPIE', date: '??-??', note: '' },
      { name: 'KEN', date: '??-??', note: '' },
      { name: 'COFFE', date: '??-??', note: '' },
      { name: '\u{674F}\u{82B1}\u{6751}', date: '??-??', note: '' }
    ],
    members: CAREGIVERS,
    caregivers: CAREGIVERS
  };
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch(e) { console.error('[DATA] 寫入失敗:', e.message); }
  // 雲端同步
  httpsPut(CLOUD_DATA_URL, data).catch(() => {});
}

function uid() {
  return 'r' + Date.now() + Math.random().toString(36).slice(2, 6);
}

// ===== 雲端數據同步 =====
async function syncDataFromCloud() {
  try {
    const cloudData = await httpsGet(CLOUD_DATA_URL);
    if (cloudData && cloudData.reminders) {
      writeData(cloudData);
      console.log('[DATA] 從雲端同步成功');
      return cloudData;
    }
  } catch(e) { console.log('[DATA] 雲端同步失敗:', e.message); }
  return null;
}

// ===== WhatsApp Session 管理 =====
async function restoreSession() {
  try {
    // 檢查本地是否已有 session
    if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
      console.log('[WA] 本地 session 存在');
      return true;
    }
    // 從雲端恢復
    console.log('[WA] 嘗試從雲端恢復 session...');
    const credsData = await httpsGet(CLOUD_CREDS_URL);
    if (credsData && credsData.creds) {
      if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
      fs.writeFileSync(path.join(SESSION_DIR, 'creds.json'), JSON.stringify(credsData.creds));
      console.log('[WA] \u2705 從雲端恢復 session 成功');
      return true;
    }
    console.log('[WA] 雲端無 session，需要掃描 QR Code');
    return false;
  } catch(e) {
    console.log('[WA] 恢復 session 失敗:', e.message);
    return false;
  }
}

async function backupCreds() {
  try {
    const credsPath = path.join(SESSION_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    await httpsPut(CLOUD_CREDS_URL, { type: 'wa-session-creds', creds });
    console.log('[WA] creds.json 已備份到雲端');
  } catch(e) { console.log('[WA] 備份 creds 失敗:', e.message); }
}

// ===== WhatsApp 連接 =====
async function connectWhatsApp() {
  await restoreSession();

  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const msgRetryCounter = new NodeCache();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    logger: require('pino')({ level: 'silent' }),
    msgRetryCounterCache: msgRetryCounter,
    browser: ['Family Reminder', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', async () => {
    saveCreds();
    await backupCreds();
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      currentQR = qr;
      console.log('[WA] QR Code 已生成，請訪問 /qr 掃描');
    }

    if (connection === 'open') {
      currentQR = null;
      waConnected = true;
      console.log('[WA] \u2705 WhatsApp 已連接');
    }

    if (connection === 'close') {
      waConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[WA] \u26A0\uFE0F 中斷 (code: ${statusCode})`);

      // 517 = 重啟需要, 410 = 需要重新掃描
      if (statusCode === 517 || statusCode === 410) {
        console.log('[WA] 需要重新掃描 QR Code');
        currentQR = null;
      }

      setTimeout(() => {
        connectWhatsApp().catch(err => {
          console.error('[WA] 重連失敗:', err.message);
          setTimeout(() => connectWhatsApp(), 10000);
        });
      }, 3000);
    }
  });

  // 訊息監聽
  setupMessageHandler();
}

// ===== WhatsApp 訊息處理 =====
function setupMessageHandler() {
  if (!sock) return;
  let processedIds = [];

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.remoteJid !== GROUP_ID) continue;
      if (msg.key.fromMe) continue;
      if (processedIds.includes(msg.key.id)) continue;

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!text) continue;

      console.log(`[WA] 收到: ${text.substring(0, 50)}`);
      const reply = processMessage(text);
      if (reply) {
        await sock.sendMessage(GROUP_ID, { text: reply });
        console.log(`[WA] 回覆已發送`);
      }

      processedIds.push(msg.key.id);
      if (processedIds.length > 200) processedIds = processedIds.slice(-200);
    }
  });
}

// ===== 指令處理 =====
function parseDate(str) {
  const now = new Date();
  const year = now.getFullYear();
  let m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${year}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  m = str.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return `${year}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  return null;
}

function parseTime(str) {
  let m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${String(m[1]).padStart(2,'0')}:${m[2]}`;
  return null;
}

function parseBirthDate(str) {
  let m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  m = str.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return `${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  return null;
}

function detectCategory(text) {
  const lower = text.toLowerCase();
  if (/\u6691[\u671F\u5047]|summer|\u590F\u4EE4/i.test(lower)) return 'summer';
  if (/\u6052\u5E38|\u65E5\u5E38|\u6BCF[\u9031\u5468\u5929\u65E5]|routine|\u56FA\u5B9A/i.test(lower)) return 'routine';
  if (/\u5B78\u6821|\u9762\u8A66|\u5165\u5B78|\u5C0F\u5B78|\u4E2D\u5B78|\u5E7C\u7A1A\u5712|school|interview/i.test(lower)) return 'school';
  if (/\u8208\u8DA3|\u73ED$|\u73ED\s|\u8AB2|\u5802|\u92FC\u7434|\u6E38\u6CF3|\u756B\u756B|\u8DF3\u821E|\u8DB3\u7403|\u7C43\u7403|\u97F3\u6A02|class/i.test(lower)) return 'class';
  return 'special';
}

function detectCaregiver(text) {
  for (const c of CAREGIVERS) {
    if (text.includes(c)) return c;
  }
  return '';
}

function handleAdd(text) {
  const body = text.replace(/^[+\uFF0B]\s*/, '').trim();
  if (!body) return '\u274C \u683C\u5F0F\uFF1A+ \u4E8B\u9805\u540D \u65E5\u671F \u6642\u9593 [\u985E\u5225] [\u7167\u9867\u8005]\n\u4F8B\uFF1A+ \u92FC\u7434\u73ED 25/6 16:00 summer EPPIE';

  const parts = body.split(/\s+/);
  if (parts.length < 2) return '\u274C \u9700\u8981\u4E8B\u9805\u540D\u540C\u65E5\u671F\n\u4F8B\uFF1A+ \u92FC\u7434\u73ED 25/6 16:00';

  let date = null, time = null, nameEnd = parts.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parseTime(parts[i]);
    if (t) { time = t; nameEnd = i; break; }
  }
  for (let i = nameEnd - 1; i >= 0; i--) {
    const d = parseDate(parts[i]);
    if (d) { date = d; nameEnd = i; break; }
  }

  if (!date) return '\u274C \u6435\u5514\u5230\u65E5\u671F\uFF0C\u8ACB\u7528 DD/MM\n\u4F8B\uFF1A+ \u92FC\u7434\u73ED 25/6 16:00';

  const name = parts.slice(0, nameEnd).join(' ');
  let remainingParts = parts.slice(nameEnd).filter(p => p !== parts[nameEnd] && !parseTime(p));
  const note = remainingParts.join(' ').trim();
  const category = detectCategory(name + ' ' + note);
  const caregiver = detectCaregiver(body);

  const reminder = { id: uid(), name, category, date, time: time || '00:00', note, caregiver, notified: false };

  const data = readData();
  if (!data.reminders) data.reminders = [];
  data.reminders.push(reminder);
  writeData(data);

  let reply = `\u2705 \u5DF2\u52A0\uFF1A${name}\n\u{1F4C5} ${date} ${time || ''}\n\u{1F3F7}\uFE0F ${CAT_NAMES[category]}`;
  if (caregiver) reply += `\n\u{1F464} ${caregiver}`;
  if (note) reply += `\n\u{1F4DD} ${note}`;
  return reply;
}

function handleDelete(text) {
  const keyword = text.replace(/^[-\uFF0D]\s*/, '').trim();
  if (!keyword) return '\u274C \u683C\u5F0F\uFF1A- \u4E8B\u9805\u540D\n\u4F8B\uFF1A- \u92FC\u7434\u73ED';

  const data = readData();
  const idx = data.reminders.findIndex(r => r.name.includes(keyword));
  if (idx === -1) return `\u274C \u6435\u5514\u5230\u300C${keyword}\u300D`;

  const removed = data.reminders[idx];
  data.reminders.splice(idx, 1);
  writeData(data);
  return `\u{1F5D1}\uFE0F \u5DF2\u522A\uFF1A${removed.name}`;
}

function handleList() {
  const data = readData();
  if (!data.reminders || data.reminders.length === 0) return '\u{1F4ED} \u66AB\u6642\u5187\u63D0\u9192\u4E8B\u9805';

  const sorted = [...data.reminders].sort((a, b) => a.date.localeCompare(b.date));
  let msg = `\u{1F4CB} \u63D0\u9192\u6E05\u55AE\uFF08\u5171 ${sorted.length} \u9805\uFF09\uFF1A\n`;
  const cats = ['school', 'summer', 'routine', 'class', 'special'];
  cats.forEach(cat => {
    const items = sorted.filter(r => r.category === cat);
    if (items.length === 0) return;
    msg += `\n${CAT_ICONS[cat]} ${CAT_NAMES[cat]}\uFF1A`;
    items.forEach(r => {
      msg += `\n  ${r.name} | \u{1F4C5} ${r.date}`;
      if (r.time !== '00:00') msg += ` ${r.time}`;
      if (r.caregiver) msg += ` | \u{1F464}${r.caregiver}`;
    });
    msg += '\n';
  });
  return msg.trim();
}

function handleBirthdayList() {
  const data = readData();
  if (!data.birthdays || data.birthdays.length === 0) return '\u{1F382} \u672A\u6709\u8A2D\u5B9A\u751F\u65E5\n\u52A0\u751F\u65E5\uFF1A+ \u751F\u65E5 \u540D\u5B57 DD/MM';

  const sorted = [...data.birthdays].sort((a, b) => a.date.localeCompare(b.date));
  let msg = '\u{1F382} \u5BB6\u5EAD\u6210\u54E1\u751F\u65E5\uFF1A\n';
  sorted.forEach(b => {
    msg += `\n\u{1F381} ${b.name}\uFF1A${b.date}`;
    if (b.note) msg += ` \uFF08${b.note}\uFF09`;
  });
  return msg;
}

function handleAddBirthday(text) {
  const body = text.replace(/^[+\uFF0B]\u751F\u65E5\s*/i, '').trim();
  if (!body) return '\u274C \u683C\u5F0F\uFF1A+ \u751F\u65E5 \u540D\u5B57 DD/MM\n\u4F8B\uFF1A+ \u751F\u65E5 KEN 15/8';

  const parts = body.split(/\s+/);
  if (parts.length < 2) return '\u274C \u683C\u5F0F\uFF1A+ \u751F\u65E5 \u540D\u5B57 DD/MM';

  let date = null, nameEnd = parts.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    const d = parseBirthDate(parts[i]);
    if (d) { date = d; nameEnd = i; break; }
  }
  if (!date) return '\u274C \u751F\u65E5\u65E5\u671F\u683C\u5F0F\uFF1ADD/MM\n\u4F8B\uFF1A+ \u751F\u65E5 KEN 15/8';

  const name = parts.slice(0, nameEnd).join(' ');
  const note = parts.slice(nameEnd + 1).join(' ').trim();

  const data = readData();
  if (!data.birthdays) data.birthdays = [];
  const existing = data.birthdays.findIndex(b => b.name === name);
  if (existing >= 0) {
    data.birthdays[existing].date = date;
    if (note) data.birthdays[existing].note = note;
  } else {
    data.birthdays.push({ name, date, note });
  }
  writeData(data);
  return `\u{1F382} \u5DF2\u8A18\u9304 ${name} \u751F\u65E5\uFF1A${date}${note ? '\n\u{1F4DD} ' + note : ''}`;
}

function handleHelp() {
  return `\u{1F4D6} \u5BB6\u5EAD\u63D0\u9192\u7CFB\u7D71 - \u6307\u4EE4\u8AAA\u660E

\u2705 \u52A0\u63D0\u9192\uFF1A
+ \u4E8B\u9805\u540D \u65E5\u671F \u6642\u9593 [\u985E\u5225] [\u7167\u9867\u8005]
\u4F8B\uFF1A+ \u92FC\u7434\u73ED 25/6 16:00 summer EPPIE

\u274C \u522A\u63D0\u9192\uFF1A
- \u4E8B\u9805\u540D
\u4F8B\uFF1A- \u92FC\u7434\u73ED

\u{1F4CB} \u7747\u63D0\u9192\u6E05\u55AE
\u63D0\u9192 / \u5217\u8868

\u{1F382} \u52A0\u751F\u65E5\uFF1A
+ \u751F\u65E5 \u540D\u5B57 DD/MM
\u4F8B\uFF1A+ \u751F\u65E5 KEN 15/8

\u{1F382} \u7747\u751F\u65E5\uFF1A
\u751F\u65E5

\u{1F4D6} \u6B64\u8AAA\u660E\uFF1A
\u5E6B\u52A9

\u{1F3F7}\uFE0F \u985E\u5225\u81EA\u52D5\u5075\u6E2C\uFF1A
\u5B78\u6821/\u9762\u8A66 \u2192 \u5B78\u6821\u9762\u8A66
\u6691\u671F/\u590F\u4EE4 \u2192 \u6691\u671F\u5B89\u6392
\u6052\u5E38/\u6BCF\u9031 \u2192 \u6052\u5E38\u65E5\u7A0B
\u8208\u8DA3\u73ED/\u8AB2\u5802 \u2192 \u8208\u8DA3\u73ED
\u5176\u4ED6 \u2192 \u7279\u5225\u65E5\u5B50

\u{1F464} \u7167\u9867\u8005\uFF1AEPPIE / KEN / COFFE / \u674F\u82B1\u6751`;
}

function processMessage(text) {
  const t = text.trim();
  if (!t) return null;

  if (/^[+\uFF0B]\u751F\u65E5/i.test(t)) return handleAddBirthday(t);
  if (/^(\u751F\u65E5|\u751F\u65E5\u67E5\u8A62|checkbirthday)$/i.test(t)) return handleBirthdayList();
  if (/^[+\uFF0B]/.test(t)) return handleAdd(t);
  if (/^[-\uFF0D]/.test(t)) return handleDelete(t);
  if (/^(\u63D0\u9192|\u5217\u8868|list|\u7747\u63D0\u9192|\u6240\u6709\u63D0\u9192)$/i.test(t)) return handleList();
  if (/^(\u5E6B\u52A9|help|\u5E6B\u624B|\u9EDE\u7528|\u6559\u5B78|\u6307\u4EE4|command|\u8AAA\u660E)$/i.test(t)) return handleHelp();
  return null;
}

// ===== 每日自動提醒 =====
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
  if (r.repeat === 'daily') return '\u6BCF\u65E5\u91CD\u8907';
  if (r.repeat === 'weekly') {
    const days = (r.repeatDays||[]).map(d => '\u661F\u671F'+DAY_NAMES[d]);
    return '\u6BCF\u9031 ' + days.join('\u3001');
  }
  if (r.repeat === 'monthly') return '\u6BCF\u6708 ' + (r.repeatDayOfMonth||'??') + ' \u65E5';
  return '';
}

function buildReminderMsg(r, daysUntil) {
  const icon = CAT_ICONS[r.category] || '\u{1F4CC}';
  const catName = CAT_NAMES[r.category] || '\u5176\u4ED6';
  const repeatText = getRepeatText(r);

  let prefix;
  if (daysUntil === 0) prefix = '\u{1F534} \u4ECA\u65E5';
  else if (daysUntil === 1) prefix = '\u{1F7E1} \u660E\u65E5';
  else if (daysUntil <= 3) prefix = `\u{1F7E0} ${daysUntil}\u65E5\u5F8C`;
  else prefix = `\u{1F7E2} ${daysUntil}\u65E5\u5F8C`;

  let msg = `${prefix} ${icon}\u3010${catName}\u3011${r.name}`;
  msg += `\n\u3000\u3000 \u{1F4C5} ${formatDate(r._displayDate || r.date)}\uFF08\u661F\u671F${getWeekDay(r._displayDate || r.date)}\uFF09${r.time !== '00:00' ? ' ' + r.time : ''}`;
  if (repeatText) msg += `\n\u3000\u3000 \u{1F501} ${repeatText}`;
  if (r.caregiver) msg += `\n\u3000\u3000 \u{1F464} ${r.caregiver}`;
  if (r.note) msg += `\n\u3000\u3000 \u{1F4DD} ${r.note}`;
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

async function sendDailyReminder() {
  if (!waConnected || !sock) {
    console.log('[CRON] WhatsApp 未連接，跳過提醒');
    return;
  }

  const data = readData();
  const reminders = data.reminders || [];
  const birthdays = data.birthdays || [];
  const today = new Date(); today.setHours(0,0,0,0);

  const upcoming = [];
  for (const r of reminders) {
    const dates = getRecurringDates(r, today, 7);
    dates.forEach(date => {
      const daysUntil = getDaysUntil(date);
      if (daysUntil >= 0 && daysUntil <= 7) {
        upcoming.push({ ...r, _displayDate: date, daysUntil });
      }
    });
  }
  upcoming.sort((a, b) => a.daysUntil - b.daysUntil);

  const birthdayUpcoming = checkBirthdays(birthdays);

  if (upcoming.length === 0 && birthdayUpcoming.length === 0) {
    console.log('[CRON] 未來7天無提醒事項');
    return;
  }

  const dateStr = `${today.getFullYear()}/${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
  let summary = `\u{1F514} *\u5BB6\u5EAD\u63D0\u9192 \u2014 ${dateStr}*\n`;

  if (birthdayUpcoming.length > 0) {
    summary += `\n\u{1F382} *\u751F\u65E5\u63D0\u9192\uFF1A*\n`;
    birthdayUpcoming.forEach(b => {
      if (b.daysAway === 0) summary += `\u{1F534} \u4ECA\u65E5\u4FC2 *${b.name}* \u751F\u65E5\uFF01\u{1F389}\u{1F381}\n`;
      else if (b.daysAway === 1) summary += `\u{1F7E1} \u660E\u65E5\u4FC2 *${b.name}* \u751F\u65E5\uFF01\uFF08${b.date}\uFF09\n`;
      else summary += `\u{1F7E2} ${b.daysAway}\u65E5\u5F8C\uFF1A*${b.name}* \u751F\u65E5\uFF08${b.date}\uFF09\n`;
    });
  }

  if (upcoming.length > 0) {
    summary += `\n\u{1F4CB} \u672A\u4F867\u65E5\u5171 ${upcoming.length} \u9805\u4E8B\u9805\uFF1A\n`;
    upcoming.forEach(u => { summary += `\n${buildReminderMsg(u, u.daysUntil)}`; });
  }

  const baseUrl = WEB_URL;
  summary += `\n\n\u{1F310} \u7DB2\u9801\u67E5\u770B\uFF1A${baseUrl}`;
  summary += `\n\u{1F4AC} WhatsApp \u7FA4\u7D44\u76F4\u63A5\u6307\u4EE4\uFF1A+ \u4E8B\u9805 / - \u4E8B\u9805 / \u63D0\u9192 / \u5E6B\u52A9`;

  try {
    await sock.sendMessage(GROUP_ID, { text: summary });
    console.log('[CRON] \u2705 \u63D0\u9192\u5DF2\u767C\u9001');
  } catch(e) {
    console.error('[CRON] \u767C\u9001\u5931\u6557:', e.message);
  }
}

// ===== Cron: 每分鐘檢查是否到 07:00 HKT (23:00 UTC) =====
function startCron() {
  setInterval(() => {
    const now = new Date();
    const hktHour = (now.getUTCHours() + 8) % 24;
    const hktMinute = now.getUTCMinutes();
    const todayKey = now.toISOString().slice(0, 10);

    if (hktHour === 7 && hktMinute === 0 && lastReminderDate !== todayKey) {
      lastReminderDate = todayKey;
      console.log('[CRON] 07:00 HKT \u2014 \u767C\u9001\u6BCF\u65E5\u63D0\u9192');
      sendDailyReminder();
    }
  }, 60000);

  console.log('[CRON] \u5DF2\u555F\u52D5\uFF0C\u6BCF\u65E5 07:00 HKT \u767C\u9001\u63D0\u9192');
}

// ===== HTTP Server =====
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // === 首頁 (網頁) ===
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('Server Error');
    }
    return;
  }

  // === QR Code 頁面 ===
  if (req.method === 'GET' && pathname === '/qr') {
    if (waConnected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5"><div style="text-align:center"><h1>\u2705 WhatsApp \u5DF2\u9023\u63A5\uFF01</h1><p>\u5BB6\u5EAD\u63D0\u9192\u7CFB\u7D71\u6B63\u5E38\u904B\u4F5C\u4E2D</p><p><a href="/">\u{1F5A8}\uFE0F \u8FD4\u56DE\u7DB2\u9801</a></p></div></body></html>');
      return;
    }
    if (currentQR) {
      try {
        const qrDataUrl = await qrcode.toDataURL(currentQR, { width: 350, margin: 2 });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp \u9023\u63A5</title><meta http-equiv="refresh" content="10"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5"><div style="text-align:center;background:#fff;padding:30px;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,0.1)"><h2>\u{1F4F1} \u6383\u63CF\u9023\u63A5 WhatsApp</h2><p style="color:#888;font-size:13px;margin-bottom:15px">\u6253\u958B WhatsApp \u2192 \u8A2D\u5B9A \u2192 \u5DF2\u9023\u63A5\u88DD\u7F6E \u2192 \u6383\u63EF QR Code</p><img src="${qrDataUrl}" style="width:300px;height:300px;border-radius:10px"><p style="color:#aaa;font-size:11px;margin-top:10px">QR Code \u6703\u81EA\u52D5\u5237\u65B0</p></div></body></html>`);
        return;
      } catch(e) {
        res.writeHead(500); res.end('QR generation error');
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>\u23F3 \u7B49\u5F85 WhatsApp \u9023\u63A5...</h2><p>\u6B63\u5728\u751F\u6210 QR Code\uFF0C\u8ACB\u7A0D\u5019</p><meta http-equiv="refresh" content="5"></div></body></html>');
    return;
  }

  // === Health Check ===
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      wa_connected: waConnected,
      qr_pending: !!currentQR,
      time: new Date().toISOString()
    }));
    return;
  }

  // === WA Status (for web page) ===
  if (req.method === 'GET' && pathname === '/wa-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected: waConnected, qr_pending: !!currentQR }));
    return;
  }

  // === 手動發送提醒 ===
  if (req.method === 'POST' && pathname === '/send-reminder') {
    sendDailyReminder();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: '提醒已觸發' }));
    return;
  }


  // === 發送自定義消息 ===
  if (req.method === 'POST' && pathname === '/api/send-message') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      if (!waConnected || !sock) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WhatsApp 未連接' }));
        return;
      }
      try {
        const { to, message } = JSON.parse(body);
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '消息內容不能為空' }));
          return;
        }
        const target = to || GROUP_ID;
        await sock.sendMessage(target, { text: message });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, target }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === GET /data ===
  if (req.method === 'GET' && pathname === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(readData()));
    return;
  }

  // === POST /data ===
  if (req.method === 'POST' && pathname === '/data') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        writeData(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // === POST /reminders ===
  if (req.method === 'POST' && pathname === '/reminders') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        const data = readData();
        item.id = item.id || uid();
        item.notified = false;
        if (!data.reminders) data.reminders = [];
        data.reminders.push(item);
        writeData(data);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: item.id }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // === PUT /reminders/:id ===
  const editMatch = pathname.match(/^\/reminders\/(.+)$/);
  if (req.method === 'PUT' && editMatch) {
    const id = decodeURIComponent(editMatch[1]);
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const data = readData();
        const idx = data.reminders.findIndex(r => r.id === id);
        if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
        data.reminders[idx] = Object.assign({}, data.reminders[idx], updates);
        writeData(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // === DELETE /reminders/:id ===
  if (req.method === 'DELETE' && editMatch) {
    const id = decodeURIComponent(editMatch[1]);
    const data = readData();
    const before = data.reminders.length;
    data.reminders = data.reminders.filter(r => r.id !== id);
    if (data.reminders.length === before) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    writeData(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // === POST /birthdays ===
  if (req.method === 'POST' && pathname === '/birthdays') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        const data = readData();
        if (!data.birthdays) data.birthdays = [];
        const existing = data.birthdays.findIndex(b => b.name === item.name);
        if (existing >= 0) data.birthdays[existing] = item;
        else data.birthdays.push(item);
        writeData(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // === DELETE /birthdays/:name ===
  const bdayMatch = pathname.match(/^\/birthdays\/(.+)$/);
  if (req.method === 'DELETE' && bdayMatch) {
    const name = decodeURIComponent(bdayMatch[1]);
    const data = readData();
    data.birthdays = data.birthdays.filter(b => b.name !== name);
    writeData(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: pathname }));
});

// ===== 啟動 =====
async function main() {
  console.log('=================================');
  console.log('\u{1F3E0} \u5BB6\u5EAD\u63D0\u9192\u7CFB\u7D71 - \u96F2\u7AEF\u670D\u52D9');
  console.log('=================================');

  // 1. 從雲端同步數據
  console.log('[INIT] \u5F9E\u96F2\u7AEF\u540C\u6B65\u6578\u64DA...');
  const cloudData = await syncDataFromCloud();
  if (cloudData) {
    console.log('[INIT] \u2705 \u6578\u64DA\u5DF2\u540C\u6B65');
  } else {
    console.log('[INIT] \u4F7F\u7528\u672C\u5730\u6578\u64DA');
  }

  // 2. 啟動 HTTP Server
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] \u{1F310} \u670D\u52D9\u5668\u5DF2\u555F\u52D5: http://0.0.0.0:${PORT}`);
    console.log(`[HTTP] \u{1F4F1} QR Code: http://localhost:${PORT}/qr`);
  });

  // 3. 連接 WhatsApp
  console.log('[WA] \u9023\u63A5 WhatsApp...');
  connectWhatsApp().catch(err => {
    console.error('[WA] \u521D\u59CB\u9023\u63A5\u5931\u6557:', err.message);
    setTimeout(() => connectWhatsApp(), 10000);
  });

  // 4. 啟動定時任務
  startCron();

  // 5. 錯誤處理
  process.on('uncaughtException', err => console.error('[ERROR] uncaught:', err.message));
  process.on('unhandledRejection', err => console.error('[ERROR] unhandled:', err));
}

main();
