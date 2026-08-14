#!/bin/bash
set -euo pipefail

# ─── Đổi nick đăng nhập cho CHROME LÀM VIDEO THỨ 3 (port 9225, profile .api-chrome-profile-video3) ───
# Cách dùng: bash switch_video3_nick.sh

UID_NUM=$(id -u)
PROFILE=/Users/qtee/Veo3Data/.api-chrome-profile-video3
COOKIES="$(dirname "$0")/cookies_video3.json"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PLIST="$HOME/Library/LaunchAgents/com.meo3.chrome-video3.plist"

echo "==> [1/5] Stopping video3 Chrome agent (release profile lock) + API server..."
launchctl bootout gui/$UID_NUM/com.meo3.chrome-video3 2>/dev/null || true
launchctl bootout gui/$UID_NUM/com.meo3.api 2>/dev/null || true
sleep 2
pkill -9 -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 2

echo "==> [2/5] Removing old video3 profile + cookies (fresh login)..."
rm -rf "$PROFILE"
rm -f "$COOKIES"

echo "==> [3/5] Opening VISIBLE Chrome for video3 nick login."
echo "      Bước làm: trong cửa sổ Chrome vừa mở → đăng nhập nick MỚI →"
echo "      rồi ĐÓNG cửa sổ Chrome."
"$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-popup-blocking --allow-insecure-localhost --ignore-certificate-errors \
  "https://accounts.google.com" &

CHROME_PID=$!

read -r -p "      Đã đăng nhập xong nick MỚI và đóng Chrome? Nhấn Enter để tiếp tục... " _

echo "==> [4/5] Killing any leftover Chrome on video3 profile..."
kill "$CHROME_PID" 2>/dev/null || true
pkill -9 -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 2

echo "==> [5/5] Restarting video3 Chrome agent (hidden, 9225) + API server..."
launchctl bootstrap gui/$UID_NUM "$PLIST" 2>/dev/null || true
launchctl kickstart gui/$UID_NUM/com.meo3.chrome-video3 2>/dev/null || true
launchctl bootstrap gui/$UID_NUM "$HOME/Library/LaunchAgents/com.meo3.api.plist" 2>/dev/null || true
launchctl kickstart -k gui/$UID_NUM/com.meo3.api 2>/dev/null || true

echo "Done! Video3 nick switched. Server will capture the new session on the next video request."
