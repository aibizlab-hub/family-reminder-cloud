# Family Reminder - 本地提醒服務設定指南

## 問題
GitHub Actions 無法直接發送 WhatsApp 訊息（需要認證）。

## 解決方案
改為喺**你部機本地跑提醒服務**，直接調用已認證嘅 `wacli`。

---

## 快速設定（3 分鐘）

### 方法一：一鍵啟動（推薦）

1. 下載 `start-reminder.bat`：
   https://raw.githubusercontent.com/ken851004-afk/family-reminder-cloud/master/start-reminder.bat

2. 雙撃執行

3. 保持視窗開啟（最小化就得）

---

### 方法二：開機自動啟動（永久方案）

1. 以**管理員身份**開 PowerShell

2. 執行：
   ```powershell
   irm https://raw.githubusercontent.com/ken851004-afk/family-reminder-cloud/master/setup-autostart.ps1 | iex
   ```

3. 完成！下次開機會自動啟動

---

## 檢查狀態

```powershell
# 檢查排程
Get-ScheduledTask -TaskName "FamilyReminderService"

# 手動啟動
Start-ScheduledTask -TaskName "FamilyReminderService"

# 檢查日誌
cat "$env:USERPROFILE\WorkBuddy\family-reminder-cloud\reminder-log.txt"
```

---

## 注意事項

1. **部機必須開啟**先可以發送提醒
2. `wacli` 必須已認證（執行 `wacli doctor` 檢查）
3. 如果 `wacli` 認證過期，重新執行 `wacli auth` 就得
4. 日誌檔位置：`%USERPROFILE%\WorkBuddy\family-reminder-cloud\reminder-log.txt`

---

## 停用 GitHub Actions（已完成）

失敗通知已停用。
