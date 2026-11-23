'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function model(extra = {}) {
  const context = { window: {}, ...extra };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/footprints.js'), 'utf8'), context);
  return context.window.Footprints;
}

function trip(id, start, end, destination = '香港', extra = {}) {
  return { id, meta: { startDate: start, endDate: end, destination, ...extra } };
}

test('footprints count inclusive elapsed days once across overlapping trips and exclude future plans', () => {
  const footprints = model();
  const trips = [
    trip('past', '2026-11-10', '2026-11-12', '香港'),
    trip('overlap', '2026-11-12', '2026-11-15', '澳门', { archived: true }),
    trip('ongoing', '2026-11-22', '2026-11-30', '北京'),
    trip('future', '2026-12-01', '2026-12-06', '东京', { archived: true }),
    trip('unknown', '', '', '伦敦'),
    trip('end-only', '', '2026-11-20', '巴黎'),
    trip('reversed', '2026-11-20', '2026-11-01', '罗马'),
  ];
  const original = JSON.stringify(trips);
  const result = footprints.summarize(trips, { today: '2026-11-23' });
  assert.equal(result.tripCount, 3);
  assert.equal(result.dayCount, 8);
  assert.equal(result.futureCount, 1);
  assert.equal(result.undatedCount, 2);
  assert.equal(result.invalidDateCount, 1);
  assert.equal(result.ongoingCount, 1);
  assert.deepEqual(Array.from(result.cities, city => city.name), ['北京', '澳门', '香港']);
  assert.equal(result.cities[0].lastDate, '2026-11-23');
  assert.equal(JSON.stringify(trips), original);
});

test('date validation handles leap years, DST boundaries and same-day travel', () => {
  const footprints = model();
  for (const date of ['2024-02-29', '2000-02-29', '2026-11-23', '0001-01-01']) assert.equal(footprints.isValidDate(date), true, date);
  for (const date of ['2025-02-29', '1900-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-11-00', '0000-01-01', '2026-1-1', '', null]) assert.equal(footprints.isValidDate(date), false, String(date));
  const result = footprints.summarize([
    trip('leap', '2024-02-28', '2024-03-01'),
    trip('spring-dst', '2024-03-09', '2024-03-11'),
    trip('fall-dst', '2024-11-02', '2024-11-04'),
    trip('single', '2024-12-01', ''),
  ], { today: '2026-11-23' });
  assert.equal(result.tripCount, 4);
  assert.equal(result.dayCount, 10);
  assert.equal(footprints.summarize([trip('early-year', '0001-01-01', '0001-01-02')], { today: '2026-11-23' }).dayCount, 2);
});

test('valid itinerary dates fill missing travel dates and explicit valid metadata takes precedence', () => {
  const footprints = model();
  const result = footprints.summarize([
    { id: 'itinerary', meta: { destination: '香港', startDate: '2025-02-29' }, itinerary: [{ date: '2025-03-03' }, { date: '2025-03-01' }, { date: 'invalid' }, null] },
    { ...trip('manual', '2025-04-03', '2025-04-04'), itinerary: [{ date: '2025-04-01' }, { date: '2025-04-05' }] },
    { id: 'invalid', meta: { destination: '东京' }, itinerary: [{ date: '2026-13-20' }] },
  ], { today: '2026-11-23' });
  assert.equal(result.tripCount, 2);
  assert.equal(result.dayCount, 5);
  assert.equal(result.undatedCount, 1);
  assert.equal(result.cities[0].visits, 2);
});

