#!/usr/bin/env python3
"""
autoclick_video_runner.py
=========================
Cơ chế tự động tạo Video qua Auto Click và giám sát tải về (hỗ trợ chạy song song 10 tác vụ):
1. Khóa chuột (/tmp/autoclick_video.lock) chỉ trong ~4s thao tác click & paste
2. Click (38, 546) + Click đúp (248, 546) lấy focus chuẩn vào <textarea> trong iframe Flow
3. Paste prompt theo định dạng (ratio|stt. prompt|urls...) & kiểm tra pixel xác nhận chữ đã vào ô
4. Click tọa độ (273, 733) nút "Chạy thủ công" & xác nhận ô input đã xoá trắng + • ĐANG CHẠY bật
5. Nhả khóa chuột ngay để task tiếp theo submit liên tục (SONG SONG: 10 tác vụ)
6. Poll thư mục Downloads tìm đúng file <stt>.mp4 mới tải về (tối đa 5 phút tính từ lúc task này bấm chạy)
"""

import os
import sys

# Ensure DISPLAY is set on Linux BEFORE importing pyautogui/mouseinfo
if sys.platform != "darwin" and "DISPLAY" not in os.environ:
    detected_disp = ":10"
    try:
        sock_dir = "/run/xrdp/sockdir"
        if os.path.isdir(sock_dir):
            nums = [
                int(f.split("_")[-1])
                for f in os.listdir(sock_dir)
                if f.startswith("xrdp_display_") and f.split("_")[-1].isdigit()
            ]
            if nums:
                detected_disp = f":{max(nums)}"
    except Exception:
        pass
    os.environ["DISPLAY"] = detected_disp

import time
import json
import argparse
import subprocess
import fcntl
import pyautogui
import pyperclip

pyautogui.FAILSAFE = True

LOCK_FILE = "/tmp/autoclick_video.lock"
SHARED_SCREEN_PATH = "/tmp/autoclick_shared_screen.png"


def capture_screen_rgb(max_age_sec=0.0, save_copy_path=None):
    """
    Chụp màn hình an toàn đa tiến trình (atomic os.replace qua file tạm gắn PID).
    Nếu max_age_sec > 0 và ảnh chung mới chụp trong khoảng max_age_sec thì tái sử dụng ngay,
    tránh 10 tiến trình gọi scrot dồn dập cùng lúc.
    """
    if sys.platform == "darwin":
        return None
    try:
        from PIL import Image
        if max_age_sec > 0 and os.path.exists(SHARED_SCREEN_PATH):
            try:
                age = time.time() - os.path.getmtime(SHARED_SCREEN_PATH)
                if 0 <= age <= max_age_sec:
                    return Image.open(SHARED_SCREEN_PATH).convert("RGB")
            except Exception:
                pass

        tmp_path = f"/tmp/autoclick_cap_{os.getpid()}.png"
        try:
            subprocess.run(
                ["scrot", "-o", tmp_path],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5
            )
            im = Image.open(tmp_path).convert("RGB")
            try:
                if save_copy_path:
                    im.save(save_copy_path)
            except Exception:
                pass
            try:
                os.replace(tmp_path, SHARED_SCREEN_PATH)
            except Exception:
                pass
            return im
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
    except Exception:
        return None


def get_downloads_files(downloads_dir):
    """Lấy danh sách các file .mp4 hiện có trong Downloads kèm mtime và size."""
    files_map = {}
    if not os.path.exists(downloads_dir):
        return files_map
    try:
        for f in os.listdir(downloads_dir):
            if f.endswith(".mp4") and not f.endswith(".crdownload"):
                p = os.path.join(downloads_dir, f)
                try:
                    st = os.stat(p)
                    files_map[f] = {"mtime": st.st_mtime, "size": st.st_size}
                except OSError:
                    pass
    except Exception as e:
        sys.stderr.write(f"[AutoClick] Lỗi đọc thư mục {downloads_dir}: {e}\n")
    return files_map


