/**
 * cloud-reminder-bot.js
 * 家庭提醒 — 雲端統一排程器 (CallMeBot WhatsApp Gateway)
 *
 * ✅ 唔使開住部電腦 (GitHub Actions 原生 cron 24/7 自己跑)
 * ✅ 唔使 wacli / baileys / 掃 QR / 14 日過期
 * ✅ 覆蓋：① 提早 1 日  ② 提早 3 小時  ③ 準時  ④ 每日 07:00 HKT 日程 digest
 *
 * 由 .github/workflows/cloud-reminder.yml 定時觸發 (每 30 分鐘)。
 * 資料源 = jsonblob (單一真相源)，bot 經 putJsonblob 寫回通知 flag。
 *
 * Env:
 *   GITHUB_TOKEN / GH_PAT  降級讀取用 (DATA_URL 唔到時)
 *   CALLMEBOT_KEN / _EPPIE / _KENNY / _ROSANNA / _COFFE / _LODOU
 *   DATA_URL (選填)        預設 jsonblob (公開 blob，唔使 token 讀)
 *   DRY_RUN=1              只記錄唔發送 (測試用)
 *
 * 修復紀錄 (2026-07-24 code review):
 *   P0 時區：準時窗口改用 HKT 絕對 UTC (Date.UTC - 8h)，唔再用本地時區 (Actions=UTC，舊 parseDt 錯 8 小時)
 *   P1 去重：標記搬去 data.notifyLedger (id::type)，寫回 jsonblob 唔會被 app 全量 PUT 抹走 → 杜絕重複發送
 *   P2 熔斷：CallMeBot 回 402/429 立即跳過剩餘發送，避免浪費配額 / 惡性循環
 *   P2 保安：KEN/EPPIE 用緊 hardcode fallback → 提醒 set GitHub Secrets 後拆走
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
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
  'Rosanna Mok': { phone: '852933398522', name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322', name: 'COFFE' },
  '老豆':        { phone: '85262269100', name: '老豆' }
};

// ===== CallMeBot API keys (per caregiver) =====
// 優先讀 GitHub Secrets (env)；若 env 冇值，先用已驗證嘅 fallback default，令 KEN+EPPIE+ROSANNA 24/7 即時生效。
// 其餘 3 位未激活 → env 為空 → 自動 SKIP（唔會報錯）。
// ⚠️ 保安：呢 3 把 fallback 暫時 hardcode 喺 source（repo 若 public 即公開）。收齊 6 把並 set 咗 GitHub Secrets 後，拆走呢個 fallback。
const CALLMEBOT_KEYS = {
  'KEN':         process.env.CALLMEBOT_KEN     || '1426181',
  'EPPIE':       process.env.CALLMEBOT_EPPIE   || '5016776',
  'Kenny Yam':   process.env.CALLMEBOT_KENNY,
  'Rosanna Mok': process.env.CALLMEBOT_ROSANNA || '6381815',
  'COFFE':       process.env.CALLMEBOT_COFFE,
  '老豆':        process.env.CALLMEBOT_LODOU
};

const CAT_ICONS = { school: '🏫', class: '🎨', special: '🎂', summer: '☀️', routine: '📅', default: '📌' };
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

// ===== 熔斷器 (Circuit Breaker) =====
// CallMeBot 回 402 (配額用盡) / 429 (被封鎖) 時立即跳過剩餘發送，避免浪費配額 / 觸發更長封鎖
let apiBlocked = false;

// ===== GitHub API helpers (降級用) =====
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

// ===== 讀取 (本地 file:// 直讀；否則主路徑讀 DATA_URL = jsonblob) =====
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
  // ① 優先讀 CI checkout 落嚟嘅本地 data.json（永遠喺，唔受 jsonblob 過期/被刪影響）
  const localPath = path.join(process.cwd(), 'data.json');
  if (fs.existsSync(localPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      console.log('[DATA] 經本地 data.json 讀取成功 (CI checkout)');
      return { data, sha: null, source: 'local' };
    } catch (e) { console.error('[DATA] 本地 data.json 讀取失敗: ' + e.message); }
  }
  // ② 主路徑：DATA_URL (jsonblob / raw github)
  try {
    const r = await fetchUrl(DATA_URL);
    console.log('[DATA] 經 DATA_URL 讀取成功: ' + DATA_URL);
    return Object.assign({}, r, { source: 'url' });
  } catch (e) {
    console.error('[DATA] DATA_URL 讀取失敗: ' + e.message);
  }
  // ③ 降級：GitHub API（需 GITHUB_TOKEN）
  if (GH_TOKEN) {
    try {
      const r = await githubApiGet('data.json');
      console.log('[DATA] 降級 GitHub API 讀取成功');
      return Object.assign({}, r, { source: 'api' });
    } catch (e2) { console.error('[DATA] GitHub 降級讀取失敗: ' + e2.message); }
  }
  console.error('[DATA] 三個資料源都讀取失敗，放棄');
  process.exit(1);
}

// ===== helpers =====
function getWeekDay(dateStr) { return DAY_NAMES[new Date(dateStr + 'T00:00:00').getDay()]; }
function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
// ★ 時區修正 (P0)：用 HKT 絕對 UTC 時間，唔好再用本地時區 (GitHub Actions 係 UTC，舊 parseDt 用 local time 會錯 8 小時)
function eventMsHKT(r) {
  const [y, mo, d] = String(r.date).split('-').map(Number);
  const [h, mi] = String(r.time || '09:00').split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600000;
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

// ===== CallMeBot WhatsApp Gateway send (含熔斷器) =====
// GET https://api.callmebot.com/whatsapp.php?phone=PHONE&text=TEXT&apikey=APIKEY
async function sendCallMeBot(caregiver, text) {
  const key = CALLMEBOT_KEYS[caregiver];
  const phone = CAREGIVER_PHONES[caregiver] && CAREGIVER_PHONES[caregiver].phone;
  if (!key || !phone) {
    console.log(`[SKIP] ${caregiver}: 無 CallMeBot key/電話，跳過`);
    return false;
  }
  if (apiBlocked) {
    console.warn(`[BREAKER] CallMeBot 已熔斷，跳過 ${caregiver} 發送以節省配額`);
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
    // 熔斷：配額用盡 (402) 或被封鎖 (429) → 跳過剩餘發送，避免惡性循環 / 更長封鎖
    if (res.status === 402 || res.status === 429) {
      apiBlocked = true;
      console.error(`[BREAKER] CallMeBot 回 ${res.status} (${caregiver})，觸發熔斷：跳過剩餘發送。`);
      return false;
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
  if (!process.env.CALLMEBOT_KEN || !process.env.CALLMEBOT_EPPIE || !process.env.CALLMEBOT_ROSANNA) {
    console.warn('[SECURITY] ⚠️ KEN/EPPIE/ROSANNA 用緊 hardcode fallback key（repo 若 public 即公開）。請儘快 set GitHub Secrets CALLMEBOT_KEN/EPPIE/ROSANNA，收齊 6 把後拆走 source 入面嘅 fallback。');
  }

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

  // ★ 去重 ledger (P1)：標記放 data.notifyLedger (id::type)，寫回 jsonblob 唔會被 app 全量 PUT 抹走 → 杜絕重複發送
  const ledger = (data.notifyLedger = data.notifyLedger || {});
  const lk = (id, t) => id + '::' + t;

  let dataChanged = false;
  let sent = 0, totalTargets = 0;

  for (const r of reminders) {
    if (r.isDone || r.isArchived || r.archived) continue;
    if (!r.caregiver) continue;
    if (!r.id) { console.log('[WARN] 提醒缺 id，跳過:', r.name); continue; }
    const eventTime = r.time || '09:00';
    const today = new Date(hkDateStr + 'T00:00:00');
    const eventDay = new Date(r.date + 'T00:00:00');
    const daysUntil = Math.ceil((eventDay - today) / 86400000);
    const dtMs = eventMsHKT(r);
    const nowMs = now.getTime();

    // --- ① 提早 1 日 (anytime 08:00–22:00 HKT 嗰日；錯過 9 點都會發，ledger 防重複) ---
    if (daysUntil === 1 && hkHour >= 8 && hkHour <= 22 && !ledger[lk(r.id, '1d')]) {
      const targets = r.caregiver === 'ALL' ? Object.keys(CAREGIVER_PHONES) : [r.caregiver];
      for (const c of targets) {
        if (!CAREGIVER_PHONES[c]) continue;
        totalTargets++;
        if (await sendCallMeBot(c, buildMsg(r, '1day'))) { sent++; ledger[lk(r.id, '1d')] = true; dataChanged = true; }
        await new Promise(res => setTimeout(res, 3500));
      }
    }

    // --- ② 提早 3 小時 ---
    if (daysUntil === 0 && !ledger[lk(r.id, '3h')]) {
      const [eh, em] = eventTime.split(':').map(Number);
      const eventHkMin = eh * 60 + em;
      const nowHkMin = hkHour * 60 + hkMin;
      const diffMin = eventHkMin - nowHkMin;
      if (diffMin >= 150 && diffMin <= 210) {
        const targets = r.caregiver === 'ALL' ? Object.keys(CAREGIVER_PHONES) : [r.caregiver];
        for (const c of targets) {
          if (!CAREGIVER_PHONES[c]) continue;
          totalTargets++;
          if (await sendCallMeBot(c, buildMsg(r, '3hour'))) { sent++; ledger[lk(r.id, '3h')] = true; dataChanged = true; }
          await new Promise(res => setTimeout(res, 3500));
        }
      }
    }

    // --- ③ 準時 (window = [dt-25min, dt+20min]，30min cron 必中)；dtMs 用 HKT 絕對 UTC (P0 修正) ---
    if (!ledger[lk(r.id, 'ontime')] && nowMs >= dtMs - 25 * 60000 && nowMs <= dtMs + 20 * 60000) {
      const targets = r.caregiver === 'ALL' ? Object.keys(CAREGIVER_PHONES) : [r.caregiver];
      for (const c of targets) {
        if (!CAREGIVER_PHONES[c]) continue;
        totalTargets++;
        if (await sendCallMeBot(c, buildMsg(r, 'ontime'))) { sent++; ledger[lk(r.id, 'ontime')] = true; dataChanged = true; }
        await new Promise(res => setTimeout(res, 3500));
      }
    }

    // --- 過期重置 (等下次 / 避免永久唔重試) ---
    if (daysUntil < 0 && (ledger[lk(r.id, '1d')] || ledger[lk(r.id, '3h')] || ledger[lk(r.id, 'ontime')])) {
      delete ledger[lk(r.id, '1d')];
      delete ledger[lk(r.id, '3h')];
      delete ledger[lk(r.id, 'ontime')];
      dataChanged = true;
    }
  }

  // --- ④ 每日 07:00–12:00 HKT 日程 digest (錯過 7 點都會發，digestSentDate 防重複) ---
  if (hkHour >= 7 && hkHour < 12) {
    const digestDate = hkDateStr;
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
    let wrote = false;
    // ① 寫回 repo data.json（單一真相源）：保證 notifyLedger 跨 run 保留 → 去重有效
    if (GH_TOKEN) {
      try {
        const cur = await githubApiGet('data.json');   // 拎最新 sha，避免覆蓋他人改動
        cur.data.notifyLedger = data.notifyLedger || {};
        cur.data.digestSentDate = data.digestSentDate;
        await githubApiPut('data.json', cur.data, cur.sha, 'Reminder bot: persist notifyLedger');
        console.log('[DATA] 已寫回 notifyLedger 至 repo data.json');
        wrote = true;
      } catch (e) { console.error('[DATA] 寫回 repo 失敗: ' + e.message); }
    }
    // ② 鏡像寫回 jsonblob（best-effort，404/過期唔阻擋）
    try {
      await putJsonblob(data);
      console.log('[DATA] 已寫回 jsonblob（鏡像）');
      wrote = true;
    } catch (e) { console.error('[DATA] jsonblob 鏡像寫回失敗 (best-effort): ' + e.message); }
    if (!wrote) console.error('[ALERT] notifyLedger 兩個寫回都失敗，去重標記可能流失');
  }

  if (sent === 0 && !dataChanged) {
    console.log('[CRON] 暫無需要發送嘅提醒。');
    if (apiBlocked) console.error('[ALERT] CallMeBot 熔斷中，請檢查配額 / 封鎖狀態。');
    process.exit(0);
  }
  if (DRY_RUN) console.log('[DRY-RUN] 跳過寫回');
  else if (dataChanged) await flush();
  if (apiBlocked) console.error('[ALERT] CallMeBot 熔斷觸發！剩餘發送已跳過，請檢查配額 / 封鎖並處理。');
  console.log(`[CALLMEBOT] 完成！發送 ${sent}/${totalTargets}` + (DRY_RUN ? ' (DRY-RUN)' : ''));
  process.exit(0);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
