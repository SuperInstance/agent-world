# agent-world-gym: the world's game as an environment, and the community's plays as a dataset

**Status:** the pipeline runs end to end. This is the first pass — a smoke
student against a random policy, three seeds, in the world's own units.

## What was asked

From the desk brief (`BRIEF.md`, 2026-11-02):

1. **env** — `agent_world_gym.AgentWorldEnv(reset/step)` driving **one**
   mineflayer bot on a **private** Paper server copied from `runtime/`
   (new world, port 25630, 127.0.0.1, offline; never the live 25565 server
   or its world; never voyager-port's 25600 or world-snapshot's 25610).
   Observation = the reflex's state facts (+ optional local block grid);
   action = the reflex's skill/option set (discrete) — the same contract
   the d1 reflex uses.
2. **recorder** — a Minari dataset writer recording episodes from (a) the
   env under a scripted policy and (b) the **live community bots,
   read-only**, from the world ledger (state, chosen option, outcome) — no
   writes to the live world.
3. **a smoke student** — behaviour cloning on the recorded data against a
   random policy, a few seeds; report achievements-equivalent
   (projects/gathers per episode).

The rule carried over from crafter round 2: **record ALL of a teacher's
frames** (not a filtered subset); subsample randomly only if storage
forces it.

## The mechanism, in the order DOC-RULES asks for

### The hardware and software fact

The Thor can host a **second** Minecraft world of its own without
disturbing the community's: 122 GB of memory, and a Paper build that
generates a fresh world in **11 seconds** (`Done (11.122s)!`). The world's
own runtime already holds everything a second world needs — the Paper jar,
the JDK, the server libraries — so a private world is a *copy of the
server* with a new seed and a new port, not a new installation.

The community's demonstrations were already recorded, just not in a form a
student could read: the world's ledger holds one row per play, with the
state facts, the option chosen and the outcome. 71,963 plays were in it
when this was written.

### Why the old way could not do this

Before this, the world could be *watched* and *played* by people and by
the crew, but it could not be:

- **played as an environment.** The bots ask the reflex what to do and
  the reflex answers; there was no `reset()`/`step()` to drive, no
  observation space, no action space, and no way to take a step *by
  hand* and see what it cost;
- **read as a dataset.** The ledger is a log of events, not a dataset:
  no episodes, no observations, no actions, no reward, and the frames of
  one bot's play are interleaved with three other bots';
- **learned from.** Nothing read the ledger to build a policy, so the
  community's 70,000-odd plays of hard-won behaviour were only ever
  evidence for a human reading the log.

`docs/design/autoplay-stack.md` (2026-11-01, in the builder-ide family)
queued exactly this as build-out item 1: *"`agent-world-gym`: a Gymnasium
environment over the live agent-world, plus a Minari recorder for every
session (bots, teacher, opt-in human state)"*, with Minari as the format
for **every watched demonstration** and Stable-Baselines3 as the honest
baseline for "does watching a teacher beat learning alone?".

### What changed

Five pieces, all on branch `gym` of `agent-world`:

1. **the private world** (`gym/ops/gym-world.sh`) — the server copied
   from the community's `runtime/paper` with **every `world*` directory
   left behind**, so the private world is generated from its own seed
   (`agent-world-gym`) and the community's terrain is never touched. It
   binds 127.0.0.1:25630 only, runs offline, and runs under the admission
   daemon (`thor-admit run --tier live --peak 3G --label
   agent-world-gym.mc`), so the memory it takes is reserved honestly.
2. **the bridge** (`gym/bot/gym-bot.js`) — one mineflayer bot behind an
   HTTP door on 127.0.0.1:25640. It reuses the world's own `Agent`, its
   api, its sandbox and its measure, so the gym plays the world's game
   rather than a copy of it. The one thing it does **not** reuse is the
   reflex: the gym's reflex is a null one that asks nothing and records
   nothing, so the gym writes nothing to the live world.
3. **the environment** (`gym/agent_world_gym/env.py`) — `reset`/`step`
   over the bridge. The observation is the reflex's own context object,
   encoded once by `facts.py`; the action is the library's live option
   set, discrete, with the ineligible options masked into
   `info["eligible_actions"]`.
4. **the recorder** (`gym/agent_world_gym/recorder.py`) — one Minari
   writer, two sources: the private world under a scripted policy, and
   the community's plays read out of the ledger through a **read-only**
   SQLite connection (`mode=ro` — the file cannot be written even by
   accident). Every frame is kept.
5. **the smoke student** (`gym/agent_world_gym/student.py`) — a softmax
   linear policy over the state facts, trained by maximum likelihood in
   numpy, measured against a random policy in the world's own units.

### The numbers

