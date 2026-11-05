// imoves CMS - staff content page v0.1 (increment 2, 4 Nov 2026)
// Published copy: dmlaycock/imoves-web-poc at /staff/ (cms/site/build.js fills config.js).
//
// Design: project doc cms/design-v0.2.md sections 4 to 6. Talks to PostgREST on the "content"
// schema (Accept-Profile / Content-Profile headers). Signs in with the same Supabase session
// as the teacher site (same localStorage keys, same origin), so a staff member signed in there
// is signed in here. Staff rights come from the JWT's app_metadata.staff claim; anyone else
// can look but not change anything.
//
// Pages: #/subject/:id  #/group/:id  #/category/:id  #/scheme/:id  #/lesson/:id  #/block/:id
// Every page: Save writes the draft; Publish copies draft to published (optionally with
// everything placed under it); History lists versions and rolls back.

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Body text as the platform renders it (web-poc nl()): a few harmless tags let through, nl2br.
const nl = s => esc(s).trim()
  .replace(/&lt;i class=&quot;((?:bi )?bi-[a-z0-9-]+)&quot;&gt;\s*&lt;\/i&gt;/g, '<i class="$1"></i>')
  .replace(/&lt;(\/?)(b|strong|em)&gt;/g, '<$1$2>').replace(/&lt;br ?\/?&gt;/g, '<br>').replace(/\r?\n/g, '<br>');
const when = t => t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
let toastT;
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', err ? 5000 : 2200); }
const KIND = { subject: 'Subject', group: 'Group', category: 'Category', scheme: 'Scheme', lesson: 'Lesson', media_block: 'Block', variant: 'Variant', part: 'Part' };
const TABLE = { subject: 'subjects', group: 'groups', category: 'categories', scheme: 'schemes', lesson: 'lessons', media_block: 'media_blocks', variant: 'scheme_variants', part: 'lesson_parts' };
const ROUTE = { subject: 'subject', group: 'group', category: 'category', scheme: 'scheme', lesson: 'lesson', media_block: 'block' };
const href = (type, id) => `#/${ROUTE[type]}/${id}`;

// ---------- API ----------
const Auth = (() => {
  const LS = 'imoves.session';
  let session = null, claims = {};
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const decode = t => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } };
  const store = s => { session = s; claims = s ? decode(s.access_token) : {}; lsSet(LS, s ? JSON.stringify(s) : null); };
  const gotrue = (path, body, bearer) => fetch(`${SUPABASE_URL}/auth/v1/${path}`, { method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  async function refresh() {
    if (!session || !session.refresh_token) return false;
    try { const r = await gotrue('token?grant_type=refresh_token', { refresh_token: session.refresh_token }); if (!r.ok) return false;
      const s = await r.json(); store({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) }); return true; } catch (e) { return false; }
  }
  async function init() {
    try { session = JSON.parse(lsGet(LS) || 'null'); } catch (e) { session = null; }
    if (session) claims = decode(session.access_token);
    if (session && (session.expires_at || 0) * 1000 < Date.now() + 60000 && !(await refresh())) store(null);
    return !!session;
  }
  async function signIn(email, password) {
    const r = await gotrue('token?grant_type=password', { email, password });
    if (!r.ok) throw new Error('These details don’t match our records. Check your email address and password and try again.');
    const s = await r.json(); store({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) });
  }
  function signOut() { const t = session && session.access_token; store(null); if (t) gotrue('logout', null, t).catch(() => {}); }
  return { init, refresh, signIn, signOut, token: () => session && session.access_token, email: () => claims.email || '', isStaff: () => !!((claims.app_metadata || {}).staff) };
})();

