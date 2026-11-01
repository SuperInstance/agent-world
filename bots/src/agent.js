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
const { isAgent, parseCommand, HELP_LINE } = require('./humanity');

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
    guard = null,
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
    this.guard = guard;

    // The other builders, set once everyone is in. A command heard by
    // four bots must be answered by one, and "who is nearest" needs the
    // whole crew's positions.
    this.community = [];

    this.bot = null;
    this.sandbox = null;
    this.api = null;
    this.counters = { mined: 0, placed: 0 };
    this.running = false;
    this.reconnecting = false;
    this.ticks = 0;
    this.plays = 0;
    this.wins = 0;
    this.losses = 0;
    this.lastConfidence = null;
    this.lastChoice = null;
    this.lastActivity = null;
    this.humanNames = new Set();
    this.duty = null;
    this.lastSaidAt = 0;
    this.lastRepliedAt = 0;
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
        givePathfinding(this.bot, this.guard);
        this.api = buildApi(this.bot, this.counters, this.guard || undefined);
        this.sandbox = createSandbox(this.api);
        this.listenForPeople();
        this.watchTheBlocks();
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
    return isAgent(name);
  }

  // -- the people -------------------------------------------------------------

  /**
   * Say one line, out loud. Rate-limited by default (a builder with a
   * narration every tick is noise, not company); a reply to a person is
   * never dropped — it is `force`, because whoever asked is waiting.
   * The line goes to the log too, as the builder's own words: that is
   * what the voices page speaks. Nothing a *person* said ever enters
   * the log (the privacy rule); this is the builder's line only.
   */
  say(text, { force = false } = {}) {
    if (!this.bot) return false;
    const now = Date.now();
    if (!force && now - this.lastSaidAt < 20000) return false;
    this.lastSaidAt = now;
    try {
      this.bot.chat(text);
    } catch (err) {
      // Not in the world yet; the line is dropped, not stored for later.
    }
    this.log.say({ bot: this.name, text });
    return true;
  }

  /** Chat and whispers: a person talking to the crew. */
  listenForPeople() {
    const heard = (username, message) => this.heard(username, message);
    this.bot.on('chat', heard);
    this.bot.on('whisper', heard);
  }

  /**
   * Watch the blocks change around us, so the no-grief ledger learns
   * what a person placed. Four builders see the same change; the ledger
   * takes it once.
   */
  watchTheBlocks() {
    if (!this.guard) return;
    this.bot.on('blockUpdate', (oldBlock, newBlock) => {
      try {
        this.guard.observe(oldBlock, newBlock);
      } catch (err) {
        // A ledger entry is protective, never load-bearing.
      }
    });
  }

  /**
   * One line of chat reached this builder. If it is a person and it is
   * one of the commands, exactly one builder acts on it — the named
   * one, the one whose role owns the job, or the nearest — except
   * "stop", which every builder obeys.
   */
  heard(username, message) {
    if (!username || username === this.name) return;
    if (isAgent(username)) return; // only people command the crew
    const parsed = parseCommand(message);
    if (!parsed) return; // free text is not on the tick

    if (parsed.addressee) {
      const named = this.community.find(
        (a) => a.name.toLowerCase() === parsed.addressee.toLowerCase()
      );
      if (!named || named !== this) return;
    } else if (parsed.route === 'role') {
      const owner = this.community.find((a) => a.role === parsed.role);
      if (!owner || owner !== this) return;
    } else if (parsed.route === 'nearest') {
      if (!this.iAmNearestTo(username)) return;
    }

    this.handleCommand(parsed.command, username);
  }

  /** Am I the closest builder to this person? Ties go to the first name. */
  iAmNearestTo(speaker) {
    const them = this.bot.players[speaker];
    if (!them || !them.position) return false;
    let best = null;
    let bestDistance = Infinity;
    for (const other of this.community) {
      if (!other.bot || !other.bot.entity) continue;
      const distance = other.bot.entity.position.distanceTo(them.position);
      if (distance < bestDistance - 0.5 || (distance < bestDistance + 0.5 && best && other.name < best.name)) {
        best = other;
        bestDistance = Math.min(bestDistance, distance);
      }
    }
    return best === this;
  }

  /** Where a player is, or null if they are gone. */
  playerPosition(name) {
    const player = this.bot.players[name];
    if (!player || !player.position) return null;
    return player.position;
  }

  handleCommand(command, from) {
    // The word is logged, never the line around it: a person's words
    // are theirs (the privacy rule), and the crew's obedience is the
    // world's own record.
    this.log.note({ bot: this.name, event: 'command', command, from });
    switch (command) {
      case 'stop':
        this.clearDuty('stopped');
        this.interrupt();
        if (this.iAmNearestTo(from)) this.say(`we've stopped, ${from}`, { force: true });
        return;
      case 'follow':
        this.setDuty({ kind: 'follow', player: from, expires: 15 * 60 * 1000 }, `following you, ${from}`);
        return;
      case 'come':
        this.setDuty({ kind: 'come', player: from, expires: 60 * 1000 }, `coming, ${from}`);
        return;
      case 'help-build':
        if (this.guard) this.guard.ledger.invite(this.name, from, 10);
        this.setDuty({ kind: 'assist', player: from, phase: 'approach', since: new Date().toISOString(), expires: 10 * 60 * 1000 }, `coming, ${from} — show me where to build`);
        return;
      case 'gather-wood':
        this.setDuty({ kind: 'gather', material: 'wood', player: from, phase: 'fetch', expires: 6 * 60 * 1000 }, `going for wood, ${from}`);
        return;
      case 'gather-stone':
        this.setDuty({ kind: 'gather', material: 'stone', player: from, phase: 'fetch', expires: 6 * 60 * 1000 }, `going for stone, ${from}`);
        return;
      case 'go-home':
        this.setDuty({ kind: 'home', expires: 2 * 60 * 1000 }, 'heading to the depot');
        return;
      case 'what-doing': {
        if (Date.now() - this.lastRepliedAt < 15000) return;
        this.lastRepliedAt = Date.now();
        const doing = this.duty
          ? {
              follow: `following ${this.duty.player}`,
              come: `coming to ${this.duty.player}`,
              home: 'walking to the depot',
              gather: `gathering ${this.duty.material} for ${this.duty.player}`,
              assist: `helping ${this.duty.player} build`,
            }[this.duty.kind]
          : this.lastActivity
            ? `working on: ${this.lastActivity}`
            : 'between jobs';
        this.say(`${this.name} is ${doing}`, { force: true });
        return;
      }
      case 'help': {
        if (Date.now() - this.lastRepliedAt < 30000) return;
        this.lastRepliedAt = Date.now();
        this.say(HELP_LINE, { force: true });
        return;
      }
      default:
        return;
    }
  }

  /** A job from a person outranks the reflex until it is done. */
  setDuty(duty, line) {
    duty.since = new Date().toISOString();
    this.duty = duty;
    this.interrupt(); // whatever walk was under way stops for the person
    this.log.note({ bot: this.name, event: 'duty_set', kind: duty.kind, from: duty.player || null });
    if (line) this.say(line, { force: true });
  }

  clearDuty(why) {
    if (!this.duty) return;
    this.log.note({ bot: this.name, event: 'duty_clear', kind: this.duty.kind, why });
    this.duty = null;
  }

  /** Stop the walk under our feet, if there is one. */
  interrupt() {
    try {
      if (this.bot.pathfinder) this.bot.pathfinder.stop();
    } catch (err) {
      // Nothing was walking.
    }
  }

  /**
   * One step of the duty. The tick loop calls this instead of the
   * reflex while a duty holds: a person's request is the one thing that
   * outranks the world's own work. No model is asked — the duty is a
   * goal, walked by the same planners the skills use, except "gather",
   * which asks the reflex for its family's skill like any other play
   * (the chooser still chooses; the play is still recorded).
   */
  async serviceDuty() {
    const duty = this.duty;
    if (!duty) return;
    const them = duty.player ? this.playerPosition(duty.player) : null;
    if (duty.player && !them) {
      this.clearDuty(`${duty.player} left the world`);
      return;
    }

    if (duty.kind === 'follow') {
      if (this.bot.entity.position.distanceTo(them) > 4) {
        await this.api.move_to(
          Math.floor(them.x), Math.floor(them.y), Math.floor(them.z)
        );
      }
      return;
    }

    if (duty.kind === 'come' || duty.kind === 'home') {
      const target =
        duty.kind === 'home'
          ? this.api.depot()
          : { x: Math.floor(them.x), y: Math.floor(them.y), z: Math.floor(them.z) };
      const distance = this.bot.entity.position.distanceTo(
        new (require('vec3').Vec3)(target.x, target.y, target.z)
      );
      if (distance <= 3) {
        if (duty.kind === 'come') this.say(`here, ${duty.player}`, { force: true });
        this.clearDuty(duty.kind === 'home' ? 'home' : 'arrived');
        return;
      }
      await this.api.move_to(target.x, target.y, target.z);
      return;
    }

    if (duty.kind === 'gather') {
      await this.serviceGather(duty);
      return;
    }

    if (duty.kind === 'assist') {
      await this.serviceAssist(duty, them);
      return;
    }
  }

  /** "gather wood/stone": the family's skill through the reflex, then
   *  the goods carried to the person who asked. */
  async serviceGather(duty) {
    if (duty.phase === 'fetch') {
      const family = duty.material === 'wood' ? 'gatherer.wood' : 'gatherer.stone';
      let decision = null;
      try {
        decision = await this.reflex.decide({
          bot: this.name,
          role: this.role,
          context: this.context(),
          state: this.worldState(),
          family,
        });
      } catch (err) {
        this.log.note({
          bot: this.name,
          event: 'reflex_unreachable',
          detail: String(err.message || err),
        });
        return; // try again next tick, until the duty expires
      }
      if (!decision || !decision.skill_id) {
        this.say(`I can't get ${duty.material} right now, ${duty.player}`, { force: true });
        this.clearDuty('the reflex refused');
        return;
      }
      this.log.decision({
        bot: this.name,
        role: this.role,
        skill: decision.skill_id,
        title: decision.title,
        reason: 'command:' + family,
        confidence: decision.confidence,
      });
      const record = await this.play(decision, this.context());
      duty.phase = 'deliver';
      duty.how = record && record.outcome ? `${record.outcome.result}: ${record.outcome.detail}` : 'ran';
      return;
    }
    if (duty.phase === 'deliver') {
      const names =
        duty.material === 'wood'
          ? ['oak_log', 'spruce_log', 'birch_log', 'cherry_log', 'dark_oak_log', 'jungle_log', 'acacia_log', 'mangrove_log', 'pale_oak_log']
          : ['cobblestone', 'stone', 'cobbled_deepslate'];
      const taken = await this.api.take_from_depot(names);
      const target = this.playerPosition(duty.player);
      if (!target) {
        this.clearDuty(`${duty.player} left the world`);
        return;
      }
      if (!taken || !taken.ok) {
        this.say(`nothing came of it, ${duty.player} (${duty.how})`, { force: true });
        this.clearDuty('nothing to deliver');
        return;
      }
      await this.api.move_to(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
      const item = this.bot.inventory.items().find((i) => i.name === taken.name);
      if (item) {
        try {
          await this.bot.toss(item.type, null, item.count);
        } catch (err) {
          // The goods stay in the bag; the next depot run returns them.
        }
      }
      this.say(
        `${taken.count} ${taken.name.replace(/_/g, ' ')} for you, ${duty.player}`,
        { force: true }
      );
      this.clearDuty('delivered');
    }
  }

  /** "help me build": stand with the person, and when they place a
   *  block, extend their line or hand them more of the same. */
  async serviceAssist(duty, them) {
    // The invite holds while we work together, and lapses when we don't.
    if (this.guard) this.guard.ledger.invite(this.name, duty.player, 10);

    if (duty.phase === 'approach') {
      if (this.bot.entity.position.distanceTo(them) <= 4) {
        duty.phase = 'by';
        this.say(`ready, ${duty.player} — place blocks and I'll carry on the line`, { force: true });
        return;
      }
      await this.api.move_to(Math.floor(them.x), Math.floor(them.y), Math.floor(them.z));
      return;
    }

    if (this.bot.entity.position.distanceTo(them) > 8) {
      await this.api.move_to(Math.floor(them.x), Math.floor(them.y), Math.floor(them.z));
      return;
    }

    const fresh = this.freshPlacements(duty.player, duty.since);
    const latest = fresh.length ? fresh[fresh.length - 1] : null;
    if (!latest) return;

    if (duty.lastKey !== latest.key) {
      duty.prev = duty.lastKey ? this.placementAt(duty.lastKey) : null;
      duty.lastKey = latest.key;
    }
    if (
      duty.prev &&
      manhattan(duty.prev, latest) === 1 &&
      Date.now() - (duty.assistedAt || 0) > 10000
    ) {
      const dx = latest.x - duty.prev.x;
      const dy = latest.y - duty.prev.y;
      const dz = latest.z - duty.prev.z;
      const target = { x: latest.x + dx, y: latest.y + dy, z: latest.z + dz };
      const have = this.api.inventory_count(latest.name);
      if (have > 0) {
        const placed = await this.api.place(latest.name, target.x, target.y, target.z);
        if (placed.ok) {
          duty.assistedAt = Date.now();
          this.say(`carried your ${latest.name.replace(/_/g, ' ')} on, ${duty.player}`, { force: true });
        }
        return;
      }
      // Nothing of the same kind: hand over what we build with, so the
      // person can carry the line themselves.
      if (Date.now() - (duty.tossedAt || 0) > 30000) {
        const stone = this.bot.inventory.items().find(
          (i) => i.name === 'cobblestone' || i.name === 'oak_planks'
        );
        if (stone) {
          try {
            await this.bot.toss(stone.type, null, Math.min(stone.count, 8));
            duty.tossedAt = Date.now();
            this.say(`no ${latest.name.replace(/_/g, ' ')} on me — here's ${stone.name.replace(/_/g, ' ')}`, { force: true });
          } catch (err) {
            // The toss is a courtesy; the duty holds.
          }
        }
      }
    }
  }

  /** The blocks a player has placed since an instant, newest last. */
  freshPlacements(player, sinceIso) {
    if (!this.guard) return [];
    const out = [];
    for (const row of this.guard.ledger.placed.values()) {
      if (row.by !== player) continue;
      if (String(row.at) <= String(sinceIso)) continue;
      const [x, y, z] = row.pos.split(',').map(Number);
      out.push({ key: row.pos, x, y, z, name: row.name, at: row.at });
    }
    out.sort((a, b) => (a.at < b.at ? -1 : 1));
    return out;
  }

  placementAt(key) {
    const [x, y, z] = key.split(',').map(Number);
    return { x, y, z };
  }

  async tick() {
    if (!this.bot || !this.bot.entity) return;
    // A person's request outranks the world's own work, and it never
    // waits on a model: the duty is walked, not asked.
    if (this.duty) {
      if (Date.now() > this.duty.expires) {
        this.clearDuty('the duty ran out of time');
      } else {
        try {
          await this.serviceDuty();
        } catch (err) {
          this.log.note({
            bot: this.name,
            event: 'duty_failed',
            kind: this.duty ? this.duty.kind : 'gone',
            detail: String(err.message || err),
          });
        }
        return;
      }
    }
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
    this.lastActivity = decision.title || this.lastActivity;
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
    return record;
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

// The names the world owns live in humanity.js now, with the rest of
// how a builder behaves when a person is in the world.
function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

module.exports = { Agent, ROLES };
