# Release Checklist

Checklist này dùng trước mỗi lần deploy hoặc restart dịch vụ.

## Truoc khi release
- Cập nhật `.env` đúng giá trị cho `PORT`, `REDIS_URL`, `MONGO_URL`, `ADMIN_EMAILS`, `STATS_TOKEN`.
- Xac nhan `NODE_ENV=production` tren node thuc te.
- Nếu chạy multi-server, kiểm tra `ENABLE_REDIS=true` và Redis/Mongo không trỏ về loopback sai mục đích.
- Chay `npm run lint`.
- Chay `npm run test:all`.

## Truoc khi cut over
- Kiểm tra PM2 status xanh trên các app node.
- Nếu có load balancer, drain node trước khi restart.
- Backup nhanh `.env` và ghi lại commit/branch đang deploy.

## Sau khi deploy
- Kiểm tra `GET /health` trả `200`.
- Kiểm tra `/api/stats` bằng `STATS_TOKEN` hoặc admin session.
- Đăng nhập `/auth.html`, vào `/game.html`, mở thêm `/admin`.
- Thử lookup user và revoke session trên admin panel.
- Xác nhận realtime vẫn connect/move/disconnect được.

## Rollback
- Quay lại commit trước đó.
- Khôi phục `.env` nếu release vừa sửa cấu hình.
- Restart PM2 với `--update-env` nếu cần.
- Kiểm tra lại `/health`, `/api/stats`, `/admin`.
