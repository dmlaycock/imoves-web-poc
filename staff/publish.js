// imoves CMS - publishing v0.1 (increment 4, 5 Nov 2026)
//
// What publishing looks like to staff: a dialog that says what will go out (new, changed,
// unchanged) and what would be wrong afterwards (a part with no file, a scheme with no lesson
// teachers could see, an item placed nowhere) before they confirm; a Preview menu on every page
// that opens the teacher site on this item with draft content, as a free, trial or paying
// account; a Waiting page (what has changed and for how long, publish from the list); and a
// Changes page (who changed or published what, when). Loaded after cms.js.

// ---------- preview on the teacher site ----------
const TEACHER_ROUTE = (type, id, row) => {
  if (type === 'subject') return `#/subject/${id}`;
  if (type === 'group') { const p = parentsOf('group', id)[0]; return p ? `#/subject/${p.parent_id}` : '#/'; }
  if (type === 'category') return `#/category/${id}`;
  if (type === 'media_block') { const p = parentsOf('media_block', id)[0]; return p ? `#/category/${p.parent_id}` : '#/'; }
  if (type === 'scheme') { const p = parentsOf('scheme', id).find(x => x.is_home) || parentsOf('scheme', id)[0]; return p ? `#/category/${p.parent_id}` : '#/'; }
  if (type === 'lesson') return `#/lesson/${id}`;
  return '#/';
};
function previewUrl(type, id, { content = 'draft', as = '', ages = '' } = {}) {
  const q = new URLSearchParams({ content }); if (as) q.set('as', as); if (ages) q.set('ages', ages); q.set('v', Date.now().toString(36));
  return `${TEACHER_URL}?${q}${TEACHER_ROUTE(type, id)}`;
}
function previewMenu() {
  if (!PAGE || !PAGE.type || PAGE.type === 'asset') return '';
  const opts = [['draft', '', 'Draft, as me'], ['draft', 'free', 'Draft, as a free account'], ['draft', 'trial', 'Draft, as a trial'], ['draft', 'paying', 'Draft, as a paying school'], ['published', '', 'Published, as me']];
  return `<div class="menu" id="previewMenu"><button class="btn" data-addbtn title="Open the teacher site on this page">Preview ▾</button><div class="items">${opts.map(o => `<button data-pv="${o[0]}|${o[1]}">${o[2]}</button>`).join('')}<hr><div class="agesrow">Ages <select id="pvAges"><option value="">as the account</option><option value="4-5">EYFS</option><option value="5-7">KS1</option><option value="7-11">KS2</option>${AGES.map(a => `<option value="${a[0]}-${a[0] + 1}">${a[1]}</option>`).join('')}</select></div></div></div>`;
}
function bindPreviewMenu(root) {
  const menu = root.querySelector('#previewMenu'); if (!menu) return;
  menu.querySelector('[data-addbtn]').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
  menu.querySelector('#pvAges').addEventListener('click', e => e.stopPropagation());
  menu.querySelectorAll('[data-pv]').forEach(b => b.addEventListener('click', async () => {
    const [content, as] = b.dataset.pv.split('|'); const ages = menu.querySelector('#pvAges').value;
    if (content === 'draft' && PAGE.dirty && Object.keys(PAGE.dirty).length && !(await save())) return;
    menu.classList.remove('open');
    window.open(previewUrl(PAGE.type, PAGE.id, { content, as, ages }), 'imoves-preview');
  }));
  document.addEventListener('click', () => menu.classList.remove('open'));
}