test('city aliases and repeated destinations merge once per trip without inventing unknown coordinates', () => {
  const footprints = model();
  const result = footprints.summarize([
    trip('first', '2026-01-01', '2026-01-02', '香港、香港市 / Hong Kong；北京市, Beijing|澳门'),
    trip('second', '2026-02-01', '2026-02-02', '香港特別行政區; Hongkong，澳門 / 尚未定位的城市'),
  ], { today: '2026-11-23' });
  const hongkong = result.cities.find(city => city.name === '香港');
  assert.equal(hongkong.visits, 2);
  assert.deepEqual(Array.from(hongkong.tripIds), ['first', 'second']);
  assert.equal(hongkong.lat, 22.27832);
  assert.equal(hongkong.lng, 114.17469);
  assert.equal(result.cities.find(city => city.name === '北京').visits, 1);
  assert.equal(result.cities.find(city => city.name === '澳门').visits, 2);
  const unknown = result.cities.find(city => city.name === '尚未定位的城市');
  assert.equal(unknown.lat, null);
  assert.equal(unknown.lng, null);
  assert.equal(footprints.resolveKnownCity('not a known city'), null);
  assert.equal(footprints.normalizeCityName('  HONG   KONG  '), '香港');
  assert.equal(footprints.cityKey('北京市'), footprints.cityKey('Beijing'));
});

test('itinerary locations count toward footprints while titles of trips, guides and wishlists do not', () => {
  const footprints = model();
  const result = footprints.summarize([{
    ...trip('no-city', '2026-01-01', '2026-01-02', ''),
    meta: { tripName: '巴黎旅行', startDate: '2026-01-01', endDate: '2026-01-02', destination: '' },
    itinerary: [{ date: '2026-01-01', items: [{ title: 'Tokyo', location: 'Tokyo' }] }],
    wishlist: [{ location: 'London', status: '想去' }],
    places: [{ location: 'Rome' }],
  }], { today: '2026-11-23' });
  assert.equal(result.tripCount, 1);
  assert.equal(result.dayCount, 2);
  assert.deepEqual(Array.from(result.cities, city => city.name), ['东京']);
  assert.deepEqual(Array.from(result.places, place => place.name), ['Tokyo']);
});

test('completed-only statistics exclude ongoing travel while preserving finished and archived records', () => {
  const footprints = model();
  const result = footprints.summarize([
    trip('ended', '2026-11-20', '2026-11-21', '香港', { archived: true }),
    trip('today', '2026-11-23', '2026-11-23', '澳门'),
    trip('ongoing', '2026-11-22', '2026-11-24', '北京'),
  ], { today: '2026-11-23', completedOnly: true });
  assert.equal(result.tripCount, 2);
  assert.equal(result.dayCount, 3);
  assert.equal(result.ongoingCount, 1);
  assert.equal(result.cities.some(city => city.name === '北京'), false);
});

test('empty and duplicate records are safe and public results do not expose source account fields', () => {
  const footprints = model();
  for (const input of [null, undefined, {}, [], [null, false, []]]) {
    const result = footprints.summarize(input, { today: '2026-11-23' });
    assert.equal(result.tripCount, 0);
    assert.equal(result.dayCount, 0);
    assert.equal(result.cities.length, 0);
  }
  const unsafeName = '<img onerror="BAD">';
  const entry = { ...trip('once', '2026-01-01', '2026-01-01', unsafeName), secret: 'DO_NOT_EXPOSE' };
  const result = footprints.summarize([entry, entry], { today: '2026-11-23' });
  assert.equal(result.tripCount, 1);
  assert.equal(result.cities[0].name, unsafeName);
  assert.equal(result.cities[0].visits, 1);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE/);
  const known = footprints.resolveKnownCity('香港');
  known.lat = 0;
  assert.equal(footprints.resolveKnownCity('香港').lat, 22.27832);
});

test('default cutoff uses local calendar day rather than the UTC date', () => {
  class ShanghaiDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-11-22T20:00:00Z'])); }
    getFullYear() { return new Date(this.getTime() + 8 * 3600000).getUTCFullYear(); }
    getMonth() { return new Date(this.getTime() + 8 * 3600000).getUTCMonth(); }
    getDate() { return new Date(this.getTime() + 8 * 3600000).getUTCDate(); }
  }
  const footprints = model({ Date: ShanghaiDate });
  const result = footprints.summarize([trip('local-today', '2026-11-23', '2026-11-25')]);
  assert.equal(result.tripCount, 1);
  assert.equal(result.dayCount, 1);
  assert.equal(result.cities[0].lastDate, '2026-11-23');
});

