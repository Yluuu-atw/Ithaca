'use strict';

/**
 * 数据模型定义 —— 唯一的"数据层"真相源（服务端使用）。
 *
 * 后续要新增/修改字段时，只需改这里 + 前端 store.js 里对应的常量，
 * 呈现层（render.js / app.js）会自动跟随数据结构渲染。
 *
 * 文档结构：
 *   meta        文档级元信息（版本号/更新时间），只管乐观并发
 *   trips[]     旅行列表，每趟旅行是一个独立完整的空间：
 *     meta      这趟旅行的元信息（名称/目的地/日期/币种/成员/是否归档）
 *     itinerary 行程：按天分组，每天若干"安排"
 *     expenses  记账：一条支出
 *     checklist 打包清单：一件要带的物品
 *     wishlist  心愿单：一个想去的地方/想做的事
 *     tracks    足迹：GPX 导入的轨迹
 *     photos    照片：旅行照片（手帐墙）
 *     places    攻略：要订的酒店/餐厅/景点
 *     guides    攻略笔记：小红书等外部收藏
 */

const CATEGORIES = {
  itinerary: ['交通', '景点', '餐饮', '住宿', '购物', '其他'],
  expense: ['餐饮', '交通', '住宿', '门票', '购物', '娱乐', '其他'],
  checklist: ['证件', '衣物', '洗漱', '电子', '药品', '其他'],
};
// 行程条目的二级分类：选完一级才显示对应的子类。空数组表示该大类不拆分。
const SUB_CATEGORIES = {
  '交通': ['飞机', '高铁', '火车', '轮船', '长途汽车', '地铁', '公交', '出租车', '自驾', '步行'],
  '餐饮': ['早餐', '午餐', '晚餐', '下午茶', '夜宵'],
  '住宿': ['酒店', '民宿', '青旅', '露营', '亲友家'],
  '购物': ['特产', '手信', '免税店', '其他'],
  '景点': [],
  '其他': [],
};
// 行程条目的费用同步到记账时，落到记账的哪个分类上
const ITEM_TO_EXPENSE_CATEGORY = {
  '交通': '交通', '餐饮': '餐饮', '住宿': '住宿', '购物': '购物', '景点': '门票', '其他': '其他',
};

const PRIORITIES = ['高', '中', '低'];
const WISH_STATUS = ['想去', '排入行程', '已完成'];
const PLACE_CATEGORIES = ['住宿', '餐饮', '景点', '交通', '购物', '娱乐', '其他'];
const PLACE_STATUS = ['想去', '待订', '已订'];
const BOOKING_TYPES = ['flight', 'train', 'bus', 'hotel', 'other'];
const BOOKING_STATUS = ['待订', '已订', '已完成', '已取消'];
const GUIDE_TAGS = ['美食', '景点', '住宿', '交通', '购物', '避坑', '行程', '其他'];
const CURRENCY_SYMBOL = {
  CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£',
  KRW: '₩', TWD: 'NT$', HKD: 'HK$', THB: '฿', SGD: 'S$',
};

