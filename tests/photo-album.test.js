'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sharp = require('sharp');
const exifr = require('../public/vendor/exifr/lite.umd.js');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/photo-album.js'), 'utf8'), context);
const album = context.window.PhotoAlbum;

test('trip date ranges include unscheduled days and preserve older photos outside the range', () => {
  const trip = {
    meta: { startDate: '2028-02-28', endDate: '2028-03-01' },
    itinerary: [{ date: '2028-03-01' }],
    photos: [{ id: 'leap', date: '2028-02-29' }, { id: 'old', date: '2028-02-27' }, { id: 'no-date' }],
  };
  assert.deepEqual(Array.from(album.tripDays(trip)), ['2028-02-28', '2028-02-29', '2028-03-01']);
  const groups = album.albums(trip);
  assert.deepEqual(Array.from(groups, day => day.key), ['2028-02-28', '2028-02-29', '2028-03-01', '2028-02-27', 'undated']);
  assert.equal(groups[1].photos[0].id, 'leap');
  assert.equal(groups[4].photos[0].id, 'no-date');
});

test('capture date keeps the camera calendar day and never substitutes an edit date', async () => {
  const image = () => sharp({ create: { width: 6, height: 6, channels: 3, background: '#846974' } });
  const original = await image().withExif({
    IFD0: { DateTime: '2026:11:27 08:00:00' },
    IFD2: { DateTimeOriginal: '2026:11:22 23:50:00', OffsetTimeOriginal: '-08:00' },
  }).jpeg().toBuffer();
  const edited = await image().withExif({ IFD0: { DateTime: '2026:11:27 08:00:00' } }).jpeg().toBuffer();
  assert.equal(await album.captureDate(original, exifr), '2026-11-22');
  assert.equal(await album.captureDate(edited, exifr), '');
  assert.equal(await album.captureDate(await image().jpeg().toBuffer(), exifr), '');
});
