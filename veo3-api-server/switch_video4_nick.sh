#!/bin/bash
set -euo pipefail

# ─── Đổi nick đăng nhập cho CHROME LÀM VIDEO THỨ 4 (port 9226, profile .api-chrome-profile-video4) ───
# Cách dùng: bash switch_video4_nick.sh

UID_NUM=$(id -u)
PROFILE=/Users/qtee/Veo3Data/.api-chrome-profile-video4
COOKIES="$(dirname "$0")/cookies_video4.json"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PLIST="$HOME/Library/LaunchAgents/com.meo3.chrome-video4.plist"

echo "==> [1/5] Stopping video4 Chrome agent (release profile lock) + API server..."
launchctl bootout gui/$UID_NUM/com.meo3.chrome-video4 2>/dev/null || true
launchctl bootout gui/$UID_NUM/com.meo3.api 2>/dev/null || true
sleep 2
pkill -9 -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 2

echo "==> [2/5] Removing old video4 profile + cookies (fresh login)..."
rm -rf "$PROFILE"
rm -f "$COOKIES"

echo "==> [3/5] Opening VISIBLE Chrome for video4 nick login."
echo "      Bước làm: trong cửa sổ Chrome vừa mở → đăng nhập nick MỚI →"
echo "      rồi ĐÓNG cửa sổ Chrome."
"$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-popup-blocking --allow-insecure-localhost --ignore-certificate-errors \
  "https://accounts.google.com" &

CHROME_PID=$!

read -r -p "      Đã đăng nhập xong nick MỚI và đóng Chrome? Nhấn Enter để tiếp tục... " _

echo "==> [4/5] Killing any leftover Chrome on video4 profile..."
kill "$CHROME_PID" 2>/dev/null || true
pkill -9 -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 2

echo "==> [5/5] Restarting video4 Chrome agent (hidden, 9226) + API server..."
launchctl bootstrap gui/$UID_NUM "$PLIST" 2>/dev/null || true
launchctl kickstart gui/$UID_NUM/com.meo3.chrome-video4 2>/dev/null || true
launchctl bootstrap gui/$UID_NUM "$HOME/Library/LaunchAgents/com.meo3.api.plist" 2>/dev/null || true
launchctl kickstart -k gui/$UID_NUM/com.meo3.api 2>/dev/null || true

echo "Done! Video4 nick switched. Server will capture the new session on the next video request."
