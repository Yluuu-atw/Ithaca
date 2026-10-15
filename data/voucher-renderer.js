'use strict';

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const QRCode = require('qrcode');
const Theme = require('../public/js/theme');
const { embedWatermark } = require('./voucher-watermark');

const WIDTH = 1080;
const MAX_HEIGHT = 12000;
const MAX_PAGES = 20;
const MARGIN = 48;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;
const PAD = 32;
const INNER_WIDTH = CONTENT_WIDTH - PAD * 2;
const FOOTER_HEIGHT = 272;
const QR_SIZE = 240;
const FONT = path.join(__dirname, '../public/vendor/fonts/noto-sans-cjk/NotoSansCJKsc-Regular.otf');
const LOGO = path.join(__dirname, '../public/brand/logo-header.svg');
const ICON = path.join(__dirname, '../public/brand/icon.svg');
const RECEIPT_TYPES = { flight: '机票', train: '火车票', bus: '汽车票', hotel: '住宿预订', other: '其他票据' };
const FONT_CACHE = path.resolve(process.env.ITHACA_DATA_DIR || __dirname, 'voucher-font-cache');

// Isolate Fontconfig from host fonts and unwritable user caches on both macOS and Linux.
syncFs.mkdirSync(FONT_CACHE, { recursive: true, mode: 0o700 });
const fontConfig = path.join(FONT_CACHE, 'fonts.conf');
syncFs.writeFileSync(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>${esc(path.dirname(FONT))}</dir><cachedir>${esc(FONT_CACHE)}</cachedir></fontconfig>`, { mode: 0o600 });
process.env.FONTCONFIG_FILE = fontConfig;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

function money(minor, currency) {
  if (!Number.isSafeInteger(minor)) fail('账单金额超出可导出范围');
  const amount = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${currency} ${Math.floor(amount / 100).toLocaleString('zh-CN')}.${String(amount % 100).padStart(2, '0')}`;
}

function checkAbort(signal) {
  if (signal) signal.throwIfAborted();
}

function fail(message) {
  const error = new Error(message);
  error.statusCode = 422;
  throw error;
}

async function textImage(value, { size = 30, color, width = INNER_WIDTH, bold = false, align = 'left' }) {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${esc(color)}">${esc(value || ' ')}</span>`,
      font: `Noto Sans CJK SC ${bold ? 'Bold ' : ''}${size}`,
      fontfile: FONT,
      width,
      wrap: 'word-char',
      align,
      spacing: Math.round(size * 0.24),
      dpi: 72,
      rgba: true,
    },
  }).png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

function recolorLogo(svg, palette) {
  return svg.replace(/<[^>]+>/g, tag => {
    for (const [token, attribute] of [['fill', 'fill'], ['stroke', 'stroke'], ['stop', 'stop-color']]) {
      const match = new RegExp(`data-${token}="([^"]+)"`).exec(tag);
      if (!match || !palette[match[1]]) continue;
      let color = palette[match[1]];
      const mixWith = /data-mix-with="([^"]+)"/.exec(tag);
      const weight = /data-mix="([^"]+)"/.exec(tag);
      if (mixWith && weight && palette[mixWith[1]]) color = Theme.mix(color, palette[mixWith[1]], Number(weight[1]));
      tag = tag.replace(new RegExp(`(^|\\s)${attribute}="[^"]*"`), `$1${attribute}="${color}"`);
    }
    return tag;
  });
}

