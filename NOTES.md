# NOTES — agent-world desk, 2026-11-01 (the reward playtest)

One line per step: what I tried, what happened (the numbers, with the box
state), what I decided next. The box: the Thor, aarch64, 122 GB; the box
**rebooted at ~20:00 UTC today** (42 min uptime when I connected at
20:41 UTC), the world came back at 20:06 UTC; another seat was running a
generation sweep and two zcode seats ran throughout; free memory 45–86 GB.

## The finding, and the chain under it

- 20:47 — Status page: `skill_4c16c6547b52` (scout.sight, "survey the
  ground around") at **reward 0.5, mean 0.5, on all 18,066 plays**, day
  and night. Wrote `ops/reward-audit.py` (committed beside this note) and
  audited every family: the sight skill is the only *constant-high*, and
  two gatherer.wood skills are constant at 1.0 on small counts (7, 37
  plays — real wins, not a defect). The bigger finding: **in the last
  two hours every other skill was constant at 0.0** — 1,855 plays, zero
  wins across all four builders. The last win in the ledger was 17:22Z.
- 20:49 — Read the reward chain: `bots/src/agent.js` `measure()` scores
  predictions `inventory_delta`/`block_placed`/`block_broken`/`moved_to`
  as 1/0; a skill with `predict.kind = "none"` records **partial** with
  `score: null`; `reflex/agent_world_reflex/models.py` `PlayRecord.reward`
  mapped `{win: 1.0, partial: 0.5, lose: 0.0}` — **"we could not measure
  this" became "this wins half the time"**, a fabricated constant, and a
  high one: higher than any working gatherer's true rate (0.28–0.33).
  The sight skill's prediction is `kind: "none"` by design (a survey
  changes nothing the measures can see), so every one of its plays scored
  exactly 0.5. That is the brief's constant.
- Decision: a partial is **not half a win**; it is no measurement. Fix at
  the source: `reward` returns `None` for a partial, and the chooser's
  `update`/`fit` skip `None`-reward records. Test: `tests/test_reward.py`
  — 6 checks FAIL against the old code (e.g. "got 0.5, want None"; the
  old arithmetic also blended one real win with five phantom partials
  into 4/7 ≈ 0.571), all pass against the new one.

## Why every family was constant at 0 (the second disease)

- 20:33–21:00 — The all-lose streak had its own cause. Probes (bots/
  probe-wedge.js, probe-spots.js and five throwaways, deleted):
  - Pebble stood **in water in a cave at (3, 27, −2)**, 48 blocks under
    the depot, since ~16:00Z; every "walk home" timed out at 20 s with
    **zero displacement**.
  - Kite's walk-east had never once moved it: 238 plays, all "the walk
    took too long", all day.
  - A **fresh probe bot** also could not move: raw controls covered
    0.02 blocks in 3 s at the depot plateau; the world border was fine
    (59999968 blocks wide); no mobs stood on anyone; chunks were loaded;
    health and food were 20.
  - A **server-side teleport** freed the same client instantly (it then
    walked 6 blocks east in 3 s). The freeze is spot-local: the bots
    stand wedged against cobble faces — much of it the cobble lines the
    community itself laid while building the wall.
  - The mechanism (probe-wedge.js): under input, mineflayer's physics
    reports the wedged bot **off the ground**, and a jump needs
    `onGround` — so it can never step or jump out, and the pathfinder's
    follower cannot make its first move, so `goto` hangs with no error.
    probe-wedge.js: 58 s on a planner goto, zero movement.
  - Also the judge was dead twice over: after the reboot another seat's
    `serve.d1-2B-old` held the lease on port 8143 while the reflex asked
    8094; then, when the reflex joined it, **480 of 486 asks failed in
    3 ms** — that server answers `/health` but not `/v1/systemone`.
