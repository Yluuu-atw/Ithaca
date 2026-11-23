'use strict';

/**
 * 足迹统计：只计算已有旅行的日期与明确填写的目的地，不把收藏或心愿单当作到访。
 * 城市点位是 GeoNames 城市中心点（WGS84），不是用户轨迹或精确到访位置。
 * Source: https://github.com/lutangar/cities.json (GeoNames extract; selected 2026-11-23)
 * License: CC BY 4.0 — https://www.geonames.org/
 */
window.Footprints = (() => {
  // [canonical name, latitude, longitude, aliases]
  const CITY_CATALOG = [
    ["北京",39.9075,116.39723,["Beijing","Peking"]],
    ["上海",31.22222,121.45806,["Shanghai"]],
    ["天津",39.14222,117.17667,["Tianjin"]],
    ["重庆",29.56026,106.55771,["Chongqing","重慶"]],
    ["石家庄",38.04139,114.47861,["Shijiazhuang","石家莊"]],
    ["太原",37.86944,112.56028,["Taiyuan"]],
    ["呼和浩特",40.81056,111.65222,["Hohhot"]],
    ["沈阳",41.79222,123.43278,["Shenyang","瀋陽"]],
    ["长春",43.88,125.32278,["Changchun","長春"]],
    ["哈尔滨",45.75,126.65,["Harbin","哈爾濱"]],
    ["南京",32.06167,118.77778,["Nanjing"]],
    ["杭州",30.29365,120.16142,["Hangzhou"]],
    ["合肥",31.86389,117.28083,["Hefei"]],
    ["福州",26.06139,119.30611,["Fuzhou"]],
    ["南昌",28.68396,115.85306,["Nanchang"]],
    ["济南",36.66833,116.99722,["Jinan","濟南"]],
    ["郑州",34.75778,113.64861,["Zhengzhou","鄭州"]],
    ["武汉",30.58333,114.26667,["Wuhan","武漢"]],
    ["长沙",28.19874,112.97087,["Changsha","長沙"]],
    ["广州",23.11667,113.25,["Guangzhou","廣州","Canton"]],
    ["南宁",22.81667,108.31667,["Nanning","南寧"]],
    ["海口",20.03421,110.34651,["Haikou"]],
    ["成都",30.66667,104.06667,["Chengdu"]],
    ["贵阳",26.58333,106.71667,["Guiyang","貴陽"]],
    ["昆明",25.03889,102.71833,["Kunming"]],
    ["拉萨",29.65,91.1,["Lhasa","拉薩"]],
    ["西安",34.25833,108.92861,["Xi’an","Xi'an","Xian"]],
    ["兰州",36.05701,103.83987,["Lanzhou","蘭州"]],
    ["西宁",36.62554,101.75739,["Xining","西寧"]],
    ["银川",38.46806,106.27306,["Yinchuan","銀川"]],
    ["乌鲁木齐",43.80096,87.60046,["Ürümqi","Urumqi","烏魯木齊"]],
    ["香港",22.27832,114.17469,["Hong Kong","Hongkong","香港特别行政区","香港特別行政區"]],
    ["澳门",22.20056,113.54611,["Macau","Macao","澳門","澳门特别行政区","澳門特別行政區"]],
    ["珠海",22.27694,113.56778,["Zhuhai"]],
    ["深圳",22.54554,114.0683,["Shenzhen"]],
    ["厦门",24.47979,118.08187,["Xiamen","廈門"]],
    ["苏州",31.30408,120.59538,["Suzhou","蘇州"]],
    ["桂林",25.28022,110.29639,["Guilin"]],
    ["三亚",18.25435,109.50947,["Sanya","三亞"]],
    ["丽江",26.86879,100.22072,["Lijiang","麗江"]],
    ["大理",25.58474,100.21229,["Dali"]],
    ["青岛",36.06488,120.38042,["Qingdao","青島"]],
    ["大连",38.91222,121.60222,["Dalian","大連"]],
    ["宁波",29.87819,121.54945,["Ningbo","寧波"]],
    ["台北",25.05306,121.52639,["Taipei","臺北"]],
    ["东京",35.6895,139.69171,["Tokyo","東京"]],
    ["大阪",34.69379,135.50107,["Osaka"]],
    ["京都",35.02107,135.75385,["Kyoto"]],
    ["首尔",37.566,126.9784,["Seoul","首爾"]],
    ["曼谷",13.75398,100.50144,["Bangkok"]],
    ["新加坡",1.28967,103.85007,["Singapore"]],
    ["吉隆坡",3.1412,101.68653,["Kuala Lumpur"]],
    ["河内",21.0245,105.84117,["Hanoi","河內"]],
    ["伦敦",51.50853,-0.12574,["London","倫敦"]],
    ["巴黎",48.85341,2.3488,["Paris"]],
    ["罗马",41.89193,12.51133,["Rome","羅馬","Roma"]],
    ["米兰",45.46427,9.18951,["Milan","米蘭","Milano"]],
    ["巴塞罗那",41.38879,2.15899,["Barcelona","巴塞羅那"]],
    ["马德里",40.4165,-3.70256,["Madrid","馬德里"]],
    ["柏林",52.52437,13.41053,["Berlin"]],
    ["阿姆斯特丹",52.37403,4.88969,["Amsterdam"]],
    ["布拉格",50.08804,14.42076,["Prague","Praha"]],
    ["维也纳",48.20849,16.37208,["Vienna","維也納","Wien"]],
    ["伊斯坦布尔",41.01384,28.94966,["Istanbul","伊斯坦布爾"]],
    ["迪拜",25.07725,55.30927,["Dubai"]],
    ["悉尼",-33.86785,151.20732,["Sydney"]],
    ["墨尔本",-37.814,144.96332,["Melbourne","墨爾本"]],
    ["纽约",40.71427,-74.00597,["New York City","New York","紐約","NYC"]],
    ["洛杉矶",34.05223,-118.24368,["Los Angeles","洛杉磯"]],
    ["旧金山",37.77493,-122.41942,["San Francisco","舊金山","三藩市"]],
    ["温哥华",49.24966,-123.11934,["Vancouver","溫哥華"]],
    ["多伦多",43.70643,-79.39864,["Toronto","多倫多"]],
  ];

  function cleanName(value) {
    return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  }

  function aliasKey(value) {
    return cleanName(value).replace(/市$/, '').replace(/\s+city$/i, '').toLocaleLowerCase();
  }

  const knownCities = new Map();
  for (const [name, lat, lng, aliases] of CITY_CATALOG) {
    const city = Object.freeze({ key: aliasKey(name), name, lat, lng });
    for (const alias of [name, ...aliases]) knownCities.set(aliasKey(alias), city);
  }

  // WGS84 points from Wikidata (CC0) and OpenStreetMap. Match exact names and listed aliases.
  const knownPlaces = new Map();
  for (const [names, city, lat, lng, source = 'wikidata'] of [
    [['旺角', 'Mong Kok', 'Mongkok'], '香港', 22.32250, 114.17056], // Q1207691
    [['中环', '中環', 'Central, Hong Kong'], '香港', 22.28194, 114.15806], // Q14767
    [['香港中文大学', '香港中文大學', 'Chinese University of Hong Kong', 'The Chinese University of Hong Kong', 'CUHK'], '香港', 22.41972, 114.20667], // Q15570
    [['太平山顶', '太平山頂', '太平山', 'Victoria Peak'], '香港', 22.27547, 114.14383], // Q17541
    [['大三巴', '大三巴牌坊', "Ruins of St. Paul's"], '澳门', 22.19747, 113.54086], // Q1551411
    [['妈阁庙', '媽閣廟', 'A-Ma Temple'], '澳门', 22.18611, 113.53114], // Q2149114
    [['疯堂斜巷', '瘋堂斜巷', 'Calçada da Igreja de S. Lázaro', 'Calçada da Igreja de São Lázaro'], '澳门', 22.1970565, 113.5449216, 'osm'], // OSM way 307195895
    [['维多利亚港', '維多利亞港', '维港', '維港', 'Victoria Harbour', 'Victoria Harbor'], '香港', 22.29, 114.17], // Q155643, harbour representative point
  ]) {
    for (const name of names) knownPlaces.set(cleanName(name).toLowerCase(), { city, lat, lng, source });
  }

  const scriptPairs = '瘋疯 維维 亞亚 灣湾 門门 體体 臺台 龍龙 鳳凤 東东 橋桥 廣广 場场 區区 園园 樓楼 環环 觀观 館馆 臨临 機机 學学 頂顶 鐵铁 灘滩 碼码 頭头 號号 聖圣 鄉乡';
  const simplified = new Map(scriptPairs.split(' ').map(pair => Array.from(pair)));
  const traditional = new Map([...simplified].map(([from, to]) => [to, from]));
  const convertScript = (value, pairs) => Array.from(value, char => pairs.get(char) || char).join('');
  const placeNameKey = value => convertScript(cleanName(value), simplified)
    .normalize('NFKD').toLowerCase().replace(/[\s\p{P}\p{M}]/gu, '');

  function nearbySearchTerm(name) {
    return cleanName(name).replace(/(?:的)?(?:旁边|旁邊|旁|附近|斜对面|斜對面|对面|對面|门口|門口|入口|出口)(?:的.*|[\s\p{P}].*|\p{Script=Han}.*)?$/u, '').trim();
  }

  function itinerarySearchQueries(name, areas) {
    const original = cleanName(name);
    const base = nearbySearchTerm(original) || original;
    const simple = convertScript(base, simplified);
    const alternate = simple === base ? convertScript(base, traditional) : simple;
    const scoped = areas.length === 1 && !placeNameKey(base).includes(placeNameKey(areas[0].name))
      ? `${areas[0].name} ${base}` : '';
    return [...new Set([original, base, alternate, scoped].filter(query =>
      query.length >= (/\p{Script=Han}/u.test(query) ? 2 : 3) && query.length <= 120
    ))].slice(0, 3);
  }

  function isCityFallback(item) {
    return item?.locationMap?.mode === 'nearby' && /[（(]城市中心[）)]\s*$/.test(item.locationMap.name || '');
  }

  function coordinates(record) {
    const value = raw => typeof raw === 'number' || typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    const lat = value(record?.lat);
    const lng = value(record?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng } : null;
  }

  function itineraryPlaceName(item) {
    const title = cleanName(item.title);
    const name = cleanName(item.location);
    if (name) return name;
    if (coordinates(item) || ['景点', '餐饮', '住宿'].includes(item.category)
      || knownPlaces.has(title.toLowerCase()) || resolveKnownCity(title)) return title;
    return '';
  }

  function itineraryLocationIndex(trip) {
    const days = (trip.itinerary || []).filter(day => Array.isArray(day?.items));
    const saved = new Map();
    const substituteIds = new Set(days.flatMap(day => day.items)
      .filter(item => item?.locationMap?.mode === 'nearby').map(item => item.id));
    for (const record of [...days.flatMap(day => day.items), ...(trip.places || []), ...(trip.expenses || [])]) {
      if (record?.locationMap?.mode || substituteIds.has(record?.itemId)) continue;
      const name = cleanName(record?.location || record?.name || record?.title).toLowerCase();
      const point = coordinates(record);
      if (!name || !point) continue;
      if (!saved.has(name)) saved.set(name, new Map());
      saved.get(name).set(`${point.lat.toFixed(5)},${point.lng.toFixed(5)}`, point);
    }
    return saved;
  }

  function matchStoredLocation(name, index) {
    const key = cleanName(name).toLowerCase();
    const known = knownPlaces.get(key);
    const city = resolveKnownCity(name);
    const matches = index.get(key);
    if (matches?.size === 1) return matches.values().next().value;
    if (matches?.size) return null;
    if (known) return { ...known };
    if (city) return { lat: city.lat, lng: city.lng, source: 'city' };
    return null;
  }

  function itinerarySearchAreas(trip, dayId, name) {
    const areas = new Map();
    const add = label => {
      const city = resolveKnownCity(label);
      if (city) areas.set(city.key, city);
    };
    const day = (trip.itinerary || []).find(entry => entry?.id === dayId);
    for (const item of day?.items || []) {
      if (!item) continue;
      const label = itineraryPlaceName(item);
      add(knownPlaces.get(label.toLowerCase())?.city || label);
    }
    if (!areas.size) {
      for (const label of String(trip.meta?.destination || '').split(/[、，,/;；|\n\r]+/)) add(label);
    }
    // An explicitly named region takes precedence over the current day's plans.
    const explicit = ['香港', '澳门', '澳門', '珠海', '深圳'].filter(region => name.includes(region));
    if (explicit.length) return [...new Map(explicit.map(region => {
      const city = resolveKnownCity(region);
      return [city.key, city];
    })).values()];
    return Array.from(areas.values());
  }

  function itineraryReferencePoint(trip, dayId, name, index) {
    const day = (trip.itinerary || []).find(entry => entry?.id === dayId);
    const base = nearbySearchTerm(name);
    if (base === cleanName(name) || base.length < 2 || resolveKnownCity(base)) return null;
    const label = (day?.items || []).filter(item => item && !item.locationMap?.mode)
      .map(itineraryPlaceName).find(label => placeNameKey(label) === placeNameKey(base)) || base;
    const point = matchStoredLocation(label, index);
    return point ? { ...point, name: label } : null;
  }

  function placeDistance(a, b) {
    const longitude = Math.abs(a.lng - b.lng);
    return Math.hypot(a.lat - b.lat, Math.min(longitude, 360 - longitude) * Math.cos(b.lat * Math.PI / 180)) * 111;
  }

  function singleTypo(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a.length > b.length) [a, b] = [b, a];
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i + (a.length === b.length ? 1 : 0)) === b.slice(i + 1);
  }

  function selectItineraryMatch(name, results, areas, reference) {
    const names = value => {
      const full = cleanName(value);
      const bilingual = /^(\p{Script=Han}[\p{Script=Han}\s]+?)\s+([\p{Script=Latin}].*)$/u.exec(full);
      return [placeNameKey(full), ...(bilingual ? [placeNameKey(bilingual[1]), placeNameKey(bilingual[2])] : [])].filter(Boolean);
    };
    const key = placeNameKey(name);
    const base = nearbySearchTerm(name);
    const stem = placeNameKey(base || name);
    const local = results.filter(result => coordinates(result) && cleanName(result.name)
      && (!areas.length || areas.some(area => placeDistance(result, area) <= 35) || reference && placeDistance(result, reference) <= 1));
    const exact = local.filter(candidate => names(candidate.name).includes(key));
    // Only combine duplicate records that describe the same small area.
    if (exact.length && exact.every(candidate => placeDistance(candidate, exact[0]) <= 0.5)) return { exact: exact[0] };
    if (reference) return { nearby: reference };
    if (!areas.length || exact.length > 1) return {};

    const scoreName = candidateKey => {
      if (candidateKey === stem) return 3;
      const shorter = Math.min(candidateKey.length, stem.length);
      const longer = Math.max(candidateKey.length, stem.length);
      if (shorter >= 3 && shorter / longer >= 0.6 && (candidateKey.includes(stem) || stem.includes(candidateKey))) return 2;
      if (shorter >= (/\p{Script=Han}/u.test(base) ? 4 : 7) && singleTypo(candidateKey, stem)) return 1;
      return 0;
    };
    const matching = local.filter(candidate => !resolveKnownCity(candidate.name)
      && !['country', 'state', 'city', 'town', 'municipality', 'county', 'district', 'locality'].includes(candidate.type))
      .map(candidate => {
        const addressMatch = stem.length >= 3 && String(candidate.address || '').split(' · ')
          .some(part => names(part).includes(stem));
        return { candidate, score: Math.max(addressMatch ? 2 : 0, ...names(candidate.name).map(scoreName)) };
      })
      .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
    const best = matching[0];
    if (best && matching.every(entry => entry.score < best.score || placeDistance(entry.candidate, best.candidate) <= 0.5)) {
      return { nearby: best.candidate };
    }
    return {};
  }

  function itineraryPlaces(trip, cutoff) {
    const days = (trip.itinerary || []).filter(day => Array.isArray(day?.items));
    const saved = itineraryLocationIndex(trip);
    const points = [];
    for (const day of days) {
      for (const item of day.items) {
        if (!item) continue;
        const date = isValidDate(item.startDate) ? item.startDate : day.date;
        const pending = item.locationMap?.mode === 'pending';
        const planned = !isValidDate(date) || date > cutoff;
        if (planned && !pending) continue;
        const name = itineraryPlaceName(item);
        if (!name) continue;
        const key = name.toLowerCase();
        const known = knownPlaces.get(key);
        const namedCity = resolveKnownCity(name);
        const legacy = isCityFallback(item);
        const mode = legacy ? undefined : item.locationMap?.mode;
        const point = mode === 'hidden' || pending ? null : (!legacy && coordinates(item)) || matchStoredLocation(name, saved);
        const area = known || (namedCity && { ...namedCity, city: namedCity.name });
        points.push({
          key: JSON.stringify([trip.id, day.id, item.id]),
          name, date: date || '', tripId: trip.id, dayId: day.id, itemId: item.id,
          tripName: trip.meta?.tripName || '未命名旅行',
          city: area && point && Math.abs(area.lat - point.lat) < 0.15 && Math.abs(area.lng - point.lng) < 0.15 ? area.city : '',
          lat: point?.lat ?? null, lng: point?.lng ?? null,
          source: (!legacy && item.locationMap?.source) || point?.source
            || (point && namedCity && point.lat === namedCity.lat && point.lng === namedCity.lng ? 'city' : ''),
          mode, planned, nearbyName: mode === 'nearby' ? item.locationMap.name : '',
        });
      }
    }
    return points;
  }

  function resolveKnownCity(value) {
    const city = knownCities.get(aliasKey(value));
    return city ? { ...city } : null;
  }

  function normalizeCityName(value) {
    const clean = cleanName(value);
    const known = knownCities.get(aliasKey(clean));
    return known ? known.name : clean;
  }

  function cityKey(value) {
    return aliasKey(normalizeCityName(value));
  }

  function isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1];
  }

  function localToday() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  // Date.UTC treats years 0–99 as 1900–1999; setUTCFullYear preserves the parsed year.
  function ordinal(value) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime() / 86400000;
  }

  function tripRange(trip) {
    const meta = trip.meta || {};
    const dates = (Array.isArray(trip.itinerary) ? trip.itinerary : [])
      .map(day => day && day.date).filter(isValidDate).sort();
    const start = isValidDate(meta.startDate) ? meta.startDate : dates[0] || '';
    const end = isValidDate(meta.endDate) ? meta.endDate : dates[dates.length - 1] || start;
    return { start, end };
  }

  function summarize(trips, options = {}) {
    const today = isValidDate(options.today) ? options.today : localToday();
    const result = { tripCount: 0, dayCount: 0, cities: [], places: [], undatedCount: 0, futureCount: 0, invalidDateCount: 0, ongoingCount: 0 };
    const ranges = [];
    const cities = new Map();
    const seenTrips = new Set();
    for (const trip of Array.isArray(trips) ? trips : []) {
      if (!trip || typeof trip !== 'object' || Array.isArray(trip)) continue;
      const id = typeof trip.id === 'string' ? trip.id : '';
      if (id && seenTrips.has(id)) continue;
      if (id) seenTrips.add(id);
      const { start, end } = tripRange(trip);
      const visited = start && end >= start && start <= today && (!options.completedOnly || end <= today);
      const places = itineraryPlaces(trip, visited ? today : '');
      result.places.push(...places);
      if (!start) { result.undatedCount += 1; continue; }
      if (end < start) { result.invalidDateCount += 1; continue; }
      if (start > today) { result.futureCount += 1; continue; }
      if (end > today) {
        result.ongoingCount += 1;
        if (options.completedOnly) continue;
      }
      const elapsedEnd = end > today ? today : end;
      result.tripCount += 1;
      ranges.push([ordinal(start), ordinal(elapsedEnd)]);
      const destination = trip.meta && trip.meta.destination;
      const names = typeof destination === 'string' ? destination.split(/[、，,\/;；|\n\r]+/) : [];
      names.push(...places.map(place => place.city).filter(Boolean));
      const seenNames = new Set();
      for (const value of names) {
        const name = normalizeCityName(value);
        const key = cityKey(name);
        if (!name || !key || seenNames.has(key)) continue;
        seenNames.add(key);
        if (!cities.has(key)) {
          const known = resolveKnownCity(name);
          cities.set(key, { key, name, lat: known ? known.lat : null, lng: known ? known.lng : null, tripIds: [], visits: 0, lastDate: '' });
        }
        const city = cities.get(key);
        city.visits += 1;
        if (id) city.tripIds.push(id);
        if (elapsedEnd > city.lastDate) city.lastDate = elapsedEnd;
      }
    }

    // Merge ranges without enumerating dates; overlapping travels count each calendar day once.
    ranges.sort((a, b) => a[0] - b[0]);
    let merged = null;
    for (const range of ranges) {
      if (!merged) merged = range.slice();
      else if (range[0] <= merged[1] + 1) merged[1] = Math.max(merged[1], range[1]);
      else { result.dayCount += merged[1] - merged[0] + 1; merged = range.slice(); }
    }
    if (merged) result.dayCount += merged[1] - merged[0] + 1;
    result.cities = Array.from(cities.values()).sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));
    result.places.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
    return result;
  }

  return {
    summarize, normalizeCityName, cityKey, resolveKnownCity, isValidDate, itineraryPlaceName, coordinates,
    itineraryLocationIndex, matchStoredLocation, itinerarySearchAreas, itineraryReferencePoint, selectItineraryMatch,
    itinerarySearchQueries, isCityFallback,
  };
})();
