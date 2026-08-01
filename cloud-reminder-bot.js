/**
 * cloud-reminder-bot.js
 * 家庭提醒 — 雲端統一排程器 (CallMeBot WhatsApp Gateway)
 *
 * ✅ 唔使開住部電腦 (GitHub Actions 原生 cron 24/7 自己跑)
 * ✅ 唔使 wacli / baileys / 掃 QR / 14 日過期
 * ✅ 覆蓋：① 提早 1 日  ② 提早 3 小時  ③ 準時  ④ 每日 07:00 HKT 日程 digest
 *
 * 由 .github/workflows/cloud-reminder.yml 定時觸發 (每 30 分鐘)。
 *
 * Env:
 *   GITHUB_TOKEN / GH_PAT  讀寫 data.json (GitHub API)
 *   CALLMEBOT_KEN / _EPPIE / _KENNY / _ROSANNA / _COFFE / _LODOU
 *   DATA_URL (選填)        data.json 來源，預設 raw.githubusercontent (公開倉，唔使 token 讀)
 *   DRY_RUN=1              只記錄唔發送 (測試用)
 */

const https = require('https');
const fs = require('fs');
const REPO = process.env.GITHUB_REPO || 'aibizlab-hub/family-reminder-cloud';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const DATA_URL = process.env.DATA_URL ||
  `https://jsonblob.com/api/jsonBlob/019fbcb0-45fe-7396-8713-75286c4be862`;

// ===== 照顧者電話對照表 (E.164 without '+') =====
const CAREGIVER_PHONES = {
  'KEN':         { phone: '85262218999', name: 'KEN' },
  'EPPIE':       { phone: '85297510047', name: 'EPPIE（太太）' },
  'Kenny Yam':   { phone: '85291339336', name: 'Kenny Yam' },
  'Rosanna Mok': { phone: '85293398522', name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322', name: 'COFFE' },
  '老豆':        { phone: '85262269100', name: '老豆' }
};

// ===== CallMeBot API keys (per caregiver) =====
// 優先讀 GitHub Secrets (env)；若 env 冇值，先用已驗證嘅 fallback default，令 KEN+EPPIE 24/7 即時生效。
// 其餘 4 位未激活 → env 為空 → 自動 SKIP（唔會報錯）。
// ⚠️ 保安：呢兩把 fallback 暫時 hardcode 喺 source（repo 若 public 即公開）。收齊 6 把並 set 咗 GitHub Secrets 後，拆走呢個 fallback。
const CALLMEBOT_KEYS = {
  'KEN':         process.env.CALLMEBOT_KEN     || '1426181',
  'EPPIE':       process.env.CALLMEBOT_EPPIE   || '5016776',
  'Kenny Yam':   process.env.CALLMEBOT_KENNY,
  'Rosanna Mok': process.env.CALLMEBOT_ROSANNA,
  'COFFE':       process.env.CALLMEBOT_COFFE,
  '老豆':        process.env.CALLMEBOT_LODOU
};

const CAT_ICONS = { school: '🏫', class: '🎨', special: '🎂', summer: '☀️', routine: '📅', default: '📌' };
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

// ===== GitHub API helpers =====
function githubApiGet(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: '/repos/' + REPO + '/contents/' + apiPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'cloud-reminder-bot'
      }
    };
    const req = https.request(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.content) {
            resolve({
              data: JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf-8')),
              sha: j.sha
            });
          } else reject(new Error('GitHub API: ' + (j.message || 'unknown')));
        } catch (e) { reject(e); }
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
      path: '/repos/' + REPO + '/contents/' + apiPath,
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'cloud-reminder-bot',
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

