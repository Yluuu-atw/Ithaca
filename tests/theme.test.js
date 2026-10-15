'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Theme = require('../public/js/theme');

test('browser and server derive the same complete theme and brand palettes', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/theme.js'), 'utf8'), context);
  const keys = Object.keys(Theme.derive('#f2ece0').css).sort();
  for (const base of ['#f2ece0', '#283440', '#000000', '#ffffff', '#215930', '#f4c', 'invalid']) {
    const actual = Theme.derive(base);
    assert.deepEqual(actual, JSON.parse(JSON.stringify(context.window.Theme.derive(base))));
    assert.deepEqual(Object.keys(actual.css).sort(), keys);
    assert.deepEqual(Object.keys(actual.brand).sort(), [...Theme.BRAND_KEYS].sort());
    for (const value of Object.values(actual.brand)) assert.match(value, /^#[a-f0-9]{6}$/);
  }
  assert.equal(Theme.derive('#283440').mode, 'dark');
  assert.equal(Theme.derive('#f2ece0').mode, 'light');
});
