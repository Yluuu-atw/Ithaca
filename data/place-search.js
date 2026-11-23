'use strict';

const ENDPOINT = 'https://photon.komoot.io/api/';
const CACHE_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 1100;
const MAX_CACHE = 500;

class PlaceSearchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cleanQuery(value) {
  if (typeof value !== 'string') throw new PlaceSearchError('请先填写地点名称');
  const query = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const minimum = /\p{Script=Han}/u.test(query) ? 2 : 3;
  if (query.length < minimum || query.length > 120) throw new PlaceSearchError('请输入完整地点名称（最多 120 个字符）');
  return query;
}

function validPoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function normalizeResults(value) {
  if (!Array.isArray(value?.features)) throw new PlaceSearchError('地点查询暂不可用', 502);
  return value.features.slice(0, 5).flatMap(entry => {
    if (entry?.geometry?.type !== 'Point' || !Array.isArray(entry.geometry.coordinates)) return [];
    const [lng, lat] = entry.geometry.coordinates;
    if (!validPoint(lat, lng)) return [];
    const info = entry.properties || {};
    const name = info.name || info.street || info.city || '';
    const address = [...new Set([info.street, info.district, info.city, info.county, info.state, info.country]
      .filter(part => typeof part === 'string' && part && part !== name))].join(' · ');
    return [{
      name: String(name).slice(0, 120),
      address: address.slice(0, 300),
      type: String(info.osm_key === 'place' ? info.osm_value || info.type : info.type || '').slice(0, 40),
      lat,
      lng,
    }];
  });
}

function createPlaceSearch({ fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map();
  const pending = new Map();
  let nextAllowed = 0;
  let chain = Promise.resolve();

  async function request(query, near) {
    const wait = Math.max(0, nextAllowed - now());
    if (wait) await sleep(wait);
    nextAllowed = now() + MIN_INTERVAL_MS;
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '5');
    if (near) {
      url.searchParams.set('lat', near.lat);
      url.searchParams.set('lon', near.lng);
    }
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'Ithaca/1.0 (+https://ithaca.xclz.tech)',
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch (_) {
      throw new PlaceSearchError('地点查询暂不可用，请稍后再试', 502);
    }
    if (!response.ok) throw new PlaceSearchError('地点查询暂不可用，请稍后再试', 502);
    try { return normalizeResults(await response.json()); }
    catch (_) { throw new PlaceSearchError('地点查询暂不可用，请稍后再试', 502); }
  }

  async function search(rawQuery, near) {
    const query = cleanQuery(rawQuery);
    const bias = validPoint(near?.lat, near?.lng) ? { lat: near.lat.toFixed(2), lng: near.lng.toFixed(2) } : null;
    const key = JSON.stringify([query.toLocaleLowerCase(), bias]);
    const found = cache.get(key);
    if (found && found.expires > now()) return Promise.resolve(found.results);
    if (pending.has(key)) return pending.get(key);
    const work = chain.then(() => request(query, bias));
    chain = work.then(() => {}, () => {});
    const settled = work.then(results => {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, { results, expires: now() + CACHE_MS });
      return results;
    }).finally(() => pending.delete(key));
    pending.set(key, settled);
    return settled;
  }

  return { search };
}

module.exports = { createPlaceSearch, PlaceSearchError, cleanQuery, normalizeResults };
