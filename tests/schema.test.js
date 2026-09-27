'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultDoc, defaultTrip, normalizeTrip, validateStoredDoc } = require('../data/schema');
const { ownedDoc } = require('./fixtures');

function withExpense() {
  const db = ownedDoc();
  const trip = db.trips[0];
  const person = db.access[trip.id].people[0];
  trip.expenses.push({
    id: 'expense_1', authorId: person.id, title: 'Coffee', amount: 20,
    payer: person.name, participants: [person.name],
  });
  return db;
}

test('current stored documents are accepted without creating or changing trips', () => {
  const empty = defaultDoc();
  assert.deepEqual(empty.trips, []);
  assert.strictEqual(validateStoredDoc(empty), empty);
  const owned = withExpense();
  const snapshot = structuredClone(owned);
  assert.strictEqual(validateStoredDoc(owned), owned);
  assert.deepEqual(owned, snapshot);
});

test('stored data rejects obsolete document and trip fields', () => {
  const base = withExpense();
  for (const [change, pattern] of [
    [db => { db.memos = []; }, /db\.memos/],
    [db => { db.setup = null; }, /db\.setup/],
    [db => { db.meta.welcomeTheme = '#ffffff'; }, /db\.meta\.welcomeTheme/],
    [db => { db.trips[0].bookings = []; }, /bookings/],
    [db => { db.trips[0].meta.version = 1; }, /meta\.version/],
    [db => { db.trips[0].expenses[0].split = '单方'; }, /split/],
    [db => { db.trips[0].expenses[0].receipt = { legacyBookingId: 'booking_1' }; }, /legacyBookingId/],
    [db => { db.trips[0].expenses[0].receipt = { id: 'booking_1' }; }, /receipt\.id/],
  ]) {
    const candidate = structuredClone(base);
    change(candidate);
    assert.throws(() => validateStoredDoc(candidate), pattern);
  }
});

test('stored data rejects missing ownership and record authors instead of repairing them', () => {
  const base = withExpense();
  for (const [change, pattern] of [
    [db => { delete db.access[db.trips[0].id]; }, /access/],
    [db => { delete db.trips[0].expenses[0].authorId; }, /authorId/],
    [db => { delete db.trips[0].expenses[0].participants; }, /participants/],
  ]) {
    const candidate = structuredClone(base);
    change(candidate);
    assert.throws(() => validateStoredDoc(candidate), pattern);
  }
});

test('current trip input normalization rejects obsolete expense and itinerary shapes', () => {
  const base = defaultTrip();
  assert.doesNotThrow(() => normalizeTrip(base));
  assert.throws(() => normalizeTrip({ ...base, bookings: [] }), /旧预订字段/);
  assert.throws(() => normalizeTrip({ ...base, meta: { ...base.meta, theme: '#fff' } }), /旧字段/);
  assert.throws(() => normalizeTrip({ ...base, expenses: [{ id: 'expense_1', title: 'Coffee' }] }), /账单格式无效/);
  assert.throws(() => normalizeTrip({ ...base, expenses: [{ id: 'expense_1', title: 'Coffee', participants: [], split: '均摊' }] }), /旧分摊字段/);
  assert.throws(() => normalizeTrip({ ...base, expenses: [{ id: 'expense_1', title: 'Coffee', participants: [], receipt: { id: 'booking_1' } }] }), /票据包含无效字段/);
  assert.throws(() => normalizeTrip({ ...base, itinerary: [{ items: [{ estimatedCost: 20 }] }] }), /旧费用字段/);
});
