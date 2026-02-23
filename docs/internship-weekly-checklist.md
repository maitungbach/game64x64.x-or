# Checklist triển khai theo tuần - Sân chơi sắc màu 64x64

## Mục tiêu tài liệu
- Chuyển hướng phát triển chính thức thành kế hoạch theo tuần, có đầu việc rõ ràng và tiêu chí nghiệm thu.
- Bám đúng trình tự: Frontend local -> Real-time backend -> Logic ổn định -> Deploy Internet -> HA nhiều server.

## Tuần 1 - Nền tảng Frontend local (Giai đoạn 1)

### Việc cần làm
- Khởi tạo project web cơ bản (`index.html`, `style.css`, `main.js`).
- Tạo `canvas` kích thước `640x640`, quy ước mỗi ô `10x10`.
- Viết hàm vẽ lưới 64x64.
- Tạo đối tượng player local:
  - `x`, `y` theo tọa độ ô.
  - `color` dạng mã hex.
- Bắt sự kiện bàn phím (`ArrowUp/Down/Left/Right`) để di chuyển.
- Ràng buộc biên để không vượt ngoài lưới.
- Vẽ lại canvas sau mỗi lần di chuyển.

### Checklist nghiệm thu
- [ ] Màn hình hiển thị đúng lưới 64x64.
- [ ] 1 pixel người chơi hiển thị đúng màu.
- [ ] Di chuyển mượt bằng bàn phím.
- [ ] Không đi ra ngoài biên.
- [ ] Chạy hoàn toàn local không cần server thời gian thực.

### Deliverable tuần
- Demo local 1 người chơi.
- Ảnh chụp hoặc video ngắn minh họa di chuyển.

## Tuần 2 - Backend + Kết nối thời gian thực (Giai đoạn 2)

### Việc cần làm
- Khởi tạo Node.js server với `Express` + `Socket.io`.
- Tạo cấu trúc lưu trạng thái người chơi trên server (`players`).
- Khi client connect:
  - Gán `socket.id`.
  - Tạo màu ngẫu nhiên.
  - Tạo vị trí spawn ban đầu.
  - Lưu vào `players`.
- Khi client gửi sự kiện move:
  - Validate tọa độ.
  - Cập nhật server state.
  - Broadcast danh sách player mới.
- Client render danh sách player nhận từ server.

### Checklist nghiệm thu
- [ ] Mở nhiều tab thấy nhiều người chơi.
- [ ] Di chuyển ở 1 tab, tab khác cập nhật gần như tức thì.
- [ ] Mỗi người chơi có màu riêng.
- [ ] Không crash khi client reconnect.

### Deliverable tuần
- Demo 3 tab chạy đồng bộ.
- Sơ đồ luồng sự kiện `connect -> move -> broadcast`.

## Tuần 3 - Ổn định logic hệ thống (Giai đoạn 3)

### Việc cần làm
- Hoàn thiện spawn thông minh:
  - Kiểm tra vị trí trống trước khi cấp spawn.
  - Nếu trùng thì thử lại (random có giới hạn số lần).
- Xử lý disconnect triệt để:
  - Xóa player khỏi state.
  - Broadcast lại danh sách mới.
- Chuẩn hóa payload:
  - Chỉ gửi dữ liệu player cần thiết (`id`, `x`, `y`, `color`).
  - Không gửi toàn bộ grid 4096 ô.
- Chống spam move event (rate limit nhẹ phía server).
- Viết test thủ công theo kịch bản lỗi phổ biến.

### Checklist nghiệm thu
- [ ] Không còn "bóng ma" sau khi đóng tab.
- [ ] Không có 2 người trùng 1 ô tại thời điểm spawn.
- [ ] Dữ liệu WebSocket gọn, chỉ gồm player list.
- [ ] Hệ thống vẫn ổn khi thao tác nhanh liên tục.

### Deliverable tuần
- Bảng test case (connect/disconnect/spawn/move spam).
- Biên bản test và lỗi đã khắc phục.

