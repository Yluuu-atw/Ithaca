'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { extractImageDraft, normalizeDraft, RecognitionError } = require('../data/ai-recognition');
const { defaultTrip } = require('../data/schema');

async function sampleImage() {
  return sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#ffffff' } }).png().toBuffer();
}

test('recognition sends a reduced image and accepts only existing booking fields', async () => {
  const bytes = await sampleImage();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-key');
    assert.ok(options.signal);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'fake-model');
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.equal(payload.response_format.json_schema.strict, true);
    assert.deepEqual(payload.response_format.json_schema.schema.properties.type, { type: 'string' });
    assert.match(payload.messages[0].content[0].text, /flight, train, bus, hotel, other/);
    const imageUrl = payload.messages[0].content[1].image_url.url;
    assert.match(imageUrl, /^data:image\/jpeg;base64,/);
    const resized = Buffer.from(imageUrl.slice('data:image/jpeg;base64,'.length), 'base64');
    const info = await sharp(resized).metadata();
    assert.ok(info.width <= 1600 && info.height <= 1600);
    assert.ok(resized.length < bytes.length);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      type: 'train', status: '已订', title: 'G123', date: '2026-10-01', time: '09:30', price: '123.45',
      payer: 'someone else', from: '北京', to: '上海', note: '',
    }) } }] }) };
  };
  const fields = await extractImageDraft({ kind: 'booking', bytes, contentType: 'image/png', apiKey: 'fake-test-key', model: 'fake-model', fetchImpl });
  assert.equal(calls, 1);
  assert.deepEqual(fields, { type: 'train', status: '已订', title: 'G123', date: '2026-10-01', time: '09:30', from: '北京', to: '上海', price: 123.45 });
});

test('expense drafts validate categories, dates, amounts and strip unsupported fields', () => {
  assert.deepEqual(normalizeDraft('expense', {
    title: '晚饭', date: '2026-02-30', time: '25:61', amount: '-12', category: '餐饮', payer: 'Alice',
    note: '<script>ignore</script>',
  }), { title: '晚饭', category: '餐饮', note: '<script>ignore</script>' });
  assert.deepEqual(normalizeDraft('expense', { amount: '0.00', category: 'not-a-category', date: '2026-02-28', time: '19:30' }), {
    date: '2026-02-28', time: '19:30', amount: 0, category: '其他',
  });
  assert.deepEqual(normalizeDraft('expense', { placeName: 'Example Cafe Central Branch', address: '100 Main Street', coordinates: '31,121' }), {
    placeName: 'Example Cafe Central Branch', address: '100 Main Street',
  });
  assert.deepEqual(normalizeDraft('booking', { type: 'invented', status: '已支付', price: '9999999999', date: '2026-01-01' }), {
    type: 'other', date: '2026-01-01',
  });
});

test('invalid image and upstream errors do not expose provider details', async () => {
  const bytes = await sampleImage();
  const mock = async () => { throw new Error('provider secret details'); };
  await assert.rejects(extractImageDraft({ kind: 'expense', bytes, contentType: 'image/png', apiKey: 'fake', fetchImpl: mock }),
    error => error instanceof RecognitionError && error.status === 502 && !error.message.includes('provider'));
  await assert.rejects(extractImageDraft({ kind: 'expense', bytes: Buffer.from('not an image'), contentType: 'image/png', apiKey: 'fake', fetchImpl: mock }),
    error => error instanceof RecognitionError && error.status === 422);
  await assert.rejects(extractImageDraft({ kind: 'expense', bytes, contentType: 'text/plain', apiKey: 'fake', fetchImpl: mock }),
    error => error instanceof RecognitionError && error.status === 415);
  await assert.rejects(extractImageDraft({ kind: 'expense', bytes, contentType: 'image/png', apiKey: '', fetchImpl: mock }),
    error => error instanceof RecognitionError && error.status === 503);
  await assert.rejects(extractImageDraft({ kind: 'expense', bytes, contentType: 'image/png', apiKey: 'fake',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }),
  }), error => error instanceof RecognitionError && error.status === 502);
});

test('canceling recognition aborts the upstream model request', async () => {
  const controller = new AbortController();
  let upstreamAborted = false;
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      upstreamAborted = true;
      reject(new DOMException('Canceled', 'AbortError'));
    }, { once: true });
    controller.abort();
  });
  await assert.rejects(extractImageDraft({
    kind: 'expense', bytes: await sampleImage(), contentType: 'image/png', apiKey: 'fake', fetchImpl,
    signal: controller.signal,
  }), error => error instanceof RecognitionError && error.status === 499);
  assert.equal(upstreamAborted, true);
});

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(origin) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/api/data`);
      if (response.status === 401) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for server');
}

test('recognition route checks login, CSRF and trip edit rights before processing', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/ai-auth-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ARK_API_KEY: '', HOST: '127.0.0.1', PORT: String(port), ITHACA_DATA_DIR: dir, ITHACA_ORIGIN: origin },
    stdio: 'ignore',
  });
  try {
    await waitForServer(origin);
    const registration = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'a secure owner password' }),
    });
    assert.equal(registration.status, 200);
    const ownerCookie = registration.headers.get('set-cookie').split(';')[0];
    const ownerCsrf = (await registration.json()).csrf;
    const initial = await (await fetch(`${origin}/api/data`, { headers: { Cookie: ownerCookie } })).json();
    initial.trips.push(defaultTrip());
    const created = await fetch(`${origin}/api/data`, {
      method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
      body: JSON.stringify({ baseVersion: initial.meta.version, data: initial }),
    });
    assert.equal(created.status, 200);
    const tripId = (await created.json()).data.trips[0].id;
    const endpoint = `${origin}/api/ai/extract?kind=expense&tripId=${tripId}`;
    const bytes = await sampleImage();
    const headers = { Origin: origin, 'Content-Type': 'image/png', Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf };
    assert.equal((await fetch(`${origin}/api/ai/status`, { headers: { Cookie: ownerCookie } })).status, 200);
    assert.deepEqual(await (await fetch(`${origin}/api/ai/status`, { headers: { Cookie: ownerCookie } })).json(), { available: false });
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'image/png' }, body: bytes })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body: bytes })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: bytes })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: bytes })).status, 503);
    assert.equal((await fetch(`${origin}/api/ai/extract?kind=unknown&tripId=${tripId}`, { method: 'POST', headers, body: bytes })).status, 400);
    const placeEndpoint = `${origin}/api/places/search`;
    const placeBody = JSON.stringify({ tripId, query: 'x' });
    assert.equal((await fetch(placeEndpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: placeBody })).status, 401);
    assert.equal((await fetch(placeEndpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: ownerCookie }, body: placeBody })).status, 403);
    assert.equal((await fetch(placeEndpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf }, body: placeBody })).status, 400);
    const visitor = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'visitor', password: 'a secure visitor password' }),
    });
    assert.equal(visitor.status, 200);
    const visitorCookie = visitor.headers.get('set-cookie').split(';')[0];
    const visitorCsrf = (await visitor.json()).csrf;
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Cookie: visitorCookie, 'X-CSRF-Token': visitorCsrf }, body: bytes })).status, 403);
    assert.equal((await fetch(placeEndpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: visitorCookie, 'X-CSRF-Token': visitorCsrf }, body: JSON.stringify({ tripId, query: 'Cafe' }) })).status, 403);
    const after = await (await fetch(`${origin}/api/data`, { headers: { Cookie: ownerCookie } })).json();
    assert.equal(after.trips[0].expenses.length, 0);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