test('footprints map itinerary points in different cities and omit future arrangements', () => {
  const footprints = model();
  const tripData = {
    ...trip('hk-mo', '2026-11-22', '2026-11-24', '香港'),
    itinerary: [
      { id: 'hk', date: '2026-11-22', items: [
        { id: 'mk', category: '其他', location: '旺角' },
        { id: 'cuhk', category: '景点', title: '香港中文大學' },
        { id: 'central', location: '中环', lat: 22.282, lng: 114.158 },
      ] },
      { id: 'mo', date: '2026-11-23', items: [
        { id: 'ruins', category: '景点', title: '大三巴牌坊' },
        { id: 'blank', category: '交通', title: '巴士', location: '' },
      ] },
      { id: 'next', date: '2026-11-24', items: [{ id: 'tomorrow', location: '妈阁庙' }] },
    ],
  };
  const result = footprints.summarize([tripData], { today: '2026-11-23' });
  assert.equal(result.tripCount, 1);
  assert.equal(result.dayCount, 2);
  assert.deepEqual(Array.from(result.cities, city => city.name).sort(), ['澳门', '香港'].sort());
  assert.equal(result.places.length, 4);
  const points = new Map(result.places.map(point => [point.itemId, point]));
  assert.equal(points.get('ruins').city, '澳门');
  assert.ok(points.get('ruins').lng < 114);
  assert.equal(points.get('cuhk').source, 'wikidata');
  assert.notEqual(points.get('mk').lat, points.get('cuhk').lat);
  assert.equal(points.get('central').lat, 22.282);
});

test('saved coordinates can resolve exact itinerary names within a trip, but conflicting or unknown places stay unlocated', () => {
  const footprints = model();
  const tripData = {
    ...trip('multiple', '2026-11-22', '2026-11-22', '香港'),
    places: [{ name: '老茶楼', lat: 22.28, lng: 114.15 }, { name: '同名店', lat: 22.29, lng: 114.14 }],
    expenses: [{ location: '同名店', lat: 22.31, lng: 114.16 }],
    itinerary: [{ id: 'day', date: '2026-11-22', items: [
      { id: 'found', location: '老茶楼', lat: ' ', lng: null },
      { id: 'ambiguous', location: '同名店' },
      { id: 'missing', location: '小巷咖啡' },
    ] }],
  };
  const { places } = footprints.summarize([tripData], { today: '2026-11-23' });
  assert.equal(places.find(place => place.itemId === 'found').lat, 22.28);
  assert.equal(places.find(place => place.itemId === 'ambiguous').lat, null);
  assert.equal(places.find(place => place.itemId === 'missing').lat, null);
});

test('online itinerary matching handles bilingual labels and rejects a distant name collision', () => {
  const footprints = model();
  const areas = [footprints.resolveKnownCity('香港')];
  const hk = { name: '星光大道 Avenue of Stars', lat: 22.294, lng: 114.175 };
  const foshan = { name: '星光大道', lat: 23.142, lng: 113.019 };
  assert.equal(footprints.selectItineraryMatch('星光大道', [foshan, hk], areas).exact, hk);
  const farOnly = footprints.selectItineraryMatch('星光大道', [foshan], areas);
  assert.equal(farOnly.exact, undefined);
  assert.equal(farOnly.nearby, undefined);
  assert.equal(footprints.selectItineraryMatch('星光大道', [{ name: '中环', lat: 22.28, lng: 114.16 }], areas).nearby, undefined);
  assert.equal(footprints.selectItineraryMatch('找不到这个店', [], []).nearby, undefined);
});