- Decision: three source fixes besides the reward.
  1. `bots/src/api.js` `gotoNear`: a stall watcher (no net progress for
     3.2 s) now buys one nudge — back off, sidestep, stop the planner,
     retry from a clean standstill; after two nudges the walk fails fast
     ("the walk could not start") instead of grinding its whole clock;
     the budget grows 1.5 s per block beyond twelve for far walks.
     Test: `bots/test/goto-near.test.js` with a stub bot that wedges —
     both tests FAIL against the old code (20 s grinds), pass against
     the new (fail in 16.5 s having moved; arrive in 2.4 s).
  2. `reflex/agent_world_reflex/decision.py`: the port is discovered —
     configured port first, then any admission lease serving the model,
     and a candidate counts only if it answers a real `/v1/systemone`
     probe (green `/health` is not enough). Canonical `serve.d1-2B`
     before variants. Test: `tests/test_d1_port.py` (5 checks).
  3. `ops/d1.sh start` brought the world's own d1-2B up on 8094 under
     the admission daemon; the reflex then ran 18 asks with 0 failures,
     mean 51 ms.
- World-ops: the four builders were teleported out of their wedged and
  barren spots (the same tool the docs record from this morning):
  Pebble into the stone quarry pit (0, 66, −8) — surface stone near the
  depot was mined out or is wall cobblestone, which the gatherer's
  search rightly does not count; Sprout to the grass field (−12, 77,
  −20); Timber to the depot edge (5, 72, −12); Kite to open ground
  (16, 71, −20). Probes graded the spots first (probe-spots.js).
- Restarted only the windows whose code changed: viewer, reflex, bots,
  and started d1. **Paper was not stopped.**

## The viewer's NaN errors (brief item 3)

- 20:52–21:10 — Reproduced with `~/lm-tools/playwright/probe.mjs`: **12**
  "computeBoundingSphere(): Computed radius is NaN" console errors per
  load (the director counted ~6). Not entities from the model file: a
  WebSocket-correlated probe showed every NaN fired **before any entity
  spawned**. A temporary patch of the served bundle
  (`ops/patch-bundle-diag.py`, diagnosis only) printed the geometry:
  twelve of them, each **24 positions / 36 indices — one box** — each
  with NaN at position index 1 (a NaN y). That is prismarine-viewer's
  fallback for a **name-less entity**: `BoxGeometry(entity.width,
  entity.height, entity.width)` with undefined width and height. The
  server's `drawable()` forwarded name-less entities because its first
  branch read `!entity.name` as "a departure or a move". 26.1 has
  entities the viewer's 1.21.4 tables do not name.
- Fix: `viewer/src/server.js` `drawable()` leaves name-less entities out
  — the rule the docs already state for model-less mobs, now applied to
  the case that actually produced NaN. Correction in writing: the check
  had been **excusing** the NaN warnings as an empty-section artifact of
  three.js; that was wrong (empty sections have 0 positions, these had
  24), and `ops/check-views.mjs` now fails on *any* console error.
- Verified: `ops/check-views.sh` — all three pages pass, the 3D view's
  line is `ok no console errors`; `probe.mjs` prints no console.error;
  the screenshot shows terrain, a builder, the strip.
- The probe whitelist: `Probe8` added to `ops/world/whitelist.txt` and
  via the console (the probes are the world's own eyes; Probe5 was
  already listed).

## Dead ends, so nobody retries them

- `/data get entity Kite` from the Paper console: "No entity was found"
  — Paper's data command does not read players. Positions came from a
  mineflayer probe instead.
- "The Thor rebooted" as the cause of the freeze: wrong — movement died
  ~16:00Z, before the reboot; the binaries and node_modules are
  unchanged since Oct 31 21:23.
- "A mob parked on the bot" (server pushes overlapping entities): wrong
  — the nearest mob to the frozen spawn was a bat 28 blocks away in a
  cave.
- "A collapsed world border": wrong — 59999968 blocks wide.
- `thor-admit serve d1-2B --port 8094 -- /bin/true` (probing the handoff
  behaviour): the daemon keyed on the command and started a server on
  8094 supervising `/bin/true`; my timeout killed it and no stale lease
  remained (checked `thor-admit status`). Do not probe serve with a
  command that is not the real model server.
- `movements.canSwim` does not exist in the installed
  mineflayer-pathfinder 2.4.5; water is already pathable there
  (`liquidCost`). Pebble could not walk home because the walk could not
  start, not because water is forbidden.

## State at the end of the hour (filled in below)

See `docs/playtest-2026-11-01-reward.md` for the numbers of the one-hour
re-run.

## The hour, measured (22:53 UTC)

