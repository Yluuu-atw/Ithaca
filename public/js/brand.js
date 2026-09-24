'use strict';

window.Brand = (() => {
  const paths = {
    icon: 'brand/icon.svg',
    header: 'brand/logo-header.svg',
    horizontal: 'brand/logo-horizontal.svg',
    favicon: 'brand/favicon.svg',
  };
  const templates = new Map();
  const rendered = new Map();
  let colors = null;
  let colorKey = '';
  let generation = 0;

  function load(name) {
    if (!templates.has(name)) {
      templates.set(name, fetch(paths[name]).then(response => {
        if (!response.ok) throw new Error(`Brand asset unavailable: ${paths[name]}`);
        return response.text();
      }));
    }
    return templates.get(name);
  }

  function recolor(source, palette) {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid brand SVG');
    const svg = doc.documentElement;
    for (const node of svg.querySelectorAll('[data-fill],[data-stroke],[data-stop]')) {
      for (const [key, attr] of [['data-fill', 'fill'], ['data-stroke', 'stroke'], ['data-stop', 'stop-color']]) {
        const name = node.getAttribute(key);
        if (!name || !palette[name]) continue;
        let color = palette[name];
        if (key === 'data-stop') {
          const other = palette[node.getAttribute('data-mix-with') || 'paper'];
          const weight = Math.max(0, Math.min(1, Number(node.getAttribute('data-mix') || 0)));
          color = Theme.mix(color, other, weight);
        }
        node.setAttribute(attr, color);
      }
    }
    return new XMLSerializer().serializeToString(svg);
  }

  async function uri(name, palette, key) {
    const id = `${name}:${key}`;
    if (!rendered.has(id)) {
      const svg = recolor(await load(name), palette);
      rendered.set(id, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    }
    return rendered.get(id);
  }

  async function refresh() {
    if (!colors) return;
    const token = ++generation;
    const nodes = [...document.querySelectorAll('[data-brand-asset]')];
    const names = [...new Set(nodes.map(node => node.dataset.brandAsset))].filter(name => paths[name]);
    try {
      const entries = await Promise.all(names.map(async name => [name, await uri(name, colors, colorKey)]));
      if (token !== generation) return;
      const urls = new Map(entries);
      for (const node of nodes) {
        if (!node.isConnected || !urls.has(node.dataset.brandAsset)) continue;
        const url = urls.get(node.dataset.brandAsset);
        if (node.tagName === 'LINK') node.href = url;
        else node.src = url;
      }
    } catch (error) {
      console.error('[brand]', error);
    }
  }

  function apply(palette) {
    const key = JSON.stringify(palette);
    if (key !== colorKey) {
      rendered.clear();
      colorKey = key;
    }
    colors = palette;
    refresh();
  }

  return { apply, refresh, recolor };
})();
