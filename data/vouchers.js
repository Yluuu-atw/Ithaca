'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { calculateTransfers } = require('./settlement');
const { publicRoster } = require('./people');
const { runImageCheck } = require('./voucher-image-check');

const ID = /^[A-Za-z0-9_-]{32}$/;
const FILE = /^page-[1-9][0-9]*\.(png|webp)$/;
const MAX_EXPENSES = 500;
const MAX_IMAGES = 200;
const MAX_PAGES = 20;
const MAX_PENDING = 12;
const JOB_TTL = 24 * 60 * 60 * 1000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

class VoucherError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}

function fail(message, status) { throw new VoucherError(message, status); }
function text(value, label, max = 5000) {
  const result = value == null ? '' : String(value);
  if (result.length > max) fail(`${label}过长，请缩短后再导出`);
  return result;
}

function member(db, principal, tripId) {
  const trip = db.trips.find(entry => entry.id === tripId);
  const grant = db.access[tripId];
  if (!trip || !grant || !principal) fail('没有这趟旅行的访问权限', 403);
  const role = principal.userId && (grant.ownerId === principal.userId ? 'owner' : grant.members[principal.userId]);
  if (['owner', 'editor', 'viewer'].includes(role)) return { trip, grant, role, key: `user:${principal.userId}` };
  if (principal.tempTripId === tripId && grant.people.some(person =>
    person.kind === 'temporary' && person.id === principal.tempPersonId)) {
    return { trip, grant, role: 'temporary', key: `temporary:${tripId}:${principal.tempPersonId}` };
  }
  fail('仅旅行成员可以导出和读取凭证', 403);
}

function optionsFor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('导出参数无效');
  const allowed = new Set(['tripId', 'filter', 'includeReceipts', 'background', 'timeZone', 'requestId']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('导出参数包含不支持的字段');
  if (typeof input.tripId !== 'string' || !input.tripId || input.tripId.length > 200) fail('旅行编号无效');
  const filter = input.filter === undefined ? 'all' : input.filter;
  if (!['all', 'receipt'].includes(filter)) fail('导出范围无效');
  if (input.includeReceipts !== undefined && typeof input.includeReceipts !== 'boolean') fail('票据预览选项无效');
  const background = input.background === undefined ? '#f2ece0' : input.background;
  if (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)) fail('主题颜色无效');
  const timeZone = input.timeZone === undefined ? 'Asia/Shanghai' : input.timeZone;
  if (typeof timeZone !== 'string' || timeZone.length > 100) fail('时区无效');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch (_) { fail('时区无效'); }
  const requestId = input.requestId || '';
  if (requestId && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$|^[a-f0-9-]{36}$/i.test(requestId))) fail('请求编号无效');
  return { tripId: input.tripId, filter, includeReceipts: input.includeReceipts === true,
    background: background.toLowerCase(), timeZone, requestId };
}

function hasReceipt(expense) {
  return !!expense.receipt || Array.isArray(expense.images) && expense.images.length > 0;
}

