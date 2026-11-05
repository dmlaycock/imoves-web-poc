// imoves CMS - staff content page v0.2 (5 Nov 2026)
//
// Design: project doc cms/design-v0.2.md. Rebuilt after David's review of v0.1: the page is
// designed from what teachers see, not from Quickbase's forms. One page per item (no tabs),
// contents first; rows open on click; a bin removes from a place (archiving when it was the
// last place); a green switch means teachers can see it, an amber dot means edits they cannot
// see yet; every list defaults to the order teachers see with hidden items last, with sort and
// filter controls; one rich-text body with the platform preview beside it; pickers instead of
// codes and ids; ages picked as EYFS / KS1 / KS2 / whole school or by year group.
//
// Talks to PostgREST on the "content" schema with the teacher site's own sign-in; staff rights
// come from the JWT's app_metadata.staff claim; anyone else can look but not change anything.
// Published copy: dmlaycock/imoves-web-poc at /staff/ (cms/site/build.js).

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = t => t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
let toastT;
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', err ? 5000 : 2200); }
const KIND = { subject: 'Subject', group: 'Group', category: 'Category', scheme: 'Scheme', lesson: 'Lesson', media_block: 'Block', variant: 'Variant', part: 'Part' };
const TABLE = { subject: 'subjects', group: 'groups', category: 'categories', scheme: 'schemes', lesson: 'lessons', media_block: 'media_blocks', variant: 'scheme_variants', part: 'lesson_parts' };
const ROUTE = { subject: 'subject', group: 'group', category: 'category', scheme: 'scheme', lesson: 'lesson', media_block: 'block' };
const href = (type, id) => `#/${ROUTE[type]}/${id}`;
const ICON = {
  drag: '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="3" cy="2" r="1.3"/><circle cx="9" cy="2" r="1.3"/><circle cx="3" cy="6" r="1.3"/><circle cx="9" cy="6" r="1.3"/><circle cx="3" cy="10" r="1.3"/><circle cx="9" cy="10" r="1.3"/></svg>',
  bin: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  restore: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>',
};
const AGES = [[4, 'Reception', '4-5'], [5, 'Year 1', '5-6'], [6, 'Year 2', '6-7'], [7, 'Year 3', '7-8'], [8, 'Year 4', '8-9'], [9, 'Year 5', '9-10'], [10, 'Year 6', '10-11']];
const QUICK = [['EYFS', 4, 5], ['KS1', 5, 7], ['KS2', 7, 11], ['Whole school', 4, 11]];
const ageLabel = (min, max) => min == null ? '' : (QUICK.find(q => q[1] === min && q[2] === max) || [])[0] || (max && max > min + 1 ? `Ages ${min}-${max}` : `Ages ${min}-${(max ?? min + 1)}`);
const COLOURS = ['733088', 'e4007c', 'f68b1f', '00a8e8', '2eb872', 'ffc20e', '6c4ab6', 'e63946', '1d3557', '00b4d8'];
const ICONS = [['', 'None'], ['bi-flag', '🚩'], ['bi-emoji-smile', '🙂'], ['bi-lightbulb', '💡'], ['bi-star', '⭐'], ['bi-info-circle', 'ℹ️'], ['bi-heart', '❤️'], ['bi-trophy', '🏆'], ['bi-book', '📖'], ['bi-music-note', '🎵']];

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
  const go = () => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let r = await go();
  if (r.status === 401 && Auth.token() && await Auth.refresh()) { headers.Authorization = `Bearer ${Auth.token()}`; r = await go(); }
  if (!r.ok) { let m = `${r.status}`; try { const j = await r.json(); m = j.message || j.hint || j.details || m; } catch (e) {} throw new Error(m); }
  if (raw || r.status === 204) return null;
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const get = path => api(path);
const getAll = async path => { const out = []; let from = 0; for (;;) { const rows = await api(`${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${from}`); out.push(...rows); if (rows.length < 1000) break; from += 1000; } return out; };
const patch = (table, id, body) => api(`${table}?id=eq.${id}`, { method: 'PATCH', body, prefer: 'return=representation' }).then(r => r && r[0]);
const insert = (table, body) => api(table, { method: 'POST', body, prefer: 'return=representation' }).then(r => r && r[0]);
const del = (table, q) => api(`${table}?${q}`, { method: 'DELETE', raw: true });
const rpc = (fn, args) => api(`rpc/${fn}`, { method: 'POST', body: args || {} });
const canEdit = () => Auth.isStaff();

// ---------- data: the tree ----------
const D = {};
const index = rows => Object.fromEntries(rows.map(r => [r.id, r]));
async function loadTree() {
  const [subjects, groups, categories, placements, waiting, ...pubs] = await Promise.all([
    getAll('subjects?select=id,name,sort,on_home,browsable,updated_at,archived&archived=eq.false&order=sort,name'),
    getAll('groups?select=id,name,updated_at,archived&archived=eq.false'),
    getAll('categories?select=id,name,subheading,image,updated_at,archived&archived=eq.false'),
    getAll('placements?select=id,parent_type,parent_id,child_type,child_id,sort,is_home,heading,subheading,variant_ids&parent_type=in.(subject,group,category)&order=sort'),
    get('waiting?select=item_type,id,changed_at&order=changed_at.desc&limit=500'),
    ...['subjects', 'groups', 'categories', 'schemes', 'lessons', 'media_blocks'].map(t => getAll(`${t}_pub?select=id`)),
  ]);
  Object.assign(D, { subjects, groups, categories, placements, waiting });
  D.subjectById = index(subjects); D.groupById = index(groups); D.catById = index(categories);
  D.pub = {}; ['subject', 'group', 'category', 'scheme', 'lesson', 'media_block'].forEach((t, i) => D.pub[t] = new Set(pubs[i].map(r => r.id)));
  D.waitSet = new Set(waiting.map(w => `${w.item_type}:${w.id}`));
  D.children = {};
  for (const p of placements) (D.children[`${p.parent_type}:${p.parent_id}`] ||= []).push(p);
  for (const k in D.children) D.children[k].sort((a, b) => a.sort - b.sort || a.id - b.id);
}
const kids = (type, id) => D.children[`${type}:${id}`] || [];
const isPub = (type, id) => !!(D.pub[type] && D.pub[type].has(id));
const isWaiting = (type, id) => D.waitSet.has(`${type}:${id}`);
const parentsOf = (type, id) => D.placements.filter(p => p.child_type === type && p.child_id === id);
async function reloadTree() { try { await loadTree(); renderTree(); updateWaitingCount(); } catch (e) {} }

// Every list defaults to the order teachers see, published first, hidden last; sort and filter
// are per list and remembered.
const PREF = { get: k => { try { return JSON.parse(localStorage.getItem('cms.pref.' + k) || 'null'); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem('cms.pref.' + k, JSON.stringify(v)); } catch (e) {} } };
function orderRows(rows, { sort = 'platform', filter = 'all', pubOf, nameOf, changedOf, sortOf }) {
  const out = rows.filter(r => filter === 'all' || (filter === 'pub') === pubOf(r));
  const by = { platform: (a, b) => (pubOf(b) - pubOf(a)) || (sortOf(a) - sortOf(b)) || String(nameOf(a)).localeCompare(String(nameOf(b))),
               name: (a, b) => String(nameOf(a)).localeCompare(String(nameOf(b))),
               changed: (a, b) => String(changedOf(b) || '').localeCompare(String(changedOf(a) || '')) };
  return out.sort(by[sort] || by.platform);
}
function listTools(key, onChange) {
  const p = PREF.get(key) || {};
  return { html: `<span class="tools"><select data-lsort="${key}"><option value="platform" ${!p.sort || p.sort === 'platform' ? 'selected' : ''}>Platform order</option><option value="name" ${p.sort === 'name' ? 'selected' : ''}>A to Z</option><option value="changed" ${p.sort === 'changed' ? 'selected' : ''}>Recently changed</option></select><select data-lfilter="${key}"><option value="all" ${!p.filter || p.filter === 'all' ? 'selected' : ''}>All</option><option value="pub" ${p.filter === 'pub' ? 'selected' : ''}>Published</option><option value="hid" ${p.filter === 'hid' ? 'selected' : ''}>Hidden</option></select></span>`,
    bind: root => root.querySelectorAll(`[data-lsort="${key}"],[data-lfilter="${key}"]`).forEach(s => s.addEventListener('change', () => { PREF.set(key, { sort: root.querySelector(`[data-lsort="${key}"]`).value, filter: root.querySelector(`[data-lfilter="${key}"]`).value }); onChange(); })),
    pref: p };
}

