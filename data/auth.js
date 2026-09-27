'use strict';

const crypto = require('node:crypto');
const { createAuthStore } = require('./auth-store');

const configuredDays = Number(process.env.ITHACA_SESSION_DAYS || 30);
const SESSION_DAYS = Number.isInteger(configuredDays) && configuredDays >= 1 && configuredDays <= 90 ? configuredDays : 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
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

function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw new Error('昵称格式无效');
  const name = value.trim().normalize('NFC');
  if (Array.from(name).length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error('昵称最多 40 个字符，不能包含控制字符');
  }
  return name;
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
  return { id: user.id, username: user.username, displayName: user.displayName,
    passkeys: user.passkeys.map(({ id, label, createdAt }) => ({ id, label, createdAt })) };
}

function createAuth(file) {
  const store = createAuthStore(file);

  async function register(username, password) {
    const { name, key } = usernameKey(username);
    const secret = await passwordRecord(password);
    let user;
    await store.mutate(state => {
      if (state.users.some(candidate => candidate.usernameKey === key)) throw new Error('用户名已存在');
      user = {
        id: crypto.randomUUID(), username: name, usernameKey: key,
        displayName: name, password: secret, passkeys: [],
        createdAt: new Date().toISOString(),
      };
      state.users.push(user);
    });
    return publicUser(user);
  }

  async function login(username, password) {
    let key;
    try { key = usernameKey(username).key; } catch (_) { key = ''; }
    const user = store.get().users.find(candidate => candidate.usernameKey === key);
    if (!user || !(await verifyPassword(password, user.password))) throw new Error('用户名或密码错误');
    return publicUser(user);
  }

  async function updateDisplayName(userId, value) {
    const name = normalizeDisplayName(value);
    let updated;
    await store.mutate(state => {
      const user = state.users.find(candidate => candidate.id === userId);
      if (!user) throw new Error('用户不存在');
      user.displayName = name || user.username;
      updated = publicUser(user);
    });
    return updated;
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

  return { store, register, login, updateDisplayName, createSession, resolve, logout };
}

module.exports = { createAuth, digest, publicUser, usernameKey, passwordRecord, verifyPassword, SESSION_DAYS };
