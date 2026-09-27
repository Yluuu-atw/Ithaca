'use strict';

const crypto = require('node:crypto');

const BOOKING_CATEGORIES = {
  flight: '交通', train: '交通', bus: '交通', hotel: '住宿', other: '其他',
};
const CONFIRMED_STATUSES = new Set(['已订', '已完成']);

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function legacyExpenseId(tripId, bookingId, occupied) {
  const digest = crypto.createHash('sha256').update(`${tripId}:${bookingId}`).digest('hex').slice(0, 20);
  const base = `exp_legacy_${digest}`;
  let id = base;
  let suffix = 2;
  while (occupied.has(id)) id = `${base}_${suffix++}`;
  occupied.add(id);
  return id;
}

function matchingExpenses(expenses, booking) {
  if (!CONFIRMED_STATUSES.has(booking.status) || !cents(booking.price)) return [];
  const category = BOOKING_CATEGORIES[booking.type] || BOOKING_CATEGORIES.other;
  const authorId = typeof booking.authorId === 'string' && booking.authorId;
  if (!authorId || !booking.date || !booking.payer) return [];
  return expenses.filter(expense => expense && !expense.receipt
    && expense.date === booking.date
    && cents(expense.amount) === cents(booking.price)
    && expense.payer === booking.payer
    && expense.category === category
    && expense.authorId === authorId);
}

function migrateLegacyBookings(source) {
  if (!source || !Array.isArray(source.trips)) return { doc: source, changed: false, stats: { linked: 0, referenceOnly: 0 } };
  if (!source.trips.some(trip => Array.isArray(trip && trip.bookings) && trip.bookings.length)) {
    return { doc: source, changed: false, stats: { linked: 0, referenceOnly: 0 } };
  }
  const doc = structuredClone(source);
  const stats = { linked: 0, referenceOnly: 0 };
  let changed = false;

  for (const trip of doc.trips) {
    if (!trip || !Array.isArray(trip.bookings) || !trip.bookings.length) continue;
    if (!Array.isArray(trip.expenses)) trip.expenses = [];
    const remaining = [];
    const occupied = new Set(trip.expenses.map(expense => expense && expense.id).filter(Boolean));
    const receipts = new Map();
    for (const expense of trip.expenses) {
      const bookingId = expense && expense.receipt && expense.receipt.legacyBookingId;
      if (!bookingId) continue;
      if (receipts.has(bookingId)) throw new Error(`Duplicate migrated booking reference in trip ${trip.id}`);
      receipts.set(bookingId, expense.id);
    }

    for (const [index, booking] of trip.bookings.entries()) {
      if (!booking || typeof booking !== 'object' || Array.isArray(booking)) {
        remaining.push(booking);
        continue;
      }
      // Once the reservation is represented in the ledger, discard its parallel record.
      // A previously deleted ledger entry must stay deleted on subsequent starts.
      if (booking.migratedExpenseId) {
        changed = true;
        continue;
      }
      if (!booking.id) booking.id = `bk_legacy_${crypto.createHash('sha256').update(`${trip.id}:${index}`).digest('hex').slice(0, 20)}`;
      const existingId = receipts.get(booking.id);
      if (existingId) {
        changed = true;
        continue;
      }

      const original = structuredClone(booking);
      const candidates = matchingExpenses(trip.expenses, booking);
      const receipt = { ...original, legacyBookingId: booking.id };
      const bookingImages = Array.isArray(booking.images) ? structuredClone(booking.images) : [];
      delete receipt.images;
      if (candidates.length === 1) {
        const expense = candidates[0];
        expense.receipt = receipt;
        expense.images = [...new Set([...(Array.isArray(expense.images) ? expense.images : []), ...bookingImages])];
        receipts.set(booking.id, expense.id);
        stats.linked++;
      } else {
        if (CONFIRMED_STATUSES.has(booking.status)) receipt.needsReview = true;
        const id = legacyExpenseId(trip.id, booking.id, occupied);
        trip.expenses.push({
          id,
          date: booking.date || '',
          time: booking.time || '',
          title: booking.title || booking.refNo || '票据',
          amount: 0,
          category: BOOKING_CATEGORIES[booking.type] || BOOKING_CATEGORIES.other,
          payer: booking.payer || '',
          participants: booking.payer ? [booking.payer] : [],
          note: booking.note || '',
          images: bookingImages,
          authorId: booking.authorId,
          receipt,
        });
        receipts.set(booking.id, id);
        stats.referenceOnly++;
      }
      changed = true;
    }
    trip.bookings = remaining;
  }

  return { doc, changed, stats };
}

module.exports = { migrateLegacyBookings };
