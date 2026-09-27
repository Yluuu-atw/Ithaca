'use strict';

const { defaultDoc, defaultTrip, defaultProfile } = require('../data/schema');
const { formalPerson, unusedAppearance, syncTripRoster } = require('../data/people');

function ownedDoc(ownerId = 'owner', ownerName = ownerId) {
  const db = defaultDoc();
  const trip = defaultTrip();
  const owner = formalPerson(ownerId, ownerName);
  const grant = { ownerId, members: {}, invites: [], share: null, people: [owner] };
  db.trips.push(trip);
  db.access[trip.id] = grant;
  db.profiles[ownerId] = defaultProfile();
  syncTripRoster(trip, grant);
  return db;
}

function addFormalMember(db, tripId, userId, name = userId, role = 'editor') {
  const trip = db.trips.find(entry => entry.id === tripId);
  const grant = db.access[tripId];
  if (!trip || !grant) throw new Error('Trip does not exist');
  const appearance = unusedAppearance(grant.people);
  const person = formalPerson(userId, name, appearance.avatar, appearance.color);
  grant.people.push(person);
  grant.members[userId] = role;
  syncTripRoster(trip, grant);
  return person;
}

module.exports = { ownedDoc, addFormalMember };
