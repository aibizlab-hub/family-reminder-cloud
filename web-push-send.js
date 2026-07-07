// Web Push sender — runs on GitHub Actions (every 5 min)
// Reads family-reminder-cloud/data.json, pushes due reminders to all subscribed devices.
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GH_PAT;
const REPO = process.env.GH_REPO || 'ken851004-afk/family-reminder-cloud';
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
  if (!res.ok) throw new Error('GET failed: ' + json.message);
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: json.sha };
}

async function putFile(path, data, sha, message, attempt) {
  attempt = attempt || 0;
  const b64 = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64, sha })
  });
  if (res.ok) return await res.json();
  if (res.status === 409 && attempt < 3) {
    // SHA conflict — re-read and retry (re-apply markings)
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
  const { data, sha } = await getFile('data.json');
  const subs = data.pushSubscriptions || [];
  if (!subs.length) { console.log('No push subscriptions — skip'); return; }
  const now = new Date();
  let changed = false;
  let pushCount = 0;
  let expired = [];

  for (const r of (data.reminders || [])) {
    const next = getNextOccurrence(r, now);
    if (!next) continue;
    const diff = next.getTime() - now.getTime();
    // due within next 5 min, or up to 1 min past
    if (diff >= -60000 && diff <= 300000) {
      const key = occKey(r, next);
      if (r._lastPushKey === key) continue; // already pushed this occurrence
      const payload = JSON.stringify({
        title: '⏰ ' + r.name,
        body: (r.time && r.time !== '00:00' ? '🕐 ' + r.time + '  ' : '') +
              (r.caregiver ? '👤 ' + r.caregiver + '  ' : '') +
              (r.note || '提醒時間到了'),
        tag: r.id,
        url: '/'
      });
      for (const s of subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
          pushCount++;
        } catch (e) {
          const code = e.statusCode;
          console.log('push fail', s.endpoint.slice(0, 45), code || e.message);
          if (code === 404 || code === 410) expired.push(s.endpoint);
        }
      }
      r._lastPushKey = key;
      changed = true;
    }
  }

  if (expired.length) {
    data.pushSubscriptions = (data.pushSubscriptions || []).filter(function(s) {
      return expired.indexOf(s.endpoint) < 0;
    });
    changed = true;
  }

  if (changed) {
    await putFile('data.json', data, sha, 'web-push: send due reminders');
    console.log('Pushed ' + pushCount + ' notification(s), removed ' + expired.length + ' expired sub(s)');
  } else {
    console.log('No due reminders to push');
  }
}

main().catch(function(e) { console.error('FATAL', e); process.exit(1); });
