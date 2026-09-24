'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { defaultDoc } = require('../data/schema');
const { claimLegacy, roleFor, canEdit, uploadNames } = require('../data/access');
const { createAuthStore } = require('../data/auth-store');

test('legacy trips and upload references are claimed by the initial owner', () => {
  const doc = defaultDoc();
  doc.trips[0].photos.push({ url: '/uploads/photo_1.jpg' });
  doc.memos.push({ id: 'memo_1', photos: ['/uploads/memo_1.jpg'] });
  const claimed = claimLegacy(doc, 'owner_1');
  const tripId = claimed.trips[0].id;
  assert.equal(roleFor(claimed, { userId: 'owner_1' }, tripId), 'owner');
  assert.equal(roleFor(claimed, { userId: 'stranger' }, tripId), null);
  assert.equal(claimed.assets['photo_1.jpg'].tripId, tripId);
  assert.equal(claimed.assets['memo_1.jpg'].ownerId, 'owner_1');
  assert.deepEqual([...uploadNames(['/uploads/good.jpg', '/uploads/../bad.jpg'])], ['good.jpg']);
});

test('viewer role cannot edit, while editor and owner can', () => {
  const doc = claimLegacy(defaultDoc(), 'owner_1');
  const tripId = doc.trips[0].id;
  doc.access[tripId].members.editor_1 = 'editor';
  doc.access[tripId].members.viewer_1 = 'viewer';
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
