// imoves CMS - working alongside Quickbase (v0.6)
//
// While Quickbase is still the live system, the CMS's copy follows it: every night (and on demand)
// content.refresh_from_quickbase brings in what changed there. An item stops following Quickbase
// the moment someone edits it here - from then on it is "managed in the CMS" and the refresh
// leaves it alone. If Quickbase changes such an item too, it goes on the list on this page and a
// person chooses: keep the CMS version, or hand the item back to Quickbase.
const QB_TOPIC = 'Changed in Quickbase and in the CMS';
const QB_TYPES = ['subject', 'group', 'category', 'scheme', 'lesson', 'media_block'];

async function loadManaged() {
  try { const rows = await get('managed?select=item_type,item_id,conflict&limit=5000'); D.managed = new Map(rows.map(r => [`${r.item_type}:${r.item_id}`, r.conflict])); }
  catch (e) { D.managed = new Map(); }
  const n = [...D.managed.values()].filter(Boolean).length;
  D.qbConflicts = n; const c = $('#qbCount'); if (c) { c.textContent = n; c.hidden = !n; }
}
// The note beside the publish details on every item page.
async function sourceNote() {
  const el = $('#srcNote'); if (!el || !PAGE || !QB_TYPES.includes(PAGE.type)) return;
  let rows = [];
  try { rows = await get(`managed?select=since,by,conflict&item_type=eq.${PAGE.type}&item_id=eq.${PAGE.id}`); } catch (e) { return; }
  const m = rows[0];
  if (!m) { el.className = 'pill src follows'; el.textContent = 'Follows Quickbase'; el.title = 'Nobody has edited this here, so it is kept up to date with Quickbase every night. It becomes managed in the CMS the moment you save a change.'; }
  else if (m.conflict) { el.className = 'pill src danger'; el.innerHTML = 'Also changed in Quickbase'; el.title = 'Managed in the CMS, and Quickbase has changed it since. Open the Quickbase page to choose which version to keep.'; el.style.cursor = 'pointer'; el.onclick = () => location.hash = '#/quickbase'; }
  else { el.className = 'pill src new'; el.textContent = 'Managed in the CMS'; el.title = `Edited here${m.by ? ' by ' + m.by : ''} on ${when(m.since)}. The nightly refresh from Quickbase leaves it alone, so do not edit it in Quickbase as well.`; }
  el.hidden = false;
}

