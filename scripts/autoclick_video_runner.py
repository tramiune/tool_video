#!/usr/bin/env python3
"""
autoclick_video_runner.py
=========================
Cơ chế tự động tạo Video & Ảnh qua Auto Click trên 2 nửa màn hình (1600x900):
- Nửa Trái (Video - mode=video): Cửa sổ (0, 27, 800x873)
  + Ô nhập (textarea): x=37..761, y=494..683 -> tâm (399, 588), góc an toàn (75, 650)
  + Nút "CHẠY THỦ CÔNG": x=36..762, y=704..755 -> tâm (399, 729)
  + Huy hiệu "• ĐANG CHẠY": x=640..775, y=188..255
- Nửa Phải (Ảnh - mode=image): Cửa sổ (800, 27, 800x873)
  + Ô nhập (textarea): x=882..1108, y=420..570 -> tâm (995, 495), góc an toàn (900, 555)
  + Nút "CHẠY THỦ CÔNG": x=881..1109, y=588..628 -> tâm (995, 608)
  + Huy hiệu "• ĐANG CHẠY": x=1000..1120, y=188..235
  + Tự động đóng modal "Studio Ảnh Thông Minh" tại (1200, 750) nếu xuất hiện
- Dùng chung khóa chuột (/tmp/autoclick_video.lock) chỉ trong ~3.5s thao tác click & paste
  để Video (trái) và Ảnh (phải) không bao giờ tranh chuột của nhau, sau đó nhả khóa ngay
  để poll thư mục ~/Downloads song song (10 tác vụ Video + 10 tác vụ Ảnh cùng lúc).
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

# Tọa độ chuẩn cho Nửa Màn Hình Trái (Video: 0..800 x 873)
VIDEO_COORDS = {
    "win_x": 0,
    "win_y": 27,
    "win_w": 800,
    "win_h": 873,
    "x_safe": 75,
    "y_safe": 650,
    "x_input": 399,
    "y_input": 588,
    "x_btn": 399,
    "y_btn": 729,
    "btn_check_pts": [(180, 729), (260, 729), (540, 729), (620, 729)],
    "running_boxes": [(640, 188, 775, 255), (385, 188, 475, 255)],
    "overlay_box": (400, 145, 765, 575),
    "allow_btns": [(642, 224), (350, 224)],
    "reload_click": (120, 240),
}

# Tọa độ chuẩn cho Nửa Màn Hình Phải (Image: 800..1600 x 873)
IMAGE_COORDS = {
    "win_x": 800,
    "win_y": 27,
    "win_w": 800,
    "win_h": 873,
    # Bố cục 2 cột của V1.0_MEO3_IMAGE_269 ở chiều rộng 800px:
    "x_safe": 900,
    "y_safe": 555,
    "x_input": 995,
    "y_input": 495,
    "x_btn": 995,
    "y_btn": 608,
    "btn_check_pts": [(900, 608), (920, 608), (1070, 608), (1090, 608)],
    # Dự phòng nếu cửa sổ phải hiển thị bố cục 1 cột giống bên trái (+800px):
    "alt_1col": {
        "x_safe": 875,
        "y_safe": 650,
        "x_input": 1199,
        "y_input": 588,
        "x_btn": 1199,
        "y_btn": 729,
        "btn_check_pts": [(980, 729), (1060, 729), (1340, 729), (1420, 729)],
    },
    "running_boxes": [(1000, 188, 1120, 238)],
    "overlay_box": (1200, 145, 1565, 575),
    "allow_btns": [(1442, 224), (1150, 224)],
    "reload_click": (920, 240),
    "welcome_modal_btn": (1200, 750),
}

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
VIDEO_EXTENSIONS = (".mp4",)


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


def get_downloads_files(downloads_dir, mode="video"):
    """Lấy danh sách các file hiện có trong Downloads kèm mtime và size."""
    files_map = {}
    if not os.path.exists(downloads_dir):
        return files_map
    exts = IMAGE_EXTENSIONS if mode == "image" else VIDEO_EXTENSIONS
    try:
        for f in os.listdir(downloads_dir):
            fl = f.lower()
            if any(fl.endswith(ext) for ext in exts) and not fl.endswith(".crdownload") and not fl.endswith(".tmp"):
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
    Tối ưu giữ độ nét cao (1024px, LANCZOS + UnsharpMask, JPEG 4:4:4 subsampling=0, progressive)
    và bỏ qua nén lại lần 2 nếu ảnh đầu vào đã nhỏ gọn sẵn.
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
        from PIL import Image, ImageFilter, ImageOps

        raw_bytes = None
        if s.startswith("http://") or s.startswith("https://"):
            req = urllib.request.Request(s, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw_bytes = resp.read()
        elif os.path.exists(s):
            with open(s, "rb") as f:
                raw_bytes = f.read()

        if raw_bytes:
            orig_im = Image.open(io.BytesIO(raw_bytes))
            orig_fmt = (orig_im.format or "").upper()
            im = ImageOps.exif_transpose(orig_im)

            # 1) Chống nén chồng 2 lần (Double Compression):
            # Nếu ảnh gốc đã là JPEG chuẩn (không bị xoay EXIF), kích thước <= 1280px và dung lượng <= 135 KB (~180 KB Base64),
            # giữ nguyên 100% byte gốc chuyển thẳng sang Base64 để không làm giảm chất lượng!
            max_dim = 1024
            if (
                orig_fmt == "JPEG"
                and im.size == orig_im.size
                and max(im.width, im.height) <= 1280
                and len(raw_bytes) <= 135 * 1024
            ):
                b64 = base64.b64encode(raw_bytes).decode("ascii")
                sys.stderr.write(
                    f"[AutoClick] 🖼️ Giữ nguyên ảnh JPEG gốc không nén lại ({len(b64) // 1024} KB base64, {im.width}x{im.height}).\n"
                )
                return f"data:image/jpeg;base64,{b64}"

            im = im.convert("RGB")
            # 2) Giữ độ phân giải 1024px + bù độ sắc nét viền (UnsharpMask) sau khi thu nhỏ bằng LANCZOS
            if max(im.width, im.height) > max_dim:
                resample = getattr(Image, "Resampling", Image).LANCZOS
                scale = max_dim / float(max(im.width, im.height))
                im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), resample)
                im = im.filter(ImageFilter.UnsharpMask(radius=1.0, percent=55, threshold=3))

            # 3) Nén JPEG chất lượng cao (4:4:4 subsampling=0 giữ 100% chi tiết màu sắc + progressive Huffman)
            # Ngưỡng Base64 an toàn cho <textarea> Bulk & Firestore: ~180 KB (180,000 ký tự)
            max_b64_len = 180000
            b64 = None
            for q, sub in ((88, 0), (84, 0), (80, 1), (75, 2)):
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=q, subsampling=sub, progressive=True, optimize=True)
                b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                if len(b64) <= max_b64_len:
                    break

            sys.stderr.write(
                f"[AutoClick] 🖼️ Đã nén giữ nét sang data:image/jpeg ({len(b64) // 1024} KB base64, {im.width}x{im.height}) vượt CSP Flow.\n"
            )
            return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        sys.stderr.write(f"[AutoClick] ⚠️ Lỗi chuyển ảnh sang data URI ({e}), giữ nguyên link gốc...\n")
    return s


def format_prompt(raw_prompt, stt, ratio, start_img=None, end_img=None, ref_images=None, mode="video"):
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

    ratio_str = str(ratio or "9:16").strip().lower()
    if mode == "image":
        if "16:9" in ratio_str or "wide" in ratio_str or "landscape" in ratio_str:
            ratio = "16:9"
        elif "1:1" in ratio_str or "square" in ratio_str:
            ratio = "1:1"
        else:
            ratio = "9:16"
    else:
        # Video SDK hỗ trợ 16:9 và 9:16
        ratio = "16:9" if ("16:9" in ratio_str or "wide" in ratio_str or "landscape" in ratio_str) else "9:16"

    # Luôn gắn chính xác mã STT của task vào đầu prompt để file tải về luôn mang tên <stt>.mp4 / <stt>.jpg
    clean_stt = str(stt).strip()
    default_fallback = "High quality detailed photograph" if mode == "image" else "Cinematic movement, high quality"
    if clean_stt:
        prompt = re.sub(r"^\d{1,6}[\.\-_:\s]+", "", prompt).strip()
        if not prompt or prompt in (".", "-", "_"):
            prompt = default_fallback
        prompt = f"{clean_stt}. {prompt}"
    elif not prompt:
        prompt = default_fallback

    full_line = f"{ratio}|{prompt}"

    # Tập hợp danh sách ảnh đầu vào (start_img, end_img, ref_images)
    all_imgs = []
    if start_img:
        all_imgs.append(start_img)
    if end_img:
        all_imgs.append(end_img)
    if ref_images:
        for r_img in ref_images:
            if r_img and r_img not in all_imgs:
                all_imgs.append(r_img)

    for img_item in all_imgs:
        uri = image_to_data_uri(img_item)
        if uri and uri not in full_line:
            full_line += f"|{uri}"

    return full_line


def activate_chrome(mode="video"):
    """
    Kích hoạt cửa sổ Google Chrome tương ứng và tự động căn chỉnh về đúng nửa màn hình:
    - mode == 'video': Nửa trái (0, 27, 800x873) (x < 400)
    - mode == 'image': Nửa phải (800, 27, 800x873) (x >= 400)
    """
    cfg = IMAGE_COORDS if mode == "image" else VIDEO_COORDS
    tx, ty, tw, th = cfg["win_x"], cfg["win_y"], cfg["win_w"], cfg["win_h"]
    label = "Ảnh (Phải)" if mode == "image" else "Video (Trái)"

    try:
        if sys.platform == "darwin":
            subprocess.run(["osascript", "-e", 'tell application "Google Chrome" to activate'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            out = subprocess.check_output(["wmctrl", "-lG"], text=True, stderr=subprocess.DEVNULL)
            target_wid = None
            cur_geom = None
            for line in out.splitlines():
                if "google chrome" in line.lower():
                    parts = line.split()
                    if len(parts) >= 6:
                        try:
                            x_pos, y_pos, w_sz, h_sz = int(parts[2]), int(parts[3]), int(parts[4]), int(parts[5])
                            if mode == "image" and x_pos >= 400:
                                target_wid = parts[0]
                                cur_geom = (x_pos, y_pos, w_sz, h_sz)
                                break
                            elif mode != "image" and x_pos < 400:
                                target_wid = parts[0]
                                cur_geom = (x_pos, y_pos, w_sz, h_sz)
                                break
                        except ValueError:
                            pass
            if target_wid:
                if cur_geom:
                    cx, cy, cw, ch = cur_geom
                    if abs(cx - tx) > 12 or abs(cy - ty) > 30 or abs(cw - tw) > 15 or abs(ch - th) > 25:
                        sys.stderr.write(f"[AutoClick] 🔧 Phát hiện cửa sổ {label} bị lệch ({cx},{cy} {cw}x{ch}), tự động đưa về nửa màn hình chuẩn ({tx},{ty} {tw}x{th})...\n")
                        subprocess.run(["wmctrl", "-ir", target_wid, "-b", "remove,maximized_vert,maximized_horz"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        subprocess.run(["wmctrl", "-ir", target_wid, "-e", f"0,{tx},{ty},{tw},{th}"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        time.sleep(0.3)
                subprocess.run(["xdotool", "windowactivate", target_wid], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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


def is_flow_currently_running(im=None, mode="video"):
    """Quét vùng góc trên bên phải khung CẤU HÌNH STUDIO tìm huy hiệu '• ĐANG CHẠY' màu xanh tím."""
    cfg = IMAGE_COORDS if mode == "image" else VIDEO_COORDS
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=0.0)
        if im is None:
            return False
        # Nếu vùng nền an toàn (x_safe, y_safe) bị bôi xanh (do Ctrl+A ngoài trang preview), không phải huy hiệu ĐANG CHẠY
        xs, ys = cfg["x_safe"], cfg["y_safe"]
        if 0 <= xs < im.width and 0 <= ys < im.height:
            rs, gs, bs = im.getpixel((xs, ys))
            if bs >= 110 and (bs - rs) >= 40:
                return False
        for (x1, y1, x2, y2) in cfg["running_boxes"]:
            blue_hits = 0
            for py in range(y1, y2 + 1, 2):
                for px in range(x1, x2 + 1, 3):
                    if 0 <= px < im.width and 0 <= py < im.height:
                        r, g, b = im.getpixel((px, py))
                        if b >= 52 and (b - r) >= 24:
                            blue_hits += 1
                            if blue_hits >= 15:
                                return True
        return False
    except Exception:
        return False


def is_chrome_overlay_menu_open(im=None, mode="video"):
    """Phát hiện xem popup danh sách Downloads màu trắng của Chrome có đang mở đè lên cửa sổ hay không."""
    cfg = IMAGE_COORDS if mode == "image" else VIDEO_COORDS
    ox1, oy1, ox2, oy2 = cfg["overlay_box"]
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=0.0)
        if im is None:
            return False
        white_count = 0
        for py in range(oy1, oy2, 15):
            for px in range(ox1, ox2, 20):
                if 0 <= px < im.width and 0 <= py < im.height:
                    r, g, b = im.getpixel((px, py))
                    if r > 235 and g > 235 and b > 235:
                        white_count += 1
                        if white_count >= 18:
                            return True
        return False
    except Exception:
        return False


def check_and_dismiss_welcome_modal(im=None, mode="image"):
    """
    Tự động phát hiện và tắt hộp thoại chào mừng 'Studio Ảnh Thông Minh' (nút tím 'Bắt đầu trải nghiệm ngay' tại 1200, 750)
    nếu cửa sổ Tạo Ảnh vừa mới mở hoặc vừa reload.
    """
    if sys.platform == "darwin" or mode != "image":
        return False
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=0.5)
        if im is None:
            return False
        # Kiểm tra màu tím đặc trưng RGB(79, 57, 246) tại (1160, 350) và tại nút bấm (1200, 750)
        r1, g1, b1 = im.getpixel((1160, 350))
        r2, g2, b2 = im.getpixel((1200, 750))
        if b1 > 190 and r1 < 120 and b2 > 190 and r2 < 120:
            bx, by = IMAGE_COORDS["welcome_modal_btn"]
            sys.stderr.write(f"[AutoClick] 🛡️ Phát hiện hộp thoại chào mừng 'Studio Ảnh Thông Minh', tự động bấm 'Bắt đầu trải nghiệm ngay' ({bx}, {by})...\n")
            activate_chrome(mode="image")
            pyautogui.moveTo(bx, by, duration=0.15)
            pyautogui.click(bx, by)
            time.sleep(1.0)
            return True
    except Exception:
        pass
    return False


def check_and_dismiss_chrome_popups(im=None, holds_lock=False, mode="video"):
    """Tự động phát hiện và bấm Allow nếu Chrome hiện popup 'Download multiple files' hoặc đóng popup Downloads."""
    if sys.platform == "darwin":
        return False
    cfg = IMAGE_COORDS if mode == "image" else VIDEO_COORDS
    x_safe, y_safe = cfg["x_safe"], cfg["y_safe"]
    try:
        if im is None:
            im = capture_screen_rgb(max_age_sec=1.0)
        if im is None:
            return False

        if holds_lock and mode == "image":
            check_and_dismiss_welcome_modal(im, mode="image")

        for (bx, by) in cfg["allow_btns"]:
            # Kiểm tra vùng nền trắng của hộp thoại phía trên-trái nút Allow
            white_pts = [(bx - 180, by - 70), (bx - 150, by - 50), (bx - 120, by - 30)]
            white_hits = sum(
                1 for (x, y) in white_pts
                if 0 <= x < im.width and 0 <= y < im.height
                and im.getpixel((x, y))[0] > 240 and im.getpixel((x, y))[1] > 240 and im.getpixel((x, y))[2] > 240
            )
            if 0 <= bx - 10 < im.width and 0 <= by < im.height:
                r_btn, g_btn, b_btn = im.getpixel((bx - 10, by))
                if white_hits >= 3 and r_btn > 235 and g_btn > 190 and b_btn > 190:
                    if not holds_lock:
                        with open(LOCK_FILE, "a+") as lf:
                            try:
                                fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            except BlockingIOError:
                                return False
                            try:
                                sys.stderr.write(f"[AutoClick] 🛡️ Phát hiện popup 'Download multiple files' ({mode})! Tự động bấm Allow ({bx}, {by})...\n")
                                activate_chrome(mode=mode)
                                pyautogui.moveTo(bx, by, duration=0.2)
                                pyautogui.click(bx, by)
                                time.sleep(0.6)
                                pyautogui.click(x_safe, y_safe)
                                time.sleep(0.2)
                            finally:
                                fcntl.flock(lf, fcntl.LOCK_UN)
                        return True
                    else:
                        sys.stderr.write(f"[AutoClick] 🛡️ Phát hiện popup 'Download multiple files' ({mode})! Tự động bấm Allow ({bx}, {by})...\n")
                        activate_chrome(mode=mode)
                        pyautogui.moveTo(bx, by, duration=0.2)
                        pyautogui.click(bx, by)
                        time.sleep(0.6)
                        pyautogui.click(x_safe, y_safe)
                        time.sleep(0.2)
                        return True

        if holds_lock and is_chrome_overlay_menu_open(im, mode=mode):
            sys.stderr.write(f"[AutoClick] 🛡️ Phát hiện popup danh sách Downloads đang che ô input ({mode})! Click ({x_safe}, {y_safe}) để đóng popup...\n")
            pyautogui.moveTo(x_safe, y_safe, duration=0.12)
            pyautogui.click(x_safe, y_safe)
            time.sleep(0.35)
            return True
    except Exception:
        pass
    return False


def maybe_reload_tab_if_bloated(mode="video"):
    """Nếu tiến trình renderer ngốn > 1.6GB RAM VÀ hiện tại đang IDLE (không có task nào ĐANG CHẠY), tự động Ctrl+R làm mới."""
    if sys.platform == "darwin":
        return
    cfg = IMAGE_COORDS if mode == "image" else VIDEO_COORDS
    try:
        out = subprocess.check_output(["ps", "-eo", "rss,args"], text=True, stderr=subprocess.DEVNULL)
        max_rss_kb = 0
        for line in out.splitlines():
            if "--type=renderer" not in line:
                continue
            if mode == "video" and "chrome_boxes/" in line:
                parts = line.strip().split(None, 1)
                if parts and parts[0].isdigit():
                    max_rss_kb = max(max_rss_kb, int(parts[0]))
            elif mode == "image" and "chrome_boxes/" not in line and "/opt/google/chrome/chrome" in line:
                parts = line.strip().split(None, 1)
                if parts and parts[0].isdigit():
                    max_rss_kb = max(max_rss_kb, int(parts[0]))
        if max_rss_kb > 1600000:
            if is_flow_currently_running(mode=mode):
                return
            rx, ry = cfg["reload_click"]
            sys.stderr.write(f"[AutoClick] 🧹 Tab {mode} đang chiếm {max_rss_kb // 1024}MB RAM (>1600MB) lúc IDLE, tự động Ctrl+R giải phóng bộ nhớ...\n")
            activate_chrome(mode=mode)
            pyautogui.click(rx, ry)
            time.sleep(0.2)
            pyautogui.hotkey("ctrl", "r")
            time.sleep(8.5)
            if mode == "image":
                im_after = capture_screen_rgb(max_age_sec=0.0)
                check_and_dismiss_welcome_modal(im_after, mode="image")
    except Exception:
        pass


def resolve_active_coords(mode="video", im=None):
    """
    Trả về bộ tọa độ (x_safe, y_safe, x_input, y_input, x_btn, y_btn, btn_check_pts)
    cho mode='video' (nửa trái) hoặc mode='image' (nửa phải, tự nhận diện bố cục 2 cột hoặc 1 cột).
    """
    if mode != "image":
        c = VIDEO_COORDS
        return c["x_safe"], c["y_safe"], c["x_input"], c["y_input"], c["x_btn"], c["y_btn"], c["btn_check_pts"]

    c = IMAGE_COORDS
    if im is not None:
        try:
            # Kiểm tra xem nút CHẠY THỦ CÔNG ở bố cục 2 cột (y=608) hay bố cục 1 cột (y=729) đang sáng
            pts_2col = c["btn_check_pts"]
            bright_2col = sum(
                1 for (px, py) in pts_2col
                if 0 <= px < im.width and 0 <= py < im.height and all(v > 190 for v in im.getpixel((px, py)))
            )
            if bright_2col >= 2:
                return c["x_safe"], c["y_safe"], c["x_input"], c["y_input"], c["x_btn"], c["y_btn"], c["btn_check_pts"]

            alt = c["alt_1col"]
            pts_1col = alt["btn_check_pts"]
            bright_1col = sum(
                1 for (px, py) in pts_1col
                if 0 <= px < im.width and 0 <= py < im.height and all(v > 190 for v in im.getpixel((px, py)))
            )
            if bright_1col >= 2:
                return alt["x_safe"], alt["y_safe"], alt["x_input"], alt["y_input"], alt["x_btn"], alt["y_btn"], alt["btn_check_pts"]
        except Exception:
            pass

    return c["x_safe"], c["y_safe"], c["x_input"], c["y_input"], c["x_btn"], c["y_btn"], c["btn_check_pts"]


def _get_expected_flow_tool_url(mode="video"):
    """Lấy URL chuẩn của công cụ VEO3_BULK từ chrome_profiles.json để tự khôi phục nếu tab bị lệch trang."""
    try:
        prof_path = "/home/vpsuser/tool_video/veo3-api-server/chrome_profiles.json"
        if os.path.exists(prof_path):
            with open(prof_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            profiles = data.get("profiles") or []
            if mode == "video":
                for p in profiles:
                    if p.get("isActiveVideo") and p.get("flowUrl") and "/tool/" in p.get("flowUrl", ""):
                        return p["flowUrl"].strip()
                for p in profiles:
                    if p.get("role") == "video" and p.get("flowUrl") and "/tool/" in p.get("flowUrl", ""):
                        return p["flowUrl"].strip()
            else:
                for p in profiles:
                    if p.get("isActiveImage") and p.get("flowUrl") and "/tool/" in p.get("flowUrl", ""):
                        return p["flowUrl"].strip()
                for p in profiles:
                    if p.get("role") == "image" and p.get("flowUrl") and "/tool/" in p.get("flowUrl", ""):
                        return p["flowUrl"].strip()
    except Exception:
        pass
    if mode == "image":
        return "https://flow.google.com/project/479ede26-9ee3-445d-aac7-aefe81b136ce/tool/42295196-bb3c-489d-9b8f-7c498fa782e4"
    return "https://flow.google.com/project/669b4b38-58c7-4e44-9d45-f75a2e8c7703/tool/0b32ee5f-3fde-4235-b517-05c3709f1304"


def wait_until_submit_button_ready(mode="video", max_wait_sec=25):
    """
    Đợi cho tới khi nút 'CHẠY THỦ CÔNG' (màu trắng sáng) hiển thị trên màn hình.
    Hỗ trợ chạy SONG SONG 10 tác vụ: KHÔNG bắt chờ task trước tắt '• ĐANG CHẠY'.
    Nếu sau 12s vẫn không thấy nút (ví dụ cửa sổ bị nhảy sang trang xem trước video),
    tự động điều hướng thanh địa chỉ về lại đúng URL công cụ Flow.
    """
    if sys.platform == "darwin":
        return resolve_active_coords(mode=mode, im=None)

    start_t = time.time()
    logged_wait = False
    tried_restore_url = False

    while (time.time() - start_t) < max_wait_sec:
        try:
            im = capture_screen_rgb(max_age_sec=0.0)
            if im is not None:
                check_and_dismiss_chrome_popups(im, holds_lock=True, mode=mode)
                if mode == "image" and check_and_dismiss_welcome_modal(im, mode="image"):
                    im = capture_screen_rgb(max_age_sec=0.0)

                x_safe, y_safe, x_in, y_in, x_btn, y_btn, check_pts = resolve_active_coords(mode=mode, im=im)
                bright = 0
                for (px, py) in check_pts:
                    if 0 <= px < im.width and 0 <= py < im.height:
                        r, g, b = im.getpixel((px, py))
                        if r > 190 and g > 190 and b > 190:
                            bright += 1
                if bright >= 2:
                    if logged_wait:
                        sys.stderr.write(f"[AutoClick] ✅ Nút CHẠY THỦ CÔNG ({mode}) đã READY tại ({x_btn}, {y_btn}) (sau {round(time.time() - start_t, 1)}s)!\n")
                        time.sleep(0.4)
                    return x_safe, y_safe, x_in, y_in, x_btn, y_btn, check_pts
        except Exception:
            pass

        elapsed_wait = time.time() - start_t
        if not tried_restore_url and elapsed_wait >= 10.0:
            tried_restore_url = True
            target_url = _get_expected_flow_tool_url(mode=mode)
            addr_x = 1050 if mode == "image" else 250
            addr_y = 98
            sys.stderr.write(f"[AutoClick] 🔄 Không thấy nút CHẠY THỦ CÔNG ({mode}) sau {round(elapsed_wait, 1)}s, tự động điều hướng lại về công cụ Flow: {target_url}\n")
            try:
                activate_chrome(mode=mode)
                set_clipboard(target_url)
                pyautogui.click(addr_x, addr_y)
                time.sleep(0.25)
                pyautogui.hotkey("ctrl", "a")
                time.sleep(0.15)
                pyautogui.hotkey("ctrl", "v")
                time.sleep(0.25)
                pyautogui.press("enter")
                time.sleep(6.0)
                if mode == "image":
                    im_after = capture_screen_rgb(max_age_sec=0.0)
                    check_and_dismiss_welcome_modal(im_after, mode="image")
            except Exception as nav_err:
                sys.stderr.write(f"[AutoClick] Lỗi khi tự điều hướng lại URL ({mode}): {nav_err}\n")
            continue

        if not logged_wait:
            sys.stderr.write(f"[AutoClick] ⏳ Đang chờ nút 'CHẠY THỦ CÔNG' ({mode}) xuất hiện...\n")
            logged_wait = True
        time.sleep(1.2)

    sys.stderr.write(f"[AutoClick] ⚠️ Đã chờ tối đa {max_wait_sec}s ({mode}), tiếp tục thực hiện click...\n")
    return resolve_active_coords(mode=mode, im=None)


def perform_click_and_submit(full_prompt, mode="video"):
    """
    Thao tác chuột nhập prompt, xoá sạch chữ cũ (Ctrl+A -> BackSpace), dán prompt 1 lần duy nhất,
    bấm Chạy thủ công và xác nhận trạng thái • ĐANG CHẠY đã bật.
    Trả về timestamp submitted_at ngay thời điểm bấm nút chạy thành công.
    """
    mod_key = "command" if sys.platform == "darwin" else "ctrl"
    with open(LOCK_FILE, "a+") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            activate_chrome(mode=mode)
            x_safe, y_safe, x_input, y_input, x_btn, y_btn, _ = wait_until_submit_button_ready(mode=mode, max_wait_sec=25)
            maybe_reload_tab_if_bloated(mode=mode)
            sys.stderr.write(f"[AutoClick] Đã nhận mouse lock ({mode}). Bắt đầu submit prompt vào ({x_input}, {y_input}) và bấm ({x_btn}, {y_btn})...\n")

            submitted_at = time.time()

            for attempt in range(1, 4):
                set_clipboard(full_prompt)
                activate_chrome(mode=mode)

                # 1. Click vào góc an toàn bên trong ô textarea (nằm ngoài popup Downloads) để lấy focus cho iframe & đóng popup nếu có
                pyautogui.moveTo(x_safe, y_safe, duration=0.12)
                pyautogui.click(x_safe, y_safe)
                time.sleep(0.25)
                pyautogui.moveTo(x_input, y_input, duration=0.12)
                pyautogui.click(x_input, y_input)
                time.sleep(0.3)
                pyautogui.click(x_input, y_input)
                time.sleep(0.2)

                # 2. Luôn Ctrl+A + BackSpace để đảm bảo ô textarea sạch 100% trước khi dán
                pyautogui.hotkey(mod_key, "a")
                time.sleep(0.15)
                pyautogui.press("backspace")
                time.sleep(0.2)

                # 3. Dán prompt từ clipboard (Ctrl + V) đúng 1 lần
                set_clipboard(full_prompt)
                time.sleep(0.2)
                pyautogui.hotkey(mod_key, "v")
                time.sleep(1.25 if len(full_prompt) > 90000 else (1.0 if len(full_prompt) > 2000 else 0.65))

                # 4. Di chuyển chuột tự nhiên qua vùng iframe rồi click nút "Chạy thủ công" (tăng điểm reCAPTCHA Enterprise)
                if mode == "image":
                    pyautogui.moveTo(x_input - 35, y_input - 20, duration=0.18)
                    pyautogui.moveTo(x_input + 30, y_input + 15, duration=0.18)
                submitted_at = time.time()
                pyautogui.moveTo(x_btn, y_btn, duration=0.22)
                pyautogui.click(x_btn, y_btn)

                # 5. Chờ tối đa 5.5s (5 lần x 1.1s) để xác nhận huy hiệu • ĐANG CHẠY đã bật
                started_ok = True
                save_snap = "/tmp/last_image_submit.png" if mode == "image" else "/tmp/last_video_submit.png"
                try:
                    if sys.platform != "darwin":
                        started_ok = False
                        for _sub_chk in range(5):
                            time.sleep(1.1)
                            im_sub = capture_screen_rgb(max_age_sec=0.0, save_copy_path=save_snap)
                            if im_sub is None:
                                continue
                            check_and_dismiss_chrome_popups(im_sub, holds_lock=True, mode=mode)
                            if is_flow_currently_running(im_sub, mode=mode):
                                started_ok = True
                                break
                except Exception:
                    started_ok = True

                if started_ok:
                    sys.stderr.write(f"[AutoClick] ✅ Submit ({mode}) thành công (đã xác nhận • ĐANG CHẠY ở lần {attempt}). Giải phóng mouse lock.\n")
                    time.sleep(0.35)
                    break
                else:
                    if attempt < 3:
                        sys.stderr.write(f"[AutoClick] ⚠️ Chưa xác nhận được trạng thái nạp ({mode}) ở lần {attempt}/3, chờ 1.5s rồi thử lại...\n")
                        time.sleep(1.5)
                    else:
                        sys.stderr.write(f"[AutoClick] ⚠️ Đã thử submit ({mode}) 3 lần. Giải phóng mouse lock.\n")

            return submitted_at
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


def _reload_image_tab_for_recaptcha_recovery():
    """Làm mới tab Tạo Ảnh (Ctrl+R) khi gặp lỗi hoạt động bất thường / dừng chạy sớm để làm mới phiên reCAPTCHA."""
    if sys.platform == "darwin":
        return
    with open(LOCK_FILE, "a+") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            if is_flow_currently_running(mode="image"):
                return
            rx, ry = IMAGE_COORDS["reload_click"]
            sys.stderr.write("[AutoClick] 🔄 Làm mới (Ctrl+R) tab Tạo Ảnh để khôi phục phiên reCAPTCHA Google Flow...\n")
            activate_chrome(mode="image")
            pyautogui.moveTo(rx, ry, duration=0.18)
            pyautogui.click(rx, ry)
            time.sleep(0.2)
            pyautogui.hotkey("ctrl", "r")
            time.sleep(7.5)
            im_after = capture_screen_rgb(max_age_sec=0.0)
            check_and_dismiss_welcome_modal(im_after, mode="image")
        except Exception as e:
            sys.stderr.write(f"[AutoClick] Lỗi khi Ctrl+R tab Tạo Ảnh: {e}\n")
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


def wait_for_file_download(downloads_dir, initial_files, submitted_at, stt="", timeout_sec=300, poll_interval=3, mode="video", full_prompt=""):
    """
    Sau khi submit:
    - Với video: chờ 25s rồi poll tìm <stt>.mp4 (timeout 300s)
    - Với image: chờ 4s rồi poll mỗi 1.5s tìm <stt>.jpg / .png / .jpeg / .webp (timeout 180s)
    """
    overall_start = submitted_at
    init_delay = 4.0 if mode == "image" else 25.0
    wait_initial = max(2.0 if mode == "image" else 5.0, min(init_delay, init_delay - (time.time() - submitted_at)))
    sys.stderr.write(f"[AutoClick] Chờ {round(wait_initial, 1)} giây trước khi bắt đầu quét file Downloads ({mode})...\n")
    time.sleep(wait_initial)

    clean_stt = str(stt).strip()
    exts = IMAGE_EXTENSIONS if mode == "image" else VIDEO_EXTENSIONS
    sys.stderr.write(f"[AutoClick] Bắt đầu quét file Downloads ({mode}, STT: {clean_stt}, timeout: {timeout_sec}s)...\n")

    poll_count = 0
    not_running_streak = 0
    internal_resubmits = 0
    min_elapsed_for_error_check = 10 if mode == "image" else 40
    max_streak = 3 if mode == "image" else 6

    while (time.time() - overall_start) < timeout_sec:
        current_time = time.time()
        elapsed = round(current_time - submitted_at, 1)
        poll_count += 1

        try:
            candidates = []
            for f in os.listdir(downloads_dir):
                fl = f.lower()
                if not any(fl.endswith(ext) for ext in exts):
                    continue
                if fl.endswith(".crdownload") or fl.endswith(".tmp"):
                    continue

                full_path = os.path.join(downloads_dir, f)
                try:
                    st = os.stat(full_path)
                    if st.st_mtime >= (overall_start - 15) and st.st_size > 0:
                        candidates.append({
                            "name": f,
                            "path": full_path,
                            "mtime": st.st_mtime,
                            "size": st.st_size
                        })
                except OSError:
                    continue

            matched_file = None

            # BẮT BUỘC khớp đúng mã STT của task (ví dụ 6458.mp4, 6458.jpg, 6458 (1).jpg)
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
                time.sleep(0.5 if mode == "image" else 1.0)
                try:
                    sz2 = os.path.getsize(p)
                    if sz2 == sz1 and sz2 > 1024:
                        sys.stderr.write(f"[AutoClick] 🎉 Đã tìm thấy file ({mode}) hoàn chỉnh: {p} ({sz2 / 1024:.1f} KB, sau {elapsed}s)\n")
                        return matched_file
                except OSError:
                    pass

            has_downloading = any(f.endswith(".crdownload") or f.endswith(".tmp") for f in os.listdir(downloads_dir))
            if not has_downloading and elapsed >= min_elapsed_for_error_check:
                im_poll = capture_screen_rgb(max_age_sec=1.5)
                if check_and_dismiss_chrome_popups(im_poll, holds_lock=False, mode=mode):
                    not_running_streak = 0
                    time.sleep(1.5)
                    continue
                if im_poll is not None and not is_flow_currently_running(im_poll, mode=mode):
                    not_running_streak += 1
                    sys.stderr.write(f"[AutoClick] ⚠️ Huy hiệu • ĐANG CHẠY ({mode}) đã tắt ({not_running_streak}/{max_streak}) tại {elapsed}s mà chưa thấy file {clean_stt}...\n")
                    if not_running_streak >= max_streak:
                        if mode == "image" and full_prompt and internal_resubmits < 2 and (time.time() - overall_start) < (timeout_sec - 35):
                            internal_resubmits += 1
                            not_running_streak = 0
                            sys.stderr.write(f"[AutoClick] 🔁 Tự động làm mới tab & gửi lại task ảnh {clean_stt} (lần khôi phục {internal_resubmits}/2)...\n")
                            _reload_image_tab_for_recaptcha_recovery()
                            submitted_at = perform_click_and_submit(full_prompt=full_prompt, mode="image")
                            time.sleep(3.5)
                            continue
                        media_label = "ảnh" if mode == "image" else "video"
                        sys.stderr.write(f"[AutoClick] ❌ FLOW_TASK_ERROR: Google Flow đã dừng chạy ({mode}) sau {elapsed}s mà không xuất file {media_label}.\n")
                        return {
                            "error_fast_fail": f"FLOW_TASK_ERROR: Google Flow từ chối tạo {media_label} này (ảnh hoặc nội dung câu lệnh có thể vi phạm chính sách an toàn của Google) sau {elapsed}s."
                        }
                else:
                    not_running_streak = 0

        except Exception as e:
            sys.stderr.write(f"[AutoClick] Lỗi khi quét thư mục ({mode}): {e}\n")

        time.sleep(poll_interval)

    return None


def main():
    parser = argparse.ArgumentParser(description="AutoClick Video & Image Runner for Google Flow (50/50 Split Screen)")
    parser.add_argument("--mode", choices=["video", "image"], default="video", help="Chế độ chạy: video (nửa trái) hoặc image (nửa phải)")
    parser.add_argument("--prompt", required=True, help="Nội dung prompt")
    parser.add_argument("--stt", default="", help="Mã số thứ tự (ví dụ: 1001)")
    parser.add_argument("--ratio", default="9:16", help="Tỉ lệ (9:16, 16:9, 1:1)")
    parser.add_argument("--start-image", default=None, help="URL ảnh đầu vào")
    parser.add_argument("--end-image", default=None, help="URL ảnh kết thúc")
    parser.add_argument("--ref-image", action="append", default=[], help="URL hoặc data URI ảnh tham chiếu (có thể truyền nhiều lần)")
    parser.add_argument("--timeout", type=int, default=0, help="Thời gian timeout (giây), mặc định 300s cho video và 180s cho ảnh")
    parser.add_argument("--downloads-dir", default=os.path.expanduser("~/Downloads"), help="Thư mục Downloads")
    args = parser.parse_args()

    mode = args.mode
    timeout_sec = args.timeout if args.timeout > 0 else (180 if mode == "image" else 300)
    poll_interval = 1.5 if mode == "image" else 3.0

    downloads_dir = os.path.abspath(os.path.expanduser(args.downloads_dir))
    if not os.path.exists(downloads_dir):
        os.makedirs(downloads_dir, exist_ok=True)

    # 1. Snapshot danh sách file hiện có
    initial_files = get_downloads_files(downloads_dir, mode=mode)

    # 2. Format prompt chuẩn
    full_prompt = format_prompt(
        raw_prompt=args.prompt,
        stt=args.stt,
        ratio=args.ratio,
        start_img=args.start_image,
        end_img=args.end_image,
        ref_images=args.ref_image,
        mode=mode
    )

    # 3. Submit bằng Auto Click (trả về mốc thời gian thực sự bấm nút Chạy)
    submitted_at = perform_click_and_submit(
        full_prompt=full_prompt,
        mode=mode
    )

    # 4. Poll trong máy tính tìm file kết quả
    matched = wait_for_file_download(
        downloads_dir=downloads_dir,
        initial_files=initial_files,
        submitted_at=submitted_at,
        stt=args.stt,
        timeout_sec=timeout_sec,
        poll_interval=poll_interval,
        mode=mode,
        full_prompt=full_prompt
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
        media_label = "ảnh" if mode == "image" else "video"
        result = {
            "status": "error",
            "error": f"Timeout {timeout_sec}s kể từ lúc submit mà không thấy file {media_label} tải về máy tính.",
            "submitted_at": submitted_at,
            "elapsed": round(time.time() - submitted_at, 1)
        }
        print(json.dumps(result, ensure_ascii=False))
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
