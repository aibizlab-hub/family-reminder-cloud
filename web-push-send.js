// Web Push sender — runs on GitHub Actions (self-perpetuating, every ~5 min)
//
// 重構版本 (2026-10-11)：
//  1. 真正讀取 settings 嘅 pre_day / pre_3h / on_time 三個時間窗，分別發送
//  2. 按 reminder.caregiver 範圍發送（Ken 只去 Ken 部機，其他人只去其他人，
//     ALL 先發畀所有人；caregiver 空白 = 唔廣播，絕不騷擾所有人）
//  3. 每 (提醒 + 時間窗 + 照顧者) 獨立去重，唔會重複彈
//  4. 400/403/404/410 當死訂閱，記入 push-state.json 跳過
//
// 只寫 push-state.json（Actions 專屬），唔寫 data.json → 唔會同前端 UI 編輯撞 409。

const REPO = process.env.GH_REPO || 'aibizlab-hub/family-reminder-cloud';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GH_PAT;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const SUBJECT = 'mailto:family-reminder@example.com';

let webpush = null;
try {
  webpush = require('web-push');
  if (VAPID_PRIVATE && VAPID_PUBLIC) webpush.setVapidDetails(SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} catch (e) {
  console.log('[warn] web-push unavailable (test mode?):', e.message);
}

const CAPTURE_MS = 6 * 60 * 1000; // 每個目標時間 ±6 分鐘捕獲窗（cron 每 5 分鐘，確保唔漏）
const WINDOWS = [
  { key: 'pre_day', offset: 24 * 3600 * 1000, label: '提前1日' },
  { key: 'pre_3h',  offset: 3 * 3600 * 1000,  label: '提前3小時' },
  { key: 'on_time', offset: 0,                 label: '準時' }
];

// ---------- GitHub helpers ----------
async function getFile(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  const json = await res.json();
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error('GET ' + path + ' failed: ' + (json.message || res.status));
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: json.sha };
}

async function putFile(path, data, sha, message) {
  const b64 = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = sha ? { message, content: b64, sha } : { message, content: b64 };
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) return await res.json();
  if (res.status === 409) { const f = await getFile(path); return putFile(path, data, f.sha, message); }
  const j = await res.json().catch(() => ({}));
  throw new Error('PUT ' + path + ' failed: ' + (j.message || res.status));
}

