'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createAuthStore } = require('./auth-store');

const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const SETUP_MS = 24 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 1 << 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function usernameKey(value) {
  const name = String(value || '').trim();
  if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(name)) throw new Error('用户名需为 3–40 个字符，可使用字母、数字、点、横线和下划线');
  return { name, key: name.toLocaleLowerCase('en-US') };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('密码长度需为 12–256 个字符');
  }
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function passwordRecord(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(24).toString('base64url');
  const hash = (await scrypt(password, salt)).toString('base64url');
  return { scheme: 'scrypt', salt, hash, N: SCRYPT_OPTIONS.N, r: SCRYPT_OPTIONS.r, p: SCRYPT_OPTIONS.p };
}

async function verifyPassword(password, record) {
  if (!record || record.scheme !== 'scrypt' || typeof password !== 'string') return false;
  const actual = await scrypt(password, record.salt);
  const expected = Buffer.from(record.hash, 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return { id: user.id, username: user.username, passkeys: (user.passkeys || []).map(({ id, label, createdAt }) => ({ id, label, createdAt })) };
}

function createAuth(file, setupFile) {
  const store = createAuthStore(file);
  const setupPath = setupFile || path.join(path.dirname(file), '..', '.local', 'setup-token');

  async function createUser(username, password, setupToken) {
    const { name, key } = usernameKey(username);
    const secret = await passwordRecord(password);
    let user;
    await store.mutate(state => {
      if (state.users.some(candidate => candidate.usernameKey === key)) throw new Error('用户名已存在');
      if (setupToken) {
        if (!state.setup || state.setup.hash !== digest(setupToken) || state.setup.expiresAt < Date.now()) {
          throw new Error('设置链接无效或已过期');
        }
        if (state.setup.pendingOwnerId) throw new Error('初始账号设置正在完成');
      }
      user = {
        id: crypto.randomUUID(), username: name, usernameKey: key,
        password: secret, passkeys: [],
        private: { welcomeTheme: '#f2ece0', memos: [], packingTemplates: [] },
        createdAt: new Date().toISOString(),
      };
      state.users.push(user);
      if (setupToken) state.setup.pendingOwnerId = user.id;
    });
    return publicUser(user);
  }

  async function register(username, password) {
    return createUser(username, password, null);
  }

  async function setup(username, password, token) {
    const state = store.get();
    if (state.setup && state.setup.hash === digest(token) && state.setup.pendingOwnerId) {
      const user = await login(username, password);
      if (user.id !== state.setup.pendingOwnerId) throw new Error('设置链接无效或已过期');
      return user;
    }
    return createUser(username, password, token);
  }

  async function finishSetup(userId) {
    await store.mutate(state => {
      if (!state.setup || state.setup.pendingOwnerId !== userId) throw new Error('初始账号设置状态不一致');
      state.setup = null;
    });
    await fs.promises.rm(setupPath, { force: true });
  }

  async function login(username, password) {
    let key;
    try { key = usernameKey(username).key; } catch (_) { key = ''; }
    const user = store.get().users.find(candidate => candidate.usernameKey === key);
    if (!user || !(await verifyPassword(password, user.password))) throw new Error('用户名或密码错误');
    return publicUser(user);
  }

  async function createSession(userId) {
    const token = randomToken();
    const csrf = randomToken();
    await store.mutate(state => {
      if (!state.users.some(user => user.id === userId)) throw new Error('用户不存在');
      state.sessions = state.sessions.filter(session => session.expiresAt > Date.now());
      state.sessions.push({ userId, hash: digest(token), csrf, expiresAt: Date.now() + SESSION_MS });
    });
    return { token, csrf };
  }

  function resolve(token) {
    if (!token) return null;
    const state = store.get();
    const session = state.sessions.find(entry => entry.hash === digest(token) && entry.expiresAt > Date.now());
    if (!session) return null;
    const user = state.users.find(entry => entry.id === session.userId);
    return user ? { user: publicUser(user), csrf: session.csrf } : null;
  }

  async function logout(token) {
    if (!token) return;
    await store.mutate(state => { state.sessions = state.sessions.filter(entry => entry.hash !== digest(token)); });
  }

  async function prepareSetup() {
    const state = store.get();
    if (state.setup && state.setup.expiresAt > Date.now() && fs.existsSync(setupPath)) {
      const existing = fs.readFileSync(setupPath, 'utf8').trim();
      if (digest(existing) === state.setup.hash) return existing;
    }
    const token = randomToken();
    await store.mutate(next => { next.setup = { hash: digest(token), expiresAt: Date.now() + SETUP_MS }; });
    await fs.promises.mkdir(path.dirname(setupPath), { recursive: true });
    await fs.promises.writeFile(setupPath, `${token}\n`, { mode: 0o600 });
    return token;
  }

  return { store, register, setup, finishSetup, login, createSession, resolve, logout, prepareSetup };
}

module.exports = { createAuth, digest, publicUser, usernameKey, passwordRecord, verifyPassword };
