#!/bin/zsh
set -euo pipefail

LABEL="com.link-router.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Stopping Link Router..."

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Link Router background service removed."
