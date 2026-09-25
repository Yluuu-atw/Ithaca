'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultDoc } = require('../data/schema');
const { claimLegacy } = require('../data/access');
const { formalPerson, syncTripRoster } = require('../data/people');
const { calculateTransfers } = require('../data/settlement');
const { project } = require('../data/document-policy');
const { createSharing } = require('../data/sharing');

test('settlement allocates cents deterministically and keeps confirmations private', async () => {
  let db = claimLegacy(defaultDoc(), 'owner');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  grant.people = [formalPerson('owner', 'Alice'), formalPerson('viewer', 'Bob'),
    { id: 'person_temp_guest', kind: 'temporary', name: 'Guest', avatar: '🐱', color: '#7d94a8' }];
  grant.members.viewer = 'viewer';
  syncTripRoster(trip, grant);
  trip.expenses.push({ id: 'e1', payer: 'Alice', participants: ['Alice', 'Bob', 'Guest'], amount: 10.01 });
  const plan = calculateTransfers(trip, grant);
  assert.equal(plan.balance[grant.people[0].id], 667);
  assert.deepEqual(plan.transfers.map(item => item.amountMinor), [334, 333]);

  const auth = { store: { get: () => ({ users: [
    { id: 'owner', username: 'Alice' }, { id: 'viewer', username: 'Bob' },
  ] }) } };
  const sharing = createSharing(auth, () => db, async change => { db = change(db); });
  const owner = { userId: 'owner' };
  const viewer = { userId: 'viewer' };
  const guest = { tempTripId: trip.id, tempPersonId: 'person_temp_guest' };
  const ownerView = project(db, owner, auth.store.get().users);
  const viewerView = project(db, viewer, auth.store.get().users);
  const ownerTransfer = ownerView.mySettlements[trip.id].transfers[0];
  const viewerTransfer = viewerView.mySettlements[trip.id].transfers[0];
  assert.equal(ownerTransfer.direction, 'in');
  assert.equal(viewerTransfer.direction, 'out');
  assert.equal(viewerTransfer.amountMinor, 334);
  assert.equal(project(db, guest).mySettlements[trip.id].transfers[0].amountMinor, 333);
  assert.deepEqual(project(db, { shareTripId: trip.id }).mySettlements, {});
  assert.equal(JSON.stringify(viewerView.rosters).includes('transferStates'), false);

  await sharing.updateTransfer(trip.id, viewer, { key: viewerTransfer.key, confirmed: true });
  assert.equal(project(db, viewer).mySettlements[trip.id].transfers[0].confirmed, true);
  assert.equal(project(db, owner).mySettlements[trip.id].transfers[0].confirmed, false);
  assert.equal(project(db, guest).mySettlements[trip.id].transfers[0].confirmed, false);
  await assert.rejects(sharing.updateTransfer(trip.id, viewer, { key: ownerTransfer.key, confirmed: true }), /转账项目已发生变化/);
  await assert.rejects(sharing.updateTransfer(trip.id, { shareTripId: trip.id }, { key: viewerTransfer.key, confirmed: true }), /只有旅行成员/);
  db.trips[0].expenses[0].amount = 12.01;
  assert.equal(project(db, viewer).mySettlements[trip.id].transfers[0].confirmed, false);
  await assert.rejects(sharing.updateTransfer(trip.id, viewer, { key: viewerTransfer.key, confirmed: true }), /转账项目已发生变化/);
});
