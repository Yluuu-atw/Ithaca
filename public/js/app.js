'use strict';

/**
 * app.js —— 交互层。
 * 监听用户操作（点击/提交/变更），调用 Store 改数据，弹窗收集输入。
 * 通过 data-action / data-* 属性做事件委托，避免给每个按钮单独绑事件。
 */

window.App = (() => {
  const current = { tab: 'overview', itineraryMode: 'simple', placeFilter: { category: '全部', keyword: '' }, bookingFilter: { type: '全部', status: '全部' }, guideFilter: { tag: '全部', keyword: '' } };
  const $ = (sel) => document.querySelector(sel);
  const modal = () => $('#modal');
  const modalBody = () => $('#modalBody');
  const modalTitle = () => $('#modalTitle');

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

  // ---------------- 渲染 ----------------
  function render() {
    const data = Store.getState();
    if (!data) return;
    $('#nav').innerHTML = Render.renderNav(current.tab);
    $('#tabbar').innerHTML = Render.renderTabbar(current.tab);
    $('#pageTitle').textContent = Render.tabTitle(current.tab);
    $('#brandName').textContent = data.meta.tripName || 'Journey';

    // 地图页特殊处理：不整块重绘，避免 Leaflet 容器被销毁（瓦片错乱的根因）
    if (current.tab === 'map') {
      if (map && $('#map')) { refreshMap(data); return; }
      $('#content').innerHTML = Render.renderPage(data, current.tab, { tileSource: currentTileSource });
      // 必须用 refreshMap 而非 initMap：切走再切回时旧 map 实例仍绑定着已脱离
      // DOM 的容器，initMap 只判断实例存在与否，会往旧容器上画，导致新节点空白
      setTimeout(() => refreshMap(data), 0);
      return;
    }

    const hadSearchFocus = document.activeElement && (document.activeElement.id === 'placeSearch' || document.activeElement.id === 'guideSearch');
    $('#content').innerHTML = Render.renderPage(data, current.tab, {
      itineraryMode: current.itineraryMode,
      placeFilter: current.placeFilter,
      bookingFilter: current.bookingFilter,
      guideFilter: current.guideFilter,
    });
    // 搜索框重绘后恢复焦点，保证连续输入
    if (hadSearchFocus && current.tab === 'places') {
      const el = $('#placeSearch');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
    if (hadSearchFocus && current.tab === 'guides') {
      const el = $('#guideSearch');
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

  // ---------------- 点击委托 ----------------
  function onClick(e) {
    if (e.target === modal()) { closeModal(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {
      case 'nav':
        current.tab = el.dataset.tab;
        render();
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

      case 'itinerary-edit-item': {
        const data = Store.getState();
        const day = (data.itinerary || []).find(x => x.id === el.dataset.day);
        const item = day && (day.items || []).find(x => x.id === el.dataset.item);
        if (item) openModal('编辑安排', Render.formItem(el.dataset.day, item));
        break;
      }

      case 'itinerary-del-item':
        if (!confirm('删除这条安排？')) return;
        doMutate(d => {
          const day = d.itinerary.find(x => x.id === el.dataset.day);
          if (day) day.items = (day.items || []).filter(i => i.id !== el.dataset.item);
        }, '已删除');
        break;

      case 'itinerary-del-day':
        if (!confirm('删除这一天及其所有安排？')) return;
        doMutate(d => { d.itinerary = d.itinerary.filter(x => x.id !== el.dataset.day); }, '已删除');
        break;

      case 'expense-add':
        openModal('记一笔', Render.formExpense(members()));
        break;

      case 'expense-del':
        if (!confirm('删除这笔支出？')) return;
        doMutate(d => { d.expenses = d.expenses.filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

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

      case 'switch-identity':
        openModal('选择身份', Render.identityPicker(members()));
        break;

      default:
        break;
    }
  }

  // ---------------- 表单提交委托 ----------------
  function onSubmit(e) {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form;
    const fd = new FormData(form);

    if (kind === 'meta') {
      const membersStr = (fd.get('members') || '').trim();
      const memberList = membersStr
        ? membersStr.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
        : [];
      doMutate(d => {
        d.meta.tripName = fd.get('tripName') || '我们的旅行';
        d.meta.destination = fd.get('destination') || '';
        d.meta.startDate = fd.get('startDate') || '';
        d.meta.endDate = fd.get('endDate') || '';
        d.meta.currency = fd.get('currency') || 'CNY';
        if (memberList.length) d.meta.members = memberList;
      }, '行程信息已保存');
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
      const fields = {
        time: fd.get('time') || '',
        endTime: fd.get('endTime') || '',
        title: fd.get('title') || '',
        location: fd.get('location') || '',
        category: fd.get('category') || '其他',
        note: fd.get('note') || '',
        estimatedCost: Number(fd.get('estimatedCost')) || 0,
      };
      if (itemId) {
        doMutate(d => {
          const day = d.itinerary.find(x => x.id === dayId);
          const it = day && (day.items || []).find(x => x.id === itemId);
          if (it) Object.assign(it, fields);
        }, '已保存');
      } else {
        doMutate(d => {
          const day = d.itinerary.find(x => x.id === dayId);
          if (day) { day.items = day.items || []; day.items.push({ id: Store.uid('itm'), ...fields }); }
        }, '已添加');
      }
      closeModal();
      return;
    }

    if (kind === 'expense') {
      const expenseId = fd.get('expenseId');
      const fields = {
        date: fd.get('date') || '',
        time: fd.get('time') || '',
        amount: Number(fd.get('amount')) || 0,
        category: fd.get('category') || '其他',
        payer: fd.get('payer') || '',
        split: fd.get('split') || '均摊',
        note: fd.get('note') || '',
      };
      if (expenseId) {
        doMutate(d => {
          const it = d.expenses.find(x => x.id === expenseId);
          if (it) Object.assign(it, fields);
        }, '已保存');
      } else {
        doMutate(d => { d.expenses.push({ id: Store.uid('exp'), ...fields }); }, '已记下');
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
      }
      closeModal();
      return;
    }

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

    if (kind === 'guide') {
      const guideId = fd.get('guideId');
      const fields = {
        title: fd.get('title') || '',
        link: fd.get('link') || '',
        tags: (fd.get('tags') || '').split(',').map(s => s.trim()).filter(Boolean),
        note: fd.get('note') || '',
      };
      if (guideId) {
        doMutate(d => {
          d.guides = d.guides || [];
          const it = d.guides.find(x => x.id === guideId);
          if (it) Object.assign(it, fields);
        }, '已保存');
      } else {
        doMutate(d => { d.guides = d.guides || []; d.guides.push({ id: Store.uid('gde'), ...fields }); }, '已收藏');
      }
      closeModal();
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
      const color = colorByDate[day.date] || '#6f9e8f';
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
      const c = colorByDate[d] || '#6f9e8f';
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

  // ---------------- 初始化 ----------------
  function init() {
    Store.subscribe(render);
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', onChange);
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
    modal().addEventListener('click', (e) => { if (e.target === modal()) closeModal(); });
    // 窗口尺寸变化时重算地图尺寸，避免瓦片错位
    window.addEventListener('resize', () => { if (map) map.invalidateSize(); });

    Store.setStatusHandler((st) => {
      if (st === 'connected') setStatus(true, '已连接');
      else if (st === 'reconnecting') setStatus(false, '重连中…');
    });

    render();
    Store.load()
      .then(() => {
        setStatus(true, '已连接');
        maybeAskIdentity();
      })
      .catch((e) => { setStatus(false, '连接失败'); toast(e.message, 'error'); });

    Store.connect();
  }

  // 首次访问（未选择身份）时，弹出「你是谁」选择器
  function maybeAskIdentity() {
    if (Store.getIdentity() != null) return;
    const ms = members();
    if (!ms || ms.length < 2) return;
    openModal('选择身份', Render.identityPicker(ms));
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
