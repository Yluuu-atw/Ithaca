'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createVoucherService } = require('../data/vouchers');
const { ownedDoc, addFormalMember } = require('./fixtures');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const owner = { userId: 'owner' };
const issuer = 'https://ithaca.example';

async function renderFixture({ outputDir, signal, onProgress }) {
  signal.throwIfAborted();
  onProgress({ stage: 'rendering', completed: 0, total: 1 });
  await fs.writeFile(path.join(outputDir, 'page-1.png'), PNG);
  await fs.writeFile(path.join(outputDir, 'page-1.webp'), 'fixture preview');
  return { pages: [{ filename: 'page-1.png', previewFilename: 'page-1.webp', width: 1, height: 1, watermark: 'ithaca-dct-v1' }] };
}

async function setup(t, render = renderFixture) {
  const parent = path.join(__dirname, '..', '.local', 'voucher-tests');
  await fs.mkdir(parent, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(parent, 'data-'));
  t.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
  const db = ownedDoc('owner', 'Owner');
  const trip = db.trips[0];
  trip.meta.tripName = 'Private trip';
  trip.meta.startDate = '2026-10-15';
  trip.expenses = [{ id: 'expense', title: 'Private meal', date: '2026-10-15', time: '13:00',
    payer: 'Owner', amount: 10.01, participants: ['Owner'] }];
  const options = { dataDir, origin: issuer, getDb: () => db, render,
    getUsers: () => [{ id: 'owner', username: 'Owner', displayName: 'Account nickname' }] };
  return { db, trip, dataDir, options, service: createVoucherService(options) };
}

async function finished(service, principal, id) {
  for (let tries = 0; tries < 200; tries++) {
    const job = await service.getJob(principal, id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(5);
  }
  throw new Error('Voucher job did not finish');
}

test('vouchers bind immutable server snapshots and exact final bytes without publishing private ledger data', async t => {
  let snapshot;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { service, db, trip, dataDir, options } = await setup(t, async args => {
    snapshot = args.snapshot;
    await held;
    return renderFixture(args);
  });
  const bob = addFormalMember(db, trip.id, 'bob', 'Bob', 'viewer');
  const carol = addFormalMember(db, trip.id, 'carol', 'Carol');
  trip.expenses[0].participants = ['Owner', 'Bob', 'Carol'];
  trip.expenses.push({ id: 'reference', title: 'Future ticket', amount: 0, payer: 'Owner', participants: ['Owner'], receipt: { price: 900 } });
  const request = { tripId: trip.id, requestId: crypto.randomUUID() };
  const created = await service.createJob(owner, request);
  const duplicate = await service.createJob(owner, request);
  assert.equal(duplicate.id, created.id);
  await assert.rejects(service.createJob(owner, { ...request, filter: 'receipt' }), { status: 409 });
  trip.expenses[0].amount = 99;
  release();
  const job = await finished(service, owner, created.id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(snapshot.totalMinor, 1001);
  assert.equal(snapshot.expenses.find(entry => entry.id === 'reference').receipt.priceMinor, 90000);
  assert.equal(snapshot.expenses.find(entry => entry.id === 'expense').payerName, 'Account nickname');
  assert.deepEqual(snapshot.expenses.find(entry => entry.id === 'expense').allocations.map(row => row.shareMinor), [334, 334, 333]);
  assert.deepEqual(snapshot.expenses.find(entry => entry.id === 'expense').allocations.map(row => row.personId), [db.access[trip.id].people[0].id, bob.id, carol.id]);
  const proof = await service.verification(created.id);
  assert.deepEqual(Object.keys(proof).sort(), ['id', 'issuedAt', 'keyId', 'payload', 'signature', 'status']);
  const payload = Buffer.from(proof.payload, 'base64');
  const manifest = JSON.parse(payload);
  assert.deepEqual(Object.keys(manifest).sort(), ['algorithm', 'id', 'issuedAt', 'issuer', 'keyId', 'pages', 'snapshotSha256', 'version']);
  for (const privateText of ['Private trip', 'Private meal', 'Account nickname', trip.id, 'totalMinor']) {
    assert.equal(payload.toString().includes(privateText), false);
  }
  const publishedKey = await service.publicKey(proof.keyId);
  assert.deepEqual(Object.keys(publishedKey).sort(), ['algorithm', 'format', 'keyId', 'publicKey']);
  const publicKey = crypto.createPublicKey({ key: Buffer.from(publishedKey.publicKey, 'base64'), format: 'der', type: 'spki' });
  assert.equal(crypto.verify(null, payload, publicKey, Buffer.from(proof.signature, 'base64')), true);
  const changed = Buffer.from(payload);
  changed[10] ^= 1;
  assert.equal(crypto.verify(null, changed, publicKey, Buffer.from(proof.signature, 'base64')), false);
  const image = await service.getImage({ userId: 'bob' }, created.id, 1);
  assert.equal(hash(await fs.readFile(image.path)), manifest.pages[0].sha256);
  assert.notEqual(hash(Buffer.concat([PNG, Buffer.from('changed')])), manifest.pages[0].sha256);
  assert.equal(hash(await fs.readFile(path.join(dataDir, 'vouchers', created.id, 'snapshot.json'))), manifest.snapshotSha256);
  assert.equal((await fs.stat(path.join(dataDir, 'voucher-keys', 'key.json'))).mode & 0o777, 0o600);
  const restarted = createVoucherService({ ...options, render: renderFixture });
  assert.equal((await restarted.createJob(owner, request)).id, created.id);
  const next = await restarted.createJob(owner, { tripId: trip.id });
  assert.equal((await finished(restarted, owner, next.id)).status, 'completed');
  assert.equal((await restarted.verification(next.id)).keyId, proof.keyId);
});

test('member authorization is rechecked for jobs and files, including anonymous shares and temporary trip scope', async t => {
  const { service, db, trip } = await setup(t);
  const viewer = addFormalMember(db, trip.id, 'viewer', 'Viewer', 'viewer');
  const temporary = { id: 'temporary-person', kind: 'temporary', name: 'Guest' };
  db.access[trip.id].people.push(temporary);
  const guest = { tempTripId: trip.id, tempPersonId: temporary.id };
  for (const forbidden of [null, { shareTripId: trip.id }, { userId: 'outsider', shareTripId: trip.id },
    { tempTripId: 'other-trip', tempPersonId: temporary.id }]) {
    await assert.rejects(service.createJob(forbidden, { tripId: trip.id }), { status: 403 });
  }
  const job = await service.createJob(guest, { tripId: trip.id });
  assert.equal((await finished(service, guest, job.id)).status, 'completed');
  await assert.rejects(service.getJob(owner, job.id), { status: 403 });
  await assert.rejects(service.getImage({ shareTripId: trip.id }, job.id, 1), { status: 403 });
  assert.equal((await service.list({ userId: 'viewer' }, trip.id)).length, 1);
  await assert.rejects(service.revoke({ userId: 'viewer' }, job.id), { status: 403 });
  delete db.access[trip.id].members.viewer;
  db.access[trip.id].people = db.access[trip.id].people.filter(person => person.id !== viewer.id);
  await assert.rejects(service.getImage({ userId: 'viewer', shareTripId: trip.id }, job.id, 1), { status: 403 });
  assert.equal((await service.revoke(owner, job.id)).status, 'revoked');
  assert.equal((await service.verification(job.id)).status, 'revoked');
  db.access[trip.id].people = db.access[trip.id].people.filter(person => person.id !== temporary.id);
  await assert.rejects(service.getJob(guest, job.id), { status: 403 });
});

test('cancellation and permission changes prevent publication and clean pending files', async t => {
  let started;
  let release;
  const running = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { service, dataDir, trip } = await setup(t, async args => {
    started();
    await held;
    return renderFixture(args);
  });
  const job = await service.createJob(owner, { tripId: trip.id });
  await running;
  assert.equal((await service.cancelJob(owner, job.id)).status, 'cancelled');
  release();
  for (let tries = 0; tries < 200; tries++) {
    if (!(await fs.readdir(path.join(dataDir, 'vouchers'))).length) break;
    await delay(5);
  }
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'vouchers')), []);
  await assert.rejects(service.verification(job.id), { status: 404 });
  assert.equal((await service.getJob(owner, job.id)).status, 'cancelled');
});

