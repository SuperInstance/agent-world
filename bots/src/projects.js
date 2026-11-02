'use strict';
// bots/src/projects.js — the work itself: executing a ratified project.
//
// A project's plan is its ratified scope: the exact block list the
// validator allowed. Every executor is **idempotent over that list** —
// each step it walks the plan, finds what the world still lacks, and
// does the next honest unit of work (walk, dig, craft, till, place).
// Nothing is placed that the plan does not name, so a re-run after an
// issue is the same code that built it (the fix is the build), and a
// builder interrupted mid-plan loses nothing but time.
//
// The roles, as the brief sets them:
//   * the **gatherer supplies** — raw materials to the site of any
//     active project whose materials are not yet staged;
//   * the **builder builds** — to the plan (chest, path, shelter);
//   * the **farmer grows** — the replant and the farm;
//   * the **scout tests** — walks the finished work, files issues.
//
// Every step returns { done, detail } and is recorded as a play
// (skill `project.<kind>`, prediction none: a step is not scored, it
// is *counted* — the board holds the number). If the step hit a
// person's radius the guard said no and the step says so; if the
// materials are not there yet the step waits *at the site*, where the
// gatherer's delivery lands in the builder's bag.

const { checkEdit } = require('./validator');
const { GATHERABLE_NAMES } = require('./materials');

/** Place one planned block through both doors: scope, then no-grief. */
async function projectPlace(agent, project, name, x, y, z) {
  const verdict = checkEdit(project, name, x, y, z, agent.guard);
  if (!verdict.ok) {
    agent.log.note({
      bot: agent.name,
      event: 'edit_denied',
      project: project.id,
      at: `${x},${y},${z}`,
      name,
      why: verdict.why,
    });
    return { ok: false, detail: `not placed: ${verdict.why}` };
  }
  const placed = await agent.api.place(name, x, y, z);
  if (placed.ok) {
    const current = project.placed || 0;
    const total = project.scope.blocks.length;
    // Progress is written every few blocks (and at the end): the board
    // is a record, not a heartbeat.
    if ((current + 1) % 4 === 0 || current + 1 >= total) {
      agent.shared.board.progress(project.id, current + 1);
    } else {
      project.placed = current + 1;
    }
  }
  return placed;
}

/** The blocks of the plan the world does not have yet. */
function missingBlocks(agent, project) {
  const out = [];
  for (const block of project.scope.blocks) {
    const there = agent.api.block_at(block.x, block.y, block.z);
    if (there !== block.name) out.push(block);
  }
  return out;
}

/** Walk near a point, close enough to work and to catch deliveries. */
async function standNear(agent, x, y, z) {
  const where = agent.position();
  if (where && Math.hypot(where.x - x, where.z - z) <= 3) return true;
  await agent.api.move_to(x, y, z);
  return true;
}

// --- the executors --------------------------------------------------------------

/** A bench for the 3x3 crafts, placed at the site's edge when the
 *  world has none (four planks, the no-grief guard holding). The bench
 *  is the community's own tool, not a project block — the scope does
 *  not name it, and the crafts it unlocks are the project's whole
 *  point (2026-11-02: "there is no recipe for chest" while Timber
 *  held eight planks). */
async function ensureBench(agent) {
  const have = agent.api.find_block({ names: ['crafting_table'], max_distance: 16 });
  if (have) return { ok: true, detail: 'a bench is near' };
  if (agent.api.inventory_count('crafting_table') < 1) {
    if (agent.api.inventory_count('oak_planks') < 4) {
      return { ok: false, detail: 'no bench for the craft, and fewer than 4 planks' };
    }
    const made = await agent.api.craft('crafting_table', 1);
    if (!made.ok) return { ok: false, detail: `no bench: ${made.detail}` };
  }
  const feet = agent.position();
  if (!feet) return { ok: false, detail: 'no bench: nowhere to stand one' };
  const { Vec3 } = require('vec3');
  for (let r = 1; r <= 3; r += 1) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const x = Math.floor(feet.x) + dx;
      const z = Math.floor(feet.z) + dz;
      for (let y = Math.floor(feet.y) + 1; y >= Math.floor(feet.y) - 2; y -= 1) {
        const at = agent.bot.blockAt(new Vec3(x, y, z));
        const below = agent.bot.blockAt(new Vec3(x, y - 1, z));
        if (!at || !below) continue;
        if (at.name !== 'air' || below.name === 'air') continue;
        const placed = await agent.api.place('crafting_table', x, y, z);
        if (placed.ok) return { ok: true, detail: `placed a bench at ${x},${y},${z}` };
      }
    }
  }
  return { ok: false, detail: 'no bench: no open ground beside the builder' };
}

