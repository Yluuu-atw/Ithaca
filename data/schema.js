'use strict';

/**
 * 数据模型定义 —— 唯一的"数据层"真相源（服务端使用）。
 *
 * 后续要新增/修改字段时，只需改这里 + 前端 store.js 里对应的常量，
 * 呈现层（render.js / app.js）会自动跟随数据结构渲染。
 *
 * 文档结构：
 *   meta        行程元信息（名称/目的地/日期/币种/成员/版本号）
 *   itinerary   行程：按天分组，每天若干"安排"
 *   expenses    记账：一条支出
 *   checklist   打包清单：一件要带的物品
 *   wishlist    心愿单：一个想去的地方/想做的事
 *   tracks      足迹：GPX 导入的轨迹（若干坐标点连成的路线）
 *   photos      照片：旅行照片（手帐墙）
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

function defaultDoc() {
  return {
    meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      tripName: '我们的旅行',
      destination: '',
      startDate: '',
      endDate: '',
      currency: 'CNY',
      members: ['我', '她'],
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

// 未知字段的一次性告警：同一个 key 只提示一次，避免每次请求刷屏
const warnedUnknown = new Set();

// 归一化：保证已知字段符合结构，缺的补默认值。
// 以原始 doc 为底再覆盖已知字段，未知字段原样保留——白名单式归一化会静默丢数据
// （服务进程比前端旧、导入未来版本的备份都会中招），表现为「保存成功但没存上」。
function normalize(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return defaultDoc();

  const d = defaultDoc();

  d.meta = Object.assign(d.meta, doc.meta || {});
  d.meta.version = Number(doc.meta && doc.meta.version) || 1;
  d.meta.updatedAt = (doc.meta && doc.meta.updatedAt) || d.meta.updatedAt;
  if (!Array.isArray(d.meta.members) || d.meta.members.length === 0) {
    d.meta.members = ['我', '她'];
  }

  d.itinerary = Array.isArray(doc.itinerary) ? doc.itinerary : [];
  d.expenses = Array.isArray(doc.expenses) ? doc.expenses : [];
  d.checklist = Array.isArray(doc.checklist) ? doc.checklist : [];
  d.wishlist = Array.isArray(doc.wishlist) ? doc.wishlist : [];
  d.tracks = Array.isArray(doc.tracks) ? doc.tracks : [];
  d.photos = Array.isArray(doc.photos) ? doc.photos : [];
  d.places = Array.isArray(doc.places) ? doc.places : [];
  d.bookings = Array.isArray(doc.bookings) ? doc.bookings : [];
  d.guides = Array.isArray(doc.guides) ? doc.guides : [];

  for (const k of Object.keys(doc)) {
    if (!(k in d) && !warnedUnknown.has(k)) {
      warnedUnknown.add(k);
      console.warn(`[schema] 未知字段「${k}」已原样保留；若这是新加的字段，服务端需要重启`);
    }
  }

  return Object.assign({}, doc, d);
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
  normalize,
};
