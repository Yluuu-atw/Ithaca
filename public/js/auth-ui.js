'use strict';

window.AuthUI = (() => {
  let currentUser = null;
  let csrf = '';
  let setupToken = '';
  let inviteToken = '';
  let linkError = '';

  function errorText(message) {
    document.getElementById('authError').textContent = message || '';
  }

  async function request(path, method = 'GET', body) {
    const response = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  }

  function setSession(session) {
    currentUser = session.user || null;
    csrf = session.csrf || '';
    Store.setCsrf(csrf);
  }

  async function finishInvitation() {
    if (!inviteToken) return;
    await request('/api/invites/redeem', 'POST', { token: inviteToken });
    inviteToken = '';
  }

  function show(mode) {
    const setup = !!setupToken;
    const register = mode === 'register' || setup;
    document.getElementById('authGate').hidden = false;
    document.getElementById('authTitle').textContent = setup ? '设置旅行所有者账号' : register ? '注册九州 ITHACA' : '登录九州 ITHACA';
    document.getElementById('authHint').textContent = setup
      ? '此链接用于认领现有旅行。请设置至少 12 位密码。'
      : inviteToken ? '先登录或注册，再加入受邀旅行。' : '登录后查看和管理你的旅行。';
    document.getElementById('authSubmit').textContent = register ? '创建账号' : '登录';
    document.getElementById('passkeyLogin').hidden = register;
    document.getElementById('authSwitch').hidden = setup;
    document.getElementById('authSwitch').textContent = register ? '已有账号？登录' : '没有账号？注册';
    document.getElementById('authForm').dataset.mode = register ? 'register' : 'login';
    document.querySelector('#authForm [name=password]').autocomplete = register ? 'new-password' : 'current-password';
    errorText(linkError);
  }

  async function submit(event, complete) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('authSubmit');
    const values = new FormData(form);
    const username = String(values.get('username') || '').trim();
    const password = String(values.get('password') || '');
    const endpoint = setupToken ? '/api/auth/setup' : form.dataset.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    button.disabled = true;
    errorText('');
    try {
      const session = await request(endpoint, 'POST', { username, password, ...(setupToken ? { token: setupToken } : {}) });
      setSession(session);
      setupToken = '';
      await finishInvitation();
      document.getElementById('authGate').hidden = true;
      complete(session);
    } catch (error) {
      errorText(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function passkeyLogin(complete) {
    errorText('');
    try {
      if (!SimpleWebAuthnBrowser.browserSupportsWebAuthn()) throw new Error('此浏览器不支持通行密钥');
      const username = document.querySelector('#authForm [name=username]').value.trim();
      if (!username) throw new Error('请先填写用户名');
      const ceremony = await request('/api/passkeys/login/options', 'POST', { username });
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: ceremony.options });
      const session = await request('/api/passkeys/login/verify', 'POST', { username, flowId: ceremony.flowId, response });
      setSession(session);
      await finishInvitation();
      document.getElementById('authGate').hidden = true;
      complete(session);
    } catch (error) { errorText(error.message); }
  }

  async function start() {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    setupToken = fragment.get('setup') || '';
    inviteToken = fragment.get('invite') || '';
    const shareToken = fragment.get('share') || '';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (shareToken) {
      try { await request('/api/share/exchange', 'POST', { token: shareToken }); }
      catch (error) {
        linkError = error.message;
        await request('/api/share/leave', 'POST', {}).catch(() => {});
      }
    }
    try {
      const session = await request('/api/auth/me');
      setSession(session);
      await finishInvitation();
      return session;
    } catch (_) {
      if (shareToken || !setupToken) {
        const shared = await fetch('/api/data');
        if (shared.ok) return { user: null, csrf: '' };
      }
    }
    return new Promise(resolve => {
      show(setupToken ? 'register' : 'login');
      document.getElementById('authForm').addEventListener('submit', event => submit(event, resolve));
      document.getElementById('passkeyLogin').addEventListener('click', () => passkeyLogin(resolve));
      document.getElementById('authSwitch').addEventListener('click', () => {
        const current = document.getElementById('authForm').dataset.mode;
        show(current === 'register' ? 'login' : 'register');
      });
    });
  }

  async function registerPasskey() {
    if (!currentUser) throw new Error('请先登录');
    if (!SimpleWebAuthnBrowser.browserSupportsWebAuthn()) throw new Error('此浏览器不支持通行密钥');
    const ceremony = await request('/api/passkeys/register/options', 'POST', {});
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: ceremony.options });
    const result = await request('/api/passkeys/register/verify', 'POST', {
      flowId: ceremony.flowId, response, label: '我的通行密钥',
    });
    currentUser = result.user;
    return currentUser;
  }

  async function removePasskey(id) {
    await request('/api/passkeys/remove', 'POST', { id });
    const session = await request('/api/auth/me');
    setSession(session);
  }

  async function logout() {
    if (currentUser) await request('/api/auth/logout', 'POST', {});
    await request('/api/share/leave', 'POST', {});
    location.reload();
  }

  return { start, request, registerPasskey, removePasskey, logout, get user() { return currentUser; } };
})();
