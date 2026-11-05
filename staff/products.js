// imoves CMS - products v0.1 (increment 5, 5 Nov 2026; design cms/products-design-v0.1.md)
//
// The top of the CMS: what imoves sells. A product page shows one view at a time (Paid, Trial,
// After trial - the Free product has one) as the whole experience of a teacher in it: the home
// screen (a subject), the subject bar and browse list, home sections, the upgrade button and
// banner, the messages for content outside the view, and the content included (subjects, with
// anything unticked inside them). Preview opens the teacher site as a teacher in that view.
// Loaded after cms.js and publish.js.

const VIEW_LABEL = { paid: 'Paid', trial: 'Trial', after_trial: 'After trial', free: 'Free' };
const VIEW_HELP = {
  paid: 'A school with a live subscription to this product.',
  trial: 'A school on the 28-day trial. Starts as a copy of Paid; untick anything the trial should not include.',
  after_trial: 'A school whose trial ended without subscribing: what keeps them coming back, and what nudges them to buy.',
  free: 'A teacher who signed up but never subscribed or trialled.',
};

async function loadProducts() {
  const [products, views] = await Promise.all([get('products?select=*&archived=eq.false&order=sort,name'), get('product_views?select=*')]);
  D.products = products; D.productViews = views; D.productById = index(products);
  D.viewsByProduct = {}; for (const v of views) (D.viewsByProduct[v.product_id] ||= []).push(v);
  for (const k in D.viewsByProduct) D.viewsByProduct[k].sort((a, b) => ['paid', 'trial', 'after_trial', 'free'].indexOf(a.view) - ['paid', 'trial', 'after_trial', 'free'].indexOf(b.view));
}
function renderProductsNav() {
  const box = $('#productsNav'); if (!box || !D.products) return;
  const cur = location.hash;
  const row = p => `<a class="prod ${cur.startsWith(`#/product/${p.id}`) ? 'active' : ''} ${isPub('product', p.id) ? '' : 'off'}" href="#/product/${p.id}">${esc(p.name)}<span class="views">${(D.viewsByProduct[p.id] || []).map(v => `<i class="${isPub('view', v.id) ? '' : 'off'}" title="${VIEW_LABEL[v.view]}${isPub('view', v.id) ? '' : ' (not published)'}">${VIEW_LABEL[v.view][0]}</i>`).join('')}</span></a>`;
  const sell = D.products.filter(p => p.sellable), free = D.products.filter(p => p.code === 'free'), legacy = D.products.filter(p => p.legacy);
  box.innerHTML = `<div class="hint">Products</div>${sell.map(row).join('')}${free.map(row).join('')}${legacy.length ? `<details class="legacy" ${cur.includes('#/product/') && legacy.some(p => cur.startsWith(`#/product/${p.id}`)) ? 'open' : ''}><summary>${ICON.chev}<span class="muted">Legacy products</span><span class="count">${legacy.length}</span></summary>${legacy.map(row).join('')}</details>` : ''}<div class="hint" style="margin-top:14px">All content</div>`;
}

