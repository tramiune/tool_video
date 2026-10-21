#!/usr/bin/env python3
"""
autoclick_video_runner.py
=========================
Cơ chế tự động tạo Video qua Auto Click và giám sát tải về:
1. Double Click tọa độ (439, 578) vào ô nhập prompt
2. Paste prompt theo định dạng (ratio|stt. prompt|urls...)
3. Click tọa độ (440, 729) nút "Chạy thủ công"
4. Chờ 30s
5. Poll thư mục Downloads tìm file .mp4 mới tải về
6. Sau 5 phút (300s) không thấy file -> Báo FAIL
7. Khi thấy file -> Trả về JSON {"status": "success", "file_path": "..."}
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

def format_prompt(raw_prompt, stt, ratio, start_img=None, end_img=None):
    """Đảm bảo format đúng dạng: ratio|stt. prompt|image_urls... (luôn trên 1 dòng duy nhất)"""
    prompt = " ".join(str(raw_prompt or "").splitlines()).strip()
    
    # Kiểm tra xem prompt đã có STT chưa
    clean_stt = str(stt).strip()
    if clean_stt and not prompt.startswith(clean_stt):
        # Tránh lặp stt nếu prompt bắt đầu bằng số
        if not prompt.split('.')[0].strip().isdigit():
            prompt = f"{clean_stt}. {prompt}"
            
    # Kiểm tra xem prompt đã có ratio chưa
    if "|" in prompt:
        parts = prompt.split("|")
        # Giữ nguyên nếu đã có format pipe
        full_line = prompt
    else:
        full_line = f"{ratio}|{prompt}"
        
    # Thêm ảnh nếu có
    if start_img and start_img not in full_line:
        full_line += f"|{start_img}"
        if end_img and end_img not in full_line:
            full_line += f"|{end_img}"
            
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
    """Kích hoạt cửa sổ Google Chrome nổi lên trước."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["osascript", "-e", 'tell application "Google Chrome" to activate'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.run(["xdotool", "search", "--onlyvisible", "--class", "google-chrome", "windowactivate"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
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

