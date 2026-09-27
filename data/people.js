'use strict';

const COLLECTIONS = ['itinerary', 'expenses', 'checklist', 'wishlist', 'tracks', 'photos', 'places', 'guides'];
const AVATAR_CHOICES = ['😎', '🥰', '🐻', '🐱', '🐶', '🦊', '🐰', '🐼', '🦁', '🐸', '🦄', '🌸', '🍀', '⭐', '🍉', '🎈'];
const COLOR_CHOICES = ['#c4714b', '#8b9a7e', '#7d94a8', '#c08e8e', '#d4a44c', '#a89478', '#b07d5a', '#8a7fa0',
  '#a87079', '#6d9b9b', '#b5814f', '#827ba6', '#719b71', '#bc7e9b', '#5e8dad', '#9a8b65'];
function avatarKey(value) { return String(value || '').replace(/\ufe0f/g, ''); }

function unusedAppearance(people, excludingId) {
  const others = (people || []).filter(person => person.id !== excludingId);
  const avatar = AVATAR_CHOICES.find(value => !others.some(person => avatarKey(person.avatar) === avatarKey(value)));
  const color = COLOR_CHOICES.find(value => !others.some(person => String(person.color || '').toLowerCase() === value));
  if (!avatar || !color) throw new Error('当前旅行的头像或颜色已用完，无法添加更多成员');
  return { avatar, color };
}

function formalPerson(userId, name, avatar, color) {
  return { id: `person_user_${userId}`, kind: 'formal', userId, name: String(name || userId), avatar: avatar || AVATAR_CHOICES[0], color: color || COLOR_CHOICES[0] };
}

function personForUser(grant, userId) {
  return (grant && grant.people || []).find(person => person.kind === 'formal' && person.userId === userId) || null;
}

function syncTripRoster(trip, grant) {
  trip.meta.members = grant.people.map(person => person.name);
  trip.meta.avatars = grant.people.map(person => person.avatar);
  trip.meta.colors = grant.people.map(person => person.color);
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

module.exports = { COLLECTIONS, AVATAR_CHOICES, COLOR_CHOICES, avatarKey, unusedAppearance, formalPerson, personForUser, syncTripRoster, assignAuthors, publicRoster, uniquePerson, rewritePersonReferences, hasPersonReferences };
