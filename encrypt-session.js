const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Encrypt session.db -> session.db.enc
const SESSION_PATH = process.argv[2] || path.join(process.env.HOME || process.env.USERPROFILE, '.wacli', 'session.db');
const KEY_ENV = process.argv[3] || 'WACLI_SESSION_KEY';
const OUTPUT = SESSION_PATH + '.enc';

const keySource = process.env[KEY_ENV];
if (!keySource) {
  console.error(`ERROR: ${KEY_ENV} env var not set`);
  console.error(`Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  process.exit(1);
}

// Derive 32-byte key from hex string
const key = Buffer.from(keySource, 'hex');
if (key.length !== 32) {
  console.error('ERROR: WACLI_SESSION_KEY must be 64-char hex (32 bytes)');
  process.exit(1);
}

const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

const input = fs.readFileSync(SESSION_PATH);
const encrypted = Buffer.concat([
  cipher.update(input),
  cipher.final()
]);
const authTag = cipher.getAuthTag();

// Output: iv(16) + authTag(16) + encrypted
const output = Buffer.concat([iv, authTag, encrypted]);
fs.writeFileSync(OUTPUT, output);

console.log(`Encrypted: ${SESSION_PATH} -> ${OUTPUT}`);
console.log(`Size: ${input.length} -> ${output.length} bytes`);
console.log(`Base64 length: ${output.toString('base64').length} chars`);
