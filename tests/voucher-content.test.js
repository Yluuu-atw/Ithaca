'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { compareContent } = require('../data/voucher-content');

async function fixture(dark = false) {
  const background = dark ? '#202329' : '#fafaf9';
  const ink = dark ? '#dedad0' : '#302c27';
  const artwork = Buffer.from(`<svg width="1080" height="600"><rect width="1080" height="600" fill="${background}"/><g fill="${ink}"><path d="M80 80h240v7H80zm0 20h180v7H80zm0 20h220v7H80zm0 110h180v5H80zm0 20h200v5H80z"/><path d="M280 280h8v60h-8zm22 0h35v8h-35zm27 8h8v20h-8zm-27 20h35v8h-35zm0 8h8v24h-8zm0 16h35v8h-35z"/><path d="M350 280h35v8h-35zm0 26h35v8h-35zm0 26h35v8h-35zm0-52h8v60h-8zm27 0h8v60h-8z"/><rect x="401" y="336" width="4" height="4"/><path d="M420 280h35v8h-35zm0 52h35v8h-35zm0-52h8v60h-8zm27 0h8v60h-8z"/></g></svg>`);
  return { buffer: await sharp(artwork).png().toBuffer(), background };
}

test('voucher content comparison accepts supported image encodings and proportional resizing', async () => {
  for (const dark of [false, true]) {
    const { buffer } = await fixture(dark);
    for (const width of [1080, 810, 720]) {
      for (const format of ['png', 'jpeg', 'webp']) {
        const candidate = await sharp(buffer).resize({ width }).toFormat(format, { quality: 85 }).toBuffer();
        assert.deepEqual(await compareContent(buffer, candidate), { state: 'matched', reason: 'content_match' }, `${dark ? 'dark' : 'light'} ${width} ${format}`);
      }
    }
  }
});

test('local edits including a four-pixel decimal cannot pass by averaging the surrounding page', async () => {
  for (const dark of [false, true]) {
    const { buffer, background } = await fixture(dark);
    for (const rect of [{ left: 401, top: 336, width: 4, height: 4 }, { left: 350, top: 285, width: 8, height: 45 }, { left: 80, top: 80, width: 180, height: 48 }]) {
      const overlay = await sharp({ create: { width: rect.width, height: rect.height, channels: 3, background } }).png().toBuffer();
      const changed = await sharp(buffer).composite([{ input: overlay, left: rect.left, top: rect.top }]).png().toBuffer();
      for (const width of [1080, 720]) {
        const encoded = await sharp(changed).resize({ width }).jpeg({ quality: 85 }).toBuffer();
        assert.notEqual((await compareContent(buffer, encoded)).state, 'matched', `${dark ? 'dark' : 'light'} ${width} ${rect.left}`);
      }
    }
  }
});

test('unsupported geometry, hidden transparency and unrelated pixels never become a content match', async () => {
  const { buffer } = await fixture();
  const candidates = [
    await sharp(buffer).resize({ width: 540 }).png().toBuffer(),
    await sharp(buffer).resize({ width: 2161 }).png().toBuffer(),
    await sharp(buffer).extract({ left: 0, top: 0, width: 1070, height: 590 }).png().toBuffer(),
    await sharp(buffer).extract({ left: 18, top: 10, width: 1044, height: 580 }).resize(1080, 600).png().toBuffer(),
    await sharp(buffer).removeAlpha().ensureAlpha(0.9).png().toBuffer(),
    await sharp(buffer).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    await sharp({ create: { width: 1080, height: 600, channels: 3, background: '#aaa' } }).png().toBuffer(),
    Buffer.from('<svg width="1080" height="600"></svg>'),
    buffer.subarray(0, Math.floor(buffer.length / 2)),
    new Uint8Array(buffer),
    null,
  ];
  for (const candidate of candidates) {
    const result = await compareContent(buffer, candidate);
    assert.equal(result.state, 'inconclusive');
    assert.deepEqual(Object.keys(result).sort(), ['reason', 'state']);
  }
});

test('animation markers and invalid reference dimensions fail closed before pixel comparison', async () => {
  const { buffer } = await fixture();
  const animatedPng = Buffer.concat([buffer.subarray(0, 8), Buffer.from([0, 0, 0, 8]), Buffer.from('acTL'), Buffer.alloc(12), buffer.subarray(8)]);
  const animatedWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPANIM'), Buffer.alloc(4)]);
  for (const candidate of [animatedPng, animatedWebp]) {
    assert.deepEqual(await compareContent(buffer, candidate), { state: 'inconclusive', reason: 'animated_image' });
  }
  const narrowReference = await sharp(buffer).resize({ width: 720 }).png().toBuffer();
  assert.deepEqual(await compareContent(narrowReference, narrowReference), { state: 'inconclusive', reason: 'reference_dimensions' });
});
