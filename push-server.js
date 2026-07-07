// Push Notification Server for family-reminder-cloud
// Reads reminders from GitHub, sends web push to subscribed devices

const fs = require('fs');
const path = require('path');
const https = require('https');
const webpush = require('web-push');

// === CONFIG ===
const VAPID_PUBLIC_KEY  = 'BGcuGDYkHE7GhGUBqIvlit3f1PGMbYjrSuBYuzqXyiDw1P3zVeMDd04IORY3oBtuHli9-TCVGguX7m_xinxzHBw';
const VAPID_PRIVATE_KEY = 'CqiGqqmyAq5FfQ8zE1EWAqWfwz4JLBCreDjAYt8W6l8';
const VAPID_EMAIL = 'ken851004@github.com';

const DATA_URL = 'https://raw.githubusercontent.com/ken851004-afk/family-reminder-cloud/master/data.json';
const STATE_FILE = path.join(__dirname, 'push-state.json');
const SUBS_FILE = path.join(__dirname, 'push-subs.json');
const LOG_FILE = path.join(__dirname, 'push-log.txt');

const CHECK_INTERVAL_MS = 60 * 1000; // check every 1 min
const SEND_WINDOW_MIN = 5; // send if reminder within 5 min

// === SETUP ===
webpush.setVapidDetails(`mailto:${VAPID_EMAIL}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// === HELPERS ===
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// === DATA FETCH ===
function fetchData() {
  return new Promise((resolve, reject) => {
    const url = new URL(DATA_URL);
    https.get({
      hostname: url.hostname, path: url.pathname, timeout: 15000,
      headers: { 'User-Agent': 'family-reminder-push/3.0' }
    }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// === REMINDER CHECK ===
function checkReminders(data, state) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentMin = now.getHours() * 60 + now.getMinutes();

  const reminders = data.reminders || [];
  const due = [];

  for (const rem of reminders) {
    if (!rem.enabled && rem.enabled !== undefined) continue;
    if (!rem.time || rem.time === '00:00') continue;

    const dayKey = `push_${rem.id}_${today}`;
    if (state.sent[dayKey]) continue;

    const [h, m] = rem.time.split(':').map(Number);
    const remMin = h * 60 + m;
    const diff = remMin - currentMin;

    // Due within window
    if (diff >= 0 && diff <= SEND_WINDOW_MIN) {
      // Check date matches
      const remDate = rem.date;
      if (remDate === today) {
        due.push({ ...rem, dayKey });
      }
      // Also check recurring
      if (rem.repeat && rem.repeat !== 'none') {
        due.push({ ...rem, dayKey });
      }
    }
  }

  return due;
}

// === PUSH SEND ===
async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      return 'expired'; // subscription no longer valid
    }
    log(`Push send error: ${err.message}`);
    return false;
  }
}

// === MAIN LOOP ===
async function run() {
  log('Push server started');

  let state = loadJSON(STATE_FILE, { sent: {} });

  while (true) {
    try {
      // Load subscriptions
      const subs = loadJSON(SUBS_FILE, []);
      if (subs.length === 0) {
        // No subscribers yet, just wait
        await sleep(CHECK_INTERVAL_MS);
        continue;
      }

      // Fetch reminder data
      log('Fetching data...');
      const data = await fetchData();
      log(`Got ${(data.reminders || []).length} reminders, ${subs.length} subscribers`);

      // Check due reminders
      const due = checkReminders(data, state);
      if (due.length > 0) {
        log(`Found ${due.length} due reminders`);
        for (const rem of due) {
          const caregiver = rem.caregiver || '';
          const title = caregiver ? `${caregiver} - ${rem.name}` : rem.name;
          const body = `${rem.time} | ${rem.category || ''}`;

          // Send to all subscribers
          let expiredSubs = 0;
          for (const sub of subs) {
            const result = await sendPush(sub, { title, body, tag: rem.id, url: '/family-reminder-cloud/' });
            if (result === 'expired') expiredSubs++;
          }

          // Mark as sent
          state.sent[rem.dayKey] = Date.now();
          log(`Sent: "${title}" to ${subs.length} devices${expiredSubs > 0 ? ` (${expiredSubs} expired)` : ''}`);
          saveJSON(STATE_FILE, state);
        }
      }

      // Clean up old sent entries (keep last 7 days)
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      let cleaned = 0;
      for (const k of Object.keys(state.sent)) {
        if (state.sent[k] < cutoff) { delete state.sent[k]; cleaned++; }
      }
      if (cleaned > 0) saveJSON(STATE_FILE, state);

    } catch (err) {
      log(`Error: ${err.message}`);
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === HTTP SERVER ===
// For receiving push subscriptions from the frontend
const http = require('http');
const PORT = 3748;

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // GET /vapid-public-key
  if (req.method === 'GET' && req.url === '/vapid-public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: VAPID_PUBLIC_KEY }));
    return;
  }

  // POST /subscribe
  if (req.method === 'POST' && req.url === '/subscribe') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const sub = JSON.parse(body);
        const subs = loadJSON(SUBS_FILE, []);

        // Deduplicate by endpoint
        const exists = subs.find(s => s.endpoint === sub.endpoint);
        if (!exists) {
          subs.push(sub);
          saveJSON(SUBS_FILE, subs);
          log(`New subscriber: ${sub.endpoint.substring(0, 60)}... (total: ${subs.length})`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: subs.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // GET /status
  if (req.method === 'GET' && req.url === '/status') {
    const subs = loadJSON(SUBS_FILE, []);
    const state = loadJSON(STATE_FILE, { sent: {} });
    const sentCount = Object.keys(state.sent).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ subscribers: subs.length, sentToday: sentCount, running: true }));
    return;
  }

  // POST /unsubscribe
  if (req.method === 'POST' && req.url === '/unsubscribe') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { endpoint } = JSON.parse(body);
        let subs = loadJSON(SUBS_FILE, []);
        subs = subs.filter(s => s.endpoint !== endpoint);
        saveJSON(SUBS_FILE, subs);
        log(`Unsubscribed: ${endpoint?.substring(0, 60)}... (total: ${subs.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: subs.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  log(`HTTP server listening on port ${PORT}`);
});

// Start the main loop
run().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
