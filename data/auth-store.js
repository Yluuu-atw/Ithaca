'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function emptyAuth() {
  return { users: [], sessions: [] };
}

function keysMatch(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function nonempty(value) { return typeof value === 'string' && value.length > 0; }

function validateAuth(value) {
  const userKeys = ['id', 'username', 'usernameKey', 'displayName', 'password', 'passkeys', 'createdAt'];
  const passwordKeys = ['scheme', 'salt', 'hash', 'N', 'r', 'p'];
  const passkeyKeys = ['id', 'publicKey', 'counter', 'transports', 'label', 'createdAt'];
  const sessionKeys = ['userId', 'hash', 'csrf', 'expiresAt'];
  if (!keysMatch(value, ['users', 'sessions']) || !Array.isArray(value.users) || !Array.isArray(value.sessions)) {
    throw new Error('Invalid auth store');
  }
  const users = new Set();
  const names = new Set();
  const passkeys = new Set();
  for (const user of value.users) {
    if (!keysMatch(user, userKeys) || !userKeys.filter(key => key !== 'password' && key !== 'passkeys').every(key => nonempty(user[key]))
      || users.has(user.id) || names.has(user.usernameKey)
      || !keysMatch(user.password, passwordKeys) || user.password.scheme !== 'scrypt'
      || !nonempty(user.password.salt) || !nonempty(user.password.hash)
      || !['N', 'r', 'p'].every(key => Number.isSafeInteger(user.password[key]) && user.password[key] > 0)
      || !Array.isArray(user.passkeys)) throw new Error('Invalid auth store');
    users.add(user.id);
    names.add(user.usernameKey);
    for (const key of user.passkeys) {
      if (!keysMatch(key, passkeyKeys) || !nonempty(key.id) || !nonempty(key.publicKey)
        || !nonempty(key.label) || !nonempty(key.createdAt)
        || !Number.isSafeInteger(key.counter) || key.counter < 0
        || !Array.isArray(key.transports) || key.transports.some(transport => !nonempty(transport))
        || passkeys.has(key.id)) throw new Error('Invalid auth store');
      passkeys.add(key.id);
    }
  }
  for (const session of value.sessions) {
    if (!keysMatch(session, sessionKeys) || !users.has(session.userId)
      || !nonempty(session.hash) || !nonempty(session.csrf)
      || !Number.isFinite(session.expiresAt)) throw new Error('Invalid auth store');
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
