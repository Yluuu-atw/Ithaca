'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');
const { defaultTrip } = require('../data/schema');

test('voucher HTTP boundary signs server data and keeps original images private', { timeout: 60000 }, async () => {
  const root = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(root, '.local/voucher-api-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ITHACA_ORIGIN: origin, ITHACA_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { logs += value; });
  child.stderr.on('data', value => { logs += value; });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function request(url, { method = 'GET', identity, body, csrf = true } = {}) {
    return fetch(origin + url, { method, headers: { Origin: origin,
      ...(identity ? { Cookie: identity.cookie, ...(csrf ? { 'X-CSRF-Token': identity.csrf } : {}) } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  }
  async function register(username) {
    const response = await request('/api/auth/register', { method: 'POST', body: { username, password: 'voucher test secure password' } });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf };
  }
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await request('/api/data')).status === 401) { ready = true; break; } } catch (_) {}
      if (child.exitCode !== null) break;
      await wait(30);
    }
    assert.ok(ready, logs);
    const owner = await register('voucher_owner');
    const stranger = await register('voucher_stranger');
    let doc = await (await request('/api/data', { identity: owner })).json();
    const trip = defaultTrip();
    trip.meta.tripName = '私人旅行名称';
    trip.meta.startDate = '2026-10-15';
    trip.meta.endDate = '2026-10-16';
    doc.trips.push(trip);
    let response = await request('/api/data', { method: 'PUT', identity: owner, body: { baseVersion: doc.meta.version, data: doc } });
    assert.equal(response.status, 200);
    doc = (await response.json()).data;
    const person = doc.trips[0].meta.members[0];
    doc.trips[0].expenses.push({ id: 'voucher_expense', title: '私人晚餐 <&>', amount: 123.45,
      category: '餐饮', payer: person, participants: [person], date: '2026-10-15', time: '18:30', note: '中文测试账单' });
    response = await request('/api/data', { method: 'PUT', identity: owner, body: { baseVersion: doc.meta.version, data: doc } });
    assert.equal(response.status, 200);
    const input = { tripId: trip.id, filter: 'all', includeReceipts: false, background: '#283440', timeZone: 'Asia/Shanghai', requestId: crypto.randomUUID() };
    assert.equal((await request('/api/voucher-jobs', { method: 'POST', identity: owner, body: input, csrf: false })).status, 403);
    assert.equal((await request('/api/voucher-jobs', { method: 'POST', identity: stranger, body: input })).status, 403);
    assert.equal((await request('/api/voucher-jobs', { method: 'POST', identity: owner, body: { ...input, amount: 1 } })).status, 400);
    response = await request('/api/voucher-jobs', { method: 'POST', identity: owner, body: input });
    assert.equal(response.status, 202, await response.clone().text());
    let job = await response.json();
    const duplicate = await (await request('/api/voucher-jobs', { method: 'POST', identity: owner, body: input })).json();
    assert.equal(duplicate.id, job.id);
    for (let i = 0; i < 200 && !['completed', 'failed'].includes(job.status); i++) {
      await wait(100);
      job = await (await request(`/api/voucher-jobs/${job.id}`, { identity: owner })).json();
    }
    assert.equal(job.status, 'completed', `${JSON.stringify(job)}\n${logs}`);
    assert.equal(job.result.totalMinor, 12345);
    const imageUrl = job.result.pages[0].imageUrl;
    assert.equal((await request(imageUrl)).status, 401);
    assert.equal((await request(imageUrl, { identity: stranger })).status, 403);
    response = await request(imageUrl, { identity: owner });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal((await sharp(bytes).metadata()).width, 1080);
    const proof = await (await request(`/api/vouchers/${job.id}/verification`)).json();
    const payload = Buffer.from(proof.payload, 'base64');
    const manifest = JSON.parse(payload);
    const key = await (await request(`/api/voucher-keys/${proof.keyId}`)).json();
    const publicKey = crypto.createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
    assert.equal(crypto.verify(null, payload, publicKey, Buffer.from(proof.signature, 'base64')), true);
    assert.equal(manifest.pages[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(proof.status, 'valid');
    for (const secret of ['私人旅行名称', '私人晚餐', 'voucher_owner', '12345', trip.id]) {
      assert.equal(payload.toString().includes(secret), false);
      assert.equal(JSON.stringify(proof).includes(secret), false);
    }
    assert.equal((await request('/verify-voucher')).status, 200);
    assert.equal((await request(`/api/vouchers/${job.id}`, { method: 'DELETE', identity: stranger })).status, 403);
    assert.equal((await request(`/api/vouchers/${job.id}`, { method: 'DELETE', identity: owner })).status, 200);
    assert.equal((await (await request(`/api/vouchers/${job.id}/verification`)).json()).status, 'revoked');
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
