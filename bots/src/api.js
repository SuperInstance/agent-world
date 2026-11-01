'use strict';
// bots/src/api.js — the world's vocabulary, and the sandbox a skill runs in.
//
// A skill is a small JavaScript function. It may only use the words
// below, and it runs in a context that contains the words and nothing
// else.
//
// Three doors, in order of strength:
//
// 1. **The static door** (the Python side, `agent_world_reflex.door`):
//    a skill that names an unknown word, or reaches for `require` or
//    `process`, is refused before it ever enters the library.
// 2. **The parse door**: the body is compiled by Node's own parser.
// 3. **The runtime door** (this file): the skill runs in a `vm` context
//    that has no `require`, no `process`, no `Buffer`, no `console`, no
//    `eval`, and no `new Function` (string code generation is off). The
//    API wrappers are built *inside* the context, so even reaching for
//    their `constructor` lands in the sandbox's realm, not the host's.
//
// The low-level work — walking, pathing, aiming, mining — stays in
// mineflayer's own planners: `mineflayer-pathfinder` plans the walk and
// `bot.dig` does the mining. This file is the thin skin over them.

const vm = require('node:vm');
const { Vec3 } = require('vec3');
const { pathfinder: pathfinderPlugin, Movements, goals } = require('mineflayer-pathfinder');

const TICK_MS = 50; // a Minecraft tick is 1/20 s

/**
 * Find the nearest block of the given names, searching by block id.
 *
 * mineflayer's search has two paths. A function matcher makes it scan
 * the neighbourhood block by block — and that scan has a budget it
 * spends on the canopy around a builder standing in a tree before it
 * ever reaches the ground, so "no stone within 24 blocks" on a stone
 * mountainside (probe7). A list of block ids makes it ask each chunk's
 * own type index instead, which has no budget to spend and finds the
 * same blocks whatever is overhead. So the names are resolved to ids
 * and the level filter — a block the builder cannot reach is not a
 * block it can work on — is applied to the results.
 */
function findByIds(bot, registry, names, maxDistance, feet, anyLevel) {
  const ids = [];
  for (const name of names) {
    const block = registry.blocksByName[name];
    if (block) ids.push(block.id);
  }
  const spots = bot.findBlocks({ matching: ids, maxDistance, count: 96 });
  for (const spot of spots) {
    if (!anyLevel && Math.abs(spot.y - feet.y) > 2) continue;
    const block = bot.blockAt(spot);
    if (block) return block;
  }
  return null;
}

/**
 * The faces a block may be placed against, in order of preference: on
 * top of the ground first, a wall beside it next, under a ceiling last.
 */
const FACES = [
  new Vec3(0, 1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, -1, 0),
];

/**
 * Teach a bot to walk.
 *
 * mineflayer-pathfinder is a plugin now: `bot.loadPlugin(pathfinder)`
 * gives the bot `bot.pathfinder`, and `goto` takes a goal. The
 * movements let the planner dig through a block on its way, which is
 * what a builder in a quarry needs.
 *
 * The guard, when there is one, reaches into the planner too: the
 * planner's `safeToBreak` is asked about every block it might dig on
 * its way, so the no-grief rule holds on the path as well as at the
 * workface. Without it, a builder walking home would dig a doorway
 * through somebody's house because the door was on the shortest path.
 */
function givePathfinding(bot, guard) {
  const applyGuard = () => {
    if (!guard) return;
    try {
      const movements = bot.pathfinder ? bot.pathfinder.movements : null;
      if (!movements) return;
      const plain = movements.safeToBreak.bind(movements);
      movements.safeToBreak = (block) => {
        if (!plain(block)) return false;
        if (!block || !block.position) return true;
        return guard.mayDig(block.position).ok;
      };
    } catch (err) {
      // The planner's own rule stands; the api's guard still holds.
    }
  };
  if (bot.pathfinder && typeof bot.pathfinder.goto === 'function') {
    applyGuard();
    return;
  }
  bot.loadPlugin(pathfinderPlugin);
  const movements = new Movements(bot);
  movements.canDigBlocks = true;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  bot.pathfinder.setMovements(movements);
  applyGuard();
}

