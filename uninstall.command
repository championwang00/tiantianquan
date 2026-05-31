#!/bin/zsh
set -euo pipefail

LABEL="com.chaopi.link-router"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Stopping Chaopi Link Router..."

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Chaopi Link Router background service removed."
