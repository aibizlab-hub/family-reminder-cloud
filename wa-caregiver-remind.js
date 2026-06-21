/**
 * GitHub Actions: 照顧者個人 WhatsApp 提醒
 * - 提早 1 天提醒（每日 09:00 HKT 發送）
 * - 提早 3 小時提醒（每小時檢查）
 * 
 * 資料來源：GitHub API data.json
 * 發送目標：照顧者個人 WhatsApp（非群組）
 */

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('baileys');
const fs = require('fs');
const https = require('https');
const path = require('path');
const NodeCache = require('node-cache');

// ===== 照顧者電話對照表 =====
const CAREGIVER_PHONES = {
  'KEN':         { phone: '852622189999', name: 'KEN' },
  'EPPIE':       { phone: '85262218999',  name: 'EPPIE（太太）' },
  'Kenny Yam':   { phone: '85291339336',  name: 'Kenny Yam' },
  'Rosanna Mok': { phone: '85293398522',  name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322',  name: 'COFFE' },
  '老豆':        { phone: '85262269100',  name: '老豆' }
};
// ===== 群組 =====
const GROUP_ID = '120363412134951607@g.us'; // 揸揸的家長們
  'Rosanna Mok': { phone: '85293398522',  name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322',  name: 'COFFE' }
};

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT;
const GITHUB_REPO = 'ken851004-afk/family-reminder-cloud';

const CAT_ICONS = { school: '🏫', class: '🎨', special: '⭐', summer: '☀️', routine: '📅' };
const DAY_NAMES = ['日','一','二','三','四','五','六'];

// ===== GitHub API helpers =====
function githubApiGet(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: '/repos/' + GITHUB_REPO + '/contents/' + apiPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'wa-caregiver-remind'
      }
    };
    const req = https.request(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.content) {
            resolve({ data: JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf-8')), sha: j.sha });
          } else reject(new Error('GitHub API: ' + (j.message || 'unknown')));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function githubApiPut(apiPath, content, sha, message) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(JSON.stringify(content, null, 2), 'utf-8').toString('base64');
    const body = JSON.stringify({ message, content: b64, sha, branch: 'master' });
    const opts = {
      hostname: 'api.github.com',
      path: '/repos/' + GITHUB_REPO + '/contents/' + apiPath,
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'wa-caregiver-remind',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(b));
        else reject(new Error('GitHub PUT ' + res.statusCode + ': ' + b.substring(0, 200)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ===== Helper functions =====
function getWeekDay(dateStr) {
  return DAY_NAMES[new Date(dateStr + 'T00:00:00').getDay()];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function buildCaregiverMsg(r, type) {
  const icon = CAT_ICONS[r.category] || '📌';
  const prefix = type === '1day' ? '⏰ 提早一天提醒' : '🚨 三小時後提醒';
  let msg = `${prefix}\n\n`;
  msg += `${icon} *${r.name}*\n`;
  msg += `📅 ${formatDate(r.date)}（星期${getWeekDay(r.date)}）${r.time && r.time !== '00:00' ? ' ' + r.time : ''}\n`;
  if (r.address) msg += `📍 ${r.address}\n`;
  if (r.note) msg += `📝 ${r.note}\n`;
  msg += `\n👤 照顧者：${r.caregiver}\n`;
  msg += `🌐 查看全部：https://b791d247cb6640908835e5bd7d0454a9.app.codebuddy.work`;
  return msg;
}

// ===== Main =====
async function main() {
  console.log('=== Caregiver WhatsApp Reminder ===');
  const now = new Date();
  const hkNow = new Date(now.getTime() + 8 * 3600000); // HKT
  const hkHour = hkNow.getUTCHours();
  const hkDateStr = `${hkNow.getUTCFullYear()}-${String(hkNow.getUTCMonth()+1).padStart(2,'0')}-${String(hkNow.getUTCDate()).padStart(2,'0')}`;
  
  console.log(`[TIME] HKT: ${hkDateStr} ${String(hkHour).padStart(2,'0')}:${String(hkNow.getUTCMinutes()).padStart(2,'0')}`);

  // 1. Fetch data.json from GitHub
  console.log('[DATA] Fetching data.json from GitHub...');
  let ghResult;
  try {
    ghResult = await githubApiGet('data.json');
  } catch(e) {
    console.error('[DATA] Failed:', e.message);
    process.exit(1);
  }
  const data = ghResult.data;
  const sha = ghResult.sha;
  const reminders = data.reminders || [];
  console.log(`[DATA] Loaded ${reminders.length} reminders`);

  // 2. Find reminders that need caregiver notification
  const toNotify = [];
  let dataChanged = false;

  for (const r of reminders) {
    if (!r.caregiver || !CAREGIVER_PHONES[r.caregiver]) continue;
    
    const eventDate = r.date; // YYYY-MM-DD
    const eventTime = r.time || '09:00';
    
    // Calculate date diff
    const today = new Date(hkDateStr + 'T00:00:00');
    const eventDay = new Date(eventDate + 'T00:00:00');
    const daysUntil = Math.ceil((eventDay - today) / 86400000);
    
    // Check 1-day-before: only at 09:00 HKT
    if (daysUntil === 1 && hkHour === 9 && !r.caregiverNotified1d) {
      toNotify.push({ reminder: r, type: '1day' });
      r.caregiverNotified1d = true;
      dataChanged = true;
      console.log(`[1DAY] ${r.name} → ${r.caregiver}`);
    }
    
    // Check 3-hours-before: event is today, check time
    if (daysUntil === 0 && !r.caregiverNotified3h) {
      const [eh, em] = eventTime.split(':').map(Number);
      const eventHkTime = eh * 60 + em; // minutes from midnight HKT
      const nowHkTime = hkHour * 60 + hkNow.getUTCMinutes();
      const diffMin = eventHkTime - nowHkTime;
      
      // Send if event is 2.5-3.5 hours away (catch once within the hourly window)
      if (diffMin >= 150 && diffMin <= 210) {
        toNotify.push({ reminder: r, type: '3hour' });
        r.caregiverNotified3h = true;
        dataChanged = true;
        console.log(`[3HOUR] ${r.name} (${eventTime}) → ${r.caregiver}`);
      }
    }
    
    // Reset flags if event has passed
    if (daysUntil < 0 && (r.caregiverNotified1d || r.caregiverNotified3h)) {
      r.caregiverNotified1d = false;
      r.caregiverNotified3h = false;
      dataChanged = true;
    }
  }

  // Save updated flags to GitHub
  if (dataChanged) {
    try {
      await githubApiPut('data.json', data, sha, 'Update caregiver notification flags');
      console.log('[DATA] Updated notification flags on GitHub');
    } catch(e) {
      console.error('[DATA] Failed to update flags:', e.message);
    }
  }

  if (toNotify.length === 0) {
    console.log('[CRON] No caregiver notifications needed. Exiting.');
    process.exit(0);
  }

  console.log(`[CRON] ${toNotify.length} notifications to send`);

  // 3. Decode WhatsApp creds
  if (!process.env.WA_CREDS_B64) {
    console.error('WA_CREDS_B64 not set');
    process.exit(1);
  }
  const credsJson = Buffer.from(process.env.WA_CREDS_B64, 'base64').toString('utf8');
  const SESSION_DIR = '/tmp/wa-session-caregiver';
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, 'creds.json'), credsJson);
  console.log('[WA] creds.json written');

  // 4. Connect & send
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
      browser: ['Caregiver Reminder', 'Chrome', '1.0.0']
    });

    let sent = 0;
    const target = toNotify.length;
    
    const timeout = setTimeout(() => {
      console.error(`[WA] Timeout: sent ${sent}/${target}`);
      sock.end();
      resolve();
    }, 120000);

    sock.ev.on('creds.update', () => saveCreds());

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('[WA] Connected! Sending notifications...');
        for (const item of toNotify) {
          const care = CAREGIVER_PHONES[item.reminder.caregiver];
          if (!care) { console.log(`[SKIP] No phone for ${item.reminder.caregiver}`); continue; }
          
          const jid = care.phone + '@s.whatsapp.net';
          const msg = buildCaregiverMsg(item.reminder, item.type);
          
          try {
            await sock.sendMessage(jid, { text: msg });
            console.log(`[SENT] ${item.reminder.name} → ${care.name} (${care.phone}) [${item.type}]`);
            sent++;
            // Small delay between messages
            await new Promise(r => setTimeout(r, 1500));
          } catch(e) {
            console.error(`[FAIL] ${item.reminder.name} → ${care.name}: ${e.message}`);
          }
        }
        
        console.log(`[WA] Done! Sent ${sent}/${target}`);
        clearTimeout(timeout);
        setTimeout(() => { sock.end(); resolve(); }, 2000);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[WA] Closed (code: ${code})`);
        if (sent === 0) {
          clearTimeout(timeout);
          reject(new Error(`Connection closed: ${code}`));
        } else {
          clearTimeout(timeout);
          resolve();
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
