'use strict';

const crypto = require('node:crypto');
const { canManage } = require('./access');
const { AccessDeniedError } = require('./document-policy');
const { usernameKey } = require('./auth');
const { formalPerson, personForUser, ensureRoster, syncTripRoster, publicRoster, uniquePerson, hasPersonReferences } = require('./people');

function token() { return crypto.randomBytes(32).toString('base64url'); }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }

function createSharing(auth, getDb, commit) {
  function owner(tripId, userId) {
    if (!canManage(getDb(), { userId }, tripId)) throw new AccessDeniedError('只有旅行所有者可以管理分享');
  }

  function details(tripId, userId) {
    owner(tripId, userId);
    const grant = getDb().access[tripId];
    const users = auth.store.get().users;
    return {
      people: publicRoster(grant),
      members: Object.entries(grant.members).map(([id, role]) => ({
        id, role, username: (users.find(user => user.id === id) || {}).username || '已删除账号',
      })),
      invites: (grant.invites || []).filter(invite => invite.expiresAt > Date.now())
        .map(({ id, role, expiresAt }) => ({ id, role, expiresAt })),
      shareEnabled: !!grant.share,
    };
  }

  async function setMember(tripId, userId, username, role) {
    owner(tripId, userId);
    if (!['editor', 'viewer'].includes(role)) throw new Error('权限无效');
    const key = usernameKey(username).key;
    const user = auth.store.get().users.find(entry => entry.usernameKey === key);
    if (!user) throw new Error('账号不存在');
    if (user.id === userId) throw new Error('所有者不能更改自己的权限');
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      const grant = next.access[tripId];
      const trip = next.trips.find(entry => entry.id === tripId);
      ensureRoster(trip, grant);
      let person = personForUser(grant, user.id);
      if (!person) {
        person = formalPerson(user.id, user.username);
        uniquePerson(grant, person);
        grant.people.push(person);
      }
      grant.members[user.id] = role;
      syncTripRoster(trip, grant);
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return details(tripId, userId);
  }

  async function removeMember(tripId, userId, memberId) {
    owner(tripId, userId);
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      if (!next.access[tripId].members[memberId]) throw new Error('成员不存在');
      const grant = next.access[tripId];
      const trip = next.trips.find(entry => entry.id === tripId);
      const person = personForUser(grant, memberId);
      if (person) {
        if (hasPersonReferences(trip, person)) {
          person.kind = 'legacy';
          delete person.userId;
        } else grant.people = grant.people.filter(entry => entry.id !== person.id);
      }
      delete grant.members[memberId];
      syncTripRoster(trip, grant);
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return details(tripId, userId);
  }

  async function createInvite(tripId, userId, role) {
    owner(tripId, userId);
    if (!['editor', 'viewer'].includes(role)) throw new Error('权限无效');
    const raw = token();
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      next.access[tripId].invites.push({ id, hash: hash(raw), role, expiresAt });
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return { token: raw, id, role, expiresAt };
  }

  async function createTemporary(tripId, userId, name) {
    owner(tripId, userId);
    const label = String(name || '').trim();
    if (!label || label.length > 40) throw new Error('临时成员名称需为 1–40 个字符');
    const raw = token();
    const person = {
      id: `person_temp_${crypto.randomUUID()}`, kind: 'temporary', name: label,
      avatar: '🙂', color: '#8b9a7e', tokenHash: hash(raw),
    };
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      const grant = next.access[tripId];
      const trip = next.trips.find(entry => entry.id === tripId);
      ensureRoster(trip, grant);
      uniquePerson(grant, person);
      grant.people.push(person);
      syncTripRoster(trip, grant);
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return { person: publicRoster({ people: [person] })[0], token: raw, tripId };
  }

  function resolveTemporary(raw) {
    if (!raw) return null;
    const wanted = hash(raw);
    for (const [tripId, grant] of Object.entries(getDb().access)) {
      const person = (grant.people || []).find(entry => entry.kind === 'temporary' && entry.tokenHash === wanted);
      if (person) return { tempTripId: tripId, tempPersonId: person.id, tempName: person.name };
    }
    return null;
  }

  async function revokeInvite(tripId, userId, inviteId) {
    owner(tripId, userId);
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      next.access[tripId].invites = next.access[tripId].invites.filter(invite => invite.id !== inviteId);
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return details(tripId, userId);
  }

  async function redeem(raw, userId) {
    const wanted = hash(raw);
    let tripId;
    await commit(current => {
      const next = structuredClone(current);
      for (const [id, grant] of Object.entries(next.access)) {
        const index = grant.invites.findIndex(invite => invite.hash === wanted && invite.expiresAt > Date.now());
        if (index < 0) continue;
        if (grant.ownerId !== userId) {
          const trip = next.trips.find(entry => entry.id === id);
          ensureRoster(trip, grant);
          const user = auth.store.get().users.find(entry => entry.id === userId);
          if (!user) throw new Error('账号不存在');
          if (!personForUser(grant, userId)) {
            const person = formalPerson(userId, user.username);
            uniquePerson(grant, person);
            grant.people.push(person);
            syncTripRoster(trip, grant);
          }
          grant.members[userId] = grant.invites[index].role;
        }
        grant.invites.splice(index, 1);
        tripId = id;
        break;
      }
      if (!tripId) throw new Error('邀请链接无效或已使用');
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return { tripId };
  }

  async function createShare(tripId, userId) {
    owner(tripId, userId);
    const raw = token();
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      next.access[tripId].share = { hash: hash(raw), createdAt: new Date().toISOString() };
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return { token: raw, tripId };
  }

  async function revokeShare(tripId, userId) {
    owner(tripId, userId);
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      next.access[tripId].share = null;
      next.meta.version = current.meta.version + 1;
      return next;
    });
  }

  function resolve(raw) {
    if (!raw) return null;
    const wanted = hash(raw);
    const grant = Object.entries(getDb().access).find(([, entry]) => entry.share && entry.share.hash === wanted);
    return grant ? { shareTripId: grant[0] } : null;
  }

  return { details, setMember, removeMember, createTemporary, resolveTemporary, createInvite, revokeInvite, redeem, createShare, revokeShare, resolve };
}

module.exports = { createSharing };