/** depot-chest: craft the chest (from staged logs), place it. */
async function buildDepotChest(agent, project) {
  const missing = missingBlocks(agent, project);
  if (!missing.length) return { done: true, detail: 'the chest stands' };
  const block = missing[0];

  if (agent.api.inventory_count('chest') < 1) {
    // Craft it: 8 planks, from the staged (or carried) logs.
    if (agent.api.inventory_count('oak_planks') < 8) {
      const logs = agent.bot.inventory.items().filter((i) => i.name.endsWith('_log'));
      if (logs.length) {
        const crafted = await agent.api.craft('oak_planks', 8);
        if (crafted.ok) return { done: false, detail: 'split logs into planks' };
      }
      const staged = await agent.api.take_from_depot(['oak_log']);
      if (staged && staged.ok) return { done: false, detail: `took ${staged.count} log(s) from the depot` };
      // A delivery is a toss, and a tossed item skids: the wood may be
      // lying at the site itself, two blocks from the one it was for.
      const picked = await agent.api.pickup_near(project.site.x, project.site.z, 6);
      if (picked) return { done: false, detail: `picked up ${picked} delivered item(s) at the site` };
      await standNear(agent, block.x, block.y, block.z);
      return { done: false, detail: 'waiting at the site for wood' };
    }
    const bench = await ensureBench(agent);
    if (!bench.ok) return { done: false, detail: bench.detail };
    const crafted = await agent.api.craft('chest', 1);
    if (!crafted.ok) return { done: false, detail: crafted.detail };
    return { done: false, detail: 'crafted the chest' };
  }

  await standNear(agent, block.x, block.y, block.z);
  const placed = await projectPlace(agent, project, 'chest', block.x, block.y, block.z);
  if (placed.ok) {
    agent.say(`the depot has a chest now — goods go in it, not on the ground`);
    return { done: true, detail: 'placed the depot chest' };
  }
  return { done: false, detail: placed.detail };
}

/** replant: saplings from the standing trees' leaves, planted on the plan. */
async function growReplant(agent, project) {
  const missing = missingBlocks(agent, project);
  if (!missing.length) return { done: true, detail: 'the forest plan is planted' };

  if (agent.api.inventory_count('oak_sapling') < 1) {
    // Saplings come from leaves. A leaf broken is a chance, not a
    // promise — the step keeps at it, a few leaves per tick.
    let found = null;
    for (let tries = 0; tries < 4 && !found; tries++) {
      const leaf = agent.api.find_block({
        names: ['oak_leaves', 'spruce_leaves', 'birch_leaves'],
        max_distance: 24,
        any_level: true,
      });
      if (!leaf) break;
      const dug = await agent.api.dig(leaf.x, leaf.y, leaf.z);
      if (agent.api.inventory_count('oak_sapling') > 0) found = true;
      else if (!dug.ok) break;
    }
    if (agent.api.inventory_count('oak_sapling') > 0) {
      return { done: false, detail: 'a sapling came out of the leaves' };
    }
    const near = missing[0];
    await standNear(agent, near.x, near.y, near.z);
    return { done: false, detail: found ? 'leaves broken, no sapling yet' : 'no leaves within reach for saplings' };
  }

  const block = missing[0];
  await standNear(agent, block.x, block.y, block.z);
  const placed = await projectPlace(agent, project, 'oak_sapling', block.x, block.y, block.z);
  return placed.ok
    ? { done: missing.length === 1, detail: `planted a sapling (${project.placed || 0} of ${project.scope.blocks.length})` }
    : { done: false, detail: placed.detail };
}

/** Break seed-bearing grass until the bag holds `wanted` seeds — one
 *  walk, the whole patch, not one break per project step. Day one the
 *  seed want cost ~36 s per break (the step's whole decision cadence
 *  for a single dig), which put 14 seeds at more than an hour of
 *  serial grinding; a batched run spends the walk once and breaks the
 *  patch at the digger's own pace. The clock bound keeps the step a
 *  step; grass beyond `reach` ends the run honestly. */
