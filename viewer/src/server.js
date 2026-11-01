'use strict';
// viewer/src/server.js — the world's window.
//
// One port, two views:
//
//   /            the 3D view (prismarine-viewer): the world as a
//                spectator sees it, with the builders in it
//   /ascii       the Syzygy text view of one perspective: the same
//                world, projected into text by an integer kernel
//   /ascii/frame the current text frame (plain text)
//   /status      who is in the world and what the reflex is doing
//
// The viewer joins the world as "Watcher", a spectator that stands at
// the depot. It needs no account of its own: the world is LAN-only and
// the whitelist is the door.

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const socketio = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder: pathfinderPlugin, Movements, goals } = require('mineflayer-pathfinder');
const { WorldView } = require('prismarine-viewer/viewer');
const { project } = require('./ascii');

const DEFAULTS = {
  host: process.env.AW_HOST || '192.168.0.78',
  port: Number(process.env.AW_PAPER_PORT || 25565),
  version: process.env.AW_MINECRAFT_VERSION || '26.1',
  webPort: Number(process.env.AW_VIEW_PORT || 8080),
  reflexHost: process.env.AW_REFLEX_HOST || '127.0.0.1',
  reflexPort: Number(process.env.AW_REFLEX_PORT || 8110),
  name: 'Watcher',
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWER_PUBLIC = path.join(
  path.dirname(require.resolve('prismarine-viewer/package.json')),
  'public'
);

/**
 * Move the watcher somewhere it can see.
 *
 * A spectator that spawns under a tree canopy sees only leaves, in both
 * views. So the watcher looks for a patch of open ground near the spawn
 * and walks to it: a place with four blocks of air above it, which in a
 * forest means a clearing.
 */
async function standClear(bot) {
  bot.loadPlugin(pathfinderPlugin);
  const movements = new Movements(bot);
  movements.canDigBlocks = false;
  bot.pathfinder.setMovements(movements);

  const origin = bot.entity.position.floored();
  const candidates = [];
  for (let radius = 3; radius <= 12; radius += 3) {
    for (let dx = -radius; dx <= radius; dx += 3) {
      for (let dz = -radius; dz <= radius; dz += 3) {
        if (dx === 0 && dz === 0) continue;
        candidates.push({ x: origin.x + dx, z: origin.z + dz });
      }
    }
  }

  for (const spot of candidates) {
    if (!isOpen(bot, spot)) continue;
    try {
      await bot.pathfinder.goto(new goals.GoalNear(spot.x, origin.y, spot.z, 1));
      console.log(`the watcher stood at ${bot.entity.position.floored()}`);
      return;
    } catch (err) {
      // Try the next patch.
    }
  }
}

/** Is there open sky above this column? */
function isOpen(bot, spot) {
  for (let dy = 1; dy <= 4; dy++) {
    const block = bot.blockAt(
      new (require('vec3').Vec3)(spot.x, spot.y + dy, spot.z)
    );
    if (!block) continue;
    if (block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
      return false;
    }
  }
  return true;
}

async function main() {
  const app = express();
  const server = http.createServer(app);
  const io = socketio(server, { path: '/socket.io' });

  // The 3D view is prismarine-viewer's own client, served as it is.
  app.use(express.static(VIEWER_PUBLIC));
  // Our own pages (the ASCII view) come second, so they can add to it.
  app.use(express.static(PUBLIC_DIR));
  app.use(express.text({ type: 'text/plain' }));

  // --- the watcher -----------------------------------------------------------
  const bot = mineflayer.createBot({
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    username: DEFAULTS.name,
    auth: 'offline',
    version: DEFAULTS.version,
  });

  bot.on('error', (err) => console.log('watcher error:', err.message));
  bot.on('end', (reason) => console.log('watcher ended:', reason));
  bot.on('kicked', (reason) => console.log('watcher kicked:', reason));

  const sockets = [];

  bot.once('spawn', () => {
    console.log(`the watcher is in the world at ${bot.entity.position}`);
    standClear(bot).catch((err) => {
      console.log('the watcher stayed where it landed:', err.message);
    });
    io.on('connection', (socket) => {
      socket.emit('version', bot.version);
      sockets.push(socket);

      const worldView = new WorldView(bot.world, 6, bot.entity.position, socket);
      worldView.init(bot.entity.position);

      function botPosition() {
        socket.emit('position', {
          pos: bot.entity.position,
          yaw: bot.entity.yaw,
          addMesh: true,
        });
        worldView.updatePosition(bot.entity.position);
      }

      bot.on('move', botPosition);
      worldView.listenToBot(bot);
      socket.on('disconnect', () => {
        bot.removeListener('move', botPosition);
        worldView.removeListenersFromBot(bot);
        sockets.splice(sockets.indexOf(socket), 1);
      });
    });
  });

  // --- the text view ---------------------------------------------------------
  // The frame is computed on demand, from the watcher's own state. The
  // kernel is integer and deterministic, so two readers of the same
  // state get the same characters.
  let lastFrame = '';
  let lastFrameAt = 0;

  app.get('/ascii', (req, res) => {
    const file = path.join(PUBLIC_DIR, 'ascii.html');
    if (!fs.existsSync(file)) {
      res.status(404).type('text/plain').send('the ASCII page is missing');
      return;
    }
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  });

  app.get('/ascii/frame', (req, res) => {
    if (!bot.entity) {
      res.type('text/plain').send('(the watcher is not in the world yet)');
      return;
    }
    const width = Math.min(Number(req.query.width) || 96, 200);
    const height = Math.min(Number(req.query.height) || 30, 60);
    const frame = project(bot, { width, height });
    lastFrame = frame;
    lastFrameAt = Date.now();
    res.type('text/plain').send(frame);
  });

  app.get('/status', async (req, res) => {
    const people = bot.players
      ? Object.values(bot.players)
          .filter((p) => p && p.username)
          .map((p) => ({ name: p.username, position: p.position }))
      : [];
    let reflex = null;
    try {
      const response = await fetch(`http://${DEFAULTS.reflexHost}:${DEFAULTS.reflexPort}/stats`);
      reflex = await response.json();
    } catch (err) {
      reflex = { error: 'the reflex did not answer' };
    }
    res.json({
      world: {
        host: DEFAULTS.host,
        port: DEFAULTS.port,
        version: DEFAULTS.version,
        watcher: bot.entity ? bot.entity.position : null,
      },
      people,
      reflex,
    });
  });

  server.listen(DEFAULTS.webPort, '0.0.0.0', () => {
    console.log(`the world's window is on http://${DEFAULTS.host}:${DEFAULTS.webPort}/`);
    console.log(`  3D view  : http://${DEFAULTS.host}:${DEFAULTS.webPort}/`);
    console.log(`  text view: http://${DEFAULTS.host}:${DEFAULTS.webPort}/ascii`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