// ===== 讀取 data.json (有 token 用 API 拿 sha；本地 file:// 直讀；冇就 raw URL 只讀) =====
function isLocalPath(u) {
  return u.startsWith('file://') || u.startsWith('/') || /^[A-Za-z]:[\\/]/.test(u);
}
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname, timeout: 10000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'cloud-reminder-bot' }
    }, res => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ data: JSON.parse(d), sha: null }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function loadData() {
  if (isLocalPath(DATA_URL)) {
    try {
      const p = DATA_URL.replace(/^file:\/\//, '');
      return { data: JSON.parse(fs.readFileSync(p, 'utf-8')), sha: null };
    } catch (e) { console.error('[DATA] 本地檔讀取失敗: ' + e.message); process.exit(1); }
  }
  // 主路徑：直接讀 DATA_URL (jsonblob / raw github)，加 Accept header
  try {
    const r = await fetchUrl(DATA_URL);
    console.log('[DATA] 經 DATA_URL 讀取成功: ' + DATA_URL);
    return r;
  } catch (e) {
    console.error('[DATA] DATA_URL 讀取失敗: ' + e.message);
    if (GH_TOKEN) {
      try { const r = await githubApiGet('data.json'); console.log('[DATA] 降級 GitHub API'); return r; }
      catch (e2) { console.error('[DATA] GitHub 降級都失敗: ' + e2.message); }
    }
    process.exit(1);
  }
}

// ===== helpers =====
function getWeekDay(dateStr) { return DAY_NAMES[new Date(dateStr + 'T00:00:00').getDay()]; }
function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
function parseDt(r) {
  const [y, mo, d] = String(r.date).split('-').map(Number);
  const [h, mi] = String(r.time || '09:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function buildMsg(r, type) {
  const icon = CAT_ICONS[r.category] || CAT_ICONS.default;
  let prefix;
  if (type === '1day') prefix = '⏰ 提早一天提醒';
  else if (type === '3hour') prefix = '🚨 三小時後提醒';
  else prefix = '🔔 準時提醒';
  let msg = `${prefix}\n\n`;
  msg += `${icon} *${r.name}*\n`;
  msg += `📅 ${formatDate(r.date)}（星期${getWeekDay(r.date)}）${r.time && r.time !== '00:00' ? ' ' + r.time : ''}\n`;
  if (r.address) msg += `📍 ${r.address}\n`;
  if (r.note) msg += `📝 ${r.note}\n`;
  if (r.caregiver === 'ALL') msg += `\n👥 照顧者：全部人\n`;
  else msg += `\n👤 照顧者：${r.caregiver}\n`;
  msg += `🌐 查看全部：https://aibizlab-hub.github.io/family-reminder-cloud/`;
  return msg;
}

function buildDigest(memberName, items) {
  let msg = `🌞 今日家庭日程 (${memberName})\n`;
  msg += `📅 ${items.dateLabel}\n\n`;
  items.list.forEach((r, i) => {
    const icon = CAT_ICONS[r.category] || CAT_ICONS.default;
    msg += `${i + 1}. ${icon} ${r.time || '全日'} ${r.name}\n`;
    if (r.note) msg += `    📝 ${r.note}\n`;
    if (r.address) msg += `    📍 ${r.address}\n`;
  });
  msg += `\n🌐 詳情：https://aibizlab-hub.github.io/family-reminder-cloud/`;
  return msg;
}

// ===== CallMeBot WhatsApp Gateway send =====
// GET https://api.callmebot.com/whatsapp.php?phone=PHONE&text=TEXT&apikey=APIKEY
async function sendCallMeBot(caregiver, text) {
  const key = CALLMEBOT_KEYS[caregiver];
  const phone = CAREGIVER_PHONES[caregiver] && CAREGIVER_PHONES[caregiver].phone;
  if (!key || !phone) {
    console.log(`[SKIP] ${caregiver}: 無 CallMeBot key/電話，跳過`);
    return false;
  }
  if (DRY_RUN) {
    console.log(`[DRY-RUN] 會經 CallMeBot 發去 ${caregiver} (${phone}):\n${text}\n`);
    return true;
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    clearTimeout(timer);
    if (res.status === 200) {
      console.log(`[CALLMEBOT] ✓ ${caregiver} (${phone}): 已排隊發送`);
      return true;
    }
    console.error(`[CALLMEBOT] ✗ ${caregiver} (${phone}): HTTP ${res.status} ${body.slice(0, 120)}`);
    return false;
  } catch (e) {
    console.error(`[CALLMEBOT] ✗ ${caregiver} (${phone}): ${e.message}`);
    return false;
  }
}

// ===== Main =====
async function main() {
  console.log('=== Cloud Reminder Bot (CallMeBot) ===' + (DRY_RUN ? ' [DRY-RUN]' : ''));
  const configuredKeys = Object.entries(CALLMEBOT_KEYS).filter(([, v]) => v).map(([k]) => k);
  console.log(`[KEYS] 已配置 CallMeBot key: ${configuredKeys.length ? configuredKeys.join(', ') : '（全無 → 請 set GitHub Secrets）'}`);

  const now = new Date();
  const hkNow = new Date(now.getTime() + 8 * 3600000);
  const hkHour = hkNow.getUTCHours();
  const hkMin = hkNow.getUTCMinutes();
  const hkDateStr = `${hkNow.getUTCFullYear()}-${String(hkNow.getUTCMonth() + 1).padStart(2, '0')}-${String(hkNow.getUTCDate()).padStart(2, '0')}`;
  console.log(`[TIME] HKT: ${hkDateStr} ${String(hkHour).padStart(2, '0')}:${String(hkMin).padStart(2, '0')}`);

  let gh;
  try { gh = await loadData(); }
  catch (e) { console.error('[DATA] 讀取失敗:', e.message); process.exit(1); }
  const data = gh.data;
  const sha = gh.sha;
  const reminders = data.reminders || [];
  console.log(`[DATA] 載入 ${reminders.length} 個提醒`);

  let dataChanged = false;
  let sent = 0, totalTargets = 0;

  for (const r of reminders) {
    if (r.isDone || r.isArchived || r.archived) continue;
    if (!r.caregiver) continue;
    const eventTime = r.time || '09:00';
    const today = new Date(hkDateStr + 'T00:00:00');
    const eventDay = new Date(r.date + 'T00:00:00');
    const daysUntil = Math.ceil((eventDay - today) / 86400000);
    const dtMs = parseDt(r).getTime();
    const nowMs = now.getTime();

    // --- ① 提早 1 日 (09:00 HKT) ---
    if (daysUntil === 1 && hkHour === 9 && !r.caregiverNotified1d) {
      const targets = r.caregiver === 'ALL' ? Object.keys(CAREGIVER_PHONES) : [r.caregiver];
      for (const c of targets) {
        if (!CAREGIVER_PHONES[c]) continue;
        totalTargets++;
        if (await sendCallMeBot(c, buildMsg(r, '1day'))) { sent++; r.caregiverNotified1d = true; dataChanged = true; }
        await new Promise(res => setTimeout(res, 3500));
      }
    }

    // --- ② 提早 3 小時 ---
    if (daysUntil === 0 && !r.caregiverNotified3h) {
      const [eh, em] = eventTime.split(':').map(Number);
      const eventHkMin = eh * 60 + em;
      const nowHkMin = hkHour * 60 + hkMin;
      const diffMin = eventHkMin - nowHkMin;
      if (diffMin >= 150 && diffMin <= 210) {
        const targets = r.caregiver === 'ALL' ? Object.keys(CAREGIVER_PHONES) : [r.caregiver];
        for (const c of targets) {
          if (!CAREGIVER_PHONES[c]) continue;
          totalTargets++;
          if (await sendCallMeBot(c, buildMsg(r, '3hour'))) { sent++; r.caregiverNotified3h = true; dataChanged = true; }
          await new Promise(res => setTimeout(res, 3500));
        }
      }
    }

    // --- ③ 準時 (window = [dt-25min, dt+20min]，30min cron 必中) ---
    if (!r.notified && nowMs >= dtMs - 25 * 60000 && nowMs <= dtMs + 20 * 60000) {
      const targets = r.caregiver === 'ALL' ? Object.keys(CAREGIVER_PHONES) : [r.caregiver];
      for (const c of targets) {
        if (!CAREGIVER_PHONES[c]) continue;
        totalTargets++;
        if (await sendCallMeBot(c, buildMsg(r, 'ontime'))) { sent++; r.notified = true; dataChanged = true; }
        await new Promise(res => setTimeout(res, 3500));
      }
    }

    // --- 過期重置 (等下次 / 避免永久唔重試) ---
    if (daysUntil < 0 && (r.caregiverNotified1d || r.caregiverNotified3h || r.notified)) {
      r.caregiverNotified1d = false;
      r.caregiverNotified3h = false;
      r.notified = false;
      dataChanged = true;
    }
  }

  // --- ④ 每日 07:00 HKT 日程 digest (每位照顧者各一則) ---
  if (hkHour === 7 && hkMin < 30) {
    const digestDate = r_digestDate(hkDateStr);
    if (data.digestSentDate !== digestDate) {
      const todays = reminders.filter(r =>
        !r.isDone && !r.isArchived && !r.archived && r.date === hkDateStr);
      todays.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      const items = { dateLabel: formatDate(hkDateStr) + '（星期' + getWeekDay(hkDateStr) + '）', list: todays };
      if (todays.length > 0) {
        for (const c of Object.keys(CAREGIVER_PHONES)) {
          totalTargets++;
          if (await sendCallMeBot(c, buildDigest(CAREGIVER_PHONES[c].name, items))) sent++;
          await new Promise(res => setTimeout(res, 3500));
        }
      }
      data.digestSentDate = digestDate;
      dataChanged = true;
    }
  }

  function putJsonblob(payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const u = new URL(DATA_URL);
      const req = https.request({
        hostname: u.hostname, path: u.pathname, method: 'PUT', timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(b); else reject(new Error('jsonblob PUT ' + res.statusCode + ': ' + b.slice(0, 120))); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function flush() {
    try {
      await putJsonblob(data);
      console.log('[DATA] 已寫回通知 flag 至 jsonblob');
    } catch (e) {
      console.error('[DATA] 寫回失敗:', e.message);
    }
  }

  if (sent === 0 && !dataChanged) {
    console.log('[CRON] 暫無需要發送嘅提醒。');
    process.exit(0);
  }
  if (dataChanged) await flush();
  console.log(`[CALLMEBOT] 完成！發送 ${sent}/${totalTargets}` + (DRY_RUN ? ' (DRY-RUN)' : ''));
  process.exit(0);
}

function r_digestDate(hkDateStr) { return hkDateStr; }

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