test('fuzzy search narrows descriptive names and keeps only related matches', () => {
  const footprints = model();
  const areas = [footprints.resolveKnownCity('澳门')];
  const queries = Array.from(footprints.itinerarySearchQueries('疯堂斜巷旁的小店', areas));
  assert.deepEqual(queries, ['疯堂斜巷旁的小店', '疯堂斜巷', '瘋堂斜巷']);
  const street = { name: '瘋堂斜巷 Calçada da Igreja de S. Lázaro', type: 'street', lat: 22.197, lng: 113.545 };
  const other = { name: '大三巴牌坊', type: 'house', lat: 22.197, lng: 113.541 };
  assert.equal(footprints.selectItineraryMatch('疯堂斜巷', [other, street], areas).exact, street);
  assert.equal(footprints.selectItineraryMatch('疯堂斜巷旁的咖啡厅', [other, street], areas).nearby, street);
  assert.equal(footprints.selectItineraryMatch('疯堂斜巷', [other], areas).nearby, undefined);
});

test('legacy city-centre substitutes disappear while verified landmarks remain visible', () => {
  const footprints = model();
  const oldFallback = { lat: 22.20056, lng: 113.54611, locationMap: { mode: 'nearby', name: '澳门（城市中心）' } };
  const data = {
    ...trip('macau', '2026-11-22', '2026-11-22', '澳门'),
    itinerary: [{ id: 'day', date: '2026-11-22', items: [
      { ...oldFallback, id: 'old', location: '没有确切坐标的小店' },
      { ...oldFallback, id: 'street', location: '疯堂斜巷' },
      { id: 'harbour', location: '維港' },
    ] }],
  };
  const { places } = footprints.summarize([data], { today: '2026-11-23' });
  const byId = new Map(places.map(place => [place.itemId, place]));
  assert.equal(byId.get('old').lat, null);
  assert.equal(byId.get('old').nearbyName, '');
  assert.equal(byId.get('street').lat, 22.1970565);
  assert.equal(byId.get('street').source, 'osm');
  assert.equal(byId.get('harbour').lng, 114.17);
  assert.equal(data.itinerary[0].items[0].lat, 22.20056);
});

test('nearby confirmation keeps the original itinerary name while a declined point stays out of the map', () => {
  const footprints = model();
  const tripData = {
    ...trip('hk', '2026-11-22', '2026-11-22', '香港'),
    itinerary: [{ id: 'day', date: '2026-11-22', items: [
      { id: 'yes', location: '海景咖啡', lat: 22.294, lng: 114.175, locationMap: { mode: 'nearby', name: '星光大道' } },
      { id: 'no', location: '旺角', lat: 22.3, lng: 114.17, locationMap: { mode: 'hidden' } },
      { id: 'later', location: '海景咖啡' },
    ] }],
  };
  const { places } = footprints.summarize([tripData], { today: '2026-11-23' });
  const byId = new Map(places.map(place => [place.itemId, place]));
  assert.equal(byId.get('yes').name, '海景咖啡');
  assert.equal(byId.get('yes').nearbyName, '星光大道');
  assert.equal(byId.get('yes').lat, 22.294);
  assert.equal(byId.get('no').lat, null);
  assert.equal(byId.get('later').lat, null);
});

test('a pending point in a future itinerary appears for manual location without counting as a visit', () => {
  const footprints = model();
  const plannedTrip = {
    ...trip('future', '2026-11-26', '2026-11-27', '澳门'),
    itinerary: [{ id: 'day', date: '2026-11-26', items: [
      { id: 'pending', category: '景点', title: '疯堂斜巷', locationMap: { mode: 'pending' } },
      { id: 'other', category: '景点', title: '大三巴' },
    ] }],
  };
  const summary = footprints.summarize([plannedTrip], { today: '2026-11-23' });
  assert.equal(summary.tripCount, 0);
  assert.equal(summary.dayCount, 0);
  assert.equal(summary.cities.length, 0);
  assert.equal(summary.places.length, 1);
  assert.equal(summary.places[0].name, '疯堂斜巷');
  assert.equal(summary.places[0].planned, true);
  assert.equal(summary.places[0].lat, null);
});
