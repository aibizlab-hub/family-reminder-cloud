const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

// 配置
const DATA_URL = 'https://raw.githubusercontent.com/ken851004-afk/family-reminder-cloud/master/data.json';
const WACLI_PATH = 'C:\\Users\\KEN85\\.workbuddy\\binaries\\wacli\\wacli.exe';
const STATE_FILE = path.join(__dirname, 'reminder-state.json');
const LOG_FILE = path.join(__dirname, 'reminder-log.txt');

// 讀取狀態
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { sent: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(line.trim());
}

// 下載 data.json
function fetchData() {
  return new Promise((resolve, reject) => {
    https.get(DATA_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// 檢查提醒是否到期
function checkReminders(data, state) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  const caregivers = data.caregivers || [];
  const reminders = data.reminders || [];

  for (const rem of reminders) {
    if (!rem.enabled) continue;

    const [remHour, remMin] = rem.time.split(':').map(Number);
    const dayKey = `${rem.id}_${today}`;

    // 跳過今日已發送
    if (state.sent[dayKey]) continue;

    // 檢查時間（容許 5 分鐘誤差）
    const timeDiff = Math.abs((currentHour * 60 + currentMinute) - (remHour * 60 + remMin));
    if (timeDiff > 5) continue;

    // 檢查重複規則
    if (!shouldRunToday(rem, today)) continue;

    // 發送 WhatsApp
    sendReminder(rem, caregivers, state, dayKey);
  }
}

function shouldRunToday(rem, today) {
  if (rem.repeat === 'never') {
    return rem.date === today;
  }
  if (rem.repeat === 'daily') return true;
  if (rem.repeat === 'weekly') {
    const todayDow = new Date(today).getDay();
    const remDow = new Date(rem.date).getDay();
    return todayDow === remDow;
  }
  if (rem.repeat === 'monthly') {
    const todayDate = new Date(today).getDate();
    const remDate = new Date(rem.date).getDate();
    return todayDate === remDate;
  }
  if (rem.repeat === 'weekdays') {
    const dow = new Date(today).getDay();
    return dow >= 1 && dow <= 5;
  }
  if (Array.isArray(rem.repeatDays)) {
    const dow = new Date(today).getDay();
    return rem.repeatDays.includes(dow);
  }
  return false;
}

function sendReminder(rem, caregivers, state, dayKey) {
  const caregiver = caregivers.find(c => c.id === rem.caregiverId);
  if (!caregiver || !caregiver.phone) {
    log(`WARN: No phone for caregiver ${rem.caregiverId}`);
    return;
  }

  const phone = caregiver.phone.startsWith('+') ? caregiver.phone : `+${caregiver.phone}`;
  const message = formatMessage(rem, caregiver);

  log(`Sending to ${caregiver.name} (${phone})...`);

  const proc = spawn(WACLI_PATH, ['send', 'text', '--to', phone, '--message', message], {
    stdio: 'inherit'
  });

  proc.on('close', (code) => {
    if (code === 0) {
      state.sent[dayKey] = Date.now();
      saveState(state);
      log(`✅ Sent: ${rem.title} → ${caregiver.name}`);
    } else {
      log(`❌ Failed (code ${code}): ${rem.title}`);
    }
  });
}

function formatMessage(rem, caregiver) {
  let msg = `📌 *${rem.title}*\n`;
  if (rem.details && rem.details.length > 0) {
    msg += `\n明細：\n`;
    rem.details.forEach(d => { msg += `  • ${d}\n`; });
  }
  if (rem.note) msg += `\n備註：${rem.note}\n`;
  msg += `\n照顧者：${caregiver.name}`;
  return msg;
}

// 清理舊狀態
function cleanupState(state) {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  for (const key of Object.keys(state.sent)) {
    if (state.sent[key] < weekAgo) delete state.sent[key];
  }
}

// 主循環
async function main() {
  log('🚀 Reminder service started');

  // 每分鐘檢查一次
  setInterval(async () => {
    try {
      const data = await fetchData();
      const state = loadState();
      cleanupState(state);
      checkReminders(data, state);
    } catch (e) {
      log(`ERROR: ${e.message}`);
    }
  }, 60000);

  // 啟動時立即檢查一次
  try {
    const data = await fetchData();
    const state = loadState();
    checkReminders(data, state);
  } catch (e) {
    log(`Startup check failed: ${e.message}`);
  }

  log('✅ Service running (checking every 60s)');
}

main();
