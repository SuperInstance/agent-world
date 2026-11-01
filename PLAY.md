# PLAY — joining the agents

One page. The world is **Minecraft Java 26.1** on the Thor, LAN-only,
open to anyone on the house network (the whitelist is off while we
playtest). Four agents live there: **Pebble** (gatherer — chops wood,
mines stone), **Timber** (builder — raises the wall), **Kite** (scout —
walks the boundary, notices arrivals), **Sprout** (farmer — breaks new
ground, plants). They keep working whether you are there or not.

## Joining

| | |
|---|---|
| **Java (the laptop)** | Minecraft Java **26.1** (the current release) → Multiplayer → Direct Connection → `192.168.0.78:25565` |
| **Bedrock (tablets, phones)** | Minecraft Bedrock → Play → Servers → Add Server → address `192.168.0.78`, port `19132` (UDP) |
| **Watch instead** | `http://192.168.0.78:8080/` — the 3D view from any browser; `http://192.168.0.78:8080/ascii` is the same world in text; `http://192.168.0.78:8080/voices` speaks the agents' lines |

No accounts are needed for Bedrock through our door (Geyser + Floodgate
bridge it to the Java world; your name gets a small mark in front of
it). Java needs its own account as usual. If a recent Bedrock client is
refused, tell us the exact version number on the title screen — there
is a ViaVersion-style plugin for exactly that, and it is a five-minute
fix on our side.

## Talking to the agents

Say a line in normal chat (T). They answer in chat — and out loud on
the voices page. You can name one to pick who answers ("Pebble, come
here"), otherwise the nearest one takes it.

| say | what happens |
|---|---|
| `follow me` | the nearest one follows you around |
| `stop` | everyone stops what they were doing for you |
| `come here` | the nearest one walks to you |
| `gather wood` / `gather stone` | Pebble chops or mines it and brings it to **you** (a few minutes — it is really doing it) |
| `help me build` | Timber comes to you; place two blocks in a line and he carries the line on, or hands you materials |
| `what are you doing?` | the nearest one says what it is up to |
| `go home` | the nearest one walks back to the depot |
| `help` | the short version of this table |

## What to expect, and the limits

- Kite greets you when you arrive (once every ten minutes, not every
  reconnect).
- **They never touch your stuff.** Blocks you place are yours: they
  won't mine them, they won't build within a few blocks of them, they
  won't open a chest you placed, and they never attack a player. Say
  `help me build` to invite Timber to build beside you.
- Your chat is never recorded anywhere — only the agents' own words and
  decisions are logged.
- The world runs at low priority on the Thor; if the box gets busy the
  agents pause politely and resume.
- Known limits: Pebble delivers at your feet — stand still for it;
  "gather" can fail honestly ("nothing came of it") when the forest or
  stone is far; Timber carries a line only in a straight run of your
  last two blocks.
