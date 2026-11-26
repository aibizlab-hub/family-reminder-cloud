/**
 * GitHub Actions: 照顧者個人 WhatsApp 提醒 (CallMeBot Gateway)
 * - 提早 1 天提醒（每日 09:00 HKT 發送）
 * - 提早 3 小時提醒（每小時檢查）
 *
 * 發送層：CallMeBot WhatsApp Gateway
 *   - 永遠唔使掃 QR、唔使 baileys session
 *   - 用永久 API key（每位照顧者向 @CallMeBot 拎一次）
 *   - 雲端 GitHub Actions 直接 call，唔使開電腦
 *
 * Env (GitHub Secrets):
 *   CALLMEBOT_KEN      KEN 嘅 CallMeBot API key
 *   CALLMEBOT_EPPIE    EPPIE 嘅 CallMeBot API key
 *   CALLMEBOT_KENNY    Kenny Yam 嘅 CallMeBot API key
 *   CALLMEBOT_ROSANNA  Rosanna Mok 嘅 CallMeBot API key
 *   CALLMEBOT_COFFE    COFFE 嘅 CallMeBot API key
 *   CALLMEBOT_LODOU   老豆 嘅 CallMeBot API key (optional)
 *   GITHUB_TOKEN       GitHub token (讀寫 data.json)
 *   GITHUB_REPO        aibizlab-hub/family-reminder-cloud
 */

const https = require('https');

// ===== 照顧者電話對照表 (E.164 without '+') =====
const CAREGIVER_PHONES = {
  'KEN':         { phone: '85262218999',  name: 'KEN' },
  'EPPIE':       { phone: '85297510047',  name: 'EPPIE（太太）' },
  'Kenny Yam':   { phone: '85291339336',  name: 'Kenny Yam' },
  'Rosanna Mok': { phone: '85293398522',  name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322',  name: 'COFFE' },
  '老豆':        { phone: '85262269100',  name: '老豆' }
};

// 收件人解析：優先 caregivers 陣列；其次 ALL；最後單一 caregiver（向後兼容）
function targetsFor(r) {
  if (Array.isArray(r.caregivers) && r.caregivers.length) return r.caregivers.slice();
  if (r.caregiver === 'ALL') return Object.keys(CAREGIVER_PHONES);
  return [r.caregiver];
}
// ===== CallMeBot API keys (per caregiver, from GitHub Secrets) =====
const CALLMEBOT_KEYS = {
  'KEN':         process.env.CALLMEBOT_KEN,
  'EPPIE':       process.env.CALLMEBOT_EPPIE,
  'Kenny Yam':   process.env.CALLMEBOT_KENNY,
  'Rosanna Mok': process.env.CALLMEBOT_ROSANNA,
  'COFFE':       process.env.CALLMEBOT_COFFE,
  '老豆':        process.env.CALLMEBOT_LODOU,
};

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT;
const GITHUB_REPO  = process.env.GITHUB_REPO || 'aibizlab-hub/family-reminder-cloud';

const CAT_ICONS = { school: '🏫', class: '🎨', special: '⭐', summer: '☀️', routine: '📅' };
const DAY_NAMES = ['日','一','二','三','四','五','六'];

// ===== GitHub API helpers (keep existing) =====
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

// ===== Helpers =====
function getWeekDay(dateStr) { return DAY_NAMES[new Date(dateStr + 'T00:00:00').getDay()]; }
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
  if (Array.isArray(r.caregivers) && r.caregivers.length) msg += `\n👥 照顧者：${r.caregivers.join(' + ')}\n`;
  else if (r.caregiver === 'ALL') msg += `\n👥 照顧者：全部人\n`;
  else msg += `\n👤 照顧者：${r.caregiver}\n`;
  msg += `🌐 查看全部：https://aibizlab-hub.github.io/family-reminder-cloud/`;
  return msg;
}

// ===== CallMeBot WhatsApp Gateway send =====
// Docs: https://www.callmebot.com/blog/free-api-whatsapp-messages
// GET https://api.callmebot.com/whatsapp.php?phone=PHONE&text=TEXT&apikey=APIKEY
async function sendCallMeBot(caregiver, text) {
  const key = CALLMEBOT_KEYS[caregiver];
  const phone = CAREGIVER_PHONES[caregiver] && CAREGIVER_PHONES[caregiver].phone;
  if (!key || !phone) {
    console.log(`[SKIP] ${caregiver}: 無 CallMeBot key/電話，跳過`);
    return false;
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    clearTimeout(timer);
    if (res.status === 200) {
      console.log(`[CALLMEBOT] ✓ ${caregiver} (${phone}): 已排隊發送`);
      return true;
    } else {
      console.error(`[CALLMEBOT] ✗ ${caregiver} (${phone}): HTTP ${res.status} ${body.slice(0, 120)}`);
      return false;
    }
  } catch (e) {
    clearTimeout(timer);
    console.error(`[CALLMEBOT] ✗ ${caregiver} (${phone}): ${e.message}`);
    return false;
  }
}

