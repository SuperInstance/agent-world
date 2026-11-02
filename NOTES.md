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

- 06:41–07:47 UTC — The loop's first live hour, and what it taught:
  the world held TPS 20.0 while the council proposed, the validator
  denied, and the crew worked. Six faults found and fixed (commit
  follows): the blanket keep-out handed a departed visitor's two
  blocks a veto over the whole depot (site searches exclude that
  ground now; the coarse deny fires only on a block inside the
  site; denied kinds cool 30 min); the chest scope floated a block
  and billed a finished chest; the library gather skills drop
  everything at the depot so a supply run through them carried
  nothing (the supply fetch gathers straight into the bag);
  oak/spruce is one family to a delivery; "mined" is not "holding"
  (the hillside spruces are a climb the planner refuses — walk
  first, dig only where you stand, `exclude` the refusals); and the
  pit still owned all four builders (Pebble y=8, Timber y=48, Kite
  y=32, Sprout y=64 — lifted by console tp; the pathfinder now holds
  the y=48 floor too, with an escape clause for a builder already
  deep).
- 07:43 UTC — **the drift detector's first live hold**: Pebble's
  success-rate signal fired, the watcher wrote the soft hold to the
  pause file, the reflex refused its asks ("paused: drift pause
  (soft)"), and — once the bots learned to read the pause file too —
  Pebble held its own work with a `drift_hold` note. The whole of
  §3.5's soft level, live and unattended.
- The watchers are detached: `ops/drift-watch.sh` (one window every
  5 min, soft enforced, tier/hard dry-run) and
  `ops/community-watch.sh` (a sample a minute into
  runtime/logs/community-20261102.csv, hourly rollups).
- An honest correction (DOC-RULES 5): the playtest note's "the
  deforested spawn" stands for oak — but the world is not woodless;
  two mature spruces stand 6 blocks from the depot (506 log blocks
  within 96, probe-wood.js). The first probe read "no wood" by
  scanning before its chunks settled, and the level-bound search
  could not see trunks 8 blocks up a hill. Both lessons are in the
  g15 seed's provenance.

- 09:30 UTC — Picked up mid-diagnosis (the seat stopped with api.js's
  nearest-first ordering and worldlook's farm-plot ring uncommitted and
  undeployed). probe-farmland vindicated the look: `farmlandNear`
  answered **no** honestly (0 farmland in 56 blocks, registry id 208);
  the farm need was real and the proposal was dying at `farmPlot` —
  every candidate centre sat on the keep-out ground. Deployed both
  fixes (suite 50/50 in 21 s): at 09:32:45 the council proposed
  **b044** with its site on the ring at (-10, 0), the validator
  allowed it, and the farmer took it up. The ring works.
- 09:43–09:49 — Pebble, back from the 09:13 soft hold's TTL, hunted
  blind: "no tree within reach of the depot", every 11 s. The facts
  (probe-crew-wood.js, new): Pebble/Timber/Kite stand in the depot
  gully at **y=61–62**; every standing log sits at **y=64–73** (the
  terraces) with the spruce canopy at y=83–86 — cd0a7f9's
  `max_y: feet+2` window contained **zero** logs. The community
  starved on a window. Widened the band to **feet+12** (a terrace or
  two up, never the canopy; the nearest-first ordering tries the
  gully-edge logs long before any climb). Suite 50/50.
- 09:49:06 — before the patched hunt ever ran, the watcher enforced a
  fresh soft hold on Pebble (success signal, TTL 30 min → lapses
  10:19). Read the fold to know if the loop converges: a held bot's
  asks are recorded as **yields, not scored plays** (service.py: "a
  held bot is a yield, not a failure"), and `partial` steps are
  unscored — so a hold does not depress the success rate by itself;
  the pool recovers when real wins return. Watching the 10:19 lapse
  with the patched hunt behind it.

- 10:26–10:58 — the doom loop named and broken. The watcher held
  Pebble again at 10:24, one window after the 10:19 TTL lapse — for
  the silence the 09:49 hold itself had made (the stall lookback is 15
  min, the TTL 30: a lapsed hold always re-trips). And the fold read
  again: refusals are yields, not scored plays, so Pebble's pool of
  wins sat empty all morning — every project play scored 'partial'
  (predict kind none). Two changes: **the watcher does not enforce a
  soft hold on an agent that played in the window** (plays or a
  drift.yield explain it; ops/drift-watch.py, "soft hold not
  enforced" — live from 10:31), and **a duty may carry its own
  result** — a supply step that mined, staged, or delivered is a won
  play (agent.js honors result.result; the hunt and the fetches say
  win).
- 10:54–11:19 — the walk itself, dissected with the repo's own
  gotoNear driven from probes (probe-walkstate.js, probe-path.js):
  the follower sticks at a 1-up step reporting moving=true with zero
  displacement until a nudge frees it (a lone probe needed two, then
  arrived in 13.2 s); the crew's walks died at three nudges. Five
  now (the wedged-walk test's bound honestly re-measured: ~23 s
  against a 20 s budget). A dig under way counts as progress in the
  stall watcher. The hunt's walk aims at dig range (3), not
  adjacency (2) — a GoalNear(2) into an embedded log searches
  forever. The refusals are remembered ten minutes (HUNT_MEMORY):
  the five nearest candidates to the gully floor were three keep-out
  refusals and two walk failures, re-bought every step, the sixth
  candidate — the nearest ALLOWED log — never reached.
- 11:19 — Pebble lifted by console tp to the farm site (-10,70,0):
  **four spruce logs mined** (result win) — the hunt works from
  terrace ground. But "mined" was not "held": collectAt gave up when
  the walk to the block's own cell failed, never chasing the drop
  (it now breaks to collectEntity). Two logs each went to b037/b044
  as tosses at 11:26 — and **despawned** (5-min item life) before
  any owner stepped over them: the board said "staged", the world
  held nothing. board-unstage.js re-opens a lied-to project; the
  delivery now walks to distance 1 before the toss; the owners
  pickup_near their site before waiting.
- Not yet true: a chest placed, a hoe crafted, a farm planted. The
  chain that remains: Pebble's walks fail from the gully floor (the
  restart put it back there; the tp does not survive a restart), and
  the 5-minute despawn races the owners' 13–45 s project-step
  cadence — the library gather drops logs in the pile, Timber takes
  them only if its project step is chosen inside the window. The
  depot chest (b037) is the fix for its own delivery problem; it has
  not closed yet.

- 12:13–13:03 — the chain closed, one block at a time. The deliveries
  kept dying at the toss: the toss landed neither at the site nor the
  pile (the delivery walk's distance-1 goal exploded like the hunt's
  distance-2; now distance 2 with a pile fallback, and the outcome
  says where it landed). Pebble disconnected at two delivery moments
  (12:13:20, 12:30:04 — "lost connection: Disconnected" in paper.log
  at exactly the materials events; unexplained, open). Then the sight:
  **a dropped item is type "other", name "item"** — the kind lives in
  metadata nobody read (probe-drop-fields.js). Every item look was
  blind: the pile look never walked its ring, pickup_near saw nothing.
  Then the bench: "no recipe for chest" — recipesFor needs a crafting
  table; api.craft finds one within 16, ensureBench crafts and places
  one when the world has none. Then the wiring: **sendToTest had no
  caller** — done projects could never reach the scout's walk (done
  stayed 0 all day for this reason alone, wood aside).
- 12:47–12:53 — two operator seeds, honestly owed and recorded: the
  console gave Timber one chest and Sprout two oak logs (the supply
  chain's despawned tosses had eaten three real deliveries' worth of
  wood); Timber placed the chest from beside the site (tp -4 68 -5,
  after six placement timeouts from the gully floor).
- 13:02:35 → 13:02:59 — **b037 done**: Timber's step said done, the
  service handed it to the tester, Kite walked it and passed it. The
  first completed project of the community round, 6.5 h in. The board:
  done 1, active 1 (b044 farm — Sprout splitting logs for the hoe at
  12:49; the seeds are its open want). The depot has a chest:
  leave_at_depot/take_from_depot now have a durable handoff surface.

- 13:10–13:50 — the run settles. The farm (b044) holds the hoe and the
  bench; Sprout and Pebble grind short_grass for the 14 wheat seeds
  ("grass broken, no seeds yet", one break ~36 s, a seed an eighth of
  the time — the honest pace of it). The chest stands at the depot;
  the board: done 1, active 1. TPS 20.0 every sample of the day
  (240/240 ≥ 19.5 by the 12:40 rollup), MemAvailable min 69.7 GB,
  zero soft holds enforced since 10:31 (31 exemptions), grief 0 (the
  visitor's two blocks stand, no new player builds). The day's doc is
  docs/playtest-community-2026-11-02.md; the round's commits run
  14ce3f6 → 6f4134e. Left for the next seat: the gully (walks from
  its floor still cannot climb out; restarts put the gatherer back),
  Pebble's delivery-moment disconnects (12:13:20, 12:30:04,
  unexplained), the farm bill's bench under-count (bills one log, the
  hoe-and-bench need eight planks), the drift gate's "success rose"
  semantics, and the replant proposal when the terrace singles run
  out. The world runs on: paper, bots, reflex, d1, drift-watch,
  community-watch, all detached.

