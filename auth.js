// Phase 1 auth: Supabase email + password over the GoTrue REST API (no SDK, matching the
// page's plain-fetch style). Only Quickbase Users credentials work (decision 23 Oct
// 2026): everyone signs in with their real platform email and password, synced from
// Quickbase by the "Web PoC auth export" workflow; accounts on the staff list carry a
// staff badge. After a fresh sign-in the page logs the login and takes the
// single-session token (web_login in web-poc/db/030_phase1_auth.sql); signing in
// elsewhere rotates the token, and this page notices and signs out - the live
// platform's single-session design, enforced here because its own middleware never was
// (schedule 11.16).
const Auth = (() => {
  const LS_SESSION = 'imoves.session';
  const LS_TOKEN = 'imoves.sessionToken';
  const LS_COOKIE = 'imoves.loginCookie';
  let session = null;   // { access_token, refresh_token, expires_at (seconds) }
  let me = null;        // web_me() row, or { staff: true } for staff log-ins
  let timer = null;

  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const claims = () => { try { return JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } };
  const isStaff = () => !!((claims().app_metadata || {}).staff);
  function loginCookie() {
    let c = lsGet(LS_COOKIE);
    if (!c) { c = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join(''); lsSet(LS_COOKIE, c); }
    return c;
  }
  function store(s) { session = s; lsSet(LS_SESSION, s ? JSON.stringify(s) : null); }

  async function gotrue(path, body, bearer) {
    const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return fetch(`${SUPABASE_URL}/auth/v1/${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
  }

  async function refresh() {
    if (!session || !session.refresh_token) return false;
    try {
      const r = await gotrue('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      if (!r.ok) return false;
      const s = await r.json();
      store({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) });
      return true;
    } catch (e) { return false; }
  }

  // After a session exists: profile, login log + single-session token, top bar.
  // Every account is a Quickbase teacher (only Quickbase credentials work); staff
  // is just an extra claim on some of them, shown as a badge.
  async function afterAuth(freshSignIn) {
    try { const rows = await rpc('web_me'); me = (rows && rows[0]) || null; } catch (e) { me = null; }
    if (isStaff()) me = Object.assign(me || {}, { staff: true });
    let token = lsGet(LS_TOKEN);
    if (freshSignIn || !token) {
      try { token = await rpc('web_login', { p_login_cookie: loginCookie(), p_user_agent: navigator.userAgent }); lsSet(LS_TOKEN, token); }
      catch (e) { /* login logging is best-effort */ }
    } else if (!(await sessionStillOk())) { signOut('elsewhere'); return false; }
    if (timer) clearInterval(timer);
    timer = setInterval(watch, 5 * 60 * 1000);
    renderUser();
    return true;
  }
  async function sessionStillOk() {
    const token = lsGet(LS_TOKEN);
    if (!token) return true;
    try { return (await rpc('web_session_ok', { p_token: token })) !== false; }
    catch (e) { return true; }   // a network blip never signs anyone out
  }
  async function watch() { if (session && !(await sessionStillOk())) signOut('elsewhere'); }

  async function init() {
    try { session = JSON.parse(lsGet(LS_SESSION) || 'null'); } catch (e) { session = null; }
    if (session && (session.expires_at || 0) * 1000 < Date.now() + 60000 && !(await refresh())) session = null;
    if (!session) { showLogin(); return false; }
    return afterAuth(false);
  }

  async function signIn(email, password) {
    const r = await gotrue('token?grant_type=password', { email, password });
    if (!r.ok) {
      let msg = 'These details don’t match our records. Check your email address and password and try again.';
      try { const e = await r.json(); if (r.status !== 400 && e.msg) msg = e.msg; } catch (e) {}
      throw new Error(msg);
    }
    const s = await r.json();
    store({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) });
    return afterAuth(true);
  }

  function signOut(reason) {
    const t = session && session.access_token;
    store(null); lsSet(LS_TOKEN, null); me = null;
    if (timer) clearInterval(timer);
    if (t) gotrue('logout', null, t).catch(() => {});
    renderUser();
    showLogin(reason === 'elsewhere'
      ? 'Your account has signed in somewhere else, so this session has ended. Only one sign-in at a time is allowed.'
      : reason === 'bye' ? 'You have signed out.' : '');
  }

  function renderUser() {
    const el = document.getElementById('usernav');
    if (!el) return;
    document.body.classList.toggle('signed-out', !session);
    if (!session) { el.innerHTML = ''; return; }
    const name = me && me.first_name ? `${me.first_name} ${me.last_name || ''}`.trim() : (me && me.email) || 'Signed in';
    el.innerHTML = `<span class="userchip" title="${esc(me && me.email || '')}"><i class="bi-person-circle"></i> ${esc(name)}${me && me.staff ? ' <span class="badge purple">Staff</span>' : ''}</span>` +
      `<button class="nbtn" id="logoutbtn" type="button"><i class="bi-box-arrow-right"></i> Log out</button>`;
    document.getElementById('logoutbtn').addEventListener('click', () => signOut('bye'));
  }

  function showLogin(message = '') {
    document.body.classList.add('signed-out');
    setBg(null);
    document.getElementById('subjectbar').innerHTML = '';
    app.innerHTML = `
      <div class="login-wrap">
        <form class="login-card" id="loginform" novalidate>
          <img src="https://imovesnew.s3.eu-west-1.amazonaws.com/platformlogo/logo" alt="imoves" class="login-logo">
          <h1>Sign in</h1>
          <p class="muted light">Use your imoves email address and password.</p>
          ${message ? `<div class="notice" role="status">${esc(message)}</div>` : ''}
          <div class="notice hidden" id="loginerror" role="alert"></div>
          <label for="le">Email address</label>
          <input id="le" type="email" autocomplete="email" required>
          <label for="lp">Password</label>
          <input id="lp" type="password" autocomplete="current-password" required>
          <button class="btn" type="submit" id="loginbtn"><i class="bi-box-arrow-in-right"></i> Sign in</button>
          <p class="muted light small">Forgotten your password? Password reset comes with Phase 2 of the rebuild - for now, reset it on <a href="https://platform.imoves.com/password/reset" target="_blank" rel="noopener">platform.imoves.com</a> and sign in here with the new one after the next credentials refresh.</p>
        </form>
      </div>`;
    document.getElementById('loginform').addEventListener('submit', async e => {
      e.preventDefault();
      const err = document.getElementById('loginerror'), btn = document.getElementById('loginbtn');
      err.classList.add('hidden');
      btn.disabled = true; btn.innerHTML = 'Signing in…';
      try {
        if (await signIn(document.getElementById('le').value.trim(), document.getElementById('lp').value)) await startApp();
      } catch (ex) {
        err.textContent = ex.message; err.classList.remove('hidden');
        btn.disabled = false; btn.innerHTML = '<i class="bi-box-arrow-in-right"></i> Sign in';
      }
    });
    document.getElementById('le').focus();
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) watch(); });

  return { init, refresh, signOut, showLogin, me: () => me, accessToken: () => session && session.access_token, isStaff };
})();