async function gatherSeeds(agent, wanted, { seconds = 90, reach = 48 } = {}) {
  const deadline = Date.now() + seconds * 1000;
  let broken = 0;
  while (agent.api.inventory_count('wheat_seeds') < wanted && Date.now() < deadline) {
    const grass = agent.api.find_block({
      names: ['short_grass', 'tall_grass', 'grass', 'fern'],
      max_distance: reach,
    });
    if (!grass) break;
    const dug = await agent.api.dig(grass.x, grass.y, grass.z);
    if (!dug.ok) break;
    broken += 1;
  }
  return { broken, got: agent.api.inventory_count('wheat_seeds') };
}

/** farm: hoe, seeds, till, plant — the plan is farmland plus wheat. */
async function growFarm(agent, project) {
  const missing = missingBlocks(agent, project);
  if (!missing.length) return { done: true, detail: 'the farm is tilled and planted' };

  const wheat = missing.filter((b) => b.name === 'wheat');
  const farmland = missing.filter((b) => b.name === 'farmland');

  // The materials: a hoe (2 planks + 2 sticks, so 4 planks and some
  // sticks), and seeds (from the grass). The bill names logs, not a
  // hoe: the gatherer carries logs and the owner crafts (2026-11-02).
  if (agent.api.inventory_count('wooden_hoe') < 1 && farmland.length) {
    if (agent.api.inventory_count('oak_planks') < 4) {
      const logs = agent.bot.inventory.items().filter((i) => i.name.endsWith('_log'));
      if (logs.length) {
        await agent.api.craft('oak_planks', 4);
        return { done: false, detail: 'split logs for the hoe' };
      }
      const staged = await agent.api.take_from_depot(['oak_log']);
      if (staged && staged.ok) return { done: false, detail: 'took a log for the hoe' };
      // A delivery is a toss, and a tossed item skids: the wood may be
      // lying at the site itself, two blocks from the one it was for.
      const pickedHoe = await agent.api.pickup_near(project.site.x, project.site.z, 6);
      if (pickedHoe) return { done: false, detail: `picked up ${pickedHoe} delivered item(s) for the hoe` };
      await standNear(agent, project.site.x, project.site.y, project.site.z);
      return { done: false, detail: 'waiting at the site for wood (the hoe)' };
    }
    // A hoe is 2 planks and 2 sticks: the craft fails without the
    // sticks, so they are split out of a plank first.
    if (agent.api.inventory_count('stick') < 2) {
      const crafted = await agent.api.craft('stick', 2);
      if (!crafted.ok) return { done: false, detail: `no sticks for the hoe: ${crafted.detail}` };
      return { done: false, detail: 'split planks for the sticks' };
    }
    const bench = await ensureBench(agent);
    if (!bench.ok) return { done: false, detail: bench.detail };
    const crafted = await agent.api.craft('wooden_hoe', 1);
    if (!crafted.ok) return { done: false, detail: crafted.detail };
    return { done: false, detail: 'crafted the hoe' };
  }

  if (wheat.length && agent.api.inventory_count('wheat_seeds') < wheat.length) {
    // Delivered seeds may be lying at the site (a supply toss skids):
    // pick them up before grinding for more.
    await agent.api.pickup_near(project.site.x, project.site.z, 8);
    if (agent.api.inventory_count('wheat_seeds') < wheat.length) {
      // short_grass is this version's seed-bearing plant ("grass" is
      // not in the registry); the terrace by the farm is covered in it.
      // One batched run per step, not one break: the want is the whole
      // plot's seeds, and the patch is walked once.
      const run = await gatherSeeds(agent, wheat.length);
      if (run.broken === 0 && agent.api.inventory_count('wheat_seeds') < 1) {
        await standNear(agent, project.site.x, project.site.y, project.site.z);
        return { done: false, detail: 'no seed grass within reach of the farm' };
      }
      return {
        done: false,
        result: run.broken ? 'win' : undefined,
        detail: `seed run: ${run.broken} grass broken, ${agent.api.inventory_count('wheat_seeds')} of ${wheat.length} seeds in hand`,
      };
    }
    return { done: false, detail: 'seeds in hand for the planting' };
  }

  // Till first (the farmland rows), then plant.
  const target = farmland[0] || wheat[0];
  await standNear(agent, target.x, target.y, target.z);
  if (farmland.length) {
    const block = farmland[0];
    const verdict = checkEdit(project, 'farmland', block.x, block.y, block.z, agent.guard);
    if (!verdict.ok) return { done: false, detail: `not tilled: ${verdict.why}` };
    const held = await agent.api.equip('wooden_hoe');
    if (!held.ok) return { done: false, detail: held.detail };
    try {
      const dirt = agent.bot.blockAt(
        new (require('vec3').Vec3)(block.x, block.y, block.z)
      );
      if (!dirt || dirt.name === 'farmland') {
        return { done: false, detail: dirt ? 'already tilled' : 'the ground is not loaded' };
      }
      await agent.bot.lookAt(
        new (require('vec3').Vec3)(block.x + 0.5, block.y + 0.5, block.z + 0.5),
        true
      );
      await agent.bot.activateBlock(dirt);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const now = agent.api.block_at(block.x, block.y, block.z);
      if (now === 'farmland') {
        const current = project.placed || 0;
        if ((current + 1) % 4 === 0 || current + 1 >= project.scope.blocks.length) {
          agent.shared.board.progress(project.id, current + 1);
        } else {
          project.placed = current + 1;
        }
        return { done: false, detail: 'tilled a row' };
      }
      return { done: false, detail: 'the hoe did not till it' };
    } catch (err) {
      return { done: false, detail: `the hoe: ${String(err.message || err)}` };
    }
  }

  const block = wheat[0];
  const placed = await projectPlace(agent, project, 'wheat_seeds', block.x, block.y, block.z);
  if (placed.ok && !missingBlocks(agent, project).length) {
    agent.say('the first farm is in — wheat by the depot');
    return { done: true, detail: 'the farm is planted' };
  }
  return { done: false, detail: placed.ok ? 'planted seeds' : placed.detail };
}

