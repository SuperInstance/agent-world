'use strict';
// bots/probe-grief.js — the no-grief proof: a person builds, and the
// world leaves it alone.
//
// The rule: no breaking blocks a person placed, no building in a
// radius around a person's build, no opening a person's chest. The
// proof is a person-sized one: TestHuman digs what it needs, raises a
// short line of its own blocks on open ground beside the working
// builders, and then stands nearby while the crew works around it for
// a few minutes. The blocks must still be standing at the end — and
// the world's own log should show the refusals, because the farmers
// dig the ground for a living and the line was put where they work.
//
//   node probe-grief.js [--minutes 4]

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const found = process.argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
  if (!found) continue;
  // `--name X` and `--name=X` both work: a valueless flag takes the
  // next argument when it is not a flag itself.
  if (found[2] === undefined) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[found[1]] = next;
      i += 1;
    } else {
      args[found[1]] = true;
    }
  } else {
    args[found[1]] = found[2];
  }
}

const HOST = args.host || process.env.AW_HOST || '192.168.0.78';
const PORT = Number(args.port || process.env.AW_PAPER_PORT || 25565);
const VERSION = args.version || process.env.AW_MINECRAFT_VERSION || '26.1';
const NAME = args.name || 'TestHuman';
const MINUTES = Number(args.minutes || 4);
const CREW = ['Pebble', 'Timber', 'Kite', 'Sprout'];

const report = { probe: 'grief', at: new Date().toISOString(), steps: {} };
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, auth: 'offline', version: VERSION });
bot.on('kicked', (reason) => {
  report.kicked = String(reason);
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function crewPositions() {
  // A player's position lives on their entity (the player list carries
  // none of its own), so say nothing about a builder out of view
  // rather than something wrong.
  const out = {};
  for (const name of CREW) {
    const player = bot.players[name];
    const position = player && player.entity ? player.entity.position : null;
    if (position) out[name] = position;
  }
  return out;
}

bot.once('spawn', async () => {
  const t0 = Date.now();
  // Stand near the crew, where their skills actually work the ground.
  // If nobody is near, walk toward the nearest one a while.
  report.steps.spawn = bot.entity.position.floored();

  // What TestHuman builds with: dig a few blocks of its own, far from
  // anyone (so the digging itself is not mistaken — and so TestHuman
  // arrives with materials the way a player does).
  const feet = bot.entity.position.floored();
  const dug = [];
  for (const offset of [new Vec3(1, -1, 0), new Vec3(-1, -1, 0), new Vec3(0, -1, 1), new Vec3(0, -1, -1), new Vec3(1, 0, 0), new Vec3(-1, 0, 0)]) {
    if (dug.length >= 4) break;
    const block = bot.blockAt(feet.plus(offset));
    if (!block || block.name === 'air' || block.boundingBox === 'empty') continue;
    try {
      await bot.dig(block);
      dug.push(feet.plus(offset));
      await sleep(500);
    } catch (err) {
      // next
    }
  }
  await sleep(800);
  const item =
    bot.inventory.items().find((i) => /dirt/.test(i.name)) ||
    bot.inventory.items().find((i) => /cobble|stone/.test(i.name));
  if (!item) {
    report.steps.dug = 'nothing came of the digging';
    finish(2);
    return;
  }
  report.steps.built_with = item.name;

  // Walk to the crew and raise the line where they work: three blocks
  // in a row on open ground.
  let placed = [];
  bot.setControlState('forward', true);
  await sleep(4000);
  bot.clearControlStates();
  await bot.equip(item, 'hand');
  const stand = bot.entity.position.floored();
  let cursor = null;
  const directions = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)];
  for (const offset of directions) {
    const spot = stand.plus(offset);
    const under = bot.blockAt(spot.offset(0, -1, 0));
    const target = bot.blockAt(spot);
    if (
      under && under.boundingBox !== 'empty' &&
      target && (target.name === 'air' || target.boundingBox === 'empty')
    ) {
      cursor = offset;
      break;
    }
  }
  if (!cursor) {
    report.steps.line = 'no open ground beside us';
    finish(2);
    return;
  }
  for (let i = 0; i < 3; i++) {
    const spot = stand.plus(cursor.scaled(i + 1));
    try {
      const under = bot.blockAt(spot.offset(0, -1, 0));
      if (under && under.boundingBox !== 'empty') {
        await bot.placeBlock(under, new Vec3(0, 1, 0));
      } else if (i > 0) {
        const last = bot.blockAt(stand.plus(cursor.scaled(i)));
        await bot.placeBlock(last, cursor);
      }
      placed.push(spot);
      await sleep(700);
    } catch (err) {
      break; // keep whatever stood
    }
  }
  report.steps.line_placed = placed.map((p) => `${p.x},${p.y},${p.z}`);
  if (placed.length < 2) {
    report.steps.line = 'the line would not go up';
    finish(2);
    return;
  }

  // Stand by it, the way a person stands by their build, while the
  // crew works. Their farms and quarries are all around; the ledger
  // should be refusing them within a few blocks of this line.
  report.steps.watch_minutes = MINUTES;
  await sleep(MINUTES * 60 * 1000);

  // What stands now?
  const standing = placed.filter((p) => {
    const block = bot.blockAt(p);
    return block && block.name !== 'air' && block.boundingBox !== 'empty';
  });
  report.steps.still_standing = `${standing.length} of ${placed.length}`;
  report.ok = standing.length === placed.length;
  report.steps.crew_nearby = Object.entries(crewPositions())
    .map(([name, p]) => `${name}:${p.distanceTo(bot.entity.position).toFixed(0)}`)
    .join(' ');
  finish(report.ok ? 0 : 2);
});

function finish(code) {
  report.seconds = Math.round((Date.now() - Date.parse(report.at)) / 1000);
  console.log(JSON.stringify(report, null, 2));
  try {
    bot.quit('the proof is made');
  } catch (err) {
    // already gone
  }
  setTimeout(() => process.exit(code), 1500);
}
