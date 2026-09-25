'use strict';

window.AuthUI = (() => {
  let currentUser = null;
  let currentTemporary = null;
  let csrf = '';
  let setupToken = '';
  let inviteToken = '';
  let linkError = '';
  let loginStep = 'account';
  let hasPasskey = false;

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
    currentTemporary = null;
    csrf = session.csrf || '';
    Store.setCsrf(csrf);
    if (currentUser && currentUser.username) {
      try { localStorage.setItem('ithaca.lastUsername', currentUser.username); } catch (_) {}
    }
  }

  function setTemporary(session) {
    currentUser = null;
    currentTemporary = session.person || null;
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
    loginStep = register ? 'password' : 'account';
    hasPasskey = false;
    document.getElementById('authSubmit').textContent = register ? '创建账号' : '继续';
    document.getElementById('authPasswordRow').hidden = !register;
    document.getElementById('passkeyLogin').hidden = true;
    document.getElementById('authBack').hidden = true;
    document.getElementById('authSwitch').hidden = setup;
    document.getElementById('authSwitch').textContent = register ? '已有账号？登录' : '没有账号？注册';
    document.getElementById('authForm').dataset.mode = register ? 'register' : 'login';
    const password = document.querySelector('#authForm [name=password]');
    password.autocomplete = register ? 'new-password' : 'current-password';
    password.required = register;
    document.querySelector('#authForm [name=username]').readOnly = false;
    errorText(linkError);
  }

  function showPassword(message) {
    loginStep = 'password';
    const field = document.getElementById('authPasswordRow');
    field.hidden = false;
    field.querySelector('input').required = true;
    document.querySelector('#authForm [name=username]').readOnly = true;
    document.getElementById('authSubmit').textContent = '登录';
    document.getElementById('passkeyLogin').hidden = !hasPasskey;
    document.getElementById('authBack').hidden = false;
    document.getElementById('authHint').textContent = message || '请输入密码登录。';
    field.querySelector('input').focus();
  }

  function finishLogin(session, complete) {
    setSession(session);
    setupToken = '';
    return request('/api/temporary/leave', 'POST', {}).catch(() => {}).then(() => finishInvitation()).then(() => {
      document.getElementById('authGate').hidden = true;
      complete(session);
    });
  }

  async function beginLogin(complete) {
    const username = document.querySelector('#authForm [name=username]').value.trim();
    if (!username) return;
    const button = document.getElementById('authSubmit');
    button.disabled = true;
    errorText('');
    try {
      if (!SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
        showPassword();
        return;
      }
      const ceremony = await request('/api/passkeys/login/options', 'POST', { username });
      hasPasskey = true;
      document.getElementById('authHint').textContent = '请在设备上验证通行密钥。';
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: ceremony.options });
      const session = await request('/api/passkeys/login/verify', 'POST', { username, flowId: ceremony.flowId, response });
      await finishLogin(session, complete);
    } catch (error) {
      showPassword(hasPasskey ? '通行密钥未完成验证，也可以输入密码登录。' : '请输入密码登录。');
      if (hasPasskey) errorText(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function submit(event, complete) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.mode === 'login' && loginStep === 'account') return beginLogin(complete);
    const button = document.getElementById('authSubmit');
    const values = new FormData(form);
    const username = String(values.get('username') || '').trim();
    const password = String(values.get('password') || '');
    const endpoint = setupToken ? '/api/auth/setup' : form.dataset.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    button.disabled = true;
    errorText('');
    try {
      const session = await request(endpoint, 'POST', { username, password, ...(setupToken ? { token: setupToken } : {}) });
      await finishLogin(session, complete);
    } catch (error) {
      errorText(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function passkeyLogin(complete) {
    await beginLogin(complete);
  }

  async function start() {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    setupToken = fragment.get('setup') || '';
    inviteToken = fragment.get('invite') || '';
    const shareToken = fragment.get('share') || '';
    const temporaryToken = fragment.get('temporary') || '';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (temporaryToken) {
      try {
        const session = await request('/api/temporary/exchange', 'POST', { token: temporaryToken });
        setTemporary(session);
        return session;
      } catch (error) {
        linkError = error.message;
        await request('/api/temporary/leave', 'POST', {}).catch(() => {});
      }
    }
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
      try {
        const temporary = await request('/api/temporary/me');
        setTemporary(temporary);
        return temporary;
      } catch (_) { /* Continue with read-only sharing or account login. */ }
      if (shareToken || !setupToken) {
        const shared = await fetch('/api/data');
        if (shared.ok) return { user: null, csrf: '' };
      }
    }
    return new Promise(resolve => {
      show(setupToken ? 'register' : 'login');
      try { document.querySelector('#authForm [name=username]').value = localStorage.getItem('ithaca.lastUsername') || ''; } catch (_) {}
      document.getElementById('authForm').addEventListener('submit', event => submit(event, resolve));
      document.getElementById('passkeyLogin').addEventListener('click', () => passkeyLogin(resolve));
      document.getElementById('authBack').addEventListener('click', () => {
        show('login');
        document.querySelector('#authForm [name=username]').focus();
      });
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
    await request('/api/temporary/leave', 'POST', {});
    await request('/api/share/leave', 'POST', {});
    location.reload();
  }

  return { start, request, registerPasskey, removePasskey, logout, get user() { return currentUser; }, get temporary() { return currentTemporary; } };
})();
