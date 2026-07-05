/**
 * GitHub Actions: 照顧者個人 WhatsApp 提醒
 * 認證方式：baileys + WA_CREDS_B64（tar.gz base64）
 *
 * 永久方案原理：
 * 1. WA_CREDS_B64 = base64( tar.gz of baileys auth_dir )
 * 2. 啟動時解壓還原 auth state
 * 3. 成功連接後自動將更新了的 auth state 打包寫回 /tmp/wa-auth-new.b64
 * 4. workflow 下一步將該檔內容更新至 GitHub Secret
 * 5. baileys 會自動續期憑證，實際可維持數週唔使理
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_REPO  = 'ken851004-afk/family-reminder-cloud';
const AUTH_DIR = '/tmp/baileys-auth';
const TAR_GZ   = '/tmp/wa-auth.tar.gz';
const NEW_B64  = '/tmp/wa-auth-new.b64';   // 更新後嘅 base64 輸出

// ── 照顧者電話對照表 ──────────────────────────────
const CAREGIVER_PHONES = {
  'KEN':         { phone: '85262218999', name: 'KEN' },
  'EPPIE':       { phone: '85297510047',  name: '🐑 EPPIE（太太）' },
  'Kenny Yam':   { phone: '85291339336',  name: 'Kenny Yam' },
  'Rosanna Mok': { phone: '85293398522',  name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322',  name: 'COFFE' },
  '老豆':        { phone: '85262269100',  name: '老豆' }
};

const CAT_ICONS = { school: '🏫', class: '🎨', special: '⭐', summer: '☀️', routine: '📅' };

// ── GitHub API helpers ─────────────────────────────────
function ghApi(method, endpoint, body) {
  return new Promise((ok, fail) => {
    const b = body ? JSON.stringify(body) : '';
    const opt = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'Authorization':       `Bearer ${GH_TOKEN}`,
        'Accept':             'application/vnd.github.v3+json',
        'User-Agent':         'wa-reminder',
        'Content-Type':       'application/json',
        'Content-Length':     Buffer.byteLength(b)
      }
    };
    const req = https.request(opt, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return fail(new Error(`GitHub API ${res.statusCode}: ${d}`));
        try { ok(d ? JSON.parse(d) : {}); } catch { ok(d); }
      });
    });
    req.on('error', fail);
    if (b) req.write(b);
    req.end();
  });
}

async function fetchReminders() {
  const res = await ghApi('GET', `/repos/${GH_REPO}/contents/data.json`);
  if (!res.content) throw new Error('讀取 data.json 失敗');
  const raw = Buffer.from(res.content, 'base64').toString('utf8');
  return JSON.parse(raw).reminders || [];
}

// ── 還原 auth state ───────────────────────────────────
function restoreAuth() {
  const b64 = process.env.WA_CREDS_B64;
  if (!b64) throw new Error('WA_CREDS_B64 未設定');

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const buf = Buffer.from(b64, 'base64');

  // 檢測格式：tar.gz 開頭 0x1f 0x8b
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    fs.writeFileSync(TAR_GZ, buf);
    execSync(`tar -xzf "${TAR_GZ}" -C "${AUTH_DIR}"`, { stdio: 'inherit' });
    console.log('✅  auth state 已還原（tar.gz）');
  } else {
    // 舊格式：直接係 creds.json base64
    const creds = JSON.parse(buf.toString('utf8'));
    const mf = path.join(AUTH_DIR, 'md-files');
    fs.mkdirSync(mf, { recursive: true });
    fs.writeFileSync(path.join(mf, 'creds.json'), JSON.stringify(creds, null, 2));
    console.log('✅  auth state 已還原（舊格式 creds.json）');
    console.warn('⚠️  建議重新生成 WA_CREDS_B64（舊格式唔包含 pre-key，連接可能失敗）');
  }
}

// ── 打包 auth state → base64 字串 ───────────────────
function packAuth() {
  // 打包前先刪走 temporary files，減少體積
  const tmpJson = path.join(AUTH_DIR, 'md-files', 'temp-creds.json');
  if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);

  execSync(`tar -czf "${TAR_GZ}" -C "${AUTH_DIR}" .`, { stdio: 'inherit' });
  return fs.readFileSync(TAR_GZ).toString('base64');
}

// ── 提醒邏輯 ────────────────────────────────────────
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

function computeNextOccurrence(r, now) {
  if (!r.repeat || r.repeat.type === 'none') {
    const [yy, mm, dd] = r.date.split('-').map(Number);
    return new Date(yy, mm - 1, dd);
  }
  const [yy, mm, dd] = r.date.split('-').map(Number);
  const base = new Date(yy, mm - 1, dd);
  if (base >= now) return base;

  switch (r.repeat.type) {
    case 'daily': {
      const d = new Date(now); d.setDate(d.getDate() + 1); return d;
    }
    case 'weekly': {
      const days = r.repeat.days || [];
      for (let i = 1; i <= 7; i++) {
        const d = new Date(now); d.setDate(d.getDate() + i);
        if (days.includes(d.getDay())) return d;
      }
      return null;
    }
    case 'monthly': {
      let m = now.getMonth(), y = now.getFullYear();
      for (let i = 0; i < 24; i++) {
        const d = new Date(y, m + i, dd);
        if (d > now) return d;
      }
      return null;
    }
    case 'yearly': {
      const next = new Date(now.getFullYear() + 1, mm - 1, dd);
      return next > now ? next : new Date(now.getFullYear() + 2, mm - 1, dd);
    }
    default: return base;
  }
}

function checkReminder(r, now) {
  if (!r.isActive) return { match: false };
  const target = computeNextOccurrence(r, now);
  if (!target) return { match: false };

  // 提早 1 日
  const d1 = new Date(target); d1.setDate(d1.getDate() - 1);
  if (sameDay(d1, now)) return { match: true, type: '1d' };

  // 提早 3 小時（即日）
  if (sameDay(target, now)) {
    const h = parseInt((r.remindTime || '09:00').split(':')[0]);
    if (now.getHours() >= h - 3 && now.getHours() <= h) {
      return { match: true, type: '3h' };
    }
  }
  return { match: false };
}

function buildMsg(r, type) {
  const icon  = CAT_ICONS[r.category] || '📌';
  const label = type === '1d' ? '📅 明日提醒' : '⏰ 即將到期（3小時內）';
  let msg = `${label}\n\n${icon} ${r.title}\n📅 ${r.date}`;
  if (r.note) msg += `\n📝 ${r.note}`;
  if (r.details && r.details.length) {
    msg += '\n\n列明事項：';
    r.details.forEach((d, i) => { msg += `\n  ${i + 1}. ${d}`; });
  }
  msg += '\n— 家庭提醒系統 —';
  return msg;
}

function getTargets(r) {
  if (r.caregivers && r.caregivers.length) {
    return r.caregivers
      .map(name => CAREGIVER_PHONES[name])
      .filter(Boolean)
      .map(c => c.phone);
  }
  return Object.values(CAREGIVER_PHONES).map(c => c.phone);
}

// ── 主程式 ───────────────────────────────────────────
async function main() {
  console.log('=== Caregiver Reminder ===');
  console.log('UTC:', new Date().toISOString());
  const hktNow = new Date(Date.now() + 8 * 3600 * 1000);
  console.log('HKT:', hktNow.toISOString());

  if (!GH_TOKEN) throw new Error('GITHUB_TOKEN 未設定');

  // 1. 還原 auth
  restoreAuth();

  // 2. 載入 baileys 並連接
  const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let sock;
  try {
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['FamilyReminder', 'Chrome', '1.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    // 等連接（40 秒 timeout，GitHub Actions 有時慢）
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('WhatsApp 連接逾時（40s）')), 40000);
      sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
          clearTimeout(t);
          console.log('✅ WhatsApp 已連接');
          ok();
        }
        if (u.connection === 'close') {
          clearTimeout(t);
          const reason = u.lastDisconnect?.error?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            fail(new Error('WhatsApp 已登出，需要重新掃 QR 碼生成 WA_CREDS_B64'));
          } else {
            fail(new Error('WhatsApp 連接失敗：' + (u.lastDisconnect?.error?.message || 'unknown')));
          }
        }
      });
    });

    // 3. 讀取提醒並檢查
    const reminders = await fetchReminders();
    console.log(`📋 載入 ${reminders.length} 個提醒`);

    const sendList = [];
    for (const r of reminders) {
      const chk = checkReminder(r, hktNow);
      if (chk.match) sendList.push({ r, type: chk.type });
    }
    console.log(`📤 需要發送 ${sendList.length} 條提醒`);

    // 4. 發送
    for (const { r, type } of sendList) {
      const msg     = buildMsg(r, type);
      const targets = getTargets(r);
      for (const phone of targets) {
        try {
          await sock.sendMessage(phone + '@s.whatsapp.net', { text: msg });
          console.log(`  ✓ ${phone} ← ${r.title}`);
        } catch (e) {
          console.error(`  ✗ ${phone}:`, e.message);
        }
      }
    }

    // 5. 保存更新後嘅 auth state，輸出 base64 畀 workflow 更新 secret
    await saveCreds();
    const newB64 = packAuth();
    fs.writeFileSync(NEW_B64, newB64);
    console.log(`✅  更新後嘅 auth state 已儲存至 ${NEW_B64}（${Math.round(newB64.length / 1024)} KB）`);

    console.log('=== 完成 ===');
    await sock.logout();
    process.exit(0);

  } catch (e) {
    console.error('❌ 嚴重錯誤：', e.message);

    if (/登出|logged out|re-auth|掃 QR/i.test(e.message)) {
      console.error('\n=== 需要重新設定憑證 ===');
      console.error('請在本機執行：node setup-wa-auth.js');
      console.error('然後將輸出的 base64 更新至 GitHub Secret: WA_CREDS_B64\n');
    }

    if (sock) try { await sock.logout(); } catch {}
    process.exit(1);
  }
}

main();