// ---------- the publish dialog ----------
// Replaces the browser confirm: shows what the publish covers and the warnings, lets staff
// include everything beneath, and publishes on confirm. Resolves true when published.
function publishDialog(type, id, name, hasChildren) {
  return new Promise(resolve => {
    let withChildren = hasChildren, rows = [], loading = true, note = '';
    const m = modal(`<div class="box"><div class="mhead"><h2>Publish ${esc(KIND[type].toLowerCase())}: ${esc(name)}</h2><button class="btn quiet sm" data-close>Cancel</button></div><div class="mtools" id="pubTools"></div><div class="mbody" id="pubBody"><div class="empty">Checking…</div></div><div class="mfoot"><input type="text" id="pubNote" placeholder="Note for the history (optional)" style="flex:1;padding:7px 10px;border:1px solid var(--line);border-radius:6px"><button class="btn primary" id="pubGo" disabled>Publish</button></div></div>`);
    const close = v => { closeModal(); resolve(v); };
    m.querySelector('[data-close]').addEventListener('click', () => close(false));
    m.onclick = e => { if (e.target === m) close(false); };
    const draw = () => {
      const items = rows.filter(r => r.kind === 'item'), warns = rows.filter(r => r.kind === 'warning');
      const by = s => items.filter(i => i.status === s);
      const list = (title, xs, cls) => xs.length ? `<details ${xs.length <= 12 ? 'open' : ''}><summary><span class="pill ${cls}">${xs.length}</span> ${title}</summary><div class="pubitems">${xs.map(i => `<div><span class="kind ${i.item_type}">${KIND[i.item_type]}</span> ${esc(i.name || '')}</div>`).join('')}</div></details>` : '';
      $('#pubTools').innerHTML = hasChildren ? `<label class="sw field-sw"><input type="checkbox" id="pubKids" ${withChildren ? 'checked' : ''}> <span>Include everything placed under it (${withChildren ? items.length - 1 : 'count'} items)</span></label>` : `<span class="muted small">Publishing this ${KIND[type].toLowerCase()}${type === 'scheme' ? ' and its lesson order' : type === 'lesson' ? ' and its parts' : ''}.</span>`;
      $('#pubBody').innerHTML = loading ? '<div class="empty">Checking…</div>' :
        `${warns.length ? `<div class="pubwarn"><b>${warns.length === 1 ? 'One thing' : warns.length + ' things'} to look at</b> - you can still publish.<div class="pubitems">${warns.map(w => `<div><span class="kind ${w.item_type}">${KIND[w.item_type]}</span> <button class="linkish" data-go="${href(w.item_type, w.id)}">${esc(w.name || '')}</button><div class="muted small">${esc(w.detail)}</div></div>`).join('')}</div></div>` : '<div class="pubok">Nothing missing: every file is ready and every container has something teachers will see.</div>'}
         ${list('new - teachers see these for the first time', by('new'), 'new')}${list('changed since last published', by('changed'), 'pending')}${list('unchanged (republished as they are)', by('unchanged'), 'live')}`;
      const kids = $('#pubKids'); if (kids) kids.addEventListener('change', () => { withChildren = kids.checked; load(); });
      $('#pubBody').querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { close(false); location.hash = b.dataset.go; }));
      $('#pubGo').disabled = loading; $('#pubGo').textContent = loading ? 'Publish' : `Publish ${items.length > 1 ? items.length + ' items' : ''}`;
    };
    const load = async () => { loading = true; draw(); try { rows = await rpc('publish_preview', { p_type: type, p_id: id, p_with_children: withChildren }); } catch (e) { toast(e.message, true); rows = []; } loading = false; draw(); };
    $('#pubGo').addEventListener('click', async () => {
      note = $('#pubNote').value.trim(); $('#pubGo').disabled = true; $('#pubGo').textContent = 'Publishing…';
      try { const v = await rpc('publish', { p_type: type, p_id: id, p_with_children: withChildren, p_note: note || null }); toast(`${name} published (v${v})`); close(true); }
      catch (e) { toast(`Could not publish: ${e.message}`, true); $('#pubGo').disabled = false; draw(); }
    });
    load();
  });
}
function unpublishDialog(type, id, name) {
  return new Promise(resolve => {
    const m = modal(`<div class="box narrow"><div class="mhead"><h2>Hide from teachers</h2></div><div class="mbody" style="padding:16px 18px"><p>Teachers stop seeing <b>${esc(name)}</b> straight away${['subject', 'group', 'category', 'scheme'].includes(type) ? ', and nothing placed under it can be reached through it' : ''}. The draft is kept; switch it on again to publish it.</p></div><div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn danger" id="unpubGo">Hide</button></div></div>`);
    const close = v => { closeModal(); resolve(v); };
    m.querySelector('[data-close]').addEventListener('click', () => close(false)); m.onclick = e => { if (e.target === m) close(false); };
    m.querySelector('#unpubGo').addEventListener('click', async () => { try { await rpc('unpublish', { p_type: type, p_id: id }); toast('Hidden from teachers'); close(true); } catch (e) { toast(`Could not unpublish: ${e.message}`, true); close(false); } });
  });
}

