'use strict';

const { personForUser, publicRoster } = require('./people');

function personForPrincipal(grant, principal, tripId) {
  if (!grant || !principal) return null;
  if (principal.userId) return personForUser(grant, principal.userId);
  if (principal.tempTripId === tripId) {
    return (grant.people || []).find(person => person.kind === 'temporary' && person.id === principal.tempPersonId) || null;
  }
  return null;
}

function allocate(cents, people, balance, sign) {
  if (!people.length) return;
  const each = Math.floor(cents / people.length);
  const remainder = cents % people.length;
  people.forEach((person, index) => { balance[person.id] += sign * (each + (index < remainder ? 1 : 0)); });
}

function calculateTransfers(trip, grant) {
  const people = grant && grant.people || [];
  const balance = Object.fromEntries(people.map(person => [person.id, 0]));
  const advanced = Object.fromEntries(people.map(person => [person.id, 0]));
  const owed = Object.fromEntries(people.map(person => [person.id, 0]));
  const byName = new Map(people.map(person => [person.name, person]));
  for (const expense of trip.expenses || []) {
    const amount = Number(expense.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cents = Math.round(amount * 100);
    if (!cents) continue;
    const payer = byName.get(expense.payer || people[0] && people[0].name);
    const participants = Array.isArray(expense.participants)
      ? [...new Set(expense.participants)].map(name => byName.get(name)).filter(Boolean)
      : expense.split === '单方' && payer ? [payer] : people;
    const payers = payer ? [payer] : people;
    const debtors = participants.length ? participants : people;
    allocate(cents, payers, advanced, 1);
    allocate(cents, debtors, owed, 1);
  }
  for (const person of people) balance[person.id] = advanced[person.id] - owed[person.id];
  const debtors = people.filter(person => balance[person.id] < 0).map(person => ({ id: person.id, amount: -balance[person.id] }));
  const creditors = people.filter(person => balance[person.id] > 0).map(person => ({ id: person.id, amount: balance[person.id] }));
  const transfers = [];
  let debit = 0;
  let credit = 0;
  while (debit < debtors.length && credit < creditors.length) {
    const from = debtors[debit];
    const to = creditors[credit];
    const amountMinor = Math.min(from.amount, to.amount);
    transfers.push({ fromId: from.id, toId: to.id, amountMinor });
    from.amount -= amountMinor;
    to.amount -= amountMinor;
    if (!from.amount) debit++;
    if (!to.amount) credit++;
  }
  return { advanced, owed, balance, transfers };
}

function personalSettlement(trip, grant, principal, users = []) {
  const person = personForPrincipal(grant, principal, trip.id);
  if (!person) return null;
  const plan = calculateTransfers(trip, grant);
  const labels = new Map(publicRoster(grant, users).map(entry => [entry.id, entry.displayName]));
  const transfers = plan.transfers.filter(transfer => transfer.fromId === person.id || transfer.toId === person.id)
    .map(transfer => {
      const direction = transfer.fromId === person.id ? 'out' : 'in';
      const otherId = direction === 'out' ? transfer.toId : transfer.fromId;
      const key = `${direction}:${otherId}:${transfer.amountMinor}`;
      return { key, direction, otherId, otherName: labels.get(otherId) || '', amountMinor: transfer.amountMinor,
        confirmed: person.transferStates && person.transferStates[key] === true || false };
    });
  return {
    personId: person.id,
    advancedMinor: plan.advanced[person.id],
    owedMinor: plan.owed[person.id],
    balanceMinor: plan.balance[person.id],
    transfers,
  };
}

module.exports = { personForPrincipal, calculateTransfers, personalSettlement };
