# Sơ đồ luồng game 64x64 - Tóm tắt

## 🎮 Một ván game (60 giây)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  [SERVER KHỞI ĐỘNG]  Port 5003                                               │
│         │                                                                   │
│         ▼                                                                   │
│  [NGƯỜI CHƠI KẾT NỐI] → Mở game.html                                      │
│         │                                                                   │
│         ▼                                                                   │
│  [TẠO/VAO PHÒNG]    (max 4 players)                                        │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │ HOST NHẤN "BẮT ĐẦU GAME"                                 │             │
│  └───────────────┬──────────────────────────────────────────┘             │
│                  │                                                         │
│                  ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 🚀 KHỞI TẠO GAME                       (60 giây)                        ││
│  │ • status = "playing"                                               │  ││
│  │ • endsAt = now + 60s                                               │  ││
│  │ • Spawn 25-35 collectibles ngẫu nhiên                            │  ││
│  │   (COIN 50% /1điểm │ GEM 30% /2điểm │ STAR 15% /3điểm │             │  ││
│  │    DIAMOND 5% /5điểm)                                             │  ││
│  │ • Broadcast tất cả collectibles tới clients                      │  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                  │                                                         │
│                  ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ ⏱️  GAMEPLAY LOOP (60 GIÂY)                                             ││
│  │                                                                         ││
│  │   ┌────────────────────────────────────────────────────┐              ││
│  │   │ PLAYER DI CHUYỂN (WASD / MŨI TÊN)               │              ││
│  │   └───────────────┬────────────────────────────────────┘              ││
│  │                   │                                                    ││
│  │                   ▼                                                    ││
│  │   ┌────────────────────────────────────────────────────┐              ││
│  │   │ SERVER NHẬN 'move'                                │              ││
│  │   │ • Validate vị trí                                 │              ││
│  │   │ • Cập nhật x, y                                   │              ││
│  │   └───────────────┬────────────────────────────────────┘              ││
│  │                   │                                                    ││
│  │                   ▼                                                    ││
│  │   ┌────────────────────────────────────────────────────┐              ││
│  │   │ KIỂM TRA VỊ TRÍ MỚI CÓ COLLECTIBLE?               │              ││
│  │   └───────────────┬─────────────────────┬──────────────┘              ││
│  │                   │                     │                           ││
│  │         ┌─────────┘        NO          └─────────┐                   ││
│  │         ▼                                      │                   ││
│  │   ┌────────────────┘                           ▼                   ││
│  │   │ COLLECT!                                     ┌───────────────┐ ││
│  │   │ • Xóa collectible khỏi map                  │ TIẾP TỤC      │ ││
│  │   │ • +points (tùy loại)                        │ DI CHUYỂN     │ ││
│  │   │ • Broadcast:                                │ (không điểm) │ ││
│  │   │   - collectiblePickedUp                     └───────────────┘ ││
│  │   │   - roomScoreUpdate (leaderboard mới)                         ││
│  │   │                                                                 ││
│  │   │ • Sau 1.2s: respawn collectible mới                          ││
│  │   │   (weighted random)                                           ││
│  │   └────────────────┘                                               ││
│  │                  │                                                 ││
│  │                  └────────────────────────────────┬───────────────┘│
│  │                                                             │         ││
│  └─────────────────────────────────────────────────────────────┬─────────┘│
│                  │                                                 │        │
│                  ▼                                                 │        │
│  [CLIENT RENDER mỗi frame]                                       │        │
│  • Vẽ grid + collectibles (pulse)                              │        │
│  • Vẽ players (lerp)                                           │        │
│  • Update timer, leaderboard                                   │        │
│                  │                                              │        │
│                  └───────────────────────┬──────────────────────┘        │
│                                          │                             │
│                                          ▼                             │
│  [KIỂM TRA TIMER] ────────NO───────> [Loop lại]                        │
│         │                                                               │
│        YES                                                              │
│         │                                                               │
│         ▼                                                               │
│  ┌────────────────────────────────────────────────────────────┐         │
│  │ ⏰ HẾT THỜI GIAN (60s)                                     │         │
│  └───────────────┬────────────────────────────────────────────┘         │
│                  │                                                      │
│                  ▼                                                      │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ 🏁 KẾT THÚC GAME                                           │        │
│  │ • Sort leaderboard theo score DESC                         │        │
│  │ • winningScore = điểm cao nhất                            │        │
│  │ • Broadcast roomEnded({leaderboard, winningScore})        │        │
│  └───────────────┬────────────────────────────────────────────┘        │
│                  │                                                     │
│                  ▼                                                     │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ 🎉 HIỂN THỊ NGƯỜI THẮNG                                   │        │
│  │ "🏆 [Tên] thắng với X điểm!"                               │        │
│  └───────────────┬────────────────────────────────────────────┘        │
│                  │                                                     │
│                  ▼                                                     │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ 🔄 RESET ROOM                                              │        │
│  │ • status = "idle"                                          │        │
│  │ • Clear collectibles                                       │        │
│  │ • Sẵn sàng ván mới                                        │        │
│  └────────────────────────────────────────────────────────────┘        │
│                                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📌 Luồng socket events (tóm tắt)

