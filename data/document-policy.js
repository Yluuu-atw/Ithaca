'use strict';

const { defaultProfile, normalizeTrip, normalizeMemo, normalizeTemplate } = require('./schema');
const { roleFor, canReadAsset, uploadNames, publicTripRoles } = require('./access');
const { COLLECTIONS, AVATAR_CHOICES, COLOR_CHOICES, formalPerson, personForUser, publicRoster } = require('./people');
const { calculateTransfers, personalSettlement } = require('./settlement');

class AccessDeniedError extends Error {
  constructor(message = '没有访问权限') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

function profileFor(db, userId) {
  const stored = userId && db.profiles && db.profiles[userId];
  return stored || defaultProfile();
}

function project(db, principal, users = []) {
  const profile = profileFor(db, principal && principal.userId);
  const permissions = publicTripRoles(db, principal);
  return {
    meta: { version: db.meta.version, updatedAt: db.meta.updatedAt, welcomeTheme: profile.welcomeTheme },
    trips: structuredClone(db.trips.filter(trip => permissions[trip.id])),
    memos: principal && principal.userId ? structuredClone(profile.memos) : [],
    packingTemplates: principal && principal.userId ? structuredClone(profile.packingTemplates) : [],
    permissions,
    rosters: Object.fromEntries(db.trips.filter(trip => permissions[trip.id]).map(trip => [trip.id, publicRoster(db.access[trip.id], users)])),
    mySettlements: Object.fromEntries(db.trips.filter(trip => permissions[trip.id]).map(trip =>
      [trip.id, personalSettlement(trip, db.access[trip.id], principal, users)]).filter(([, value]) => value)),
    groupSettlements: Object.fromEntries(db.trips.filter(trip => permissions[trip.id]).map(trip => {
      const people = db.access[trip.id].people || [];
      const plan = calculateTransfers(trip, db.access[trip.id]);
      const named = amounts => Object.fromEntries(people.map(person => [person.name, amounts[person.id]]));
      return [trip.id, { advanced: named(plan.advanced), shouldPay: named(plan.owed), balance: named(plan.balance) }];
    })),
    appearanceChoices: { avatars: AVATAR_CHOICES, colors: COLOR_CHOICES },
  };
}

function cleanTrip(input) {
  const trip = structuredClone(input);
  delete trip.access;
  delete trip.permissions;
  delete trip.ownerId;
  return normalizeTrip(trip);
}

function checkTripAssets(db, trip) {
  for (const name of uploadNames(trip)) {
    if (!db.assets[name] || db.assets[name].tripId !== trip.id) {
      throw new AccessDeniedError('旅行包含无权使用的附件');
    }
  }
}

function preserveAuthors(before, after, authorId) {
  for (const collection of COLLECTIONS) {
    const oldItems = new Map((before && before[collection] || []).map(item => [item.id, item]));
    const seen = new Set();
    for (const item of after[collection] || []) {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error('记录 ID 无效或重复');
      seen.add(item.id);
      const old = oldItems.get(item.id);
      if (old) {
        if (item.authorId !== old.authorId) throw new AccessDeniedError('不能修改记录作者');
      } else if (item.authorId && item.authorId !== authorId) {
        throw new AccessDeniedError('不能指定其他记录作者');
      }
      item.authorId = old ? old.authorId : authorId;
      if (collection !== 'itinerary') continue;
      const oldNested = new Map((old && old.items || []).map(nested => [nested.id, nested]));
      const nestedSeen = new Set();
      for (const nested of item.items || []) {
        if (!nested || typeof nested.id !== 'string' || !nested.id || nestedSeen.has(nested.id)) throw new Error('行程记录 ID 无效或重复');
        nestedSeen.add(nested.id);
        const original = oldNested.get(nested.id);
        if (original && nested.authorId !== original.authorId) throw new AccessDeniedError('不能修改记录作者');
        if (!original && nested.authorId && nested.authorId !== authorId) throw new AccessDeniedError('不能指定其他记录作者');
        nested.authorId = original ? original.authorId : authorId;
      }
    }
  }
}

function same(value, other) { return JSON.stringify(value) === JSON.stringify(other); }

function checkOwnCollection(before, after, personId, nested = false) {
  const originals = new Map(before.map(item => [item.id, item]));
  const seen = new Set();
  for (const item of after) {
    if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error('记录 ID 无效或重复');
    seen.add(item.id);
    const old = originals.get(item.id);
    if (old) {
      if (item.authorId !== old.authorId) throw new AccessDeniedError('不能修改记录作者');
      if (old.authorId !== personId) {
        if (nested) {
          const { items: oldItems, ...oldFields } = old;
          const { items: nextItems, ...nextFields } = item;
          if (!same(oldFields, nextFields)) throw new AccessDeniedError('不能修改其他成员的内容');
          checkOwnCollection(oldItems || [], nextItems || [], personId);
        } else if (!same(old, item)) throw new AccessDeniedError('不能修改其他成员的内容');
      } else if (nested) checkOwnCollection(old.items || [], item.items || [], personId);
    } else {
      if (item.authorId && item.authorId !== personId) throw new AccessDeniedError('不能指定其他记录作者');
      item.authorId = personId;
      if (nested) checkOwnCollection([], item.items || [], personId);
    }
  }
  for (const old of before) {
    if (!seen.has(old.id) && (old.authorId !== personId || nested && (old.items || []).some(item => item.authorId !== personId))) {
      throw new AccessDeniedError('不能删除其他成员的内容');
    }
  }
  const oldOthers = before.filter(item => item.authorId !== personId).map(item => item.id);
  const newOthers = after.filter(item => item.authorId !== personId).map(item => item.id);
  if (!same(oldOthers, newOthers)) throw new AccessDeniedError('不能调整其他成员的内容');
}

function updateTemporary(db, principal, submitted) {
  const tripId = principal.tempTripId;
  if (roleFor(db, principal, tripId) !== 'temporary') throw new AccessDeniedError();
  if (!submitted || !Array.isArray(submitted.trips) || submitted.trips.length !== 1 || submitted.trips[0].id !== tripId) {
    throw new AccessDeniedError('临时成员只能修改当前旅行');
  }
  const original = db.trips.find(trip => trip.id === tripId);
  const changed = cleanTrip(submitted.trips[0]);
  if (!same(original.meta, changed.meta)) throw new AccessDeniedError('临时成员不能修改旅行信息');
  const protectedFields = new Set(['meta', ...COLLECTIONS]);
  for (const key of new Set([...Object.keys(original), ...Object.keys(changed)])) {
    if (!protectedFields.has(key) && !same(original[key], changed[key])) {
      throw new AccessDeniedError('临时成员不能修改旅行信息');
    }
  }
  checkTripAssets(db, changed);
  for (const collection of COLLECTIONS) {
    checkOwnCollection(original[collection] || [], changed[collection] || [], principal.tempPersonId, collection === 'itinerary');
  }
  const allItems = (changed.itinerary || []).flatMap(day => day.items || []);
  if (new Set(allItems.map(item => item.id)).size !== allItems.length) throw new Error('行程记录 ID 重复');
  const next = structuredClone(db);
  next.trips = next.trips.map(trip => trip.id === tripId ? changed : trip);
  return next;
}

function updateDocument(db, principal, submitted) {
  if (principal && principal.tempPersonId && !principal.userId) return updateTemporary(db, principal, submitted);
  if (!principal || !principal.userId) throw new AccessDeniedError();
  if (!submitted || !Array.isArray(submitted.trips) || !submitted.meta) throw new Error('文档格式无效');
  const userId = principal.userId;
  const next = structuredClone(db);
  const existing = new Map(db.trips.map(trip => [trip.id, trip]));
  const incoming = new Map();
  for (const trip of submitted.trips) {
    if (!trip || typeof trip.id !== 'string' || !/^trip_[a-zA-Z0-9_-]{1,96}$/.test(trip.id)) throw new Error('旅行 ID 无效');
    if (incoming.has(trip.id)) throw new Error('旅行 ID 重复');
    incoming.set(trip.id, trip);
  }

  const merged = [];
  for (const trip of db.trips) {
    const role = roleFor(db, principal, trip.id);
    if (!role) { merged.push(trip); continue; }
    const changed = incoming.get(trip.id);
    if (!changed) {
      if (role !== 'owner') throw new AccessDeniedError('只有旅行所有者可以删除旅行');
      delete next.access[trip.id];
      continue;
    }
    incoming.delete(trip.id);
    if (role === 'viewer') {
      if (JSON.stringify(changed) !== JSON.stringify(trip)) throw new AccessDeniedError('只读旅行不能修改');
      merged.push(trip);
      continue;
    }
    const cleaned = cleanTrip(changed);
    if (JSON.stringify([cleaned.meta.members, cleaned.meta.avatars, cleaned.meta.colors]) !==
      JSON.stringify([trip.meta.members, trip.meta.avatars, trip.meta.colors])) {
      throw new AccessDeniedError('成员只能通过成员管理修改');
    }
    const author = personForUser(db.access[trip.id], userId);
    if (!author) throw new AccessDeniedError('当前账号没有旅行身份');
    checkTripAssets(db, cleaned);
    preserveAuthors(trip, cleaned, author.id);
    merged.push(cleaned);
  }

  for (const [id, trip] of incoming) {
    if (existing.has(id)) throw new AccessDeniedError('不能访问这趟旅行');
    const cleaned = cleanTrip(trip);
    const person = formalPerson(userId, principal.username || userId);
    cleaned.meta.members = [person.name];
    cleaned.meta.avatars = [person.avatar];
    cleaned.meta.colors = [person.color];
    preserveAuthors(null, cleaned, person.id);
    checkTripAssets(db, cleaned);
    merged.push(cleaned);
    next.access[id] = { ownerId: userId, members: {}, invites: [], share: null, people: [person] };
  }
  next.trips = merged;

  const oldProfile = profileFor(db, userId);
  next.profiles[userId] = {
    welcomeTheme: typeof submitted.meta.welcomeTheme === 'string'
      ? submitted.meta.welcomeTheme : oldProfile.welcomeTheme,
    memos: Array.isArray(submitted.memos) ? submitted.memos.map(normalizeMemo) : oldProfile.memos,
    packingTemplates: Array.isArray(submitted.packingTemplates)
      ? submitted.packingTemplates.map(normalizeTemplate).filter(Boolean) : oldProfile.packingTemplates,
  };
  for (const name of uploadNames(next.profiles[userId].memos)) {
    if (!canReadAsset(db, principal, name)) throw new AccessDeniedError('备忘录包含无权使用的附件');
  }
  return next;
}

module.exports = { AccessDeniedError, profileFor, project, updateDocument, updateTemporary };