// ---------- Waiting page ----------
async function pageWaiting() {
  const nav = ticket();
  PAGE = { type: null, dirty: {}, reload: pageWaiting };
  const pref = PREF.get('waiting') || {};
  const rows = await get('waiting_aged?select=*&order=changed_at.desc&limit=1000');
  if (stale(nav)) return;
  D.waiting = rows; D.waitSet = new Set(rows.map(w => `${w.item_type}:${w.id}`)); updateWaitingCount();
  const people = [...new Set(rows.map(r => r.changed_by).filter(Boolean))].sort();
  const shown = rows.filter(r => (!pref.type || r.item_type === pref.type) && (!pref.who || r.changed_by === pref.who) && (!pref.old || r.days_waiting >= 7));
  const age = r => r.days_waiting >= 7 ? `<span class="pill pending" title="Waiting more than a week">${Math.floor(r.days_waiting)} days</span>` : r.days_waiting >= 1 ? `<span class="muted small">${Math.floor(r.days_waiting)} day${r.days_waiting >= 2 ? 's' : ''}</span>` : '<span class="muted small">today</span>';
  editor.innerHTML = `<div class="crumbs"><span>Waiting to publish</span></div><div class="edhead"><h1>Waiting to publish</h1><span class="meta">${rows.length} item${rows.length === 1 ? '' : 's'} with changes teachers cannot see${rows.filter(r => r.days_waiting >= 7).length ? ` · <span class="pill pending">${rows.filter(r => r.days_waiting >= 7).length} waiting over a week</span>` : ''}</span>
      <div class="actions">${canEdit() && shown.length ? `<button class="btn primary" id="pubAll">Publish all ${shown.length} shown</button>` : ''}</div></div>` +
    panel('', `<div class="mediatools2" style="margin-bottom:12px"><select id="wType"><option value="">All kinds</option>${['subject', 'group', 'category', 'scheme', 'lesson', 'media_block'].map(t => `<option value="${t}" ${pref.type === t ? 'selected' : ''}>${KIND[t]}s</option>`).join('')}</select><select id="wWho"><option value="">Anyone</option>${people.map(p => `<option value="${esc(p)}" ${pref.who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select><label class="sw field-sw"><input type="checkbox" id="wOld" ${pref.old ? 'checked' : ''}> <span>Only waiting over a week</span></label></div>
      <div class="rows">${shown.map(r => `<div class="row" data-go="${href(r.item_type, r.id)}"><span class="handle" style="cursor:default"></span><span class="kind ${r.item_type}">${KIND[r.item_type]}</span><div class="title"><div class="name">${esc(r.name)}</div><div class="sub">${r.is_published ? `changed since v${r.last_version}` : 'never published'}${r.changed_by ? ` · ${esc(r.changed_by)}` : ''} · ${when(r.changed_at)}</div></div>${age(r)}<div class="rt">${canEdit() ? `<button class="btn sm" data-pub="${r.item_type}:${r.id}" data-name="${esc(r.name)}">Publish…</button>` : ''}</div></div>`).join('') || '<div class="empty">Nothing waiting. Everything that has changed is published.</div>'}</div>`);
  const setPref = p => { PREF.set('waiting', { ...(PREF.get('waiting') || {}), ...p }); pageWaiting(); };
  $('#wType').addEventListener('change', e => setPref({ type: e.target.value })); $('#wWho').addEventListener('change', e => setPref({ who: e.target.value })); $('#wOld').addEventListener('change', e => setPref({ old: e.target.checked }));
  editor.querySelectorAll('.row[data-go]').forEach(r => r.addEventListener('click', e => { if (e.target.closest('button')) return; location.hash = r.dataset.go; }));
  editor.querySelectorAll('[data-pub]').forEach(b => b.addEventListener('click', async e => { e.stopPropagation(); const [t, id] = b.dataset.pub.split(':'); if (await publishDialog(t, +id, b.dataset.name, ['subject', 'group', 'category', 'scheme'].includes(t))) { await reloadTree(); pageWaiting(); } }));
  const all = $('#pubAll'); if (all) all.addEventListener('click', async () => {
    if (!confirm(`Publish all ${shown.length} items shown, each on its own (containers without their children)? Use Publish… on a row to see what each one changes first.`)) return;
    let n = 0; for (const r of shown) { try { await rpc('publish', { p_type: r.item_type, p_id: r.id, p_with_children: false }); n++; } catch (e) { toast(`${r.name}: ${e.message}`, true); } }
    toast(`${n} published`); await reloadTree(); pageWaiting();
  });
}

// ---------- Changes page (the audit log) ----------
async function pageChanges() {
  const nav = ticket();
  PAGE = { type: null, dirty: {}, reload: pageChanges };
  const pref = PREF.get('changes') || {};
  const q = (pref.q || '').replace(/[%,()]/g, ' ').trim();
  const filter = (pref.action ? `&action=eq.${pref.action}` : '') + (pref.who ? `&actor=eq.${encodeURIComponent(pref.who)}` : '') + (pref.type ? `&item_type=eq.${pref.type}` : '') + (q ? `&name=ilike.*${encodeURIComponent(q)}*` : '');
  const limit = pref.more || 100;
  const [rows, actors] = await Promise.all([get(`activity?select=id,at,actor,item_type,item_id,action,name,changed&item_type=neq.all${filter}&order=id.desc&limit=${limit}`), get('activity?select=actor&order=id.desc&limit=2000')]);
  if (stale(nav)) return;
  const people = [...new Set(actors.map(a => a.actor))].sort();
  const verb = { insert: 'created', update: 'changed', delete: 'deleted', publish: 'published', unpublish: 'hid from teachers', rollback: 'restored a version of', migrate: 'migrated' };
  editor.innerHTML = `<div class="crumbs"><span>Changes</span></div><div class="edhead"><h1>Changes</h1><span class="meta">who did what, newest first</span></div>` +
    panel('', `<div class="mediatools2" style="margin-bottom:12px"><input type="search" id="cq" placeholder="Item name" value="${esc(pref.q || '')}"><select id="cAction"><option value="">Anything</option>${Object.entries(verb).filter(([k]) => k !== 'migrate').map(([k, v]) => `<option value="${k}" ${pref.action === k ? 'selected' : ''}>${v}</option>`).join('')}</select><select id="cType"><option value="">All kinds</option>${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${pref.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select><select id="cWho"><option value="">Anyone</option>${people.map(p => `<option value="${esc(p)}" ${pref.who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      <div class="rows changes">${rows.map(r => `<div class="row" ${ROUTE[r.item_type] ? `data-go="${href(r.item_type, r.item_id)}"` : 'style="cursor:default"'}><span class="handle" style="cursor:default"></span><span class="kind ${r.item_type}">${KIND[r.item_type] || r.item_type}</span><div class="title"><div class="name"><b>${esc(r.actor)}</b> ${verb[r.action] || r.action} ${esc(r.name || '(deleted)')}</div>${r.changed && r.changed.length ? `<div class="sub">${esc(r.changed.join(', '))}</div>` : ''}</div><span class="muted small">${when(r.at)}</span></div>`).join('') || '<div class="empty">Nothing recorded.</div>'}</div>${rows.length >= limit ? `<div class="inline-add"><button class="btn" id="cMore">Show more</button></div>` : ''}`);
  const setPref = p => { PREF.set('changes', { ...(PREF.get('changes') || {}), more: 0, ...p }); pageChanges(); };
  $('#cq').addEventListener('input', debounce(e => setPref({ q: e.target.value }), 300)); $('#cAction').addEventListener('change', e => setPref({ action: e.target.value })); $('#cType').addEventListener('change', e => setPref({ type: e.target.value })); $('#cWho').addEventListener('change', e => setPref({ who: e.target.value }));
  const more = $('#cMore'); if (more) more.addEventListener('click', () => { PREF.set('changes', { ...(PREF.get('changes') || {}), more: limit + 200 }); pageChanges(); });
  editor.querySelectorAll('.row[data-go]').forEach(r => r.addEventListener('click', () => location.hash = r.dataset.go));
  if (pref.q) { const i = $('#cq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}
