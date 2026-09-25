'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test('the initial owner setup seals data and issues a CSRF-protected session', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '../.local/server-auth-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(dir, 'setup-token');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ITHACA_DATA_DIR: dir, ITHACA_SETUP_TOKEN_PATH: tokenFile, ITHACA_ORIGIN: origin },
    stdio: 'ignore',
  });
  try {
    const token = await waitFor(tokenFile);
    assert.equal((await fetch(`${origin}/api/data`)).status, 401);
    const setup = await fetch(`${origin}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: 'owner', password: 'a secure owner password', token }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const { csrf } = await setup.json();
    const profilePath = `${origin}/api/auth/profile`;
    const profileBody = JSON.stringify({ displayName: 'Owner Name' });
    assert.equal((await fetch(profilePath, {
      method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: profileBody,
    })).status, 403);
    const profile = await fetch(profilePath, {
      method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: profileBody,
    });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).user.displayName, 'Owner Name');
    assert.equal((await (await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } })).json()).user.displayName, 'Owner Name');
    const data = await fetch(`${origin}/api/data`, { headers: { Cookie: cookie } });
    assert.equal(data.status, 200);
    const ownerData = await data.json();
    assert.equal(ownerData.trips.length, 1);
    const register = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: 'visitor', password: 'a secure visitor password' }),
    });
    assert.equal(register.status, 200);
    const visitorCookie = register.headers.get('set-cookie').split(';')[0];
    const visitorCsrf = (await register.json()).csrf;
    const visitorData = await (await fetch(`${origin}/api/data`, { headers: { Cookie: visitorCookie } })).json();
    assert.equal(visitorData.trips.length, 0);
    assert.equal(JSON.parse(await (await fetch(`${origin}/api/export`, { headers: { Cookie: visitorCookie } })).text()).trips.length, 0);
    const injected = await fetch(`${origin}/api/data`, {
      method: 'PUT',
      headers: { Cookie: visitorCookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': visitorCsrf },
      body: JSON.stringify({ baseVersion: visitorData.meta.version, data: ownerData }),
    });
    assert.equal(injected.status, 403);
    const image = Buffer.from('89504e470d0a1a0a', 'hex');
    const upload = await fetch(`${origin}/api/photos?tripId=${ownerData.trips[0].id}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'image/png' },
      body: image,
    });
    assert.equal(upload.status, 200);
    const photoUrl = (await upload.json()).url;
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: visitorCookie } })).status, 404);
    const latest = await (await fetch(`${origin}/api/data`, { headers: { Cookie: cookie } })).json();
    latest.trips[0].photos.push({ id: 'photo_1', url: photoUrl });
    const savedPhoto = await fetch(`${origin}/api/data`, {
      method: 'PUT',
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: latest.meta.version, data: latest }),
    });
    assert.equal(savedPhoto.status, 200);
    const exportData = (await savedPhoto.json()).data;
    const tripId = ownerData.trips[0].id;
    const shareCreated = await fetch(`${origin}/api/trips/${tripId}/share`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(shareCreated.status, 200);
    const shareToken = (await shareCreated.json()).token;
    const exchanged = await fetch(`${origin}/api/share/exchange`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: shareToken }),
    });
    assert.equal(exchanged.status, 200);
    const shareCookie = exchanged.headers.get('set-cookie').split(';')[0];
    const shared = await fetch(`${origin}/api/data`, { headers: { Cookie: shareCookie } });
    assert.equal(shared.status, 200);
    assert.deepEqual((await shared.json()).permissions, { [tripId]: 'viewer' });
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: shareCookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/data`, {
      method: 'PUT', headers: { Cookie: shareCookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
    })).status, 403);
    assert.equal((await fetch(`${origin}/api/trips/${tripId}/share`, {
      method: 'DELETE', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf },
    })).status, 200);
    assert.equal((await fetch(`${origin}/api/data`, { headers: { Cookie: shareCookie } })).status, 401);
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: shareCookie } })).status, 404);
    assert.equal((await fetch(`${origin}/api/link-preview`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })).status, 403);
    const importResponse = await fetch(`${origin}/api/import`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify(exportData),
    });
    assert.equal(importResponse.status, 200);
    const afterImport = (await importResponse.json()).data;
    assert.equal(afterImport.trips.length, 2);
    const copiedPhotoUrl = afterImport.trips[1].photos[0].url;
    assert.notEqual(copiedPhotoUrl, photoUrl);
    assert.equal((await fetch(`${origin}${copiedPhotoUrl}`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await (await fetch(`${origin}/api/data`, { headers: { Cookie: visitorCookie } })).json()).trips.length, 0);
    assert.equal((await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 403);
    assert.equal((await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf } })).status, 200);
    assert.equal((await fetch(`${origin}/api/data`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
