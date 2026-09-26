'use strict';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
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
  if (query.length < 3 || query.length > 120) throw new PlaceSearchError('地点名称需为 3–120 个字符');
  return query;
}

function normalizeResults(value) {
  if (!Array.isArray(value)) throw new PlaceSearchError('地点查询暂不可用', 502);
  return value.slice(0, 5).flatMap(entry => {
    const lat = Number(entry.lat);
    const lng = Number(entry.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
    return [{
      name: String(entry.name || '').slice(0, 120),
      address: String(entry.display_name || '').slice(0, 300),
      type: String(entry.addresstype || entry.type || '').slice(0, 40),
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

  async function request(query) {
    const wait = Math.max(0, nextAllowed - now());
    if (wait) await sleep(wait);
    nextAllowed = now() + MIN_INTERVAL_MS;
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '0');
    url.searchParams.set('limit', '5');
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'Ithaca/1.0 (+https://ithaca.xclz.tech)',
          'Accept-Language': 'zh-CN,zh,en',
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

  async function search(rawQuery) {
    const query = cleanQuery(rawQuery);
    const key = query.toLocaleLowerCase();
    const found = cache.get(key);
    if (found && found.expires > now()) return Promise.resolve(found.results);
    if (pending.has(key)) return pending.get(key);
    const work = chain.then(() => request(query));
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
