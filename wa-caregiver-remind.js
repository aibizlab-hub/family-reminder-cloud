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
  'KEN':         { phone: '85262218999', name: 'KEN' },
  'EPPIE':       { phone: '85297510047',  name: '🐑 EPPIE（太太）' },
  'Kenny Yam':   { phone: '85291339336',  name: 'Kenny Yam' },
  'Rosanna Mok': { phone: '85293398522',  name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322',  name: 'COFFE' },
  '老豆':        { phone: '85262269100',  name: '老豆' }
};
// ===== 群組 =====
const GROUP_ID = '120363412134951607@g.us'; // 揸揸的家長們

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
    const doReq = (bodyStr) => {
      const req = https.request(opts, res => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => {
          if (res.statusCode === 409) {
            // SHA conflict — re-fetch latest sha and retry ONCE
            console.log('[GH] SHA conflict, re-fetching...');
            githubApiGet(apiPath).then(fresh => {
              const newSha = fresh.sha;
              const newB64 = Buffer.from(JSON.stringify(content, null, 2), 'utf-8').toString('base64');
              const newBody = JSON.stringify({ message, content: newB64, sha: newSha, branch: 'master' });
              const req2 = https.request(opts, res2 => {
                let b2 = ''; res2.on('data', c => b2 += c);
                res2.on('end', () => {
                  if (res2.statusCode >= 200 && res2.statusCode < 300) resolve(JSON.parse(b2));
                  else reject(new Error('GitHub PUT retry ' + res2.statusCode + ': ' + b2.substring(0, 200)));
                });
              });
              req2.on('error', reject);
              req2.write(newBody);
              req2.end();
            }).catch(reject);
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(b));
          else reject(new Error('GitHub PUT ' + res.statusCode + ': ' + b.substring(0, 200)));
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    };
    doReq(body);
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

function matchesRepeatDate(r, checkDateStr) {
  if (!r.repeat || r.repeat === 'none') return false;
  const checkDay = new Date(checkDateStr + 'T00:00:00');
  if (r.repeat === 'daily') return true;
  if (r.repeat === 'weekly' && r.repeatDays && r.repeatDays.length > 0) {
    return r.repeatDays.includes(checkDay.getDay());
  }
  if (r.repeat === 'monthly') {
    const dom = r.repeatDayOfMonth || new Date(r.date + 'T00:00:00').getDate();
    return checkDay.getDate() === dom;
  }
  return false;
}

function buildCaregiverMsg(r, type, isBirthday) {
  if (isBirthday) {
    let msg = '🎉 *' + r.name + '*\n\n';
    msg += '📅 ' + formatDate(r.date) + '（星期' + getWeekDay(r.date) + '）\n';
    if (r.note) msg += '📝 ' + r.note + '\n';
    msg += '\n👉 記得祝賀同準備慶祝！';
    msg += '\n🌐 查看全部：https://ken851004-afk.github.io/family-reminder-cloud/';
    return msg;
  }
  const icon = CAT_ICONS[r.category] || '📌';
  const prefix = type === '1day' ? '⏰ 提早一天提醒' : '🚨 三小時後提醒';
  let msg = `${prefix}\n\n`;
  msg += `${icon} *${r.name}*\n`;
  msg += `📅 ${formatDate(r.date)}（星期${getWeekDay(r.date)}）${r.time && r.time !== '00:00' ? ' ' + r.time : ''}\n`;
  if (r.address) msg += `📍 ${r.address}\n`;
  if (r.note) msg += `📝 ${r.note}\n`;
  
  // Show "全部人" if caregiver is 'ALL'
  if (r.caregiver === 'ALL') {
    msg += `\n👥 照顧者：全部人\n`;
  } else {
    msg += `\n👤 照顧者：${r.caregiver}\n`;
  }
  
  msg += `🌐 查看全部：https://ken851004-afk.github.io/family-reminder-cloud/`;
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
  const tomorrowDate = new Date(new Date(hkDateStr + 'T00:00:00').getTime() + 86400000).toISOString().slice(0, 10);

  for (const r of reminders) {
    // Skip if no caregiver specified
    // For work items with no caregiver, treat as KEN's item (safety net)
    if (!r.caregiver) {
      if (r.category === 'work') {
        r.caregiver = 'KEN';
        dataChanged = true;
      } else {
        continue;
      }
    }
    
    // Skip if caregiver is specified but not in our phone list (and not 'ALL')
    if (r.caregiver !== 'ALL' && !CAREGIVER_PHONES[r.caregiver]) continue;
    
    const eventTime = r.time || '09:00';
    
    // Calculate date diff for original date
    const today = new Date(hkDateStr + 'T00:00:00');
    const eventDay = new Date(r.date + 'T00:00:00');
    const daysUntil = Math.ceil((eventDay - today) / 86400000);
    
    // Determine which date(s) apply: original date OR repeat match
    const appliesToday = (daysUntil === 0) || (daysUntil < 0 && matchesRepeatDate(r, hkDateStr));
    const appliesTomorrow = (daysUntil === 1) || (daysUntil <= 0 && matchesRepeatDate(r, tomorrowDate));
    
    // Check 1-day-before: only at 09:00 HKT
    if (appliesTomorrow && hkHour === 9 && !r.caregiverNotified1d) {
      const actualDate = (daysUntil === 1) ? r.date : tomorrowDate;
      toNotify.push({ reminder: {...r, date: actualDate}, type: '1day' });
      r.caregiverNotified1d = true;
      dataChanged = true;
      console.log(`[1DAY] ${r.name} → ${r.caregiver}`);
    }
    
    // Check 3-hours-before: event is today, check time
    if (appliesToday && !r.caregiverNotified3h) {
      const [eh, em] = eventTime.split(':').map(Number);
      const eventHkTime = eh * 60 + em; // minutes from midnight HKT
      const nowHkTime = hkHour * 60 + hkNow.getUTCMinutes();
      const diffMin = eventHkTime - nowHkTime;
      
      // Wider window: 120-240 min (2-4 hours ahead)
      if (diffMin >= 120 && diffMin <= 240) {
        const actualDate = (daysUntil === 0) ? r.date : hkDateStr;
        toNotify.push({ reminder: {...r, date: actualDate}, type: '3hour' });
        r.caregiverNotified3h = true;
        dataChanged = true;
        console.log(`[3HOUR] ${r.name} (${eventTime}) → ${r.caregiver}`);
      }
    }
    
    // Reset flags for non-repeating events that are long past (>7 days)
    if (daysUntil < -7 && !matchesRepeatDate(r, hkDateStr) && !matchesRepeatDate(r, tomorrowDate)) {
      if (r.caregiverNotified1d || r.caregiverNotified3h) {
        if (!r.repeat || r.repeat === 'none') {
          r.caregiverNotified1d = false;
          r.caregiverNotified3h = false;
          dataChanged = true;
        }
      }
    }
  }

  // 2b. Check birthdays
  const todayMMDD = hkDateStr.slice(5); // MM-DD
  const bdaysToday = (data.birthdays || []).filter(b => b.date === todayMMDD);
  if (bdaysToday.length > 0) {
    console.log(`[BDAY] ${bdaysToday.length} birthday(s) today: ${bdaysToday.map(b=>b.name).join(', ')}`);
    // Send at 09:00 HKT only
    if (hkHour === 9) {
      for (const b of bdaysToday) {
        const bdayReminder = {
          name: b.name + ' 生日',
          date: hkDateStr,
          time: '09:00',
          category: 'special',
          caregiver: 'ALL',
          note: b.note || '',
          address: '',
          _isBirthday: true
        };
        toNotify.push({ reminder: bdayReminder, type: '1day', isBirthday: true });
      }
    }
  }

  // Check if there's anything to do
  const groupNotifs = data.groupNotifications || [];
  const pendingMsgs = data.pendingMessages || [];
  const pendingCount = pendingMsgs.length;
  if (toNotify.length === 0 && groupNotifs.length === 0 && pendingCount === 0) {
    console.log('[CRON] Nothing to do. Exiting.');
    process.exit(0);
  }

  console.log(`[CRON] ${toNotify.length} caregiver + ${groupNotifs.length} group + ${pendingCount} pending notifications to send`);

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
      printQRInTerminal: true,  // Enable for debugging
      qr: (qr) => {
        console.error('[WA] ⚠️ QR CODE NEEDED! Scan this with WhatsApp:');
        console.error(qr);
        console.error('[WA] (This means WA_CREDS_B64 is expired or invalid)');
      },
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
        
        // Send group notifications (caregiver changes)
        const groupNotifs = data.groupNotifications || [];
        for (const gn of groupNotifs) {
          const rem = data.reminders.find(r => r.name === gn.reminderName);
          const dt = rem ? rem.date : '(不詳)';
          const msg = `📋 *照顧者已更改*\n\n事項：${gn.reminderName}\n日期：${dt}\n之前：${gn.oldCaregiver}\n現在：${gn.newCaregiver}\n\n🌐 查看全部：https://ken851004-afk.github.io/family-reminder-cloud/`;
          try {
            await sock.sendMessage(GROUP_ID, { text: msg });
            console.log(`[SENT-GRP] ${gn.reminderName}: ${gn.oldCaregiver} → ${gn.newCaregiver}`);
          } catch(e) {
            console.error(`[FAIL-GRP] ${gn.reminderName}: ${e.message}`);
          }
        }
        // Clear group notifications after sending
        if (groupNotifs.length > 0) {
          data.groupNotifications = [];
          dataChanged = true;
          console.log(`[GRP] Cleared ${groupNotifs.length} group notifications`);
        }

        // Process pending ad-hoc WhatsApp messages
        if (pendingMsgs.length > 0) {
          console.log(`[PENDING] Processing ${pendingMsgs.length} ad-hoc messages`);
          for (const msg of pendingMsgs) {
            try {
              const jid = msg.phone.includes('@') ? msg.phone : msg.phone + '@s.whatsapp.net';
              await sock.sendMessage(jid, { text: msg.text });
              console.log(`[PENDING-SENT] → ${msg.phone}: ${msg.text.substring(0, 40)}`);
              sent++;
              await new Promise(r => setTimeout(r, 1000));
            } catch(e) {
              console.error(`[PENDING-FAIL] → ${msg.phone}: ${e.message}`);
            }
          }
          data.pendingMessages = [];
          dataChanged = true;
          console.log(`[PENDING] Cleared ${pendingMsgs.length} pending messages`);
        }
        
        for (const item of toNotify) {
          const reminder = item.reminder;
          
          // If caregiver is 'ALL', send to all caregivers
          if (reminder.caregiver === 'ALL') {
            console.log(`[ALL] Sending to all caregivers: ${reminder.name}`);
            
            for (const [careName, careInfo] of Object.entries(CAREGIVER_PHONES)) {
              const jid = careInfo.phone + '@s.whatsapp.net';
              const msg = buildCaregiverMsg(reminder, item.type, item.isBirthday);
              console.log(`[DEBUG] Sending to JID: ${jid}, Name: ${careInfo.name}`);
              
              try {
                await sock.sendMessage(jid, { text: msg });
                console.log(`[SENT-ALL] ${reminder.name} → ${careInfo.name} (${careInfo.phone}) [${item.type}]`);
                sent++;
                // Small delay between messages
                await new Promise(r => setTimeout(r, 1500));
              } catch(e) {
                console.error(`[FAIL-ALL] ${reminder.name} → ${careInfo.name}: ${e.message}`);
              }
            }
          } else {
            // Send to single caregiver (original logic)
            const care = CAREGIVER_PHONES[reminder.caregiver];
            if (!care) { console.log(`[SKIP] No phone for ${reminder.caregiver}`); continue; }
            
            const jid = care.phone + '@s.whatsapp.net';
            const msg = buildCaregiverMsg(reminder, item.type);
            console.log(`[DEBUG] Sending to JID: ${jid}, Name: ${care.name}`);
            
            try {
              await sock.sendMessage(jid, { text: msg });
              console.log(`[SENT] ${reminder.name} → ${care.name} (${care.phone}) [${item.type}]`);
              sent++;
              // Small delay between messages
              await new Promise(r => setTimeout(r, 1500));
            } catch(e) {
              console.error(`[FAIL] ${reminder.name} → ${care.name}: ${e.message}`);
            }
          }
        }
        
        console.log(`[WA] Done! Sent ${sent}/${target}`);
        // Save data (updated flags + cleared group notifications)
        if (dataChanged) {
          try {
            await githubApiPut('data.json', data, sha, 'Update notification flags + clear group notifications');
            console.log('[DATA] Saved to GitHub');
          } catch(e) {
            console.error('[DATA] Failed to save:', e.message);
          }
        }
        clearTimeout(timeout);
        setTimeout(() => { sock.end(); resolve(); }, 2000);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || 'unknown';
        console.error(`[WA] Connection closed! Code: ${statusCode}, Error: ${errorMsg}`);
        console.error('[WA] lastDisconnect:', JSON.stringify(lastDisconnect, null, 2));
        // Only error if we had notifications but failed to send any
        if (sent === 0 && toNotify.length > 0) {
          clearTimeout(timeout);
          reject(new Error(`Connection closed before sending: ${statusCode} - ${errorMsg}`));
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
