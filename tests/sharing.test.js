'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuth } = require('../data/auth');
const { defaultDoc } = require('../data/schema');
const { claimLegacy, roleFor } = require('../data/access');
const { project } = require('../data/document-policy');
const { createSharing } = require('../data/sharing');

test('owner grants roles, redeems one-use invites and revokes anonymous access', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/sharing-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const owner = await auth.register('owner', 'owner private password');
    const editor = await auth.register('editor', 'editor private password');
    const viewer = await auth.register('viewer', 'viewer private password');
    let db = claimLegacy(defaultDoc(), owner.id);
    const tripId = db.trips[0].id;
    const sharing = createSharing(auth, () => db, async fn => { db = fn(db); });

    await sharing.setMember(tripId, owner.id, 'editor', 'editor');
    assert.equal(roleFor(db, { userId: editor.id }, tripId), 'editor');
    assert.equal(db.access[tripId].people.find(person => person.userId === editor.id).name, 'editor');
    assert.equal(db.trips[0].meta.members.includes('editor'), true);
    await sharing.setMember(tripId, owner.id, 'editor', 'viewer');
    assert.equal(db.access[tripId].people.filter(person => person.userId === editor.id).length, 1);
    await sharing.removeMember(tripId, owner.id, editor.id);
    assert.equal(roleFor(db, { userId: editor.id }, tripId), null);
    await assert.rejects(sharing.setMember(tripId, viewer.id, 'editor', 'editor'), /只有旅行所有者/);

    const invitation = await sharing.createInvite(tripId, owner.id, 'viewer');
    assert.equal(JSON.stringify(db).includes(invitation.token), false);
    assert.equal((await sharing.redeem(invitation.token, viewer.id)).tripId, tripId);
    assert.equal(roleFor(db, { userId: viewer.id }, tripId), 'viewer');
    await assert.rejects(sharing.redeem(invitation.token, editor.id), /无效或已使用/);

    const link = await sharing.createShare(tripId, owner.id);
    assert.equal(JSON.stringify(db).includes(link.token), false);
    const guest = sharing.resolve(link.token);
    assert.deepEqual(guest, { shareTripId: tripId });
    assert.equal(project(db, guest).trips.length, 1);
    await sharing.revokeShare(tripId, owner.id);
    assert.equal(sharing.resolve(link.token), null);
    const replacement = await sharing.createShare(tripId, owner.id);
    assert.equal(sharing.resolve(link.token), null);
    assert.deepEqual(sharing.resolve(replacement.token), { shareTripId: tripId });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trip profiles inherit account names and reserve appearances per trip', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/trip-profile-'));
  try {
    const auth = createAuth(path.join(dir, 'auth.json'), path.join(dir, 'setup-token'));
    const owner = await auth.register('owner', 'owner private password');
    const viewer = await auth.register('viewer', 'viewer private password');
    let db = claimLegacy(defaultDoc(), owner.id);
    const tripId = db.trips[0].id;
    const sharing = createSharing(auth, () => db, async fn => { db = fn(db); });
    const originalName = db.access[tripId].people[0].name;
    const originalAvatar = db.access[tripId].people[0].avatar;
    const originalColor = db.access[tripId].people[0].color;
    db.trips[0].expenses.push({ id: 'expense_1', payer: originalName, participants: [originalName] });

    assert.equal(project(db, { userId: owner.id }, auth.store.get().users).rosters[tripId][0].displayName, 'owner');
    await auth.updateDisplayName(owner.id, 'Account Name');
    assert.equal(project(db, { userId: owner.id }, auth.store.get().users).rosters[tripId][0].displayName, 'Account Name');
    await sharing.setMember(tripId, owner.id, viewer.username, 'viewer');
    const people = db.access[tripId].people;
    const viewerPerson = people.find(person => person.userId === viewer.id);
    assert.equal(people.filter(person => person.avatar === viewerPerson.avatar).length, 1);
    assert.equal(people.filter(person => person.color === viewerPerson.color).length, 1);

    const ownerPrincipal = { userId: owner.id };
    await sharing.updateProfile(tripId, ownerPrincipal, { tripNickname: ' Trip Name ', avatar: originalAvatar, color: originalColor });
    assert.equal(project(db, ownerPrincipal, auth.store.get().users).rosters[tripId][0].displayName, 'Trip Name');
    assert.equal(db.trips[0].expenses[0].payer, originalName);
    assert.equal(db.trips[0].meta.members[0], originalName);
    await assert.rejects(sharing.updateProfile(tripId, { userId: viewer.id }, {
      tripNickname: 'Visitor', avatar: originalAvatar, color: viewerPerson.color,
    }), /头像已被其他成员使用/);
    await assert.rejects(sharing.updateProfile(tripId, { userId: viewer.id }, {
      tripNickname: 'Visitor', avatar: viewerPerson.avatar, color: originalColor,
    }), /颜色已被其他成员使用/);
    await assert.rejects(sharing.updateProfile(tripId, { shareTripId: tripId }, {
      tripNickname: 'Guest', avatar: originalAvatar, color: originalColor,
    }), /只有旅行成员/);

    const temporary = await sharing.createTemporary(tripId, owner.id, 'Guest');
    assert.equal(new Set(db.access[tripId].people.map(person => person.avatar)).size, people.length + 1);
    assert.equal(new Set(db.access[tripId].people.map(person => person.color)).size, people.length + 1);
    await sharing.updateProfile(tripId, sharing.resolveTemporary(temporary.token), {
      tripNickname: 'Day Guest', avatar: temporary.person.avatar, color: temporary.person.color,
    });
    assert.equal(project(db, sharing.resolveTemporary(temporary.token)).rosters[tripId].find(person => person.id === temporary.person.id).displayName, 'Day Guest');
    await sharing.updateProfile(tripId, ownerPrincipal, { tripNickname: '', avatar: originalAvatar, color: originalColor });
    assert.equal(project(db, ownerPrincipal, auth.store.get().users).rosters[tripId][0].displayName, 'Account Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
