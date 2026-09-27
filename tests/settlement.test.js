'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultDoc } = require('../data/schema');
const { claimLegacy } = require('../data/access');
const { formalPerson, syncTripRoster } = require('../data/people');
const { calculateTransfers, personalSettlement } = require('../data/settlement');
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
  assert.equal(ownerView.groupSettlements[trip.id].balance.Alice, 667);
  assert.equal(ownerView.groupSettlements[trip.id].shouldPay.Alice, 334);
  assert.equal(project(db, { shareTripId: trip.id }).groupSettlements[trip.id].balance.Bob, -334);
  const ownerTransfer = ownerView.mySettlements[trip.id].transfers[0];
  const viewerTransfer = viewerView.mySettlements[trip.id].transfers[0];
  assert.deepEqual(ownerView.mySettlements[trip.id].expenseShares, [
    { expenseId: 'e1', amountMinor: 1001, advancedMinor: 1001, shareMinor: 334 },
  ]);
  assert.deepEqual(viewerView.mySettlements[trip.id].expenseShares, [
    { expenseId: 'e1', amountMinor: 1001, advancedMinor: 0, shareMinor: 334 },
  ]);
  assert.deepEqual(project(db, guest).mySettlements[trip.id].expenseShares, [
    { expenseId: 'e1', amountMinor: 1001, advancedMinor: 0, shareMinor: 333 },
  ]);
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

test('personal expense shares reconcile exactly with totals, refunds, and transfers', () => {
  const db = claimLegacy(defaultDoc(), 'owner');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  grant.people = [formalPerson('owner', 'Alice'), formalPerson('viewer', 'Bob'),
    { id: 'person_temp_guest', kind: 'temporary', name: 'Guest', avatar: '🐱', color: '#7d94a8' }];
  grant.members.viewer = 'viewer';
  syncTripRoster(trip, grant);
  trip.expenses = [
    { id: 'charge', payer: 'Alice', participants: ['Alice', 'Bob', 'Guest'], amount: 10.01 },
    { id: 'refund', payer: 'Alice', participants: ['Alice', 'Bob', 'Guest'], amount: -10.01 },
    { id: 'missing_payer', participants: ['Bob', 'Guest'], amount: 1.01 },
    { id: 'legacy_single', payer: 'Bob', split: '单方', amount: 2.01 },
    { id: 'penny', payer: 'Guest', participants: ['Alice', 'Bob', 'Guest'], amount: 0.01 },
    { id: 'pending_ticket', payer: 'Alice', amount: 0, receipt: { price: 500 } },
  ];

  const plan = calculateTransfers(trip, grant);
  const principals = [
    { userId: 'owner' },
    { userId: 'viewer' },
    { tempTripId: trip.id, tempPersonId: 'person_temp_guest' },
  ];
  const mine = principals.map(principal => personalSettlement(trip, grant, principal));
  for (const settlement of mine) {
    assert.equal(settlement.expenseShares.reduce((sum, row) => sum + row.advancedMinor, 0), settlement.advancedMinor);
    assert.equal(settlement.expenseShares.reduce((sum, row) => sum + row.shareMinor, 0), settlement.owedMinor);
    assert.equal(settlement.advancedMinor - settlement.owedMinor, settlement.balanceMinor);
    assert.equal(settlement.expenseShares.some(row => row.expenseId === 'pending_ticket'), false);
  }
  assert.deepEqual(mine[0].expenseShares.find(row => row.expenseId === 'charge'),
    { expenseId: 'charge', amountMinor: 1001, advancedMinor: 1001, shareMinor: 334 });
  assert.deepEqual(mine[0].expenseShares.find(row => row.expenseId === 'refund'),
    { expenseId: 'refund', amountMinor: -1001, advancedMinor: -1001, shareMinor: -334 });
  assert.deepEqual(mine[0].expenseShares.find(row => row.expenseId === 'missing_payer'),
    { expenseId: 'missing_payer', amountMinor: 101, advancedMinor: 101, shareMinor: 0 });
  assert.deepEqual(mine[1].expenseShares.find(row => row.expenseId === 'legacy_single'),
    { expenseId: 'legacy_single', amountMinor: 201, advancedMinor: 201, shareMinor: 201 });
  assert.equal(mine[0].expenseShares.some(row => row.expenseId === 'legacy_single'), false);
  assert.deepEqual(mine.map(settlement => settlement.balanceMinor), [100, -51, -49]);
  assert.deepEqual(plan.transfers.map(transfer => transfer.amountMinor), [51, 49]);
  assert.equal(mine[0].transfers.every(transfer => transfer.direction === 'in'), true);
  assert.equal(mine[1].transfers.every(transfer => transfer.direction === 'out'), true);
  assert.equal(mine[2].transfers.every(transfer => transfer.direction === 'out'), true);
});

test('a refund reverses the same per-member allocation', () => {
  const db = claimLegacy(defaultDoc(), 'owner');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  trip.expenses = [
    { payer: trip.meta.members[0], participants: trip.meta.members.slice(), amount: 10.01 },
    { payer: trip.meta.members[0], participants: trip.meta.members.slice(), amount: -10.01 },
  ];
  const plan = calculateTransfers(trip, grant);
  assert.deepEqual(plan.transfers, []);
  assert.ok(Object.values(plan.balance).every(value => value === 0));
});

test('receipt metadata and legacy reservation prices never create another transfer', () => {
  const db = claimLegacy(defaultDoc(), 'owner');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  const [payer, companion] = trip.meta.members;
  trip.expenses = [{
    id: 'expense_paid', payer, participants: [payer, companion], amount: 20,
    receipt: { legacyBookingId: 'booking_paid', price: 999, status: '已订' },
  }, {
    id: 'expense_pending', payer, participants: [payer, companion], amount: 0,
    receipt: { legacyBookingId: 'booking_pending', price: 888, status: '待订' },
  }];
  trip.bookings = [
    { id: 'booking_paid', payer, price: 20, status: '已订' },
    { id: 'booking_pending', payer, price: 888, status: '待订' },
  ];

  const plan = calculateTransfers(trip, grant);
  assert.equal(plan.advanced[grant.people[0].id], 2000);
  assert.equal(plan.owed[grant.people[0].id], 1000);
  assert.equal(plan.owed[grant.people[1].id], 1000);
  assert.deepEqual(plan.transfers.map(transfer => transfer.amountMinor), [1000]);
});

test('a legacy expense without an ID still contributes to personal totals', () => {
  const db = claimLegacy(defaultDoc(), 'owner');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  const [payer, companion] = trip.meta.members;
  trip.expenses = [{ payer, participants: [payer, companion], amount: 2 }];

  const owner = personalSettlement(trip, grant, { userId: 'owner' });
  assert.equal(owner.advancedMinor, 200);
  assert.equal(owner.owedMinor, 100);
  assert.deepEqual(owner.expenseShares, [
    { expenseId: '', amountMinor: 200, advancedMinor: 200, shareMinor: 100 },
  ]);
});
