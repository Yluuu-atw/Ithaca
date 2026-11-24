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
      calls.push({ url, query: url.searchParams.get('q'), at: current, agent: options.headers['User-Agent'] });
      return { ok: true, json: async () => ({ features: [point('Cafe', [121.5, 31.2], { street: 'Main Street' })] }) };
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
  assert.equal(calls[0].url.hostname, 'photon.komoot.io');
  await search.search('Cafe Main Street', { lat: 31.208, lng: 121.505 });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url.searchParams.get('lat'), '31.21');
  assert.equal(calls[2].url.searchParams.get('lon'), '121.50');
});

function point(name, coordinates, properties = {}) {
  return { geometry: { type: 'Point', coordinates }, properties: { name, ...properties } };
}

test('place search rejects invalid queries and coordinates', async () => {
  const search = createPlaceSearch({ fetchImpl: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(search.search('a'), error => error instanceof PlaceSearchError && error.status === 400);
  assert.deepEqual(normalizeResults({ features: [
    point('Invalid', [0, 95]),
    point('Missing', [0, null]),
    point('Shop', [120.2, 30.1], { city: 'Town' }),
    point('City', [120.23, 30.12], { osm_key: 'place', osm_value: 'city', type: 'district' }),
  ] }), [
    { name: 'Shop', address: 'Town', type: '', lat: 30.1, lng: 120.2 },
    { name: 'City', address: '', type: 'city', lat: 30.12, lng: 120.23 },
  ]);
  const chinese = createPlaceSearch({ fetchImpl: async url => {
    assert.equal(url.searchParams.get('q'), '旺角');
    return { ok: true, json: async () => ({ features: [] }) };
  } });
  assert.deepEqual(await chinese.search('旺角'), []);
});

test('dining lookup searches nearby named restaurants by exact cuisine tag and caches the result', async () => {
  let calls = 0;
  const search = createPlaceSearch({ fetchImpl: async url => {
    calls++;
    if (url.hostname === 'photon.komoot.io') {
      assert.equal(url.searchParams.get('q'), 'indian');
      assert.equal(url.searchParams.getAll('osm_tag')[0], 'amenity:restaurant');
      assert.equal(url.searchParams.get('bbox').split(',').length, 4);
      return { ok: true, json: async () => ({ features: [point('Unrelated Cafe', [114.15, 22.28], { osm_key: 'amenity', osm_value: 'restaurant' })] }) };
    }
    assert.equal(url.hostname, 'overpass-api.de');
    assert.match(url.searchParams.get('data'), /around:4500,22\.28,114\.15/);
    assert.match(url.searchParams.get('data'), /\["cuisine"~"\(\^\|;\) \*indian \*\(;\|\$\)",i\]/);
    return { ok: true, json: async () => ({ elements: [
      { lat: 22.29, lon: 114.15, tags: { name: 'Farther' } },
      { center: { lat: 22.281, lon: 114.15 }, tags: { name: 'Nearby', 'addr:street': 'Main Street' } },
      { lat: 22.28, lon: 114.15, tags: {} },
    ] }) };
  } });
  const near = { lat: 22.28, lng: 114.15 };
  await assert.rejects(search.searchDining('印度菜', near, 'indian";out;'), error => error.status === 400);
  const restaurants = await search.searchDining('印度菜', near, 'indian');
  assert.deepEqual(restaurants.map(place => place.name), ['Nearby', 'Farther']);
  assert.equal(restaurants[0].dining, true);
  assert.equal(restaurants[0].address, 'Main Street');
  await search.searchDining('印度菜', near, 'indian');
  assert.equal(calls, 2);
});

test('a named roast goose restaurant can match simplified or traditional characters', async () => {
  const search = createPlaceSearch({ fetchImpl: async url => {
    assert.equal(url.hostname, 'photon.komoot.io');
    assert.equal(url.searchParams.get('q'), '燒鵝');
    return { ok: true, json: async () => ({ features: [
      point('地方燒鵝', [114.15, 22.28], { osm_key: 'amenity', osm_value: 'restaurant' }),
      point('不相关餐厅', [114.15, 22.28], { osm_key: 'amenity', osm_value: 'restaurant' }),
      point('燒鵝街', [114.15, 22.28], { osm_key: 'highway' }),
    ] }) };
  } });
  assert.deepEqual((await search.searchDining('烧鹅', { lat: 22.28, lng: 114.15 })).map(row => row.name), ['地方燒鵝']);
});
