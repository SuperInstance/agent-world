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
 * Teach a bot to walk.
 *
 * mineflayer-pathfinder is a plugin now: `bot.loadPlugin(pathfinder)`
 * gives the bot `bot.pathfinder`, and `goto` takes a goal. The
 * movements let the planner dig through a block on its way, which is
 * what a builder in a quarry needs.
 */
function givePathfinding(bot) {
  if (bot.pathfinder && typeof bot.pathfinder.goto === 'function') return;
  bot.loadPlugin(pathfinderPlugin);
  const movements = new Movements(bot);
  movements.canDigBlocks = true;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  bot.pathfinder.setMovements(movements);
}

/**
 * Walk to within `distance` blocks of a point.
 *
 * The deadline matters: the planner retries an unreachable goal for as
 * long as it likes, and a builder that waits forever on a log it can
 * never reach is a builder that has stopped working. So every walk has
 * a clock, and a walk that runs out of time is a failure the skill can
 * hear about.
 */
async function gotoNear(bot, x, y, z, distance = 2, timeout = 20000) {
  let timer = null;
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(x, y, z, distance)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the walk took too long')), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Never leave a goal set: a stale goal makes the bot walk on.
    try {
      bot.pathfinder.stop();
    } catch (err) {
      // The pathfinder may not have been given a goal at all.
    }
  }
}

/**
 * Where the community's depot is.
 *
 * The world spawn: every builder appears there and every builder can
 * find it, without anyone telling them where it is.
 */
function depotSpot(bot) {
  const spot = bot.spawnPoint || bot.entity.position;
  return {
    x: Math.floor(spot.x),
    y: Math.floor(spot.y),
    z: Math.floor(spot.z),
  };
}

/** The vocabulary: the words a skill may use, and what they do. */
function buildApi(bot, counters) {
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
      const found = bot.findBlock({
        matching: (block) => (names ? names.includes(block.name) : block.name !== 'air'),
        maxDistance,
      });
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
      const item = registry.itemsByName[name];
      if (!item) return { ok: false, detail: `there is no item called ${name}` };
      const have = bot.inventory.count(name, null);
      if (!have) return { ok: false, detail: `the bot has no ${name} to leave` };
      const wanted = Math.min(Number(count) || have, have);
      const spot = depotSpot(bot);
      try {
        await gotoNear(bot, spot.x, spot.y, spot.z, 0);
      } catch (err) {
        // Walk as close as the planner allows and carry on: the item
        // lands at the bot's feet either way.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      await bot.toss(item, null, wanted);
      return { ok: true, detail: `left ${wanted} ${name} at the depot` };
    },
    take_from_depot: async (name) => {
      const spot = depotSpot(bot);
      const before = bot.inventory.count(name, null);
      // The item lands at the gatherer's feet at the depot, which is
      // within a block or two of the spawn point. So the taker walks a
      // small ring around the depot and checks what it is holding after
      // each step: the pickup happens when the bot walks over the item,
      // and a single walk to the centre is not always close enough.
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
        await new Promise((resolve) => setTimeout(resolve, 500));
        const now = bot.inventory.count(name, null);
        if (now > before) {
          return { ok: true, count: now, detail: `the bot has ${now} ${name}` };
        }
      }
      return { ok: false, count: before, detail: `the depot has no ${name}` };
    },
    find_chest: () => {
      const found = bot.findBlock({
        matching: (block) => block.name === 'chest' || block.name === 'trapped_chest',
        maxDistance: 32,
      });
      if (!found) return null;
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
      try {
        await approach(bot, block.position);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        await bot.dig(block);
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
      const blockType = registry.blocksByName[name];
      if (!blockType) return { ok: false, detail: `there is no block called ${name}` };
      const position = new Vec3(x, y, z);
      try {
        await approach(bot, position);
        await bot.equip(item, 'hand');
        await bot.placeBlock(blockType, position);
        counters.placed += 1;
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
        const block = bot.findBlock({
          matching: (b) => b.name === 'chest' || b.name === 'trapped_chest',
          maxDistance: 32,
        });
        if (!block) return { ok: false, detail: 'there is no chest nearby' };
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
  if (distance <= 4) return;
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