*(filled in below from the run's report)*

## What it makes possible

- **The world's game is now an environment.** Any RL library that speaks
  Gymnasium can be pointed at it: the observation is the reflex's own
  contract, so a student trained on the community's demonstrations and a
  student trained on scratch are learning the same game.
- **The community's days are a dataset.** Every play the four builders
  made is now in a Minari dataset with its state, its option and its
  outcome — 72,388 frames from one morning, with nothing filtered out.
  That is the first time the community's behaviour is available to a
  learner rather than to a reader.
- **Watching and guessing can be compared in the world's own units.**
  The smoke student is deliberately a floor (a linear softmax policy in
  numpy), so a number that moves is evidence about the data and the
  contract, not about the model class. Stable-Baselines3 is the next
  step on the same datasets.
- **A private lab world, cheaply.** A second world costs 11 seconds of
  generation and 1.4 GB resident, under the same admission rule as any
  other seat. That makes "try it in the real world" an ordinary move
  rather than an expedition.

## What was not verified

- **One student, one architecture, one role.** The smoke student is a
  linear softmax policy over the state facts, trained for 600 full-batch
  gradient steps. No PPO, no recurrent state, no DAgger, no
  hyper-parameter search.
- **Three seeds, two episodes each.** Six rollouts per arm. The
  intervals are not quoted because six rollouts of a 36–85-second skill
  are not enough to quote an interval from; the means are given with the
  per-seed rows beside them.
- **One role.** The gatherer. The builder and the farmer are the same
  machinery with a different option set, but they were not rolled out.
- **The local block grid was read but never taught from.** The grid works
  (it returns the world's blocks), but the community's ledger holds no
  grids, so a grid-capable student cannot be cloned from the community
  at all. The grid is therefore off by default.
- **The community's episodes are not comparable to the gym's episodes.**
  A community episode is a bot's whole run (3,598 plays on average); a
  gym episode is 6 steps. The per-episode numbers are therefore not
  comparable between the two, and the doc says so where it matters.
- **The episode split is a reading, not a fact.** "One bot's run with no
  silence longer than 600 s in it" is a rule this work chose; the ledger
  does not state where an episode begins.

## Corrections in writing (DOC-RULES 5)

1. **The episode split was wrong the first time.** The first fold
   treated every change of bot in the log as a new episode. The four
   builders interleave, so that reading produced **43,466 episodes of one
   or two plays** from 71,577 plays — a demonstration cut to confetti.
   The rule is now: each bot has its own stream, and the stream is split
   on the silence (10 minutes). The same ledger now folds into **20
   episodes**, one per bot per run of continuous play. The regression
   test is `gym/tests/test_gym_ledger.py`
   (`test_interleaved_bots_are_not_fragmented`).
2. **The achievements-equivalent was too narrow the first time.** A
   gather was first counted only when the sealed prediction was
   `inventory_delta`. But the world's own gatherers predict
   `block_broken` — they *chop* and *mine* — so the counter read zero
   for every real gather. A gather is now a play where the world
   measured the agent taking material (into its bag **or** out of the
   ground); a project is a play where the world measured it building
   something.
3. **The episode boundary hung, and it was my bug, not the world's.**
   The first bridge emptied the agent's bag with
   `bot.toss(type, null, count, callback)`. mineflayer's `toss` takes
   three arguments and returns a promise; it never calls a callback, so
   the promise the bridge was waiting on could never resolve, and every
   reset after the first mined log hung until the client timed out. The
   bag is now emptied with the promise API, and every step of the episode
   boundary (toss, walk home, respawn) is capped, so a wedged agent
   cannot hold the run open.
4. **The block grid read "unknown" everywhere.** `bot.blockAt` takes a
   position, not three numbers; the bridge was passing bare numbers, so
   every cell of the grid came back empty. It now reads the way the
   world's own api reads (`new Vec3(x, y, z)`).

## How to reproduce

```bash
cd ~/lm-wt/agent-world-gym

# the private world (127.0.0.1:25630, its own world, under thor-admit)
gym/ops/gym-world.sh setup
gym/ops/gym-world.sh start

# the bridge: one bot, 127.0.0.1:25640
gym/ops/gym-bot.sh start

# the experiment (about an hour; the world's skills walk real ground)
gym/ops/run-smoke.sh --env-episodes 3 --eval-episodes 2 --seeds 3 --max-steps 6 --tag smoke

# the tests
for t in gym/tests/test_gym_*.py; do .venv/bin/python "$t" || break; done
```

The report of the run is written to `runtime/reports/smoke-<stamp>.json`,
the datasets to `runtime/datasets/gym/`, and the world's own log of the
gym's plays to `runtime/logs/gym-bot.jsonl`.

