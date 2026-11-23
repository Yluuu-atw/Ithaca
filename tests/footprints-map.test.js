'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ withLeaflet = true } = {}) {
  const container = { isConnected: true, scrollIntoView() {}, classList: { add() {}, remove() {} } };
  const status = { textContent: '' };
  const calls = { searches: [], maps: [], markers: [], tiles: [], listeners: new Set() };
  const store = {
    async searchPlaces(query, { signal }) {
      calls.searches.push({ query, signal });
      return [];
    },
  };
  const context = {
    window: {
      Footprints: { cityKey: value => String(value).trim().toLowerCase().replace(/市$/, '') },
      addEventListener(name, listener) { calls.listeners.add(listener); },
      removeEventListener(name, listener) { calls.listeners.delete(listener); },
    },
    document: { getElementById: id => id === 'footprintsMap' ? container : id === 'footprintsMapStatus' ? status : null },
    Store: store,
    AbortController,
    setTimeout: () => 1,
    clearTimeout() {},
  };
  if (withLeaflet) context.L = {
    map() {
      const instance = {
        removed: false, views: [], bounds: [], attributionControl: { addAttribution() {} },
        handlers: new Map(),
        on(name, handler) { this.handlers.set(name, handler); },
        off(name, handler) { if (this.handlers.get(name) === handler) this.handlers.delete(name); },
        invalidateSize() {},
        setView(point) { this.views.push(point); },
        fitBounds(points) { this.bounds.push(points); },
        remove() { this.removed = true; },
      };
      calls.maps.push(instance);
      return instance;
    },
    featureGroup() { return { addTo() { return this; }, clearLayers() {} }; },
    tileLayer(url, options) {
      const instance = {
        url, options,
        handlers: {}, on(name, handler) { this.handlers[name] = handler; return this; }, addTo() { return this; },
      };
      calls.tiles.push(instance);
      return instance;
    },
    divIcon: options => options,
    marker(point) {
      const instance = {
        point, opened: false, tooltip: '', popup: '',
        addTo() { return this; },
        bindTooltip(value) { this.tooltip = value; return this; },
        bindPopup(value) { this.popup = value; return this; },
        openPopup() { this.opened = true; },
      };
      calls.markers.push(instance);
      return instance;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/footprints-map.js'), 'utf8'), context);
  return { api: context.window.FootprintsMap, calls, store, status, container };
}

const knownCity = () => ({ key: '杭州', name: '杭州', lat: 30.25, lng: 120.17, visits: 2, tripIds: ['one', 'two'] });
const unknownCity = () => ({ key: 'nantes', name: 'Nantes', lat: null, lng: null, visits: 1, tripIds: ['three'] });

test('cities with coordinates open directly and unlocated destinations are searched only after a click', async () => {
  const { api, calls, store } = setup();
  let updated;
  store.searchPlaces = async (query, { signal }) => {
    calls.searches.push({ query, signal });
    return [{ name: 'Nantes', type: 'city', lat: 47.22, lng: -1.55 }];
  };
  api.mount({ cities: [knownCity(), unknownCity()] }, { onCitiesChange: cities => { updated = cities; } });
  assert.equal(calls.searches.length, 0);
  assert.equal(calls.markers.length, 1);
  assert.equal(await api.locate('杭州'), true);
  assert.equal(calls.searches.length, 0);
  assert.equal(calls.markers[0].opened, true);
  assert.equal(await api.locate('nantes'), true);
  assert.equal(calls.searches.length, 1);
  assert.equal(updated.find(city => city.key === 'nantes').lat, 47.22);
  assert.equal(await api.locate('nantes'), true);
  assert.equal(calls.searches.length, 1);
  api.destroy();
});

test('search never substitutes a POI, region, mismatched name or ambiguous city for a destination', async () => {
  const cases = [
    [{ name: 'Nantes', type: 'restaurant', lat: 47.22, lng: -1.55 }],
    [{ name: 'Nantes', type: 'administrative', lat: 47.22, lng: -1.55 }],
    [{ name: 'Another city', type: 'city', lat: 47.22, lng: -1.55 }],
    [{ name: 'Nantes', type: 'city', lat: 47.22, lng: -1.55 }, { name: 'Nantes', type: 'city', lat: 45, lng: 4 }],
    [{ name: 'Nantes', type: 'city', lat: null, lng: -1.55 }],
    [{ name: 'Nantes', type: 'city', lat: 91, lng: -1.55 }],
  ];
  for (const results of cases) {
    const { api, store, calls, status } = setup();
    let updates = 0;
    store.searchPlaces = async () => results;
    api.mount({ cities: [unknownCity()] }, { onCitiesChange: () => updates++ });
    assert.equal(await api.locate('nantes'), false);
    assert.equal(calls.markers.length, 0);
    assert.equal(updates, 0);
    assert.equal(api.decorate([unknownCity()])[0].lat, null);
    assert.match(status.textContent, /暂未找到|同名城市/);
    api.destroy();
  }
});

test('navigating away aborts geocoding and late responses cannot update a new map or the cache', async () => {
  const { api, store, calls, status } = setup();
  let resolveSearch;
  let signal;
  let oldUpdates = 0;
  store.searchPlaces = (query, options) => {
    signal = options.signal;
    return new Promise(resolve => { resolveSearch = resolve; });
  };
  api.mount({ cities: [unknownCity()] }, { onCitiesChange: () => oldUpdates++ });
  const pending = api.locate('nantes');
  api.destroy();
  assert.equal(signal.aborted, true);
  assert.equal(calls.maps[0].removed, true);
  assert.equal(calls.listeners.size, 0);
  api.mount({ cities: [knownCity()] });
  const newStatus = status.textContent;
  resolveSearch([{ name: 'Nantes', type: 'city', lat: 47.22, lng: -1.55 }]);
  assert.equal(await pending, false);
  assert.equal(oldUpdates, 0);
  assert.equal(status.textContent, newStatus);
  assert.equal(api.decorate([unknownCity()])[0].lat, null);
  api.destroy();
});

test('decorating cities preserves source records and uses only confirmed cached coordinates', async () => {
  const { api, store } = setup();
  const cities = [knownCity(), unknownCity()];
  const before = JSON.stringify(cities);
  const decorated = api.decorate(cities);
  assert.notEqual(decorated[0], cities[0]);
  assert.equal(decorated[1].lat, null);
  store.searchPlaces = async () => [{ name: 'Nantes', type: 'town', lat: '47.22', lng: '-1.55' }];
  api.mount({ cities });
  await api.locate('nantes');
  assert.equal(api.decorate(cities)[1].lng, -1.55);
  assert.equal(JSON.stringify(cities), before);
  api.destroy();
});

test('map and lookup failures leave statistics available with a useful status message', async () => {
  const missing = setup({ withLeaflet: false });
  missing.api.mount({ cities: [knownCity()] });
  assert.match(missing.status.textContent, /地图暂时不可用.*统计.*仍可查看/);
  assert.equal(missing.calls.searches.length, 0);
  missing.api.destroy();

  const { api, calls, store, status } = setup();
  api.mount({ cities: [unknownCity()] });
  calls.tiles[0].handlers.tileerror();
  assert.match(status.textContent, /地图底图暂时无法加载.*列表仍可使用/);
  store.searchPlaces = async () => { throw new Error('Network unavailable'); };
  assert.equal(await api.locate('nantes'), false);
  assert.match(status.textContent, /暂时无法定位.*统计数据仍然保留/);
  api.destroy();
});

test('marker labels escape destination text before passing it to Leaflet HTML', () => {
  const { api, calls } = setup();
  api.mount({ cities: [{ ...knownCity(), name: '<img src=x onerror=BAD>' }] });
  assert.match(calls.markers[0].tooltip, /&lt;img/);
  assert.doesNotMatch(calls.markers[0].popup, /<img/);
  api.destroy();
});

test('marker, bounds and city focus use display projection while cached coordinates remain WGS84', async () => {
  const { api, calls, store } = setup();
  const cities = [knownCity(), { ...knownCity(), key: 'other', lat: 31, lng: 121 }, unknownCity()];
  const before = JSON.stringify(cities);
  const projectPoint = (lat, lng) => [lat + 0.01, lng + 0.02];
  api.mount({ cities }, { projectPoint });
  assert.deepEqual(Array.from(calls.markers[0].point), [30.26, 120.19]);
  assert.deepEqual(Array.from(calls.maps[0].bounds[0], point => Array.from(point)), [[30.26, 120.19], [31.01, 121.02]]);
  assert.equal(api.focus('杭州'), true);
  assert.deepEqual(Array.from(calls.maps[0].views.at(-1)), [30.26, 120.19]);
  store.searchPlaces = async () => [{ name: 'Nantes', type: 'city', lat: 47.22, lng: -1.55 }];
  await api.locate('nantes');
  assert.deepEqual(Array.from(calls.maps[0].views.at(-1)), [47.23, -1.53]);
  assert.equal(api.decorate(cities).find(city => city.key === 'nantes').lat, 47.22);
  assert.equal(JSON.stringify(cities), before);
  assert.match(calls.tiles[0].url, /autonavi\.com/);
  assert.equal(calls.tiles[0].options.maxZoom, 18);
  assert.match(calls.tiles[0].options.attribution, /高德地图/);
  api.destroy();
});

test('the map fits itinerary points across cities and zooms to the selected arrangement', () => {
  const { api, calls } = setup();
  const places = [
    { key: 'hk-point', name: '旺角', date: '2026-10-21', tripName: '港澳', lat: 22.3225, lng: 114.17, city: '香港' },
    { key: 'mo-point', name: '大三巴', date: '2026-10-22', tripName: '港澳', lat: 22.19747, lng: 113.54086, city: '澳门' },
  ];
  api.mount({ cities: [], places });
  assert.deepEqual(Array.from(calls.maps[0].bounds[0], point => Array.from(point)), [[22.3225, 114.17], [22.19747, 113.54086]]);
  assert.equal(api.focus('mo-point'), true);
  assert.deepEqual(Array.from(calls.maps[0].views.at(-1)), [22.19747, 113.54086]);
  assert.match(calls.markers[1].popup, /大三巴.*2026-10-22/);
  assert.equal(calls.markers[1].opened, true);
  api.destroy();
});

test('manual selection consumes one click and is cancelled when leaving the map', () => {
  const { api, calls, status } = setup();
  api.mount({ cities: [knownCity()] });
  const map = calls.maps[0];
  const selected = [];
  assert.equal(api.pickPoint('小巷咖啡', point => selected.push(point)), true);
  assert.match(status.textContent, /小巷咖啡/);
  const point = { lat: 30.25, lng: 120.17 };
  map.handlers.get('click')({ latlng: point });
  assert.deepEqual(selected, [point]);
  assert.equal(map.handlers.has('click'), false);
  api.pickPoint('还未选点', point => selected.push(point));
  api.destroy();
  assert.equal(map.handlers.has('click'), false);
  assert.equal(map.removed, true);
  assert.equal(selected.length, 1);
});
