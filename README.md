# agent-world — a community of agents living in Minecraft on the Thor

A Minecraft world on the Jetson AGX Thor (192.168.0.78), with four
builders living in it. They gather, they build, they farm and they
scout. Every few seconds each of them asks the world's decision seam
what to do next; the answer comes from a small decision model on the
same box, batched across all four builders into one call. The world
keeps working when nobody is watching.

Everything is **LAN-only**: the server binds the house network, the
door is a whitelist, and nothing is published to the internet.

```
   your laptop, a tablet, a phone          the Thor (192.168.0.78)
 ────────────────────────────────         ─────────────────────────────────
   Minecraft Java  ─────────────┐         Paper 26.1.2 (Java 25)
   Minecraft Bedrock ───────────┼────────▶ 25565 / 19132 (Geyser)
   a browser ───────────────────┘         prismarine-viewer :8080
                                         d1-2B  :8094   (the reflex)
                                         four mineflayer builders
                                         the skill library and the log
```

## How to join

### Minecraft Java (the ProArt, Windows)

1. Open Minecraft (the Java edition) — the launcher, not the
   Microsoft Store one.
2. **Multiplayer → Direct Connect** and enter
   **`192.168.0.78`** and port **`25565`**.
3. Join.

**The client must be version 26.1.** The server runs Paper 26.1.2,
which is the newest release the builders can speak (mineflayer has no
protocol data for 26.2 or 26.3 yet), and Minecraft does not let a newer
client join an older server. If your launcher is on a newer version,
open **Install Versions** in the launcher, install **26.1** beside it,
and run that one. Nothing else changes.

To use your own account (and your own skin), the server can be put
back into online mode: see *The trade* below.

### Minecraft Bedrock (the tablets and the phones)

The family runs Bedrock, so the world has the **GeyserMC** plugin and
its **Floodgate** companion:

- add the server with the address **`192.168.0.78`** and port
  **`19132`** (UDP);
- Bedrock clients join without an account through Floodgate;
- a Bedrock client on Floodgate shows as `.<name>` to a Java client.

### A browser (any device, no Minecraft)

- **the 3D view** — `http://192.168.0.78:8080/` — the world as a
  spectator sees it, with the builders in it;
- **the text view** — `http://192.168.0.78:8080/ascii` — one
  perspective projected into characters by an integer kernel.

Both are on the house network; neither is published.

## Running it

Everything lives in this directory. The runtimes (two JDKs, Node, the
Paper jar, the Geyser jar) are installed locally, not system-wide.

```bash
ops/install-runtime.sh     # fetch and check the runtimes (idempotent)
ops/paper.sh start         # the world
ops/d1.sh start            # the decision model (shared by all builders)
ops/bots.sh start          # the reflex and the four builders
ops/viewer.sh start        # the 3D view and the text view

ops/paper.sh status        # is it up, on what port, how much memory
ops/paper.sh logs 40       # the server's log
ops/paper.sh console       # the server console
ops/paper.sh stop          # save and stop, cleanly (about a second)
```

They all run in one tmux session (`agent-world`), one window each:
`paper`, `d1`, `reflex`, `bots`, `viewer`.

The whitelist is a file, and the server is told about it on every
start:

```bash
ops/paper.sh whitelist list
ops/paper.sh whitelist add Casey
ops/paper.sh whitelist remove Casey
```

## The shape of it

| part | where | what it is |
|---|---|---|
| the world | `ops/` | Paper 26.1.2, Geyser, the whitelist, the memory floor |
| the reflex | `reflex/` | the decision seam: the library, the log, the chooser, the mediator |
| the builders | `bots/` | four mineflayer clients, one per role, and the sandbox the skills run in |
| the window | `viewer/` | the 3D view and the integer text view |

The full description — how a decision is made, how a skill is written
and retired, what the numbers are, and what the trade-offs are — is in
[`docs/agent-world.md`](docs/agent-world.md).

## The trade

**The server runs in offline mode.** The builders need no Minecraft
accounts of their own, which is what makes a community of four agents
possible without four accounts and four logins. The price is that
anyone on the LAN can claim any name — so the **whitelist is the
door**, and it is applied through the server's own command on every
start. If you would rather have your own account (and your own skin)
appear on the server, the change is one line in
`ops/world/server.properties.template`:

```
online-mode=true
```

and then each human client needs a Mojang account and a UUID on the
whitelist. The builders would then need accounts of their own, or
their own Paper-side exemption.

**The server is a resident service on a shared box.** It is capped at
6 GB of heap, runs at `nice 10`, and refuses to start while the box has
less than 25 GB free — the rule that came out of the 13:22 OOM. It does
not take the heavy lock, because it is not a heavy step; the lock is
taken only while the decision model loads.

**No chat and no audio is stored.** The world's log holds decisions and
outcomes: what a builder chose, what it did, whether the prediction
held, and what it cost. Nothing a human said or heard is in it.

## Licences

- Paper (the server) needs no licence; **each human client needs its
  own copy of Minecraft and its own acceptance of Mojang's EULA**
  (accepted for this world by Casey on 2026-10-31).
- GeyserMC and Floodgate: MIT.
- mineflayer, prismarine-viewer: MIT.
- The JDK (Eclipse Temurin) and Node.js: their own licences, in the
  archives under `runtime/dl/`.
- This repository: MIT.
