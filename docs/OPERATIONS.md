# Operations Guide

## Release checklist
Xem [RELEASE-CHECKLIST.md](/c:/workspace/game64x64.x-or/docs/RELEASE-CHECKLIST.md) trước mỗi lần deploy hoặc restart.
Nếu gặp sự cố đăng nhập, xem [LOGIN-DEBUG-PROD.md](/c:/workspace/game64x64.x-or/docs/LOGIN-DEBUG-PROD.md).

## Admin dashboard
- URL: `/admin`
- Cần đăng nhập bằng tài khoản có email nằm trong `ADMIN_EMAILS`
- Hien thi:
  - Health (`/api/health`)
  - Runtime stats (`/api/stats`)
  - Counters connect/move/disconnect/error
  - Tra cuu user theo email
  - Thu hồi session và ngắt socket của user

Dashboard poll mỗi 5 giây khi tab đang mở, và giảm tần suất khi tab bị ẩn.

## Bao ve /api/stats
Nếu đặt `STATS_TOKEN`, endpoint `/api/stats` sẽ yêu cầu header:
- `x-stats-token: <token>`

Admin session hợp lệ vẫn có thể truy cập `/api/stats` mà không cần token.
Trang `/admin` có ô nhập token để gửi kèm header này khi cần.

## Bao ve /api/health
- `GET /health`: healthcheck tối thiểu cho probe/load balancer
- `GET /api/health`: chi tiết hệ thống, yêu cầu admin session

## Endpoint
- `GET /health`: liveness check tối thiểu
- `GET /api/health`: health check chi tiết, yêu cầu admin
- `GET /api/admin/dashboard`: snapshot admin gồm health + stats, yêu cầu admin
- `GET /api/stats`: runtime stats (có thể cần token)
- `GET /api/admin/user-by-email?email=<email>`: tra cứu user và session active
- `POST /api/admin/user/revoke-sessions`: thu hồi session user

## Kiểm tra nhanh
```bash
curl http://127.0.0.1:3000/health
curl -H "x-stats-token: <token>" http://127.0.0.1:3000/api/stats
bash deploy/cluster-healthcheck.sh
```

## Drain node trước khi reboot
Tren LB `103.252.74.109` / `172.16.10.202`:
```bash
sudo /usr/local/bin/game64x64-node-state status
sudo /usr/local/bin/game64x64-node-state drain 172.16.10.216
sudo /usr/local/bin/game64x64-node-state drain 172.16.10.253
sudo /usr/local/bin/game64x64-node-state undrain 172.16.10.216
```

## Persist env cho PM2
App nodes đọc env từ file `/opt/game64x64/.env` thông qua `config/ecosystem.config.js`.
Sau khi sửa `.env`, nạp lại:
```bash
cd /opt/game64x64
pm2 restart config/ecosystem.config.js --only game64x64 --update-env
pm2 save
```

## Lưu trữ tài khoản
Tài khoản đăng ký mới được lưu trực tiếp trong MongoDB collection `game64x64.users`.
Đây là nguồn dữ liệu chính, được giữ lại sau khi restart app, PM2, hoặc reboot VPS.
Không dùng file cục bộ trên từng app node để lưu tài khoản đăng ký.

Kiểm tra nhanh trên data node:
```bash
mongosh "mongodb://127.0.0.1:37018/game64x64" --eval "db.users.find({}, { email: 1, name: 1, createdAt: 1 }).limit(10)"
```

## Broadcast batching
Server gộp các request broadcast trong khoảng `BROADCAST_INTERVAL_MS` (mặc định 33ms)
nhằm giảm tần suất `updatePlayers` khi tải cao.

Theo doi trong `/api/stats`:
- `broadcastRequestsTotal`
- `broadcastsEmitted`
- `broadcastsCoalesced`