async function api(path, { method = 'GET', body, prefer, raw = false } = {}) {
  const headers = { apikey: SUPABASE_KEY, 'Accept-Profile': 'content', 'Content-Profile': 'content' };
  if (Auth.token()) headers.Authorization = `Bearer ${Auth.token()}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  let r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401 && Auth.token() && await Auth.refresh()) { headers.Authorization = `Bearer ${Auth.token()}`; r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  if (!r.ok) { let m = `${r.status}`; try { const j = await r.json(); m = j.message || j.hint || j.details || m; } catch (e) {} throw new Error(m); }
  if (raw || r.status === 204) return null;
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const get = (path) => api(path);
const getAll = async path => { const out = []; let from = 0; for (;;) { const rows = await api(`${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${from}`); out.push(...rows); if (rows.length < 1000) break; from += 1000; } return out; };
const patch = (table, id, body) => api(`${table}?id=eq.${id}`, { method: 'PATCH', body, prefer: 'return=representation' }).then(r => r && r[0]);
const insert = (table, body) => api(table, { method: 'POST', body, prefer: 'return=representation' }).then(r => r && r[0]);
const del = (table, q) => api(`${table}?${q}`, { method: 'DELETE', raw: true });
const rpc = (fn, args) => api(`rpc/${fn}`, { method: 'POST', body: args || {} });

// ---------- data: the tree ----------
const D = { subjects: [], groups: [], categories: [], placements: [], pub: {} };
const index = rows => Object.fromEntries(rows.map(r => [r.id, r]));
async function loadTree() {
  const [subjects, groups, categories, placements, pubS, pubG, pubC, pubSch, pubL, pubB] = await Promise.all([
    getAll('subjects?select=id,name,sort,on_home,browsable,updated_at&order=sort'), getAll('groups?select=id,name,updated_at'),
    getAll('categories?select=id,name,subheading,image,updated_at'),
    getAll('placements?select=id,parent_type,parent_id,child_type,child_id,sort,is_home,heading,subheading,variant_ids&parent_type=in.(subject,group,category)&order=sort'),
    getAll('subjects_pub?select=id'), getAll('groups_pub?select=id'), getAll('categories_pub?select=id'), getAll('schemes_pub?select=id'), getAll('lessons_pub?select=id'), getAll('media_blocks_pub?select=id'),
  ]);
  Object.assign(D, { subjects, groups, categories, placements });
  D.subjectById = index(subjects); D.groupById = index(groups); D.catById = index(categories);
  D.pub = { subject: new Set(pubS.map(r => r.id)), group: new Set(pubG.map(r => r.id)), category: new Set(pubC.map(r => r.id)), scheme: new Set(pubSch.map(r => r.id)), lesson: new Set(pubL.map(r => r.id)), media_block: new Set(pubB.map(r => r.id)) };
  D.children = {};
  for (const p of placements) (D.children[`${p.parent_type}:${p.parent_id}`] ||= []).push(p);
  for (const k in D.children) D.children[k].sort((a, b) => a.sort - b.sort || a.id - b.id);
}
const kids = (type, id) => D.children[`${type}:${id}`] || [];
const isPub = (type, id) => !!(D.pub[type] && D.pub[type].has(id));
function parentsOf(type, id) { return D.placements.filter(p => p.child_type === type && p.child_id === id); }

function renderTree() {
  const tree = $('#tree');
  const open = new Set(JSON.parse(sessionStorage.getItem('cms.open') || '[]'));
  const chev = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>';
  const cur = location.hash;
  let h = '<div class="hint">Subjects, groups, categories</div>';
  for (const s of D.subjects) {
    const groups = kids('subject', s.id);
    h += `<details class="subject" data-key="s${s.id}" ${open.has('s' + s.id) ? 'open' : ''}><summary>${chev}<a href="${href('subject', s.id)}" class="${isPub('subject', s.id) ? '' : 'off'}" style="color:inherit;text-decoration:none;flex:1">${esc(s.name)}</a><span class="count">${groups.length}</span></summary>`;
    for (const gp of groups) {
      const g = D.groupById[gp.child_id]; if (!g) continue;
      const cats = kids('group', g.id);
      h += `<details class="group" data-key="g${g.id}" ${open.has('g' + g.id) ? 'open' : ''}><summary>${chev}<a href="${href('group', g.id)}" class="${isPub('group', g.id) ? '' : 'off'}" style="color:inherit;text-decoration:none;flex:1">${esc(g.name)}</a><span class="count">${cats.length}</span></summary>`;
      for (const cp of cats) {
        const c = D.catById[cp.child_id]; if (!c) continue;
        const n = kids('category', c.id).length;
        h += `<div class="cat"><button class="${cur === href('category', c.id) ? 'active' : ''} ${isPub('category', c.id) ? '' : 'off'}" data-go="${href('category', c.id)}"><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</span><span class="count">${n}</span></button></div>`;
      }
      h += '</details>';
    }
    h += '</details>';
  }
  tree.innerHTML = h;
  tree.querySelectorAll('details').forEach(d => d.addEventListener('toggle', () => { const o = new Set(JSON.parse(sessionStorage.getItem('cms.open') || '[]')); d.open ? o.add(d.dataset.key) : o.delete(d.dataset.key); sessionStorage.setItem('cms.open', JSON.stringify([...o])); }));
  tree.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
}
function treeReveal(type, id) {
  // open the tree down to this item
  const o = new Set(JSON.parse(sessionStorage.getItem('cms.open') || '[]'));
  const walk = (t, i) => { for (const p of parentsOf(t, i)) { o.add((p.parent_type === 'subject' ? 's' : 'g') + p.parent_id); if (p.parent_type === 'group') walk('group', p.parent_id); } };
  if (type === 'category') walk('category', id); else if (type === 'group') { o.add('g' + id); walk('group', id); } else if (type === 'subject') o.add('s' + id);
  sessionStorage.setItem('cms.open', JSON.stringify([...o]));
}

// ---------- search ----------
const qres = $('#qres');
$('#q').addEventListener('input', debounce(async e => {
  const q = e.target.value.trim();
  if (q.length < 2) { qres.classList.remove('open'); return; }
  try {
    const rows = await rpc('search', { p_q: q, p_limit: 25 });
    qres.innerHTML = rows.length ? rows.map(r => `<button data-go="${href(r.item_type, r.id)}"><span class="kind ${r.item_type}">${KIND[r.item_type]}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}${r.detail ? ` <span class="muted small">${esc(r.detail).slice(0, 60)}</span>` : ''}</span><span class="muted small">${r.id}</span></button>`).join('') : '<div class="empty">Nothing found</div>';
    qres.classList.add('open');
    qres.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { qres.classList.remove('open'); $('#q').value = ''; location.hash = b.dataset.go; }));
  } catch (err) { toast(err.message, true); }
}, 220));
document.addEventListener('click', e => { if (!e.target.closest('.search')) qres.classList.remove('open'); });

// ---------- editor framework ----------
const editor = $('#editor');
let PAGE = null;   // { type, id, row, dirty: {}, fields }
function field(key, label, { type = 'text', help = '', options, span = false, rows } = {}) {
  const v = PAGE.row[key];
  let input;
  if (type === 'textarea') input = `<textarea data-f="${key}" ${rows ? `rows="${rows}"` : ''}>${esc(v)}</textarea>`;
  else if (type === 'select') input = `<select data-f="${key}">${options.map(o => `<option value="${esc(o[0])}" ${String(v ?? '') === String(o[0]) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  else if (type === 'check') input = `<label class="switch"><input type="checkbox" data-f="${key}" ${v ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
  else if (type === 'number') input = `<input type="number" data-f="${key}" value="${v ?? ''}">`;
  else if (type === 'list') input = `<input type="text" data-f="${key}" data-list="1" value="${esc((v || []).join(', '))}">`;
  else input = `<input type="text" data-f="${key}" value="${esc(v)}">`;
  return `<div class="field ${span ? 'span' : ''}" data-field="${key}">${type === 'check' ? '' : `<label>${esc(label)}</label>`}${input}${help ? `<div class="help">${help}</div>` : ''}</div>`;
}
function bindFields(root) {
  root.querySelectorAll('[data-f]').forEach(el => {
    const key = el.dataset.f;
    el.addEventListener('input', () => {
      let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.dataset.list ? el.value.split(',').map(s => s.trim()).filter(Boolean) : (el.value === '' ? null : el.value);
      PAGE.dirty[key] = v; PAGE.row[key] = v;
      el.closest('.field')?.classList.add('dirty');
      $('#saveBtn') && ($('#saveBtn').disabled = false);
      if (PAGE.onChange) PAGE.onChange(key);
    });
  });
}
async function save() {
  if (!Object.keys(PAGE.dirty).length) return;
  try {
    const row = await patch(TABLE[PAGE.type], PAGE.id, PAGE.dirty);
    PAGE.row = Object.assign(PAGE.row, row); PAGE.dirty = {};
    editor.querySelectorAll('.field.dirty').forEach(f => f.classList.remove('dirty'));
    $('#saveBtn').disabled = true;
    toast('Saved to draft');
    refreshStatus(); loadWaiting();
    if (['subject', 'group', 'category'].includes(PAGE.type)) { const t = PAGE.type === 'subject' ? D.subjectById : PAGE.type === 'group' ? D.groupById : D.catById; if (t[PAGE.id]) t[PAGE.id].name = PAGE.row.name; renderTree(); }
    $('#pageTitle').textContent = PAGE.row.name || PAGE.row.heading || '';
  } catch (e) { toast(`Could not save: ${e.message}`, true); }
}
async function refreshStatus() {
  try {
    const [s] = await rpc('item_status', { p_type: PAGE.type, p_id: PAGE.id });
    const el = $('#status'); if (!el) return;
    const pub = s.is_published;
    el.innerHTML = (pub ? `<span class="pill live"><span class="dot"></span>Published v${s.last_version}</span>` : '<span class="pill hidden"><span class="dot"></span>Not published</span>') +
      (s.waiting ? ' <span class="pill pending">Changes waiting</span>' : '');
    el.title = s.last_published_at ? `Last published ${when(s.last_published_at)} by ${s.last_published_by}` : '';
    if (D.pub[PAGE.type]) { pub ? D.pub[PAGE.type].add(PAGE.id) : D.pub[PAGE.type].delete(PAGE.id); }
    $('#unpubBtn') && ($('#unpubBtn').hidden = !pub);
  } catch (e) { /* status is decoration */ }
}
async function publish(withChildren) {
  if (Object.keys(PAGE.dirty).length) await save();
  if (withChildren && !confirm(`Publish "${PAGE.row.name || PAGE.row.heading}" and everything placed under it?`)) return;
  try { const v = await rpc('publish', { p_type: PAGE.type, p_id: PAGE.id, p_with_children: !!withChildren }); toast(`Published as version ${v}`); await refreshStatus(); loadWaiting(); renderTree(); if (PAGE.tab === 'history') loadHistory(); }
  catch (e) { toast(`Could not publish: ${e.message}`, true); }
}
async function unpublish() {
  if (!confirm(`Take "${PAGE.row.name || PAGE.row.heading}" off the platform? Teachers will no longer see it (the draft is kept).`)) return;
  try { await rpc('unpublish', { p_type: PAGE.type, p_id: PAGE.id }); toast('Unpublished'); await refreshStatus(); loadWaiting(); renderTree(); } catch (e) { toast(`Could not unpublish: ${e.message}`, true); }
}
function pageHeader(crumbs, tabs) {
  const canEdit = Auth.isStaff();
  return `<div class="crumbs">${crumbs.map((c, i) => (i ? '<span class="sep">›</span>' : '') + (c.href ? `<button data-go="${c.href}">${esc(c.name)}</button>` : `<span class="cur">${esc(c.name)}</span>`)).join('')}</div>
    <div class="edhead"><h1><span id="pageTitle">${esc(PAGE.row.name || PAGE.row.heading || '')}</span><span class="id">${KIND[PAGE.type]} ${PAGE.id}</span></h1>
      <span class="status" id="status"></span>
      <div class="actions">${canEdit ? `<button class="btn" id="saveBtn" disabled>Save draft</button>
        <div class="menu" id="pubMenu"><button class="btn primary" id="pubBtn">Publish ▾</button><div class="items"><button data-pub="0">Publish this ${KIND[PAGE.type].toLowerCase()} only</button>${['subject', 'group', 'category', 'scheme'].includes(PAGE.type) ? '<button data-pub="1">Publish with everything under it</button>' : ''}<button data-pub="u" id="unpubBtn" hidden>Unpublish</button></div></div>` : ''}</div></div>
    <div class="tabs">${tabs.map((t, i) => `<button class="${i === 0 ? 'active' : ''}" data-tab="${t.key}">${esc(t.label)}${t.n != null ? ` <span class="n">${t.n}</span>` : ''}</button>`).join('')}</div>`;
}
function bindHeader(root) {
  root.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  const save_ = $('#saveBtn'); if (save_) save_.addEventListener('click', save);
  const m = $('#pubMenu');
  if (m) {
    $('#pubBtn').addEventListener('click', e => { e.stopPropagation(); m.classList.toggle('open'); });
    document.addEventListener('click', () => m.classList.remove('open'), { once: true });
    m.querySelectorAll('[data-pub]').forEach(b => b.addEventListener('click', () => { m.classList.remove('open'); b.dataset.pub === 'u' ? unpublish() : publish(b.dataset.pub === '1'); }));
  }
  root.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
}
function showTab(key) {
  editor.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === key));
  editor.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === key));
  if (key === 'history') loadHistory();
  PAGE.tab = key;
}
const panel = (key, inner) => `<div class="tabpanel ${key === PAGE.firstTab ? 'active' : ''}" data-panel="${key}">${inner}</div>`;