/** path / shelter: place the planned blocks; wait at the site for materials. */
async function buildPlanned(agent, project) {
  const missing = missingBlocks(agent, project);
  if (!missing.length) {
    return { done: true, detail: `every planned block stands (${project.scope.blocks.length})` };
  }
  const names = Array.from(new Set(missing.map((b) => b.name)));
  const name = names.find((n) => agent.api.inventory_count(n) > 0);

  if (!name) {
    // Nothing in hand: the depot (chest or pile) first, then the site,
    // where the gatherer's delivery lands in the bag.
    for (const want of names) {
      if (want === 'oak_planks' || want === 'stick') {
        const logs = agent.bot.inventory.items().filter((i) => i.name.endsWith('_log'));
        if (logs.length) {
          await agent.api.craft('oak_planks', 8);
          return { done: false, detail: 'split logs into planks' };
        }
        continue;
      }
      const taken = await agent.api.take_from_depot([want]);
      if (taken && taken.ok) return { done: false, detail: `took ${taken.count} ${want} from the depot` };
    }
    const block = missing[0];
    await standNear(agent, block.x, block.y, block.z);
    return { done: false, detail: `waiting at the site for ${names.join(', ')}` };
  }

  const block = missing.find((b) => b.name === name);
  await standNear(agent, block.x, block.y, block.z);
  const placed = await projectPlace(agent, project, name, block.x, block.y, block.z);
  if (placed.ok && !missingBlocks(agent, project).length) {
    agent.say(`${project.title} is up`);
    return { done: true, detail: 'the last planned block is placed' };
  }
  return { done: false, detail: placed.ok ? `placed ${name}` : placed.detail };
}

/** ramp: terraform, not construction — each step's column is dug down
 *  to the step, then finished with the scope's cobblestone, so the old
 *  wall itself becomes the staircase out of the gully. One cell (or a
 *  few digs) per step; the dig list is derived from the world, not
 *  planned blind. */
async function buildRamp(agent, project) {
  const missing = missingBlocks(agent, project);
  if (!missing.length) {
    return { done: true, detail: 'every step of the ramp stands' };
  }
  const have = agent.api.inventory_count('cobblestone');
  if (have < 1) {
    const taken = await agent.api.take_from_depot(['cobblestone']);
    if (taken && taken.ok) return { done: false, detail: `took ${taken.count} cobblestone from the depot` };
    if (have < 1) {
      // The world's surface stone is the ramp's own material: a step or
      // two of quarrying pays for a step of stairs.
      const stone = agent.api.find_block({ names: ['stone', 'cobblestone'], max_distance: 24 });
      if (stone) {
        await agent.api.dig(stone.x, stone.y, stone.z);
        return { done: false, detail: 'quarried a stone for the steps' };
      }
      await standNear(agent, project.site.x, project.site.y, project.site.z);
      return { done: false, detail: 'waiting at the site for cobblestone' };
    }
  }
  // The lowest missing step first: the staircase is built from the
  // floor up, and every finished step is the footing for the next.
  const block = missing.slice().sort((a, b) => a.y - b.y)[0];
  await standNear(agent, block.x, block.y, block.z);
  // Carve the column down to the step: everything solid above the
  // step's own y (and a natural block sitting at the step's y, which
  // the cobblestone replaces) goes, a few blocks per step.
  let dug = 0;
  for (let y = block.y + 6; y >= block.y && dug < 8; y--) {
    const there = agent.api.block_at(block.x, y, block.z);
    if (!there || there === 'air' || there === 'cobblestone') continue;
    const out = await agent.api.dig(block.x, y, block.z);
    if (!out.ok) return { done: false, detail: `could not carve the step: ${out.detail}` };
    dug += 1;
  }
  const placed = await projectPlace(agent, project, 'cobblestone', block.x, block.y, block.z);
  if (placed.ok) {
    return {
      done: !missingBlocks(agent, project).length,
      detail: dug
        ? `carved ${dug} and placed a step (${project.placed || 0} of ${project.scope.blocks.length})`
        : `placed a step (${project.placed || 0} of ${project.scope.blocks.length})`,
    };
  }
  return { done: false, detail: placed.detail };
}

