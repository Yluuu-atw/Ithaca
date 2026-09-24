'use strict';

window.Theme = (() => {
  const DEFAULT_BG = '#f2ece0';
  const DARK_BG = '#283440';
  const BRAND_KEYS = [
    'paper', 'ink', 'latin', 'caption', 'accent', 'sky', 'mist', 'sun',
    'cloud', 'pavilion', 'pin', 'pinHole', 'road', 'divider',
    ...Array.from({ length: 9 }, (_, i) => `region${String(i + 1).padStart(2, '0')}`),
  ];

  function rgb(hex) {
    const value = String(hex || '').trim();
    const short = /^#([\da-f]{3})$/i.exec(value);
    const full = /^#([\da-f]{6})$/i.exec(value);
    const digits = short ? [...short[1]].map(c => c + c).join('') : full && full[1];
    if (!digits) return null;
    return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
  }

  function hex(channels) {
    return '#' + channels.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }

  function mix(a, b, weight) {
    const left = rgb(a), right = rgb(b);
    return hex(left.map((v, i) => v * (1 - weight) + right[i] * weight));
  }

  function hsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    const lightness = (max + min) / 2;
    const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
    return [hue, saturation, lightness];
  }

  function hslHex(hue, saturation, lightness) {
    const s = Math.max(0, Math.min(1, saturation));
    const l = Math.max(0, Math.min(1, lightness));
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const offset = l - chroma / 2;
    const segment = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0]
      : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma]
        : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
    return hex(segment.map(v => (v + offset) * 255));
  }

  function luminance(channels) {
    const linear = channels.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function derive(input) {
    const channels = rgb(input) || rgb(DEFAULT_BG);
    const base = hex(channels);
    const [hue, rawSaturation] = hsl(channels);
    const saturation = Math.max(rawSaturation, 0.34);
    const dark = luminance(channels) < 0.22;
    const css = {
      '--bg': base,
      '--surface': dark ? mix(base, '#ffffff', 0.08) : hslHex(hue, saturation * 0.22, 0.985),
      '--surface-2': dark ? mix(base, '#ffffff', 0.15) : hslHex(hue, saturation * 0.3, 0.955),
      '--border': dark ? mix(base, '#ffffff', 0.28) : hslHex(hue, saturation * 0.32, 0.885),
      '--line': dark ? mix(base, '#ffffff', 0.4) : '#a8997f',
      '--text': dark ? '#f5eee5' : '#3a3733',
      '--muted': dark ? '#c6beb4' : '#7d7468',
      '--primary': dark ? hslHex(hue, saturation, 0.38) : hslHex(hue, saturation, 0.62),
      '--primary-600': dark ? hslHex(hue, saturation * 0.9, 0.8) : hslHex(hue, saturation, 0.4),
      '--accent': dark ? '#d4b274' : '#d4a44c',
      '--danger': dark ? '#e48d88' : '#b5544c',
      '--chart-2': dark ? '#a9c398' : '#8b9a7e',
      '--chart-3': dark ? '#9cb8cb' : '#7d94a8',
      '--chart-4': dark ? '#d0a2ac' : '#c08e8e',
      '--chart-5': dark ? '#d4b274' : '#d4a44c',
      '--chart-6': dark ? '#b9a992' : '#a89478',
      '--shadow': dark ? '4px 5px 0 rgba(0, 0, 0, .28)' : '4px 5px 0 rgba(58, 55, 51, .14)',
      '--shadow-sm': dark ? '3px 3px 0 rgba(0, 0, 0, .24)' : '3px 3px 0 rgba(58, 55, 51, .12)',
      '--shadow-lift': dark ? '6px 7px 0 rgba(0, 0, 0, .32)' : '6px 7px 0 rgba(58, 55, 51, .18)',
    };
    css['--primary-soft'] = dark ? mix(base, css['--primary'], 0.28) : hslHex(hue, saturation * 0.55, 0.93);
    css['--accent-soft'] = dark ? mix(base, css['--accent'], 0.2) : '#f6ecd4';
    css['--danger-soft'] = dark ? mix(base, css['--danger'], 0.2) : '#f4dfdc';
    css['--chart-1'] = hslHex(hue, saturation, dark ? 0.65 : 0.55);

    const categoryColors = {
      flight: css['--chart-3'], train: css['--chart-2'], bus: css['--chart-5'],
      hotel: css['--chart-4'], other: css['--chart-6'], stay: css['--chart-4'],
      food: css['--chart-1'], scenic: css['--chart-2'], traffic: css['--chart-3'],
      shop: css['--chart-5'], fun: css['--chart-6'],
    };
    for (const [name, color] of Object.entries(categoryColors)) {
      css[`--cat-${name}`] = color;
      css[`--cat-${name}-soft`] = mix(dark ? base : css['--surface'], color, dark ? 0.2 : 0.13);
    }

    const surface = css['--surface'];
    const chart = [css['--chart-4'], css['--chart-5'], css['--chart-3'], css['--chart-5'],
      css['--chart-6'], css['--chart-2'], css['--chart-1'], css['--chart-3'], css['--chart-6']];
    const brand = {
      paper: surface,
      ink: css['--text'],
      latin: css['--muted'],
      caption: css['--muted'],
      accent: dark ? css['--accent'] : css['--primary'],
      sky: dark ? mix(base, css['--chart-3'], 0.25) : mix(base, surface, 0.5),
      mist: dark ? mix(css['--surface-2'], css['--chart-3'], 0.38) : mix(css['--border'], css['--primary-soft'], 0.35),
      sun: css['--accent'],
      cloud: dark ? mix(css['--surface-2'], css['--chart-3'], 0.25) : mix(css['--surface-2'], surface, 0.5),
      pavilion: css['--chart-6'],
      pin: dark ? css['--accent'] : css['--primary'],
      pinHole: surface,
      road: dark ? mix(css['--accent'], surface, 0.38) : surface,
      divider: dark ? mix(css['--text'], base, 0.55) : '#fffaf5',
    };
    chart.forEach((color, i) => {
      brand[`region${String(i + 1).padStart(2, '0')}`] = mix(color, surface, dark ? 0.42 : 0.32);
    });
    return { base, mode: dark ? 'dark' : 'light', css, brand };
  }

  function apply(input) {
    const theme = derive(input);
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.css)) root.style.setProperty(name, value);
    root.dataset.themeMode = theme.mode;
    root.style.colorScheme = theme.mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme.base;
    return theme;
  }

  return { BRAND_KEYS, DARK_BG, derive, apply, mix };
})();