// Page text block (scheme and lesson): editor rows with the platform preview beside them.
function textBlock(withDescription) {
  const r = PAGE.row;
  const rowsHtml = (withDescription ? `<div class="rowlabel">Short description (shown on the card and in search results)</div>${field('description', 'Description', { type: 'textarea', span: true, rows: 2 })}` : '') +
    `<div class="rowlabel">Opening text</div>${field('body_opening_text', 'Opening', { type: 'textarea', span: true })}` +
    [1, 2, 3].map(i => `<div class="rowlabel">Section ${i}</div>${field(`body_subheading_${i}`, 'Heading')}${field(`body_subheading_${i}_text`, 'Text', { type: 'textarea' })}`).join('') +
    `<div class="rowlabel">Closing text</div>${field('body_closing_text', 'Closing', { type: 'textarea', span: true })}`;
  return `<div class="panel"><div class="body"><div class="textwork"><div class="editors"><div class="textrows">${rowsHtml}</div></div><div class="preview" id="preview"></div></div></div></div>`;
}
function renderPreview() {
  const pv = $('#preview'); if (!pv) return;
  const r = PAGE.row;
  const para = (t, cls = '') => t && String(t).trim() ? `<p class="${cls}">${nl(t)}</p>` : '';
  let h = `<div class="pvlabel"><span>How teachers see it</span><span>live preview</span></div><div class="pvtitle">${esc(r.name)}</div>${r.subheading ? `<div class="pvsub">${esc(r.subheading)}</div>` : ''}`;
  h += para(r.description) + para(r.body_opening_text);
  for (const i of [1, 2, 3]) if (r[`body_subheading_${i}`]) h += `<h5>${esc(r[`body_subheading_${i}`])}</h5>${para(r[`body_subheading_${i}_text`])}`;
  h += para(r.body_closing_text);
  if (!r.description && !r.body_opening_text && !r.body_closing_text && ![1, 2, 3].some(i => r[`body_subheading_${i}`])) h += '<div class="pvempty">No page text yet.</div>';
  pv.innerHTML = h;
}

// Visibility (legacy audience keys until packages arrive in increment 5)
async function visibilityPanel(type, id) {
  const rows = await get(`visibility?item_type=eq.${type}&item_id=eq.${id}&select=audience`);
  const have = new Set(rows.map(r => r.audience));
  const opts = [['all', 'Everyone'], ['free', 'Free users'], ['trial', 'Trial users'], ['paying', 'Paying users']];
  return `<div class="panel"><h3>Who can see this ${KIND[type].toLowerCase()}</h3><div class="body"><div class="field"><div class="chips">${opts.map(o => `<label class="chip"><input type="checkbox" data-vis="${o[0]}" ${have.has(o[0]) ? 'checked' : ''} ${Auth.isStaff() ? '' : 'disabled'}> ${o[1]}</label>`).join('')}</div><div class="help">The current platform rules (show to all / free / trial / paying). Per-package views arrive in increment 5. Changes here save straight away and take effect on the next publish.</div></div></div></div>`;
}
function bindVisibility(root, type, id) {
  root.querySelectorAll('[data-vis]').forEach(cb => cb.addEventListener('change', async () => {
    try {
      if (cb.checked) await insert('visibility', { item_type: type, item_id: id, audience: cb.dataset.vis });
      else await del('visibility', `item_type=eq.${type}&item_id=eq.${id}&audience=eq.${cb.dataset.vis}`);
      toast('Visibility saved'); refreshStatus();
    } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  }));
}