// ---------- 下次發生時間 ----------
function getNextOccurrence(r, now) {
  const parts = (r.time || '09:00').split(':');
  const hh = parseInt(parts[0], 10) || 0;
  const mm = parseInt(parts[1], 10) || 0;
  const at = (d) => { const x = new Date(d); x.setHours(hh, mm, 0, 0); return x; };
  if (!r.repeat || r.repeat === 'none') return at(new Date(r.date + 'T00:00:00'));
  if (r.repeat === 'daily') { let t = at(new Date()); if (t <= now) t.setDate(t.getDate() + 1); return t; }
  if (r.repeat === 'weekly') {
    const days = r.repeatDays || [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      if (days.indexOf(d.getDay()) >= 0) { const c = at(d); if (c > now) return c; }
    }
    return null;
  }
  if (r.repeat === 'monthly') {
    const dom = r.repeatDayOfMonth || new Date(r.date).getDate();
    for (let m = 0; m < 24; m++) {
      const d = new Date(); d.setMonth(d.getMonth() + m);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(dom, last));
      const c = at(d); if (c > now) return c;
    }
    return null;
  }
  return null;
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function occKey(r, date) {
  return r.id + '_' + date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
         '_' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

// ---------- 按照顧者範圍收件人 ----------
function recipientsFor(r, subs) {
  const cg = (r.caregiver || '').trim();
  if (cg === 'ALL') return subs.slice();      // 全家 → 所有裝置
  if (cg === '') return [];                    // 空白 = 唔廣播（用家明確要求：唔好騷擾所有人）
  return subs.filter(s => (s.caregiver || '').trim() === cg); // 只發畀相同照顧者嘅裝置
}

// ---------- 通知內容（按時間窗唔同） ----------
function buildPayload(r, win, next) {
  const t = (r.time && r.time !== '00:00') ? r.time : '';
  let title, body;
  if (win.key === 'pre_day') { title = '📅 明日提醒'; body = (t ? t + ' ' : '') + r.name + '（提前1日）'; }
  else if (win.key === 'pre_3h') { title = '⏰ 仲有3個鐘'; body = (t ? t + ' ' : '') + r.name + '（提前3小時）'; }
  else { title = '🔔 時間到'; body = (t ? '🕐 ' + t + ' ' : '') + r.name; }
  if (r.caregiver && r.caregiver !== 'ALL') body += '  👤' + r.caregiver;
  if (r.note) body += '  📝' + r.note;
  return JSON.stringify({ title, body, tag: r.id + '_' + win.key, url: '/' });
}

// 供單元測試使用
module.exports = { getNextOccurrence, recipientsFor, buildPayload, occKey, WINDOWS, CAPTURE_MS, main };

// ---------- 主流程 ----------
async function main() {
  if (!TOKEN) { console.error('FATAL: no GITHUB_TOKEN'); process.exit(1); }
  const { data } = await getFile('data.json');
  if (!data) { console.log('data.json missing'); return; }
  const subs = data.pushSubscriptions || [];
  if (!subs.length) { console.log('No push subscriptions — skip'); return; }

  const stateFile = await getFile('push-state.json');
  const state = stateFile.data || { dedup: {}, deadSubs: [] };
  state.dedup = state.dedup || {};
  state.deadSubs = state.deadSubs || [];

  const settings = data.settings || {};
  const now = new Date();
  let pushCount = 0, deadCount = 0;

  for (const r of (data.reminders || [])) {
    const next = getNextOccurrence(r, now);
    if (!next) continue;
    for (const win of WINDOWS) {
      if (!settings[win.key]) continue; // 呢個時間窗喺設定入面關咗
      const target = new Date(next.getTime() - win.offset);
      const diff = target.getTime() - now.getTime();
      if (diff < -CAPTURE_MS || diff > CAPTURE_MS) continue;

      const recips = recipientsFor(r, subs);
      if (!recips.length) {
        if (r.caregiver && r.caregiver !== 'ALL') {
          console.log('[scope] ' + r.name + ' → 照顧者 ' + r.caregiver + ' 暫時無裝置訂閱，跳過（等人訂閱先）');
        }
        continue;
      }

      for (const s of recips) {
        if (state.deadSubs.indexOf(s.endpoint) >= 0) continue;
        // 去重 key 必須含 subscription endpoint：ALL 會發畀多部機，每部要獨立去重，
        // 唔可以共用 r.caregiver（否則第 1 部發完，其餘全部被 skip）
        const dkey = r.id + '|' + win.key + '|' + occKey(r, next) + '|' + s.endpoint;
        // 兼容舊 dedup：舊 sender 用 r.id 做 key（只有 on_time）
        if (win.key === 'on_time' && state.dedup[r.id] === occKey(r, next)) continue;
        if (state.dedup[dkey]) continue;

        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, buildPayload(r, win, next));
          pushCount++;
          state.dedup[dkey] = 1;
          console.log('[send] ' + win.label + ' → ' + r.caregiver + ' : ' + r.name);
        } catch (e) {
          const code = e.statusCode;
          if (code === 400 || code === 403 || code === 404 || code === 410) {
            if (state.deadSubs.indexOf(s.endpoint) < 0) state.deadSubs.push(s.endpoint);
            deadCount++;
            console.log('[dead] ' + s.endpoint.slice(0, 40));
          } else {
            console.log('[fail] ' + s.endpoint.slice(0, 40) + ' ' + (code || e.message));
          }
        }
      }
    }
  }

  if (pushCount > 0 || deadCount > 0) {
    await putFile('push-state.json', state, stateFile.sha, 'web-push: dedup/deadSubs update');
    console.log('Pushed ' + pushCount + ' notification(s), marked ' + deadCount + ' dead sub(s)');
  } else {
    console.log('No due reminders to push');
  }
}

if (require.main === module) {
  main().catch(function (e) { console.error('FATAL', e); process.exit(1); });
}
