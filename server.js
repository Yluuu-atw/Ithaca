'use strict';

/**
 * Ithaca server — no external dependencies.
 *
 * 职责：
 *   1. 托管 public/ 静态资源
 *   2. REST API（/api/data 读写整份文档）
 *   3. SSE（/api/events）多设备实时同步
 *   4. JSON 文件原子持久化（写临时文件 + rename，防写坏）
 *
 * 数据与呈现分离：数据只存在 data/db.json，服务端只做读写与广播，
 * 不关心界面长什么样；界面逻辑全在 public/ 里。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalize, defaultDoc } = require('./data/schema');
const { claimLegacy } = require('./data/access');
const { createAuth } = require('./data/auth');
const { AccessDeniedError, project, updateDocument } = require('./data/document-policy');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.ITHACA_DATA_DIR ? path.resolve(process.env.ITHACA_DATA_DIR) : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const AUTH_PATH = path.join(DATA_DIR, 'auth.json');
const SETUP_TOKEN_PATH = process.env.ITHACA_SETUP_TOKEN_PATH || path.join(__dirname, '.local', 'setup-token');
const ORIGIN = process.env.ITHACA_ORIGIN || `http://localhost:${PORT}`;
const COOKIE_NAME = ORIGIN.startsWith('https://') ? '__Host-ithaca_sid' : 'ithaca_sid';

// ---------------- 数据加载 & 原子持久化 ----------------

function loadDb() {
  if (!fs.existsSync(DB_PATH)) return defaultDoc();
  try {
    return normalize(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  } catch (err) {
    console.error('[db] 数据文件损坏，已回退到默认值:', err.message);
    return defaultDoc();
  }
}

let db = loadDb();
const auth = createAuth(AUTH_PATH, SETUP_TOKEN_PATH);

// 写盘：临时文件 + rename，避免写一半损坏原文件
function writeDb(data) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_PATH + '.tmp';
    fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, DB_PATH, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

// 版本冲突专用错误，让路由层能区分 409（客户端该重试）和 400（请求本身有问题）
class VersionConflictError extends Error {
  constructor(latestVersion) {
    super('版本冲突');
    this.latestVersion = latestVersion;
  }
}

let writeChain = Promise.resolve();

/**
 * 串行提交一次变更：「校验版本 → 更新内存 → 落盘」作为一个原子步骤排队执行。
 *
 * 排队是必须的：不排队的话两个并发 PUT 会在 await 期间交错，双方都读到同一个
 * 旧版本号而通过校验，后完成的那次会静默覆盖前一次（丢数据）。
 *
 * 落盘失败必须回滚内存：否则接口返回的数据和磁盘上的不一致，用户看到改动
 * 却在重启后全部丢失。
 *
 * 失败只影响本次调用——队列吞掉 rejection。否则一次写盘失败（磁盘满、休眠唤醒）
 * 会让 writeChain 变成 rejected promise，之后所有写入都永久失效。
 */
function commit(mutateFn, baseVersion) {
  const run = writeChain.then(async () => {
    if (baseVersion !== undefined && baseVersion !== db.meta.version) {
      throw new VersionConflictError(db.meta.version);
    }
    const previous = db;
    const next = mutateFn(db);
    next.meta.updatedAt = new Date().toISOString();
    db = next;
    try {
      await writeDb(db);
    } catch (err) {
      db = previous; // 回滚：内存必须与磁盘保持一致
      throw err;
    }
    broadcast({ type: 'data', data: db, version: db.meta.version });
    return db;
  });
  writeChain = run.then(() => {}, () => {}); // 吞掉失败，不污染队列
  return run;
}

// ---------------- SSE 实时广播 ----------------

const sseClients = new Set();

