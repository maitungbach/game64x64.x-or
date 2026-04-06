# Operations Guide

## Release checklist
Xem [RELEASE-CHECKLIST.md](/c:/workspace/game64x64.x-or/docs/RELEASE-CHECKLIST.md) truoc moi lan deploy hoac restart.

## Admin dashboard
- URL: `/admin`
- Can dang nhap bang tai khoan co email nam trong `ADMIN_EMAILS`
- Hien thi:
  - Health (`/api/health`)
  - Runtime stats (`/api/stats`)
  - Counters connect/move/disconnect/error
  - Tra cuu user theo email
  - Thu hoi session va ngat socket cua user

Dashboard poll moi 2 giay.

## Bao ve /api/stats
Neu dat `STATS_TOKEN`, endpoint `/api/stats` se yeu cau header:
- `x-stats-token: <token>`

Admin session hop le van co the truy cap `/api/stats` ma khong can token.
Trang `/admin` co o nhap token de gui kem header nay khi can.

## Bao ve /api/health
- `GET /health`: healthcheck toi thieu cho probe/load balancer
- `GET /api/health`: chi tiet he thong, yeu cau admin session

## Endpoint
- `GET /health`: liveness check toi thieu
- `GET /api/health`: health check chi tiet, yeu cau admin
- `GET /api/stats`: runtime stats (co the can token)
- `GET /api/admin/user-by-email?email=<email>`: tra cuu user va session active
- `POST /api/admin/user/revoke-sessions`: thu hoi session user

## Kiem tra nhanh
```bash
curl http://127.0.0.1:3000/health
curl -H "x-stats-token: <token>" http://127.0.0.1:3000/api/stats
```

## Drain node truoc khi reboot
Tren LB `103.252.74.109` / `172.16.10.202`:
```bash
sudo /usr/local/bin/game64x64-node-state status
sudo /usr/local/bin/game64x64-node-state drain 172.16.10.216
sudo /usr/local/bin/game64x64-node-state drain 172.16.10.253
sudo /usr/local/bin/game64x64-node-state undrain 172.16.10.216
```

## Persist env cho PM2
App nodes doc env tu file `/opt/game64x64/.env` thong qua `config/ecosystem.config.js`.
Sau khi sua `.env`, nap lai:
```bash
cd /opt/game64x64
pm2 restart config/ecosystem.config.js --only game64x64 --update-env
pm2 save
```

## Luu tru tai khoan
Tai khoan dang ky moi duoc luu truc tiep trong MongoDB collection `game64x64.users`.
Day la nguon du lieu chinh, duoc giu lai sau khi restart app, PM2, hoac reboot VPS.
Khong dung file cuc bo tren tung app node de luu tai khoan dang ky.

Kiem tra nhanh tren data node:
```bash
mongosh "mongodb://127.0.0.1:37018/game64x64" --eval "db.users.find({}, { email: 1, name: 1, createdAt: 1 }).limit(10)"
```

## Broadcast batching
Server gop cac request broadcast trong khoang `BROADCAST_INTERVAL_MS` (mac dinh 33ms)
nham giam tan suat `updatePlayers` duoi tai cao.

Theo doi trong `/api/stats`:
- `broadcastRequestsTotal`
- `broadcastsEmitted`
- `broadcastsCoalesced`
