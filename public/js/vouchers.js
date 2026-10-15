'use strict';

window.Vouchers = (() => {
  const stages = {
    queued: '正在等待生成', preparing: '正在整理账单', attachments: '正在处理票据预览',
    layout: '正在排版账单', rendering: '正在生成长图', signing: '正在签发凭证', ready: '凭证已生成',
    cancelled: '已取消生成', failed: '生成失败', unavailable: '无法继续查询任务',
  };
  let session = null;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const receipt = expense => !!(expense.receipt || Array.isArray(expense.images) && expense.images.length);
  const money = (minor, currency) => {
    try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency || 'CNY', minimumFractionDigits: 2 }).format(minor / 100); }
    catch (_) { return `${(minor / 100).toFixed(2)} ${currency || ''}`; }
  };
  const date = value => {
    const result = new Date(value);
    return Number.isFinite(result.getTime()) ? result.toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  };
  const alive = state => session === state && state.dialog.open;
  const busy = state => state.creating || state.cancelling || state.job && ['queued', 'running'].includes(state.job.status);
  const get = (state, selector) => state.dialog.querySelector(selector);

  async function request(state, path, method = 'GET', body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.Store?.getCsrf() || state.csrf || '' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(result.error || `请求未完成（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return result;
    } finally { clearTimeout(timeout); }
  }

  function summary(state) {
    const filter = get(state, '[name=voucherFilter]:checked').value;
    const expenses = (state.trip.expenses || []).filter(entry => filter === 'all' || receipt(entry));
    const total = expenses.reduce((sum, entry) => sum + Math.round((Number(entry.amount) || 0) * 100), 0);
    get(state, '[data-voucher-summary]').innerHTML = `<strong>${esc(money(total, state.trip.meta?.currency))}</strong><span>${expenses.length} 笔 · ${filter === 'all' ? '全部账单' : '仅票据账单'}${expenses.length ? '' : '，暂无可导出的账单'}</span>`;
    get(state, '[data-voucher-action=generate]').disabled = !expenses.length;
  }

  function setError(state, message) {
    const node = get(state, '[data-voucher-error]');
    node.textContent = message || '';
    node.hidden = !message;
  }

  function stopTracking(state, error) {
    if (![401, 403, 404].includes(error.status)) return false;
    clearTimeout(state.timer);
    state.job = { id: state.job?.id || '', status: 'unavailable', progress: { stage: 'unavailable' } };
    state.creating = false;
    state.cancelling = false;
    state.uncertain = false;
    state.cancelIntent = false;
    state.closeAfterCancel = false;
    state.disconnected = false;
    state.requestId = null;
    state.requestBody = null;
    get(state, '[data-voucher-cancel-question]').hidden = true;
    setError(state, error.status === 404
      ? '生成任务已失效，请重新生成。已完成的凭证可在“已生成的凭证”中查看。'
      : error.status === 401 ? '登录已失效，无法继续查询任务，请重新登录。尚无法确认服务端是否已完成或取消。'
        : '当前身份无法继续查询此任务。尚无法确认服务端是否已完成或取消，可关闭此窗口。');
    controls(state);
    loadRecent(state);
    return true;
  }

  function controls(state) {
    const working = !!busy(state);
    const completed = state.job?.status === 'completed';
    get(state, '[data-voucher-form]').hidden = completed;
    get(state, '[data-voucher-form] fieldset').disabled = working || !!state.uncertain;
    get(state, '[name=voucherReceipts]').disabled = working || !!state.uncertain;
    get(state, '[data-voucher-action=generate]').hidden = working || completed;
    get(state, '[data-voucher-action=cancel]').hidden = !working && !state.uncertain;
    get(state, '[data-voucher-action=refresh]').hidden = !state.disconnected;
    get(state, '[data-voucher-action=close-footer]').hidden = working;
    get(state, '[data-voucher-action=keep]').disabled = !!state.cancelling;
    get(state, '[data-voucher-action=cancel-confirm]').disabled = !!state.cancelling;
    get(state, '[data-voucher-action=again]').hidden = !completed;
    const save = get(state, '[data-voucher-save]');
    const pages = state.result?.pages || [];
    save.hidden = !completed || pages.length !== 1;
    if (completed && pages.length === 1) {
      save.href = `/api/vouchers/${encodeURIComponent(state.result.id)}/images/1?download=1`;
      save.download = `ithaca-${state.result.id}-1.png`;
    }
    get(state, '[data-voucher-action=save-pages]').hidden = !completed || pages.length < 2;
    get(state, '[data-voucher-recent]').hidden = working || !state.recent.length;
    get(state, '[data-voucher-progress-box]').hidden = !working && !state.job;
    const progress = state.job?.progress || { stage: 'preparing' };
    const total = Number(progress.total);
    const done = Number(progress.completed);
    const measurable = Number.isFinite(total) && total > 0 && Number.isFinite(done) && done >= 0;
    get(state, '[data-voucher-stage]').textContent = state.cancelling ? '正在取消生成' : state.creating ? '正在提交生成任务' : stages[progress.stage] || '正在生成凭证';
    get(state, '[data-voucher-count]').textContent = measurable ? `${Math.min(done, total)} / ${total}` : '';
    const meter = get(state, 'progress');
    if (measurable) { meter.max = total; meter.value = Math.min(done, total); }
    else meter.removeAttribute('value');
    meter.hidden = !working;
    state.dialog.setAttribute('aria-busy', String(working));
  }

  function schedule(state) {
    clearTimeout(state.timer);
    if (alive(state) && busy(state) && !state.creating && !state.cancelling && !state.disconnected) {
      state.timer = setTimeout(() => refresh(state), 900);
    }
  }

  async function receive(state, job) {
    if (!alive(state)) return;
    state.job = job;
    state.creating = false;
    state.uncertain = false;
    state.disconnected = false;
    if (state.cancelIntent && busy(state)) { await cancel(state); return; }
    if (job.status === 'completed') {
      state.cancelIntent = false;
      get(state, '[data-voucher-cancel-question]').hidden = true;
      renderResult(state, job.result);
      loadRecent(state);
    } else if (job.status === 'failed') {
      state.requestId = null;
      state.requestBody = null;
      state.cancelIntent = false;
      get(state, '[data-voucher-cancel-question]').hidden = true;
      setError(state, job.error || '生成失败，请重试。');
    } else if (job.status === 'cancelled') {
      state.cancelIntent = false;
      state.requestId = null;
      state.requestBody = null;
      get(state, '[data-voucher-cancel-question]').hidden = true;
      if (state.closeAfterCancel) { close(state); return; }
    }
    controls(state);
    schedule(state);
  }

  async function refresh(state) {
    if (!alive(state) || !state.job || state.polling) return;
    state.polling = true;
    const turn = ++state.requestTurn;
    try {
      const job = await request(state, `/api/voucher-jobs/${encodeURIComponent(state.job.id)}`);
      if (alive(state) && turn === state.requestTurn) { setError(state, ''); await receive(state, job); }
    } catch (error) {
      if (alive(state) && turn === state.requestTurn) {
        if (stopTracking(state, error)) return;
        state.disconnected = true;
        setError(state, `${error.message}。任务可能仍在继续，请重新查询后再操作。`);
        controls(state);
      }
    } finally { state.polling = false; }
  }

  async function generate(state) {
    if (busy(state)) return;
    state.creating = true;
    state.cancelIntent = false;
    state.closeAfterCancel = false;
    state.disconnected = false;
    state.job = null;
    setError(state, '');
    state.requestId ||= crypto.randomUUID();
    state.requestBody ||= {
      tripId: state.trip.id, filter: get(state, '[name=voucherFilter]:checked').value,
      includeReceipts: get(state, '[name=voucherReceipts]').checked,
      background: state.themeBase, timeZone: state.timeZone, requestId: state.requestId,
    };
    controls(state);
    try {
      await receive(state, await request(state, '/api/voucher-jobs', 'POST', state.requestBody));
    } catch (error) {
      if (!alive(state)) return;
      state.creating = false;
      state.uncertain = !error.status || error.status >= 500;
      if (!state.uncertain) { state.requestId = null; state.requestBody = null; }
      const message = error.name === 'AbortError' ? '请求超时' : error.message;
      setError(state, state.uncertain ? `${message}。重试会查询同一次生成任务，不会重复签发。` : message);
      get(state, '[data-voucher-action=generate]').textContent = state.uncertain ? '重试本次生成' : '重新生成';
      controls(state);
    }
  }

  function askCancel(state, closeAfterCancel = false) {
    if (!busy(state) && !state.uncertain) { if (closeAfterCancel) close(state); return; }
    state.closeAfterCancel = closeAfterCancel;
    get(state, '[data-voucher-cancel-question]').hidden = false;
    get(state, '[data-voucher-action=keep]').focus();
  }

  async function cancel(state) {
    if (!alive(state) || state.cancelling) return;
    state.cancelIntent = true;
    if (state.creating) { get(state, '[data-voucher-stage]').textContent = '等待任务创建后取消'; return; }
    if (!state.job && state.uncertain) {
      state.creating = true;
      controls(state);
      try { await receive(state, await request(state, '/api/voucher-jobs', 'POST', state.requestBody)); }
      catch (error) {
        if (!alive(state)) return;
        if (stopTracking(state, error)) return;
        state.creating = false;
        setError(state, `${error.message}。暂时无法确认取消，请保持页面并重新查询。`);
        controls(state);
      }
      return;
    }
    if (!state.job) return;
    state.cancelling = true;
    ++state.requestTurn;
    controls(state);
    try {
      const job = await request(state, `/api/voucher-jobs/${encodeURIComponent(state.job.id)}`, 'DELETE');
      state.cancelling = false;
      state.cancelIntent = false;
      state.uncertain = false;
      state.requestBody = null;
      await receive(state, job);
    } catch (error) {
      if (!alive(state)) return;
      if (stopTracking(state, error)) return;
      state.cancelling = false;
      state.disconnected = true;
      setError(state, `${error.message}。尚未确认取消，请重新查询。`);
      controls(state);
    }
  }

  function renderResult(state, voucher) {
    if (!voucher || !Array.isArray(voucher.pages)) return;
    state.result = voucher;
    state.uncertain = false;
    state.requestBody = null;
    const box = get(state, '[data-voucher-result]');
    box.hidden = false;
    const revoked = voucher.status === 'revoked';
    const verifyUrl = `/verify-voucher#${encodeURIComponent(voucher.id)}`;
    box.innerHTML = `<div class="voucher-summary"><strong>${esc(money(voucher.totalMinor, voucher.currency))}</strong><span>${voucher.count} 笔 · ${voucher.pageCount} 张 · ${esc(date(voucher.issuedAt))}</span></div>
      <p class="voucher-note">${revoked ? '此凭证已撤销在线核验。' : '已签发为独立快照。请发送原始 PNG 文件，压缩或截图后将无法核验。'}${voucher.pageCount > 1 ? '请保存全部页面，整份核验需要每一张原图。' : ''}</p>
      <div class="voucher-pages">${voucher.pages.map(page => {
        const url = `/api/vouchers/${encodeURIComponent(voucher.id)}/images/${page.page}`;
        const preview = `/api/vouchers/${encodeURIComponent(voucher.id)}/previews/${page.page}`;
        return `<section class="voucher-page"><h3>第 ${page.page} / ${voucher.pageCount} 张</h3>
          <a class="voucher-page-preview" href="${url}" target="_blank" rel="noopener" aria-label="查看第 ${page.page} 张原图"><img src="${preview}" alt="第 ${page.page} 张凭证预览" loading="lazy"></a>
          <div class="voucher-actions"><a class="btn btn-primary" href="${url}" download="ithaca-${esc(voucher.id)}-${page.page}.png">保存原图</a><a class="btn btn-ghost" href="${url}" target="_blank" rel="noopener">放大查看</a>${navigator.share && navigator.canShare ? `<button type="button" class="btn btn-ghost" data-voucher-action="share" data-page="${page.page}">准备分享</button>` : ''}</div>
        </section>`;
      }).join('')}</div>
      <div class="voucher-actions" style="margin-top:18px"><a class="btn btn-ghost" href="${verifyUrl}" target="_blank" rel="noopener">核验原图</a>${voucher.canRevoke && !revoked ? '<button type="button" class="btn btn-ghost" data-voucher-action="revoke">撤销在线核验</button>' : ''}</div>
      <div data-voucher-revoke-question class="voucher-cancel-question" hidden><p>撤销后，核验页会显示已撤销。已保存的图片仍会保留。</p><div class="voucher-actions"><button type="button" class="btn btn-ghost" data-voucher-action="revoke-back">保留凭证</button><button type="button" class="btn btn-ghost" data-voucher-action="revoke-confirm">确认撤销</button></div></div>`;
  }

  async function share(state, button) {
    const page = Number(button.dataset.page);
    const key = `${state.result.id}:${page}`;
    const file = state.shareFiles.get(key);
    if (file) {
      try { await navigator.share({ files: [file], title: '九州 ITHACA · 账单凭证' }); }
      catch (error) { if (error.name !== 'AbortError') setError(state, '系统分享未完成，请使用“保存原图”。'); }
      return;
    }
    button.disabled = true;
    button.textContent = '正在准备原图';
    try {
      const response = await fetch(`/api/vouchers/${encodeURIComponent(state.result.id)}/images/${page}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('无法读取原图，请确认旅行访问权限。');
      const blob = await response.blob();
      const ready = new File([blob], `ithaca-${state.result.id}-${page}.png`, { type: 'image/png' });
      if (!navigator.canShare({ files: [ready] })) throw new Error('当前设备无法分享此文件，请使用“保存原图”。');
      if (!alive(state)) return;
      state.shareFiles.set(key, ready);
      button.textContent = '打开系统分享';
    } catch (error) { setError(state, error.message); button.textContent = '准备分享'; }
    finally { button.disabled = false; }
  }

  async function revoke(state) {
    const button = get(state, '[data-voucher-action=revoke-confirm]');
    button.disabled = true;
    try {
      await request(state, `/api/vouchers/${encodeURIComponent(state.result.id)}`, 'DELETE');
      if (!alive(state)) return;
      renderResult(state, { ...state.result, status: 'revoked' });
      loadRecent(state);
    } catch (error) { if (alive(state)) { setError(state, error.message); button.disabled = false; } }
  }

  async function loadRecent(state) {
    try {
      const data = await request(state, `/api/vouchers?tripId=${encodeURIComponent(state.trip.id)}`);
      if (!alive(state)) return;
      state.recent = data.vouchers || [];
      const box = get(state, '[data-voucher-recent]');
      box.hidden = busy(state) || !state.recent.length;
      box.innerHTML = `<h3>已生成的凭证</h3><ul class="voucher-recent-list">${state.recent.map(voucher => `<li><div>${esc(date(voucher.issuedAt))}<small>${voucher.count} 笔 · ${voucher.pageCount} 张 · ${voucher.status === 'revoked' ? '已撤销' : voucher.filter === 'receipt' ? '票据' : '全部账单'}</small></div><button type="button" class="btn btn-ghost btn-sm" data-voucher-action="recent" data-id="${esc(voucher.id)}">查看</button></li>`).join('')}</ul>`;
    } catch (_) { /* Export remains available when the history request fails. */ }
  }

  function close(state, fromHistory = false) {
    if (!alive(state)) return;
    if (busy(state) || state.uncertain) { askCancel(state, true); return; }
    clearTimeout(state.timer);
    state.dialog.close();
    state.dialog.remove();
    window.removeEventListener('beforeunload', state.onUnload);
    window.removeEventListener('popstate', state.onBack);
    state.shareFiles.clear();
    session = null;
    if (!fromHistory && history.state?.voucherDialog === state.marker) history.back();
    state.opener?.focus({ preventScroll: true });
  }

  function open(options) {
    if (session) { session.dialog.focus(); return; }
    const dialog = document.createElement('dialog');
    dialog.className = 'voucher-dialog';
    dialog.setAttribute('aria-labelledby', 'voucherTitle');
    dialog.innerHTML = `<div class="voucher-shell"><header class="voucher-head"><h2 id="voucherTitle">导出账单凭证</h2><button class="btn btn-ghost btn-sm" type="button" data-voucher-action="close">关闭</button></header>
      <div class="voucher-body"><p class="voucher-intro">将账单整理成可保存的长图，保留独立快照，并提供原图完整性核验。</p>
      <form class="voucher-form" data-voucher-form><fieldset><legend>导出范围</legend><div class="voucher-scopes"><label class="voucher-scope"><input type="radio" name="voucherFilter" value="all" ${options.filter === 'receipt' ? '' : 'checked'}>全部账单</label><label class="voucher-scope"><input type="radio" name="voucherFilter" value="receipt" ${options.filter === 'receipt' ? 'checked' : ''}>仅票据</label></div></fieldset>
        <div class="voucher-summary" data-voucher-summary></div><label class="voucher-option"><input type="checkbox" name="voucherReceipts"><span>附带票据预览<small>包含已上传的订单截图，可能带有姓名、订单号等信息。默认只导出账单文字。</small></span></label>
        <p class="voucher-note">以服务器保存的账单为准。公开核验页只核对签名和文件完整性，不公开账单内容。超长账单会拆成编号连续的图片。</p></form>
      <section data-voucher-result hidden aria-label="已生成凭证"></section><section class="voucher-recent" data-voucher-recent hidden></section></div>
      <footer class="voucher-footer"><div data-voucher-progress-box hidden role="status" aria-live="polite"><div class="voucher-status"><span data-voucher-stage></span><span data-voucher-count></span></div><progress class="voucher-progress" aria-label="凭证生成进度"></progress></div>
      <p class="voucher-error" data-voucher-error role="alert" hidden></p><div class="voucher-cancel-question" data-voucher-cancel-question hidden><p>凭证正在生成，确认取消本次生成吗？</p><div class="voucher-actions"><button type="button" class="btn btn-primary" data-voucher-action="keep">继续生成</button><button type="button" class="btn btn-ghost" data-voucher-action="cancel-confirm">取消生成</button></div></div>
      <div class="voucher-actions"><a class="btn btn-primary" data-voucher-save hidden>保存原图</a><button type="button" class="btn btn-primary" data-voucher-action="save-pages" hidden>逐张保存</button><button type="button" class="btn btn-primary" data-voucher-action="generate">生成长图凭证</button><button type="button" class="btn btn-ghost" data-voucher-action="again" hidden>再导出一份</button><button type="button" class="btn btn-ghost" data-voucher-action="refresh" hidden>重新查询</button><button type="button" class="btn btn-ghost" data-voucher-action="cancel" hidden>取消生成</button><button type="button" class="btn btn-ghost" data-voucher-action="close-footer">完成</button></div></footer></div>`;
    const state = {
      ...options, dialog, trip: options.trip, marker: crypto.randomUUID(), opener: document.activeElement,
      themeBase: options.themeBase || getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      timeZone: options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      shareFiles: new Map(), recent: [], job: null, requestId: null, requestBody: null, requestTurn: 0,
    };
    try { localStorage.setItem('ithaca.voucherTheme', state.themeBase); } catch (_) { /* Storage may be unavailable. */ }
    session = state;
    document.body.append(dialog);
    dialog.showModal();
    summary(state);
    state.onUnload = event => { if (busy(state) || state.uncertain) { event.preventDefault(); event.returnValue = ''; } };
    state.onBack = () => {
      if (!alive(state)) return;
      if (busy(state) || state.uncertain) {
        history.pushState({ ...history.state, voucherDialog: state.marker }, '', location.href);
        askCancel(state, true);
      } else close(state, true);
    };
    history.pushState({ ...history.state, voucherDialog: state.marker }, '', location.href);
    window.addEventListener('beforeunload', state.onUnload);
    window.addEventListener('popstate', state.onBack);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(state); });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) { close(state); return; }
      const button = event.target.closest('[data-voucher-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.voucherAction;
      if (action === 'close' || action === 'close-footer') close(state);
      else if (action === 'generate') generate(state);
      else if (action === 'again') {
        state.job = null;
        state.result = null;
        state.requestId = null;
        state.requestBody = null;
        state.shareFiles.clear();
        get(state, '[data-voucher-result]').hidden = true;
        get(state, '[data-voucher-action=generate]').textContent = '生成长图凭证';
        setError(state, '');
        controls(state);
        summary(state);
        get(state, '.voucher-body').scrollTop = 0;
      }
      else if (action === 'refresh') state.job ? refresh(state) : generate(state);
      else if (action === 'cancel') askCancel(state);
      else if (action === 'cancel-confirm') cancel(state);
      else if (action === 'keep') {
        get(state, '[data-voucher-cancel-question]').hidden = true;
        state.closeAfterCancel = false;
        state.cancelIntent = false;
      }
      else if (action === 'share') share(state, button);
      else if (action === 'save-pages') get(state, '[data-voucher-result] .voucher-actions')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else if (action === 'revoke') get(state, '[data-voucher-revoke-question]').hidden = false;
      else if (action === 'revoke-back') get(state, '[data-voucher-revoke-question]').hidden = true;
      else if (action === 'revoke-confirm') revoke(state);
      else if (action === 'recent' && !busy(state) && !state.uncertain) {
        const voucher = state.recent.find(entry => entry.id === button.dataset.id);
        if (!voucher) return;
        state.job = { status: 'completed', progress: { stage: 'ready' }, result: voucher };
        renderResult(state, voucher);
        controls(state);
        get(state, '.voucher-body').scrollTop = 0;
      }
    });
    get(state, '[data-voucher-form]').addEventListener('submit', event => { event.preventDefault(); generate(state); });
    get(state, '[data-voucher-form]').addEventListener('change', () => {
      if (state.uncertain) return;
      state.requestId = null;
      state.requestBody = null;
      summary(state);
    });
    get(state, '#voucherTitle').tabIndex = -1;
    get(state, '#voucherTitle').focus({ preventScroll: true });
    loadRecent(state);
  }

  return { open };
})();
