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
 *     bookings  票据：机票/火车票/酒店等预订凭证
 *     guides    攻略笔记：小红书等外部收藏
 */

const CATEGORIES = {
  itinerary: ['交通', '景点', '餐饮', '住宿', '购物', '其他'],
  expense: ['餐饮', '交通', '住宿', '门票', '购物', '娱乐', '其他'],
  checklist: ['证件', '衣物', '洗漱', '电子', '药品', '其他'],
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
    },
    itinerary: [], // [{ id, date, items: [{ id, time, endTime, title, location, lat, lng, note, category, estimatedCost }] }]
    expenses: [],  // [{ id, date, time, amount, category, payer, split, note }]
    checklist: [], // [{ id, name, category, checked, owner }]
    wishlist: [],  // [{ id, name, location, note, priority, status }]
    tracks: [],    // [{ id, name, date, color, points: [{ lat, lng, ele, time }] }]
    photos: [],    // [{ id, url, thumb, date, caption, location, lat, lng }]
    places: [],    // [{ id, name, category, location, lat, lng, date, note, status, cost, link }]
    bookings: [],  // [{ id, type, title, status, date, time, endDate, endTime, from, to, carrier, seat, refNo, price, payer, link, note }]
    guides: [],    // [{ id, title, link, cover, tags: [], note }] 攻略笔记（小红书等外部收藏）
  };
}

// 文档级元信息只管乐观并发与界面偏好（背景色），其余全在 trips 里
const DEFAULT_THEME = '#f2ece0';
function defaultDoc() {
  return {
    meta: { version: 1, updatedAt: new Date().toISOString(), theme: DEFAULT_THEME },
    trips: [defaultTrip()],
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

  for (const k of TRIP_LISTS) t[k] = Array.isArray(src[k]) ? src[k] : [];

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

  const rawTrips = Array.isArray(source.trips) ? source.trips : [];
  d.trips = rawTrips.length ? rawTrips.map(normalizeTrip) : [defaultTrip()];

  // 背景色是界面偏好而非旅行数据，整份文档一份；早期挂在 trip.meta 上，
  // 首次读到时提升到文档级，保住用户当下看到的颜色
  const inherited = (source.meta && source.meta.theme)
    || d.trips.map(t => t.meta.theme).find(v => typeof v === 'string' && v);
  d.meta.theme = typeof inherited === 'string' && inherited ? inherited : DEFAULT_THEME;

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
  TRIP_LISTS,
};
