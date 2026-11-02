# playtest 2026-11-02: the community round, day one — the loop that could not finish, and the block that ended it

**Where:** `~/lm-wt/agent-world`, branch `community-loop` · **When:** 2026-11-02, 06:19–13:40 UTC (this seat: 09:30 onward) · **Live:** Paper 26.1.2 on the Thor, LAN-only, whitelist off, people may join any time

Casey's ask (2026-11-01): *"the main thing is to be able to leave and have the community developing while you are gone."* This note is the first day of trying: what the loop did unattended, every fault the day exposed, the one block that finally stood, and what is still open.

---

## 1. What a returning human saw, hour by hour

The numbers are from `ops/community-watch.sh` (a sample a minute into `runtime/logs/community-20261102.csv`, hourly rollups in `community-20261102.summary`); the board is the append-only `runtime/logs/board.jsonl`.

| hour (UTC) | done | active | blocks in scope | pauses | TPS | MemAvail min | box load |
|---|---|---|---|---|---|---|---|
| 08:28 | 0 | 2 | 0 | 1 soft | 20.0 | 69.7 GB | 28 |
| 09:30 | 0 | 1 | 0 | 1 soft | 20.0 | 69.7 GB | 23 |
| 10:33 | 0 | 2 | 0 | 1 soft | 20.0 | 69.7 GB | 16 |
| 11:37 | 0 | 2 | 0 | 0 | 20.0 | 69.7 GB | 12 |
| 12:40 | 0 | 2 | 0 | 0 | 20.0 | 69.7 GB | 5 |
| 13:36 | **1** | 1 | **1** | 0 | 20.0 | 69.7 GB | 5 |

Every TPS sample of the day ≥ 19.5 (min 20.0; the 12:40 rollup counts 240/240). No visitor griefed and nothing of the crew's touched a visitor's build: the two blocks a test human placed at 06:01 still stand, and the ledger recorded no third player build. The board saw 20 proposals (all validated — 16 denies before the keep-out fix of the first hour, allows after), 4 started, 8 material deliveries, 1 project walked and **done at 13:02:59** — b037, a chest at the depot, 1/1 blocks, proposed by the council at 09:32:45 on the farm-plot ring, supplied by the gatherer, placed by the builder, passed by the scout 24 s after the hand-off was wired.

A returning human at 13:40 finds: the greeting naming the work (a chest done, a farm in progress), Pebble cutting terrace spruce and breaking fern for seeds, Sprout at the farm grinding short_grass for wheat seeds ("grass broken, no seeds yet" — each break drops seeds an eighth of the time), Kite surveying, Timber free after the chest. And a chest at the depot that holds what the crew drops there.

## 2. Why nothing finished for six hours

The loop ran all day — council, validator, owners, watcher, all live — and finished nothing until 13:02. Six faults, each measured, each fixed in its turn (commits `14ce3f6`, `4becf2d`, `3346099`; the log of record carries the evidence, NOTES.md the narrative):

1. **The supervision held its own silence.** A soft hold lasts 30 min; the drift signals look back 15. A lapsed hold always re-tripped the alarm its own silence fed, and the gatherer was re-held within one window of every lapse (09:49, 10:24 — the second for a window where it had played 24 supply steps and idled nothing). And every project play scored `partial` (prediction kind none), so the success signal sat undefined all morning. Now: a soft hold is not enforced on an agent that played or stands aside (31 exemptions by 13:40, zero holds enforced since 10:31), and a duty's own result is honored — a mined, staged, or delivered supply step is the win it is.
2. **The hunt was blind in a window.** The gatherer stood in the depot gully (y61) while every standing log sat at y64–73; cd0a7f9's `max_y: feet+2` held zero logs. The band is feet+12 now, candidates come nearest-first, refusals are remembered ten minutes, and the dig goes directly (api.dig's best-effort approach) the way the library skill always did — the one way wood actually moved all day.
3. **The follower that could not start.** The pathfinder's follower sticks at a 1-up step — moving, mining nothing, feet never advancing — until a nudge realigns it (a lone probe needed two, then arrived in 13.2 s). Walks now carry five nudges, a dig under way counts as progress, and a dig-range goal replaced adjacency. The gully floor still defeats climbs from inside — open work.
4. **Invisible drops.** A dropped item is an entity of type `other` named `item`; the kind lives in metadata nobody read (`bots/probe-drop-fields.js`). Every item look was blind — the depot pile's ring never walked, the site pickup saw nothing — while deliveries despawned on their five-minute clock and the board kept saying "staged" (`bots/board-unstage.js` re-opens a lied-to project).
5. **The bench that was never there.** "there is no recipe for chest" with eight planks in hand: a 3×3 recipe needs a crafting table and `recipesFor` was never given one. `api.craft` finds a bench within 16; `ensureBench` crafts one from four planks and places it when the world has none.
6. **The test that could never be scheduled.** `board.sendToTest` had no caller — owners said done forever and the scout's walk, the only road to `done`, was never offered. `service()` hands a finished plan to the tester now; b037 closed 24 s later.

One more version fact closed the farm's seed hunt: this Minecraft's seed-bearing plant is **short_grass** (`grass` is not in the registry; the only `tall_grass` within 96 of the depot stands at y43, thirty blocks down). Both seed fetches search `short_grass`/`fern` now, and the crew grinds them honestly.

## 3. What the operator's hand did (the debt)

The console teleported Pebble out of the gully twice (a tp does not survive a restart) and Timber beside the chest site after six placement timeouts; and the console gave Timber one chest and Sprout four oak logs in all — seeds for a supply chain whose deliveries had despawned through the blind-handoff days. The world owes itself one chest and four logs; the chest now standing is the durable handoff surface that makes the debt payable — `leave_at_depot`/`take_from_depot` prefer it, and items in a chest do not despawn.

## 4. Open, honestly

- **The gully.** Walks from the gully floor still cannot climb out (the follower's step-stick beats five nudges there); every restart puts the gatherer back at the bottom. The depot ground itself is the fault line — the chest site needed a tp to place from.
- **Pebble's delivery disconnects.** Two "lost connection: Disconnected" at exactly delivery moments (12:13:20, 12:30:04) — unexplained; the rejoin covers it in ten seconds but eats the play's outcome row.
- **The farm's seed grind.** 14 seeds at a one-eighth drop rate is ~an hour of grass-breaking; the hoe and bench are done, the farmland waits on seeds. The council's farm bill also under-counts the bench (one log billed, eight planks needed) — the bill should say two.
- **The drift gate's "success rose".** The 06:45 alarm fired because Pebble's success rate *improved* too fast; the exemption keeps it from biting a working agent, but the gate's semantics for a working crew deserve their own look.
- **The deforested spawn** stands as the playtest left it: oak gone, two hillside spruces and terrace singles left (60 trunk blocks within 64). The replant project has not been proposed yet — the council's need list still sees enough wood. When the singles are gone it will.

## 5. How to reproduce every number

`ops/community-watch.sh` (the CSV and rollups), `ops/drift-watch.sh` (the watcher log: holds, exemptions), `runtime/logs/board.jsonl` (every proposal, delivery, test, done), `runtime/logs/bots.jsonl` (every decision and outcome, the drift fold's source), `bots/probe-*.js` (the day's probes: crew positions, wood stock, follower state, drop fields, needs), `bots/board-unstage.js`. The suite: `cd bots && ../runtime/node/bin/node --test` — 50/50 in ~21 s at every commit of the day.