- 14:00–14:40 — day two, the five CONTINUE priorities, four fixed and
  the fifth turned over to the crew. **(1) The "Pebble disconnects"
  were never a world fault**: every mystery disconnect (paper.log
  local 03:13:20, 03:23:31, 03:30:04, 03:42:09, 04:00:03, 04:26:41 —
  UTC 12:13–13:26) has **all four bots leaving the same second** and a
  staggered rejoin ~10 s later, with ProbeD/W/G connections between:
  those were the previous seat's own `ops/bots.sh restart` calls while
  patching delivery code (tmux kill-window is a SIGHUP; the graceful
  quit path never ran). `cmd_stop` now SIGTERMs the window's leaves
  first (`bot.quit('the world is resting')`), then kills the window;
  the orphan reflex from the 09:36 restart (no port, PID 2834293) is
  killed. **(2)** the drift success signal is one-sided at the source
  (drift-pause 4baf697, floored at zero — the signed form let the rate
  gate fire on a rise from far-above-reference to slightly-above-it,
  Pebble 06:45); the watcher restarted onto it at 13:59 and its first
  window read "nothing in alarm" where the five minutes before planned
  a Pebble success hold. **(3)** bills count the bench: CRAFTED_FROM
  gains `crafting_table` (4 planks = 1 log), `benchNear` mirrors the
  craft-time 16, and depot-chest/farm bills add the bench only when
  the site has none (rawBill: chest+bench 3 logs; hoe+bench+14 seeds
  2 logs + seeds). **(4)** seeds by the patch: `gatherSeeds` breaks a
  90 s run per step at reach 48 — the old one-break-per-step cadence
  (~36 s a break) put 14 seeds at more than an hour. **(5)** the gully
  itself: a `ramp` project kind that carves the way out — each step a
  cell dug down to the standing level and finished with scoped
  cobble, terraform, not construction (a place-only plan cannot cross
  the 4-high mossy wall; probe-column.js read the wall, the floating
  lip at y66, and the crew floor y61-64). `surfaceAt` now skips ALL
  leaves — spruce canopy counted as ground made the spawn slope a
  y69 plateau and the first planner run refused a gully it could not
  see.
