'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
  const results = new Map();
  const batchFailures = new Map();
  const recordFailure = Symbol('record');
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch (_) { /* The file can identify a voucher without a valid fragment. */ }
  if (!validId(id)) id = '';
  let manifest = null;
  let record = null;
  let active = false;
  let controller = null;
  let cancelled = false;

  function applyTheme() {
    let base = matchMedia('(prefers-color-scheme: dark)').matches ? Theme.DARK_BG : '#f2ece0';
    try { base = localStorage.getItem('ithaca.voucherTheme') || base; } catch (_) { /* Storage may be unavailable. */ }
    Brand.apply(Theme.apply(base).brand);
  }
  applyTheme();
  window.addEventListener('storage', event => { if (event.key === 'ithaca.voucherTheme') applyTheme(); });
  window.addEventListener('hashchange', () => location.reload());

  function state(kind, title, detail = '') {
    $('verifyResult').dataset.state = kind;
    $('verifyStateTitle').textContent = title;
    $('verifyStateDetail').textContent = detail;
    $('verifyStateDetail').hidden = !detail;
  }

  function activity(title, progress) {
    $('verifyActivityTitle').textContent = title;
    $('verifyActivityCount').textContent = Number.isFinite(progress) ? `${progress}%` : '';
    if (Number.isFinite(progress)) $('verifyProgress').value = progress;
    else $('verifyProgress').removeAttribute('value');
  }

  function setBusy(value) {
    active = value;
    $('verifyFiles').disabled = value;
    $('verifyActivity').hidden = !value;
    $('verifyRetry').hidden = true;
    if (value) {
      controller = new AbortController();
      cancelled = false;
    } else controller = null;
  }

  function decode(value) {
    if (typeof value !== 'string' || value.length > 200000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('签名格式无效。');
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
  }

  function responseError(status) {
    if (status === 404) return '找不到这份凭证。';
    if (status === 413) return '图片不能超过 32 MB。';
    if (status === 422) return '图片格式或尺寸不支持。';
    if (status === 429) return '核验繁忙，请稍后重试。';
    return '暂时无法核验，请稍后重试。';
  }

  async function json(path, signal) {
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    const timer = setTimeout(abort, 30000);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(path, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: timeout.signal });
      if (!response.ok) throw new Error(responseError(response.status));
      return response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  function validManifest(value, proof, expectedId) {
    if (!value || value.version !== 1 || value.algorithm !== 'Ed25519' || value.id !== expectedId
      || value.keyId !== proof.keyId || value.issuedAt !== proof.issuedAt
      || !Number.isFinite(Date.parse(value.issuedAt)) || !/^[a-f0-9]{64}$/.test(value.snapshotSha256)
      || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 20) return false;
    try { if (new URL(value.issuer).origin !== location.origin) return false; }
    catch (_) { return false; }
    return value.pages.every((page, index) => page.page === index + 1
      && page.width === 1080
      && Number.isSafeInteger(page.height) && page.height >= 1080 && page.height <= 12000
      && /^[a-f0-9]{64}$/.test(page.sha256) && page.watermark === 'ithaca-dct-v1');
  }

  async function signedRecord(expectedId, supplied, signal) {
    const proof = supplied || await json(`/api/vouchers/${encodeURIComponent(expectedId)}/verification`, signal);
    if (!proof || proof.id !== expectedId || !['valid', 'revoked'].includes(proof.status)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(proof.keyId)) throw new Error('签发记录无效。');
    if (!crypto.subtle) throw new Error('当前浏览器不支持验签。');
    const payload = decode(proof.payload);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
    catch (_) { throw new Error('签名清单无效。'); }
    if (!validManifest(value, proof, expectedId)) throw new Error('凭证签名或隐水印版本不匹配。');
    const key = await json(`/api/voucher-keys/${encodeURIComponent(proof.keyId)}`, signal);
    if (key.keyId !== proof.keyId || key.algorithm !== 'Ed25519' || key.format !== 'spki') throw new Error('签发公钥无效。');
    let publicKey;
    try { publicKey = await crypto.subtle.importKey('spki', decode(key.publicKey), { name: 'Ed25519' }, false, ['verify']); }
    catch (_) { throw new Error('请使用支持 Ed25519 的较新浏览器。'); }
    const verified = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, decode(proof.signature), payload);
    if (!verified) throw new Error('签名校验未通过。');
    if (record && record.id === expectedId && record.payload !== proof.payload) throw new Error('签名清单发生变化。');
    signal?.throwIfAborted();
    return { proof, value };
  }

  function details() {
    $('verifyDetails').replaceChildren();
    if (!manifest) { $('verifyDetails').hidden = true; return; }
    for (const [label, value] of [
      ['凭证编号', id],
      ['签发时间', new Date(manifest.issuedAt).toLocaleString('zh-CN', { hour12: false })],
      ['图片张数', `${manifest.pages.length} 张`],
    ]) {
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
    for (const page of manifest?.pages || []) {
      const result = results.get(page.page);
      const row = document.createElement('li');
      const number = document.createElement('span');
      const status = document.createElement('span');
      row.dataset.matched = String(result?.result === 'matched');
      row.dataset.result = result?.result || 'pending';
      number.textContent = `第 ${page.page} / ${manifest.pages.length} 张`;
      status.textContent = result ? ({ matched: '未发现内容修改', different: '图片存在差异', inconclusive: '无法核验', revoked: '凭证已撤销' }[result.result] || '待核验') : '待核验';
      row.append(number, status);
      $('verifyPages').append(row);
    }
  }

  function showResult() {
    const failures = [...batchFailures.values()];
    $('verifyUnmatched').hidden = !failures.length;
    $('verifyUnmatched').textContent = failures.map(value => value.message).join('；');
    const checked = [...results.values()];
    const count = checked.filter(value => value.result === 'matched').length;
    const summary = manifest ? `${count} / ${manifest.pages.length} 张已核验` : '';
    const reason = checked.find(value => value.result === 'inconclusive')?.reason;
    const guidance = {
      resolution: '清晰度不足', image_resolution: '清晰度不足',
      geometry: '尺寸或比例不匹配', image_geometry: '尺寸或比例不匹配',
      quality: '压缩过重', lossy_ambiguous: '压缩过重', watermark: '未识别到隐水印',
    }[reason];
    if (record?.status === 'revoked' || [...checked, ...failures].some(value => value.result === 'revoked')) state('revoked', '凭证已撤销');
    else if ([...checked, ...failures].some(value => value.result === 'different')) state('error', '图片存在差异', summary);
    else if (failures.length || checked.some(value => value.result === 'inconclusive')) state('error', '无法核验', [summary, guidance].filter(Boolean).join(' · '));
    else if (manifest && count === manifest.pages.length) state('success', '未发现内容修改', summary);
    else if (count) state('pending', '尚未核验完整', summary);
    else state('pending', '待核验', manifest ? '选择图片核验' : '选择账单凭证图片');
  }

  function invalidate(file, page) {
    if (Number.isSafeInteger(page) && manifest?.pages.some(entry => entry.page === page)) {
      results.set(page, { result: 'inconclusive', filename: file.name });
      return;
    }
    const known = [...results].filter(([, value]) => value.filename === file.name);
    if (known.length) {
      for (const [number] of known) results.set(number, { result: 'inconclusive', filename: file.name });
    } else {
      // An unreadable watermark cannot identify which previously checked page it replaces.
      for (const [number, value] of results) if (value.result === 'matched') results.set(number, { ...value, result: 'inconclusive' });
    }
  }

  async function imageType(file) {
    if (file.size > 32 * 1024 * 1024) throw new Error('图片不能超过 32 MB。');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if ([82, 73, 70, 70].every((value, index) => bytes[index] === value)
      && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return 'image/webp';
    throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  }

  function upload(file, type, signal, index, total) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = (error, value) => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      xhr.open('POST', '/api/voucher-check');
      xhr.withCredentials = false;
      xhr.timeout = 30000;
      xhr.responseType = 'json';
      xhr.setRequestHeader('Content-Type', type);
      if (id) xhr.setRequestHeader('X-Voucher-Id', id);
      xhr.upload.onprogress = event => activity(`上传图片 · ${index + 1} / ${total}`, event.lengthComputable ? Math.floor(event.loaded / event.total * 100) : undefined);
      xhr.upload.onload = () => activity(`正在核验 · ${index + 1} / ${total}`);
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300
        ? finish(null, xhr.response) : finish(new Error(responseError(xhr.status)));
      xhr.onerror = () => finish(new Error('网络中断，请重试。'));
      xhr.ontimeout = () => finish(new Error('核验超时，请重试。'));
      xhr.onabort = () => finish(new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { finish(new DOMException('Cancelled', 'AbortError')); return; }
      activity(`上传图片 · ${index + 1} / ${total}`, 0);
      xhr.send(file);
    });
  }

  async function accept(result, file, signal) {
    if (!result || !['matched', 'different', 'inconclusive', 'revoked'].includes(result.result)) throw new Error('核验结果无效。');
    if (result.reason === 'identity' || result.id && id && result.id !== id) throw new Error('所选图片不是这份凭证。');
    if (!validId(result.id)) throw new Error('未识别到有效隐水印。');
    if (id === result.id && Number.isSafeInteger(result.page)) invalidate(file, result.page);
    if (result.result === 'matched' && !result.verification) throw new Error('缺少凭证签名。');
    const signed = await signedRecord(result.id, result.verification, signal);
    if (result.result !== 'revoked' && (!Number.isSafeInteger(result.page) || result.page < 1
      || result.page > signed.value.pages.length || result.pageCount !== signed.value.pages.length)) throw new Error('图片页码与签名不匹配。');
    if (result.result === 'matched' && signed.proof.status !== 'valid') result = { ...result, result: 'revoked' };
    id = result.id;
    record = signed.proof;
    manifest = signed.value;
    if (result.result === 'revoked') record = { ...record, status: 'revoked' };
    if (Number.isSafeInteger(result.page)) results.set(result.page, { result: result.result, filename: file.name, reason: result.reason });
    details();
    pages();
    return result;
  }

  async function load() {
    if (active) return;
    if (!id) { showResult(); return; }
    setBusy(true);
    activity('正在读取凭证');
    state('loading', '正在读取凭证');
    try {
      const signed = await signedRecord(id, null, controller.signal);
      record = signed.proof;
      manifest = signed.value;
      details();
      pages();
      showResult();
    } catch (error) {
      state('error', cancelled ? '已取消核验' : '无法核验', cancelled ? '' : error.message);
    } finally {
      setBusy(false);
      $('verifyRetry').hidden = !!record || cancelled;
    }
  }

  async function checkFiles(files) {
    if (active || !files.length) return;
    if (files.length > 20) { state('error', '无法核验', '每次最多选择 20 张图片。'); return; }
    batchFailures.clear();
    setBusy(true);
    state('loading', '正在核验');
    $('verifyActivity').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    try {
      for (const [index, file] of files.entries()) {
        try {
          const type = await imageType(file);
          controller.signal.throwIfAborted();
          const result = await upload(file, type, controller.signal, index, files.length);
          const accepted = await accept(result, file, controller.signal);
          if (accepted.result !== 'matched') {
            // Each selected file keeps its outcome even when another file has the same name or page.
            const message = { different: '图片存在差异', inconclusive: '无法核验', revoked: '凭证已撤销' }[accepted.result];
            batchFailures.set(index, { result: accepted.result, message: `${file.name}：${message}` });
          }
        } catch (error) {
          invalidate(file);
          pages();
          if (cancelled) break;
          batchFailures.set(index, { result: 'inconclusive', message: `${file.name}：${error.message || '无法核验。'}` });
        }
      }
      if (!cancelled && record) {
        // Refresh revocation after a batch without repeating image uploads.
        try { record = (await signedRecord(id, null, controller.signal)).proof; }
        catch (error) { batchFailures.set(recordFailure, { result: 'inconclusive', message: error.message || '无法查询凭证状态。' }); }
      }
      showResult();
      if (cancelled) state('pending', '已取消核验');
    } finally {
      setBusy(false);
      $('verifyFiles').value = '';
    }
  }

  $('verifyRetry').addEventListener('click', load);
  $('verifyFiles').addEventListener('change', event => checkFiles([...event.target.files]));
  $('verifyCancel').addEventListener('click', () => { cancelled = true; controller?.abort(); });
  load();
})();