/** The tester: walk the finished work, file what is missing. */
async function testProject(agent, project) {
  await standNear(agent, project.site.x, project.site.y, project.site.z);
  const missing = missingBlocks(agent, project);
  const total = project.scope.blocks.length;
  if (missing.length) {
    agent.shared.board.fileIssue(
      project.id,
      `${missing.length} of ${total} planned blocks missing (first: ${missing[0].name} at ${missing[0].x},${missing[0].y},${missing[0].z})`
    );
    agent.say(`walked ${project.title}: ${missing.length} of ${total} still missing — filed for ${project.owner}`);
    return { done: true, detail: `issue filed: ${missing.length} missing of ${total}` };
  }
  // All there. Any open issue closes with the pass.
  for (const issue of project.issues) {
    if (!issue.fixed_at) agent.shared.board.fixIssue(project.id, issue.n);
  }
  agent.shared.board.finish(project.id);
  agent.say(`${project.title} passed the walk — ${total} blocks standing`);
  return { done: true, detail: `passed: ${total} of ${total}` };
}

// --- the supply duty (the gatherer) ---------------------------------------------

/** What materials does an active project still want from the world?
 *  Only the raws the gatherer can carry — the world's own list, in one
 *  place (materials.js), the same one the validator approves bills
 *  against. A bill names raws; the owner crafts the rest at the site. */
const DELIVERABLES = GATHERABLE_NAMES;

function supplyTarget(board) {
  for (const project of board.list()) {
    if (project.status !== 'active' || !project.owner) continue;
    const staged = project.staged || {};
    const wants = [];
    for (const [name, count] of Object.entries(project.materials || {})) {
      if (!DELIVERABLES.includes(name)) continue;
      const have = staged[name] || 0;
      if (have < count) wants.push({ name, count: count - have });
    }
    if (wants.length) return { project, wants };
  }
  return null;
}

/** One step of supplying: fetch what a project wants, carry it to the site. */
/** Refusals the hunt has already learned, this process's lifetime:
 *  "x,y,z" -> when it was refused. A candidate that was protected or
 *  unwalkable ten minutes ago may be tried again; one refused a moment
 *  ago is not re-bought at the price of a walk. */
const HUNT_MEMORY = new Map();