async function renderVoucher({ snapshot, id, verificationUrl, outputDir, signal, onProgress = () => {} }) {
  checkAbort(signal);
  const { css, brand } = Theme.derive(snapshot.background);
  const ink = css['--text'];
  const muted = css['--muted'];
  const accent = css['--primary-600'];
  const currency = snapshot.trip.currency;
  const shortId = id.slice(0, 12);
  const groups = [];
  let measuredHeight = 0;
  let attachmentBytes = 0;
  const imageCount = snapshot.expenses.reduce((sum, expense) => sum + expense.images.length, 0);
  let imagesDone = 0;

  async function row(value, options = {}) {
    checkAbort(signal);
    const image = await textImage(value, { color: ink, ...options });
    checkAbort(signal);
    measuredHeight += image.height + 18;
    if (measuredHeight > MAX_PAGES * (MAX_HEIGHT - FOOTER_HEIGHT - MARGIN * 2)) fail(`凭证超过 ${MAX_PAGES} 张长图，请缩小导出范围`);
    return { height: image.height + 18, layers: [{ ...image, left: 0, top: 0 }] };
  }

  async function fieldRows(label, value, options = {}) {
    if (value === undefined || value === null || value === '') return [];
    const chars = Array.from(String(value));
    const rows = [];
    // Bound each raster row while retaining all text at semantic continuation boundaries.
    for (let offset = 0; offset < chars.length; offset += 480) {
      rows.push(await row(`${label}${offset ? '（续）' : ''}  ${chars.slice(offset, offset + 480).join('')}`, options));
    }
    return rows;
  }

  const scope = snapshot.filter === 'receipt' ? '票据筛选 · 部分账单' : '全部账单';
  const issued = new Intl.DateTimeFormat('zh-CN', {
    timeZone: snapshot.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(snapshot.issuedAt));
  const summary = [
    await row(scope, { size: 28, color: muted }),
    await row(money(snapshot.totalMinor, currency), { size: 62, color: accent, bold: true }),
    await row(`${snapshot.count} 笔账单`, { size: 28, color: muted }),
    ...await fieldRows('生成于', `${issued}（${snapshot.timeZone}）`, { size: 24, color: muted }),
  ];
  groups.push({ kind: 'summary', title: '账单汇总', rows: summary });
  const dayRows = [await row('每日汇总', { size: 32, bold: true })];
  for (const day of snapshot.days) {
    dayRows.push(await row(`${day.dayNumber > 0 ? `第 ${day.dayNumber} 天` : '旅行日期外'}  ·  ${day.date || '未填写日期'}     ${money(day.totalMinor, currency)}`, { size: 28 }));
  }
  groups.push({ title: '每日汇总', rows: dayRows });

  for (let index = 0; index < snapshot.expenses.length; index++) {
    checkAbort(signal);
    const expense = snapshot.expenses[index];
    const title = `${index + 1}. ${expense.title || '未命名账单'}`;
    const rows = [
      ...await fieldRows('', title, { size: 34, bold: true }),
      await row(money(expense.amountMinor, currency), { size: 44, bold: true, color: accent }),
      ...await fieldRows('时间', [expense.dayLabel, expense.date, expense.time].filter(Boolean).join(' · '), { size: 26, color: muted }),
      ...await fieldRows('分类', expense.category, { size: 26, color: muted }),
      ...await fieldRows('细分', expense.subCategory, { size: 26, color: muted }),
      ...await fieldRows('车次 / 航班号', expense.refNo, { size: 28 }),
      ...await fieldRows('付款人', expense.payerName || '未填写', { size: 28 }),
      ...await fieldRows('地点', expense.location, { size: 28 }),
      ...await fieldRows('备注', expense.note, { size: 28 }),
    ];
    if (expense.allocations.length) {
      rows.push(await row('分摊明细', { size: 27, bold: true, color: muted }));
      for (const member of expense.allocations) {
        rows.push(...await fieldRows('', `${member.name}  ·  分摊 ${money(member.shareMinor, currency)}${member.advancedMinor ? `  ·  垫付 ${money(member.advancedMinor, currency)}` : ''}`, { size: 27 }));
      }
    }
    if (expense.receipt) {
      const receipt = expense.receipt;
      rows.push(await row('票据信息', { size: 27, bold: true, color: muted }));
      const fields = [
        ['类型', RECEIPT_TYPES[receipt.type] || receipt.type],
        ['状态', receipt.status],
        ['出发', receipt.from], ['到达', receipt.to],
        ['起始时间', [receipt.date, receipt.time].filter(Boolean).join(' ')],
        ['结束时间', [receipt.endDate, receipt.endTime].filter(Boolean).join(' ')],
        ['服务方', receipt.carrier], ['座位', receipt.seat], ['编号', receipt.refNo],
      ];
      for (const [label, value] of fields) rows.push(...await fieldRows(label, value, { size: 26 }));
      if (receipt.priceMinor != null && (expense.amountMinor === 0 || receipt.priceMinor !== expense.amountMinor)) {
        rows.push(await row(`票据参考金额 ${money(receipt.priceMinor, currency)}（不另计入合计）`, { size: 26, color: muted }));
      }
      if (receipt.needsReview) rows.push(await row('票据信息待核对', { size: 26, color: muted }));
    }
    for (let attachment = 0; attachment < expense.images.length; attachment++) {
      checkAbort(signal);
      const image = expense.images[attachment];
      if (!path.isAbsolute(image.path)) fail('票据图片路径无效');
      onProgress({ stage: 'attachments', completed: imagesDone, total: imageCount });
      let rendered;
      try {
        rendered = await sharp(image.path, { limitInputPixels: 80_000_000 }).rotate()
          .resize({ width: INNER_WIDTH, height: 1800, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
      } catch {
        fail(`第 ${index + 1} 笔账单的第 ${attachment + 1} 张票据无法读取，请检查附件后重试`);
      }
      checkAbort(signal);
      attachmentBytes += rendered.data.length;
      if (attachmentBytes > 64 * 1024 * 1024) fail('票据预览内容过大，请取消附带预览或缩小导出范围');
      measuredHeight += rendered.info.height + 26;
      if (measuredHeight > MAX_PAGES * (MAX_HEIGHT - FOOTER_HEIGHT - MARGIN * 2)) fail(`凭证超过 ${MAX_PAGES} 张长图，请缩小导出范围`);
      rows.push(await row(`票据 ${attachment + 1}/${expense.images.length}`, { size: 24, color: muted }));
      rows.push({ height: rendered.info.height + 26, layers: [{ input: rendered.data, left: Math.floor((INNER_WIDTH - rendered.info.width) / 2), top: 0 }] });
      imagesDone++;
      onProgress({ stage: 'attachments', completed: imagesDone, total: imageCount });
    }
    groups.push({ title, rows });
    onProgress({ stage: 'layout', completed: index + 1, total: snapshot.expenses.length });
  }

  const logoSource = recolorLogo(await fs.readFile(LOGO, 'utf8'), brand);
  const logo = await sharp(Buffer.from(logoSource)).resize({ width: 320 }).png().toBuffer({ resolveWithObject: true });
  const heading = await textImage('账单凭证', { size: 42, color: ink, width: 480, bold: true });
  const tripName = await textImage(snapshot.trip.name, { size: 36, color: ink, width: CONTENT_WIDTH, bold: true });
  const headerHeight = Math.max(logo.info.height, heading.height) + tripName.height + 74;
  const bodyCapacity = MAX_HEIGHT - MARGIN * 2 - headerHeight - FOOTER_HEIGHT;
  if (bodyCapacity < 2200) fail('旅行名称过长，请缩短名称后导出');
  const pages = [];
  let current = { groups: [], used: 0 };
  function nextPage() {
    if (!current.groups.length) return;
    pages.push(current);
    if (pages.length >= MAX_PAGES) fail(`凭证超过 ${MAX_PAGES} 张长图，请缩小导出范围`);
    current = { groups: [], used: 0 };
  }
  for (const group of groups) {
    const groupHeight = group.rows.reduce((sum, item) => sum + item.height, 0) + PAD * 2 + 24;
    if (groupHeight <= bodyCapacity) {
      if (current.used + groupHeight > bodyCapacity) nextPage();
      current.groups.push({ ...group, height: groupHeight });
      current.used += groupHeight;
      continue;
    }
    if (current.groups.length) nextPage();
    let pending = [];
    let used = PAD * 2 + 24;
    const continued = await row(`${group.title}（续）`, { size: 30, bold: true, color: muted });
    for (const item of group.rows) {
      if (item.height + continued.height + PAD * 2 + 24 > bodyCapacity) fail('账单内容过长，无法完整排版');
      if (used + item.height > bodyCapacity) {
        current.groups.push({ ...group, rows: pending, height: used });
        current.used = used;
        nextPage();
        pending = [continued];
        used = PAD * 2 + 24 + continued.height;
      }
      pending.push(item);
      used += item.height;
    }
    current.groups.push({ ...group, rows: pending, height: used });
    current.used = used;
  }
  if (current.groups.length) pages.push(current);
  if (pages.length > MAX_PAGES) fail(`凭证超过 ${MAX_PAGES} 张长图，请缩小导出范围`);

  const qrBase = await QRCode.toBuffer(verificationUrl, { type: 'png', errorCorrectionLevel: 'H', width: QR_SIZE, margin: 4, color: { dark: '#202020ff', light: '#ffffffff' } });
  const badgeSize = 48;
  const badge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${badgeSize}" height="${badgeSize}"><rect width="100%" height="100%" rx="8" fill="#fff"/></svg>`);
  const icon = await sharp(Buffer.from(recolorLogo(await fs.readFile(ICON, 'utf8'), brand))).resize(badgeSize, badgeSize).png().toBuffer();
  const badgeOffset = (QR_SIZE - badgeSize) / 2;
  const qr = await sharp(qrBase).composite([
    { input: badge, left: badgeOffset, top: badgeOffset },
    { input: icon, left: badgeOffset, top: badgeOffset },
  ]).png().toBuffer();
  const verificationLabel = await textImage('扫码核验', { size: 28, color: ink, width: 690, bold: true });
  const results = [];
  await fs.mkdir(outputDir, { recursive: true });
  for (let index = 0; index < pages.length; index++) {
    checkAbort(signal);
    onProgress({ stage: 'rendering', completed: index, total: pages.length });
    const page = pages[index];
    const height = Math.max(1080, MARGIN * 2 + headerHeight + page.used + FOOTER_HEIGHT);
    const layers = [
      { input: logo.data, left: MARGIN, top: MARGIN },
      { input: heading.input, left: WIDTH - MARGIN - heading.width, top: MARGIN + 22 },
      { input: tripName.input, left: MARGIN, top: MARGIN + Math.max(logo.info.height, heading.height) + 28 },
    ];
    const cards = [];
    let y = MARGIN + headerHeight;
    for (const group of page.groups) {
      cards.push(`<rect x="${MARGIN}" y="${y}" width="${CONTENT_WIDTH}" height="${group.height - 24}" rx="22" fill="${css['--surface']}" stroke="${css['--border']}" stroke-width="2"/>`);
      let rowY = y + PAD;
      for (const item of group.rows) {
        for (const layer of item.layers) layers.push({ input: layer.input, left: MARGIN + PAD + layer.left, top: rowY + layer.top });
        rowY += item.height;
      }
      y += group.height;
    }
    const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"><rect width="100%" height="100%" fill="${css['--bg']}"/>${cards.join('')}</svg>`);
    const footY = height - MARGIN - FOOTER_HEIGHT + 16;
    layers.push({ input: verificationLabel.input, left: MARGIN, top: footY + 76 });
    const pageLabel = await textImage(`凭证 ${shortId}  ·  第 ${index + 1} / ${pages.length} 张`, { size: 25, color: ink, width: 690 });
    layers.push({ input: pageLabel.input, left: MARGIN, top: footY + 126 });
    layers.push({ input: qr, left: WIDTH - MARGIN - QR_SIZE, top: footY });
    const filename = `page-${index + 1}.png`;
    const previewFilename = `page-${index + 1}.webp`;
    const composed = await sharp(background).composite(layers).png().toBuffer();
    checkAbort(signal);
    onProgress({ stage: 'watermark', completed: index, total: pages.length });
    const marked = await embedWatermark(composed, { id, page: index + 1 });
    checkAbort(signal);
    await fs.writeFile(path.join(outputDir, filename), marked);
    checkAbort(signal);
    await sharp(marked).resize({ width: 540 }).webp({ quality: 80 }).toFile(path.join(outputDir, previewFilename));
    checkAbort(signal);
    results.push({ filename, previewFilename, width: WIDTH, height, watermark: 'ithaca-dct-v1' });
    onProgress({ stage: 'watermark', completed: index + 1, total: pages.length });
  }
  return { pages: results };
}

module.exports = { renderVoucher };