def wait_until_submit_button_ready(x_btn=273, y_btn=733, max_wait_sec=30):
    """Đợi cho tới khi nút 'CHẠY THỦ CÔNG' (màu trắng sáng) đã hiện trên màn hình (tránh bấm lúc trang đang load)."""
    if sys.platform == "darwin":
        return True
    try:
        from PIL import Image
    except ImportError:
        return True

    start_t = time.time()
    check_pts = [(180, y_btn), (x_btn, y_btn - 13), (x_btn, y_btn + 9), (350, y_btn)]
    logged_wait = False

    while (time.time() - start_t) < max_wait_sec:
        try:
            subprocess.run(["scrot", "-o", "/tmp/autoclick_ready_check.png"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            im = Image.open("/tmp/autoclick_ready_check.png").convert("RGB")
            bright = 0
            for (px, py) in check_pts:
                if 0 <= px < im.width and 0 <= py < im.height:
                    r, g, b = im.getpixel((px, py))
                    if r > 190 and g > 190 and b > 190:
                        bright += 1
            if bright >= 2:
                if logged_wait:
                    sys.stderr.write(f"[AutoClick] ✅ Giao diện Flow đã READY (sau {round(time.time() - start_t, 1)}s)!\n")
                    time.sleep(1.0)
                return True
        except Exception:
            pass

        if not logged_wait:
            sys.stderr.write("[AutoClick] ⏳ Trang Flow đang tải, chờ nút 'CHẠY THỦ CÔNG' xuất hiện...\n")
            logged_wait = True
        time.sleep(1.5)

    sys.stderr.write("[AutoClick] ⚠️ Đã chờ tối đa 30s, tiếp tục thực hiện click...\n")
    return False

def perform_click_and_submit(full_prompt, x_input=248, y_input=546, x_btn=273, y_btn=733):
    """Thao tác chuột nhập prompt và bấm Chạy thủ công."""
    mod_key = "command" if sys.platform == "darwin" else "ctrl"
    # Khóa chuột để tránh 2 task chạy đè lên nhau
    with open(LOCK_FILE, "w") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            wait_until_submit_button_ready(x_btn, y_btn, max_wait_sec=30)
            sys.stderr.write(f"[AutoClick] Đã nhận mouse lock. Bắt đầu submit prompt vào ({x_input}, {y_input}) và bấm ({x_btn}, {y_btn})...\n")
            
            # 1. Focus ô textarea (click 2 lần có delay để cửa sổ nhận focus và con trỏ chuột đặt vào ô)
            pyautogui.moveTo(x_input, y_input, duration=0.3)
            pyautogui.click(x_input, y_input)
            time.sleep(0.3)
            pyautogui.click(x_input, y_input)
            time.sleep(0.2)
            
            # Xóa text cũ (Ctrl + A hoặc Cmd + A)
            pyautogui.hotkey(mod_key, "a")
            time.sleep(0.1)
            
            # 2. Copy prompt vào clipboard và dán (Ctrl + V hoặc Cmd + V)
            set_clipboard(full_prompt)
            time.sleep(0.3)
            pyautogui.hotkey(mod_key, "v")
            time.sleep(0.8)
            
            # 3. Click nút "Chạy thủ công"
            pyautogui.moveTo(x_btn, y_btn, duration=0.3)
            pyautogui.click(x_btn, y_btn)
            time.sleep(1.0)
            
            # 4. Chụp ảnh màn hình để lưu bằng chứng submit
            try:
                os.system("scrot /tmp/last_video_submit.png 2>/dev/null")
            except Exception:
                pass
            
            sys.stderr.write(f"[AutoClick] Submit thành công. Giải phóng mouse lock.\n")
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)

def wait_for_file_download(downloads_dir, initial_files, submitted_at, stt="", timeout_sec=300, poll_interval=3):
    """
    Sau khi submit:
    - Chờ 30s
    - Poll thư mục Downloads tìm file .mp4 mới
    - Sau 5 phút (timeout_sec) báo fail
    """
    # 1. Chờ 30 giây trước khi bắt đầu poll
    sys.stderr.write(f"[AutoClick] Chờ 30 giây trước khi bắt đầu quét file Downloads...\n")
    time.sleep(30)
    
    clean_stt = str(stt).strip()
    sys.stderr.write(f"[AutoClick] Bắt đầu quét file Downloads (STT: {clean_stt}, timeout: {timeout_sec}s)...\n")
    
    while (time.time() - submitted_at) < timeout_sec:
        current_time = time.time()
        elapsed = round(current_time - submitted_at, 1)
        
        try:
            candidates = []
            for f in os.listdir(downloads_dir):
                if not f.endswith(".mp4"):
                    continue
                # Bỏ qua file tải dở
                if f.endswith(".crdownload") or f.endswith(".tmp"):
                    continue
                    
                full_path = os.path.join(downloads_dir, f)
                try:
                    st = os.stat(full_path)
                    # Điều kiện 1: File mới được tạo/sửa sau khi submit (cho phép trừ hao 10s)
                    if st.st_mtime >= (submitted_at - 10):
                        # Điều kiện 2: File có size > 0
                        if st.st_size > 0:
                            candidates.append({
                                "name": f,
                                "path": full_path,
                                "mtime": st.st_mtime,
                                "size": st.st_size
                            })
                except OSError:
                    continue
                    
            # Tìm file phù hợp nhất
            matched_file = None
            
            # Ưu tiên 1: Tên file chứa đúng STT (ví dụ 001.mp4, 001 (1).mp4)
            if clean_stt:
                for c in candidates:
                    if clean_stt in c["name"]:
                        matched_file = c
                        break
                        
            # Ưu tiên 2: File mới hoàn toàn không có trong danh sách ban đầu
            if not matched_file:
                new_files = [c for c in candidates if c["name"] not in initial_files]
                if new_files:
                    # Lấy file mới nhất
                    new_files.sort(key=lambda x: x["mtime"], reverse=True)
                    matched_file = new_files[0]
                    
            if matched_file:
                # Kiểm tra file đã tải xong hẳn chưa (size không đổi sau 1s)
                p = matched_file["path"]
                sz1 = matched_file["size"]
                time.sleep(1.0)
                try:
                    sz2 = os.path.getsize(p)
                    if sz2 == sz1 and sz2 > 1024: # Lớn hơn 1KB
                        sys.stderr.write(f"[AutoClick] 🎉 Đã tìm thấy file hoàn chỉnh: {p} ({sz2 / 1024 / 1024:.2f} MB, sau {elapsed}s)\n")
                        return matched_file
                except OSError:
                    pass
                    
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

    # Tự động đọc tọa độ từ video_.json nếu có
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
    
    # 3. Submit bằng Auto Click
    submitted_at = time.time()
    perform_click_and_submit(
        full_prompt=full_prompt,
        x_input=x_in,
        y_input=y_in,
        x_btn=x_btn,
        y_btn=y_btn
    )
    
    # 4. Chờ 30s và poll trong máy tính tối đa 5 phút
    matched = wait_for_file_download(
        downloads_dir=downloads_dir,
        initial_files=initial_files,
        submitted_at=submitted_at,
        stt=args.stt,
        timeout_sec=args.timeout,
        poll_interval=3
    )
    
    if matched:
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