// History
async function loadHistory() {
  const box = $('#history'); if (!box) return;
  box.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const [versions, changes] = await Promise.all([
      get(`versions?item_type=eq.${PAGE.type}&item_id=eq.${PAGE.id}&select=version,published_by,published_at,note&order=version.desc`),
      get(`changes?item_type=eq.${PAGE.type}&item_id=eq.${PAGE.id}&select=at,actor,action,before,after&order=at.desc&limit=40`),
    ]);
    const diff = c => { if (c.action !== 'update' || !c.before || !c.after) return ''; const keys = Object.keys(c.after).filter(k => JSON.stringify(c.after[k]) !== JSON.stringify(c.before[k]) && k !== 'updated_at'); return keys.length ? `<div class="diff">${keys.map(k => `<div><span class="k">${esc(k)}</span><span class="o">${esc(String(c.before[k] ?? '')).slice(0, 80)}</span><span class="n">${esc(String(c.after[k] ?? '')).slice(0, 80)}</span></div>`).join('')}</div>` : ''; };
    box.innerHTML = `<div class="panel"><h3>Published versions</h3><div class="body history">${versions.length ? versions.map(v => `<div class="v"><span class="n">v${v.version}</span><span class="who">${esc(v.published_by)}${v.note ? ` <span class="muted">${esc(v.note)}</span>` : ''}</span><span class="when">${when(v.published_at)}</span>${Auth.isStaff() && v.version !== versions[0].version ? `<button class="btn sm" data-rb="${v.version}">Roll back to this</button>` : ''}</div>`).join('') : '<div class="muted">Never published.</div>'}</div></div>
      <div class="panel"><h3>Recent changes</h3><div class="body">${changes.length ? changes.map(c => `<div class="change"><div class="top"><b>${esc(c.action)}</b><span>${esc(c.actor)}</span><span class="when">${when(c.at)}</span></div>${diff(c)}</div>`).join('') : '<div class="muted">No changes recorded.</div>'}</div></div>`;
    box.querySelectorAll('[data-rb]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Restore version ${b.dataset.rb} and publish it?`)) return;
      try { await rpc('rollback', { p_type: PAGE.type, p_id: PAGE.id, p_version: +b.dataset.rb }); toast('Rolled back and published'); route(); } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}

// ---------- placements editor ----------
// A container's children in order: drag to reorder, remove, add existing or new.
const CHILD_TYPES = { subject: ['group'], group: ['category'], category: ['scheme', 'lesson', 'media_block', 'category', 'subject'], variant: ['lesson'] };
async function childRows(parentType, parentId) {
  const ps = parentType === 'variant' ? await get(`placements?parent_type=eq.variant&parent_id=eq.${parentId}&select=*&order=sort`) : kids(parentType, parentId);
  const byType = {};
  for (const p of ps) (byType[p.child_type] ||= []).push(p.child_id);
  const rows = {};
  await Promise.all(Object.entries(byType).map(async ([t, ids]) => {
    const sel = t === 'media_block' ? 'id,heading,kind,text' : t === 'scheme' ? 'id,name,subheading,image' : t === 'category' ? 'id,name,subheading,image' : 'id,name';
    const r = await getAll(`${TABLE[t]}?id=in.(${ids.join(',')})&select=${sel}`);
    rows[t] = index(r);
  }));
  return ps.map(p => ({ p, item: (rows[p.child_type] || {})[p.child_id] })).filter(x => x.item);
}
async function placementsPanel(parentType, parentId, { title = 'Contents', note = '' } = {}) {
  const list = await childRows(parentType, parentId);
  const canEdit = Auth.isStaff();
  const row = ({ p, item }) => {
    const name = p.heading || item.name || item.heading || item.kind;
    const sub = p.subheading || item.subheading || (item.kind ? `${item.kind} block` : '');
    const pub = p.child_type === 'subject' ? true : isPub(p.child_type, p.child_id);
    return `<div class="row" data-pid="${p.id}" data-ct="${p.child_type}" data-cid="${p.child_id}">${canEdit ? '<span class="handle" title="Drag to reorder"><svg viewBox="0 0 12 12" fill="currentColor"><circle cx="3" cy="2" r="1.3"/><circle cx="9" cy="2" r="1.3"/><circle cx="3" cy="6" r="1.3"/><circle cx="9" cy="6" r="1.3"/><circle cx="3" cy="10" r="1.3"/><circle cx="9" cy="10" r="1.3"/></svg></span>' : ''}
      ${item.image ? `<img class="thumb" src="${esc(item.image)}" alt="">` : ''}<span class="kind ${p.child_type}">${KIND[p.child_type]}</span>
      <div class="title"><div class="name">${esc(name)}${p.heading ? ' <span class="muted small">(renamed here)</span>' : ''}</div><div class="sub">${esc(sub)}</div></div>
      ${p.variant_ids ? '<span class="pill new" title="Only some age variants show here">variants</span>' : ''}
      <span class="pill ${pub ? 'live' : 'hidden'}"><span class="dot"></span>${pub ? 'Published' : 'Not published'}</span>
      ${p.child_type === 'subject' ? '' : `<button class="btn sm open" data-go="${href(p.child_type, p.child_id)}">Open</button>`}
      ${canEdit ? `<button class="btn sm quiet danger" data-unplace="${p.id}" title="Remove from here">Remove</button>` : ''}</div>`;
  };
  const addMenu = canEdit ? `<div class="inline-add"><div class="menu" id="addMenu-${parentType}-${parentId}"><button class="btn" data-addbtn>+ Add</button><div class="items">${CHILD_TYPES[parentType].map(t => `<button data-add-existing="${t}">Add an existing ${KIND[t].toLowerCase()}…</button>`).join('')}${CHILD_TYPES[parentType].filter(t => t !== 'subject').map(t => `<button data-add-new="${t}">New ${KIND[t].toLowerCase()}</button>`).join('')}</div></div><span class="muted small">${note}</span></div>` : '';
  return `<div class="panel"><h3>${esc(title)} <span class="muted" style="font-weight:400">${list.length}</span></h3><div class="body"><div class="rows childlist" data-plist="${parentType}:${parentId}">${list.map(row).join('') || '<div class="empty">Nothing placed here yet.</div>'}</div>${addMenu}</div></div>`;
}
function bindPlacements(root, parentType, parentId, onChange) {
  root.querySelectorAll(`[data-plist="${parentType}:${parentId}"]`).forEach(list => {
    list.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); location.hash = b.dataset.go; }));
    if (Auth.isStaff()) {
      new Sortable(list, { handle: '.handle', animation: 150, onEnd: async () => {
        const groups = {};
        [...list.querySelectorAll('.row')].forEach(r => (groups[r.dataset.ct] ||= []).push(+r.dataset.cid));
        try {
          // one sequence across every child type: sort = position in the list
          const ids = [...list.querySelectorAll('.row')].map(r => +r.dataset.pid);
          await Promise.all(ids.map((pid, i) => patch('placements', pid, { sort: i + 1 })));
          toast('Order saved'); refreshStatus(); await reloadTreeQuiet(); if (onChange) onChange();
        } catch (e) { toast(e.message, true); }
      } });
      list.querySelectorAll('[data-unplace]').forEach(b => b.addEventListener('click', async () => {
        const r = b.closest('.row'); const others = parentsOf(r.dataset.ct, +r.dataset.cid).length;
        const last = r.dataset.ct !== 'subject' && others <= 1 && parentType !== 'variant';
        if (!confirm(last ? 'This is the only place this item appears. Removing it here means it will not appear anywhere. Remove?' : 'Remove from here? It stays everywhere else it is placed.')) return;
        try { await del('placements', `id=eq.${b.dataset.unplace}`); toast('Removed'); await reloadTreeQuiet(); if (onChange) onChange(); } catch (e) { toast(e.message, true); }
      }));
    }
  });
  const menu = root.querySelector(`#addMenu-${parentType}-${parentId}`);
  if (menu) {
    menu.querySelector('[data-addbtn]').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.querySelectorAll('[data-add-existing]').forEach(b => b.addEventListener('click', () => pickExisting(b.dataset.addExisting, parentType, parentId, onChange)));
    menu.querySelectorAll('[data-add-new]').forEach(b => b.addEventListener('click', () => createNew(b.dataset.addNew, parentType, parentId, onChange)));
  }
}
async function reloadTreeQuiet() { try { await loadTree(); renderTree(); } catch (e) {} }
async function place(parentType, parentId, childType, childId) {
  const existing = parentType === 'variant' ? await get(`placements?parent_type=eq.variant&parent_id=eq.${parentId}&select=sort`) : kids(parentType, parentId);
  const sort = existing.reduce((m, p) => Math.max(m, p.sort || 0), 0) + 1;
  const isHome = parentsOf(childType, childId).length === 0 && childType !== 'subject';
  return insert('placements', { parent_type: parentType, parent_id: parentId, child_type: childType, child_id: childId, sort, is_home: isHome });
}
function modal(html) { const m = $('#modal'); m.innerHTML = html; m.classList.add('open'); m.onclick = e => { if (e.target === m) closeModal(); }; return m; }
function closeModal() { $('#modal').classList.remove('open'); $('#modal').innerHTML = ''; }
async function pickExisting(childType, parentType, parentId, onChange) {
  const m = modal(`<div class="box"><div class="mhead"><h2>Add an existing ${KIND[childType].toLowerCase()}</h2><button class="btn quiet sm" data-close>Close</button></div><div class="mtools"><input id="pickq" type="search" placeholder="Type a name or id" autofocus></div><div class="mbody" id="pickres"><div class="empty">Start typing to search.</div></div><div class="mfoot"></div></div>`);
  m.querySelector('[data-close]').addEventListener('click', closeModal);
  const run = debounce(async () => {
    const q = m.querySelector('#pickq').value.trim(); if (q.length < 2) return;
    const rows = await rpc('search', { p_q: q, p_limit: 40, p_type: childType });
    const already = new Set(kids(parentType, parentId).map(p => `${p.child_type}:${p.child_id}`));
    m.querySelector('#pickres').innerHTML = rows.length ? rows.map(r => `<button class="pick" data-id="${r.id}" ${already.has(`${childType}:${r.id}`) ? 'disabled' : ''}><div class="meta"><b>${esc(r.name)}</b><span>${esc(r.detail || '')} · id ${r.id}${already.has(`${childType}:${r.id}`) ? ' · already here' : ''}</span></div></button>`).join('') : '<div class="empty">Nothing found.</div>';
    m.querySelectorAll('.pick').forEach(b => b.addEventListener('click', async () => {
      try { await place(parentType, parentId, childType, +b.dataset.id); closeModal(); toast('Added'); await reloadTreeQuiet(); if (onChange) onChange(); } catch (e) { toast(e.message, true); }
    }));
  }, 220);
  m.querySelector('#pickq').addEventListener('input', run);
  setTimeout(() => m.querySelector('#pickq').focus(), 50);
}
async function createNew(childType, parentType, parentId, onChange) {
  const name = prompt(`Name for the new ${KIND[childType].toLowerCase()}:`); if (!name) return;
  try {
    let row;
    if (childType === 'media_block') row = await insert('media_blocks', { kind: 'link', heading: name });
    else if (childType === 'scheme') { row = await insert('schemes', { name }); await insert('scheme_variants', { scheme_id: row.id, sort: 1 }); }
    else row = await insert(TABLE[childType], { name });
    await place(parentType, parentId, childType, row.id);
    toast('Created'); await reloadTreeQuiet(); if (onChange) onChange();
    location.hash = href(childType, row.id);
  } catch (e) { toast(e.message, true); }
}
// Where an item appears (its placements as a child), for the Placements tab.
async function whereUsedPanel(type, id) {
  const ps = type === 'lesson' ? await get(`placements?child_type=eq.lesson&child_id=eq.${id}&select=*`) : parentsOf(type, id);
  const names = await Promise.all(ps.map(async p => {
    if (p.parent_type === 'variant') { const [v] = await get(`scheme_variants?id=eq.${p.parent_id}&select=id,scheme_id,age_min,age_max,schemes(name)`); return v ? { href: href('scheme', v.scheme_id), name: `${v.schemes.name} (ages ${v.age_min ?? '?'}-${v.age_max ?? '?'})`, kind: 'scheme' } : null; }
    const t = p.parent_type; const item = t === 'subject' ? D.subjectById[p.parent_id] : t === 'group' ? D.groupById[p.parent_id] : D.catById[p.parent_id];
    return item ? { href: href(t, p.parent_id), name: item.name, kind: t, p } : null;
  }));
  return `<div class="panel"><h3>Where this appears</h3><div class="body"><div class="place">${names.filter(Boolean).map(n => `<div class="item ${n.p && n.p.is_home ? 'home' : ''}"><span class="kind ${n.kind}">${KIND[n.kind]}</span><div class="path"><b>${esc(n.name)}</b>${n.p ? `<span>position ${n.p.sort}${n.p.is_home ? ' · home' : ''}${n.p.variant_ids ? ' · some variants only' : ''}</span>` : ''}</div><button class="btn sm" data-go="${n.href}">Open</button></div>`).join('') || '<div class="empty">Not placed anywhere yet. Add it to a category or scheme from that page.</div>'}</div></div></div>`;
}

