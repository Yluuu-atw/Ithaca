'use strict';

const sharp = require('sharp');

const WIDTH = 1080;
const MIN_HEIGHT = 1080;
const MAX_HEIGHT = 12000;
const MAX_INPUT_PIXELS = 26_000_000;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const BLOCK = 16;
const STRENGTH = 24;
const PACKET_BYTES = 37;
const BIT_COUNT = PACKET_BYTES * 8;
const DECODE_OPTIONS = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS };
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BASIS = new Float64Array(BLOCK * BLOCK);

// IWM1 carries a locator, not proof that the surrounding pixels are authentic.
// Coefficient quantization and repetition tolerate common image re-encoding.
for (let y = 0; y < BLOCK; y++) {
  for (let x = 0; x < BLOCK; x++) {
    BASIS[y * BLOCK + x] = (2 / BLOCK) * (
      Math.cos(Math.PI * (2 * x + 1) / (2 * BLOCK)) * Math.cos(Math.PI * (2 * y + 1) * 2 / (2 * BLOCK))
      - Math.cos(Math.PI * (2 * x + 1) * 2 / (2 * BLOCK)) * Math.cos(Math.PI * (2 * y + 1) / (2 * BLOCK))
    );
  }
}

function invalid(message = '无法读取这张图片') {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
}

function supportedHeight(height) {
  return Number.isInteger(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT;
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(id)
    && Buffer.from(id, 'base64url').toString('base64url') === id;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPacket({ id, page, height }) {
  if (!validId(id) || !Number.isInteger(page) || page < 1 || page > 20 || !supportedHeight(height)) {
    throw invalid('凭证水印参数无效');
  }
  const bytes = Buffer.alloc(PACKET_BYTES);
  bytes.write('IWM1', 0, 'ascii');
  Buffer.from(id, 'base64url').copy(bytes, 4);
  bytes.writeUInt8(page, 28);
  bytes.writeUInt32BE(height, 29);
  // CRC detects transmission errors; authentication requires the signed record.
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 33)), 33);
  return bytes;
}

function readPacket(bytes, candidateHeight) {
  if (bytes.subarray(0, 4).toString('ascii') !== 'IWM1' || bytes.readUInt32BE(33) !== crc32(bytes.subarray(0, 33))) return null;
  const id = bytes.subarray(4, 28).toString('base64url');
  const page = bytes.readUInt8(28);
  const height = bytes.readUInt32BE(29);
  if (!validId(id) || page < 1 || page > 20 || !supportedHeight(height) || height !== candidateHeight) return null;
  return { id, page, height };
}

function formatOf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_INPUT_BYTES) throw invalid('图片文件大小不支持');
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw invalid('请选择 PNG、JPEG 或 WebP 图片');
}

function rejectAnimatedPng(bytes) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw invalid('不支持动态图');
    offset += length + 12;
    if (type === 'IEND') return;
  }
  throw invalid();
}

async function inspect(bytes, pngOnly = false) {
  const format = formatOf(bytes);
  if (pngOnly && format !== 'png') throw invalid('凭证生成图片必须为 PNG');
  if (format === 'png') rejectAnimatedPng(bytes);
  const metadata = await sharp(bytes, DECODE_OPTIONS).metadata();
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (metadata.format !== format || (metadata.pages || 1) !== 1
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > MAX_INPUT_PIXELS) throw invalid('图片尺寸或格式不支持');
  if (metadata.hasAlpha && !(await sharp(bytes, DECODE_OPTIONS).stats()).isOpaque) throw invalid('请选择不含透明区域的图片');
  return { width, height };
}

function dither(index) {
  let value = (index + 1) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296 - 0.5;
}

function coefficient(data, width, blockX, blockY) {
  let result = 0;
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const pixel = ((blockY + y) * width + blockX + x) * 3;
      const luminance = 0.299 * data[pixel] + 0.587 * data[pixel + 1] + 0.114 * data[pixel + 2];
      result += luminance * BASIS[y * BLOCK + x];
    }
  }
  return result;
}

function embedPixels(data, { width, height }, bytes) {
  const encoded = Buffer.from(data);
  let blockIndex = 0;
  for (let by = 0; by + BLOCK <= height; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= width; bx += BLOCK, blockIndex++) {
      const position = (blockIndex * 137) % BIT_COUNT;
      const bit = (bytes[position >>> 3] >>> (7 - (position & 7))) & 1;
      const before = coefficient(data, width, bx, by);
      const shift = dither(blockIndex);
      const target = (2 * Math.round((before / STRENGTH - shift - bit) / 2) + bit + shift) * STRENGTH;
      const adjustment = (target - before) / 2;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const pixel = ((by + y) * width + bx + x) * 3;
          const change = adjustment * BASIS[y * BLOCK + x];
          for (let channel = 0; channel < 3; channel++) {
            encoded[pixel + channel] = Math.max(0, Math.min(255, Math.round(data[pixel + channel] + change)));
          }
        }
      }
    }
  }
  return encoded;
}

function extractPixels(data, { width, height }) {
  const votes = new Float64Array(BIT_COUNT);
  let blockIndex = 0;
  for (let by = 0; by + BLOCK <= height; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= width; bx += BLOCK, blockIndex++) {
      const position = (blockIndex * 137) % BIT_COUNT;
      const value = coefficient(data, width, bx, by);
      votes[position] += Math.cos(Math.PI * (value / STRENGTH - dither(blockIndex)));
    }
  }
  const bytes = Buffer.alloc(PACKET_BYTES);
  for (let index = 0; index < BIT_COUNT; index++) {
    if (votes[index] < 0) bytes[index >>> 3] |= 1 << (7 - (index & 7));
  }
  return readPacket(bytes, height);
}

async function embedWatermark(pngBuffer, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('凭证水印参数无效');
    const { id, page } = options;
    if (!validId(id) || !Number.isInteger(page) || page < 1 || page > 20) throw invalid('凭证水印参数无效');
    const dimensions = await inspect(pngBuffer, true);
    if (dimensions.width !== WIDTH || !supportedHeight(dimensions.height)) throw invalid('凭证图片尺寸不支持');
    const { data, info } = await sharp(pngBuffer, DECODE_OPTIONS).rotate().removeAlpha().toColourspace('srgb')
      .raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const encoded = embedPixels(data, info, createPacket({ id, page, height: info.height }));
    const check = extractPixels(encoded, info);
    if (!check || check.id !== id || check.page !== page) throw invalid('无法生成可读取的凭证水印');
    return await sharp(encoded, { raw: info }).png({ compressionLevel: 8 }).toBuffer();
  } catch (error) {
    if (error.statusCode === 422) throw error;
    throw invalid();
  }
}

async function extractWatermark(imageBuffer) {
  try {
    const dimensions = await inspect(imageBuffer);
    const estimatedHeight = Math.round(dimensions.height * WIDTH / dimensions.width);
    // Integer resize rounding can move the inferred original height by one pixel.
    for (const offset of [0, -1, 1]) {
      const height = estimatedHeight + offset;
      if (!supportedHeight(height)) continue;
      const { data, info } = await sharp(imageBuffer, DECODE_OPTIONS).rotate().removeAlpha().toColourspace('srgb')
        .resize({ width: WIDTH, height, fit: 'fill', kernel: 'lanczos3' })
        .raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
      const result = extractPixels(data, info);
      if (result) return result;
    }
    return null;
  } catch (error) {
    if (error.statusCode === 422) throw error;
    throw invalid();
  }
}

module.exports = { embedWatermark, extractWatermark };
