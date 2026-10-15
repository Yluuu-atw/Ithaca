'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { embedWatermark, extractWatermark } = require('../data/voucher-watermark');

const ID = Buffer.from('0123456789abcdefghijklmn').toString('base64url');
const WIDTH = 1080;
const HEIGHT = 1441;
let fixturePromise;

function fixture() {
  if (!fixturePromise) fixturePromise = (async () => {
    const source = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#f2ece0' } })
      .composite([{ input: Buffer.from(`<svg width="1080" height="1441"><rect x="48" y="160" width="984" height="1000" rx="20" fill="#faf9f6"/><path d="M100 260h600v12H100z M100 320h380v24H100z M100 410h740v12H100z M100 480h610v12H100z M100 560h420v12H100z" fill="#393732"/></svg>`) }])
      .png().toBuffer();
    return { source, marked: await embedWatermark(source, { id: ID, page: 2 }) };
  })();
  return fixturePromise;
}

test('pixel watermark locators survive supported image transformations without requiring identical file bytes', async () => {
  const { source, marked } = await fixture();
  assert.notDeepEqual(source, marked);
  const metadata = await sharp(marked).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.channels, 3);
  assert.equal(metadata.hasAlpha, false);
  const expected = { id: ID, page: 2, height: HEIGHT };
  for (const transformed of [
    marked,
    await sharp(marked).jpeg({ quality: 75 }).toBuffer(),
    await sharp(marked).webp({ quality: 80 }).toBuffer(),
    await sharp(marked).resize({ width: 540 }).jpeg({ quality: 85 }).toBuffer(),
  ]) assert.deepEqual(await extractWatermark(transformed), expected);
  assert.equal(await extractWatermark(source), null);
});

test('watermark extraction only identifies a record and cannot establish content integrity', async () => {
  const { marked } = await fixture();
  const replacement = await sharp({ create: { width: 120, height: 55, channels: 3, background: '#ff3030' } }).png().toBuffer();
  const altered = await sharp(marked).composite([{ input: replacement, top: 300, left: 240 }]).png().toBuffer();
  assert.notDeepEqual(altered, marked);
  const locator = await extractWatermark(altered);
  assert.deepEqual(locator, { id: ID, page: 2, height: HEIGHT });
  assert.deepEqual(Object.keys(locator).sort(), ['height', 'id', 'page']);
  const cropped = await sharp(marked).extract({ left: 0, top: 0, width: WIDTH, height: HEIGHT - 40 }).png().toBuffer();
  assert.equal(await extractWatermark(cropped), null);
});

test('watermark image boundaries reject invalid payloads, unsafe formats, transparency and oversized inputs', async () => {
  const { source } = await fixture();
  const rejected = { statusCode: 422 };
  for (const options of [null, { id: ID, page: 0 }, { id: ID, page: 21 }, { id: ID, page: 1.5 },
    { id: `${ID}=`, page: 1 }, { id: 'a'.repeat(31), page: 1 }, { id: '/'.repeat(32), page: 1 }]) {
    await assert.rejects(embedWatermark(source, options), rejected);
  }
  for (const input of ['/tmp/source.png', Buffer.from('<svg width="1080" height="1440"></svg>'),
    Buffer.from('GIF89a-not-an-image'), Buffer.from('II*\0-not-an-image'), source.subarray(0, 40), Buffer.alloc(32 * 1024 * 1024 + 1)]) {
    await assert.rejects(extractWatermark(input), rejected);
  }
  const transparent = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#00000000' } }).png().toBuffer();
  await assert.rejects(extractWatermark(transparent), rejected);
  const small = await sharp({ create: { width: 1080, height: 1079, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(embedWatermark(small, { id: ID, page: 1 }), rejected);
  const wide = await sharp({ create: { width: 1079, height: HEIGHT, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(embedWatermark(wide, { id: ID, page: 1 }), rejected);
  const large = await sharp({ create: { width: 5100, height: 5100, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(extractWatermark(large), rejected);
  // Reject APNG control chunks even when the installed decoder exposes only the default frame.
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0);
  animation.write('acTL', 4, 'ascii');
  animation.writeUInt32BE(2, 8);
  const apng = Buffer.concat([source.subarray(0, 33), animation, source.subarray(33)]);
  await assert.rejects(extractWatermark(apng), rejected);
});
