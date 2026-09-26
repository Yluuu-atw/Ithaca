'use strict';

/**
 * store.js —— 客户端数据层。
 *
 * 职责：与后端 /api 通信、乐观并发控制（版本号）、SSE 实时订阅。
 * 呈现层（render.js / app.js）只通过 Store 读写数据，不直接碰网络。
 *
 * 数据与呈现分离：这里管"数据从哪来、怎么保存、怎么同步"；
 * render.js 只负责把数据画出来。
 */

window.Store = (() => {
  const CONST = {
    itineraryCategories: ['交通', '景点', '餐饮', '住宿', '购物', '其他'],
    // 二级分类：选完一级才显示对应子类；子类再映射到票据的 type
    subCategories: {
      '交通': ['飞机', '高铁', '火车', '轮船', '长途汽车', '地铁', '公交', '出租车', '自驾', '步行'],
      '餐饮': ['早餐', '午餐', '晚餐', '下午茶', '夜宵'],
      '住宿': ['酒店', '民宿', '青旅', '露营', '亲友家'],
      '购物': ['特产', '手信', '免税店', '其他'],
      '景点': [],
      '其他': [],
    },
    itemToExpenseCategory: { '交通': '交通', '餐饮': '餐饮', '住宿': '住宿', '购物': '购物', '景点': '门票', '其他': '其他' },
    // 记账分类反向映射回行程分类（记账多出「门票」「娱乐」两类）
    expenseToItemCategory: { '交通': '交通', '餐饮': '餐饮', '住宿': '住宿', '购物': '购物', '门票': '景点', '娱乐': '其他', '其他': '其他' },
    expenseCategories: ['餐饮', '交通', '住宿', '门票', '购物', '娱乐', '其他'],
    checklistCategories: ['证件', '衣物', '洗漱', '电子', '药品', '其他'],
    splitOptions: ['均摊', '单方'],
    priorities: ['高', '中', '低'],
    wishStatus: ['想去', '排入行程', '已完成'],
    placeCategories: ['住宿', '餐饮', '景点', '交通', '购物', '娱乐', '其他'],
    placeStatus: ['想去', '待订', '已订'],
    bookingTypes: [
      { id: 'flight', label: '机票', icon: '✈️' },
      { id: 'train', label: '火车票', icon: '🚄' },
      { id: 'bus', label: '大巴票', icon: '🚌' },
      { id: 'hotel', label: '酒店', icon: '🏨' },
      { id: 'other', label: '其他', icon: '🎫' },
    ],
    bookingStatus: ['待订', '已订', '已完成', '已取消'],
    guideTags: ['美食', '景点', '住宿', '交通', '购物', '避坑', '行程', '其他'],
    currencySymbol: {
      CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£',
      KRW: '₩', TWD: 'NT$', HKD: 'HK$', THB: '฿', SGD: 'S$',
    },
    trackColors: ['#c4714b', '#8b9a7e', '#7d94a8', '#c08e8e', '#d4a44c', '#a89478'],
  };

  let state = null;          // 整份文档 { meta, trips }
  let version = 0;
  const listeners = new Set();
  let statusHandler = null;
  let es = null;
  let csrf = '';

  // 本设备当前看的是哪趟旅行。存在 localStorage 而不是文档里，
  // 两人可以同时看不同的旅行而互不干扰。
  let activeTrip = null;
  try { activeTrip = localStorage.getItem('journey.activeTrip'); } catch (_) {}

  const notify = () => { for (const fn of listeners) fn(getState()); };

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function setCsrf(token) { csrf = token || ''; }
  function getCsrf() { return csrf; }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // 当前旅行 id：优先用本设备记住的，已删除/不存在则退到第一趟未归档的
  function currentTripId() {
    const trips = (state && state.trips) || [];
    if (!trips.length) return null;
    if (activeTrip && trips.some(t => t.id === activeTrip)) return activeTrip;
    const live = trips.find(t => !(t.meta && t.meta.archived));
    return (live || trips[0]).id;
  }

  function tripById(id) {
    return ((state && state.trips) || []).find(t => t.id === id) || null;
  }

  function getRole(id) { return (state && state.permissions && state.permissions[id || currentTripId()]) || null; }
  function canEditTrip(id) { return ['owner', 'editor', 'temporary'].includes(getRole(id)); }
  function canManageTrip(id) { return getRole(id) === 'owner'; }
  function getRoster(id) { return (state && state.rosters && state.rosters[id || currentTripId()]) || []; }
  function getAppearanceChoices() { return (state && state.appearanceChoices) || { avatars: [], colors: [] }; }
  function getMySettlement(id) { return (state && state.mySettlements && state.mySettlements[id || currentTripId()]) || null; }
  function getGroupSettlement(id) { return (state && state.groupSettlements && state.groupSettlements[id || currentTripId()]) || null; }
  function getPersonId() {
    const roster = getRoster();
    const temporary = window.AuthUI && AuthUI.temporary;
    if (temporary) return temporary.id;
    const user = window.AuthUI && AuthUI.user;
    const person = user && roster.find(entry => entry.kind === 'formal' && entry.userId === user.id);
    return person ? person.id : null;
  }
  function canEditRecord(record) {
    const role = getRole();
    return role === 'owner' || role === 'editor' || role === 'temporary' && record && record.authorId === getPersonId();
  }

  async function load() {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('数据加载失败');
    state = await res.json();
    version = (state.meta && state.meta.version) || 0;
    notify();
    return state;
  }

  /**
   * 以纯函数方式修改当前旅行：fn 收到的是「当前旅行」的克隆，形状与旧版一致，
   * 所以调用方照旧写 d.expenses.push(...) 即可。内部再映射回整份文档保存。
   *
   * 乐观并发控制：若版本冲突（对方已改），自动拉取最新并重放本次修改。
   */
  async function mutate(fn) {
    if (!state) await load();
    if (!canEditTrip()) throw new Error('这趟旅行是只读的');
    for (let attempt = 0; attempt < 6; attempt++) {
      const base = version;
      const next = deepClone(state);
      const id = currentTripId();
      const trip = next.trips.find(t => t.id === id);
      if (!trip) throw new Error('当前旅行不存在，请刷新');
      fn(trip);
      next.meta.updatedAt = new Date().toISOString();

      const res = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ baseVersion: base, data: next }),
      });

      if (res.status === 409) {
        const latest = await (await fetch('/api/data')).json();
        state = latest;
        version = (latest.meta && latest.meta.version) || 0;
        continue; // 重放本次修改
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '保存失败');
      }
      const saved = await res.json();
      state = saved.data;
      version = saved.version;
      notify();
      return getState();
    }
    throw new Error('保存冲突次数过多，请稍后重试');
  }

  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        state = msg.data;
        version = msg.version;
        notify();
      } catch (_) { /* 忽略坏消息 */ }
    };
    es.onopen = () => { if (statusHandler) statusHandler('connected'); notify(); };
    es.onerror = () => { if (statusHandler) statusHandler('reconnecting'); /* EventSource 自动重连 */ };
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function setStatusHandler(fn) { statusHandler = fn; }

  // 返回当前旅行对象，形状与多旅行版之前完全一致（meta + 各集合），
  // 因此 render.js / app.js 里读 s.meta、d.expenses 的代码一行都不用改。
  // 加载完成前返回空趟，调用方无需到处判空。
  const EMPTY_TRIP = {
    id: '', meta: { tripName: '', destination: '', startDate: '', endDate: '', currency: 'CNY', members: [], archived: false },
    itinerary: [], expenses: [], checklist: [], wishlist: [],
    tracks: [], photos: [], places: [], bookings: [], guides: [],
  };
  function getState() { return tripById(currentTripId()) || EMPTY_TRIP; }
  // 打包模板是文档级的，跨旅行复用，只能从整份文档取
  function getTemplates() { return (state && state.packingTemplates) || []; }
  // 首页背景色存文档级，与任何一趟旅行无关
  function getWelcomeTheme() { return (state && state.meta && state.meta.welcomeTheme) || null; }
  // 备忘录是文档级的，跟当前是哪趟旅行无关
  function listMemos() { return ((state && state.memos) || []).slice(); }

  // ---------------- 旅行列表 ----------------
  function listTrips() { return ((state && state.trips) || []).slice(); }
  function getActiveTripId() { return currentTripId(); }

  function setActiveTrip(id) {
    if (!tripById(id)) return;
    activeTrip = id;
    try { localStorage.setItem('journey.activeTrip', id); } catch (_) {}
    notify();
  }

  // New trips start with the signed-in owner; the server assigns the canonical roster.
  async function createTrip() {
    const prev = getState();
    let newId = null;
    await mutateDoc((doc) => {
      const t = {
        id: uid('trip'),
        meta: {
          tripName: '新的旅行',
          destination: '',
          startDate: '',
          endDate: '',
          currency: (prev && prev.meta && prev.meta.currency) || 'CNY',
          members: [],
          archived: false,
        },
        itinerary: [], expenses: [], checklist: [], wishlist: [],
        tracks: [], photos: [], places: [], bookings: [], guides: [],
      };
      doc.trips.push(t);
      newId = t.id;
    });
    if (newId) setActiveTrip(newId);
    return getState();
  }

  // mutate 只能改当前旅行；新建/删除这类要动 trips 数组的操作走这条通道
  async function mutateDoc(fn) {
    if (!state) await load();
    for (let attempt = 0; attempt < 6; attempt++) {
      const base = version;
      const next = deepClone(state);
      fn(next);
      next.meta.updatedAt = new Date().toISOString();
      const res = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ baseVersion: base, data: next }),
      });
      if (res.status === 409) {
        const latest = await (await fetch('/api/data')).json();
        state = latest;
        version = (latest.meta && latest.meta.version) || 0;
        continue;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '保存失败');
      }
      const saved = await res.json();
      state = saved.data;
      version = saved.version;
      notify();
      return getState();
    }
    throw new Error('保存冲突次数过多，请稍后重试');
  }

  function deleteTrip(id) {
    return mutateDoc((doc) => {
      doc.trips = doc.trips.filter(t => t.id !== id);
    }).then((r) => {
      if (activeTrip === id) { activeTrip = null; try { localStorage.removeItem('journey.activeTrip'); } catch (_) {} }
      return r;
    });
  }

  function setTripArchived(id, archived) {
    return mutateDoc((doc) => {
      const t = doc.trips.find(x => x.id === id);
      if (t) { t.meta = t.meta || {}; t.meta.archived = !!archived; }
    });
  }

  function getIdentity() {
    const personId = getPersonId();
    const index = personId ? getRoster().findIndex(person => person.id === personId) : -1;
    return index < 0 ? null : index;
  }

  // 记在本设备而非文档里，两人可以各收各的
  let boardOpen = true;
  try { const v = localStorage.getItem('journey.boardOpen'); if (v != null) boardOpen = v === '1'; } catch (_) {}
  function getBoardOpen() { return boardOpen; }
  function setBoardOpen(v) {
    boardOpen = !!v;
    try { localStorage.setItem('journey.boardOpen', boardOpen ? '1' : '0'); } catch (_) {}
    notify();
  }

  // Upload any private image; existing photo callers keep the URL-only wrapper.
  async function uploadImage(blob, scope) {
    const target = scope === 'memo' ? '?scope=memo' : `?tripId=${encodeURIComponent(currentTripId() || '')}`;
    const res = await fetch('/api/images' + target, {
      method: 'POST',
      headers: { 'Content-Type': imageContentType(blob), 'X-CSRF-Token': csrf },
      body: blob,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '照片上传失败');
    }
    return res.json();
  }

  function imageContentType(blob) {
    if (blob.type) return blob.type;
    const ext = String(blob.name || '').split('.').pop().toLowerCase();
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' })[ext] || 'application/octet-stream';
  }

  async function uploadPhoto(blob, scope) {
    return (await uploadImage(blob, scope)).url;
  }

  async function imageRecognitionAvailable() {
    const res = await fetch('/api/ai/status');
    if (!res.ok) return false;
    return !!(await res.json()).available;
  }

  async function recognizeImage(blob, kind) {
    const res = await fetch(`/api/ai/extract?kind=${encodeURIComponent(kind)}&tripId=${encodeURIComponent(currentTripId() || '')}`, {
      method: 'POST',
      headers: { 'Content-Type': imageContentType(blob), 'X-CSRF-Token': csrf },
      body: blob,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '没看清图片内容');
    }
    return (await res.json()).fields || {};
  }

  function previewLink(url) {
    return fetch('/api/link-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ url, tripId: currentTripId() }),
    });
  }

  return {
    CONST, deepClone, uid, load, mutate, mutateDoc, connect, subscribe, setStatusHandler, setCsrf, getCsrf, getTemplates,
    getState, getWelcomeTheme, listMemos, getIdentity, getRoster, getAppearanceChoices, getMySettlement, getGroupSettlement, getPersonId, canEditRecord, uploadPhoto, uploadImage, imageRecognitionAvailable, recognizeImage, previewLink,
    listTrips, getActiveTripId, setActiveTrip, createTrip, deleteTrip, setTripArchived,
    getRole, canEditTrip, canManageTrip,
    getBoardOpen, setBoardOpen,
  };
})();
