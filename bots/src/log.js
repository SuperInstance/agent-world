'use strict';
// bots/src/log.js — the world's own log.
//
// The privacy rule is a hard one: **no human chat and no audio is
// stored**. So this log has no way to record either. It writes agent
// decisions and their outcomes, and nothing else: what a builder chose,
// what it did, whether the sealed prediction held, and what it cost.
//
// One JSON object per line. The file is the humans' window into a world
// that keeps working while they are away.

const fs = require('node:fs');
const path = require('node:path');

class Log {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  write(kind, fields) {
    const row = Object.assign({ at: new Date().toISOString(), kind }, fields);
    this.stream.write(JSON.stringify(row) + '\n');
    return row;
  }

  decision(fields) {
    return this.write('decision', fields);
  }

  outcome(fields) {
    return this.write('outcome', fields);
  }

  note(fields) {
    return this.write('note', fields);
  }

  close() {
    this.stream.end();
  }
}

module.exports = { Log };
