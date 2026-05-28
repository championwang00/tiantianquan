#!/bin/zsh
set -euo pipefail

LABEL="com.tiantianquan.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Stopping 甜甜圈..."

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "甜甜圈 background service removed."