function snapshotFor(db, principal, options, users, issuedAt) {
  const { trip, grant } = member(db, principal, options.tripId);
  const selected = trip.expenses.filter(expense => options.filter === 'all' || hasReceipt(expense));
  if (!selected.length) fail('当前范围没有可导出的账单');
  if (selected.length > MAX_EXPENSES) fail(`一次最多导出 ${MAX_EXPENSES} 笔账单，请缩小范围`);
  const allocations = new Map(calculateTransfers({ expenses: selected }, grant).allocations.map(row => [row.expenseId, row]));
  const labels = new Map(publicRoster(grant, users).map(person => [person.id, text(person.displayName, '成员昵称', 200)]));
  const people = new Map(grant.people.map(person => [person.name, person]));
  const allDates = [...new Set([...trip.itinerary.map(day => day.date), ...trip.expenses.map(expense => expense.date)].filter(Boolean))].sort();
  const dayNumber = date => {
    if (!date) return null;
    const diff = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${trip.meta.startDate}T00:00:00Z`)) / 86400000;
    return Number.isInteger(diff) && diff >= 0 ? diff + 1 : allDates.indexOf(date) + 1;
  };
  let imageCount = 0;
  const expenses = selected.map(expense => {
    const allocation = allocations.get(expense.id);
    if (!Number.isSafeInteger(allocation.amountMinor)) fail('账单金额超出可精确导出的范围');
    const participants = new Set(expense.participants.length ? expense.participants : grant.people.map(person => person.name));
    const payer = people.get(expense.payer);
    const receipt = expense.receipt && typeof expense.receipt === 'object' ? expense.receipt : null;
    const images = options.includeReceipts ? [...new Set([
      ...(Array.isArray(expense.images) ? expense.images : []),
      ...(receipt && Array.isArray(receipt.images) ? receipt.images : []),
    ])].map(url => {
      const match = typeof url === 'string' && /^\/uploads\/([A-Za-z0-9_.-]+)$/.exec(url);
      if (!match || match[1] === '.' || match[1] === '..' || !db.assets[match[1]] || db.assets[match[1]].tripId !== trip.id) {
        fail('票据附件不可访问，请检查附件后再导出');
      }
      imageCount++;
      return { filename: match[1] };
    }) : [];
    const receiptData = receipt ? Object.fromEntries(['type', 'status', 'from', 'to', 'date', 'time', 'endDate', 'endTime', 'carrier', 'seat', 'refNo']
      .map(key => [key, text(receipt[key], '票据信息')])) : null;
    if (receiptData) {
      receiptData.priceMinor = Math.round(Number(receipt.price || 0) * 100);
      if (!Number.isSafeInteger(receiptData.priceMinor)) fail('票据参考价超出可精确导出的范围');
      receiptData.needsReview = receipt.needsReview === true;
    }
    const date = text(expense.date, '账单日期', 100);
    const day = dayNumber(date);
    return {
      id: expense.id, title: text(expense.title, '账单名称'), date, time: text(expense.time, '账单时间', 100),
      dayLabel: day == null ? '未填写日期' : `第 ${day} 天`, category: text(expense.category || '其他', '账单分类', 100),
      subCategory: text(expense.subCategory, '账单分类', 100), refNo: text(expense.refNo, '车次或航班号', 200),
      amountMinor: allocation.amountMinor, payerName: payer ? labels.get(payer.id) : '共同垫付',
      allocations: grant.people.filter(person => participants.has(person.name) || allocation.advanced[person.id] || allocation.owed[person.id])
        .map(person => ({ personId: person.id, name: labels.get(person.id), advancedMinor: allocation.advanced[person.id], shareMinor: allocation.owed[person.id] })),
      location: text(expense.location, '账单地点'), note: text(expense.note, '账单备注'), receipt: receiptData, images,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  if (imageCount > MAX_IMAGES) fail(`一次最多附带 ${MAX_IMAGES} 张票据预览，请取消附带预览或缩小范围`);
  const days = [];
  let totalMinor = 0;
  for (const expense of expenses) {
    totalMinor += expense.amountMinor;
    if (!Number.isSafeInteger(totalMinor)) fail('账单合计超出可精确导出的范围');
    let day = days.find(entry => entry.date === expense.date);
    if (!day) { day = { date: expense.date, dayNumber: dayNumber(expense.date), totalMinor: 0, count: 0 }; days.push(day); }
    day.totalMinor += expense.amountMinor;
    day.count++;
    if (!Number.isSafeInteger(day.totalMinor)) fail('每日合计超出可精确导出的范围');
  }
  return { version: 1, trip: { id: trip.id, name: text(trip.meta.tripName, '旅行名称', 500),
    currency: text(trip.meta.currency, '币种', 20), startDate: trip.meta.startDate, endDate: trip.meta.endDate },
  issuedAt, timeZone: options.timeZone, background: options.background, filter: options.filter,
  includeReceipts: options.includeReceipts, totalMinor, count: expenses.length, days, expenses };
}

async function writeAtomic(filename, value, mode = 0o600) {
  const temporary = `${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(value), { mode, flag: 'wx' });
    await fsp.rename(temporary, filename);
  } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
}

