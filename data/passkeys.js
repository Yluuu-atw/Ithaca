'use strict';

const crypto = require('node:crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { publicUser, usernameKey } = require('./auth');

const CHALLENGE_MS = 5 * 60 * 1000;

function createPasskeys(auth, origin) {
  const rpID = new URL(origin).hostname;
  const flows = new Map();

  function begin(kind, userId, challenge) {
    for (const [id, flow] of flows) if (flow.expiresAt < Date.now()) flows.delete(id);
    const flowId = crypto.randomBytes(24).toString('base64url');
    flows.set(flowId, { kind, userId, challenge, expiresAt: Date.now() + CHALLENGE_MS });
    return flowId;
  }

  function consume(flowId, kind, userId) {
    const flow = flows.get(flowId);
    flows.delete(flowId);
    if (!flow || flow.kind !== kind || flow.userId !== userId || flow.expiresAt < Date.now()) {
      throw new Error('通行密钥验证已过期，请重新尝试');
    }
    return flow.challenge;
  }

  function findUser(username) {
    let key;
    try { key = usernameKey(username).key; } catch (_) { key = ''; }
    return auth.store.get().users.find(user => user.usernameKey === key);
  }

  async function registrationOptions(userId) {
    const user = auth.store.get().users.find(candidate => candidate.id === userId);
    if (!user) throw new Error('用户不存在');
    const options = await generateRegistrationOptions({
      rpName: '九州 ITHACA', rpID, userName: user.username,
      userID: Buffer.from(user.id), attestationType: 'none',
      excludeCredentials: (user.passkeys || []).map(key => ({ id: key.id, transports: key.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { flowId: begin('register', userId, options.challenge), options };
  }

  async function register(userId, flowId, response, label) {
    const expectedChallenge = consume(flowId, 'register', userId);
    const result = await verifyRegistrationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified) throw new Error('通行密钥验证失败');
    const credential = result.registrationInfo.credential;
    let updated;
    await auth.store.mutate(state => {
      const user = state.users.find(candidate => candidate.id === userId);
      if (!user) throw new Error('用户不存在');
      if (state.users.some(candidate => (candidate.passkeys || []).some(key => key.id === credential.id))) {
        throw new Error('通行密钥已登记');
      }
      user.passkeys ||= [];
      user.passkeys.push({
        id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter, transports: response.response.transports || [],
        label: String(label || '通行密钥').trim().slice(0, 60) || '通行密钥',
        createdAt: new Date().toISOString(),
      });
      updated = publicUser(user);
    });
    return updated;
  }

  async function authenticationOptions(username) {
    const user = findUser(username);
    if (!user || !(user.passkeys || []).length) throw new Error('账号没有通行密钥');
    const options = await generateAuthenticationOptions({
      rpID, userVerification: 'required',
      allowCredentials: user.passkeys.map(key => ({ id: key.id, transports: key.transports })),
    });
    return { flowId: begin('login', user.id, options.challenge), options };
  }

  async function authenticate(username, flowId, response) {
    const user = findUser(username);
    if (!user) throw new Error('通行密钥验证失败');
    const expectedChallenge = consume(flowId, 'login', user.id);
    const key = (user.passkeys || []).find(candidate => candidate.id === response.id);
    if (!key) throw new Error('通行密钥验证失败');
    const result = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: key.id, publicKey: Buffer.from(key.publicKey, 'base64url'), counter: key.counter, transports: key.transports },
      requireUserVerification: true,
    });
    if (!result.verified) throw new Error('通行密钥验证失败');
    await auth.store.mutate(state => {
      const stored = state.users.find(candidate => candidate.id === user.id);
      const storedKey = stored && (stored.passkeys || []).find(candidate => candidate.id === key.id);
      if (!storedKey || storedKey.counter !== key.counter) throw new Error('通行密钥状态已更新，请重试');
      storedKey.counter = result.authenticationInfo.newCounter;
    });
    return publicUser(user);
  }

  async function remove(userId, id) {
    await auth.store.mutate(state => {
      const user = state.users.find(candidate => candidate.id === userId);
      if (!user) throw new Error('用户不存在');
      const count = (user.passkeys || []).length;
      user.passkeys = (user.passkeys || []).filter(key => key.id !== id);
      if (user.passkeys.length === count) throw new Error('通行密钥不存在');
    });
  }

  return { registrationOptions, register, authenticationOptions, authenticate, remove };
}

module.exports = { createPasskeys };