// ===== Main =====
async function main() {
  console.log('=== Caregiver WhatsApp Reminder (CallMeBot) ===');
  if (!GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN not set — cannot read data');
    process.exit(1);
  }
  const configuredKeys = Object.entries(CALLMEBOT_KEYS).filter(([, v]) => v).map(([k]) => k);
  console.log(`[KEYS] 已配置 CallMeBot key: ${configuredKeys.length ? configuredKeys.join(', ') : '（全無）'}`);

  const now = new Date();
  const hkNow = new Date(now.getTime() + 8 * 3600000);
  const hkHour = hkNow.getUTCHours();
  const hkDateStr = `${hkNow.getUTCFullYear()}-${String(hkNow.getUTCMonth()+1).padStart(2,'0')}-${String(hkNow.getUTCDate()).padStart(2,'0')}`;
  console.log(`[TIME] HKT: ${hkDateStr} ${String(hkHour).padStart(2,'0')}:${String(hkNow.getUTCMinutes()).padStart(2,'0')}`);

  let ghResult;
  try {
    ghResult = await githubApiGet('data.json');
  } catch (e) {
    console.error('[DATA] Failed:', e.message);
    process.exit(1);
  }
  const data = ghResult.data;
  const sha = ghResult.sha;
  const reminders = data.reminders || [];
  console.log(`[DATA] Loaded ${reminders.length} reminders`);

  const toNotify = [];
  let dataChanged = false;

  for (const r of reminders) {
    if (!r.caregiver) continue;
    if (r.caregiver !== 'ALL' && !CAREGIVER_PHONES[r.caregiver]) continue;

    const eventTime = r.time || '09:00';
    const today = new Date(hkDateStr + 'T00:00:00');
    const eventDay = new Date(r.date + 'T00:00:00');
    const daysUntil = Math.ceil((eventDay - today) / 86400000);

    if (daysUntil === 1 && hkHour === 9 && !r.caregiverNotified1d) {
      toNotify.push({ reminder: r, type: '1day' });
      console.log(`[1DAY] ${r.name} → ${r.caregiver}`);
    }

    if (daysUntil === 0 && !r.caregiverNotified3h) {
      const [eh, em] = eventTime.split(':').map(Number);
      const eventHkTime = eh * 60 + em;
      const nowHkTime = hkHour * 60 + hkNow.getUTCMinutes();
      const diffMin = eventHkTime - nowHkTime;
      if (diffMin >= 150 && diffMin <= 210) {
        toNotify.push({ reminder: r, type: '3hour' });
        console.log(`[3HOUR] ${r.name} (${eventTime}) → ${r.caregiver}`);
      }
    }

    // 過期提醒：重置 flag，等刪除或下次
    if (daysUntil < 0 && (r.caregiverNotified1d || r.caregiverNotified3h)) {
      r.caregiverNotified1d = false;
      r.caregiverNotified3h = false;
      dataChanged = true;
    }
  }

  async function flushFlags() {
    try {
      await githubApiPut('data.json', data, sha, 'Update caregiver notification flags');
      console.log('[DATA] Updated notification flags on GitHub');
    } catch (e) {
      console.error('[DATA] Failed to update flags:', e.message);
    }
  }

  if (toNotify.length === 0) {
    if (dataChanged) await flushFlags();
    console.log('[CRON] No caregiver notifications needed. Exiting.');
    process.exit(0);
  }

  console.log(`[CRON] ${toNotify.length} notifications to send`);
  let sent = 0;
  let totalTargets = 0;
  for (const item of toNotify) {
    const reminder = item.reminder;
    const targets = targetsFor(reminder);
    let itemSent = 0, itemTotal = 0;
    for (const care of targets) {
      if (!CAREGIVER_PHONES[care]) continue;
      itemTotal++; totalTargets++;
      const ok = await sendCallMeBot(care, buildCaregiverMsg(reminder, item.type));
      if (ok) { sent++; itemSent++; }
      await new Promise(r => setTimeout(r, 3500)); // CallMeBot: 1 msg / 3s per number
    }
    // 全部目標發送成功先標記 flag，避免「標咗但未送到」永久唔重試
    if (itemTotal > 0 && itemSent === itemTotal) {
      if (item.type === '1day') reminder.caregiverNotified1d = true;
      else reminder.caregiverNotified3h = true;
      dataChanged = true;
    } else {
      console.log(`[WARN] ${reminder.name} 部分/全部發送失敗，留待下次重試`);
    }
  }

  if (dataChanged) await flushFlags();
  console.log(`[CALLMEBOT] Done! Delivered ${sent}/${totalTargets}`);
  process.exit(0);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