// ---------- pages ----------
async function pageSubject(id) {
  const [row] = await get(`subjects?id=eq.${id}&select=*`); if (!row) return notFound();
  PAGE = { type: 'subject', id, row, dirty: {}, firstTab: 'groups' };
  const [groupsHtml, visHtml] = await Promise.all([placementsPanel('subject', id, { title: 'Groups', note: 'The groups shown on the subject page, in this order.' }), visibilityPanel('subject', id)]);
  editor.innerHTML = pageHeader([{ name: 'Subjects' }, { name: row.name }], [{ key: 'groups', label: 'Groups' }, { key: 'details', label: 'Details' }, { key: 'featured', label: 'Featured' }, { key: 'visibility', label: 'Visibility' }, { key: 'history', label: 'History' }]) +
    panel('groups', groupsHtml) +
    panel('details', `<div class="panel"><div class="body"><div class="grid">${field('name', 'Name')}${field('button_colour', 'Button colour (hex, without #)')}${field('icon', 'Icon class (Bootstrap icon)')}${field('sort', 'Order in the subject bar', { type: 'number' })}${field('description', 'Description (collapsible panel at the top of the subject page)', { type: 'textarea', span: true })}${field('background_image', 'Background image URL', { span: true, help: 'Image upload arrives with the media library (increment 3).' })}${field('call_scheduling_url', 'Call scheduling URL', { span: true })}
      <div class="span"><div class="subhead">Home page and browse</div>${field('on_home', 'Show on the home page', { type: 'check' })} ${field('homepage_order', 'Home page order', { type: 'number' })} ${field('browsable', 'Include in Browse', { type: 'check' })} ${field('browse_order', 'Browse order', { type: 'number' })}</div></div></div></div>`) +
    panel('featured', featuredPanel()) +
    panel('visibility', visHtml) +
    panel('history', '<div id="history"></div>');
  bindHeader(editor); bindFields(editor); bindPlacements(editor, 'subject', id, () => route()); bindVisibility(editor, 'subject', id); bindFeatured();
  refreshStatus();
}
function featuredPanel() {
  const fv = PAGE.row.featured_video || {};
  const slot = (k, label) => { const v = fv[k] || {}; return `<div class="subhead">${label}</div><div class="grid"><div class="field"><label>Stream UID</label><input type="text" data-fv="${k}.stream_uid" value="${esc(v.stream_uid)}"></div><div class="field"><label>Wistia id (legacy)</label><input type="text" data-fv="${k}.wistia_id" value="${esc(v.wistia_id)}"></div><div class="field"><label>Heading</label><input type="text" data-fv="${k}.heading" value="${esc(v.heading)}"></div><div class="field"><label>Subheading</label><input type="text" data-fv="${k}.subheading" value="${esc(v.subheading)}"></div><div class="field span"><label>Description</label><textarea data-fv="${k}.description">${esc(v.description)}</textarea></div></div>`; };
  const feats = PAGE.row.featured || [];
  return `<div class="panel"><h3>Featured video</h3><div class="body"><div class="help">Shown at the top of the subject page. Paid users see the KS1 or KS2 version by their class age; free users see the free version. Leave a slot empty to show nothing to that audience.</div>${slot('ks1', 'Paid, KS1 (ages 4-7)')}${slot('ks2', 'Paid, KS2 (ages 7-11)')}${slot('free', 'Free users')}</div></div>
    <div class="panel"><h3>Featured categories on the home page</h3><div class="body"><div class="help">Up to four category tiles for users who land on the home page rather than a subject page. Category id, heading and subheading.</div><div class="grid">${[0, 1, 2, 3].map(i => { const f = feats[i] || {}; return `<div class="field"><label>Tile ${i + 1}: category id</label><input type="number" data-ft="${i}.category_id" value="${f.category_id ?? ''}"></div><div class="field"><label>Heading</label><input type="text" data-ft="${i}.heading" value="${esc(f.heading)}"></div><div class="field"><label>Subheading</label><input type="text" data-ft="${i}.subheading" value="${esc(f.subheading)}"></div>`; }).join('')}</div></div></div>`;
}
function bindFeatured() {
  editor.querySelectorAll('[data-fv]').forEach(el => el.addEventListener('input', () => {
    const [k, f] = el.dataset.fv.split('.'); const fv = PAGE.row.featured_video ? JSON.parse(JSON.stringify(PAGE.row.featured_video)) : {};
    (fv[k] ||= {})[f] = el.value || undefined; if (!Object.values(fv[k]).some(Boolean)) delete fv[k];
    PAGE.row.featured_video = Object.keys(fv).length ? fv : null; PAGE.dirty.featured_video = PAGE.row.featured_video; $('#saveBtn').disabled = false;
  }));
  editor.querySelectorAll('[data-ft]').forEach(el => el.addEventListener('input', () => {
    const [i, f] = el.dataset.ft.split('.'); const feats = JSON.parse(JSON.stringify(PAGE.row.featured || []));
    feats[+i] ||= {}; feats[+i][f] = f === 'category_id' ? (el.value ? +el.value : undefined) : (el.value || undefined);
    PAGE.row.featured = feats.filter(x => x && x.category_id); PAGE.dirty.featured = PAGE.row.featured; $('#saveBtn').disabled = false;
  }));
}
async function pageGroup(id) {
  const [row] = await get(`groups?id=eq.${id}&select=*`); if (!row) return notFound();
  PAGE = { type: 'group', id, row, dirty: {}, firstTab: 'categories' };
  const parent = parentsOf('group', id)[0]; const subj = parent && D.subjectById[parent.parent_id];
  const [catsHtml, visHtml, whereHtml] = await Promise.all([placementsPanel('group', id, { title: 'Categories', note: 'The category tiles in this group, in this order. A category can sit in several groups.' }), visibilityPanel('group', id), whereUsedPanel('group', id)]);
  editor.innerHTML = pageHeader([subj ? { name: subj.name, href: href('subject', subj.id) } : { name: 'Groups' }, { name: row.name }], [{ key: 'categories', label: 'Categories' }, { key: 'details', label: 'Details' }, { key: 'placements', label: 'Where it appears' }, { key: 'visibility', label: 'Visibility' }, { key: 'history', label: 'History' }]) +
    panel('categories', catsHtml) +
    panel('details', `<div class="panel"><div class="body"><div class="grid">${field('name', 'Name')}${field('curriculum', 'Curriculum label')}${field('description', 'Description (shown beside the group heading)', { type: 'textarea', span: true })}</div></div></div>`) +
    panel('placements', whereHtml) + panel('visibility', visHtml) + panel('history', '<div id="history"></div>');
  bindHeader(editor); bindFields(editor); bindPlacements(editor, 'group', id, () => route()); bindVisibility(editor, 'group', id);
  editor.querySelectorAll('.place [data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  refreshStatus();
}
async function pageCategory(id) {
  const [row] = await get(`categories?id=eq.${id}&select=*`); if (!row) return notFound();
  PAGE = { type: 'category', id, row, dirty: {}, firstTab: 'contents' };
  const parent = parentsOf('category', id).find(p => p.is_home) || parentsOf('category', id)[0];
  const grp = parent && parent.parent_type === 'group' && D.groupById[parent.parent_id]; const subjP = grp && parentsOf('group', grp.id)[0]; const subj = subjP && D.subjectById[subjP.parent_id];
  const [contentsHtml, visHtml, whereHtml] = await Promise.all([placementsPanel('category', id, { title: 'Contents', note: 'Schemes, single lessons, video or document blocks, other categories and subject tiles, in the order teachers see them.' }), visibilityPanel('category', id), whereUsedPanel('category', id)]);
  const tile = `<div class="field span"><label>Tile preview</label><div style="display:flex;gap:16px;align-items:flex-start"><div id="tilePreview"></div><div class="help">Leave the image blank and the platform draws a tile from the category name (replaces the hand-made word tiles). Image upload arrives with the media library.</div></div></div>`;
  editor.innerHTML = pageHeader([subj ? { name: subj.name, href: href('subject', subj.id) } : { name: 'Categories' }, grp ? { name: grp.name, href: href('group', grp.id) } : null, { name: row.name }].filter(Boolean),
      [{ key: 'contents', label: 'Contents' }, { key: 'details', label: 'Details' }, { key: 'placements', label: 'Where it appears' }, { key: 'visibility', label: 'Visibility' }, { key: 'history', label: 'History' }]) +
    panel('contents', contentsHtml) +
    panel('details', `<div class="panel"><div class="body"><div class="grid">${field('name', 'Name')}${field('subheading', 'Subheading (on the tile)')}${field('description', 'Description (on the category page)', { type: 'textarea', span: true })}${field('image', 'Image URL (blank = generated tile)', { span: true })}${tile}${field('background_image', 'Page background image URL', { span: true })}${field('noun_singular', 'What a lesson is called here (singular)', { help: 'e.g. lesson, activity, session' })}${field('noun_plural', 'Plural')}${field('homepage_order', 'Home page order', { type: 'number' })}<div class="span">${field('on_subject_page', 'Show this category as a tile on the subject page', { type: 'check' })}</div></div></div></div>`) +
    panel('placements', whereHtml) + panel('visibility', visHtml) + panel('history', '<div id="history"></div>');
  bindHeader(editor); bindFields(editor); bindPlacements(editor, 'category', id, () => route()); bindVisibility(editor, 'category', id);
  editor.querySelectorAll('.place [data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  const drawTile = () => { const r = PAGE.row; $('#tilePreview').innerHTML = r.image ? `<img src="${esc(r.image)}" alt="" style="width:180px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;border:1px solid var(--line)">` : `<div style="width:180px;aspect-ratio:16/9;border-radius:8px;background:linear-gradient(135deg,#733088,#9c4dbf);color:#fff;display:grid;place-items:center;text-align:center;padding:10px;font-family:'Baloo 2',sans-serif;font-weight:700;font-size:17px;line-height:1.15">${esc(r.name)}</div>`; };
  drawTile(); PAGE.onChange = k => { if (k === 'image' || k === 'name') drawTile(); };
  refreshStatus();
}
async function pageBlock(id) {
  const [row] = await get(`media_blocks?id=eq.${id}&select=*`); if (!row) return notFound();
  PAGE = { type: 'media_block', id, row, dirty: {}, firstTab: 'details' };
  const whereHtml = await whereUsedPanel('media_block', id);
  const v = row.video || {};
  const vslot = (k, label) => { const x = v[k] || {}; return `<div class="subhead">${label}</div><div class="grid"><div class="field"><label>Stream UID</label><input type="text" data-bv="${k}.stream_uid" value="${esc(x.stream_uid)}"></div><div class="field"><label>Wistia id (legacy)</label><input type="text" data-bv="${k}.wistia_id" value="${esc(x.wistia_id)}"></div><div class="field"><label>Duration (as shown, e.g. 3:20)</label><input type="text" data-bv="${k}.duration" value="${esc(x.duration)}"></div><div class="field"><label>Heading for this audience (optional)</label><input type="text" data-bv="${k}.heading" value="${esc(x.heading)}"></div><div class="field span"><label>Text for this audience (optional)</label><textarea data-bv="${k}.text">${esc(x.text)}</textarea></div></div>`; };
  editor.innerHTML = pageHeader([{ name: 'Blocks' }, { name: row.heading || row.kind }], [{ key: 'details', label: 'Details' }, { key: 'placements', label: 'Where it appears' }, { key: 'history', label: 'History' }]) +
    panel('details', `<div class="panel"><div class="body"><div class="grid">${field('kind', 'Kind', { type: 'select', options: [['video', 'Video'], ['document', 'Document'], ['link', 'Link']] })}${field('heading', 'Heading')}${field('text', 'Text', { type: 'textarea', span: true })}
      <div class="span" data-kind="document">${field('document_url', 'Document URL', { span: true, help: 'Upload arrives with the media library (increment 3); for now a URL.' })}</div>
      <div class="span" data-kind="link"><div class="grid">${field('link_text', 'Button text')}${field('link_url', 'Link URL')}</div></div>
      <div class="span" data-kind="video">${vslot('all', 'Video for everyone')}${vslot('paid', 'Paid users (leave empty to use the version for everyone)')}${vslot('free', 'Free users (leave empty to use the version for everyone)')}</div></div></div></div>`) +
    panel('placements', whereHtml) + panel('history', '<div id="history"></div>');
  bindHeader(editor); bindFields(editor);
  const showKind = () => editor.querySelectorAll('[data-kind]').forEach(el => el.hidden = el.dataset.kind !== PAGE.row.kind); showKind(); PAGE.onChange = k => { if (k === 'kind') showKind(); };
  editor.querySelectorAll('[data-bv]').forEach(el => el.addEventListener('input', () => {
    const [k, f] = el.dataset.bv.split('.'); const vv = PAGE.row.video ? JSON.parse(JSON.stringify(PAGE.row.video)) : {};
    (vv[k] ||= {})[f] = el.value || undefined; if (!Object.values(vv[k]).some(Boolean)) delete vv[k];
    PAGE.row.video = Object.keys(vv).length ? vv : null; PAGE.dirty.video = PAGE.row.video; $('#saveBtn').disabled = false;
  }));
  editor.querySelectorAll('.place [data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  refreshStatus();
}

// Scheme: details, page text, variants (each with its lesson sequence), placements, subjects, history.
async function pageScheme(id, tab) {
  const [row] = await get(`schemes?id=eq.${id}&select=*`); if (!row) return notFound();
  const variants = await get(`scheme_variants?scheme_id=eq.${id}&select=*&order=sort,age_min`);
  PAGE = { type: 'scheme', id, row, dirty: {}, firstTab: tab || 'variants', variants, variant: variants[0] && variants[0].id, reload: t => pageScheme(id, t || PAGE.tab) };
  const home = parentsOf('scheme', id).find(p => p.is_home) || parentsOf('scheme', id)[0];
  const cat = home && D.catById[home.parent_id];
  const whereHtml = await whereUsedPanel('scheme', id);
  editor.innerHTML = pageHeader([cat ? { name: cat.name, href: href('category', cat.id) } : { name: 'Schemes' }, { name: row.name }],
      [{ key: 'variants', label: variants.length > 1 ? 'Lessons by age' : 'Lessons', n: variants.length > 1 ? variants.length : null }, { key: 'details', label: 'Details' }, { key: 'text', label: 'Page text' }, { key: 'placements', label: 'Placement' }, { key: 'history', label: 'History' }]) +
    panel('variants', `<div class="panel"><div class="vtabs" id="vtabs"></div><div id="variantBox"></div></div>`) +
    panel('details', `<div class="panel"><div class="body"><div class="grid">${field('name', 'Name')}${field('subheading', 'Subheading')}${field('image', 'Image URL', { span: true, help: 'Image upload arrives with the media library (increment 3).' })}<div class="span">${field('free_sample', 'Free sample (visible and open to everyone, shows the Free badge)', { type: 'check' })}</div>${field('extra_subject_ids', 'Extra subject ids (beyond those implied by where it is placed)', { type: 'list', span: true, help: 'Comma-separated subject ids. Search and favourites group by subject.' })}</div></div></div>`) +
    panel('text', textBlock(true)) +
    panel('placements', whereHtml) + panel('history', '<div id="history"></div>');
  bindHeader(editor); bindFields(editor); renderPreview(); PAGE.onChange = () => renderPreview();
  editor.querySelectorAll('.place [data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  renderVariantTabs(); await renderVariant();
  refreshStatus();
}
function renderVariantTabs() {
  const box = $('#vtabs'); const vs = PAGE.variants;
  const label = v => v.age_min != null ? `Ages ${v.age_min}-${v.age_max ?? v.age_min}` : (v.subheading || `Variant ${v.sort}`);
  box.innerHTML = vs.map(v => `<button class="${v.id === PAGE.variant ? 'active' : ''}" data-v="${v.id}">${esc(label(v))}</button>`).join('') + (Auth.isStaff() ? `<button data-v="new" title="Another age range of this scheme, with its own lesson sequence">+ Add age variant</button>` : '');
  box.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.v === 'new') {
      const min = prompt('Youngest age (4 to 11):', '4'), max = min && prompt('Oldest age (4 to 11):', '11'); if (!min || !max) return;
      try { const v = await insert('scheme_variants', { scheme_id: PAGE.id, age_min: +min, age_max: +max, sort: PAGE.variants.length + 1 }); PAGE.variants.push(v); PAGE.variant = v.id; renderVariantTabs(); await renderVariant(); toast('Variant added'); } catch (e) { toast(e.message, true); }
      return;
    }
    PAGE.variant = +b.dataset.v; renderVariantTabs(); await renderVariant();
  }));
}
async function renderVariant() {
  const v = PAGE.variants.find(x => x.id === PAGE.variant); const box = $('#variantBox');
  if (!v) { box.innerHTML = '<div class="empty">No variant yet.</div>'; return; }
  const lessonsHtml = await placementsPanel('variant', v.id, { title: 'Lessons', note: 'In the order teachers see them. A lesson can be in more than one scheme.' });
  const ov = (k, label, type = 'text') => `<div class="field"><label>${esc(label)}</label>${type === 'textarea' ? `<textarea data-vf="${k}" placeholder="${esc(PAGE.row[k] || '')}">${esc(v[k])}</textarea>` : `<input type="${type}" data-vf="${k}" value="${esc(v[k])}" placeholder="${esc(PAGE.row[k] || '')}">`}</div>`;
  box.innerHTML = `<div class="body" style="padding-bottom:0"><div class="grid four"><div class="field"><label>Youngest age</label><input type="number" data-vf="age_min" value="${v.age_min ?? ''}"></div><div class="field"><label>Oldest age</label><input type="number" data-vf="age_max" value="${v.age_max ?? ''}"></div><div class="field"><label>Variant order</label><input type="number" data-vf="sort" value="${v.sort ?? ''}"></div><div class="field" style="align-self:end">${Auth.isStaff() && PAGE.variants.length > 1 ? `<button class="btn sm danger" id="delVariant">Delete this variant</button>` : ''}</div></div>
    <details style="margin:8px 0 4px"><summary class="muted small" style="cursor:pointer">Text and image for this age range only (blank = same as the scheme)</summary><div class="grid" style="margin-top:8px">${ov('subheading', 'Subheading')}${ov('image', 'Image URL')}${ov('description', 'Description', 'textarea')}${ov('body_opening_text', 'Opening text', 'textarea')}${ov('body_closing_text', 'Closing text', 'textarea')}</div></details></div>${lessonsHtml.replace('<div class="panel">', '<div>').replace(/<\/div>$/, '')}`;
  box.querySelectorAll('[data-vf]').forEach(el => el.addEventListener('change', debounce(async () => {
    const val = el.type === 'number' ? (el.value === '' ? null : +el.value) : (el.value || null);
    try { const r = await patch('scheme_variants', v.id, { [el.dataset.vf]: val }); Object.assign(v, r); toast('Saved'); renderVariantTabs(); refreshStatus(); } catch (e) { toast(e.message, true); }
  }, 300)));
  const delBtn = box.querySelector('#delVariant');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const n = (await get(`placements?parent_type=eq.variant&parent_id=eq.${v.id}&select=id`)).length;
    if (n && !confirm(`This variant has ${n} lessons placed in it; they stay as lessons but leave this scheme. Delete the variant?`)) return;
    if (!n && !confirm('Delete this variant?')) return;
    try { await del('placements', `parent_type=eq.variant&parent_id=eq.${v.id}`); await del('scheme_variants', `id=eq.${v.id}`); PAGE.variants = PAGE.variants.filter(x => x.id !== v.id); PAGE.variant = PAGE.variants[0]?.id; renderVariantTabs(); await renderVariant(); toast('Variant deleted'); } catch (e) { toast(e.message, true); }
  });
  bindPlacements(box, 'variant', v.id, () => renderVariant());
}

