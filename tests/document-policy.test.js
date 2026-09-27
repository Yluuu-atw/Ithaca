'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultTrip } = require('../data/schema');
const { AccessDeniedError, project, updateDocument } = require('../data/document-policy');
const { syncTripRoster } = require('../data/people');
const { ownedDoc, addFormalMember } = require('./fixtures');

function fixture() {
  const db = ownedDoc('alice');
  const other = ownedDoc('bob');
  const second = other.trips[0];
  db.trips.push(second);
  db.access[second.id] = other.access[second.id];
  db.profiles.bob = other.profiles.bob;
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

test('formal member nicknames are projected without changing stored trip names', () => {
  const db = fixture();
  const tripId = db.trips[0].id;
  const originalName = db.access[tripId].people[0].name;
  const view = project(db, { userId: 'alice' }, [{ id: 'alice', username: '饼饼饼', displayName: '饼饼' }]);
  assert.equal(view.rosters[tripId][0].displayName, '饼饼');
  assert.equal(view.rosters[tripId][0].name, originalName);
  assert.deepEqual(view.trips[0].meta.members, db.trips[0].meta.members);
  assert.equal(db.access[tripId].people[0].displayName, undefined);
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
  addFormalMember(db, tripId, 'bob', 'bob', 'viewer');
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
  assert.equal(next.access[fresh.id].people.length, 1);
  assert.deepEqual(next.trips.find(trip => trip.id === fresh.id).meta.members, ['alice']);
  assert.equal('access' in next.trips.find(trip => trip.id === fresh.id), false);
});

test('server owns trip roster and authorship', () => {
  const db = fixture();
  const principal = { userId: 'alice', username: 'alice' };
  const view = project(db, principal);
  view.trips[0].meta.members.push('imposter');
  assert.throws(() => updateDocument(db, principal, view), AccessDeniedError);
  view.trips[0].meta.members.pop();
  view.trips[0].expenses.push({ id: 'expense_new', title: 'Coffee', amount: 10,
    payer: 'alice', participants: ['alice'], authorId: 'someone_else' });
  assert.throws(() => updateDocument(db, principal, view), AccessDeniedError);
  delete view.trips[0].expenses[0].authorId;
  const next = updateDocument(db, principal, view);
  assert.equal(next.trips[0].expenses[0].authorId, db.access[db.trips[0].id].people[0].id);
  assert.equal('tokenHash' in project(next, principal).rosters[db.trips[0].id][0], false);
});

test('an editor cannot attach a photo owned by another trip', () => {
  const db = fixture();
  const principal = { userId: 'alice' };
  db.assets['private.jpg'] = { tripId: db.trips[1].id, ownerId: null, createdAt: '' };
  const view = project(db, principal);
  view.trips[0].photos.push({ url: '/uploads/private.jpg' });
  assert.throws(() => updateDocument(db, principal, view), AccessDeniedError);
});

test('expense and receipt images retain trip ownership on save', () => {
  const db = fixture();
  const principal = { userId: 'alice' };
  const tripId = db.trips[0].id;
  db.assets['own.jpg'] = { tripId, ownerId: null, createdAt: '' };
  db.assets['other.jpg'] = { tripId: db.trips[1].id, ownerId: null, createdAt: '' };
  const view = project(db, principal);
  view.trips[0].expenses.push({ id: 'expense_1', title: 'Ticket', amount: 0,
    payer: 'alice', participants: ['alice'], images: ['/uploads/own.jpg'],
    receipt: { images: ['/uploads/own.jpg'] } });
  const saved = updateDocument(db, principal, view);
  assert.deepEqual(saved.trips[0].expenses[0].images, ['/uploads/own.jpg']);
  assert.deepEqual(saved.trips[0].expenses[0].receipt.images, ['/uploads/own.jpg']);
  view.trips[0].expenses[0].images = ['/uploads/other.jpg'];
  assert.throws(() => updateDocument(db, principal, view), AccessDeniedError);
  view.trips[0].expenses[0].images = ['/uploads/own.jpg'];
  view.trips[0].expenses[0].receipt.images = ['/uploads/other.jpg'];
  assert.throws(() => updateDocument(db, principal, view), AccessDeniedError);
});

test('ticket details inherit expense authorship and temporary edit restrictions', () => {
  const db = ownedDoc('alice');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  const ownerAuthorId = grant.people[0].id;
  const tempAuthorId = 'person_temp_guest';
  grant.people.push({ id: tempAuthorId, kind: 'temporary', name: 'Guest', avatar: '🐱', color: '#7d94a8' });
  syncTripRoster(trip, grant);
  trip.expenses.push({
    id: 'expense_paid', title: 'Rail fare', amount: 24, payer: 'alice', participants: ['alice'],
    authorId: ownerAuthorId,
    receipt: { refNo: 'A123' },
  });
  const guest = { tempTripId: trip.id, tempPersonId: tempAuthorId };
  const guestView = project(db, guest);
  guestView.trips[0].expenses[0].receipt.refNo = 'Hijacked';
  assert.throws(() => updateDocument(db, guest, guestView), AccessDeniedError);

  guestView.trips[0].expenses[0].receipt.refNo = 'A123';
  guestView.trips[0].expenses.push({
    id: 'expense_guest', title: 'Train ticket', amount: 0, payer: 'Guest', participants: ['Guest'],
    receipt: { status: '待订', price: 88 },
  });
  const saved = updateDocument(db, guest, guestView);
  assert.equal(saved.trips[0].expenses[1].authorId, tempAuthorId);
  assert.equal(saved.trips[0].expenses[0].authorId, ownerAuthorId);
  assert.equal(saved.trips[0].expenses[1].receipt.price, 88);

  const owner = { userId: 'alice' };
  const ownerView = project(saved, owner);
  ownerView.trips[0].expenses[1].receipt.refNo = 'Updated';
  const updated = updateDocument(saved, owner, ownerView);
  assert.equal(updated.trips[0].expenses[1].authorId, tempAuthorId);
  assert.equal(updated.trips[0].expenses[1].receipt.refNo, 'Updated');
});