```
Client A              Server                 Game Service               Client B
   │                     │                         │                       │
   ├─ connect ──────────>│                         │                       │
   │<─ socket.id ────────│                         │                       │
   │                     │                         │                       │
   ├─ joinRoom ─────────>│                         │                       │
   │                     ├─ addPlayer ────────────>│                       │
   │                     │<─────────────────────────┤                       │
   │<─ roomJoined ───────│                         │                       │
   │                     │                         │                       │
   ├─ (Host) startRoom ─>│                         │                       │
   │                     ├─ startRoomGame ────────>│                       │
   │<─ roomStarted ──────│                         │                       │
   │<─ updateCollectibles│                         │                       │
   │                     │                         │                       │
   ├─ move(direction) ──>│                         │                       │
   │                     ├─ movePlayer ────────────>│                       │
   │                     │<─────────────────────────┤                       │
   │                     ├─ checkCollectible ──────>│                       │
   │                     │                         ├─ check x,y            │
   │                     │<─────────────────────────┤                       │
   │                     │                         │                       │
   │                     │    (Nếu có collectible) │                       │
   │                     ├─ addRoomScore ──────────>│                       │
   │                     │                         └───────────┬───────────┤
   │                     │                                         │       │
   │                     ├─────────────────────────────────────────┤       │
   │                     │                                         │       │
   │<─ collectiblePickedUp│                                        │       │
   │<─ updateCollectibles │ (respawn sau 1.2s)                    │       │
   │<─ roomScoreUpdate   │                                        │       │
   │                     │                                         │       │
   │                     │                                         │       │
   ══════════════════════════════════════════════════════════════════       │
   │                     │                                         │       │
   │                     │◄── timer check ────────────────────────┤       │
   │                     │   (endsAt reached?)                   │       │
   │                     │                                         │       │
   │<─ roomEnded ────────│                                         │       │
   │  {leaderboard}      │                                         │       │
   │                     │                                         │       │
   │  HIỂN THỊ WINNER    │                                         │       │
   │                     │                                         │       │
   │                     ├─ resetRoom ─────────────────────────>│       │
   │                     │                         (clear data) │       │
   │                     │                                         │       │
   ──────────────────────╨═══════════════════════════════════════════════   │
                                                                           │
   (Các client khác nhận cùng events và render giống nhau)                │
```

---

## 🎯 Scoring logic (đơn giản)

```
Player di chuyển đến cell (x,y)
         │
         ▼
┌─────────────────────────┐
│ checkCollectiblePickup │
│ (x, y, playerId)       │
└───────────┬─────────────┘
            │
    ┌───────┴───────┐
    │               │
  CÓ            KHÔNG CÓ
    │               │
    ▼               │
┌─────────────────┐  │
│ +points (1-5)   │  │
│ (tùy loại)      │  │
└────────┬────────┘  │
         │           │
         ▼           │
   [Broadcast]      │
   & respawn 1.2s   │
         │           │
         └───────────┘
         │
         ▼
   [Leaderboard cập nhật]
```

---

## 📊 Collectibles tỉ lệ spawn

```
Weighted Random (tổng = 100):
│
├─ 0-49   (50%)  → COIN  (1 điểm, 🟡 vàng)
├─ 50-79  (30%)  → GEM   (2 điểm, 🟢 xanh)
├─ 80-94  (15%)  → STAR  (3 điểm, 🔴 đỏ)
└─ 95-99   (5%)  → DIAMOND (5 điểm, 🔵 xanh ngọc)

Mỗi lần spawn: randomInt(0,99)
```

---

**TL;DR:**

```
JOIN ROOM → START → [COLLECTIBLES SPAWN] → PLAY 60s (di chuyển → thu thập → +điểm)
        → [COLLECTIBLES RESPAWN SAU 1.2s] → HẾT THỜI GIAN → AI NHIỀU ĐIỂM NHẤT THẮNG
```

**Server:** `http://localhost:5003`  
**Test account:** `tester01@example.com / Test123!`