async function pageQuickbase() {
  const nav = ticket();
  PAGE = { type: null, dirty: {}, reload: pageQuickbase };
  const [runs, managed, reviews] = await Promise.all([
    get('refresh_runs?select=id,at,seconds,summary&order=id.desc&limit=8'),
    get('managed?select=*&order=since.desc&limit=2000'),
    get(`reviews?select=id,item_type,item_id,at,note&topic=eq.${encodeURIComponent(QB_TOPIC)}&resolved=eq.false&order=at.desc&limit=500`),
  ]);
  if (stale(nav)) return;
  const names = new Map(managed.map(m => [`${m.item_type}:${m.item_id}`, m.name]));
  const last = runs[0];
  const sum = s => { const t = { updated: 0, added: 0, removed: 0, published: 0, unpublished: 0 }; for (const v of Object.values(s || {})) if (v && typeof v === 'object') for (const k in t) t[k] += v[k] || 0; return t; };
  const line = r => { const t = sum(r.summary); const bits = [[t.updated, 'updated'], [t.added, 'added'], [t.removed, 'removed'], [t.published, 'made live'], [t.unpublished, 'taken off live']].filter(b => b[0]).map(b => `${b[0]} ${b[1]}`); return bits.length ? bits.join(' · ') : 'nothing had changed'; };
  const row = (type, id, name, sub, buttons) => `<div class="row" data-go="${href(type, id)}"><span class="handle" style="cursor:default"></span><span class="kind ${type}">${KIND[type] || type}</span><div class="title"><div class="name">${esc(name || `${KIND[type] || type} ${id}`)}</div><div class="sub">${sub}</div></div><span class="rowacts">${buttons}</span></div>`;
  const acts = (type, id, name, both) => canEdit() ? `${both ? `<button class="btn sm" data-keep="${type}:${id}" data-name="${esc(name || '')}">Keep CMS version</button>` : ''}<button class="btn sm" data-back="${type}:${id}" data-name="${esc(name || '')}">Hand back to Quickbase</button>` : '';
  const quiet = managed.filter(m => !m.conflict);
  editor.innerHTML = `<div class="crumbs"><span>Quickbase</span></div><div class="edhead"><h1>Quickbase</h1><span class="meta">${last ? `last brought in ${when(last.at)}` : 'not brought in yet'}</span></div>` +
    panel('How the two work side by side', `<div class="help" style="max-width:760px"><p>Quickbase is still the live system. Every night the CMS brings in what changed there, so anything you have not touched here stays the same as Quickbase.</p><p>The moment you save a change to an item here, it is <b>managed in the CMS</b>: the nightly refresh leaves it alone. From then on, edit it here only - a change made to it in Quickbase is not brought in, and the item appears below so someone can choose which version to keep.</p></div>`) +
    panel(`Changed in both places${reviews.length ? ` <span class="pill danger">${reviews.length}</span>` : ''}`, reviews.length ? `<div class="rows qb">${reviews.map(r => row(r.item_type, r.item_id, names.get(`${r.item_type}:${r.item_id}`), `${esc(r.note)} · noticed ${when(r.at)}`, acts(r.item_type, r.item_id, names.get(`${r.item_type}:${r.item_id}`), true))).join('')}</div>` : '<div class="empty">Nothing has been changed in both places.</div>') +
    panel(`Managed in the CMS <span class="muted small">${quiet.length}</span>`, quiet.length ? `<div class="rows qb">${quiet.map(m => row(m.item_type, m.item_id, m.name, `since ${when(m.since)}${m.by ? ' · ' + esc(m.by) : ''}`, acts(m.item_type, m.item_id, m.name, false))).join('')}</div>` : '<div class="empty">Nothing yet. Everything follows Quickbase until someone edits it here.</div>') +
    panel('Recent refreshes', runs.length ? `<div class="rows qb">${runs.map(r => `<div class="row" style="cursor:default"><span class="handle" style="cursor:default"></span><div class="title"><div class="name">${when(r.at)}</div><div class="sub">${line(r)}${r.summary && r.summary.changed_on_both_sides ? ` · ${r.summary.changed_on_both_sides} changed in both places` : ''}</div></div></div>`).join('')}</div><p class="help" style="margin-top:10px"><button class="linkbtn" id="qbChanges">See what Quickbase changed</button> in the Changes list.</p>` : '<div class="empty">No refresh has run yet.</div>');
  editor.querySelectorAll('.row[data-go]').forEach(r => r.addEventListener('click', e => { if (e.target.closest('button')) return; location.hash = r.dataset.go; }));
  const done = async msg => { toast(msg); await loadManaged(); pageQuickbase(); };
  editor.querySelectorAll('[data-keep]').forEach(b => b.addEventListener('click', async () => {
    const [t, id] = b.dataset.keep.split(':');
    if (!confirm(`Keep the CMS version of "${b.dataset.name}"? The change made in Quickbase is not brought in.`)) return;
    try { await rpc('keep_cms', { p_type: t, p_id: +id }); await done('Kept the CMS version'); } catch (e) { toast(e.message, true); }
  }));
  editor.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', async () => {
    const [t, id] = b.dataset.back.split(':');
    if (!confirm(`Hand "${b.dataset.name}" back to Quickbase? Tonight's refresh replaces the CMS version with Quickbase's, and the changes made here are lost.`)) return;
    try { await rpc('hand_back', { p_type: t, p_id: +id }); await done('Handed back. The next refresh brings in the Quickbase version.'); } catch (e) { toast(e.message, true); }
  }));
  const qc = $('#qbChanges'); if (qc) qc.addEventListener('click', () => { PREF.set('changes', { who: 'quickbase' }); location.hash = '#/changes'; });
}
