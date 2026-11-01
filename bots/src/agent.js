'use strict';
// bots/src/agent.js — one builder in the world.
//
// A builder is a mineflayer client with a role. What it does is not up to
// it: every tick it tells the reflex what it can see and what it needs,
// and the reflex answers with one skill to do. The skill is a small
// JavaScript function from the library, it runs in the sandbox, and its
// outcome is measured against the prediction the skill made.
//
// Three things are worth noticing:
//
// * **The pathing is not the agent's.** The skill says *what* to do
//   ("mine that oak log"); mineflayer's own planners work out how to get
//   there. The reflex chooses the decision, not the footsteps.
// * **The measure is the skill's own prediction.** A skill says what it
//   expects to change; the world checks it. That is what makes a win rate
//   mean something.
// * **Nothing about a human is recorded.** The log holds decisions and
//   outcomes. Chat and audio are never stored.

const crypto = require('node:crypto');
const mineflayer = require('mineflayer');
const { buildApi, createSandbox, givePathfinding } = require('./api');

const ROLES = {
  gatherer: 'Gets the raw material the other builders need.',
  builder: 'Puts things together in the world.',
  scout: 'Looks around so the others know what is there.',
  farmer: 'Grows food so the world keeps going.',
};

class Agent {
  constructor({
    name,
    role,
    host,
    port,
    version,
    reflex,
    log,
    tickMs = 2000,
    offset = 0,
    onSpawn,
  }) {
    this.name = name;
    this.role = role;
    this.host = host;
    this.port = port;
    this.version = version;
    this.reflex = reflex;
    this.log = log;
    this.tickMs = tickMs;
    this.offset = offset;
    this.onSpawn = onSpawn;

    this.bot = null;
    this.sandbox = null;
    this.counters = { mined: 0, placed: 0 };
    this.running = false;
    this.reconnecting = false;
    this.ticks = 0;
    this.plays = 0;
    this.wins = 0;
    this.losses = 0;
    this.lastConfidence = null;
    this.lastChoice = null;
    this.humanNames = new Set();
  }

  // -- the connection ---------------------------------------------------------

  connect() {
    return new Promise((resolve, reject) => {
      this.bot = mineflayer.createBot({
        host: this.host,
        port: this.port,
        username: this.name,
        auth: 'offline',
        version: this.version,
        checkTimeoutInterval: 60000,
      });

      this.bot.once('spawn', () => {
        givePathfinding(this.bot);
        this.sandbox = createSandbox(buildApi(this.bot, this.counters));
        this.log.note({ bot: this.name, event: 'spawn', position: this.position() });
        if (this.onSpawn) this.onSpawn(this);
        resolve(this);
      });

      this.bot.once('error', (err) => {
        this.log.note({ bot: this.name, event: 'error', detail: String(err.message || err) });
        reject(err);
      });

      this.bot.on('kicked', (reason) => {
        this.log.note({ bot: this.name, event: 'kicked', detail: String(reason) });
      });

      this.bot.on('end', (reason) => {
        this.log.note({ bot: this.name, event: 'end', detail: String(reason) });
        // The world restarts, the network wobbles, the whitelist is
        // applied a second late: a builder that gives up is a builder
        // that never comes back. So it comes back.
        if (this.running) this.reconnect();
      });
    });
  }

