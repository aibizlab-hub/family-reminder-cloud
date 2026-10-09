// Web Push sender — runs on GitHub Actions (every 5 min)
// 讀 family-reminder-cloud/data.json（只讀），push 到期提醒畀所有 subscribed device
// 去重狀態寫入 push-state.json（Actions 專屬檔，唔會同前端 UI 編輯撞 409）
// v3-B 加固：data.json 完全唔寫，消除同前端嘅 SHA 衝突
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GH_PAT;
const REPO = process.env.GH_REPO || 'aibizlab-hub/family-reminder-cloud';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const SUBJECT = 'mailto:family-reminder@example.com';

const webpush = require('web-push');
webpush.setVapidDetails(SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

async function getFile(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  const json = await res.json();
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error('GET failed: ' + json.message);
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: json.sha };
}

async function putFile(path, data, sha, message, attempt) {
  attempt = attempt || 0;
  const b64 = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = sha
    ? { message, content: b64, sha }
    : { message, content: b64 };
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) return await res.json();
  if (res.status === 409 && attempt < 3) {
    console.log('PUT 409, retrying (' + (attempt + 1) + ')...');
    const fresh = await getFile(path);
    return putFile(path, data, fresh.sha, message, attempt + 1);
  }
  const json = await res.json();
  throw new Error('PUT failed: ' + json.message);
}

function getNextOccurrence(r, now) {
  const parts = (r.time || '09:00').split(':');
  const hh = parseInt(parts[0], 10) || 0;
  const mm = parseInt(parts[1], 10) || 0;
  function at(d) { const x = new Date(d); x.setHours(hh, mm, 0, 0); return x; }
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
  return r.id + '_' + date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '_' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

async function main() {
  const { data } = await getFile('data.json');
  if (!data) { console.log('data.json missing'); return; }
  const subs = data.pushSubscriptions || [];
  if (!subs.length) { console.log('No push subscriptions — skip'); return; }

  // 讀去重狀態（Actions 專屬檔）
  const stateFile = await getFile('push-state.json');
  const state = stateFile.data || { dedup: {}, deadSubs: [] };
  state.dedup = state.dedup || {};
  state.deadSubs = state.deadSubs || [];

  const now = new Date();
  let pushCount = 0;
  let deadCount = 0;

  for (const r of (data.reminders || [])) {
    const next = getNextOccurrence(r, now);
    if (!next) continue;
    const diff = next.getTime() - now.getTime();
    // due within next 5 min, or up to 1 min past
    if (diff >= -60000 && diff <= 300000) {
      const key = occKey(r, next);
      if (state.dedup[r.id] === key) continue; // 已 push 過呢次
      const payload = JSON.stringify({
        title: '⏰ ' + r.name,
        body: (r.time && r.time !== '00:00' ? '🕐 ' + r.time + '  ' : '') +
              (r.caregiver ? '👤 ' + r.caregiver + '  ' : '') +
              (r.note || '提醒時間到了'),
        tag: r.id,
        url: '/'
      });
      for (const s of subs) {
        if (state.deadSubs.indexOf(s.endpoint) >= 0) continue; // 跳過死端點
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
          pushCount++;
        } catch (e) {
          const code = e.statusCode;
          if (code === 400 || code === 403 || code === 404 || code === 410) {
            if (state.deadSubs.indexOf(s.endpoint) < 0) state.deadSubs.push(s.endpoint);
            deadCount++;
            console.log('dead sub marked', s.endpoint.slice(0, 45));
          } else {
            console.log('push fail', s.endpoint.slice(0, 45), code || e.message);
          }
        }
      }
      state.dedup[r.id] = key;
    }
  }

  // 只寫 push-state.json（唔寫 data.json → 唔會同前端 UI 撞 409）
  if (pushCount > 0 || deadCount > 0) {
    await putFile('push-state.json', state, stateFile.sha, 'web-push: update dedup/deadSubs');
    console.log('Pushed ' + pushCount + ' notification(s), marked ' + deadCount + ' dead sub(s)');
  } else {
    console.log('No due reminders to push');
  }
}

main().catch(function(e) { console.error('FATAL', e); process.exit(1); });
