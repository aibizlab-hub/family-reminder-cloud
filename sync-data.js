/**
 * sync-data.js
 * 雲端資料對賬器：將 repo 嘅 data.json 同 jsonblob (bot 嘅雲端源) 雙向合併，
 * 令兩邊保持一致，且絕對唔會因為某一邊空咗 / 壞咗而抹走另一邊嘅資料。
 *
 * 修復紀錄 (2026-07-24 code review):
 *   - 用 GITHUB_TOKEN (Actions 內建) || GH_PAT，唔使硬 set 個人 PAT
 *   - 雙向合併 (union by id)：repo 編輯優先，jsonblob 多咗嘅項會補返入 repo
 *   - 防 wipe：blob 空 / 無 reminders 陣列 / 解析失敗 → 當空處理，唔會 overwrite 另一邊
 *   - 變化檢測：無變就唔 commit / 唔 PUT，避免無謂嘅 commit 噪音
 *   - 保留 notifyLedger (bot 去重標記)：兩邊 merge，唔會流失
 *
 * Env:
 *   JSONBLOB_ID    jsonblob blob ID (預設 = bot 用緊嗰個；可經 secret 覆蓋)
 *   GITHUB_TOKEN / GH_PAT   讀寫 data.json
 *   REPO           預設 aibizlab-hub/family-reminder-cloud
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = process.env.REPO || 'aibizlab-hub/family-reminder-cloud';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT;
const JSONBLOB_ID = process.env.JSONBLOB_ID || '019fbcb0-45fe-7396-8713-75286c4be862';

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'family-reminder-sync' }, headers),
      timeout: 15000
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, data: null, raw: d }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.end();
  });
}

function httpsPutJson(url, body, headers = {}) {
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'PUT',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'family-reminder-sync'
      }, headers),
      timeout: 15000
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.write(postData);
    req.end();
  });
}

function githubApiGet(apiPath) {
  return httpsGetJson(`https://api.github.com/repos/${REPO}/contents/${apiPath}`, {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github.v3+json'
  }).then(j => {
    if (j.data && j.data.content) {
      const data = JSON.parse(Buffer.from(j.data.content.replace(/\n/g, ''), 'base64').toString('utf-8'));
      return { data, sha: j.data.sha };
    }
    throw new Error('GitHub API: ' + (j.data && j.data.message || 'no content'));
  });
}

function githubApiPut(apiPath, content, sha, message) {
  const b64 = Buffer.from(JSON.stringify(content, null, 2), 'utf-8').toString('base64');
  return httpsPutJson(`https://api.github.com/repos/${REPO}/contents/${apiPath}`, {
    message, content: b64, sha, branch: 'master'
  }, {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github.v3+json'
  });
}

// 返一個「結構正常」嘅 data 對象；唔正常 (空 / 無 reminders / 解析失敗) → null (防 wipe)
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.reminders)) return null;
  return obj;
}

function unionById(repoArr, blobArr) {
  const map = new Map();
  (repoArr || []).forEach(r => { if (r && r.id) map.set(r.id, r); });
  (blobArr || []).forEach(r => { if (r && r.id && !map.has(r.id)) map.set(r.id, r); });
  return Array.from(map.values());
}

function unionByName(repoArr, blobArr) {
  const map = new Map();
  (repoArr || []).forEach(b => { if (b && b.name) map.set(b.name, b); });
  (blobArr || []).forEach(b => { if (b && b.name && !map.has(b.name)) map.set(b.name, b); });
  return Array.from(map.values());
}

function merge(repo, blob) {
  const merged = Object.assign({}, repo);
  merged.reminders = unionById(repo.reminders, blob.reminders);
  merged.birthdays = unionByName(repo.birthdays, blob.birthdays);
  merged.history = repo.history || blob.history || [];
  merged.settings = repo.settings || blob.settings || {};
  merged._deletedIds = Array.from(new Set([...(repo._deletedIds || []), ...(blob._deletedIds || [])]));
  merged.pendingMessages = repo.pendingMessages || blob.pendingMessages || [];
  // 去重標記：兩邊都保留 (唔會流失 bot 寫落嘅 notifyLedger)
  merged.notifyLedger = Object.assign({}, blob.notifyLedger || {}, repo.notifyLedger || {});
  merged.digestSentDate = repo.digestSentDate || blob.digestSentDate;
  return merged;
}

function stableStringify(o) { return JSON.stringify(o, null, 2); }

async function main() {
  console.log('=== Sync Data (bidirectional merge) ===');
  if (!JSONBLOB_ID) { console.error('[FATAL] 未 set JSONBLOB_ID，跳過 sync'); process.exit(0); }

  // 1. 讀 repo data.json (本地 checkout 優先；冇就經 API)
  let repo = null, repoSha = null;
  const localPath = path.join(process.cwd(), 'data.json');
  if (fs.existsSync(localPath) && !GH_TOKEN) {
    try { repo = sanitize(JSON.parse(fs.readFileSync(localPath, 'utf-8'))); repoSha = null; }
    catch (e) { console.error('[REPO] 本地讀取失敗:', e.message); }
  }
  if (!repo && GH_TOKEN) {
    try { const g = await githubApiGet('data.json'); repo = sanitize(g.data); repoSha = g.sha; }
    catch (e) { console.error('[REPO] API 讀取失敗:', e.message); }
  }
  if (!repo) { console.error('[REPO] 讀唔到 data.json，放棄'); process.exit(1); }
  console.log(`[REPO] reminders: ${(repo.reminders || []).length}`);

  // 2. 讀 jsonblob (防 wipe：失敗 / 空 → 當 null)
  let blob = null;
  try {
    const b = await httpsGetJson(`https://jsonblob.com/api/jsonBlob/${JSONBLOB_ID}`);
    blob = sanitize(b.data);
    if (!blob) console.log('[BLOB] 空 / 異常，當空處理 (唔會 wipe repo)');
    else console.log(`[BLOB] reminders: ${(blob.reminders || []).length}`);
  } catch (e) {
    console.log('[BLOB] 讀取失敗，當空處理 (唔會 wipe repo):', e.message);
  }

  // 3. 合併
  const merged = merge(repo, blob || {});

  // ★ 寫返本地 data.json，令緊接嘅 bot step 讀到最新 (含 notifyLedger / app 新加嘅提醒)，
  //   唔使等下一次 checkout 先見到 — 避免 bot 讀到過期 local 而漏發 / 重發
  try { fs.writeFileSync(localPath, stableStringify(merged)); console.log('[REPO] 已寫返本地 data.json (供 bot 讀最新)'); }
  catch (e) { console.error('[REPO] 本地寫回失敗:', e.message); }

  // 4. 寫回 repo (有變先寫)
  if (stableStringify(merged) !== stableStringify(repo)) {
    if (GH_TOKEN && repoSha) {
      try {
        await githubApiPut('data.json', merged, repoSha, 'Sync: reconcile data.json with cloud (merge)');
        console.log('[REPO] 已合併寫回 data.json');
      } catch (e) {
        console.error('[REPO] 寫回失敗 (可能 SHA 衝突，下次 retry):', e.message);
      }
    } else {
      console.log('[REPO] 有變但無 GH_TOKEN/sha，跳過寫回 (請喺 CI 跑或 set token)');
    }
  } else {
    console.log('[REPO] 無變化，跳過寫回');
  }

  // 5. 寫回 jsonblob (有變先寫；防 wipe：只寫 sanitize 過嘅 merged)
  if (blob && stableStringify(merged) === stableStringify(blob)) {
    console.log('[BLOB] 無變化，跳過寫回');
  } else {
    try {
      await httpsPutJson(`https://jsonblob.com/api/jsonBlob/${JSONBLOB_ID}`, merged);
      console.log('[BLOB] 已合併寫回 jsonblob');
    } catch (e) {
      console.error('[BLOB] 寫回失敗:', e.message);
    }
  }

  console.log('=== Done ===');
  process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
