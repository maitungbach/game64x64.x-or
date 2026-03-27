# Windows Autostart

## Muc tieu
- Khi dang nhap Windows, tunnel SSH toi MongoDB duoc bat lai neu dang tat.
- App `game64x64` duoc chay duoi PM2 va tu khoi dong lai neu bi dung.
- Watchdog local kiem tra moi 30 giay de dam bao `mongoConnected=true`.

## File lien quan
- `scripts/windows-ensure-runtime.ps1`: dam bao tunnel + PM2 + health check.
- `scripts/windows-runtime-watchdog.ps1`: watchdog chay nen, lap lai moi 30 giay.
- `scripts/windows-install-startup.ps1`: cai file Startup cho user hien tai.

## Bien moi truong tuy chon
Doc tu `.env` neu co:

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

## Cai auto-start cho user hien tai
```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows-install-startup.ps1
```

Launcher se duoc tao trong Startup folder cua Windows va watchdog se tu chay sau khi dang nhap.

## Log
- `logs/windows-runtime.log`
- `logs/mongo-tunnel.out.log`
- `logs/mongo-tunnel.err.log`