def image_to_data_uri(img_ref):
    """
    Chuyển URL ảnh (https://...) hoặc đường dẫn file cục bộ sang chuỗi data:image/jpeg;base64,...
    để vượt qua Content-Security-Policy (img-src data: blob:) của Google Flow iframe.
    """
    if not img_ref:
        return None
    s = str(img_ref).strip()
    if s.startswith("data:image"):
        return s
    try:
        import base64
        import io
        import urllib.request
        from PIL import Image

        raw_bytes = None
        if s.startswith("http://") or s.startswith("https://"):
            req = urllib.request.Request(s, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw_bytes = resp.read()
        elif os.path.exists(s):
            with open(s, "rb") as f:
                raw_bytes = f.read()

        if raw_bytes:
            im = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
            max_dim = 768
            if max(im.width, im.height) > max_dim:
                resample = getattr(Image, "Resampling", Image).LANCZOS
                scale = max_dim / float(max(im.width, im.height))
                im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), resample)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=80, optimize=True)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            if len(b64) > 90000:
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=72, optimize=True)
                b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            sys.stderr.write(f"[AutoClick] 🖼️ Đã chuyển ảnh sang data:image/jpeg ({len(b64) // 1024} KB base64, {im.width}x{im.height}) vượt CSP Flow.\n")
            return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        sys.stderr.write(f"[AutoClick] ⚠️ Lỗi chuyển ảnh sang data URI ({e}), giữ nguyên link gốc...\n")
    return s


def format_prompt(raw_prompt, stt, ratio, start_img=None, end_img=None):
    """Đảm bảo format đúng dạng: ratio|stt. prompt|image_urls... (luôn trên 1 dòng duy nhất)"""
    import re
    prompt = " ".join(str(raw_prompt or "").splitlines()).strip()

    # Nếu đã có prefix ratio| ở đầu thì tách ra để chuẩn hóa STT
    if "|" in prompt:
        parts = prompt.split("|")
        if parts[0].strip() in ("9:16", "16:9", "1:1"):
            ratio = parts[0].strip()
            prompt = "|".join(parts[1:]).strip()

    # Loại bỏ ký tự '|' trong nội dung prompt để không làm lệch split('|') của Flow Tool
    prompt = prompt.replace("|", " - ")
    prompt = re.sub(r"\s+", " ", prompt).strip()

    # Video SDK chỉ hỗ trợ 16:9 và 9:16
    ratio_str = str(ratio or "9:16").strip()
    ratio = "16:9" if ("16:9" in ratio_str or "wide" in ratio_str.lower()) else "9:16"

    # Luôn gắn chính xác mã STT của task vào đầu prompt để file tải về luôn mang tên <stt>.mp4
    clean_stt = str(stt).strip()
    if clean_stt:
        prompt = re.sub(r"^\d{1,6}[\.\-_:\s]+", "", prompt).strip()
        if not prompt or prompt in (".", "-", "_"):
            prompt = "Cinematic movement, high quality"
        prompt = f"{clean_stt}. {prompt}"
    elif not prompt:
        prompt = "Cinematic movement, high quality"

    full_line = f"{ratio}|{prompt}"

    # Thêm ảnh nếu có (chuyển sang data:image/jpeg;base64,... gọn nhẹ 768px vượt CSP của Google Flow)
    if start_img:
        start_uri = image_to_data_uri(start_img)
        if start_uri and start_uri not in full_line:
            full_line += f"|{start_uri}"
            if end_img:
                end_uri = image_to_data_uri(end_img)
                if end_uri and end_uri not in full_line:
                    full_line += f"|{end_uri}"

    return full_line


def load_preset_coords():
    """Tự động đọc tọa độ từ video_.json nếu có."""
    preset_paths = [
        os.path.expanduser("~/auto_click/presets/video_.json"),
        "/home/vpsuser/auto_click/presets/video_.json",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "auto_click/presets/video_.json"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "auto_click/presets/video_.json")
    ]
    for p in preset_paths:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    x_in, y_in = None, None
                    x_btn, y_btn = None, None
                    for act in data:
                        t = act.get("type")
                        if t in ("doubleclick", "click") and x_in is None:
                            x_in = act.get("x")
                            y_in = act.get("y")
                        elif t in ("click", "doubleclick") and (act.get("x") != x_in or act.get("y") != y_in):
                            x_btn = act.get("x")
                            y_btn = act.get("y")
                    if x_in is not None and x_btn is not None:
                        return x_in, y_in, x_btn, y_btn
            except Exception:
                pass
    return None


