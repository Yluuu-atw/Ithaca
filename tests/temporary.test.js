'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuth } = require('../data/auth');
const { defaultDoc, defaultTrip } = require('../data/schema');
const { claimLegacy, roleFor } = require('../data/access');
const { createSharing } = require('../data/sharing');
const { AccessDeniedError, project, updateDocument } = require('../data/document-policy');

test('temporary identity sees one trip and can only change own records', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/temporary-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const owner = await auth.register('owner', 'owner private password');
    let db = claimLegacy(defaultDoc(), owner.id);
    const tripId = db.trips[0].id;
    db.trips[0].expenses.push({ id: 'owner_expense', title: 'Owner', authorId: db.access[tripId].people[0].id });
    db.trips[0].itinerary.push({ id: 'owner_day', date: '2026-09-25', authorId: db.access[tripId].people[0].id, items: [
      { id: 'owner_item', title: 'Owner item', authorId: db.access[tripId].people[0].id },
    ] });
    const hidden = defaultTrip();
    db.trips.push(hidden);
    db.access[hidden.id] = { ownerId: 'other', members: {}, invites: [], share: null, people: [] };
    const sharing = createSharing(auth, () => db, async fn => { db = fn(db); });
    const created = await sharing.createTemporary(tripId, owner.id, '访客');
    assert.equal(JSON.stringify(db).includes(created.token), false);
    const principal = sharing.resolveTemporary(created.token);
    assert.equal(roleFor(db, principal, tripId), 'temporary');
    assert.equal(roleFor(db, principal, hidden.id), null);
    const view = project(db, principal);
    assert.deepEqual(view.trips.map(trip => trip.id), [tripId]);
    assert.equal(JSON.stringify(view).includes('tokenHash'), false);
    view.trips[0].expenses.push({ id: 'temporary_expense', title: 'Mine' });
    view.trips[0].itinerary[0].items.push({ id: 'temporary_item', title: 'Mine' });
    view.trips[0].expenses.push({ id: 'temporary_receipt_to_remove', title: 'Remove', itemId: 'temporary_entry_to_remove' });
    view.trips[0].itinerary[0].items.push({ id: 'temporary_entry_to_remove', title: 'Remove', expenseId: 'temporary_receipt_to_remove' });
    db = updateDocument(db, principal, view);
    assert.equal(db.trips[0].expenses[1].authorId, principal.tempPersonId);
    assert.equal(db.trips[0].itinerary[0].items[1].authorId, principal.tempPersonId);

    const changed = project(db, principal);
    changed.trips[0].expenses[1].title = 'Edited by me';
    changed.trips[0].itinerary[0].items[1].title = 'Edited by me';
    db = updateDocument(db, principal, changed);
    assert.equal(db.trips[0].expenses[1].title, 'Edited by me');

    changed.trips[0].expenses[0].title = 'Hijacked';
    assert.throws(() => updateDocument(db, principal, changed), AccessDeniedError);
    changed.trips[0].expenses[0].title = 'Owner';
    changed.trips[0].itinerary[0].items[0].title = 'Hijacked';
    assert.throws(() => updateDocument(db, principal, changed), AccessDeniedError);
    changed.trips[0].itinerary[0].items[0].title = 'Owner item';
    changed.trips[0].meta.tripName = 'Hijacked';
    assert.throws(() => updateDocument(db, principal, changed), AccessDeniedError);
    changed.trips[0].meta.tripName = db.trips[0].meta.tripName;
    changed.trips[0].unexpected = 'Hijacked';
    assert.throws(() => updateDocument(db, principal, changed), AccessDeniedError);
    delete changed.trips[0].unexpected;
    changed.trips[0].expenses.shift();
    assert.throws(() => updateDocument(db, principal, changed), AccessDeniedError);
    changed.trips[0].expenses.unshift(db.trips[0].expenses[0]);
    changed.trips.push(hidden);
    assert.throws(() => updateDocument(db, principal, changed), AccessDeniedError);
    changed.trips.pop();
    changed.trips[0].expenses = changed.trips[0].expenses.filter(item => item.id !== 'temporary_receipt_to_remove');
    changed.trips[0].itinerary[0].items = changed.trips[0].itinerary[0].items.filter(item => item.id !== 'temporary_entry_to_remove');
    db = updateDocument(db, principal, changed);
    assert.equal(db.trips[0].expenses.length, 2);
    assert.equal(db.trips[0].itinerary[0].items.length, 2);

    const editor = await auth.register('editor', 'editor private password');
    await sharing.setMember(tripId, owner.id, editor.username, 'editor');
    const editorView = project(db, { userId: editor.id, username: editor.username });
    editorView.trips[0].itinerary[0].items[1].title = 'Edited by formal member';
    db = updateDocument(db, { userId: editor.id, username: editor.username }, editorView);
    assert.equal(db.trips[0].itinerary[0].items[1].title, 'Edited by formal member');
    assert.equal(db.trips[0].itinerary[0].items[1].authorId, principal.tempPersonId);

    db.access[tripId].people = db.access[tripId].people.filter(person => person.id !== principal.tempPersonId);
    assert.equal(sharing.resolveTemporary(created.token), null);
    assert.equal(roleFor(db, principal, tripId), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('temporary member can remove the last own expense from another member’s generated day', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/temporary-generated-day-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const owner = await auth.register('owner', 'owner private password');
    let db = claimLegacy(defaultDoc(), owner.id);
    const tripId = db.trips[0].id;
    const ownerPersonId = db.access[tripId].people[0].id;
    db.trips[0].itinerary.push({
      id: 'owner_generated_day', date: '2026-09-25', fromExpense: true,
      authorId: ownerPersonId, items: [],
    });

    const sharing = createSharing(auth, () => db, async fn => { db = fn(db); });
    const created = await sharing.createTemporary(tripId, owner.id, '访客');
    const principal = sharing.resolveTemporary(created.token);
    const added = project(db, principal);
    added.trips[0].expenses.push({
      id: 'temporary_expense', title: 'Mine', itemId: 'temporary_item',
    });
    added.trips[0].itinerary[0].items.push({
      id: 'temporary_item', title: 'Mine', expenseId: 'temporary_expense',
    });
    db = updateDocument(db, principal, added);

    const removingDay = project(db, principal);
    removingDay.trips[0].expenses = [];
    removingDay.trips[0].itinerary = [];
    assert.throws(() => updateDocument(db, principal, removingDay), AccessDeniedError);

    const removed = project(db, principal);
    removed.trips[0].expenses = [];
    removed.trips[0].itinerary[0].items = [];
    db = updateDocument(db, principal, removed);
    assert.equal(db.trips[0].expenses.length, 0);
    assert.equal(db.trips[0].itinerary.length, 1);
    assert.equal(db.trips[0].itinerary[0].id, 'owner_generated_day');
    assert.equal(db.trips[0].itinerary[0].authorId, ownerPersonId);
    assert.deepEqual(db.trips[0].itinerary[0].items, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replacing a member transfers references and revokes the old link', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/replacement-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const owner = await auth.register('owner', 'owner private password');
    const formal = await auth.register('formal', 'formal private password');
    let db = claimLegacy(defaultDoc(), owner.id);
    const tripId = db.trips[0].id;
    const sharing = createSharing(auth, () => db, async fn => { db = fn(db); });
    const temporary = await sharing.createTemporary(tripId, owner.id, '旅伴');
    db.trips[0].expenses.push({ id: 'exp_1', payer: '旅伴', participants: ['旅伴', '我'], authorId: temporary.person.id });
    await sharing.replacePerson(tripId, owner.id, temporary.person.id, { kind: 'formal', username: formal.username });
    assert.equal(sharing.resolveTemporary(temporary.token), null);
    assert.equal(roleFor(db, { userId: formal.id }, tripId), 'editor');
    assert.equal(db.trips[0].expenses[0].payer, formal.username);
    assert.deepEqual(db.trips[0].expenses[0].participants, [formal.username, '我']);
    assert.equal(db.trips[0].expenses[0].authorId, `person_user_${formal.id}`);
    await assert.rejects(sharing.replacePerson(tripId, owner.id, db.access[tripId].people[1].id, { kind: 'formal', username: owner.username }), /不能替换旅行所有者|这名成员已在旅行中/);

    const replacement = await sharing.replacePerson(tripId, owner.id, `person_user_${formal.id}`, { kind: 'temporary', name: '新旅伴' });
    assert.equal(roleFor(db, { userId: formal.id }, tripId), null);
    assert.equal(sharing.resolveTemporary(replacement.token).tempPersonId, replacement.person.id);
    assert.equal(db.trips[0].expenses[0].payer, '新旅伴');
    assert.equal(db.trips[0].expenses[0].authorId, replacement.person.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