/** Cancel a walk, if one is running, and give the cancellation a moment
 * to land. A stop that arrives while the next walk is starting stops
 * that one instead, and a builder whose every walk is stopped before it
 * begins is a builder that stands still forever (probe7: "Path was
 * stopped before it could be completed", two milliseconds in). */
async function stopWalking(bot) {
  try {
    bot.pathfinder.stop();
  } catch (err) {
    // Nothing was running; nothing to stop.
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/**
 * How long a walk may run: the caller's timeout, plus 1.5 s for every
 * block beyond twelve. A near walk keeps the tight deadline it always
 * had; a far walk — the scout's 24-block survey, the gatherer's climb
 * home from a dig — needs the extra room, and the stall watcher below
 * keeps a walk that cannot start from grinding through any of it.
 */
function walkBudget(bot, x, y, z, timeout) {
  const p = bot.entity.position;
  const far = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2);
  return timeout + Math.max(0, far - 12) * 1500;
}

const STALL_MS = 3200; // no net progress for this long → the walk is wedged
const STALL_PROGRESS = 1.0; // blocks of net progress that disprove a stall

/**
 * One attempt: the planner's own goto, under a stall watcher.
 *
 * Resolves 'arrived' when the goal is reached, 'error:…' when the
 * planner itself gives up (NoPath and friends), 'timeout' when the
 * walk's whole budget is spent, and 'stalled' when the bot stops
 * making progress — the signature of a bot pressed against a block it
 * cannot step over: the planner finds a path, its follower cannot make
 * the first move, and the walk would otherwise hang to its deadline
 * having moved nothing (probe17: fifty-eight seconds, zero blocks).
 */
function attemptWalk(bot, x, y, z, distance, deadline) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let checkpoint = bot.entity.position.clone();
    const arrived = () => bot.entity.position.distanceTo(new Vec3(x, y, z)) <= distance + 0.5;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(watcher);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    bot.pathfinder.goto(new goals.GoalNear(x, y, z, distance)).then(
      () => finish('arrived'),
      (err) => finish('error:' + String((err && err.message) || err))
    );
    const rearm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish('stalled'), STALL_MS);
    };
    timer = setTimeout(() => finish('stalled'), STALL_MS);
    const watcher = setInterval(() => {
      if (arrived()) {
        finish('arrived');
        return;
      }
      if (bot.entity.position.distanceTo(checkpoint) >= STALL_PROGRESS) {
        checkpoint = bot.entity.position.clone();
        rearm();
      }
      if (Date.now() >= deadline) finish('timeout');
    }, 1200);
  });
}

/**
 * The un-wedge. A bot pressed against a face reports itself off the
 * ground while it presses, so even a jump will not fire (probe18), and
 * every planner retry goes nowhere. Raw controls away from the face do
 * work — a step back opens the pocket — so the bot backs off, sidesteps
 * both ways, and lets the next attempt plan from a clean standstill.
 */