function loadKey(dataDir, hasVouchers) {
  const directory = path.join(dataDir, 'voucher-keys');
  const filename = path.join(directory, 'key.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filename)) {
    if (hasVouchers) fail('凭证签名密钥缺失，请从完整备份恢复后再导出', 503);
    const pair = crypto.generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const value = { version: 1, keyId: sha256(Buffer.from(publicKey, 'base64')).slice(0, 32), publicKey,
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
    const temporary = path.join(directory, `key-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(temporary, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const publicKey = crypto.createPublicKey({ key: Buffer.from(value.publicKey, 'base64'), type: 'spki', format: 'der' });
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(value.privateKey, 'base64'), type: 'pkcs8', format: 'der' });
  if (value.version !== 1 || publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519'
    || value.keyId !== sha256(Buffer.from(value.publicKey, 'base64')).slice(0, 32)
    || !publicKey.equals(crypto.createPublicKey(privateKey))) fail('凭证签名密钥无效，请恢复完整备份', 503);
  fs.chmodSync(filename, 0o600);
  const published = { keyId: value.keyId, algorithm: 'Ed25519', format: 'spki', publicKey: value.publicKey };
  const publicFilename = path.join(directory, `public-${value.keyId}.json`);
  if (!fs.existsSync(publicFilename)) {
    fs.writeFileSync(publicFilename, JSON.stringify(published), { mode: 0o600, flag: 'wx' });
  } else if (JSON.stringify(JSON.parse(fs.readFileSync(publicFilename, 'utf8'))) !== JSON.stringify(published)) {
    fail('凭证公钥记录不一致，请恢复完整备份', 503);
  }
  return { ...value, privateObject: privateKey };
}

function createVoucherService({ dataDir, origin, getDb, render, getUsers = () => [] }) {
  const issuer = new URL(origin).origin;
  const directory = path.join(dataDir, 'vouchers');
  const records = new Map();
  const jobs = new Map();
  const requests = new Map();
  const rates = new Map();
  const queue = [];
  let running = false;
  let signingKey;
  let initializationError;
  const ready = initialize().catch(error => { initializationError = error; });

  async function initialize() {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.pending-')) { await fsp.rm(path.join(directory, entry.name), { recursive: true, force: true }); continue; }
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      const record = JSON.parse(await fsp.readFile(path.join(directory, entry.name, 'record.json'), 'utf8'));
      if (record.id !== entry.name) throw new Error('Voucher record identity mismatch');
      records.set(record.id, record);
      if (record.requestId) requests.set(`${record.creator}:${record.requestId}`, { id: record.id, optionsHash: record.optionsHash });
    }
  }

  async function available() {
    await ready;
    if (initializationError) fail('凭证存储不可用，请检查完整备份和服务日志', 503);
  }

  function key() {
    if (!signingKey) {
      try { signingKey = loadKey(dataDir, records.size > 0); }
      catch (error) { if (error instanceof VoucherError) throw error; fail('凭证签名密钥不可用，请恢复完整备份', 503); }
    }
    return signingKey;
  }

  function known(id) {
    if (!ID.test(id || '') || !records.has(id)) fail('找不到这份凭证', 404);
    return records.get(id);
  }

  async function state(record) {
    let result = JSON.parse(await fsp.readFile(path.join(directory, record.id, 'state.json'), 'utf8'));
    if (!result.revokedAt && !getDb().trips.some(trip => trip.id === record.tripId)) {
      result = { revokedAt: new Date().toISOString(), reason: 'trip-deleted' };
      await writeAtomic(path.join(directory, record.id, 'state.json'), result);
    }
    return result;
  }

  async function describe(record, principal) {
    const access = member(getDb(), principal, record.tripId);
    const current = await state(record);
    return { id: record.id, issuedAt: record.issuedAt, status: current.revokedAt ? 'revoked' : 'valid',
      filter: record.filter, includeReceipts: record.includeReceipts, count: record.count, totalMinor: record.totalMinor,
      currency: record.currency, pageCount: record.pages.length, canRevoke: access.role === 'owner' || access.key === record.creator,
      verificationUrl: `${issuer}/verify-voucher#${record.id}`,
      pages: record.pages.map((page, index) => ({ page: index + 1, width: page.width, height: page.height,
        imageUrl: `/api/vouchers/${record.id}/images/${index + 1}`, previewUrl: `/api/vouchers/${record.id}/previews/${index + 1}` })) };
  }

  async function describeJob(job, principal) {
    const access = member(getDb(), principal, job.tripId);
    if (access.key !== job.creator) fail('无法访问其他成员的导出任务', 403);
    return { id: job.id, status: job.status, progress: { ...job.progress }, createdAt: job.createdAt,
      result: job.status === 'completed' ? await describe(known(job.id), principal) : null, error: job.error || null };
  }

  function cleanupJobs() {
    const threshold = Date.now() - JOB_TTL;
    for (const [id, job] of jobs) if (!['queued', 'running'].includes(job.status) && Date.parse(job.createdAt) < threshold) {
      jobs.delete(id);
      if (job.requestKey && !records.has(id)) requests.delete(job.requestKey);
    }
    for (const [identity, timestamps] of rates) {
      const recent = timestamps.filter(value => value > Date.now() - 3600000);
      if (recent.length) rates.set(identity, recent); else rates.delete(identity);
    }
  }

  async function createJob(principal, input) {
    await available();
    const options = optionsFor(input);
    const access = member(getDb(), principal, options.tripId);
    cleanupJobs();
    const optionsHash = sha256(JSON.stringify({ ...options, requestId: '' }));
    const requestKey = options.requestId ? `${access.key}:${options.requestId}` : '';
    const prior = requestKey && requests.get(requestKey);
    if (prior) {
      if (prior.optionsHash !== optionsHash) fail('这次导出的参数已变化，请重新发起导出', 409);
      return getJob(principal, prior.id);
    }
    const active = [...jobs.values()].filter(job => ['queued', 'running'].includes(job.status));
    if (active.some(job => job.creator === access.key)) fail('已有凭证正在生成，请等待或先取消', 409);
    if (active.length >= MAX_PENDING) fail('导出任务较多，请稍后重试', 429);
    const timestamps = rates.get(access.key) || [];
    if (timestamps.length >= 8) fail('导出次数较多，请一小时后再试', 429);
    key();
    const createdAt = new Date().toISOString();
    const snapshot = snapshotFor(getDb(), principal, options, getUsers(), createdAt);
    const id = crypto.randomBytes(24).toString('base64url');
    const job = { id, creator: access.key, tripId: options.tripId, options, optionsHash, requestKey,
      principal: { ...principal }, snapshot, createdAt, status: 'queued', progress: { stage: 'queued', completed: 0, total: 0 },
      controller: new AbortController(), error: null };
    jobs.set(id, job);
    if (requestKey) requests.set(requestKey, { id, optionsHash });
    timestamps.push(Date.now());
    rates.set(access.key, timestamps);
    queue.push(job);
    const result = await describeJob(job, principal);
    void pump();
    return result;
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        if (job.status === 'cancelled') continue;
        await execute(job);
      }
    } finally { running = false; }
  }

  async function execute(job) {
    const outputDir = path.join(directory, `.pending-${job.id}`);
    const finalDir = path.join(directory, job.id);
    let published = false;
    const { signal } = job.controller;
    const check = () => { signal.throwIfAborted(); member(getDb(), job.principal, job.tripId); };
    try {
      check();
      job.status = 'running';
      job.progress = { stage: 'preparing', completed: 0, total: 0 };
      await fsp.mkdir(outputDir, { mode: 0o700 });
      const rendering = structuredClone(job.snapshot);
      for (const expense of rendering.expenses) for (const image of expense.images) {
        image.path = path.join(dataDir, 'uploads', image.filename);
        const info = await fsp.lstat(image.path).catch(() => null);
        if (!info || !info.isFile() || info.isSymbolicLink()) fail('票据原图缺失，无法生成完整凭证');
      }
      const result = await render({ snapshot: rendering, id: job.id, verificationUrl: `${issuer}/verify-voucher#${job.id}`,
        outputDir, signal, onProgress: progress => {
          check();
          if (!progress || !['attachments', 'layout', 'rendering', 'watermark'].includes(progress.stage)) return;
          job.progress = { stage: progress.stage, completed: Math.max(0, Number(progress.completed) || 0), total: Math.max(0, Number(progress.total) || 0) };
        } });
      check();
      const pages = result && result.pages;
      if (!Array.isArray(pages) || !pages.length || pages.length > MAX_PAGES) fail('凭证页数超限，请缩小导出范围');
      job.progress = { stage: 'signing', completed: 0, total: pages.length };
      const manifestPages = [];
      const savedPages = [];
      const used = new Set();
      let totalBytes = 0;
      for (const [index, page] of pages.entries()) {
        check();
        if (!page || !FILE.test(page.filename) || !page.filename.endsWith('.png')
          || !FILE.test(page.previewFilename) || !page.previewFilename.endsWith('.webp')
          || used.has(page.filename) || used.has(page.previewFilename)
          || !Number.isInteger(page.width) || page.width < 1 || page.width > 4096
          || !Number.isInteger(page.height) || page.height < 1 || page.height > 12000
          || page.watermark !== 'ithaca-dct-v1') fail('凭证图片格式无效');
        used.add(page.filename); used.add(page.previewFilename);
        for (const filename of [page.filename, page.previewFilename]) {
          const info = await fsp.lstat(path.join(outputDir, filename));
          if (!info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024) fail('凭证图片过大，请缩小导出范围');
          totalBytes += info.size;
          if (totalBytes > 250 * 1024 * 1024) fail('凭证总大小超限，请缩小导出范围');
          await fsp.chmod(path.join(outputDir, filename), 0o600);
        }
        const bytes = await fsp.readFile(path.join(outputDir, page.filename));
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('凭证图片格式无效');
        manifestPages.push({ page: index + 1, width: page.width, height: page.height, sha256: sha256(bytes), watermark: page.watermark });
        savedPages.push({ filename: page.filename, previewFilename: page.previewFilename, width: page.width, height: page.height });
        job.progress.completed = index + 1;
      }
      const signing = key();
      const manifest = { version: 1, algorithm: 'Ed25519', id: job.id, issuer, issuedAt: job.createdAt,
        keyId: signing.keyId, snapshotSha256: sha256(JSON.stringify(job.snapshot)), pages: manifestPages };
      const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
      const record = { id: job.id, tripId: job.tripId, creator: job.creator, issuedAt: job.createdAt,
        requestId: job.options.requestId, optionsHash: job.optionsHash, filter: job.snapshot.filter,
        includeReceipts: job.snapshot.includeReceipts, count: job.snapshot.count, totalMinor: job.snapshot.totalMinor,
        currency: job.snapshot.trip.currency, keyId: signing.keyId, pages: savedPages,
        payload: payload.toString('base64'), signature: crypto.sign(null, payload, signing.privateObject).toString('base64') };
      await fsp.writeFile(path.join(outputDir, 'snapshot.json'), JSON.stringify(job.snapshot), { mode: 0o600, flag: 'wx' });
      await fsp.writeFile(path.join(outputDir, 'record.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await fsp.writeFile(path.join(outputDir, 'state.json'), JSON.stringify({ revokedAt: null, reason: null }), { mode: 0o600, flag: 'wx' });
      check();
      await fsp.rename(outputDir, finalDir);
      check();
      records.set(job.id, record);
      published = true;
      job.status = 'completed';
      job.progress = { stage: 'ready', completed: pages.length, total: pages.length };
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.progress = { stage: job.status, completed: 0, total: 0 };
      const expected = error instanceof VoucherError || error.statusCode === 422;
      job.error = signal.aborted ? null : expected ? error.message : '凭证生成失败，请重试；若持续失败请联系管理员';
      if (!signal.aborted && !expected) console.error('Voucher generation failed:', error);
    } finally {
      delete job.snapshot;
      await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => {});
      if (!published) await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function getJob(principal, id) {
    await available();
    if (!ID.test(id || '')) fail('找不到这次导出任务', 404);
    const job = jobs.get(id);
    if (job) return describeJob(job, principal);
    const record = known(id);
    const access = member(getDb(), principal, record.tripId);
    if (access.key !== record.creator) fail('无法访问其他成员的导出任务', 403);
    return { id, status: 'completed', progress: { stage: 'ready', completed: record.pages.length, total: record.pages.length },
      createdAt: record.issuedAt, result: await describe(record, principal), error: null };
  }

  async function cancelJob(principal, id) {
    await getJob(principal, id);
    const job = jobs.get(id);
    if (!job || job.status === 'completed') fail('凭证已生成，可撤销在线核验', 409);
    if (['queued', 'running'].includes(job.status)) {
      job.controller.abort();
      job.status = 'cancelled';
      job.progress = { stage: 'cancelled', completed: 0, total: 0 };
      delete job.snapshot;
    }
    return describeJob(job, principal);
  }

  async function list(principal, tripId) {
    await available();
    member(getDb(), principal, tripId);
    return Promise.all([...records.values()].filter(record => record.tripId === tripId)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).map(record => describe(record, principal)));
  }

  async function getImage(principal, id, pageNumber, { preview = false } = {}) {
    await available();
    const record = known(id);
    member(getDb(), principal, record.tripId);
    const page = Number(pageNumber);
    if (!Number.isInteger(page) || page < 1 || page > record.pages.length) fail('找不到这张凭证图片', 404);
    const filename = preview ? record.pages[page - 1].previewFilename : record.pages[page - 1].filename;
    return { path: path.join(directory, id, filename), contentType: preview ? 'image/webp' : 'image/png',
      filename: `ithaca-${id}-${page}.${preview ? 'webp' : 'png'}` };
  }

  async function revoke(principal, id) {
    await available();
    const record = known(id);
    const access = member(getDb(), principal, record.tripId);
    if (access.role !== 'owner' && access.key !== record.creator) fail('仅生成者或旅行所有者可以撤销凭证', 403);
    const current = await state(record);
    if (!current.revokedAt) await writeAtomic(path.join(directory, id, 'state.json'), { revokedAt: new Date().toISOString(), reason: 'manual' });
    return describe(record, principal);
  }

  async function verification(id) {
    await available();
    const record = known(id);
    const current = await state(record);
    return { id: record.id, status: current.revokedAt ? 'revoked' : 'valid', issuedAt: record.issuedAt,
      keyId: record.keyId, payload: record.payload, signature: record.signature };
  }

  async function publicKey(keyId) {
    await available();
    if (!/^[a-f0-9]{32}$/.test(keyId || '')) fail('找不到签发公钥', 404);
    let value;
    try { value = JSON.parse(await fsp.readFile(path.join(dataDir, 'voucher-keys', `public-${keyId}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') fail('找不到签发公钥', 404); fail('签发公钥暂不可用', 503); }
    const bytes = Buffer.from(value.publicKey || '', 'base64');
    if (value.keyId !== keyId || sha256(bytes).slice(0, 32) !== keyId
      || value.algorithm !== 'Ed25519' || value.format !== 'spki') fail('签发公钥无效', 503);
    return { keyId, algorithm: 'Ed25519', format: 'spki', publicKey: value.publicKey };
  }

  async function checkImage(bytes, { expectedId = '', signal } = {}) {
    await available();
    if (expectedId && !ID.test(expectedId)) fail('凭证编号无效');
    const locator = await runImageCheck('extract', bytes, { signal });
    if (!locator || !ID.test(locator.id) || !records.has(locator.id)) return { result: 'inconclusive', reason: 'watermark' };
    if (expectedId && locator.id !== expectedId) return { result: 'different', reason: 'identity', id: expectedId };
    const record = known(locator.id);
    const published = await publicKey(record.keyId);
    const publicObject = crypto.createPublicKey({ key: Buffer.from(published.publicKey, 'base64'), format: 'der', type: 'spki' });
    const payload = Buffer.from(record.payload, 'base64');
    if (!crypto.verify(null, payload, publicObject, Buffer.from(record.signature, 'base64'))) fail('凭证签名无效', 503);
    const manifest = JSON.parse(payload.toString('utf8'));
    if (manifest.version !== 1 || manifest.algorithm !== 'Ed25519' || manifest.id !== record.id
      || manifest.issuer !== issuer || manifest.keyId !== record.keyId || manifest.issuedAt !== record.issuedAt
      || !Array.isArray(manifest.pages) || manifest.pages.length !== record.pages.length) fail('凭证签名清单无效', 503);
    const page = manifest.pages[locator.page - 1];
    const saved = record.pages[locator.page - 1];
    if (!page || !saved || page.page !== locator.page || page.width !== 1080 || page.height !== locator.height
      || page.watermark !== 'ithaca-dct-v1' || !/^[a-f0-9]{64}$/.test(page.sha256)) return { result: 'inconclusive', reason: 'watermark' };
    const describeCheck = async result => {
      const proof = await verification(record.id);
      return { result: proof.status === 'revoked' ? 'revoked' : result.result, reason: result.reason,
        id: record.id, page: page.page, pageCount: manifest.pages.length, issuedAt: record.issuedAt, verification: proof };
    };
    if ((await state(record)).revokedAt) return describeCheck({ result: 'revoked', reason: 'revoked' });
    if (!FILE.test(saved.filename) || !saved.filename.endsWith('.png')) fail('凭证存档无效', 503);
    const filename = path.join(directory, record.id, saved.filename);
    const info = await fsp.lstat(filename).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024) fail('凭证存档不可用', 503);
    const reference = await fsp.readFile(filename);
    if (sha256(reference) !== page.sha256) fail('凭证存档校验失败', 503);
    const compared = await runImageCheck('compare', bytes, { reference, signal });
    if (!['matched', 'different', 'inconclusive'].includes(compared?.state)) fail('图片核验暂不可用', 503);
    signal?.throwIfAborted();
    return describeCheck({ result: compared.state, reason: compared.reason || 'content' });
  }

  async function revokeDeletedTrips() {
    await available();
    for (const record of records.values()) if (!getDb().trips.some(trip => trip.id === record.tripId)) await state(record);
    for (const job of jobs.values()) if (['queued', 'running'].includes(job.status) && !getDb().trips.some(trip => trip.id === job.tripId)) {
      job.controller.abort();
      job.status = 'cancelled';
      job.progress = { stage: 'cancelled', completed: 0, total: 0 };
    }
  }

  return { ready, createJob, getJob, cancelJob, list, getImage, revoke, verification, publicKey, checkImage, revokeDeletedTrips };
}

module.exports = { createVoucherService, VoucherError };
