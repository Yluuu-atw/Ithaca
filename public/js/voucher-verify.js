'use strict';

(() => {
  const $ = id => document.getElementById(id);
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch (_) { /* Invalid fragments are handled below. */ }
  const matched = new Map();
  let manifest = null;
  let active = false;
  let record = null;
  let generation = 0;
  function applyTheme() {
    let base = matchMedia('(prefers-color-scheme: dark)').matches ? Theme.DARK_BG : '#f2ece0';
    try { base = localStorage.getItem('ithaca.voucherTheme') || base; } catch (_) { /* Storage may be unavailable. */ }
    Brand.apply(Theme.apply(base).brand);
  }
  applyTheme();
  window.addEventListener('storage', event => { if (event.key === 'ithaca.voucherTheme') applyTheme(); });
  window.addEventListener('hashchange', () => location.reload());

  function state(kind, title, detail) {
    $('verifyResult').dataset.state = kind;
    $('verifyStateTitle').textContent = title;
    $('verifyStateDetail').textContent = detail;
  }

  function decode(value) {
    if (typeof value !== 'string' || value.length > 200000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('签发记录的编码无效。');
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
  }

  async function json(path) {
    const response = await fetch(path, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (response.status === 404) throw new Error('找不到这份凭证，请检查二维码或核验链接。');
    if (response.status === 429) throw new Error('查询过于频繁，请稍后重试。');
    if (!response.ok) throw new Error('暂时无法查询本站签发记录，请联网后重试。');
    return response.json();
  }

  function validManifest(value, result) {
    if (!value || value.version !== 1 || value.algorithm !== 'Ed25519' || value.id !== id
      || value.keyId !== result.keyId || value.issuedAt !== result.issuedAt
      || !Number.isFinite(Date.parse(value.issuedAt)) || !/^[a-f0-9]{64}$/.test(value.snapshotSha256)
      || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 100) return false;
    try { if (new URL(value.issuer).origin !== location.origin) return false; }
    catch (_) { return false; }
    return value.pages.every((page, index) => page.page === index + 1
      && Number.isSafeInteger(page.width) && page.width > 0 && page.width <= 20000
      && Number.isSafeInteger(page.height) && page.height > 0 && page.height <= 100000
      && /^[a-f0-9]{64}$/.test(page.sha256));
  }

  async function signedRecord() {
    const result = await json(`/api/vouchers/${encodeURIComponent(id)}/verification`);
    if (!result || result.id !== id || !['valid', 'revoked'].includes(result.status)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(result.keyId)) throw new Error('签发记录格式无效，不能确认完整性。');
    if (!crypto.subtle) throw new Error('当前浏览器无法完成本地验签，请使用支持 Web Crypto 的较新浏览器。');
    const payload = decode(result.payload);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!validManifest(value, result)) throw new Error('签名清单与本站或凭证编号不一致，不能确认完整性。');
    const key = await json(`/api/voucher-keys/${encodeURIComponent(result.keyId)}`);
    if (key.keyId !== result.keyId || key.algorithm !== 'Ed25519' || key.format !== 'spki') throw new Error('签发公钥格式无效。');
    let publicKey;
    try { publicKey = await crypto.subtle.importKey('spki', decode(key.publicKey), { name: 'Ed25519' }, false, ['verify']); }
    catch (_) { throw new Error('当前浏览器无法使用本站的签名公钥完成核验，请换用支持 Ed25519 的较新浏览器。'); }
    const verified = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, decode(result.signature), payload);
    if (!verified) throw new Error('签名校验未通过，不能确认凭证由本站签发。');
    if (record && record.payload !== result.payload) throw new Error('此凭证的签名清单发生变化，不能继续核验。');
    return { result, value };
  }

  function details() {
    $('verifyDetails').replaceChildren();
    const entries = [
      ['凭证编号', id],
      ['签发时间', new Date(manifest.issuedAt).toLocaleString('zh-CN', { hour12: false })],
      ['图片张数', `${manifest.pages.length} 张`],
      ['签发站点', new URL(manifest.issuer).host],
    ];
    for (const [label, value] of entries) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      $('verifyDetails').append(dt, dd);
    }
    $('verifyDetails').hidden = false;
  }

  function pages() {
    $('verifyPages').replaceChildren();
    for (const page of manifest.pages) {
      const row = document.createElement('li');
      const number = document.createElement('span');
      const status = document.createElement('span');
      row.dataset.matched = String(matched.has(page.page));
      number.textContent = `第 ${page.page} / ${manifest.pages.length} 张`;
      status.textContent = matched.has(page.page) ? `原图一致 · ${matched.get(page.page)}` : '尚未核对图片';
      row.append(number, status);
      $('verifyPages').append(row);
    }
  }

  function showResult(unmatched = []) {
    $('verifyUnmatched').hidden = !unmatched.length;
    $('verifyUnmatched').textContent = unmatched.length ? `以下文件与签发原图不同，可能经过压缩、裁剪或修改，无法确认完整性：${unmatched.join('、')}` : '';
    if (record.status === 'revoked') {
      state('revoked', '此凭证已撤销在线核验', '历史签名仍可核对原始文件，但不应将此凭证视为当前有效凭证。');
    } else if (unmatched.length) {
      state('error', '部分文件无法确认完整性', `已核对一致 ${matched.size} / ${manifest.pages.length} 张。请提供全部原始 PNG 文件。`);
    } else if (matched.size === manifest.pages.length) {
      state('success', '图片与签发原图一致', `全部 ${manifest.pages.length} 张图片均通过签名和文件摘要核验，在线记录有效。`);
    } else if (matched.size) {
      state('pending', '已核对部分原图', `${matched.size} / ${manifest.pages.length} 张与签发原图一致，请继续选择其余原图。整份凭证尚未核对完整。`);
    } else {
      state('pending', '签发记录有效，尚未核对图片', '选择收到的原始 PNG 图片后，才可判断图片是否与签发原图一致。');
    }
  }

  async function load() {
    if (active) return;
    const token = ++generation;
    active = true;
    $('verifyFiles').disabled = true;
    $('verifyRetry').hidden = true;
    state('loading', '正在读取签发记录', '正在核对本站签名与在线有效状态。');
    try {
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) throw new Error('核验链接缺少有效凭证编号，请使用长图上的二维码打开。');
      const signed = await signedRecord();
      if (token !== generation) return;
      record = signed.result;
      manifest = signed.value;
      details();
      pages();
      showResult();
      $('verifyFilesSection').hidden = false;
      $('verifyFiles').disabled = false;
    } catch (error) {
      state('error', '暂时无法完成核验', error.message || '签发记录无法读取，请稍后重试。');
      $('verifyRetry').hidden = false;
    } finally { active = false; }
  }

  async function checkFiles(files) {
    if (active || !manifest || !files.length) return;
    active = true;
    $('verifyFiles').disabled = true;
    $('verifyRetry').hidden = true;
    const mismatched = [];
    try {
      state('loading', '正在核对图片', '图片只在当前浏览器中处理，不会上传。');
      const signed = await signedRecord();
      record = signed.result;
      for (const [index, file] of files.entries()) {
        state('loading', `正在核对第 ${index + 1} / ${files.length} 个文件`, '正在本地计算原图摘要。');
        if (file.size > 128 * 1024 * 1024 || file.size < 8) { mismatched.push(`${file.name}（文件大小不支持）`); continue; }
        const bytes = await file.arrayBuffer();
        const signature = new Uint8Array(bytes, 0, 8);
        const png = [137, 80, 78, 71, 13, 10, 26, 10];
        if (!png.every((value, position) => signature[position] === value)) { mismatched.push(file.name); continue; }
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
        const page = manifest.pages.find(entry => entry.sha256 === hash);
        if (page) matched.set(page.page, file.name);
        else mismatched.push(file.name);
        pages();
      }
      // Refresh revocation after local hashing, which may take time for long images.
      const latest = await signedRecord();
      record = latest.result;
      showResult(mismatched);
    } catch (error) {
      state('error', '核验尚未完成', error.message || '无法完成核验，请重试。');
      $('verifyRetry').hidden = false;
    } finally {
      active = false;
      $('verifyFiles').value = '';
      $('verifyFiles').disabled = false;
    }
  }

  $('verifyRetry').addEventListener('click', load);
  $('verifyFiles').addEventListener('change', event => checkFiles([...event.target.files]));
  load();
})();
