'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('new expense uses local current minute and edits preserve stored time', () => {
  class LocalDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [2026, 8, 26, 17, 42, 33]));
    }
  }
  const context = {
    window: {}, Date: LocalDate,
    Store: { getState: () => ({ meta: { members: [] } }), getIdentity: () => 0, CONST: { expenseCategories: [], expenseToItemCategory: {}, subCategories: {}, currencySymbol: {} } },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  assert.match(context.window.Render.formExpense([], null), /name="time" value="2026-09-26T17:42"/);
  assert.match(context.window.Render.formExpense([], { id: 'e1', date: '2026-08-05', time: '08:15' }), /name="time" value="2026-08-05T08:15"/);
});

test('daily expense matrix uses trip days and amount-only member columns', () => {
  const context = {
    window: {},
    Store: {
      getIdentity: () => null,
      getRoster: () => [],
      getMySettlement: () => null,
      CONST: { currencySymbol: { CNY: '¥' } },
    },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const state = {
    meta: { members: ['Alice', 'Bob'], avatars: ['😎', '🐱'], colors: ['#c4714b', '#7d94a8'], currency: 'CNY', startDate: '2026-08-01' },
    itinerary: [{ date: '2026-08-01' }, { date: '2026-08-03' }],
    expenses: [{ id: 'e1', date: '2026-08-03', time: '12:00', payer: 'Alice', amount: 26, title: 'Lunch' }],
  };
  const html = context.window.Render.renderPage(state, 'bookings');
  const matrix = html.match(/<div class="exp-mx-scroll"[\s\S]*?<\/table>/)[0];
  assert.match(matrix, /第 1 天/);
  assert.match(matrix, /第 3 天/);
  assert.match(matrix, /总支出/);
  assert.match(matrix, /¥26/);
  assert.doesNotMatch(matrix, /2026-08-03|笔|exp-mx-toggle|exp-mx-detail/);
});

test('ledger shows only current identity transfer actions when a personal plan exists', () => {
  const context = {
    window: {},
    Store: {
      getMySettlement: () => ({ advancedMinor: 0, owedMinor: 500, balanceMinor: -500,
        transfers: [{ key: 'out:person_a:500', direction: 'out', otherName: 'Alice', amountMinor: 500, confirmed: false }] }),
      CONST: { currencySymbol: { CNY: '¥' } },
    },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const html = context.window.Render.renderPage({ id: 'trip_1', meta: { members: [], currency: 'CNY' }, expenses: [], itinerary: [] }, 'bookings');
  assert.match(html, /我的结算/);
  assert.match(html, /我需要转给/);
  assert.match(html, /Alice/);
  assert.match(html, /data-action="settle-confirm"/);
  assert.match(html, /标记已转/);
  assert.match(html, /不会自动转账/);
});

test('aggregate settlement uses server cents so it agrees with personal transfers', () => {
  const context = {
    window: {},
    Store: {
      getMySettlement: () => null,
      getGroupSettlement: () => ({ advanced: { Alice: 1000, Bob: 0 }, shouldPay: { Alice: 501, Bob: 499 }, balance: { Alice: 499, Bob: -499 } }),
      getIdentity: () => null,
      getRoster: () => [],
      CONST: { currencySymbol: { CNY: '¥' } },
    },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const html = context.window.Render.renderPage({ id: 'trip_1', meta: { members: ['Alice', 'Bob'], currency: 'CNY' }, expenses: [], itinerary: [] }, 'bookings');
  assert.match(html, /应收 ¥4\.99/);
  assert.match(html, /应补 ¥4\.99/);
});