// 打包模板：按旅行类型给推荐物品，减少逐条输入。
// category 必须落在 CATEGORIES.checklist 的六个分类里。
const PACKING_TEMPLATES = [
  {
    id: 'tpl_general', name: '通用', icon: '🎒',
    items: [
      { name: '身份证', category: '证件' }, { name: '护照', category: '证件' },
      { name: '银行卡', category: '证件' }, { name: '现金', category: '证件' },
      { name: '内衣裤', category: '衣物' }, { name: '袜子', category: '衣物' },
      { name: '睡衣', category: '衣物' }, { name: '换洗T恤', category: '衣物' },
      { name: '外套', category: '衣物' },
      { name: '牙刷', category: '洗漱' }, { name: '牙膏', category: '洗漱' },
      { name: '洗面奶', category: '洗漱' }, { name: '毛巾', category: '洗漱' },
      { name: '洗发水', category: '洗漱' }, { name: '沐浴露', category: '洗漱' },
      { name: '手机', category: '电子' }, { name: '充电器', category: '电子' },
      { name: '充电宝', category: '电子' }, { name: '耳机', category: '电子' },
      { name: '感冒药', category: '药品' }, { name: '肠胃药', category: '药品' },
      { name: '创可贴', category: '药品' },
      { name: '纸巾', category: '其他' }, { name: '湿巾', category: '其他' },
      { name: '水杯', category: '其他' }, { name: '雨伞', category: '其他' },
    ],
  },
  {
    id: 'tpl_island', name: '海岛', icon: '🏝️',
    items: [
      { name: '护照', category: '证件' }, { name: '身份证', category: '证件' },
      { name: '泳衣', category: '衣物' }, { name: '沙滩裤', category: '衣物' },
      { name: '遮阳帽', category: '衣物' }, { name: '防晒衫', category: '衣物' },
      { name: '沙滩拖鞋', category: '衣物' }, { name: '墨镜', category: '衣物' },
      { name: '防晒霜', category: '洗漱' }, { name: '晒后修复', category: '洗漱' },
      { name: '防水手机套', category: '电子' }, { name: '运动相机', category: '电子' },
      { name: '浮潜面镜', category: '其他' }, { name: '沙滩巾', category: '其他' },
      { name: '防水袋', category: '其他' }, { name: '防蚊液', category: '其他' },
    ],
  },
  {
    id: 'tpl_city', name: '城市', icon: '🏙️',
    items: [
      { name: '身份证', category: '证件' }, { name: '学生证/优待证', category: '证件' },
      { name: '舒适走路鞋', category: '衣物' }, { name: '轻便外套', category: '衣物' },
      { name: '换洗衣物', category: '衣物' }, { name: '遮阳帽', category: '衣物' },
      { name: '防晒霜', category: '洗漱' }, { name: '免洗洗手液', category: '洗漱' },
      { name: '充电宝', category: '电子' }, { name: '耳机', category: '电子' },
      { name: '购物袋', category: '其他' }, { name: '折叠伞', category: '其他' },
      { name: '保温杯', category: '其他' }, { name: '双肩包', category: '其他' },
    ],
  },
  {
    id: 'tpl_ski', name: '滑雪', icon: '⛷️',
    items: [
      { name: '身份证', category: '证件' }, { name: '保险单', category: '证件' },
      { name: '滑雪服', category: '衣物' }, { name: '保暖内衣', category: '衣物' },
      { name: '滑雪袜', category: '衣物' }, { name: '雪地靴', category: '衣物' },
      { name: '帽子手套围巾', category: '衣物' },
      { name: '润肤霜', category: '洗漱' }, { name: '唇膏', category: '洗漱' },
      { name: '防晒霜', category: '洗漱' },
      { name: '滑雪镜', category: '其他' }, { name: '头盔', category: '其他' },
      { name: '护膝护臀', category: '其他' }, { name: '暖宝宝', category: '其他' },
      { name: '保温杯', category: '其他' },
    ],
  },
  {
    id: 'tpl_road', name: '自驾', icon: '🚗',
    items: [
      { name: '驾照', category: '证件' }, { name: '行驶证', category: '证件' },
      { name: '身份证', category: '证件' },
      { name: '墨镜', category: '衣物' }, { name: '舒适鞋子', category: '衣物' },
      { name: '车充', category: '电子' }, { name: '手机支架', category: '电子' },
      { name: '行车记录仪', category: '电子' }, { name: '充电宝', category: '电子' },
      { name: '零食', category: '其他' }, { name: '饮用水', category: '其他' },
      { name: '车载垃圾袋', category: '其他' }, { name: '纸巾', category: '其他' },
      { name: '雨伞', category: '其他' }, { name: 'U型枕', category: '其他' },
    ],
  },
  {
    id: 'tpl_hike', name: '登山', icon: '🥾',
    items: [
      { name: '身份证', category: '证件' }, { name: '保险单', category: '证件' },
      { name: '登山鞋', category: '衣物' }, { name: '速干衣', category: '衣物' },
      { name: '冲锋衣', category: '衣物' }, { name: '登山袜', category: '衣物' },
      { name: '帽子', category: '衣物' },
      { name: '防晒霜', category: '洗漱' }, { name: '湿巾', category: '洗漱' },
      { name: '头灯', category: '电子' }, { name: '充电宝', category: '电子' },
      { name: '创可贴', category: '药品' }, { name: '碘伏', category: '药品' },
      { name: '弹力绷带', category: '药品' }, { name: '藿香正气水', category: '药品' },
      { name: '登山杖', category: '其他' }, { name: '登山包', category: '其他' },
      { name: '水袋', category: '其他' }, { name: '能量棒', category: '其他' },
      { name: '防水袋', category: '其他' },
    ],
  },
  {
    id: 'tpl_cruise', name: '游轮', icon: '🚢',
    items: [
      { name: '护照', category: '证件' }, { name: '签证', category: '证件' },
      { name: '船票', category: '证件' }, { name: '旅行保险单', category: '证件' },
      { name: '正装', category: '衣物' }, { name: '泳衣', category: '衣物' },
      { name: '防风外套', category: '衣物' }, { name: '沙滩拖鞋', category: '衣物' },
      { name: '晕船药', category: '药品' }, { name: '肠胃药', category: '药品' },
      { name: '防晒霜', category: '洗漱' },
      { name: '望远镜', category: '其他' }, { name: '防水袋', category: '其他' },
    ],
  },
  {
    id: 'tpl_biz', name: '商务', icon: '💼',
    items: [
      { name: '身份证', category: '证件' }, { name: '护照', category: '证件' },
      { name: '名片', category: '证件' },
      { name: '正装', category: '衣物' }, { name: '皮鞋', category: '衣物' },
      { name: '领带/丝巾', category: '衣物' }, { name: '换洗衬衫', category: '衣物' },
      { name: '笔记本电脑', category: '电子' }, { name: '电脑充电器', category: '电子' },
      { name: '鼠标', category: '电子' }, { name: '转接头', category: '电子' },
      { name: 'U盘', category: '电子' }, { name: '手机充电器', category: '电子' },
      { name: '文件袋', category: '其他' }, { name: '笔记本', category: '其他' },
      { name: '钢笔', category: '其他' },
    ],
  },
];

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 一趟旅行的完整空间。每趟能装下全部模块，互不干扰。
function defaultTrip() {
  return {
    id: uid('trip'),
    meta: {
      tripName: '我们的旅行',
      destination: '',
      startDate: '',
      endDate: '',
      currency: 'CNY',
      members: [],
      avatars: [],   // 与 members 一一对应
      colors: [],   // 与 members 一一对应，用于按付款人区分
      archived: false,
      packingTypes: [],   // 本趟用到的打包模板 id，候选池取并集；空则只显示「通用」
      stops: [],   // 途径地点，手动维护的城市/站点级概括；空数组则回退到从行程条目自动推导
    },
    itinerary: [], // Day membership follows the item's start date; order only controls items within a day.
    expenses: [],  // Ledger entries; optional receipt metadata and images share the same financial amount.
    checklist: [], // [{ id, name, category, checked, owner }]
    wishlist: [],  // [{ id, name, location, note, priority, status }]
    tracks: [],    // [{ id, name, date, color, points: [{ lat, lng, ele, time }] }]
    photos: [],    // [{ id, url, thumb, date, caption, location, lat, lng }]
    places: [],    // [{ id, name, category, location, lat, lng, date, note, status, cost, link }]
    guides: [],    // [{ id, title, link, cover, tags: [], note }] 攻略笔记（小红书等外部收藏）
  };
}

