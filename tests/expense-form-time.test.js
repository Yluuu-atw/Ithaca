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
  assert.match(context.window.Render.formExpense([], { id: 'e2', date: '', time: '' }), /name="time" value=""/);
  const existing = context.window.Render.formExpense([], { id: 'e3', location: 'Old Town', lat: 31.22, lng: 121.48 });
  assert.match(existing, /name="location"[^>]*value="Old Town"/);
  assert.match(existing, /name="lat" value="31\.22"/);
  assert.match(existing, /name="lng" value="121\.48"/);
  assert.match(existing, /data-action="expense-location-gps"/);
  assert.match(existing, /data-action="expense-location-map"/);
  assert.match(existing, /data-action="expense-location-search"/);
  assert.doesNotMatch(existing, /data-action="expense-del"/);
});

test('tickets filter the same ledger and use the expense entry flow', () => {
  const context = {
    window: {},
    Store: {
      getState: () => ({ meta: { members: [] } }),
      getIdentity: () => null,
      getRoster: () => [],
      getMySettlement: () => null,
      getGroupSettlement: () => null,
      canEditRecord: () => false,
      CONST: {
        expenseCategories: ['餐饮', '交通', '住宿', '门票', '购物', '娱乐', '其他'],
        bookingTypes: [{ id: 'train', label: '火车票', icon: '🚄' }],
        bookingStatus: ['待订', '已订'],
        currencySymbol: { CNY: '¥' },
      },
    },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const state = { id: 'trip_1', meta: { members: [], currency: 'CNY' }, expenses: [], itinerary: [] };
  const page = context.window.Render.renderPage(state, 'bookings');
  assert.match(page, /data-action="expense-image-start"/);
  assert.match(page, /data-action="expense-add"/);
  assert.match(page, /data-action="ledger-filter" data-filter="all"/);
  assert.match(page, /data-action="ledger-filter" data-filter="receipt"/);
  assert.doesNotMatch(page, /data-action="booking-add"|class="booking-section"/);
  for (const form of [context.window.Render.formExpense([], null), context.window.Render.formExpense([], null, { receipt: true })]) {
    assert.match(form, /让我看看/);
    assert.match(form, /vendor\/fluent-emoji\/1f4f7\.png/);
    assert.match(form, /name="imageFiles"/);
  }
  const receiptForm = context.window.Render.formExpense([], null, { receipt: true });
  assert.match(receiptForm, /name="receiptEnabled" value="1" checked/);
  assert.match(receiptForm, /name="receiptRefNo"/);
  assert.match(receiptForm, /name="receiptDate"/);
  assert.match(receiptForm, /name="receiptTime"/);
  assert.match(receiptForm, /<option selected>待订<\/option>/);
  assert.match(receiptForm, /<option selected>其他<\/option>/);
  assert.match(receiptForm, /参考价不计入支出/);
  assert.match(receiptForm, /未付款时花费填 0/);
  assert.doesNotMatch(receiptForm, /data-form="booking"/);

  const expense = { id: 'expense_1', title: '北京丰台', date: '2026-09-27', time: '12:34', amount: 42, category: '交通', itemId: 'linked_item' };
  const expenseState = { ...state, expenses: [expense], itinerary: [{ date: expense.date, items: [{ id: 'linked_item' }] }] };
  const ledger = context.window.Render.renderPage(expenseState, 'bookings');
  assert.match(ledger, /data-action="expense-detail" data-id="expense_1"/);
  assert.doesNotMatch(ledger, /data-action="expense-del"/);
  const readOnly = context.window.Render.expenseDetail(expenseState, 'expense_1');
  assert.match(readOnly, /北京丰台/);
  assert.match(readOnly, /2026\.09\.27 · 12:34/);
  assert.doesNotMatch(readOnly, /<input|data-action="expense-edit"|data-action="expense-del"/);
  context.Store.canEditRecord = () => true;
  const editable = context.window.Render.expenseDetail(expenseState, 'expense_1');
  assert.match(editable, /data-action="expense-edit"/);
  assert.match(editable, /data-action="expense-del"/);
  context.Store.canEditRecord = record => record.id !== 'linked_item';
  assert.doesNotMatch(context.window.Render.expenseDetail(expenseState, 'expense_1'), /data-action="expense-edit"|data-action="expense-del"/);

  const mergedTicket = { ...expense, images: ['/uploads/bill.webp'], receipt: { type: 'train', images: ['/uploads/ticket.webp'] } };
  const mergedDetail = context.window.Render.expenseDetail({ ...expenseState, expenses: [mergedTicket] }, 'expense_1');
  assert.match(mergedDetail, /\/uploads\/bill\.webp/);
  assert.match(mergedDetail, /\/uploads\/ticket\.webp/);
  const mergedForm = context.window.Render.formExpense([], mergedTicket);
  assert.match(mergedForm, /data-existing-url="\/uploads\/ticket\.webp"/);
  assert.equal((mergedForm.match(/data-existing-url="\/uploads\/ticket\.webp"/g) || []).length, 1);
  assert.match(mergedForm, /data-action="entry-image-remove"/);
  assert.doesNotMatch(mergedForm, /name="receiptEnabled"[^>]*disabled/);
});

test('booking recognition maps to receipt fields without creating an expense amount', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8')
    .replace('return { init };', 'return { init, testHelpers: { entryRecognitionKind, bookingDraftToExpenseDraft, applyImageDraft, syncExpenseFromItem, retainedReceiptImages } };')
    .replace("document.addEventListener('DOMContentLoaded', App.init);", '');
  const context = {
    window: {}, document: { addEventListener() {} },
    Store: { CONST: { itemToExpenseCategory: {} } },
  };
  vm.runInNewContext(source, context);
  const { entryRecognitionKind, bookingDraftToExpenseDraft, applyImageDraft, syncExpenseFromItem, retainedReceiptImages } = context.window.App.testHelpers;
  const receiptForm = { dataset: { form: 'expense' }, elements: { namedItem: () => ({ checked: true }) } };
  assert.equal(entryRecognitionKind(receiptForm), 'booking');
  assert.equal(entryRecognitionKind({ ...receiptForm, elements: { namedItem: () => ({ checked: false }) } }), 'expense');
  const mapped = JSON.parse(JSON.stringify(bookingDraftToExpenseDraft({
    type: 'train', status: '待订', title: 'Train G123', date: '2026-10-03', time: '08:30',
    from: '北京', to: '上海', carrier: 'G123', price: 123.45, amount: 123.45,
  })));
  assert.deepEqual(mapped, {
    title: 'Train G123', receiptType: 'train', receiptStatus: '待订', receiptDate: '2026-10-03',
    receiptTime: '08:30', receiptFrom: '北京', receiptTo: '上海', receiptCarrier: 'G123',
    receiptPrice: 123.45, category: '交通',
  });
  assert.equal(Object.hasOwn(mapped, 'amount'), false);
  const controls = new Map([
    ['time', { value: '2026-09-01T12:34', tagName: 'INPUT' }],
    ['amount', { value: '0', tagName: 'INPUT' }],
    ['receiptDate', { value: '', tagName: 'INPUT' }],
    ['receiptTime', { value: '', tagName: 'INPUT' }],
    ['receiptPrice', { value: '', tagName: 'INPUT' }],
  ]);
  applyImageDraft({ dataset: { form: 'expense' }, _entryTouched: new Set(), _entryEditing: true,
    elements: { namedItem: name => controls.get(name) }, querySelector: () => null }, mapped);
  assert.equal(controls.get('time').value, '2026-09-01T12:34');
  assert.equal(controls.get('amount').value, '0');
  assert.equal(controls.get('receiptDate').value, '2026-10-03');
  assert.equal(controls.get('receiptTime').value, '08:30');
  assert.equal(controls.get('receiptPrice').value, '123.45');

  const ticket = { id: 'exp_ticket', itemId: 'item_ticket', amount: 123.45, images: ['/uploads/receipt.webp'],
    receipt: { images: ['/uploads/receipt.webp'], price: 123.45 } };
  const imageOnly = { id: 'exp_image', itemId: 'item_image', amount: 20, images: ['/uploads/photo.webp'] };
  const plain = { id: 'exp_plain', itemId: 'item_plain', amount: 20 };
  const trip = { expenses: [ticket, imageOnly, plain] };
  for (const id of ['item_ticket', 'item_image', 'item_plain']) {
    syncExpenseFromItem(trip, { id, amount: 0, title: 'Updated itinerary item' }, '2026-10-03');
  }
  assert.deepEqual(trip.expenses.map(entry => entry.id), ['exp_ticket', 'exp_image']);
  assert.equal(ticket.amount, 0);
  assert.equal(ticket.title, 'Updated itinerary item');
  assert.equal(ticket.date, '2026-10-03');
  assert.equal(imageOnly.amount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(retainedReceiptImages(ticket.receipt, []))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(retainedReceiptImages(ticket.receipt, ['/uploads/receipt.webp']))), ['/uploads/receipt.webp']);
});

