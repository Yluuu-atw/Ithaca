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
 *     bookings  Legacy reservation import input; emptied after ledger migration
 *     guides    攻略笔记：小红书等外部收藏
 */

const CATEGORIES = {
  itinerary: ['交通', '景点', '餐饮', '住宿', '购物', '其他'],
  expense: ['餐饮', '交通', '住宿', '门票', '购物', '娱乐', '其他'],
  checklist: ['证件', '衣物', '洗漱', '电子', '药品', '其他'],
};
const { ensureRoster } = require('./people');

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

const SPLIT_OPTIONS = ['均摊', '单方'];
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
      members: ['我', '她'],
      avatars: ['😎', '🥰'],   // 与 members 一一对应
      colors: ['#e6a877', '#6f9e8f'],   // 与 members 一一对应，用于按付款人区分
      archived: false,
      packingTypes: [],   // 本趟用到的打包模板 id，候选池取并集；空则只显示「通用」
    },
    itinerary: [], // Day records may set fromExpense when created by an expense. Item startDate/endDate do not affect order.
    expenses: [],  // Ledger entries; optional receipt metadata and images share the same financial amount.
    checklist: [], // [{ id, name, category, checked, owner }]
    wishlist: [],  // [{ id, name, location, note, priority, status }]
    tracks: [],    // [{ id, name, date, color, points: [{ lat, lng, ele, time }] }]
    photos: [],    // [{ id, url, thumb, date, caption, location, lat, lng }]
    places: [],    // [{ id, name, category, location, lat, lng, date, note, status, cost, link }]
    bookings: [],  // Legacy import input; the receipt fields live on expenses after migration.
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

// 文档级元信息：乐观并发 + 首页背景色（首页与每趟旅行各存各的，互不影响）
const DEFAULT_WELCOME_THEME = '#f2ece0';
function defaultDoc() {
  return {
    meta: { version: 1, updatedAt: new Date().toISOString(), welcomeTheme: DEFAULT_WELCOME_THEME },
    trips: [defaultTrip()],
    memos: [],
    access: {},
    assets: {},
    profiles: {},
    packingTemplates: PACKING_TEMPLATES.map(t => ({
      id: t.id, name: t.name, icon: t.icon,
      items: t.items.map(i => ({ name: i.name, category: i.category })),
    })),
  };
}

// 一趟旅行的集合字段，迁移与归一化都要用
const TRIP_LISTS = ['itinerary', 'expenses', 'checklist', 'wishlist', 'tracks', 'photos', 'places', 'bookings', 'guides'];

// 未知字段的一次性告警：同一个 key 只提示一次，避免每次请求刷屏
const warnedUnknown = new Set();

// 归一化一趟旅行：meta 补默认值，集合字段确保是数组，未知字段原样保留
function normalizeTrip(raw) {
  const t = defaultTrip();
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  t.id = typeof src.id === 'string' && src.id ? src.id : t.id;
  t.meta = Object.assign(t.meta, src.meta || {});
  t.meta.tripName = String(t.meta.tripName || '我们的旅行');
  if (!Array.isArray(t.meta.members) || t.meta.members.length === 0) {
    t.meta.members = ['我', '她'];
  }
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

  for (const k of TRIP_LISTS) t[k] = Array.isArray(src[k]) ? src[k] : [];

  // 行程条目的 estimatedCost 改名为 amount，与记账同名，两边同步就不再是「翻译」。
  // 一次性迁移，改完即删旧字段，前端永远只看到 amount。
  for (const day of t.itinerary) {
    for (const it of ((day && day.items) || [])) {
      if (it && it.estimatedCost !== undefined) {
        if (it.amount === undefined) it.amount = it.estimatedCost;
        delete it.estimatedCost;
      }
    }
  }

  // 记账早先只有一个 note，它实际充当「名称」（列表拿它当标题）。
  // 改名为 title 与行程条目同名，另留 note 作备注，两边同步变纯复制。
  for (const ex of t.expenses) {
    if (ex && ex.title === undefined && ex.note !== undefined) {
      ex.title = ex.note;
      ex.note = '';
    }
  }

  return Object.assign({}, src, t);
}

// 旧结构迁移：多旅行版之前数据是平铺在文档顶层的（meta.tripName + 顶层集合）。
// 检测到旧结构就整体包成 trips[0]，一条数据都不丢。
function isLegacyDoc(doc) {
  return !Array.isArray(doc.trips) && (doc.meta && 'tripName' in doc.meta);
}

