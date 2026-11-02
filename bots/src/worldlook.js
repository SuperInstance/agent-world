'use strict';
// bots/src/worldlook.js — the world, as the council sees it.
//
// The council must not propose a chest on a hillside of air or a farm
// in a quarry, so it reads the world before it proposes. It reads
// through whichever builder is nearest the depot (they all see the
// same world, but chunks load around *players* — a look through a
// builder far from the depot reads nulls, and nulls are "unknown",
// never "empty").
//
// Every look is honest about what it cannot see: a column outside the
// loaded chunks yields null, the needs-check treats null as "not
// found", and a proposal built on nulls does not happen. A council
// that proposed into fog would ratify a scope the builders cannot
// place; this one waits until someone walks there.

const Vec3 = require('vec3').Vec3;

const AIR = (block) =>
  !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';

class WorldLook {
  /**
   * @param {() => Array} agents the live agents (each with .bot)
   * @param {object|null} guard one agent's guard (for chest checks)
   * @param {() => Map} playerBuilds the no-grief ledger's placed map,
   *   so a site search never plans a block the workface would refuse
   */
  constructor(agents, guard = null, playerBuilds = null) {
    this.agents = agents;
    this.guard = guard;
    this.playerBuilds = playerBuilds || (() => new Map());
    this.keepOut = 8; // BUILD_KEEP_OUT from humanity.js, held here too
  }

  /** Is a point inside a person's build radius? (A plan that includes
   *  such a point plans a block the api will refuse; better not to
   *  plan it.) */
  _nearPlayerBuild(x, y, z) {
    const placed = this.playerBuilds();
    if (!placed || !placed.size) return false;
    const r2 = (this.keepOut + 1) * (this.keepOut + 1);
    for (const key of placed.keys()) {
      const [px, py, pz] = key.split(',').map(Number);
      const dx = px - x, dy = py - y, dz = pz - z;
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  }

  _bot() {
    let best = null;
    let bestDistance = Infinity;
    for (const agent of this.agents()) {
      if (!agent.bot || !agent.bot.entity) continue;
      const spawn = agent.bot.spawnPoint || agent.bot.entity.position;
      const d = agent.bot.entity.position.distanceTo(spawn);
      if (d < bestDistance) {
        best = agent.bot;
        bestDistance = d;
      }
    }
    return best;
  }

  depot() {
    const bot = this._bot();
    if (!bot) return { x: 0, y: 70, z: 0 };
    const spot = bot.spawnPoint || bot.entity.position;
    return { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) };
  }

  blockAt(x, y, z) {
    const bot = this._bot();
    if (!bot) return null;
    try {
      return bot.blockAt(new Vec3(x, y, z));
    } catch (err) {
      return null;
    }
  }

  /** The y of the top standable block in a column, or null. */
  surfaceAt(x, z) {
    const bot = this._bot();
    if (!bot) return null;
    const top = Math.floor((bot.entity ? bot.entity.position.y : 70) + 12);
    for (let y = top; y >= top - 40; y--) {
      const block = this.blockAt(x, y, z);
      if (!block) continue; // outside the loaded chunks: unknown
      if (AIR(block) || block.boundingBox === 'empty') continue;
      if (block.name === 'oak_leaves' || block.name.endsWith('_log')) continue;
      return y;
    }
    return null;
  }

