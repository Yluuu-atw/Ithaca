'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGuide() {
  const context = { window: {}, URL, Theme: require('../public/js/theme') };
  for (const [file, key] of [['footprints.js', 'Footprints'], ['render.js', 'Render'], ['guide-planner.js', 'GuidePlanner']]) {
    const code = fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
    vm.runInNewContext(code, context);
    context[key] = context.window[key];
  }
  return context;
}

const planner = () => loadGuide().GuidePlanner;

test('route drafts reserve meal times, keep known coordinates and avoid existing bookings', () => {
  const guide = planner();
  const trip = { meta: {}, itinerary: [{ date: '2026-11-24', items: [{ title: '车票', time: '09:00', endTime: '10:00' }] }] };
  const selected = { name: '旺角', category: '景点', point: { lat: 22.319, lng: 114.17 } };
  const stops = guide.collectStops('我想去旺角、中环，想吃早茶、烧鹅', [selected]);
  assert.deepEqual(Array.from(stops, stop => [stop.name, stop.category]), [['旺角', '景点'], ['中环', '景点'], ['早茶', '餐饮'], ['烧鹅', '餐饮']]);
  assert.equal(stops[0].point.lat, selected.point.lat);
  const dates = guide.dateRange('2026-11-24', '2026-11-25');
  const draft = guide.makeDraft(stops, trip, dates);
  assert.equal(draft.length, 4);
  assert(draft.every(row => !(row.date === '2026-11-24' && row.time < '10:00' && row.endTime > '09:00')));
  assert.equal(draft.find(row => row.name === '早茶').time, '08:30');
  assert(draft.find(row => row.name === '烧鹅').time >= '11:30');
  const rows = guide.prepareCommit(trip, draft.filter(row => row.date).map((row, i) => ({ ...row, id: `new-${i}` })));
  assert.equal(rows.length, 4);
  trip.itinerary[0].items.push({ title: '新记录', time: rows[0].time, endTime: rows[0].endTime });
  assert.throws(() => guide.prepareCommit(trip, rows), /时间重叠/);
});

test('route lookup keeps unresolved names when the map is unavailable and uses verified points', async () => {
  const guide = planner();
  const trip = { id: 'a', meta: { destination: '香港' }, itinerary: [] };
  const stops = guide.collectStops('中環海濱長廊、没有记录的小店');
  const calls = [];
  const result = await guide.resolveStops(stops, trip, '香港', async (query, opts) => {
    calls.push([query, opts.tripId]);
    if (query.includes('小店')) throw new Error('offline');
    return [{ name: '中環海濱長廊', address: '中环', lat: 22.283, lng: 114.159 }];
  }, () => {}, new AbortController().signal);
  assert.equal(calls.length, 2);
  assert(calls.every(([, tripId]) => tripId === 'a'));
  assert.equal(result[0].verified, 'osm');
  assert.equal(result[1].point, null);
  assert.equal(result[1].name, '没有记录的小店');
});

test('route drafts group nearby stops before moving far away when another day is available', () => {
  const guide = planner();
  const stops = [
    { name: '旺角', category: '景点', point: { lat: 22.3225, lng: 114.17 } },
    { name: '大三巴', category: '景点', point: { lat: 22.1975, lng: 113.54 } },
    { name: '中环', category: '景点', point: { lat: 22.282, lng: 114.16 } },
  ];
  const draft = guide.makeDraft(stops, { itinerary: [] }, ['2026-11-24', '2026-11-25']);
  assert.deepEqual(Array.from(draft, row => [row.name, row.date]), [['旺角', '2026-11-24'], ['中环', '2026-11-24'], ['大三巴', '2026-11-25']]);
});

test('the handbook shows sourced walking steps by date and does not invent steps for unknown stops', () => {
  const { GuidePlanner: guide, Render } = loadGuide();
  const destination = '香港、澳门';
  const central = { name: '中環', category: '景点', point: { lat: 22.28, lng: 114.15 } };
  const macau = { name: '澳门历史城区', category: '景点' };
  const unknown = { name: '新景点', category: '景点' };
  const curated = guide.visitGuide(central, destination);
  assert(guide.visitGuide(macau, destination).steps.some(([name]) => name === '大三巴牌坊'));
  assert.equal(guide.visitGuide({ ...central, point: { lat: 22.20, lng: 113.55 } }, destination), null);
  assert.equal(guide.visitGuide(unknown, destination), null);
  const [start, end] = ['2026-11-24', '2026-11-25'];
  const trip = { id: 'guide-test', meta: { destination }, itinerary: [] };
  const [first] = guide.makeDraft([{ ...central, visit: curated }], trip, [start]);
  assert.equal(first.endTime, '10:30');
  assert.equal(guide.prepareCommit(trip, [{ ...first, id: 'central' }])[0].endTime, '10:30');
  const html = Render.renderPage(trip, 'guide-plan', {
    guideStage: 'draft',
    guidePlan: { inputs: { destination, start, end }, rows: [
      { ...first, id: 'central' }, { ...unknown, id: 'unknown', date: end, time: '09:00' },
    ] },
  });
  assert.match(html, /data-tab="guide-plan" aria-current="page">生成路线.*收藏攻略.*心愿单.*地图/s);
  assert.match(html, /11月24日.*中环街市.*半山扶梯.*discoverhongkong\.com.*11月25日.*新景点.*从「新景点」开始/s);
  assert.equal(Render.isPrimaryTabActive('places', 'guide-plan'), true);
});

