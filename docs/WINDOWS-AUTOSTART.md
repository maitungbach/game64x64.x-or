# Windows Autostart

## Muc tieu
- Khi đăng nhập Windows, tunnel SSH tới MongoDB được bật lại nếu đang tắt.
- App `game64x64` được chạy dưới PM2 và tự khởi động lại nếu bị dừng.
- Watchdog local kiểm tra mỗi 30 giây để đảm bảo `mongoConnected=true`.

## File lien quan
- `scripts/windows-ensure-runtime.ps1`: dam bao tunnel + PM2 + health check.
- `scripts/windows-runtime-watchdog.ps1`: watchdog chạy nền, lặp lại mỗi 30 giây.
- `scripts/windows-install-startup.ps1`: cài file Startup cho user hiện tại.

## Bien moi truong tuy chon
Đọc từ `.env` nếu có:

```env
MONGO_TUNNEL_SSH_HOST=103.252.74.109
MONGO_TUNNEL_SSH_PORT=2357
MONGO_TUNNEL_SSH_USER=root
MONGO_TUNNEL_REMOTE_HOST=172.16.10.202
MONGO_TUNNEL_REMOTE_PORT=27017
MONGO_TUNNEL_LOCAL_HOST=127.0.0.1
MONGO_TUNNEL_LOCAL_PORT=37018
# MONGO_TUNNEL_SSH_KEY=C:\Users\Thinkpad\.ssh\id_rsa
```

## Lenh thu cong
```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows-runtime-watchdog.ps1
```

## Cài auto-start cho user hiện tại
```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows-install-startup.ps1
```

Launcher sẽ được tạo trong Startup folder của Windows và watchdog sẽ tự chạy sau khi đăng nhập.

## Log
- `logs/windows-runtime.log`
- `logs/mongo-tunnel.out.log`
- `logs/mongo-tunnel.err.log`
