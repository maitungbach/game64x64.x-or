# Login Debug Production

Checklist nhanh khi user báo "đã đăng ký nhưng không đăng nhập được".

## 1) Xác nhận response thật sự
- Mở DevTools > Network.
- Goi `POST /api/auth/login`.
- Doc status code:
  - `401`: sai email/password hoặc account không tồn tại trong storage hiện tại.
  - `409`: user đang online ở nơi khác (còn session active).
  - `429`: bị rate limit.
  - `403`: request origin/csrf không trusted.

## 2) Kiểm tra app node đang dùng storage nào
Tren moi node:
```bash
pm2 env <id_game64x64> | egrep "AUTH_REQUIRE_MONGO|MONGO_URL|ENABLE_REDIS|REDIS_URL"
pm2 logs game64x64 --nostream --lines 120
```
Cần thấy được dòng startup:
- `[startup] MongoDB enabled for auth storage.`

Nếu thấy:
- `[startup] MongoDB connection failed. Auth will use in-memory storage.`
thì account cũ sẽ mất sau restart.

## 3) Kiểm tra tunnel Mongo + Redis
Tren moi node:
```bash
nc -z -w2 127.0.0.1 37018 && echo mongo_tunnel_ok || echo mongo_tunnel_fail
nc -z -w2 172.16.10.202 6379 && echo redis_ok || echo redis_fail
```

## 4) Kiểm tra user có trong Mongo không
Trên node (qua tunnel local):
```bash
mongosh --quiet "mongodb://127.0.0.1:37018/game64x64" --eval "db.users.find({email:'YOUR_EMAIL'}).limit(1).toArray()"
```

## 5) Khi login bi `409`
- Đây là session conflict (`AUTH_REJECT_CONCURRENT=true`).
- Cach xu ly:
  - Đăng xuất ở máy cũ, hoặc
  - Admin revoke session user trong `/admin`.

## 6) Khi login bi `429`
- Đợi hết cửa sổ rate limit, hoặc
- Kiểm tra Redis ở node data.

## 7) Kiểm tra cân bằng LB
- Bao dam LB truyen ve node dang healthy:
```bash
curl -I https://colorbox64x64.online/health
```
- Nếu 1 node lỗi, drain node đó trước khi xử lý.
