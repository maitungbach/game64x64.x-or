# Operations Guide

## Admin dashboard
- URL: `/admin`
- Hien thi:
  - Health (`/api/health`)
  - Runtime stats (`/api/stats`)
  - Counters connect/move/disconnect/error

Dashboard poll moi 2 giay.

## Bao ve /api/stats
Neu dat `STATS_TOKEN`, endpoint `/api/stats` se yeu cau header:
- `x-stats-token: <token>`

Trang `/admin` co o nhap token de gui header nay.

## Endpoint
- `GET /api/health`: health check nhanh
- `GET /api/stats`: runtime stats (co the can token)

## Kiem tra nhanh
```bash
curl http://127.0.0.1:3000/api/health
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
