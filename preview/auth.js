// Phase 1 auth: Supabase email + password over the GoTrue REST API (no SDK, matching the
// page's plain-fetch style). Only Quickbase Users credentials work (decision 23 Oct
// 2026): everyone signs in with their real platform email and password, synced from
// Quickbase by the "Web PoC auth export" workflow; accounts on the staff list carry a
// staff badge. After a fresh sign-in the page logs the login and takes the
// single-session token (web_login in web-poc/db/030_phase1_auth.sql); signing in
// elsewhere rotates the token, and this page notices and signs out - the live
// platform's single-session design, enforced here because its own middleware never was
// (schedule 11.16).
//
// Staff passcode sign-in (v0.24): #/login/{userId}/{passcode} - the PoC's version of the
// live platform's /login/{userId}/{passcode}, opened from the Quickbase Users form. The
// edge function web-passcode-login checks the passcode (Users fid 788) server-side and
// returns a single-use token, exchanged here for a normal session. A passcode session
// is not logged as the teacher's own login and does not take their single-session
// token, so impersonating never signs the real teacher out.
const Auth = (() => {
  const LS_SESSION = 'imoves.session';
  const LS_TOKEN = 'imoves.sessionToken';
  const LS_COOKIE = 'imoves.loginCookie';
  const LS_VIA = 'imoves.via';         // 'passcode' while impersonating
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
    const viaPasscode = lsGet(LS_VIA) === 'passcode';
    if (viaPasscode) me = Object.assign(me || {}, { passcode: true });
    let token = lsGet(LS_TOKEN);
    if (viaPasscode) { /* staff passcode session: no login record, no single-session token */ }
    else if (freshSignIn || !token) {
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
    const m = location.hash.match(/^#\/login\/(\d+)\/([^/?#]+)/);
    if (m) {
      // Take the passcode out of the address bar and history straight away.
      history.replaceState(null, '', location.pathname + location.search + '#/');
      return passcodeSignIn(+m[1], decodeURIComponent(m[2]));
    }
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

  function clearSession() {
    const t = session && session.access_token;
    store(null); lsSet(LS_TOKEN, null); lsSet(LS_VIA, null); me = null;
    if (t) gotrue('logout', null, t).catch(() => {});
  }

  // Staff "log in as" link: whoever is signed in on this browser is signed out first,
  // as on the live platform.
  async function passcodeSignIn(userId, passcode) {
    clearSession();
    app.innerHTML = '<div class="loading">Signing in from Quickbase…</div>';
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/web-passcode-login`, {
        method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, passcode }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.token_hash) throw new Error(j.error || `Sign-in from Quickbase failed (${r.status}).`);
      const v = await gotrue('verify', { type: j.type || 'magiclink', token_hash: j.token_hash });
      if (!v.ok) throw new Error(`Sign-in from Quickbase failed at the last step (${v.status}). Open the link again.`);
      const s = await v.json();
      store({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) });
      lsSet(LS_VIA, 'passcode');
      return afterAuth(true);
    } catch (e) {
      showLogin(e.message);
      return false;
    }
  }

  function signOut(reason) {
    const t = session && session.access_token;
    store(null); lsSet(LS_TOKEN, null); lsSet(LS_VIA, null); me = null;
    if (timer) clearInterval(timer);
    if (t) gotrue('logout', null, t).catch(() => {});
    renderUser();
    showLogin(reason === 'elsewhere'
      ? 'Your account has signed in somewhere else, so this session has ended. Only one sign-in at a time is allowed.'
      : reason === 'bye' ? 'You have signed out.' : '');
  }

  // The live header carries no user name: Log Out lives in the Menu dropdown. The PoC adds
  // a "Passcode" badge beside the school name while impersonating from Quickbase.
  function renderUser() {
    document.body.classList.toggle('signed-out', !session);
    const badge = document.getElementById('passcodebadge');
    if (badge) badge.remove();
    if (!session) {
      for (const id of ['userctx', 'subjectbar', 'usermenu']) { const x = document.getElementById(id); if (x) x.innerHTML = ''; }
      for (const id of ['stickybanner', 'upgradebtn']) { const x = document.getElementById(id); if (x) x.classList.add('hidden'); }
      return;
    }
    if (me && me.passcode) {
      const ctx = document.getElementById('userctx');
      if (ctx) ctx.insertAdjacentHTML('beforeend', ` <span class="badge passcode" id="passcodebadge" title="Signed in from Quickbase with this user’s passcode">Passcode</span>`);
    }
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

  return { init, refresh, signOut, showLogin, renderUser, me: () => me, accessToken: () => session && session.access_token, isStaff };
})();
