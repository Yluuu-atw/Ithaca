'use strict';

const crypto = require('node:crypto');

const COLLECTIONS = ['itinerary', 'expenses', 'checklist', 'wishlist', 'tracks', 'photos', 'places', 'bookings', 'guides'];
const AVATAR_CHOICES = ['😎', '🥰', '🐻', '🐱', '🐶', '🦊', '🐰', '🐼', '🦁', '🐸', '🦄', '🌸', '🍀', '⭐', '🍉', '🎈'];
const COLOR_CHOICES = ['#c4714b', '#8b9a7e', '#7d94a8', '#c08e8e', '#d4a44c', '#a89478', '#b07d5a', '#8a7fa0',
  '#a87079', '#6d9b9b', '#b5814f', '#827ba6', '#719b71', '#bc7e9b', '#5e8dad', '#9a8b65'];
const DEFAULT_COLORS = COLOR_CHOICES;
const DEFAULT_AVATARS = AVATAR_CHOICES;
function avatarKey(value) { return String(value || '').replace(/\ufe0f/g, ''); }

function unusedAppearance(people, excludingId) {
  const others = (people || []).filter(person => person.id !== excludingId);
  const avatar = AVATAR_CHOICES.find(value => !others.some(person => avatarKey(person.avatar) === avatarKey(value)));
  const color = COLOR_CHOICES.find(value => !others.some(person => String(person.color || '').toLowerCase() === value));
  if (!avatar || !color) throw new Error('当前旅行的头像或颜色已用完，无法添加更多成员');
  return { avatar, color };
}

function stableId(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function formalPerson(userId, name, avatar, color) {
  return { id: `person_user_${userId}`, kind: 'formal', userId, name: String(name || userId), avatar: avatar || AVATAR_CHOICES[0], color: color || COLOR_CHOICES[0] };
}

function personForUser(grant, userId) {
  return (grant && grant.people || []).find(person => person.kind === 'formal' && person.userId === userId) || null;
}

function ensureRoster(trip, grant) {
  if (!grant) return;
  if (!Array.isArray(grant.people) || !grant.people.length) {
    const names = Array.isArray(trip.meta.members) && trip.meta.members.length ? trip.meta.members : ['我'];
    grant.people = names.map((name, index) => index === 0
      ? formalPerson(grant.ownerId, name, trip.meta.avatars && trip.meta.avatars[index], trip.meta.colors && trip.meta.colors[index])
      : {
        id: `person_legacy_${stableId(`${trip.id}:${index}:${name}`)}`, kind: 'legacy',
        name: String(name), avatar: trip.meta.avatars && trip.meta.avatars[index] || DEFAULT_AVATARS[index % DEFAULT_AVATARS.length],
        color: trip.meta.colors && trip.meta.colors[index] || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      });
  }
  if (!personForUser(grant, grant.ownerId)) {
    const appearance = unusedAppearance(grant.people);
    grant.people.unshift(formalPerson(grant.ownerId, grant.ownerId, appearance.avatar, appearance.color));
  }
  for (const userId of Object.keys(grant.members || {})) {
    if (!personForUser(grant, userId)) {
      const appearance = unusedAppearance(grant.people);
      grant.people.push(formalPerson(userId, `账号 ${userId.slice(0, 8)}`, appearance.avatar, appearance.color));
    }
  }
  syncTripRoster(trip, grant);
  const ownerPerson = personForUser(grant, grant.ownerId);
  stampAuthors(trip, ownerPerson.id);
}

function syncTripRoster(trip, grant) {
  trip.meta.members = grant.people.map(person => person.name);
  trip.meta.avatars = grant.people.map(person => person.avatar || '🙂');
  trip.meta.colors = grant.people.map(person => person.color || DEFAULT_COLORS[0]);
}

function stampAuthors(trip, ownerPersonId) {
  for (const collection of COLLECTIONS) {
    for (const [index, item] of (trip[collection] || []).entries()) {
      if (!item || typeof item !== 'object') continue;
      if (!item.id) item.id = `legacy_${stableId(`${trip.id}:${collection}:${index}`)}`;
      if (!item.authorId) item.authorId = ownerPersonId;
      if (collection === 'itinerary') {
        for (const [nestedIndex, nested] of (item.items || []).entries()) {
          if (!nested || typeof nested !== 'object') continue;
          if (!nested.id) nested.id = `legacy_${stableId(`${trip.id}:itinerary:${index}:${nestedIndex}`)}`;
          if (!nested.authorId) nested.authorId = ownerPersonId;
        }
      }
    }
  }
}

function assignAuthors(trip, personId) {
  for (const collection of COLLECTIONS) {
    for (const item of trip[collection] || []) {
      if (!item || typeof item !== 'object') continue;
      item.authorId = personId;
      if (collection === 'itinerary') {
        for (const nested of item.items || []) if (nested && typeof nested === 'object') nested.authorId = personId;
      }
    }
  }
}

function publicRoster(grant, users = []) {
  const byId = new Map(users.map(user => [user.id, user]));
  return (grant && grant.people || []).map(({ id, kind, userId, name, avatar, color, tripNickname }) => {
    const person = { id, kind, userId, name, avatar, color, tripNickname: tripNickname || '' };
    const account = kind === 'formal' && byId.get(userId);
    person.displayName = tripNickname || account && (account.displayName || account.username) || name;
    return person;
  });
}

function uniquePerson(grant, candidate, excludingId) {
  const key = candidate.name.trim().toLocaleLowerCase('en-US');
  if (!key) throw new Error('成员名称不能为空');
  if ((grant.people || []).some(person => person.id !== excludingId && (
    person.name.trim().toLocaleLowerCase('en-US') === key ||
    candidate.userId && person.userId === candidate.userId
  ))) throw new Error('这名成员已在旅行中');
}

function rewritePersonReferences(trip, from, to) {
  for (const collection of COLLECTIONS) {
    for (const item of trip[collection] || []) {
      rewrite(item, from, to);
    }
  }
}

function hasPersonReferences(trip, person) {
  function found(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.authorId === person.id || value.payer === person.name || value.owner === person.name) return true;
    if (Array.isArray(value.participants) && value.participants.includes(person.name)) return true;
    return Object.values(value).some(nested => nested && typeof nested === 'object' && found(nested));
  }
  return COLLECTIONS.some(collection => found(trip[collection] || []));
}

function rewrite(value, from, to) {
  if (!value || typeof value !== 'object') return;
  if (value.authorId === from.id) value.authorId = to.id;
  for (const key of ['payer', 'owner']) {
    if (value[key] === from.name) value[key] = to.name;
  }
  if (Array.isArray(value.participants)) {
    value.participants = value.participants.map(name => name === from.name ? to.name : name);
  }
  if (Array.isArray(value)) value.forEach(item => rewrite(item, from, to));
  else for (const nested of Object.values(value)) if (nested && typeof nested === 'object') rewrite(nested, from, to);
}

module.exports = { COLLECTIONS, AVATAR_CHOICES, COLOR_CHOICES, avatarKey, unusedAppearance, formalPerson, personForUser, ensureRoster, syncTripRoster, stampAuthors, assignAuthors, publicRoster, uniquePerson, rewritePersonReferences, hasPersonReferences };
