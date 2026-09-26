'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const sharp = require('sharp');

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
    assert.ok(ownerData.appearanceChoices.avatars.length > 1);
    assert.ok(ownerData.appearanceChoices.colors.length > 1);
    assert.equal(ownerData.rosters[ownerData.trips[0].id][0].displayName, 'Owner Name');
    const accountSearch = await fetch(`${origin}/api/users?q=Name`, { headers: { Cookie: cookie } });
    assert.equal((await accountSearch.json()).users[0].username, 'owner');
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
    const image = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#b68b61' } }).png().toBuffer();
    const upload = await fetch(`${origin}/api/photos?tripId=${ownerData.trips[0].id}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'image/png' },
      body: image,
    });
    assert.equal(upload.status, 200);
    const uploadedPhoto = await upload.json();
    const photoUrl = uploadedPhoto.url;
    const name = photoUrl.slice('/uploads/'.length);
    assert.equal(uploadedPhoto.previewUrl, `/api/image-previews/${name}.webp`);
    assert.ok(fs.existsSync(path.join(dir, 'thumbs', `${name}.webp`)));
    const thumbUrl = `/api/photo-thumbs/${photoUrl.slice('/uploads/'.length)}.webp`;
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: visitorCookie } })).status, 404);
    assert.equal((await fetch(`${origin}${thumbUrl}`, { headers: { Cookie: visitorCookie } })).status, 404);
    const thumb = await fetch(`${origin}${thumbUrl}`, { headers: { Cookie: cookie } });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    assert.equal(thumb.headers.get('cache-control'), 'private, no-store');
    const thumbBytes = Buffer.from(await thumb.arrayBuffer());
    assert.ok(thumbBytes.length < image.length);
    const thumbInfo = await sharp(thumbBytes).metadata();
    assert.equal(thumbInfo.format, 'webp');
    assert.equal(thumbInfo.width, 480);
    assert.equal(thumbInfo.height, 480);
    assert.equal((await fetch(`${origin}${thumbUrl}`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${origin}${uploadedPhoto.previewUrl}`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${origin}${uploadedPhoto.previewUrl}`, { headers: { Cookie: visitorCookie } })).status, 404);
    const otherImage = await fetch(`${origin}/api/images?tripId=${ownerData.trips[0].id}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'image/png' }, body: image,
    });
    assert.equal(otherImage.status, 200);
    const otherAsset = await otherImage.json();
    assert.ok(otherAsset.url.startsWith('/uploads/'));
    assert.ok(fs.existsSync(path.join(dir, 'thumbs', `${otherAsset.url.slice('/uploads/'.length)}.webp`)));
    const beforeInvalid = fs.readdirSync(path.join(dir, 'uploads')).length;
    const invalidImage = await fetch(`${origin}/api/images?tripId=${ownerData.trips[0].id}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'image/png' }, body: Buffer.from('not an image'),
    });
    assert.equal(invalidImage.status, 400);
    assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, beforeInvalid);
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
    const profileUrl = `${origin}/api/trips/${tripId}/profile`;
    const currentPerson = exportData.rosters[tripId][0];
    assert.equal((await fetch(profileUrl, {
      method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripNickname: 'Trip Owner', avatar: currentPerson.avatar, color: currentPerson.color }),
    })).status, 403);
    const tripProfile = await fetch(profileUrl, {
      method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripNickname: 'Trip Owner', avatar: currentPerson.avatar, color: currentPerson.color }),
    });
    assert.equal(tripProfile.status, 200);
    assert.equal((await tripProfile.json()).displayName, 'Trip Owner');
    assert.equal((await (await fetch(`${origin}/api/data`, { headers: { Cookie: cookie } })).json()).rosters[tripId][0].displayName, 'Trip Owner');
    const tempCreated = await fetch(`${origin}/api/trips/${tripId}/temporary`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temporary Guest' }),
    });
    assert.equal(tempCreated.status, 200);
    const temporary = await tempCreated.json();
    const exchangedTemp = await fetch(`${origin}/api/temporary/exchange`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: temporary.token }),
    });
    const tempCookie = exchangedTemp.headers.get('set-cookie').split(';')[0];
    const tempCsrf = (await exchangedTemp.json()).csrf;
    assert.equal((await fetch(profileUrl, {
      method: 'PATCH', headers: { Cookie: tempCookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripNickname: 'Temp', avatar: temporary.person.avatar, color: temporary.person.color }),
    })).status, 403);
    assert.equal((await fetch(profileUrl, {
      method: 'PATCH', headers: { Cookie: tempCookie, Origin: origin, 'X-CSRF-Token': tempCsrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripNickname: 'Temp', avatar: temporary.person.avatar, color: temporary.person.color }),
    })).status, 200);
    assert.equal((await (await fetch(`${origin}/api/data`, { headers: { Cookie: tempCookie } })).json()).rosters[tripId].find(person => person.id === temporary.person.id).displayName, 'Temp');
    const settlementDoc = await (await fetch(`${origin}/api/data`, { headers: { Cookie: cookie } })).json();
    settlementDoc.trips[0].expenses.push({ id: 'expense_settlement', payer: settlementDoc.trips[0].meta.members[0],
      participants: [settlementDoc.trips[0].meta.members[0], temporary.person.name], amount: 10 });
    const settlementSave = await fetch(`${origin}/api/data`, {
      method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: settlementDoc.meta.version, data: settlementDoc }),
    });
    assert.equal(settlementSave.status, 200);
    const tempSettlement = (await (await fetch(`${origin}/api/data`, { headers: { Cookie: tempCookie } })).json()).mySettlements[tripId];
    assert.equal(tempSettlement.transfers[0].direction, 'out');
    const transfersUrl = `${origin}/api/trips/${tripId}/transfers`;
    const transferBody = JSON.stringify({ key: tempSettlement.transfers[0].key, confirmed: true });
    assert.equal((await fetch(transfersUrl, {
      method: 'PATCH', headers: { Cookie: tempCookie, Origin: origin, 'Content-Type': 'application/json' }, body: transferBody,
    })).status, 403);
    const transferUpdate = await fetch(transfersUrl, {
      method: 'PATCH', headers: { Cookie: tempCookie, Origin: origin, 'X-CSRF-Token': tempCsrf, 'Content-Type': 'application/json' },
      body: transferBody,
    });
    assert.equal(transferUpdate.status, 200);
    assert.equal((await transferUpdate.json()).transfers[0].confirmed, true);
    assert.equal((await (await fetch(`${origin}/api/data`, { headers: { Cookie: cookie } })).json()).mySettlements[tripId].transfers[0].confirmed, false);
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
    const sharedData = await shared.json();
    assert.deepEqual(sharedData.permissions, { [tripId]: 'viewer' });
    assert.deepEqual(sharedData.mySettlements, {});
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: shareCookie } })).status, 200);
    assert.equal((await fetch(`${origin}${thumbUrl}`, { headers: { Cookie: shareCookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/data`, {
      method: 'PUT', headers: { Cookie: shareCookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
    })).status, 403);
    assert.equal((await fetch(`${origin}/api/trips/${tripId}/share`, {
      method: 'DELETE', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf },
    })).status, 200);
    assert.equal((await fetch(`${origin}/api/data`, { headers: { Cookie: shareCookie } })).status, 401);
    assert.equal((await fetch(`${origin}${photoUrl}`, { headers: { Cookie: shareCookie } })).status, 404);
    assert.equal((await fetch(`${origin}${thumbUrl}`, { headers: { Cookie: shareCookie } })).status, 401);
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
