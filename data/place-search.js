'use strict';

const ENDPOINT = 'https://photon.komoot.io/api/';
const DINING_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const CACHE_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 1100;
const MAX_CACHE = 500;
const DINING_NAMES = {
  indian: ['印度', '旁遮普'], japanese: ['日本', '日式'], korean: ['韩国', '韓國', '韓式', '韩式'],
  thai: ['泰国', '泰國', '泰式'], vietnamese: ['越南'], italian: ['意大利', '義大利', '義式'],
  french: ['法国', '法國', '法式'], mexican: ['墨西哥'], sichuan: ['川菜', '四川'], cantonese: ['粤菜', '粵菜'],
  dim_sum: ['点心', '點心', '早茶'], sushi: ['寿司', '壽司'], ramen: ['拉面', '拉麵', '拉麺'], pizza: ['披萨', '披薩', '比薩'],
};

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
    const dining = typeof info.name === 'string' && info.name.trim() &&
      info.osm_key === 'amenity' && ['restaurant', 'fast_food', 'cafe'].includes(info.osm_value);
    return [{
      name: String(name).slice(0, 120),
      address: address.slice(0, 300),
      type: String(info.osm_key === 'place' ? info.osm_value || info.type : info.type || '').slice(0, 40),
      lat,
      lng,
      ...(dining ? { dining: true } : {}),
    }];
  });
}

function diningResults(body, near) {
  if (!Array.isArray(body?.elements)) throw new PlaceSearchError('餐厅查询暂不可用', 502);
  return body.elements.flatMap(entry => {
    const t = entry.tags || {};
    const { lat, lon: lng } = entry.center || entry;
    const name = t['name:zh-Hans'] || t['name:zh'] || t.name;
    if (!validPoint(lat, lng) || typeof name !== 'string' || !name.trim()) return [];
    const address = [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean).join(' ');
    return [{ name: name.slice(0, 120), address: address.slice(0, 220), lat, lng, dining: true }];
  }).sort((a, b) => {
    const score = place => (place.lat - near.lat) ** 2
      + ((place.lng - near.lng) * Math.cos(near.lat * Math.PI / 180)) ** 2;
    return score(a) - score(b);
  }).slice(0, 8);
}

function createPlaceSearch({ fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map();
  const pending = new Map();
  let nextAllowed = 0;
  let chain = Promise.resolve();

  async function request(url, normalize, timeout = 8000) {
    const wait = Math.max(0, nextAllowed - now());
    if (wait) await sleep(wait);
    nextAllowed = now() + MIN_INTERVAL_MS;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'Ithaca/1.0 (+https://ithaca.xclz.tech)',
        },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (_) {
      throw new PlaceSearchError('地点查询暂不可用，请稍后再试', 502);
    }
    if (!response.ok) throw new PlaceSearchError('地点查询暂不可用，请稍后再试', 502);
    try { return normalize(await response.json()); }
    catch (_) { throw new PlaceSearchError('地点查询暂不可用，请稍后再试', 502); }
  }

  function cached(key, fetchResults) {
    const found = cache.get(key);
    if (found && found.expires > now()) return Promise.resolve(found.results);
    if (pending.has(key)) return pending.get(key);
    const work = chain.then(fetchResults);
    chain = work.then(() => {}, () => {});
    const settled = work.then(results => {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, { results, expires: now() + CACHE_MS });
      return results;
    }).finally(() => pending.delete(key));
    pending.set(key, settled);
    return settled;
  }

  async function search(rawQuery, near) {
    const query = cleanQuery(rawQuery);
    const bias = validPoint(near?.lat, near?.lng) ? { lat: near.lat.toFixed(2), lng: near.lng.toFixed(2) } : null;
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '5');
    if (bias) {
      url.searchParams.set('lat', bias.lat);
      url.searchParams.set('lon', bias.lng);
    }
    return cached(JSON.stringify([query.toLocaleLowerCase(), bias]), () => request(url, normalizeResults));
  }

  async function searchDining(rawQuery, near, cuisine) {
    const query = cleanQuery(rawQuery);
    if ((cuisine !== undefined && (typeof cuisine !== 'string' || !Object.hasOwn(DINING_NAMES, cuisine)))
      || !validPoint(near?.lat, near?.lng)) {
      throw new PlaceSearchError('请选择有效的菜系和游览区域');
    }
    const point = { lat: Number(near.lat.toFixed(2)), lng: Number(near.lng.toFixed(2)) };
    const roastGoose = /^(?:烧鹅|燒鵝|roast goose)$/iu.test(query);
    const searchTerm = cuisine ? cuisine.replaceAll('_', ' ') : roastGoose ? '燒鵝' : query;
    const names = [searchTerm, ...(cuisine ? DINING_NAMES[cuisine] : []), ...(roastGoose ? ['烧鹅', 'roast goose', 'roasted goose'] : [])]
      .map(name => name.toLowerCase());
    return cached(JSON.stringify(['dining', searchTerm.toLowerCase(), cuisine, point]), async () => {
      const photon = new URL(ENDPOINT);
      const span = Math.min(1, .045 / Math.max(.001, Math.cos(point.lat * Math.PI / 180)));
      photon.searchParams.set('q', searchTerm);
      photon.searchParams.set('limit', '5');
      photon.searchParams.set('lat', point.lat);
      photon.searchParams.set('lon', point.lng);
      photon.searchParams.set('bbox', [Math.max(-180, point.lng - span), Math.max(-90, point.lat - .045),
        Math.min(180, point.lng + span), Math.min(90, point.lat + .045)].join(','));
      photon.searchParams.append('osm_tag', 'amenity:restaurant');
      photon.searchParams.append('osm_tag', 'amenity:fast_food');
      try {
        const places = await request(photon, normalizeResults, 3200);
        const matches = places.filter(place => place.dining && names.some(name => place.name.toLowerCase().includes(name)));
        if (matches.length || !cuisine) return matches;
      } catch (error) {
        if (!cuisine) throw error;
      }
      const url = new URL(DINING_ENDPOINT);
      url.searchParams.set('data', `[out:json][timeout:4];nwr(around:4500,${point.lat},${point.lng})`
        + '["amenity"~"^(restaurant|fast_food|cafe)$"]["name"]'
        + `["cuisine"~"(^|;) *${cuisine} *(;|$)",i];out center 80;`);
      return request(url, body => diningResults(body, point), 5500);
    });
  }

  return { search, searchDining };
}

module.exports = { createPlaceSearch, PlaceSearchError, cleanQuery, normalizeResults };
