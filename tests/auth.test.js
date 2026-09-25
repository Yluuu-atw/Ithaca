'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuth } = require('../data/auth');

test('registration, password login, session expiry and logout use stored hashes', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/auth-flow-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const user = await auth.register('Traveler', 'a long private password');
    assert.equal(user.username, 'Traveler');
    assert.equal((await auth.login('traveler', 'a long private password')).id, user.id);
    await assert.rejects(auth.login('Traveler', 'wrong password'), /用户名或密码错误/);
    await assert.rejects(auth.register('TRAVELER', 'another long password'), /用户名已存在/);
    const { token, csrf } = await auth.createSession(user.id);
    assert.equal(auth.resolve(token).user.id, user.id);
    assert.ok(csrf.length >= 32);
    const serialized = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes('a long private password'), false);
    await auth.logout(token);
    assert.equal(auth.resolve(token), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrelated registrant cannot claim legacy trips without the operator token', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/setup-flow-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const setupToken = await auth.prepareSetup();
    await auth.register('visitor', 'a visitor password');
    await assert.rejects(auth.setup('owner', 'an owner password', 'invalid'), /设置链接无效/);
    const owner = await auth.setup('owner', 'an owner password', setupToken);
    assert.equal(owner.username, 'owner');
    assert.equal((await auth.setup('owner', 'an owner password', setupToken)).id, owner.id);
    await auth.finishSetup(owner.id);
    await assert.rejects(auth.setup('other', 'another long password', setupToken), /设置链接无效/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('display name changes keep the account identifier and session stable', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/display-name-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'));
    const user = await auth.register('饼饼饼', 'a long private password');
    const { token } = await auth.createSession(user.id);
    assert.equal(user.displayName, '饼饼饼');
    assert.equal((await auth.updateDisplayName(user.id, ' 饼饼 ')).displayName, '饼饼');
    assert.equal(auth.resolve(token).user.displayName, '饼饼');
    assert.equal((await auth.login('饼饼饼', 'a long private password')).id, user.id);
    await assert.rejects(auth.login('饼饼', 'a long private password'), /用户名或密码错误/);
    await assert.rejects(auth.updateDisplayName(user.id, 'bad\nname'), /控制字符/);
    assert.equal(auth.resolve(token).user.displayName, '饼饼');
    assert.equal((await auth.updateDisplayName(user.id, ' ')).displayName, '饼饼饼');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
