'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function emptyAuth() {
  return { users: [], sessions: [] };
}

function validateAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'users') || !Object.hasOwn(value, 'sessions')
    || !Array.isArray(value.users) || !Array.isArray(value.sessions)
    || value.users.some(user => !user || typeof user !== 'object' || Array.isArray(user) || typeof user.id !== 'string')
    || value.sessions.some(session => !session || typeof session !== 'object' || Array.isArray(session))) {
    throw new Error('Invalid auth store');
  }
}

function readAuth(file) {
  if (!fs.existsSync(file)) return emptyAuth();
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateAuth(value);
  return value;
}

function createAuthStore(file) {
  let state = readAuth(file);
  let queue = Promise.resolve();

  async function write(next) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.promises.rename(temp, file);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }

  function mutate(fn) {
    const run = queue.then(async () => {
      const next = structuredClone(state);
      const result = await fn(next);
      validateAuth(next);
      await write(next);
      state = next;
      return result;
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  return { get: () => structuredClone(state), mutate };
}

module.exports = { emptyAuth, readAuth, createAuthStore };
