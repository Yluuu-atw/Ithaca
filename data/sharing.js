'use strict';

const crypto = require('node:crypto');
const { canManage, canRead } = require('./access');
const { AccessDeniedError } = require('./document-policy');
const { personForPrincipal, personalSettlement } = require('./settlement');
const { usernameKey } = require('./auth');
const { AVATAR_CHOICES, COLOR_CHOICES, avatarKey, unusedAppearance, formalPerson, personForUser, ensureRoster, syncTripRoster, publicRoster, uniquePerson, hasPersonReferences, rewritePersonReferences } = require('./people');

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
      people: publicRoster(grant, users),
      members: Object.entries(grant.members).map(([id, role]) => ({
        id, role, username: (users.find(user => user.id === id) || {}).username || '已删除账号',
      })),
      invites: (grant.invites || []).filter(invite => invite.expiresAt > Date.now())
        .map(({ id, role, expiresAt }) => ({ id, role, expiresAt })),
      shareEnabled: !!grant.share,
    };
  }

  async function updateProfile(tripId, principal, input) {
    if (!input || typeof input !== 'object' || typeof input.tripNickname !== 'string' || typeof input.avatar !== 'string' || typeof input.color !== 'string') {
      throw new Error('成员资料格式无效');
    }
    const tripNickname = input.tripNickname.trim().normalize('NFC');
    if (Array.from(tripNickname).length > 40 || /[\p{Cc}\p{Cf}]/u.test(tripNickname)) throw new Error('旅行昵称最多 40 个字符，不能包含控制字符');
    let updated;
    await commit(current => {
      if (!canRead(current, principal, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      const grant = next.access[tripId];
      const person = principal.userId ? personForUser(grant, principal.userId)
        : (grant.people || []).find(entry => entry.kind === 'temporary' && principal.tempTripId === tripId && entry.id === principal.tempPersonId);
      if (!person) throw new AccessDeniedError('只有旅行成员可以编辑资料');
      const avatar = input.avatar;
      const color = input.color.toLowerCase();
      if (avatar !== person.avatar && grant.people.some(entry => entry.id !== person.id && avatarKey(entry.avatar) === avatarKey(avatar))) throw new Error('头像已被其他成员使用');
      if (color !== String(person.color || '').toLowerCase() && grant.people.some(entry => entry.id !== person.id && String(entry.color || '').toLowerCase() === color)) throw new Error('颜色已被其他成员使用');
      if (avatar !== person.avatar && !AVATAR_CHOICES.includes(avatar)) throw new Error('头像选项无效');
      if (color !== String(person.color || '').toLowerCase() && !COLOR_CHOICES.includes(color)) throw new Error('颜色选项无效');
      person.tripNickname = tripNickname;
      person.avatar = avatar;
      person.color = color;
      syncTripRoster(next.trips.find(entry => entry.id === tripId), grant);
      next.meta.version = current.meta.version + 1;
      updated = { ...person };
      return next;
    });
    return publicRoster({ people: [updated] }, auth.store.get().users)[0];
  }

  async function updateTransfer(tripId, principal, input) {
    if (!input || typeof input.key !== 'string' || typeof input.confirmed !== 'boolean') throw new Error('转账状态格式无效');
    await commit(current => {
      if (!canRead(current, principal, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      const grant = next.access[tripId];
      const person = personForPrincipal(grant, principal, tripId);
      if (!person) throw new AccessDeniedError('只有旅行成员可以更新转账状态');
      const trip = next.trips.find(entry => entry.id === tripId);
      const plan = personalSettlement(trip, grant, principal);
      if (!plan.transfers.some(transfer => transfer.key === input.key)) throw new Error('转账项目已发生变化，请刷新后重试');
      const validKeys = new Set(plan.transfers.map(transfer => transfer.key));
      person.transferStates = Object.fromEntries(Object.entries(person.transferStates || {})
        .filter(([key, confirmed]) => validKeys.has(key) && confirmed === true));
      if (input.confirmed) person.transferStates[input.key] = true;
      else delete person.transferStates[input.key];
      next.meta.version = current.meta.version + 1;
      return next;
    });
    const current = getDb();
    return personalSettlement(current.trips.find(trip => trip.id === tripId), current.access[tripId], principal, auth.store.get().users);
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
        const appearance = unusedAppearance(grant.people);
        person = formalPerson(user.id, user.username, appearance.avatar, appearance.color);
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

  async function removePerson(tripId, userId, personId) {
    owner(tripId, userId);
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      const grant = next.access[tripId];
      const trip = next.trips.find(entry => entry.id === tripId);
      const person = (grant.people || []).find(entry => entry.id === personId);
      if (!person) throw new Error('成员不存在');
      if (person.userId === grant.ownerId) throw new Error('不能移除旅行所有者');
      if (person.userId) delete grant.members[person.userId];
      if (hasPersonReferences(trip, person)) {
        person.kind = 'legacy';
        delete person.userId;
        delete person.tokenHash;
      } else grant.people = grant.people.filter(entry => entry.id !== personId);
      syncTripRoster(trip, grant);
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return details(tripId, userId);
  }

  async function replacePerson(tripId, userId, personId, replacement) {
    owner(tripId, userId);
    const kind = replacement && replacement.kind;
    if (!['formal', 'temporary'].includes(kind)) throw new Error('替换身份类型无效');
    const raw = kind === 'temporary' ? token() : null;
    let nextPerson;
    if (kind === 'formal') {
      const key = usernameKey(replacement.username).key;
      const user = auth.store.get().users.find(entry => entry.usernameKey === key);
      if (!user) throw new Error('账号不存在');
      nextPerson = formalPerson(user.id, user.username);
    } else {
      const name = String(replacement.name || '').trim();
      if (!name || name.length > 40) throw new Error('临时成员名称需为 1–40 个字符');
      nextPerson = { id: `person_temp_${crypto.randomUUID()}`, kind: 'temporary', name, tokenHash: hash(raw) };
    }
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      const grant = next.access[tripId];
      const trip = next.trips.find(entry => entry.id === tripId);
      const index = (grant.people || []).findIndex(person => person.id === personId);
      if (index < 0) throw new Error('成员不存在');
      const previous = grant.people[index];
      if (previous.userId === grant.ownerId) throw new Error('不能替换旅行所有者');
      if (previous.id === nextPerson.id) throw new Error('替换成员必须选择其他身份');
      uniquePerson(grant, nextPerson, personId);
      const replacementPerson = { ...nextPerson, avatar: previous.avatar || '🙂', color: previous.color || '#8b9a7e' };
      const oldRole = previous.userId && grant.members[previous.userId];
      if (previous.userId) delete grant.members[previous.userId];
      if (replacementPerson.userId) grant.members[replacementPerson.userId] = oldRole || 'editor';
      rewritePersonReferences(trip, previous, replacementPerson);
      grant.people[index] = replacementPerson;
      syncTripRoster(trip, grant);
      next.meta.version = current.meta.version + 1;
      return next;
    });
    return { person: publicRoster({ people: [nextPerson] })[0], token: raw, tripId };
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
      tokenHash: hash(raw),
    };
    await commit(current => {
      if (!canManage(current, { userId }, tripId)) throw new AccessDeniedError();
      const next = structuredClone(current);
      const grant = next.access[tripId];
      const trip = next.trips.find(entry => entry.id === tripId);
      ensureRoster(trip, grant);
      uniquePerson(grant, person);
      Object.assign(person, unusedAppearance(grant.people));
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
            const appearance = unusedAppearance(grant.people);
            const person = formalPerson(userId, user.username, appearance.avatar, appearance.color);
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

  return { details, updateProfile, updateTransfer, setMember, removeMember, removePerson, replacePerson, createTemporary, resolveTemporary, createInvite, revokeInvite, redeem, createShare, revokeShare, resolve };
}

module.exports = { createSharing };
