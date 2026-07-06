# VEO3 Flow REST API Server 🔓

Dự án này là một API Server RESTful hoàn chỉnh, độc lập, cho phép bạn gọi các API tạo Video (VEO3) và Ảnh (Imagen 3) của Google Labs từ bất kỳ môi trường lập trình nào (Python, Node.js backend, PHP, Curl, v.v.).

Dự án hoạt động dựa trên cơ chế đánh chặn token OAuth của Google Labs Flow kết hợp với một Chrome Extension giải Captcha reCAPTCHA Enterprise cực kỳ thông minh chạy trực tiếp trên trình duyệt Chrome của bạn.

---

## 🛠️ Cài Đặt và Khởi Chạy

### 1. Cài đặt Node.js Dependencies
Di chuyển vào thư mục dự án và cài đặt các thư viện cần thiết:
```bash
cd veo3-api-server
npm install
```

### 2. Chuẩn bị Cookies Google Labs Flow
Bạn cần lấy Cookie tài khoản Google Labs đang có quyền sử dụng VEO3 Flow:
1. Mở trình duyệt Chrome của bạn, truy cập: `https://labs.google/fx/vi/tools/flow` (Đăng nhập tài khoản Google).
2. Sử dụng extension Chrome như **EditThisCookie** hoặc phím F12 -> Application -> Cookies.
3. Xuất (Export) cookie ra định dạng JSON.
4. Tạo một file tên là `cookies.json` trong thư mục gốc của `veo3-api-server/` và dán nội dung cookie đó vào.

### 3. Cài đặt Captcha Solver Extension trên Trình duyệt Chrome thật
Bởi vì Google Labs bảo vệ nút bấm tạo video bằng reCAPTCHA Enterprise, trình duyệt ẩn (headless) của server sẽ bị Google chặn. Chúng ta giải quyết bằng cách chuyển tiếp yêu cầu giải mã captcha tới trình duyệt Chrome thật của bạn:
1. Mở Chrome (tab bình thường đang đăng nhập Google và mở trang `https://labs.google/fx/vi/tools/flow`).
2. Truy cập: `chrome://extensions/`
3. Bật chế độ nhà phát triển (**Developer mode** ở góc trên cùng bên phải).
4. Nhấn **Load unpacked** (Tải tiện ích đã giải nén) và chọn thư mục `veo3-api-server/extension`.
5. Sau khi load thành công, nhấn vào biểu tượng extension trên thanh công cụ để xem trạng thái kết nối. Nó sẽ kết nối tới port `3456` của server của bạn.

### 4. Khởi chạy Server
Chạy lệnh sau để khởi động server:
```bash
npm start
```

Khi khởi chạy:
- Server sẽ lắng nghe kết nối WebSocket từ Extension trên port `3456`.
- Server tự động bật một Brave Browser ẩn (hoặc Chrome ẩn) bằng Puppeteer, đọc cookies từ `cookies.json` để tự động đăng nhập và bắt token OAuth ya29 phục vụ việc call API của Google.

---

## 🚀 REST API Endpoints

### 1. Tạo Video (Text-to-Video, Image-to-Video, Interpolation)

- **URL**: `/api/generate-video`
- **Method**: `POST`
- **Content-Type**: `application/json` (hoặc `multipart/form-data` nếu bạn upload file ảnh lên trực tiếp)

**Payload ví dụ (JSON)**:
```json
{
  "prompt": "a majestic dragon flying over burning castle, cinematic movie style",
  "aspectRatio": "16:9", // Tùy chọn: "16:9", "9:16", "1:1", "4:3", "3:4"
  "model": "veo_3_1_fast", // Tùy chọn: "veo_3_1_fast", "veo_3_1_quality", "veo_3_1_lite", "abra"
  "count": 1, // Tùy chọn: 1 hoặc 2
  "durationSeconds": 6, // Tùy chọn: 4 hoặc 6 (abra hỗ trợ 8s, 10s)
  "startImage": "mediaId_hoac_url_anh" // Tùy chọn (cho Image-to-Video)
}
```

**Hoặc gửi qua Postman (Form-Data)** để upload ảnh trực tiếp:
- `prompt`: `a cinematic sequence`
- `startImage`: `[Chọn File ảnh]` (hệ thống tự động upload lên Google Flow làm frame đầu)

**Response**:
```json
{
  "success": true,
  "taskId": "7d953932-d8df-461d-8547-a89fa12b3ca3",
  "status": "queued"
}
```

---

### 2. Tạo Ảnh (Imagen 3)

- **URL**: `/api/generate-image`
- **Method**: `POST`

**Payload ví dụ (JSON)**:
```json
{
  "prompt": "cute cat sitting in a tea cup, hyperrealistic",
  "aspectRatio": "1:1",
  "count": 2
}
```

**Response**:
```json
{
  "success": true,
  "taskId": "b9a52bc3-a8df-4d69-be19-ff37ea984ad3",
  "status": "queued"
}
```

---

### 3. Kiểm tra Trạng Thái Task & Lấy Link Tải

- **URL**: `/api/status/:taskId`
- **Method**: `GET`

**Response ví dụ (Đang tạo)**:
```json
{
  "id": "7d953932-d8df-461d-8547-a89fa12b3ca3",
  "type": "video",
  "status": "generating",
  "prompt": "a majestic dragon...",
  "progress": "12s elapsed",
  "media": [],
  "error": null
}
```

**Response ví dụ (Hoàn tất)**:
```json
{
  "id": "7d953932-d8df-461d-8547-a89fa12b3ca3",
  "type": "video",
  "status": "completed",
  "media": [
    {
      "mediaId": "projects/flow-xxxxx/media/generation-xxxxx",
      "status": "success",
      "url": "https://storage.googleapis.com/ai-sandbox-videofx/video/..." // Link download video trực tiếp từ Google GCS
    }
  ],
  "error": null
}
```

---

### 4. Cập Nhật Cookies Động

- **URL**: `/api/set-cookies`
- **Method**: `POST`

**Payload**:
```json
{
  "cookies": [ ... mảng cookies mới lấy được từ trình duyệt ... ]
}
```
Lệnh này giúp cập nhật file `cookies.json` trực tiếp qua API và yêu cầu trình duyệt ẩn nạp lại cookie để gia hạn token OAuth mới ngay lập tức mà không cần khởi động lại server.