- 14:29 — the council proposed the ramp on its own (b058, 7 steps)
  and the validator **denied** it for the right reason:
  TestHumanH's coarse_dirt (5,67,2 / 4,66,2) inside the site. The
  deny drew two real flaws out of the plan: steps through the visitor
  keep-out, and the **chest's own column held as a step** — carved, it
  would have dug the depot chest out of its terrace. Fixed (keep-out
  skip in the planner, goal column never a candidate, a chest guard
  in the executor, site hugging the plan), tests 9/9 on the real
  visitor coordinates (c9d23fc).
- 14:38:41 — **b060 allowed**: 6 cobble steps SW of the chest
  ((-2,62,-4) … (-3,67,-6)), site r=4 — kind:known, scope:bounded,
  site:known, materials:gatherable. The builder owns it; the unattended
  stretch (projects done per hour is the headline) starts here.

- 15:00–16:00 — the ramp's executor earned its keep the hard way, one
  honest refusal at a time. The builder's quarry looped "quarried a
  stone" without ever holding one (a dig that reported success without
  checking its own outcome), then refused honestly ("too deep: the
  community mines no lower than y=48" — the nearest bare stone to the
  gully is a cave wall twenty blocks down), then found nothing at all
  (find_block's default window is ±2 of the builder's own feet; the
  pit's stone sits at y58–62 below them) — and the instrumented
  refusal named the real state: **the builder itself was at y38–40**,
  mined underground between project steps by its own library skills
  (the playable round's pit failure, alive in the bandit's repertoire;
  probe-find.js: 96 stone spots within 32 of the gully floor, so the
  world had stone all along). buildRamp now stands at the work BEFORE
  gathering for it — a search from the site finds the stone the site
  sits on — and the quarry is bounded `min_y: 49, any_level: true`.
  The drift watcher held Timber (soft, spend signal) over the wasteful
  stretch — the supervision doing exactly its job — and the hold lapses
  at its TTL.
- The seeds taught their own lesson: the batching worked (runs of
  90–115 s, the first seed of the day arrived), but by 15:40 the
  farm's own terrace was ground bare — "0 grass broken" every tick
  within 48, and nothing within 96 either. The seed economy of the
  spawn slope is spent. The owner's gate is back to one-seed (a seed
  in hand is a seed in the ground, and wheat pays its own seeds
  back), and the gatherer's forage reaches 160 for untouched patches.
  What the world still owes itself: a wheat cycle (plant-harvest-
  replant) so seeds compound instead of being mined out of the grass
  — that is next-seat work, recorded under risks.