// Lesson: details, page text, parts, placements, thumb-o-meter, history.
async function pageLesson(id, tab) {
  const [row] = await get(`lessons?id=eq.${id}&select=*`); if (!row) return notFound();
  PAGE = { type: 'lesson', id, row, dirty: {}, firstTab: tab || 'parts', reload: t => pageLesson(id, t || PAGE.tab) };
  const [parts, whereHtml] = await Promise.all([get(`lesson_parts?lesson_id=eq.${id}&select=*&order=sort,id`), whereUsedPanel('lesson', id)]);
  PAGE.parts = parts;
  const vp = await get(`placements?child_type=eq.lesson&child_id=eq.${id}&parent_type=eq.variant&select=parent_id&limit=1`);
  let crumbs = [{ name: 'Lessons' }];
  if (vp[0]) { const [v] = await get(`scheme_variants?id=eq.${vp[0].parent_id}&select=scheme_id,schemes(name)`); if (v) crumbs = [{ name: v.schemes.name, href: href('scheme', v.scheme_id) }]; }
  crumbs.push({ name: row.name });
  editor.innerHTML = pageHeader(crumbs, [{ key: 'parts', label: 'Parts', n: parts.filter(p => !p.archived).length }, { key: 'details', label: 'Details' }, { key: 'text', label: 'Page text' }, { key: 'placements', label: 'Placement' }, { key: 'thumb', label: 'Thumb-o-meter' }, { key: 'history', label: 'History' }]) +
    panel('parts', '<div id="partsBox"></div>') +
    panel('details', `<div class="panel"><div class="body"><div class="grid">${field('name', 'Name')}${field('heading_2', 'Secondary heading (beside the name on the lesson page)')}${field('description', 'Short description (on the lesson row)', { type: 'textarea', span: true, rows: 2 })}${field('description_long', 'Long description', { type: 'textarea', span: true })}
      <div class="span"><div class="subhead">Ages</div><div class="grid four">${field('age_min', 'Youngest age', { type: 'number' })}${field('age_max', 'Oldest age', { type: 'number' })}</div></div>
      <div class="span"><div class="subhead">What to expect</div><div class="grid four">${field('duration', 'Duration (minutes)', { type: 'number' })}${field('preparation', 'Preparation (minutes)', { type: 'number' })}${field('intensity', 'Physical intensity')}${field('focus', 'Focus')}${field('location', 'Location(s)', { type: 'list', help: 'Comma-separated, e.g. Hall, Classroom' })}</div></div>
      <div class="span"><div class="subhead">Flags</div>${field('free_sample', 'Free sample (open to everyone, Free badge)', { type: 'check' })} ${field('featured', 'Featured', { type: 'check' })}</div>
      ${field('background_image', 'Page background image URL', { span: true })}${field('tags', 'Tags (for search)', { type: 'list', span: true, help: 'Comma-separated. Used by search from increment 6.' })}${field('extra_search', 'Extra search terms', { span: true })}${field('extra_subject_ids', 'Extra subject ids', { type: 'list', span: true, help: 'Subjects beyond those implied by the scheme placement; search and favourites group by subject.' })}</div></div></div>`) +
    panel('text', textBlock(false)) +
    panel('placements', whereHtml) +
    panel('thumb', `<div class="panel"><div class="body"><div class="grid">${field('thumb_enabled', 'Show the thumb-o-meter on this lesson', { type: 'check' })}${field('thumb_question', 'Question', { span: true })}${field('thumb_response_0', 'Response 1 (thumbs down)')}${field('thumb_response_1', 'Response 2 (sideways)')}${field('thumb_response_2', 'Response 3 (thumbs up)')}</div></div></div>`) +
    panel('history', '<div id="history"></div>');
  bindHeader(editor); bindFields(editor); renderPreview(); PAGE.onChange = () => renderPreview();
  editor.querySelectorAll('.place [data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  renderParts();
  refreshStatus();
}
const PART_TYPES = ['Video', 'Audio', 'Slides', 'Image', 'Download', 'Text'];
const partIcon = t => ({ Video: '🎬', Audio: '🎵', Slides: '🖼️', Image: '🖼', Download: '📄', Text: '📝' }[t] || '📝');
function renderParts() {
  const box = $('#partsBox'); const canEdit = Auth.isStaff();
  const live = PAGE.parts.filter(p => !p.archived);
  const isDoc = p => p.show_as_document ?? (p.media_type === 'Download');
  let n = 0;
  const row = p => { const doc = isDoc(p); const num = (!doc && p.live && !p.archived) ? ++n : null;
    return `<div class="part ${p.archived ? 'archived' : ''}" data-part="${p.id}"><div class="row">${canEdit && !p.archived ? '<span class="handle"><svg viewBox="0 0 12 12" fill="currentColor"><circle cx="3" cy="2" r="1.3"/><circle cx="9" cy="2" r="1.3"/><circle cx="3" cy="6" r="1.3"/><circle cx="9" cy="6" r="1.3"/><circle cx="3" cy="10" r="1.3"/><circle cx="9" cy="10" r="1.3"/></svg></span>' : '<span class="handle"></span>'}<span class="num">${num ? `Part ${num}` : (doc ? (p.heading && /\b(lesson|session)\s*plans?\b/i.test(p.heading) ? 'Plan' : 'Printable') : '')}</span><span class="media">${partIcon(p.media_type)} ${esc(p.media_type)}</span><div class="title"><div class="name">${esc(p.heading || '(no heading)')}</div><div class="sub">${esc((p.additional_info || '').replace(/\s+/g, ' ').slice(0, 90))}</div></div>${p.duration ? `<span class="muted small">${esc(p.duration)}</span>` : ''}<span class="pill ${p.archived ? 'hidden' : p.live ? 'live' : 'pending'}"><span class="dot"></span>${p.archived ? 'Archived' : p.live ? 'Live' : 'Hidden'}</span><button class="btn sm quiet" data-toggle>Edit</button></div>
      <div class="detail"></div></div>`; };
  box.innerHTML = `<div class="panel"><h3>Parts</h3><div class="body"><div class="help" style="margin-bottom:10px">Video, audio, slides, images and text are numbered "Part X of Y" in this order. Downloads sit outside the sequence as the lesson plan card and the Printables list.</div><div class="rows" id="partList">${live.map(row).join('') || '<div class="empty">No parts yet.</div>'}</div>
    ${canEdit ? `<div class="inline-add"><div class="menu" id="addPart"><button class="btn" data-addbtn>+ Add part</button><div class="items">${PART_TYPES.map(t => `<button data-newpart="${t}">${partIcon(t)} ${t}</button>`).join('')}</div></div></div>` : ''}
    ${PAGE.parts.some(p => p.archived) ? `<details style="margin-top:12px"><summary class="muted small" style="cursor:pointer">Archived parts (${PAGE.parts.filter(p => p.archived).length})</summary><div class="rows" style="margin-top:8px">${PAGE.parts.filter(p => p.archived).map(row).join('')}</div></details>` : ''}</div></div>`;
  box.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => { const el = b.closest('.part'); el.classList.toggle('open'); if (el.classList.contains('open')) renderPartDetail(el); }));
  if (canEdit) {
    const list = box.querySelector('#partList');
    if (list) new Sortable(list, { handle: '.handle', animation: 150, onEnd: async () => {
      const ids = [...list.querySelectorAll('.part')].map(e => +e.dataset.part);
      try { await Promise.all(ids.map((pid, i) => patch('lesson_parts', pid, { sort: i + 1 }))); ids.forEach((pid, i) => { const p = PAGE.parts.find(x => x.id === pid); if (p) p.sort = i + 1; }); PAGE.parts.sort((a, b) => a.sort - b.sort); toast('Order saved'); renderParts(); refreshStatus(); } catch (e) { toast(e.message, true); }
    } });
    const menu = box.querySelector('#addPart');
    menu.querySelector('[data-addbtn]').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.querySelectorAll('[data-newpart]').forEach(b => b.addEventListener('click', async () => {
      try { const p = await insert('lesson_parts', { lesson_id: PAGE.id, media_type: b.dataset.newpart, heading: b.dataset.newpart, sort: PAGE.parts.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1 }); PAGE.parts.push(p); renderParts(); const el = box.querySelector(`[data-part="${p.id}"]`); el.classList.add('open'); renderPartDetail(el); refreshStatus(); } catch (e) { toast(e.message, true); }
    }));
  }
}
function renderPartDetail(el) {
  const p = PAGE.parts.find(x => x.id === +el.dataset.part); const d = el.querySelector('.detail'); const canEdit = Auth.isStaff();
  const f = (k, label, type = 'text', extra = '') => `<div class="field"><label>${esc(label)}</label>${type === 'textarea' ? `<textarea data-pf="${k}">${esc(p[k])}</textarea>` : type === 'select' ? `<select data-pf="${k}">${extra}</select>` : `<input type="text" data-pf="${k}" value="${esc(p[k])}">`}</div>`;
  const mediaFields = { Video: f('stream_uid', 'Cloudflare Stream UID') + f('wistia_id', 'Wistia id (legacy, until the player switch)'), Audio: f('file_url', 'Audio file URL'), Image: f('file_url', 'Image URL'), Download: f('file_url', 'File URL') + f('download_button', 'Button text') + f('download_info', 'Info text'), Slides: f('google_slide_id', 'Google Slides id (captured decks play from R2)') + '<div class="help">PDF upload rendered to slides arrives with the media library (increment 3).</div>', Text: '' }[p.media_type] || '';
  d.innerHTML = `<div class="grid" style="margin-top:10px">${f('media_type', 'Type', 'select', PART_TYPES.map(t => `<option ${p.media_type === t ? 'selected' : ''}>${t}</option>`).join(''))}${f('heading', 'Heading')}${f('duration', 'Duration (as shown, e.g. 4:30)')}<div class="field"><label>Shown as</label><select data-pf="show_as_document"><option value="" ${p.show_as_document == null ? 'selected' : ''}>By type (downloads outside the sequence)</option><option value="false" ${p.show_as_document === false ? 'selected' : ''}>In the Part X of Y sequence</option><option value="true" ${p.show_as_document === true ? 'selected' : ''}>As a document (lesson plan or printable)</option></select></div>
    <div class="span">${f('additional_info', 'Text shown with this part', 'textarea')}</div><div class="span"><div class="grid">${mediaFields}</div></div>
    <div class="span" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><label class="switch"><input type="checkbox" data-pf="live" ${p.live ? 'checked' : ''}> <span>Live</span></label>${canEdit ? `<button class="btn sm" data-archive>${p.archived ? 'Restore' : 'Archive'}</button>` : ''}${canEdit && p.qb_id == null ? '<button class="btn sm danger" data-delpart>Delete</button>' : ''}</div></div>`;
  if (!canEdit) { d.querySelectorAll('input,select,textarea').forEach(x => x.disabled = true); return; }
  d.querySelectorAll('[data-pf]').forEach(x => x.addEventListener('change', debounce(async () => {
    const k = x.dataset.pf; let v = x.type === 'checkbox' ? x.checked : x.value === '' ? null : x.value;
    if (k === 'show_as_document') v = x.value === '' ? null : x.value === 'true';
    try { const r = await patch('lesson_parts', p.id, { [k]: v }); Object.assign(p, r); toast('Saved'); refreshStatus(); if (k === 'media_type' || k === 'heading' || k === 'live' || k === 'show_as_document') { renderParts(); const e2 = $(`[data-part="${p.id}"]`); e2.classList.add('open'); renderPartDetail(e2); } } catch (e) { toast(e.message, true); }
  }, 250)));
  const arch = d.querySelector('[data-archive]'); if (arch) arch.addEventListener('click', async () => { try { const r = await patch('lesson_parts', p.id, { archived: !p.archived }); Object.assign(p, r); renderParts(); refreshStatus(); } catch (e) { toast(e.message, true); } });
  const dl = d.querySelector('[data-delpart]'); if (dl) dl.addEventListener('click', async () => { if (!confirm('Delete this part?')) return; try { await del('lesson_parts', `id=eq.${p.id}`); PAGE.parts = PAGE.parts.filter(x => x.id !== p.id); renderParts(); refreshStatus(); } catch (e) { toast(e.message, true); } });
}

