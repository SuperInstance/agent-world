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
