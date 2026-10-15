'use strict';

const sharp = require('sharp');

const LIMIT_PIXELS = 26_000_000;
const MAX_BYTES = 32 * 1024 * 1024;
const INPUT_OPTIONS = { failOn: 'error', limitInputPixels: LIMIT_PIXELS, sequentialRead: true };
const undecided = reason => ({ state: 'inconclusive', reason });

function imageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_BYTES) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function isAnimated(buffer, format) {
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) return true;
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
      offset += length + 12;
    }
  } else if (format === 'webp') {
    for (let offset = 12; offset + 8 <= buffer.length;) {
      const length = buffer.readUInt32LE(offset + 4);
      if (length > buffer.length - offset - 8) return true;
      const type = buffer.toString('ascii', offset, offset + 4);
      if (type === 'ANIM' || type === 'ANMF') return true;
      if (type === 'VP8X' && length > 0 && (buffer[offset + 8] & 2)) return true;
      offset += length + 8 + (length & 1);
    }
  }
  return false;
}

async function inspect(buffer) {
  const format = imageFormat(buffer);
  if (!format) return { error: 'unsupported_image' };
  if (isAnimated(buffer, format)) return { error: 'animated_image' };
  const metadata = await sharp(buffer, INPUT_OPTIONS).metadata();
  if (metadata.format !== format || metadata.depth !== 'uchar') return { error: 'unsupported_image' };
  if ((metadata.pages || 1) !== 1) return { error: 'animated_image' };
  if (metadata.orientation && metadata.orientation !== 1) return { error: 'image_orientation' };
  const { width, height } = metadata;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > LIMIT_PIXELS) return { error: 'image_dimensions' };
  if (metadata.hasAlpha && !(await sharp(buffer, INPUT_OPTIONS).stats()).isOpaque) return { error: 'transparent_image' };
  return { width, height };
}

async function normalize(buffer, width, height) {
  const result = await sharp(buffer, INPUT_OPTIONS).removeAlpha().resize({ width, kernel: 'lanczos3' })
    .toColourspace('srgb').blur(0.6).raw().toBuffer({ resolveWithObject: true });
  if (result.info.width !== width || result.info.height !== height || result.info.channels !== 3 || result.data.length !== width * height * 3) return null;
  return result.data;
}

function patchWindow(width, size) {
  const ring = new Float32Array(width * size);
  const columns = new Float64Array(width);
  let maximum = 0;
  return {
    add(row, y) {
      const offset = (y % size) * width;
      for (let x = 0; x < width; x++) {
        columns[x] += row[x] - ring[offset + x];
        ring[offset + x] = row[x];
      }
      if (y + 1 < size) return;
      let sum = 0;
      for (let x = 0; x < width; x++) {
        sum += columns[x];
        if (x >= size) sum -= columns[x - size];
        if (x + 1 >= size) maximum = Math.max(maximum, sum / (size * size));
      }
    },
    get maximum() { return maximum; },
  };
}

function comparePixels(reference, candidate, width, height) {
  const patchSize = Math.max(6, Math.round(10 * width / 1080));
  const patch = patchWindow(width, patchSize);
  const micro = patchWindow(width, Math.max(3, Math.round(4 * width / 1080)));
  const color = patchWindow(width, patchSize);
  const luminanceRow = new Float32Array(width);
  const colorRow = new Float32Array(width);
  let strongDifferences = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const red = reference[i] - candidate[i];
      const green = reference[i + 1] - candidate[i + 1];
      const blue = reference[i + 2] - candidate[i + 2];
      const difference = Math.abs(0.2126 * red + 0.7152 * green + 0.0722 * blue);
      luminanceRow[x] = difference;
      colorRow[x] = Math.max(Math.abs(red), Math.abs(green), Math.abs(blue));
      if (difference >= 24) strongDifferences++;
    }
    patch.add(luminanceRow, y);
    micro.add(luminanceRow, y);
    color.add(colorRow, y);
  }
  // Widespread differences cannot distinguish a displaced/cropped image from
  // extensive editing. This guard only rejects; it never grants a match.
  if (strongDifferences > width * height * 0.01) return undecided('image_alignment');
  if (patch.maximum >= 32 || micro.maximum >= 48) return { state: 'different', reason: 'local_difference' };
  if (patch.maximum > 11 || micro.maximum > 18 || color.maximum > 32) return undecided('lossy_ambiguous');
  return { state: 'matched', reason: 'content_match' };
}

// The caller must authenticate the stored reference first. A match means that
// no supported local content change was detected, not exact byte equality.
async function compareContent(referenceBuffer, candidateBuffer) {
  try {
    const reference = await inspect(referenceBuffer);
    if (reference.error) return undecided(reference.error);
    const candidate = await inspect(candidateBuffer);
    if (candidate.error) return undecided(candidate.error);
    if (reference.width !== 1080 || reference.height < 10 || reference.height > 12000) return undecided('reference_dimensions');
    if (candidate.width < 720 || candidate.width > 2160) return undecided('image_resolution');
    const expectedHeight = reference.height * candidate.width / reference.width;
    if (Math.abs(candidate.height - expectedHeight) > 1) return undecided('image_geometry');
    const width = Math.min(reference.width, candidate.width);
    const height = Math.round(reference.height * width / reference.width);
    const a = await normalize(referenceBuffer, width, height);
    const b = await normalize(candidateBuffer, width, height);
    if (!a || !b) return undecided('image_geometry');
    return comparePixels(a, b, width, height);
  } catch (_) {
    return undecided('image_decode');
  }
}

module.exports = { compareContent };
