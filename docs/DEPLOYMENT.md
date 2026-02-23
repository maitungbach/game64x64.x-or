# Deployment Guide (1 VPS)

## 1. Chuan bi VPS Ubuntu
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

## 3. Chay app voi PM2
```bash
mkdir -p logs
pm2 start config/ecosystem.config.js
pm2 save
pm2 startup
```

Kiem tra:
```bash
pm2 status
curl http://127.0.0.1:3000/health
```

## 4. Cau hinh Nginx reverse proxy
```bash
sudo cp deploy/nginx.game64x64.conf /etc/nginx/sites-available/game64x64
sudo ln -s /etc/nginx/sites-available/game64x64 /etc/nginx/sites-enabled/game64x64
sudo nginx -t
sudo systemctl reload nginx
```

Neu can, xoa default site:
```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl reload nginx
```

## 5. Mo firewall
```bash
sudo ufw allow 80/tcp
sudo ufw allow 22/tcp
sudo ufw enable
```

## 6. Verify sau deploy
```bash
curl http://<SERVER_IP>/health
```

Mo trinh duyet: `http://<SERVER_IP>` va test 2-3 tab.
Trang quan tri: `http://<SERVER_IP>/admin`.

## Lenh van hanh nhanh
```bash
pm2 logs game64x64
pm2 restart game64x64
pm2 stop game64x64
```

## Ghi chu cho buoc HA (2 server)
- Khi nang cap nhieu node, bat `ENABLE_REDIS=true` va cau hinh `REDIS_URL`.
- Dung file `deploy/nginx.game64x64.lb.conf` cho load balancer.
- Xem huong dan day du tai `docs/DEPLOYMENT-HA.md`.
