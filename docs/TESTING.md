# Testing Guide

## Smoke test realtime
Kiem tra 3 luong chinh:
- Nhiu client cung connect
- Move duoc dong bo realtime
- Disconnect khong de lai ghost player

Chay lenh:
```bash
npm run test:smoke
```

Ket qua mong doi:
```text
PASS realtime smoke: connect/move/disconnect
```

## Smoke test stats endpoint
Kiem tra endpoint `/api/stats`:
- Khong co token -> 401
- Co token dung -> 200 + dung schema JSON

Chay lenh:
```bash
npm run test:stats
```

Hoac chay tat ca:
```bash
npm run test:all
```

## Smoke test Redis atomic (HA)
Kiem tra khi bat Redis:
- Khong co 2 player trung 1 o trong luong update realtime
- Redis index theo player va theo cell luon dong bo

Chay lenh:
```bash
npm run test:redis
```

Luu y:
- Test tu skip neu may khong co Redis tai `REDIS_URL`.
- Neu Redis co san, test se tao key tam va tu xoa sau khi xong.

## Luu y
- Cac test tu bat server rieng (`3101`, `3102`, `3103`).
- `test:smoke` va `test:stats` chay voi `ENABLE_REDIS=false`.
- `test:redis` chay voi `ENABLE_REDIS=true`.

## Load test nhieu client
Mo phong tai voi nhieu client Socket.io:
```bash
npm run test:load -- --clients 50 --duration 30 --moves 6
```

Neu `/api/stats` co token:
```bash
npm run test:load -- --token <STATS_TOKEN>
```
