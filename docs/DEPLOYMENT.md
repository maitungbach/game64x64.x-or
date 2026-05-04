# Deployment Guide (1 VPS)

## 1. Chuẩn bị VPS Ubuntu
```bash
sudo apt update
sudo apt install -y nodejs npm git nginx
sudo npm install -g pm2
```

## 2. Lay source code
```bash
git clone <REPO_URL> game64x64
cd game64x64
npm install
```

## 3. Chạy app với PM2
```bash
mkdir -p logs
pm2 start config/ecosystem.config.js
pm2 save
pm2 startup
```

Kiểm tra:
```bash
pm2 status
curl http://127.0.0.1:3000/health
```

## 4. Cấu hình Nginx reverse proxy
```bash
sudo cp deploy/nginx.game64x64.conf /etc/nginx/sites-available/game64x64
sudo ln -s /etc/nginx/sites-available/game64x64 /etc/nginx/sites-enabled/game64x64
sudo nginx -t
sudo systemctl reload nginx
```

Nếu cần, xóa default site:
```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl reload nginx
```

## 5. Mở firewall
```bash
sudo ufw allow 80/tcp
sudo ufw allow 22/tcp
sudo ufw enable
```

## 6. Verify sau deploy
```bash
curl http://<SERVER_IP>/health
```

Mở trình duyệt: `http://<SERVER_IP>` và test 2-3 tab.
Trang quan tri: `http://<SERVER_IP>/admin`.

## Lệnh vận hành nhanh
```bash
pm2 logs game64x64
pm2 restart game64x64
pm2 stop game64x64
```

## Ghi chú cho bước HA (2 server)
- Khi nâng cấp nhiều node, bật `ENABLE_REDIS=true` và cấu hình `REDIS_URL`.
- Dùng file `deploy/nginx.game64x64.lb.conf` cho load balancer.
- Xem hướng dẫn đầy đủ tại `docs/DEPLOYMENT-HA.md`.