test('deleted trips revoke public verification and a missing private key never silently changes issuer identity', async t => {
  const { service, options, db, trip, dataDir } = await setup(t);
  const created = await service.createJob(owner, { tripId: trip.id });
  assert.equal((await finished(service, owner, created.id)).status, 'completed');
  const proof = await service.verification(created.id);
  await fs.unlink(path.join(dataDir, 'voucher-keys', 'key.json'));
  const restarted = createVoucherService(options);
  assert.deepEqual(await restarted.publicKey(proof.keyId), await service.publicKey(proof.keyId));
  await assert.rejects(restarted.createJob(owner, { tripId: trip.id }), { status: 503 });
  await assert.rejects(fs.stat(path.join(dataDir, 'voucher-keys', 'key.json')), { code: 'ENOENT' });
  db.trips = [];
  delete db.access[trip.id];
  assert.equal((await restarted.verification(created.id)).status, 'revoked');
  await assert.rejects(restarted.getImage(owner, created.id, 1), { status: 403 });
});

test('queued work is serialized and losing membership during rendering prevents issuance', async t => {
  let release;
  let started;
  let renders = 0;
  const held = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const { service, db, trip, dataDir } = await setup(t, async args => {
    renders++;
    if (renders === 1) { started(); await held; }
    return renderFixture(args);
  });
  addFormalMember(db, trip.id, 'viewer', 'Viewer', 'viewer');
  const viewer = { userId: 'viewer' };
  const first = await service.createJob(viewer, { tripId: trip.id });
  await running;
  const second = await service.createJob(owner, { tripId: trip.id });
  assert.equal((await service.getJob(owner, second.id)).status, 'queued');
  assert.equal(renders, 1);
  delete db.access[trip.id].members.viewer;
  release();
  assert.equal((await finished(service, owner, second.id)).status, 'completed');
  assert.equal(renders, 2);
  await assert.rejects(service.verification(first.id), { status: 404 });
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'vouchers')), [second.id]);
});

test('snapshot inputs reject untrusted fields, foreign attachments, and unsafe amounts without partial exports', async t => {
  const { service, trip, db } = await setup(t);
  await assert.rejects(service.createJob(owner, { tripId: trip.id, expenses: [] }), { status: 400 });
  await assert.rejects(service.createJob(owner, { tripId: trip.id, background: '<svg>' }), { status: 400 });
  await assert.rejects(service.createJob(owner, { tripId: trip.id, timeZone: '../../outside' }), { status: 400 });
  trip.expenses[0].images = ['/uploads/foreign.png'];
  db.assets['foreign.png'] = { tripId: 'another-trip', ownerId: 'owner' };
  await assert.rejects(service.createJob(owner, { tripId: trip.id, includeReceipts: true }), { status: 400 });
  trip.expenses[0].amount = Number.MAX_SAFE_INTEGER;
  await assert.rejects(service.createJob(owner, { tripId: trip.id }), { status: 400 });
  assert.deepEqual(await service.list(owner, trip.id), []);
});
