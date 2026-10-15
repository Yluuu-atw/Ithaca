'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { project, updateDocument, AccessDeniedError } = require('../data/document-policy');
const { syncTripRoster, unusedAppearance } = require('../data/people');
const { ownedDoc, addFormalMember } = require('./fixtures');

function itineraryHelpers(canEditRecord = () => true) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8')
    .replace('return { init };', 'return { saveItineraryItem, moveItemToDate, syncExpenseFromItem, syncItemFromExpense, removeExpenseRecord };')
    .replace("document.addEventListener('DOMContentLoaded', App.init);", '');
  let sequence = 0;
  const context = {
    window: {}, document: { addEventListener() {} },
    Store: {
      uid: prefix => `${prefix}_test_${++sequence}`,
      canEditRecord,
      CONST: { itemToExpenseCategory: { 交通: '交通' }, expenseToItemCategory: { 交通: '交通' } },
    },
  };
  vm.runInNewContext(source, context);
  return context.window.App;
}

function sampleItem(id, authorId) {
  return { id, authorId, title: 'Train', startDate: '2026-10-15', time: '09:00',
    category: '交通', amount: 30, payer: 'alice', participants: ['alice'] };
}

function sampleDays(authorId, itemAuthorId = authorId) {
  return [
    { id: 'day_source', date: '2026-10-15', authorId, order: ['item_move', 'item_stay'],
      items: [sampleItem('item_move', itemAuthorId), sampleItem('item_stay', authorId)] },
    { id: 'day_target', date: '2026-10-16', authorId, order: ['item_target'],
      items: [{ ...sampleItem('item_target', authorId), startDate: '2026-10-16' }] },
  ];
}

test('moving an itinerary item reuses its date container and preserves record identity', () => {
  const { saveItineraryItem } = itineraryHelpers();
  const trip = { itinerary: sampleDays('person_alice'), expenses: [
    { id: 'expense_linked', itemId: 'item_move', authorId: 'person_alice', amount: 30 },
  ] };
  const original = trip.itinerary[0].items[0];
  const destination = saveItineraryItem(trip, 'day_source', original.id,
    { startDate: '2026-10-16', time: '11:45', title: 'Changed train' });
  assert.equal(destination, 'day_target');
  assert.equal(trip.itinerary.filter(day => day.date === '2026-10-16').length, 1);
  assert.equal(trip.itinerary.flatMap(day => day.items).filter(item => item.id === original.id).length, 1);
  assert.equal(trip.itinerary[1].items[1], original);
  assert.equal(original.authorId, 'person_alice');
  assert.deepEqual(trip.itinerary[0].order, ['item_stay']);
  assert.deepEqual(trip.itinerary[1].order, ['item_target', 'item_move']);
  assert.equal(trip.expenses.length, 1);
  assert.equal(trip.expenses[0].id, 'expense_linked');
  assert.equal(trip.expenses[0].authorId, 'person_alice');
  assert.equal(trip.expenses[0].date, '2026-10-16');
  assert.equal(trip.expenses[0].time, '11:45');
});

test('new and moved items create only the missing date container', () => {
  const { saveItineraryItem, moveItemToDate } = itineraryHelpers();
  const source = { id: 'day_source', date: '2026-10-15', authorId: 'person_alice', order: [], items: [] };
  const trip = { itinerary: [source], expenses: [] };
  const destination = saveItineraryItem(trip, source.id, null,
    { title: 'Walk', startDate: '2026-10-17', time: '15:00', amount: 0 });
  const target = trip.itinerary.find(day => day.id === destination);
  assert.equal(target.date, '2026-10-17');
  assert.equal(trip.itinerary.length, 2);
  assert.equal(source.items.length, 0);
  assert.deepEqual(source.order, []);
  assert.equal(target.items.length, 1);
  assert.equal(moveItemToDate(trip, target, target.items[0], target.date), target);
  assert.equal(trip.itinerary.length, 2);
  assert.equal(target.items.length, 1);
  assert.throws(() => saveItineraryItem(trip, 'missing_day', null, {}), /已被删除/);
  assert.throws(() => saveItineraryItem(trip, target.id, 'missing_item', {}), /已被移动或删除/);
});