- The window 21:53–22:53 UTC: farmer.ground 270 of 271 wins,
  gatherer.stone 164 of 165, scout.ground 20 plays with rewards
  {0.0, 1.0} — its first win ever ("moved 25.2 blocks (wanted 20)",
  22:03:26Z) — and the survey's 1,564 plays all unscored. Judge
  1,828 calls, 0 failures, mean 58.4 ms, on the world's own serve
  (port 8094). Estimates moved on evidence: farmer.ground night
  0.005 → 0.251, gatherer.stone night 0.282 → 0.361.
- Still broken, on purpose of the design: builder.wall 19 plays, 0
  wins ("the wall could not grow" — a placement problem for the
  mediator), and the scout walks lose 19 of 20 in the forest.
- The playtest note with the whole story:
  docs/playtest-2026-11-01-reward.md.

## 2026-11-01, the playable round (Casey 13:40: "playable with the agents live")

- Started 14:19 UTC from the desk brief. The world was already up
  (paper 26.1.2-74, viewer, reflex, four builders, d1 on 8094), the
  tree clean at 3219f47. Killed a leftover hung `node --test
  bots/test/goto-near.test.js` (2 h 06 in --test-timeout=0; it passes
  cleanly in 23 s when actually run, so the hang was the run, not the
  code).
- Built the no-grief ledger (bots/src/humanity.js): a block that
  appears within 6 blocks of a person is theirs; no mining it, no
  mining within 4 blocks of it, no building within 8 unless the person
  said "help me build" (a 10-minute invite); a chest a person placed
  is never opened; players are never attacked. The pathfinder's
  safeToBreak is held to the same rule, so a planned path cannot dig
  through a house either. 14 offline tests pin the rules
  (bots/test/no-grief.test.js, all pass, 81 ms).
- Next: the command table and the duties, then restart reflex+bots
  (service.py gains a family= filter so "gather wood" is the chooser's
  wood family, not a model parsing words), then the probes.

