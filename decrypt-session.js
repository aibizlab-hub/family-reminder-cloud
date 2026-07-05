const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Decrypt session.db.enc -> session.db
const ENC_FILE = process.argv[2];
const SESSION_PATH = process.argv[3] || path.join(process.env.HOME || process.env.USERPROFILE, '.wacli', 'session.db');
const KEY_ENV = process.argv[4] || 'WACLI_SESSION_KEY';

if (!ENC_FILE) {
  console.error('Usage: node decrypt-session.js <encrypted-file> [output-session.db] [KEY_ENV]');
  process.exit(1);
}

const keySource = process.env[KEY_ENV];
if (!keySource) {
  console.error(`ERROR: ${KEY_ENV} env var not set`);
  process.exit(1);
}

const key = Buffer.from(keySource, 'hex');
if (key.length !== 32) {
  console.error('ERROR: Key must be 64-char hex (32 bytes)');
  process.exit(1);
}

const input = fs.readFileSync(ENC_FILE);
const iv = input.slice(0, 16);
const authTag = input.slice(16, 32);
const encrypted = input.slice(32);

const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(authTag);

const decrypted = Buffer.concat([
  decipher.update(encrypted),
  decipher.final()
]);

// Ensure output directory exists
const outDir = path.dirname(SESSION_PATH);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(SESSION_PATH, decrypted);
console.log(`Decrypted: ${ENC_FILE} -> ${SESSION_PATH}`);
console.log(`Size: ${input.length} -> ${decrypted.length} bytes`);
