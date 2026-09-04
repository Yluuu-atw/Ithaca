'use strict';

/**
 * render.js —— 呈现层（纯视图）。
 * 只负责把 Store 里的数据渲染成 HTML 字符串，不直接改数据、不碰网络。
 * 交互逻辑在 app.js，通过 data-action / data-* 属性委托处理。
 */

window.Render = (() => {
  const TABS = [
    { id: 'overview', label: '概览', icon: '🏠' },
    { id: 'itinerary', label: '行程', icon: '🗺️' },
    { id: 'places', label: '攻略', icon: '📌' },
    { id: 'bookings', label: '票据', icon: '🎫' },
    { id: 'expenses', label: '记账', icon: '💰' },
    { id: 'checklist', label: '清单', icon: '🎒' },
    { id: 'wishlist', label: '心愿单', icon: '⭐' },
    { id: 'map', label: '地图', icon: '📍' },
    { id: 'photos', label: '照片', icon: '📷' },
  ];

  // ---------------- 小工具 ----------------
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

  // 成员名显示：本设备自己的成员显示「我」，对方显示实际称呼
  function dispName(members, name) {
    const idx = Store.getIdentity();
    if (idx != null && name === members[idx]) return '我';
    return name || '';
  }

  // 表单里的成员下拉：自己显示「我」并默认选中
  function memberOptions(members) {
    const idx = Store.getIdentity();
    return (members || []).map((m, i) => {
      const label = (idx != null && i === idx) ? '我' : m;
      const sel = (idx != null && i === idx) ? ' selected' : '';
      return `<option value="${esc(m)}"${sel}>${esc(label)}</option>`;
    }).join('');
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
  function summarizeExpenses(s) {
    const members = s.meta.members || [];
    const total = s.expenses.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const advanced = {}; members.forEach(m => advanced[m] = 0);
    const shouldPay = {}; members.forEach(m => shouldPay[m] = 0);
    const byCategory = {};

    for (const e of s.expenses) {
      const amt = Number(e.amount) || 0;
      const payer = e.payer || members[0] || '';
      advanced[payer] = (advanced[payer] || 0) + amt;
      byCategory[e.category || '其他'] = (byCategory[e.category || '其他'] || 0) + amt;
      if (e.split === '单方') {
        shouldPay[payer] = (shouldPay[payer] || 0) + amt;
      } else {
        const share = amt / Math.max(1, members.length);
        members.forEach(m => shouldPay[m] = (shouldPay[m] || 0) + share);
      }
    }
    const balance = {};
    members.forEach(m => balance[m] = (advanced[m] || 0) - (shouldPay[m] || 0));
    return { total, advanced, shouldPay, balance, byCategory };
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
        <span class="nav-icon">${t.icon}</span><span class="nav-label">${t.label}</span>
      </button>`).join('');
  }

  function renderTabbar(active) {
    return TABS.map(t => `
      <button class="tab-item ${t.id === active ? 'active' : ''}" data-action="nav" data-tab="${t.id}">
        <span class="tab-icon">${t.icon}</span><span class="tab-label">${t.label}</span>
      </button>`).join('');
  }

  function tabTitle(tab) {
    const t = TABS.find(x => x.id === tab);
    return t ? t.label : '';
  }

  // ---------------- 页面分发 ----------------
  function renderPage(state, tab, opts) {
    opts = opts || {};
    switch (tab) {
      case 'itinerary': return renderItinerary(state, opts.itineraryMode);
      case 'places': return renderPlaces(state, opts.placeFilter);
      case 'bookings': return renderBookings(state, opts.bookingFilter);
      case 'map': return renderMap(state, opts.tileSource);
      case 'expenses': return renderExpenses(state);
      case 'checklist': return renderChecklist(state);
      case 'wishlist': return renderWishlist(state);
      case 'photos': return renderPhotos(state);
      default: return renderOverview(state);
    }
  }

  // ---------------- 概览 ----------------
  function renderOverview(s) {
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
        <div class="settle-name">${esc(dispName(m.members || [], name))}</div>
        <div class="settle-line">垫付 ${money(exp.advanced[name] || 0, m.currency)} · 应付 ${money(exp.shouldPay[name] || 0, m.currency)}</div>
        <div class="settle-bal ${cls}">${txt}</div>
      </div>`;
    }).join('');

    const catEntries = Object.entries(exp.byCategory).sort((a, b) => b[1] - a[1]);
    const maxCat = Math.max(1, ...catEntries.map(e => e[1]));
    const catBars = catEntries.map(([c, v]) => `
      <div class="cat-row">
        <span class="cat-name">${esc(c)}</span>
        <div class="cat-bar"><div class="cat-fill" style="width:${(v / maxCat * 100).toFixed(0)}%"></div></div>
        <span class="cat-val">${money(v, m.currency)}</span>
      </div>`).join('') || '<p class="empty">还没有记账记录</p>';

    return `
      <div class="page-stack">
        <section class="card">
          <div class="card-head"><h2>🧳 行程信息</h2></div>
          <form class="grid-form" data-form="meta">
            <label>旅行名称<input name="tripName" value="${esc(m.tripName)}"></label>
            <label>目的地<input name="destination" value="${esc(m.destination)}" placeholder="如：日本 · 关西"></label>
            <label>开始日期<input type="date" name="startDate" value="${esc(m.startDate)}"></label>
            <label>结束日期<input type="date" name="endDate" value="${esc(m.endDate)}"></label>
            <label>币种<select name="currency">${currencyOpts}</select></label>
            <label>成员（逗号分隔）<input name="members" value="${esc((m.members || []).join(','))}" placeholder="我,她"></label>
            <div class="form-actions"><button class="btn btn-primary" type="submit">保存</button></div>
          </form>
        </section>

        <section class="stat-grid">
          <div class="stat-card"><div class="stat-value">${money(exp.total, m.currency)}</div><div class="stat-label">总花费</div></div>
          <div class="stat-card"><div class="stat-value">${s.itinerary.length}</div><div class="stat-label">行程天数</div></div>
          <div class="stat-card"><div class="stat-value">${checklistDone}/${checklistTotal}</div><div class="stat-label">清单完成</div></div>
          <div class="stat-card"><div class="stat-value">${s.wishlist.length}</div><div class="stat-label">心愿单</div></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>💸 花费与结算</h2></div>
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
        <p>还没有行程安排</p><p class="empty-hint">先新建一天，再把想去的地方排进去 ✨</p>
      </div></div>`;
    }
    if (isDetail) {
      return head + `<div class="day-list">${days.map((d, i) => renderDay(s, d, i)).join('')}</div>`;
    }
    return head + `<div class="day-list">${days.map((d, i) => renderDaySimple(s, d, i)).join('')}</div>`;
  }

  function renderDaySimple(s, d, idx) {
    const items = d.items || [];
    const dayTotal = items.reduce((x, i) => x + (Number(i.estimatedCost) || 0), 0);
    const date = d.date || '';
    const dayNo = (s.meta.startDate && date && diffDays(s.meta.startDate, date) >= 0)
      ? diffDays(s.meta.startDate, date) + 1 : idx + 1;
    const firstTitles = items.slice(0, 3).map(i => esc(i.title)).join(' · ');
    return `<button class="day-simple" data-action="day-detail" data-day="${esc(d.id)}">
      <div class="day-simple-num">Day ${dayNo}</div>
      <div class="day-simple-main">
        <div class="day-simple-date">${fmtDate(date)} ${weekday(date)}</div>
        <div class="day-simple-titles">${items.length ? firstTitles + (items.length > 3 ? ' …' : '') : '（暂无安排）'}</div>
      </div>
      <div class="day-simple-side">
        <span class="day-simple-count">${items.length} 项</span>
        ${dayTotal ? `<span class="iti-cost">${money(dayTotal, s.meta.currency)}</span>` : ''}
        <span class="chevron">›</span>
      </div>
    </button>`;
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
        ? `<ul class="iti-list detail-list">${items.map(i => renderItiItem(s, day.id, i)).join('')}</ul>`
        : '<p class="empty small">这天还没有安排</p>'}
    </div>`;
  }

  function renderDay(s, d, idx) {
    const items = [...(d.items || [])].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    const dayTotal = items.reduce((x, i) => x + (Number(i.estimatedCost) || 0), 0);
    const date = d.date || '';
    const dayNo = (s.meta.startDate && date && diffDays(s.meta.startDate, date) >= 0)
      ? diffDays(s.meta.startDate, date) + 1 : idx + 1;

    return `<section class="card day-card">
      <div class="day-head">
        <div><h3>Day ${dayNo} <span class="day-date">${fmtDate(date)} ${weekday(date)}</span></h3></div>
        <div class="day-actions">
          ${dayTotal ? `<span class="iti-cost">${money(dayTotal, s.meta.currency)}</span>` : ''}
          <button class="btn btn-ghost btn-sm" data-action="itinerary-add-item" data-day="${esc(d.id)}">＋ 安排</button>
          <button class="icon-btn danger" data-action="itinerary-del-day" data-day="${esc(d.id)}" title="删除这一天">✕</button>
        </div>
      </div>
      ${items.length
        ? `<ul class="iti-list">${items.map(i => renderItiItem(s, d.id, i)).join('')}</ul>`
        : '<p class="empty small">这天还没有安排</p>'}
    </section>`;
  }

  function renderItiItem(s, dayId, i) {
    return `<li class="iti-item">
      <div class="iti-time">
        <span class="t-start">${esc(i.time || '—')}</span>
        ${i.endTime ? `<span class="t-arrow">↓</span><span class="t-end">${esc(i.endTime)}</span>` : ''}
      </div>
      <div class="iti-main">
        <div class="iti-title">${esc(i.title || '（未命名）')}</div>
        ${i.location ? `<div class="iti-loc">📍 ${esc(i.location)}</div>` : ''}
        ${i.note ? `<div class="iti-note">${esc(i.note)}</div>` : ''}
      </div>
      <div class="iti-side">
        <span class="badge">${esc(i.category || '其他')}</span>
        ${i.estimatedCost ? `<span class="iti-cost">${money(i.estimatedCost, s.meta.currency)}</span>` : ''}
        <button class="icon-btn danger" data-action="itinerary-del-item" data-day="${esc(dayId)}" data-item="${esc(i.id)}" title="删除">✕</button>
      </div>
    </li>`;
  }

  // ---------------- 记账 ----------------
  function renderExpenses(s) {
    const exp = summarizeExpenses(s);
    const grouped = groupByDate(s.expenses);
    const head = `<div class="list-head">
      <span>共 ${s.expenses.length} 笔 · 总计 ${money(exp.total, s.meta.currency)}</span>
      <button class="btn btn-primary" data-action="expense-add">＋ 记一笔</button>
    </div>`;

    const settle = (s.meta.members || []).map(name => {
      const b = exp.balance[name] || 0;
      let txt, cls;
      if (b > 0.005) { txt = '应收 ' + money(b, s.meta.currency); cls = 'pos'; }
      else if (b < -0.005) { txt = '应补 ' + money(-b, s.meta.currency); cls = 'neg'; }
      else { txt = '持平'; cls = 'zero'; }
      return `<div class="settle-item">
        <div class="settle-name">${esc(dispName(s.meta.members || [], name))}</div>
        <div class="settle-line">垫付 ${money(exp.advanced[name] || 0, s.meta.currency)} · 应付 ${money(exp.shouldPay[name] || 0, s.meta.currency)}</div>
        <div class="settle-bal ${cls}">${txt}</div>
      </div>`;
    }).join('');

    const summary = `<section class="card"><div class="card-head"><h2>🧾 结算</h2></div><div class="settle-grid">${settle}</div></section>`;

    const body = grouped.length
      ? grouped.map(g => renderExpenseGroup(s, g)).join('')
      : `<div class="card"><div class="empty"><p>还没有记账</p><p class="empty-hint">点击「记一笔」开始记录花费 💸</p></div></div>`;

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
          <span class="badge">${esc(e.category || '其他')}</span>
          ${e.time ? `<span class="exp-time">${esc(e.time)}</span>` : ''}
          <span class="tag">${esc(dispName(s.meta.members || [], e.payer || ''))} 付</span>
          <span class="tag">${splitTag}</span>
        </div>
      </div>
      <div class="exp-side">
        <span class="exp-amount">${money(e.amount, s.meta.currency)}</span>
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
      return `<div class="card">${head}<div class="empty"><p>打包清单是空的</p><p class="empty-hint">把要带的东西加进来吧 🎒</p></div></div>`;
    }

    const progress = `<div class="card progress-wrap">
      <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
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
        ${c.owner ? `<span class="tag">${esc(dispName(s.meta.members || [], c.owner))}</span>` : ''}
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
      return `<div class="card">${head}<div class="empty"><p>还没有心愿</p><p class="empty-hint">把想去的地方、想做的事记下来 ⭐</p></div></div>`;
    }
    return head + `<div class="wish-grid">${s.wishlist.map(w => renderWishItem(s, w)).join('')}</div>`;
  }

  function renderWishItem(s, w) {
    const prio = w.priority || '中';
    const prioCls = { 高: 'high', 中: 'mid', 低: 'low' }[prio] || 'mid';
    return `<div class="card wish-card">
      <div class="wish-head">
        <h3>${esc(w.name)}</h3>
        <button class="icon-btn danger" data-action="wish-del" data-id="${esc(w.id)}" title="删除">✕</button>
      </div>
      ${w.location ? `<div class="iti-loc">📍 ${esc(w.location)}</div>` : ''}
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

  function formItem(dayId) {
    const cats = Store.CONST.itineraryCategories;
    return `<form data-form="item">
      <input type="hidden" name="dayId" value="${esc(dayId)}">
      <div class="form-row">
        <label>开始时间<input type="time" name="time" value="09:00"></label>
        <label>结束时间<input type="time" name="endTime"></label>
      </div>
      <label>安排内容<input name="title" required placeholder="如：清水寺"></label>
      <label>地点<input name="location" placeholder="如：京都 · 东山区"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label>预估花费<input type="number" name="estimatedCost" min="0" step="0.01" placeholder="0" inputmode="decimal"></label>
      </div>
      <label>备注<input name="note" placeholder="预约信息、路线等"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">添加</button></div>
    </form>`;
  }

  function formExpense(members) {
    const cats = Store.CONST.expenseCategories;
    const splits = Store.CONST.splitOptions;
    return `<form data-form="expense">
      <div class="form-row">
        <label>日期<input type="date" name="date" required value="${today()}"></label>
        <label>时间<input type="time" name="time"></label>
      </div>
      <label>金额<input type="number" name="amount" min="0" step="0.01" required placeholder="0.00" inputmode="decimal"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label>谁付的<select name="payer">${memberOptions(members)}</select></label>
      </div>
      <label>分摊<select name="split">${splits.map(sp => `<option>${sp}</option>`).join('')}</select></label>
      <label>备注<input name="note" placeholder="如：晚饭 · 烤肉"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">记下</button></div>
    </form>`;
  }

  function formChecklist(members) {
    const cats = Store.CONST.checklistCategories;
    return `<form data-form="checklist">
      <label>物品<input name="name" required placeholder="如：护照"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label>谁带<select name="owner">${memberOptions(members)}</select></label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">添加</button></div>
    </form>`;
  }

  function formWish() {
    const prios = Store.CONST.priorities;
    return `<form data-form="wish">
      <label>心愿<input name="name" required placeholder="如：看一次日出"></label>
      <label>地点<input name="location" placeholder="如：海边"></label>
      <label>优先级<select name="priority">${prios.map(p => `<option>${p}</option>`).join('')}</select></label>
      <label>备注<input name="note" placeholder="为什么想去、有什么期待"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">添加</button></div>
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
        <p class="empty-hint">把旅行照片传上来，做成手帐 📷✨</p>
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
            ${p.location ? `<span class="photo-cap-loc">📍 ${esc(p.location)}</span>` : ''}
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
        <p>还没有收藏的地点</p><p class="empty-hint">把要订的酒店、想去的餐厅加进来 📌</p>
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
        <span class="badge">${esc(p.category || '其他')}</span>
        <span class="place-status st-${stCls}">${esc(p.status || '想去')}</span>
      </div>
      <h3 class="place-name">${esc(p.name || '（未命名）')}</h3>
      ${p.location ? `<div class="place-loc">📍 ${esc(p.location)}</div>` : ''}
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
        <button class="icon-btn danger" data-action="place-del" data-id="${esc(p.id)}" title="删除">✕</button>
      </div>
      <div class="detail-tags">
        <span class="badge">${esc(p.category || '其他')}</span>
        <span class="place-status st-${({想去:'want',待订:'pending',已订:'booked'}[p.status] || 'want')}">${esc(p.status || '想去')}</span>
      </div>
      ${p.location ? `<div class="detail-row">📍 ${esc(p.location)}</div>` : ''}
      ${p.date ? `<div class="detail-row">📅 ${esc(p.date)}</div>` : ''}
      ${p.cost ? `<div class="detail-row">💰 ${money(p.cost, s.meta.currency)}</div>` : ''}
      ${safeUrl(p.link) ? `<div class="detail-row">🔗 <a href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener noreferrer">${esc(p.link)}</a></div>` : ''}
      ${p.note ? `<div class="detail-note">${esc(p.note)}</div>` : ''}
    </div>`;
  }

  function formPlace() {
    const cats = Store.CONST.placeCategories;
    const sts = Store.CONST.placeStatus;
    return `<form data-form="place">
      <label>名称<input name="name" required placeholder="如：尖沙咀某酒店"></label>
      <div class="form-row">
        <label>分类<select name="category">${cats.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label>状态<select name="status">${sts.map(st => `<option>${st}</option>`).join('')}</select></label>
      </div>
      <label>地点<input name="location" placeholder="如：香港尖沙咀"></label>
      <div class="form-row">
        <label>日期<input type="date" name="date"></label>
        <label>预算/价格<input type="number" name="cost" min="0" step="0.01" placeholder="0" inputmode="decimal"></label>
      </div>
      <label>链接<input name="link" placeholder="预订链接（可选）"></label>
      <label>备注<textarea name="note" rows="2" placeholder="房型、预订号、推荐菜等"></textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">保存</button></div>
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
        <p>还没有票据</p><p class="empty-hint">把订好的机票、火车票、大巴票、酒店凭证记进来 🎫</p>
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
    return `<div class="booking-card" data-action="booking-detail" data-id="${esc(b.id)}" role="button" tabindex="0">
      <div class="bk-icon">${t.icon}</div>
      <div class="bk-main">
        <div class="bk-title">${esc(b.title || route || t.label)}</div>
        ${sub ? `<div class="bk-sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="bk-side">
        <span class="bk-status st-${bkStatusCls(b.status)}">${esc(b.status || '待订')}</span>
        ${b.price ? `<span class="bk-price">${money(b.price, s.meta.currency)}</span>` : ''}
      </div>
    </div>`;
  }

  function bookingDetail(s, id) {
    const b = (s.bookings || []).find(x => x.id === id);
    if (!b) return '<p class="empty small">找不到这张票据</p>';
    const t = bkType(b.type);
    const route = [b.from, b.to].filter(Boolean).join(' → ');
    const when = [b.date, b.time].filter(Boolean).join(' ');
    const when2 = [b.endDate, b.endTime].filter(Boolean).join(' ');
    return `<div class="detail">
      <div class="detail-head">
        <h3>${t.icon} ${esc(b.title || route || t.label)}</h3>
        <button class="icon-btn danger" data-action="booking-del" data-id="${esc(b.id)}" title="删除">✕</button>
      </div>
      <div class="detail-tags">
        <span class="badge">${t.label}</span>
        <span class="bk-status st-${bkStatusCls(b.status)}">${esc(b.status || '待订')}</span>
      </div>
      ${route ? `<div class="detail-row">🛣 ${esc(route)}</div>` : ''}
      ${when ? `<div class="detail-row">🕐 ${esc(when)}${when2 ? ' → ' + esc(when2) : ''}</div>` : ''}
      ${b.carrier ? `<div class="detail-row">🚩 承运/航司/车次：${esc(b.carrier)}</div>` : ''}
      ${b.seat ? `<div class="detail-row">💺 座位/舱位/房型：${esc(b.seat)}</div>` : ''}
      ${b.refNo ? `<div class="detail-row">🧾 订单号：${esc(b.refNo)}</div>` : ''}
      ${b.price ? `<div class="detail-row">💰 金额：${money(b.price, s.meta.currency)}</div>` : ''}
      ${b.payer ? `<div class="detail-row">👤 付款人：${esc(b.payer)}</div>` : ''}
      ${safeUrl(b.link) ? `<div class="detail-row">🔗 <a href="${esc(safeUrl(b.link))}" target="_blank" rel="noopener noreferrer">${esc(b.link)}</a></div>` : ''}
      ${b.note ? `<div class="detail-note">${esc(b.note)}</div>` : ''}
    </div>`;
  }

  function formBooking(members) {
    const types = Store.CONST.bookingTypes;
    const sts = Store.CONST.bookingStatus;
    const memberOpts = memberOptions(members);
    return `<form data-form="booking">
      <div class="form-row">
        <label>票种<select name="type">${types.map(t => `<option value="${t.id}">${t.icon} ${t.label}</option>`).join('')}</select></label>
        <label>状态<select name="status">${sts.map(st => `<option>${st}</option>`).join('')}</select></label>
      </div>
      <label>标题<input name="title" required placeholder="如：CZ3xxx 航班 / G6xx 车次 / 酒店名"></label>
      <div class="form-row">
        <label>出发地/起点<input name="from" placeholder="如：北京"></label>
        <label>到达地/终点<input name="to" placeholder="如：珠海"></label>
      </div>
      <div class="form-row">
        <label>日期<input type="date" name="date"></label>
        <label>时间<input type="time" name="time"></label>
      </div>
      <div class="form-row">
        <label>结束日期<input type="date" name="endDate"></label>
        <label>结束时间<input type="time" name="endTime"></label>
      </div>
      <div class="form-row">
        <label>承运/航司/车次<input name="carrier" placeholder="如：南方航空"></label>
        <label>座位/舱位/房型<input name="seat" placeholder="如：经济舱 / 大床房"></label>
      </div>
      <div class="form-row">
        <label>订单号<input name="refNo" placeholder="如：ABC123"></label>
        <label>金额<input type="number" name="price" min="0" step="0.01" placeholder="0" inputmode="decimal"></label>
      </div>
      <div class="form-row">
        <label>谁付的<select name="payer">${memberOpts}</select></label>
        <label>链接<input name="link" placeholder="电子票链接（可选）"></label>
      </div>
      <label>备注<textarea name="note" rows="2" placeholder="取票码、行李、退改规则等"></textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">保存票据</button></div>
    </form>`;
  }

  // ---------------- 身份选择器 ----------------
  function identityPicker(members) {
    const idx = Store.getIdentity();
    const btns = (members || []).map((m, i) => {
      const active = idx === i;
      return `<button class="btn ${active ? 'btn-primary' : 'btn-ghost'} identity-btn" data-action="identity-pick" data-idx="${i}">
        <span class="identity-icon">${i === 0 ? '👨' : '👩'}</span>
        <span>我是 ${esc(m)}</span>
      </button>`;
    }).join('');
    return `<div class="identity-picker">
      <p class="identity-hint">你是谁？之后记账、清单、票据会默认记在你名下</p>
      <div class="identity-options">${btns}</div>
    </div>`;
  }

  return {
    TABS,
    esc, money, today, fmtDate, weekday,
    renderNav, renderTabbar, tabTitle, renderPage,
    formDay, formItem, formExpense, formChecklist, formWish, formPhoto, formPlace, formBooking,
    renderPlaces, placeDetail, dayDetail, renderBookings, bookingDetail, identityPicker,
  };
})();