function broadcast() {
  for (const client of sseClients) {
    try {
      if (!auth.resolve(client.token)) {
        client.res.end();
        sseClients.delete(client);
        continue;
      }
      const data = project(db, client.principal);
      client.res.write(`data: ${JSON.stringify({ type: 'data', data, version: db.meta.version })}\n\n`);
    } catch (_) { sseClients.delete(client); }
  }
}

function handleSSE(req, res, principal, token) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const data = project(db, principal);
  res.write(`data: ${JSON.stringify({ type: 'data', data, version: db.meta.version })}\n\n`);
  const client = { res, principal, token };
  sseClients.add(client);
  req.on('close', () => sseClients.delete(client));
}

// ---------------- 静态文件服务 ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const isUpload = rel.startsWith('uploads/');
  const base = isUpload ? UPLOAD_DIR : PUBLIC_DIR;
  const inner = isUpload ? rel.slice('uploads/'.length) : rel;
  const filePath = path.resolve(base, inner);
  if (!filePath.startsWith(base + path.sep) && filePath !== base) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // vendor 下的 emoji 与 leaflet 是打包进来的静态资源，内容不会变，给长缓存；
    // 其余每次校验，但带上 ETag/Last-Modified 才能命中 304，否则 no-cache 等于每次全量重下
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();
    const immutable = rel.startsWith('vendor/');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'ETag': etag,
      'Last-Modified': lastModified,
    };
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if ((inm && inm.split(',').some(t => t.trim() === etag))
      || (!inm && ims && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------- REST API ----------------

function sendJSON(res, code, obj, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  const item = raw.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}

function sessionCookie(token, maxAge) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (COOKIE_NAME.startsWith('__Host-')) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function sameOrigin(req) {
  const expected = process.env.ITHACA_ORIGIN || `http://${req.headers.host}`;
  return req.headers.origin === expected;
}

const attempts = new Map();
function limited(req, action, max, interval) {
  const key = `${req.socket.remoteAddress}:${action}`;
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < interval);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > max;
}

async function handleAuth(req, res, pathname) {
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const session = auth.resolve(cookieValue(req, COOKIE_NAME));
    return session ? sendJSON(res, 200, session) : sendJSON(res, 401, { error: '请先登录' });
  }
  if (!['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/setup'].includes(pathname)) return false;
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
  if (!sameOrigin(req)) return sendJSON(res, 403, { error: '请求来源无效' });
  if (limited(req, pathname, pathname === '/api/auth/login' ? 20 : 8, 15 * 60 * 1000)) {
    return sendJSON(res, 429, { error: '尝试次数过多，请稍后再试' });
  }
  try {
    if (pathname === '/api/auth/logout') {
      const token = cookieValue(req, COOKIE_NAME);
      const session = auth.resolve(token);
      if (session && req.headers['x-csrf-token'] !== session.csrf) return sendJSON(res, 403, { error: '安全令牌无效' });
      await auth.logout(token);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    const body = await readJSON(req);
    let user;
    if (pathname === '/api/auth/register') user = await auth.register(body.username, body.password);
    if (pathname === '/api/auth/login') user = await auth.login(body.username, body.password);
    if (pathname === '/api/auth/setup') {
      if (!db.trips.some(trip => !db.access[trip.id])) return sendJSON(res, 409, { error: '初始设置已完成' });
      user = await auth.setup(body.username, body.password, body.token);
      await commit(current => {
        const next = claimLegacy(current, user.id);
        next.meta.version = current.meta.version + 1;
        return next;
      });
      await auth.finishSetup(user.id);
    }
    const session = await auth.createSession(user.id);
    return sendJSON(res, 200, { user, csrf: session.csrf }, { 'Set-Cookie': sessionCookie(session.token) });
  } catch (error) {
    return sendJSON(res, 400, { error: error.message });
  }
}

/**
 * 读取请求体为 Buffer。必须先攒 Buffer 再一次性解码：
 * 逐 chunk 做字符串拼接会把跨 chunk 边界的 UTF-8 多字节字符切成 U+FFFD，
 * 中文内容超过约 64KB（Node stream 默认 highWaterMark）就会静默损坏。
 */
function readBody(req, limit) {
  const max = limit || 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

// JSON 请求体：攒完再按 UTF-8 整体解码
async function readJSON(req) {
  return JSON.parse((await readBody(req)).toString('utf8'));
}

function extFromType(contentType) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
  };
  return map[contentType] || '.jpg';
}

