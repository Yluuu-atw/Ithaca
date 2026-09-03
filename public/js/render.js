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
    { id: 'map', label: '地图', icon: '📍' },
    { id: 'expenses', label: '记账', icon: '💰' },
    { id: 'checklist', label: '清单', icon: '🎒' },
    { id: 'wishlist', label: '心愿单', icon: '⭐' },
    { id: 'photos', label: '照片', icon: '📷' },
  ];

  // ---------------- 小工具 ----------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n, currency) {
    const v = Number(n) || 0;
    const sym = Store.CONST.currencySymbol[currency] || '';
    return sym + v.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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
  function renderPage(state, tab) {
    switch (tab) {
      case 'itinerary': return renderItinerary(state);
      case 'map': return renderMap(state);
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
        <div class="settle-name">${esc(name)}</div>
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
  function renderItinerary(s) {
    const days = [...s.itinerary].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const estTotal = s.itinerary.reduce((a, d) => a + (d.items || []).reduce((x, i) => x + (Number(i.estimatedCost) || 0), 0), 0);
    const head = `<div class="list-head">
      <span>共 ${days.length} 天 · 预估 ${money(estTotal, s.meta.currency)}</span>
      <button class="btn btn-primary" data-action="itinerary-add-day">＋ 新建一天</button>
    </div>`;

    if (!days.length) {
      return `<div class="card">${head}<div class="empty">
        <p>还没有行程安排</p><p class="empty-hint">先新建一天，再把想去的地方排进去 ✨</p>
      </div></div>`;
    }
    return head + `<div class="day-list">${days.map((d, i) => renderDay(s, d, i)).join('')}</div>`;
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
        <div class="settle-name">${esc(name)}</div>
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
          <span class="tag">${esc(e.payer || '')} 付</span>
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
        ${c.owner ? `<span class="tag">${esc(c.owner)}</span>` : ''}
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
        <label>谁付的<select name="payer">${members.map(m => `<option>${esc(m)}</option>`).join('')}</select></label>
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
        <label>谁带<select name="owner">${members.map(m => `<option>${esc(m)}</option>`).join('')}</select></label>
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
  function renderMap(s) {
    const pointCount = s.itinerary.reduce((a, d) => a + (d.items || []).filter(i => i.lat != null && i.lng != null).length, 0);
    const trackCount = (s.tracks || []).length;
    return `
      <div class="map-layout">
        <div class="map-toolbar">
          <div class="map-legend" id="mapLegend"></div>
          <div class="map-actions">
            <button class="btn btn-ghost btn-sm" data-action="gpx-import">⬆ 导入 GPX 足迹</button>
            <button class="btn btn-ghost btn-sm" data-action="map-fit">⤢ 全部</button>
          </div>
        </div>
        <div id="map" class="map-container"></div>
        <div class="map-hint">
          已标注 ${pointCount} 个行程点 · ${trackCount} 条足迹轨迹
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

  return {
    TABS,
    esc, money, today, fmtDate, weekday,
    renderNav, renderTabbar, tabTitle, renderPage,
    formDay, formItem, formExpense, formChecklist, formWish, formPhoto,
  };
})();
