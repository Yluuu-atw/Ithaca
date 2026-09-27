'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultDoc } = require('../data/schema');
const { claimLegacy } = require('../data/access');
const { calculateTransfers } = require('../data/settlement');
const { migrateLegacyBookings } = require('../data/booking-migration');

function fixture() {
  const doc = claimLegacy(defaultDoc(), 'owner');
  const trip = doc.trips[0];
  const authorId = doc.access[trip.id].people[0].id;
  return { doc, trip, authorId };
}

test('a unique paid reservation attaches to an existing expense once', () => {
  const { doc, trip, authorId } = fixture();
  trip.expenses.push({
    id: 'expense_rail', title: 'Rail fare', date: '2026-09-01', category: '交通',
    amount: 169.5, payer: '我', participants: ['我', '她'], authorId,
    images: ['/uploads/bill.webp'],
  });
  trip.bookings.push({
    id: 'booking_rail', title: 'Train ticket', type: 'train', status: '已订',
    date: '2026-09-01', price: 169.5, payer: '我', authorId,
    refNo: 'R123', images: ['/uploads/ticket.webp'],
  });
  const before = structuredClone(doc);

  const first = migrateLegacyBookings(doc);
  const migrated = first.doc.trips[0];
  assert.equal(first.changed, true);
  assert.deepEqual(doc, before);
  assert.equal(migrated.expenses.length, 1);
  assert.equal(migrated.expenses[0].id, 'expense_rail');
  assert.equal(migrated.expenses[0].amount, 169.5);
  assert.equal(migrated.expenses[0].authorId, authorId);
  assert.deepEqual(migrated.expenses[0].images, ['/uploads/bill.webp', '/uploads/ticket.webp']);
  assert.equal(migrated.expenses[0].receipt.legacyBookingId, 'booking_rail');
  assert.equal(migrated.expenses[0].receipt.images, undefined);
  assert.deepEqual(migrated.bookings, []);

  const second = migrateLegacyBookings(first.doc);
  assert.equal(second.changed, false);
  assert.equal(second.doc.trips[0].expenses.length, 1);
  assert.deepEqual(second.doc.trips[0].expenses, migrated.expenses);
  assert.deepEqual(second.doc.trips[0].bookings, []);
  assert.deepEqual(calculateTransfers(migrated, first.doc.access[trip.id]).transfers.map(x => x.amountMinor), [8475]);
});

test('pending and unmatched booked reservations are reference-only ledger entries', () => {
  const { doc, trip, authorId } = fixture();
  trip.expenses.push({
    id: 'expense_paid', title: 'Dinner', date: '2026-09-02', category: '餐饮',
    amount: 40, payer: '我', participants: ['我', '她'], authorId,
  });
  trip.bookings.push(
    { id: 'booking_pending', title: 'Hotel quote', type: 'hotel', status: '待订', date: '2026-09-03', price: 500, payer: '我', authorId },
    { id: 'booking_unmatched', title: 'Booked train', type: 'train', status: '已订', date: '2026-09-04', price: 80, payer: '我', authorId },
  );

  const first = migrateLegacyBookings(doc);
  const migrated = first.doc.trips[0];
  const byBooking = new Map(migrated.expenses.filter(x => x.receipt && x.receipt.legacyBookingId)
    .map(x => [x.receipt.legacyBookingId, x]));
  assert.equal(migrated.expenses.length, 3);
  assert.deepEqual([...byBooking.keys()].sort(), ['booking_pending', 'booking_unmatched']);
  for (const booking of migrated.bookings) {
    const expense = byBooking.get(booking.id);
    assert.equal(expense.amount, 0);
    assert.equal(expense.receipt.price, booking.price);
    assert.equal(expense.authorId, authorId);
    assert.equal(expense.receipt.legacyBookingId, booking.id);
  }
  assert.deepEqual(migrated.bookings, []);
  const plan = calculateTransfers(migrated, first.doc.access[trip.id]);
  assert.deepEqual(plan.transfers.map(x => x.amountMinor), [2000]);
  assert.equal(migrateLegacyBookings(first.doc).doc.trips[0].expenses.length, 3);
});

test('ambiguous matching never chooses an existing charge or adds another', () => {
  const { doc, trip, authorId } = fixture();
  for (const id of ['expense_a', 'expense_b']) {
    trip.expenses.push({ id, title: 'Rail fare', date: '2026-09-05', category: '交通',
      amount: 60, payer: '我', participants: ['我', '她'], authorId });
  }
  trip.bookings.push({ id: 'booking_ambiguous', title: 'Train ticket', type: 'train', status: '已订',
    date: '2026-09-05', price: 60, payer: '我', authorId });

  const migrated = migrateLegacyBookings(doc).doc.trips[0];
  assert.equal(migrated.expenses.length, 3);
  assert.equal(migrated.expenses.find(x => x.receipt && x.receipt.legacyBookingId === 'booking_ambiguous').amount, 0);
  assert.equal(migrated.expenses.filter(x => Number(x.amount) > 0).length, 2);
  assert.deepEqual(migrated.bookings, []);
});

test('a deleted migrated expense is not recreated by later migration checks', () => {
  const { doc, trip, authorId } = fixture();
  trip.bookings.push({ id: 'booking_old', title: 'Old reservation', type: 'hotel',
    status: '待订', date: '2026-09-06', price: 120, payer: '我', authorId });
  const first = migrateLegacyBookings(doc);
  const expenseId = first.doc.trips[0].expenses[0].id;
  first.doc.trips[0].expenses = first.doc.trips[0].expenses.filter(x => x.id !== expenseId);

  const second = migrateLegacyBookings(first.doc);
  assert.equal(second.changed, false);
  assert.equal(second.doc.trips[0].expenses.length, 0);
  assert.deepEqual(second.doc.trips[0].bookings, []);
});
