#!/bin/zsh
set -euo pipefail

APP_NAME="Chaopi Link Router"
LABEL="com.chaopi.link-router"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

show_help() {
  cat <<'HELP'
Chaopi Link Router 一键更新

执行内容：
  1. 拉取 GitHub 最新代码
  2. 保留当前电脑的本地配置
  3. 仅在需要时更新依赖
  4. 重启并检查本地服务
  5. 打开 Chrome 扩展页，提示重新加载插件

用法：双击 update.command，或在终端运行 ./update.command
HELP
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

finish() {
  if [[ -t 0 ]]; then
    echo ""
    read -k 1 "?按任意键关闭..."
    echo ""
  fi
}
trap finish EXIT

echo "正在更新 $APP_NAME..."
cd "$ROOT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "未找到 Git，请先安装 Xcode Command Line Tools。"
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "未找到 Node.js 20+，请先安装 Node.js。"
  exit 1
fi
if [[ ! -d .git ]]; then
  echo "当前目录不是 Git 项目：$ROOT_DIR"
  exit 1
fi

# config.js contains a machine-specific router token. Keep it out of normal
# status and pull conflict checks while retaining the tracked empty template.
if git ls-files --error-unmatch extension/config.js >/dev/null 2>&1; then
  git update-index --skip-worktree extension/config.js
fi

DIRTY_TRACKED="$(git status --porcelain --untracked-files=no)"
if [[ -n "$DIRTY_TRACKED" ]]; then
  echo "检测到尚未提交的项目修改，已停止更新以避免覆盖："
  echo "$DIRTY_TRACKED"
  echo "请先提交、暂存或撤销这些修改后再运行。"
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "当前 Git 处于 detached HEAD，无法安全拉取。"
  exit 1
fi

BEFORE_HEAD="$(git rev-parse HEAD)"
BEFORE_LOCK="$(git rev-parse HEAD:server/package-lock.json 2>/dev/null || true)"

echo "正在从 GitHub 拉取 $BRANCH..."
git pull --ff-only

AFTER_HEAD="$(git rev-parse HEAD)"
AFTER_LOCK="$(git rev-parse HEAD:server/package-lock.json 2>/dev/null || true)"

if [[ ! -d "$SERVER_DIR/node_modules" || "$BEFORE_LOCK" != "$AFTER_LOCK" ]]; then
  echo "正在更新服务依赖..."
  npm install --prefix "$SERVER_DIR"
else
  echo "服务依赖没有变化，跳过安装。"
fi

echo "正在恢复当前电脑的本地配置..."
node "$SERVER_DIR/src/init-local.js" >/dev/null

if [[ -f "$PLIST" ]]; then
  echo "正在重启本地服务..."
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  echo "尚未找到本地服务，正在执行首次安装..."
  "$ROOT_DIR/install.command"
fi

echo "正在检查本地服务..."
HEALTHY=0
for _attempt in {1..15}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:18791/health >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" -ne 1 ]]; then
  echo "代码已更新，但本地服务未能通过健康检查。"
  echo "请查看日志：$HOME/Library/Logs/ChaopiLinkRouter/server.err.log"
  exit 1
fi

if [[ "$BEFORE_HEAD" == "$AFTER_HEAD" ]]; then
  echo "当前已经是最新版本。"
else
  echo "代码已更新：${BEFORE_HEAD[1,7]} → ${AFTER_HEAD[1,7]}"
fi

echo "本地服务运行正常。"
echo "最后一步：在 Chrome 扩展页找到 Chaopi Link Router，点击“重新加载”。"
open -a "Google Chrome" "chrome://extensions/" >/dev/null 2>&1 || true