function photoUid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 抓笔记页的 og:image / og:title。浏览器跨域取不到，只能服务端代抓。
// 失败一律返回 null 由调用方降级，绝不阻塞收藏保存。
function fetchOG(target, redirects) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch (_) { return resolve(null); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(null);
    const left = redirects == null ? 3 : redirects;
    const get = u.protocol === 'https:' ? https : http;
    const rq = get.get(u.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 8000,
    }, (rs) => {
      // 重定向：小红书短链会 302，跟几步才能拿到真实笔记页
      if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location && left > 0) {
        rs.resume();
        return resolve(fetchOG(new URL(rs.headers.location, u.href).href, left - 1));
      }
      if (rs.statusCode !== 200) { rs.resume(); return resolve(null); }
      // og 标签都在 <head>，读前 256KB 足够，不为整页图片浪费内存
      const chunks = [];
      let size = 0;
      rs.on('data', (c) => { if (size < 256 * 1024) { chunks.push(c); size += c.length; } });
      rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      rs.on('error', () => resolve(null));
    });
    rq.on('timeout', () => { rq.destroy(); resolve(null); });
    rq.on('error', () => resolve(null));
  });
}

// og 标签的 property/content 顺序不固定，两种都匹配
function ogContent(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp(`<meta[^>]+(?:property="${esc}"[^>]*content="([^"]*)"|content="([^"]*)"[^>]*property="${esc}")`, 'i'));
  return m ? (m[1] || m[2] || '') : '';
}

// 小红书等站点的 CDN 链接带签名和时间戳会过期，只存 URL 迟早裂图，
// 抓到封面就落到本地。失败返回空串，由调用方退回原链接，绝不阻塞收藏。
function downloadImage(url, redirects) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(''); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve('');
    const left = redirects == null ? 3 : redirects;
    const get = u.protocol === 'https:' ? https : http;
    const rq = get.get(u.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      timeout: 10000,
    }, (rs) => {
      if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location && left > 0) {
        rs.resume();
        return resolve(downloadImage(new URL(rs.headers.location, u.href).href, left - 1));
      }
      if (rs.statusCode !== 200) { rs.resume(); return resolve(''); }
      const chunks = [];
      let size = 0;
      rs.on('data', (c) => {
        size += c.length;
        if (size > 15 * 1024 * 1024) { rq.destroy(); return resolve(''); }
        chunks.push(c);
      });
      rs.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return resolve('');
        const name = photoUid() + extFromType((rs.headers['content-type'] || '').split(';')[0].trim());
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        fs.writeFile(path.join(UPLOAD_DIR, name), buf, (err) => resolve(err ? '' : '/uploads/' + name));
      });
      rs.on('error', () => resolve(''));
    });
    rq.on('timeout', () => { rq.destroy(); resolve(''); });
    rq.on('error', () => resolve(''));
  });
}

function pickCover(html) {
  const all = [];
  const re = /<meta[^>]+(?:property="og:image"[^>]*content="([^"]*)"|content="([^"]*)"[^>]*property="og:image")/gi;
  let m;
  while ((m = re.exec(html))) all.push(m[1] || m[2] || '');
  // picasso-static 的小图是小红书默认占位图，不是笔记封面
  const real = all.find(x => x.includes('notes_pre_post')) || all.find(x => x && !x.includes('picasso-static'));
  const url = real || '';
  return url.startsWith('//') ? 'https:' + url : url;
}

