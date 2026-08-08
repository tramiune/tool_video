#!/bin/bash
set -euo pipefail

# ─── Đổi nick đăng nhập cho CHROME LÀM ẢNH (port 9223, profile .api-chrome-profile-img) ───
# Cách dùng: bash switch_image_nick.sh
# - Dừng agent chrome ảnh + API server (để mở khoá profile)
# - Mở cửa sổ Chrome NHÌN THẤY ĐƯỢC của profile ảnh → bạn đăng xuất, đăng nhập nick MỚI, đóng cửa sổ
# - Khởi động lại agent chrome ảnh (ẩn, 9223) + API server

UID_NUM=$(id -u)
IMG_PROFILE=/Users/qtee/Veo3Data/.api-chrome-profile-img
IMG_COOKIES="$(dirname "$0")/cookies_image.json"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PLIST="$HOME/Library/LaunchAgents/com.meo3.chrome-img.plist"

echo "==> [1/5] Stopping image Chrome agent (release profile lock) + API server..."
launchctl bootout gui/$UID_NUM/com.meo3.chrome-img 2>/dev/null || true
launchctl bootout gui/$UID_NUM/com.meo3.api 2>/dev/null || true
sleep 2
# Đảm bảo không còn process Chrome nào đang khoá profile ảnh
pkill -f "user-data-dir=$IMG_PROFILE" 2>/dev/null || true
sleep 1

echo "==> [2/5] Removing old image profile + cookies (fresh login)..."
rm -rf "$IMG_PROFILE"
rm -f "$IMG_COOKIES"

echo "==> [3/5] Opening VISIBLE Chrome for image nick login."
echo "      Bước làm: trong cửa sổ Chrome vừa mở → đăng xuất tài khoản cũ →"
echo "      đăng nhập nick MỚI → rồi ĐÓNG cửa sổ Chrome."
"$CHROME" \
  --user-data-dir="$IMG_PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-popup-blocking --allow-insecure-localhost --ignore-certificate-errors \
  "https://accounts.google.com" &

CHROME_PID=$!

read -r -p "      Đã đăng nhập xong nick MỚI và đóng Chrome? Nhấn Enter để tiếp tục... " _

echo "==> [4/5] Killing any leftover Chrome on image profile..."
kill "$CHROME_PID" 2>/dev/null || true
pkill -f "user-data-dir=$IMG_PROFILE" 2>/dev/null || true
sleep 2

echo "==> [5/5] Restarting image Chrome agent (hidden, 9223) + API server..."
launchctl bootstrap gui/$UID_NUM "$PLIST" 2>/dev/null || true
launchctl kickstart -k gui/$UID_NUM/com.meo3.chrome-img 2>/dev/null || true
launchctl bootstrap gui/$UID_NUM "$HOME/Library/LaunchAgents/com.meo3.api.plist" 2>/dev/null || true
launchctl kickstart -k gui/$UID_NUM/com.meo3.api 2>/dev/null || true

echo "Done! Image nick switched. Server will capture the new session on the next image request."
