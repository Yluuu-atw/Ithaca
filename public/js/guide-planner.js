'use strict';

window.GuidePlanner = (() => {
  const DAY_MS = 86400000;
  const MAX_STOPS = 12;
  const MAX_DAYS = 14;
  const MEAL = '餐饮';
  const SLOTS = [
    { start: 8 * 60 + 30, end: 10 * 60 + 30, meal: 'breakfast' },
    { start: 9 * 60, end: 12 * 60 },
    { start: 11 * 60 + 30, end: 14 * 60, meal: 'lunch' },
    { start: 14 * 60, end: 16 * 60 },
    { start: 16 * 60, end: 18 * 60 + 30 },
    { start: 18 * 60, end: 21 * 60, meal: 'dinner' },
  ];
  const ROUTE_OPTIONS = [
    { id: 'balanced', label: '步行＋地铁', description: '默认方案。附近步行，远一点搭地铁，地铁覆盖不到时用公交接驳。', walkingKm: 1.25 },
    { id: 'relaxed', label: '步行优先', description: '把同一片区的景点连起来走，每站多留一点时间，跨区再搭地铁或公交。', walkingKm: 2, later: 15, extraVisit: 10 },
    { id: 'transit', label: '地铁优先', description: '较短的跨站路段也优先搭地铁，步行主要用来进站和到达景点。', walkingKm: .65, earlier: 15 },
  ];
  const MTR_FARES = 'https://www.mtr.com.hk/en/customer/tickets/octopus_fares.html';
  const MTR_MAP = 'https://www.mtr.com.hk/en/customer/services/system_map.html';
  const BRIDGE_FARES = 'https://www.td.gov.hk/tc/transport_in_hong_kong/land_based_cross_boundary_transport/access_to_hzmb_hong_kong_port/';
  const MTR_STATIONS = {
    central: { name: '中环站', line: '荃湾线', exit: 'C', arrival: '步行到中环街市的德辅道中入口。' },
    mongkok: { name: '旺角站', line: '荃湾线', exit: 'D3', arrival: '走到通菜街的女人街路段开始游览。' },
    tsimshatsui: { name: '尖沙咀站', line: '荃湾线', exit: 'B2', arrival: '往尖东方向走到科学馆道 2 号。' },
    university: { name: '大学站', line: '东铁线', exit: 'A', arrival: '从校园入口沿步道前往未圆湖。' },
    hunghom: { name: '红磡站', line: '东铁线', exit: 'D1', arrival: '步行前往香港科学馆。' },
    admiralty: { name: '金钟站' },
    kowloontong: { name: '九龙塘站' },
  };
  const WALK_GUIDES = [
    {
      names: /^(?:香港科[学學][馆館]|hongkongsciencemuseum)$/iu,
      areas: /香港|hong\s*kong|尖沙咀|尖东|尖東|九龍|九龙|港澳/iu,
      point: { lat: 22.301, lng: 114.177 }, area: 'HK',
      station: 'tsimshatsui',
      source: ['香港科学馆 · 交通地图', 'https://hk.science.museum/documents/map/HKScM_Location-Map.pdf'],
    },
    {
      names: /^(?:香港)?(?:旺角|旺角市集|mongkok)$/iu,
      areas: /香港|hong\s*kong|九龍|九龙|kowloon|旺角|港澳/iu,
      point: { lat: 22.320, lng: 114.170 }, duration: 90, area: 'HK',
      station: 'mongkok',
      steps: [
        ['女人街', '通菜街南段的摊档密集，适合逛街和尝鸡蛋仔、鱼蛋。横街人多，想慢慢看可以先挑一侧走。'],
        ['金鱼街', '通菜街北段聚集了不少水族铺，可以看看门外的观赏鱼、旧楼和招牌。拍店内陈列前先问店家。'],
        ['花墟道', '在太子一带逛花店、盆栽铺和园艺小店。这里适合街拍，逛完可以从太子站离开。'],
      ],
      source: ['香港旅发局 · 金鱼街与旺角市集', 'https://www.discoverhongkong.com/tc/place-to-go/travel.guide-goldfish-market.html'],
    },
    {
      names: /^(?:香港)?(?:中[环環]|中[环環]老城[区區]|central|oldtowncentral)$/iu,
      areas: /香港|hong\s*kong|港岛|港島|hong\s*kong\s*island|中[环環]|港澳/iu,
      point: { lat: 22.282, lng: 114.155 }, duration: 90, area: 'HK',
      station: 'central',
      steps: [
        ['中环街市', '看看活化后保留的楼梯和建筑细节。附近有通往半山扶梯的行人通道，适合衔接荷李活道。'],
        ['半山扶梯', '在扶梯一带观察高低错落的街道和楼梯。要去大馆，可以沿通道往荷李活道方向走。'],
        ['大馆', '先看旧警署建筑和庭院，有余力再选一处旧监狱展区或感兴趣的展览。'],
        ['砵甸乍街', '在石板街看看花岗岩阶梯和街景。下雨或推行李可以走旁边较平缓的路。'],
      ],
      source: ['香港旅发局 · 中环漫步', 'https://www.discoverhongkong.com/tc/tours/stroll-central.html'],
    },
    {
      names: /^(?:香港中文大[学學]|港中大|cuhk|thechineseuniversityofhongkong)$/iu,
      areas: /香港|hong\s*kong|沙田|sha\s*tin|港澳/iu,
      point: { lat: 22.420, lng: 114.207 }, duration: 105, area: 'HK',
      station: 'university',
      steps: [
        ['未圆湖', '湖在崇基学院的山脚一带，可以沿湖慢走，兼看校园的绿荫和坡地。'],
        ['崇基学院礼拜堂', '留一点时间看礼拜堂外观。附近步道可接往本部的上坡路线，出发前可对照校方步行地图。'],
        ['百万大道', '在大学图书馆外看校园主轴，也可以按体力决定是否下山。进入馆舍前先核对访客要求。'],
      ],
      source: ['香港中文大学 · 校园路线与访客资讯', 'https://www.cuhk.edu.hk/chinese/university/visitors.html'],
      routeSource: ['香港中文大学 · 校园步行地图', 'https://www.scu.cuhk.edu.hk/wp-content/uploads/useful-information/Campus-Map-Walking-Routes-Aug-2025.pdf'],
    },
    {
      names: /^(?:澳[门門])?(?:大三巴(?:牌坊)?|[历歷]史城[区區]|historiccentreofmaca[ou]|ruinsofstpauls)$/iu,
      areas: /澳[门門]|maca[ou]|港澳/iu,
      point: { lat: 22.197, lng: 113.541 }, duration: 90, area: 'MO',
      arrival: '新马路议事亭前地附近',
      steps: [
        ['议事亭前地', '在广场留意脚下的波浪纹路和周边建筑，沿相连的步行街可以逛到玫瑰堂。'],
        ['玫瑰堂', '在街巷口看看教堂立面，可以顺路经过教堂附近的广场和店铺。'],
        ['大三巴牌坊', '从石阶底部看牌坊全景，再上台阶观察立面雕刻。人多时可先在广场侧边停一会儿。'],
        ['哪吒庙与旧城墙', '两处都在牌坊旁，适合停下来看看各时期的建筑怎样紧邻在一起。', '哪吒庙'],
        ['大炮台', '从炮台俯瞰屋顶和街巷。路上坡道和台阶较多，可以按体力决定留多久。'],
      ],
      source: ['澳门旅游局 · 历史城区步行手册', 'https://content.macaotourism.gov.mo/uploads/mgto_brochures/b526a854a7a0151c21c2cf64cb04b662d445e1c6.pdf'],
    },
  ];
  const DINING_GUIDES = [
    {
      request: /印度|旁遮普|indian|punjabi/iu,
      name: 'New Punjab Club',
      preferredMeal: 'dinner',
      station: 'central',
      address: '香港中环云咸街 34 号，环球商业大厦地下',
      area: { lat: 22.280, lng: 114.155 },
      source: ['餐厅官网 · 菜单与订位', 'https://www.newpunjabclub.com/home-tc'],
      tips: [
        ['为什么选这家', '店在中环云咸街，适合接在中环街市、大馆一带的行程后。店内以旁遮普料理为主，可以一次尝到坦都烤炉菜和咖喱。'],
        ['可以怎么点', '可以用萨莫萨酸辣小食开胃，再选坦都烤肉或奶油鸡配印度面饼。介意辣度可以点单时询问，出发前通过官网看当日餐期并订位。'],
      ],
    },
    {
      request: /烧鹅|燒鵝|roast\s+goose/iu,
      name: '一乐烧鹅',
      preferredMeal: 'lunch',
      station: 'central',
      budget: { currency: 'HKD', min: 80, max: 160 },
      address: '香港中环士丹利街 34–38 号金禾大厦地下',
      area: { lat: 22.283, lng: 114.155 },
      source: ['香港旅发局 · 一乐烧鹅', 'https://www.discoverhongkong.com/tc/place-to-go/travel.guide-yat-lok-restaurant.html'],
      tips: [
        ['为什么选这家', '中环士丹利街的粤式烧味店，招牌是皮脆多汁的烧鹅。从中环街市或半山扶梯一带过来，可以接在街区步行之后。'],
        ['可以怎么点', '想简单吃一餐可点烧鹅配濑粉；同行人多可问店员能否按份切鹅，再加一份叉烧或脆皮烧肉分着尝。用餐时间记得预留排队余量。'],
      ],
    },
  ];
  const CUISINES = [
    [/印度|旁遮普|indian|punjabi/iu, 'indian'], [/日本|日料|japanese/iu, 'japanese'],
    [/韩国|韓國|韩餐|korean/iu, 'korean'], [/泰国|泰國|泰餐|thai/iu, 'thai'],
    [/越南|vietnamese/iu, 'vietnamese'], [/意大利|義大利|italian/iu, 'italian'],
    [/法国|法國|french/iu, 'french'], [/墨西哥|mexican/iu, 'mexican'],
    [/川菜|四川菜|sichuan/iu, 'sichuan'], [/粤菜|粵菜|cantonese/iu, 'cantonese'],
    [/早茶|点心|點心|dim\s*sum/iu, 'dim_sum'], [/寿司|壽司|sushi/iu, 'sushi'],
    [/拉面|拉麵|ramen/iu, 'ramen'], [/披萨|披薩|pizza/iu, 'pizza'],
  ];

  const asText = value => String(value ?? '').trim();
  const nameKey = value => asText(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const dateStamp = date => Date.parse(date + 'T00:00:00Z');
  const dateAt = stamp => new Date(stamp).toISOString().slice(0, 10);
  const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

  function minutesAt(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || '');
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function dateRange(start, end) {
    if (!Footprints.isValidDate(start) || !Footprints.isValidDate(end) || start > end) {
      throw new Error('请填写有效的起止日期');
    }
    const first = dateStamp(start), last = dateStamp(end);
    if (last - first >= MAX_DAYS * DAY_MS) throw new Error(`一次可安排最多 ${MAX_DAYS} 天，请缩小日期范围`);
    return Array.from({ length: (last - first) / DAY_MS + 1 }, (_, index) => dateAt(first + index * DAY_MS));
  }

  function defaultDates(trip, today) {
    const days = (trip.itinerary || []).map(day => day?.date).filter(Footprints.isValidDate).sort();
    const tripStart = Footprints.isValidDate(trip.meta?.startDate) ? trip.meta.startDate : days[0] || today;
    const end = Footprints.isValidDate(trip.meta?.endDate) ? trip.meta.endDate : days.at(-1) || tripStart;
    const start = tripStart <= today && today <= end ? today : tripStart;
    return { start, end: dateAt(Math.max(dateStamp(start), Math.min(dateStamp(end), dateStamp(start) + (MAX_DAYS - 1) * DAY_MS))) };
  }

  function savedChoices(trip) {
    return [...(trip.places || []).map(place => ({
      id: `place:${place.id}`, name: asText(place.name || place.location), category: place.category,
      point: Footprints.coordinates(place), address: asText(place.location), label: '收藏地点',
      budget: Number(place.cost) > 0 ? { currency: trip.meta.currency, min: Number(place.cost), max: Number(place.cost) } : null,
    })), ...(trip.wishlist || []).filter(wish => wish.status !== '已完成').map(wish => ({
      id: `wish:${wish.id}`, name: asText(wish.name || wish.location), address: asText(wish.location),
      category: '景点', point: Footprints.coordinates(wish), label: '心愿单',
    }))].filter(choice => choice.name);
  }

  function collectStops(input, chosen = []) {
    const stops = new Map();
    const add = stop => {
      const name = asText(stop.name).slice(0, 100);
      if (!name) return;
      const key = nameKey(name);
      const previous = stops.get(key);
      if (!previous || stop.point && !previous.point) stops.set(key, { ...stop, name });
    };
    let category = '景点';
    const mealCue = /^(?:(?:还|也|顺便)?(?:想|要)?(?:吃|喝|尝尝)|美食[:：]|餐饮[:：])\s*/u;
    const placeCue = /^(?:(?:还|也)?(?:想|要)(?:去|逛|看)|去逛|打卡|景点[:：])\s*/u;
    const parts = asText(input).replace(/(还想吃|还想去|想去|想逛|想看|想吃|想喝|顺便吃|美食[:：]|餐饮[:：]|景点[:：])/gu, '\n$1')
      .split(/[、，,；;。\n\r]+/u);
    for (let name of parts) {
      name = name.trim().replace(/^(?:我(?:们)?|然后|另外)\s*(?=想|要|还|也|去|吃)/u, '');
      if (/^(?:我|我们|然后|另外)$/u.test(name)) continue;
      if (mealCue.test(name)) { category = MEAL; name = name.replace(mealCue, ''); }
      if (placeCue.test(name)) { category = '景点'; name = name.replace(placeCue, ''); }
      add({ name: name.replace(/^[:：\s]+|[。！？?!\s]+$/gu, ''), category });
    }
    chosen.forEach(add);
    if (!stops.size) throw new Error('请先填写想去、想吃的内容，或勾选已收藏的地点');
    if (stops.size > MAX_STOPS) throw new Error(`一次最多规划 ${MAX_STOPS} 站，请分批生成`);
    return [...stops.values()];
  }

  async function resolveStops(stops, trip, destination, search, update, signal) {
    const scope = { ...trip, meta: { ...trip.meta, destination } };
    const known = Footprints.itineraryLocationIndex(trip);
    const result = [];
    for (const [index, stop] of stops.entries()) {
      update(index + 1, stops.length);
      const stored = Footprints.matchStoredLocation(stop.name, known);
      const point = stop.point || (stored?.source !== 'city' ? Footprints.coordinates(stored) : null);
      if (point) {
        result.push({ ...stop, point, verified: stop.point ? 'saved' : stored.source || 'saved' });
        continue;
      }
      let found;
      if (stop.category !== MEAL && !signal.aborted) {
        const areas = Footprints.itinerarySearchAreas(scope, '', stop.name);
        const [name] = Footprints.itinerarySearchQueries(stop.name, areas);
        const near = areas.length === 1 ? Footprints.coordinates(areas[0]) : undefined;
        if (name) {
          const placeHint = stop.address || (!areas.length && !/[、，,；;]/u.test(destination) ? destination : '');
          const query = placeHint && !name.includes(placeHint) ? `${name} ${placeHint}`.slice(0, 120) : name;
          try {
            const matches = await search(query, { tripId: trip.id, near, signal });
            found = Footprints.selectItineraryMatch(stop.name, matches, areas).exact;
          } catch (_) { /* The draft can still be edited and saved with a location name. */ }
        }
      }
      result.push(found ? { ...stop, point: Footprints.coordinates(found), address: found.address, verified: 'osm' }
        : { ...stop, point: null, verified: '' });
    }
    return result;
  }

  function distance(a, b) {
    if (!a?.point || !b?.point) return null;
    const rad = Math.PI / 180;
    const dLat = (b.point.lat - a.point.lat) * rad;
    const dLng = (b.point.lng - a.point.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.point.lat * rad) * Math.cos(b.point.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function visitGuide(stop, destination) {
    if (stop.category === MEAL) return null;
    return WALK_GUIDES.find(guide => guide.names.test(nameKey(stop.name))
      && (stop.point ? distance(stop, guide) <= 12 : guide.areas.test(`${stop.address || ''} ${destination}`))) || null;
  }

  async function resolveEntrances(stops, tripId, search, signal) {
    const candidates = stops.filter(stop => stop.category === '景点' && stop.point && !stop.visit).slice(0, 3);
    const entrances = new Map();
    const gateName = /正门|正門|主入口|大门|大門|[东西南北東西南北]门|[东西南北東西南北]門|入口|entrance|\bgate\b/iu;
    for (const stop of candidates) {
      if (signal.aborted) break;
      const venue = nameKey(stop.name);
      const suffix = /\p{Script=Han}/u.test(stop.name) ? '入口' : 'entrance';
      try {
        const matches = await search(`${stop.name} ${suffix}`.slice(0, 120), { tripId, near: stop.point, signal });
        const nearby = matches.flatMap(match => {
          const point = Footprints.coordinates(match);
          if (!point || !gateName.test(match.name || '') || distance(stop, { point }) > 1.5) return [];
          if (!nameKey(match.name).includes(venue) && !nameKey(match.address).includes(venue)) return [];
          const main = /正门|正門|主入口|main\s*(?:entrance|gate)/iu.test(match.name);
          return [{ name: match.name, point, rank: (main ? 0 : 2) + distance(stop, { point }) }];
        }).sort((a, b) => a.rank - b.rank);
        if (nearby.length) entrances.set(stop, { name: nearby[0].name, point: nearby[0].point });
      } catch (_) { /* Keep the landmark as the arrival point if a gate is unavailable. */ }
    }
    return stops.map(stop => entrances.has(stop) ? { ...stop, entrance: entrances.get(stop) } : stop);
  }

  function searchAnchor(row, draft, trip, area) {
    const nearby = draft.filter(stop => stop.category !== MEAL && stop.date && (stop.point || stop.visit?.point));
    const travel = (trip.itinerary || []).filter(day => day.date === row.date)
      .flatMap(day => day.items || []).find(item => item.category === '景点' && Footprints.coordinates(item));
    const sameDay = nearby.filter(stop => stop.date === row.date);
    const sight = sameDay.filter(stop => stop.time <= row.time).at(-1) || sameDay[0];
    return sight?.point || sight?.visit?.point || Footprints.coordinates(travel) || nearby[0]?.point
      || nearby[0]?.visit?.point || area;
  }

  async function resolveMeals(draft, trip, destination, search, signal) {
    const meals = draft.filter(row => row.category === MEAL && !row.verified);
    if (!meals.length) return draft;
    const scope = { ...trip, meta: { ...trip.meta, destination } };
    const areas = Footprints.itinerarySearchAreas(scope, '', '');
    let area = areas.length === 1 ? Footprints.coordinates(areas[0]) : null;
    if (!area && !areas.length && !searchAnchor(meals[0], draft, trip) && !signal.aborted) {
      try {
        const places = await search(destination, { tripId: trip.id, signal });
        area = Footprints.coordinates(Footprints.selectItineraryMatch(destination, places, []).exact);
      } catch (_) { /* The meal can still be confirmed manually. */ }
    }
    const recommendations = new Map();
    for (const row of meals) {
      const near = searchAnchor(row, draft, trip, area);
      const known = DINING_GUIDES.find(place => place.request.test(row.name) &&
        (near ? distance({ point: near }, { point: place.area }) <= 10 : /香港|hong\s*kong|港澳/iu.test(destination)));
      if (known) {
        const { name, address, area: routePoint, source, tips, preferredMeal, budget, station } = known;
        recommendations.set(row, { ...row, name, address, routePoint, mealQuery: row.name, dining: { source, tips, preferredMeal, budget, station } });
        continue;
      }
      if (!near || signal.aborted) continue;
      const cuisine = CUISINES.find(([pattern]) => pattern.test(row.name))?.[1];
      try {
        const options = { tripId: trip.id, near, dining: true, cuisine, signal };
        const choices = await search(row.name, options);
        const match = choices.find(place => {
          const point = Footprints.coordinates(place);
          return point && place.dining && nameKey(place.name)
            && distance({ point: near }, { point }) <= 5;
        });
        if (match) {
          recommendations.set(row, {
            ...row, name: match.name, point: Footprints.coordinates(match), address: match.address, verified: 'osm',
            mealQuery: row.name, dining: {},
          });
        }
      } catch (_) { /* Preserve the request when the map provider has no usable restaurant. */ }
    }
    return draft.map(row => recommendations.get(row) || (
      meals.includes(row) ? { ...row, mealQuery: row.name, needsRestaurant: true } : row));
  }

  function itineraryIntervals(trip, dates) {
    const busy = new Map([...dates].map(date => [date, []]));
    for (const day of trip.itinerary || []) {
      for (const item of day?.items || []) {
        if (!item) continue;
        const started = Footprints.isValidDate(item.startDate) ? item.startDate : day.date;
        const start = minutesAt(item.time);
        if (!Footprints.isValidDate(started) || start === null) continue;
        const ended = Footprints.isValidDate(item.endDate) ? item.endDate : started;
        const end = minutesAt(item.endTime);
        const startStamp = dateStamp(started) + start * 60000;
        const statedEnd = end === null ? startStamp : dateStamp(ended) + end * 60000;
        const endStamp = statedEnd > startStamp ? statedEnd : startStamp + 60 * 60000;
        for (const [date, spans] of busy) {
          const base = dateStamp(date);
          if (startStamp >= base + DAY_MS || endStamp <= base) continue;
          spans.push({ start: Math.max(0, (startStamp - base) / 60000), end: Math.min(1440, (endStamp - base) / 60000) });
        }
      }
    }
    return busy;
  }

  function freeStart(spans, start, duration, latest) {
    for (const entry of [...spans].sort((a, b) => a.start - b.start)) {
      if (start + duration <= entry.start) break;
      if (start < entry.end) start = Math.ceil(entry.end / 5) * 5;
    }
    return start + duration <= latest ? start : null;
  }

  function baseDuration(stop) { return stop.visit?.duration || (stop.category === MEAL ? 60 : 75); }

  function durationFor(stop) { return stop.duration || baseDuration(stop); }

  function fitsMealWindow(stop, slot) {
    if (stop.category !== MEAL) return !slot.meal;
    const preference = stop.mealQuery || stop.name;
    if (/早茶|早餐|brunch/iu.test(preference)) return slot.meal === 'breakfast';
    if (/午餐|午饭|lunch/iu.test(preference)) return slot.meal === 'lunch';
    if (/晚餐|晚饭|dinner/iu.test(preference)) return slot.meal === 'dinner';
    if (stop.dining?.preferredMeal) return slot.meal === stop.dining.preferredMeal;
    return slot.meal === 'lunch' || slot.meal === 'dinner';
  }

  function makeDraft(stops, trip, dates, policy = ROUTE_OPTIONS[0]) {
    const pending = stops.slice();
    const result = [];
    const busy = itineraryIntervals(trip, dates);
    let previousDayLast;
    for (const [dayIndex, date] of dates.entries()) {
      const holds = busy.get(date);
      let previous, anchor;
      let previousEnd = 0;
      for (const slot of SLOTS) {
        const candidates = pending.map((stop, index) => ({ stop, index, km: distance(anchor, routingLocation(stop)) }))
          .filter(({ stop }) => fitsMealWindow(stop, slot))
          .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
        for (const { stop, index, km } of candidates) {
          if (km > 35 && dayIndex < dates.length - 1) continue;
          const duration = baseDuration(stop) + (stop.category === MEAL ? 0 : policy.extraVisit || 0);
          const from = previous || overnightOrigin(previousDayLast, stop);
          const transfer = estimateTransfer(from, stop, policy);
          const buffer = transfer?.minutes || 0;
          const windowStart = slot.start + (policy.later || 0) - (slot.meal ? 0 : policy.earlier || 0);
          const windowEnd = slot.end + (policy.later || 0);
          const depart = freeStart(holds, Math.max(windowStart - buffer, previousEnd, previous ? 0 : 7 * 60 + 30),
            buffer + duration, windowEnd);
          if (depart === null) continue;
          const time = depart + buffer;
          result.push({ ...stop, date, duration, time: clock(time), endTime: clock(time + duration), distance: distance(previous, stop) });
          previous = stop;
          const positioned = routingLocation(stop);
          if (positioned.point) anchor = positioned;
          previousEnd = time + duration;
          holds.push({ start: depart, end: previousEnd });
          pending.splice(index, 1);
          break;
        }
      }
      if (previous) previousDayLast = previous;
    }
    return result.concat(pending.map(stop => ({ ...stop, date: '', time: '', endTime: '', distance: null,
      duration: baseDuration(stop) + (stop.category === MEAL ? 0 : policy.extraVisit || 0) })));
  }

  function routingLocation(stop) {
    return { point: stop?.entrance?.point || stop?.point || stop?.routePoint || stop?.visit?.point };
  }

  function travelArea(stop) {
    if (stop.visit?.area) return stop.visit.area;
    const label = `${stop.address || ''} ${stop.name || ''}`;
    if (/澳门|澳門|maca[ou]/iu.test(label)) return 'MO';
    if (/香港|hong\s*kong/iu.test(label)) return 'HK';
    if (/珠海|zhuhai|深圳|shenzhen/iu.test(label)) return '';
    const point = routingLocation(stop).point;
    if (point) {
      if (point.lat >= 22.13 && point.lat <= 22.23 && point.lng >= 113.52 && point.lng <= 113.61) return 'MO';
      if (point.lat >= 22.18 && point.lat <= 22.56 && point.lng >= 113.84 && point.lng <= 114.44) return 'HK';
      return '';
    }
    return '';
  }

  function stationFor(stop) {
    return stop?.visit?.station || stop?.dining?.station;
  }

  function stationArrival(stop, station) {
    if (stop.category === MEAL) return '出站后沿店铺地址步行到店。';
    const selected = stop.children?.[0]?.name;
    const follow = selected && selected !== stop.visit?.steps?.[0]?.[0] ? `步行到「${selected}」开始游览。` : station.arrival;
    return `从 ${station.exit} 出口出站，${follow}`;
  }

  function railSteps(from, to) {
    const a = stationFor(from), b = stationFor(to);
    if (!a || !b || a === b) return null;
    let segments;
    if (a !== 'university' && b !== 'university') {
      const southToNorth = ['central', 'tsimshatsui', 'mongkok'];
      segments = [[a, b, '荃湾线', southToNorth.indexOf(a) < southToNorth.indexOf(b) ? '荃湾' : '中环']];
    } else if (a === 'tsimshatsui' || b === 'tsimshatsui') {
      segments = a === 'university' ? [[a, 'hunghom', '东铁线', '金钟']] : [['hunghom', b, '东铁线', '罗湖或落马洲']];
    } else {
      const cityStation = a === 'university' ? b : a;
      const mongkok = cityStation === 'mongkok';
      const change = mongkok ? 'kowloontong' : 'admiralty';
      const line = mongkok ? '观塘线' : '荃湾线';
      segments = a === 'university'
        ? [[a, change, '东铁线', '金钟'], [change, b, line, mongkok ? '黄埔' : '中环']]
        : [[a, change, line, mongkok ? '调景岭' : '荃湾'], [change, b, '东铁线', '罗湖或落马洲']];
    }
    const steps = segments.map(([board, alight, line, direction], index) => ({
      title: index ? `${MTR_STATIONS[board].name}换乘` : `从${MTR_STATIONS[board].name}上车`,
      note: `${index ? '' : `从「${departureName(from)}」步行到车站。`}搭${line}往${direction}方向，到${MTR_STATIONS[alight].name}。`,
    }));
    const station = MTR_STATIONS[segments.at(-1)[1]];
    steps.push({ title: `${station.name}下车`, note: stationArrival(to, station) });
    return steps;
  }

  function firstStopAccess(stop) {
    if (stop.needsRestaurant) return { mode: '到店交通', note: '餐厅定位后安排到店路线。' };
    const station = MTR_STATIONS[stationFor(stop)];
    if (station) return { mode: '港铁', station: station.name,
      note: `搭${station.line}到${station.name}。${stationArrival(stop, station)}`, source: MTR_MAP };
    return { mode: '步行或公共交通', mapMode: 'transit',
      note: `以「${arrivalName(stop)}」为到达点。住得近可步行，距离较远优先搭地铁或公交。首站出发地未定，具体班次待核实。` };
  }

  function arrivalName(stop) {
    return stop.entrance?.name || (stop.visit && stop.children?.[0]?.name) || stop.visit?.arrival || stop.name;
  }

  function departureName(stop) {
    return stop.visit ? childrenFor(stop).at(-1)?.name || stop.name : arrivalName(stop);
  }

  function publicTransfer(from, to, km) {
    const intercity = km !== null && km >= 35;
    const minutes = km === null ? 35 : Math.ceil((intercity ? 45 + km * 1.1 : 22 + km * 3.5) / 5) * 5;
    return {
      mode: intercity ? '城际公共交通' : '公共交通接驳', minutes, partial: true, mapMode: 'transit',
      detail: '具体线路和票价待核实，所列时间为接驳预留。',
      steps: [{
        title: `搭公共交通前往「${arrivalName(to)}」`,
        note: `从「${departureName(from)}」出发，优先走${intercity ? '城际铁路或客运巴士' : '地铁或公交'}，下车后步行到这一站。`,
      }],
    };
  }

  function hongKongPortRail(stop, towardPort) {
    const station = stationFor(stop);
    const tungChungBound = '转东涌线往东涌站。';
    if (station === 'central') return towardPort ? `从中环站沿站内通道到香港站，${tungChungBound}` : '搭东涌线到香港站，经站内通道到中环站。';
    if (station === 'university') return towardPort
      ? `从大学站搭东铁线往金钟方向到九龙塘，转观塘线往黄埔方向到太子，再搭荃湾线往荃湾方向到荔景，${tungChungBound}`
      : '搭东涌线往香港方向到荔景，转荃湾线往中环方向到太子，再搭观塘线往调景岭方向到九龙塘，转东铁线往罗湖或落马洲方向到大学站。';
    if (station) return towardPort
      ? `从${MTR_STATIONS[station].name}搭荃湾线往荃湾方向到荔景站，${tungChungBound}`
      : `搭东涌线往香港方向到荔景，转荃湾线往中环方向到${MTR_STATIONS[station].name}。`;
    return towardPort ? '先搭港铁东涌线到东涌站。' : '从东涌站搭港铁返回市区，再步行或接驳到目的地。';
  }

  function bridgeTransfer(from, to, origin) {
    const hkToMacau = origin === 'HK';
    const fromPort = hkToMacau ? '香港口岸' : '澳门口岸';
    const toPort = hkToMacau ? '澳门口岸' : '香港口岸';
    const busToHKPort = { title: '东涌转 B6 巴士', note: `${hongKongPortRail(from, true)}在东涌市中心搭 B6 到大桥香港口岸。工作日早高峰 B6 暂停服务时，按该站站牌搭 B6S。` };
    const busFromHKPort = { title: 'B6 转港铁东涌线', note: `出关后搭 B6 到东涌站。${hongKongPortRail(to, false)}再前往「${arrivalName(to)}」。` };
    const busToMacauPort = { title: '搭澳门 101 路巴士到口岸', note: `从「${departureName(from)}」前往亚马喇前地，搭 101 路到港珠澳大桥边检大楼。` };
    const busFromMacauPort = { title: '搭澳门 101 路巴士进市区', note: `出关后在大桥边检大楼搭 101 路至亚马喇前地，再前往「${arrivalName(to)}」。${to.visit?.area === 'MO' ? '去历史城区可沿殷皇子大马路往新马路步行。' : ''}` };
    return { mode: '跨境巴士', minutes: 180, budget: { currency: 'HKD', min: 65, max: 70 },
      partial: true, source: BRIDGE_FARES, detail: '预留公共交通接驳及过关时间，所列票价为港澳线穿梭巴士部分。',
      steps: [
        hkToMacau ? busToHKPort : busToMacauPort,
        { title: '搭港澳线穿梭巴士', note: `在${fromPort}办理出境，搭金巴到${toPort}，下车办理入境。` },
        hkToMacau ? busFromMacauPort : busFromHKPort,
      ] };
  }

  function estimateTransfer(from, to, policy) {
    if (!from || !to) return null;
    const km = distance(routingLocation(from), routingLocation(to));
    const origin = travelArea(from), destination = travelArea(to);
    if (origin && destination && origin !== destination) return bridgeTransfer(from, to, origin);
    const steps = origin === 'HK' && destination === 'HK' ? railSteps(from, to) : null;
    const walkingKm = steps ? policy.walkingKm : Math.max(policy.walkingKm, ROUTE_OPTIONS[0].walkingKm);
    if (km !== null && km <= walkingKm) {
      return { mode: '步行', minutes: Math.max(5, Math.ceil(km * 20 / 5) * 5), free: true, mapMode: 'walking',
        steps: [{ title: `步行到「${arrivalName(to)}」`, note: `从「${departureName(from)}」出发，沿公共步行路线前往。` }] };
    }
    if (steps) return { mode: '港铁', minutes: Math.ceil((14 + (km ?? 5) * 2.4) / 5) * 5,
      budget: { currency: 'HKD', min: km < 7 ? 6 : 10, max: km < 7 ? 18 : 32 },
      source: MTR_FARES, routeSource: MTR_MAP, steps, detail: '用时含步行到站、候车和换乘。' };
    return publicTransfer(from, to, km);
  }

  function overnightOrigin(previous, stop) {
    if (!previous) return null;
    const km = distance(routingLocation(previous), routingLocation(stop));
    const a = travelArea(previous), b = travelArea(stop);
    return km >= 35 || a && b && a !== b ? previous : null;
  }

  function routeOptions(stops, trip, dates) {
    return ROUTE_OPTIONS.map(policy => ({
      id: policy.id, label: policy.label, description: policy.description, rows: makeDraft(stops, trip, dates, policy),
    }));
  }

  function childrenFor(row) {
    if (Array.isArray(row.children)) return row.children;
    if (row.category !== '景点') return [];
    if (row.visit?.steps) return row.visit.steps.map(([name, note, mapName]) => ({ name, note, mapName, catalog: true }));
    return [
      { name: `从「${arrivalName(row)}」开始`, mapName: row.entrance?.name || row.name,
        note: row.entrance ? '由地图收录的这个入口进入，沿入口连接的公开步道往主区域走。'
          : '把景点的地图定位作为起点，从临街一侧开始步行。' },
      { name: `${row.name}短线游览`, note: '从起点走一段开放步道，在沿途标志性位置停留，最后沿原路回到起点。', noMap: true },
    ];
  }

  function moveChild(children, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || !children[from] || !children[to] || from === to) return children;
    const reordered = children.slice();
    reordered.splice(to, 0, reordered.splice(from, 1)[0]);
    return reordered;
  }

  function stopBudget(row) {
    if (row.budget || row.dining?.budget) return row.budget || row.dining.budget;
    if (row.visit?.area && childrenFor(row).every(child => child.catalog)) {
      return { currency: row.visit.area === 'MO' ? 'MOP' : 'HKD', min: 0, max: 0 };
    }
    return null;
  }

  function daysByDate(rows) {
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.date)) grouped.set(row.date, []);
      grouped.get(row.date).push(row);
    }
    return [...grouped].sort(([a], [b]) => (a || '9999').localeCompare(b || '9999'));
  }

  function addBudget(summary, cost, partial = false) {
    if (!cost || partial) summary.unpriced += 1;
    if (!cost || !['HKD', 'MOP', 'CNY', 'TWD', 'JPY', 'USD', 'EUR', 'GBP', 'KRW', 'SGD', 'THB', 'AUD'].includes(cost.currency)
      || !Number.isFinite(cost.min) || !Number.isFinite(cost.max) || cost.min < 0 || cost.min > cost.max) return;
    const value = summary.budget.get(cost.currency) || { currency: cost.currency, min: 0, max: 0 };
    value.min += cost.min;
    value.max += cost.max;
    summary.budget.set(cost.currency, value);
  }

  function daySummary() {
    return { stops: [], visit: 0, meals: 0, travel: 0, modes: new Set(), budget: new Map(), unpriced: 0, conflicts: 0, untimed: 0 };
  }

  function draftDays(rows, variantId) {
    const policy = ROUTE_OPTIONS.find(option => option.id === variantId) || ROUTE_OPTIONS[0];
    let previousDayLast;
    return daysByDate(rows).map(([date, stops]) => {
      const summary = daySummary();
      const legs = stops.map((row, index) => {
        summary.stops.push(row.name);
        summary[row.category === MEAL ? 'meals' : 'visit'] += durationFor(row);
        addBudget(summary, stopBudget(row));
        if (!date) return null;
        const from = stops[index - 1] || overnightOrigin(previousDayLast, row);
        const estimate = estimateTransfer(from, row, policy);
        if (!estimate) return null;
        const arrival = minutesAt(row.time);
        const previousStart = from.date === row.date ? minutesAt(from.time) : null;
        const depart = arrival === null ? null : arrival - estimate.minutes;
        const conflict = depart !== null && (depart < 0 || previousStart !== null && previousStart + durationFor(from) > depart);
        summary.travel += estimate.minutes;
        summary.modes.add(estimate.mode);
        if (!estimate.free) addBudget(summary, estimate.budget, estimate.partial);
        if (conflict) summary.conflicts += 1;
        return { ...estimate, from, to: row, depart, conflict };
      });
      if (date) previousDayLast = stops.at(-1);
      return { date, stops, legs, summary };
    });
  }

  function savedDaySummary(items) {
    const summary = daySummary();
    for (const item of items) {
      const start = minutesAt(item.time);
      const end = minutesAt(item.endTime);
      const hasTime = start !== null && end !== null && end >= start && (!item.endDate || item.endDate === item.startDate);
      const duration = hasTime ? end - start : 0;
      if (!hasTime) summary.untimed += 1;
      const transport = item.category === '交通';
      if (transport) {
        summary.travel += duration;
        summary.modes.add(item.guideRoute?.mode || '交通');
      } else {
        summary.stops.push(item.title || item.location || '未命名');
        summary[item.category === MEAL ? 'meals' : 'visit'] += duration;
      }
      if (!item.guideRoute?.free) addBudget(summary, item.guideRoute?.budget, item.guideRoute?.partial);
    }
    return summary;
  }

  function preparedTransfers(trip, rows, variantId) {
    const busy = itineraryIntervals(trip, new Set(rows.map(row => row.date)));
    for (const row of rows) busy.get(row.date).push({ start: minutesAt(row.time), end: minutesAt(row.endTime) });
    const transfers = new Map();
    for (const day of draftDays(rows, variantId)) {
      for (const leg of day.legs.filter(Boolean)) {
        const arrive = minutesAt(leg.to.time);
        const holds = busy.get(day.date);
        const blocked = leg.depart === null || leg.conflict || holds.some(span => span.start < arrive && span.end > leg.depart);
        transfers.set(leg.to.id, { ...leg, bookable: !blocked, time: blocked ? '' : clock(leg.depart) });
        if (!blocked) holds.push({ start: leg.depart, end: arrive });
      }
    }
    return transfers;
  }

  function moveDraftStop(rows, id, targetId, after) {
    if (id === targetId) return rows;
    const source = rows.find(row => row.id === id);
    const target = rows.find(row => row.id === targetId);
    if (!source || !target || source.date !== target.date) return rows;
    const order = rows.filter(row => row !== source);
    order.splice(order.indexOf(target) + Number(after), 0, source);
    return order;
  }

  function prepareCommit(trip, selected) {
    const days = new Set(selected.map(row => row.date));
    const existing = (trip.itinerary || []).flatMap(day => (day?.items || []).filter(Boolean).map(item => ({ item, date: item.startDate || day.date })));
    const busy = itineraryIntervals(trip, days);
    const result = [];
    for (const row of selected) {
      if (row.needsRestaurant) throw new Error(`请先为「${row.mealQuery}」填写具体餐厅`);
      if (existing.some(({ item, date }) => item.id === row.id || date === row.date && nameKey(item.title) === nameKey(row.name))) continue;
      const start = minutesAt(row.time);
      const end = start === null ? null : start + durationFor(row);
      if (!Footprints.isValidDate(row.date) || end === null || end >= 1440) throw new Error(`请给「${row.name}」填写有效日期和时间`);
      const holds = busy.get(row.date);
      if (holds.some(span => start < span.end && end > span.start)) throw new Error(`「${row.name}」和已有安排或草稿时间重叠，请调整后再加入`);
      holds.push({ start, end });
      result.push({ ...row, endTime: clock(end) });
    }
    return result;
  }

  function parseLink(value) {
    try {
      const url = new URL(value);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url;
    } catch (_) { /* Invalid link. */ }
    return null;
  }

  function linkKey(raw) {
    const url = parseLink(Render.extractUrl(raw));
    if (!url) return '';
    const id = /\/(?:explore|discovery\/item)\/([\da-f]{12,})(?:\/|$)/i.exec(url.pathname)?.[1];
    if (id && /(?:^|\.)xiaohongshu\.com$/i.test(url.hostname)) return `xhs:${id.toLowerCase()}`;
    return `${url.hostname}${url.pathname.replace(/\/$/, '')}${url.search}`;
  }

  function parseSharedLinks(input) {
    const found = new Map();
    const text = asText(input);
    let from = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s【】，。！？、"'）)】<>]+/gi)) {
      const before = text.slice(from, match.index).trim();
      from = match.index + match[0].length;
      const link = parseLink(match[0])?.href;
      const key = link && linkKey(link);
      if (!key || found.has(key)) continue;
      const shareTitle = Render.extractTitle(before) || before.split(/\r?\n/u).at(-1) || '';
      const host = new URL(link).hostname;
      const title = shareTitle.slice(0, 60) || (/xiaohongshu\.com$|^xhslink\.com$/i.test(host) ? '小红书攻略' : host);
      found.set(key, { link, title });
    }
    if (!found.size) throw new Error('没有找到可导入的链接');
    if (found.size > MAX_STOPS) throw new Error(`一次最多导入 ${MAX_STOPS} 条链接，请分批粘贴`);
    return [...found.values()];
  }

  return { defaultDates, dateRange, savedChoices, collectStops, resolveStops, resolveMeals, resolveEntrances, visitGuide, distance, durationFor,
    makeDraft, routeOptions, childrenFor, moveChild, firstStopAccess, arrivalName, stopBudget, draftDays, savedDaySummary, preparedTransfers, moveDraftStop,
    prepareCommit, linkKey, parseSharedLinks };
})();
