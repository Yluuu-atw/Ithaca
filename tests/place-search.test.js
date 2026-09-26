'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaceSearch, PlaceSearchError, normalizeResults } = require('../data/place-search');

test('place search caches public venue results and serializes provider calls', async () => {
  const calls = [];
  let current = 1000;
  const search = createPlaceSearch({
    now: () => current,
    sleep: async ms => { current += ms; },
    fetchImpl: async (url, options) => {
      calls.push({ query: url.searchParams.get('q'), at: current, agent: options.headers['User-Agent'] });
      return { ok: true, json: async () => [{ name: 'Cafe', display_name: 'Cafe, Main Street', addresstype: 'restaurant', lat: '31.2', lon: '121.5' }] };
    },
  });
  const [one, same, two] = await Promise.all([
    search.search('Cafe Main Street'),
    search.search('Cafe Main Street'),
    search.search('Another Cafe'),
  ]);
  assert.deepEqual(one, same);
  assert.equal(one[0].lat, 31.2);
  assert.equal(two[0].lng, 121.5);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 1100);
  assert.match(calls[0].agent, /Ithaca/);
  await search.search('Cafe Main Street');
  assert.equal(calls.length, 2);
});

test('place search rejects invalid queries and coordinates', async () => {
  const search = createPlaceSearch({ fetchImpl: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(search.search('a'), error => error instanceof PlaceSearchError && error.status === 400);
  assert.deepEqual(normalizeResults([
    { lat: '95', lon: '0' },
    { name: 'Shop', display_name: 'Shop, Town', lat: '30.1', lon: '120.2' },
  ]), [{ name: 'Shop', address: 'Shop, Town', type: '', lat: 30.1, lng: 120.2 }]);
});
