'use strict';

// 城市和每日行程地点使用同一张地图，坐标只在展示时转换。
window.FootprintsMap = (() => {
  const resolvedCities = new Map();
  let active = null;

  function validPoint(city) {
    return city && city.lat != null && city.lat !== '' && city.lng != null && city.lng !== ''
      && Number.isFinite(Number(city.lat)) && Number.isFinite(Number(city.lng))
      && Math.abs(Number(city.lat)) <= 90 && Math.abs(Number(city.lng)) <= 180;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function decorate(cities) {
    return (Array.isArray(cities) ? cities : []).map(city => {
      const point = validPoint(city) ? city : resolvedCities.get(city.key);
      return { ...city, lat: validPoint(point) ? Number(point.lat) : null, lng: validPoint(point) ? Number(point.lng) : null };
    });
  }

  function isActive(state) {
    return active === state && state.container.isConnected;
  }

  function creditCitySearch(state) {
    if (state.map && (state.cities.some(city => resolvedCities.has(city.key)) || state.places.some(place => place.source === 'osm'))) {
      state.map.attributionControl.addAttribution('地点查询 &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>');
    }
  }

  function updateStatus(state) {
    if (!isActive(state)) return;
    const status = document.getElementById('footprintsMapStatus');
    if (!status) return;
    const marked = state.cities.filter(validPoint).length;
    const placed = state.places.filter(validPoint).length;
    const pending = state.cities.length + state.places.filter(place => place.mode !== 'hidden').length - marked - placed;
    const report = marked || placed || pending
      ? `已标记 ${marked} 座城市、${placed} 条行程地点。${pending ? `另有 ${pending} 条待定位，可在下方列表查找。` : ''}`
      : '已开始旅行的城市和行程地点会显示在这里。';
    status.textContent = `${state.message || report}${state.tileError ? ' 地图底图暂时无法加载，列表仍可使用。' : ''}`;
  }

  function drawCities(state) {
    if (!state.map || !isActive(state)) return;
    state.layer.clearLayers();
    state.markers.clear();
    const addMarker = (entry, isPlace) => {
      const icon = L.divIcon({
        className: isPlace ? 'footprints-marker footprints-marker-place' : 'footprints-marker',
        html: '<span class="footprints-marker-dot"></span>',
        iconSize: [22, 22], iconAnchor: [11, 11],
      });
      const detail = isPlace ? `${entry.date} · ${entry.tripName}` : `${entry.visits || 0} 趟旅行`;
      const nearby = entry.nearbyName ? `<small>附近标记：${esc(entry.nearbyName)}</small>` : '';
      const marker = L.marker(state.projectPoint(entry.lat, entry.lng), {
        icon, title: entry.name, alt: `${entry.name}，${detail}`, keyboard: true,
        zIndexOffset: isPlace ? 100 : 0,
      }).addTo(state.layer)
        .bindTooltip(esc(entry.name), { direction: 'top' })
        .bindPopup(`<strong>${esc(entry.name)}</strong><p>${esc(detail)}</p>${nearby}`);
      state.markers.set(entry.key, marker);
    };
    state.cities.filter(validPoint).forEach(city => addMarker(city, false));
    state.places.filter(validPoint).forEach(place => {
      const city = place.source === 'city' && state.cities.find(entry =>
        entry.lat === place.lat && entry.lng === place.lng);
      const existing = city && state.markers.get(city.key);
      if (existing) state.markers.set(place.key, existing);
      else addMarker(place, true);
    });
    updateStatus(state);
  }

  function fit() {
    const state = active;
    if (!state || !state.map || !isActive(state)) return;
    const points = [...state.cities, ...state.places].filter(validPoint).map(entry => state.projectPoint(entry.lat, entry.lng));
    state.map.invalidateSize({ pan: false });
    if (points.length === 1) state.map.setView(points[0], state.places.some(validPoint) ? 15 : 9);
    else if (points.length) state.map.fitBounds(points, { padding: [36, 36], maxZoom: state.places.some(validPoint) ? 14 : 9 });
    else state.map.setView([25, 30], 2);
  }

  function cancelPick() {
    const state = active;
    if (!state?.pick) return false;
    state.map.off('click', state.pick);
    state.pick = null;
    state.container.classList.remove('is-picking');
    if (state.pickButton) state.pickButton.hidden = true;
    state.message = '';
    updateStatus(state);
    return true;
  }

  function pickPoint(name, onSelect) {
    const state = active;
    if (!state?.map || !isActive(state)) return false;
    cancelPick();
    state.message = `缩放或拖动地图，点一下「${name}」的位置。`;
    state.container.classList.add('is-picking');
    state.pickButton = document.getElementById('footprintsCancelPick');
    if (state.pickButton) state.pickButton.hidden = false;
    state.pick = event => {
      cancelPick();
      onSelect(event.latlng);
    };
    state.map.on('click', state.pick);
    updateStatus(state);
    state.container.scrollIntoView({ block: 'center', behavior: 'auto' });
    return true;
  }

  function focus(key) {
    const state = active;
    if (!state || !state.map || !isActive(state)) return false;
    const place = state.places.find(entry => entry.key === key);
    const entry = place || state.cities.find(city => city.key === key);
    const marker = state.markers.get(key);
    if (!validPoint(entry) || !marker) return false;
    state.container.scrollIntoView({ block: 'center', behavior: 'auto' });
    state.map.invalidateSize({ pan: false });
    if (place && place.source !== 'city') {
      state.map.setView(state.projectPoint(place.lat, place.lng), 16);
    } else {
      const nearby = state.places.filter(point => validPoint(point) && (point.city === entry.name ||
        (Math.abs(point.lat - entry.lat) <= 0.2 && Math.abs(point.lng - entry.lng) <= 0.2)));
      if (nearby.length) {
        const bounds = [entry, ...nearby].map(point => state.projectPoint(point.lat, point.lng));
        state.map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13 });
      } else state.map.setView(state.projectPoint(entry.lat, entry.lng), 12);
    }
    marker.openPopup();
    return true;
  }

  function destroy() {
    const state = active;
    cancelPick();
    active = null;
    if (!state) return;
    if (state.controller) state.controller.abort();
    if (state.resizeObserver) state.resizeObserver.disconnect();
    if (state.resizeHandler) window.removeEventListener('resize', state.resizeHandler);
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    if (state.map) state.map.remove();
  }

  function mount(summary, { onCitiesChange, projectPoint } = {}) {
    destroy();
    const container = document.getElementById('footprintsMap');
    if (!container) return;
    const state = {
      container, cities: decorate(summary && summary.cities), places: summary?.places || [], onCitiesChange,
      projectPoint: typeof projectPoint === 'function' ? projectPoint : (lat, lng) => [lat, lng],
      map: null, layer: null, markers: new Map(), controller: null,
      resizeObserver: null, resizeHandler: null, resizeTimer: null,
      tileError: false, message: '',
    };
    active = state;
    if (typeof L === 'undefined') {
      state.message = '地图暂时不可用，旅行统计和城市列表仍可查看。';
      updateStatus(state);
      return;
    }
    state.map = L.map(container, { zoomControl: true, scrollWheelZoom: false });
    state.layer = L.featureGroup().addTo(state.map);
    const tiles = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'], maxZoom: 18,
      attribution: '&copy; 高德地图',
    });
    tiles.on('loading', () => { if (isActive(state)) state.tileError = false; });
    tiles.on('tileerror', () => { state.tileError = true; updateStatus(state); });
    tiles.on('load', () => updateStatus(state));
    tiles.addTo(state.map);
    state.map.attributionControl.addAttribution('城市坐标 <a href="https://www.geonames.org/" target="_blank" rel="noopener">&copy; GeoNames</a>');
    if (state.places.some(place => place.source === 'wikidata')) {
      state.map.attributionControl.addAttribution('地点坐标 <a href="https://www.wikidata.org/" target="_blank" rel="noopener">Wikidata</a>');
    }
    creditCitySearch(state);
    drawCities(state);
    fit();
    const resize = () => {
      if (!isActive(state)) return;
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(() => {
        if (isActive(state)) state.map.invalidateSize({ pan: false });
      }, 60);
    };
    if (typeof ResizeObserver !== 'undefined') {
      state.resizeObserver = new ResizeObserver(resize);
      state.resizeObserver.observe(container);
    } else {
      state.resizeHandler = resize;
      window.addEventListener('resize', resize);
    }
    resize();
  }

  async function locate(key) {
    const state = active;
    if (!state || !isActive(state)) return false;
    const city = state.cities.find(entry => entry.key === key);
    if (!city) return false;
    if (validPoint(city)) return focus(key);
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const query = /^[\u3400-\u9fff]{2}$/.test(city.name) ? `${city.name}市` : city.name;
    if (query.length < 3 || query.length > 120) {
      state.message = '请在旅行目的地中填写完整城市名称后重新定位。';
      updateStatus(state);
      state.controller = null;
      return false;
    }
    state.message = `正在定位 ${city.name}…`;
    updateStatus(state);
    try {
      const results = await Store.searchPlaces(query, { signal: controller.signal });
      if (!isActive(state) || controller.signal.aborted) return false;
      const normalize = value => window.Footprints.cityKey(value);
      const points = new Map();
      (Array.isArray(results) ? results : []).filter(result =>
        ['city', 'town', 'municipality'].includes(result.type)
        && normalize(result.name) === normalize(city.name) && validPoint(result)
      ).forEach(result => {
        const lat = Number(result.lat);
        const lng = Number(result.lng);
        points.set(`${lat.toFixed(5)},${lng.toFixed(5)}`, { lat, lng });
      });
      if (points.size !== 1) {
        state.message = points.size > 1
          ? `${city.name} 存在多个同名城市，暂不自动标记，请使用更明确的城市名称。`
          : `暂未找到 ${city.name} 的城市位置，请在旅行目的地中填写城市名；统计数据仍然保留。`;
        updateStatus(state);
        return false;
      }
      resolvedCities.set(key, points.values().next().value);
      state.cities = decorate(state.cities);
      creditCitySearch(state);
      state.message = '';
      drawCities(state);
      if (typeof state.onCitiesChange === 'function') state.onCitiesChange(state.cities);
      focus(key);
      return true;
    } catch (error) {
      if (!isActive(state) || controller.signal.aborted || error.name === 'AbortError') return false;
      state.message = `${city.name} 暂时无法定位，请稍后再试；统计数据仍然保留。`;
      updateStatus(state);
      return false;
    } finally {
      if (isActive(state) && state.controller === controller) state.controller = null;
    }
  }

  return { decorate, mount, destroy, focus, fit, locate, pickPoint, cancelPick };
})();