async function nudge(bot) {
  await stopWalking(bot);
  for (const control of ['back', 'left', 'right']) {
    bot.setControlState(control, true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    bot.setControlState(control, false);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/**
 * Walk to within `distance` blocks of a point.
 *
 * The deadline matters: the planner retries an unreachable goal for as
 * long as it likes, and a builder that waits forever on a log it can
 * never reach is a builder that has stopped working. So every walk has
 * a clock (scaled to how far the walk is), and a walk that runs out of
 * time is a failure the skill can hear about.
 *
 * A walk that *cannot start* — a bot wedged against a cobble line, or
 * standing in water its planner will not swim out of — is worse than a
 * slow one: it burns the whole deadline, records an honest but useless
 * loss, and starts the same doomed walk again next tick. That is how
 * three builders spent an afternoon playing the same walk 20 seconds at
 * a time and never moving a block. So the walk watches its own
 * progress: when it stops for three seconds, the bot backs off (one
 * nudge), tries again, and after two nudges gives up early — the
 * skill hears a failure it can act on, and the walk that could not
 * start has cost seconds, not the whole clock.
 */
/** A stop that lands while a walk is starting kills that walk, and the
 * planner reports it as a rejection rather than a verdict (probe7's
 * "Path was stopped before it could be completed", two milliseconds
 * in). It is an interruption, not an answer: retry it like a stall. */
const STOP_RACE = /stopped before it could be completed|path was stopped/i;

async function gotoNear(bot, x, y, z, distance = 2, timeout = 20000) {
  const deadline = Date.now() + walkBudget(bot, x, y, z, timeout);
  const within = () => bot.entity.position.distanceTo(new Vec3(x, y, z)) <= distance + 0.5;
  let reason = null;
  let nudges = 0;
  try {
    while (Date.now() < deadline) {
      if (within()) return;
      let outcome = await attemptWalk(bot, x, y, z, distance, deadline);
      if (outcome === 'arrived') return;
      if (outcome.startsWith('error:')) {
        const message = outcome.slice(6);
        if (!STOP_RACE.test(message)) throw new Error(message);
        outcome = 'stalled';
      }
      // A stall buys one nudge; the third stall ends the walk, and the
      // whole budget ending it does too.
      if (outcome === 'timeout') {
        reason = 'the walk took too long';
        break;
      }
      if (++nudges > 2) {
        reason = 'the walk could not start';
        break;
      }
      await nudge(bot);
    }
  } finally {
    if (!within()) await stopWalking(bot);
  }
  throw new Error(reason || 'the walk could not start');
}

/** What a tree is made of: the spawn column may be inside one. */
const CANOPY = new Set([
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'azalea_leaves',
  'flowering_azalea_leaves', 'mangrove_leaves', 'pale_oak_leaves',
]);

/**
 * Where the community's depot is.
 *
 * The world spawn: every builder appears there and every builder can
 * find it, without anyone telling them where it is. The spawn point
 * itself can be up in a tree's canopy (the spawn packet names a column,
 * not a floor), so the depot is the first solid ground in that column
 * from the top down that is not part of a tree — leaves and trunks are
 * skipped, so the depot is where a builder can stand, whatever grows
 * above it.
 */
function depotSpot(bot) {
  const spot = bot.spawnPoint || bot.entity.position;
  const x = Math.floor(spot.x);
  const z = Math.floor(spot.z);
  const start = Math.floor(spot.y);
  const air = (block) =>
    !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
  const tree = (block) => CANOPY.has(block.name) || block.name.endsWith('_log');
  for (let y = start + 8; y >= start - 24; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) continue;
    // Grass, ferns and snow are not a floor: a goal standing on them
    // can never be reached, and a builder that walks to an unreachable
    // goal walks to wherever it gave up instead (probe7). Only a block
    // with a bounding box is ground.
    if (block.boundingBox === 'empty') continue;
    if (air(block) || tree(block)) continue;
    return { x, y: y + 1, z };
  }
  return { x, y: start, z };
}

/** The vocabulary: the words a skill may use, and what they do.
 *
 * The guard is the no-grief rule (see humanity.js). It is optional so
 * the tests and the probes can run without a person in the world; the
 * builders never run without one.
 */
const OPEN_GUARD = {
  mayDig: () => ({ ok: true }),
  mayPlace: () => ({ ok: true }),
  isPlayerChest: () => false,
  ownPlacement: () => {},
};

function buildApi(bot, counters, guard = OPEN_GUARD) {
  const registry = bot.registry;
  // The depot: the chest the community shares. The gatherer fills it,
  // the builder empties it. It is why four builders are a community and
  // not four strangers.
  let openChest = null;

  const blockAt = (x, y, z) => {
    const block = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    return block || null;
  };

  return {
    // --- what the bot can see ------------------------------------------------
    position: () => {
      const p = bot.entity.position;
      return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    },
    health: () => bot.health,
    food: () => bot.food,
    time_of_day: () => Math.round((bot.time.timeOfDay / 24000) * 1000) / 1000,
    light: () => {
      // An estimate, not a query: if there is a solid block overhead the
      // bot is in the dark, otherwise it can see the sky.
      const p = bot.entity.position.floored();
      const above = bot.blockAt(p.offset(0, 2, 0));
      return above && above.name !== 'air' ? 0 : 15;
    },
    inventory: () =>
      bot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
    inventory_count: (name) => {
      const item = bot.inventory.items().find((i) => i.name === name);
      return item ? item.count : 0;
    },
    block_at: (x, y, z) => {
      const block = blockAt(x, y, z);
      return block ? block.name : null;
    },
    find_block: (query) => {
      const q = query || {};
      const names = q.names || (q.name ? [q.name] : null);
      const maxDistance = q.max_distance || q.maxDistance || 32;
      const feet = bot.entity.position.floored();
      // A block the builder cannot stand next to is not a block it can
      // work on: a log five blocks up a tree is found, aimed at and
      // then not mined, because the server refuses a dig that is out of
      // reach. So the candidates are the ones at the builder's own
      // level, unless the query asks for any level.
      const anyLevel = q.any_level === true;
      let found = null;
      if (names) {
        found = findByIds(bot, registry, names, maxDistance, feet, anyLevel);
      } else {
        // Any block at all: the name-less search keeps the function
        // matcher, which scans the neighbourhood itself.
        found = bot.findBlock({
          matching: (block) => {
            if (!block || !block.position) return false;
            if (block.name === 'air') return false;
            if (anyLevel) return true;
            return Math.abs(block.position.y - feet.y) <= 2;
          },
          maxDistance,
        });
      }
      if (!found) return null;
      return {
        x: found.position.x,
        y: found.position.y,
        z: found.position.z,
        name: found.name,
      };
    },
    depot: () => {
      // The depot is the world spawn: the one place every builder can
      // find without being told where it is, and the one place they all
      // appear. It needs nothing built first — it is already there.
      const spot = depotSpot(bot);
      return { x: spot.x, y: spot.y, z: spot.z };
    },
    leave_at_depot: async (name, count) => {
      const spot = depotSpot(bot);
      try {
        await gotoNear(bot, spot.x, spot.y, spot.z, 0);
      } catch (err) {
        // Walk as close as the planner allows and carry on: the item
        // lands at the bot's feet either way.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Toss looking up: a drop thrown forward lands two blocks from
      // the depot and rolls, and the taker's small ring may miss it.
      await bot.lookAt(bot.entity.position.offset(0, 6, 0), true);
      if (name === undefined || name === null) {
        // No name, no argument: leave everything, in one standing —
        // walking away between items walks back over the pile, and a
        // bot that picks up what it just left is how the depot stayed
        // empty while everyone kept delivering to it.
        for (const item of bot.inventory.items()) {
          try {
            await bot.toss(item.type, null, item.count);
          } catch (err) {
            // One item that will not leave stays in the bag; the rest go.
          }
        }
      } else {
        const item = registry.itemsByName[name];
        if (!item) return { ok: false, detail: `there is no item called ${name}` };
        const have = bot.inventory.count(name, null);
        if (!have) return { ok: false, detail: `the bot has no ${name} to leave` };
        const wanted = Math.min(Number(count) || have, have);
        await bot.toss(item, null, wanted);
      }
      // Step aside, south, and stop: standing on the pile (or walking
      // back over it) takes it straight back into the bag.
      try {
        await gotoNear(bot, spot.x, spot.y, spot.z + 3, 1, 5000);
      } catch (err) {
        // The pile keeps whatever distance it can get.
      }
      return { ok: true, detail: 'left it at the depot' };
    },
    take_from_depot: async (nameOrNames) => {
      const wanted = (
        Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames]
      ).filter((n) => typeof n === 'string' && n);
      if (!wanted.length) return { ok: false, detail: 'nothing was asked for' };
      const spot = depotSpot(bot);
      const before = new Map(wanted.map((n) => [n, bot.inventory.count(n, null)]));
      // One ring around the depot, walked once: the pickup has no filter,
      // so a single pass collects the whole pile whatever it is, and the
      // first wanted item that appears ends the walk. (Asking once per
      // item made a builder pace the depot for minutes while the
      // gatherers swept the pile back up behind it.)
      const ring = [
        [0, 0], [2, 0], [-2, 0], [0, 2], [0, -2],
        [2, 2], [-2, -2], [2, -2], [-2, 2],
      ];
      for (const [dx, dz] of ring) {
        try {
          await gotoNear(bot, spot.x + dx, spot.y, spot.z + dz, 1);
        } catch (err) {
          // Some points are out of reach; the next one may not be.
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        for (const name of wanted) {
          const now = bot.inventory.count(name, null);
          if (now > before.get(name)) {
            return { ok: true, name, count: now, detail: `the bot has ${now} ${name}` };
          }
        }
      }
      return { ok: false, detail: `the depot has no ${wanted.join(', ')}` };
    },
    find_chest: () => {
      // A person's chest is not the community's: it is found, and then
      // left alone. (The depot chest was placed by the world, so it is
      // not in the ledger.)
      const feet = bot.entity.position.floored();
      const found = findByIds(bot, registry, ['chest', 'trapped_chest'], 32, feet, true);
      if (!found) return null;
      if (guard.isPlayerChest(found.position)) {
        return { player_chest: true, x: found.position.x, y: found.position.y, z: found.position.z };
      }
      return { x: found.position.x, y: found.position.y, z: found.position.z };
    },
    nearby_players: () =>
      Object.values(bot.players)
        .filter((p) => p && p.position && p.username !== bot.username)
        .map((p) => ({
          name: p.username,
          distance: Math.round(p.position.distanceTo(bot.entity.position) * 10) / 10,
        })),
    look_at: async (x, y, z) => {
      await bot.lookAt(new Vec3(x, y, z), true);
      return { ok: true };
    },

    // --- what the bot may do -------------------------------------------------
    dig: async (x, y, z) => {
      const block = blockAt(x, y, z);
      if (!block) return { ok: false, detail: 'there is no block there' };
      if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
        return { ok: false, detail: 'there is nothing to mine there' };
      }
      // A person's block is never mined, however good it looks. This is
      // the workface of the no-grief rule: every skill digs through
      // here, so every skill is held to it.
      const verdict = guard.mayDig(block.position);
      if (!verdict.ok) {
        return { ok: false, detail: `not mining that: ${verdict.why}` };
      }
      try {
        await approach(bot, block.position);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        await bot.dig(block);
        // The dig is a packet, not a promise: the server refuses one
        // that is out of reach, and mineflayer does not notice. So the
        // builder looks at the block afterwards and says so when it is
        // still there. A dig that silently did nothing is how a
        // builder "mines" for hours and carries nothing.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const still = blockAt(
          block.position.x,
          block.position.y,
          block.position.z
        );
        if (still && still.name === block.name) {
          return { ok: false, detail: `the ${block.name} did not break` };
        }
        counters.mined += 1;
        // The block is broken but the item is on the ground: walk onto
        // it so it is actually collected. Otherwise a builder "mined"
        // for hours and never carried anything, and the world would
        // look like it was working while it was not.
        const collected = await collectAt(bot, block.position);
        return {
          ok: true,
          detail: collected ? `mined ${block.name} and collected it` : `mined ${block.name}`,
        };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    place: async (name, x, y, z) => {
      const item = bot.inventory.items().find((i) => i.name === name);
      if (!item) return { ok: false, detail: `the bot has no ${name}` };
      const position = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
      // The build-side of the no-grief rule: a builder builds beside a
      // person's build only when the person invited it.
      const verdict = guard.mayPlace(position);
      if (!verdict.ok) {
        return { ok: false, detail: `not building there: ${verdict.why}` };
      }
      const target = bot.blockAt(position);
      if (
        target &&
        target.name !== 'air' &&
        target.name !== 'cave_air' &&
        target.name !== 'void_air'
      ) {
        return { ok: false, detail: `there is already a ${target.name} there` };
      }
      // mineflayer does not place a block at a point; it places against
      // a neighbour's face. So the neighbour is found — the ground under
      // the target first, then a wall beside it — and the face is the one
      // that points at the target.
      let reference = null;
      let face = null;
      for (const direction of FACES) {
        const neighbour = bot.blockAt(position.minus(direction));
        if (
          neighbour &&
          neighbour.boundingBox !== 'empty' &&
          neighbour.name !== 'air'
        ) {
          reference = neighbour;
          face = direction;
          break;
        }
      }
      if (!reference) return { ok: false, detail: 'there is nothing to build against there' };
      try {
        await approach(bot, position);
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(reference, face);
        counters.placed += 1;
        guard.ownPlacement(position);
        return { ok: true, detail: `placed ${name}` };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    move_to: async (x, y, z) => {
      try {
        await gotoNear(bot, x, y, z, 2);
        return { ok: true, detail: `walked to ${x}, ${y}, ${z}` };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    equip: async (name) => {
      const item = bot.inventory.items().find((i) => i.name === name);
      if (!item) return { ok: false, detail: `the bot has no ${name}` };
      try {
        await bot.equip(item, 'hand');
        return { ok: true, detail: `holding ${name}` };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    craft: async (name, count) => {
      const wanted = count || 1;
      const item = registry.itemsByName[name];
      if (!item) return { ok: false, detail: `there is no item called ${name}` };
      const recipes = bot.recipesFor(item.id, null, wanted);
      if (!recipes.length) return { ok: false, detail: `there is no recipe for ${name}` };
      try {
        await bot.craft(recipes[0], wanted);
        return { ok: true, detail: `crafted ${wanted} ${name}` };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    attack: async (name) => {
      const target = Object.values(bot.entities).find(
        (e) => e && e.name === name && e.position
      );
      if (!target) return { ok: false, detail: `there is no ${name} to attack` };
      // Never a person. Whatever a skill asks for, a player is not it.
      if (target.type === 'player' || target.username) {
        return { ok: false, detail: 'the builders never attack a player' };
      }
      try {
        await bot.attack(target);
        return { ok: true, detail: `attacked ${name}` };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    wait: async (ticks) => {
      const ms = Math.min(Math.max(Number(ticks) || 0, 0) * TICK_MS, 10000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { ok: true };
    },
    open_chest: async () => {
      try {
        if (openChest) {
          openChest.close();
          openChest = null;
        }
        const block = findByIds(
          bot,
          registry,
          ['chest', 'trapped_chest'],
          32,
          bot.entity.position.floored(),
          true
        );
        if (!block) return { ok: false, detail: 'there is no chest nearby' };
        // Never a person's chest: not opened, not emptied, not touched.
        if (guard.isPlayerChest(block.position)) {
          return { ok: false, detail: 'that chest is a player\u2019s; leaving it alone' };
        }
        await approach(bot, block.position);
        openChest = await bot.openContainer(block);
        return { ok: true, detail: 'the chest is open' };
      } catch (err) {
        openChest = null;
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    deposit: async (name, count) => {
      if (!openChest) return { ok: false, detail: 'no chest is open' };
      const item = registry.itemsByName[name];
      if (!item) return { ok: false, detail: `there is no item called ${name}` };
      const have = bot.inventory.count(name, null);
      if (!have) return { ok: false, detail: `the bot has no ${name}` };
      const wanted = Math.min(Number(count) || have, have);
      try {
        await openChest.deposit(item, null, wanted);
        return { ok: true, detail: `put ${wanted} ${name} in the chest` };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
    withdraw: async (name, count) => {
      if (!openChest) return { ok: false, detail: 'no chest is open' };
      const item = registry.itemsByName[name];
      if (!item) return { ok: false, detail: `there is no item called ${name}` };
      const wanted = Math.min(Number(count) || 1, openChest.containerItems().length
        ? openChest.containerItems().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)
        : 0);
      if (!wanted) return { ok: false, detail: `the chest has no ${name}` };
      try {
        await openChest.withdraw(item, null, wanted);
        return { ok: true, detail: `took ${wanted} ${name} from the chest` };
      } catch (err) {
        return { ok: false, detail: String((err && err.message) || err) };
      }
    },
  };
}

/** Walk next to a block, if the bot is not close enough to work on it. */
async function approach(bot, position) {
  const distance = bot.entity.position.distanceTo(position);
  // Two blocks, not four: the server refuses a dig from further than
  // the builder's reach, and the drop is only picked up from close by.
  if (distance <= 2) return;
  try {
    await gotoNear(bot, position.x, position.y, position.z, 2, 12000);
  } catch (err) {
    // The planner could not get there. Mineflayer's dig is forgiving
    // about the exact distance, so carry on and let it try.
  }
}

/**
 * Walk onto the item that is lying where the block was.
 *
 * The drop appears at the block's own position, so the bot goes there
 * and waits: the server hands the item over when the bot is close
 * enough. Looking for the item entity instead is fragile — the entity
 * names have changed across versions — and the block's position is
 * known exactly.
 */
async function collectAt(bot, position) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await gotoNear(bot, position.x, position.y, position.z, 1);
    } catch (err) {
      // Could not walk there: the item stays on the ground.
      return false;
    }
    // The server hands the item over when the bot is close enough; it
    // takes a moment, so the wait is generous.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  // If the item is still lying about, go to the item itself: the block
  // position is close, but "close" is not "inside the pickup range".
  return collectEntity(bot);
}

/** Walk to the dropped item that is nearest, so it is picked up. */
async function collectEntity(bot) {
  const drops = Object.values(bot.entities).filter(
    (e) => e && e.position && (e.name === 'item' || e.name === 'Item' || e.name === 'item_stack')
  );
  if (!drops.length) return false;
  const drop = drops.sort(
    (a, b) =>
      a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
  )[0];
  try {
    await gotoNear(bot, drop.position.x, drop.position.y, drop.position.z, 0);
  } catch (err) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  return true;
}

/**
 * Build the sandbox.
 *
 * The context is created empty. The API wrappers are built inside it,
 * so the host object is never a property of anything the skill can reach.
 */
function createSandbox(hostApi) {
  const context = vm.createContext(
    {},
    {
      name: 'agent-world-skill',
      codeGeneration: { strings: false, wasm: false },
    }
  );

  const factory = vm.runInContext(
    `(function (host) {
       const api = {};
       for (const key of Object.keys(host)) {
         api[key] = (...args) => host[key](...args);
       }
       // Put the words on the context's own global, from inside the
       // context: a skill sees them as globals, and there is no way
       // back to the host object that made them.
       Object.assign(globalThis, api);
       return api;
     })`,
    context
  );
  const api = factory(hostApi);

  return {
    context,
    /**
     * Run one skill body. The body is the body of an async function,
     * which is what it is: a skill awaits its actions.
     */
    async run(body) {
      const script = new vm.Script(`(async () => {\n${body}\n})()`, {
        filename: 'skill.js',
      });
      return await script.runInContext(context, { timeout: 30000 });
    },
  };
}

module.exports = { buildApi, createSandbox, givePathfinding, gotoNear, TICK_MS };
