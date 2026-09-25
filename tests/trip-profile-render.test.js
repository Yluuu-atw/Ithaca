'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('trip profile choices hide another member’s appearance and retain the current one', () => {
  const roster = [
    { id: 'mine', kind: 'formal', name: 'owner', displayName: 'Account Name', avatar: '😎', color: '#c4714b', tripNickname: '' },
    { id: 'other', kind: 'formal', name: 'other', displayName: 'Other', avatar: '🐱', color: '#7d94a8' },
  ];
  const store = {
    getRoster: () => roster,
    getIdentity: () => 0,
    getAppearanceChoices: () => ({ avatars: ['😎', '🐱', '🐶'], colors: ['#c4714b', '#7d94a8', '#8b9a7e'] }),
    canManageTrip: () => true,
  };
  const context = { window: {}, Store: store, Theme: { DARK_BG: '#202020' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/render.js'), 'utf8'), context);
  const html = context.window.Render.tripProfileEditor(roster[0], 'Account Name');
  assert.match(html, /name="tripNickname" value="Account Name"/);
  assert.match(html, /name="inheritNickname" value="1"/);
  assert.match(html, /data-value="😎"/);
  assert.match(html, /data-value="🐶"/);
  assert.doesNotMatch(html, /data-value="🐱"/);
  assert.match(html, /data-value="#c4714b"/);
  assert.match(html, /data-value="#8b9a7e"/);
  assert.doesNotMatch(html, /data-value="#7d94a8"/);
  assert.match(html, /vendor\/fluent-emoji\/1f60e.png/);
  const identity = context.window.Render.identityPicker({ meta: { members: ['owner', 'other'], avatars: ['😎', '🐱'], colors: ['#c4714b', '#7d94a8'] } });
  assert.match(identity, /data-action="trip-profile-open"/);
  store.getAppearanceChoices = () => ({ avatars: ['😎', '🐱'], colors: ['#c4714b', '#7d94a8'] });
  const exhausted = context.window.Render.tripProfileEditor(roster[0], 'Account Name');
  assert.match(exhausted, /当前旅行没有其他可用头像/);
  assert.match(exhausted, /当前旅行没有其他可用颜色/);
});
