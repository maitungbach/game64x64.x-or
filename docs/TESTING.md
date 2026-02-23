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

## Luu y
- Cac test tu bat server rieng (`3101`, `3102`).
- Test mac dinh chay voi `ENABLE_REDIS=false`.
