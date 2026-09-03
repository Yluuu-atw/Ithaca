'use strict';

/**
 * Journey 服务端 —— 零依赖（仅用 Node 内置模块）。
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
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalize, defaultDoc } = require('./data/schema');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

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
let writeChain = Promise.resolve();

function persist(data) {
  writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_PATH + '.tmp';
    fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, DB_PATH, (err2) => (err2 ? reject(err2) : resolve()));
    });
  }));
  return writeChain;
}

// ---------------- SSE 实时广播 ----------------

const sseClients = new Set();

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (_) { sseClients.delete(res); }
  }
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'data', data: db, version: db.meta.version })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// ---------------- 静态文件服务 ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------- REST API ----------------

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// 读取原始二进制 body（照片上传），限制 20MB
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('照片过大（上限 20MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

async function handlePhotoUpload(req, res, pathname) {
  if (pathname === '/api/photos' && req.method === 'POST') {
    try {
      const buf = await readRawBody(req);
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

async function handleApi(req, res, pathname) {
  const photoResult = await handlePhotoUpload(req, res, pathname);
  if (photoResult !== null) return photoResult;

  if (pathname === '/api/data' && req.method === 'GET') {
    return sendJSON(res, 200, db);
  }

  if (pathname === '/api/data' && req.method === 'PUT') {
    try {
      const payload = JSON.parse(await readBody(req));
      const baseVersion = Number(payload.baseVersion) || 0;
      // 乐观并发控制：客户端基于的版本不一致则拒绝，避免覆盖他人改动
      if (baseVersion !== db.meta.version) {
        return sendJSON(res, 409, { error: '版本冲突', version: db.meta.version });
      }
      const next = normalize(payload.data);
      next.meta.version = db.meta.version + 1;
      next.meta.updatedAt = new Date().toISOString();
      db = next;
      await persist(db);
      broadcast({ type: 'data', data: db, version: db.meta.version });
      return sendJSON(res, 200, { data: db, version: db.meta.version });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/export' && req.method === 'GET') {
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="journey-${stamp}.json"`,
    });
    return res.end(JSON.stringify(db, null, 2));
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    try {
      const incoming = JSON.parse(await readBody(req));
      const next = normalize(incoming);
      next.meta.version = db.meta.version + 1;
      next.meta.updatedAt = new Date().toISOString();
      db = next;
      await persist(db);
      broadcast({ type: 'data', data: db, version: db.meta.version });
      return sendJSON(res, 200, { data: db, version: db.meta.version });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
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

  if (pathname === '/api/events' && req.method === 'GET') return handleSSE(req, res);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  console.log('┌──────────────────────────────────────────┐');
  console.log('│   Journey · 情侣旅行规划 · 已启动         │');
  console.log('└──────────────────────────────────────────┘');
  console.log(`  本机访问:    http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  局域网访问:  http://${a}:${PORT}   ← 发给 TA`);
  console.log(`  数据文件:    ${DB_PATH}`);
});
