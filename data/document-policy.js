'use strict';

const { defaultDoc, normalizeTrip, normalizeMemo, normalizeTemplate } = require('./schema');
const { roleFor, publicTripRoles } = require('./access');

class AccessDeniedError extends Error {
  constructor(message = '没有访问权限') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

function profileFor(db, userId) {
  const stored = userId && db.profiles && db.profiles[userId];
  return stored || { welcomeTheme: '#f2ece0', memos: [], packingTemplates: defaultDoc().packingTemplates };
}

function project(db, principal) {
  const profile = profileFor(db, principal && principal.userId);
  const permissions = publicTripRoles(db, principal);
  return {
    meta: { version: db.meta.version, updatedAt: db.meta.updatedAt, welcomeTheme: profile.welcomeTheme },
    trips: structuredClone(db.trips.filter(trip => permissions[trip.id])),
    memos: principal && principal.userId ? structuredClone(profile.memos) : [],
    packingTemplates: principal && principal.userId ? structuredClone(profile.packingTemplates) : [],
    permissions,
  };
}

function cleanTrip(input) {
  const trip = structuredClone(input);
  delete trip.access;
  delete trip.permissions;
  delete trip.ownerId;
  return normalizeTrip(trip);
}

function updateDocument(db, principal, submitted) {
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
    merged.push(cleanTrip(changed));
  }

  for (const [id, trip] of incoming) {
    if (existing.has(id)) throw new AccessDeniedError('不能访问这趟旅行');
    merged.push(cleanTrip(trip));
    next.access[id] = { ownerId: userId, members: {}, invites: [], share: null };
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
  return next;
}

module.exports = { AccessDeniedError, profileFor, project, updateDocument };
