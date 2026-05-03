# Login Debug Production

Checklist nhanh khi user bao "da dang ky nhung khong dang nhap duoc".

## 1) Xac nhan response that su
- Mo DevTools > Network.
- Goi `POST /api/auth/login`.
- Doc status code:
  - `401`: sai email/password hoac account khong ton tai trong storage hien tai.
  - `409`: user dang online o noi khac (con session active).
  - `429`: bi rate limit.
  - `403`: request origin/csrf khong trusted.

## 2) Kiem tra app node dang dung storage nao
Tren moi node:
```bash
pm2 env <id_game64x64> | egrep "AUTH_REQUIRE_MONGO|MONGO_URL|ENABLE_REDIS|REDIS_URL"
pm2 logs game64x64 --nostream --lines 120
```
Can thay duoc dong startup:
- `[startup] MongoDB enabled for auth storage.`

Neu thay:
- `[startup] MongoDB connection failed. Auth will use in-memory storage.`
thi account cu se mat sau restart.

## 3) Kiem tra tunnel Mongo + Redis
Tren moi node:
```bash
nc -z -w2 127.0.0.1 37018 && echo mongo_tunnel_ok || echo mongo_tunnel_fail
nc -z -w2 172.16.10.202 6379 && echo redis_ok || echo redis_fail
```

## 4) Kiem tra user co trong Mongo khong
Tren node (qua tunnel local):
```bash
mongosh --quiet "mongodb://127.0.0.1:37018/game64x64" --eval "db.users.find({email:'YOUR_EMAIL'}).limit(1).toArray()"
```

## 5) Khi login bi `409`
- Day la session conflict (`AUTH_REJECT_CONCURRENT=true`).
- Cach xu ly:
  - Dang xuat o may cu, hoac
  - Admin revoke session user trong `/admin`.

## 6) Khi login bi `429`
- Doi het cua so rate limit, hoac
- Kiem tra Redis o node data.

## 7) Kiem tra can bang LB
- Bao dam LB truyen ve node dang healthy:
```bash
curl -I https://colorbox64x64.online/health
```
- Neu 1 node loi, drain node do truoc khi xu ly.