  /** A standable spot near (x, z): ground with two airs above it. */
  standableNear(x, y, z, radius) {
    for (let r = 0; r <= radius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ground = this.surfaceAt(x + dx, z + dz);
          if (ground == null) continue;
          const at = this.blockAt(x + dx, ground + 1, z + dz);
          const above = this.blockAt(x + dx, ground + 2, z + dz);
          if (AIR(at) && AIR(above) && ground >= y - 12) {
            if (this._nearPlayerBuild(x + dx, ground, z + dz)) continue;
            return { x: x + dx, y: ground + 1, z: z + dz };
          }
        }
      }
    }
    return null;
  }

  /** Count blocks by name in a cube the given radius, loaded parts only.
   *
   * Sampled every four blocks: trunks are columns and walls are runs,
   * so a four-block stride sees them; what it must not do is walk
   * half a million columns on the council's every tick. */
  countBlocks(names, x, y, z, radius) {
    const bot = this._bot();
    if (!bot) return 0;
    const set = new Set(names);
    let count = 0;
    for (let dx = -radius; dx <= radius; dx += 4) {
      for (let dz = -radius; dz <= radius; dz += 4) {
        for (let dy = -8; dy <= 24; dy += 4) {
          const block = this.blockAt(x + dx, y + dy, z + dz);
          if (block && set.has(block.name)) count += 1;
        }
      }
    }
    return count;
  }

  /** Is there a chest (not a person's) near the point? */
  chestAt(x, y, z, radius) {
    const bot = this._bot();
    if (!bot) return false;
    const registry = bot.registry;
    const ids = ['chest', 'trapped_chest']
      .map((n) => registry.blocksByName[n] && registry.blocksByName[n].id)
      .filter(Boolean);
    if (!ids.length) return false;
    const spots = bot.findBlocks({
      matching: ids,
      maxDistance: radius + 16,
      count: 16,
    });
    for (const spot of spots) {
      if (Math.hypot(spot.x - x, spot.z - z) > radius) continue;
      if (this.guard && this.guard.isPlayerChest(spot)) continue;
      return true;
    }
    return false;
  }

  /** Is there farmland near the point? */
  farmlandNear(x, y, z, radius) {
    const bot = this._bot();
    if (!bot) return false;
    const id = bot.registry.blocksByName['farmland'] && bot.registry.blocksByName['farmland'].id;
    if (!id) return false;
    const spots = bot.findBlocks({ matching: [id], maxDistance: radius + 24, count: 8 });
    return spots.some((s) => Math.hypot(s.x - x, s.z - z) <= radius);
  }

  /** Spots that would take a sapling: grass or dirt with air above. */
  plantableSpots(x, y, z, radius, wanted) {
    const out = [];
    for (let r = 2; r <= radius && out.length < wanted; r++) {
      for (let dx = -r; dx <= r && out.length < wanted; dx++) {
        for (let dz = -r; dz <= r && out.length < wanted; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ground = this.surfaceAt(x + dx, z + dz);
          if (ground == null) continue;
          const block = this.blockAt(x + dx, ground, z + dz);
          const at = this.blockAt(x + dx, ground + 1, z + dz);
          if (!block || !['grass_block', 'dirt', 'coarse_dirt'].includes(block.name)) continue;
          if (!AIR(at)) continue;
          if (this._nearPlayerBuild(x + dx, ground, z + dz)) continue;
          out.push({ x: x + dx, y: ground, z: z + dz });
        }
      }
    }
    return out;
  }

  /** A 5x5 farm plot near water if there is one, else on open dirt.
   *  Every candidate centre is tried until one yields a 3x3 of
   *  tillable, unclaimed columns — the depot's water sits beside a
   *  departed visitor's two blocks, and the first centre is not the
   *  only farm in the world. */
  farmPlot(x, y, z, radius) {
    const bot = this._bot();
    if (!bot) return null;
    const centers = [];
    const waterId = bot.registry.blocksByName['water'] && bot.registry.blocksByName['water'].id;
    if (waterId) {
      const spots = bot.findBlocks({ matching: [waterId], maxDistance: radius + 24, count: 16 });
      for (const s of spots) {
        if (Math.hypot(s.x - x, s.z - z) <= radius) centers.push({ x: s.x + 2, z: s.z });
      }
    }
    const open = this.standableNear(x, y, z, radius);
    if (open) centers.push({ x: open.x, z: open.z });
    const farther = this.standableNear(x, y, z, radius + 12);
    if (farther) centers.push({ x: farther.x, z: farther.z });

    for (const center of centers) {
      const blocks = [];
      let ok = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const ground = this.surfaceAt(center.x + dx, center.z + dz);
          if (ground == null) continue;
          const block = this.blockAt(center.x + dx, ground, center.z + dz);
          if (!block || !['grass_block', 'dirt', 'coarse_dirt'].includes(block.name)) continue;
          if (this._nearPlayerBuild(center.x + dx, ground, center.z + dz)) continue;
          ok += 1;
          blocks.push({ name: 'farmland', x: center.x + dx, y: ground, z: center.z + dz });
          blocks.push({ name: 'wheat', x: center.x + dx, y: ground + 1, z: center.z + dz });
        }
      }
      if (ok >= 9) return { x: center.x, y, z: center.z, blocks };
    }
    return null;
  }

  /** Cobblestone on the surface along the line to (tx, tz), one block
   *  every two, up to max. The y is the surface at plan time; the
   *  builder re-reads the world when it places. */
  pathBlocks(x, y, z, tx, tz, max) {
    const distance = Math.hypot(tx - x, tz - z);
    const steps = Math.min(Math.floor(distance / 2), max);
    const blocks = [];
    for (let i = 1; i <= steps; i++) {
      const px = Math.round(x + ((tx - x) * i) / steps);
      const pz = Math.round(z + ((tz - z) * i) / steps);
      const ground = this.surfaceAt(px, pz);
      if (ground == null) continue;
      const at = this.blockAt(px, ground, pz);
      if (!at) continue;
      if (this._nearPlayerBuild(px, ground, pz)) continue;
      if (['grass_block', 'dirt', 'coarse_dirt', 'sand', 'gravel'].includes(at.name)) {
        // Replace the walk-worn ground itself: the path sits *in* the
        // world, not on a step above it.
        blocks.push({ name: 'cobblestone', x: px, y: ground, z: pz });
      } else if (AIR(at)) {
        blocks.push({ name: 'cobblestone', x: px, y: ground, z: pz });
      }
    }
    return blocks;
  }
}

module.exports = { WorldLook };
