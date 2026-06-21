/**
 * GitHub Actions: 同步 jsonblob 数据到 GitHub repo 的 data.json
 * 
 * 环境变量:
 * - JSONBLOB_ID: jsonblob.com blob ID
 * - GH_PAT: GitHub Personal Access Token
 */

const https = require('https');
const fs = require('fs');

const OWNER = 'ken851004-afk';
const REPO = 'family-reminder-cloud';
const JSONBLOB_ID = process.env.JSONBLOB_ID;
const GH_PAT = process.env.GH_PAT;

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { headers };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    }).on('error', reject);
  });
}

function httpsRequest(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('=== Sync Data ===');

  // 1. Fetch from jsonblob
  const blobRes = await httpsGet(`https://jsonblob.com/api/jsonBlob/${JSONBLOB_ID}`);
  if (blobRes.status !== 200 || !blobRes.data) {
    console.error('Failed to fetch from jsonblob:', blobRes.status);
    process.exit(1);
  }
  console.log('[BLOB] Fetched data:', blobRes.data.reminders?.length || 0, 'reminders');

  // 2. Get current data.json SHA (needed for update)
  const fileRes = await httpsGet(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/data.json`,
    { 'Authorization': `token ${GH_PAT}`, 'User-Agent': 'family-reminder-sync' }
  );

  let sha = null;
  if (fileRes.status === 200 && fileRes.data.sha) {
    sha = fileRes.data.sha;
    console.log('[GH] Current data.json SHA:', sha);
  } else {
    console.log('[GH] data.json does not exist yet, creating new');
  }

  // 3. Update data.json
  const content = Buffer.from(JSON.stringify(blobRes.data, null, 2)).toString('base64');
  const updateRes = await httpsRequest(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/data.json`,
    'PUT',
    {
      message: `Auto-sync data ${new Date().toISOString()}`,
      content,
      ...(sha ? { sha } : {})
    },
    { 'Authorization': `token ${GH_PAT}`, 'User-Agent': 'family-reminder-sync' }
  );

  if (updateRes.status === 200 || updateRes.status === 201) {
    console.log('[GH] data.json updated successfully!');
  } else {
    console.error('[GH] Update failed:', updateRes.status, updateRes.data);
    process.exit(1);
  }
}

main().then(() => {
  console.log('=== Done ===');
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