- 15:00 UTC: the crew restarted with the command layer live; the join
  proof passed end to end (TestHuman9: join 0.4 s, greeting 1062 ms,
  moved 9 blocks, chat, broke coarse_dirt, placed it back; the dig
  needed look-first/verify-after — the same lesson as the api's).
  Privacy checked by grep: 0 marked free-text lines in bots.jsonl.
  Say-lines verified through /events to the voices page; check-views
  passes all three pages.
- The command battery found four faults, all fixed (commits e702bdd,
  40e6548, later): duties died instantly (expires was a duration read
  as a timestamp); nearest-routing never fired (a player's position is
  on the entity, not the player list); a paper restart re-armed the
  whitelist at the door (now AW_PLAYTEST=1 keeps it open, said out
  loud at every start); the follow re-planned walks to old positions
  (now GoalFollow holds the person's entity).
- Bedrock, measured: Geyser shipped with transport "nethernet" (WebRTC
  only) so RakNet never answered; set to "both". ViaVersion 5.12.3
  installed (Geyser 2.12.1 targets MC 26.3, the world runs 26.1.2).
  bedrock-protocol 3.59.0 joins the door and is refused: "Please log
  into Xbox" under auth-type online/offline/floodgate, reload and two
  restarts. Anonymous Bedrock is not a thing in this Geyser; signed-in
  devices are the path, and that path is untested here (no device).
- gatherer.wood v11 seeded (searches 96 blocks, steps 24 on failure):
  the night's chopping cleared the spawn forest and v10 searched 24.
  The gather duty now retries from new ground before giving up.
- 01:0x UTC: **the Thor dropped off the LAN mid-run** (ping 100%
  loss from the ProArt while the Orin answers; the box was load ~11,
  86 GB free). Everything since is staged locally. When it returns:
  run the final battery, the grief probe, ops/steady.sh 30, fill the
  playtest note's placeholders, commit.

- 02:33 UTC: the power cut's real wound found and healed: the box died
  between builder-ide's ledger INSERT(id='') and its UPDATE, leaving
  one audit row with an empty id that every later insert of the
  placeholder collided with ("UNIQUE constraint failed: audit.id" on
  every play). One UPDATE healed it; the log of record (bots.jsonl)
  refolded unchanged (41,357 plays). The reflex reloaded, the crew
  rejoined on their own.
- The follow, cracked: mineflayer-pathfinder's GoalFollow with the
  work movements (dig on, parkour off) stalls a few blocks from a
  moving target and never closes (FollowerM2: 13.9 → 8.0 forever);
  with walking movements it closes to 1.3 (FollowerX). And even with
  walking movements, a wedged bot computes paths ("success" every 4 s)
  and never makes the first move — probe-follow, FollowerF2 at 11.6
  blocks. Fixes: a follow now walks with its own movements (no
  digging), and the follow duty watches its own progress and nudges
  itself loose the way gotoNear always has.
- "stop" is now visible: the crew holds still five seconds,
  re-releasing the planner every tick, before taking up its own work.
- gatherer.wood v12 seeded: four 36-block walks, searching after each,
  before admitting there is no tree (the spawn forest is gone; v11
  searched 96 blocks from where it stood and failed three times in one
  battery — a gatherer must go where wood is).
- The last battery (04:26 UTC): what-doing ok, addressed ok, stop ok
  (ack 400 ms, they let go), follow and come ok when the crew is near,
  failing honestly from 35+ blocks of rough ground; gather-wood running
  v12 as this is written. The full table and every earlier run's
  numbers are in docs/playtest-2026-11-02-playable.md.
- 06:0x UTC: the endgame numbers. The grief proof complete under the
  rule: TestHumanH placed 2 coarse_dirt with Timber working 4 blocks
  away, the ledger recorded both placements as they landed, and both
  stood after the watch (2 of 2; an earlier run held 2 of 2 at crew
  distance 13-35). The steady half hour: 62 samples, TPS 63/63 >= 19.5
  (min 19.9, median 20.0, reconstructed from paper.log by
  ops/tps-window.sh), MemAvailable min 78.9 GB, d1 running mean
  3.7 -> 6.0 ms (single-digit under a person plus my probes, load
  13-28). The playtest note docs/playtest-2026-11-02-playable.md holds
  the tables and the honest limits (carry-on unwitnessed, the depot
  pile race, the deforested spawn, the pit-stranded crew — the
  mediator's list).


## 2026-11-02, the community round (Casey 2026-11-01: "leave and have the community developing while you are gone")

- 06:19 UTC — The box was up 4:53 h (load 22–29, another seat's
  voyager-port sandbox under thor-admit; 88 GB free). Paper, viewer,
  reflex and the four builders were already running — but **d1 was
  down**: the reflex's every model call had failed since its start
  (634/634 at 2.5 ms). `ops/d1.sh start` brought it up on 8094; 29
  calls later only 2 failures (the race at startup), then clean.
  TPS 20.0/20.0/20.0, crew + Watcher in the world.
- Built the community loop, all offline-tested (31 new checks, the
  full suite 48/48 in 21 s): the **board** (`bots/src/board.js`, an
  append-only event log `runtime/logs/board.jsonl` replayed into
  state, snapshot `runtime/board.json`, the manifest fingerprint), the
  **validator** (`bots/src/validator.js` — a local rule table with
  builder-ide core/precedent's exact interface, since that repo is not
  merged here; every project proposal and every structural edit passes
  it), the **council** (`bots/src/council.js` — deterministic order of
  need: chest, forest, farm, path, shelter; a DeepInfra model may
  *propose* when the needs are met, never decide), the **world look**
  (`bots/src/worldlook.js` — the council's eyes, honest about unloaded
  chunks) and the **executors** (`bots/src/projects.js` — idempotent
  plan-walkers per role; the scout tests finished work and files
  issues; the gatherer supplies materials to sites).
- The playtest's known failures, fixed at the source: the **depot
  pile race** (leave_at_depot/take_from_depot now use the depot chest
  first — placed by the depot-chest project, the council's first
  need), **depth-minding** (api.dig refuses below y=48 — the planner
  may still dig upward to escape a pit; skill g14 "surface stone"
  seeded as gatherer.stone v9, searching y≥50), and the **gone
  forest** (a replant project: saplings from leaves, planted on the
  plan; scope 8 spots).
- Humans: the greeting now says what the community is building
  (board.headline()) and offers a hand in it; new commands
  `what are you building?`, `build a farm`, `plant trees`,
  `build a chest`, `build a shelter` — a person's request becomes a
  proposal through the same validator (a deny is said plainly).
