# chutes

Public Chutes & Ladders game: https://chutes.129-158-253-250.sslip.io (no login, by owner request).

- **On this screen:** 1 to 6 players on one device. Pick a character and a name per player, then Play (autoplay with an adjustable 0 to 5 s interval), Pause, or Step. Pure client-side.
- **Online room:** create a room, share the link (`?room=CODE`). Each person joins from their own device with a name and character and spins on their own turn. The host starts and restarts rounds, can spin for an absent player, and can turn on auto-spin after N seconds of waiting.

## Pieces

| Path | What |
|---|---|
| `server.py` | Stdlib HTTP server. Serves `static/` and the room API. Server-authoritative: it rolls every spin (SystemRandom), owns turn order, and gates the next spin until the last animation finished (`readyAt`). |
| `static/index.html` | Whole client: SVG board, spinner, token animation, both modes. |
| `static/chars.js` | 45 characters as 96px WebP data URIs (amiibo renders for game characters, Wikipedia thumbnails for movie and TV). Nothing hotlinks. |
| `data/rooms.db` | SQLite room store (gitignored). Rooms idle for `CHUTES_ROOM_TTL_HOURS` are dropped. |

Clients poll `GET /api/rooms/CODE?v=N` (1 s visible, 4 s hidden) instead of WebSockets, because the owner's corporate proxy blocks WebSockets. Identity is a random 32-hex id in localStorage sent as `X-Client-Id`; nothing else is stored about visitors.

API: `POST /api/rooms {char, name}` creates (creator is host and player 1). `POST /api/rooms/CODE/<action>` with `join {char, name}`, `char {seat, char}`, `name {seat, name}`, `leave {seat}`, `start`, `lobby`, `spin {expect}`, `settings {autoSpin}`.

Limits: 6 seats per room, 20 room creations per IP per 10 min, 1000 live rooms, 2 KB bodies, names 20 chars.

## Run

Env: `CHUTES_HOST` (127.0.0.1), `CHUTES_PORT` (8791), `CHUTES_DATA_DIR` (./data), `CHUTES_ROOM_TTL_HOURS` (24), `CHUTES_MAX_ROOMS` (1000).

Unit: `systemd/oak-chutes.service` (symlinked into `~/.config/systemd/user/`). Caddy block `chutes.129-158-253-250.sslip.io` reverse-proxies to 127.0.0.1:8791.

```
systemctl --user restart oak-chutes
curl -s https://chutes.129-158-253-250.sslip.io/healthz
```
