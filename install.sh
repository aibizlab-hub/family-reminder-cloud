#!/bin/bash
# ============================================================
# 🏠 家庭提醒系統 — 一鍵安裝腳本
# 支援：Linux / macOS / Git Bash (Windows)
# ============================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
BOLD='\033[1m'

banner() {
  echo -e "${CYAN}"
  echo "╔══════════════════════════════════════╗"
  echo "║   🏠 家庭提醒系統 — 一鍵安裝       ║"
  echo "║   請回答我們這一家 v7              ║"
  echo "╚══════════════════════════════════════╝"
  echo -e "${NC}"
}

section() { echo -e "\n${BOLD}${GREEN}▸ $1${NC}"; }
info()   { echo -e "  ${CYAN}→${NC} $1"; }
done_msg() { echo -e "  ${GREEN}✅ 完成：${NC}$1"; }
warn()   { echo -e "  ${YELLOW}⚠️  注意：${NC}$1"; }

# ============================================================
banner

# ---- Step 0: Check prerequisites ----
section "第 0 步：檢查環境"
command -v git >/dev/null 2>&1 || { echo -e "${RED}❌ 需要 git！請安裝 git${NC}"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo -e "${RED}❌ 需要 curl！${NC}"; exit 1; }
done_msg "git + curl 已安裝"

# ---- Step 1: Fork/clone ----
section "第 1 步：獲取代碼"
REPO_URL="https://github.com/ken851004-afk/family-reminder-cloud.git"
INSTALL_DIR="${HOME}/family-reminder-cloud"

if [ -d "$INSTALL_DIR" ]; then
  info "目錄已存在，更新中..."
  cd "$INSTALL_DIR" && git pull
else
  info "Clone 中..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
done_msg "代碼就位：$INSTALL_DIR"

# ---- Step 2: GitHub Token ----
section "第 2 步：設定 GitHub Token"
echo -e "  ${YELLOW}需要 GitHub Personal Access Token（Classic）${NC}"
echo -e "  ${YELLOW}建立方法：GitHub → Settings → Developer settings → Tokens (classic)${NC}"
echo -e "  ${YELLOW}權限需要：repo（勾選）${NC}"

if [ -z "$GH_TOKEN" ]; then
  read -r -p "  請貼上 GitHub Token（ghp_ 開頭）: " GH_TOKEN
fi

# Test token
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user)
if [ "$HTTP_CODE" != "200" ]; then
  echo -e "  ${RED}❌ Token 驗證失敗（HTTP $HTTP_CODE）！請檢查後重試${NC}"
  exit 1
fi
GH_USER=$(curl -s -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | grep -o '"login":"[^"]*"' | cut -d'"' -f4)
done_msg "Token 有效（用戶：$GH_USER）"

# ---- Step 3: WhatsApp Credentials (optional) ----
section "第 3 步：WhatsApp 憑證（可跳過）"
echo -e "  ${YELLOW}需要 Baileys WhatsApp 憑證（Base64）${NC}"
echo -e "  ${YELLOW}如果暫時唔需要 WhatsApp 提醒功能，可以跳過${NC}"
read -r -p "  請貼上 WA_CREDS_B64（或直接 Enter 跳過）: " WA_CREDS

if [ -n "$WA_CREDS" ]; then
  done_msg "WhatsApp 憑證已設定"
else
  warn "已跳過 WhatsApp 設定（提醒功能將無法運作）"
fi

# ---- Step 4: Fork or use existing ----
section "第 4 步：設定你的 GitHub Repo"
read -r -p "  你的 GitHub 用戶名（剛才驗證的：$GH_USER）[Enter=使用]: " INPUT_USER
GH_USER="${INPUT_USER:-$GH_USER}"

# Check if repo exists under user
REPO_CHECK=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/$GH_USER/family-reminder-cloud")

