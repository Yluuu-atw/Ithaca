'use strict';

/**
 * render.js —— 呈现层（纯视图）。
 * 只负责把 Store 里的数据渲染成 HTML 字符串，不直接改数据、不碰网络。
 * 交互逻辑在 app.js，通过 data-action / data-* 属性委托处理。
 */

window.Render = (() => {
  // w 是槽位宽度权重：左 3 项各 1.0 共 3.0、概览 1.25、右 4 项各 0.75 共 3.0，
  // 概览中心 = 3.0 + 1.25/2 = 3.625，总权重 7.25，正好落在 0.5 中线上
  const TABS = [
    { id: 'itinerary', label: '行程', icon: '🗺️', w: 1 },
    { id: 'places', label: '攻略', icon: '📌', w: 1 },
    { id: 'map', label: '地图', icon: '📍', w: 1 },
    { id: 'overview', label: '概览', icon: '🏠', w: 1.25 },
    { id: 'wishlist', label: '心愿单', icon: '⭐', w: 0.75 },
    { id: 'bookings', label: '记账', icon: '🎫', w: 0.75 },
    { id: 'checklist', label: '清单', icon: '🎒', w: 0.75 },
    { id: 'photos', label: '照片', icon: '📷', w: 0.75 },
  ];

  // ---------------- 小工具 ----------------
  // FluentUI 3D emoji（MIT, github.com/microsoft/fluentui-emoji）。
  // 数据里仍存 emoji 字符，渲染时才换成图，免得动数据模型。
  const EMOJI_PNG = {
    '✈': '2708.png', '✨': '2728.png', '⭐': '2b50.png', '🌸': '1f338.png',
    '🍀': '1f340.png', '🍉': '1f349.png', '🎈': '1f388.png', '🎒': '1f392.png',
    '🎫': '1f3ab.png', '🏠': '1f3e0.png', '🏨': '1f3e8.png', '🐰': '1f430.png',
    '🐱': '1f431.png', '🐶': '1f436.png', '🐸': '1f438.png', '🐻': '1f43b.png',
    '🐼': '1f43c.png', '👤': '1f464.png', '💰': '1f4b0.png', '💸': '1f4b8.png',
    '💺': '1f4ba.png', '📅': '1f4c5.png', '📌': '1f4cc.png', '📍': '1f4cd.png',
    '📕': '1f4d5.png', '📦': '1f4e6.png', '📷': '1f4f7.png', '🔗': '1f517.png',
    '🕐': '1f550.png', '🗓': '1f5d3.png', '🗺': '1f5fa.png', '😎': '1f60e.png',
    '🙂': '1f642.png', '🚄': '1f684.png', '🚌': '1f68c.png', '🚩': '1f6a9.png',
    '🥰': '1f970.png', '🦁': '1f981.png', '🦄': '1f984.png', '🦊': '1f98a.png',
    '🧭': '1f9ed.png', '🧳': '1f9f3.png', '🧾': '1f9fe.png',
  };

  // 没收录的字符原样返回，避免变成空白
  function emo(ch) {
    const f = EMOJI_PNG[ch] || EMOJI_PNG[String(ch).replace(/\ufe0f/g, '')];
    if (!f) return esc(ch);
    return `<img class="emo" src="vendor/fluent-emoji/${f}" alt="${esc(ch)}" loading="lazy">`;
  }

  // Canvas 绘制用：拿到收录过的 emoji 图片地址，没收录的返回空串
  function emojiSrc(ch) {
    const f = EMOJI_PNG[ch] || EMOJI_PNG[String(ch).replace(/\ufe0f/g, '')];
    return f ? `vendor/fluent-emoji/${f}` : '';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 链接消毒：esc() 只转义字符，拦不住 javascript: / data: 这类伪协议
   * （它们不含特殊字符，能原样穿过 esc 进入 href，点击即执行脚本）。
   * 只放行 http(s) 与 mailto；无协议的裸域名补 https://；其余返回空串，
   * 由调用方降级为纯文本，避免数据被静默丢弃。
   */
  function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (/^(https?:\/\/|mailto:)/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) return '';          // 其它带协议的一律拒绝
    if (/^[^\s/?#]+\.[^\s/?#]{2,}(?:[/?#]|$)/.test(s)) return 'https://' + s; // 裸域名
    return '';
  }

  function money(n, currency) {
    const v = Number(n) || 0;
    const sym = Store.CONST.currencySymbol[currency] || '';
    return sym + v.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // 越界兜底：成员数与头像数理论上已由 normalize 对齐，防御外部数据
  function avatarOf(meta, i) {
    const av = (meta && meta.avatars) || [];
    return av[i] || '🙂';
  }

  // <option> 与隐藏输入域里放不了图，那两处继续用 avatarOf 取字符
  function avatarImg(meta, i) {
    return emo(avatarOf(meta, i));
  }

  function colorOf(meta, i) {
    const cl = (meta && meta.colors) || [];
    return cl[i] || '';
  }

  // 返回空串表示该付款人不着色
  function payerColor(meta, name) {
    const i = ((meta && meta.members) || []).indexOf(name);
    return i < 0 ? '' : colorOf(meta, i);
  }

  // 成员显示名：本设备自己显示「我」，对方显示实际昵称
  function dispName(members, name) {
    const idx = Store.getIdentity();
    if (idx != null && name === members[idx]) return '我';
    return name || '';
  }

  function memberChip(meta, name) {
    const members = (meta && meta.members) || [];
    const i = members.indexOf(name);
    if (i < 0) return esc(name || '');
    const mc = colorOf(meta, i);
    return `<span class="member-chip"${mc ? ` style="--mc:${esc(mc)}"` : ''}><span class="member-ava">${avatarImg(meta, i)}</span>${esc(dispName(members, name))}</span>`;
  }

  // <select> 的 option 里放不进渲染后的表情图，成员选择改成自定义控件：
  // 隐藏域承载值，FormData 原样读得到，与 avatar-pick 同一套做法
  function memberPicker(members, selected, meta, name) {
    const idx = Store.getIdentity();
    const list = members || [];
    const hasSel = selected != null && selected !== '';
    const cur = hasSel ? selected : (idx != null ? list[idx] : list[0]);
    const curIdx = list.indexOf(cur);
    const chip = (i) => {
      const mc = colorOf(meta, i);
      return `<span class="member-chip"${mc ? ` style="--mc:${esc(mc)}"` : ''}><span class="member-ava">${avatarImg(meta, i)}</span>${esc(dispName(list, list[i]))}</span>`;
    };
    const opts = list.map((m, i) => `
      <button type="button" class="member-pick-opt ${m === cur ? 'is-cur' : ''}" data-action="member-pick-opt" data-name="${esc(m)}">
        ${chip(i)}
      </button>`).join('');
    return `<input type="hidden" name="${esc(name)}" value="${esc(cur || '')}">
      <div class="member-pick">
        <button type="button" class="member-pick-cur" data-action="member-pick-toggle" aria-haspopup="listbox">
          ${curIdx >= 0 ? chip(curIdx) : '<span class="member-chip">未指定</span>'}
          <span class="member-pick-caret">▾</span>
        </button>
        <div class="member-pick-menu" hidden>${opts}</div>
      </div>`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtDate(d) {
    if (!d) return '';
    const parts = d.split('-').map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return d;
    return `${parts[1]}月${parts[2]}日`;
  }

  function weekday(d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return '周' + '日一二三四五六'[dt.getDay()];
  }

  function diffDays(a, b) {
    const da = new Date(a + 'T00:00:00');
    const db = new Date(b + 'T00:00:00');
    return Math.round((db - da) / 86400000);
  }

  // ---------------- 汇总计算 ----------------
  // 已订/已完成是真花出去的钱，待订只是计划、已取消不作数
  const BOOKING_COUNTED = ['已订', '已完成'];

  function summarizeExpenses(s) {
    const members = s.meta.members || [];
    const n = Math.max(1, members.length);
    const advanced = {}; members.forEach(m => advanced[m] = 0);
    const shouldPay = {}; members.forEach(m => shouldPay[m] = 0);
    const byCategory = {};
    let total = 0;         // 仅记账模块的支出
    let bookingTotal = 0;  // 已落实的票据金额

    const isMember = (x) => x && advanced[x] !== undefined;
    // 无付款人的款项视作公共支出：人人先垫自己那份，净转移为零但总额照算
    const credit = (amt, payer) => {
      if (isMember(payer)) advanced[payer] += amt;
      else members.forEach(m => advanced[m] += amt / n);
    };

    for (const e of s.expenses) {
      const amt = Number(e.amount) || 0;
      total += amt;
      const payer = e.payer || members[0] || '';
      byCategory[e.category || '其他'] = (byCategory[e.category || '其他'] || 0) + amt;
      credit(amt, payer);
      if (e.split === '单方') {
        if (isMember(payer)) shouldPay[payer] += amt;
        else members.forEach(m => shouldPay[m] += amt / n);
      } else {
        members.forEach(m => shouldPay[m] += amt / n);
      }
    }

    for (const b of (s.bookings || [])) {
      if (!BOOKING_COUNTED.includes(b.status)) continue;
      const amt = Number(b.price) || 0;
      if (!amt) continue;
      bookingTotal += amt;
      byCategory['票据'] = (byCategory['票据'] || 0) + amt;
      credit(amt, b.payer);
      members.forEach(m => shouldPay[m] += amt / n);
    }

    const balance = {};
    members.forEach(m => balance[m] = (advanced[m] || 0) - (shouldPay[m] || 0));
    return { total, bookingTotal, grand: total + bookingTotal, advanced, shouldPay, balance, byCategory };
  }

  function groupByDate(list) {
    const map = {};
    for (const e of list) (map[e.date] = map[e.date] || []).push(e);
    return Object.entries(map)
      .sort((a, b) => (a[0] || '').localeCompare(b[0] || ''))
      .map(([date, items]) => ({ date, items }));
  }

  function groupByCategory(list, order) {
    const map = {};
    for (const c of list) {
      const k = c.category || '其他';
      (map[k] = map[k] || []).push(c);
    }
    const keys = [...order, ...Object.keys(map).filter(k => !order.includes(k))];
    return keys.filter(k => map[k]).map(k => ({ category: k, items: map[k] }));
  }

  // ---------------- 导航 ----------------
  function renderNav(active) {
    return TABS.map(t => `
      <button class="nav-item ${t.id === active ? 'active' : ''}" data-action="nav" data-tab="${t.id}">
        <span class="nav-icon">${emo(t.icon)}</span><span class="nav-label">${t.label}</span>
      </button>`).join('');
  }

  // 视觉由 Canvas 绘制，这里只保留触摸热区与无障碍语义；
  // 宽度用百分比从权重算出，不靠 flex-grow：浏览器的 flex 分配对
  // 小数 grow 值不会严格按比例，会让热区和 canvas 槽位对不齐
  function renderTabbar(active) {
    const total = TABS.reduce((s, t) => s + t.w, 0);
    return TABS.map(t => `
      <button class="tab-item ${t.id === active ? 'active' : ''}" data-action="nav" data-tab="${t.id}" style="width:${(t.w / total * 100).toFixed(4)}%" aria-label="${esc(t.label)}"></button>`).join('');
  }

  function tabTitle(tab) {
    if (tab === 'trips') return '管理旅行';   // 不在 TABS 里，从侧栏看板进入
    const t = TABS.find(x => x.id === tab);
    return t ? t.label : '';
  }

  // ---------------- 页面分发 ----------------
  function renderPage(state, tab, opts) {
    opts = opts || {};
    switch (tab) {
      case 'itinerary': return renderItinerary(state, opts.itineraryMode);
      case 'trips': return renderTrips(opts.showArchived);
      case 'places': return renderPlaces(state, opts.placeFilter) + renderGuides(state, opts.guideFilter);
      case 'bookings': return renderBookings(state, opts.bookingFilter) + renderExpenses(state);
      case 'map': return renderMap(state, opts.tileSource);
      case 'checklist': return renderChecklist(state);
      case 'wishlist': return renderWishlist(state);
      case 'photos': return renderPhotos(state);
      default: return renderOverview(state, opts.editMeta);
    }
  }

  // ---------------- 侧栏旅行看板 ----------------
  // 归档的默认不显示，但全部归档时兜底显示，否则看板会空掉。
  // 收起时头部改显当前旅行名，否则收起后就不知道在用哪一趟。
  function renderTripBoard() {
    const all = Store.listTrips();
    const activeId = Store.getActiveTripId();
    const live = all.filter(t => !(t.meta && t.meta.archived));
    const list = live.length ? live : all;
    const open = Store.getBoardOpen();
    const active = all.find(t => t.id === activeId);

    const cards = list.map(t => {
      const m = t.meta || {};
      const isActive = t.id === activeId;
      const cover = (t.photos && t.photos[0] && t.photos[0].url) || '';
      const days = (t.itinerary || []).length;
      const expCost = (t.expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
      const bkCost = (t.bookings || []).filter(x => BOOKING_COUNTED.includes(x.status))
        .reduce((a, x) => a + (Number(x.price) || 0), 0);
      const cost = expCost + bkCost;
      const stats = [days ? `${days} 天` : '', cost ? money(cost, m.currency || 'CNY') : '']
        .filter(Boolean).join(' · ');
      const counts = [
        (t.photos || []).length ? `${emo('📷')}${t.photos.length}` : '',
        (t.places || []).length ? `${emo('📌')}${t.places.length}` : '',
        (t.bookings || []).length ? `${emo('🎫')}${t.bookings.length}` : '',
        (t.guides || []).length ? `${emo('📕')}${t.guides.length}` : '',
      ].filter(Boolean).join(' ');
      return `<button class="board-card ${isActive ? 'is-active' : ''}" data-action="trip-open" data-id="${esc(t.id)}" title="${esc(m.tripName || '')}">
        ${cover
          ? `<span class="board-cover"><img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
          : `<span class="board-cover board-cover-empty">${avatarImg(m, 0)}</span>`}
        <span class="board-main">
          <span class="board-name">${esc(m.tripName || '未命名')}</span>
          <span class="board-stats">${esc(stats || '还没有内容')}</span>
          ${counts ? `<span class="board-counts">${counts}</span>` : ''}
        </span>
      </button>`;
    }).join('');

    const headText = open
      ? `我的旅行${all.length ? ` · ${all.length}` : ''}`
      : ((active && active.meta && active.meta.tripName) || '我的旅行');

    return `<div class="board ${open ? '' : 'is-collapsed'}">
      <div class="board-head">
        <button class="board-toggle" data-action="board-toggle" aria-expanded="${open}">
          <span class="board-title">${esc(headText)}</span>
          <span class="board-chevron">${open ? '▾' : '▸'}</span>
        </button>
        <button class="icon-btn" data-action="trip-create" title="新建旅行">＋</button>
      </div>
      <div class="board-body">
        <div class="board-list">${cards || '<p class="board-empty">还没有旅行</p>'}</div>
        <button class="board-more" data-action="trip-goto-list">管理旅行 ›</button>
      </div>
    </div>`;
  }

  // ---------------- 旅行列表 ----------------
  function renderTrips(showArchived) {
    const all = Store.listTrips();
    const activeId = Store.getActiveTripId();
    const archivedCount = all.filter(t => t.meta && t.meta.archived).length;
    const list = showArchived ? all : all.filter(t => !(t.meta && t.meta.archived));

    const head = `<div class="list-head">
      <span>共 ${all.length} 趟旅行${archivedCount ? `（${archivedCount} 趟已归档）` : ''}</span>
      <button class="btn btn-primary" data-action="trip-create">＋ 新建旅行</button>
    </div>`;

    const bar = archivedCount
      ? `<div class="card trip-bar">
           <button class="chip ${showArchived ? 'active' : ''}" data-action="trip-toggle-archived">
             ${showArchived ? '隐藏已归档' : `显示已归档（${archivedCount}）`}
           </button>
         </div>` : '';

    const cards = list.map(t => {
      const m = t.meta || {};
      const days = (t.itinerary || []).length;
      const expTotal = (t.expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
      const photoN = (t.photos || []).length;
      const guideN = (t.guides || []).length;
      const isArchived = !!m.archived;
      const isActive = t.id === activeId;
      const stats = [
        days ? `${days} 天行程` : '',
        expTotal ? `花费 ${money(expTotal, m.currency || 'CNY')}` : '',
        photoN ? `${photoN} 张照片` : '',
        guideN ? `${guideN} 篇收藏` : '',
      ].filter(Boolean).join(' · ') || '还没有内容';

      return `<div class="card trip-card ${isActive ? 'is-active' : ''} ${isArchived ? 'is-archived' : ''}" data-action="trip-open" data-id="${esc(t.id)}">
        <div class="trip-top">
          <h3>${esc(m.tripName || '未命名旅行')}${isActive ? '<span class="trip-now">当前</span>' : ''}${isArchived ? '<span class="trip-arch">已归档</span>' : ''}</h3>
        </div>
        ${m.destination ? `<div class="trip-dest">${emo('📍')} ${esc(m.destination)}</div>` : ''}
        ${(m.startDate || m.endDate) ? `<div class="trip-date">${emo('🗓')} ${esc(fmtDate(m.startDate) || '?')} – ${esc(fmtDate(m.endDate) || '?')}</div>` : ''}
        <div class="trip-stats">${esc(stats)}</div>
        <div class="trip-foot">
          <button class="icon-btn" data-action="trip-archive" data-id="${esc(t.id)}" data-arch="${isArchived ? '0' : '1'}" title="${isArchived ? '取消归档' : '归档'}">${isArchived ? '↩' : emo('📦')}</button>
          <button class="icon-btn danger" data-action="trip-delete" data-id="${esc(t.id)}" title="删除">✕</button>
        </div>
      </div>`;
    }).join('');

    const grid = list.length
      ? `<div class="trip-grid">${cards}</div>`
      : `<div class="card"><div class="empty"><p>${showArchived ? '没有已归档的旅行' : '还没有旅行'}</p><p class="empty-hint">新建一趟，把想去的地方、要订的票、花的钱都放进去 ${emo('🧳')}</p></div></div>`;

    return head + bar + grid;
  }

  // ---------------- 概览 ----------------
  // 起止日期与目的地都从行程推算，省得手填两遍还容易跟行程对不上
  function tripDates(s) {
    const dates = (s.itinerary || []).map(d => d.date).filter(Boolean).sort();
    return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : { start: '', end: '' };
  }

  // 只取每天的起点，末站再补终点。中间经过的地点不展示，免得链路太长。
  function tripStops(s) {
    const days = [...(s.itinerary || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const stops = [];
    const push = (loc) => {
      const x = (loc || '').trim();
      if (x && x !== stops[stops.length - 1]) stops.push(x);
    };
    days.forEach(d => {
      const first = (d.items || []).map(i => i.location).find(Boolean);
      push(first);
    });
    // 末站补终点
    const lastDay = days[days.length - 1];
    if (lastDay) {
      const items = lastDay.items || [];
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].location) { push(items[i].location); break; }
      }
    }
    return stops;
  }

  // 每日花费：记账按日期 + 已订票据按日期，摊到行程的每一天上
  function dailySpend(s) {
    const days = [...(s.itinerary || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const byDate = {};
    (s.expenses || []).forEach(e => {
      if (!e.date) return;
      byDate[e.date] = (byDate[e.date] || 0) + (Number(e.amount) || 0);
    });
    (s.bookings || []).forEach(b => {
      if (!['已订', '已完成'].includes(b.status) || !b.date) return;
      byDate[b.date] = (byDate[b.date] || 0) + (Number(b.price) || 0);
    });
    const list = days.map(d => ({ date: d.date, amount: byDate[d.date] || 0 }));
    // 行程外的日期也别丢
    Object.keys(byDate).sort().forEach(dt => {
      if (!list.some(x => x.date === dt)) list.push({ date: dt, amount: byDate[dt] });
    });
    list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return list;
  }

  function barChart(s, data) {
    const max = Math.max(1, ...data.map(d => d.amount));
    if (!data.length) return '<p class="chart-empty">排好行程后，这里会按天显示花费</p>';
    const bars = data.map(d => {
      const h = d.amount ? Math.max(4, d.amount / max * 100) : 0;
      return `<div class="bar-col ${d.amount ? 'has-value' : ''}" title="${esc(d.date)} ${money(d.amount, s.meta.currency)}">
        <span class="bar-val">${d.amount ? money(d.amount, s.meta.currency) : ''}</span>
        <div class="bar-track"><div class="bar-fill" style="--h:${h.toFixed(1)}%"></div></div>
        <span class="bar-label">${esc(d.date ? fmtDate(d.date) : '')}</span>
      </div>`;
    }).join('');
    const anyValue = data.some(d => d.amount > 0);
    return anyValue ? `<div class="chart-bars">${bars}</div>`
      : `<div class="chart-bars">${bars}</div><p class="chart-empty" style="height:auto;padding:6px 0 0">还没有花费记录</p>`;
  }

  function donutChart(s, byCategory) {
    const entries = Object.entries(byCategory || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, v]) => a + v, 0);
    if (!entries.length) {
      return `<div class="donut-wrap"><div class="donut"><svg viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--surface-2)" stroke-width="5.2"/></svg>
        <div class="donut-center"><span class="donut-total">—</span><span class="donut-cap">暂无</span></div></div>
        <div class="donut-legend"><p class="empty small" style="margin:0">记一笔或订张票，这里就有占比了</p></div></div>`;
    }
    const C = 2 * Math.PI * 15.9;
    let acc = 0;
    const segs = entries.map(([, v], i) => {
      const len = v / total * C;
      const seg = `<circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--chart-${(i % 6) + 1})" stroke-width="5.2"
        stroke-dasharray="${len.toFixed(3)} ${(C - len).toFixed(3)}" stroke-dashoffset="${(-acc).toFixed(3)}"/>`;
      acc += len;
      return seg;
    }).join('');
    const legend = entries.map(([k, v], i) => `
      <div class="legend-row">
        <span class="legend-dot" style="--c:var(--chart-${(i % 6) + 1})"></span>
        <span class="legend-name">${esc(k)}</span>
        <span class="legend-val">${money(v, s.meta.currency)}</span>
      </div>`).join('');
    return `<div class="donut-wrap">
      <div class="donut"><svg viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--surface-2)" stroke-width="5.2"/>${segs}
      </svg><div class="donut-center"><span class="donut-total">${money(total, s.meta.currency)}</span><span class="donut-cap">总花费</span></div></div>
      <div class="donut-legend">${legend}</div>
    </div>`;
  }

  function ringChart(done, total, note) {
    const pct = total ? Math.round(done / total * 100) : 0;
    const C = 2 * Math.PI * 42;
    const off = C * (1 - pct / 100);
    return `<div class="ring-wrap">
      <div class="ring"><svg viewBox="0 0 100 100">
        <circle class="ring-bg" cx="50" cy="50" r="42"/>
        <circle class="ring-fg" cx="50" cy="50" r="42" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>
      </svg><div class="ring-center"><span class="ring-pct">${pct}%</span><span class="ring-cap">${done}/${total}</span></div></div>
      <p class="ring-note">${note}</p>
    </div>`;
  }

  // 填完就该像「已完成」，不该一直挂着表单框
  function metaSummary(s) {
    const m = s.meta;
    const d = tripDates(s);
    const stops = tripStops(s);
    const days = (d.start && d.end) ? diffDays(d.start, d.end) + 1 : 0;
    const dateTxt = d.start
      ? `${fmtDate(d.start)} – ${fmtDate(d.end)}${days > 0 ? ` · ${days} 天` : ''}`
      : '';
    const chain = stops.map(x => `<span class="stop">${esc(x)}</span>`)
      .join('<span class="stop-arrow">→</span>');
    return `<div class="trip-summary">
      <div class="trip-summary-name">${esc(m.tripName || '未命名旅行')}</div>
      ${stops.length ? `<div class="trip-stops">${chain}</div>` : ''}
      ${dateTxt ? `<div class="trip-summary-row">${emo('🗓')} <span>${esc(dateTxt)}</span></div>` : ''}
      ${(!stops.length && !dateTxt) ? '<p class="trip-summary-hint">去「行程」页排几天，日期和途经地会自动带出来</p>' : ''}
    </div>`;
  }

  // 成员面板：只读展示，增删改在右上角身份弹窗里
  function renderMembers(s) {
    const m = s.meta;
    const members = m.members || [];
    const chips = members.map((name, i) => `
      <span class="member-tile" style="--mc:${esc(colorOf(m, i) || 'var(--border)')}">
        <span class="member-tile-ava">${avatarImg(m, i)}</span>
        <span class="member-tile-name">${esc(dispName(members, name))}</span>
      </span>`).join('');
    return `<section class="card span-4">
      <div class="card-head">
        <h2>${emo('👥')} 成员</h2>
        <button class="btn btn-ghost btn-sm" data-action="switch-identity">管理</button>
      </div>
      <div class="member-tiles">${chips || '<p class="empty small">还没有成员</p>'}</div>
    </section>`;
  }

  function renderOverview(s, editMeta) {
    const m = s.meta;
    const exp = summarizeExpenses(s);
    const checklistDone = s.checklist.filter(c => c.checked).length;
    const checklistTotal = s.checklist.length;

    const currencyOpts = Object.keys(Store.CONST.currencySymbol)
      .map(c => `<option value="${c}" ${c === m.currency ? 'selected' : ''}>${c}</option>`).join('');

    const settle = (m.members || []).map(name => {
      const b = exp.balance[name] || 0;
      let txt, cls;
      if (b > 0.005) { txt = '应收 ' + money(b, m.currency); cls = 'pos'; }
      else if (b < -0.005) { txt = '应补 ' + money(-b, m.currency); cls = 'neg'; }
      else { txt = '持平'; cls = 'zero'; }
      return `<div class="settle-item">
        <div class="settle-name">${memberChip(m, name)}</div>
        <div class="settle-line">垫付 ${money(exp.advanced[name] || 0, m.currency)} · 应付 ${money(exp.shouldPay[name] || 0, m.currency)}</div>
        <div class="settle-bal ${cls}">${txt}</div>
      </div>`;
    }).join('');

    const catEntries = Object.entries(exp.byCategory).sort((a, b) => b[1] - a[1]);
    const maxCat = Math.max(1, ...catEntries.map(e => e[1]));
    const catBars = catEntries.map(([c, v]) => `
      <div class="cat-row">
        <span class="cat-name">${esc(c)}</span>
        <div class="cat-bar"><div class="cat-fill" style="--pct:${(v / maxCat * 100).toFixed(0)}%"></div></div>
        <span class="cat-val">${money(v, m.currency)}</span>
      </div>`).join('') || '<p class="empty">还没有记账记录</p>';

    const daily = dailySpend(s);
    const photoN = (s.photos || []).length;
    const guideN = (s.guides || []).length;
    const placeN = (s.places || []).length;
    const bookingN = (s.bookings || []).length;

    return `
      <div class="dash-grid">
        <section class="card span-8">
          <div class="card-head">
            <h2>${emo('🧳')} 行程信息</h2>
            ${editMeta
              ? '<button class="btn btn-ghost btn-sm" data-action="meta-cancel">取消</button>'
              : '<button class="btn btn-ghost btn-sm" data-action="meta-edit">✎ 编辑</button>'}
          </div>
          ${editMeta ? `
          <form class="grid-form" data-form="meta">
            <label>旅行名称<input name="tripName" value="${esc(m.tripName)}"></label>
            <div class="form-actions"><button class="btn btn-primary" type="submit">保存</button></div>
          </form>` : metaSummary(s)}
        </section>

        ${renderMembers(s)}

        <section class="card span-7">
          <div class="card-head"><h2>${emo('📅')} 每日花费</h2></div>
          ${barChart(s, daily)}
        </section>

        <section class="card span-5">
          <div class="card-head"><h2>${emo('🍩')} 分类占比</h2></div>
          ${donutChart(s, exp.byCategory)}
        </section>

        <section class="card span-4">
          <div class="card-head"><h2>${emo('📊')} 统计</h2></div>
          <div class="stat-grid stat-grid-2">
            <div class="stat-card"><div class="stat-value">${money(exp.grand, m.currency)}</div><div class="stat-label">总花费</div></div>
            <div class="stat-card"><div class="stat-value">${s.itinerary.length}</div><div class="stat-label">行程天数</div></div>
            <div class="stat-card"><div class="stat-value">${bookingN}</div><div class="stat-label">票据</div></div>
            <div class="stat-card"><div class="stat-value">${s.wishlist.length}</div><div class="stat-label">心愿单</div></div>
          </div>
        </section>

        <section class="card span-4">
          <div class="card-head"><h2>${emo('🎒')} 打包进度</h2></div>
          ${ringChart(checklistDone, checklistTotal, checklistTotal
            ? `还有 ${checklistTotal - checklistDone} 件没装进行李箱`
            : '去清单页加几样要带的东西')}
        </section>

        <section class="card span-4">
          <div class="card-head"><h2>${emo('📷')} 旅行收藏</h2></div>
          <div class="stat-grid stat-grid-2">
            <div class="stat-card"><div class="stat-value">${photoN}</div><div class="stat-label">照片</div></div>
            <div class="stat-card"><div class="stat-value">${placeN}</div><div class="stat-label">攻略</div></div>
            <div class="stat-card"><div class="stat-value">${guideN}</div><div class="stat-label">笔记</div></div>
            <div class="stat-card"><div class="stat-value">${(s.tracks || []).length}</div><div class="stat-label">足迹</div></div>
          </div>
        </section>

        <section class="card span-12">
          <div class="card-head">
            <h2>${emo('💸')} 花费与结算</h2>
            <label class="currency-pick">币种
              <select data-action="currency-change">${currencyOpts}</select>
            </label>
          </div>
          ${exp.bookingTotal ? `<p class="spend-note">记账 ${money(exp.total, m.currency)} ＋ 已订票据 ${money(exp.bookingTotal, m.currency)}</p>` : ''}
          <div class="settle-grid">${settle}</div>
          <div class="cat-list">${catBars}</div>
        </section>
      </div>`;
  }

  // ---------------- 行程 ----------------
  function renderItinerary(s, mode) {
    const isDetail = mode === 'detail';
    const days = [...s.itinerary].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const estTotal = s.itinerary.reduce((a, d) => a + (d.items || []).reduce((x, i) => x + (Number(i.estimatedCost) || 0), 0), 0);
    const head = `<div class="list-head">
      <span>共 ${days.length} 天 · 预估 ${money(estTotal, s.meta.currency)}</span>
      <div class="head-actions">
        <button class="btn btn-ghost btn-sm" data-action="itinerary-toggle-mode">${isDetail ? '简洁模式' : '详细模式'}</button>
        <button class="btn btn-primary" data-action="itinerary-add-day">＋ 新建一天</button>
      </div>
    </div>`;

    if (!days.length) {
      return `<div class="card">${head}<div class="empty">
        <p>还没有行程安排</p><p class="empty-hint">先新建一天，再把想去的地方排进去 ${emo('✨')}</p>
      </div></div>`;
    }
    if (isDetail) {
      return head + `<div class="timeline">${days.map((d, i) => renderDay(s, d, i)).join('')}</div>`;
    }
    return head + `<div class="timeline">${days.map((d, i) => renderDaySimple(s, d, i)).join('')}</div>`;
  }

  function renderDaySimple(s, d, idx) {
    const items = d.items || [];
    const dayTotal = items.reduce((x, i) => x + (Number(i.estimatedCost) || 0), 0);
    const date = d.date || '';
    const dayNo = (s.meta.startDate && date && diffDays(s.meta.startDate, date) >= 0)
      ? diffDays(s.meta.startDate, date) + 1 : idx + 1;
    const stops = items.map(i => i.location).filter(Boolean);
    const firstStop = stops[0], lastStop = stops[stops.length - 1];
    const stopTxt = firstStop
      ? (firstStop === lastStop ? firstStop : `${firstStop} → ${lastStop}`)
      : '';
    const firstTitles = items.slice(0, 3).map(i => esc(i.title)).join(' · ');
    return `<div class="tl-day">
      <div class="tl-marker"><span class="tl-dot">${dayNo}</span></div>
      <div class="tl-body">
        <button class="tl-summary" data-action="day-detail" data-day="${esc(d.id)}">
          <div class="tl-head">
            <span class="tl-dayno">DAY ${dayNo}</span>
            <span class="tl-date">${esc(shortDate(date))}</span>
            <span class="tl-weekday">${esc(weekday(date))}</span>
            <div class="tl-meta">
              ${items.length ? `${items.length} 项` : ''}
              ${dayTotal ? ` · ${money(dayTotal, s.meta.currency)}` : ''}
              <span class="chevron">›</span>
            </div>
          </div>
          ${stopTxt ? `<div class="tl-stops">${emo('📍')} ${esc(stopTxt)}</div>` : ''}
          <div class="tl-titles">${items.length ? firstTitles + (items.length > 3 ? ' …' : '') : '暂无安排'}</div>
        </button>
      </div>
    </div>`;
  }

  function dayDetail(s, dayId) {
    const day = s.itinerary.find(d => d.id === dayId);
    if (!day) return '<p class="empty small">找不到这一天</p>';
    const items = [...(day.items || [])].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    return `<div class="detail">
      <div class="detail-head">
        <h3>${fmtDate(day.date)} ${weekday(day.date)}</h3>
        <button class="btn btn-ghost btn-sm" data-action="itinerary-add-item" data-day="${esc(day.id)}">＋ 安排</button>
      </div>
      ${items.length
        ? `<ul class="tl-items tl-plain">${items.map(i => renderItiItem(s, day.id, i)).join('')}</ul>`
        : '<p class="empty small">这天还没有安排</p>'}
    </div>`;
  }

  // 简化日期：2026-09-29 → 9/29，时间轴大标题用
  function shortDate(d) {
    if (!d) return '';
    const p = d.split('-').map(Number);
    return p.length < 3 ? d : `${p[1]}/${p[2]}`;
  }

  function renderDay(s, d, idx) {
    const items = [...(d.items || [])].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    const dayTotal = items.reduce((x, i) => x + (Number(i.estimatedCost) || 0), 0);
    const date = d.date || '';
    const dayNo = (s.meta.startDate && date && diffDays(s.meta.startDate, date) >= 0)
      ? diffDays(s.meta.startDate, date) + 1 : idx + 1;
    const stops = items.map(i => i.location).filter(Boolean);
    const firstStop = stops[0], lastStop = stops[stops.length - 1];
    const stopTxt = firstStop
      ? (firstStop === lastStop ? firstStop : `${firstStop} → ${lastStop}`)
      : '';

    return `<div class="tl-day">
      <div class="tl-marker"><span class="tl-dot">${dayNo}</span></div>
      <div class="tl-body">
        <div class="tl-head">
          <span class="tl-dayno">DAY ${dayNo}</span>
          <span class="tl-date">${esc(shortDate(date))}</span>
          <span class="tl-weekday">${esc(weekday(date))}</span>
          <div class="tl-meta">
            ${items.length ? `${items.length} 项` : ''}
            ${dayTotal ? ` · ${money(dayTotal, s.meta.currency)}` : ''}
          </div>
          <div class="tl-actions">
            <button class="btn btn-ghost btn-sm" data-action="itinerary-add-item" data-day="${esc(d.id)}">＋ 安排</button>
            <button class="icon-btn danger" data-action="itinerary-del-day" data-day="${esc(d.id)}" title="删除这一天">✕</button>
          </div>
        </div>
        ${stopTxt ? `<div class="tl-stops">${emo('📍')} ${esc(stopTxt)}${stops.length > 2 ? ` 等 ${stops.length} 地` : ''}</div>` : ''}
        ${items.length
          ? `<ul class="tl-items">${items.map(i => renderItiItem(s, d.id, i)).join('')}</ul>`
          : '<p class="tl-empty">这天还没有安排</p>'}
      </div>
    </div>`;
  }

  function renderItiItem(s, dayId, i) {
    const t = i.time || '';
    return `<li class="tl-item ${i.estimatedCost ? 'has-value' : ''}">
      <div class="tl-time">${esc(t || '—')}${i.endTime ? `<small>${esc(i.endTime)}</small>` : ''}</div>
      <div class="tl-card">
        <div class="tl-main">
          <div class="tl-title">${esc(i.title || '（未命名）')}</div>
          ${i.location ? `<div class="tl-loc">${emo('📍')} ${esc(i.location)}</div>` : ''}
          ${i.note ? `<div class="tl-note">${esc(i.note)}</div>` : ''}
        </div>
        <div class="tl-side">
          <span class="badge" data-cat="${esc(i.category || '其他')}">${esc(i.category || '其他')}</span>
          ${i.estimatedCost ? `<span class="iti-cost">${money(i.estimatedCost, s.meta.currency)}</span>` : ''}
          <button class="icon-btn" data-action="itinerary-edit-item" data-day="${esc(dayId)}" data-item="${esc(i.id)}" title="编辑">✎</button>
          <button class="icon-btn danger" data-action="itinerary-del-item" data-day="${esc(dayId)}" data-item="${esc(i.id)}" title="删除">✕</button>
        </div>
      </div>
    </li>`;
  }

  // ---------------- 记账 ----------------
  function renderExpenses(s) {
    const exp = summarizeExpenses(s);
    const grouped = groupByDate(s.expenses);
    const head = `<div class="list-head">
      <span>共 ${s.expenses.length} 笔 · 支出 ${money(exp.total, s.meta.currency)}${exp.bookingTotal ? ` · 另有已订票据 ${money(exp.bookingTotal, s.meta.currency)}` : ''}</span>
      <button class="btn btn-primary" data-action="expense-add">＋ 记一笔</button>
    </div>`;

    const settle = (s.meta.members || []).map(name => {
      const b = exp.balance[name] || 0;
      let txt, cls;
      if (b > 0.005) { txt = '应收 ' + money(b, s.meta.currency); cls = 'pos'; }
      else if (b < -0.005) { txt = '应补 ' + money(-b, s.meta.currency); cls = 'neg'; }
      else { txt = '持平'; cls = 'zero'; }
      return `<div class="settle-item">
        <div class="settle-name">${memberChip(s.meta, name)}</div>
        <div class="settle-line">垫付 ${money(exp.advanced[name] || 0, s.meta.currency)} · 应付 ${money(exp.shouldPay[name] || 0, s.meta.currency)}</div>
        <div class="settle-bal ${cls}">${txt}</div>
      </div>`;
    }).join('');

    const summary = `<section class="card"><div class="card-head"><h2>${emo('🧾')} 结算</h2></div><div class="settle-grid">${settle}</div></section>`;

    const body = grouped.length
      ? grouped.map(g => renderExpenseGroup(s, g)).join('')
      : `<div class="card"><div class="empty"><p>还没有记账</p><p class="empty-hint">点击「记一笔」开始记录花费 ${emo('💸')}</p></div></div>`;

    return head + summary + body;
  }

  function renderExpenseGroup(s, g) {
    const total = g.items.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    return `<section class="card">
      <div class="day-head"><h3>${fmtDate(g.date)} ${weekday(g.date)}</h3><span class="iti-cost">${money(total, s.meta.currency)}</span></div>
      <ul class="exp-list">${g.items.map(e => renderExpenseItem(s, e)).join('')}</ul>
    </section>`;
  }

  function renderExpenseItem(s, e) {
    const splitTag = e.split === '单方' ? '单方' : '均摊';
    return `<li class="exp-item">
      <div class="exp-main">
        <div class="exp-title">${esc(e.note || e.category || '支出')}</div>
        <div class="exp-meta">
          <span class="badge" data-cat="${esc(e.category || '其他')}">${esc(e.category || '其他')}</span>
          ${e.time ? `<span class="exp-time">${esc(e.time)}</span>` : ''}
          <span class="tag">${memberChip(s.meta, e.payer || '')} 付</span>
          <span class="tag">${splitTag}</span>
        </div>
      </div>
      <div class="exp-side">
        <span class="exp-amount">${money(e.amount, s.meta.currency)}</span>
        <button class="icon-btn" data-action="expense-edit" data-id="${esc(e.id)}" title="编辑">✎</button>
        <button class="icon-btn danger" data-action="expense-del" data-id="${esc(e.id)}" title="删除">✕</button>
      </div>
    </li>`;
  }

  // ---------------- 打包清单 ----------------
  function renderChecklist(s) {
    const total = s.checklist.length;
    const done = s.checklist.filter(c => c.checked).length;
    const pct = total ? Math.round(done / total * 100) : 0;
    const head = `<div class="list-head">
      <span>已打包 ${done}/${total}</span>
      <button class="btn btn-primary" data-action="checklist-add">＋ 添加物品</button>
    </div>`;

    if (!total) {
      return `<div class="card">${head}<div class="empty"><p>打包清单是空的</p><p class="empty-hint">把要带的东西加进来吧 ${emo('🎒')}</p></div></div>`;
    }

    const progress = `<div class="card progress-wrap">
      <div class="progress"><div class="progress-fill" style="--pct:${pct}%"></div></div>
      <div class="progress-hint">${pct}% · ${done}/${total}</div>
    </div>`;

    const grouped = groupByCategory(s.checklist, Store.CONST.checklistCategories);
    const body = grouped.map(g => {
      const gdone = g.items.filter(c => c.checked).length;
      return `<section class="card">
        <div class="day-head"><h3>${esc(g.category)}</h3><span class="muted">${gdone}/${g.items.length}</span></div>
        <ul class="chk-list">${g.items.map(c => renderChecklistItem(s, c)).join('')}</ul>
      </section>`;
    }).join('');

    return head + progress + body;
  }

  function renderChecklistItem(s, c) {
    return `<li class="chk-item ${c.checked ? 'done' : ''}">
      <label class="chk">
        <input type="checkbox" data-action="checklist-toggle" data-id="${esc(c.id)}" ${c.checked ? 'checked' : ''}>
        <span class="chk-box"></span>
        <span class="chk-name">${esc(c.name)}</span>
      </label>
      <div class="chk-side">
        ${c.owner ? `<span class="tag">${memberChip(s.meta, c.owner)}</span>` : ''}
        <button class="icon-btn" data-action="checklist-edit" data-id="${esc(c.id)}" title="编辑">✎</button>
        <button class="icon-btn danger" data-action="checklist-del" data-id="${esc(c.id)}" title="删除">✕</button>
      </div>
    </li>`;
  }

  // ---------------- 心愿单 ----------------
  function renderWishlist(s) {
    const head = `<div class="list-head">
      <span>共 ${s.wishlist.length} 个心愿</span>
      <button class="btn btn-primary" data-action="wish-add">＋ 添加心愿</button>
    </div>`;
    if (!s.wishlist.length) {
      return `<div class="card">${head}<div class="empty"><p>还没有心愿</p><p class="empty-hint">把想去的地方、想做的事记下来 ${emo('⭐')}</p></div></div>`;
    }
    return head + `<div class="wish-grid">${s.wishlist.map(w => renderWishItem(s, w)).join('')}</div>`;
  }

  function renderWishItem(s, w) {
    const prio = w.priority || '中';
    const prioCls = { 高: 'high', 中: 'mid', 低: 'low' }[prio] || 'mid';
    return `<div class="card wish-card">
      <div class="wish-head">
        <h3>${esc(w.name)}</h3>
        <div>
          <button class="icon-btn" data-action="wish-edit" data-id="${esc(w.id)}" title="编辑">✎</button>
          <button class="icon-btn danger" data-action="wish-del" data-id="${esc(w.id)}" title="删除">✕</button>
        </div>
      </div>
      ${w.location ? `<div class="iti-loc">${emo('📍')} ${esc(w.location)}</div>` : ''}
      ${w.note ? `<div class="iti-note">${esc(w.note)}</div>` : ''}
      <div class="wish-foot">
        <span class="badge prio-${prioCls}">${esc(prio)}</span>
        <select class="select" data-action="wish-status" data-id="${esc(w.id)}">
          ${Store.CONST.wishStatus.map(st => `<option value="${st}" ${st === w.status ? 'selected' : ''}>${st}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }

  // ---------------- 表单（弹窗用） ----------------
  function formDay() {
    return `<form data-form="day">
      <label>日期<input type="date" name="date" required value="${today()}"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">创建这一天</button></div>
    </form>`;
  }

  function formItem(dayId, item) {
    const cats = Store.CONST.itineraryCategories;
    const v = item || {};
    return `<form data-form="item">
      <input type="hidden" name="dayId" value="${esc(dayId)}">
      ${item ? `<input type="hidden" name="itemId" value="${esc(item.id)}">` : ''}
      <div class="form-row">
        <label>开始时间<input type="time" name="time" value="${esc(item ? (v.time || '') : '09:00')}"></label>
        <label>结束时间<input type="time" name="endTime" value="${esc(v.endTime || '')}"></label>
      </div>
      <label>安排内容<input name="title" required placeholder="如：清水寺" value="${esc(v.title || '')}"></label>
      <label>地点<input name="location" placeholder="如：京都 · 东山区" value="${esc(v.location || '')}"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option ${c === (v.category || '其他') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>预估花费<input type="number" name="estimatedCost" min="0" step="0.01" placeholder="0" inputmode="decimal" value="${esc(v.estimatedCost || '')}"></label>
      </div>
      <label>备注<input name="note" placeholder="预约信息、路线等" value="${esc(v.note || '')}"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${item ? '保存' : '添加'}</button></div>
    </form>`;
  }

  function formExpense(members, item) {
    const cats = Store.CONST.expenseCategories;
    const splits = Store.CONST.splitOptions;
    const v = item || {};
    return `<form data-form="expense">
      ${item ? `<input type="hidden" name="expenseId" value="${esc(item.id)}">` : ''}
      <div class="form-row">
        <label>日期<input type="date" name="date" required value="${esc(item ? (v.date || '') : today())}"></label>
        <label>时间<input type="time" name="time" value="${esc(v.time || '')}"></label>
      </div>
      <label>金额<input type="number" name="amount" min="0" step="0.01" required placeholder="0.00" inputmode="decimal" value="${esc(v.amount == null ? '' : v.amount)}"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option ${item && c === (v.category || '其他') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>谁付的${memberPicker(members, item ? v.payer : undefined, Store.getState().meta, 'payer')}</label>
      </div>
      <label>分摊<select name="split">${splits.map(sp => `<option ${item && sp === (v.split || '均摊') ? 'selected' : ''}>${sp}</option>`).join('')}</select></label>
      <label>备注<input name="note" placeholder="如：晚饭 · 烤肉" value="${esc(v.note || '')}"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${item ? '保存' : '记下'}</button></div>
    </form>`;
  }

  function formChecklist(members, item) {
    const cats = Store.CONST.checklistCategories;
    const v = item || {};
    return `<form data-form="checklist">
      ${item ? `<input type="hidden" name="checklistId" value="${esc(item.id)}">` : ''}
      <label>物品<input name="name" required placeholder="如：护照" value="${esc(v.name || '')}"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option ${item && c === (v.category || '其他') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>谁带${memberPicker(members, item ? v.owner : undefined, Store.getState().meta, 'owner')}</label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${item ? '保存' : '添加'}</button></div>
    </form>`;
  }

  function formWish(item) {
    const prios = Store.CONST.priorities;
    const v = item || {};
    return `<form data-form="wish">
      ${item ? `<input type="hidden" name="wishId" value="${esc(item.id)}">` : ''}
      <label>心愿<input name="name" required placeholder="如：看一次日出" value="${esc(v.name || '')}"></label>
      <label>地点<input name="location" placeholder="如：海边" value="${esc(v.location || '')}"></label>
      <label>优先级<select name="priority">${prios.map(p => `<option ${item && p === (v.priority || '中') ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label>备注<input name="note" placeholder="为什么想去、有什么期待" value="${esc(v.note || '')}"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${item ? '保存' : '添加'}</button></div>
    </form>`;
  }

  // ---------------- 地图 ----------------
  function renderMap(s, tileSource) {
    const pointCount = s.itinerary.reduce((a, d) => a + (d.items || []).filter(i => i.lat != null && i.lng != null).length, 0);
    const trackCount = (s.tracks || []).length;
    const ts = tileSource || 'amap';
    const tileBtn = (val, label) => `<button class="btn btn-sm ${ts === val ? 'btn-primary' : 'btn-ghost'}" data-action="tile-source" data-tile="${val}">${label}</button>`;
    return `
      <div class="map-layout">
        <div class="map-toolbar">
          <div class="map-legend" id="mapLegend"></div>
          <div class="map-actions">
            ${tileBtn('amap', '高德')}
            ${tileBtn('osm', 'OSM')}
            <button class="btn btn-ghost btn-sm" data-action="gpx-import">⬆ 导入 GPX</button>
            <button class="btn btn-ghost btn-sm" data-action="map-fit">⤢ 全部</button>
          </div>
        </div>
        <div id="map" class="map-container"></div>
        <div class="map-hint">
          已标注 ${pointCount} 个行程点 · ${trackCount} 条足迹轨迹
          · 高德为国内底图(已纠偏)，OSM 为全球底图(港澳更精确)
        </div>
      </div>
      <input type="file" id="gpxFile" accept=".gpx,.xml" hidden>`;
  }

  // ---------------- 照片 ----------------
  function renderPhotos(s) {
    const photos = s.photos || [];
    const head = `<div class="list-head">
      <span>共 ${photos.length} 张照片</span>
      <button class="btn btn-primary" data-action="photo-add">＋ 添加照片</button>
    </div>`;

    if (!photos.length) {
      return `<div class="card">${head}<div class="empty">
        <p>还没有照片</p>
        <p class="empty-hint">把旅行照片传上来，做成手帐 ${emo('📷')}${emo('✨')}</p>
      </div></div>`;
    }

    const grouped = groupByDate(photos);
    const body = grouped.map(g => `
      <section class="card photo-day">
        <div class="day-head"><h3>${fmtDate(g.date)} ${weekday(g.date)}</h3><span class="muted">${g.items.length} 张</span></div>
        <div class="photo-grid">
          ${g.items.map(p => renderPhotoCard(s, p)).join('')}
        </div>
      </section>`).join('');

    return head + `<div class="day-list">${body}</div>`;
  }

  function renderPhotoCard(s, p) {
    return `<figure class="photo-card">
      <div class="photo-img-wrap">
        <img class="photo-img" src="${esc(p.url)}" alt="${esc(p.caption || '照片')}" loading="lazy">
        <button class="icon-btn danger photo-del" data-action="photo-del" data-id="${esc(p.id)}" title="删除">✕</button>
      </div>
      ${p.caption || p.location
        ? `<figcaption class="photo-cap">
            ${p.caption ? `<span class="photo-cap-text">${esc(p.caption)}</span>` : ''}
            ${p.location ? `<span class="photo-cap-loc">${emo('📍')} ${esc(p.location)}</span>` : ''}
          </figcaption>`
        : ''}
    </figure>`;
  }

  // ---------------- 照片上传表单 ----------------
  function formPhoto() {
    return `<form data-form="photo">
      <label>选择照片<input type="file" name="file" accept="image/*" required multiple></label>
      <label>拍摄日期<input type="date" name="date" value="${today()}"></label>
      <label>配文<input name="caption" placeholder="一句话记录此刻（可选）"></label>
      <label>地点<input name="location" placeholder="如：维多利亚港（可选）"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">上传</button></div>
    </form>`;
  }

  // ---------------- 攻略 / 预订 ----------------
  function renderPlaces(s, filter) {
    const places = s.places || [];
    const cats = Store.CONST.placeCategories;
    filter = filter || {};
    const activeCat = filter.category || '全部';
    const keyword = (filter.keyword || '').trim().toLowerCase();

    let list = places;
    if (activeCat !== '全部') list = list.filter(p => (p.category || '其他') === activeCat);
    if (keyword) {
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(keyword) ||
        (p.location || '').toLowerCase().includes(keyword) ||
        (p.note || '').toLowerCase().includes(keyword));
    }

    const head = `<div class="list-head">
      <span>共 ${places.length} 个地点</span>
      <button class="btn btn-primary" data-action="place-add">＋ 添加</button>
    </div>`;

    const chips = ['全部', ...cats].map(c =>
      `<button class="chip ${c === activeCat ? 'active' : ''}" data-action="place-filter" data-cat="${esc(c)}">${esc(c)}</button>`).join('');

    const tools = `<div class="card place-tools">
      <div class="search-bar"><input type="search" id="placeSearch" placeholder="搜索地点 / 关键词…" value="${esc(filter.keyword || '')}"></div>
      <div class="chips">${chips}</div>
    </div>`;

    if (!places.length) {
      return head + tools + `<div class="card"><div class="empty">
        <p>还没有收藏的地点</p><p class="empty-hint">把要订的酒店、想去的餐厅加进来 ${emo('📌')}</p>
      </div></div>`;
    }

    const grid = list.length
      ? `<div class="place-grid">${list.map(p => renderPlaceCard(s, p)).join('')}</div>`
      : `<div class="card"><div class="empty"><p>没有匹配的结果</p></div></div>`;

    return head + tools + grid;
  }

  function renderPlaceCard(s, p) {
    const stCls = { 想去: 'want', 待订: 'pending', 已订: 'booked' }[p.status] || 'want';
    return `<div class="place-card" data-action="place-detail" data-id="${esc(p.id)}" role="button" tabindex="0">
      <div class="place-top">
        <span class="badge" data-cat="${esc(p.category || '其他')}">${esc(p.category || '其他')}</span>
        <span class="place-status st-${stCls}">${esc(p.status || '想去')}</span>
      </div>
      <h3 class="place-name">${esc(p.name || '（未命名）')}</h3>
      ${p.location ? `<div class="place-loc">${emo('📍')} ${esc(p.location)}</div>` : ''}
      ${p.note ? `<div class="place-note">${esc(p.note)}</div>` : ''}
      <div class="place-foot">
        ${p.cost ? `<span class="iti-cost">${money(p.cost, s.meta.currency)}</span>` : '<span></span>'}
        ${p.date ? `<span class="tag">${esc(p.date)}</span>` : '<span></span>'}
      </div>
    </div>`;
  }

  function placeDetail(s, id) {
    const p = (s.places || []).find(x => x.id === id);
    if (!p) return '<p class="empty small">找不到这个地点</p>';
    return `<div class="detail">
      <div class="detail-head">
        <h3>${esc(p.name || '')}</h3>
        <div>
          <button class="icon-btn" data-action="place-edit" data-id="${esc(p.id)}" title="编辑">✎</button>
          <button class="icon-btn danger" data-action="place-del" data-id="${esc(p.id)}" title="删除">✕</button>
        </div>
      </div>
      <div class="detail-tags">
        <span class="badge" data-cat="${esc(p.category || '其他')}">${esc(p.category || '其他')}</span>
        <span class="place-status st-${({想去:'want',待订:'pending',已订:'booked'}[p.status] || 'want')}">${esc(p.status || '想去')}</span>
      </div>
      ${p.location ? `<div class="detail-row">${emo('📍')} ${esc(p.location)}</div>` : ''}
      ${p.date ? `<div class="detail-row">${emo('📅')} ${esc(p.date)}</div>` : ''}
      ${p.cost ? `<div class="detail-row">${emo('💰')} ${money(p.cost, s.meta.currency)}</div>` : ''}
      ${safeUrl(p.link) ? `<div class="detail-row">${emo('🔗')} <a href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener noreferrer">${esc(p.link)}</a></div>` : ''}
      ${p.note ? `<div class="detail-note">${esc(p.note)}</div>` : ''}
    </div>`;
  }

  function formPlace(item) {
    const cats = Store.CONST.placeCategories;
    const sts = Store.CONST.placeStatus;
    const v = item || {};
    return `<form data-form="place">
      ${item ? `<input type="hidden" name="placeId" value="${esc(item.id)}">` : ''}
      <label>名称<input name="name" required placeholder="如：尖沙咀某酒店" value="${esc(v.name || '')}"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option ${item && c === (v.category || '其他') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>状态<select name="status">${sts.map(st => `<option ${item && st === (v.status || '想去') ? 'selected' : ''}>${st}</option>`).join('')}</select></label>
      </div>
      <label>地点<input name="location" placeholder="如：香港尖沙咀" value="${esc(v.location || '')}"></label>
      <div class="form-row">
        <label>日期<input type="date" name="date" value="${esc(v.date || '')}"></label>
        <label>预算/价格<input type="number" name="cost" min="0" step="0.01" placeholder="0" inputmode="decimal" value="${esc(v.cost == null ? '' : v.cost)}"></label>
      </div>
      <label>链接<input name="link" placeholder="预订链接（可选）" value="${esc(v.link || '')}"></label>
      <label>备注<textarea name="note" rows="2" placeholder="房型、预订号、推荐菜等">${esc(v.note || '')}</textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${item ? '保存' : '添加'}</button></div>
    </form>`;
  }

  // ---------------- 攻略笔记收藏（小红书等外部链接） ----------------
  function renderGuides(s, filter) {
    const guides = s.guides || [];
    filter = filter || {};
    const activeTag = filter.tag || '全部';
    const kw = (filter.keyword || '').trim().toLowerCase();
    const list = guides.filter(g => {
      if (activeTag !== '全部' && !(g.tags || []).includes(activeTag)) return false;
      if (!kw) return true;
      return [g.title, g.note, (g.tags || []).join(' ')].join(' ').toLowerCase().includes(kw);
    });

    const head = `<div class="list-head">
      <span>共 ${guides.length} 篇收藏</span>
      <button class="btn btn-primary" data-action="guide-add">＋ 收藏笔记</button>
    </div>`;

    const chips = ['全部', ...Store.CONST.guideTags].map(t =>
      `<button class="chip ${t === activeTag ? 'active' : ''}" data-action="guide-filter" data-tag="${esc(t)}">${esc(t)}</button>`).join('');

    const tools = `<div class="card place-tools">
      <div class="search-bar"><input type="search" id="guideSearch" placeholder="搜索标题 / 备注 / 标签…" value="${esc(filter.keyword || '')}"></div>
      <div class="chips">${chips}</div>
    </div>`;

    if (!guides.length) {
      return `<div class="card">${head}<div class="empty"><p>还没有收藏</p><p class="empty-hint">在小红书看到好攻略，点分享复制链接，存进来随时看 ${emo('📕')}</p></div></div>`;
    }

    const grid = list.length
      ? `<div class="place-grid">${list.map(g => renderGuideCard(s, g)).join('')}</div>`
      : `<div class="card"><div class="empty"><p>没有匹配的结果</p></div></div>`;

    return head + tools + grid;
  }

  function renderGuideCard(s, g) {
    const url = safeUrl(extractUrl(g.link || ''));
    const tags = (g.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    const body = `${url
        ? `<a class="guide-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
             <h3>${esc(g.title || '（未命名）')}</h3>
             <div class="guide-host">↗ ${esc(hostOf(url))}</div>
           </a>`
        : `<h3>${esc(g.title || '（未命名）')}</h3>`}
      ${tags ? `<div class="guide-tags">${tags}</div>` : ''}
      ${g.note ? `<div class="iti-note">${esc(g.note)}</div>` : ''}
      <div class="guide-foot">
        <button class="icon-btn" data-action="guide-edit" data-id="${esc(g.id)}" title="编辑">✎</button>
        <button class="icon-btn danger" data-action="guide-del" data-id="${esc(g.id)}" title="删除">✕</button>
      </div>`;
    return `<div class="card guide-card">
      ${g.cover ? `<a class="guide-cover" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(g.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>` : ''}
      <div class="guide-body">${body}</div>
    </div>`;
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
  }

  // 从分享文案里抽出纯链接。小红书 App 分享出来的是整段文字（标题+表情+链接+推广语），
  // 直接存会让 safeUrl 判为非法。
  function extractUrl(text) {
    const m = String(text == null ? '' : text).match(/https?:\/\/[^\s【】，。！？、"'）)】]+/i);
    return m ? m[0] : String(text == null ? '' : text).trim();
  }

  // 分享文案的【】里通常就是笔记标题
  function extractTitle(text) {
    const m = String(text == null ? '' : text).match(/【([^】]{2,})】/);
    return m ? m[1].trim() : '';
  }

  function formGuide(item) {
    const tags = Store.CONST.guideTags;
    const v = item || {};
    const picked = v.tags || [];
    return `<form data-form="guide">
      ${item ? `<input type="hidden" name="guideId" value="${esc(item.id)}">` : ''}
      <label>标题<input name="title" required placeholder="如：香港三天两夜保姆级攻略" value="${esc(v.title || '')}"></label>
      <label>链接<input name="link" placeholder="粘贴分享链接或整段分享文字，自动识别" value="${esc(v.link || '')}"></label>
      <label>标签<div class="chips guide-tag-pick">${tags.map(t =>
        `<button type="button" class="chip ${picked.includes(t) ? 'active' : ''}" data-action="guide-tag-toggle" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div></label>
      <input type="hidden" name="tags" value="${esc(picked.join(','))}">
      <label>备注<textarea name="note" rows="2" placeholder="哪几点值得去、要提前订什么">${esc(v.note || '')}</textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${item ? '保存' : '收藏'}</button></div>
    </form>`;
  }

  // ---------------- 票据 / 预订凭证 ----------------
  const bkType = (id) => Store.CONST.bookingTypes.find(x => x.id === id) || { icon: '🎫', label: '其他' };
  const bkStatusCls = (st) => ({ 待订: 'want', 已订: 'booked', 已完成: 'done', 已取消: 'cancel' }[st] || 'want');

  function renderBookings(s, filter) {
    const bookings = s.bookings || [];
    filter = filter || {};
    const activeType = filter.type || '全部';
    const activeStatus = filter.status || '全部';

    let list = bookings;
    if (activeType !== '全部') list = list.filter(b => b.type === activeType);
    if (activeStatus !== '全部') list = list.filter(b => (b.status || '待订') === activeStatus);
    list = [...list].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const head = `<div class="list-head">
      <span>共 ${bookings.length} 张票据</span>
      <button class="btn btn-primary" data-action="booking-add">＋ 添加票据</button>
    </div>`;

    const typeChips = ['全部', ...Store.CONST.bookingTypes.map(t => t.id)].map(c => {
      const label = c === '全部' ? '全部' : bkType(c).label;
      return `<button class="chip ${c === activeType ? 'active' : ''}" data-action="booking-filter-type" data-type="${esc(c)}">${label}</button>`;
    }).join('');
    const statusChips = ['全部', ...Store.CONST.bookingStatus].map(c =>
      `<button class="chip chip-sm ${c === activeStatus ? 'active' : ''}" data-action="booking-filter-status" data-status="${esc(c)}">${c}</button>`).join('');

    const tools = `<div class="card place-tools">
      <div class="chips">${typeChips}</div>
      <div class="chips">${statusChips}</div>
    </div>`;

    if (!bookings.length) {
      return head + tools + `<div class="card"><div class="empty">
        <p>还没有票据</p><p class="empty-hint">把订好的机票、火车票、大巴票、酒店凭证记进来 ${emo('🎫')}</p>
      </div></div>`;
    }

    const listHtml = list.length
      ? `<div class="booking-list">${list.map(b => renderBookingCard(s, b)).join('')}</div>`
      : `<div class="card"><div class="empty"><p>没有匹配的票据</p></div></div>`;

    return head + tools + listHtml;
  }

  function renderBookingCard(s, b) {
    const t = bkType(b.type);
    const route = [b.from, b.to].filter(Boolean).join(' → ');
    const sub = [route, b.date ? fmtDate(b.date) : '', b.time || '', b.carrier || '', b.refNo ? `#${b.refNo}` : ''].filter(Boolean).join(' · ');
    const pc = payerColor(s.meta, b.payer);
    const pi = ((s.meta && s.meta.members) || []).indexOf(b.payer);
    return `<div class="booking-card ${pc ? 'has-payer' : ''}" ${pc ? `style="--payer-color:${esc(pc)}"` : ''} data-action="booking-detail" data-id="${esc(b.id)}" role="button" tabindex="0">
      <div class="bk-icon" data-type="${esc(t.id)}">${emo(t.icon)}</div>
      <div class="bk-main">
        <div class="bk-title">${esc(b.title || route || t.label)}</div>
        ${sub ? `<div class="bk-sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="bk-side">
        ${pi >= 0 ? `<span class="bk-payer" title="${esc(b.payer)}">${avatarImg(s.meta, pi)}</span>` : ''}
        <span class="bk-status st-${bkStatusCls(b.status)}">${esc(b.status || '待订')}</span>
        ${b.price ? `<span class="bk-price">${money(b.price, s.meta.currency)}</span>` : ''}
      </div>
    </div>`;
  }

  function bookingDetail(s, id) {
    const b = (s.bookings || []).find(x => x.id === id);
    if (!b) return '<p class="empty small">找不到这张票据</p>';
    const t = bkType(b.type);
    const from = b.from || '';
    const to = b.to || '';
    const hasRoute = !!(from || to);
    const when = [b.date, b.time].filter(Boolean).join(' ');
    const when2 = [b.endDate, b.endTime].filter(Boolean).join(' ');
    const facts = [
      ['时间', when ? when + (when2 ? ' → ' + when2 : '') : ''],
      ['承运 / 车次', b.carrier],
      ['座位 / 房型', b.seat],
      ['订单号', b.refNo],
    ].filter(f => f[1]);
    const factCells = facts.map(([k, v]) =>
      `<div class="detail-fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')
      + (b.payer ? `<div class="detail-fact"><dt>付款人</dt><dd>${memberChip(s.meta, b.payer)}</dd></div>` : '');
    return `<div class="detail">
      <div class="detail-head">
        <h3>${emo(t.icon)} ${esc(b.title || t.label)}</h3>
        <div>
          <button class="icon-btn" data-action="booking-edit" data-id="${esc(b.id)}" title="编辑">✎</button>
          <button class="icon-btn danger" data-action="booking-del" data-id="${esc(b.id)}" title="删除">✕</button>
        </div>
      </div>
      <div class="detail-tags">
        <span class="badge">${t.label}</span>
        <span class="bk-status st-${bkStatusCls(b.status)}">${esc(b.status || '待订')}</span>
      </div>
      ${hasRoute ? `<div class="detail-route">
        <span class="pt">${esc(from || '—')}</span><span class="arrow">→</span><span class="pt">${esc(to || '—')}</span>
      </div>` : ''}
      ${factCells ? `<dl class="detail-facts">${factCells}</dl>` : ''}
      ${b.price ? `<div class="detail-amount">${money(b.price, s.meta.currency)}</div>` : ''}
      ${safeUrl(b.link) ? `<div class="detail-row">${emo('🔗')} <a href="${esc(safeUrl(b.link))}" target="_blank" rel="noopener noreferrer">${esc(b.link)}</a></div>` : ''}
      ${b.note ? `<div class="detail-note">${esc(b.note)}</div>` : ''}
    </div>`;
  }

  function formBooking(members, item) {
    const types = Store.CONST.bookingTypes;
    const sts = Store.CONST.bookingStatus;
    const v = item || {};
    const memberPick = memberPicker(members, item ? v.payer : undefined, Store.getState().meta, 'payer');
    return `<form data-form="booking">
      ${item ? `<input type="hidden" name="bookingId" value="${esc(item.id)}">` : ''}
      <div class="form-row">
        <label>票种<select name="type">${types.map(t => `<option value="${t.id}" ${item && t.id === (v.type || 'other') ? 'selected' : ''}>${t.icon} ${t.label}</option>`).join('')}</select></label>
        <label>状态<select name="status">${sts.map(st => `<option ${item && st === (v.status || '待订') ? 'selected' : ''}>${st}</option>`).join('')}</select></label>
      </div>
      <label>标题<input name="title" required placeholder="如：CZ3xxx 航班 / G6xx 车次 / 酒店名" value="${esc(v.title || '')}"></label>
      <div class="form-row">
        <label>出发地/起点<input name="from" placeholder="如：北京" value="${esc(v.from || '')}"></label>
        <label>到达地/终点<input name="to" placeholder="如：珠海" value="${esc(v.to || '')}"></label>
      </div>
      <div class="form-row">
        <label>日期<input type="date" name="date" value="${esc(v.date || '')}"></label>
        <label>时间<input type="time" name="time" value="${esc(v.time || '')}"></label>
      </div>
      <div class="form-row">
        <label>结束日期<input type="date" name="endDate" value="${esc(v.endDate || '')}"></label>
        <label>结束时间<input type="time" name="endTime" value="${esc(v.endTime || '')}"></label>
      </div>
      <div class="form-row">
        <label>承运/航司/车次<input name="carrier" placeholder="如：南方航空" value="${esc(v.carrier || '')}"></label>
        <label>座位/舱位/房型<input name="seat" placeholder="如：经济舱 / 大床房" value="${esc(v.seat || '')}"></label>
      </div>
      <div class="form-row">
        <label>订单号<input name="refNo" placeholder="如：ABC123" value="${esc(v.refNo || '')}"></label>
        <label>金额<input type="number" name="price" min="0" step="0.01" placeholder="0" inputmode="decimal" value="${esc(v.price == null ? '' : v.price)}"></label>
      </div>
      <div class="form-row">
        <label>谁付的${memberPick}</label>
        <label>链接<input name="link" placeholder="电子票链接（可选）" value="${esc(v.link || '')}"></label>
      </div>
      <label>备注<textarea name="note" rows="2" placeholder="取票码、行李、退改规则等">${esc(v.note || '')}</textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${item ? '保存' : '保存票据'}</button></div>
    </form>`;
  }

  // ---------------- 旅行切换器（侧栏快切用） ----------------
  function tripPicker() {
    const all = Store.listTrips();
    const activeId = Store.getActiveTripId();
    const btns = all.map(t => {
      const m = t.meta || {};
      const active = t.id === activeId;
      const arch = m.archived ? '<span class="trip-arch">已归档</span>' : '';
      return `<button class="btn ${active ? 'btn-primary' : 'btn-ghost'} trip-pick-btn" data-action="trip-pick" data-id="${esc(t.id)}">
        <span class="trip-pick-name">${esc(m.tripName || '未命名旅行')}${arch}</span>
        ${m.destination ? `<span class="trip-pick-dest">${esc(m.destination)}</span>` : ''}
      </button>`;
    }).join('');
    return `<div class="trip-pick">
      ${btns || '<p class="empty small">还没有旅行</p>'}
      <div class="form-actions"><button class="btn btn-ghost" data-action="trip-goto-list">管理旅行</button></div>
    </div>`;
  }

  // ---------------- 背景色选择 ----------------
  // 页面底色必须是浅调，卡片是纯白，底色过饱和会和卡片打架
  const BG_PRESETS = ['#f6f4ef', '#eef2f5', '#f5eff3', '#eef4f0', '#f8f1e8', '#f1f0f6', '#f0f2ed', '#f7eff0'];
  function themePicker(current) {
    const cur = (current || '#f6f4ef').toLowerCase();
    const sw = BG_PRESETS.map(c => `
      <button type="button" class="theme-swatch ${c === cur ? 'is-on' : ''}"
        data-action="theme-pick" data-color="${c}" style="--sw:${c}" aria-label="${c}"></button>`).join('');
    return `<form data-form="theme">
      <input type="hidden" name="bg" value="${esc(cur)}">
      <div class="theme-pick">
        <div class="theme-swatches">${sw}</div>
        <input type="color" name="custom" class="theme-custom" value="${esc(cur)}" aria-label="自定义颜色">
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">保存</button></div>
    </form>`;
  }

  // ---------------- 身份选择器 ----------------
  function identityPicker(trip) {
    const meta = (trip && trip.meta) || {};
    const members = meta.members || [];
    const idx = Store.getIdentity();
    // 有账目/负责记录的成员不允许删，否则历史会指向不存在的人
    const usedBy = (name) => (trip.expenses || []).some(e => e.payer === name)
      || (trip.bookings || []).some(b => b.payer === name)
      || (trip.checklist || []).some(c => c.owner === name);
    const rows = members.map((m, i) => {
      const active = idx === i;
      const used = usedBy(m);
      return `<div class="identity-row ${active ? 'is-active' : ''}"${colorOf(meta, i) ? ` style="--mc:${esc(colorOf(meta, i))}"` : ''}>
        <button class="identity-main" data-action="identity-pick" data-idx="${i}">
          <span class="identity-ava">${avatarImg(meta, i)}</span>
          <span class="identity-name">${esc(m)}${active ? '<span class="identity-now">这是我</span>' : ''}</span>
        </button>
        <button class="icon-btn" data-action="member-edit" data-idx="${i}" title="改昵称/头像/颜色">✎</button>
        <button class="icon-btn danger" data-action="member-del" data-idx="${i}" title="${used ? '名下还有记录，不能删除' : '删除'}" ${used ? 'disabled' : ''}>✕</button>
      </div>`;
    }).join('');
    return `<div class="identity-picker">
      <p class="identity-hint">你是谁？记账、清单、票据会默认记在你名下</p>
      <div class="identity-options">${rows}</div>
      <button class="btn btn-ghost identity-add" data-action="member-add">＋ 添加成员</button>
    </div>`;
  }

  function formMember(trip, idx) {
    const meta = (trip && trip.meta) || {};
    const members = meta.members || [];
    const cur = avatarOf(meta, idx);
    const curColor = colorOf(meta, idx);
    const opts = Store.CONST.avatarChoices.map(a =>
      `<button type="button" class="chip avatar-opt ${a === cur ? 'active' : ''}" data-action="avatar-pick" data-avatar="${a}">${emo(a)}</button>`).join('');
    const colorOpts = Store.CONST.colorChoices.map(c =>
      `<button type="button" class="chip color-opt ${c === curColor ? 'active' : ''}" data-action="color-pick" data-color="${esc(c)}" style="--swatch:${esc(c)}" title="${esc(c)}"></button>`).join('');
    return `<form data-form="member">
      <input type="hidden" name="idx" value="${idx}">
      <input type="hidden" name="avatar" value="${esc(cur)}">
      <input type="hidden" name="color" value="${esc(curColor)}">
      <label>昵称<input name="name" required value="${esc(members[idx] || '')}" placeholder="如：小树"></label>
      <label>头像<div class="avatar-grid">${opts}</div></label>
      <label>标识色<div class="color-grid">${colorOpts}</div></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">保存</button></div>
    </form>`;
  }

  return {
    TABS,
    esc, money, today, fmtDate, weekday,
    renderNav, renderTabbar, tabTitle, renderPage,
    formDay, formItem, formExpense, formChecklist, formWish, formPhoto, formPlace, formBooking,
    renderPlaces, placeDetail, dayDetail, renderBookings, bookingDetail, identityPicker,
    formGuide,
    extractUrl, extractTitle,
    tripPicker,
    formMember,
    renderTripBoard,
    emojiSrc,
    themePicker,
  };
})();