test('linked expenses and itinerary items share date and time in both editing directions', () => {
  const { syncExpenseFromItem, syncItemFromExpense } = itineraryHelpers();
  const trip = { itinerary: sampleDays('person_alice'), expenses: [] };
  const item = trip.itinerary[0].items[0];
  syncExpenseFromItem(trip, item, trip.itinerary[0].date);
  const expense = trip.expenses[0];
  assert.equal(expense.itemId, item.id);
  assert.equal(expense.date, item.startDate);
  assert.equal(expense.time, item.time);
  expense.date = '2026-10-16';
  expense.time = '13:20';
  syncItemFromExpense(trip, expense);
  assert.equal(trip.itinerary[1].items[1], item);
  assert.equal(item.startDate, expense.date);
  assert.equal(item.time, expense.time);
  assert.equal(trip.expenses.length, 1);
  assert.equal(trip.itinerary.flatMap(day => day.items).filter(entry => entry.id === item.id).length, 1);
});

test('moving the last linked item removes only an editable automatically created day', () => {
  for (const editable of [true, false]) {
    const { moveItemToDate } = itineraryHelpers(() => editable);
    const item = { ...sampleItem('item_move', 'person_guest'), expenseId: 'expense_linked' };
    const source = { id: 'day_source', date: '2026-10-15', fromExpense: true, authorId: 'person_alice', items: [item] };
    const trip = { itinerary: [source], expenses: [] };
    const target = moveItemToDate(trip, source, item, '2026-10-17');
    assert.equal(target.fromExpense, true);
    assert.equal(trip.itinerary.includes(source), !editable);
    assert.equal(target.items[0], item);
  }
});

test('shared itinerary and expense fields survive edits and location changes invalidate coordinates', () => {
  const { saveItineraryItem, syncExpenseFromItem, syncItemFromExpense } = itineraryHelpers();
  const trip = { itinerary: sampleDays('person_alice'), expenses: [] };
  const item = trip.itinerary[0].items[0];
  Object.assign(item, { refNo: 'G123', subCategory: '高铁', location: 'Beijing', lat: 39.9, lng: 116.4 });
  syncExpenseFromItem(trip, item, trip.itinerary[0].date);
  const expense = trip.expenses[0];
  expense.note = 'Updated note';
  syncItemFromExpense(trip, expense);
  assert.equal(item.refNo, 'G123');
  assert.equal(item.subCategory, '高铁');
  assert.equal(item.location, 'Beijing');
  assert.equal(item.lat, 39.9);
  saveItineraryItem(trip, 'day_source', item.id, { title: 'Renamed train', location: 'Beijing' });
  assert.equal(item.lat, 39.9);
  saveItineraryItem(trip, 'day_source', item.id, { location: 'Shanghai' });
  assert.equal(item.lat, null);
  assert.equal(item.lng, null);
  assert.equal(expense.location, 'Shanghai');
  assert.equal(expense.lat, null);
  assert.equal(expense.lng, null);
});

test('formal editors can move another author’s item without changing authorship or duplicating IDs', () => {
  const db = ownedDoc('alice');
  const trip = db.trips[0];
  const aliceId = db.access[trip.id].people[0].id;
  const bob = addFormalMember(db, trip.id, 'bob');
  trip.itinerary = sampleDays(aliceId);
  const principal = { userId: 'bob' };
  const visible = project(db, principal);
  const { saveItineraryItem } = itineraryHelpers();
  const targetId = saveItineraryItem(visible.trips[0], 'day_source', 'item_move',
    { startDate: '2026-10-18', time: '10:30' });
  const saved = updateDocument(db, principal, visible);
  const target = saved.trips[0].itinerary.find(day => day.id === targetId);
  assert.equal(target.authorId, bob.id);
  assert.equal(target.items[0].authorId, aliceId);
  assert.equal(target.items[0].id, 'item_move');

  const forged = project(saved, principal);
  forged.trips[0].itinerary.find(day => day.id === targetId).items[0].authorId = bob.id;
  assert.throws(() => updateDocument(saved, principal, forged), AccessDeniedError);
  const duplicate = project(saved, principal);
  duplicate.trips[0].itinerary[0].items.push(structuredClone(target.items[0]));
  assert.throws(() => updateDocument(saved, principal, duplicate), /行程记录 ID 无效或重复/);
});

