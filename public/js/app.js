'use strict';

/**
 * app.js —— 交互层。
 * 监听用户操作（点击/提交/变更），调用 Store 改数据，弹窗收集输入。
 * 通过 data-action / data-* 属性做事件委托，避免给每个按钮单独绑事件。
 */

window.App = (() => {
  const current = { view: 'welcome', tab: 'overview', itinerarySelection: null, ledgerFilter: 'all', settlementDetailsOpen: false, settlementDetailsTripId: '', placeFilter: { category: '全部', keyword: '' }, guideFilter: { tag: '全部', keyword: '' }, showArchived: false, editMeta: false, calY: new Date().getFullYear(), calM: new Date().getMonth(), editTrips: false };
  const guidePlans = new Map();
  let dockKick = null;
  let welcomeSceneSource = '';
  let welcomeSceneSrc = '';
  let shareNotice = '';
  let sharePeople = [];
  let footprintsDayTimer = null;
  let footprintsDayStamp = '';
  const viewActions = new Set([
    'archive-trip-open', 'board-toggle', 'boarding-pass-save',
    'cal-day', 'cal-next', 'cal-prev', 'dt-item-toggle',
    'expense-detail', 'export', 'footprints-city', 'footprints-place', 'footprints-place-result',
    'footprints-pick', 'footprints-cancel-pick', 'footprints-fit',
    'guide-filter', 'item-back', 'itinerary-select-date', 'ledger-filter', 'settlement-details-toggle',
    'map-fit', 'modal-close', 'nav', 'packing-type', 'photo-day-open', 'photo-open', 'photo-open-url', 'place-detail', 'place-filter',
    'switch-identity', 'switch-trip', 'tile-source', 'trip-goto-list', 'trip-open',
    'trip-pick', 'trip-toggle-archived', 'welcome-calendar', 'welcome-enter',
    'welcome-home', 'welcome-trips',
  ]);

  function temporaryActionAllowed(action, el) {
    const trip = Store.getState();
    const lists = {
      'expense-edit': 'expenses', 'expense-del': 'expenses',
      'checklist-toggle': 'checklist', 'checklist-edit': 'checklist', 'checklist-del': 'checklist',
      'wish-status': 'wishlist', 'wish-edit': 'wishlist', 'wish-del': 'wishlist',
      'photo-del': 'photos', 'place-edit': 'places', 'place-del': 'places',
      'guide-edit': 'guides', 'guide-del': 'guides',
    };
    if (lists[action]) {
      const record = (trip[lists[action]] || []).find(item => item.id === el.dataset.id);
      if (!record || !Store.canEditRecord(record)) return false;
      if ((action === 'expense-edit' || action === 'expense-del') && record.itemId) {
        const item = (trip.itinerary || []).flatMap(day => day.items || []).find(entry => entry.id === record.itemId);
        if (item && !Store.canEditRecord(item)) return false;
      }
      return true;
    }
    if (action === 'itinerary-edit-item' || action === 'itinerary-del-item') {
      const day = (trip.itinerary || []).find(item => item.id === el.dataset.day);
      const item = day && (day.items || []).find(entry => entry.id === el.dataset.item);
      if (!item || !Store.canEditRecord(item)) return false;
      return action !== 'itinerary-del-item' || !(trip.expenses || []).some(expense =>
        expense.itemId === item.id && !Store.canEditRecord(expense));
    }
    if (action === 'itinerary-del-day') {
      const day = (trip.itinerary || []).find(item => item.id === el.dataset.day);
      if (!day || !Store.canEditRecord(day) || (day.items || []).some(item => !Store.canEditRecord(item))) return false;
      const ids = new Set((day.items || []).map(item => item.id));
      return !(trip.expenses || []).some(expense => ids.has(expense.itemId) && !Store.canEditRecord(expense));
    }
    if (['meta-edit', 'meta-cancel', 'currency-change', 'packing-type', 'pool-toggle',
      'template-manage', 'template-save', 'template-edit', 'template-new', 'template-del',
      'template-item-add', 'template-item-del', 'trip-archive'].includes(action)) return false;
    return true;
  }

  function actionAllowed(action, el) {
    if (action === 'voucher-open') return Store.getIdentity() != null;
    if (action === 'settle-confirm') return Store.getIdentity() != null;
    if (viewActions.has(action) || action === 'account-open' || action === 'account-logout') return true;
    if (action.startsWith('passkey-')) return !!AuthUI.user;
    if (action === 'account-avatar-open') return !!AuthUI.user;
    if (action === 'share-open' || action.startsWith('share-')) return Store.canManageTrip(el.dataset.id || undefined);
    if (action === 'trip-del-confirm' || action === 'trip-del-ok' || action === 'trip-delete') {
      return Store.canManageTrip(el.dataset.id);
    }
    if (action === 'tripmgr-edit') return Store.listTrips().some(trip => Store.canManageTrip(trip.id));
    if (action === 'trip-create' || action === 'import' || action.startsWith('memo-') || action.startsWith('template-') || action === 'welcome-memo') {
      return !!AuthUI.user;
    }
    if (action === 'theme-open' || action === 'theme-pick') {
      return !!AuthUI.user;
    }
    if (action.startsWith('trip-profile-')) return Store.getIdentity() != null;
    if (Store.getRole() === 'temporary') return temporaryActionAllowed(action, el);
    return Store.canEditTrip(el.dataset.id && Store.getRole(el.dataset.id) ? el.dataset.id : undefined);
  }

  function applyPermissions(root = document) {
    root.querySelectorAll('[data-action]').forEach(el => {
      const allowed = actionAllowed(el.dataset.action, el);
      el.classList.toggle('permission-hidden', !allowed);
      if ('disabled' in el) el.disabled = !allowed || el.dataset.empty === 'true';
    });
    root.querySelectorAll('.action-menu').forEach(menu => {
      menu.hidden = !menu.querySelector('[data-action]:not(.permission-hidden)');
    });
  }

  function applyTheme(base) {
    const theme = Theme.apply(base);
    Brand.apply(theme.brand);
    document.querySelectorAll('.theme-dot').forEach(d => { d.style.background = theme.base; });
    // Repaint the inline scene as soon as the background theme changes. The
    // source is cached so picking several colors in the modal stays instant.
    if (current.view === 'welcome' && document.getElementById('welcomeBg')) paintWelcomeBg();
    if (dockKick) dockKick();
  }
  const $ = (sel) => document.querySelector(sel);
  const modal = () => $('#modal');
  const modalBody = () => $('#modalBody');
  const modalTitle = () => $('#modalTitle');
  const modalTaskProgress = () => $('#modalTaskProgress');

  // datetime-local 的值是 YYYY-MM-DDTHH:MM，拆回日期与时分两段存
  function splitDT(v) {
    if (!v) return ['', ''];
    const i = String(v).indexOf('T');
    if (i < 0) return ['', String(v)];
    return [v.slice(0, i), v.slice(i + 1, i + 6)];
  }

  // 参与人多选的隐藏域存 JSON 数组，解析失败当作空
  function parseList(v) {
    try {
      const a = JSON.parse(v || '[]');
      return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x) : [];
    } catch (_) {
      return [];
    }
  }

  let toastTimer = null;

  // ---------------- 状态提示 ----------------
  function setStatus(ok, text) {
    const dot = $('#statusDot');
    const t = $('#statusText');
    if (dot) dot.className = 'dot ' + (ok ? 'ok' : 'err');
    if (t) t.textContent = text;
  }

  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (type || 'info');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------------- 开启页视图切换 ----------------
  function setView(view) {
    current.view = view;
    document.body.classList.toggle('is-welcome', view === 'welcome');
    if (view === 'welcome') {
      clearFootprintsView();
      // View switches do not notify the store, so reapply the account theme here.
      applyTheme(Store.getWelcomeTheme());
      $('#welcome').innerHTML = Render.renderWelcome();
      Brand.refresh();
      applyPermissions();
      fetchWeather();
      paintWelcomeBg();
      return;
    }
    render();
  }

  // 把背景 SVG 内联进 DOM，才能对它的子元素逐个做描边式淡入。
  // <img> 引用的 SVG 受独立文档作用域限制，CSS 动画够不着内部节点。
  async function paintWelcomeBg() {
    const host = document.getElementById('welcomeBg');
    if (!host) return;
    const src = host.dataset.src;
    if (!src) return;
    try {
      if (!welcomeSceneSource || welcomeSceneSrc !== src) {
        const res = await fetch(src);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        welcomeSceneSource = await res.text();
        welcomeSceneSrc = src;
      }
      host.innerHTML = Theme.recolorSvg(welcomeSceneSource, Store.getWelcomeTheme());
      // slice 让 SVG 像 object-fit:cover 一样铺满并裁边，缩放窗口不再移位
      const root = host.querySelector('svg');
      if (root) root.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      const nodes = host.querySelectorAll('svg > *');
      nodes.forEach((n, i) => n.style.setProperty('--i', i));
    } catch (_) {
      host.innerHTML = `<img src="${src}" alt="">`;
    }
  }

  function showCalendar() {
    const body = `<div class="cal">${Render.renderCalendar(Store.listTrips(), current.calY, current.calM)}</div>`;
    openModal('旅行日历', body);
  }
  function showTripsManager() {
    openModal('管理旅行', Render.renderTripsManager(Store.listTrips(), current.editTrips));
  }

  function accountModal() {
    const user = AuthUI.user;
    if (!user) {
      const temporary = AuthUI.temporary;
      const currentPerson = temporary && Store.getRoster().find(person => person.id === temporary.id);
      openModal(temporary ? '临时成员' : '只读分享', temporary
        ? `<p>当前身份：<b>${Render.esc(currentPerson && currentPerson.displayName || temporary.name)}</b></p><p class="access-hint">这名成员仅可访问当前旅行，编辑自己添加的内容。</p><button class="btn btn-ghost" data-action="account-logout">退出临时成员</button>`
        : '<p>正在查看公开分享的旅行。</p><button class="btn btn-ghost" data-action="account-logout">退出分享</button>');
      return;
    }
    const keys = (user.passkeys || []).map(key => `
      <div class="access-row"><span>${Render.esc(key.label)} · ${Render.esc(new Date(key.createdAt).toLocaleDateString())}</span>
      <button class="btn btn-ghost btn-sm" data-action="passkey-remove" data-id="${Render.esc(key.id)}">移除</button></div>`).join('');
    openModal('账号与通行密钥', `
      <p>用户名：<b>${Render.esc(user.username)}</b></p>
      <form data-form="account-profile">
        <label>昵称<input name="displayName" value="${Render.esc(user.displayName || user.username)}" maxlength="40" autocomplete="nickname" placeholder="输入昵称"></label>
        <p class="access-hint">昵称用于成员展示；未单独设置昵称的旅行会跟随更新。登录仍使用用户名，留空可恢复用户名。</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">保存昵称</button></div>
      </form>
      <p class="access-hint">通行密钥可通过 Apple 密码、Face ID、Touch ID、指纹或跨设备扫码使用，具体方式由设备决定。</p>
      ${keys || '<p class="access-hint">尚未添加通行密钥。</p>'}
      <div class="form-actions"><button class="btn btn-primary" data-action="passkey-add">添加通行密钥</button>
      <button class="btn btn-ghost" data-action="account-logout">退出登录</button></div>`);
  }

  function previewAccountAvatar(input) {
    const form = input.form;
    const preview = form.querySelector('[data-avatar-preview]');
    const status = form.querySelector('[data-avatar-status]');
    const submit = form.querySelector('[type="submit"]');
    form._avatarOriginal ??= preview.innerHTML;
    if (form._avatarPreviewUrl) URL.revokeObjectURL(form._avatarPreviewUrl);
    form._avatarPreviewUrl = '';
    preview.innerHTML = form._avatarOriginal;
    submit.disabled = true;
    status.textContent = '';

    const file = input.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      input.value = '';
      status.textContent = '头像照片不能超过 20 MB。';
      return;
    }

    const url = URL.createObjectURL(file);
    form._avatarPreviewUrl = url;
    const image = document.createElement('img');
    image.className = 'mine-avatar-photo';
    image.alt = '头像预览';
    image.addEventListener('load', () => {
      if (!form.isConnected || form._avatarPreviewUrl !== url) return;
      preview.replaceChildren(image);
      submit.disabled = false;
      status.textContent = file.name;
    }, { once: true });
    image.addEventListener('error', () => {
      if (!form.isConnected || form._avatarPreviewUrl !== url) return;
      URL.revokeObjectURL(url);
      form._avatarPreviewUrl = '';
      input.value = '';
      status.textContent = '无法预览这张照片，请选择 JPG、PNG 或 WebP 图片。';
    }, { once: true });
    image.src = url;
  }

  async function saveAccountAvatar(form, photo) {
    const input = form.elements.photo;
    const button = form.querySelector('[type="submit"]');
    if (form._saving || button.disabled || !photo?.size) return;
    const status = form.querySelector('[data-avatar-status]');
    form._saving = true;
    button.disabled = input.disabled = true;
    status.textContent = '正在保存头像…';
    try {
      await AuthUI.updateAvatar(photo);
    } catch (error) {
      status.textContent = error.message || '头像保存失败，请重试。';
      return;
    } finally {
      form._saving = false;
      button.disabled = input.disabled = false;
    }
    closeModal(true);
    render();
    toast('头像已保存', 'success');
  }

  async function openTripProfile() {
    await Store.load();
    const choices = Store.getAppearanceChoices();
    if (!choices.avatars.length || !choices.colors.length) throw new Error('头像和颜色选项加载失败，请重试');
    const person = Store.getRoster()[Store.getIdentity()];
    if (!person) throw new Error('当前身份已失效，请刷新');
    const account = AuthUI.user;
    const inheritedName = person.kind === 'formal' && account ? account.displayName || account.username : person.name;
    openModal('我的旅行资料', Render.tripProfileEditor(person, inheritedName));
  }

  function shareUrl(type, token) {
    const url = new URL(location.pathname, location.origin);
    url.hash = `${type}=${encodeURIComponent(token)}`;
    return url.href;
  }

  async function shareModal() {
    const tripId = Store.getActiveTripId();
    if (!Store.canManageTrip(tripId)) throw new Error('只有旅行所有者可以管理分享');
    const data = await AuthUI.request(`/api/trips/${encodeURIComponent(tripId)}/access`);
    sharePeople = data.people || [];
    const roles = new Map(data.members.map(member => [member.id, member.role]));
    const usernames = new Map(data.members.map(member => [member.id, member.username]));
    const members = (data.people || []).map(person => {
      const owner = person.userId === AuthUI.user.id;
      const label = owner ? '所有者' : person.kind === 'temporary' ? '临时成员 · 仅本旅行' : person.kind === 'unlinked' ? '待关联' : roles.get(person.userId) === 'viewer' ? '正式成员 · 只读' : '正式成员 · 可编辑';
      const displayName = person.displayName || person.name;
      const username = owner ? AuthUI.user.username : usernames.get(person.userId);
      const account = person.kind === 'formal' && username && displayName !== username ? ` · @${Render.esc(username)}` : '';
      return `<div class="access-row"><span>${Render.esc(displayName)}${account} · ${label}</span>${owner ? '' : `<span class="access-row-actions"><button class="btn btn-ghost btn-sm" data-action="share-member-replace" data-person-id="${Render.esc(person.id)}">替换</button>${person.kind === 'unlinked' ? '' : `<button class="btn btn-ghost btn-sm" data-action="share-member-remove" data-person-id="${Render.esc(person.id)}">移除</button>`}</span>`}</div>`;
    }).join('');
    const invites = data.invites.map(invite => `<div class="access-row"><span>${invite.role === 'editor' ? '可编辑' : '只读'}邀请 · ${new Date(invite.expiresAt).toLocaleDateString()} 到期</span><button class="btn btn-ghost btn-sm" data-action="share-invite-remove" data-id="${Render.esc(invite.id)}">撤销</button></div>`).join('');
    openModal('分享与权限', `
      <p class="access-hint">仅这趟旅行的所有者可以管理成员和链接。</p>
      ${shareNotice ? `<label>新链接<input id="shareNotice" readonly value="${Render.esc(shareNotice)}" onclick="this.select()"></label><button type="button" class="btn btn-ghost btn-sm" data-action="copy-share-link">复制链接</button>` : ''}
      <h3>旅行成员</h3>${members || '<p class="access-hint">尚无协作成员。</p>'}
      <form data-form="share-member" class="access-form">
        <input id="registeredMemberName" name="username" list="registeredMembers" autocomplete="off" placeholder="搜索用户名或昵称" required><datalist id="registeredMembers"></datalist>
        <select name="role"><option value="editor">可编辑</option><option value="viewer">只读</option></select>
        <button class="btn btn-primary" type="submit">添加正式成员</button>
      </form>
      <form data-form="share-temporary" class="access-form">
        <input name="name" maxlength="40" placeholder="临时成员名称" required>
        <button class="btn btn-ghost" type="submit">添加临时成员并生成链接</button>
      </form>
      <h3>邀请链接</h3>${invites || '<p class="access-hint">尚无邀请链接。</p>'}
      <div class="form-actions"><button class="btn btn-ghost" data-action="share-invite-editor">创建编辑邀请</button><button class="btn btn-ghost" data-action="share-invite-viewer">创建只读邀请</button></div>
      <h3>匿名只读链接</h3><p class="access-hint">${data.shareEnabled ? '链接已启用。重新生成会使旧链接失效。' : '链接未启用。任何持有链接的人都能查看这趟旅行。'}</p>
      <div class="form-actions"><button class="btn btn-primary" data-action="share-create">${data.shareEnabled ? '重新生成链接' : '创建只读链接'}</button>
      ${data.shareEnabled ? '<button class="btn btn-ghost" data-action="share-revoke">撤销链接</button>' : ''}</div>`);
  }
  function shiftMonth(delta) {
    const d = new Date(current.calY, current.calM + delta, 1);
    current.calY = d.getFullYear();
    current.calM = d.getMonth();
    showCalendar();
  }

  function showMemos() {
    if (current.view === 'app' && current.tab === 'journal') {
      closeModal();
      render();
      return;
    }
    openModal('备忘录', `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <button type="button" class="btn btn-primary btn-sm" data-action="memo-new">＋ 新建</button>
      </div>
      ${Render.renderMemos(Store.listMemos(), Store.listTrips())}`);
  }

  function openJournalEditor(memo = null) {
    const tripId = Store.getActiveTripId();
    if (!tripId || (memo && memo.tripId !== tripId)) return;
    current.journalMemo = memo || { tripId, createdAt: new Date().toISOString() };
    navigateTo('journal-editor');
  }

  function journalHasChanges(form) {
    const { text, tripId, file, keep } = form.elements;
    return text.value !== text.defaultValue || tripId.value !== current.journalMemo.tripId
      || !!file.files.length || !!(keep && keep.checked !== keep.defaultChecked);
  }

  // wttr.in 按 IP 推断城市，无需 key。失败就静默降级，不阻塞页面。
  const WEATHER_ICON = [
    [/^(113)$/, '☀️'], [/^(116)$/, '⛅'], [/^(119|122)$/, '☁️'],
    [/^(143|248|260)$/, '🌫️'],
    [/^(176|263|266|293|296|299|302|305|308|311|314|353|356|359)$/, '🌧️'],
    [/^(179|182|185|227|230|317|320|323|326|329|332|335|338|350|362|365|368|371|374|377)$/, '🌨️'],
    [/^(386|389|392|395)$/, '⛈️'],
  ];
  async function fetchWeather() {
    const el = () => document.getElementById('welcomeWeather');
    try {
      const res = await fetch('https://wttr.in/?format=j1', { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const cur = (j.current_condition || [])[0];
      if (!cur) throw new Error('no data');
      const code = String(cur.weatherCode || '');
      const icon = (WEATHER_ICON.find(([re]) => re.test(code)) || [null, '🌤️'])[1];
      const area = ((j.nearest_area || [])[0].areaName || [])[0];
      const city = area && area.value ? area.value : '';
      const node = el();
      if (node) {
        const emo = node.querySelector('.weather-emo');
        const txt = node.querySelector('.weather-txt');
        if (emo) emo.textContent = icon;
        if (txt) txt.textContent =
          `${cur.temp_C}°C${cur.weatherDesc && cur.weatherDesc[0] ? ' ' + cur.weatherDesc[0].value : ''}${city ? ' · ' + city : ''}`;
      }
    } catch (_) {
      const node = el();
      if (node) {
        const emo = node.querySelector('.weather-emo');
        const txt = node.querySelector('.weather-txt');
        if (emo) emo.textContent = '☁️';
        if (txt) txt.textContent = '天气暂不可用';
      }
    }
  }

  // Keep date membership and manual ordering consistent when an item changes day.
  function moveItemToDate(trip, source, item, date) {
    const targetDate = date || source.date;
    item.startDate = targetDate;
    if (targetDate === source.date) return source;
    let target = trip.itinerary.find(day => day.date === targetDate);
    if (!target) {
      target = { id: Store.uid('day'), date: targetDate, items: [], fromExpense: !!item.expenseId };
      trip.itinerary.push(target);
    }
    source.items = source.items.filter(entry => entry.id !== item.id);
    target.items.push(item);
    for (const day of [source, target]) {
      if (Array.isArray(day.order) && Store.canEditRecord(day)) {
        day.order = day.order.filter(id => id !== item.id);
        if (day === target) day.order.push(item.id);
      }
    }
    if (source.fromExpense && !source.items.length && Store.canEditRecord(source)) {
      trip.itinerary = trip.itinerary.filter(day => day.id !== source.id);
    }
    return target;
  }

  function saveItineraryItem(trip, dayId, itemId, fields) {
    const source = trip.itinerary.find(day => day.id === dayId);
    if (!source) throw new Error('这一天已被删除，请刷新后重试');
    let item = itemId && source.items.find(entry => entry.id === itemId);
    if (itemId && !item) throw new Error('这条安排已被移动或删除，请刷新后重试');
    if (!item) {
      item = { id: Store.uid('itm'), ...fields };
      source.items.push(item);
      if (Array.isArray(source.order) && Store.canEditRecord(source)) source.order.push(item.id);
    } else {
      if (Object.hasOwn(fields, 'location') && fields.location !== (item.location || '')) {
        item.lat = null;
        item.lng = null;
        delete item.locationMap;
      }
      Object.assign(item, fields);
    }
    const target = moveItemToDate(trip, source, item, fields.startDate);
    syncExpenseFromItem(trip, item, target.date);
    return target.id;
  }

  // 行程条目 → 记账：填了花费就自动建一条支出记录，用 itemId 双向关联。
  // 落库的字段与记账页手建的完全一致，之后改哪边都同步。
  function syncExpenseFromItem(trip, item, date) {
    if (!trip || !item) return;
    const cost = Number(item.amount) || 0;
    trip.expenses = trip.expenses || [];
    const ex = trip.expenses.find(x => x.itemId === item.id);
    const fields = {
      date: date || '',
      time: item.time || '',
      title: item.title || '',
      amount: cost,
      category: (Store.CONST.itemToExpenseCategory || {})[item.category] || '其他',
      subCategory: item.subCategory || '',
      refNo: item.refNo || '',
      payer: item.payer || '',
      participants: (item.participants || []).slice(),
      note: item.note || '',
      location: item.location || '',
      lat: item.locationMap?.mode === 'nearby' ? null : item.lat ?? null,
      lng: item.locationMap?.mode === 'nearby' ? null : item.lng ?? null,
    };
    // Keep a zero-cost ledger entry when its receipt or images still matter.
    if (!cost) {
      if (ex && (ex.receipt || (Array.isArray(ex.images) && ex.images.length))) Object.assign(ex, fields);
      else if (ex) trip.expenses = trip.expenses.filter(x => x.id !== ex.id);
      return;
    }
    if (!ex) {
      trip.expenses.push({ id: Store.uid('exp'), itemId: item.id, ...fields });
      return;
    }
    Object.assign(ex, fields);
  }

  // 记账 → 行程条目：反向同步分类、细分、车次、金额与付款人
  function syncItemFromExpense(trip, ex) {
    if (!ex || !ex.itemId) return;
    for (const day of (trip.itinerary || [])) {
      const it = (day.items || []).find(x => x.id === ex.itemId);
      if (!it) continue;
      it.category = (Store.CONST.expenseToItemCategory || {})[ex.category] || it.category;
      it.subCategory = ex.subCategory || '';
      it.refNo = ex.refNo || '';
      if (ex.title) it.title = ex.title;
      it.note = ex.note || '';
      const location = ex.location || '';
      if (location !== (it.location || '') || ex.lat != null && ex.lng != null) delete it.locationMap;
      it.location = location;
      if (it.locationMap?.mode !== 'nearby') {
        it.lat = ex.lat ?? null;
        it.lng = ex.lng ?? null;
      }
      it.amount = Number(ex.amount) || 0;
      if (ex.payer) it.payer = ex.payer;
      if (Array.isArray(ex.participants)) it.participants = ex.participants.slice();
      if (it.endTime) {
        // Shift wall-clock times together; the trip does not store a timezone.
        const stamp = (date, time) => Date.parse(`${date}T${time || '00:00'}:00Z`);
        const previousStart = stamp(it.startDate || day.date, it.time);
        const previousEnd = stamp(it.endDate || it.startDate || day.date, it.endTime);
        const nextStart = stamp(ex.date || day.date, ex.time);
        if ([previousStart, previousEnd, nextStart].every(Number.isFinite) && previousEnd >= previousStart) {
          const nextEnd = new Date(nextStart + previousEnd - previousStart).toISOString();
          it.endDate = nextEnd.slice(0, 10);
          it.endTime = nextEnd.slice(11, 16);
        }
      }
      it.time = ex.time || '';
      moveItemToDate(trip, day, it, ex.date);
      return;
    }
  }

  function removeExpenseRecord(trip, id) {
    const expense = (trip.expenses || []).find(entry => entry.id === id);
    if (!expense) return;
    trip.expenses = trip.expenses.filter(entry => entry.id !== id);
    if (!expense.itemId) return;
    for (const day of (trip.itinerary || [])) {
      const item = (day.items || []).find(entry => entry.id === expense.itemId);
      if (!item) continue;
      if (item.expenseId === id) {
        day.items = day.items.filter(entry => entry.id !== item.id);
        if (Array.isArray(day.order) && Store.canEditRecord(day)) day.order = day.order.filter(itemId => itemId !== item.id);
        if (day.fromExpense && day.items.length === 0 && Store.canEditRecord(day)) {
          trip.itinerary = trip.itinerary.filter(entry => entry.id !== day.id);
        }
      } else {
        item.amount = 0;
      }
      return;
    }
  }

  function deleteEntry(el, question, mutate) {
    const form = el.closest('form');
    if (form && form._entryTask) {
      imageEntryStatus(form, '先取消当前操作，再删除记录');
      return;
    }
    if (!confirm(question)) return;
    const inModal = modal().contains(el);
    const modalContent = inModal ? modalBody().firstElementChild : null;
    el.disabled = true;
    Store.mutate(mutate).then(() => {
      toast('已删除', 'success');
      if (inModal && modalBody().firstElementChild === modalContent) closeModal(true);
    }).catch(error => {
      if (el.isConnected) el.disabled = false;
      toast(error.message || '删除失败', 'error');
    });
  }

  // ---------------- 渲染 ----------------
  function clearFootprintsView() {
    if (typeof FootprintsMap !== 'undefined') FootprintsMap.destroy();
    clearTimeout(footprintsDayTimer);
    footprintsDayTimer = null;
    footprintsDayStamp = '';
  }

  function projectFootprintPoint(lat, lng) {
    if (isHkMacau(lng, lat)) return [lat, lng];
    const [mapLng, mapLat] = wgs84ToGcj02(lng, lat);
    return [mapLat, mapLng];
  }

  function mountFootprints(summary) {
    FootprintsMap.mount(summary, {
      projectPoint: projectFootprintPoint,
      onCitiesChange(cities) {
        if (current.view !== 'app' || current.tab !== 'footprints') return;
        const count = $('#footprintsCityCount');
        const list = $('#footprintsCityList');
        if (count) count.textContent = String(cities.filter(city => Number.isFinite(city.lat) && Number.isFinite(city.lng)).length);
        if (list) list.innerHTML = Render.renderFootprintCities(cities);
      },
    });
    footprintsDayStamp = Render.today();
    const nextDay = new Date();
    nextDay.setHours(24, 0, 1, 0);
    footprintsDayTimer = setTimeout(() => {
      if (current.view === 'app' && current.tab === 'footprints') render();
    }, Math.max(1000, nextDay.getTime() - Date.now()));
  }

  function canLocateFootprint(tripId, item) {
    if (!item) return false;
    const role = Store.getRole(tripId);
    return role === 'owner' || role === 'editor' || role === 'temporary' && item.authorId === AuthUI.temporary?.id;
  }

  function openFootprintLocation(key) {
    FootprintsMap.cancelPick();
    if (FootprintsMap.focus(key)) return;
    const trips = Store.listTrips();
    const place = Footprints.summarize(trips).places.find(entry => entry.key === key);
    if (!place || Footprints.coordinates(place)) return;
    const trip = trips.find(entry => entry.id === place.tripId);
    const item = trip?.itinerary.find(day => day.id === place.dayId)?.items.find(entry => entry.id === place.itemId);
    if (!canLocateFootprint(place.tripId, item)) {
      toast('需要这趟旅行的编辑权限才能补充地点坐标', 'info');
      return;
    }
    openModal('定位行程地点', `<form data-form="footprints-location">
      <label>搜索地点<input name="query" required minlength="2" maxlength="120" value="${Render.esc(place.name)}" placeholder="地点名称及所在城市" autocomplete="off"></label>
      <p class="field-hint">可加上城市或街道来缩小范围。选择正确的结果后，坐标会保存到这条行程。</p>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">搜索地点</button>
        <button class="btn btn-ghost" type="button" data-action="footprints-pick">在地图上选点</button>
      </div>
      <p class="field-hint" data-location-status role="status"></p>
      <div class="expense-location-suggestions" data-location-results></div>
    </form>`);
    const form = modalBody().querySelector('form[data-form="footprints-location"]');
    if (form) form._footprintPlace = place;
  }

  async function searchFootprintLocation(form, query) {
    const place = form._footprintPlace;
    if (!place || form._saving) return;
    form._locationSearchController?.abort();
    const controller = new AbortController();
    form._locationSearchController = controller;
    const status = form.querySelector('[data-location-status]');
    const box = form.querySelector('[data-location-results]');
    box.replaceChildren();
    form._locationCandidates = [];
    status.textContent = '正在查找…';
    try {
      const results = await Store.searchPlaces(query, { tripId: place.tripId, signal: controller.signal });
      if (!form.isConnected || controller.signal.aborted) return;
      const candidates = results.filter(result => Footprints.coordinates(result));
      form._locationCandidates = candidates;
      status.textContent = candidates.length ? '点选正确的地点，将它标到地图上。' : '未找到这个地点。试试全名，或加上城市和街道。';
      box.innerHTML = candidates.map((result, index) => `<button type="button" class="expense-location-result" data-action="footprints-place-result" data-index="${index}">
        <strong>${Render.esc(result.name || result.address)}</strong><span>${Render.esc(result.address)}</span>
      </button>`).join('');
      if (candidates.length) box.insertAdjacentHTML('beforeend', '<p class="field-hint">地点查询 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></p>');
    } catch (error) {
      if (form.isConnected && !controller.signal.aborted) status.textContent = error.message || '地点查询失败，请稍后再试。';
    } finally {
      if (form._locationSearchController === controller) form._locationSearchController = null;
    }
  }

  function pickFootprintLocation(form) {
    const place = form?._footprintPlace;
    if (!place || !closeModal()) return;
    const started = FootprintsMap.pickPoint(place.name, point => {
      let { lat, lng } = point;
      // Reverse the high-level map projection before saving canonical WGS84 coordinates.
      for (let i = 0; i < 3; i++) {
        const [projectedLat, projectedLng] = projectFootprintPoint(lat, lng);
        lat += point.lat - projectedLat;
        lng += point.lng - projectedLng;
      }
      openModal('保存地点标记', `<form data-form="footprints-location-confirm">
        <p>把「${Render.esc(place.name)}」标在刚选的位置。</p>
        <p class="field-hint" data-location-status role="status"></p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">保存标记</button>
          <button type="button" class="btn btn-ghost" data-action="footprints-pick">重新选点</button>
        </div>
      </form>`);
      const confirmation = modalBody().querySelector('form[data-form="footprints-location-confirm"]');
      if (confirmation) {
        confirmation._footprintPlace = place;
        confirmation._footprintPoint = { lat, lng };
      }
    });
    if (!started) toast('地图暂不可用，请稍后再试', 'info');
  }

  async function saveFootprintLocation(form, candidate) {
    const place = form?._footprintPlace;
    const point = Footprints.coordinates(candidate);
    if (!place || !point || form._saving) return;
    form._saving = true;
    try {
      await Store.mutate(trip => {
        const item = trip.itinerary.find(day => day.id === place.dayId)?.items.find(entry => entry.id === place.itemId);
        if (!canLocateFootprint(trip.id, item) || Footprints.itineraryPlaceName(item) !== place.name
          || Footprints.coordinates(item) && !Footprints.isCityFallback(item)) {
          throw new Error('这条行程已更新，请重新打开后再定位');
        }
        if (!item.location) item.location = place.name;
        Object.assign(item, point);
        delete item.locationMap;
        const expense = trip.expenses.find(entry => entry.itemId === item.id);
        if (expense && canLocateFootprint(trip.id, expense)) Object.assign(expense, { location: item.location, ...point });
      }, place.tripId);
      closeModal(true);
      FootprintsMap.focus(place.key);
      toast(place.planned ? '已保存位置，到行程当天会显示在足迹地图' : '已标记行程地点', 'success');
    } catch (error) {
      form.querySelector('[data-location-status]').textContent = error.message || '坐标保存失败';
    } finally {
      form._saving = false;
    }
  }

  function render() {
    const data = Store.getState();
    if (!data) return;
    const packingPool = $('#packingPool');
    if (packingPool) current.packingPoolOpen = packingPool.open;
    clearFootprintsView();
    document.body.dataset.accessRole = Store.getRole() || 'viewer';
    document.body.dataset.currentTab = current.tab;
    const avatar = Render.accountAvatarUrl(AuthUI.user);
    document.body.style.setProperty('--account-avatar-image', avatar ? `url("${avatar}")` : 'none');
    applyTheme(Store.getWelcomeTheme());
    // 背景插画跟着当前旅行的目的地走；getState 返回的就是当前这趟
    const doodleImg = document.querySelector('#doodleBg img');
    if (doodleImg) {
      const want = `vendor/${Render.doodleFor(data)}`;
      if (doodleImg.getAttribute('src') !== want) doodleImg.setAttribute('src', want);
    }
    $('#nav').innerHTML = Render.renderNav(current.tab);
    if (!$('#tabItems').children.length) $('#tabItems').innerHTML = Render.renderTabbar(current.tab);
    else $('#tabItems').querySelectorAll('.tab-item').forEach((b) => {
      b.classList.toggle('active', Render.isPrimaryTabActive(b.dataset.tab, current.tab));
    });
    if (dockKick) dockKick();
    $('#pageTitle').textContent = current.tab === 'journal-editor' && current.journalMemo?.id
      ? '编辑旅行日志' : Render.tabTitle(current.tab);
    $('#board').innerHTML = Render.renderTripBoard();
    const tripNameEl = $('#topbarTripName');
    if (tripNameEl) tripNameEl.textContent = data.meta.tripName || '九州 ITHACA';
    // 开启页下主内容区不渲染，但侧栏、看板、导航要保持最新
    if (current.view === 'welcome') { applyPermissions(); return; }

    // 共享旅行同步时保留正在编辑的正文、光标和所选照片。
    if (current.tab === 'journal-editor' && AuthUI.user && $('#journalEditor')) {
      applyPermissions();
      return;
    }

    const guidePlan = guidePlans.get(data.id);
    const guideStage = canPlanGuide(data.id) ? (guidePlan?.rows ? 'draft' : 'input') : 'readonly';
    const guidePage = $('#guidePlannerPage');
    if (guidePage) {
      const samePage = current.tab === 'guide-plan' && guidePage.dataset.tripId === data.id;
      if (samePage && guidePage.dataset.stage === guideStage) {
        applyPermissions();
        return;
      }
      if (!samePage && canPlanGuide(guidePage.dataset.tripId)) rememberGuidePage(guidePage);
      guidePage.querySelector('form')?._guideLookup?.abort();
    }

    // 地图页特殊处理：不整块重绘，避免 Leaflet 容器被销毁（瓦片错乱的根因）
    if (current.tab === 'map') {
      if (map && $('#map')) { refreshMap(data); applyPermissions(); return; }
      $('#content').innerHTML = Render.renderPage(data, current.tab, { tileSource: currentTileSource });
      // 必须用 refreshMap 而非 initMap：切走再切回时旧 map 实例仍绑定着已脱离
      // DOM 的容器，initMap 只判断实例存在与否，会往旧容器上画，导致新节点空白
      setTimeout(() => refreshMap(data), 0);
      applyPermissions();
      return;
    }

    const focusedSearch = document.activeElement && (document.activeElement.id === 'placeSearch' || document.activeElement.id === 'guideSearch')
      ? document.activeElement.id : null;
    const footprintsSummary = current.tab === 'footprints' ? Footprints.summarize(Store.listTrips()) : null;
    const dateRailScroll = $('#itineraryDates')?.scrollLeft || 0;
    $('#content').innerHTML = Render.renderPage(data, current.tab, {
      archiveTripId: current.archiveTripId,
      footprintsSummary,
      journalMemo: current.journalMemo,
      photoDay: activePhotoDay(data),
      packingPoolOpen: current.packingPoolOpen,
      itineraryDate: current.itinerarySelection?.tripId === data.id ? current.itinerarySelection.date : null,
      ledgerFilter: current.ledgerFilter,
      settlementDetailsOpen: current.settlementDetailsOpen && current.settlementDetailsTripId === data.id,
      placeFilter: current.placeFilter,
      guideFilter: current.guideFilter,
      guidePlan, guideStage,
      showArchived: current.showArchived,
      editMeta: current.editMeta,
    });
    const guideAiOption = $('#guidePlannerPage [data-guide-ai-option]');
    if (guideAiOption) {
      Store.guideAiAvailable().then(available => {
        if (!available || !guideAiOption.isConnected) return;
        guideAiOption.querySelector('input').disabled = false;
        guideAiOption.hidden = false;
      }).catch(() => {});
    }
    const dateRail = $('#itineraryDates');
    const activeDate = dateRail?.querySelector('.is-active');
    if (activeDate) {
      dateRail.scrollLeft = dateRailScroll;
      if (activeDate.offsetLeft < dateRail.scrollLeft) dateRail.scrollLeft = activeDate.offsetLeft;
      else if (activeDate.offsetLeft + activeDate.offsetWidth > dateRail.scrollLeft + dateRail.clientWidth) {
        dateRail.scrollLeft = activeDate.offsetLeft + activeDate.offsetWidth - dateRail.clientWidth;
      }
    }
    // 搜索框重绘后恢复焦点，保证连续输入
    if (focusedSearch && current.tab === 'places') {
      const el = document.getElementById(focusedSearch);
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
    applyPermissions();
    if (footprintsSummary) mountFootprints(footprintsSummary);
  }

  function activePhotoDay(trip) {
    return current.photoAlbum?.tripId === trip.id ? current.photoAlbum.key : null;
  }

  function navigateTo(tab, { photoAlbum = null, archiveTripId = '' } = {}) {
    if (current.tab === 'journal-editor' && tab !== 'journal-editor') {
      const editor = $('#journalEditor');
      if (editor?._saving) return;
      if (editor && current.journalMemo && journalHasChanges(editor)
        && !confirm('旅行日志尚未保存。要放弃修改并返回吗？')) return;
      current.journalMemo = null;
    }
    const switchingItinerary = current.view === 'app' && (
      current.tab === 'overview' && tab === 'itinerary' || current.tab === 'itinerary' && tab === 'overview');
    const oldSlider = switchingItinerary && $('.itinerary-subnav-slider');
    const sliderStart = oldSlider && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? getComputedStyle(oldSlider).transform : null;
    current.tab = tab;
    current.photoAlbum = photoAlbum;
    current.archiveTripId = archiveTripId;
    // 首页、底栏和二级入口统一切页，详情不继承上一个页面的滚动位置。
    if (current.view === 'welcome') setView('app'); else render();
    if (sliderStart) {
      const slider = $('.itinerary-subnav-slider');
      if (slider?.animate) slider.animate(
        [{ transform: sliderStart }, { transform: getComputedStyle(slider).transform }],
        { duration: 240, easing: 'cubic-bezier(.22, .75, .28, 1)' });
    }
    $('#content').scrollTop = 0;
    window.scrollTo(0, 0);
    $('#pageTitle').setAttribute('tabindex', '-1');
    $('#pageTitle').focus({ preventScroll: true });
  }

  // ---------------- 弹窗 ----------------
  function openModal(title, formHTML) {
    if (!modal().hidden && !closeModal()) return;
    modalTaskProgress().hidden = true;
    modalTitle().textContent = title;
    modalBody().innerHTML = formHTML;
    modalBody().scrollTop = 0;
    modal().hidden = false;
    configureImageEntry(modalBody().querySelector('form'));
    applyPermissions(modal());
    modalTitle().setAttribute('tabindex', '-1');
    modalTitle().focus({ preventScroll: true });
  }

  function closeModal(force = false) {
    const form = modalBody().querySelector('form');
    if (!force && form && form._saving) {
      toast('正在保存，请稍等', 'info');
      return false;
    }
    if (!force && form && form._entryTask) {
      imageEntryStatus(form, form._entryTask.kind === 'commit' ? '正在保存，请稍等' : '先取消当前操作，再关闭页面');
      return false;
    }
    if (!force && form && form._entryFiles && (form._entryFiles.length || form._entryTouched.size)
      && !confirm('填写的内容尚未保存，确定放弃并退出吗？')) return false;
    releaseEntryFiles(form);
    modal().hidden = true;
    modalBody().innerHTML = '';
    modalTaskProgress().hidden = true;
    return true;
  }

  function releaseEntryFiles(form) {
    for (const entry of (form && form._entryFiles) || []) URL.revokeObjectURL(entry.preview);
    if (form?._avatarPreviewUrl) URL.revokeObjectURL(form._avatarPreviewUrl);
    if (form && form._locationMap) form._locationMap.remove();
    if (form && form._locationSearchController) form._locationSearchController.abort();
    form?._guideLookup?.abort();
  }

  function configureImageEntry(form) {
    if (!form || form.dataset.form !== 'expense') return;
    form._entryFiles = [];
    form._entryTouched = new Set();
    form._entryEditing = !!form.querySelector('[name="expenseId"]');
    form.addEventListener('invalid', event => {
      const label = event.target.closest('label');
      imageEntryStatus(form, `请先填写${label ? label.firstChild.textContent.trim() : '必填信息'}，再保存`);
    }, true);
    form._aiAvailability = Store.imageRecognitionAvailable().catch(() => false).then(available => {
      if (!form.isConnected) return false;
      if (!available) {
        form.querySelector('.image-entry-title').textContent = '添加图片';
        form.querySelector('.image-entry-subtitle').textContent = '保存订单或支出的截图';
        form.querySelector('.image-entry-hint').textContent = '保存后保留原图和预览图。';
      }
      return available;
    });
  }

  function imageEntryStatus(form, message) {
    const status = form.querySelector('.image-entry-status');
    if (status) status.textContent = message;
  }

  function imageEntryProgress(form, stage, percent = null, cancellable = true) {
    if (!modalBody().contains(form)) return;
    const box = modalTaskProgress();
    box.hidden = false;
    box.querySelector('.image-entry-stage').textContent = stage;
    box.querySelector('.image-entry-percent').textContent = percent == null ? '' : `${Math.round(percent)}%`;
    const meter = box.querySelector('.image-entry-meter');
    meter.classList.toggle('is-waiting', percent == null);
    if (percent == null) meter.removeAttribute('aria-valuenow');
    else {
      const value = Math.max(0, Math.min(100, percent));
      meter.setAttribute('aria-valuenow', String(Math.round(value)));
      meter.querySelector('span').style.width = `${value}%`;
    }
    const cancel = box.querySelector('.image-entry-cancel');
    cancel.hidden = !cancellable;
    if (cancellable) cancel.textContent = form._entryTask && form._entryTask.kind === 'recognition' ? '取消识别' : '取消上传';
  }

  function clearImageTask(form) {
    form._entryTask = null;
    if (modalBody().contains(form)) {
      const box = modalTaskProgress();
      box.hidden = true;
      box.querySelector('.image-entry-cancel').disabled = false;
    }
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = false;
    const picker = form.querySelector('[name="imageFiles"]');
    if (picker) picker.disabled = false;
  }

  function appendSelectedImage(form, file) {
    const preview = URL.createObjectURL(file);
    const entry = { file, preview, url: '' };
    form._entryFiles.push(entry);
    const wrap = document.createElement('span');
    wrap.className = 'entry-image';
    wrap.dataset.pendingIndex = String(form._entryFiles.length - 1);
    const image = document.createElement('img');
    image.src = preview;
    image.alt = '待保存的图片预览';
    image.className = 'entry-image-open';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'entry-image-remove';
    remove.dataset.action = 'entry-image-remove';
    remove.setAttribute('aria-label', '移除图片');
    remove.textContent = '×';
    wrap.append(image, remove);
    form.querySelector('.entry-images').append(wrap);
    return entry;
  }

  function applyImageDraft(form, fields) {
    for (const [name, value] of Object.entries(fields)) {
      if (form.dataset.form === 'expense' && (name === 'date' || name === 'time')) continue;
      const input = form.elements.namedItem(name);
      if (!input || form._entryTouched.has(name) || (form._entryEditing && input.value)) continue;
      if (input.tagName === 'SELECT' && ![...input.options].some(option => option.value === String(value))) continue;
      input.value = String(value);
      if (name === 'category' && form.dataset.form === 'expense') {
        const box = form.querySelector('#expFields');
        if (box) box.innerHTML = Render.expFields(input.value, {});
      }
    }
  }

  function entryRecognitionKind(form) {
    return form.dataset.form === 'expense' && form.elements.namedItem('receiptEnabled')?.checked
      ? 'booking' : form.dataset.form;
  }

  function bookingDraftToExpenseDraft(fields) {
    const draft = {};
    for (const name of ['title', 'note']) {
      if (typeof fields[name] === 'string') draft[name] = fields[name];
    }
    const bookingFields = {
      type: 'receiptType', status: 'receiptStatus', date: 'receiptDate', time: 'receiptTime',
      from: 'receiptFrom', to: 'receiptTo', endDate: 'receiptEndDate', endTime: 'receiptEndTime',
      carrier: 'receiptCarrier', seat: 'receiptSeat', refNo: 'receiptRefNo', price: 'receiptPrice',
    };
    for (const [from, to] of Object.entries(bookingFields)) {
      if (typeof fields[from] === 'string' || (from === 'price' && Number.isFinite(fields[from]))) {
        draft[to] = fields[from];
      }
    }
    const category = { flight: '交通', train: '交通', bus: '交通', hotel: '住宿', other: '其他' }[fields.type];
    if (category) draft.category = category;
    return draft;
  }

  function retainedReceiptImages(previousReceipt, images) {
    const saved = new Set(images);
    return (Array.isArray(previousReceipt?.images) ? previousReceipt.images : [])
      .filter(url => saved.has(url));
  }

  async function onEntryImagesSelected(input) {
    const form = input.closest('form');
    if (!form || !form._entryFiles) return;
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const entries = files.map(file => appendSelectedImage(form, file));
    if (form.dataset.form === 'expense') suggestPhotoGps(form, files);
    const available = await form._aiAvailability;
    if (!form.isConnected || !available || !entries.length) {
      if (form.isConnected) imageEntryStatus(form, `已添加 ${files.length} 张图片`);
      return;
    }
    await runImageRecognition(form, entries[0]);
  }

  async function suggestPhotoGps(form, files) {
    if (!window.exifr || !window.exifr.gps) return;
    for (const file of files) {
      try {
        const gps = await window.exifr.gps(file);
        if (!form.isConnected) return;
        if (!gps) continue;
        const { latitude: lat, longitude: lng } = gps;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
        form._photoGps = { lat, lng };
        const suggestions = form.querySelector('.expense-photo-suggestion');
        suggestions.hidden = false;
        suggestions.innerHTML = `<div class="expense-location-suggestion"><span>照片含拍摄位置，可作为地点参考。</span><button type="button" class="btn btn-ghost btn-sm" data-action="expense-location-photo">使用照片位置</button></div>`;
        return;
      } catch (_) { /* Files without GPS metadata are expected. */ }
    }
  }

  function expenseLocationStatus(form, message) {
    const status = form.querySelector('.expense-location-status');
    if (status) status.textContent = message;
  }

  async function searchExpenseLocation(form, query, { automatic = false, label = '' } = {}) {
    if (!form.isConnected) return;
    if (form._locationSearchController) form._locationSearchController.abort();
    const controller = new AbortController();
    form._locationSearchController = controller;
    expenseLocationStatus(form, automatic ? '正在确认订单地点…' : '正在查找地点…');
    try {
      const results = await Store.searchPlaces(query, { signal: controller.signal });
      if (!form.isConnected || form._locationSearchController !== controller) return;
      if (automatic && (form._entryTouched.has('location') || form.elements.namedItem('location').value)) return;
      const broad = new Set(['country', 'state', 'province', 'city', 'county', 'district', 'suburb', 'village']);
      if (automatic && results.length === 1 && !broad.has(results[0].type)
        && !form._entryTouched.has('location') && !form.elements.namedItem('location').value) {
        setExpenseLocation(form, { location: label || results[0].name || results[0].address, lat: results[0].lat, lng: results[0].lng }, '已从订单确认地点并标记；请核对。');
        return;
      }
      if (!results.length) {
        expenseLocationStatus(form, automatic ? '订单里的地点未能准确找到，暂不填写。' : '没有找到地点；可以手动填写或在地图上选点。');
        return;
      }
      form._locationCandidates = results;
      const box = form.querySelector('.expense-location-suggestions');
      box.hidden = false;
      box.innerHTML = `<p class="field-hint">${automatic ? '找到几个可能的地点，请选择：' : '选择一个地点：'}</p>${results.map((place, index) => `
        <button type="button" class="expense-location-result" data-action="expense-location-choose" data-index="${index}">
          <strong>${Render.esc(place.name || place.address)}</strong><span>${Render.esc(place.address)}</span>
        </button>`).join('')}`;
      form.querySelector('.expense-location-attribution').hidden = false;
      expenseLocationStatus(form, automatic ? '地点存在歧义，请核对后选择。' : '找到地点，请核对后选择。');
    } catch (error) {
      if (error.name !== 'AbortError' && form.isConnected) expenseLocationStatus(form, automatic ? '订单地点暂时查不到，可手动填写。' : error.message || '地点查询失败');
    } finally {
      if (form._locationSearchController === controller) form._locationSearchController = null;
    }
  }

  async function suggestRecognizedLocation(form, fields) {
    if (form._entryTouched.has('location') || form.elements.namedItem('location').value) return;
    const placeName = String(fields.placeName || '').trim();
    const address = String(fields.address || '').trim();
    const specificBranch = /(?:店|分店|门店|支店|branch|station|terminal|酒店|餐厅|饭店)/i.test(placeName);
    if (address.length < 6 && !specificBranch) return;
    const query = [address, placeName].filter(Boolean).join(' ');
    await searchExpenseLocation(form, query, { automatic: true, label: placeName || address });
  }

  function setExpenseLocation(form, place, message) {
    const location = form.elements.namedItem('location');
    location.value = place.location || '';
    form.elements.namedItem('lat').value = Number.isFinite(place.lat) ? String(place.lat) : '';
    form.elements.namedItem('lng').value = Number.isFinite(place.lng) ? String(place.lng) : '';
    form._entryTouched.add('location');
    const suggestions = form.querySelector('.expense-location-suggestions');
    if (suggestions) suggestions.hidden = true;
    const photoSuggestion = form.querySelector('.expense-photo-suggestion');
    if (photoSuggestion) photoSuggestion.hidden = true;
    expenseLocationStatus(form, message);
    if (form._locationMap && Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
      const point = [place.lat, place.lng];
      if (form._locationPin) form._locationPin.setLatLng(point);
      else form._locationPin = L.marker(point).addTo(form._locationMap);
      form._locationMap.setView(point, 16);
    }
  }

  function showExpenseLocationMap(form) {
    const box = form.querySelector('.expense-location-map');
    box.hidden = false;
    form.querySelector('.expense-location-attribution').hidden = false;
    if (form._locationMap) { form._locationMap.invalidateSize(); return; }
    const lat = Number(form.elements.namedItem('lat').value);
    const lng = Number(form.elements.namedItem('lng').value);
    const hasPoint = form.elements.namedItem('lat').value !== '' && form.elements.namedItem('lng').value !== '';
    const tripPoint = (Store.getState().itinerary || []).flatMap(day => day.items || [])
      .find(item => Number.isFinite(item.lat) && Number.isFinite(item.lng));
    const initial = hasPoint ? [lat, lng] : tripPoint ? [tripPoint.lat, tripPoint.lng] : [20, 0];
    const map = L.map(box, { zoomControl: true }).setView(initial, hasPoint || tripPoint ? 13 : 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    form._locationMap = map;
    if (hasPoint) form._locationPin = L.marker(initial).addTo(map);
    map.on('click', event => {
      setExpenseLocation(form, { location: '', lat: event.latlng.lat, lng: event.latlng.lng }, '已标记地图位置；可填写地点名称。');
    });
    requestAnimationFrame(() => map.invalidateSize());
  }

  async function runImageRecognition(form, entry) {
    if (form._entryTask || !entry || !form._entryFiles.includes(entry)) return;
    const task = { kind: 'recognition', controller: new AbortController() };
    form._entryTask = task;
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    const picker = form.querySelector('[name="imageFiles"]');
    if (picker) picker.disabled = true;
    form.querySelector('.image-entry-retry').hidden = true;
    imageEntryStatus(form, '正在看图片，完成后请核对内容');
    imageEntryProgress(form, '正在准备图片');
    try {
      const recognitionKind = entryRecognitionKind(form);
      const result = await Store.recognizeImage(entry.file, recognitionKind, {
        signal: task.controller.signal,
        onPhase: phase => {
          if (!form.isConnected || form._entryTask !== task) return;
          imageEntryProgress(form, phase === 'preparing' ? '正在准备图片' : phase === 'uploading' ? '正在上传识别图片' : '正在提取信息');
        },
        onProgress: (loaded, total) => {
          if (form.isConnected && form._entryTask === task) imageEntryProgress(form, '正在上传识别图片', loaded / total * 100);
        },
      });
      if (form.isConnected && form._entryTask === task && form._entryFiles.includes(entry)) {
        const draft = form.dataset.form === 'expense' && recognitionKind === 'booking'
          ? bookingDraftToExpenseDraft(result) : result;
        applyImageDraft(form, draft);
        imageEntryStatus(form, '看好了，核对一下填写的内容');
        if (form.dataset.form === 'expense' && recognitionKind === 'expense') void suggestRecognizedLocation(form, result);
      }
    } catch (error) {
      if (form.isConnected && form._entryTask === task) {
        imageEntryStatus(form, error.name === 'AbortError' ? '已取消识别，图片和填写内容仍在' : `${error.message || '没看清图片'}；可以重试或手动填写`);
        form.querySelector('.image-entry-retry').hidden = false;
      }
    } finally {
      if (form.isConnected && form._entryTask === task) clearImageTask(form);
    }
  }

  async function entryImageUrls(form, task) {
    const saved = [...form.querySelectorAll('.entry-image[data-existing-url]')].map(el => el.dataset.existingUrl);
    const entries = form._entryFiles || [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry.url) {
        imageEntryProgress(form, `正在上传第 ${index + 1}/${entries.length} 张图片`, 0);
        entry.url = (await Store.uploadImage(entry.file, undefined, {
          signal: task.controller.signal,
          onProgress: (loaded, total) => imageEntryProgress(form, `正在上传第 ${index + 1}/${entries.length} 张图片`, loaded / total * 100),
          onPhase: () => imageEntryProgress(form, '正在生成图片预览'),
        })).url;
      }
      saved.push(entry.url);
    }
    return [...new Set(saved)];
  }

  function startImageSave(form) {
    if (form._entryTask) return null;
    const hasFiles = !!(form._entryFiles || []).some(entry => !entry.url);
    const task = { kind: hasFiles ? 'upload' : 'commit', controller: new AbortController() };
    form._entryTask = task;
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    const picker = form.querySelector('[name="imageFiles"]');
    if (picker) picker.disabled = true;
    imageEntryStatus(form, '正在保存，完成后会自动返回');
    imageEntryProgress(form, hasFiles ? '准备上传图片' : '正在保存记录', null, hasFiles);
    return task;
  }

  function commitImageSave(form, task) {
    task.kind = 'commit';
    imageEntryProgress(form, '正在保存记录', null, false);
  }

  // ---------------- 数据操作 ----------------
  function members() { return Store.getState().meta.members || []; }

  function readItemDraft(form, original = {}) {
    const fd = new FormData(form);
    const draft = { ...original, ...form._itemDraft };
    for (const field of ['title', 'location', 'refNo', 'note', 'payer']) {
      if (fd.has(field)) draft[field] = String(fd.get(field) || '');
    }
    if (fd.has('amount')) draft.amount = Number(fd.get('amount')) || 0;
    if (fd.has('participants')) draft.participants = parseList(fd.get('participants'));
    if (fd.has('time')) [draft.startDate, draft.time] = splitDT(fd.get('time'));
    if (fd.has('endTime')) [draft.endDate, draft.endTime] = splitDT(fd.get('endTime'));
    return draft;
  }

  function itemLocation(fd, existing, draft = {}) {
    if (fd.has('location')) return String(fd.get('location') || '').trim();
    const title = String(fd.get('title') || '');
    const location = draft.location ?? existing?.location ?? title;
    const pinned = existing && existing.lat != null && existing.lng != null;
    if (existing && !pinned && location === existing.title) return title;
    return location;
  }

  function confirmItineraryLocation({ title, text, hint, address, accept, cancel }) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'nearby-location-dialog';
      dialog.setAttribute('aria-labelledby', 'itineraryLocationTitle');
      dialog.innerHTML = `<form method="dialog">
        <h2 id="itineraryLocationTitle">${Render.esc(title)}</h2>
        <p>${Render.esc(text)}</p>
        ${address ? `<p class="field-hint">${Render.esc(address)}</p>` : ''}
        <p class="field-hint">${Render.esc(hint)}</p>
        <div class="form-actions">
          <button class="btn btn-ghost" value="no" autofocus>${Render.esc(cancel)}</button>
          <button class="btn btn-primary" value="yes">${Render.esc(accept)}</button>
        </div>
      </form>`;
      dialog.addEventListener('close', () => {
        const accepted = dialog.returnValue === 'yes';
        dialog.remove();
        resolve(accepted);
      }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  // One deadline covers the original query and all name variants.
  const ITINERARY_LOCATION_WAIT_MS = 1500;

  async function locateItineraryOnSave(trip, dayId, fields, existing) {
    const name = Footprints.itineraryPlaceName(fields);
    if (!name) return { fields: {} };
    const legacy = Footprints.isCityFallback(existing);
    if (existing && !legacy && name === Footprints.itineraryPlaceName(existing)
      && (Footprints.coordinates(existing) || ['hidden', 'pending'].includes(existing.locationMap?.mode))) return { fields: {} };

    const index = Footprints.itineraryLocationIndex(trip);
    const stored = Footprints.matchStoredLocation(name, index);
    if (stored) return { fields: { ...Footprints.coordinates(stored),
      locationMap: stored.source === 'osm' ? { source: 'osm' } : null } };

    const areas = Footprints.itinerarySearchAreas(trip, dayId, name);
    const reference = Footprints.itineraryReferencePoint(trip, dayId, name, index);
    const results = [];
    const signal = AbortSignal.timeout(ITINERARY_LOCATION_WAIT_MS);
    const options = { tripId: trip.id, near: areas.length === 1 ? Footprints.coordinates(areas[0]) : undefined, signal };
    let nearby;
    for (const query of Footprints.itinerarySearchQueries(name, areas)) {
      try {
        const matches = await Store.searchPlaces(query, options);
        if (signal.aborted) break;
        results.push(...matches);
      } catch (_) { break; }
      const match = Footprints.selectItineraryMatch(name, results, areas, reference);
      if (match.exact) return { fields: { ...Footprints.coordinates(match.exact), locationMap: { source: 'osm' } } };
      nearby = match.nearby;
      if (nearby) break;
    }
    if (!nearby) {
      const accepted = await confirmItineraryLocation({
        title: '先保存地点名称？',
        text: signal.aborted ? `「${name}」还没查到位置。现在可以先保存行程。` : `暂时找不到「${name}」的位置。`,
        hint: '保存后，可在「我的足迹」的行程地点列表点这条记录，搜索或在地图上选点。',
        accept: '暂存名称',
        cancel: '继续编辑',
      });
      if (!accepted) return null;
      return {
        fields: { lat: null, lng: null, locationMap: { mode: 'pending' } },
        message: '已保存行程，可稍后在我的足迹定位',
      };
    }
    const accepted = await confirmItineraryLocation({
      title: '用附近地点标记？',
      text: `没能确认「${name}」的准确位置。要在足迹地图上用「${nearby.name}」作为参考位置吗？`,
      address: nearby.address,
      hint: '选「否」会保留行程地点名称，地图上不显示标记。',
      accept: '是',
      cancel: '否',
    });
    if (!accepted) return { fields: { lat: null, lng: null, locationMap: { mode: 'hidden' } } };
    return { fields: {
      ...Footprints.coordinates(nearby),
      locationMap: { mode: 'nearby', name: nearby.name, source: nearby.source || (results.includes(nearby) ? 'osm' : '') },
    } };
  }

  async function doMutate(fn, successMsg, tripId) {
    try {
      await Store.mutate(fn, tripId);
      if (successMsg) toast(successMsg, 'success');
      return true;
    } catch (e) {
      toast(e.message || '操作失败', 'error');
      return false;
    }
  }

  // 途径地点标签重绘：走 DOM 构造，地点名是用户输入，不能拼进 innerHTML
  function renderStopTags(form, list) {
    const wrap = form.querySelector('.stops-tags');
    if (!wrap) return;
    wrap.textContent = '';
    if (!list.length) {
      const empty = document.createElement('span');
      empty.className = 'stops-empty';
      empty.textContent = '留空会自动取自行程';
      wrap.appendChild(empty);
      return;
    }
    list.forEach((name, i) => {
      const tag = document.createElement('span');
      tag.className = 'stop-tag';
      tag.textContent = name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'stop-tag-x';
      x.dataset.action = 'stop-del';
      x.dataset.idx = String(i);
      x.setAttribute('aria-label', '移除');
      x.textContent = '✕';
      tag.appendChild(x);
      wrap.appendChild(tag);
    });
  }

  // 模板是文档级的，改它要走 mutateDoc 而不是 mutate（后者只给旅行对象）
  async function doMutateDoc(fn) {
    try {
      await Store.mutateDoc(fn);
    } catch (e) {
      toast(e.message || '操作失败', 'error');
    }
  }

  // 旅行的新建/删除/归档要动 trips 数组，Store 侧已自行提交，
  // 这里只做错误提示，不能再套 doMutate（会重复 PUT）。
  async function doDocOp(fn, successMsg) {
    try {
      await fn();
      if (successMsg) toast(successMsg, 'success');
    } catch (e) {
      toast(e.message || '操作失败', 'error');
    }
  }

  // ---------------- 点击委托 ----------------
  function onClick(e) {
    if (e.target === modal()) { closeModal(); return; }
    const el = e.target.closest('[data-action]');
    const menu = $('.action-menu[open]');
    if (menu && (el || !menu.contains(e.target))) menu.open = false;
    if (!el) return;
    const action = el.dataset.action;
    if (!actionAllowed(action, el)) { e.preventDefault(); toast('没有修改这条内容的权限', 'error'); return; }

    switch (action) {
      case 'settle-confirm':
        el.disabled = true;
        AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/transfers`, 'PATCH', {
          key: el.dataset.key, confirmed: el.dataset.confirmed !== '1',
        }).then(() => Store.load()).catch(error => { el.disabled = false; toast(error.message, 'error'); });
        break;
      case 'settlement-details-toggle': {
        const tripId = Store.getActiveTripId();
        const open = !(current.settlementDetailsOpen && current.settlementDetailsTripId === tripId);
        current.settlementDetailsOpen = open;
        current.settlementDetailsTripId = tripId;
        const panel = el.closest('.settle-personal')?.querySelector('#settlementDetails');
        if (panel) panel.hidden = !open;
        el.setAttribute('aria-expanded', String(open));
        el.textContent = open ? '收起分摊明细' : '查看分摊明细';
        break;
      }
      case 'account-open': accountModal(); break;
      case 'account-avatar-open': {
        const person = Store.getRoster()[Store.getIdentity()];
        openModal('更换头像', Render.accountAvatarPicker(AuthUI.user, person?.avatar));
        break;
      }
      case 'account-logout':
        AuthUI.logout().catch(error => toast(error.message, 'error'));
        break;
      case 'passkey-add':
        AuthUI.registerPasskey().then(() => { toast('通行密钥已添加', 'success'); accountModal(); })
          .catch(error => toast(error.message, 'error'));
        break;
      case 'passkey-remove':
        AuthUI.removePasskey(el.dataset.id).then(accountModal).catch(error => toast(error.message, 'error'));
        break;
      case 'share-open':
        shareNotice = '';
        shareModal().catch(error => toast(error.message, 'error'));
        break;
      case 'copy-share-link': {
        const field = document.getElementById('shareNotice');
        if (field) navigator.clipboard.writeText(field.value).then(() => toast('链接已复制', 'success')).catch(() => { field.select(); toast('请复制已选中的链接'); });
        break;
      }
      case 'share-create':
        AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/share`, 'POST', {})
          .then(result => { shareNotice = shareUrl('share', result.token); return shareModal(); })
          .catch(error => toast(error.message, 'error'));
        break;
      case 'share-revoke':
        AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/share`, 'DELETE', {})
          .then(() => { shareNotice = ''; return shareModal(); })
          .catch(error => toast(error.message, 'error'));
        break;
      case 'share-invite-editor':
      case 'share-invite-viewer':
        AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/invites`, 'POST', {
          role: action === 'share-invite-editor' ? 'editor' : 'viewer',
        }).then(result => { shareNotice = shareUrl('invite', result.token); return shareModal(); })
          .catch(error => toast(error.message, 'error'));
        break;
      case 'share-invite-remove':
        AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/invites`, 'DELETE', { id: el.dataset.id })
          .then(() => { shareNotice = ''; return shareModal(); })
          .catch(error => toast(error.message, 'error'));
        break;
      case 'share-member-remove':
        AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/members`, 'DELETE', { personId: el.dataset.personId })
          .then(() => Store.load()).then(() => shareModal()).catch(error => toast(error.message, 'error'));
        break;
      case 'share-member-replace': {
        const person = sharePeople.find(entry => entry.id === el.dataset.personId);
        if (!person) break;
        openModal(`替换成员：${person.name}`, `
          <p class="access-hint">替换后，原成员的记录和账目归属转到新身份；原临时链接或账号权限立即失效。</p>
          <form data-form="replace-formal" class="access-form">
            <input type="hidden" name="personId" value="${Render.esc(person.id)}">
            <input id="replacementMemberName" name="username" list="registeredMembers" autocomplete="off" placeholder="搜索用户名或昵称" required><datalist id="registeredMembers"></datalist>
            <button class="btn btn-primary" type="submit">替换为正式成员</button>
          </form>
          <form data-form="replace-temporary" class="access-form">
            <input type="hidden" name="personId" value="${Render.esc(person.id)}">
            <input name="name" maxlength="40" value="${Render.esc(person.name)}" placeholder="临时成员名称" required>
            <button class="btn btn-ghost" type="submit">替换为临时成员</button>
          </form>`);
        break;
      }
      case 'welcome-enter':
        if (!Store.listTrips().length && AuthUI.user) showTripsManager();
        else setView('app');
        break;

      case 'welcome-home':
        setView('welcome');
        break;

      case 'welcome-calendar':
        showCalendar();
        break;

      case 'welcome-trips':
        current.editTrips = false;
        showTripsManager();
        break;

      case 'tripmgr-edit':
        current.editTrips = !current.editTrips;
        showTripsManager();
        break;

      case 'trip-del-confirm': {
        const id = el.dataset.id;
        const nm = (Store.listTrips().find(t => t.id === id) || {}).meta;
        openModal('删除这趟旅行？', `
          <p style="color:var(--muted);margin:0 0 14px">「${Render.esc((nm && nm.tripName) || '未命名旅行')}」的行程、花费、照片都会一并删除，无法恢复。</p>
          <div class="form-actions">
            <button type="button" class="btn btn-ghost" data-action="tripmgr-edit">取消</button>
            <button type="button" class="btn btn-primary" data-action="trip-del-ok" data-id="${Render.esc(id)}">确认删除</button>
          </div>`);
        break;
      }

      case 'trip-del-ok': {
        const id = el.dataset.id;
        doDocOp(() => Store.deleteTrip(id), '已删除').then(() => {
          current.editTrips = false;
          showTripsManager();
        });
        break;
      }

      case 'cal-prev':
        shiftMonth(-1);
        break;

      case 'cal-next':
        shiftMonth(1);
        break;

      case 'cal-day': {
        const date = el.dataset.date;
        const trips = Store.listTrips();
        const lines = [];
        trips.forEach((t) => {
          const day = (t.itinerary || []).find(d => d && d.date === date);
          if (!day) return;
          const name = (t.meta && t.meta.tripName) || '未命名';
          const items = (day.items || []).map(i => `${i.time ? i.time + ' ' : ''}${i.title || ''}${i.location ? '（' + i.location + '）' : ''}`).join('<br>') || '（当天没有具体安排）';
          lines.push(`<div style="margin-bottom:10px"><b>${Render.esc(name)}</b><br><span style="color:var(--muted)">${items}</span></div>`);
        });
        openModal(date, lines.join('') || '这天没有旅行安排');
        break;
      }

      case 'welcome-memo':
        showMemos();
        break;

      case 'memo-new':
        if (current.view === 'app' && current.tab === 'journal') openJournalEditor();
        else openModal('新建备忘录', Render.formMemo(null, Store.listTrips()));
        break;

      case 'memo-edit': {
        const m = Store.listMemos().find(x => x.id === el.dataset.id);
        if (!m) break;
        if (current.view === 'app' && current.tab === 'journal') openJournalEditor(m);
        else openModal('编辑备忘录', Render.formMemo(m, Store.listTrips()));
        break;
      }

      case 'memo-del': {
        const id = el.dataset.id;
        openModal('删除这条备忘录？', `
          <p style="color:var(--muted);margin:0 0 14px">删除后无法恢复。</p>
          <div class="form-actions">
            <button type="button" class="btn btn-ghost" data-action="modal-close">取消</button>
            <button type="button" class="btn btn-primary" data-action="memo-del-ok" data-id="${Render.esc(id)}">确认删除</button>
          </div>`);
        break;
      }

      case 'memo-del-ok': {
        const id = el.dataset.id;
        doDocOp(() => Store.mutateDoc(d => { d.memos = (d.memos || []).filter(x => x.id !== id); }), '已删除')
          .then(showMemos);
        break;
      }

      case 'nav':
        if (el.dataset.tab === 'itinerary') current.itinerarySelection = null;
        navigateTo(el.dataset.tab);
        break;

      case 'footprints-city':
        FootprintsMap.locate(el.dataset.key);
        break;

      case 'footprints-place':
        openFootprintLocation(el.dataset.key);
        break;

      case 'footprints-place-result':
        {
          const form = el.closest('form[data-form="footprints-location"]');
          saveFootprintLocation(form, form?._locationCandidates?.[Number(el.dataset.index)]);
        }
        break;

      case 'footprints-pick':
        pickFootprintLocation(el.closest('form'));
        break;

      case 'footprints-cancel-pick':
        FootprintsMap.cancelPick();
        break;

      case 'footprints-fit':
        FootprintsMap.fit();
        break;

      // 从行程详情弹窗进来的编辑，返回/保存后回到行程详情而不是关掉
      case 'item-back':
        openModal('行程详情', Render.dayDetail(Store.getState(), el.dataset.day));
        break;

      case 'modal-close':
        closeModal();
        break;

      case 'export':
        exportData();
        break;
      case 'boarding-pass-save': {
        const ticket = el.closest('[data-boarding-pass]')?.querySelector('.overview-ticket');
        if (!ticket || el.disabled) break;
        el.disabled = true;
        TicketImage.save(ticket)
          .then(() => toast('已下载登机牌图片', 'success'))
          .catch(() => toast('登机牌图片保存失败，请重试', 'error'))
          .finally(() => { el.disabled = false; });
        break;
      }
      case 'voucher-open':
        if (!modal().hidden && !closeModal()) return;
        Vouchers.open({
          trip: Store.getState(), filter: current.ledgerFilter,
          themeBase: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          csrf: Store.getCsrf(),
        });
        break;

      case 'import':
        $('#importFile').click();
        break;

      case 'itinerary-add-day':
        openModal('新建一天', Render.formDay(el.dataset.date));
        break;

      case 'itinerary-add-item':
        current.editItemFrom = modal().hidden ? '' : el.dataset.day;
        openModal('添加安排', Render.formItem(el.dataset.day));
        break;

      case 'dt-item-toggle': {
        const detail = el.parentElement.querySelector('.dt-detail');
        if (detail) {
          detail.hidden = !detail.hidden;
          el.closest('.dt-item').classList.toggle('is-open', !detail.hidden);
          el.setAttribute('aria-expanded', String(!detail.hidden));
        }
        break;
      }

      // 类别切换：重填该类的专属字段，已填的内容带过去
      case 'pick-item-cat': {
        const cat = el.dataset.cat;
        const form = el.closest('form[data-form="item"]');
        if (!form || !cat) break;
        form.querySelector('[name="category"]').value = cat;
        form.querySelectorAll('.cat-picker .btn').forEach(b => {
          b.classList.toggle('btn-primary', b.dataset.cat === cat);
          b.classList.toggle('btn-ghost', b.dataset.cat !== cat);
        });
        const data = Store.getState();
        const itemIdEl = form.querySelector('[name="itemId"]');
        const day = (data.itinerary || []).find(x => x.id === form.querySelector('[name="dayId"]').value);
        const item = itemIdEl && day && (day.items || []).find(x => x.id === itemIdEl.value);
        form._itemDraft = readItemDraft(form, item || {});
        form.querySelector('#itemFields').innerHTML = Render.itemFields(cat, form._itemDraft, data.meta || {}, day && day.date);
        break;
      }

      case 'itinerary-edit-item': {
        const data = Store.getState();
        const day = (data.itinerary || []).find(x => x.id === el.dataset.day);
        const item = day && (day.items || []).find(x => x.id === el.dataset.item);
        // 弹窗还开着说明是从行程详情点进来的，保存后要回到那个弹窗
        current.editItemFrom = modal().hidden ? '' : el.dataset.day;
        if (item) openModal('编辑安排', Render.formItem(el.dataset.day, item));
        break;
      }

      case 'itinerary-del-item':
        if (!confirm('删除这条安排？')) return;
        doMutate(d => {
          const day = d.itinerary.find(x => x.id === el.dataset.day);
          if (day) {
            day.items = (day.items || []).filter(i => i.id !== el.dataset.item);
            if (Array.isArray(day.order) && (Store.getRole() !== 'temporary' || Store.canEditRecord(day))) {
              day.order = day.order.filter(id => id !== el.dataset.item);
            }
          }
          d.expenses = (d.expenses || []).filter(e => e.itemId !== el.dataset.item);
        }, '已删除').then(() => {
          // 弹窗里的删除必须自己刷新弹窗，render() 只重绘主内容区
          if (!modal().hidden) {
            modalBody().innerHTML = Render.dayDetail(Store.getState(), el.dataset.day);
            applyPermissions(modal());
          }
        });
        break;

      case 'itinerary-del-day': {
        if (!confirm('删除这一天及其所有安排？')) return;
        const day = (Store.getState().itinerary || []).find(x => x.id === el.dataset.day);
        const ids = new Set(((day && day.items) || []).map(i => i.id));
        doMutate(d => {
          d.itinerary = d.itinerary.filter(x => x.id !== el.dataset.day);
          d.expenses = (d.expenses || []).filter(e => !ids.has(e.itemId));
        }, '已删除').then(() => {
          if (!modal().hidden) closeModal();
        });
        break;
      }

      case 'meta-edit':
        current.editMeta = true;
        render();
        break;

      // 途径地点标签：点添加或回车都进列表，隐藏域存 JSON 数组
      case 'stop-add': {
        const form = el.closest('form');
        const input = form && form.querySelector('.stops-input');
        const hidden = form && form.querySelector('[name="stops"]');
        if (!input || !hidden) return;
        const val = (input.value || '').trim();
        if (!val) { input.focus(); return; }
        const list = parseList(hidden.value);
        if (list.includes(val)) { toast('这个地点已经在列表里了', 'error'); input.select(); return; }
        list.push(val);
        hidden.value = JSON.stringify(list);
        input.value = '';
        renderStopTags(form, list);
        input.focus();
        break;
      }

      case 'stop-del': {
        const form = el.closest('form');
        const hidden = form && form.querySelector('[name="stops"]');
        if (!hidden) return;
        const list = parseList(hidden.value);
        list.splice(Number(el.dataset.idx), 1);
        hidden.value = JSON.stringify(list);
        renderStopTags(form, list);
        break;
      }

      case 'meta-cancel':
        current.editMeta = false;
        render();
        break;

      case 'board-toggle':
        Store.setBoardOpen(!Store.getBoardOpen());
        break;

      case 'trip-create':
        Store.createTrip().then(() => {
          closeModal();
          current.tab = 'overview';
          setView('app');
          toast('已新建旅行，去概览改个名字吧', 'success');
        }).catch(error => toast(error.message, 'error'));
        break;

      case 'archive-trip-open':
        if (Store.listTrips().some(trip => trip.id === el.dataset.id)) {
          navigateTo('archive-trip', { archiveTripId: el.dataset.id });
        }
        break;
      case 'trip-open':
        Store.setActiveTrip(el.dataset.id);
        // 从管理旅行弹窗点进来要先关弹窗；开启页下点边栏卡片则直接进该旅行
        closeModal();
        navigateTo('overview');
        break;

      case 'trip-archive': {
        const id = el.dataset.id;
        const to = el.dataset.arch === '1';
        doDocOp(() => Store.setTripArchived(id, to), to ? '已归档' : '已取消归档');
        break;
      }

      case 'trip-delete': {
        const t = Store.listTrips().find(x => x.id === el.dataset.id);
        if (!confirm(`删除「${t && t.meta ? t.meta.tripName : '这趟旅行'}」？里面的行程、账目、照片都会一起没掉，不可恢复。`)) return;
        doDocOp(() => Store.deleteTrip(el.dataset.id), '已删除');
        break;
      }

      case 'trip-toggle-archived':
        current.showArchived = !current.showArchived;
        render();
        break;

      case 'ledger-filter':
        current.ledgerFilter = el.dataset.filter === 'receipt' ? 'receipt' : 'all';
        render();
        break;

      case 'expense-add':
        openModal(current.ledgerFilter === 'receipt' ? '添加票据' : '记一笔',
          Render.formExpense(members(), null, { receipt: current.ledgerFilter === 'receipt' }));
        break;

      case 'expense-image-start':
        openModal(current.ledgerFilter === 'receipt' ? '添加票据' : '记一笔',
          Render.formExpense(members(), null, { receipt: current.ledgerFilter === 'receipt' }));
        modalBody().querySelector('form[data-form="expense"] [name="imageFiles"]')?.click();
        break;

      case 'welcome-expense-add':
        Store.setActiveTrip(el.dataset.id);
        current.tab = 'bookings';
        setView('app');
        openModal('记一笔', Render.formExpense(members()));
        break;

      case 'expense-location-search': {
        const form = el.closest('form[data-form="expense"]');
        if (!form) break;
        const query = form.elements.namedItem('location').value.trim();
        if (query.length < 3) { expenseLocationStatus(form, '请先填写至少三个字的地点名称。'); break; }
        void searchExpenseLocation(form, query);
        break;
      }

      case 'expense-location-choose': {
        const form = el.closest('form[data-form="expense"]');
        const candidate = form && form._locationCandidates && form._locationCandidates[Number(el.dataset.index)];
        if (candidate) setExpenseLocation(form, { location: candidate.name || candidate.address, lat: candidate.lat, lng: candidate.lng }, '已选定地点并标记在地图上。');
        break;
      }

      case 'expense-location-gps': {
        const form = el.closest('form[data-form="expense"]');
        if (!form || !navigator.geolocation) { if (form) expenseLocationStatus(form, '此设备暂不支持定位'); break; }
        el.disabled = true;
        expenseLocationStatus(form, '正在获取当前位置…');
        navigator.geolocation.getCurrentPosition(position => {
          el.disabled = false;
          if (!form.isConnected) return;
          setExpenseLocation(form, { location: '', lat: position.coords.latitude, lng: position.coords.longitude }, '已标记当前位置；可填写地点名称。');
        }, () => {
          el.disabled = false;
          if (form.isConnected) expenseLocationStatus(form, '未取得位置，可手动填写或在地图上选点。');
        }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
        break;
      }

      case 'expense-location-map': {
        const form = el.closest('form[data-form="expense"]');
        if (form) showExpenseLocationMap(form);
        break;
      }

      case 'expense-location-photo': {
        const form = el.closest('form[data-form="expense"]');
        if (form && form._photoGps) setExpenseLocation(form, { location: '', ...form._photoGps }, '已采用照片拍摄位置；请核对是否为实际消费地点。');
        break;
      }

      case 'expense-del': {
        const id = el.dataset.id;
        const expense = (Store.getState().expenses || []).find(entry => entry.id === id);
        if (!expense) return;
        const item = (Store.getState().itinerary || []).flatMap(day => day.items || []).find(entry => entry.id === expense.itemId);
        const linked = item && item.expenseId === id;
        deleteEntry(el, linked
          ? '删除这笔记账及其关联行程？所附图片也会从旅行中移除。'
          : '删除这笔记账？所附图片会从旅行中移除；关联行程保留，金额清零。',
        trip => removeExpenseRecord(trip, id));
        break;
      }

      case 'expense-detail': {
        const expense = (Store.getState().expenses || []).find(entry => entry.id === el.dataset.id);
        if (expense) openModal('记账详情', Render.expenseDetail(Store.getState(), expense.id));
        break;
      }

      case 'expense-edit': {
        const it = (Store.getState().expenses || []).find(x => x.id === el.dataset.id);
        if (it) openModal('编辑支出', Render.formExpense(members(), it));
        break;
      }

      case 'checklist-add':
        openModal('添加物品', Render.formChecklist(members()));
        break;

      case 'checklist-del':
        doMutate(d => { d.checklist = d.checklist.filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'checklist-edit': {
        const it = (Store.getState().checklist || []).find(x => x.id === el.dataset.id);
        if (it) openModal('编辑物品', Render.formChecklist(members(), it));
        break;
      }

      // 候选池卡片：点一下加入清单，已加的再点移除。连点不弹 toast，免得刷屏
      case 'pool-toggle': {
        const name = el.dataset.name;
        const cat = el.dataset.category || '其他';
        doMutate(d => {
          d.checklist = d.checklist || [];
          const idx = d.checklist.findIndex(c => c.name === name);
          // 只删一条：清单里允许同名（比如两件 T 恤），点一下不该全删
          if (idx >= 0) d.checklist.splice(idx, 1);
          else d.checklist.push({ id: Store.uid('chk'), name, category: cat, checked: false, owner: '' });
        }, '');
        break;
      }

      // 旅行类型多选：候选池取所选模板的并集。
      // packingTypes 为空时界面显示的是「通用」，toggle 必须基于这个显示状态算，
      // 否则点第二个类型会把「通用」顶掉。
      case 'packing-type': {
        const id = el.dataset.id;
        doMutate(d => {
          const tpls = Store.getTemplates();
          const cur = new Set(d.meta.packingTypes || []);
          if (!cur.size) tpls.filter(t => t.name === '通用').forEach(t => cur.add(t.id));
          if (cur.has(id)) cur.delete(id); else cur.add(id);
          d.meta.packingTypes = [...cur];
        }, '');
        break;
      }

      case 'template-manage':
        openModal('管理模板', Render.formTemplateManage());
        break;

      case 'template-edit': {
        const tpl = Store.getTemplates().find(t => t.id === el.dataset.id);
        if (tpl) openModal('编辑模板物品', Render.formTemplateEdit(tpl));
        break;
      }

      case 'template-new':
        doMutateDoc(doc => {
          doc.packingTemplates = doc.packingTemplates || [];
          doc.packingTemplates.push({ id: Store.uid('tpl'), name: '新模板', icon: '📦', items: [] });
        }).then(() => openModal('管理模板', Render.formTemplateManage()));
        break;

      case 'template-del': {
        if (!confirm('删除这个模板？')) return;
        const id = el.dataset.id;
        doMutateDoc(doc => {
          doc.packingTemplates = (doc.packingTemplates || []).filter(t => t.id !== id);
          // 用到这个模板的旅行也一并摘掉，避免候选池留悬空 id
          for (const t of (doc.trips || [])) {
            if (Array.isArray(t.meta && t.meta.packingTypes)) {
              t.meta.packingTypes = t.meta.packingTypes.filter(x => x !== id);
            }
          }
        }).then(() => openModal('管理模板', Render.formTemplateManage()));
        break;
      }

      case 'template-item-add': {
        const form = el.closest('form');
        const tplId = form.querySelector('[name="tplId"]').value;
        const name = form.querySelector('[name="newName"]').value.trim();
        const cat = form.querySelector('[name="newCat"]').value;
        if (!name) { toast('先填物品名称', 'error'); return; }
        doMutateDoc(doc => {
          const tpl = (doc.packingTemplates || []).find(t => t.id === tplId);
          if (tpl) tpl.items.push({ name, category: cat });
        }).then(() => {
          const tpl = Store.getTemplates().find(t => t.id === tplId);
          if (tpl) openModal('编辑模板物品', Render.formTemplateEdit(tpl));
        });
        break;
      }

      case 'template-item-del': {
        const form = el.closest('form');
        const tplId = form.querySelector('[name="tplId"]').value;
        const idx = Number(el.dataset.idx);
        doMutateDoc(doc => {
          const tpl = (doc.packingTemplates || []).find(t => t.id === tplId);
          if (tpl) tpl.items.splice(idx, 1);
        }).then(() => {
          const tpl = Store.getTemplates().find(t => t.id === tplId);
          if (tpl) openModal('编辑模板物品', Render.formTemplateEdit(tpl));
        });
        break;
      }

      case 'template-save':
        if (!(Store.getState().checklist || []).length) { toast('清单还是空的', 'error'); return; }
        openModal('存为模板', Render.formSaveTemplate(Store.getState()));
        break;

      case 'wish-add':
        openModal('添加心愿', Render.formWish());
        break;

      case 'wish-del':
        if (!confirm('删除这个心愿？')) return;
        doMutate(d => { d.wishlist = d.wishlist.filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'wish-edit': {
        const it = (Store.getState().wishlist || []).find(x => x.id === el.dataset.id);
        if (it) openModal('编辑心愿', Render.formWish(it));
        break;
      }

      case 'gpx-import':
        $('#gpxFile').click();
        break;

      case 'map-fit':
        fitMapToAll();
        break;

      case 'tile-source':
        if (currentTileSource !== el.dataset.tile) {
          currentTileSource = el.dataset.tile;
          // 销毁旧地图，重建并切换瓦片源
          if (map) { try { map.remove(); } catch (_) {} map = null; mapLayer = null; mapTrackLayers = []; }
          render();
        }
        break;

      case 'photo-day-open': {
        const trip = Store.getState();
        if (PhotoAlbum.albums(trip).some(album => album.key === el.dataset.date)) {
          navigateTo('photos', { photoAlbum: { tripId: trip.id, key: el.dataset.date } });
        }
        break;
      }

      case 'photo-add': {
        const date = PhotoAlbum.dateKey(el.dataset.date);
        openModal(date ? '添加照片' : '按拍摄日期上传', Render.formPhoto(Store.getState(), date));
        break;
      }

      case 'photo-open': {
        const trip = Store.getState();
        const album = PhotoAlbum.albums(trip).find(entry => entry.key === activePhotoDay(trip));
        PhotoViewer.open(album?.photos || trip.photos || [], el.dataset.id);
        break;
      }

      case 'photo-open-url':
        PhotoViewer.open([{ id: 'memo', url: el.dataset.url }], 'memo');
        break;

      case 'image-entry-cancel': {
        const form = modalBody().querySelector('form[data-form="expense"]');
        const task = form && form._entryTask;
        if (task && task.kind !== 'commit') {
          el.disabled = true;
          imageEntryStatus(form, '正在取消…');
          task.controller.abort();
        }
        break;
      }

      case 'image-entry-retry': {
        const form = el.closest('form');
        const entry = form && form._entryFiles && form._entryFiles[0];
        if (entry) runImageRecognition(form, entry);
        break;
      }

      case 'entry-image-remove': {
        const thumb = el.closest('.entry-image');
        const form = el.closest('form');
        if (!thumb || !form) break;
        if (thumb.dataset.pendingIndex != null) {
          const index = Number(thumb.dataset.pendingIndex);
          const entry = form._entryFiles.splice(index, 1)[0];
          if (entry) URL.revokeObjectURL(entry.preview);
          thumb.remove();
          form.querySelectorAll('.entry-image[data-pending-index]').forEach((node, i) => { node.dataset.pendingIndex = String(i); });
          if (!form._entryFiles.length) form.querySelector('.image-entry-retry').hidden = true;
        } else {
          thumb.remove();
          if (form._entryTouched) form._entryTouched.add('images');
        }
        break;
      }

      case 'photo-del':
        if (!confirm('删除这张照片？')) return;
        doMutate(d => { d.photos = (d.photos || []).filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'itinerary-select-date':
        current.itinerarySelection = { tripId: Store.getActiveTripId(), date: el.dataset.date };
        render();
        $('#itineraryDates .is-active')?.focus({ preventScroll: true });
        break;

      case 'place-add':
        openModal('添加地点', Render.formPlace());
        break;

      case 'place-detail':
        openModal('地点详情', Render.placeDetail(Store.getState(), el.dataset.id));
        break;

      case 'place-edit': {
        const it = (Store.getState().places || []).find(x => x.id === el.dataset.id);
        if (it) openModal('编辑地点', Render.formPlace(it));
        break;
      }

      case 'place-del':
        if (!confirm('删除这个地点？')) return;
        doMutate(d => { d.places = (d.places || []).filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'place-filter':
        current.placeFilter.category = el.dataset.cat;
        render();
        break;

      case 'guide-planner-back': {
        const tripId = el.closest('#guidePlannerPage').dataset.tripId;
        const plan = guidePlans.get(tripId);
        renderGuidePlan(tripId, { inputs: plan.inputs });
        break;
      }
      case 'guide-stop-move': {
        const item = el.closest('[data-guide-sort-id]');
        const direction = Number(el.dataset.direction);
        const target = direction < 0 ? item.previousElementSibling : item.nextElementSibling;
        if (target) moveGuideStop(item.dataset.guideSortId, target.dataset.guideSortId, direction > 0);
        break;
      }
      case 'guide-variant': {
        const page = el.closest('#guidePlannerPage');
        const form = page.querySelector('[data-form="guide-draft"]');
        const tripId = page.dataset.tripId;
        const plan = guidePlans.get(tripId);
        const chosen = plan.options.find(option => option.id === el.dataset.variant);
        if (!chosen || chosen.id === plan.variantId || form._saving) break;
        const options = plan.options.map(option => option.id === plan.variantId
          ? { ...option, rows: readGuideRows(form, plan) } : option);
        renderGuidePlan(tripId, { ...plan, options, variantId: chosen.id, rows: chosen.rows });
        break;
      }
      case 'guide-stop-detail': {
        if (el.closest('form')._saving) break;
        const page = el.closest('#guidePlannerPage');
        const id = el.closest('[data-guide-stop]').dataset.guideStop;
        const tripId = page.dataset.tripId;
        const row = guidePlans.get(tripId)?.rows.find(stop => stop.id === id);
        if (!row) break;
        const kind = el.dataset.kind;
        const item = el.closest('[data-guide-child]');
        const childIndex = item ? Number(item.dataset.guideChild) : null;
        const child = item ? GuidePlanner.childrenFor(row)[childIndex] : null;
        if (item && !child) break;
        const title = kind === 'schedule' ? `编辑「${row.name}」的时间`
          : kind === 'restaurant' ? `为「${row.mealQuery || row.name}」选择餐厅`
          : child ? `编辑「${child.name}」` : `给「${row.name}」添加小景点`;
        openModal(title, Render.formGuideStopDetail(row, kind, child));
        const form = modalBody().querySelector('[data-form="guide-stop-detail"]');
        if (form) form._guideDetail = { tripId, id, kind, childIndex };
        break;
      }
      case 'guide-child-remove': {
        const { guideStop: id } = el.closest('[data-guide-stop]').dataset;
        const index = Number(el.closest('[data-guide-child]').dataset.guideChild);
        refreshGuideDraft(rows => rows.map(row => row.id === id
          ? { ...row, children: GuidePlanner.childrenFor(row).filter((_, i) => i !== index) } : row), id, '已删除小景点', false, index);
        break;
      }
      case 'guide-import-open': {
        openModal('导入攻略', Render.formGuideImport());
        const form = modalBody().querySelector('[data-form="guide-import"]');
        if (form) form._guideTripId = Store.getActiveTripId();
        break;
      }

      case 'guide-add':
        openModal('收藏笔记', Render.formGuide());
        break;

      case 'guide-edit': {
        const g = (Store.getState().guides || []).find(x => x.id === el.dataset.id);
        if (g) openModal('编辑收藏', Render.formGuide(g));
        break;
      }

      case 'guide-del':
        if (!confirm('删除这篇收藏？')) return;
        doMutate(d => { d.guides = (d.guides || []).filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'guide-filter':
        current.guideFilter.tag = el.dataset.tag;
        render();
        break;

      case 'guide-tag-toggle': {
        // 多选结果塞进隐藏域，表单提交时才有 tags 字段可取
        el.classList.toggle('active');
        const picked = Array.from(el.closest('.guide-tag-pick').querySelectorAll('.chip.active'))
          .map(c => c.dataset.tag);
        el.closest('form').querySelector('[name=tags]').value = picked.join(',');
        break;
      }

      case 'switch-trip':
        openModal('切换旅行', Render.tripPicker());
        break;

      case 'trip-pick':
        Store.setActiveTrip(el.dataset.id);
        closeModal();
        render();
        break;

      case 'trip-goto-list':
        closeModal();
        current.tab = 'trips';
        render();
        break;

      case 'switch-identity':
        openModal('旅行成员', Render.identityPicker(Store.getState()));
        break;

      case 'trip-profile-open':
        openTripProfile().catch(error => toast(error.message, 'error'));
        break;

      case 'trip-profile-avatar':
      case 'trip-profile-color': {
        const group = el.closest('.profile-choice-group');
        group.querySelector('input[type=hidden]').value = el.dataset.value;
        group.querySelectorAll('[data-action]').forEach(choice => {
          const selected = choice === el;
          choice.classList.toggle('is-on', selected);
          choice.setAttribute('aria-pressed', String(selected));
        });
        break;
      }

      case 'trip-profile-reset': {
        const form = el.closest('form');
        const field = form.querySelector('[name=tripNickname]');
        field.value = field.dataset.inherited;
        form.querySelector('[name=inheritNickname]').value = '1';
        break;
      }

      case 'theme-pick': {
        const form = el.closest('form');
        const input = form && form.querySelector('[name=bg]');
        if (input) input.value = el.dataset.color;
        el.closest('.theme-swatches').querySelectorAll('.theme-swatch').forEach(c => c.classList.remove('is-on'));
        el.classList.add('is-on');
        // 先看效果再保存，改错了不落库
        applyTheme(el.dataset.color);
        break;
      }

      case 'theme-open': {
        const bg = Store.getWelcomeTheme() || '#f2ece0';
        openModal('页面背景', Render.themePicker(bg));
        break;
      }

      case 'member-pick-toggle': {
        const menu = el.closest('.member-pick').querySelector('.member-pick-menu');
        document.querySelectorAll('.member-pick-menu').forEach(m => {
          if (m !== menu) m.hidden = true;
        });
        menu.hidden = !menu.hidden;
        break;
      }

      case 'member-pick-opt': {
        const wrap = el.closest('.member-pick');
        const hidden = wrap.previousElementSibling;
        hidden.value = el.dataset.name;
        wrap.querySelector('.member-pick-cur .member-chip')
          .replaceWith(el.querySelector('.member-chip').cloneNode(true));
        wrap.querySelectorAll('.member-pick-opt').forEach(o => o.classList.remove('is-cur'));
        el.classList.add('is-cur');
        wrap.querySelector('.member-pick-menu').hidden = true;
        break;
      }

      // 参与人多选：点击即切换勾选，值存隐藏域的 JSON 数组
      case 'member-multi-opt': {
        const on = !el.classList.contains('is-on');
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-pressed', String(on));
        el.querySelector('.member-multi-check').textContent = on ? '✓' : '';
        const wrap = el.closest('.member-multi');
        const hidden = wrap.previousElementSibling;
        const names = [...wrap.querySelectorAll('.member-multi-opt.is-on')].map(o => o.dataset.name);
        hidden.value = JSON.stringify(names);
        const allBtn = wrap.querySelector('.member-multi-all');
        const total = wrap.querySelectorAll('.member-multi-opt').length;
        if (allBtn) allBtn.textContent = names.length === total ? '全不选' : '全选';
        break;
      }

      case 'member-multi-all': {
        const wrap = el.closest('.member-multi');
        const opts = [...wrap.querySelectorAll('.member-multi-opt')];
        const on = opts.some(o => !o.classList.contains('is-on'));
        opts.forEach(o => {
          o.classList.toggle('is-on', on);
          o.setAttribute('aria-pressed', String(on));
          o.querySelector('.member-multi-check').textContent = on ? '✓' : '';
        });
        wrap.previousElementSibling.value = JSON.stringify(on ? opts.map(o => o.dataset.name) : []);
        el.textContent = on ? '全不选' : '全选';
        break;
      }

      default:
        break;
    }
  }

  function canPlanGuide(tripId) {
    return Store.canEditTrip(tripId) && Store.getRole(tripId) !== 'temporary';
  }

  function readGuideInputs(fd) {
    return {
      destination: String(fd.get('destination') || '').trim(),
      start: fd.get('start'), end: fd.get('end'),
      text: String(fd.get('stops') || ''), chosen: fd.getAll('chosen'),
      useAi: fd.has('guideAi'),
    };
  }

  function readGuideRows(form, plan) {
    const rows = new Map([...form.querySelectorAll('[data-guide-stop]')].map(row => [row.dataset.guideStop, row]));
    return plan.rows.map(stop => {
      const row = rows.get(stop.id);
      return {
        ...stop,
        selected: row.querySelector('[name="include"]').checked,
      };
    });
  }

  function rememberGuidePage(page) {
    const tripId = page.dataset.tripId;
    const plan = guidePlans.get(tripId);
    const form = page.querySelector('form');
    if (page.dataset.stage === 'draft' && plan?.rows) {
      guidePlans.set(tripId, { ...plan, rows: readGuideRows(form, plan) });
    } else if (page.dataset.stage === 'input') {
      guidePlans.set(tripId, { inputs: readGuideInputs(new FormData(form)) });
    }
  }

  function renderGuidePlan(tripId, plan) {
    guidePlans.set(tripId, plan);
    const page = $('#guidePlannerPage');
    if (page?.dataset.tripId === tripId) page.dataset.stage = '';
    render();
    $('#content').scrollTop = 0;
    window.scrollTo(0, 0);
    $('#guideBookTitle')?.focus({ preventScroll: true });
  }

  function refreshGuideDraft(update, id, message, sorting = false, childIndex = null) {
    const page = $('#guidePlannerPage');
    if (current.tab !== 'guide-plan' || !page || !canPlanGuide(page.dataset.tripId)) return;
    const form = page.querySelector('[data-form="guide-draft"]');
    if (!form || form._saving) return;
    const tripId = page.dataset.tripId;
    const plan = guidePlans.get(tripId);
    const sortOpen = form.querySelector('.guide-sort').open;
    const active = document.activeElement;
    const sourceDirection = active?.dataset.direction;
    const rows = update(readGuideRows(form, plan));
    guidePlans.set(tripId, { ...plan, rows });
    page.dataset.stage = '';
    render();
    const updated = $('#guidePlannerPage');
    updated.querySelector('.guide-sort').open = sortOpen;
    const status = updated.querySelector('[data-guide-edit-status]');
    status.hidden = false;
    status.textContent = message;
    const stop = [...updated.querySelectorAll(sorting ? '[data-guide-sort-id]' : '[data-guide-stop]')]
      .find(element => (sorting ? element.dataset.guideSortId : element.dataset.guideStop) === id);
    if (!stop) return;
    const item = childIndex === null ? stop : stop.querySelector(`[data-guide-child="${childIndex}"]`) || stop;
    const focus = sorting
      ? [...item.querySelectorAll('button:not(:disabled)')].find(button => button.dataset.direction === sourceDirection) || item.querySelector('button:not(:disabled)')
      : (active?.classList.contains('guide-child-grip') && item.querySelector('.guide-child-grip')) || item.querySelector('.action-menu-trigger');
    if (focus) focus.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
  }

  function moveGuideStop(id, targetId, after) {
    refreshGuideDraft(rows => GuidePlanner.moveDraftStop(rows, id, targetId, after), id, '已调整当天顺序', true);
  }

  function moveGuideChild(id, from, to) {
    refreshGuideDraft(rows => rows.map(row => row.id === id
      ? { ...row, children: GuidePlanner.moveChild(GuidePlanner.childrenFor(row), from, to) } : row),
    id, '已调整小景点顺序', false, to);
  }

  function submitGuideStopDetail(form, fd, trip) {
    const { id, kind, childIndex } = form._guideDetail;
    const page = $('#guidePlannerPage');
    if (current.tab !== 'guide-plan' || page?.dataset.tripId !== trip.id) throw new Error('请返回路线手册再试');
    const row = guidePlans.get(trip.id)?.rows.find(stop => stop.id === id);
    if (!row) throw new Error('这站已不在路线手册中');
    if (kind === 'schedule') {
      const date = fd.get('date');
      const time = fd.get('time');
      if (!Footprints.isValidDate(date) || !time) throw new Error('请填写日期和开始时间');
      closeModal(true);
      refreshGuideDraft(rows => rows.map(stop => stop.id === id ? { ...stop, date, time } : stop), id, '已更新时间');
      return;
    }
    const name = String(fd.get('name') || '').trim();
    const note = String(fd.get('note') || '').trim();
    if (!name) throw new Error(kind === 'child' ? '请填写小景点名称' : '请填写餐厅名称');
    let fields, message;
    if (kind === 'child') {
      const children = GuidePlanner.childrenFor(row).slice();
      if (children.some((child, index) => index !== childIndex && child.name === name)) throw new Error('这站已经有这个小景点');
      if (childIndex === null) {
        if (children.length >= 8) throw new Error('每站最多添加 8 个小景点');
        children.push({ name, note });
        message = '已添加小景点';
      } else {
        const child = children[childIndex];
        if (!child) throw new Error('这个小景点已不在路线手册中');
        children[childIndex] = child.name === name ? { ...child, note } : { name, note };
        message = '小景点已更新';
      }
      fields = { children };
    } else if (name === row.name && !row.needsRestaurant) {
      fields = { address: note };
    } else {
      fields = { name, address: note, point: null, routePoint: null, verified: '', dining: null, needsRestaurant: false, selected: !!row.date };
    }
    closeModal(true);
    refreshGuideDraft(rows => rows.map(stop => stop.id === id ? { ...stop, ...fields } : stop), id,
      message || '已更新餐厅', false, childIndex);
  }

  async function generateGuideDraft(form, fd, trip) {
    const inputs = readGuideInputs(fd);
    if (!inputs.destination) throw new Error('请填写目的地');
    const dates = GuidePlanner.dateRange(inputs.start, inputs.end);
    const chosen = GuidePlanner.savedChoices(trip).filter(choice => inputs.chosen.includes(choice.id));
    const stops = GuidePlanner.collectStops(inputs.text, chosen);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12500);
    const submit = form.querySelector('[type="submit"]');
    const status = form.querySelector('[data-guide-status]');
    form._guideLookup = controller;
    submit.disabled = true;
    try {
      const resolved = await GuidePlanner.resolveStops(stops, trip, inputs.destination, Store.searchPlaces,
        (index, total) => { status.textContent = `正在核对地点 ${index}/${total}…`; }, controller.signal);
      if (!form.isConnected || current.view !== 'app') return;
      const latestTrip = Store.listTrips().find(entry => entry.id === trip.id);
      if (!latestTrip || !canPlanGuide(trip.id)) throw new Error('这趟旅行当前无法编辑');
      const stopsWithRoutes = resolved.map(stop => ({ ...stop, visit: GuidePlanner.visitGuide(stop, inputs.destination) }));
      const preview = GuidePlanner.makeDraft(stopsWithRoutes, latestTrip, dates);
      status.textContent = '正在为用餐偏好匹配沿途餐厅…';
      const withRestaurants = await GuidePlanner.resolveMeals(preview, latestTrip, inputs.destination, Store.searchPlaces, controller.signal);
      if (!form.isConnected || current.view !== 'app' || !canPlanGuide(trip.id)) return;
      status.textContent = '正在匹配景点入口…';
      const withEntrances = await GuidePlanner.resolveEntrances(withRestaurants, trip.id, Store.searchPlaces, controller.signal);
      if (!form.isConnected || current.view !== 'app' || !canPlanGuide(trip.id)) return;
      const stopsForPlans = withEntrances.map(stop => ({ ...stop, id: Store.uid('itm') }));
      let aiNotice = '';
      const eligible = stopsForPlans.filter(row => !row.needsRestaurant);
      if (inputs.useAi && eligible.length) {
        status.textContent = '基础路线已排好，正在用 AI 补充游览建议…';
        const aiLookup = new AbortController();
        form._guideLookup = aiLookup;
        try {
          const notes = await Store.guideAiNotes({
            tripId: trip.id,
            destination: inputs.destination,
            stops: eligible.map(row => ({
              name: row.name,
              category: row.category,
              known: [row.entrance?.name, ...(row.visit?.steps || row.dining?.tips || []).map(([title]) => title)].filter(Boolean),
            })),
            signal: aiLookup.signal,
          });
          for (const { index, note } of notes) {
            if (eligible[index] && typeof note === 'string') eligible[index].aiNote = note;
          }
        } catch (_) {
          aiNotice = 'AI 暂未返回建议，基础路线已生成。';
        }
      }
      if (!form.isConnected || current.view !== 'app' || !canPlanGuide(trip.id)) return;
      const options = GuidePlanner.routeOptions(stopsForPlans, latestTrip, dates);
      renderGuidePlan(trip.id, { inputs, rows: options[0].rows, variantId: options[0].id, options, aiNotice });
    } finally {
      clearTimeout(deadline);
      form._guideLookup = null;
      submit.disabled = false;
    }
  }

  async function saveGuideDraft(form, trip) {
    const plan = guidePlans.get(trip.id);
    const selected = readGuideRows(form, plan).filter(row => row.selected);
    if (!selected.length) throw new Error('请勾选要加入行程的地点');
    let count = 0, transferCount = 0, transferReview = 0, firstDate = '';
    await Store.mutate(draft => {
      const rows = GuidePlanner.prepareCommit(draft, selected);
      count = rows.length;
      transferCount = 0;
      transferReview = 0;
      firstDate = rows.map(row => row.date).sort()[0] || '';
      const transfers = GuidePlanner.preparedTransfers(draft, rows, plan.variantId);
      const addedByDay = new Map();
      for (const row of rows) {
        let day = draft.itinerary.find(entry => entry.date === row.date);
        if (!day) {
          day = { id: Store.uid('day'), date: row.date, items: [] };
          draft.itinerary.push(day);
        }
        const category = Object.hasOwn(Store.CONST.itemToExpenseCategory, row.category || '') ? row.category : '景点';
        const children = GuidePlanner.childrenFor(row);
        const travel = transfers.get(row.id);
        const access = travel ? null : GuidePlanner.firstStopAccess(row);
        if (!addedByDay.has(day)) addedByDay.set(day, []);
        if (travel?.bookable) {
          const transferId = Store.uid('itm');
          saveItineraryItem(draft, day.id, null, {
            id: transferId, startDate: row.date, endDate: row.date, time: travel.time, endTime: row.time,
            title: `${travel.mode} · ${travel.from.name} → ${row.name}`, location: '', category: '交通',
            note: [`${travel.mode}，预留约 ${travel.minutes} 分钟`, travel.detail].filter(Boolean).join(' · '),
            amount: 0, payer: '', participants: [],
            guideRoute: { mode: travel.mode, budget: travel.budget, partial: travel.partial, free: travel.free, steps: travel.steps },
          });
          addedByDay.get(day).push(transferId);
          transferCount += 1;
        } else if (travel) {
          transferReview += 1;
        }
        const note = [row.address && row.address !== row.name ? row.address : '',
          row.entrance ? `游览入口：${row.entrance.name}` : '',
          travel && !travel.bookable ? `从「${travel.from.name}」过来，建议预留 ${travel.minutes} 分钟（${travel.mode}），请核对时段。` : '',
          '开放时间与预约待核实'].filter(Boolean).join(' · ');
        saveItineraryItem(draft, day.id, null, {
          id: row.id, startDate: row.date, endDate: row.date, time: row.time, endTime: row.endTime,
          title: row.name, location: row.name, category, note, amount: 0, payer: '', participants: [],
          lat: row.point?.lat ?? null, lng: row.point?.lng ?? null,
          locationMap: row.point ? row.verified === 'osm' ? { source: 'osm' } : null : { mode: 'pending' },
          guideRoute: { children, budget: GuidePlanner.stopBudget(row), partial: !!travel && !travel.bookable,
            steps: access ? [{ title: access.mode + (access.station ? ` · ${access.station}` : ''), note: access.note }]
              : travel && !travel.bookable ? travel.steps : undefined },
        });
        addedByDay.get(day).push(row.id);
      }
      for (const [day, newIds] of addedByDay) {
        const newSet = new Set(newIds);
        const displayed = Render.orderDayItems(day).map(item => item.id);
        const currentOrder = displayed.filter(id => newSet.has(id));
        if (currentOrder.every((id, i) => id === newIds[i])) continue;
        let index = 0;
        day.order = displayed.map(id => newSet.has(id) ? newIds[index++] : id);
      }
    }, trip.id);
    const result = count ? `已加入 ${count} 站${transferCount ? `和 ${transferCount} 段交通` : ''}` : '勾选的地点已在行程里';
    toast(transferReview ? `${result}，另有 ${transferReview} 段交通需调整时段` : result, transferReview ? 'info' : 'success');
    if (firstDate && Store.getActiveTripId() === trip.id && form.isConnected) {
      current.itinerarySelection = { tripId: trip.id, date: firstDate };
      navigateTo('itinerary');
    } else if (form.isConnected) {
      form.querySelector('[data-guide-status]').textContent = count ? `已加入 ${count} 项安排` : '勾选的地点已在行程里';
    }
  }

  async function importGuideLinks(fd, trip) {
    const entries = GuidePlanner.parseSharedLinks(fd.get('links')).map(entry => ({ id: Store.uid('gde'), ...entry, tags: [], note: '' }));
    let count = 0;
    await Store.mutate(draft => {
      const guides = draft.guides || (draft.guides = []);
      const existing = new Set(guides.map(guide => GuidePlanner.linkKey(guide.link)));
      const fresh = entries.filter(entry => !existing.has(GuidePlanner.linkKey(entry.link)));
      guides.push(...fresh);
      count = fresh.length;
    }, trip.id);
    closeModal(true);
    toast(count ? `已导入 ${count} 条攻略${entries.length > count ? '，已跳过重复链接' : ''}` : '这些链接已在收藏里', 'success');
  }

  async function submitGuideForm(form, fd, kind) {
    if (form._saving || form._guideLookup) return;
    const status = form.querySelector('[data-guide-status]');
    const tripId = form.closest('#guidePlannerPage')?.dataset.tripId || form._guideTripId || form._guideDetail?.tripId;
    const trip = Store.listTrips().find(entry => entry.id === tripId);
    if (!trip || !canPlanGuide(trip.id)) { status.textContent = '这趟旅行当前无法编辑'; return; }
    const submit = form.querySelector('[type="submit"]');
    try {
      if (kind === 'guide-planner') {
        await generateGuideDraft(form, fd, trip);
        return;
      }
      if (kind === 'guide-stop-detail') {
        submitGuideStopDetail(form, fd, trip);
        return;
      }
      form._saving = true;
      submit.disabled = true;
      status.textContent = '正在保存…';
      if (kind === 'guide-draft') await saveGuideDraft(form, trip);
      else await importGuideLinks(fd, trip);
    } catch (error) {
      status.textContent = error.message || '操作失败，请重试';
    } finally {
      form._saving = false;
      submit.disabled = false;
    }
  }

  // ---------------- 表单提交委托 ----------------
  async function onSubmit(e) {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form;
    const fd = new FormData(form);
    if (form.classList.contains('guide-form')) {
      await submitGuideForm(form, fd, kind);
      return;
    }
    if (kind === 'account-avatar') {
      await saveAccountAvatar(form, fd.get('photo'));
      return;
    }
    if (kind === 'account-profile') {
      try {
        await AuthUI.updateDisplayName(String(fd.get('displayName') || ''));
        await Store.load();
        accountModal();
        toast('昵称已保存', 'success');
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (kind === 'trip-profile') {
      try {
        if (Store.getIdentity() == null) throw new Error('当前身份已失效，请刷新');
        await AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/profile`, 'PATCH', {
          tripNickname: fd.get('inheritNickname') === '1' ? '' : String(fd.get('tripNickname') || ''),
          avatar: String(fd.get('avatar') || ''), color: String(fd.get('color') || ''),
        });
        await Store.load();
        if (current.view === 'app' && current.tab === 'profile') {
          closeModal();
          render();
        } else {
          openModal('旅行成员', Render.identityPicker(Store.getState()));
        }
        toast('旅行资料已保存', 'success');
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (kind === 'share-member') {
      try {
        await AuthUI.request(`/api/trips/${encodeURIComponent(Store.getActiveTripId())}/members`, 'POST', {
          username: String(fd.get('username') || '').trim(), role: fd.get('role'),
        });
        shareNotice = '';
        await Store.load();
        await shareModal();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (kind === 'share-temporary' || kind === 'replace-formal' || kind === 'replace-temporary') {
      try {
        const tripId = encodeURIComponent(Store.getActiveTripId());
        const result = kind === 'share-temporary'
          ? await AuthUI.request(`/api/trips/${tripId}/temporary`, 'POST', { name: String(fd.get('name') || '').trim() })
          : await AuthUI.request(`/api/trips/${tripId}/members`, 'PATCH', {
            personId: String(fd.get('personId') || ''),
            replacement: kind === 'replace-formal'
              ? { kind: 'formal', username: String(fd.get('username') || '').trim() }
              : { kind: 'temporary', name: String(fd.get('name') || '').trim() },
          });
        shareNotice = result.token ? shareUrl('temporary', result.token) : '';
        await Store.load();
        await shareModal();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (kind === 'footprints-location') {
      await searchFootprintLocation(form, String(fd.get('query') || '').trim());
      return;
    }
    if (kind === 'footprints-location-confirm') {
      await saveFootprintLocation(form, form._footprintPoint);
      return;
    }
    if (kind === 'memo') {
      if (AuthUI.user) await saveMemo(form, fd);
      return;
    }
    if (!Store.canEditTrip() && !(AuthUI.user && (kind.startsWith('tpl-') || kind === 'theme'))) {
      toast('这趟旅行是只读的', 'error');
      return;
    }

    if (kind === 'meta') {
      // 起止日期由行程推算，币种在花费区单独改，成员走身份弹窗
      // 目的地是背景插画的匹配依据，新建旅行时行程还是空的，必须能显式填
      doMutate(d => {
        d.meta.tripName = (fd.get('tripName') || '').trim() || '我们的旅行';
        d.meta.destination = (fd.get('destination') || '').trim();
        // 途径地点是标签数组；留空表示走自动推导
        d.meta.stops = parseList(fd.get('stops'));
      }, '行程信息已保存');
      current.editMeta = false;
      render();
      return;
    }

    if (kind === 'theme') {
      const bg = (fd.get('bg') || '').trim();
      if (bg) {
        doDocOp(() => Store.mutateDoc(d => { d.meta.welcomeTheme = bg; }), '个人主题已更新');
      }
      closeModal();
      return;
    }

    if (kind === 'day') {
      const date = fd.get('date');
      if (!date) { toast('请先选择日期', 'error'); return; }
      if (form._saving) return;
      form._saving = true;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      let dayId;
      const saved = await doMutate(d => {
        let day = d.itinerary.find(entry => entry.date === date);
        if (!day) {
          day = { id: Store.uid('day'), date, items: [] };
          d.itinerary.push(day);
        }
        dayId = day.id;
      });
      form._saving = false;
      submit.disabled = false;
      if (saved && current.tab === 'itinerary') {
        current.itinerarySelection = { tripId: Store.getActiveTripId(), date };
        closeModal(true);
        render();
      } else if (saved) openModal('行程详情', Render.dayDetail(Store.getState(), dayId));
      return;
    }

    if (kind === 'item') {
      const dayId = fd.get('dayId');
      const itemId = fd.get('itemId');
      const trip = Store.getState();
      const existing = trip.itinerary.find(day => day.id === dayId)?.items.find(item => item.id === itemId);
      // datetime-local 提交的是 YYYY-MM-DDTHH:MM，拆成日期 + 时分两段存
      const [startDate, time] = splitDT(fd.get('time'));
      const [endDate, endTime] = splitDT(fd.get('endTime'));
      if (!fd.get('category')) { toast('请先选择类别', 'error'); return; }
      if (!String(fd.get('title') || '').trim()) { toast('请先填写安排内容', 'error'); return; }
      if (startDate && endDate && `${endDate}T${endTime}` < `${startDate}T${time}`) {
        toast('结束时间不能早于开始时间', 'error');
        return;
      }
      const fields = {
        time,
        startDate,
        endTime,
        endDate,
        title: fd.get('title') || '',
        // Categories without an address input must preserve an existing geocoded location.
        location: itemLocation(fd, existing, form._itemDraft),
        category: fd.get('category') || '其他',
        refNo: (fd.get('refNo') || '').trim(),
        note: fd.get('note') || '',
        amount: Number(fd.get('amount')) || 0,
        payer: fd.get('payer') || '',
        participants: parseList(fd.get('participants')),
      };
      const inline = !!form.closest('.dt-item');
      if (form._saving) return;
      form._saving = true;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      const submitText = submit.textContent;
      let targetDayId;
      let saved;
      try {
        submit.textContent = '正在确认地点…';
        const location = await locateItineraryOnSave(trip, dayId, fields, existing);
        if (!location || !form.isConnected) return;
        Object.assign(fields, location.fields);
        submit.textContent = '正在保存…';
        saved = await doMutate(d => {
          targetDayId = saveItineraryItem(d, dayId, itemId, fields);
        }, location.message || (itemId ? '已保存' : '已添加'), trip.id);
      } catch (error) {
        toast(error.message || '行程保存失败', 'error');
      } finally {
        form._saving = false;
        submit.disabled = false;
        submit.textContent = submitText;
      }
      if (!saved) return;
      // 内嵌表单：重渲染行程详情，保持这条展开并回到只读态
      if (inline) {
        document.getElementById('modalBody').innerHTML = Render.dayDetail(Store.getState(), targetDayId);
        applyPermissions(modal());
        const li = document.querySelector(`.dt-item[data-item="${itemId}"]`);
        if (li) {
          li.querySelector('.dt-detail').hidden = false;
          li.classList.add('is-open');
        }
        return;
      }
      // 从行程详情弹窗点进来的编辑，保存后回到那个弹窗
      if (current.editItemFrom) {
        openModal('行程详情', Render.dayDetail(Store.getState(), targetDayId));
        current.editItemFrom = '';
        return;
      }
      closeModal();
      if (current.tab === 'itinerary') {
        const target = Store.getState().itinerary.find(day => day.id === targetDayId);
        if (target) {
          current.itinerarySelection = { tripId: Store.getActiveTripId(), date: target.date || 'undated' };
          render();
        }
      }
      return;
    }

    if (kind === 'expense') {
      const expenseId = fd.get('expenseId');
      const savedExpense = expenseId && (Store.getState().expenses || []).find(item => item.id === expenseId);
      const previousReceipt = savedExpense && savedExpense.receipt && typeof savedExpense.receipt === 'object'
        ? savedExpense.receipt : null;
      const receiptEnabled = fd.get('receiptEnabled') === '1';
      // 与行程表单一致：datetime-local 拆成日期 + 时分两段存
      const [date, time] = splitDT(fd.get('time'));
      const lat = Number(fd.get('lat'));
      const lng = Number(fd.get('lng'));
      const hasPoint = fd.get('lat') !== '' && fd.get('lng') !== ''
        && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      const fields = {
        date,
        time,
        title: fd.get('title') || '',
        amount: Number(fd.get('amount')) || 0,
        category: fd.get('category') || '其他',
        subCategory: fd.get('subCategory') || '',
        refNo: (fd.get('refNo') || '').trim(),
        payer: fd.get('payer') || '',
        participants: parseList(fd.get('participants')),
        note: fd.get('note') || '',
        location: (fd.get('location') || '').trim(),
        lat: hasPoint ? lat : null,
        lng: hasPoint ? lng : null,
      };
      fields.receipt = receiptEnabled ? {
        ...(previousReceipt || {}),
        type: fd.get('receiptType') || 'other',
        status: fd.get('receiptStatus') || '待订',
        date: fd.get('receiptDate') || '',
        time: fd.get('receiptTime') || '',
        from: (fd.get('receiptFrom') || '').trim(),
        to: (fd.get('receiptTo') || '').trim(),
        endDate: fd.get('receiptEndDate') || '',
        endTime: fd.get('receiptEndTime') || '',
        carrier: (fd.get('receiptCarrier') || '').trim(),
        seat: (fd.get('receiptSeat') || '').trim(),
        refNo: (fd.get('receiptRefNo') || '').trim(),
        link: (fd.get('receiptLink') || '').trim(),
        price: Number(fd.get('receiptPrice')) || 0,
      } : null;
      if (fields.receipt && fields.amount > 0) delete fields.receipt.needsReview;
      const task = startImageSave(form);
      if (!task) return;
      try {
        fields.images = await entryImageUrls(form, task);
        if (fields.receipt && previousReceipt) {
          fields.receipt.images = retainedReceiptImages(previousReceipt, fields.images);
        }
        if (task.controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
        commitImageSave(form, task);
        if (expenseId) {
          await Store.mutate(d => {
            const it = d.expenses.find(x => x.id === expenseId);
            if (it) { Object.assign(it, fields); syncItemFromExpense(d, it); }
          });
        } else {
          // 新建记账要反向落到行程：按日期找那天（没有就新建），建一条行程条目双向关联
          await Store.mutate(d => {
            const ex = { id: Store.uid('exp'), itemId: '', ...fields };
            d.itinerary = d.itinerary || [];
            let day = d.itinerary.find(x => x.date === ex.date);
            if (!day) {
              day = { id: Store.uid('day'), date: ex.date, items: [], fromExpense: true };
              d.itinerary.push(day);
              if (Store.getRole() !== 'temporary') d.itinerary.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
            }
            const it = {
              id: Store.uid('itm'),
              time: ex.time, endTime: '',
              title: ex.title || ex.category,
              location: ex.location, lat: ex.lat, lng: ex.lng, note: ex.note || '',
              category: (Store.CONST.expenseToItemCategory || {})[ex.category] || '其他',
              subCategory: ex.subCategory || '',
              refNo: ex.refNo || '',
              amount: ex.amount, payer: ex.payer,
              participants: Array.isArray(ex.participants) ? ex.participants.slice() : [],
              expenseId: ex.id,
            };
            day.items.push(it);
            if (Array.isArray(day.order) && Store.getRole() !== 'temporary') day.order.push(it.id);
            ex.itemId = it.id;
            d.expenses.push(ex);
          });
        }
        toast(expenseId ? '已保存' : '已记下', 'success');
        closeModal(true);
      } catch (error) {
        imageEntryStatus(form, error.name === 'AbortError' ? '已取消上传，图片和填写内容仍在' : '保存失败，图片和填写内容仍在');
        if (error.name !== 'AbortError') toast(error.message || '保存失败', 'error');
      } finally {
        if (form.isConnected && form._entryTask === task) clearImageTask(form);
      }
      return;
    }

    if (kind === 'checklist') {
      const checklistId = fd.get('checklistId');
      const fields = {
        name: fd.get('name') || '',
        category: fd.get('category') || '其他',
        owner: fd.get('owner') || '',
      };
      if (checklistId) {
        // checked 由列表上的勾选框单独维护，不在表单里，不能重置
        doMutate(d => {
          const it = d.checklist.find(x => x.id === checklistId);
          if (it) Object.assign(it, fields);
        }, '已保存');
      } else {
        doMutate(d => { d.checklist.push({ id: Store.uid('chk'), ...fields, checked: false }); }, '已添加');
        // 勾了「同时存入模板」就沉淀进去，下次同类旅行直接从候选池点
        if (AuthUI.user && fd.get('saveToTpl') === 'on') {
          const tpls = Store.getTemplates();
          const active = new Set((Store.getState().meta || {}).packingTypes || []);
          // 界面上没选类型时显示的是「通用」，沉淀要落到它，
          // 否则会一次性塞进全部模板
          if (!active.size) tpls.filter(t => t.name === '通用').forEach(t => active.add(t.id));
          doMutateDoc(doc => {
            for (const t of (doc.packingTemplates || [])) {
              if (!active.has(t.id)) continue;
              if (!t.items.some(i => i.name === fields.name)) t.items.push({ name: fields.name, category: fields.category });
            }
          });
        }
      }
      closeModal();
      return;
    }

    if (kind === 'tpl-manage') {
      const renames = [];
      for (const [k, v] of fd.entries()) {
        if (k.startsWith('name_')) renames.push([k.slice(5), String(v).trim() || '未命名']);
      }
      doMutateDoc(doc => {
        for (const [id, nm] of renames) {
          const t = (doc.packingTemplates || []).find(x => x.id === id);
          if (t) t.name = nm;
        }
      }, '已保存').then(() => closeModal());
      return;
    }

    if (kind === 'tpl-save') {
      const name = (fd.get('name') || '').trim();
      const icon = (fd.get('icon') || '').trim() || '📦';
      if (!name) { toast('先填模板名称', 'error'); return; }
      const items = (Store.getState().checklist || []).map(c => ({ name: c.name, category: c.category }));
      doMutateDoc(doc => {
        doc.packingTemplates = doc.packingTemplates || [];
        doc.packingTemplates.push({ id: Store.uid('tpl'), name, icon, items });
      }, '已存为模板').then(() => closeModal());
      return;
    }

    // 条目编辑全走按钮，没有提交动作；拦住回车误触发表单
    if (kind === 'tpl-edit') return;

    if (kind === 'wish') {
      const wishId = fd.get('wishId');
      const fields = {
        name: fd.get('name') || '',
        location: fd.get('location') || '',
        note: fd.get('note') || '',
        priority: fd.get('priority') || '中',
      };
      if (wishId) {
        // status 由列表上的下拉单独维护，不在表单里，不能重置
        doMutate(d => {
          const it = d.wishlist.find(x => x.id === wishId);
          if (it) Object.assign(it, fields);
        }, '已保存');
      } else {
        doMutate(d => { d.wishlist.push({ id: Store.uid('wish'), ...fields, status: '想去' }); }, '已添加');
      }
      closeModal();
      return;
    }

    if (kind === 'photo') {
      await uploadPhotos(form, fd);
      return;
    }

    if (kind === 'place') {
      const placeId = fd.get('placeId');
      const fields = {
        name: fd.get('name') || '',
        category: fd.get('category') || '其他',
        status: fd.get('status') || '想去',
        location: fd.get('location') || '',
        date: fd.get('date') || '',
        cost: Number(fd.get('cost')) || 0,
        link: fd.get('link') || '',
        note: fd.get('note') || '',
      };
      if (placeId) {
        doMutate(d => {
          d.places = d.places || [];
          const it = d.places.find(x => x.id === placeId);
          if (it) Object.assign(it, fields);
        }, '已保存');
      } else {
        doMutate(d => { d.places = d.places || []; d.places.push({ id: Store.uid('plc'), ...fields }); }, '已保存');
      }
      closeModal();
      return;
    }

    if (kind === 'guide') {
      const guideId = fd.get('guideId');
      const fields = {
        title: fd.get('title') || '',
        link: fd.get('link') || '',
        tags: (fd.get('tags') || '').split(',').map(s => s.trim()).filter(Boolean),
        note: fd.get('note') || '',
      };
      // 编辑时保留原封面，除非链接变了
      const prev = guideId ? (Store.getState().guides || []).find(x => x.id === guideId) : null;
      if (prev && prev.cover && prev.link === fields.link) fields.cover = prev.cover;
      closeModal();

      // 抓封面是网络请求，不能阻塞保存：先落数据，抓到再补一次
      doMutate(d => {
        d.guides = d.guides || [];
        if (guideId) {
          const it = d.guides.find(x => x.id === guideId);
          if (it) Object.assign(it, fields);
        } else {
          d.guides.push({ id: Store.uid('gde'), ...fields });
        }
      }, guideId ? '已保存' : '已收藏');

      const url = Render.extractUrl(fields.link || '');
      if (!url || !/^https?:\/\//i.test(url)) return;
      try {
        const r = await Store.previewLink(url);
        if (!r.ok) return;
        const og = await r.json();
        if (!og || (!og.cover && !og.title)) return;
        await Store.mutate(d => {
          const list = d.guides || [];
          const it = list.find(x => x.id === (guideId || (list[list.length - 1] || {}).id));
          if (!it || it.link !== fields.link) return;   // 期间被删/改则放弃
          if (og.cover && !it.cover) it.cover = og.cover;
          if (og.title && !it.title) it.title = og.title.slice(0, 60);
        });
      } catch (_) { /* 抓不到就保持无封面，不影响收藏 */ }
      return;
    }
  }

  // ---------------- 变更委托（勾选/下拉） ----------------
  function onChange(e) {
    if (e.target.matches('form[data-form="account-avatar"] input[type="file"]')) {
      previewAccountAvatar(e.target);
      return;
    }
    if (e.target.matches('input[name="imageFiles"]')) {
      onEntryImagesSelected(e.target);
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (!actionAllowed(action, el)) return;

    if (action === 'checklist-toggle') {
      const id = el.dataset.id;
      const checked = el.checked;
      doMutate(d => {
        const c = d.checklist.find(x => x.id === id);
        if (c) c.checked = checked;
      });
    } else if (action === 'wish-status') {
      const id = el.dataset.id;
      const status = el.value;
      doMutate(d => {
        const w = d.wishlist.find(x => x.id === id);
        if (w) w.status = status;
      });
    } else if (action === 'currency-change') {
      doMutate(d => { d.meta.currency = el.value; }, '币种已更新');
    }
  }

  // ---------------- 封面补抓 ----------------
  // 旧数据或抓取失败的收藏没有 cover，会在每次数据变化时补抓一次。
  // attempted 记住已试过的 id，避免死链被反复重试。
  const coverAttempted = new Set();
  async function backfillCovers() {
    if (!Store.canEditTrip() || Store.getRole() === 'temporary') return;
    const data = Store.getState();
    if (!data) return;
    const todo = (data.guides || []).filter(g => g.link && !g.cover && !coverAttempted.has(g.id));
    if (!todo.length) return;
    for (const g of todo) {
      coverAttempted.add(g.id);
      const url = Render.extractUrl(g.link);
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const r = await Store.previewLink(url);
        if (!r.ok) continue;
        const og = await r.json();
        if (!og || !og.cover) continue;
        await Store.mutate(d => {
          const it = (d.guides || []).find(x => x.id === g.id);
          if (it && !it.cover) it.cover = og.cover;
        });
      } catch (_) { /* 抓不到就留空，下次不再重试 */ }
    }
  }

  // ---------------- 私人日志与备忘录 ----------------
  async function saveMemo(form, fd) {
    if (form._saving) return;
    const journal = form.matches('#journalEditor');
    const status = form.querySelector('[data-memo-status]');
    const editingId = String(fd.get('id') || '');
    const text = String(fd.get('text') || '');
    const tripId = String(fd.get('tripId') || '');
    const keepPhotos = fd.has('keep');
    const files = fd.getAll('file').filter(file => file.size);
    if (!text.trim()) {
      status.textContent = '请先写下正文。';
      form.elements.text.focus();
      return;
    }
    if (tripId && !Store.listTrips().some(trip => trip.id === tripId)) {
      status.textContent = '关联的旅行已不可用，请重新选择。';
      return;
    }

    const id = editingId || (form._memoId ||= Store.uid('memo'));
    const controls = Array.from(form.querySelectorAll('textarea, select, input:not([type="hidden"]), button[type="submit"]'));
    const uploads = form._memoUploads ||= new Map();
    form._saving = true;
    controls.forEach(control => { control.disabled = true; });
    try {
      status.textContent = files.length ? '正在上传照片…' : '正在保存…';
      for (const file of files) {
        if (!uploads.has(file)) uploads.set(file, await Store.uploadPhoto(file, 'memo'));
      }
      const added = files.map(file => uploads.get(file));
      status.textContent = '正在保存…';
      const createdAt = new Date().toISOString();
      await Store.mutateDoc(doc => {
        doc.memos ||= [];
        const index = doc.memos.findIndex(memo => memo.id === id);
        if (editingId && index < 0) throw new Error('这篇记录已被删除。可以复制正文后重新创建。');
        const existing = doc.memos[index];
        const photos = keepPhotos ? [...(existing?.photos || []), ...added] : added;
        const memo = { id, tripId, text, photos: [...new Set(photos)], createdAt: existing?.createdAt || createdAt };
        if (existing) doc.memos[index] = memo;
        else doc.memos.unshift(memo);
      });
    } catch (error) {
      status.textContent = `保存失败：${error.message || '请重试'}。正文仍在编辑区。`;
      return;
    } finally {
      form._saving = false;
      controls.forEach(control => { control.disabled = false; });
    }

    if (journal) {
      current.journalMemo = null;
      navigateTo('journal');
    } else showMemos();
    toast(journal ? '旅行日志已保存' : '备忘录已保存', 'success');
  }

  // ---------------- 照片上传 ----------------
  async function preparePhotoBatch(form, input) {
    if (form._saving) return;
    const trip = Store.listTrips().find(entry => entry.id === form.dataset.trip);
    const submit = form.querySelector('[type="submit"]');
    const status = form.querySelector('[data-photo-status]');
    const dateList = form.querySelector('[data-photo-dates]');
    const fixedDate = PhotoAlbum.dateKey(form.dataset.date);
    const entries = Array.from(input.files, file => ({ file, id: Store.uid('pho'), date: fixedDate }));
    const batch = { entries, tripId: form.dataset.trip, ready: false };
    form._photoBatch = batch;
    submit.disabled = true;
    dateList.replaceChildren();
    status.textContent = '';
    if (!entries.length) return;
    if (!trip || !Store.canEditTrip(trip.id)) {
      status.textContent = '当前旅行无法上传照片。';
      return;
    }
    if (entries.some(entry => entry.file.size > 20 * 1024 * 1024)) {
      status.textContent = '有照片超过 20 MB，请压缩后重新选择。';
      return;
    }

    if (!fixedDate) {
      const days = PhotoAlbum.tripDays(trip);
      const daySet = new Set(days);
      status.textContent = '正在读取拍摄日期…';
      for (const entry of entries) {
        entry.takenOn = await PhotoAlbum.captureDate(entry.file);
        if (!form.isConnected || form._photoBatch !== batch) return;
        entry.date = !days.length || daySet.has(entry.takenOn) ? entry.takenOn : '';
      }
      dateList.innerHTML = Render.photoBatchDates(entries, days);
      const missing = entries.filter(entry => !entry.date).length;
      status.textContent = missing ? `请为 ${missing} 张照片选择归档日期。` : `已识别 ${entries.length} 张照片的拍摄日期。`;
    } else status.textContent = `已选择 ${entries.length} 张照片。`;
    batch.ready = true;
    submit.disabled = false;
  }

  async function uploadPhotos(form, fd) {
    const batch = form._photoBatch;
    if (!batch?.ready || form._saving) return;
    const { entries, tripId } = batch;
    const fixedDate = PhotoAlbum.dateKey(form.dataset.date);
    const dates = entries.map((entry, index) => fixedDate || PhotoAlbum.dateKey(fd.get(`date-${index}`)));
    const status = form.querySelector('[data-photo-status]');
    if (dates.some(date => !date)) {
      status.textContent = '请先为每张照片选择归档日期。';
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    const input = form.querySelector('[type="file"]');
    const caption = fd.get('caption') || '';
    const location = fd.get('location') || '';
    form._saving = true;
    submit.disabled = true;
    input.disabled = true;
    let saved = false;
    try {
      for (const [index, entry] of entries.entries()) {
        if (entry.url) continue;
        status.textContent = `正在上传第 ${index + 1} / ${entries.length} 张照片…`;
        const result = await Store.uploadImage(entry.file, undefined, { tripId });
        entry.url = result.url;
      }
      const uploaded = entries.map((entry, index) => ({
        id: entry.id, url: entry.url, date: dates[index], caption, location,
      }));
      status.textContent = '正在归档照片…';
      await Store.mutate(trip => {
        trip.photos = trip.photos || [];
        const existing = new Set(trip.photos.map(photo => photo.id));
        trip.photos.push(...uploaded.filter(photo => !existing.has(photo.id)));
      }, tripId);
      saved = true;
    } catch (e) {
      status.textContent = `上传失败：${e.message}。选中的照片和日期已保留，可以重试。`;
    } finally {
      form._saving = false;
      submit.disabled = false;
      input.disabled = false;
    }
    if (saved && form.isConnected) {
      closeModal(true);
      toast(`已归档 ${entries.length} 张照片`, 'success');
    }
  }

  // ---------------- 地图引擎 ----------------
  let map = null;
  let mapLayer = null;
  let mapTrackLayers = [];
  let currentTileSource = 'amap'; // 'amap'(高德/GCJ02) | 'osm'(WGS84)

  // ---- WGS84 → GCJ02 坐标转换（高德瓦片是 GCJ-02，需纠偏）----
  const GCJ_A = 6378245.0;
  const GCJ_EE = 0.00669342162296594323;
  function outOfChina(lng, lat) { return (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271); }
  // 港澳不受测绘法限制，地图按 WGS84 对齐，无需纠偏
  function isHkMacau(lng, lat) {
    if (lng >= 113.75 && lng <= 114.6 && lat >= 22.05 && lat <= 22.65) return true; // 香港
    if (lng >= 113.45 && lng <= 113.7 && lat >= 22.05 && lat <= 22.25) return true;  // 澳门
    return false;
  }
  function transformLat(x, y) {
    let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return r;
  }
  function transformLng(x, y) {
    let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return r;
  }
  function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lng + dLng, lat + dLat];
  }
  // 把 WGS84 坐标投影到当前瓦片源的坐标（返回 Leaflet 的 [lat, lng]）
  function project(lat, lng) {
    if (currentTileSource === 'amap' && !isHkMacau(lng, lat)) {
      const [lng2, lat2] = wgs84ToGcj02(lng, lat);
      return [lat2, lng2];
    }
    return [lat, lng];
  }

  function buildMap() {
    map = L.map('map', { zoomControl: true });
    if (currentTileSource === 'amap') {
      L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        attribution: '© 高德地图',
      }).addTo(map);
    } else {
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }).addTo(map);
    }
    mapLayer = L.featureGroup().addTo(map);
  }

  function drawMapLayers(data) {
    mapLayer.clearLayers();
    mapTrackLayers.forEach(l => map.removeLayer(l));
    mapTrackLayers = [];

    const themeTrackColors = ['--primary', '--accent', '--primary-600', '--border']
      .map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim())
      .filter(Boolean);
    const trackColors = themeTrackColors.length ? themeTrackColors : Store.CONST.trackColors;

    const points = [];
    for (const day of data.itinerary) {
      for (const item of (day.items || [])) {
        if (item.lat != null && item.lng != null && !Footprints.isCityFallback(item)) points.push({ day, item });
      }
    }

    const dayDates = data.itinerary.map(d => d.date);
    const colorByDate = {};
    dayDates.forEach((d, i) => {
      colorByDate[d] = trackColors[i % trackColors.length];
    });

    for (const { day, item } of points) {
      const color = colorByDate[day.date] || trackColors[0];
      const icon = L.divIcon({
        className: 'journey-marker',
        html: `<span class="jm-dot" style="background:${color}"></span>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      });
      const popup = `<b>${Render.esc(item.title || '')}</b>` +
        (item.location ? `<br>📍 ${Render.esc(item.location)}` : '') +
        `<br><span style="color:#999">${Render.esc(day.date || '')} ${Render.esc(item.time || '')}</span>`;
      L.marker(project(item.lat, item.lng), { icon }).addTo(mapLayer).bindPopup(popup);
    }

    for (const [i, track] of (data.tracks || []).entries()) {
      const color = track.color || trackColors[i % trackColors.length];
      const coords = (track.points || []).filter(p => p.lat != null && p.lng != null).map(p => project(p.lat, p.lng));
      if (coords.length >= 2) {
        const line = L.polyline(coords, { color, weight: 3, opacity: 0.8 }).addTo(map);
        mapTrackLayers.push(line);
      }
    }

    fitMapToAll();
    renderMapLegend(data, colorByDate);
  }

  function refreshMap(data) {
    const el = $('#map');
    if (!el || typeof L === 'undefined') return;
    // 容器若已被其它渲染替换，则重建地图
    if (!map || map._container !== el) {
      if (map) { try { map.remove(); } catch (_) {} map = null; mapLayer = null; mapTrackLayers = []; }
      buildMap();
    }
    drawMapLayers(data);
    setTimeout(() => map.invalidateSize(), 60);
  }

  function fitMapToAll() {
    if (!map) return;
    const layers = [mapLayer, ...mapTrackLayers].filter(l => l.getBounds && l.getBounds().isValid());
    if (!layers.length) {
      map.setView([23.5, 113.5], 7);
      return;
    }
    let bounds = layers[0].getBounds();
    for (const l of layers.slice(1)) bounds = bounds.extend(l.getBounds());
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  }

  function renderMapLegend(data, colorByDate) {
    const hint = $('#mapHint');
    if (hint) hint.innerHTML = Render.mapHint(data);
    const el = $('#mapLegend');
    if (!el) return;
    const dates = data.itinerary.map(d => d.date).filter(d => d);
    el.innerHTML = dates.map(d => {
      const c = colorByDate[d] || '#c4714b';
      return `<span class="legend-item"><span class="legend-dot" style="background:${c}"></span>${Render.fmtDate(d)}</span>`;
    }).join('');
  }

  // ---------------- GPX 导入 ----------------
  function importGpx(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const doc = new DOMParser().parseFromString(reader.result, 'text/xml');
        const pts = Array.from(doc.getElementsByTagName('trkpt')).map(pt => ({
          lat: parseFloat(pt.getAttribute('lat')),
          lng: parseFloat(pt.getAttribute('lon')),
          ele: parseFloat((pt.getElementsByTagName('ele')[0] || {}).textContent || '0') || 0,
          time: (pt.getElementsByTagName('time')[0] || {}).textContent || '',
        })).filter(p => !isNaN(p.lat) && !isNaN(p.lng));

        if (pts.length < 2) { toast('GPX 里没有足够的轨迹点', 'error'); return; }

        const name = file.name.replace(/\.(gpx|xml)$/i, '');
        await Store.mutate(d => {
          d.tracks = d.tracks || [];
          d.tracks.push({ id: Store.uid('trk'), name, date: '', points: pts });
        });
        toast(`已导入轨迹「${name}」（${pts.length} 个点）`, 'success');
      } catch (e) {
        toast('GPX 导入失败：' + e.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  // ---------------- 导出 / 导入 ----------------
  function exportData() {
    const a = document.createElement('a');
    a.href = '/api/export';
    a.download = 'journey-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': Store.getCsrf() },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('服务端拒绝导入');
        toast('导入成功', 'success'); // SSE 会广播并重渲染
      } catch (e) {
        toast('导入失败：' + e.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  // 候选卡片拖到清单区添加：桌面端的补充手势，手机端以点击为主
  function initPoolDrag() {
    document.addEventListener('dragstart', (e) => {
      const card = e.target.closest && e.target.closest('.pool-card');
      if (!card) return;
      if (card.classList.contains('is-on')) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', JSON.stringify({ name: card.dataset.name, category: card.dataset.category }));
      e.dataTransfer.effectAllowed = 'copy';
      card.classList.add('is-dragging');
    });
    document.addEventListener('dragend', (e) => {
      const card = e.target.closest && e.target.closest('.pool-card');
      if (card) card.classList.remove('is-dragging');
      document.querySelectorAll('.chk-drop').forEach(z => z.classList.remove('is-over'));
    });
    document.addEventListener('dragover', (e) => {
      const zone = e.target.closest && e.target.closest('.chk-drop');
      if (!zone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-over');
    });
    document.addEventListener('dragleave', (e) => {
      const zone = e.target.closest && e.target.closest('.chk-drop');
      if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('is-over');
    });
    document.addEventListener('drop', (e) => {
      const zone = e.target.closest && e.target.closest('.chk-drop');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('is-over');
      let data = null;
      try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) {}
      if (!data || !data.name) return;
      const { name } = data;
      const cat = data.category || '其他';
      doMutate(d => {
        d.checklist = d.checklist || [];
        if (d.checklist.some(c => c.name === name)) return;   // 已有的不重复加
        d.checklist.push({ id: Store.uid('chk'), name, category: cat, checked: false, owner: '' });
      }, '已加入');
    });
  }

  // ---------------- 行程详情：拖动调换顺序 ----------------
  // 用 Pointer Events 一套代码同时覆盖鼠标与触摸；不用 HTML5 draggable，触屏不支持。
  // 拖动只改 day.order（展示顺序），不动 time——用户填的时间是事实，顺序是偏好。
  function commitDayOrder(dayId, orderIds) {
    if (!Store.canEditTrip() || Store.getRole() === 'temporary') return;
    return doMutate(d => {
      const day = (d.itinerary || []).find(x => x.id === dayId);
      if (!day) throw new Error('这一天已被删除，请刷新后重试');
      const have = new Set((day.items || []).map(i => i.id));
      // 只留还存在的条目，删掉的要从 order 里摘出去，否则会留下悬空 id
      day.order = orderIds.filter(id => have.has(id));
    }, '顺序已调整').then(saved => {
      if (!modal().hidden) {
        modalBody().innerHTML = Render.dayDetail(Store.getState(), dayId);
        applyPermissions(modal());
      } else if (!saved) render();
    });
  }

  function initDayItemDrag() {
    let drag = null;

    document.addEventListener('pointerdown', (e) => {
      if (drag || e.button !== 0 || !Store.canEditTrip() || Store.getRole() === 'temporary') return;
      const grip = e.target.closest && e.target.closest('.dt-grip, .guide-sort-grip, .guide-child-grip');
      if (!grip) return;
      const child = grip.classList.contains('guide-child-grip');
      const guide = child || grip.classList.contains('guide-sort-grip');
      const itemSelector = child ? '[data-guide-child]' : guide ? '[data-guide-sort-id]' : '.dt-item';
      const li = grip.closest(itemSelector);
      const list = li?.parentElement;
      if (!li || !list) return;
      if (guide && list.closest('form')._saving) return;
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      li.classList.add('is-dragging');
      drag = { list, li, guide, child, itemSelector, pid: e.pointerId, moved: false, originalNext: li.nextElementSibling };
    });

    document.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pid || !drag.li.isConnected) return;
      const items = [...drag.list.querySelectorAll(drag.itemSelector)];
      for (const other of items) {
        if (other === drag.li) continue;
        const r = other.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          const before = (e.clientY - r.top) < r.height / 2;
          drag.list.insertBefore(drag.li, before ? other : other.nextSibling);
          drag.moved = true;
          break;
        }
      }
    });

    const finish = (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const { list, li, moved, guide, child, originalNext } = drag;
      drag = null;
      li.classList.remove('is-dragging');
      if (!moved || !li.isConnected) return;
      if (guide) {
        if (e.type === 'pointercancel') list.insertBefore(li, originalNext);
        else if (li.nextElementSibling !== originalNext) {
          if (child) {
            const id = list.closest('[data-guide-stop]').dataset.guideStop;
            moveGuideChild(id, Number(li.dataset.guideChild), [...list.children].indexOf(li));
          } else {
            const next = li.nextElementSibling;
            const target = next || li.previousElementSibling;
            moveGuideStop(li.dataset.guideSortId, target.dataset.guideSortId, !next);
          }
        }
        return;
      }
      if (e.type === 'pointercancel') {
        if (!modal().hidden) {
          modalBody().innerHTML = Render.dayDetail(Store.getState(), list.dataset.day);
          applyPermissions(modal());
        } else render();
        return;
      }
      commitDayOrder(list.dataset.day, [...list.querySelectorAll('.dt-item')].map(x => x.dataset.item));
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  // ---------------- 初始化 ----------------
  function init() {
    PhotoViewer.init();
    Store.subscribe(render);
    Store.subscribe(backfillCovers);
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', onChange);
    document.addEventListener('input', e => {
      const form = e.target.closest && e.target.closest('form[data-form="expense"]');
      if (form && form._entryTouched && e.target.name !== 'imageFiles') form._entryTouched.add(e.target.name);
      if (form && form.dataset.form === 'expense' && e.target.name === 'location') {
        if (form._locationSearchController) form._locationSearchController.abort();
        form.elements.namedItem('lat').value = '';
        form.elements.namedItem('lng').value = '';
        if (form._locationPin) { form._locationPin.remove(); form._locationPin = null; }
        expenseLocationStatus(form, '地点名称已修改；需要标记位置时请重新选点。');
      }
    });
    document.addEventListener('error', (e) => {
      const image = e.target;
      if (!(image instanceof HTMLImageElement) || !image.dataset.original) return;
      const original = image.dataset.original;
      delete image.dataset.original;
      image.src = original;
    }, true);
    initDayItemDrag();
    initPoolDrag();
    // 记账分类切换时重填二级字段（细分 + 车次/航班号）
    document.addEventListener('change', (e) => {
      if (e.target.matches('form[data-form="photo"] input[type="file"]')) {
        preparePhotoBatch(e.target.form, e.target);
      }
      if (e.target && e.target.id === 'expCat') {
        const box = document.getElementById('expFields');
        if (box) box.innerHTML = Render.expFields(e.target.value, {});
      }
    });
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target.matches('.guide-child-grip')) {
        e.preventDefault();
        const item = e.target.closest('[data-guide-child]');
        const next = e.key === 'ArrowDown' ? item.nextElementSibling : item.previousElementSibling;
        if (next) moveGuideChild(item.closest('[data-guide-stop]').dataset.guideStop, Number(item.dataset.guideChild), Number(next.dataset.guideChild));
        return;
      }
      if (e.key === 'Escape') {
        const menu = $('.action-menu[open]');
        if (menu) {
          menu.open = false;
          menu.querySelector('summary').focus();
          return;
        }
        if (!document.querySelector('.nearby-location-dialog[open]')) closeModal();
        return;
      }
      // 途径地点输入框里回车是「加这个地点」，不能让表单直接提交
      if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('stops-input')) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.target.closest('form').querySelector('[data-action="stop-add"]').click();
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('li.exp-row[data-action="expense-detail"]')) {
        e.preventDefault();
        e.target.click();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      const form = !modal().hidden && modalBody().querySelector('form');
      const journal = current.tab === 'journal-editor' && $('#journalEditor');
      if (!form?._entryTask && !(journal && current.journalMemo && (journal._saving || journalHasChanges(journal)))) return;
      e.preventDefault();
      e.returnValue = '';
    });
    $('#importFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importFile(file);
      e.target.value = '';
    });
    // GPX 文件输入是动态渲染的，用委托绑定
    document.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'gpxFile') {
        const file = e.target.files[0];
        if (file) importGpx(file);
        e.target.value = '';
      }
    });
    // 搜索：实时检索（防抖）
    let searchTimer = null;
    document.addEventListener('input', (e) => {
      const which = e.target && (e.target.id === 'placeSearch' ? 'place' : e.target.id === 'guideSearch' ? 'guide' : null);
      if (!which) return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        current[which === 'place' ? 'placeFilter' : 'guideFilter'].keyword = e.target.value;
        render();
      }, 250);
    });
    let accountSearchTimer = null;
    document.addEventListener('input', (e) => {
      if (!e.target || !['registeredMemberName', 'replacementMemberName'].includes(e.target.id)) return;
      const field = e.target;
      const choices = field.parentElement.querySelector('datalist');
      if (!choices) return;
      clearTimeout(accountSearchTimer);
      choices.replaceChildren();
      const query = field.value.trim();
      if (query.length < 2) return;
      accountSearchTimer = setTimeout(async () => {
        try {
          const result = await AuthUI.request(`/api/users?q=${encodeURIComponent(query)}`);
          if (field.value.trim() !== query || !field.isConnected) return;
          choices.replaceChildren(...result.users.map(user => {
            const option = document.createElement('option');
            option.value = user.username;
            option.label = user.displayName === user.username ? user.username : `${user.displayName}（@${user.username}）`;
            return option;
          }));
        } catch (_) { choices.replaceChildren(); }
      }, 180);
    });
    document.addEventListener('input', (e) => {
      if (e.target && e.target.name === 'tripNickname' && e.target.closest('form[data-form="trip-profile"]')) {
        e.target.form.querySelector('[name=inheritNickname]').value = '0';
      }
    });
    // 背景色自定义取色器：拖动时实时预览，松手前不落库
    document.addEventListener('input', (e) => {
      if (!e.target || !e.target.classList || !e.target.classList.contains('theme-custom')) return;
      applyTheme(e.target.value);
      const form = e.target.closest('form');
      if (!form) return;
      const hidden = form.querySelector('[name=bg]');
      if (hidden) hidden.value = e.target.value;
      form.querySelectorAll('.theme-swatch').forEach(c => c.classList.remove('is-on'));
    });
    modal().addEventListener('click', (e) => { if (e.target === modal()) closeModal(); });

    // Dock 式标签栏：整条栏画在一张 canvas 上，DOM 只留透明热区，
    // 避免每帧改 style.transform 触发合成层重排导致手机上闪烁
    (function bindDock() {
      const bar = $('#tabbar');
      const canvas = bar.querySelector('.tabbar-bg');
      const ctx = canvas.getContext('2d');
      const MAX_S = 1.9, MIN_S = 0.72, RADIUS = 72, EASE = 0.22;
      const ICON = 25, LABEL = 11.5;
      const tabs = Render.TABS;
      const imgs = tabs.map((t) => {
        const src = Render.emojiSrc(t.icon);
        if (!src) return null;
        const im = new Image();
        // 异步加载期间画不出东西，加载完成后必须补一帧，否则首屏图标空白
        im.decoding = 'async';
        im.addEventListener('load', kick);
        im.addEventListener('error', kick);
        im.src = src;
        return im;
      });
      let curX = null;
      let running = false;

      const gauss = (d) => Math.exp(-(d * d) / (RADIUS * RADIUS));
      const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

      const totalW = tabs.reduce((s, t) => s + t.w, 0);
      const slotCenter = (i, w) => {
        let acc = 0;
        for (let k = 0; k < i; k++) acc += tabs[k].w;
        return (acc + tabs[i].w / 2) / totalW * w;
      };

      function activeIdx() {
        const a = bar.querySelector('.tab-item.active');
        return a ? Array.prototype.indexOf.call(bar.querySelectorAll('.tab-item'), a) : 0;
      }

      function resize() {
        const r = bar.getBoundingClientRect();
        if (!r.width) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        canvas.width = Math.round(r.width * dpr);
        canvas.height = Math.round(r.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      function paint(px, w, h, itemsH) {
        ctx.clearRect(0, 0, w, h);
        const act = activeIdx();
        const labelY = itemsH - 8;
        // 文字占位按实际行高算，图标底边贴在文字上方，否则放大后会被画布上沿裁掉
        const textH = LABEL * 1.45;
        const iconBottom = labelY - textH - 3;
        // 表面高度跟着图标大小走：两侧贴着最小图标，指针处抬到最大图标上方，
        // 两端由图标尺寸反推，避免出现曲线够得着中间却离两侧图标很远的空档
        const flatTop = iconBottom - ICON * MIN_S - 5;
        const peakTop = iconBottom - ICON * MAX_S - 5;
        const edge = (x) => flatTop - (flatTop - peakTop) * gauss(x - px);
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(0, edge(0));
        for (let x = 2; x <= w; x += 2) ctx.lineTo(x, edge(x));
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = cssVar('--surface') || '#fff';
        ctx.fill();
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
          const y = edge(x);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = cssVar('--border') || '#e6e6e6';
        ctx.lineWidth = 1;
        ctx.stroke();

        tabs.forEach((t, i) => {
          const c = slotCenter(i, w);
          const f = gauss(c - px);
          const s = MIN_S + (MAX_S - MIN_S) * f;
          const size = ICON * s;
          const cy = iconBottom - size / 2;
          const im = imgs[i];
          if (im && im.complete && im.naturalWidth) {
            ctx.drawImage(im, c - size / 2, cy - size / 2, size, size);
          }
          ctx.font = `600 ${(LABEL * (1 + f * 0.35)).toFixed(1)}px ${cssVar('--font') || 'sans-serif'}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = i === act ? (cssVar('--primary-600') || '#a15734') : (cssVar('--muted') || '#7d7468');
          ctx.globalAlpha = i === act ? 1 : 0.55 + 0.45 * f;
          ctx.fillText(t.label, c, labelY);
          ctx.globalAlpha = 1;
        });
      }

      function frame() {
        running = false;
        if (getComputedStyle(bar).display === 'none') return;
        const r = bar.getBoundingClientRect();
        if (!r.width) return;
        if (canvas.width !== Math.round(r.width * Math.min(window.devicePixelRatio || 1, 3))
          || canvas.height !== Math.round(r.height * Math.min(window.devicePixelRatio || 1, 3))) resize();
        // 目标吸附到当前页签中心，滑动时就一格一格跳，不是浮在半路
        const want = slotCenter(activeIdx(), r.width);
        if (curX == null) curX = want;
        const dx = want - curX;
        curX = Math.abs(dx) < 0.2 ? want : curX + dx * EASE;
        paint(curX, r.width, r.height, bar.querySelector('.tab-items').offsetHeight);
        if (curX !== want) kick();
      }

      function kick() {
        if (!running) { running = true; requestAnimationFrame(frame); }
      }

      const xAt = (clientX) => clientX - bar.getBoundingClientRect().left;
      // 按布局槽位判定：每格固定宽度，手指横移时区域可预测
      const tabAt = (localX) => {
        const list = bar.querySelectorAll('.tab-item');
        for (const it of list) {
          const l = it.offsetLeft;
          if (localX >= l && localX < l + it.offsetWidth) return it;
        }
        return null;
      };
      const switchTo = (item) => {
        if (item && item.dataset.tab !== current.tab) navigateTo(item.dataset.tab);
      };

      let dragging = false;
      let startX = 0;
      let moved = false;

      bar.addEventListener('touchstart', (e) => {
        dragging = true; moved = false;
        startX = e.touches[0].clientX;
        kick();
      }, { passive: true });
      bar.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        if (!moved && Math.abs(t.clientX - startX) > 6) moved = true;
        if (moved) switchTo(tabAt(xAt(t.clientX)));
        kick();
      }, { passive: true });
      bar.addEventListener('touchend', (e) => {
        dragging = false;
        if (!moved) switchTo(tabAt(xAt(e.changedTouches[0].clientX)));
        kick();
      }, { passive: true });
      bar.addEventListener('touchcancel', () => { dragging = false; kick(); }, { passive: true });

      window.addEventListener('resize', () => { resize(); kick(); });
      resize();
      dockKick = kick;
      kick();
    })();
    // 窗口尺寸变化时重算地图尺寸，避免瓦片错位
    window.addEventListener('resize', () => { if (map) map.invalidateSize(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && current.view === 'app' && current.tab === 'footprints' && footprintsDayStamp !== Render.today()) render();
    });

    Store.setStatusHandler((st) => {
      if (st === 'connected') setStatus(true, '已连接');
      else if (st === 'reconnecting') setStatus(false, '重连中…');
    });

    AuthUI.start().then(async () => {
      await Store.load();
      setView('welcome');
      setStatus(true, '已连接');
      Store.connect();
    }).catch(error => { setStatus(false, '连接失败'); toast(error.message, 'error'); });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
