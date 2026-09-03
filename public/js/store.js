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
    currencySymbol: {
      CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£',
      KRW: '₩', TWD: 'NT$', HKD: 'HK$', THB: '฿', SGD: 'S$',
    },
    trackColors: ['#e6a877', '#6f9e8f', '#7c9fd9', '#c98bb8', '#8fb6a0', '#d9a577'],
  };

  let state = null;
  let version = 0;
  const listeners = new Set();
  let statusHandler = null;
  let es = null;

  const notify = () => { for (const fn of listeners) fn(state); };

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
   * 以纯函数方式修改数据：fn 直接修改传入的克隆对象。
   * 内部做乐观并发控制——若版本冲突（他人已改），自动拉取最新并重放本次修改。
   */
  async function mutate(fn) {
    if (!state) await load();
    for (let attempt = 0; attempt < 6; attempt++) {
      const base = version;
      const next = deepClone(state);
      fn(next);
      next.meta.updatedAt = new Date().toISOString();

      const res = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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
      return state;
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
  function getState() { return state; }

  // 上传照片，返回服务端生成的 URL
  async function uploadPhoto(blob) {
    const res = await fetch('/api/photos', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '照片上传失败');
    }
    const data = await res.json();
    return data.url;
  }

  return { CONST, deepClone, uid, load, mutate, connect, subscribe, setStatusHandler, getState, uploadPhoto };
})();
