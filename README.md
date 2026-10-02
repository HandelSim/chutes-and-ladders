# Chutes & Ladders

Public party version of Chutes & Ladders: https://chutes.129-158-253-250.sslip.io (no login, by owner request).
Every change is a commit here; releases are tags (`v1.0.0` is the original autoplay game).

- **On this screen (local):** 1 to 6 seats on one device, each seat Human or CPU. Humans spin (and choose
  abilities) themselves; CPU seats play on their own. Hot-seat minigames ("Pass to <name>").
- **Online room:** create a room, share the link (`?room=CODE`). Everyone joins from their own device, picks a
  name and character, and plays their own turns and minigames. The host can mark absent players as CPU.
- **Board:** random by default (re-roll or Classic before the game starts). Arrows on every row show the
  direction of travel.

## Abilities

Every character has one ability (flavor name per character, see `CHAR_AB` in `rules.py`). Using one costs a
charge. You start with 1 charge, hold at most 2, and earn one by sliding down a chute or winning a minigame.
Abilities switch off after round 50 (overtime) so long games finish.

```
Double Spin    spin twice, move the total
Lucky Spin     spin 3 times, keep the best
Pick a Number  costs 2 charges: choose your spin, 1 to 3
Chute Shield   the next chute you land on does nothing, then spin
Swap           trade places with the nearest player ahead (up to 18 squares) instead of spinning
Quake          everyone ahead of you drops back up to 10 squares (never behind you), then spin
```

Balance is checked with `sim.py` (CPU policy vs CPU policy, classic and random boards, 2 to 6 players):
every ability lands within roughly 0.85x to 1.2x of a fair win share.

## Minigames

Every 3 rounds (setting: off, or every 1 to 10 rounds) everyone plays a short minigame. 1st moves +3 squares,
2nd +2, 3rd +1, last stays put; the winner also gets +1 charge. CPU seats get a simulated score.

```
Needle Stop    stop the needle in a shrinking green zone, 5 tries
Quick Draw     tap the instant SPIN! appears, ignore the decoys, 4 rounds
Pad Recall     repeat a growing pad sequence, one mistake ends it
Head Count     count one character in a 2 s crowd flash, 3 rounds
Ladder Gamble  climb rung by rung for points, bank before it breaks
Chute Dodge    steer between 3 lanes down a chute for 12 s
```

## Pieces

```
server.py               stdlib HTTP server: static files, room API, minigame timing, build id
rules.py                the whole game engine (turns, abilities, boards, minigame payout, CPU choices)
sim.py                  balance simulator for rules.py
suggest.py              suggestion box intake (screening, rate limits, status feed)
static/index.html       the client (SVG board, animations, ability UI, minigame overlay, update pill)
static/chars.js         45 characters as embedded WebP data URIs (nothing hotlinks)
static/minigames/*.js   the six minigames (two per file)
data/                   SQLite rooms + suggestions (gitignored)
```

The server is authoritative: it rolls every spin, owns turn order and applies abilities. Clients poll
`GET /api/rooms/CODE?v=N` (no WebSockets: the owner's corporate proxy blocks them). Identity is a random
32-hex id in localStorage sent as `X-Client-Id`.

Every response carries a `build` id (hash of the code). When it changes, open pages show an "Update
available" button at the top right instead of reloading in the middle of a game.

## Run

Env: `CHUTES_HOST` (127.0.0.1), `CHUTES_PORT` (8791), `CHUTES_DATA_DIR` (./data), `CHUTES_ROOM_TTL_HOURS` (24),
`CHUTES_SOLO_TTL_HOURS` (6), `CHUTES_MAX_ROOMS` (1000).

```
python3 server.py                     # local
python3 sim.py                        # balance report
systemctl --user restart oak-chutes   # production (unit lives in the oak repo)
curl -s https://chutes.129-158-253-250.sslip.io/healthz
```

Release: merge to `main`, tag `vX.Y.Z`, restart the unit. Roll back: `git checkout vX.Y.Z` (or revert) and
restart.