function notFound() { editor.innerHTML = '<div class="empty" style="padding-top:120px">Not found.</div>'; }

// ---------- waiting drawer ----------
async function loadWaiting() {
  try {
    const rows = await get('waiting?select=*&order=changed_at.desc&limit=200');
    const c = $('#waitingCount'); c.textContent = rows.length; c.hidden = !rows.length;
    $('#drawerItems').innerHTML = rows.length ? rows.map(r => `<div class="change"><div class="top"><span class="kind ${r.item_type}">${KIND[r.item_type]}</span><button data-go="${href(r.item_type, r.id)}" style="border:0;background:none;color:var(--accent);cursor:pointer;font-weight:600;text-align:left;padding:0">${esc(r.name)}</button><span class="when">${when(r.changed_at)}</span></div><div class="what">${r.is_published ? `changed since v${r.last_version}` : 'never published'}${r.changed_by ? ` · ${esc(r.changed_by)}` : ''}</div></div>`).join('') : '<div class="empty">Nothing waiting. Everything that has changed is published.</div>';
    $('#drawerItems').querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { $('#drawer').classList.remove('open'); location.hash = b.dataset.go; }));
  } catch (e) { /* ignore */ }
}
$('#waitingBtn').addEventListener('click', () => $('#drawer').classList.toggle('open'));
$('#drawerClose').addEventListener('click', () => $('#drawer').classList.remove('open'));

