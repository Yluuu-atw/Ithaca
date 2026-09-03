'use strict';

/**
 * app.js —— 交互层。
 * 监听用户操作（点击/提交/变更），调用 Store 改数据，弹窗收集输入。
 * 通过 data-action / data-* 属性做事件委托，避免给每个按钮单独绑事件。
 */

window.App = (() => {
  const current = { tab: 'overview' };
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
    $('#content').innerHTML = Render.renderPage(data, current.tab);
    if (current.tab === 'map') setTimeout(() => initMap(data), 0);
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

      case 'checklist-add':
        openModal('添加物品', Render.formChecklist(members()));
        break;

      case 'checklist-del':
        doMutate(d => { d.checklist = d.checklist.filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'wish-add':
        openModal('添加心愿', Render.formWish());
        break;

      case 'wish-del':
        if (!confirm('删除这个心愿？')) return;
        doMutate(d => { d.wishlist = d.wishlist.filter(x => x.id !== el.dataset.id); }, '已删除');
        break;

      case 'gpx-import':
        $('#gpxFile').click();
        break;

      case 'map-fit':
        fitMapToAll();
        break;

      case 'photo-add':
        openModal('添加照片', Render.formPhoto());
        break;

      case 'photo-del':
        if (!confirm('删除这张照片？')) return;
        doMutate(d => { d.photos = (d.photos || []).filter(x => x.id !== el.dataset.id); }, '已删除');
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
      const item = {
        id: Store.uid('itm'),
        time: fd.get('time') || '',
        endTime: fd.get('endTime') || '',
        title: fd.get('title') || '',
        location: fd.get('location') || '',
        category: fd.get('category') || '其他',
        note: fd.get('note') || '',
        estimatedCost: Number(fd.get('estimatedCost')) || 0,
      };
      doMutate(d => {
        const day = d.itinerary.find(x => x.id === dayId);
        if (day) { day.items = day.items || []; day.items.push(item); }
      }, '已添加');
      closeModal();
      return;
    }

    if (kind === 'expense') {
      const exp = {
        id: Store.uid('exp'),
        date: fd.get('date') || '',
        time: fd.get('time') || '',
        amount: Number(fd.get('amount')) || 0,
        category: fd.get('category') || '其他',
        payer: fd.get('payer') || '',
        split: fd.get('split') || '均摊',
        note: fd.get('note') || '',
      };
      doMutate(d => { d.expenses.push(exp); }, '已记下');
      closeModal();
      return;
    }

    if (kind === 'checklist') {
      const item = {
        id: Store.uid('chk'),
        name: fd.get('name') || '',
        category: fd.get('category') || '其他',
        owner: fd.get('owner') || '',
        checked: false,
      };
      doMutate(d => { d.checklist.push(item); }, '已添加');
      closeModal();
      return;
    }

    if (kind === 'wish') {
      const item = {
        id: Store.uid('wish'),
        name: fd.get('name') || '',
        location: fd.get('location') || '',
        note: fd.get('note') || '',
        priority: fd.get('priority') || '中',
        status: '想去',
      };
      doMutate(d => { d.wishlist.push(item); }, '已添加');
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

  function initMap(data) {
    const el = $('#map');
    if (!el || typeof L === 'undefined') return;

    if (!map) {
      map = L.map('map', { zoomControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
    }

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
      L.marker([item.lat, item.lng], { icon }).addTo(mapLayer).bindPopup(popup);
    }

    for (const [i, track] of (data.tracks || []).entries()) {
      const color = track.color || Store.CONST.trackColors[i % Store.CONST.trackColors.length];
      const coords = (track.points || []).filter(p => p.lat != null && p.lng != null).map(p => [p.lat, p.lng]);
      if (coords.length >= 2) {
        const line = L.polyline(coords, { color, weight: 3, opacity: 0.8 }).addTo(map);
        mapTrackLayers.push(line);
      }
    }

    fitMapToAll();
    renderMapLegend(data, colorByDate);
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
    modal().addEventListener('click', (e) => { if (e.target === modal()) closeModal(); });

    Store.setStatusHandler((st) => {
      if (st === 'connected') setStatus(true, '已连接');
      else if (st === 'reconnecting') setStatus(false, '重连中…');
    });

    render();
    Store.load()
      .then(() => setStatus(true, '已连接'))
      .catch((e) => { setStatus(false, '连接失败'); toast(e.message, 'error'); });

    Store.connect();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
