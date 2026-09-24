'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuth } = require('../data/auth');
const { createPasskeys } = require('../data/passkeys');

test('passkey challenges are bound to user, ceremony and one attempt', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/passkeys-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const alice = await auth.register('alice', 'alice private password');
    const bob = await auth.register('bobby', 'bobby private password');
    const passkeys = createPasskeys(auth, 'https://ithaca.example.test:1145');
    const flow = await passkeys.registrationOptions(alice.id);
    assert.equal(flow.options.rp.id, 'ithaca.example.test');
    assert.equal(flow.options.authenticatorSelection.userVerification, 'required');
    assert.equal(flow.options.authenticatorSelection.residentKey, 'required');
    await assert.rejects(passkeys.register(bob.id, flow.flowId, {}, 'wrong user'), /已过期/);
    await assert.rejects(passkeys.register(alice.id, flow.flowId, {}, 'replayed'), /已过期/);
    const next = await passkeys.registrationOptions(alice.id);
    await assert.rejects(passkeys.register(alice.id, next.flowId, {}, 'forged'));
    await assert.rejects(passkeys.register(alice.id, next.flowId, {}, 'replayed'), /已过期/);
    await assert.rejects(passkeys.authenticationOptions('alice'), /没有通行密钥/);
    assert.deepEqual(auth.store.get().users[0].passkeys, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
