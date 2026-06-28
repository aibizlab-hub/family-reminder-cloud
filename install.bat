@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
:: ============================================================
:: 🏠 家庭提醒系统 — 一键安装脚本 (Windows)
:: ============================================================
title 家庭提醒系统 - 一键安装

echo.
echo ╔══════════════════════════════════════╗
echo ║   🏠 家庭提醒系统 — 一键安装       ║
echo ║   请回答我们这一家 v7              ║
echo ╚══════════════════════════════════════╝
echo.

:: ---- Check git ----
echo [0/8] 检查环境...
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 需要安装 git！请下载：https://git-scm.com
    pause & exit /b 1
)
echo   ✅ git 已安装

:: ---- Clone ----
echo.
echo [1/8] 获取代码...
set INSTALL_DIR=%USERPROFILE%\family-reminder-cloud
if exist "%INSTALL_DIR%" (
    echo   → 目录已存在，更新中...
    cd /d "%INSTALL_DIR%" && git pull
) else (
    echo   → Clone 中...
    git clone https://github.com/ken851004-afk/family-reminder-cloud.git "%INSTALL_DIR%"
    cd /d "%INSTALL_DIR%"
)
echo   ✅ 代码就位

:: ---- GitHub Token ----
echo.
echo [2/8] 设定 GitHub Token
echo   需要 GitHub Personal Access Token (Classic^)
echo   建立方法：GitHub → Settings → Developer settings → Tokens (classic^)
echo   权限需要：repo（勾选）
set /p GH_TOKEN="  请贴上 GitHub Token (ghp_ 开头): "

:: Test token
curl -s -o nul -w "%%{http_code}" -H "Authorization: Bearer %GH_TOKEN%" https://api.github.com/user > %TEMP%\gh_test.txt
set /p HTTP_CODE=<%TEMP%\gh_test.txt
if not "%HTTP_CODE%"=="200" (
    echo   ❌ Token 验证失败 (HTTP %HTTP_CODE%)！
    pause & exit /b 1
)
echo   ✅ Token 有效

:: ---- WhatsApp ----
echo.
echo [3/8] WhatsApp 凭证（可跳过）
echo   需要 Baileys WhatsApp 凭证 (Base64)
set /p WA_CREDS="  请贴上 WA_CREDS_B64（或直接 Enter 跳过）: "
if not "%WA_CREDS%"=="" (echo   ✅ WhatsApp 凭证已设定) else (echo   ⚠️ 已跳过)

:: ---- Fork/Repo ----
echo.
echo [4/8] 设定你的 GitHub Repo
for /f "tokens=*" %%i in ('curl -s -H "Authorization: Bearer %GH_TOKEN%" https://api.github.com/user ^| findstr /c:"\"login\""') do set GH_USER_LINE=%%i
echo   你的 GitHub 用户名请从下面查：https://github.com/settings/profile
set /p GH_USER="  请输入你的 GitHub 用户名: "

:: Check/create repo
curl -s -o nul -w "%%{http_code}" -H "Authorization: Bearer %GH_TOKEN%" "https://api.github.com/repos/%GH_USER%/family-reminder-cloud" > %TEMP%\repo_check.txt
set /p REPO_CHECK=<%TEMP%\repo_check.txt
if "%REPO_CHECK%"=="200" (
    echo   → Repo 已存在
) else (
    echo   → 建立新 repo...
    curl -s -H "Authorization: Bearer %GH_TOKEN%" -H "Content-Type: application/json" -d "{\"name\":\"family-reminder-cloud\",\"description\":\"家庭提醒系统\",\"private\":false}" https://api.github.com/user/repos >nul
)
cd /d "%INSTALL_DIR%"
git remote remove origin 2>nul
git remote add origin "https://github.com/%GH_USER%/family-reminder-cloud.git"
git branch -M master
git push -u origin master 2>nul
echo   ✅ Repo: https://github.com/%GH_USER%/family-reminder-cloud

:: ---- Secrets ----
echo.
echo [5/8] 设定 GitHub Secrets
echo   ⚠️ 请手动设定以下 Secrets：
echo     设定网址：https://github.com/%GH_USER%/family-reminder-cloud/settings/secrets/actions
echo.
echo     • GH_PAT = %GH_TOKEN%
if not "%WA_CREDS%"=="" echo     • WA_CREDS_B64 = %WA_CREDS%
echo.
echo   请按任意键继续（设定完 Secrets 后）...
pause >nul

:: ---- Pages ----
echo.
echo [6/8] 启用 GitHub Pages
curl -s -X POST -H "Authorization: Bearer %GH_TOKEN%" -H "Content-Type: application/json" -d "{\"source\":{\"branch\":\"gh-pages\",\"path\":\"/\"}}" "https://api.github.com/repos/%GH_USER%/family-reminder-cloud/pages" >nul 2>&1
set PAGES_URL=https://%GH_USER%.github.io/family-reminder-cloud/
echo   ✅ Pages URL: %PAGES_URL%

:: ---- gh-pages ----
echo.
echo [7/8] 部署网页...
cd /d "%INSTALL_DIR%"
git show-ref --verify --quiet refs/heads/gh-pages 2>nul
if %errorlevel% neq 0 (
    git checkout --orphan gh-pages
    git rm -rf . 2>nul
    git checkout master -- index.html
    echo.>.nojekyll
    git add index.html .nojekyll
    git commit -m "Initial Pages deploy"
    git push origin gh-pages
    git checkout master
)
echo   ✅ gh-pages 已部署

:: ---- Init data ----
echo.
echo [8/8] 初始化资料...
if not exist "%INSTALL_DIR%\data.json" (
    echo {"reminders":[],"birthdays":[],"history":[]}> "%INSTALL_DIR%\data.json"
    git add data.json && git commit -m "Init data.json" && git push
)
echo   ✅ data.json 已初始化

:: ---- Done ----
echo.
echo ╔══════════════════════════════════════╗
echo ║   🎉 安装完成！                     ║
echo ╚══════════════════════════════════════╝
echo.
echo   📱 你的网址：%PAGES_URL%
echo   📋 记得设定 Secrets
echo.
echo   📖 README：https://github.com/%GH_USER%/family-reminder-cloud
echo   📲 WhatsApp 号码格式：852XXXXXXXX@s.whatsapp.net
echo.
pause