async function handlePhotoUpload(req, res, pathname) {
  if (pathname === '/api/photos' && req.method === 'POST') {
    try {
      const buf = await readBody(req, 20 * 1024 * 1024);
      const ct = (req.headers['content-type'] || '').split(';')[0].trim();
      const ext = extFromType(ct);
      const name = photoUid() + ext;
      if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buf);
      return sendJSON(res, 200, { url: '/uploads/' + name });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }
  return null;
}

async function handleApi(req, res, pathname, session) {
  const principal = { userId: session.user.id };
  const photoResult = await handlePhotoUpload(req, res, pathname);
  if (photoResult !== null) return photoResult;

  if (pathname === '/api/link-preview' && req.method === 'GET') {
    const target = new URL(req.url, 'http://localhost').searchParams.get('url');
    if (!target) return sendJSON(res, 400, { error: '缺少 url' });
    const html = await fetchOG(target);
    if (!html) return sendJSON(res, 200, { cover: '', title: '' });
    const remote = pickCover(html);
    // 落到本地，CDN 链接过期后才不会裂图；下载失败退回原链接
    const local = remote ? await downloadImage(remote) : '';
    return sendJSON(res, 200, { cover: local || remote, title: ogContent(html, 'og:title') });
  }

  if (pathname === '/api/data' && req.method === 'GET') {
    return sendJSON(res, 200, project(db, principal));
  }

  if (pathname === '/api/data' && req.method === 'PUT') {
    try {
      const payload = await readJSON(req);
      const baseVersion = Number(payload.baseVersion) || 0;
      // 乐观并发控制：校验版本、更新内存、落盘作为一个原子步骤串行执行
      const saved = await commit((cur) => {
        const next = updateDocument(cur, principal, payload.data);
        next.meta.version = cur.meta.version + 1;
        return next;
      }, baseVersion);
      return sendJSON(res, 200, { data: project(saved, principal), version: saved.meta.version });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return sendJSON(res, 409, { error: '版本冲突', version: err.latestVersion });
      }
      if (err instanceof AccessDeniedError) return sendJSON(res, 403, { error: err.message });
      return sendJSON(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/export' && req.method === 'GET') {
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="journey-${stamp}.json"`,
    });
    return res.end(JSON.stringify(project(db, principal), null, 2));
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    return sendJSON(res, 501, { error: '安全导入功能正在更新' });
  }

  return sendJSON(res, 404, { error: 'Not Found' });
}

// ---------------- 服务器入口 ----------------

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  if (pathname.startsWith('/api/auth/')) return handleAuth(req, res, pathname);
  if (pathname.startsWith('/api/')) {
    const session = auth.resolve(cookieValue(req, COOKIE_NAME));
    if (!session) return sendJSON(res, 401, { error: '请先登录' });
    if (!['GET', 'HEAD'].includes(req.method) && (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf)) {
      return sendJSON(res, 403, { error: '安全令牌无效' });
    }
    if (pathname === '/api/events' && req.method === 'GET') return handleSSE(req, res, { userId: session.user.id }, cookieValue(req, COOKIE_NAME));
    return handleApi(req, res, pathname, session);
  }
  return serveStatic(req, res, pathname);
});

async function start() {
  if (db.trips.some(trip => !db.access[trip.id])) {
    await auth.prepareSetup();
    console.log(`[auth] 初始设置链接令牌已写入 ${SETUP_TOKEN_PATH}`);
  }
  server.listen(PORT, HOST, () => {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  console.log('┌──────────────────────────────────────────┐');
  console.log('│   九州 ITHACA · 旅行规划 · 已启动        │');
  console.log('└──────────────────────────────────────────┘');
  console.log(`  本机访问:    http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  局域网访问:  http://${a}:${PORT}   ← 发给 TA`);
  console.log(`  数据文件:    ${DB_PATH}`);
  });
}

start().catch(error => {
  console.error('[startup]', error);
  process.exitCode = 1;
});
