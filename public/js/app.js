'use strict';

/**
 * app.js —— 交互层。
 * 监听用户操作（点击/提交/变更），调用 Store 改数据，弹窗收集输入。
 * 通过 data-action / data-* 属性做事件委托，避免给每个按钮单独绑事件。
 */

window.App = (() => {
  const current = { view: 'welcome', tab: 'overview', itineraryMode: 'simple', placeFilter: { category: '全部', keyword: '' }, bookingFilter: { type: '全部', status: '全部' }, guideFilter: { tag: '全部', keyword: '' }, showArchived: false, editMeta: false, calY: new Date().getFullYear(), calM: new Date().getMonth(), editTrips: false };
  let dockKick = null;

  function applyTheme(base) {
    const theme = Theme.apply(base);
    Brand.apply(theme.brand);
    document.querySelectorAll('.theme-dot').forEach(d => { d.style.background = theme.base; });
    if (dockKick) dockKick();
  }
  const $ = (sel) => document.querySelector(sel);
  const modal = () => $('#modal');
  const modalBody = () => $('#modalBody');
  const modalTitle = () => $('#modalTitle');

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
      // 切回首页要主动应用首页自己的底色；这里没有数据变更，不会走 notify→render
      applyTheme(Store.getWelcomeTheme());
      $('#welcome').innerHTML = Render.renderWelcome();
      Brand.refresh();
      fetchWeather();
      paintWelcomeBg();
      return;
    }
    render();
    maybeAskIdentity();
  }

  // 把背景 SVG 内联进 DOM，才能对它的子元素逐个做描边式淡入。
  // <img> 引用的 SVG 受独立文档作用域限制，CSS 动画够不着内部节点。
  async function paintWelcomeBg() {
    const host = document.getElementById('welcomeBg');
    if (!host) return;
    const src = host.dataset.src;
    if (!src) return;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      host.innerHTML = await res.text();
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
  function shiftMonth(delta) {
    const d = new Date(current.calY, current.calM + delta, 1);
    current.calY = d.getFullYear();
    current.calM = d.getMonth();
    showCalendar();
  }

  function showMemos() {
    openModal('备忘录', `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <button type="button" class="btn btn-primary btn-sm" data-action="memo-new">＋ 新建</button>
      </div>
      ${Render.renderMemos(Store.listMemos(), Store.listTrips())}`);
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

  // 行程条目 → 记账：填了花费就自动建一条支出记录，用 itemId 双向关联。
  // 落库的字段与记账页手建的完全一致，之后改哪边都同步。
  function syncExpenseFromItem(trip, item, date) {
    if (!trip || !item) return;
    const cost = Number(item.amount) || 0;
    trip.expenses = trip.expenses || [];
    const ex = trip.expenses.find(x => x.itemId === item.id);
    // 费用清零时把已生成的记账条目一并删掉，不留 0 元记录
    if (!cost) {
      if (ex) trip.expenses = trip.expenses.filter(x => x.id !== ex.id);
      return;
    }
    const fields = {
      date: date || '',
      time: item.time || '',
      title: item.title || '',
      amount: cost,
      category: (Store.CONST.itemToExpenseCategory || {})[item.category] || '其他',
      payer: item.payer || '',
      participants: (item.participants || []).slice(),
      note: item.note || '',
    };
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
      it.amount = Number(ex.amount) || 0;
      if (ex.payer) it.payer = ex.payer;
      if (Array.isArray(ex.participants)) it.participants = ex.participants.slice();
      return;
    }
  }

  // ---------------- 渲染 ----------------
  function render() {
    const data = Store.getState();
    if (!data) return;
    // 首页与每趟旅行各用各的背景色，互不影响
    applyTheme(current.view === 'welcome' ? Store.getWelcomeTheme() : (data.meta && data.meta.theme));
    // 背景插画跟着当前旅行的目的地走；getState 返回的就是当前这趟
    const doodleImg = document.querySelector('#doodleBg img');
    if (doodleImg) {
      const want = `vendor/${Render.doodleFor(data)}`;
      if (doodleImg.getAttribute('src') !== want) doodleImg.setAttribute('src', want);
    }
    $('#nav').innerHTML = Render.renderNav(current.tab);
    if (!$('#tabItems').children.length) $('#tabItems').innerHTML = Render.renderTabbar(current.tab);
    else $('#tabItems').querySelectorAll('.tab-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === current.tab);
    });
    if (dockKick) dockKick();
    $('#pageTitle').textContent = Render.tabTitle(current.tab);
    $('#board').innerHTML = Render.renderTripBoard();
    const tripNameEl = $('#topbarTripName');
    if (tripNameEl) tripNameEl.textContent = data.meta.tripName || '九州 ITHACA';
    // 开启页下主内容区不渲染，但侧栏、看板、导航要保持最新
    if (current.view === 'welcome') return;

    // 地图页特殊处理：不整块重绘，避免 Leaflet 容器被销毁（瓦片错乱的根因）
    if (current.tab === 'map') {
      if (map && $('#map')) { refreshMap(data); return; }
      $('#content').innerHTML = Render.renderPage(data, current.tab, { tileSource: currentTileSource });
      // 必须用 refreshMap 而非 initMap：切走再切回时旧 map 实例仍绑定着已脱离
      // DOM 的容器，initMap 只判断实例存在与否，会往旧容器上画，导致新节点空白
      setTimeout(() => refreshMap(data), 0);
      return;
    }

    const focusedSearch = document.activeElement && (document.activeElement.id === 'placeSearch' || document.activeElement.id === 'guideSearch')
      ? document.activeElement.id : null;
    $('#content').innerHTML = Render.renderPage(data, current.tab, {
      itineraryMode: current.itineraryMode,
      placeFilter: current.placeFilter,
      bookingFilter: current.bookingFilter,
      guideFilter: current.guideFilter,
      showArchived: current.showArchived,
      editMeta: current.editMeta,
    });
    // 搜索框重绘后恢复焦点，保证连续输入
    if (focusedSearch && current.tab === 'places') {
      const el = document.getElementById(focusedSearch);
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
  }

  // ---------------- 弹窗 ----------------
  function openModal(title, formHTML) {
    modalTitle().textContent = title;
    modalBody().innerHTML = formHTML;
    modal().hidden = false;
    const first = modalBody().querySelector('input, select');
    if (first) first.focus();
  }

  function closeModal() {
    modal().hidden = true;
    modalBody().innerHTML = '';
  }

  // ---------------- 数据操作 ----------------
  function members() { return Store.getState().meta.members || []; }

  async function doMutate(fn, successMsg) {
    try {
      await Store.mutate(fn);
      if (successMsg) toast(successMsg, 'success');
    } catch (e) {
      toast(e.message || '操作失败', 'error');
    }
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
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {
      case 'welcome-enter':
        setView('app');
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
        openModal('新建备忘录', Render.formMemo(null, Store.listTrips()));
        break;

      case 'memo-edit': {
        const m = Store.listMemos().find(x => x.id === el.dataset.id);
        if (m) openModal('编辑备忘录', Render.formMemo(m, Store.listTrips()));
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
        current.tab = el.dataset.tab;
        // 开启页下点侧栏导航，直接进到对应页面，不必先点「我的旅行」
        if (current.view === 'welcome') setView('app'); else render();
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

      case 'import':
        $('#importFile').click();
        break;

      case 'itinerary-add-day':
        openModal('新建一天', Render.formDay());
        break;

      case 'itinerary-add-item':
        openModal('添加安排', Render.formItem(el.dataset.day));
        break;

      case 'exp-mx-toggle': {
        const detail = el.querySelector('.exp-mx-detail');
        if (detail) detail.hidden = !detail.hidden;
        break;
      }

      case 'dt-item-toggle': {
        const detail = el.parentElement.querySelector('.dt-detail');
        if (detail) {
          detail.hidden = !detail.hidden;
          el.closest('.dt-item').classList.toggle('is-open', !detail.hidden);
        }
        break;
      }

      case 'iti-item-toggle': {
        const detail = el.parentElement.querySelector('.tl-detail');
        if (detail) {
          detail.hidden = !detail.hidden;
          el.closest('.tl-item').classList.toggle('is-open', !detail.hidden);
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
        form.querySelector('#itemFields').innerHTML = Render.itemFields(cat, item || {}, data.meta || {}, day && day.date);
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
            if (Array.isArray(day.order)) day.order = day.order.filter(id => id !== el.dataset.item);
          }
          d.expenses = (d.expenses || []).filter(e => e.itemId !== el.dataset.item);
        }, '已删除').then(() => {
          // 弹窗里的删除必须自己刷新弹窗，render() 只重绘主内容区
          if (!modal().hidden) modalBody().innerHTML = Render.dayDetail(Store.getState(), el.dataset.day);
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

      case 'meta-cancel':
        current.editMeta = false;
        render();
        break;

      case 'board-toggle':
        Store.setBoardOpen(!Store.getBoardOpen());
        break;

      case 'trip-create':
        doDocOp(() => Store.createTrip()).then(() => {
          current.tab = 'overview';
          render();
          toast('已新建旅行，去概览改个名字吧', 'success');
        });
        break;

      case 'trip-open':
        Store.setActiveTrip(el.dataset.id);
        current.tab = 'overview';
        // 从管理旅行弹窗点进来要先关弹窗；开启页下点边栏卡片则直接进该旅行
        closeModal();
        if (current.view === 'welcome') setView('app'); else render();
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

      case 'expense-add':
        openModal('记一笔', Render.formExpense(members()));
        break;

      case 'expense-del': {
        if (!confirm('删除这笔支出？')) return;
        const id = el.dataset.id;
        const ex = (Store.getState().expenses || []).find(x => x.id === id);
        doMutate(d => {
          d.expenses = d.expenses.filter(x => x.id !== id);
          if (ex && ex.itemId) {
            for (const day of (d.itinerary || [])) {
              const it = (day.items || []).find(i => i.id === ex.itemId);
              if (it) { it.amount = 0; break; }
            }
          }
        }, '已删除');
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

      case 'photo-add':
        openModal('添加照片', Render.formPhoto());
        break;

      case 'photo-del':
        if (!confirm('删除这张照片？')) return;
        doMutate(d => { d.photos = (d.photos || []).filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'itinerary-toggle-mode':
        current.itineraryMode = current.itineraryMode === 'detail' ? 'simple' : 'detail';
        render();
        break;

      case 'day-detail':
        openModal('行程详情', Render.dayDetail(Store.getState(), el.dataset.day));
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

      case 'booking-add':
        openModal('添加票据', Render.formBooking(members()));
        break;

      case 'booking-detail':
        openModal('票据详情', Render.bookingDetail(Store.getState(), el.dataset.id));
        break;

      case 'booking-edit': {
        const it = (Store.getState().bookings || []).find(x => x.id === el.dataset.id);
        if (it) openModal('编辑票据', Render.formBooking(members(), it));
        break;
      }

      case 'booking-del':
        if (!confirm('删除这张票据？')) return;
        doMutate(d => { d.bookings = (d.bookings || []).filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'booking-filter-type':
        current.bookingFilter.type = el.dataset.type;
        render();
        break;

      case 'booking-filter-status':
        current.bookingFilter.status = el.dataset.status;
        render();
        break;

      case 'identity-pick':
        Store.setIdentity(Number(el.dataset.idx));
        closeModal();
        break;

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
        openModal('选择身份', Render.identityPicker(Store.getState()));
        break;

      case 'member-edit':
        openModal('编辑成员', Render.formMember(Store.getState(), Number(el.dataset.idx)));
        break;

      case 'member-add': {
        const prev = Store.getState();
        const n = (prev.meta.members || []).length;
        const defaults = Store.CONST.avatarChoices[n % Store.CONST.avatarChoices.length];
        const color = Store.CONST.colorChoices[n % Store.CONST.colorChoices.length];
        doMutate(d => {
          d.meta.members.push(`成员${n + 1}`);
          d.meta.avatars = d.meta.avatars || [];
          d.meta.avatars.push(defaults);
          d.meta.colors = d.meta.colors || [];
          d.meta.colors.push(color);
        }, '已添加');
        // 加完直接进编辑，省得再点一次
        openModal('编辑成员', Render.formMember(Store.getState(), n));
        break;
      }

      case 'member-del': {
        const i = Number(el.dataset.idx);
        const t = Store.getState();
        const name = (t.meta.members || [])[i];
        if (!name) return;
        const used = (t.expenses || []).some(e => e.payer === name)
          || (t.bookings || []).some(b => b.payer === name)
          || (t.checklist || []).some(c => c.owner === name);
        if (used) { toast('这名成员名下还有记录，先处理掉再删', 'error'); return; }
        if (!confirm(`删除成员「${name}」？`)) return;
        doMutate(d => {
          d.meta.members.splice(i, 1);
          if (d.meta.avatars) d.meta.avatars.splice(i, 1);
          if (d.meta.colors) d.meta.colors.splice(i, 1);
        }, '已删除');
        openModal('选择身份', Render.identityPicker(Store.getState()));
        break;
      }

      case 'avatar-pick': {
        // 单选结果塞进隐藏域，表单提交时才有 avatar 字段可取
        el.closest('.avatar-grid').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        el.classList.add('active');
        el.closest('form').querySelector('[name=avatar]').value = el.dataset.avatar;
        break;
      }

      case 'color-pick': {
        el.closest('.color-grid').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        el.classList.add('active');
        el.closest('form').querySelector('[name=color]').value = el.dataset.color;
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
        const bg = (current.view === 'welcome'
          ? Store.getWelcomeTheme()
          : (Store.getState().meta && Store.getState().meta.theme)) || '#f2ece0';
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

  // ---------------- 表单提交委托 ----------------
  async function onSubmit(e) {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form;
    const fd = new FormData(form);

    if (kind === 'meta') {
      // 起止日期由行程推算，币种在花费区单独改，成员走身份弹窗
      // 目的地是背景插画的匹配依据，新建旅行时行程还是空的，必须能显式填
      doMutate(d => {
        d.meta.tripName = (fd.get('tripName') || '').trim() || '我们的旅行';
        d.meta.destination = (fd.get('destination') || '').trim();
      }, '行程信息已保存');
      current.editMeta = false;
      render();
      return;
    }

    if (kind === 'theme') {
      const bg = (fd.get('bg') || '').trim();
      if (bg) {
        if (current.view === 'welcome') {
          doDocOp(() => Store.mutateDoc(d => { d.meta.welcomeTheme = bg; }), '首页背景已更新');
        } else {
          doMutate(d => { d.meta.theme = bg; }, '背景色已更新');
        }
      }
      closeModal();
      return;
    }

    if (kind === 'memo') {
      const id = (fd.get('id') || '').trim();
      const text = (fd.get('text') || '').trim();
      const tripId = (fd.get('tripId') || '').trim();
      const keep = fd.get('keep') != null;
      const files = fd.getAll('file').filter(f => f && f.size);
      const existing = id ? (Store.listMemos().find(x => x.id === id) || {}) : {};
      const carried = (id && keep) ? (existing.photos || []) : [];
      closeModal();
      (async () => {
        if (files.length) toast('照片上传中…', 'info');
        const uploaded = [];
        for (const f of files) {
          try { uploaded.push(await Store.uploadPhoto(f)); }
          catch (_) { toast('有照片上传失败，其余已保存', 'error'); }
        }
        const photos = carried.concat(uploaded);
        await doDocOp(() => Store.mutateDoc(d => {
          d.memos = d.memos || [];
          const i = id ? d.memos.findIndex(x => x.id === id) : -1;
          const rec = {
            id: id || Store.uid('memo'),
            text, photos, tripId,
            createdAt: i >= 0 ? d.memos[i].createdAt : new Date().toISOString(),
          };
          if (i >= 0) d.memos[i] = rec; else d.memos.unshift(rec);
        }), '备忘录已保存');
        showMemos();
      })();
      return;
    }

    if (kind === 'day') {
      const date = fd.get('date');
      doMutate(d => {
        d.itinerary.push({ id: Store.uid('day'), date, items: [] });
      }, '已创建');
      closeModal();
      return;
    }

    if (kind === 'item') {
      const dayId = fd.get('dayId');
      const itemId = fd.get('itemId');
      // datetime-local 提交的是 YYYY-MM-DDTHH:MM，拆成日期 + 时分两段存
      const [startDate, time] = splitDT(fd.get('time'));
      const [endDate, endTime] = splitDT(fd.get('endTime'));
      const fields = {
        time,
        startDate,
        endTime,
        endDate,
        title: fd.get('title') || '',
        // 餐饮/住宿/景点不填地点了，时间轴的 📍 路线读的是这个字段，用标题兜底
        location: fd.get('location') || fd.get('title') || '',
        category: fd.get('category') || '其他',
        refNo: (fd.get('refNo') || '').trim(),
        note: fd.get('note') || '',
        amount: Number(fd.get('amount')) || 0,
        payer: fd.get('payer') || '',
        participants: parseList(fd.get('participants')),
      };
      const inline = !!form.closest('.dt-item');
      if (itemId) {
        await doMutate(d => {
          const day = d.itinerary.find(x => x.id === dayId);
          const it = day && (day.items || []).find(x => x.id === itemId);
          if (it) { Object.assign(it, fields); syncExpenseFromItem(d, it, day && day.date); }
        }, '已保存');
      } else {
        await doMutate(d => {
          const day = d.itinerary.find(x => x.id === dayId);
          if (day) {
            day.items = day.items || [];
            const it = { id: Store.uid('itm'), ...fields };
            day.items.push(it);
            // 手动排过序的日子，新条目接在末尾；没排过的继续按时间排
            if (Array.isArray(day.order)) day.order.push(it.id);
            syncExpenseFromItem(d, it, day.date);
          }
        }, '已添加');
      }
      // 内嵌表单：重渲染行程详情，保持这条展开并回到只读态
      if (inline) {
        document.getElementById('modalBody').innerHTML = Render.dayDetail(Store.getState(), dayId);
        const li = document.querySelector(`.dt-item[data-item="${itemId}"]`);
        if (li) {
          li.querySelector('.dt-detail').hidden = false;
          li.classList.add('is-open');
        }
        return;
      }
      // 从行程详情弹窗点进来的编辑，保存后回到那个弹窗
      if (current.editItemFrom) {
        openModal('行程详情', Render.dayDetail(Store.getState(), current.editItemFrom));
        current.editItemFrom = '';
        return;
      }
      closeModal();
      return;
    }

    if (kind === 'expense') {
      const expenseId = fd.get('expenseId');
      // 与行程表单一致：datetime-local 拆成日期 + 时分两段存
      const [date, time] = splitDT(fd.get('time'));
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
      };
      if (expenseId) {
        doMutate(d => {
          const it = d.expenses.find(x => x.id === expenseId);
          if (it) { Object.assign(it, fields); syncItemFromExpense(d, it); }
        }, '已保存');
      } else {
        // 新建记账要反向落到行程：按日期找那天（没有就新建），建一条行程条目双向关联
        doMutate(d => {
          const ex = { id: Store.uid('exp'), itemId: '', ...fields };
          d.itinerary = d.itinerary || [];
          let day = d.itinerary.find(x => x.date === ex.date);
          if (!day) {
            day = { id: Store.uid('day'), date: ex.date, items: [] };
            d.itinerary.push(day);
            d.itinerary.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
          }
          const it = {
            id: Store.uid('itm'),
            time: ex.time, endTime: '',
            title: ex.title || ex.category,
            location: '', lat: null, lng: null, note: ex.note || '',
            category: (Store.CONST.expenseToItemCategory || {})[ex.category] || '其他',
            subCategory: ex.subCategory || '',
            refNo: ex.refNo || '',
            amount: ex.amount, payer: ex.payer,
            participants: Array.isArray(ex.participants) ? ex.participants.slice() : [],
            expenseId: ex.id,
          };
          day.items.push(it);
          if (Array.isArray(day.order)) day.order.push(it.id);
          ex.itemId = it.id;
          d.expenses.push(ex);
        }, '已记下');
      }
      closeModal();
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
        if (fd.get('saveToTpl') === 'on') {
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
      const fileInput = form.querySelector('input[type=file]');
      const files = fileInput ? fileInput.files : null;
      if (!files || !files.length) { toast('请先选择照片', 'error'); return; }
      const date = fd.get('date') || '';
      const caption = fd.get('caption') || '';
      const location = fd.get('location') || '';
      uploadPhotos(files, date, caption, location);
      closeModal();
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

    if (kind === 'booking') {
      const bookingId = fd.get('bookingId');
      const fields = {
        type: fd.get('type') || 'other',
        title: fd.get('title') || '',
        status: fd.get('status') || '待订',
        from: fd.get('from') || '',
        to: fd.get('to') || '',
        date: fd.get('date') || '',
        time: fd.get('time') || '',
        endDate: fd.get('endDate') || '',
        endTime: fd.get('endTime') || '',
        carrier: fd.get('carrier') || '',
        seat: fd.get('seat') || '',
        refNo: fd.get('refNo') || '',
        price: Number(fd.get('price')) || 0,
        payer: fd.get('payer') || '',
        link: fd.get('link') || '',
        note: fd.get('note') || '',
      };
      if (bookingId) {
        doMutate(d => {
          d.bookings = d.bookings || [];
          const it = d.bookings.find(x => x.id === bookingId);
          if (it) Object.assign(it, fields);
        }, '已保存票据');
      } else {
        doMutate(d => { d.bookings = d.bookings || []; d.bookings.push({ id: Store.uid('bk'), ...fields }); }, '已保存票据');
      }
      closeModal();
      return;
    }

    if (kind === 'member') {
      const idx = Number(fd.get('idx'));
      const newName = (fd.get('name') || '').trim();
      const avatar = fd.get('avatar') || '';
      const color = fd.get('color') || '';
      if (!newName) return;
      doMutate(d => {
        const m = d.meta.members;
        if (!m || idx < 0 || idx >= m.length) return;
        const old = m[idx];
        m[idx] = newName;
        d.meta.avatars = d.meta.avatars || [];
        d.meta.avatars[idx] = avatar;
        d.meta.colors = d.meta.colors || [];
        d.meta.colors[idx] = color;
        // 这三处按名字引用成员，不同步就会指向一个已不存在的人
        if (old && old !== newName) {
          (d.expenses || []).forEach(e => { if (e.payer === old) e.payer = newName; });
          (d.checklist || []).forEach(c => { if (c.owner === old) c.owner = newName; });
          (d.bookings || []).forEach(b => { if (b.payer === old) b.payer = newName; });
        }
      }, '已保存');
      openModal('选择身份', Render.identityPicker(Store.getState()));
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
        const r = await fetch('/api/link-preview?url=' + encodeURIComponent(url));
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
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

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
    const data = Store.getState();
    if (!data) return;
    const todo = (data.guides || []).filter(g => g.link && !g.cover && !coverAttempted.has(g.id));
    if (!todo.length) return;
    for (const g of todo) {
      coverAttempted.add(g.id);
      const url = Render.extractUrl(g.link);
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const r = await fetch('/api/link-preview?url=' + encodeURIComponent(url));
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

  // ---------------- 照片上传 ----------------
  async function uploadPhotos(files, date, caption, location) {
    toast('上传中…', 'info');
    try {
      const uploaded = [];
      for (const file of Array.from(files)) {
        const url = await Store.uploadPhoto(file);
        uploaded.push({ id: Store.uid('pho'), url, date, caption, location });
      }
      await Store.mutate(d => {
        d.photos = d.photos || [];
        d.photos.push(...uploaded);
      });
      toast(`已上传 ${uploaded.length} 张照片`, 'success');
    } catch (e) {
      toast('上传失败：' + e.message, 'error');
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
    mapLayer = L.layerGroup().addTo(map);
  }

  function drawMapLayers(data) {
    mapLayer.clearLayers();
    mapTrackLayers.forEach(l => map.removeLayer(l));
    mapTrackLayers = [];

    const points = [];
    for (const day of data.itinerary) {
      for (const item of (day.items || [])) {
        if (item.lat != null && item.lng != null) points.push({ day, item });
      }
    }

    const dayDates = data.itinerary.map(d => d.date);
    const colorByDate = {};
    dayDates.forEach((d, i) => {
      colorByDate[d] = Store.CONST.trackColors[i % Store.CONST.trackColors.length];
    });

    for (const { day, item } of points) {
      const color = colorByDate[day.date] || '#c4714b';
      const icon = L.divIcon({
        className: 'journey-marker',
        html: `<span class="jm-dot" style="background:${color}"></span>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      });
      const popup = `<b>${Render.esc(item.title || '')}</b>` +
        (item.location ? `<br>📍 ${Render.esc(item.location)}` : '') +
        `<br><span style="color:#999">${day.date} ${item.time || ''}</span>`;
      L.marker(project(item.lat, item.lng), { icon }).addTo(mapLayer).bindPopup(popup);
    }

    for (const [i, track] of (data.tracks || []).entries()) {
      const color = track.color || Store.CONST.trackColors[i % Store.CONST.trackColors.length];
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
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  function renderMapLegend(data, colorByDate) {
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
          headers: { 'Content-Type': 'application/json' },
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
    doMutate(d => {
      const day = (d.itinerary || []).find(x => x.id === dayId);
      if (!day) return;
      const have = new Set((day.items || []).map(i => i.id));
      // 只留还存在的条目，删掉的要从 order 里摘出去，否则会留下悬空 id
      day.order = orderIds.filter(id => have.has(id));
    }, '顺序已调整').then(() => {
      if (!modal().hidden) modalBody().innerHTML = Render.dayDetail(Store.getState(), dayId);
    });
  }

  function initDayItemDrag() {
    let drag = null;

    document.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest && e.target.closest('.dt-grip');
      if (!grip) return;
      const li = grip.closest('.dt-item');
      const list = li && li.closest('.dt-list');
      if (!li || !list) return;
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      li.classList.add('is-dragging');
      drag = { list, li, pid: e.pointerId, moved: false };
    });

    document.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      drag.moved = true;
      const items = [...drag.list.querySelectorAll('.dt-item')];
      for (const other of items) {
        if (other === drag.li) continue;
        const r = other.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          const before = (e.clientY - r.top) < r.height / 2;
          drag.list.insertBefore(drag.li, before ? other : other.nextSibling);
          break;
        }
      }
    });

    const finish = (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const { list, li, moved } = drag;
      drag = null;
      li.classList.remove('is-dragging');
      if (!moved) return;
      commitDayOrder(list.dataset.day, [...list.querySelectorAll('.dt-item')].map(x => x.dataset.item));
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  // ---------------- 初始化 ----------------
  function init() {
    Store.subscribe(render);
    Store.subscribe(backfillCovers);
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', onChange);
    initDayItemDrag();
    initPoolDrag();
    // 记账分类切换时重填二级字段（细分 + 车次/航班号）
    document.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'expCat') {
        const box = document.getElementById('expFields');
        if (box) box.innerHTML = Render.expFields(e.target.value, {});
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
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
        if (item && item.dataset.tab !== current.tab) { current.tab = item.dataset.tab; render(); }
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

    Store.setStatusHandler((st) => {
      if (st === 'connected') setStatus(true, '已连接');
      else if (st === 'reconnecting') setStatus(false, '重连中…');
    });

    setView('welcome');
    Store.load()
      .then(() => {
        setStatus(true, '已连接');
        maybeAskIdentity();
      })
      .catch((e) => { setStatus(false, '连接失败'); toast(e.message, 'error'); });

    Store.connect();
  }

  // 首次访问（未选择身份）时，弹出「你是谁」选择器。
  // 开启页视图下不弹，等用户点进旅行页再问，否则弹窗会盖住开启页。
  function maybeAskIdentity() {
    if (current.view === 'welcome') return;
    if (Store.getIdentity() != null) return;
    const ms = members();
    if (!ms || ms.length < 2) return;
    openModal('选择身份', Render.identityPicker(Store.getState()));
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