test('temporary members move their items across shared days while other content remains protected', () => {
  const db = ownedDoc('alice');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  const aliceId = grant.people[0].id;
  const guestId = 'person_temp_guest';
  grant.people.push({ id: guestId, kind: 'temporary', name: 'Guest', ...unusedAppearance(grant.people) });
  syncTripRoster(trip, grant);
  trip.itinerary = sampleDays(aliceId, guestId);
  const principal = { tempTripId: trip.id, tempPersonId: guestId };
  const visible = project(db, principal);
  const { saveItineraryItem } = itineraryHelpers(record => record.authorId === guestId);
  saveItineraryItem(visible.trips[0], 'day_source', 'item_move',
    { startDate: '2026-10-16', time: '12:00' });
  const saved = updateDocument(db, principal, visible);
  assert.equal(saved.trips[0].itinerary[1].items[1].authorId, guestId);
  assert.deepEqual(saved.trips[0].itinerary[0].order, trip.itinerary[0].order);
  assert.deepEqual(saved.trips[0].itinerary[1].order, trip.itinerary[1].order);
  assert.deepEqual(saved.trips[0].itinerary[0].items[0], trip.itinerary[0].items[1]);
  assert.deepEqual(saved.trips[0].itinerary[1].items[0], trip.itinerary[1].items[0]);

  const movedAgain = project(saved, principal);
  const createdDayId = saveItineraryItem(movedAgain.trips[0], 'day_target', 'item_move',
    { startDate: '2026-10-19', time: '08:00' });
  const savedAgain = updateDocument(saved, principal, movedAgain);
  const createdDay = savedAgain.trips[0].itinerary.find(day => day.id === createdDayId);
  assert.equal(createdDay.authorId, guestId);
  assert.equal(createdDay.items[0].authorId, guestId);

  const forbiddenMove = project(savedAgain, principal);
  saveItineraryItem(forbiddenMove.trips[0], 'day_source', 'item_stay',
    { startDate: '2026-10-19', time: '10:00' });
  assert.throws(() => updateDocument(savedAgain, principal, forbiddenMove), AccessDeniedError);
  const changedDay = project(savedAgain, principal);
  changedDay.trips[0].itinerary[0].date = '2026-10-20';
  assert.throws(() => updateDocument(savedAgain, principal, changedDay), AccessDeniedError);
  const forged = project(savedAgain, principal);
  forged.trips[0].itinerary.find(day => day.id === createdDayId).items[0].authorId = aliceId;
  assert.throws(() => updateDocument(savedAgain, principal, forged), AccessDeniedError);
  const duplicate = project(savedAgain, principal);
  duplicate.trips[0].itinerary[0].items.push(structuredClone(createdDay.items[0]));
  assert.throws(() => updateDocument(savedAgain, principal, duplicate), /行程记录 ID 重复/);
});

test('removing an owned linked expense preserves another author’s manual day order', () => {
  const db = ownedDoc('alice');
  const trip = db.trips[0];
  const grant = db.access[trip.id];
  const guestId = 'person_temp_guest';
  grant.people.push({ id: guestId, kind: 'temporary', name: 'Guest', ...unusedAppearance(grant.people) });
  syncTripRoster(trip, grant);
  trip.itinerary = sampleDays(grant.people[0].id, guestId);
  trip.itinerary[0].items[0].expenseId = 'expense_guest';
  trip.expenses.push({ id: 'expense_guest', authorId: guestId, itemId: 'item_move', amount: 30,
    title: 'Train', payer: 'Guest', participants: ['Guest'] });
  const principal = { tempTripId: trip.id, tempPersonId: guestId };
  const visible = project(db, principal);
  itineraryHelpers(record => record.authorId === guestId).removeExpenseRecord(visible.trips[0], 'expense_guest');
  const saved = updateDocument(db, principal, visible).trips[0];
  assert.equal(saved.expenses.length, 0);
  assert.equal(saved.itinerary[0].items.length, 1);
  assert.equal(saved.itinerary[0].items[0].id, 'item_stay');
  assert.deepEqual(saved.itinerary[0].order, trip.itinerary[0].order);
});