async function supplyStep(agent, board) {
  const target = supplyTarget(board);
  if (!target) return null; // nothing to supply: the tick falls through
  const { project, wants } = target;
  const want = wants[0];
  const staged = project.staged || {};
  // The bill names a canonical item; the world gives what it gives.
  // A log is a log to the craft bench, so wood is counted and
  // delivered by its family (the gatherer mined spruce all morning
  // for a bill that said oak, and the site never saw a log).
  const FAMILY = {
    oak_log: ['oak_log', 'spruce_log', 'birch_log', 'cherry_log', 'dark_oak_log', 'pale_oak_log', 'mangrove_log', 'acacia_log', 'jungle_log'],
    cobblestone: ['cobblestone', 'stone', 'cobbled_deepslate'],
  };
  const familyOf = (name) => FAMILY[name] || [name];
  const inHand = familyOf(want.name).reduce(
    (sum, name) => sum + agent.api.inventory_count(name), 0
  );

  if (inHand >= want.count) {
    // Carry them to the site and let them go: the owner stands there —
    // CLOSE. A toss from three blocks skids out of every pickup radius
    // and despawns five minutes later, and the board keeps saying
    // "staged" for wood the world no longer holds (2026-11-02, b037:
    // two logs staged at 11:26, gone by 11:31, Timber waiting still).
    // The walk is best effort — and if the site cannot be walked to
    // (the gully rim), the goods go to the depot pile instead: the
    // owner's take_from_depot walks that ring, and a pile the owner
    // reads beats a toss into the wild.
    // Distance two, not one: an adjacency goal into the gully rim
    // searches forever, and the walk that never concludes is how the
    // morning's deliveries landed wherever the gatherer happened to
    // stand (b037's wood was never at the site NOR the pile — probe
    // eyes saw both, empty, four seconds before despawn).
    let tossWhere = 'the site';
    const walkedIn = await agent.api
      .move_to(project.site.x, project.site.y, project.site.z, 2);
    if (!walkedIn.ok) {
      const home = agent.api.depot();
      const walkedHome = await agent.api.move_to(home.x + 2, home.y, home.z + 2, 2);
      tossWhere = walkedHome.ok ? 'the depot pile' : 'where the gatherer stands';
    }
    const from = agent.position();
    if (from) tossWhere += ` (${Math.round(from.x)},${Math.round(from.y)},${Math.round(from.z)})`;
    const item = agent.bot.inventory.items().find((i) => familyOf(want.name).includes(i.name));
    if (!item) return { done: false, detail: `the ${want.name} left the bag` };
    try {
      await agent.bot.toss(item.type, null, Math.min(item.count, want.count));
    } catch (err) {
      return { done: false, detail: 'the delivery would not leave the bag' };
    }
    const delivered = Math.min(item.count, want.count);
    staged[want.name] = (staged[want.name] || 0) + delivered;
    board.stagedMaterials(project.id, staged);
    agent.say(`${delivered} ${want.name.replace(/_/g, ' ')} for ${project.title}`);
    return {
      done: false,
      result: 'win',
      detail: `delivered ${delivered} ${want.name} to ${project.id}, tossed at ${tossWhere}`,
    };
  }

  // Fetch. The gather is direct — into the bag, not through the
  // library's gather skills, whose honest behaviour is to leave
  // everything at the depot (a fine end for idle work, and a leak in
  // a supply run: the gatherer dropped the log at the pile it was
  // asked to carry past, and the owner waited at the site while the
  // wood piled up six blocks away). The reflex still owns the idle
  // ticks; this is a delivery, and the delivery is the plan's.
  if (want.name === 'oak_log') {
    // The depot pile may already hold what the site wants — the idle
    // skills drop everything there — and a delivery that walks past a
    // pile of logs to chop new ones is not a supply chain.
    const taken = await agent.api.take_from_depot(['oak_log', 'spruce_log', 'birch_log']);
    if (taken && taken.ok) {
      return { done: false, result: 'win', detail: `took ${taken.count} ${taken.name} from the depot` };
    }
    const home = agent.api.depot();
    const near = agent.position();
    if (!near || Math.hypot(near.x - home.x, near.z - home.z) > 64) {
      await agent.api.move_to(home.x + 4, home.y, home.z + 4);
    }
    const names = ['oak_log', 'spruce_log', 'birch_log', 'cherry_log', 'dark_oak_log', 'pale_oak_log', 'mangrove_log', 'acacia_log', 'jungle_log'];
    // A tree is only wood if the gatherer can STAND at it. The depot's
    // two spruces grow on a hill face the planner cannot climb, and a
    // dig packet the server accepts anyway mines a block whose drop
    // falls where nobody stands (probe-wood plus the holding counts,
    // 2026-11-02: "mined spruce_log (holding 0)"). So: walk first, and
    // only a walk that arrives may dig; a tree that will not be walked
    // to is tried no longer. Somebody's neighbour (the no-grief
    // keep-out) is passed by the same door.
    //
    // Two rules keep the hunt short, because a long hunt is a long
    // silence and the detector reads a long silence as a stall:
    //
    // * the search looks for wood **within a band above the feet**
    //   (max_y: the feet plus twelve — a terrace or two up, never the
    //   canopy). The feet-plus-two band of 2026-11-02 went blind the
    //   moment the gatherer stood in the depot gully: Pebble at y=61,
    //   every standing log at y=64-70 (probe-crew-wood.js), and the
    //   hunt answered "no tree within reach" while logs stood seven
    //   blocks away — the community starved on a window. The band
    //   still excludes the hillside canopy ten blocks up (y=83-86),
    //   and the nearest-first ordering (api.js) tries the gully-edge
    //   logs long before any climb; a walk that does not arrive is
    //   excluded and the next-nearest is tried.
    // * a tree inside somebody's keep-out is **skipped without a
    //   walk**: the guard knows before the feet move, and the refuse
    //   is free.
    const feet = agent.position() || { y: 70 };
    const tried = [];
    // The refusals, said: "protected or unreachable" starved the crew
    // for an hour on 2026-11-02 without a word about which tree or
    // why — the log of record now carries the candidate and its
    // refusal (the guard's why, or the walk's own words).
    const why = [];
    // ...and the refusals are REMEMBERED. The five nearest candidates
    // to a gatherer in the depot gully are three keep-out refusals and
    // two walk failures, and `tried` reset every step — so every step
    // bought the same five refusals and never reached the sixth
    // candidate, the nearest log actually allowed (2026-11-02, the
    // 11:10 hunts: (2,64,0) protected, (9,62,0) walk, (6,68,5)
    // protected, (5,68,10) walk, (3,67,0) protected — the allowed
    // (0,68,2) never tried). A refusal cools ten minutes; a walk
    // budget (five walks) is spent only on walks — a refusal is free
    // to learn, as it always should have been.
    const now = Date.now();
    for (const [key, row] of HUNT_MEMORY) {
      if (now - row.at > 10 * 60 * 1000) HUNT_MEMORY.delete(key);
    }
    const refused = (key, reason) => {
      why.push(reason);
      HUNT_MEMORY.set(key, { at: now });
    };
    let walks = 0;
    for (let seen = 0; seen < 24 && walks < 5; seen += 1) {
      const log = agent.api.find_block({
        names,
        max_distance: 96,
        any_level: true,
        max_y: Math.round(feet.y) + 12,
        exclude: tried,
      });
      if (!log) {
        return {
          done: false,
          detail: why.length
            ? `no tree left to try: ${why.slice(0, 5).join(' | ')}`
            : 'no tree within reach of the depot',
        };
      }
      tried.push(`${log.x},${log.y},${log.z}`);
      const key = `${log.x},${log.y},${log.z}`;
      if (HUNT_MEMORY.has(key)) continue; // a refusal that has not cooled
      // The keep-out, checked before the feet move: a neighbour's
      // block is never mined, and the refusal costs nothing to learn.
      const mayDig = agent.guard && agent.guard.mayDig
        ? agent.guard.mayDig({ x: log.x, y: log.y, z: log.z })
        : { ok: true };
      if (!mayDig.ok) {
        refused(key, `(${log.x},${log.y},${log.z}) ${mayDig.why}`);
        continue;
      }
      // Dig directly — the library's own gather skill does, and it is
      // the one way wood has actually moved all day (11:36: "found a
      // tree at its own level, mined a log", from the same gully floor
      // where the hunt's separate walk failed every candidate).
      // api.dig's approach walks the last steps best effort (12 s,
      // forgiving of distance), the guard still rules inside the dig,
      // and collectAt chases the drop. A strict walk-first was the
      // morning's whole failure surface: the follower sticks at the
      // gully's 1-up steps and the hunt read "unreachable" for trees
      // standing at the gatherer's own level.
      walks += 1;
      const dug = await agent.api.dig(log.x, log.y, log.z);
      if (dug.ok) {
        HUNT_MEMORY.delete(key);
        return { done: false, result: 'win', detail: dug.detail };
      }
      if (!dug.detail.includes('not mining') && !dug.detail.includes('too deep')) {
        return { done: false, detail: dug.detail };
      }
      refused(key, `(${log.x},${log.y},${log.z}) dig: ${dug.detail}`);
    }
    return {
      done: false,
      detail: `every tree within reach is protected or unreachable: ${why.slice(0, 5).join(' | ')}`,
    };
  }
  if (want.name === 'cobblestone') {
    const taken = await agent.api.take_from_depot(['cobblestone', 'stone', 'cobbled_deepslate']);
    if (taken && taken.ok) {
      return { done: false, result: 'win', detail: `took ${taken.count} ${taken.name} from the depot` };
    }
    const home = agent.api.depot();
    const near = agent.position();
    if (!near || Math.hypot(near.x - home.x, near.z - home.z) > 64) {
      await agent.api.move_to(home.x + 4, home.y, home.z + 4);
    }
    const names = ['stone', 'andesite', 'diorite', 'granite'];
    const tried = [];
    for (let look = 0; look < 4; look++) {
      const stone = agent.api.find_block({ names, max_distance: 48, min_y: 50, exclude: tried });
      if (!stone) return { done: false, detail: 'no surface stone within reach of the depot' };
      const dug = await agent.api.dig(stone.x, stone.y, stone.z);
      if (dug.ok) return { done: false, result: 'win', detail: dug.detail };
      tried.push(`${stone.x},${stone.y},${stone.z}`);
      if (!dug.detail.includes('not mining')) return { done: false, detail: dug.detail };
    }
    return { done: false, detail: 'every surface stone within reach is protected or unreachable' };
  }
  if (want.name === 'oak_sapling') {
    const leaf = agent.api.find_block({
      names: ['oak_leaves', 'spruce_leaves', 'birch_leaves'],
      max_distance: 24,
      any_level: true,
    });
    if (leaf) {
      const dug = await agent.api.dig(leaf.x, leaf.y, leaf.z);
      return { done: false, result: dug.ok ? 'win' : undefined, detail: dug.detail };
    }
    return { done: false, detail: 'no leaves for saplings nearby' };
  }
  if (want.name === 'wheat_seeds') {
    // short_grass is this version's seed-bearing plant: "grass" is not
    // in the registry and tall_grass grows two tall only in lush
    // places (the one within 96 of the depot stands 30 blocks DOWN, at
    // y43 — probe, 2026-11-02). The terrace by the farm is covered in
    // short_grass and fern. One batched run per step fills the whole
    // want — one break per step was the hour-long grind (2026-11-02).
    const run = await gatherSeeds(agent, want.count);
    if (run.broken === 0) {
      return { done: false, detail: 'no seed grass within reach' };
    }
    return {
      done: false,
      result: 'win',
      detail: `seed run: ${run.broken} grass broken, ${run.got} of ${want.count} seeds in hand`,
    };
  }
  return null;
}