## Tuần 4 - Deploy 1 VPS chạy Internet (Giai đoạn 4 - phần 1)

### Việc cần làm
- Chuẩn bị VPS Ubuntu:
  - Cài `nodejs`, `npm`, `git`, `nginx`.
- Đưa source code lên VPS (git clone hoặc scp).
- Cài dependency và chạy app bằng PM2:
  - `pm2 start server.js`
  - `pm2 save`
  - `pm2 startup`
- Cấu hình Nginx reverse proxy đến Node app.
- Mở port/tường lửa cần thiết.
- Kiểm tra truy cập bằng mạng ngoài (4G/thiết bị khác).

### Checklist nghiệm thu
- [ ] Truy cập được qua domain/IP công cộng.
- [ ] WebSocket hoạt động sau Nginx proxy.
- [ ] PM2 tự khởi động lại app khi reboot.
- [ ] Người dùng điện thoại và máy tính đều vào được.

### Deliverable tuần
- URL demo public.
- Tài liệu thao tác deploy cơ bản.

## Tuần 5 - Nâng cấp High Availability (2 server + Redis)

### Việc cần làm
- Dựng tối thiểu 2 Node server.
- Cài Redis dùng chung.
- Chuyển state/đồng bộ realtime sang mô hình nhiều instance:
  - Dùng Socket.io Redis adapter.
- Cấu hình Nginx load balancing giữa 2 Node server.
- Kiểm thử failover:
  - Tắt 1 server trong lúc đang có người chơi.
  - Quan sát hệ thống còn phục vụ được không.

### Checklist nghiệm thu
- [ ] 2 server chạy đồng thời và nhận traffic.
- [ ] Dữ liệu người chơi đồng bộ giữa các instance.
- [ ] Tắt 1 server, hệ thống vẫn hoạt động.
- [ ] Không mất kết nối hàng loạt khi có sự cố 1 node.

### Deliverable tuần
- Sơ đồ kiến trúc triển khai thực tế.
- Báo cáo failover test (kịch bản, kết quả, ảnh minh chứng).

## Tuần 6 - Hoàn thiện báo cáo thực tập và nghiệm thu cuối

### Việc cần làm
- Tổng hợp tài liệu kỹ thuật:
  - Kiến trúc hệ thống.
  - Luồng dữ liệu realtime.
  - Hướng dẫn cài đặt và vận hành.
- Tổng hợp số liệu kiểm thử:
  - Độ trễ cảm nhận.
  - Ổn định khi nhiều tab/thiết bị.
  - Kết quả failover.
- Chuẩn bị demo kịch bản chuẩn:
  - Nhiều người chơi online.
  - Disconnect/reconnect.
  - Tắt 1 server vẫn còn dịch vụ.

### Checklist nghiệm thu
- [ ] Đạt 3 tiêu chí: đúng đắn, ổn định, thực tế.
- [ ] Có demo trực tiếp qua Internet công cộng.
- [ ] Có tài liệu vận hành và hướng dẫn triển khai.
- [ ] Có báo cáo bài học rút ra và hướng nâng cấp.

### Deliverable tuần
- Báo cáo thực tập hoàn chỉnh.
- Slide bảo vệ + script demo.

## Rủi ro và phương án dự phòng
- Rủi ro: Trễ tiến độ backend realtime.
  - Ứng phó: Chốt API sự kiện sớm, ưu tiên luồng connect/move/disconnect trước.
- Rủi ro: Lỗi đồng bộ khi multi-server.
  - Ứng phó: Hoàn tất Redis adapter trên môi trường staging trước khi production.
- Rủi ro: VPS cấu hình yếu gây lag.
  - Ứng phó: Giảm payload, giới hạn tần suất move, chọn VPS gần khu vực người dùng.

## KPI tối thiểu để qua kỳ thực tập
- Realtime nhiều người: Hoàn thành.
- Deploy Internet công cộng: Hoàn thành.
- Có kiểm thử failover 2 server: Hoàn thành.
- Có tài liệu kỹ thuật + demo: Hoàn thành.
