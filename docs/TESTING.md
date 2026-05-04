# Testing Guide

## Smoke test realtime
Kiểm tra 3 luồng chính:
- Nhiu client cung connect
- Move được đồng bộ realtime
- Disconnect không để lại ghost player

Chay lenh:
```bash
npm run test:smoke
```

Kết quả mong đợi:
```text
PASS realtime smoke: connect/move/disconnect
```

## Smoke test stats endpoint
Kiểm tra endpoint `/api/stats`:
- Khong co token -> 401
- Co token dung -> 200 + dung schema JSON

Chay lenh:
```bash
npm run test:stats
```

Hoặc chạy tất cả:
```bash
npm run test:all
```

## Smoke test Redis atomic (HA)
Kiểm tra khi bật Redis:
- Không có 2 player trùng 1 ô trong lưới update realtime
- Redis index theo player và theo cell luôn đồng bộ

Chay lenh:
```bash
npm run test:redis
```

Luu y:
- Test tự skip nếu máy không có Redis tại `REDIS_URL`.
- Nếu Redis có sẵn, test sẽ tạo key tạm và tự xóa sau khi xong.

## Luu y
- Cac test tu bat server rieng (`3101`, `3102`, `3103`).
- `test:smoke` và `test:stats` chạy với `ENABLE_REDIS=false`.
- `test:redis` chạy với `ENABLE_REDIS=true`.

## Load test nhieu client
Mo phong tai voi nhieu client Socket.io:
```bash
npm run test:load -- --clients 50 --duration 30 --moves 6
```

Neu `/api/stats` co token:
```bash
npm run test:load -- --token <STATS_TOKEN>
```
