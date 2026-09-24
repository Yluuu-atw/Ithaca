'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultDoc, defaultTrip } = require('../data/schema');
const { claimLegacy } = require('../data/access');
const { AccessDeniedError, project, updateDocument } = require('../data/document-policy');

function fixture() {
  const db = claimLegacy(defaultDoc(), 'alice');
  const second = defaultTrip();
  db.trips.push(second);
  db.access[second.id] = { ownerId: 'bob', members: {}, invites: [], share: null };
  return db;
}

test('data projections exclude hidden trips, ACLs, assets, and other profiles', () => {
  const db = fixture();
  db.profiles.bob = { welcomeTheme: '#112233', memos: [], packingTemplates: [] };
  const view = project(db, { userId: 'alice' });
  assert.deepEqual(view.trips.map(trip => trip.id), [db.trips[0].id]);
  assert.deepEqual(view.permissions, { [db.trips[0].id]: 'owner' });
  assert.equal('access' in view, false);
  assert.equal('assets' in view, false);
  assert.equal('profiles' in view, false);
  assert.notEqual(view.meta.welcomeTheme, '#112233');
});

test('document update preserves hidden trips and denies injected IDs', () => {
  const db = fixture();
  const principal = { userId: 'alice' };
  const visible = project(db, principal);
  visible.trips[0].meta.tripName = 'Edited';
  const next = updateDocument(db, principal, visible);
  assert.equal(next.trips[0].meta.tripName, 'Edited');
  assert.deepEqual(next.trips[1], db.trips[1]);
  visible.trips.push(db.trips[1]);
  assert.throws(() => updateDocument(db, principal, visible), AccessDeniedError);
});

test('viewers cannot change or delete a trip; editors cannot delete it', () => {
  const db = fixture();
  const tripId = db.trips[0].id;
  db.access[tripId].members.bob = 'viewer';
  const bob = { userId: 'bob' };
  const visible = project(db, bob);
  visible.trips.find(trip => trip.id === tripId).meta.tripName = 'Tampered';
  assert.throws(() => updateDocument(db, bob, visible), AccessDeniedError);
  visible.trips = visible.trips.filter(trip => trip.id !== tripId);
  assert.throws(() => updateDocument(db, bob, visible), AccessDeniedError);
  db.access[tripId].members.bob = 'editor';
  assert.throws(() => updateDocument(db, bob, visible), AccessDeniedError);
});

test('new trips are assigned to the author, without accepting client ACL fields', () => {
  const db = fixture();
  const principal = { userId: 'alice' };
  const view = project(db, principal);
  const fresh = defaultTrip();
  fresh.access = { ownerId: 'bob' };
  view.trips.push(fresh);
  view.access = { [fresh.id]: { ownerId: 'bob' } };
  const next = updateDocument(db, principal, view);
  assert.equal(next.access[fresh.id].ownerId, 'alice');
  assert.equal('access' in next.trips.find(trip => trip.id === fresh.id), false);
});