// ---------- the product page ----------
async function pageProduct(id, viewId) {
  const nav = ticket();
  if (!D.products) await loadProducts();
  const [row] = await get(`products?id=eq.${id}&select=*`); if (stale(nav)) return; if (!row) return notFound();
  const views = await get(`product_views?product_id=eq.${id}&select=*`); if (stale(nav)) return;
  views.sort((a, b) => ['paid', 'trial', 'after_trial', 'free'].indexOf(a.view) - ['paid', 'trial', 'after_trial', 'free'].indexOf(b.view));
  PAGE = { type: 'product', id, row, dirty: {}, views, view: views.find(v => v.id === viewId) || views[0], reload: () => pageProduct(id, PAGE.view && PAGE.view.id) };
  const pk = await get(`packages?product_id=eq.${id}&select=*&order=live_subs.desc.nullslast,name`); if (stale(nav)) return;
  const subs = pk.reduce((n, p) => n + (p.live_subs || 0), 0);
  editor.innerHTML = pageHeader([{ name: 'Products', href: '#/' }, { name: row.name }], { subtitle: row.sellable ? 'sellable' : row.legacy ? 'legacy' : '' }) +
    panel('', `<div class="vtabs prodtabs" id="viewTabs"></div><div id="viewBox"></div>`) +
    panel('Details', `<div class="grid">${field('name', 'Name')}${field('code', 'Code', { help: 'Used by the website and accounts; change with care.' })}${field('trial_days', 'Trial length (days)', { type: 'number' })}<div class="span">${field('description', 'Description (for staff)', { type: 'textarea', rows: 2 })}</div>
      <div class="span" style="display:flex;gap:24px;flex-wrap:wrap">${field('sellable', 'One of the five products sold on the website', { type: 'switch' })}${field('legacy', 'Legacy: kept so existing subscriptions work', { type: 'switch' })}</div></div>`) +
    panel(`Packages that attach to this product <span class="muted">${pk.length} · ${subs} live subscriptions</span>`, `<div class="help" style="margin-bottom:8px">The Quickbase packages accounts attach to a school. Infant, junior and primary are age forms of the same experience; only the age rights differ.</div><div class="rows">${pk.map(p => `<div class="row" style="cursor:default"><span class="handle" style="cursor:default"></span><div class="title"><div class="name">${esc(p.name || '')}</div><div class="sub">${esc(p.kind || '')} · ${esc(p.age_form)}${p.is_trial ? ' · trial' : ''}${p.is_legacy ? ' · legacy shape' : ''}${p.note ? ' · ' + esc(p.note) : ''}</div></div><span class="muted small">${p.live_subs || 0} live</span></div>`).join('') || '<div class="empty">No packages map onto this product yet.</div>'}</div>`);
  finish([]);
  renderViewTabs(); await renderView();
}
function renderViewTabs() {
  const box = $('#viewTabs'); const vs = PAGE.views;
  box.innerHTML = vs.map(v => `<button class="${PAGE.view && v.id === PAGE.view.id ? 'active' : ''}" data-v="${v.id}">${VIEW_LABEL[v.view]}${isWaiting('view', v.id) ? ' <span class="dot" title="Changes not yet published"></span>' : ''}${isPub('view', v.id) ? '' : ' <span class="muted small">(hidden)</span>'}</button>`).join('') +
    (canEdit() && !vs.some(v => v.view === 'trial') && PAGE.row.code !== 'free' ? `<button class="btn sm quiet" data-v="new-trial">${ICON.plus} Trial view</button>` : '');
  box.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.v === 'new-trial') { try { const paid = vs.find(v => v.view === 'paid') || {}; const { id, created_at, updated_at, view, ...rest } = paid; const v = await insert('product_views', { ...rest, product_id: PAGE.id, view: 'trial' }); PAGE.views.push(v); PAGE.view = v; renderViewTabs(); await renderView(); toast('Trial view added as a copy of Paid'); } catch (e) { toast(e.message, true); } return; }
    PAGE.view = vs.find(v => v.id === +b.dataset.v); renderViewTabs(); await renderView();
  }));
}
// One view: the experience, edited in place (each change saves the view straight away).
async function renderView() {
  const v = PAGE.view; const box = $('#viewBox');
  if (!v) { box.innerHTML = '<div class="empty">No views yet.</div>'; return; }
  const subjects = D.subjects.filter(s => !s.archived);
  const name = id => (D.subjectById[id] || {}).name || `Subject ${id}`;
  const home = D.subjectById[v.home_subject_id];
  const chips = (key, label, help) => `<div class="field span"><label>${esc(label)}</label><div class="chiprow" data-list="${key}">${(v[key] || []).filter((x, i, a) => a.indexOf(x) === i).map(id => `<span class="chip on" data-id="${id}">${canEdit() ? `<span class="handle">${ICON.drag}</span>` : ''}${esc(name(id))}${canEdit() ? `<button type="button" class="x" data-rm="${id}" title="Remove">×</button>` : ''}</span>`).join('')}${canEdit() ? `<button type="button" class="chip add" data-addto="${key}">${ICON.plus} Add subject</button>` : ''}</div><div class="help">${help}</div></div>`;
  const stat = isPub('view', v.id) ? (isWaiting('view', v.id) ? '<span class="pill pending">changes not yet published</span>' : '<span class="pill live">published</span>') : '<span class="pill hidden">not published</span>';
  box.innerHTML = `<div class="subpanel"><div class="viewhead"><div><b>${VIEW_LABEL[v.view]}</b> <span class="muted">${esc(VIEW_HELP[v.view])}</span></div><div class="actions">${stat}${previewMenuFor(v)}${canEdit() ? `<button class="btn primary sm" id="pubView" ${isPub('view', v.id) && !isWaiting('view', v.id) ? 'disabled' : ''}>Publish this view</button>${isPub('view', v.id) ? `<button class="btn sm" id="unpubView">Hide</button>` : ''}` : ''}</div></div>
    <div class="grid" style="margin-top:12px">
      <div class="field span"><label>Home screen</label><div class="achip compact"><span class="athumb ph">🏠</span><div class="ameta">${home ? `<b><a href="${href('subject', home.id)}">${esc(home.name)}</a></b><span>A subject: its groups, categories, featured video and tiles are edited on its page.</span>` : '<b class="muted">No home screen chosen</b><span>Teachers land on the first subject in the bar.</span>'}</div>${canEdit() ? `<div class="abtns"><button class="btn sm" id="pickHome">${home ? 'Change' : 'Choose'}</button>${home ? `<button class="btn sm" data-go="${href('subject', home.id)}">Open</button>` : ''}</div>` : ''}</div></div>
      ${chips('subject_bar', 'Subject bar', 'The buttons across the top of every page, in this order.')}
      ${chips('browse_list', 'Browse', 'The subjects in the Browse page, in this order.')}
      ${chips('home_sections', 'Home page sections', 'Only used when there is no home screen: the subject cards on the carousel home.')}
      <div class="span"><div class="subhead">Content included</div>
        <div class="chips" style="margin-bottom:8px"><label class="chip"><input type="checkbox" data-vf="all_content" ${v.all_content ? 'checked' : ''}> Everything (all subjects, all ages)</label></div>
        <div id="viewSubjects" ${v.all_content ? 'hidden' : ''}><div class="chips">${subjects.map(s => `<label class="chip"><input type="checkbox" data-subj="${s.id}" ${(v.subject_ids || []).includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div><div class="help">Tick the subjects a teacher in this view can open. ${v.view === 'trial' || v.view === 'after_trial' ? 'To leave out part of a subject, untick groups, categories, schemes or lessons below.' : ''}</div>
        ${v.view !== 'paid' ? `<details style="margin-top:8px" ${(await excludedCount(v)) ? 'open' : ''}><summary class="muted small" style="cursor:pointer">Leave out parts of the included subjects (${await excludedCount(v)} left out)</summary><div id="exclTree" class="excltree"></div></details>` : ''}</div></div>
      <div class="span"><div class="subhead">When a teacher reaches content outside this view</div><div class="grid">
        <div class="span" style="display:flex;gap:24px;flex-wrap:wrap"><label class="sw field-sw"><input type="checkbox" data-vf="show_upgrade" ${v.show_upgrade ? 'checked' : ''}> <span>Show the orange Upgrade button</span></label><label class="sw field-sw"><input type="checkbox" data-vf="banner_show" ${v.banner_show ? 'checked' : ''}> <span>Show the sticky banner</span></label></div>
        <div class="field"><label>Upgrade button text</label><input type="text" data-vf="upgrade_text" value="${esc(v.upgrade_text)}" placeholder="Upgrade"></div>
        <div class="field"><label>Lesson message (a locked lesson)</label><input type="text" data-vf="lesson_message_1" value="${esc(v.lesson_message_1)}" placeholder="This lesson isn’t included in your subscription."></div>
        <div class="field"><label>Scheme message (a locked scheme)</label><input type="text" data-vf="scheme_message_1" value="${esc(v.scheme_message_1)}"></div>
        <div class="field"><label>Second line (optional)</label><input type="text" data-vf="lesson_message_2" value="${esc(v.lesson_message_2)}"></div>
        <div class="field span" data-banner ${v.banner_show ? '' : 'hidden'}><label>Banner text</label>${rteHtml('data-vrte="banner_text"', v.banner_text, 'The sticky banner at the bottom of every page')}</div>
        <div class="field" data-banner ${v.banner_show ? '' : 'hidden'}><label>Banner colours (text / background / border)</label><div style="display:flex;gap:8px"><input type="text" data-vf="banner_colour" value="${esc(v.banner_colour)}" placeholder="#ffffff" style="flex:1"><input type="text" data-vf="banner_background" value="${esc(v.banner_background)}" placeholder="#733088" style="flex:1"><input type="text" data-vf="banner_border" value="${esc(v.banner_border)}" placeholder="#733088" style="flex:1"></div></div>
      </div></div>
    </div></div>`;
  bindPreviewMenuFor(box, v);
  box.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  if (!canEdit()) { box.querySelectorAll('input,[contenteditable]').forEach(x => { x.disabled = true; x.removeAttribute('contenteditable'); }); }
  const saveView = async body => { try { Object.assign(v, await patch('product_views', v.id, body)); D.waitSet.add(`view:${v.id}`); const pb = $('#pubView'); if (pb) pb.disabled = false; toast('Saved'); refreshStatus(); return true; } catch (e) { toast(e.message, true); return false; } };
  // chips: drag, remove, add
  box.querySelectorAll('[data-list]').forEach(list => {
    const key = list.dataset.list;
    const ids = () => [...list.querySelectorAll('.chip.on')].map(c => +c.dataset.id);
    if (canEdit()) new Sortable(list, { handle: '.handle', draggable: '.chip.on', animation: 150, onEnd: () => saveView({ [key]: ids() }) });
    list.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => { if (await saveView({ [key]: ids().filter(x => x !== +b.dataset.rm) })) renderView(); }));
    const add = list.querySelector('[data-addto]'); if (add) add.addEventListener('click', () => pickerModal('Add a subject', 'subject', async sid => { if (await saveView({ [key]: [...ids(), sid] })) renderView(); }, new Set(ids())));
  });
  const ph = $('#pickHome'); if (ph) ph.addEventListener('click', () => pickerModal('Choose the home screen', 'subject', async sid => { if (await saveView({ home_subject_id: sid })) renderView(); }));
  box.querySelectorAll('[data-vf]').forEach(el => el.addEventListener('change', debounce(async () => {
    const k = el.dataset.vf; const val = el.type === 'checkbox' ? el.checked : (el.value || null);
    if (await saveView({ [k]: val })) { if (k === 'all_content') renderView(); if (k === 'banner_show') box.querySelectorAll('[data-banner]').forEach(x => x.hidden = !val); }
  }, 200)));
  box.querySelectorAll('[data-subj]').forEach(cb => cb.addEventListener('change', async () => { if (await saveView({ subject_ids: [...box.querySelectorAll('[data-subj]:checked')].map(x => +x.dataset.subj) })) renderExclusions(v); }));
  const br = box.querySelector('[data-vrte]'); if (br) wireRte(br, debounce(h => { if ((h || null) !== (v.banner_text || null)) saveView({ banner_text: h }); }, 500));
  const pub = $('#pubView'); if (pub) pub.addEventListener('click', async () => { if (await publishDialog('view', v.id, `${PAGE.row.name} · ${VIEW_LABEL[v.view]}`, false)) { await reloadTree(); renderViewTabs(); renderView(); } });
  const un = $('#unpubView'); if (un) un.addEventListener('click', async () => { if (await unpublishDialog('view', v.id, `${PAGE.row.name} · ${VIEW_LABEL[v.view]}`)) { await reloadTree(); renderViewTabs(); renderView(); } });
  if (v.view !== 'paid' && !v.all_content) renderExclusions(v);
}
async function excludedCount(v) { v._excl ||= await get(`view_exclusions?view_id=eq.${v.id}&select=item_type,item_id`); return v._excl.length; }
// The included subjects as a tree of groups > categories > schemes/lessons, each with a tick.
async function renderExclusions(v) {
  const box = $('#exclTree'); if (!box) return;
  const excl = new Set((await excludedCount(v), v._excl).map(x => `${x.item_type}:${x.item_id}`));
  const tick = (t, id, name, cls = '') => `<label class="${cls}"><input type="checkbox" data-ex="${t}:${id}" ${excl.has(`${t}:${id}`) ? '' : 'checked'} ${canEdit() ? '' : 'disabled'}> ${esc(name)}</label>`;
  let h = '';
  for (const sid of (v.subject_ids || [])) {
    const s = D.subjectById[sid]; if (!s) continue;
    h += `<details><summary>${esc(s.name)}</summary>`;
    for (const gp of kids('subject', sid)) { const g = D.groupById[gp.child_id]; if (!g) continue;
      h += `<details class="l2"><summary>${tick('group', g.id, g.name)}</summary>`;
      for (const cp of kids('group', g.id)) { const c = D.catById[cp.child_id]; if (!c) continue;
        h += `<details class="l3" data-cat="${c.id}"><summary>${tick('category', c.id, c.name)}</summary><div class="l4" data-cat-items="${c.id}"><span class="muted small">Loading…</span></div></details>`; }
      h += '</details>'; }
    h += '</details>';
  }
  box.innerHTML = h || '<div class="empty">Tick some subjects first.</div>';
  const loadCat = async el => { const cid = +el.dataset.cat; const items = el.querySelector('[data-cat-items]'); if (items.dataset.loaded) return; items.dataset.loaded = '1';
    const rows = await childRows('category', cid);
    items.innerHTML = rows.filter(x => ['scheme', 'lesson'].includes(x.p.child_type)).map(x => tick(x.p.child_type, x.p.child_id, x.item.name, 'l4item')).join('') || '<span class="muted small">Nothing placed here.</span>';
    bindTicks(items); };
  box.querySelectorAll('details[data-cat]').forEach(el => el.addEventListener('toggle', () => { if (el.open) loadCat(el); }));
  const bindTicks = root => root.querySelectorAll('[data-ex]').forEach(cb => cb.addEventListener('change', async () => {
    const [t, id] = cb.dataset.ex.split(':');
    try { if (cb.checked) await del('view_exclusions', `view_id=eq.${v.id}&item_type=eq.${t}&item_id=eq.${id}`); else await insert('view_exclusions', { view_id: v.id, item_type: t, item_id: +id });
      v._excl = null; await patch('product_views', v.id, { updated_at: new Date().toISOString() }); D.waitSet.add(`view:${v.id}`); const pb = $('#pubView'); if (pb) pb.disabled = false; toast('Saved'); }
    catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  }));
  bindTicks(box);
}
// Preview as a teacher in this view (the teacher site reads the draft view by id).
function previewMenuFor(v) {
  return `<div class="menu" id="pvMenu-${v.id}"><button class="btn sm" data-addbtn>Preview as this view ▾</button><div class="items"><button data-pv="draft">Draft content</button><button data-pv="published">Published content</button><hr><div class="agesrow">Ages <select data-pvages><option value="">infant, junior and primary (all)</option><option value="4-7">infant (4-7)</option><option value="7-11">junior (7-11)</option></select></div></div></div>`;
}
function bindPreviewMenuFor(root, v) {
  const menu = root.querySelector(`#pvMenu-${v.id}`); if (!menu) return;
  menu.querySelector('[data-addbtn]').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
  menu.querySelector('[data-pvages]').addEventListener('click', e => e.stopPropagation());
  menu.querySelectorAll('[data-pv]').forEach(b => b.addEventListener('click', () => {
    menu.classList.remove('open'); const ages = menu.querySelector('[data-pvages]').value;
    const q = new URLSearchParams({ content: b.dataset.pv, view: v.id }); if (ages) q.set('ages', ages); q.set('v', Date.now().toString(36));
    window.open(`${TEACHER_URL}?${q}#/`, 'imoves-preview');
  }));
  document.addEventListener('click', () => menu.classList.remove('open'));
}

// ---------- the products overview (home page of the CMS) ----------
async function pageProducts() {
  const nav = ticket();
  PAGE = { type: null, dirty: {}, reload: pageProducts };
  if (!D.products) await loadProducts();
  const pk = await get('packages?select=product_id,live_subs'); if (stale(nav)) return;
  const subs = {}; for (const p of pk) subs[p.product_id] = (subs[p.product_id] || 0) + (p.live_subs || 0);
  const name = id => (D.subjectById[id] || {}).name || '';
  const card = p => { const vs = D.viewsByProduct[p.id] || []; return `<div class="prodcard ${isPub('product', p.id) ? '' : 'off'}" data-go="#/product/${p.id}"><div class="ph"><b>${esc(p.name)}</b><span class="muted small">${subs[p.id] || 0} live subscriptions</span></div><div class="pv">${vs.map(v => `<div><span class="pill ${isPub('view', v.id) ? 'live' : 'hidden'}">${VIEW_LABEL[v.view]}</span> <span class="muted small">${v.home_subject_id ? 'home: ' + esc(name(v.home_subject_id)) : 'no home screen'} · ${v.all_content ? 'everything' : (v.subject_ids || []).length + ' subjects'}${(v.subject_bar || []).length ? ' · bar: ' + v.subject_bar.length : ''}</span></div>`).join('')}</div></div>`; };
  editor.innerHTML = `<div class="crumbs"><span>Products</span></div><div class="edhead"><h1>Products</h1><span class="meta">What imoves sells, and what a teacher in each lands on</span>${canEdit() ? `<div class="actions"><button class="btn" id="newProduct">${ICON.plus} New product</button></div>` : ''}</div>` +
    panel('The five products', `<div class="prodgrid">${D.products.filter(p => p.sellable).map(card).join('')}</div>`) +
    panel('Free, and legacy products', `<div class="help" style="margin-bottom:10px">Free is what a teacher who never subscribed sees. Legacy products are kept so existing subscriptions keep working; they are not sold.</div><div class="prodgrid">${D.products.filter(p => !p.sellable).map(card).join('')}</div>`);
  editor.querySelectorAll('[data-go]').forEach(c => c.addEventListener('click', () => location.hash = c.dataset.go));
  const np = $('#newProduct'); if (np) np.addEventListener('click', () => askName('New product', async n => { try { const p = await insert('products', { name: n, code: n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), sort: 50 }); for (const vw of ['paid', 'trial', 'after_trial']) await insert('product_views', { product_id: p.id, view: vw }); D.products = null; await reloadTree(); location.hash = `#/product/${p.id}`; } catch (e) { toast(e.message, true); } }));
}
