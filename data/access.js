'use strict';

const { normalize } = require('./schema');

const UPLOAD_NAME = /^\/uploads\/([a-zA-Z0-9_.-]+)$/;

function roleFor(db, principal, tripId) {
  const grant = db.access && db.access[tripId];
  if (!grant || !principal) return null;
  if (principal.userId && grant.ownerId === principal.userId) return 'owner';
  if (principal.userId && (grant.members[principal.userId] === 'editor' || grant.members[principal.userId] === 'viewer')) {
    return grant.members[principal.userId];
  }
  if (principal.shareTripId === tripId) return 'viewer';
  return null;
}

function canRead(db, principal, tripId) {
  return roleFor(db, principal, tripId) !== null;
}

function canEdit(db, principal, tripId) {
  return ['owner', 'editor'].includes(roleFor(db, principal, tripId));
}

function canManage(db, principal, tripId) {
  return roleFor(db, principal, tripId) === 'owner';
}

function uploadNames(value, result = new Set()) {
  if (typeof value === 'string') {
    const match = UPLOAD_NAME.exec(value);
    if (match) result.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) uploadNames(item, result);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) uploadNames(item, result);
  }
  return result;
}

function claimLegacy(raw, ownerId) {
  const db = normalize(raw);
  if (!ownerId) throw new Error('Owner ID required');
  if (!db.profiles[ownerId]) {
    db.profiles[ownerId] = {
      welcomeTheme: db.meta.welcomeTheme,
      memos: db.memos,
      packingTemplates: db.packingTemplates,
    };
  }
  for (const trip of db.trips) {
    if (db.access[trip.id]) continue;
    db.access[trip.id] = { ownerId, members: {}, invites: [], share: null };
    for (const name of uploadNames(trip)) {
      if (!db.assets[name]) db.assets[name] = { tripId: trip.id, ownerId: null, createdAt: '' };
    }
  }
  for (const memo of db.memos) {
    for (const name of uploadNames(memo)) {
      if (!db.assets[name]) db.assets[name] = { tripId: null, ownerId, createdAt: '' };
    }
  }
  return db;
}

function publicTripRoles(db, principal) {
  const roles = {};
  for (const trip of db.trips) {
    const role = roleFor(db, principal, trip.id);
    if (role) roles[trip.id] = role;
  }
  return roles;
}

module.exports = { roleFor, canRead, canEdit, canManage, uploadNames, claimLegacy, publicTripRoles };