// 文档级元信息只管乐观并发，其余全在 trips 里
function defaultMemo() {
  return { id: uid('memo'), text: '', photos: [], tripId: '', createdAt: new Date().toISOString() };
}
function normalizeMemo(raw) {
  const m = defaultMemo();
  const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  if (typeof s.id === 'string' && s.id) m.id = s.id;
  if (typeof s.text === 'string') m.text = s.text;
  if (Array.isArray(s.photos)) m.photos = s.photos.filter(p => typeof p === 'string' && p);
  if (typeof s.tripId === 'string') m.tripId = s.tripId;
  if (typeof s.createdAt === 'string' && s.createdAt) m.createdAt = s.createdAt;
  return m;
}

// 打包模板条目只认 { name, category }，category 不在六分类里的落到「其他」
function normalizeTemplate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .filter(i => i && typeof i.name === 'string' && i.name.trim())
    .map(i => ({
      name: i.name.trim(),
      category: CATEGORIES.checklist.includes(i.category) ? i.category : '其他',
    }));
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('tpl'),
    name: name || '未命名',
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : '📦',
    items,
  };
}

const DEFAULT_WELCOME_THEME = '#f2ece0';
function defaultPackingTemplates() {
  return PACKING_TEMPLATES.map(template => ({
    id: template.id, name: template.name, icon: template.icon,
    items: template.items.map(item => ({ name: item.name, category: item.category })),
  }));
}

