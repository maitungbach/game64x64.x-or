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