function renderTree() {
  const tree = $('#tree');
  const open = new Set(JSON.parse(sessionStorage.getItem('cms.open') || '[]'));
  const cur = location.hash;
  const pref = { sort: $('#treeSort').value, filter: $('#treeFilter').value };
  const subjects = orderRows(D.subjects, { ...pref, pubOf: s => isPub('subject', s.id), nameOf: s => s.name, changedOf: s => s.updated_at, sortOf: s => s.sort ?? 1e9 });
  const sub = pref.sort === 'changed' ? 'changed' : 'platform';
  const groupRows = sId => orderRows(kids('subject', sId).map(p => ({ p, g: D.groupById[p.child_id] })).filter(x => x.g), { sort: sub, pubOf: x => isPub('group', x.g.id), nameOf: x => x.g.name, changedOf: x => x.g.updated_at, sortOf: x => x.p.sort });
  const catRows = gId => orderRows(kids('group', gId).map(p => ({ p, c: D.catById[p.child_id] })).filter(x => x.c), { sort: sub, pubOf: x => isPub('category', x.c.id), nameOf: x => x.c.name, changedOf: x => x.c.updated_at, sortOf: x => x.p.sort });
  let h = '<div class="hint">Subjects</div>';
  let hiddenStarted = false;
  for (const s of subjects) {
    if (pref.sort === 'platform' && pref.filter === 'all' && !isPub('subject', s.id) && !hiddenStarted) { hiddenStarted = true; h += '<div class="hint">Hidden subjects</div>'; }
    const groups = groupRows(s.id);
    h += `<details class="subject" data-key="s${s.id}" ${open.has('s' + s.id) ? 'open' : ''}><summary>${ICON.chev}<a href="${href('subject', s.id)}" class="${isPub('subject', s.id) ? '' : 'off'} ${cur === href('subject', s.id) ? 'active' : ''}">${esc(s.name)}</a><span class="count">${groups.length}</span></summary>`;
    for (const { g } of groups) {
      const cats = catRows(g.id);
      h += `<details class="group" data-key="g${g.id}" ${open.has('g' + g.id) ? 'open' : ''}><summary>${ICON.chev}<a href="${href('group', g.id)}" class="${isPub('group', g.id) ? '' : 'off'} ${cur === href('group', g.id) ? 'active' : ''}">${esc(g.name)}</a><span class="count">${cats.length}</span></summary>`;
      for (const { c } of cats) h += `<div class="cat"><button class="${cur === href('category', c.id) ? 'active' : ''} ${isPub('category', c.id) ? '' : 'off'}" data-go="${href('category', c.id)}"><span class="n">${esc(c.name)}</span><span class="count">${kids('category', c.id).length}</span></button></div>`;
      h += '</details>';
    }
    h += '</details>';
  }
  h += `<a class="archl muted" href="#/archive">Archive</a>`;
  tree.innerHTML = h;
  tree.querySelectorAll('details').forEach(d => d.addEventListener('toggle', () => { const o = new Set(JSON.parse(sessionStorage.getItem('cms.open') || '[]')); d.open ? o.add(d.dataset.key) : o.delete(d.dataset.key); sessionStorage.setItem('cms.open', JSON.stringify([...o])); }));
  tree.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
}
$('#treeSort').addEventListener('change', renderTree); $('#treeFilter').addEventListener('change', renderTree);
function treeReveal(type, id) {
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
let PAGE = null;
// Each page load takes a ticket; a load that finds a newer ticket (the user clicked away) stops.
let NAV = 0;
const ticket = () => ++NAV; const stale = n => n !== NAV;
function markDirty(key, v) { PAGE.dirty[key] = v; PAGE.row[key] = v; const b = $('#saveBtn'); if (b) b.disabled = false; if (PAGE.onChange) PAGE.onChange(key); }
function field(key, label, { type = 'text', help = '', options, span = false, rows, placeholder = '' } = {}) {
  const v = PAGE.row[key];
  let input;
  if (type === 'textarea') input = `<textarea data-f="${key}" ${rows ? `rows="${rows}"` : ''} placeholder="${esc(placeholder)}">${esc(v)}</textarea>`;
  else if (type === 'switch') return `<label class="sw field-sw"><input type="checkbox" data-f="${key}" ${v ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
  else if (type === 'number') input = `<input type="number" data-f="${key}" value="${v ?? ''}" placeholder="${esc(placeholder)}">`;
  else if (type === 'chips') return `<div class="field ${span ? 'span' : ''}" data-field="${key}"><label>${esc(label)}</label><div class="chips">${options.map(o => `<label class="chip"><input type="checkbox" data-chip="${key}" value="${esc(o[0])}" ${(v || []).includes(o[0]) ? 'checked' : ''}> ${esc(o[1])}</label>`).join('')}</div>${help ? `<div class="help">${help}</div>` : ''}</div>`;
  else if (type === 'radio') return `<div class="field ${span ? 'span' : ''}" data-field="${key}"><label>${esc(label)}</label><div class="chips">${options.map(o => `<label class="chip"><input type="radio" name="r-${key}" data-radio="${key}" value="${esc(o[0])}" ${String(v ?? '') === String(o[0]) ? 'checked' : ''}> ${esc(o[1])}</label>`).join('')}</div>${help ? `<div class="help">${help}</div>` : ''}</div>`;
  else input = `<input type="${type === 'url' ? 'url' : 'text'}" data-f="${key}" value="${esc(v)}" placeholder="${esc(placeholder)}">`;
  return `<div class="field ${span ? 'span' : ''}" data-field="${key}"><label>${esc(label)}</label>${input}${help ? `<div class="help">${help}</div>` : ''}</div>`;
}
function bindFields(root) {
  root.querySelectorAll('[data-f]').forEach(el => el.addEventListener('input', () => {
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value === '' ? null : el.value);
    markDirty(el.dataset.f, v); el.closest('.field')?.classList.add('dirty');
  }));
  root.querySelectorAll('[data-chip]').forEach(el => el.addEventListener('change', () => {
    const key = el.dataset.chip; const vals = [...root.querySelectorAll(`[data-chip="${key}"]:checked`)].map(x => x.value);
    markDirty(key, vals); el.closest('.field')?.classList.add('dirty');
  }));
  root.querySelectorAll('[data-radio]').forEach(el => el.addEventListener('change', () => { markDirty(el.dataset.radio, el.value === '' ? null : el.value); el.closest('.field')?.classList.add('dirty'); }));
  if (!canEdit()) root.querySelectorAll('input,select,textarea,[contenteditable]').forEach(x => { x.disabled = true; x.removeAttribute('contenteditable'); });
}
async function save() {
  if (!PAGE || !PAGE.type || !Object.keys(PAGE.dirty).length) return true;
  try {
    const body = { ...PAGE.dirty };
    if ('extra_subject_ids' in body) body.extra_subject_ids = (body.extra_subject_ids || []).map(Number);
    const row = await patch(TABLE[PAGE.type], PAGE.id, body);
    PAGE.row = Object.assign(PAGE.row, row); PAGE.dirty = {};
    editor.querySelectorAll('.field.dirty').forEach(f => f.classList.remove('dirty'));
    const b = $('#saveBtn'); if (b) b.disabled = true;
    toast('Saved to draft');
    const t = { subject: D.subjectById, group: D.groupById, category: D.catById }[PAGE.type]; if (t && t[PAGE.id]) { t[PAGE.id].name = PAGE.row.name; renderTree(); }
    const pt = $('#pageTitle'); if (pt) pt.textContent = PAGE.row.name || PAGE.row.heading || '';
    await refreshStatus(); loadWaiting();
    return true;
  } catch (e) { toast(`Could not save: ${e.message}`, true); return false; }
}
async function refreshStatus() {
  if (!PAGE || !PAGE.type) return;
  try {
    const [s] = await rpc('item_status', { p_type: PAGE.type, p_id: PAGE.id });
    const sw = $('#pubSwitch'), meta = $('#pubMeta'), pc = $('#pubChanges');
    if (sw) { sw.querySelector('input').checked = s.is_published; sw.classList.toggle('waiting', s.waiting); sw.title = s.is_published ? 'Teachers can see this. Switch off to hide it.' : 'Hidden from teachers. Switch on to publish it.'; }
    if (meta) meta.innerHTML = s.last_published_at ? `v${s.last_version} · ${when(s.last_published_at)} · ${esc(s.last_published_by)} · <button id="histBtn">history</button>` : 'never published';
    if (pc) pc.hidden = !(s.is_published && s.waiting);
    const hb = $('#histBtn'); if (hb) hb.addEventListener('click', () => openHistory());
    if (D.pub[PAGE.type]) { s.is_published ? D.pub[PAGE.type].add(PAGE.id) : D.pub[PAGE.type].delete(PAGE.id); }
    s.waiting ? D.waitSet.add(`${PAGE.type}:${PAGE.id}`) : D.waitSet.delete(`${PAGE.type}:${PAGE.id}`);
  } catch (e) { /* status is decoration */ }
}
async function publish(type, id, withChildren, name) {
  if (PAGE && PAGE.type === type && PAGE.id === id && !(await save())) return false;
  try { const v = await rpc('publish', { p_type: type, p_id: id, p_with_children: !!withChildren }); toast(`${name || KIND[type]} published (v${v})`); return true; }
  catch (e) { toast(`Could not publish: ${e.message}`, true); return false; }
}
async function unpublish(type, id, name) {
  if (!confirm(`Hide "${name}" from teachers? The draft is kept and you can publish it again.`)) return false;
  try { await rpc('unpublish', { p_type: type, p_id: id }); toast('Hidden from teachers'); return true; } catch (e) { toast(`Could not unpublish: ${e.message}`, true); return false; }
}
// Publish switch for a row or a header: on = publish (asking about children for containers), off = unpublish.
async function onSwitch(input, type, id, name, hasChildren, after) {
  const want = input.checked; input.checked = !want;
  let ok;
  if (want) { const kidsToo = hasChildren && confirm(`Publish "${name}" with everything under it? Cancel publishes just this ${KIND[type].toLowerCase()}.`); ok = await publish(type, id, kidsToo, name); }
  else ok = await unpublish(type, id, name);
  if (ok) { input.checked = want; await reloadTree(); if (after) after(); }
}
function pageHeader(crumbs, { subtitle = '' } = {}) {
  const hasChildren = ['subject', 'group', 'category', 'scheme'].includes(PAGE.type);
  return `<div class="crumbs">${crumbs.map((c, i) => (i ? '<span class="sep">›</span>' : '') + (c.href ? `<button data-go="${c.href}">${esc(c.name)}</button>` : `<span>${esc(c.name)}</span>`)).join('')}</div>
    <div class="edhead"><h1><span id="pageTitle">${esc(PAGE.row.name || PAGE.row.heading || '')}</span><span class="id">${KIND[PAGE.type]} ${PAGE.id}${subtitle ? ' · ' + esc(subtitle) : ''}</span></h1>
      <span class="meta" id="pubMeta"></span>
      <div class="actions">${canEdit() ? `<button class="btn" id="saveBtn" disabled>Save draft</button><button class="btn primary" id="pubChanges" hidden title="Teachers see the last published version; this publishes your changes">Publish changes</button>` : ''}
        <label class="sw" id="pubSwitch"><input type="checkbox" ${canEdit() ? '' : 'disabled'} data-children="${hasChildren ? 1 : 0}"> <span class="small">Teachers can see</span></label></div></div>`;
}
function bindHeader(root) {
  root.querySelectorAll('.crumbs [data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  const s = $('#saveBtn'); if (s) s.addEventListener('click', save);
  const pc = $('#pubChanges'); if (pc) pc.addEventListener('click', async () => { if (await publish(PAGE.type, PAGE.id, false, PAGE.row.name || PAGE.row.heading)) { await reloadTree(); refreshStatus(); loadWaiting(); } });
  const sw = $('#pubSwitch'); if (sw) sw.querySelector('input').addEventListener('change', e => onSwitch(e.target, PAGE.type, PAGE.id, PAGE.row.name || PAGE.row.heading, e.target.dataset.children === '1', () => { refreshStatus(); loadWaiting(); }));
}
const panel = (title, inner, { tools = '', id = '' } = {}) => `<div class="panel" ${id ? `id="${id}"` : ''}>${title || tools ? `<h3>${title}${tools}</h3>` : ''}<div class="body">${inner}</div></div>`;

// ---------- rich text body ----------
// Teachers see one piece of text with headings in it, so staff edit one piece of text with
// headings in it. Stored as a small HTML subset: p, h5, strong, em, br, ul, li.
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html'); const root = doc.body.firstChild;
  const ALLOW = { P: 'p', H5: 'h5', H1: 'h5', H2: 'h5', H3: 'h5', H4: 'h5', H6: 'h5', STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', BR: 'br', UL: 'ul', OL: 'ul', LI: 'li', DIV: 'p' };
  const walk = node => {
    let out = '';
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) { out += esc(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      if (c.tagName === 'I' && /\bbi-/.test(c.className)) { out += `<i class="${esc(c.className.split(/\s+/).filter(x => /^bi(-|$)/.test(x)).join(' '))}"></i>`; continue; }
      const tag = ALLOW[c.tagName];
      if (!tag) { out += walk(c); continue; }
      if (tag === 'br') { out += '<br>'; continue; }
      const inner = walk(c);
      if (!inner.trim() && tag !== 'li') continue;
      out += `<${tag}>${inner}</${tag}>`;
    }
    return out;
  };
  return walk(root).replace(/<p>(\s|<br>)*<\/p>/g, '').trim() || null;
}
const RTE_BAR = '<div class="bar"><button type="button" data-cmd="formatBlock" data-arg="h5" title="Heading">Heading</button><button type="button" data-cmd="formatBlock" data-arg="p" title="Paragraph">Text</button><span class="sep"></span><button type="button" data-cmd="bold" title="Bold"><b>B</b></button><button type="button" data-cmd="italic" title="Italic"><i>I</i></button><button type="button" data-cmd="insertUnorderedList" title="Bullet list">• List</button><span class="sep"></span><button type="button" data-cmd="removeFormat" title="Clear formatting">Clear</button></div>';
function rteHtml(attr, value, placeholder) { return `<div class="rte" ${attr}>${RTE_BAR}<div class="ed" contenteditable="${canEdit()}" data-placeholder="${esc(placeholder)}">${value || ''}</div></div>`; }
function wireRte(box, onChange) {
  const ed = box.querySelector('.ed');
  const sync = debounce(() => onChange(sanitize(ed.innerHTML)), 200);
  ed.addEventListener('input', sync);
  ed.addEventListener('paste', e => { e.preventDefault(); const html = e.clipboardData.getData('text/html'); const text = e.clipboardData.getData('text/plain'); document.execCommand('insertHTML', false, html ? (sanitize(html) || '') : esc(text).replace(/\n/g, '<br>')); });
  const refreshBar = () => box.querySelectorAll('[data-cmd]').forEach(b => { try { const on = b.dataset.cmd === 'formatBlock' ? document.queryCommandValue('formatBlock').toLowerCase() === b.dataset.arg : document.queryCommandState(b.dataset.cmd); b.classList.toggle('on', !!on); } catch (e) {} });
  box.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('mousedown', e => { e.preventDefault(); ed.focus(); document.execCommand(b.dataset.cmd, false, b.dataset.arg || null); sync(); refreshBar(); }));
  document.addEventListener('selectionchange', () => { if (box.contains(document.activeElement)) refreshBar(); });
  ed.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { try { if (document.queryCommandValue('formatBlock').toLowerCase() === 'h5') setTimeout(() => document.execCommand('formatBlock', false, 'p'), 0); } catch (x) {} } });
}
function bindRte(root) { root.querySelectorAll('[data-rte]').forEach(box => wireRte(box, v => { if ((v || null) !== (PAGE.row[box.dataset.rte] || null)) markDirty(box.dataset.rte, v); })); }
function textPanel({ withDescription = true } = {}) {
  return panel('Page text', `<div class="textwork"><div>${withDescription ? field('description', 'Short description', { type: 'textarea', rows: 2, help: 'On the card and in search results. Below is the page itself.' }) : ''}<div class="field" style="margin-top:10px"><label>Page text</label>${rteHtml('data-rte="body"', PAGE.row.body, 'Write the text teachers see. Use Heading for section titles.')}</div></div><div class="preview" id="preview"></div></div>`);
}
function renderPreview() {
  const pv = $('#preview'); if (!pv) return;
  const r = PAGE.row;
  let h = `<div class="pvlabel"><span>How teachers see it</span><span>live preview</span></div>`;
  if (r.image) h += `<img class="pvimg" src="${esc(r.image)}" alt="">`;
  h += `<div class="pvtitle">${esc(r.name)}</div>${r.subheading || r.heading_2 ? `<div class="pvsub">${esc(r.subheading || r.heading_2)}</div>` : ''}`;
  if (r.description && r.description.trim()) h += `<p>${esc(r.description).replace(/\n/g, '<br>')}</p>`;
  h += r.body || (!r.description ? '<div class="pvempty">No page text yet.</div>' : '');
  pv.innerHTML = h;
}

// ---------- pickers ----------
function agePicker(minKey = 'age_min', maxKey = 'age_max') {
  const min = PAGE.row[minKey], max = PAGE.row[maxKey];
  const on = a => min != null && a >= min && a < (max ?? min + 1);
  return `<div class="field span agepick" data-agepick="${minKey}|${maxKey}"><label>Ages</label><div class="quick">${QUICK.map(q => `<button type="button" class="chip ${min === q[1] && max === q[2] ? 'on' : ''}" data-q="${q[1]}|${q[2]}">${q[0]}</button>`).join('')}<button type="button" class="chip ${min == null ? 'on' : ''}" data-q="|">Not set</button></div><div class="years">${AGES.map(a => `<label><input type="checkbox" value="${a[0]}" ${on(a[0]) ? 'checked' : ''}>${a[1]}<small>${a[2]}</small></label>`).join('')}</div></div>`;
}
function bindAgePickers(root) {
  root.querySelectorAll('[data-agepick]').forEach(box => {
    const [minKey, maxKey] = box.dataset.agepick.split('|');
    const apply = (min, max) => { markDirty(minKey, min); markDirty(maxKey, max); box.querySelectorAll('.years input').forEach(i => i.checked = min != null && +i.value >= min && +i.value < max); box.querySelectorAll('[data-q]').forEach(b => { const [a, z] = b.dataset.q.split('|'); b.classList.toggle('on', (a === '' && min == null) || (+a === min && +z === max)); }); };
    box.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { const [a, z] = b.dataset.q.split('|'); apply(a === '' ? null : +a, z === '' ? null : +z); }));
    box.querySelectorAll('.years input').forEach(i => i.addEventListener('change', () => {
      const ticked = [...box.querySelectorAll('.years input:checked')].map(x => +x.value).sort((a, b) => a - b);
      if (!ticked.length) return apply(null, null);
      apply(ticked[0], ticked[ticked.length - 1] + 1);   // the platform stores one range
    }));
  });
}
function colourPicker(key) {
  const v = (PAGE.row[key] || '').replace('#', '').toLowerCase();
  return `<div class="field" data-field="${key}"><label>Button colour</label><div class="colour" data-colour="${key}">${COLOURS.map(c => `<button type="button" style="background:#${c}" class="${v === c ? 'on' : ''}" data-c="${c}" title="#${c}"></button>`).join('')}<input type="color" value="#${/^[0-9a-f]{6}$/.test(v) ? v : '733088'}" title="Any colour"></div></div>`;
}
function bindColour(root) {
  root.querySelectorAll('[data-colour]').forEach(box => {
    const key = box.dataset.colour;
    const set = c => { markDirty(key, c); box.querySelectorAll('[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === c)); };
    box.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => set(b.dataset.c)));
    box.querySelector('input[type=color]').addEventListener('input', e => set(e.target.value.replace('#', '')));
  });
}
function iconPicker(key) {
  const v = PAGE.row[key] || '';
  return `<div class="field" data-field="${key}"><label>Icon (beside the subject name in search results)</label><div class="iconpick" data-iconpick="${key}">${ICONS.map(i => `<button type="button" class="${v === i[0] ? 'on' : ''}" data-i="${i[0]}" title="${i[0] || 'None'}">${i[1]}</button>`).join('')}</div></div>`;
}
function bindIcon(root) { root.querySelectorAll('[data-iconpick]').forEach(box => box.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => { markDirty(box.dataset.iconpick, b.dataset.i || null); box.querySelectorAll('[data-i]').forEach(x => x.classList.toggle('on', x === b)); }))); }
function imageField(key, label, { tile = false } = {}) {
  const v = PAGE.row[key];
  const pv = v ? `<img class="pv" src="${esc(v)}" alt="">` : tile ? `<div class="tile">${esc(PAGE.row.name || '')}</div>` : '<div class="pv"></div>';
  return `<div class="field span" data-field="${key}"><label>${esc(label)}</label><div class="imgfield" data-imgfield="${key}" data-tile="${tile ? 1 : 0}">${pv}<div class="f"><input type="url" data-f="${key}" value="${esc(v)}" placeholder="https://…"><div class="help">${tile ? 'Leave blank and the platform draws a tile from the name (no more hand-made word tiles). ' : ''}Image upload arrives with the media library; for now paste an image address.</div></div></div></div>`;
}
function bindImageFields(root) {
  root.querySelectorAll('[data-imgfield]').forEach(box => {
    const key = box.dataset.imgfield;
    const redraw = () => { const v = PAGE.row[key]; box.firstElementChild.outerHTML = v ? `<img class="pv" src="${esc(v)}" alt="">` : (box.dataset.tile === '1' ? `<div class="tile">${esc(PAGE.row.name || '')}</div>` : '<div class="pv"></div>'); };
    box.querySelector('input').addEventListener('input', debounce(redraw, 300));
    if (box.dataset.tile === '1') { const n = root.querySelector('[data-f="name"]'); if (n) n.addEventListener('input', debounce(redraw, 300)); }
  });
}
async function subjectChips(key, derivedIds) {
  const subs = await get('subject_names?select=id,name&archived=eq.false&order=name');
  const extras = (PAGE.row[key] || []).map(String);
  return `<div class="field span" data-field="${key}"><label>Subjects</label><div class="chips">${subs.filter(s => derivedIds.has(s.id)).map(s => `<span class="chip" style="opacity:.65;cursor:default" title="From where it is placed">${esc(s.name)}</span>`).join('')}${subs.filter(s => !derivedIds.has(s.id)).map(s => `<label class="chip"><input type="checkbox" data-chip="${key}" value="${s.id}" ${extras.includes(String(s.id)) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div><div class="help">Grey chips come from where this is placed. Tick extra subjects to list it under them too (search and favourites group by subject).</div></div>`;
}

// ---------- contents lists (placements) ----------
const CHILD_TYPES = { subject: ['group'], group: ['category'], category: ['scheme', 'lesson', 'media_block', 'category', 'subject'], variant: ['lesson'] };
async function childRows(parentType, parentId) {
  const ps = parentType === 'variant' ? await get(`placements?parent_type=eq.variant&parent_id=eq.${parentId}&select=*&order=sort`) : kids(parentType, parentId);
  const byType = {};
  for (const p of ps) (byType[p.child_type] ||= []).push(p.child_id);
  const rows = {};
  await Promise.all(Object.entries(byType).map(async ([t, ids]) => {
    const sel = { media_block: 'id,heading,kind,text,updated_at', scheme: 'id,name,subheading,image,updated_at', category: 'id,name,subheading,image,updated_at', lesson: 'id,name,description,age_min,age_max,updated_at', group: 'id,name,description,updated_at', subject: 'id,name,updated_at' }[t];
    const r = await getAll(`${TABLE[t]}?id=in.(${ids.join(',')})&select=${sel}`);
    rows[t] = index(r);
  }));
  return ps.map(p => ({ p, item: (rows[p.child_type] || {})[p.child_id] })).filter(x => x.item);
}
async function contentsPanel(parentType, parentId, { title = 'Contents', note = '', key } = {}) {
  key = key || `${parentType}:${parentId}`;
  const list = await childRows(parentType, parentId);
  const tools = listTools(`list.${parentType}`, () => PAGE.reload && PAGE.reload());
  const pref = tools.pref;
  const ordered = orderRows(list, { sort: pref.sort, filter: pref.filter, pubOf: x => x.p.child_type === 'subject' ? true : isPub(x.p.child_type, x.p.child_id), nameOf: x => x.p.heading || x.item.name || x.item.heading || '', changedOf: x => x.item.updated_at, sortOf: x => x.p.sort });
  const sortable = (pref.sort || 'platform') === 'platform' && (pref.filter || 'all') === 'all' && canEdit();
  const row = ({ p, item }) => {
    const name = p.heading || item.name || item.heading || item.kind;
    const sub = p.subheading || item.subheading || item.description || (item.kind ? `${item.kind} block` : '');
    const t = p.child_type; const pub = t === 'subject' ? true : isPub(t, p.child_id); const waiting = isWaiting(t, p.child_id);
    const hasChildren = ['subject', 'group', 'category', 'scheme'].includes(t);
    return `<div class="row ${pub ? '' : 'off'}" data-pid="${p.id}" data-ct="${t}" data-cid="${p.child_id}" data-name="${esc(name)}" data-children="${hasChildren ? 1 : 0}" ${t === 'subject' ? '' : `data-go="${href(t, p.child_id)}"`}>${sortable ? `<span class="handle" title="Drag to reorder">${ICON.drag}</span>` : '<span class="handle" style="cursor:default"></span>'}
      ${item.image ? `<img class="thumb" src="${esc(item.image)}" alt="">` : ''}<span class="kind ${t}">${KIND[t]}</span>
      <div class="title"><div class="name">${esc(name)}${p.heading ? ' <span class="muted small">(renamed here)</span>' : ''}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
      ${t === 'lesson' && item.age_min != null ? `<span class="ages">${esc(ageLabel(item.age_min, item.age_max))}</span>` : ''}${p.variant_ids ? '<span class="pill new" title="Only some age variants show here">some ages</span>' : ''}
      <div class="rt">${t === 'subject' ? '' : `<label class="sw row-sw ${waiting ? 'waiting' : ''}" title="${pub ? 'Teachers can see this' : 'Hidden from teachers'}"><input type="checkbox" data-pubsw ${pub ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}></label>`}${canEdit() ? `<button class="btn icon danger" data-unplace="${p.id}" title="Remove from here">${ICON.bin}</button>` : ''}</div></div>`;
  };
  const menuId = `addMenu-${key.replace(':', '-')}`;
  const addMenu = canEdit() ? `<div class="inline-add"><div class="menu" id="${menuId}"><button class="btn" data-addbtn>${ICON.plus} Add</button><div class="items">${CHILD_TYPES[parentType].filter(t => t !== 'subject').map(t => `<button data-add-new="${t}">New ${KIND[t].toLowerCase()}</button>`).join('')}<hr>${CHILD_TYPES[parentType].map(t => `<button data-add-existing="${t}">Existing ${KIND[t].toLowerCase()}…</button>`).join('')}</div></div><span class="muted small">${note}</span></div>` : '';
  return { html: panel(title ? `${esc(title)} <span class="muted">${list.length}</span>` : '', `<div class="rows" data-plist="${key}">${ordered.map(row).join('') || '<div class="empty">Nothing here yet.</div>'}</div>${addMenu}`, { tools: tools.html }), bind: root => { tools.bind(root); bindContents(root, parentType, parentId, key, menuId); } };
}
function bindContents(root, parentType, parentId, key, menuId) {
  const list = root.querySelector(`[data-plist="${key}"]`); if (!list) return;
  list.querySelectorAll('.row[data-go]').forEach(r => r.addEventListener('click', e => { if (e.target.closest('.handle, .rt, input, label, button')) return; location.hash = r.dataset.go; }));
  list.querySelectorAll('[data-pubsw]').forEach(i => i.addEventListener('change', e => { const r = e.target.closest('.row'); onSwitch(e.target, r.dataset.ct, +r.dataset.cid, r.dataset.name, r.dataset.children === '1', () => PAGE.reload && PAGE.reload()); }));
  if (canEdit()) {
    if (list.querySelector('.handle svg')) new Sortable(list, { handle: '.handle', animation: 150, onEnd: async () => {
      const ids = [...list.querySelectorAll('.row')].map(r => +r.dataset.pid);
      try { await Promise.all(ids.map((pid, i) => patch('placements', pid, { sort: i + 1 }))); toast('Order saved'); await reloadTree(); refreshStatus(); } catch (e) { toast(e.message, true); }
    } });
    list.querySelectorAll('[data-unplace]').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation(); const r = b.closest('.row');
      const others = r.dataset.ct === 'subject' ? 1 : (r.dataset.ct === 'lesson' ? (await get(`placements?child_type=eq.lesson&child_id=eq.${r.dataset.cid}&select=id`)).length : parentsOf(r.dataset.ct, +r.dataset.cid).length);
      const last = r.dataset.ct !== 'subject' && others <= 1;
      if (!confirm(last ? `"${r.dataset.name}" appears nowhere else, so it will go to the Archive (you can restore it from there). Remove?` : `Remove "${r.dataset.name}" from here? It stays everywhere else it appears.`)) return;
      try { const res = await rpc('unplace', { p_placement_id: +b.dataset.unplace }); toast(res === 'archived' ? 'Moved to the Archive' : 'Removed'); await reloadTree(); if (PAGE.reload) PAGE.reload(); } catch (err) { toast(err.message, true); }
    }));
  }
  const menu = root.querySelector(`#${menuId}`);
  if (menu) {
    menu.querySelector('[data-addbtn]').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.querySelectorAll('[data-add-existing]').forEach(b => b.addEventListener('click', () => pickExisting(b.dataset.addExisting, parentType, parentId)));
    menu.querySelectorAll('[data-add-new]').forEach(b => b.addEventListener('click', () => createNew(b.dataset.addNew, parentType, parentId)));
  }
}
async function place(parentType, parentId, childType, childId) {
  const existing = parentType === 'variant' ? await get(`placements?parent_type=eq.variant&parent_id=eq.${parentId}&select=sort`) : kids(parentType, parentId);
  const sort = existing.reduce((m, p) => Math.max(m, p.sort || 0), 0) + 1;
  const isHome = childType !== 'subject' && (childType === 'lesson' ? (await get(`placements?child_type=eq.lesson&child_id=eq.${childId}&select=id`)).length === 0 : parentsOf(childType, childId).length === 0);
  return insert('placements', { parent_type: parentType, parent_id: parentId, child_type: childType, child_id: childId, sort, is_home: isHome });
}
function modal(html) { const m = $('#modal'); m.innerHTML = html; m.classList.add('open'); m.onclick = e => { if (e.target === m) closeModal(); }; return m; }
function closeModal() { $('#modal').classList.remove('open'); $('#modal').innerHTML = ''; }
function pickerModal(title, type, onPick, already = new Set()) {
  const m = modal(`<div class="box"><div class="mhead"><h2>${esc(title)}</h2><button class="btn quiet sm" data-close>Close</button></div><div class="mtools"><input id="pickq" type="search" placeholder="Type a name or id"></div><div class="mbody" id="pickres"><div class="empty">Start typing to search.</div></div><div class="mfoot"></div></div>`);
  m.querySelector('[data-close]').addEventListener('click', closeModal);
  const run = debounce(async () => {
    const q = m.querySelector('#pickq').value.trim(); if (q.length < 2) return;
    const rows = await rpc('search', { p_q: q, p_limit: 40, p_type: type });
    m.querySelector('#pickres').innerHTML = rows.length ? rows.map(r => `<button class="pick" data-id="${r.id}" ${already.has(r.id) ? 'disabled' : ''}><div class="meta"><b>${esc(r.name)}</b><span>${esc(r.detail || '')} · id ${r.id}${already.has(r.id) ? ' · already here' : ''}</span></div></button>`).join('') : '<div class="empty">Nothing found.</div>';
    m.querySelectorAll('.pick').forEach(b => b.addEventListener('click', () => { closeModal(); onPick(+b.dataset.id); }));
  }, 220);
  m.querySelector('#pickq').addEventListener('input', run);
  setTimeout(() => m.querySelector('#pickq').focus(), 50);
}
async function pickExisting(childType, parentType, parentId) {
  const have = parentType === 'variant' ? await get(`placements?parent_type=eq.variant&parent_id=eq.${parentId}&select=child_type,child_id`) : kids(parentType, parentId);
  pickerModal(`Add an existing ${KIND[childType].toLowerCase()}`, childType, async id => {
    try { await place(parentType, parentId, childType, id); toast('Added'); await reloadTree(); if (PAGE.reload) PAGE.reload(); } catch (e) { toast(e.message, true); }
  }, new Set(have.filter(p => p.child_type === childType).map(p => p.child_id)));
}
function askName(title, cb) {
  const m = modal(`<div class="box narrow"><div class="mhead"><h2>${esc(title)}</h2></div><div class="mbody" style="padding:16px 18px"><div class="field"><label>Name</label><input type="text" id="newName"></div></div><div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="newOk">Create</button></div></div>`);
  m.querySelector('[data-close]').addEventListener('click', closeModal);
  const ok = () => { const v = m.querySelector('#newName').value.trim(); if (!v) return; closeModal(); cb(v); };
  m.querySelector('#newOk').addEventListener('click', ok); m.querySelector('#newName').addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  setTimeout(() => m.querySelector('#newName').focus(), 50);
}
function createNew(childType, parentType, parentId) {
  askName(`New ${KIND[childType].toLowerCase()}`, async name => {
    try {
      let row;
      if (childType === 'media_block') row = await insert('media_blocks', { kind: 'video', heading: name });
      else if (childType === 'scheme') { row = await insert('schemes', { name }); await insert('scheme_variants', { scheme_id: row.id, sort: 1, age_min: 4, age_max: 11 }); }
      else row = await insert(TABLE[childType], { name });
      await place(parentType, parentId, childType, row.id);
      toast('Created'); await reloadTree();
      location.hash = href(childType, row.id);
    } catch (e) { toast(e.message, true); }
  });
}
async function wherePanel(type, id) {
  const ps = type === 'lesson' ? await get(`placements?child_type=eq.lesson&child_id=eq.${id}&select=*`) : parentsOf(type, id);
  const names = await Promise.all(ps.map(async p => {
    if (p.parent_type === 'variant') { const [v] = await get(`scheme_variants?id=eq.${p.parent_id}&select=id,scheme_id,age_min,age_max,schemes(name)`); return v ? { href: href('scheme', v.scheme_id), name: v.schemes.name, sub: ageLabel(v.age_min, v.age_max), kind: 'scheme', p } : null; }
    const t = p.parent_type; const item = t === 'subject' ? D.subjectById[p.parent_id] : t === 'group' ? D.groupById[p.parent_id] : D.catById[p.parent_id];
    return item ? { href: href(t, p.parent_id), name: item.name, kind: t, p } : null;
  }));
  const html = panel('Where it appears', `<div class="place">${names.filter(Boolean).map(n => `<div class="item ${n.p.is_home ? 'home' : ''}" data-go="${n.href}"><span class="kind ${n.kind}">${KIND[n.kind]}</span><div class="path"><b>${esc(n.name)}</b><span>${n.sub ? esc(n.sub) + ' · ' : ''}position ${n.p.sort}${n.p.is_home ? ' · home' : ''}${n.p.variant_ids ? ' · some ages only' : ''}</span></div></div>`).join('') || '<div class="empty">Not placed anywhere. Add it to a category or scheme from that page.</div>'}</div>`);
  return { html, bind: root => root.querySelectorAll('.place [data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go)) };
}
async function visibilityPanel(type, id) {
  const rows = await get(`visibility?item_type=eq.${type}&item_id=eq.${id}&select=audience`);
  const have = new Set(rows.map(r => r.audience));
  const opts = [['all', 'Everyone'], ['paying', 'Paying subscribers'], ['trial', 'On a trial'], ['free', 'Free accounts']];
  return { html: panel('Who can see it', `<div class="chips">${opts.map(o => `<label class="chip"><input type="checkbox" data-vis="${o[0]}" ${have.has(o[0]) ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}> ${o[1]}</label>`).join('')}</div><div class="help">Saves straight away; teachers see the change on the next publish. Per-package views (paid, trial, after-trial) arrive with the Packages work.</div>`),
    bind: root => root.querySelectorAll('[data-vis]').forEach(cb => cb.addEventListener('change', async () => {
      try { if (cb.checked) await insert('visibility', { item_type: type, item_id: id, audience: cb.dataset.vis }); else await del('visibility', `item_type=eq.${type}&item_id=eq.${id}&audience=eq.${cb.dataset.vis}`); toast('Saved'); refreshStatus(); }
      catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
    })) };
}

// ---------- history drawer ----------
async function openHistory() {
  const d = $('#drawer'); $('#drawerTitle').textContent = `History: ${PAGE.row.name || PAGE.row.heading || ''}`; d.classList.add('open');
  const box = $('#drawerItems'); box.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const [versions, changes] = await Promise.all([
      get(`versions?item_type=eq.${PAGE.type}&item_id=eq.${PAGE.id}&select=version,published_by,published_at,note&order=version.desc`),
      get(`changes?item_type=eq.${PAGE.type}&item_id=eq.${PAGE.id}&select=at,actor,action,before,after&order=at.desc&limit=40`),
    ]);
    const diff = c => { if (c.action !== 'update' || !c.before || !c.after) return ''; const keys = Object.keys(c.after).filter(k => JSON.stringify(c.after[k]) !== JSON.stringify(c.before[k]) && k !== 'updated_at'); return keys.length ? `<div class="diff">${keys.map(k => `<div><span class="k">${esc(k)}</span><span class="o">${esc(String(c.before[k] ?? '')).slice(0, 60)}</span><span class="n">${esc(String(c.after[k] ?? '')).slice(0, 60)}</span></div>`).join('')}</div>` : ''; };
    box.innerHTML = `<h3 style="font-size:13px;margin:8px 0">Published versions</h3><div class="history">${versions.length ? versions.map(v => `<div class="v"><span class="n">v${v.version}</span><span class="who">${esc(v.published_by)}${v.note ? ` <span class="muted">${esc(v.note)}</span>` : ''}</span><span class="when">${when(v.published_at)}</span>${canEdit() && v.version !== versions[0].version ? `<button class="btn sm" data-rb="${v.version}">Restore</button>` : ''}</div>`).join('') : '<div class="muted">Never published.</div>'}</div>
      <h3 style="font-size:13px;margin:18px 0 8px">Changes</h3>${changes.length ? changes.map(c => `<div class="change"><div class="top"><b>${esc(c.action)}</b><span>${esc(c.actor)}</span><span class="when">${when(c.at)}</span></div>${diff(c)}</div>`).join('') : '<div class="muted">No changes recorded.</div>'}`;
    box.querySelectorAll('[data-rb]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Restore version ${b.dataset.rb} and publish it? The current draft is replaced.`)) return;
      try { await rpc('rollback', { p_type: PAGE.type, p_id: PAGE.id, p_version: +b.dataset.rb }); toast('Restored and published'); d.classList.remove('open'); route(); } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}

// ---------- pages ----------
function notFound() { editor.innerHTML = '<div class="empty" style="padding-top:120px">Not found.</div>'; }
function finish(binds) { bindHeader(editor); bindFields(editor); bindRte(editor); bindAgePickers(editor); bindColour(editor); bindIcon(editor); bindImageFields(editor); binds.forEach(b => b && b.bind && b.bind(editor)); renderPreview(); if (!PAGE.onChange) PAGE.onChange = () => renderPreview(); refreshStatus(); }

// Subjects overview: the platform's subject order, drag to reorder, switches.
async function pageSubjects() {
  const nav = ticket();
  PAGE = { type: null, dirty: {}, reload: pageSubjects };
  const subs = orderRows(D.subjects, { pubOf: s => isPub('subject', s.id), nameOf: s => s.name, sortOf: s => s.sort ?? 1e9, changedOf: s => s.updated_at });
  if (stale(nav)) return;
  editor.innerHTML = `<div class="crumbs"><span>Subjects</span></div><div class="edhead"><h1>Subjects</h1><span class="meta">${subs.filter(s => isPub('subject', s.id)).length} published of ${subs.length}</span></div>` +
    panel('In the order teachers see them', `<div class="rows subjects-page" id="subjList">${subs.map(s => `<div class="row ${isPub('subject', s.id) ? '' : 'off'}" data-id="${s.id}" data-name="${esc(s.name)}" data-go="${href('subject', s.id)}">${canEdit() ? `<span class="handle">${ICON.drag}</span>` : '<span class="handle"></span>'}<div class="title"><div class="name">${esc(s.name)}</div><div class="sub">${kids('subject', s.id).length} groups${s.on_home ? ' · on the home page' : ''}${s.browsable ? ' · in Browse' : ''}</div></div><div class="rt"><label class="sw row-sw ${isWaiting('subject', s.id) ? 'waiting' : ''}"><input type="checkbox" data-pubsw ${isPub('subject', s.id) ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}></label></div></div>`).join('')}</div>${canEdit() ? `<div class="inline-add"><button class="btn" id="newSubject">${ICON.plus} New subject</button><span class="muted small">Drag to change the order of the subject bar and Browse. Hidden subjects sit at the bottom.</span></div>` : ''}`);
  const list = $('#subjList');
  list.querySelectorAll('.row').forEach(r => r.addEventListener('click', e => { if (e.target.closest('.handle, .rt, input, label')) return; location.hash = r.dataset.go; }));
  list.querySelectorAll('[data-pubsw]').forEach(i => i.addEventListener('change', e => { const r = e.target.closest('.row'); onSwitch(e.target, 'subject', +r.dataset.id, r.dataset.name, true, pageSubjects); }));
  if (canEdit()) {
    new Sortable(list, { handle: '.handle', animation: 150, onEnd: async () => { const ids = [...list.querySelectorAll('.row')].map(r => +r.dataset.id); try { await Promise.all(ids.map((id, i) => patch('subjects', id, { sort: i + 1 }))); toast('Order saved'); await reloadTree(); } catch (e) { toast(e.message, true); } } });
    $('#newSubject').addEventListener('click', () => askName('New subject', async name => { try { const row = await insert('subjects', { name, sort: D.subjects.length + 1 }); await reloadTree(); location.hash = href('subject', row.id); } catch (e) { toast(e.message, true); } }));
  }
}
async function pageSubject(id) {
  const nav = ticket();
  const [row] = await get(`subjects?id=eq.${id}&select=*`); if (stale(nav)) return; if (!row) return notFound();
  PAGE = { type: 'subject', id, row, dirty: {}, reload: () => pageSubject(id) };
  const [groups, vis] = await Promise.all([contentsPanel('subject', id, { title: 'Groups', note: 'The groups on the subject page, in this order.' }), visibilityPanel('subject', id)]);
  const fv = row.featured_video || {}; const hasKs = !!(fv.ks1 && fv.ks2 && JSON.stringify(fv.ks1) !== JSON.stringify(fv.ks2)); const hasFree = !!fv.free;
  const vslot = (k, label) => { const v = fv[k] || {}; return `<div class="grid" data-vslot="${k}"><div class="field"><label>${esc(label)}: video (Stream UID)</label><input type="text" data-fv="${k}.stream_uid" value="${esc(v.stream_uid)}" placeholder="Until the media library: paste the Stream UID"></div><div class="field"><label>Heading</label><input type="text" data-fv="${k}.heading" value="${esc(v.heading)}"></div><div class="field"><label>Subheading</label><input type="text" data-fv="${k}.subheading" value="${esc(v.subheading)}"></div><div class="field span"><label>Description</label><textarea data-fv="${k}.description" rows="2">${esc(v.description)}</textarea></div></div>`; };
  if (stale(nav)) return;
  editor.innerHTML = pageHeader([{ name: 'Subjects', href: '#/' }, { name: row.name }]) + groups.html +
    panel('Details', `<div class="grid">${field('name', 'Name')}${colourPicker('button_colour')}${iconPicker('icon')}<div class="span">${field('description', 'Description (the collapsible panel at the top of the subject page)', { type: 'textarea', rows: 3 })}</div>${imageField('background_image', 'Page background image')}
      <div class="span" style="display:flex;gap:24px;flex-wrap:wrap">${field('on_home', 'Show on the home page', { type: 'switch' })}${field('browsable', 'Include in Browse', { type: 'switch' })}</div></div>`) +
    panel('Featured video', `<div class="help" style="margin-bottom:10px">Optional. Shown at the top of the subject page.</div>${vslot('ks2', hasKs ? 'Paying users, KS2 (ages 7-11)' : 'Video')}
      <div style="margin:10px 0 6px"><label class="sw field-sw"><input type="checkbox" id="fvKs" ${hasKs ? 'checked' : ''}> <span>Different video for KS1 (ages 4-7)</span></label></div><div id="fvKs1" ${hasKs ? '' : 'hidden'}>${vslot('ks1', 'Paying users, KS1')}</div>
      <div style="margin:10px 0 6px"><label class="sw field-sw"><input type="checkbox" id="fvFree" ${hasFree ? 'checked' : ''}> <span>Different video for free accounts</span></label></div><div id="fvFree1" ${hasFree ? '' : 'hidden'}>${vslot('free', 'Free accounts')}</div>`) +
    panel('Home page tiles', `<div class="help" style="margin-bottom:10px">Up to four category tiles for teachers who land on the home page rather than a subject. The heading and subheading are optional and override the category's own.</div><div class="rows" id="featList"></div>${canEdit() ? `<div class="inline-add"><button class="btn" id="featAdd">${ICON.plus} Add a category tile</button></div>` : ''}`) +
    vis.html;
  finish([groups, vis]);
  bindFeaturedVideo(); bindFeaturedTiles();
}
function bindFeaturedVideo() {
  const fvKs = $('#fvKs'), fvFree = $('#fvFree');
  const read = () => {
    const fv = {}; editor.querySelectorAll('[data-fv]').forEach(el => { const [k, f] = el.dataset.fv.split('.'); if (el.value) (fv[k] ||= {})[f] = el.value; });
    const out = {}; if (fv.ks2 && fv.ks2.stream_uid) { out.ks2 = fv.ks2; out.ks1 = fvKs.checked && fv.ks1 && fv.ks1.stream_uid ? fv.ks1 : fv.ks2; }
    if (fvFree.checked && fv.free && fv.free.stream_uid) out.free = fv.free;
    return Object.keys(out).length ? out : null;
  };
  const sync = () => markDirty('featured_video', read());
  editor.querySelectorAll('[data-fv]').forEach(el => el.addEventListener('input', sync));
  fvKs.addEventListener('change', () => { $('#fvKs1').hidden = !fvKs.checked; sync(); });
  fvFree.addEventListener('change', () => { $('#fvFree1').hidden = !fvFree.checked; sync(); });
}
function bindFeaturedTiles() {
  const list = $('#featList');
  const draw = () => {
    const feats = PAGE.row.featured || [];
    list.innerHTML = feats.map((f, i) => { const c = D.catById[f.category_id]; return `<div class="row" data-i="${i}" style="cursor:default">${canEdit() ? `<span class="handle">${ICON.drag}</span>` : ''}${c && c.image ? `<img class="thumb" src="${esc(c.image)}" alt="">` : ''}<div class="title"><div class="name">${esc(c ? c.name : 'Category ' + f.category_id)}</div><div class="sub" style="display:flex;gap:6px"><input type="text" placeholder="Heading (optional)" value="${esc(f.heading)}" data-fh="${i}" style="flex:1;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg)"><input type="text" placeholder="Subheading (optional)" value="${esc(f.subheading)}" data-fs="${i}" style="flex:1;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg)"></div></div>${canEdit() ? `<button class="btn icon danger" data-fdel="${i}">${ICON.bin}</button>` : ''}</div>`; }).join('') || '<div class="empty">No tiles yet.</div>';
    list.querySelectorAll('[data-fh],[data-fs]').forEach(el => el.addEventListener('input', () => { const i = +(el.dataset.fh ?? el.dataset.fs); const f = PAGE.row.featured[i]; if (el.dataset.fh != null) f.heading = el.value || undefined; else f.subheading = el.value || undefined; markDirty('featured', PAGE.row.featured); }));
    list.querySelectorAll('[data-fdel]').forEach(b => b.addEventListener('click', () => { PAGE.row.featured.splice(+b.dataset.fdel, 1); markDirty('featured', PAGE.row.featured); draw(); }));
    if (canEdit() && feats.length > 1) new Sortable(list, { handle: '.handle', animation: 150, onEnd: () => { const order = [...list.querySelectorAll('.row')].map(r => PAGE.row.featured[+r.dataset.i]); PAGE.row.featured = order; markDirty('featured', order); draw(); } });
  };
  draw();
  const add = $('#featAdd'); if (add) add.addEventListener('click', () => {
    if ((PAGE.row.featured || []).length >= 4) return toast('Four tiles is the most the home page shows', true);
    pickerModal('Choose a category', 'category', id => { (PAGE.row.featured ||= []).push({ category_id: id }); markDirty('featured', PAGE.row.featured); draw(); });
  });
}
async function pageGroup(id) {
  const nav = ticket();
  const [row] = await get(`groups?id=eq.${id}&select=*`); if (stale(nav)) return; if (!row) return notFound();
  PAGE = { type: 'group', id, row, dirty: {}, reload: () => pageGroup(id) };
  const parent = parentsOf('group', id)[0]; const subj = parent && D.subjectById[parent.parent_id];
  const [cats, vis, where] = await Promise.all([contentsPanel('group', id, { title: 'Categories', note: 'The tiles in this group, in this order. A category can sit in several groups.' }), visibilityPanel('group', id), wherePanel('group', id)]);
  if (stale(nav)) return;
  editor.innerHTML = pageHeader([{ name: 'Subjects', href: '#/' }, subj ? { name: subj.name, href: href('subject', subj.id) } : null, { name: row.name }].filter(Boolean)) + cats.html +
    panel('Details', `<div class="grid">${field('name', 'Name')}<div class="span">${field('description', 'Description (shown beside the group heading)', { type: 'textarea', rows: 2 })}</div></div>`) + vis.html + where.html;
  finish([cats, vis, where]);
}
async function pageCategory(id) {
  const nav = ticket();
  const [row] = await get(`categories?id=eq.${id}&select=*`); if (stale(nav)) return; if (!row) return notFound();
  PAGE = { type: 'category', id, row, dirty: {}, reload: () => pageCategory(id) };
  const parent = parentsOf('category', id).find(p => p.is_home) || parentsOf('category', id)[0];
  const grp = parent && parent.parent_type === 'group' && D.groupById[parent.parent_id]; const subjP = grp && parentsOf('group', grp.id)[0]; const subj = subjP && D.subjectById[subjP.parent_id];
  const [contents, vis, where] = await Promise.all([contentsPanel('category', id, { title: 'Contents', note: 'Schemes, single lessons, video or document blocks and other categories, in the order teachers see them.' }), visibilityPanel('category', id), wherePanel('category', id)]);
  const nounOpts = [['Lesson|Lessons', 'Lessons'], ['Activity|Activities', 'Activities'], ['Resource|Resources', 'Resources'], ['Session|Sessions', 'Sessions']];
  PAGE.row.noun = `${row.noun_singular || 'Lesson'}|${row.noun_plural || 'Lessons'}`;
  if (stale(nav)) return;
  editor.innerHTML = pageHeader([{ name: 'Subjects', href: '#/' }, subj ? { name: subj.name, href: href('subject', subj.id) } : null, grp ? { name: grp.name, href: href('group', grp.id) } : null, { name: row.name }].filter(Boolean)) + contents.html +
    panel('Details', `<div class="grid">${field('name', 'Name')}${field('subheading', 'Subheading (on the tile)')}<div class="span">${field('description', 'Description (on the category page)', { type: 'textarea', rows: 2 })}</div>${imageField('image', 'Tile image', { tile: true })}${imageField('background_image', 'Page background image')}
      ${field('noun', 'What the items are called', { type: 'radio', options: nounOpts, help: 'Shown on the tile, e.g. "12 activities".' })}<div class="span">${field('on_subject_page', 'Show as a tile on the subject page', { type: 'switch' })}</div></div>`) + vis.html + where.html;
  PAGE.onChange = k => { if (k === 'noun') { const [s, p] = PAGE.row.noun.split('|'); delete PAGE.dirty.noun; PAGE.dirty.noun_singular = s; PAGE.dirty.noun_plural = p; PAGE.row.noun_singular = s; PAGE.row.noun_plural = p; } renderPreview(); };
  finish([contents, vis, where]);
}
async function pageBlock(id) {
  const nav = ticket();
  const [row] = await get(`media_blocks?id=eq.${id}&select=*`); if (stale(nav)) return; if (!row) return notFound();
  PAGE = { type: 'media_block', id, row, dirty: {}, reload: () => pageBlock(id) };
  const where = await wherePanel('media_block', id);
  const v = row.video || {}; const diff = !!(v.free || v.paid);
  const vslot = (k, label) => { const x = v[k] || {}; return `<div class="grid" data-vslot="${k}"><div class="field"><label>${esc(label)}: video (Stream UID)</label><input type="text" data-bv="${k}.stream_uid" value="${esc(x.stream_uid)}"></div><div class="field"><label>Length shown on the tile (e.g. 3:20)</label><input type="text" data-bv="${k}.duration" value="${esc(x.duration)}"></div>${k !== 'all' ? `<div class="field"><label>Heading for this audience (optional)</label><input type="text" data-bv="${k}.heading" value="${esc(x.heading)}"></div><div class="field span"><label>Text for this audience (optional)</label><textarea data-bv="${k}.text" rows="2">${esc(x.text)}</textarea></div>` : ''}</div>`; };
  if (stale(nav)) return;
  editor.innerHTML = pageHeader([{ name: 'Blocks' }, { name: row.heading || row.kind }], { subtitle: `${row.kind} block` }) +
    panel('Details', `<div class="grid">${field('kind', 'Kind', { type: 'radio', options: [['video', 'Video'], ['document', 'Document'], ['link', 'Link']] })}${field('heading', 'Heading')}<div class="span">${field('text', 'Text', { type: 'textarea', rows: 3 })}</div>
      <div class="span" data-kind="document">${field('document_url', 'Document', { help: 'Upload arrives with the media library; for now a file address.' })}</div>
      <div class="span" data-kind="link"><div class="grid">${field('link_text', 'Button text')}${field('link_url', 'Link address')}</div></div>
      <div class="span" data-kind="video">${vslot(diff ? 'paid' : 'all', diff ? 'Paying subscribers' : 'Video')}<div style="margin:10px 0 6px"><label class="sw field-sw"><input type="checkbox" id="bvDiff" ${diff ? 'checked' : ''}> <span>Show a different video to free accounts</span></label></div><div id="bvFree" ${diff ? '' : 'hidden'}>${vslot('free', 'Free accounts')}</div></div></div>`) + where.html;
  const showKind = () => editor.querySelectorAll('[data-kind]').forEach(el => el.hidden = el.dataset.kind !== PAGE.row.kind);
  PAGE.onChange = k => { if (k === 'kind') showKind(); };
  finish([where]); showKind();
  const bvDiff = $('#bvDiff');
  const sync = () => { const vv = {}; editor.querySelectorAll('[data-bv]').forEach(el => { const [k, f] = el.dataset.bv.split('.'); if (el.value) (vv[k] ||= {})[f] = el.value; }); const out = {}; const main = vv.paid || vv.all; if (bvDiff.checked) { if (main) out.paid = main; if (vv.free) out.free = vv.free; } else if (main) out.all = main; markDirty('video', Object.keys(out).length ? out : null); };
  editor.querySelectorAll('[data-bv]').forEach(el => el.addEventListener('input', sync));
  bvDiff.addEventListener('change', () => { $('#bvFree').hidden = !bvDiff.checked; sync(); });
}

// Scheme: lessons by age first (each variant its own sequence), then page text and details.
async function pageScheme(id, keepVariant) {
  const nav = ticket();
  const [row] = await get(`schemes?id=eq.${id}&select=*`); if (!row) return notFound();
  const variants = (await get(`scheme_variants?scheme_id=eq.${id}&select=*`)).sort((a, b) => (a.age_min ?? 99) - (b.age_min ?? 99) || a.sort - b.sort);
  if (stale(nav)) return;
  PAGE = { type: 'scheme', id, row, dirty: {}, variants, variant: keepVariant && variants.some(v => v.id === keepVariant) ? keepVariant : variants[0] && variants[0].id, reload: () => pageScheme(id, PAGE.variant) };
  const home = parentsOf('scheme', id).find(p => p.is_home) || parentsOf('scheme', id)[0];
  const cat = home && D.catById[home.parent_id];
  const derived = new Set(); for (const p of parentsOf('scheme', id)) { const g = parentsOf('category', p.parent_id)[0]; const s = g && parentsOf('group', g.parent_id)[0]; if (s) derived.add(s.parent_id); }
  const [where, subj] = await Promise.all([wherePanel('scheme', id), subjectChips('extra_subject_ids', derived)]);
  if (stale(nav)) return;
  editor.innerHTML = pageHeader([{ name: 'Subjects', href: '#/' }, cat ? { name: cat.name, href: href('category', cat.id) } : null, { name: row.name }].filter(Boolean)) +
    panel(variants.length > 1 ? 'Lessons by age' : 'Lessons', `<div class="vtabs" id="vtabs"></div><div id="variantBox"></div>`) +
    textPanel() +
    panel('Details', `<div class="grid">${field('name', 'Name')}${field('subheading', 'Subheading (shown under the name)')}${imageField('image', 'Image (on the scheme card and every lesson in it)')}<div class="span">${field('free_sample', 'Free sample: open to everyone, shows the Free badge', { type: 'switch' })}</div>${subj}</div>`) +
    where.html;
  finish([where]);
  renderVariantTabs(); await renderVariant();
}
function renderVariantTabs() {
  const box = $('#vtabs'); const vs = PAGE.variants;
  box.innerHTML = vs.map(v => `<button class="${v.id === PAGE.variant ? 'active' : ''}" data-v="${v.id}">${esc(ageLabel(v.age_min, v.age_max) || v.subheading || 'All ages')}</button>`).join('') + (canEdit() ? `<button class="btn sm quiet" data-v="new" title="Another age range with its own lesson sequence">${ICON.plus} Age variant</button>` : '');
  box.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.v === 'new') {
      const m = modal(`<div class="box narrow"><div class="mhead"><h2>New age variant</h2></div><div class="mbody" style="padding:16px 18px"><div class="help" style="margin-bottom:8px">The same scheme for another age range, with its own sequence of lessons. Teachers see one card with an age switch.</div><div class="chips">${QUICK.map(q => `<button type="button" class="chip" data-q="${q[1]}|${q[2]}">${q[0]}</button>`).join('')}${AGES.map(a => `<button type="button" class="chip" data-q="${a[0]}|${a[0] + 1}">${a[1]}</button>`).join('')}</div><div style="margin-top:10px"><label class="sw field-sw"><input type="checkbox" id="copyLessons" checked> <span>Start with a copy of the current lesson list</span></label></div></div><div class="mfoot"><button class="btn" data-close>Cancel</button></div></div>`);
      m.querySelector('[data-close]').addEventListener('click', closeModal);
      m.querySelectorAll('[data-q]').forEach(q => q.addEventListener('click', async () => {
        const [a, z] = q.dataset.q.split('|').map(Number); const copy = m.querySelector('#copyLessons').checked; closeModal();
        try { const v = await insert('scheme_variants', { scheme_id: PAGE.id, age_min: a, age_max: z, sort: PAGE.variants.length + 1 });
          if (copy && PAGE.variant) { const ps = await get(`placements?parent_type=eq.variant&parent_id=eq.${PAGE.variant}&select=child_id,sort`); for (const p of ps) await insert('placements', { parent_type: 'variant', parent_id: v.id, child_type: 'lesson', child_id: p.child_id, sort: p.sort }); }
          toast('Variant added'); pageScheme(PAGE.id, v.id); } catch (e) { toast(e.message, true); }
      }));
      return;
    }
    PAGE.variant = +b.dataset.v; renderVariantTabs(); await renderVariant();
  }));
}
async function renderVariant() {
  const v = PAGE.variants.find(x => x.id === PAGE.variant); const box = $('#variantBox');
  if (!v) { box.innerHTML = '<div class="empty">No lessons yet.</div>'; return; }
  const lessons = await contentsPanel('variant', v.id, { title: '', note: 'In the order teachers see them. A lesson can be in more than one scheme.', key: `variant:${v.id}` });
  const inner = lessons.html.replace(/^<div class="panel"[^>]*>/, '<div class="subpanel">').replace(/<\/div>$/, '');
  const multi = PAGE.variants.length > 1;
  box.innerHTML = `${multi ? `<details style="margin-bottom:10px"><summary class="muted small" style="cursor:pointer">${esc(ageLabel(v.age_min, v.age_max))}: change the ages, or give this range its own text or image</summary><div style="margin-top:8px"><div class="agepick" data-vagepick="${v.id}"><div class="quick">${QUICK.map(q => `<button type="button" class="chip ${v.age_min === q[1] && v.age_max === q[2] ? 'on' : ''}" data-q="${q[1]}|${q[2]}">${q[0]}</button>`).join('')}</div><div class="years">${AGES.map(a => `<label><input type="checkbox" value="${a[0]}" ${v.age_min != null && a[0] >= v.age_min && a[0] < v.age_max ? 'checked' : ''}>${a[1]}<small>${a[2]}</small></label>`).join('')}</div></div>
    <div class="grid" style="margin-top:10px"><div class="field"><label>Subheading for this range (blank = the scheme's)</label><input type="text" data-vf="subheading" value="${esc(v.subheading)}" placeholder="${esc(PAGE.row.subheading || '')}"></div><div class="field"><label>Image for this range (blank = the scheme's)</label><input type="url" data-vf="image" value="${esc(v.image)}"></div><div class="field span"><label>Page text for this range (blank = the scheme's)</label>${rteHtml(`data-vrte="${v.id}"`, v.body, 'Only if this age range needs different text')}</div></div>
    ${canEdit() ? `<div style="margin-top:10px"><button class="btn sm danger" id="delVariant">Delete this age variant</button></div>` : ''}</div></details>` : ''}${inner}`;
  lessons.bind(box);
  if (multi) {
    const ap = box.querySelector('[data-vagepick]');
    const applyAges = async (min, max) => { try { Object.assign(v, await patch('scheme_variants', v.id, { age_min: min, age_max: max })); PAGE.variants.sort((a, b) => (a.age_min ?? 99) - (b.age_min ?? 99)); renderVariantTabs(); await renderVariant(); toast('Saved'); refreshStatus(); } catch (e) { toast(e.message, true); } };
    ap.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { const [a, z] = b.dataset.q.split('|').map(Number); applyAges(a, z); }));
    ap.querySelectorAll('.years input').forEach(i => i.addEventListener('change', () => { const t = [...ap.querySelectorAll('.years input:checked')].map(x => +x.value).sort((a, b) => a - b); if (t.length) applyAges(t[0], t[t.length - 1] + 1); }));
    box.querySelectorAll('[data-vf]').forEach(el => el.addEventListener('change', debounce(async () => { try { Object.assign(v, await patch('scheme_variants', v.id, { [el.dataset.vf]: el.value || null })); toast('Saved'); refreshStatus(); } catch (e) { toast(e.message, true); } }, 300)));
    const vr = box.querySelector('[data-vrte]'); if (vr) wireRte(vr, debounce(async h => { if ((h || null) !== (v.body || null)) { try { Object.assign(v, await patch('scheme_variants', v.id, { body: h })); toast('Saved'); refreshStatus(); } catch (e) { toast(e.message, true); } } }, 500));
    const delBtn = box.querySelector('#delVariant');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete the ${ageLabel(v.age_min, v.age_max)} variant? Its lessons stay as lessons but leave this scheme.`)) return;
      try { await del('placements', `parent_type=eq.variant&parent_id=eq.${v.id}`); await del('scheme_variants', `id=eq.${v.id}`); toast('Variant deleted'); pageScheme(PAGE.id); } catch (e) { toast(e.message, true); }
    });
  }
}

// Lesson: parts as teachers see them (lesson plan, printables, then the numbered sequence), then text and details.
const PART_TYPES = [['Video', '🎬'], ['Audio', '🎵'], ['Slides', '🖥️'], ['Image', '🖼️'], ['Text', '📝'], ['Download', '📄']];
const partIcon = t => (PART_TYPES.find(x => x[0] === t) || ['', '📝'])[1];
const isPlan = p => /\b(lesson|session)\s*plans?\b/i.test(p.heading || '');
const isDoc = p => p.show_as_document ?? (p.media_type === 'Download');
async function pageLesson(id) {
  const nav = ticket();
  const [row] = await get(`lessons?id=eq.${id}&select=*`); if (stale(nav)) return; if (!row) return notFound();
  PAGE = { type: 'lesson', id, row, dirty: {}, reload: () => pageLesson(id) };
  const [parts, where, vps] = await Promise.all([get(`lesson_parts?lesson_id=eq.${id}&select=*&order=sort,id`), wherePanel('lesson', id), get(`placements?child_type=eq.lesson&child_id=eq.${id}&parent_type=eq.variant&select=parent_id`)]);
  PAGE.parts = parts;
  const derived = new Set(); let crumb = null;
  for (const vp of vps) { const [v] = await get(`scheme_variants?id=eq.${vp.parent_id}&select=scheme_id,schemes(name)`); if (!v) continue; if (!crumb) crumb = { name: v.schemes.name, href: href('scheme', v.scheme_id) }; for (const p of parentsOf('scheme', v.scheme_id)) { const g = parentsOf('category', p.parent_id)[0]; const s = g && parentsOf('group', g.parent_id)[0]; if (s) derived.add(s.parent_id); } }
  const subj = await subjectChips('extra_subject_ids', derived);
  PAGE.row.tags_text = (row.tags || []).join(', ');
  if (stale(nav)) return;
  editor.innerHTML = pageHeader([{ name: 'Subjects', href: '#/' }, crumb, { name: row.name }].filter(Boolean)) +
    panel('Parts', '<div id="partsBox"></div>') +
    textPanel() +
    panel('Details', `<div class="grid">${field('name', 'Name')}${field('heading_2', 'Subtitle (beside the name on the lesson page)')}${agePicker()}
      <div class="span"><div class="subhead">What to expect</div><div class="grid">${field('duration', 'Length (minutes)', { type: 'number' })}${field('preparation', 'Preparation (minutes)', { type: 'number' })}${field('intensity', 'Physical intensity', { type: 'radio', options: [['', 'Not set'], ['Low', 'Low'], ['Moderate', 'Moderate'], ['Vigorous', 'Vigorous']] })}${field('focus', 'Focus', { type: 'radio', options: [['', 'Not set'], ['Energising', 'Energising'], ['Calming', 'Calming']] })}${field('location', 'Where it can be taught', { type: 'chips', options: [['Hall', 'Hall'], ['Classroom', 'Classroom'], ['Outdoors', 'Outdoors'], ['Corridors', 'Corridors'], ['Home', 'Home']] })}</div></div>
      <div class="span" style="display:flex;gap:24px;flex-wrap:wrap">${field('free_sample', 'Free sample: open to everyone, shows the Free badge', { type: 'switch' })}${field('thumb_enabled', 'Show the thumb-o-meter', { type: 'switch' })}</div>
      ${imageField('background_image', 'Page background image')}${subj}<div class="span">${field('tags_text', 'Search tags (comma-separated)', { help: 'For the search work: words teachers might type that are not in the text.' })}</div></div>`) +
    where.html;
  PAGE.onChange = k => { if (k === 'tags_text') { delete PAGE.dirty.tags_text; PAGE.dirty.tags = (PAGE.row.tags_text || '').split(',').map(s => s.trim()).filter(Boolean); } renderPreview(); };
  finish([where]);
  renderParts();
}
function renderParts() {
  const box = $('#partsBox');
  const live = PAGE.parts.filter(p => !p.archived);
  const plans = live.filter(p => isDoc(p) && isPlan(p)), prints = live.filter(p => isDoc(p) && !isPlan(p)), seq = live.filter(p => !isDoc(p));
  let n = 0;
  const row = (p, label) => `<div class="part" data-part="${p.id}"><div class="row">${canEdit() && !p.archived ? `<span class="handle">${ICON.drag}</span>` : '<span class="handle" style="cursor:default"></span>'}<span class="num">${label}</span><span class="media">${partIcon(p.media_type)} ${esc(p.media_type)}</span><div class="title"><div class="name">${esc(p.heading || '(no heading)')}</div><div class="sub">${esc((p.additional_info || '').replace(/\s+/g, ' ').slice(0, 90))}</div></div>${p.duration ? `<span class="muted small">${esc(p.duration)}</span>` : ''}<div class="rt"><label class="sw row-sw" title="${p.live ? 'Teachers can see this part' : 'Hidden part'}"><input type="checkbox" data-partlive ${p.live ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}></label>${canEdit() ? `<button class="btn icon danger" data-partbin title="${p.archived ? 'Restore' : 'Remove (archive)'}">${p.archived ? ICON.restore : ICON.bin}</button>` : ''}</div></div><div class="detail"></div></div>`;
  const block = (title, items, f) => items.length ? `<div class="blockhead">${title}</div><div class="rows" data-partlist="${title}">${items.map(f).join('')}</div>` : '';
  box.innerHTML = `${block('Lesson plan', plans, p => row(p, 'Plan'))}${block('Printables', prints, p => row(p, 'Printable'))}${block('In the lesson', seq, p => row(p, p.live ? `Part ${++n}` : ''))}${!live.length ? '<div class="empty">No parts yet.</div>' : ''}
    ${canEdit() ? `<div class="inline-add"><div class="menu up" id="addPart"><button class="btn" data-addbtn>${ICON.plus} Add part</button><div class="items">${PART_TYPES.map(t => `<button data-newpart="${t[0]}">${t[1]} ${t[0]}</button>`).join('')}</div></div><span class="muted small">Video, audio, slides, images and text are numbered in order. Downloads sit outside the sequence.</span></div>` : ''}
    ${PAGE.parts.some(p => p.archived) ? `<details style="margin-top:12px"><summary class="muted small" style="cursor:pointer">Archived parts (${PAGE.parts.filter(p => p.archived).length})</summary><div class="rows" style="margin-top:8px">${PAGE.parts.filter(p => p.archived).map(p => row(p, '')).join('')}</div></details>` : ''}`;
  box.querySelectorAll('.part > .row').forEach(r => r.addEventListener('click', e => { if (e.target.closest('.handle, .rt, input, label, button')) return; const el = r.closest('.part'); el.classList.toggle('open'); if (el.classList.contains('open')) renderPartDetail(el); }));
  const savePart = async (p, body) => { try { Object.assign(p, await patch('lesson_parts', p.id, body)); refreshStatus(); return true; } catch (e) { toast(e.message, true); return false; } };
  box.querySelectorAll('[data-partlive]').forEach(i => i.addEventListener('change', async e => { const p = PAGE.parts.find(x => x.id === +e.target.closest('.part').dataset.part); if (await savePart(p, { live: e.target.checked })) renderParts(); else e.target.checked = !e.target.checked; }));
  box.querySelectorAll('[data-partbin]').forEach(b => b.addEventListener('click', async e => { e.stopPropagation(); const p = PAGE.parts.find(x => x.id === +b.closest('.part').dataset.part); if (!p.archived && !confirm(`Remove "${p.heading || p.media_type}" from the lesson? It goes to the archived parts below and can be restored.`)) return; if (await savePart(p, { archived: !p.archived })) { toast(p.archived ? 'Part archived' : 'Part restored'); renderParts(); } }));
  if (canEdit()) {
    box.querySelectorAll('[data-partlist]').forEach(list => new Sortable(list, { handle: '.handle', group: 'parts', animation: 150, onEnd: async () => {
      const ids = [...box.querySelectorAll('[data-partlist] .part')].map(e => +e.dataset.part);
      try { await Promise.all(ids.map((pid, i) => patch('lesson_parts', pid, { sort: i + 1 }))); ids.forEach((pid, i) => { const p = PAGE.parts.find(x => x.id === pid); if (p) p.sort = i + 1; }); PAGE.parts.sort((a, b) => a.sort - b.sort); toast('Order saved'); renderParts(); refreshStatus(); } catch (e) { toast(e.message, true); }
    } }));
    const menu = box.querySelector('#addPart');
    menu.querySelector('[data-addbtn]').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.querySelectorAll('[data-newpart]').forEach(b => b.addEventListener('click', async () => {
      try { const p = await insert('lesson_parts', { lesson_id: PAGE.id, media_type: b.dataset.newpart, heading: b.dataset.newpart === 'Download' ? 'Lesson plan' : '', sort: PAGE.parts.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1 }); PAGE.parts.push(p); renderParts(); const el = box.querySelector(`[data-part="${p.id}"]`); el.classList.add('open'); renderPartDetail(el); el.querySelector('[data-pf="heading"]').focus(); refreshStatus(); } catch (e) { toast(e.message, true); }
    }));
  }
}
function renderPartDetail(el) {
  const p = PAGE.parts.find(x => x.id === +el.dataset.part); const d = el.querySelector('.detail');
  const f = (k, label, type = 'text', placeholder = '') => `<div class="field"><label>${esc(label)}</label>${type === 'textarea' ? `<textarea data-pf="${k}" rows="3">${esc(p[k])}</textarea>` : `<input type="text" data-pf="${k}" value="${esc(p[k])}" placeholder="${esc(placeholder)}">`}</div>`;
  const media = { Video: f('stream_uid', 'Video (Cloudflare Stream UID)', 'text', 'Until the media library: paste the Stream UID'), Audio: f('file_url', 'Audio file address') + f('duration', 'Length shown (e.g. 4:30)'), Image: f('file_url', 'Image address'), Download: f('file_url', 'File address'), Slides: f('google_slide_id', 'Slides (Google deck id until PDF upload arrives)'), Text: '' }[p.media_type] || '';
  d.innerHTML = `<div class="grid" style="margin-top:10px"><div class="field span"><label>Type</label><div class="chips">${PART_TYPES.map(t => `<label class="chip"><input type="radio" name="pt-${p.id}" data-pf="media_type" value="${t[0]}" ${p.media_type === t[0] ? 'checked' : ''}> ${t[1]} ${t[0]}</label>`).join('')}</div></div>${f('heading', 'Heading')}<div class="span">${f('additional_info', 'Text shown with this part', 'textarea')}</div><div class="span"><div class="grid">${media}</div></div>
    ${p.media_type === 'Download' || p.show_as_document != null ? `<div class="span"><div class="field"><label>Shown as</label><div class="chips"><label class="chip"><input type="radio" name="sd-${p.id}" data-pf="show_as_document" value="" ${p.show_as_document == null ? 'checked' : ''}> Usual for its type</label><label class="chip"><input type="radio" name="sd-${p.id}" data-pf="show_as_document" value="true" ${p.show_as_document === true ? 'checked' : ''}> A document (plan or printable)</label><label class="chip"><input type="radio" name="sd-${p.id}" data-pf="show_as_document" value="false" ${p.show_as_document === false ? 'checked' : ''}> In the numbered sequence</label></div><div class="help">A download with "Lesson plan" or "Session plan" in its heading is the lesson plan card; other downloads are printables.</div></div></div>` : ''}</div>`;
  if (!canEdit()) { d.querySelectorAll('input,textarea').forEach(x => x.disabled = true); return; }
  d.querySelectorAll('[data-pf]').forEach(x => x.addEventListener('change', debounce(async () => {
    const k = x.dataset.pf; let v = x.value === '' ? null : x.value;
    if (k === 'show_as_document') v = x.value === '' ? null : x.value === 'true';
    try { Object.assign(p, await patch('lesson_parts', p.id, { [k]: v })); toast('Saved'); refreshStatus(); if (['media_type', 'heading', 'show_as_document', 'duration'].includes(k)) { renderParts(); const e2 = $(`[data-part="${p.id}"]`); if (e2) { e2.classList.add('open'); renderPartDetail(e2); } } } catch (e) { toast(e.message, true); }
  }, 250)));
}

async function pageArchive() {
  const nav = ticket();
  PAGE = { type: null, dirty: {}, reload: pageArchive };
  const rows = await get('archive?select=*&order=updated_at.desc&limit=500');
  if (stale(nav)) return;
  if (stale(nav)) return;
  editor.innerHTML = `<div class="crumbs"><span>Archive</span></div><div class="edhead"><h1>Archive</h1><span class="meta">${rows.length} items</span></div>` +
    panel('Removed from everywhere', `<div class="help" style="margin-bottom:10px">Items removed from their last place. Restore brings one back so you can add it to a category or scheme again; open it to edit.</div><div class="rows">${rows.map(r => `<div class="row" data-go="${href(r.item_type, r.id)}"><span class="handle" style="cursor:default"></span><span class="kind ${r.item_type}">${KIND[r.item_type]}</span><div class="title"><div class="name">${esc(r.name)}</div><div class="sub">archived ${when(r.updated_at)}</div></div>${canEdit() ? `<button class="btn sm" data-restore="${r.item_type}:${r.id}">${ICON.restore} Restore</button>` : ''}</div>`).join('') || '<div class="empty">The archive is empty.</div>'}</div>`);
  editor.querySelectorAll('.row[data-go]').forEach(r => r.addEventListener('click', e => { if (e.target.closest('button')) return; location.hash = r.dataset.go; }));
  editor.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation(); const [t, id] = b.dataset.restore.split(':');
    try { await rpc('restore', { p_type: t, p_id: +id }); toast('Restored. Now add it to a category or scheme from that page.'); await reloadTree(); location.hash = href(t, +id); } catch (err) { toast(err.message, true); }
  }));
}

// ---------- waiting drawer ----------
function updateWaitingCount() { const c = $('#waitingCount'); const n = (D.waiting || []).length; c.textContent = n; c.hidden = !n; }
async function loadWaiting() {
  try { const rows = await get('waiting?select=*&order=changed_at.desc&limit=200'); D.waiting = rows; D.waitSet = new Set(rows.map(w => `${w.item_type}:${w.id}`)); updateWaitingCount(); } catch (e) { /* ignore */ }
}
async function openWaiting() {
  await loadWaiting(); const rows = D.waiting || [];
  $('#drawerTitle').textContent = 'Waiting to publish'; $('#drawer').classList.add('open');
  $('#drawerItems').innerHTML = (rows.length ? `<div class="help" style="margin:8px 0">Changes teachers cannot see yet. Open an item and press Publish changes, or switch it on.</div>` : '') + (rows.length ? rows.map(r => `<div class="change"><div class="top"><span class="kind ${r.item_type}">${KIND[r.item_type]}</span><button data-go="${href(r.item_type, r.id)}" style="border:0;background:none;color:var(--accent);cursor:pointer;font-weight:600;text-align:left;padding:0">${esc(r.name)}</button><span class="when">${when(r.changed_at)}</span></div><div class="what">${r.is_published ? `changed since v${r.last_version}` : 'never published'}${r.changed_by ? ` · ${esc(r.changed_by)}` : ''}</div></div>`).join('') : '<div class="empty">Nothing waiting. Everything that has changed is published.</div>');
  $('#drawerItems').querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { $('#drawer').classList.remove('open'); location.hash = b.dataset.go; }));
}
$('#waitingBtn').addEventListener('click', openWaiting);
$('#drawerClose').addEventListener('click', () => $('#drawer').classList.remove('open'));

// ---------- routing and boot ----------
async function route() {
  const p = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  const id = +p[1]; const type = { block: 'media_block' }[p[0]] || p[0];
  if (p[1] !== undefined && !Number.isInteger(id)) { editor.innerHTML = '<div class="empty" style="padding-top:120px">Not found.</div>'; return; }
  if (PAGE && PAGE.dirty && Object.keys(PAGE.dirty).length && !(PAGE.type === type && PAGE.id === id)) { if (!confirm('You have unsaved changes. Leave without saving?')) { history.back(); return; } }
  $('#drawer').classList.remove('open');
  editor.innerHTML = '<div class="empty" style="padding-top:80px">Loading…</div>';
  try {
    if (p[0] === 'subject') { treeReveal('subject', id); renderTree(); await pageSubject(id); }
    else if (p[0] === 'group') { treeReveal('group', id); renderTree(); await pageGroup(id); }
    else if (p[0] === 'category') { treeReveal('category', id); renderTree(); await pageCategory(id); }
    else if (p[0] === 'scheme') await pageScheme(id);
    else if (p[0] === 'lesson') await pageLesson(id);
    else if (p[0] === 'block') await pageBlock(id);
    else if (p[0] === 'archive') await pageArchive();
    else { renderTree(); await pageSubjects(); }
  } catch (e) { editor.innerHTML = `<div class="empty" style="padding-top:80px">Something went wrong: ${esc(e.message)}</div>`; }
  editor.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && PAGE && PAGE.type) { e.preventDefault(); save(); } });

async function start() {
  document.body.classList.remove('signedout'); $('#login').classList.remove('open');
  $('#who').textContent = Auth.email() + (Auth.isStaff() ? ' · staff' : ''); $('#signout').hidden = false;
  $('#readonly').hidden = Auth.isStaff();
  try { await loadTree(); renderTree(); updateWaitingCount(); } catch (e) { $('#tree').innerHTML = `<div class="hint">Could not load content: ${esc(e.message)}</div>`; }
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