test('shared notes keep their title and original URL and skip duplicate Xiaohongshu note IDs', () => {
  const guide = planner();
  const first = 'https://www.xiaohongshu.com/explore/1234567890ab?xsec_token=example';
  const second = 'https://www.xiaohongshu.com/discovery/item/1234567890ab';
  const results = guide.parseSharedLinks(`【港岛散步】${first}\n【重复】${second}\n【早茶】https://xhslink.com/a/example`);
  assert.deepEqual(Array.from(results, entry => [entry.title, entry.link]), [['港岛散步', first], ['早茶', 'https://xhslink.com/a/example']]);
  assert.throws(() => guide.parseSharedLinks('没有链接'), /没有找到/);
});

test('food preferences become named restaurants and unmatched food stays out of the itinerary', async () => {
  const guide = planner();
  const date = '2026-11-24';
  const trip = { id: 'guide-test', meta: { destination: '香港' }, itinerary: [] };
  const central = { name: '中环', point: { lat: 22.28, lng: 114.15 }, category: '景点', date, time: '09:00' };
  const meals = ['印度菜', '烧鹅', '越南菜', '自创菜'].map(name => ({ name, category: '餐饮', date, time: '12:00' }));
  const rows = await guide.resolveMeals([central, ...meals], trip, '香港', async (name, opts) => {
    if (opts.cuisine !== 'vietnamese') return [{ name: '自创菜街', lat: 22.28, lng: 114.15 }];
    assert.equal(opts.near.lat, central.point.lat);
    return [{ name: '远方餐馆', lat: 22.9, lng: 114.15, dining: true },
      { name: '街坊越菜', lat: 22.281, lng: 114.15, dining: true, address: '测试街 1 号' }];
  }, new AbortController().signal);
  assert.deepEqual(Array.from(rows, row => row.name), ['中环', 'New Punjab Club', '一乐烧鹅', '街坊越菜', '自创菜']);
  assert.equal(rows[3].mealQuery, '越南菜');
  assert.equal(rows[4].needsRestaurant, true);
  assert.throws(() => guide.prepareCommit(trip, [rows[4]]), /填写具体餐厅/);
  const schedule = guide.makeDraft(rows.slice(0, 3), trip, [date]);
  assert.deepEqual(Array.from(schedule, row => [row.name, row.time]),
    [['中环', '09:00'], ['一乐烧鹅', '11:30'], ['New Punjab Club', '18:00']]);
});

test('manual order keeps times and rejects moving into a different day', () => {
  const { GuidePlanner: guide, Render } = loadGuide();
  const first = { id: 'one', name: '旺角', category: '景点', date: '2026-11-24', time: '09:00', children: [{ name: '西洋菜南街', note: '先看街景' }] };
  const second = { id: 'two', name: '中环', category: '景点', date: first.date, time: '14:00' };
  const third = { id: 'three', date: '2026-11-25' };
  assert.deepEqual(Array.from(guide.moveDraftStop([first, second, third], second.id, first.id, false)), [second, first, third]);
  const untouched = [first, third];
  assert.equal(guide.moveDraftStop(untouched, first.id, third.id, false), untouched);
  const html = Render.renderPage({ id: 't' }, 'guide-plan', { guideStage: 'draft', guidePlan: {
    rows: [second, first], inputs: { destination: '香港', start: first.date, end: first.date },
  } });
  assert.match(html, /data-guide-stop="two"[\s\S]+?14:00[\s\S]+?data-guide-stop="one"[\s\S]+?09:00[\s\S]+?西洋菜南街/);
});

