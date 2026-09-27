'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { roleFor, canEdit, canReadAsset, uploadNames } = require('../data/access');
const { createAuthStore } = require('../data/auth-store');
const { ownedDoc, addFormalMember } = require('./fixtures');

test('trip and private uploads follow their current owners', () => {
  const doc = ownedDoc('owner_1');
  const tripId = doc.trips[0].id;
  doc.assets['photo_1.jpg'] = { tripId, ownerId: null, createdAt: '' };
  doc.assets['memo_1.jpg'] = { tripId: null, ownerId: 'owner_1', createdAt: '' };
  assert.equal(roleFor(doc, { userId: 'owner_1' }, tripId), 'owner');
  assert.equal(roleFor(doc, { userId: 'stranger' }, tripId), null);
  assert.equal(canReadAsset(doc, { userId: 'owner_1' }, 'photo_1.jpg'), true);
  assert.equal(canReadAsset(doc, { userId: 'owner_1' }, 'memo_1.jpg'), true);
  assert.equal(canReadAsset(doc, { userId: 'stranger' }, 'memo_1.jpg'), false);
  assert.deepEqual([...uploadNames(['/uploads/good.jpg', '/uploads/../bad.jpg'])], ['good.jpg']);
});

test('viewer role cannot edit, while editor and owner can', () => {
  const doc = ownedDoc('owner_1');
  const tripId = doc.trips[0].id;
  addFormalMember(doc, tripId, 'editor_1');
  addFormalMember(doc, tripId, 'viewer_1', 'viewer_1', 'viewer');
  assert.equal(canEdit(doc, { userId: 'owner_1' }, tripId), true);
  assert.equal(canEdit(doc, { userId: 'editor_1' }, tripId), true);
  assert.equal(canEdit(doc, { userId: 'viewer_1' }, tripId), false);
});

test('auth store serializes writes and rolls back failed mutations', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/auth-test-'));
  try {
    const store = createAuthStore(path.join(dir, 'auth.json'));
    await Promise.all([
      store.mutate(state => { state.users.push({ id: 'one' }); }),
      store.mutate(state => { state.users.push({ id: 'two' }); }),
    ]);
    await assert.rejects(store.mutate(() => { throw new Error('reject'); }), /reject/);
    assert.deepEqual(store.get().users.map(user => user.id), ['one', 'two']);
    assert.deepEqual(createAuthStore(path.join(dir, 'auth.json')).get().users.map(user => user.id), ['one', 'two']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