// --- the service ----------------------------------------------------------------

/** The map from a project kind to its owner's executor. */
const EXECUTORS = {
  'depot-chest': buildDepotChest,
  replant: growReplant,
  farm: growFarm,
  path: buildPlanned,
  shelter: buildPlanned,
  ramp: buildRamp,
};

class ProjectService {
  constructor({ board, log }) {
    this.board = board;
    this.log = log;
    this._deniedNoteAt = 0;
  }

  /**
   * One step of the community's work for this agent's role. Returns
   * the play body (a function for agent.play), or null when the role
   * has no project to serve (the reflex chooses as it always did).
   */
  service(agent) {
    // The tester first: finished work waits on no one.
    const waiting = this.board.awaitingTest();
    if (waiting && agent.role === 'scout') {
      return {
        skill_id: 'project.test',
        title: `test ${waiting.title}`,
        reason: 'project:' + waiting.id,
        predict: { kind: 'none' },
        body: () => testProject(agent, waiting),
      };
    }
    if (waiting) {
      // The scout is away (a person's duty holds it); the work keeps.
      void waiting;
    }

    let project = this.board.forOwner(agent.role);
    if (project) {
      if (project.status === 'ratified') {
        this.board.started(project.id);
        project = this.board.get(project.id);
        agent.say(`starting on ${project.title}`);
      }
      const executor = EXECUTORS[project.kind];
      if (executor) {
        return {
          skill_id: 'project.' + project.kind,
          title: project.title,
          reason: 'project:' + project.id,
          predict: { kind: 'none' },
          body: async () => {
            const result = await executor(agent, project);
            // The hand to the tester: an owner whose plan stands sends
            // the project to the scout's walk. Nothing ever called
            // sendToTest (2026-11-02: "the chest stands" said twenty
            // times over while the board waited for a test that could
            // never be scheduled — done stayed 0 all day).
            const fresh = this.board.get(project.id);
            if (result && result.done && fresh && fresh.status === 'active') {
              this.board.sendToTest(project.id);
              agent.say(`${project.title} looks done — Kite, walk it`);
            }
            return result;
          },
        };
      }
      this.log({
        event: 'project_no_executor',
        project: project.id,
        kind: project.kind,
      });
      return null;
    }

    if (agent.role === 'gatherer') {
      const target = supplyTarget(this.board);
      if (target) {
        return {
          skill_id: 'project.supply',
          title: `supply ${target.project.title}`,
          reason: 'project:' + target.project.id,
          predict: { kind: 'none' },
          body: () => supplyStep(agent, this.board) || { done: false, detail: 'nothing to supply' },
        };
      }
    }
    return null;
  }
}

module.exports = { ProjectService, supplyTarget, missingBlocks, projectPlace };
