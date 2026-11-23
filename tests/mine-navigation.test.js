'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(options = {}) {
  const state = {
    id: 'current-trip',
    meta: { tripName: '山间旅行', members: ['alice'], avatars: ['😎'] },
    checklist: [{ id: 'item-1', name: '清单中的私人物品', category: '其他', checked: true }],
    photos: [{ id: 'photo-1', url: '/uploads/travel-photo.webp', caption: '照片内容', date: '2026-11-23' }],
  };
  const memos = [
    { id: 'memo-1', tripId: state.id, text: '本次旅行日志内容', createdAt: '2026-11-23T08:00:00Z', photos: [] },
    { id: 'memo-2', tripId: 'another-trip', text: '其他旅行日志内容', createdAt: '2026-11-22T08:00:00Z', photos: [] },
    { id: 'memo-3', tripId: '', text: '未关联旅行的备忘录', createdAt: '2026-11-21T08:00:00Z', photos: [] },
  ];
  const person = options.person === undefined
    ? { id: 'person-1', name: 'alice', displayName: '小旅人', avatar: '😎', kind: 'formal' }
    : options.person;
  const user = options.user === undefined
    ? { username: 'alice', displayName: 'Alice', passwordHash: 'SHOULD_NOT_RENDER', passkeys: [{ id: 'PRIVATE_KEY_ID' }] }
    : options.user;
  const store = {
    getIdentity: () => person ? 0 : null,
    getRoster: () => person ? [person] : [],
    getTemplates: () => [],
    listMemos: () => memos,
    listTrips: () => [state],
    getActiveTripId: () => state.id,
    CONST: { checklistCategories: ['其他'] },
  };
  const context = { window: {}, Store: store, AuthUI: { user }, Theme: { DARK_BG: '#202020' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/footprints.js'), 'utf8'), context);
  context.Footprints = context.window.Footprints;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/photo-album.js'), 'utf8'), context);
  context.PhotoAlbum = context.window.PhotoAlbum;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  return { render: context.window.Render, state, store, memos, person, user };
}

test('the fourth primary tab opens My and stays selected on every personal detail page', () => {
  const { render } = setup();
  assert.deepEqual(Array.from(render.TABS, tab => tab.id), ['overview', 'places', 'bookings', 'mine']);
  assert.equal(render.tabTitle('mine'), '我的');
  for (const page of ['mine', 'checklist', 'photos', 'profile', 'journal', 'archive', 'settings', 'footprints']) {
    assert.equal(render.isPrimaryTabActive('mine', page), true);
    assert.equal(render.isPrimaryTabActive('overview', page), false);
    assert.equal(render.isPrimaryTabActive('places', page), false);
    assert.equal(render.isPrimaryTabActive('bookings', page), false);
    assert.match(render.renderTabbar(page), /class="tab-item active" data-action="nav" data-tab="mine"/);
    assert.match(render.renderNav(page), /class="nav-item active" data-action="nav" data-tab="mine"/);
  }
  assert.equal(render.isPrimaryTabActive('mine', 'map'), false);
});

test('My shows profile and menu entries without exposing checklist, gallery or journal contents', () => {
  const { render, state } = setup();
  const html = render.renderPage(state, 'mine');
  assert.match(html, /小旅人/);
  assert.match(html, /账号：alice/);
  assert.match(html, /本次旅行 · 山间旅行/);
  assert.match(html, /已打包 1\/1/);
  assert.match(html, /1 张/);
  assert.match(html, /1 篇/);
  for (const page of ['checklist', 'photos', 'profile', 'journal', 'archive', 'settings', 'footprints']) {
    assert.match(html, new RegExp(`class="mine-menu-row" data-action="nav" data-tab="${page}"`));
  }
  assert.doesNotMatch(html, /module-subnav|清单中的私人物品|照片内容|travel-photo\.webp|本次旅行日志内容|class="notebook"|class="photo-grid"/);
});

test('each detail page has a route back to My and retains its actual feature content', () => {
  const { render, state } = setup();
  const expected = {
    checklist: /清单中的私人物品/,
    photos: /按拍摄日期上传/,
    profile: /编辑账号信息/,
    journal: /本次旅行日志内容/,
    archive: /山间旅行/,
    settings: /导出旅行数据/,
    footprints: /累计旅行天数/,
  };
  for (const [page, content] of Object.entries(expected)) {
    const html = render.renderPage(state, page);
    assert.match(html, /class="mine-back" data-action="nav" data-tab="mine"/);
    assert.match(html, content);
    assert.doesNotMatch(html, /module-subnav/);
  }
  assert.match(render.renderPage(state, 'checklist'), /data-action="checklist-toggle"/);
  assert.match(render.renderPage(state, 'photos'), /data-action="photo-add"/);
  assert.match(render.renderPage(state, 'profile'), /data-action="trip-profile-open"/);
  assert.match(render.renderPage(state, 'journal'), /data-action="memo-new"/);
});

test('photo albums show every travel day before opening the selected photo grid', () => {
  const { render, state } = setup();
  state.itinerary = [{ date: '2026-11-22' }, { date: '2026-11-24' }];
  state.photos.push({ id: 'legacy', url: '/uploads/legacy.jpg', date: '2026-10-31' });
  const html = render.renderPage(state, 'photos');
  for (const date of ['2026-11-22', '2026-11-23', '2026-11-24', '2026-10-31']) {
    assert.match(html, new RegExp(`data-action="photo-day-open" data-date="${date}"`));
  }
  assert.doesNotMatch(html, /travel-photo\.webp|legacy\.jpg/);
  const day = render.renderPage(state, 'photos', { photoDay: '2026-11-23' });
  assert.match(day, /data-action="nav" data-tab="photos"/);
  assert.match(day, /data-action="photo-add" data-date="2026-11-23"/);
  assert.match(day, /travel-photo\.webp/);
  assert.doesNotMatch(day, /legacy\.jpg/);
});

test('journals contain only notes associated with the current trip and existing note actions', () => {
  const { render, state, memos } = setup();
  const html = render.renderPage(state, 'journal');
  assert.match(html, /1 篇 · 仅自己可见/);
  assert.match(html, /本次旅行日志内容/);
  assert.match(html, /data-action="memo-edit" data-id="memo-1"/);
  assert.match(html, /data-action="memo-del" data-id="memo-1"/);
  assert.doesNotMatch(html, /其他旅行日志内容|未关联旅行的备忘录|memo-2|memo-3/);
  assert.deepEqual(memos.map(memo => memo.id), ['memo-1', 'memo-2', 'memo-3']);
  const empty = render.renderPage({ ...state, id: 'new-trip' }, 'journal');
  assert.match(empty, /记录旅途中的片刻/);
  assert.doesNotMatch(empty, /本次旅行日志内容/);
});

test('temporary members and shared viewers cannot render private journal records', () => {
  for (const person of [null, { id: 'temporary', name: '临时伙伴', kind: 'temporary' }]) {
    const { render, state, store } = setup({ user: null, person });
    store.listMemos = () => { throw new Error('Private notes must not be read without a formal account'); };
    const mine = render.renderPage(state, 'mine');
    assert.match(mine, /旅行日志/);
    const journal = render.renderPage(state, 'journal');
    assert.match(journal, /请使用正式账号登录/);
    assert.doesNotMatch(journal, /data-action="memo-new"|data-action="memo-edit"|本次旅行日志内容/);
    const editor = render.renderPage(state, 'journal-editor', { journalMemo: { tripId: state.id, text: '私人正文' } });
    assert.doesNotMatch(editor, /journalEditor|私人正文/);
    const profile = render.renderPage(state, 'profile');
    assert.match(profile, /未登录正式账号/);
    if (!person) assert.doesNotMatch(profile, /data-action="trip-profile-open"/);
  }
});

test('the journal editor keeps the trip selection and safely reloads text and attachments', () => {
  const { render, state, memos } = setup();
  const memo = { ...memos[0], text: '\n第一段\n\n第二段 </textarea>', photos: ['/uploads/journal.webp'] };
  const html = render.renderPage(state, 'journal-editor', { journalMemo: memo });
  assert.match(html, /<form id="journalEditor"[^>]*data-form="memo"/);
  assert.match(html, /<textarea[^>]*aria-label="日志正文"[^>]*rows="14"[\s\S]*第一段\n\n第二段 &lt;\/textarea&gt;/);
  assert.match(html, /<option value="current-trip" selected>/);
  assert.match(html, /data-tab="journal"/);
  assert.match(html, /data-url="\/uploads\/journal.webp"/);
  assert.match(html, /name="file" accept="image\/\*" multiple/);
  assert.doesNotMatch(render.renderPage(state, 'journal-editor', { journalMemo: memos[1] }), /journalEditor|其他旅行日志内容/);
});

test('personal views escape user text and never include account secrets', () => {
  const { render, state, person, user, memos } = setup();
  person.displayName = '<script>PERSON</script>';
  person.avatar = '<script>AVATAR</script>';
  user.username = '<script>ACCOUNT</script>';
  user.displayName = '<script>NICKNAME</script>';
  state.meta.tripName = '<script>TRIP</script>';
  memos[0].text = '<script>JOURNAL</script>';
  for (const page of ['mine', 'profile', 'journal', 'archive', 'settings', 'footprints']) {
    const html = render.renderPage(state, page);
    assert.doesNotMatch(html, /<script>|SHOULD_NOT_RENDER|PRIVATE_KEY_ID/);
    assert.match(html, /&lt;script&gt;TRIP&lt;\/script&gt;/);
  }
  assert.match(render.renderPage(state, 'mine'), /&lt;script&gt;PERSON&lt;\/script&gt;/);
  assert.match(render.renderPage(state, 'profile'), /&lt;script&gt;ACCOUNT&lt;\/script&gt;/);
  assert.match(render.renderPage(state, 'journal'), /&lt;script&gt;JOURNAL&lt;\/script&gt;/);
});

test('archives group every accessible trip by valid travel dates without changing the source order', () => {
  const { render, state, store } = setup();
  const trips = [
    { id: 'undated', meta: { tripName: '日期尚未确定', startDate: '2025-02-29' } },
    { id: 'previous', meta: { tripName: '已归档的旅行', startDate: '2024-02-29', archived: true } },
    { ...state, meta: { ...state.meta, destination: '杭州' }, itinerary: [{ date: '2026-11-23' }, { date: '2026-11-25' }] },
    { id: 'future', meta: { tripName: '跨年旅行', startDate: '2026-12-31', endDate: '2027-01-02' } },
    { id: 'fallback', meta: { tripName: '行程日期兜底', startDate: '2026-13-20' }, itinerary: [{ date: 'invalid' }, { date: '2025-06-15' }] },
  ];
  store.listTrips = () => trips;
  const before = JSON.stringify(trips);
  const html = render.renderPage(state, 'archive');
  const ids = Array.from(html.matchAll(/data-action="trip-open" data-id="([^"]+)"/g), match => match[1]);
  assert.deepEqual(ids, ['future', 'current-trip', 'fallback', 'previous', 'undated']);
  assert.match(html, /2026 年/);
  assert.match(html, /2025 年/);
  assert.match(html, /2024 年/);
  assert.match(html, /待定日期/);
  assert.match(html, /2026年12月31日 — 2027年1月2日/);
  assert.match(html, /2026年11月23日 — 11月25日/);
  assert.match(html, /2024年2月29日/);
  assert.match(html, /当前/);
  assert.match(html, /已归档/);
  assert.match(html, /杭州/);
  assert.match(html, /data-original="\/uploads\/travel-photo.webp"/);
  assert.doesNotMatch(html, /data-action="trip-delete"|data-action="trip-archive"|2025年2月29日|13月20日/);
  assert.equal(JSON.stringify(trips), before);
});

test('archives handle no trips and escape trip identifiers and destination text', () => {
  const { render, state, store } = setup();
  store.listTrips = () => [];
  const empty = render.renderPage(state, 'archive');
  assert.match(empty, /还没有旅行档案/);
  assert.doesNotMatch(empty, /data-action="trip-open"/);
  store.listTrips = () => [{ id: 'trip" onclick="BAD', meta: { tripName: '<script>NAME</script>', destination: '<b>PLACE</b>' } }];
  const html = render.renderPage(state, 'archive');
  assert.match(html, /data-id="trip&quot; onclick=&quot;BAD"/);
  assert.match(html, /&lt;script&gt;NAME&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;PLACE&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>|<b>PLACE|" onclick="BAD/);
});

test('settings reuse supported actions and state the export scope for accounts and guests', () => {
  for (const user of [{ username: 'alice', passwordHash: 'SHOULD_NOT_RENDER', passkeys: [{ id: 'PRIVATE_KEY_ID' }] }, null]) {
    const { render, state } = setup({ user });
    const html = render.renderPage(state, 'settings');
    assert.equal(render.tabTitle('settings'), '设置');
    assert.equal(render.tabTitle('archive'), '旅行档案');
    assert.match(html, /data-action="account-open"/);
    assert.match(html, /data-action="export"/);
    assert.match(html, /不含照片文件、账号和通行密钥，不是完整备份/);
    assert.doesNotMatch(html, /SHOULD_NOT_RENDER|PRIVATE_KEY_ID|data-action="import"/);
    if (user) {
      assert.match(html, /data-action="theme-open"/);
      assert.match(html, /账号与安全/);
    } else {
      assert.doesNotMatch(html, /data-action="theme-open"/);
      assert.match(html, /查看当前身份/);
      assert.match(html, /正式账号登录/);
    }
  }
});

test('footprints render mapped cities, explicit unresolved destinations and safe text', () => {
  const { render, state } = setup();
  const html = render.renderPage(state, 'footprints', { footprintsSummary: {
    tripCount: 3, dayCount: 7, undatedCount: 1, invalidDateCount: 0,
    cities: [
      { key: 'hk', name: '香港', lat: 22.3, lng: 114.1, visits: 2, lastDate: '2026-11-20' },
      { key: 'unknown"key', name: '<script>destination</script>', lat: null, lng: null, visits: 1, lastDate: '2026-11-21' },
    ],
  } });
  assert.equal(render.tabTitle('footprints'), '我的足迹');
  assert.match(html, /id="footprintsCityCount">1</);
  assert.match(html, /<dt>旅行次数<\/dt><dd>3<\/dd>/);
  assert.match(html, /<dt>累计旅行天数<\/dt><dd>7<\/dd>/);
  assert.match(html, /id="footprintsMap"/);
  assert.match(html, /data-action="footprints-fit"/);
  assert.match(html, /待定位 · 点击查找城市/);
  assert.match(html, /data-key="unknown&quot;key"/);
  assert.match(html, /&lt;script&gt;destination&lt;\/script&gt;/);
  assert.match(html, /1 趟旅行缺少有效日期/);
  assert.doesNotMatch(html, /<script>|data-action="trip-delete"/);
});