if [ "$REPO_CHECK" == "200" ]; then
  info "Repo $GH_USER/family-reminder-cloud 已存在"
  ORIGIN_URL="https://github.com/$GH_USER/family-reminder-cloud.git"
else
  info "建立新 repo: $GH_USER/family-reminder-cloud"
  curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"family-reminder-cloud","description":"🏠 家庭提醒系統","private":false}' \
    https://api.github.com/user/repos > /dev/null
  ORIGIN_URL="https://github.com/$GH_USER/family-reminder-cloud.git"
fi

# Set remote and push
cd "$INSTALL_DIR"
git remote remove origin 2>/dev/null || true
git remote add origin "$ORIGIN_URL"
git branch -M master
git push -u origin master 2>/dev/null || info "master 分支已存在，跳過 push"
done_msg "Repo: https://github.com/$GH_USER/family-reminder-cloud"

# ---- Step 5: Secrets ----
section "第 5 步：設定 GitHub Secrets"
# Set GH_PAT
curl -s -X PUT -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
  -d "{\"encrypted_value\":\"$(echo -n "$GH_TOKEN" | openssl base64 -A 2>/dev/null || echo -n "$GH_TOKEN" | base64)\",\"key_id\":\"dummy\"}" \
  "https://api.github.com/repos/$GH_USER/family-reminder-cloud/actions/secrets/GH_PAT" > /dev/null 2>&1 || true

info "請手動設定以下 Secrets（GitHub → Repo → Settings → Secrets and variables → Actions）："
echo -e "  ${YELLOW}  • GH_PAT = $GH_TOKEN${NC}"

if [ -n "$WA_CREDS" ]; then
  echo -e "  ${YELLOW}  • WA_CREDS_B64 = $WA_CREDS${NC}"
fi
echo -e "  ${CYAN}  設定網址：https://github.com/$GH_USER/family-reminder-cloud/settings/secrets/actions${NC}"

# ---- Step 6: Enable GitHub Pages ----
section "第 6 步：啟用 GitHub Pages"
curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
  -d '{"source":{"branch":"gh-pages","path":"/"}}' \
  "https://api.github.com/repos/$GH_USER/family-reminder-cloud/pages" > /dev/null 2>&1 || info "Pages 已啟用或需手動設定"

PAGES_URL="https://${GH_USER}.github.io/family-reminder-cloud/"
done_msg "GitHub Pages URL: $PAGES_URL"

# ---- Step 7: Create gh-pages branch ----
section "第 7 步：部署網頁"
cd "$INSTALL_DIR"
if git show-ref --verify --quiet refs/heads/gh-pages; then
  info "gh-pages 分支已存在"
else
  git checkout --orphan gh-pages
  git rm -rf . 2>/dev/null || true
  git checkout master -- index.html
  touch .nojekyll
  git add index.html .nojekyll
  git commit -m "Initial Pages deploy"
  git push origin gh-pages
  git checkout master
fi
done_msg "gh-pages 已部署"

# ---- Step 8: Init data.json ----
section "第 8 步：初始化資料"
cd "$INSTALL_DIR"
if [ ! -f "data.json" ]; then
  echo '{"reminders":[],"birthdays":[],"history":[]}' > data.json
  git add data.json && git commit -m "Init data.json" && git push
fi
done_msg "data.json 已初始化"

# ---- Done ----
echo -e "\n${BOLD}${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║   🎉 安裝完成！                     ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}📱 你的網址：${BOLD}$PAGES_URL${NC}"
echo -e "  ${CYAN}📋 記得設定 Secrets：${NC}"
echo -e "     ${YELLOW}https://github.com/$GH_USER/family-reminder-cloud/settings/secrets/actions${NC}"
echo ""
echo -e "  ${CYAN}📖 README：${NC}https://github.com/$GH_USER/family-reminder-cloud"
echo -e "  ${CYAN}📲 WhatsApp 號碼格式：${NC}852XXXXXXXX@s.whatsapp.net"
echo ""