test('draft alternatives reserve transfer time and summarize budgets before the stations', () => {
  const { GuidePlanner: guide, Render } = loadGuide();
  const date = '2026-11-26';
  const destination = '香港';
  const trip = { id: 'route', meta: { destination }, itinerary: [] };
  const stops = ['旺角', '中环'].map((name, i) => ({
    id: `stop${i}`, name, category: '景点', visit: guide.visitGuide({ name }, destination),
  }));
  const options = guide.routeOptions(stops, trip, [date]);
  assert.deepEqual(Array.from(options, option => option.id), ['balanced', 'relaxed', 'transit']);
  assert.deepEqual(Array.from(options, option => option.label), ['步行＋地铁', '步行优先', '地铁优先']);
  assert.notEqual(options[0].rows[0].time, options[1].rows[0].time);
  const rows = guide.prepareCommit(trip, options[0].rows);
  const [day] = guide.draftDays(rows);
  assert.equal(day.legs[1].mode, '港铁');
  assert(day.legs[1].minutes >= 20);
  assert.equal(day.summary.conflicts, 0);
  assert.equal(day.summary.budget.get('HKD').max, 18);
  const planned = guide.preparedTransfers(trip, rows).get(rows[1].id);
  assert.equal(planned.bookable, true);
  assert(planned.time >= rows[0].endTime);
  const conflict = guide.preparedTransfers(trip, [rows[0], { ...rows[1], time: rows[0].endTime }]).get(rows[1].id);
  assert.equal(conflict.bookable, false);
  const html = Render.renderPage(trip, 'guide-plan', { guideStage: 'draft', guidePlan: {
    rows, options, variantId: options[0].id, inputs: { destination, start: date, end: date },
  } });
  assert.match(html, /选择攻略方案[\s\S]*?步行＋地铁[\s\S]*?步行优先[\s\S]*?地铁优先[\s\S]*?当天小报[\s\S]*?HKD 6–18[\s\S]*?data-guide-stop=/);
  assert.match(html, /添加小景点[\s\S]*?交通方式/);
});

test('cross-border travel uses public connections in both directions and child stops remain sortable', () => {
  const guide = planner();
  const destination = '香港、澳门';
  const dates = ['2026-11-26', '2026-11-27'];
  const stops = ['旺角', '澳门历史城区'].map((name, i) => ({
    id: `stop${i}`, name, category: '景点', visit: guide.visitGuide({ name }, destination),
  }));
  const trip = { itinerary: [] };
  const rows = guide.makeDraft(stops, trip, dates);
  const days = guide.draftDays(rows);
  assert.equal(rows[1].date, dates[1]);
  assert.equal(days[1].legs[0].mode, '跨境巴士');
  assert.equal(days[1].summary.travel, 180);
  assert.match(days[1].legs[0].steps[0].note, /旺角站.*荔景站.*东涌线.*B6/);
  assert.match(days[1].legs[0].steps[2].note, /101 路至亚马喇前地.*新马路.*步行/);
  const returnLeg = guide.draftDays([{ ...rows[1], date: dates[0] }, { ...rows[0], date: dates[1] }])[1].legs[0];
  assert.match(returnLeg.steps[0].note, /亚马喇前地.*101 路.*港珠澳大桥/);
  assert.match(returnLeg.steps[2].note, /B6.*东涌线.*荃湾线.*旺角站/);
  assert.equal(days[1].summary.budget.get('HKD').min, 65);
  assert.equal(days[1].summary.unpriced, 1);
  const before = guide.childrenFor(rows[0]);
  const after = guide.moveChild(before, 2, 0);
  assert.deepEqual(Array.from(after, entry => entry.name), ['花墟道', '女人街', '金鱼街']);
  assert.equal(before[0].name, '女人街');
  assert.equal(after[0].note, before[2].note);
});

test('transport preferences affect both drafts and saved legs, including rail access to the science museum', () => {
  const guide = planner();
  const date = '2026-11-26';
  const trip = { itinerary: [] };
  const stops = ['旺角', '香港科学馆'].map((name, index) => ({
    id: String(index), category: '景点', name, visit: guide.visitGuide({ name }, '香港'),
    point: { lat: index ? 22.306 : 22.320, lng: 114.170 },
  }));
  for (const option of guide.routeOptions(stops, trip, [date])) {
    const mode = option.id === 'relaxed' ? '步行' : '港铁';
    const rows = guide.prepareCommit(trip, option.rows);
    assert.equal(guide.draftDays(rows, option.id)[0].legs[1].mode, mode);
    assert.equal(guide.preparedTransfers(trip, rows, option.id).get(rows[1].id).mode, mode);
  }
  const university = { ...stops[0], name: '香港中文大学', point: null, visit: guide.visitGuide({ name: '香港中文大学' }, '香港') };
  const [day] = guide.draftDays(guide.makeDraft([university, { ...stops[1], point: null }], trip, [date]));
  assert.match(day.legs[1].steps[0].note, /东铁线往金钟方向，到红磡站/);
  assert.match(day.legs[1].steps[1].note, /D1 出口.*香港科学馆/);
});