// ---------- routing and boot ----------
async function route() {
  const p = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  const id = +p[1];
  if (PAGE && Object.keys(PAGE.dirty).length && !(PAGE.type === p[0] && PAGE.id === id)) { if (!confirm('You have unsaved changes. Leave without saving?')) { history.back(); return; } }
  editor.innerHTML = '<div class="empty" style="padding-top:80px">Loading…</div>';
  try {
    if (p[0] === 'subject') { treeReveal('subject', id); renderTree(); await pageSubject(id); }
    else if (p[0] === 'group') { treeReveal('group', id); renderTree(); await pageGroup(id); }
    else if (p[0] === 'category') { treeReveal('category', id); renderTree(); await pageCategory(id); }
    else if (p[0] === 'scheme') await pageScheme(id);
    else if (p[0] === 'lesson') await pageLesson(id);
    else if (p[0] === 'block') await pageBlock(id);
    else { PAGE = null; editor.innerHTML = `<div class="empty" style="padding-top:120px"><h2 style="font-weight:600;font-size:18px;margin-bottom:8px">imoves content</h2>Open a subject on the left, or search above. ${Auth.isStaff() ? 'Changes save to a draft; nothing reaches teachers until you publish it.' : ''}</div>`; }
  } catch (e) { editor.innerHTML = `<div class="empty" style="padding-top:80px">Something went wrong: ${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && PAGE) { e.preventDefault(); save(); } });

async function start() {
  document.body.classList.remove('signedout'); $('#login').classList.remove('open');
  $('#who').textContent = Auth.email() + (Auth.isStaff() ? ' · staff' : ''); $('#signout').hidden = false;
  $('#readonly').hidden = Auth.isStaff();
  try { await loadTree(); renderTree(); } catch (e) { $('#tree').innerHTML = `<div class="hint">Could not load content: ${esc(e.message)}</div>`; }
  loadWaiting();
  route();
}
function showLogin(msg) {
  document.body.classList.add('signedout'); $('#login').classList.add('open'); $('#who').textContent = ''; $('#signout').hidden = true;
  const err = $('#loginerror'); if (msg) { err.textContent = msg; err.classList.remove('hidden'); }
}
$('#loginform').addEventListener('submit', async e => {
  e.preventDefault(); const btn = $('#loginbtn'); btn.disabled = true;
  try { await Auth.signIn($('#le').value.trim(), $('#lp').value); await start(); } catch (ex) { $('#loginerror').textContent = ex.message; $('#loginerror').classList.remove('hidden'); } finally { btn.disabled = false; }
});
$('#signout').addEventListener('click', () => { Auth.signOut(); showLogin('You have signed out.'); });
(async () => { if (await Auth.init()) await start(); else showLogin(); })();