function defaultProfile() {
  return { welcomeTheme: DEFAULT_WELCOME_THEME, memos: [], packingTemplates: defaultPackingTemplates() };
}

// Document metadata is used only for optimistic concurrency.
function defaultDoc() {
  return {
    meta: { version: 1, updatedAt: new Date().toISOString() },
    trips: [],
    access: {},
    assets: {},
    profiles: {},
  };
}

const TRIP_LISTS = ['itinerary', 'expenses', 'checklist', 'wishlist', 'tracks', 'photos', 'places', 'guides'];
const RECEIPT_FIELDS = new Set([
  'type', 'status', 'date', 'time', 'from', 'to', 'endDate', 'endTime',
  'carrier', 'seat', 'refNo', 'link', 'price', 'images', 'needsReview',
]);

// 归一化一趟旅行：meta 补默认值，集合字段确保是数组，未知字段原样保留
function normalizeTrip(raw) {
  if (!isRecord(raw) || !isRecord(raw.meta)) throw new Error('旅行格式无效');
  if (Object.hasOwn(raw, 'bookings')) throw new Error('旅行包含旧预订字段');
  if (raw.itinerary !== undefined && !Array.isArray(raw.itinerary)) throw new Error('行程格式无效');
  if (raw.expenses !== undefined && !Array.isArray(raw.expenses)) throw new Error('账单格式无效');
  for (const key of ['theme', 'version', 'updatedAt']) {
    if (Object.hasOwn(raw.meta, key)) throw new Error(`旅行包含旧字段 meta.${key}`);
  }
  for (const day of raw.itinerary || []) {
    for (const item of day && day.items || []) {
      if (item && Object.hasOwn(item, 'estimatedCost')) throw new Error('行程包含旧费用字段');
    }
  }
  for (const expense of raw.expenses || []) {
    if (!isRecord(expense) || typeof expense.title !== 'string' || !Array.isArray(expense.participants)) {
      throw new Error('账单格式无效');
    }
    if (Object.hasOwn(expense, 'split')) throw new Error('账单包含旧分摊字段');
    if (expense.receipt !== undefined && expense.receipt !== null) {
      if (!isRecord(expense.receipt)) throw new Error('票据格式无效');
      for (const key of Object.keys(expense.receipt)) {
        if (!RECEIPT_FIELDS.has(key)) throw new Error(`票据包含无效字段 ${key}`);
      }
    }
  }
  const t = defaultTrip();
  const src = raw;

  t.id = typeof src.id === 'string' && src.id ? src.id : t.id;
  t.meta = Object.assign(t.meta, src.meta || {});
  t.meta.tripName = String(t.meta.tripName || '我们的旅行');
  if (!Array.isArray(t.meta.members)) t.meta.members = [];
  // 头像必须与成员一一对应：缺的补默认，多的截掉
  const DEFAULT_AVATARS = ['😎', '🥰', '🐻', '🐱'];
  const av = Array.isArray(t.meta.avatars) ? t.meta.avatars : [];
  t.meta.avatars = t.meta.members.map((_, i) => (av[i] ? String(av[i]) : DEFAULT_AVATARS[i % DEFAULT_AVATARS.length]));
  // 同理，颜色也要与成员对齐
  const DEFAULT_COLORS = ['#e6a877', '#6f9e8f', '#7c9fd9', '#c98bb8'];
  const cl = Array.isArray(t.meta.colors) ? t.meta.colors : [];
  t.meta.colors = t.meta.members.map((_, i) => (cl[i] ? String(cl[i]) : DEFAULT_COLORS[i % DEFAULT_COLORS.length]));
  t.meta.archived = !!t.meta.archived;
  // 本趟用到的打包模板 id：只留字符串，模板本身存不存在由前端兜底
  t.meta.packingTypes = Array.isArray(t.meta.packingTypes)
    ? t.meta.packingTypes.filter(x => typeof x === 'string' && x)
    : [];
  // 途径地点：只留非空字符串。留空表示回退到从行程条目自动推导
  t.meta.stops = Array.isArray(t.meta.stops)
    ? t.meta.stops.map(x => typeof x === 'string' ? x.trim() : '').filter(Boolean)
    : [];

  for (const k of TRIP_LISTS) t[k] = Array.isArray(src[k]) ? src[k] : [];

  return Object.assign({}, src, t);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(path, reason) {
  throw new Error(`Invalid stored data at ${path}: ${reason}`);
}

function requireRecord(value, path) {
  if (!isRecord(value)) invalid(path, 'expected an object');
  return value;
}

function requireArray(value, path) {
  if (!Array.isArray(value)) invalid(path, 'expected an array');
  return value;
}

function requireString(value, path, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value)) invalid(path, 'expected a string');
  return value;
}