def activate_chrome():
    """Kích hoạt cửa sổ Google Chrome Video bên trái (x < 350) nổi lên trước và tự động căn chỉnh lại đúng tọa độ chuẩn (-4, 27, 508x906) nếu bị kéo lệch."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["osascript", "-e", 'tell application "Google Chrome" to activate'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            out = subprocess.check_output(["wmctrl", "-lG"], text=True, stderr=subprocess.DEVNULL)
            left_wid = None
            cur_geom = None
            for line in out.splitlines():
                if "google chrome" in line.lower():
                    parts = line.split()
                    if len(parts) >= 6:
                        try:
                            x_pos, y_pos, w_sz, h_sz = int(parts[2]), int(parts[3]), int(parts[4]), int(parts[5])
                            if x_pos < 350:
                                left_wid = parts[0]
                                cur_geom = (x_pos, y_pos, w_sz, h_sz)
                                break
                        except ValueError:
                            pass
            if left_wid:
                if cur_geom:
                    cx, cy, cw, ch = cur_geom
                    if abs(cx - (-4)) > 10 or abs(cy - 27) > 30 or abs(cw - 508) > 15 or abs(ch - 906) > 20:
                        sys.stderr.write(f"[AutoClick] 🔧 Phát hiện cửa sổ Video bị lệch ({cx},{cy} {cw}x{ch}), tự động đưa về vị trí chuẩn (-4,27 508x906)...\n")
                        subprocess.run(["wmctrl", "-ir", left_wid, "-b", "remove,maximized_vert,maximized_horz"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        subprocess.run(["wmctrl", "-ir", left_wid, "-e", "0,-4,27,508,906"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        time.sleep(0.3)
                subprocess.run(["xdotool", "windowactivate", left_wid], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.run(["xdotool", "search", "--onlyvisible", "--class", "google-chrome", "windowactivate"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.25)
    except Exception:
        pass


def set_clipboard(text):
    """Copy text vào clipboard mà không để xclip giữ pipe stdout/stderr của tiến trình cha."""
    try:
        proc = subprocess.Popen(
            ['xclip', '-selection', 'clipboard'],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True
        )
        proc.communicate(text.encode('utf-8'), timeout=5)
    except Exception:
        pyperclip.copy(text)


def is_flow_currently_running(im=None):
    """Quét vùng góc trên bên phải khung CẤU HÌNH STUDIO (x=385..475, y=190..255) tìm huy hiệu '• ĐANG CHẠY' màu xanh tím."""
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=0.0)
        if im is None:
            return False
        blue_hits = 0
        for py in range(190, 256, 2):
            for px in range(385, 476, 3):
                if 0 <= px < im.width and 0 <= py < im.height:
                    r, g, b = im.getpixel((px, py))
                    if b >= 52 and (b - r) >= 24:
                        blue_hits += 1
                        if blue_hits >= 15:
                            return True
        return False
    except Exception:
        return False


def is_chrome_overlay_menu_open(im=None):
    """
    Phát hiện xem popup danh sách Downloads màu trắng của Chrome (x=119..474, y=137..574)
    hoặc menu tràn '>>' (Forward / Downloads / Profile ở x=195..310, y=120..265) có đang mở đè lên cửa sổ trái hay không.
    """
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=0.0)
        if im is None:
            return False
        white_count = 0
        for py in range(145, 575, 15):
            for px in range(140, 450, 20):
                if 0 <= px < im.width and 0 <= py < im.height:
                    r, g, b = im.getpixel((px, py))
                    if r > 235 and g > 235 and b > 235:
                        white_count += 1
                        if white_count >= 18:
                            return True
        return False
    except Exception:
        return False


def has_pasted_text_in_textarea(im=None):
    """
    Kiểm tra xem trong ô textarea NHẬP THỦ CÔNG (x=50..440, y=505..680) đã có chữ trắng sáng (r>170, g>170, b>170)
    trên nền tối (#0e1420) hay chưa.
    - Nếu popup Downloads màu trắng của Chrome đang mở đè lên vùng này -> trả về False ngay (tránh nhận nhầm nền trắng popup là chữ).
    - Khi ô trống (chỉ có chữ placeholder 'tỷ lệ|mô tả|link_ảnh...' màu xám tối RGB ~ 66,76,111): số điểm sáng = 0.
    - Khi đã dán prompt: chữ trắng #f1f5f9 tạo ra hàng trăm điểm sáng > 170 trên nền tối.
    - Ngay khi bấm 'CHẠY THỦ CÔNG' thành công: Bulk AI Studio Pro lập tức xoá trắng ô textarea về 0 điểm sáng.
    """
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=0.0)
        if im is None:
            return False
        if is_chrome_overlay_menu_open(im):
            return False
        bright_pixels = 0
        dark_bg_pixels = 0
        for py in range(505, 680, 2):
            for px in range(50, 440, 2):
                if 0 <= px < im.width and 0 <= py < im.height:
                    r, g, b = im.getpixel((px, py))
                    if r < 40 and g < 45 and b < 65:
                        dark_bg_pixels += 1
                    elif r > 170 and g > 170 and b > 170:
                        bright_pixels += 1
        return bright_pixels >= 12 and dark_bg_pixels >= 500
    except Exception:
        return False


def check_and_dismiss_chrome_popups(im=None, holds_lock=False):
    """Tự động phát hiện và bấm Allow nếu Chrome hiện popup 'Download multiple files' ở cửa sổ trái."""
    if sys.platform == "darwin":
        return False
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=1.0)
        if im is None:
            return False
        white_pts = [(150, 150), (180, 170), (210, 190)]
        white_hits = sum(
            1 for (x, y) in white_pts
            if im.getpixel((x, y))[0] > 240 and im.getpixel((x, y))[1] > 240 and im.getpixel((x, y))[2] > 240
        )
        r_btn, g_btn, b_btn = im.getpixel((340, 224))
        if white_hits >= 3 and r_btn > 235 and g_btn > 190 and b_btn > 190:
            if not holds_lock:
                # Chỉ thao tác chuột nếu lấy được lock (không tranh chuột với tiến trình đang submit)
                with open(LOCK_FILE, "a+") as lf:
                    try:
                        fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        return False
                    try:
                        sys.stderr.write("[AutoClick] 🛡️ Phát hiện popup 'Download multiple files' của Chrome! Tự động bấm Allow (350, 224)...\n")
                        activate_chrome()
                        pyautogui.moveTo(350, 224, duration=0.2)
                        pyautogui.click(350, 224)
                        time.sleep(0.6)
                        pyautogui.click(75, 650)
                        time.sleep(0.2)
                    finally:
                        fcntl.flock(lf, fcntl.LOCK_UN)
                return True
            else:
                sys.stderr.write("[AutoClick] 🛡️ Phát hiện popup 'Download multiple files' của Chrome! Tự động bấm Allow (350, 224)...\n")
                activate_chrome()
                pyautogui.moveTo(350, 224, duration=0.2)
                pyautogui.click(350, 224)
                time.sleep(0.6)
                pyautogui.click(75, 650)
                time.sleep(0.2)
                return True
        # Nếu popup danh sách Downloads màu trắng (x=119..474, y=137..574) đang mở đè lên ô input (248, 546)
        # -> Click vào góc dưới-trái của ô textarea (75, 650) (nằm ngoài hoàn toàn popup Downloads) để đóng popup an toàn!
        if holds_lock and is_chrome_overlay_menu_open(im):
            sys.stderr.write("[AutoClick] 🛡️ Phát hiện popup danh sách Downloads đang che ô input! Click (75, 650) để đóng popup...\n")
            pyautogui.moveTo(75, 650, duration=0.12)
            pyautogui.click(75, 650)
            time.sleep(0.35)
            return True
    except Exception:
        pass
    return False


def maybe_reload_video_tab_if_bloated():
    """Nếu tiến trình renderer của veo3_002 ngốn > 1.6GB RAM VÀ hiện tại đang IDLE (không có task nào ĐANG CHẠY), tự động Ctrl+R làm mới."""
    if sys.platform == "darwin":
        return
    try:
        out = subprocess.check_output(["ps", "-eo", "rss,args"], text=True, stderr=subprocess.DEVNULL)
        max_rss_kb = 0
        for line in out.splitlines():
            if "chrome_boxes/" in line and "--type=renderer" in line:
                parts = line.strip().split(None, 1)
                if parts and parts[0].isdigit():
                    max_rss_kb = max(max_rss_kb, int(parts[0]))
        if max_rss_kb > 1600000:
            if is_flow_currently_running():
                return
            sys.stderr.write(f"[AutoClick] 🧹 Tab Video đang chiếm {max_rss_kb // 1024}MB RAM (>1600MB) lúc IDLE, tự động Ctrl+R giải phóng bộ nhớ...\n")
            activate_chrome()
            pyautogui.click(120, 240)
            time.sleep(0.2)
            pyautogui.hotkey("ctrl", "r")
            time.sleep(9.0)
    except Exception:
        pass


def wait_until_submit_button_ready(x_btn=273, y_btn=733, max_wait_sec=25):
    """
    Đợi cho tới khi nút 'CHẠY THỦ CÔNG' (màu trắng sáng) hiển thị trên màn hình.
    Hỗ trợ chạy SONG SONG 10 tác vụ: KHÔNG bắt chờ task trước tắt '• ĐANG CHẠY',
    vì Bulk AI Studio Pro cho phép nạp liên tiếp các task vào VIDEO PIPELINE khi đang chạy.
    """
    if sys.platform == "darwin":
        return True

    start_t = time.time()
    check_pts = [(180, y_btn), (x_btn, y_btn - 13), (x_btn, y_btn + 9), (350, y_btn)]
    logged_wait = False

    while (time.time() - start_t) < max_wait_sec:
        try:
            im = capture_screen_rgb(max_age_sec=0.0)
            if im is not None:
                check_and_dismiss_chrome_popups(im, holds_lock=True)
                bright = 0
                for (px, py) in check_pts:
                    if 0 <= px < im.width and 0 <= py < im.height:
                        r, g, b = im.getpixel((px, py))
                        if r > 190 and g > 190 and b > 190:
                            bright += 1
                if bright >= 2:
                    if logged_wait:
                        sys.stderr.write(f"[AutoClick] ✅ Nút CHẠY THỦ CÔNG đã READY (sau {round(time.time() - start_t, 1)}s)!\n")
                        time.sleep(0.5)
                    return True
        except Exception:
            pass

        if not logged_wait:
            sys.stderr.write("[AutoClick] ⏳ Đang chờ nút 'CHẠY THỦ CÔNG' xuất hiện...\n")
            logged_wait = True
        time.sleep(1.2)

    sys.stderr.write(f"[AutoClick] ⚠️ Đã chờ tối đa {max_wait_sec}s, tiếp tục thực hiện click...\n")
    return False


def perform_click_and_submit(full_prompt, x_input=248, y_input=546, x_btn=273, y_btn=733):
    """
    Thao tác chuột nhập prompt, xoá sạch chữ cũ (Ctrl+A -> BackSpace), dán prompt 1 lần duy nhất,
    bấm Chạy thủ công và xác nhận trạng thái • ĐANG CHẠY đã bật.
    Trả về timestamp submitted_at ngay thời điểm bấm nút chạy thành công.
    """
    mod_key = "command" if sys.platform == "darwin" else "ctrl"
    with open(LOCK_FILE, "a+") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            wait_until_submit_button_ready(x_btn, y_btn, max_wait_sec=25)
            maybe_reload_video_tab_if_bloated()
            sys.stderr.write(f"[AutoClick] Đã nhận mouse lock. Bắt đầu submit prompt vào ({x_input}, {y_input}) và bấm ({x_btn}, {y_btn})...\n")

            submitted_at = time.time()

            for attempt in range(1, 4):
                set_clipboard(full_prompt)
                activate_chrome()

                # 1. Click vào (75, 650) (góc dưới-trái bên trong ô textarea, nằm NGOÀI hoàn toàn vùng popup Downloads x=119..474, y=137..574):
                #    - Nếu popup Downloads của Chrome đang mở đè lên (248, 546), cú click (75, 650) sẽ đóng popup ngay mà KHÔNG bấm nhầm vào file video trong danh sách!
                #    - Nếu không có popup, (75, 650) vẫn nằm gọn trong ô <textarea> nên sẽ kích hoạt focus cho iframe.
                pyautogui.moveTo(75, 650, duration=0.12)
                pyautogui.click(75, 650)
                time.sleep(0.3)
                pyautogui.moveTo(x_input, y_input, duration=0.12)
                pyautogui.click(x_input, y_input)
                time.sleep(0.35)
                pyautogui.click(x_input, y_input)
                time.sleep(0.25)

                # 2. Luôn Ctrl+A + BackSpace để đảm bảo ô textarea sạch 100% trước khi dán (tránh nối chồng 2 prompt làm hỏng link --start-image)
                pyautogui.hotkey(mod_key, "a")
                time.sleep(0.15)
                pyautogui.press("backspace")
                time.sleep(0.2)

                # 3. Dán prompt từ clipboard (Ctrl + V) đúng 1 lần
                set_clipboard(full_prompt)
                time.sleep(0.25)
                pyautogui.hotkey(mod_key, "v")
                time.sleep(1.25 if len(full_prompt) > 90000 else (1.0 if len(full_prompt) > 2000 else 0.65))

                # 4. Click nút "Chạy thủ công"
                submitted_at = time.time()
                pyautogui.moveTo(x_btn, y_btn, duration=0.2)
                pyautogui.click(x_btn, y_btn)

                # 5. Chờ tối đa 5.5s (5 lần x 1.1s) để xác nhận huy hiệu • ĐANG CHẠY đã bật
                started_ok = True
                try:
                    if sys.platform != "darwin":
                        started_ok = False
                        for _sub_chk in range(5):
                            time.sleep(1.1)
                            im_sub = capture_screen_rgb(max_age_sec=0.0, save_copy_path="/tmp/last_video_submit.png")
                            if im_sub is None:
                                continue
                            check_and_dismiss_chrome_popups(im_sub, holds_lock=True)
                            if is_flow_currently_running(im_sub):
                                started_ok = True
                                break
                except Exception:
                    started_ok = True

                if started_ok:
                    sys.stderr.write(f"[AutoClick] ✅ Submit thành công (đã xác nhận • ĐANG CHẠY ở lần {attempt}). Giải phóng mouse lock.\n")
                    time.sleep(0.4)
                    break
                else:
                    if attempt < 3:
                        sys.stderr.write(f"[AutoClick] ⚠️ Chưa xác nhận được trạng thái nạp ở lần {attempt}/3, chờ 1.5s rồi thử lại...\n")
                        time.sleep(1.5)
                    else:
                        sys.stderr.write("[AutoClick] ⚠️ Đã thử submit 3 lần. Giải phóng mouse lock.\n")

            return submitted_at
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


def wait_for_file_download(downloads_dir, initial_files, submitted_at, stt="", timeout_sec=300, poll_interval=3):
    """
    Sau khi submit:
    - Chờ 25s
    - Poll thư mục Downloads tìm đúng file <stt>.mp4 mới
    - Sau 5 phút (timeout_sec tính từ lúc task này submit) báo fail
    """
    wait_initial = max(5.0, min(25.0, 25.0 - (time.time() - submitted_at)))
    sys.stderr.write(f"[AutoClick] Chờ {round(wait_initial, 1)} giây trước khi bắt đầu quét file Downloads...\n")
    time.sleep(wait_initial)

    clean_stt = str(stt).strip()
    sys.stderr.write(f"[AutoClick] Bắt đầu quét file Downloads (STT: {clean_stt}, timeout: {timeout_sec}s)...\n")

    poll_count = 0
    not_running_streak = 0
    while (time.time() - submitted_at) < timeout_sec:
        current_time = time.time()
        elapsed = round(current_time - submitted_at, 1)
        poll_count += 1

        try:
            candidates = []
            for f in os.listdir(downloads_dir):
                if not f.endswith(".mp4"):
                    continue
                if f.endswith(".crdownload") or f.endswith(".tmp"):
                    continue

                full_path = os.path.join(downloads_dir, f)
                try:
                    st = os.stat(full_path)
                    if st.st_mtime >= (submitted_at - 15) and st.st_size > 0:
                        candidates.append({
                            "name": f,
                            "path": full_path,
                            "mtime": st.st_mtime,
                            "size": st.st_size
                        })
                except OSError:
                    continue

            matched_file = None

            # BẮT BUỘC khớp đúng mã STT của task (ví dụ 6458.mp4, 6458 (1).mp4) để tuyệt đối không lấy nhầm video của task khác
            if clean_stt:
                for c in candidates:
                    base_name = os.path.splitext(c["name"])[0].strip()
                    if (
                        base_name == clean_stt
                        or base_name.startswith(f"{clean_stt} ")
                        or base_name.startswith(f"{clean_stt}(")
                        or base_name.startswith(f"{clean_stt}_")
                        or base_name.startswith(f"{clean_stt}-")
                        or base_name.startswith(f"{clean_stt}.")
                    ):
                        matched_file = c
                        break
            else:
                new_files = [c for c in candidates if c["name"] not in initial_files]
                if new_files:
                    new_files.sort(key=lambda x: x["mtime"], reverse=True)
                    matched_file = new_files[0]

            if matched_file:
                p = matched_file["path"]
                sz1 = matched_file["size"]
                time.sleep(1.0)
                try:
                    sz2 = os.path.getsize(p)
                    if sz2 == sz1 and sz2 > 1024:
                        sys.stderr.write(f"[AutoClick] 🎉 Đã tìm thấy file hoàn chỉnh: {p} ({sz2 / 1024 / 1024:.2f} MB, sau {elapsed}s)\n")
                        return matched_file
                except OSError:
                    pass

            # Kiểm tra popup chặn tải file và kiểm tra nếu toàn bộ Flow đã tắt • ĐANG CHẠY liên tiếp 6 lần (18s)
            has_downloading = any(f.endswith(".crdownload") or f.endswith(".tmp") for f in os.listdir(downloads_dir))
            if not has_downloading and elapsed >= 40:
                im_poll = capture_screen_rgb(max_age_sec=1.5)
                if check_and_dismiss_chrome_popups(im_poll, holds_lock=False):
                    not_running_streak = 0
                    time.sleep(2.0)
                    continue
                if im_poll is not None and not is_flow_currently_running(im_poll):
                    not_running_streak += 1
                    sys.stderr.write(f"[AutoClick] ⚠️ Huy hiệu • ĐANG CHẠY đã tắt ({not_running_streak}/6) tại {elapsed}s mà chưa thấy file {clean_stt}.mp4...\n")
                    if not_running_streak >= 6:
                        sys.stderr.write(f"[AutoClick] ❌ FLOW_TASK_ERROR: Google Flow đã dừng chạy (báo LỖI trên Flow) sau {elapsed}s mà không xuất file video.\n")
                        return {
                            "error_fast_fail": f"FLOW_TASK_ERROR: Google Flow từ chối tạo video này (ảnh hoặc nội dung câu lệnh có thể vi phạm chính sách an toàn của Google Veo) sau {elapsed}s."
                        }
                else:
                    not_running_streak = 0

        except Exception as e:
            sys.stderr.write(f"[AutoClick] Lỗi khi quét thư mục: {e}\n")

        time.sleep(poll_interval)

    return None


def main():
    parser = argparse.ArgumentParser(description="AutoClick Video Runner for Google Flow")
    parser.add_argument("--prompt", required=True, help="Nội dung prompt")
    parser.add_argument("--stt", default="", help="Mã số thứ tự (ví dụ: 001)")
    parser.add_argument("--ratio", default="9:16", help="Tỉ lệ (9:16 hoặc 16:9)")
    parser.add_argument("--start-image", default=None, help="URL ảnh đầu vào")
    parser.add_argument("--end-image", default=None, help="URL ảnh kết thúc")
    parser.add_argument("--timeout", type=int, default=300, help="Thời gian timeout (giây), mặc định 300s = 5p")
    parser.add_argument("--downloads-dir", default=os.path.expanduser("~/Downloads"), help="Thư mục Downloads")
    parser.add_argument("--x-input", type=int, default=439, help="Tọa độ X ô nhập")
    parser.add_argument("--y-input", type=int, default=578, help="Tọa độ Y ô nhập")
    parser.add_argument("--x-btn", type=int, default=440, help="Tọa độ X nút chạy")
    parser.add_argument("--y-btn", type=int, default=729, help="Tọa độ Y nút chạy")
    args = parser.parse_args()

    downloads_dir = os.path.abspath(os.path.expanduser(args.downloads_dir))
    if not os.path.exists(downloads_dir):
        os.makedirs(downloads_dir, exist_ok=True)

    preset_coords = load_preset_coords()
    x_in = args.x_input
    y_in = args.y_input
    x_btn = args.x_btn
    y_btn = args.y_btn
    if preset_coords:
        px_in, py_in, px_btn, py_btn = preset_coords
        if args.x_input == 439 and args.y_input == 578:
            x_in, y_in = px_in, py_in
        if args.x_btn == 440 and args.y_btn == 729:
            x_btn, y_btn = px_btn, py_btn
        sys.stderr.write(f"[AutoClick] Đã áp dụng tọa độ từ preset video_.json: Input=({x_in}, {y_in}), Submit=({x_btn}, {y_btn})\n")

    # 1. Snapshot danh sách file hiện có
    initial_files = get_downloads_files(downloads_dir)

    # 2. Format prompt chuẩn
    full_prompt = format_prompt(
        raw_prompt=args.prompt,
        stt=args.stt,
        ratio=args.ratio,
        start_img=args.start_image,
        end_img=args.end_image
    )

    # 3. Submit bằng Auto Click (trả về mốc thời gian thực sự bấm nút Chạy)
    submitted_at = perform_click_and_submit(
        full_prompt=full_prompt,
        x_input=x_in,
        y_input=y_in,
        x_btn=x_btn,
        y_btn=y_btn
    )

    # 4. Poll trong máy tính tối đa 5 phút tính từ lúc task này đã bấm nút Chạy
    matched = wait_for_file_download(
        downloads_dir=downloads_dir,
        initial_files=initial_files,
        submitted_at=submitted_at,
        stt=args.stt,
        timeout_sec=args.timeout,
        poll_interval=3
    )

    if matched and matched.get("error_fast_fail"):
        result = {
            "status": "error",
            "error": matched["error_fast_fail"],
            "submitted_at": submitted_at,
            "elapsed": round(time.time() - submitted_at, 1)
        }
        print(json.dumps(result, ensure_ascii=False))
        sys.stdout.flush()
        sys.exit(2)
    elif matched:
        result = {
            "status": "success",
            "file_path": matched["path"],
            "filename": matched["name"],
            "size": matched["size"],
            "submitted_at": submitted_at,
            "elapsed": round(time.time() - submitted_at, 1)
        }
        print(json.dumps(result, ensure_ascii=False))
        sys.stdout.flush()
        sys.exit(0)
    else:
        result = {
            "status": "error",
            "error": f"Timeout {args.timeout}s (5 phút) kể từ lúc submit mà không thấy file video tải về máy tính.",
            "submitted_at": submitted_at,
            "elapsed": round(time.time() - submitted_at, 1)
        }
        print(json.dumps(result, ensure_ascii=False))
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
