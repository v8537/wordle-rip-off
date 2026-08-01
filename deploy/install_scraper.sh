#!/bin/bash
# Installs the LaunchAgent that keeps data/answers.json stocked with NYT Wordle answers (see
# scripts/scrape_word.py). Run this on the host that owns the write-access deploy key for this
# repo (currently the home server) -- not on a dev machine, which pushes by hand.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL="com.wordle.scrape"

mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/logs"

cat > "$LAUNCH_AGENTS_DIR/${LABEL}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>${PROJECT_DIR}/scripts/scrape_word.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <!-- Every 30 minutes, rather than a fixed calendar time: the script itself computes
    the current window from the host's local date, so exact timing doesn't matter, and a
    short interval sidesteps having to reconcile the host's local timezone against the
    many different visitor-local "todays" the window needs to cover. -->
    <key>StartInterval</key>
    <integer>1800</integer>
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/logs/scrape.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/logs/scrape.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$LAUNCH_AGENTS_DIR/${LABEL}.plist" 2>/dev/null || true
launchctl load -w "$LAUNCH_AGENTS_DIR/${LABEL}.plist"
echo "Loaded $LABEL"