function migrateLegacy(doc) {
  const trip = normalizeTrip(Object.assign({}, doc, { id: undefined, meta: doc.meta || {} }));
  return {
    meta: {
      version: Number(doc.meta && doc.meta.version) || 1,
      updatedAt: (doc.meta && doc.meta.updatedAt) || new Date().toISOString(),
    },
    trips: [trip],
  };
}

// 归一化：保证已知字段符合结构，缺的补默认值。
// 未知字段原样保留——白名单式归一化会静默丢数据（服务进程比前端旧、导入未来版本的
// 备份都会中招），表现为「保存成功但没存上」。
function normalize(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return defaultDoc();

  // 旧结构先迁移，再走新结构的归一化
  const source = isLegacyDoc(doc) ? migrateLegacy(doc) : doc;
  const d = defaultDoc();

  d.meta.version = Number(source.meta && source.meta.version) || 1;
  d.meta.updatedAt = (source.meta && source.meta.updatedAt) || d.meta.updatedAt;
  // 首页背景色是后加的字段，老数据里没有；没有就先落到纸色
  d.meta.welcomeTheme = (typeof (source.meta && source.meta.welcomeTheme) === 'string' && source.meta.welcomeTheme)
    || DEFAULT_WELCOME_THEME;

  const rawTrips = Array.isArray(source.trips) ? source.trips : [];
  d.trips = rawTrips.length ? rawTrips.map(normalizeTrip) : [defaultTrip()];

  // 备忘录是文档级的，不属于任何一趟旅行；tripId 只是可选关联
  d.memos = Array.isArray(source.memos) ? source.memos.map(normalizeMemo) : [];

  // Access and asset ownership are server-only. Browser document updates must never
  // pass these fields through to persistence.
  d.access = {};
  for (const [tripId, entry] of Object.entries(source.access || {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const ownerId = typeof entry.ownerId === 'string' ? entry.ownerId : '';
    if (!ownerId) continue;
    const members = {};
    for (const [userId, role] of Object.entries(entry.members || {})) {
      if (role === 'editor' || role === 'viewer') members[userId] = role;
    }
    d.access[tripId] = {
      ownerId,
      members,
      invites: Array.isArray(entry.invites) ? entry.invites : [],
      share: entry.share && typeof entry.share === 'object' ? entry.share : null,
      people: Array.isArray(entry.people) ? entry.people : [],
    };
  }
  for (const trip of d.trips) ensureRoster(trip, d.access[trip.id]);
  d.assets = {};
  for (const [name, entry] of Object.entries(source.assets || {})) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const tripId = typeof entry.tripId === 'string' ? entry.tripId : null;
    const ownerId = typeof entry.ownerId === 'string' ? entry.ownerId : null;
    if (!tripId && !ownerId) continue;
    d.assets[name] = { tripId, ownerId, createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '' };
  }
  d.profiles = {};
  for (const [userId, entry] of Object.entries(source.profiles || {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    d.profiles[userId] = {
      welcomeTheme: typeof entry.welcomeTheme === 'string' ? entry.welcomeTheme : DEFAULT_WELCOME_THEME,
      memos: Array.isArray(entry.memos) ? entry.memos.map(normalizeMemo) : [],
      packingTemplates: Array.isArray(entry.packingTemplates)
        ? entry.packingTemplates.map(normalizeTemplate).filter(Boolean) : [],
    };
  }

  // 打包模板也是文档级的，跨旅行复用。老数据没有就补内置的，用户改过的一律保留。
  d.packingTemplates = Array.isArray(source.packingTemplates) && source.packingTemplates.length
    ? source.packingTemplates.map(normalizeTemplate).filter(Boolean)
    : d.packingTemplates;

  for (const k of Object.keys(source)) {
    if (!(k in d) && !warnedUnknown.has(k)) {
      warnedUnknown.add(k);
      console.warn(`[schema] 未知字段「${k}」已原样保留；若这是新加的字段，服务端需要重启`);
    }
  }

  return Object.assign({}, source, d);
}

module.exports = {
  CATEGORIES,
  SUB_CATEGORIES,
  ITEM_TO_EXPENSE_CATEGORY,
  SPLIT_OPTIONS,
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
  normalize,
  normalizeTrip,
  normalizeMemo,
  normalizeTemplate,
  TRIP_LISTS,
};
