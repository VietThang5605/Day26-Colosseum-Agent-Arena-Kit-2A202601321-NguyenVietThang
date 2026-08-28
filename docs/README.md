# Colosseum Web Arena — Hướng dẫn Deploy GitHub Pages 🌐⚔️

Ứng dụng web tĩnh hoàn chỉnh (100% Client-Side WebAssembly) cho phép tải lên 2 file `.bundle` đấu bot Colosseum và hiển thị pixel battle HUD trực tiếp trên trình duyệt.

---

## 🚀 Cách Deploy lên GitHub Pages trong 2 bước:

1. **Đẩy mã nguồn lên GitHub**:
   ```bash
   git add docs/
   git commit -m "feat: add colosseum web arena for github pages"
   git push origin main
   ```

2. **Bật GitHub Pages trên Repository**:
   - Truy cập vào Repository trên GitHub: `https://github.com/<username>/<repo-name>`
   - Vào **Settings** $\rightarrow$ Chọn mục **Pages** ở thanh menu bên trái.
   - Ở mục **Build and deployment**:
     - **Source**: Chọn `Deploy from a branch`
     - **Branch**: Chọn `main` và chọn thư mục `/docs`
     - Nhấn **Save**.

Sau khoảng 1-2 phút, trang web của bạn sẽ hoạt động trực tiếp tại địa chỉ:
`https://<username>.github.io/<repo-name>/`

---

## ✨ Tính năng nổi bật của Web Arena:
- **Zero-Backend (100% Client-side)**: Chạy toàn bộ logic trọng tài, gateway và công tố viên bằng **Pyodide Python 3.12 WebAssembly** ngay trong trình duyệt. Không tốn chi phí hosting hay máy chủ!
- **Hỗ trợ Drag-and-Drop**: Kéo thả trực tiếp file `.bundle` hoặc `.zip` của bạn và đối thủ.
- **Có sẵn 4 Bot Presets**: `Champion (Bot của bạn)`, `Adversary (Bot mạnh nhất)`, `Operator`, và `Rookie`.
- **Canvas Pixel Art Battle HUD**: Tái tạo đầy đủ màn hình trận đấu với thanh máu, credits, sprite động, bảng thông báo khiếu nại (claim cut-in), và timeline scrubber.
- **Thống kê & Xuất Dữ liệu**: Xem chi tiết 10 hiệp đấu và tải về file `trace.jsonl`.