test('receipt filter applies to daily spending and bill rows without counting reference prices', () => {
  const context = {
    window: {},
    Store: {
      getIdentity: () => null,
      getRoster: () => [],
      getMySettlement: () => null,
      getGroupSettlement: () => null,
      CONST: { currencySymbol: { CNY: '¥' }, bookingTypes: [], bookingStatus: [] },
    },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const state = {
    meta: { members: ['Alice'], currency: 'CNY', startDate: '2026-10-01' },
    itinerary: [{ date: '2026-10-01' }],
    expenses: [
      { id: 'plain', date: '2026-10-01', title: 'Plain', payer: 'Alice', amount: 10 },
      { id: 'ticket', date: '2026-10-01', title: 'Ticket', payer: 'Alice', amount: 20, receipt: { price: 200 } },
      { id: 'photo', date: '2026-10-01', title: 'Photo', payer: 'Alice', amount: 30, images: ['/uploads/photo.webp'] },
      { id: 'reference', date: '2026-10-01', title: 'Reference', payer: 'Alice', amount: 0, receipt: { price: 900 } },
    ],
  };
  const all = context.window.Render.renderPage(state, 'bookings', { ledgerFilter: 'all' });
  const receipts = context.window.Render.renderPage(state, 'bookings', { ledgerFilter: 'receipt' });
  assert.match(all, /共 4 笔 · 支出 ¥60/);
  assert.match(receipts, /共 3 笔 · 支出 ¥50/);
  assert.match(receipts, /Ticket/);
  assert.match(receipts, /Photo/);
  assert.match(receipts, /Reference/);
  assert.match(receipts, /参考价 ¥900/);
  assert.doesNotMatch(receipts, /Plain/);
  assert.match(receipts, /exp-mx-total">¥50/);
  assert.match(receipts, /结算按全部账单计算/);
});

test('overview spending agrees with the ledger when an order also has a receipt', () => {
  const context = {
    window: {},
    AuthUI: { user: null },
    Store: {
      getIdentity: () => null,
      getRoster: () => [],
      canManageTrip: () => false,
      CONST: { currencySymbol: { CNY: '¥' } },
    },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const state = {
    meta: { tripName: 'Test', members: [], currency: 'CNY' },
    itinerary: [{ date: '2026-10-01', items: [] }],
    expenses: [{ date: '2026-10-01', amount: 123.45, category: '交通', participants: [], receipt: { price: 123.45, status: '已订' } }],
    checklist: [], wishlist: [], photos: [], places: [], guides: [], tracks: [],
  };
  const html = context.window.Render.renderPage(state, 'overview');
  assert.match(html, /<div class="overview-total"><strong>¥123\.45<\/strong><span>总花费 · 已记录 1 笔<\/span><\/div>/);
  assert.doesNotMatch(html, /¥246\.9/);
  assert.match(html, /已记录 1 笔/);
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

test('personal settlement shows exact bill shares across ledger filters and opens existing bill details', () => {
  const context = {
    window: {},
    Store: {
      getIdentity: () => null,
      getRoster: () => [],
      getMySettlement: () => ({ advancedMinor: 1001, owedMinor: 334, balanceMinor: 667,
        transfers: [{ key: 'in:person_b:667', direction: 'in', otherName: 'Bob', amountMinor: 667, confirmed: false }],
        expenseShares: [{ expenseId: 'meal', amountMinor: 1001, advancedMinor: 1001, shareMinor: 334 }],
      }),
      canEditRecord: () => false,
      CONST: { currencySymbol: { CNY: '¥' } },
    },
    Theme: { DARK_BG: '#202020' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const state = {
    id: 'trip_1',
    meta: { members: ['Alice', 'Bob'], currency: 'CNY', startDate: '2026-10-01' },
    expenses: [{ id: 'meal', title: '晚餐', date: '2026-10-01', time: '19:30', category: '餐饮', payer: 'Alice', amount: 10.01 }],
    itinerary: [],
  };
  const closed = context.window.Render.renderPage(state, 'bookings');
  assert.match(closed, /data-action="settlement-details-toggle"[^>]*aria-expanded="false"/);
  assert.match(closed, /id="settlementDetails" hidden/);

  const open = context.window.Render.renderPage(state, 'bookings', { ledgerFilter: 'receipt', settlementDetailsOpen: true });
  assert.match(open, /我需要收取/);
  assert.match(open, /data-action="settlement-details-toggle"[^>]*aria-expanded="true"/);
  assert.match(open, /data-action="expense-detail" data-id="meal"/);
  assert.match(open, /晚餐/);
  assert.match(open, /我分摊 <strong>¥3\.34<\/strong> <small>33\.4%<\/small>/);
  assert.match(open, /我垫付 ¥10\.01/);
  assert.match(open, /互相垫付抵消后的净额/);
  assert.match(open, /还没有带票据的账单/);
  assert.match(context.window.Render.expenseDetail(state, 'meal'), /晚餐/);
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
