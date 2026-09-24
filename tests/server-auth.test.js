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
    assert.equal((await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 403);
    assert.equal((await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf } })).status, 200);
    assert.equal((await fetch(`${origin}/api/data`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
