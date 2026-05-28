#!/bin/zsh
set -euo pipefail

APP_NAME="Link Router"
LABEL="com.link-router.local"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/LinkRouter"

echo "Installing $APP_NAME..."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 20+ first, then run this installer again."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required. Current version: $(node -v)"
  exit 1
fi

mkdir -p "$LOG_DIR"

cd "$SERVER_DIR"
if [ -f package-lock.json ]; then
  npm install
else
  npm install
fi

node --check src/index.js >/dev/null
node src/init-local.js

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>WorkingDirectory</key>
  <string>$SERVER_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$SERVER_DIR/src/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo ""
echo "$APP_NAME installed."
echo "Local service: http://127.0.0.1:18791"
echo "Logs: $LOG_DIR"
echo ""
echo "Next step: load the Chrome extension from:"
echo "$ROOT_DIR/extension"
