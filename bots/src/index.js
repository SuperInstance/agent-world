'use strict';
// bots/src/index.js — the community.
//
// Four builders, one per role, all in the same world. Each tick every
// builder asks the reflex what to do; the reflex batches those questions
// into one call to the decision model.
//
//   node src/index.js                     # the four builders
//   node src/index.js --names Pebble,Timber
//   node src/index.js --tick 3000        # a slower world
//
// The bots connect in **offline mode**: the world is LAN-only and the
// whitelist is the door, so the builders need no accounts.

const path = require('node:path');
const { Agent, ROLES } = require('./agent');
const { Reflex } = require('./reflex');
const { Log } = require('./log');

const DEFAULTS = {
  host: process.env.AW_HOST || '192.168.0.78',
  port: Number(process.env.AW_PAPER_PORT || 25565),
  version: process.env.AW_MINECRAFT_VERSION || '26.1',
  reflexHost: process.env.AW_REFLEX_HOST || '127.0.0.1',
  reflexPort: Number(process.env.AW_REFLEX_PORT || 8110),
  logFile: process.env.AW_BOT_LOG || '/home/caseydigennaro/lm-wt/agent-world/runtime/logs/bots.jsonl',
  tickMs: Number(process.env.AW_TICK_MS || 2000),
};

// The community: a name, a role, and what the role is for.
const CREW = [
  { name: 'Pebble', role: 'gatherer' },
  { name: 'Timber', role: 'builder' },
  { name: 'Kite', role: 'scout' },
  { name: 'Sprout', role: 'farmer' },
];

function parseArgs(argv) {
  // Start from the defaults: the world's addresses, the log, the tick.
  const out = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--names') out.names = String(argv[++i] || '').split(',');
    else if (argv[i] === '--tick') out.tick = Number(argv[++i] || DEFAULTS.tickMs);
    else if (argv[i] === '--host') out.host = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i] === '--log') out.logFile = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = new Log(args.logFile);
  const reflex = new Reflex({ host: args.reflexHost, port: args.reflexPort });

  let crew = CREW;
  if (args.names && args.names.length) {
    crew = CREW.filter((c) => args.names.includes(c.name));
    if (!crew.length) {
      console.error('no builder matches those names; the community is: ' + CREW.map((c) => c.name).join(', '));
      process.exit(1);
    }
  }

  log.note({ event: 'world_opened', crew: crew.map((c) => ({ name: c.name, role: c.role })) });
  console.log(`the community is opening: ${crew.map((c) => `${c.name} (${c.role})`).join(', ')}`);

  const agents = [];
  let attempt = 0;
  for (const member of crew) {
    // Paper throttles connections from one address (bukkit.yml's
    // connection-throttle, 4 s), and every builder here comes from the
    // same one. So the community walks in rather than all at once.
    if (attempt) await new Promise((r) => setTimeout(r, 6000));
    attempt += 1;
    const agent = new Agent({
      name: member.name,
      role: member.role,
      host: args.host,
      port: args.port,
      version: args.version,
      reflex,
      log,
      tickMs: args.tick,
      offset: attempt - 1,
    });
    try {
      await agent.connect();
      agents.push(agent);
      agent.start();
      console.log(`  ${member.name} joined as ${member.role}: ${ROLES[member.role]}`);
    } catch (err) {
      console.error(`  ${member.name} could not join: ${err.message || err}`);
    }
  }

  if (!agents.length) {
    console.error('nobody joined. Is the world up? (ops/paper.sh status)');
    process.exit(1);
  }

  const report = setInterval(() => {
    const plays = agents.reduce((sum, a) => sum + a.plays, 0);
    const wins = agents.reduce((sum, a) => sum + a.wins, 0);
    const losses = agents.reduce((sum, a) => sum + a.losses, 0);
    const rate = plays ? Math.round((wins / plays) * 100) : 0;
    console.log(
      `  ${new Date().toISOString().slice(11, 19)}  ` +
        `${agents.length} builders  ${plays} plays  ${wins} won  ${losses} lost  (${rate}%)`
    );
  }, 30000);

  const shutdown = () => {
    clearInterval(report);
    for (const agent of agents) agent.stop();
    log.note({ event: 'world_closed' });
    log.close();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