test('reordered sightseeing descriptions appear once in numbered rows with compact edit menus', () => {
  const { GuidePlanner: guide, Render } = loadGuide();
  const date = '2026-11-26';
  const trip = { id: 'hk', meta: { destination: '香港' }, itinerary: [] };
  const choices = ['中环', '香港中文大学'].map((name, index) => ({
    id: `item${index}`, name, category: '景点', visit: guide.visitGuide({ name }, '香港'),
    date, time: index ? '14:00' : '09:00',
  }));
  const original = guide.childrenFor(choices[1]);
  choices[1].children = guide.moveChild(original, 2, 0);
  const [day] = guide.draftDays(choices);
  assert.equal(day.legs[1].steps[0].title, '从中环站上车');
  assert.match(day.legs[1].steps[0].note, /荃湾线.*金钟站/);
  assert.equal(day.legs[1].steps[1].title, '金钟站换乘');
  assert.match(day.legs[1].steps[1].note, /东铁线.*大学站/);
  assert.match(day.legs[1].steps[2].note, /A 出口/);
  const [back] = guide.draftDays(choices.slice().reverse());
  assert.match(back.legs[1].steps[0].note, /东铁线往金钟方向/);
  assert.match(back.legs[1].steps[1].note, /荃湾线往中环方向/);
  const html = Render.renderPage(trip, 'guide-plan', { guideStage: 'draft', guidePlan: {
    rows: choices, inputs: { destination: '香港', start: date, end: date },
  } });
  assert.match(html, /route-report-main[\s\S]*?当天小报[\s\S]*?route-report-metrics/);
  assert(!html.includes('小景点顺序'));
  const stop = html.split('data-guide-stop="item1"')[1];
  assert.match(stop, /data-guide-child="0"[\s\S]*?百万大道[\s\S]*?大学图书馆外看校园主轴[\s\S]*?data-guide-child="1"[\s\S]*?未圆湖[\s\S]*?交通方式[\s\S]*?金钟站换乘/);
  assert.match(stop, /<summary[^>]*香港中文大学的操作[\s\S]*?data-kind="schedule">编辑日期和时间/);
  assert.match(stop, /<b>1\.<\/b><strong>百万大道<\/strong>[\s\S]*?<summary[^>]*百万大道的操作[\s\S]*?data-kind="child">编辑[\s\S]*?data-action="guide-child-remove">删除/);
  assert.doesNotMatch(stop, /<h4>小景点|>地图<\/a>|name="(?:date|time)"|guide-child-move|调整日期和时间/);
  assert.equal((stop.match(/在大学图书馆外看校园主轴/g) || []).length, 1);
  const schedule = Render.formGuideStopDetail(choices[1], 'schedule');
  assert.match(schedule, /name="date" value="2026-11-26"[\s\S]*?name="time" value="14:00"/);
  const child = Render.formGuideStopDetail(choices[1], 'child', choices[1].children[0]);
  assert.match(child, /value="百万大道"[\s\S]*?在大学图书馆外看校园主轴[\s\S]*?>保存<\/button>/);
});

test('unlisted transfers prioritize public transportation to the resolved entrance', async () => {
  const { GuidePlanner: guide, Render } = loadGuide();
  const park = { id: 'park', name: '街坊公园', category: '景点', point: { lat: 22.303, lng: 114.184 } };
  const first = { id: 'first', name: '滨海广场', category: '景点', point: { lat: 22.278, lng: 114.174 } };
  const [resolved] = await guide.resolveEntrances([park], 't', async (query, opts) => {
    assert.equal(query, '街坊公园 入口');
    assert.equal(opts.near, park.point);
    return [
      { name: '邻近大楼正门', lat: 22.303, lng: 114.184 },
      { name: '街坊公园侧入口', lat: 22.3031, lng: 114.184 },
      { name: '街坊公园正门', lat: 22.304, lng: 114.184 },
      { name: '街坊公园主入口', lat: 22.8, lng: 114.184 },
    ];
  }, new AbortController().signal);
  assert.equal(resolved.entrance.name, '街坊公园正门');
  assert.equal(guide.childrenFor(resolved)[0].name, '从「街坊公园正门」开始');
  const date = '2026-11-26';
  const trip = { id: 't', meta: { destination: '香港' }, itinerary: [] };
  const rows = guide.makeDraft([first, resolved], trip, [date]);
  const [day] = guide.draftDays(rows);
  assert.equal(day.legs[1].mode, '公共交通接驳');
  assert.match(day.legs[1].steps[0].title, /街坊公园正门/);
  const html = Render.renderPage(trip, 'guide-plan', { guideStage: 'draft', guidePlan: {
    rows, inputs: { destination: '香港', start: date, end: date },
  } });
  assert.match(html, /从「街坊公园正门」开始.*交通方式.*公共交通接驳.*搭公共交通前往「街坊公园正门」.*公共交通导航/s);
  assert.doesNotMatch(html, /出租车|打车|travelmode=driving|确认入口|选一条主线|查看可用线路|查交通路线/);
});