  /** Come back after the world went away. */
  async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    while (this.running) {
      // Paper throttles reconnects from one address: wait longer than
      // the throttle window, and wait longer still for the builders
      // further down the line, so they do not all come back at once.
      await new Promise((resolve) => setTimeout(resolve, 15000 + this.offset * 7000));
      if (!this.running) break;
      try {
        this.bot = null;
        await this.connect();
        this.log.note({ bot: this.name, event: 'rejoined' });
        break;
      } catch (err) {
        this.log.note({
          bot: this.name,
          event: 'rejoin_failed',
          detail: String(err.message || err),
        });
      }
    }
    this.reconnecting = false;
  }

  position() {
    if (!this.bot || !this.bot.entity) return null;
    const p = this.bot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }

  // -- the tick ---------------------------------------------------------------

  /** What the builder can see and what it needs. This is the context. */
  context() {
    const t = this.bot ? this.bot.time.timeOfDay / 24000 : 0;
    const players = this.bot ? Object.values(this.bot.players) : [];
    const humans = players
      .filter((p) => p && p.username && p.username !== this.name)
      .filter((p) => !this.isAgent(p.username))
      .map((p) => p.username);
    this.humanNames = new Set(humans);
    return {
      bot: this.name,
      role: this.role,
      phase: t < 0.3 || t > 0.8 ? 'night' : 'day',
      time_of_day: Math.round(t * 1000) / 1000,
      health: this.bot ? this.bot.health : 20,
      food: this.bot ? this.bot.food : 20,
      has_material: this.bot ? this.bot.inventory.items().length > 0 : false,
      humans: humans.length,
      human_present: humans.length > 0,
      confidence: this.lastConfidence,
    };
  }

  /** The shared state the whole world's pack is asked over. */
  worldState() {
    const ctx = this.context();
    const phase = ctx.phase === 'day' ? 'daytime' : 'night';
    return (
      `${phase} in a Minecraft world. ` +
      `This builder is a ${ctx.role}. ` +
      `It has ${ctx.has_material ? 'some materials' : 'no materials'} and ` +
      `${ctx.humans === 0 ? 'no humans nearby' : `${ctx.humans} human(s) nearby`}.`
    );
  }

  isAgent(name) {
    return AGENT_NAMES.has(name);
  }

  async tick() {
    if (!this.bot || !this.bot.entity) return;
    this.ticks += 1;
    const ctx = this.context();
    let decision;
    try {
      decision = await this.reflex.decide({
        bot: this.name,
        role: this.role,
        context: ctx,
        state: this.worldState(),
      });
    } catch (err) {
      this.log.note({
        bot: this.name,
        event: 'reflex_unreachable',
        detail: String(err.message || err),
      });
      return;
    }

    if (!decision || !decision.skill_id) {
      this.lastChoice = decision && decision.reason ? decision.reason : 'no_decision';
      this.log.decision({
        bot: this.name,
        role: this.role,
        skill: null,
        reason: this.lastChoice,
        detail: (decision && decision.detail) || '',
      });
      return;
    }

    this.lastConfidence =
      typeof decision.confidence === 'number' ? decision.confidence : this.lastConfidence;
    this.lastChoice = decision.reason;
    this.log.decision({
      bot: this.name,
      role: this.role,
      skill: decision.skill_id,
      title: decision.title,
      reason: decision.reason,
      confidence: decision.confidence,
      propensity: decision.propensity,
      candidates: decision.candidates,
    });

    await this.play(decision, ctx);
  }

  // -- the play ---------------------------------------------------------------

  async play(decision, ctx) {
    const started = Date.now();
    const before = {
      mined: this.counters.mined,
      placed: this.counters.placed,
      position: this.position(),
      inventory: this.inventoryMap(),
    };

    let result = { done: false, detail: 'the skill did not run' };
    let failure = null;
    try {
      result = (await this.sandbox.run(decision.body)) || result;
    } catch (err) {
      failure = String((err && err.message) || err);
    }

    const outcome = this.measure(decision.predict || { kind: 'none' }, before, failure);
    // The skill's own reason is part of the record: "there is nothing at
    // the depot" is the difference between a skill that failed and a
    // skill that had no reason to run.
    const said = result && result.detail ? String(result.detail) : '';
    if (said && outcome.detail && !outcome.detail.includes(said)) {
      outcome.detail = `${outcome.detail} — ${said}`;
    }
    const wall = (Date.now() - started) / 1000;

    const record = {
      id: 'play_' + crypto.randomBytes(6).toString('hex'),
      at: new Date().toISOString(),
      skill_id: decision.skill_id,
      skill_version: decision.skill_version || 1,
      context: Object.assign({}, ctx, {
        confidence: this.lastConfidence,
        chooser_reason: decision.reason,
      }),
      outcome,
      cost: { wall_seconds: wall, gpu_minutes: 0, hosted_cents: 0 },
      chooser: 'bandit/ctx-v1+judge',
      chooser_version: '1',
      propensity: typeof decision.propensity === 'number' ? decision.propensity : null,
      candidates: decision.candidates || [],
    };

    this.plays += 1;
    if (outcome.result === 'win') this.wins += 1;
    if (outcome.result === 'lose') this.losses += 1;

    this.log.outcome({
      bot: this.name,
      skill: decision.skill_id,
      result: outcome.result,
      measure: outcome.measure,
      detail: outcome.detail,
      wall_seconds: Number(wall.toFixed(3)),
    });

    try {
      await this.reflex.play(record);
    } catch (err) {
      this.log.note({
        bot: this.name,
        event: 'play_not_recorded',
        detail: String(err.message || err),
      });
    }
  }

  inventoryMap() {
    const map = {};
    if (!this.bot) return map;
    for (const item of this.bot.inventory.items()) map[item.name] = item.count;
    return map;
  }

  /** Did the prediction hold? This is the measure the record carries. */
  measure(predict, before, failure) {
    const detail = (result) =>
      failure ? `the skill failed: ${failure}` : (result && result.detail) || '';

    if (failure) {
      return { result: 'lose', measure: 'sealed_prediction', score: 0, detail: failure };
    }

    const kind = predict && predict.kind ? predict.kind : 'none';
    const min = predict && predict.min ? predict.min : 1;

    if (kind === 'inventory_delta') {
      const after = this.inventoryMap();
      const item = predict.item;
      const gained = (after[item] || 0) - (before.inventory[item] || 0);
      return {
        result: gained >= min ? 'win' : 'lose',
        measure: 'sealed_prediction',
        score: gained >= min ? 1 : 0,
        detail: `${item} ${gained >= 0 ? '+' : ''}${gained} (wanted ${min})`,
      };
    }
    if (kind === 'block_placed') {
      const placed = this.counters.placed - before.placed;
      return {
        result: placed >= min ? 'win' : 'lose',
        measure: 'sealed_prediction',
        score: placed >= min ? 1 : 0,
        detail: `${placed} block(s) placed (wanted ${min})`,
      };
    }
    if (kind === 'block_broken') {
      const mined = this.counters.mined - before.mined;
      return {
        result: mined >= min ? 'win' : 'lose',
        measure: 'sealed_prediction',
        score: mined >= min ? 1 : 0,
        detail: `${mined} block(s) mined (wanted ${min})`,
      };
    }
    if (kind === 'moved_to') {
      const now = this.position();
      let moved = 0;
      if (now && before.position) {
        moved = Math.sqrt(
          Math.pow(now.x - before.position.x, 2) +
            Math.pow(now.y - before.position.y, 2) +
            Math.pow(now.z - before.position.z, 2)
        );
      }
      return {
        result: moved >= min ? 'win' : 'lose',
        measure: 'sealed_prediction',
        score: moved >= min ? 1 : 0,
        detail: `moved ${moved.toFixed(1)} blocks (wanted ${min})`,
      };
    }
    // No measurable effect: the play happened, but it cannot be called a
    // win or a loss. It is partial, and it says so.
    return {
      result: 'partial',
      measure: 'sealed_prediction',
      score: null,
      detail: detail(null) || 'the skill ran; it made no measurable change',
    };
  }

  // -- the loop ---------------------------------------------------------------

  start() {
    this.running = true;
    const loop = async () => {
      while (this.running) {
        try {
          await this.tick();
        } catch (err) {
          this.log.note({
            bot: this.name,
            event: 'tick_failed',
            detail: String(err.message || err),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, this.tickMs));
      }
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.bot) this.bot.quit('the world is resting');
  }
}

// The names the world owns. A player who is not one of these is a human.
// The watcher is the spectator the viewer page joins as, and the probes
// are the world's own diagnostics: none of them is a person, and reading
// them as one would tell the mediator a human had joined whenever
// somebody opened the world's window.
const AGENT_NAMES = new Set([
  'Pebble', 'Timber', 'Kite', 'Sprout',
  'Watcher',
  'Probe', 'Probe2', 'Probe3', 'Probe4', 'Probe5', 'Probe6',
]);

module.exports = { Agent, ROLES, AGENT_NAMES };
