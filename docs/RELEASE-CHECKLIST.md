# Release Checklist

Checklist nay dung truoc moi lan deploy hoac restart dich vu.

## Truoc khi release
- Cap nhat `.env` dung gia tri cho `PORT`, `REDIS_URL`, `MONGO_URL`, `ADMIN_EMAILS`, `STATS_TOKEN`.
- Xac nhan `NODE_ENV=production` tren node thuc te.
- Neu chay multi-server, kiem tra `ENABLE_REDIS=true` va Redis/Mongo khong tro ve loopback sai muc dich.
- Chay `npm run lint`.
- Chay `npm run test:all`.

## Truoc khi cut over
- Kiem tra PM2 status xanh tren cac app node.
- Neu co load balancer, drain node truoc khi restart.
- Backup nhanh `.env` va ghi lai commit/branch dang deploy.

## Sau khi deploy
- Kiem tra `GET /health` tra `200`.
- Kiem tra `/api/stats` bang `STATS_TOKEN` hoac admin session.
- Dang nhap `/auth.html`, vao `/game.html`, mo them `/admin`.
- Thu lookup user va revoke session tren admin panel.
- Xac nhan realtime van connect/move/disconnect duoc.

## Rollback
- Quay lai commit truoc do.
- Khoi phuc `.env` neu release vua sua cau hinh.
- Restart PM2 voi `--update-env` neu can.
- Kiem tra lai `/health`, `/api/stats`, `/admin`.
