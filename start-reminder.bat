@echo off
REM 一鍵啟動 Family Reminder 本地服務
REM 用法：雙撃此檔 或 喺 CMD 執行 start-reminder.bat

echo ================================
echo  Family Reminder 本地服務
echo ================================
echo.

REM 設定路徑
set REPO_DIR=%USERPROFILE%\WorkBuddy\family-reminder-cloud
set WACLI=%USERPROFILE%\.workbuddy\binaries\wacli\wacli.exe
set NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.12.0\node.exe

REM 1. 檢查 wacli 認證
echo [1/4] 檢查 WhatsApp 認證...
"%WACLI%" doctor 2>&1 | find "authenticated" >nul
if errorlevel 1 (
    echo ❌ wacli 未認證，請先執行：wacli auth
    pause
    exit /b 1
)
echo ✅ wacli 已認證

REM 2. 下載最新 data.json
echo.
echo [2/4] 下載最新 data.json...
if not exist "%REPO_DIR%" mkdir "%REPO_DIR%"
curl -s -o "%REPO_DIR%\data.json" "https://raw.githubusercontent.com/ken851004-afk/family-reminder-cloud/master/data.json"
if errorlevel 1 (
    echo ⚠️  下載失敗，使用舊檔
) else (
    echo ✅ data.json 已更新
)

REM 3. 下載 local-reminder-service.js
echo.
echo [3/4] 下載提醒服務腳本...
curl -s -o "%REPO_DIR%\local-reminder-service.js" "https://raw.githubusercontent.com/ken851004-afk/family-reminder-cloud/master/local-reminder-service.js"
if errorlevel 1 (
    echo ❌ 下載失敗
    pause
    exit /b 1
)
echo ✅ 腳本已下載

REM 4. 啟動服務
echo.
echo [4/4] 啟動提醒服務...
echo ────────────────────────────────
echo 服務執行中，唔好關閉此視窗
echo 要停止請按 Ctrl+C
echo ────────────────────────────────
echo.

"%NODE%" "%REPO_DIR%\local-reminder-service.js"

pause
