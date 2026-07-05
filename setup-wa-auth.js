/**
 * 本機工具：掃 QR 碼生成 WhatsApp auth state（WA_CREDS_B64）
 *
 * 用法：
 *   1. node setup-wa-auth.js
 *   2. 終端會顯示 QR 碼（或打開瀏覽器睇 qr.html）
 *   3. 用手機 WhatsApp → 已連結裝置 → 掃碼
 *   4. 成功連接後自動打包 auth state → wa-auth.tar.gz
 *   5. 輸出 base64 畀你複製去 GitHub Secret
 *
 * 之後每當 workflow 成功執行，會自動更新 WA_CREDS_B64，
 * 實際可維持數週唔使手動更新。
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AUTH_DIR = path.join(__dirname, 'baileys-auth');
const TAR_GZ   = path.join(__dirname, 'wa-auth.tar.gz');
const HTML     = path.join(__dirname, 'qr.html');

async function main() {
  console.log('=== WhatsApp Auth Setup ===');
  console.log('準備掃 QR 碼登入 WhatsApp Web...\n');

  // 清理舊 auth
  if (fs.existsSync(AUTH_DIR)) {
    console.log('⚠️  發現舊嘅 baileys-auth/，清理中...');
    fs.rmSync(AUTH_DIR, { recursive: true });
  }

  const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let qrStr = '';
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,    // 終端顯示 QR
    browser: ['FamilyReminder', 'Setup', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  // 擷取 QR code（terminal 會自動顯示，呢度另外產 HTML 畀瀏覽器）
  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      qrStr = update.qr;
      console.log('\n📱 請用手機 WhatsApp 掃以下 QR 碼：\n');
      console.log('（如果終端睇唔到，請打開 qr.html）\n');

      // 產 QR HTML（用 qrcode-generator 或者簡單 data URI）
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qrStr);
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WhatsApp QR</title></head>
<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
<h2>📱 請用 WhatsApp 掃以下 QR 碼</h2>
<img src="${qrUrl}" style="border:2px solid #333;margin:20px"/>
<p>WhatsApp → 已連結裝置 → 連結裝置 → 掃描 QR 碼</p>
<script>setTimeout(()=>location.reload(), 10000); // 10秒刷新</script>
</body></html>`;
      fs.writeFileSync(HTML, html);
      console.log('📄  QR HTML 已寫入：' + HTML);
      console.log('   可用瀏覽器打開該檔案睇大圖 QR 碼\n');
    }

    if (update.connection === 'open') {
      console.log('\n✅  WhatsApp 已成功連接！');
      console.log('   手機號碼：' + update.user?.id || 'unknown');

      // 等 3 秒確保 auth state 已寫入
      await new Promise(r => setTimeout(r, 3000));
      await saveCreds();

      // 打包 auth state → tar.gz
      console.log('\n📦  打包 auth state...');
      execSync(`tar -czf "${TAR_GZ}" -C "${AUTH_DIR}" .`, { stdio: 'inherit' });

      const tarSize = fs.statSync(TAR_GZ).size;
      console.log(`✅  wa-auth.tar.gz 已生成（${Math.round(tarSize / 1024)} KB）`);

      // 輸出 base64
      const b64 = fs.readFileSync(TAR_GZ).toString('base64');
      console.log('\n📋  請將以下 base64 複製去 GitHub Secret（WA_CREDS_B64）：\n');
      console.log('═══════════════════════════════════════════════');
      console.log(b64);
      console.log('═══════════════════════════════════════════════\n');
      console.log('長度：' + Math.round(b64.length / 1024) + ' KB');
      console.log('\n步驟：');
      console.log('  1. 去 https://github.com/ken851004-afk/family-reminder-cloud/settings/secrets/actions');
      console.log('  2. 搵 WA_CREDS_B64 → Update');
      console.log('  3. 貼上上面嘅 base64（全部複製，唔好漏）');
      console.log('  4. 撳 Update secret\n');

      // 同時寫入檔案方便複製
      const b64File = path.join(__dirname, 'wa-auth-b64.txt');
      fs.writeFileSync(b64File, b64);
      console.log('📄  base64 已同時寫入：' + b64File);
      console.log('   可直接複製該檔內容\n');

      await sock.logout();
      process.exit(0);
    }

    if (update.connection === 'close') {
      const reason = update.lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.error('\n❌  已登出，請重新執行此 script\n');
      } else {
        console.error('\n❌  連接失敗：' + (update.lastDisconnect?.error?.message || 'unknown') + '\n');
      }
      process.exit(1);
    }
  });
}

main().catch(e => {
  console.error('❌ 嚴重錯誤：', e.message);
  process.exit(1);
});