function requireKeys(value, keys, path, optional = []) {
  requireRecord(value, path);
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'missing field');
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) invalid(`${path}.${key}`, 'unknown field');
}

// Persisted data must already use the current shape. Startup and writes never repair it.
function validateStoredDoc(raw) {
  requireKeys(raw, ['meta', 'trips', 'access', 'assets', 'profiles'], 'db');
  requireKeys(raw.meta, ['version', 'updatedAt'], 'db.meta');
  if (!Number.isSafeInteger(raw.meta.version) || raw.meta.version < 1) invalid('db.meta.version', 'expected a positive integer');
  requireString(raw.meta.updatedAt, 'db.meta.updatedAt');
  requireArray(raw.trips, 'db.trips');
  requireRecord(raw.access, 'db.access');
  requireRecord(raw.assets, 'db.assets');
  requireRecord(raw.profiles, 'db.profiles');

  const tripIds = new Set();
  const tripMetaKeys = ['tripName', 'destination', 'startDate', 'endDate', 'currency', 'members', 'avatars', 'colors', 'archived', 'packingTypes'];
  for (const [index, trip] of raw.trips.entries()) {
    const path = `db.trips[${index}]`;
    requireKeys(trip, ['id', 'meta', ...TRIP_LISTS], path);
    requireString(trip.id, `${path}.id`);
    if (tripIds.has(trip.id)) invalid(`${path}.id`, 'duplicate trip ID');
    tripIds.add(trip.id);
    requireKeys(trip.meta, tripMetaKeys, `${path}.meta`, ['stops']);
    if (Object.hasOwn(trip.meta, 'stops')) {
      requireArray(trip.meta.stops, `${path}.meta.stops`);
      for (const [stopIndex, stop] of trip.meta.stops.entries()) requireString(stop, `${path}.meta.stops[${stopIndex}]`);
    }
    for (const key of ['tripName', 'destination', 'startDate', 'endDate', 'currency']) {
      requireString(trip.meta[key], `${path}.meta.${key}`, key !== 'tripName' && key !== 'currency');
    }
    if (typeof trip.meta.archived !== 'boolean') invalid(`${path}.meta.archived`, 'expected a boolean');
    for (const key of ['members', 'avatars', 'colors', 'packingTypes']) {
      requireArray(trip.meta[key], `${path}.meta.${key}`);
      for (const [itemIndex, value] of trip.meta[key].entries()) requireString(value, `${path}.meta.${key}[${itemIndex}]`);
    }
    if (trip.meta.members.length !== trip.meta.avatars.length || trip.meta.members.length !== trip.meta.colors.length) {
      invalid(`${path}.meta`, 'member names, avatars, and colors must align');
    }
    for (const key of TRIP_LISTS) requireArray(trip[key], `${path}.${key}`);
    const grant = raw.access[trip.id];
    requireKeys(grant, ['ownerId', 'members', 'invites', 'share', 'people'], `db.access.${trip.id}`);
    requireString(grant.ownerId, `db.access.${trip.id}.ownerId`);
    requireRecord(grant.members, `db.access.${trip.id}.members`);
    for (const [userId, role] of Object.entries(grant.members)) {
      if (!userId || !['editor', 'viewer'].includes(role)) invalid(`db.access.${trip.id}.members.${userId}`, 'invalid role');
    }
    requireArray(grant.invites, `db.access.${trip.id}.invites`);
    for (const [inviteIndex, invite] of grant.invites.entries()) {
      const invitePath = `db.access.${trip.id}.invites[${inviteIndex}]`;
      requireKeys(invite, ['id', 'hash', 'role', 'expiresAt'], invitePath);
      requireString(invite.id, `${invitePath}.id`);
      requireString(invite.hash, `${invitePath}.hash`);
      if (!['editor', 'viewer'].includes(invite.role)) invalid(`${invitePath}.role`, 'invalid role');
      if (!Number.isFinite(invite.expiresAt)) invalid(`${invitePath}.expiresAt`, 'expected a timestamp');
    }
    if (grant.share !== null) {
      requireKeys(grant.share, ['hash', 'createdAt'], `db.access.${trip.id}.share`);
      requireString(grant.share.hash, `db.access.${trip.id}.share.hash`);
      requireString(grant.share.createdAt, `db.access.${trip.id}.share.createdAt`);
    }
    requireArray(grant.people, `db.access.${trip.id}.people`);
    if (!grant.people.length) invalid(`db.access.${trip.id}.people`, 'owner identity is missing');
    const peopleIds = new Set();
    const peopleNames = new Set();
    for (const [personIndex, person] of grant.people.entries()) {
      const personPath = `db.access.${trip.id}.people[${personIndex}]`;
      requireRecord(person, personPath);
      for (const key of Object.keys(person)) {
        if (!['id', 'kind', 'userId', 'name', 'avatar', 'color', 'tokenHash', 'tripNickname', 'transferStates'].includes(key)) {
          invalid(`${personPath}.${key}`, 'unknown field');
        }
      }
      for (const key of ['id', 'name', 'avatar', 'color']) requireString(person[key], `${personPath}.${key}`);
      if (!['formal', 'temporary', 'unlinked'].includes(person.kind)) invalid(`${personPath}.kind`, 'invalid identity type');
      if (person.kind === 'formal') requireString(person.userId, `${personPath}.userId`);
      if (person.kind === 'temporary') requireString(person.tokenHash, `${personPath}.tokenHash`);
      if (person.kind === 'unlinked' && (person.userId || person.tokenHash)) invalid(personPath, 'unlinked identity still has credentials');
      if (person.tripNickname !== undefined) requireString(person.tripNickname, `${personPath}.tripNickname`, true);
      if (person.transferStates !== undefined) {
        requireRecord(person.transferStates, `${personPath}.transferStates`);
        for (const [key, value] of Object.entries(person.transferStates)) {
          if (value !== true) invalid(`${personPath}.transferStates.${key}`, 'expected a confirmed transfer');
        }
      }
      if (peopleIds.has(person.id) || peopleNames.has(person.name)) invalid(personPath, 'duplicate identity');
      peopleIds.add(person.id);
      peopleNames.add(person.name);
    }
    if (!grant.people.some(person => person.kind === 'formal' && person.userId === grant.ownerId)) {
      invalid(`db.access.${trip.id}.people`, 'owner identity is missing');
    }
    for (const userId of Object.keys(grant.members)) {
      if (!grant.people.some(person => person.kind === 'formal' && person.userId === userId)) {
        invalid(`db.access.${trip.id}.members.${userId}`, 'member identity is missing');
      }
    }
    for (const [personIndex, person] of grant.people.entries()) {
      if (trip.meta.members[personIndex] !== person.name || trip.meta.avatars[personIndex] !== person.avatar || trip.meta.colors[personIndex] !== person.color) {
        invalid(`${path}.meta.members`, 'trip roster differs from access roster');
      }
    }
    for (const collection of TRIP_LISTS) {
      const itemIds = new Set();
      for (const [itemIndex, item] of trip[collection].entries()) {
        const itemPath = `${path}.${collection}[${itemIndex}]`;
        requireRecord(item, itemPath);
        requireString(item.id, `${itemPath}.id`);
        if (itemIds.has(item.id)) invalid(`${itemPath}.id`, 'duplicate record ID');
        itemIds.add(item.id);
        requireString(item.authorId, `${itemPath}.authorId`);
        if (!peopleIds.has(item.authorId)) invalid(`${itemPath}.authorId`, 'unknown author');
        if (collection === 'expenses') {
          if (Object.hasOwn(item, 'split')) invalid(`${itemPath}.split`, 'obsolete field');
          requireString(item.title, `${itemPath}.title`, true);
          requireArray(item.participants, `${itemPath}.participants`);
          if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) invalid(`${itemPath}.amount`, 'expected an amount');
          requireString(item.payer, `${itemPath}.payer`, true);
          for (const participant of item.participants) if (!peopleNames.has(participant)) invalid(`${itemPath}.participants`, 'unknown member');
          if (item.receipt !== null && item.receipt !== undefined) {
            requireRecord(item.receipt, `${itemPath}.receipt`);
            for (const key of Object.keys(item.receipt)) {
              if (!RECEIPT_FIELDS.has(key)) invalid(`${itemPath}.receipt.${key}`, 'unknown field');
            }
          }
        }
        if (collection === 'itinerary') {
          requireArray(item.items, `${itemPath}.items`);
          for (const [nestedIndex, nested] of item.items.entries()) {
            const nestedPath = `${itemPath}.items[${nestedIndex}]`;
            requireRecord(nested, nestedPath);
            requireString(nested.id, `${nestedPath}.id`);
            requireString(nested.authorId, `${nestedPath}.authorId`);
            if (!peopleIds.has(nested.authorId)) invalid(`${nestedPath}.authorId`, 'unknown author');
            if (Object.hasOwn(nested, 'estimatedCost')) invalid(`${nestedPath}.estimatedCost`, 'obsolete field');
          }
        }
      }
    }
  }
  for (const tripId of Object.keys(raw.access)) if (!tripIds.has(tripId)) invalid(`db.access.${tripId}`, 'unknown trip');

  for (const [name, asset] of Object.entries(raw.assets)) {
    const path = `db.assets.${name}`;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) invalid(path, 'invalid asset name');
    requireKeys(asset, ['tripId', 'ownerId', 'createdAt'], path);
    if (asset.tripId !== null) requireString(asset.tripId, `${path}.tripId`);
    if (asset.ownerId !== null) requireString(asset.ownerId, `${path}.ownerId`);
    if (!asset.tripId && !asset.ownerId) invalid(path, 'asset has no owner');
    requireString(asset.createdAt, `${path}.createdAt`, true);
  }
  for (const [userId, profile] of Object.entries(raw.profiles)) {
    const path = `db.profiles.${userId}`;
    if (!userId) invalid(path, 'invalid user ID');
    requireKeys(profile, ['welcomeTheme', 'memos', 'packingTemplates'], path);
    requireString(profile.welcomeTheme, `${path}.welcomeTheme`);
    requireArray(profile.memos, `${path}.memos`);
    requireArray(profile.packingTemplates, `${path}.packingTemplates`);
    for (const [memoIndex, memo] of profile.memos.entries()) {
      const memoPath = `${path}.memos[${memoIndex}]`;
      requireKeys(memo, ['id', 'text', 'photos', 'tripId', 'createdAt'], memoPath);
      requireString(memo.id, `${memoPath}.id`);
      requireString(memo.text, `${memoPath}.text`, true);
      requireString(memo.tripId, `${memoPath}.tripId`, true);
      requireString(memo.createdAt, `${memoPath}.createdAt`);
      requireArray(memo.photos, `${memoPath}.photos`);
      for (const photo of memo.photos) requireString(photo, `${memoPath}.photos[]`);
    }
    for (const [templateIndex, template] of profile.packingTemplates.entries()) {
      const templatePath = `${path}.packingTemplates[${templateIndex}]`;
      requireKeys(template, ['id', 'name', 'icon', 'items'], templatePath);
      for (const key of ['id', 'name', 'icon']) requireString(template[key], `${templatePath}.${key}`);
      requireArray(template.items, `${templatePath}.items`);
      for (const [itemIndex, item] of template.items.entries()) {
        const itemPath = `${templatePath}.items[${itemIndex}]`;
        requireKeys(item, ['name', 'category'], itemPath);
        requireString(item.name, `${itemPath}.name`);
        if (!CATEGORIES.checklist.includes(item.category)) invalid(`${itemPath}.category`, 'unknown category');
      }
    }
  }
  return raw;
}

module.exports = {
  CATEGORIES,
  SUB_CATEGORIES,
  ITEM_TO_EXPENSE_CATEGORY,
  PRIORITIES,
  WISH_STATUS,
  PLACE_CATEGORIES,
  PLACE_STATUS,
  BOOKING_TYPES,
  BOOKING_STATUS,
  GUIDE_TAGS,
  CURRENCY_SYMBOL,
  uid,
  defaultDoc,
  defaultTrip,
  defaultProfile,
  defaultPackingTemplates,
  validateStoredDoc,
  normalizeTrip,
  normalizeMemo,
  normalizeTemplate,
  TRIP_LISTS,
};
