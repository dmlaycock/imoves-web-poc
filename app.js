// ---------- data access (PostgREST) ----------
// Signed in, requests carry the user's token (role authenticated); the key alone is the
// read-only anon role. Publishable keys (sb_publishable_...) go in the apikey header
// only; legacy anon JWTs also as a bearer token.
function apiHeaders() {
  const headers = { apikey: SUPABASE_KEY };
  const t = Auth.accessToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  else if (!SUPABASE_KEY.startsWith('sb_')) headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  if (SUPABASE_SCHEMA && !SUPABASE_SCHEMA.startsWith('__')) headers['Accept-Profile'] = SUPABASE_SCHEMA;
  return headers;
}
async function restFetch(path, init) {
  let r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...apiHeaders(), ...(init && init.headers) } });
  if (r.status === 401 && Auth.accessToken() && await Auth.refresh()) {
    r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...apiHeaders(), ...(init && init.headers) } });
  }
  return r;
}
async function rest(path, { all = false } = {}) {
  if (!all) {
    const r = await restFetch(path);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }
  const out = []; let from = 0; const page = 1000;
  for (;;) {
    const r = await restFetch(path, { headers: { Range: `${from}-${from + page - 1}` } });
    if (!r.ok && r.status !== 206) throw new Error(`${path}: ${r.status}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < page) break; from += page;
  }
  return out;
}
// Call a database function (used for login logging and the single-session check).
async function rpc(name, args) {
  const r = await restFetch(`rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const D = {}; // in-memory copy of the tree
async function loadTree() {
  const [subjects, subgroups, subcategories, schemes, links, lessons] = await Promise.all([
    rest('subjects?select=*&order=order', { all: true }),
    rest('subgroups?select=*&order=order', { all: true }),
    rest('subcategories?select=id,name,order,homepage_order,image,background_image_url,description,subheading,is_live,is_schemes,is_direct_resource,is_redirect_to_category,is_redirect_to_lesson,is_redirect_to_url,direct_resource_heading_all,direct_resource_heading_paid,direct_resource_text_all,direct_resource_text_paid,direct_resource_wistia_id_all,direct_resource_wistia_id_paid,direct_resource_wistia_duration_all,direct_resource_wistia_duration_paid,is_direct_resource_linked,direct_resource_link_text,direct_resource_link_url,subject_id,subgroup_id,subcategory_redirect_id,lesson_redirect_id,url_redirect,content_noun_derived_plural,content_noun_derived_singular,is_visible_on_homepage&order=order', { all: true }),
    rest('schemes?select=id,name,subheading,description,body_opening_text,body_closing_text,body_subheading_1,body_subheading_1_text,body_subheading_2,body_subheading_2_text,body_subheading_3,body_subheading_3_text,is_live,is_freemium,image,order', { all: true }),
    rest('scheme_subcategories?select=*', { all: true }),
    rest('lessons?select=id,name,is_live,scheme_id,order,description,is_freemium,age_min,age_max,duration,has_video,has_audio,has_downloads,has_slides,has_lesson_plan,has_assessment_template&order=order', { all: true }),
  ]);
  D.subjects = subjects.filter(s => s.is_live);
  D.subgroups = subgroups.filter(s => s.is_live);
  D.subcategories = subcategories.filter(s => s.is_live);
  D.schemes = schemes.filter(s => s.is_live);
  D.lessons = lessons.filter(l => l.is_live);
  D.subjectById = index(D.subjects); D.subgroupById = index(D.subgroups); D.subcatById = index(D.subcategories);
  D.schemeById = index(D.schemes); D.lessonById = index(D.lessons);
  D.lessonsByScheme = group(D.lessons, 'scheme_id');
  D.schemesBySubcat = {}; D.subcatsByScheme = {};
  for (const l of links) {
    const s = D.schemeById[l.scheme_id]; if (!s) continue;
    (D.schemesBySubcat[l.subcategory_id] ||= []).push(s);
    (D.subcatsByScheme[l.scheme_id] ||= []).push(l.subcategory_id);
  }
  for (const k in D.schemesBySubcat) D.schemesBySubcat[k].sort(byOrder);
  D.subgroupsBySubject = group(D.subgroups, 'subject_id');
  D.subcatsBySubgroup = group(D.subcategories, 'subgroup_id');
  D.loadedAt = new Date();
}
const index = rows => Object.fromEntries(rows.map(r => [r.id, r]));
function group(rows, key) { const g = {}; for (const r of rows) (g[r[key]] ||= []).push(r); return g; }
const byOrder = (a, b) => (a.order ?? 1e12) - (b.order ?? 1e12) || String(a.name || '').localeCompare(String(b.name || ''));

// ---------- entitlements (Phase 1 increment 2) ----------
// Mirrors the live platform's SubjectPolicy and LessonPolicy (app/Subjects/Policies,
// app/Lessons/Policies) using the per-user fields from web_me(). Applied client-side
// for now; API-level enforcement comes at cutover, when anon read of the content
// tables (which the CMS PoC still relies on) is withdrawn.
const E = {};
function initEntitlements() {
  const m = Auth.me() || {};
  E.allContent = !!m.all_content; E.allSubjects = !!m.all_subjects;
  E.allAges = !!m.all_ages; E.ageRights = m.age_rights || [];
  E.subjectIds = new Set([...(m.subject_ids || []), ...(m.niche_subject_ids || [])]);
  E.freeAll = !!m.free_all; E.trialAll = !!m.trial_all; E.payingAll = !!m.paying_all;
  E.homepage = m.homepage_subject_id || null;
  E.buttons = m.subject_button_ids || []; E.browse = m.browse_menu_ids || [];
  E.homeSections = m.home_section_ids || [];
  E.lessonMessage = m.lesson_message_1 || 'This lesson isn’t included in your subscription.';
  E.upgradeText = m.lesson_upgrade_button_text || 'Upgrade';
  E.showUpgrade = !!m.show_upgrade_button;
}
// SubjectPolicy::view
function canViewSubject(s) {
  return !!(s.show_all || (s.show_free && E.freeAll) || (s.show_trial && E.trialAll) || (s.show_paying && E.payingAll));
}
function lessonSubjects(l) {
  return (D.subcatsByScheme[l.scheme_id] || []).map(id => D.subcatById[id] && D.subcatById[id].subject_id).filter(Boolean);
}
// LessonPolicy::access (with age filters)
function canAccessLesson(l) {
  if (l.is_freemium || E.allContent) return true;
  if (!E.allSubjects && !lessonSubjects(l).some(id => E.subjectIds.has(id))) return false;
  if (E.allAges) return true;
  if (l.age_min == null) return false;
  return E.ageRights.some((on, k) => on && l.age_min <= 4 + k && l.age_max >= 5 + k);
}
const col = v => (v ? (/^(#|rgb|hsl)/.test(v) ? v : '#' + v) : '');
// The strip next to the logo (school and class name, as the live header), the orange
// Upgrade button and the per-user sticky banner.
function renderUserContext() {
  const m = Auth.me() || {};
  const ctx = document.getElementById('userctx');
  if (ctx) ctx.innerHTML = esc(m.school_name || '') + ' <span class="text-light-purple">' + (m.class_name ? esc(m.class_name) : '<a class="text-light-purple text-decoration-none" href="#/profile">Enter your class name</a>') + '</span>';
  const up = document.getElementById('upgradebtn');
  if (up) up.classList.toggle('hidden', !E.showUpgrade);
  const bn = document.getElementById('stickybanner');
  if (bn) {
    if (m.banner_show && m.banner_text) {
      bn.classList.remove('hidden');
      bn.textContent = m.banner_text;
      bn.style.color = col(m.banner_color); bn.style.background = col(m.banner_background);
      bn.style.borderColor = col(m.banner_border);
    } else bn.classList.add('hidden');
  }
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Body text: escape everything, then let through the few harmless tags staff use in Quickbase
// (icon <i class="bi-...">, <b>, <strong>, <em>, <br>), as the current site renders these fields unescaped.
const nl = s => esc(s).trim()
  .replace(/&lt;i class=&quot;((?:bi )?bi-[a-z0-9-]+)&quot;&gt;\s*&lt;\/i&gt;/g, '<i class="$1"></i>')
  .replace(/&lt;(\/?)(b|strong|em)&gt;/g, '<$1$2>')
  .replace(/&lt;br ?\/?&gt;/g, '<br>');
const img = p => p ? (p.startsWith('http') ? p : CF + p) : CF + 'defaultimages/default_s.png';
const limit = (s, n) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');
function schemeLessons(scheme) { return (D.lessonsByScheme[scheme.id] || []); }
function subcatLessons(sc) { return (D.schemesBySubcat[sc.id] || []).flatMap(schemeLessons); }
function ageRange(lessons) {
  const mins = lessons.map(l => l.age_min).filter(Number.isFinite), maxs = lessons.map(l => l.age_max).filter(Number.isFinite);
  if (!mins.length) return null; return `${Math.min(...mins)}-${Math.max(...maxs)}`;
}
function lessonAges(l) { return l.age_min != null ? `${l.age_min}-${l.age_max}` : null; }
// Age strip: pills 4-11, lit between min and max inclusive (the way the Quickbase ages column reads)
function ageStrip(min, max, cls = '') {
  if (min == null) return '';
  let h = '';
  for (let a = 4; a <= 11; a++) h += `<b class="${a >= min && a <= max ? 'on' : ''}" aria-hidden="true">${a}</b>`;
  return `<span class="ages ${cls}" title="Ages ${min}-${max}" role="img" aria-label="Ages ${min} to ${max}">${h}</span>`;
}
function ageStripRange(r, cls = '') { if (!r) return ''; const [a, b] = r.split('-').map(Number); return ageStrip(a, b, cls); }
// "My class" preference: the current site's age filter rebuilt as a browser-side preference
function classAge() { try { const v = localStorage.getItem('imoves.classAge'); return v ? +v : null; } catch (e) { return null; } }
function coversClass(range) { const a = classAge(); if (a == null || !range) return false; const [lo, hi] = range.split('-').map(Number); return lo <= a && a + 1 <= hi; }
function noun(sc, n) { return n === 1 ? (sc.content_noun_derived_singular || 'lesson') : (sc.content_noun_derived_plural || 'lessons'); }
function visibleSubcats(sg) {
  return (D.subcatsBySubgroup[sg.id] || []).filter(sc => sc.is_visible_on_homepage && ((D.schemesBySubcat[sc.id] || []).length > 0 || !sc.is_schemes)).sort(byOrder);
}
function subcatIsFree(sc) { return (D.schemesBySubcat[sc.id] || []).some(s => s.is_freemium); }
function subcatHref(sc) { return `#/subject/${sc.subject_id}/subcategory/${sc.id}`; }
function lessonHref(l, sc) { return `#/lesson/${l.id}` + (sc ? `?sc=${sc.id}` : ''); }
function wistia(id) { return `<div class="wistia-ratio videobox"><iframe src="https://fast.wistia.net/embed/iframe/${esc(id)}?videoFoam=true" allow="autoplay; fullscreen" allowfullscreen title="Video"></iframe></div>`; }
function setBg(url) { document.body.style.backgroundImage = url ? `url('${url.replace(/ /g, '%20')}')` : ''; document.body.classList.toggle('with-bg-img', !!url); }

// ---------- routing ----------
const app = document.getElementById('app-page');
function reveal() { app.classList.remove('reveal'); void app.offsetWidth; app.classList.add('reveal'); }
window.addEventListener('hashchange', route);
async function route() {
  const hash = location.hash.slice(1) || '/';
  const [pathPart, query = ''] = hash.split('?');
  const qs = Object.fromEntries(new URLSearchParams(query));
  const p = pathPart.split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (p[0] || 'home')));
  document.querySelectorAll('#scrollable-navbar .subject-button').forEach(a => a.classList.toggle('active', p[0] === 'subject' && a.dataset.id === p[1]));
  const subj = p[0] === 'subject' ? D.subjectById[+p[1]] : null;
  const an = document.getElementById('agenoun'); if (an) an.textContent = subj && subj.name === 'Active Blasts' ? 'activities' : 'lessons';   // Subject::lessonLabel() - hard-coded on the live site
  const hf = document.getElementById('headerfilter'); if (hf) hf.classList.toggle('hidden', p[0] === 'search' || p[0] === 'curriculum' || p[0] === 'profile');
  window.scrollTo(0, 0);
  try {
    if (p[0] === 'login') { location.reload(); return; }   // a Quickbase passcode link opened in a signed-in tab: Auth.init() handles it
    if (!p.length) return pageHome();
    if (p[0] === 'subject' && p[2] === 'subcategory') return pageSubcategory(+p[1], +p[3]);
    if (p[0] === 'subject') return pageSubject(+p[1]);
    if (p[0] === 'lesson' && p[2] === 'history') return pageLessonHistory(+p[1]);
    if (p[0] === 'lesson') return pageLesson(+p[1], qs.sc ? +qs.sc : null);
    if (p[0] === 'search') return pageSearch(qs.q || '');
    if (p[0] === 'browse') { openBrowse(); history.replaceState(null, '', location.pathname + location.search + '#/'); return; }
    if (p[0] === 'favourites') return pageFavourites();
    if (p[0] === 'curriculum') return pageCurriculum();
    if (p[0] === 'profile') return pageProfile();
    if (p[0] === 'upgrade') { app.innerHTML = '<div class="notice">The upgrade options page arrives with Phase 2 of the rebuild.</div>'; return; }
    app.innerHTML = `<div class="notice">Page not found.</div>`;
  } catch (e) { app.innerHTML = `<div class="notice">Something went wrong: ${esc(e.message)}</div>`; }
}

// ---------- pages ----------
function renderSubjectBar() {
  // The live bar is the user's own list (Users fid 918) filtered by SubjectPolicy.
  const subjects = D.subjects.filter(s => E.buttons.includes(s.id) && canViewSubject(s)).sort(byOrder);
  document.getElementById('scrollable-navbar').innerHTML = subjects.map(s =>
    `<div class="p-1 flex-even"><a href="#/subject/${s.id}" data-id="${s.id}" class="subject-button d-flex link align-items-center text-nowrap p-2" style="background-color: #${esc(s.button_colour || '733088')}"><span class="button-text text-center w-100 text-1">${esc(s.name)}</span></a></div>`).join('');
  document.getElementById('subjectnav').classList.toggle('hidden', subjects.length < 2);
  setTimeout(() => { const n = document.getElementById('scrollable-navbar'); if (n) n.dispatchEvent(new Event('scroll')); }, 0);
}

// Menu dropdown: nav/partials/user-info.blade.php. Items whose pages are not built yet still
// appear, as on the live site, and land on a short notice.
function renderUserMenu() {
  const m = Auth.me() || {};
  const item = (href, label, extra = '') => `<a href="${href}" class="dropdown-item btn btn-secondary pl-3 pe-4 shadow-none" ${extra}>${label}</a>`;
  const div = '<div class="dropdown-divider"></div>';
  let html = item('#/', 'Home') + div + item('#/search', 'Search') + item('#/favourites', 'Favourites') + item('#/curriculum', 'Curriculum') + div +
    item('#/profile', 'My Profile') + item(m.is_admin ? '#/school-management' : '#/my-school', m.is_admin ? 'School Management' : 'My School') +
    (E.showUpgrade ? item('#/upgrade', 'Upgrade') : '') + div + item('https://imoves.com/help', 'Help', 'target="_blank" rel="noopener"') + div +
    `<button type="button" class="dropdown-item btn btn-secondary shadow-none pl-3 pe-4" id="logoutbtn">Log Out</button>`;
  const menu = document.getElementById('usermenu'); menu.innerHTML = html;
  menu.querySelector('#logoutbtn').addEventListener('click', () => Auth.signOut('bye'));
  const btn = document.getElementById('dropdownMenuButton');
  if (!btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('show'); });
    document.addEventListener('click', () => menu.classList.remove('show'));
    menu.addEventListener('click', () => menu.classList.remove('show'));
  }
}

// Browse modal: nav/partials/browser.blade.php + subject-group-panels.blade.php.
function renderBrowse() {
  const subjects = D.subjects.filter(s => s.is_browsable && E.browse.includes(s.id) && canViewSubject(s)).sort((a, b) => (a.browse_order ?? 999) - (b.browse_order ?? 999));
  const tabs = [], panes = [];
  subjects.forEach((s, i) => {
    const sgs = (D.subgroupsBySubject[s.id] || []).sort(byOrder).map(sg => ({ sg, subcats: visibleSubcats(sg) })).filter(x => x.subcats.length);
    if (!sgs.length) return;
    const on = tabs.length === 0 ? ' active' : '';
    tabs.push(`<a class="list-group-item list-group-item-action cursor-pointer text-truncate${on}" data-pane="${s.id}" role="tab"><i class="${esc(cleanIcon(s.icon) || 'bi-flag')} text-primary me-2 d-none d-sm-inline"></i> ${esc(s.name)}</a>`);
    panes.push(`<div class="tab-pane py-4 px-3${on}" data-pane="${s.id}" role="tabpanel">
      <div class="row"><div class="col-12 title"><a class="h4 text-primary" href="#/subject/${s.id}">${esc(s.name)}</a><button type="button" class="btn-close float-end text-primary" data-close aria-label="Close"></button><hr class="mt-2"></div></div>
      <div class="card-columns subject-subgroup-columns">` + sgs.map(({ sg, subcats }) =>
        `<div class="card w-100 d-inline-block bg-transparent border-0 my-2"><div class="card-body p-0"><ul class="list-unstyled"><li class="h6 text-primary"><a class="text-primary" href="#/subject/${s.id}">${esc(sg.name)}</a></li>` +
        subcats.map(sc => `<li class="mb-1"><a class="text-mid-purple fw-light" href="${subcatHref(sc)}">${esc(sc.name)}</a></li>`).join('') + `</ul></div></div>`).join('') + `</div></div>`);
  });
  document.getElementById('browse-tabs').innerHTML = tabs.join('');
  document.getElementById('browse-panes').innerHTML = panes.join('');
  const modal = document.getElementById('subject-browse-modal');
  modal.querySelectorAll('#browse-tabs a').forEach(a => a.addEventListener('click', () => {
    modal.querySelectorAll('#browse-tabs a, #browse-panes .tab-pane').forEach(el => el.classList.toggle('active', el.dataset.pane === a.dataset.pane));
  }));
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeBrowse));
  modal.querySelectorAll('#browse-panes a[href]').forEach(a => a.addEventListener('click', closeBrowse));
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.addEventListener('click', e => { if (e.target === modal) closeBrowse(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeBrowse(); hideModal('search-modal'); } });
    document.getElementById('browsebtn').addEventListener('click', openBrowse);
  }
  document.getElementById('browsebtnwrap').classList.toggle('hidden', !tabs.length);
}
// Modals (live: Bootstrap). One small helper here instead of the Bootstrap JS bundle.
function showModal(id) {
  const m = document.getElementById(id);
  m.style.display = 'block'; document.body.classList.add('modal-open');
  requestAnimationFrame(() => m.classList.add('show'));
  let bd = document.getElementById('poc-backdrop');
  if (!bd) { bd = document.createElement('div'); bd.id = 'poc-backdrop'; bd.className = 'modal-backdrop fade show'; document.body.appendChild(bd); }
  bd.onclick = () => hideModal(id);
}
function hideModal(id) {
  const m = document.getElementById(id);
  m.classList.remove('show'); m.style.display = 'none'; document.body.classList.remove('modal-open');
  const bd = document.getElementById('poc-backdrop'); if (bd) bd.remove();
}
function bindSearchModal() {
  const m = document.getElementById('search-modal');
  if (m.dataset.bound) return; m.dataset.bound = '1';
  document.getElementById('searchopen').addEventListener('click', () => { showModal('search-modal'); setTimeout(() => document.getElementById('search_term').focus(), 50); });
  m.querySelector('[data-close]').addEventListener('click', () => hideModal('search-modal'));
  m.addEventListener('click', e => { if (e.target === m) hideModal('search-modal'); });
  document.getElementById('search-form').addEventListener('submit', e => {
    e.preventDefault(); hideModal('search-modal');
    location.hash = '#/search?q=' + encodeURIComponent(document.getElementById('search_term').value.trim());
  });
}
function bindSubjectScroll() {
  const nav = document.getElementById('scrollable-navbar'); if (!nav || nav.dataset.bound) return; nav.dataset.bound = '1';
  document.querySelectorAll('.navbar-subjects .scroll-button').forEach(b => b.addEventListener('click', () => nav.scrollBy({ left: b.dataset.scroll === 'left' ? -150 : 150, behavior: 'smooth' })));
  const upd = () => {
    const max = nav.scrollWidth - nav.clientWidth;
    document.querySelector('.scroll-button[data-scroll="left"]').classList.toggle('d-none', nav.scrollLeft <= 0);
    document.querySelector('.scroll-button[data-scroll="right"]').classList.toggle('d-none', max <= 0 || nav.scrollLeft >= max - 1);
  };
  nav.addEventListener('scroll', upd); window.addEventListener('resize', upd); upd();
}
function openBrowse() {
  const m = document.getElementById('subject-browse-modal');
  const cur = (location.hash.match(/^#\/subject\/(\d+)/) || [])[1];
  if (cur) m.querySelectorAll('#browse-tabs a, #browse-panes .tab-pane').forEach(el => el.classList.toggle('active', el.dataset.pane === cur));
  if (!m.querySelector('#browse-tabs a.active')) { const f = m.querySelector('#browse-tabs a'); if (f) f.click(); }
  showModal('subject-browse-modal');
}
function closeBrowse() { hideModal('subject-browse-modal'); }
function cleanIcon(i) { if (!i) return ''; const m = i.match(/class="([^"]+)"/); return (m ? m[1] : i).trim(); }

function pageHome() {
  // The live "/" sends users with a homepage subject (fid 921) straight to that
  // subject's page - nearly everyone - so the carousel home below is the fallback.
  if (E.homepage && D.subjectById[E.homepage]) { location.replace(`#/subject/${E.homepage}`); return; }
  setBg(null);
  const subjects = D.subjects.filter(s => s.is_carouselable && canViewSubject(s) &&
    (!E.homeSections.length || E.homeSections.includes(s.id))).sort((a, b) => (a.homepage_order ?? 999) - (b.homepage_order ?? 999));
  let html = '';
  for (const s of subjects) {
    const feats = [1, 2, 3, 4].map(i => ({ sc: D.subcatById[s[`featured_subcategory_id_${i}`]], heading: s[`featured_heading_${i}`], sub: s[`featured_subheading_${i}`] })).filter(f => f.sc);
    if (!feats.length) continue;
    html += `<div class="row"><div class="col-12 position-relative"><div class="card shadow bg-light-purple border-primary mb-5">
      <h5 class="card-header bg-primary bg-gradient-primary text-white d-flex justify-content-between position-relative"><a href="#/subject/${s.id}" class="text-decoration-none stretched-link text-white d-flex justify-content-between w-100"><div>${esc(s.name)}</div><div class="flex-end"><small class="ml-3 text-white">View all &rarr;</small></div></a></h5>
      <div class="card-body pb-1"><div class="row row-cols-1 row-cols-md-2 row-cols-xxl-4">`;
    for (const f of feats) html += subcatCard(f.sc, { heading: f.heading, sub: f.sub, cols: 'col mb-4' });
    html += `</div></div></div></div></div>`;
  }
  app.innerHTML = html || '<div class="notice">Nothing to show on the home page yet.</div>';
  reveal();
}

function pageSubject(id) {
  const s = D.subjectById[id];
  if (!s) { app.innerHTML = '<div class="notice">Subject not found.</div>'; return; }
  if (!canViewSubject(s)) { app.innerHTML = `<div class="notice">${esc(s.name)} isn’t part of your subscription.${E.showUpgrade ? ` <a class="btn btn-primary btn-sm" href="#/upgrade" style="margin-left:.6rem">${esc(E.upgradeText)}</a>` : ''}</div>`; return; }
  setBg(s.background_image_url);
  const video = s.is_featuring_video && (s.featured_video_wistia_id_paid_ks2 || s.featured_video_wistia_id_free);
  const vHead = s.featured_video_heading_paid_ks2 || s.featured_video_heading_free, vSub = s.featured_video_subheading_paid_ks2 || s.featured_video_subheading_free;
  const vDesc = s.featured_video_description_paid_ks2 || s.featured_video_description_free || '';
  let html = `<div class="row pt-4 pb-2 d-none d-sm-block"><div class="col"><div class="card shadow border-primary bg-ultra-light-purple rounded">
    <h5 class="card-header bg-primary bg-gradient-primary text-white d-flex"><div>${esc(s.name)}</div><div class="ms-auto"><button type="button" class="subgroup-collapse" data-toggle aria-expanded="true" aria-label="Show or hide"></button></div></h5>
    ${s.description ? `<div class="collapse-smooth"><div><div class="card-body"><p class="fw-light text-primary h6 mb-0">${nl(s.description)}</p></div></div></div>` : ''}</div><hr></div></div>`;
  if (video) html += `<div class="row"><div class="col-12"><div class="card shadow-lg border-primary mb-5">
    <h5 class="card-header bg-primary bg-gradient-primary text-white">${esc(vHead || 'Featured')}${vSub ? ` <small class="text-white-50 ml-0 ml-sm-2 d-block d-sm-inline">${esc(vSub)}</small>` : ''}<small class="float-end"><span class="badge bg-warning"><i class="bi-star-fill mr-1 mt-1"></i> <span style="position: relative; top: 1px;">Featured</span></span></small></h5>
    <div class="card-body pb-1"><div class="row"><div class="col-12 mb-3"><div class="media d-block"><div class="img-thumbnail shadow-lg img-fluid scheme-thumbnail w-100 d-block border-primary border-dashed p-2">${wistia(video)}</div>
    ${vDesc ? `<div class="media-body px-1 pt-4"><p class="card-text text-purple fw-light lead mb-0">${nl(vDesc)}</p></div>` : ''}</div></div></div></div></div></div></div>`;
  const subgroups = (D.subgroupsBySubject[id] || []).sort(byOrder);
  let any = false;
  for (const sg of subgroups) {
    const subcats = visibleSubcats(sg);
    if (!subcats.length) continue; any = true;
    html += `<div class="row" id="parent-subgroup-${sg.id}"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5">
      <h5 class="card-header bg-primary bg-gradient-primary text-white d-flex"><div>${esc(sg.name)}${sg.description ? ` <small class="text-light-purple ml-0 ml-sm-3 d-block d-sm-inline fw-light i-small">${esc(sg.description)}</small>` : ''}</div><div class="ms-auto"><button type="button" class="subgroup-collapse" data-toggle aria-expanded="true" aria-label="Show or hide ${esc(sg.name)}"></button></div></h5>
      <div class="collapse-smooth"><div><div class="card-body pb-1"><div class="row">`;
    for (const sc of subcats) html += subcatCard(sc, {});
    html += `</div></div></div></div></div></div></div>`;
  }
  if (!any) html += '<div class="notice">This subject has no live content at the moment.</div>';
  app.innerHTML = html;
  reveal();
  bindCollapses();
}

// Collapsible panels (live: Bootstrap collapse + subcategory_display_state.js remembering the
// state); here with the expand-in-place transition agreed on 19 Oct.
function bindCollapses() {
  app.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
    const body = b.closest('.card').querySelector('.collapse-smooth'); if (!body) return;
    const closed = body.classList.toggle('closed'); b.classList.toggle('collapsed', closed); b.setAttribute('aria-expanded', !closed);
  }));
}

// A subcategory card: subjects/partials/subcategory-card.blade.php (desktop variant).
function subcatCard(sc, { heading, sub, cols } = {}) {
  const lessons = subcatLessons(sc), ages = ageRange(lessons);
  const vid = sc.is_direct_resource && (sc.direct_resource_wistia_duration_paid || sc.direct_resource_wistia_duration_all);
  const subheading = sub || sc.subheading;
  const meta = (ages ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><i class="bi-person-lines-fill text-primary me-1"></i> Ages ${esc(ages)}</li>` : '') +
    (lessons.length ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="text-primary"><i class="bi-collection-play text-primary me-1"></i> ${lessons.length} ${esc(noun(sc, lessons.length))}</span></li>` : '') +
    (vid ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="text-primary"><i class="bi-film text-primary me-1"></i> ${esc(vid)} video</span></li>` : '') +
    (subcatIsFree(sc) ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-end align-items-center"><span class="scheme-badge badge-freemium ms-2"><span class="badge bg-success">Free</span></span></li>` : '');
  return `<div class="${cols || 'col-12 col-md-6 col-lg-6 col-xl-3 mb-4'}"><a href="${subcatHref(sc)}" title="${esc(sc.name)}" class="text-decoration-none">
    <div class="card subcategory-card lift shadow-sm d-flex flex-column h-100"><img src="${esc(img(sc.image))}" class="card-img-top" alt="${esc(sc.name)}" loading="lazy">
    <div class="card-body border-top border-primary p-0 d-flex flex-column justify-content-between"><div class="align-self-start w-100"><div class="pt-2 d-flex flex-column w-100 h-100 justify-content-center">
      <h5 class="text-primary ${subheading ? 'mt-3 mb-1' : 'my-3'} mx-3 card-title text-nowrap">${esc(limit(heading || sc.name, 25))}</h5>
      ${subheading ? `<h6 class="subcategory-card--subheading h6 text-mid-purple fw-light mb-2 mx-3 card-title">${esc(limit(subheading, 130))}</h6>` : ''}</div></div>
    <ul class="list-group border-0 list-group-flush list-group-horizontal text-mid-purple small text-nowrap justify-content-around">${meta}</ul></div></div></a></div>`;
}

// ---------- teacher actions (v0.27) ----------
// Favourites, mark as done, lesson views, thumb-o-meter and search logging, stored in
// imoves-poc (web-poc/db/034_teacher_actions.sql) rather than Quickbase (decision 23 Oct).
const MY = { fav: new Set(), done: new Set(), seen: new Set() };
async function loadMyLessons() {
  try { const [r] = await rpc('web_my_lessons'); MY.fav = new Set(r.favourites); MY.done = new Set(r.completed); MY.seen = new Set(r.seen); }
  catch (e) { console.warn('my lessons unavailable:', e.message); }
}
async function restWrite(path, body, method = 'POST') {
  const prefer = 'return=minimal' + (path.includes('on_conflict=') ? ',resolution=merge-duplicates' : '');
  const r = await restFetch(path, { method, headers: { 'Content-Type': 'application/json', Prefer: prefer }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status}`);
}
const uid = () => (Auth.me() || {}).id;
async function toggleFavourite(lessonId) {
  if (MY.fav.has(lessonId)) { await restWrite(`user_favourites?user_id=eq.${uid()}&lesson_id=eq.${lessonId}`, null, 'DELETE'); MY.fav.delete(lessonId); }
  else { await restWrite('user_favourites', { user_id: uid(), lesson_id: lessonId }); MY.fav.add(lessonId); }
  paintStates();
}
// Live: "Mark as done" adds a completion each time (history lists them all); the
// "Activity Complete" state shows while any completion exists; clicking it again removes
// them (mark-as-incomplete).
async function toggleDone(lessonId) {
  if (MY.done.has(lessonId)) { await restWrite(`user_lesson_completions?user_id=eq.${uid()}&lesson_id=eq.${lessonId}`, null, 'DELETE'); MY.done.delete(lessonId); }
  else { await restWrite('user_lesson_completions', { user_id: uid(), lesson_id: lessonId }); MY.done.add(lessonId); }
  paintStates();
}
async function logView(lessonId) {
  let c = null; try { c = localStorage.getItem('imoves.loginCookie'); } catch (e) {}
  try { await restWrite('user_lesson_views', { user_id: uid(), lesson_id: lessonId, login_cookie: c }); MY.seen.add(lessonId); } catch (e) { /* best effort */ }
}
async function logSearch(term, results) { try { await restWrite('user_searches', { user_id: uid(), term, results }); } catch (e) {} }
async function saveAssessment(lessonId, data) { await restWrite('user_assessments', { user_id: uid(), lesson_id: lessonId, ...data }); }
// Repaint every favourite / done control on the page from MY (live swaps d-none between variants).
function paintStates() {
  document.querySelectorAll('[data-fav-for]').forEach(el => {
    const on = MY.fav.has(+el.dataset.favFor); const row = el.dataset.favKind === 'icon';
    if (row) { el.innerHTML = on ? '<i class="bi-star-fill text-warning"></i>' : '<i class="bi-star text-mid-purple"></i>'; el.title = on ? 'Remove from Favourites' : 'Add to Favourites'; }
    else { el.classList.toggle('btn-primary', on || el.dataset.bg === '1'); el.classList.toggle('btn-outline-primary', !on && el.dataset.bg !== '1'); el.innerHTML = on ? `<i class="bi-star-fill text-warning me-2"></i>Favourite ${esc(el.dataset.label)}` : `<i class="bi-star me-2"></i>Add to <span class="d-none d-xl-inline">Favourite ${esc(el.dataset.labels)}</span><span class="d-inline d-xl-none">Favourites</span>`; }
  });
  document.querySelectorAll('[data-done-for]').forEach(el => {
    const on = MY.done.has(+el.dataset.doneFor); const row = el.dataset.doneKind === 'icon';
    if (row) { el.innerHTML = on ? '<i class="bi-check-circle-fill text-success"></i>' : '<i class="bi-circle text-mid-purple"></i>'; el.title = on ? 'Mark as Incomplete' : 'Mark as Complete'; }
    else { el.classList.toggle('btn-primary', on || el.dataset.bg === '1'); el.classList.toggle('btn-outline-primary', !on && el.dataset.bg !== '1'); el.innerHTML = on ? `<i class="d-none d-lg-inline bi-check-circle-fill mr-1"></i> ${esc(el.dataset.label)} Complete` : `<i class="d-none d-lg-inline bi-check-circle mr-1"></i> Mark <span class="d-none d-xl-inline">as</span> Done`; }
  });
}
function bindActions(root) {
  root.querySelectorAll('[data-fav-for]').forEach(el => { if (el.dataset.bound) return; el.dataset.bound = '1'; el.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); el.classList.add('cursor-wait'); try { await toggleFavourite(+el.dataset.favFor); } catch (x) { alert('Could not save: ' + x.message); } el.classList.remove('cursor-wait'); }); });
  root.querySelectorAll('[data-done-for]').forEach(el => { if (el.dataset.bound) return; el.dataset.bound = '1'; el.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); el.classList.add('cursor-wait'); try { await toggleDone(+el.dataset.doneFor); } catch (x) { alert('Could not save: ' + x.message); } el.classList.remove('cursor-wait'); }); });
  root.querySelectorAll('.curriculum-btn').forEach(el => { if (el.dataset.bound) return; el.dataset.bound = '1'; el.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); openGroupSelect(+el.dataset.lessonId); }); });
  paintStates();
}

// ---------- profile and school curriculum (v0.28) ----------
// My personal profile (user-profile/show.blade.php). Edits go to user_profile_edits and
// web_me() layers them over the nightly Users copy (web-poc/db/035_profile_curriculum.sql).
async function pageProfile() {
  setBg(null);
  const m = Auth.me() || {};
  let roles = []; try { roles = (await rpc('web_user_roles')).map(r => r.role); } catch (e) {}
  const mine = new Set(m.roles || []);
  const field = (label, id, value, auto) => `<div class="form-row mb-3"><div class="col"><label for="${id}" class="text-1">${label}</label><input type="text" class="form-control" id="${id}" name="${id}" value="${esc(value || '')}" ${auto ? `autocomplete="${auto}"` : ''}></div></div>`;
  app.innerHTML = `<div class="profile-container form-page container-fluid pb-5"><div class="row justify-content-center"><div class="col-12 col-sm-10 col-lg-8">
    <div class="heading-1 text-primary">My personal profile</div>
    <form id="user_profile_form"><div class="row"><div class="col-6">${field('First Name', 'first_name', m.first_name, 'given-name')}</div><div class="col-6">${field('Last Name', 'last_name', m.last_name, 'family-name')}</div></div>
    ${field('Telephone', 'telephone_number', m.phone, 'tel')}${field('My Class Name', 'class_name', m.class_name)}
    <div class="form-row mb-3"><div class="col"><label for="user_roles" class="text-1">My Role(s)</label><select multiple class="form-control form-select" id="user_roles" name="user_roles" size="${Math.min(8, Math.max(3, roles.length))}" title="Select your role(s)">${roles.map(r => `<option value="${esc(r)}" ${mine.has(r) ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></div></div>
    <div class="notice d-none" id="profile-msg" role="status"></div>
    <button class="btn btn-primary heading-2 btn-save w-100" type="submit">Update my details</button></form></div></div></div>`;
  reveal();
  document.getElementById('user_profile_form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, msg = document.getElementById('profile-msg'), btn = f.querySelector('.btn-save');
    const body = { user_id: uid(), first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim(), phone: f.telephone_number.value.trim(), class_name: f.class_name.value.trim(), roles: [...f.user_roles.selectedOptions].map(o => o.value) };
    btn.disabled = true;
    try {
      await restWrite('user_profile_edits?on_conflict=user_id', body);   // upsert
      Object.assign(Auth.me(), { first_name: body.first_name, last_name: body.last_name, phone: body.phone, class_name: body.class_name, roles: body.roles });
      renderUserContext(); Auth.renderUser();
      msg.textContent = 'Your details have been updated.'; msg.classList.remove('d-none');
    } catch (x) { msg.textContent = 'Could not save: ' + x.message; msg.classList.remove('d-none'); }
    btn.disabled = false;
  });
}

// School Curriculum Management (resources/js/curriculum/*.vue). Tabs > groups > lessons per
// school; everyone at the school sees it, school admins edit it when "Unlocked".
const CUR = { tabs: [], current: null, edit: false };
async function loadCurriculum() {
  const [tabs, groups, gl] = await Promise.all([
    rest('curriculum_tabs?select=*&order=order,id'), rest('curriculum_groups?select=*&order=order,id'), rest('curriculum_group_lessons?select=*&order=order,id'),
  ]);
  const byTab = group(groups, 'tab_id'), byGroup = group(gl, 'group_id');
  CUR.tabs = tabs.map(t => ({ ...t, groups: (byTab[t.id] || []).map(g => ({ ...g, lessons: byGroup[g.id] || [] })) }));
  if (!CUR.tabs.some(t => t.id === CUR.current)) CUR.current = CUR.tabs[0] ? CUR.tabs[0].id : null;
}
async function curriculumLessons(ids) {
  if (!ids.length) return {};
  const rows = await rest(`lessons?id=in.(${[...new Set(ids)].join(',')})&select=id,name,description,body_opening_text,scheme_id,age_min,age_max,duration`);
  return index(rows);
}
function curriculumLessonCard(l, gl, edit) {
  const scheme = D.schemeById[l.scheme_id]; const sc = scheme && D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]];
  const blurb = (l.description || l.body_opening_text || '').trim();
  return `<div class="col mb-4" data-gl="${gl.id}"><a href="${edit ? '#' : lessonHref(l, sc)}" class="text-decoration-none ${edit ? 'pe-none' : ''}"><div class="card subcategory-card ${edit ? '' : 'lift'} h-100 shadow-sm d-flex flex-column"><img src="${esc(img(scheme?.image))}" class="card-img-top" alt="${esc(l.name)}" loading="lazy">
    <div class="card-body border-top border-primary p-0 d-flex flex-column justify-content-between">
      ${edit ? `<div class="align-self-end mx-3 pt-2 pe-auto"><button type="button" class="btn btn-sm btn-link text-primary p-0 me-2" data-move="up" title="Move up"><i class="bi bi-arrow-up"></i></button><button type="button" class="btn btn-sm btn-link text-primary p-0 me-2" data-move="down" title="Move down"><i class="bi bi-arrow-down"></i></button><button type="button" class="btn btn-sm btn-link text-primary p-0 me-2" data-copy="${l.id}" title="Copy to another group"><i class="bi bi-files"></i></button><button type="button" class="btn btn-sm btn-link text-danger p-0" data-del-gl="${gl.id}" title="Delete"><i class="bi bi-trash"></i></button></div>` : ''}
      <div class="align-self-start w-100 flex-grow-1"><div class="pt-2 d-flex flex-column w-100 h-100"><h5 class="text-primary ${blurb ? 'mt-3 mb-1' : 'my-3'} mx-3 card-title text-truncate"><small class="text-mid-purple mb-2">${esc(scheme ? scheme.name : '')}<br></small>${esc(l.name)}</h5>${blurb ? `<h6 class="h6 text-mid-purple fw-light mb-3 mx-3 card-title">${esc(limit(blurb, 100))}</h6>` : ''}</div></div>
      <ul class="list-group border-0 list-group-flush list-group-horizontal text-mid-purple small text-nowrap justify-content-around"><li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="lesson-icon text-truncate"><i class="bi-person text-purple mr-1"></i> <span>${esc(ageText(l))}</span></span></li>${l.duration ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="lesson-icon text-truncate ms-2 ml-lg-3 my-1"><i class="bi-clock text-purple mr-1"></i> ${l.duration}m</span></li>` : ''}</ul>
    </div></div></a></div>`;
}
async function pageCurriculum() {
  setBg(null);
  const admin = !!(Auth.me() || {}).is_admin;
  try { CUR.edit = admin && localStorage.getItem('curriculumEditMode') === 'true'; } catch (e) { CUR.edit = false; }
  app.innerHTML = '<div class="loading">Loading curriculum…</div>';
  await loadCurriculum();
  const lessons = await curriculumLessons(CUR.tabs.flatMap(t => t.groups.flatMap(g => g.lessons.map(x => x.lesson_id))));
  renderCurriculum(admin, lessons);
}
function renderCurriculum(admin, lessons) {
  const edit = CUR.edit;
  let html = `<div class="container container-padded py-3 px-0">`;
  if (admin) html += `<div class="row"><h3 class="col-12 col-md-6 text-primary">School Curriculum Management</h3><div class="col-12 col-md-4 text-end"><button class="btn btn-primary" type="button" id="cur-browse">Browse <span class="d-lg-inline d-none">to add resources</span> &gt;</button></div>
    <div class="col-12 col-md-2 flex-row-reverse d-flex"><div class="toggle toggle-right ${edit ? 'active' : ''}"><a href="#" data-edit="1">Unlocked</a></div><div class="toggle toggle-left ${edit ? '' : 'active'}"><a href="#" data-edit="0">Locked</a></div></div></div>`;
  html += `<ul class="nav nav-pills" role="presentation">` + CUR.tabs.map(t => `<li class="nav-item"><a href="#" class="nav-link ${t.id === CUR.current ? 'active' : ''}" data-tab="${t.id}" role="tab">${esc(t.name)}${edit ? ` <span class="dropdown d-inline"><i class="bi bi-three-dots-vertical" role="button" data-tabmenu="${t.id}"></i><ul class="dropdown-menu"><li><a class="dropdown-item" href="#" data-tab-rename="${t.id}">Rename</a></li><li><a class="dropdown-item" href="#" data-tab-clone="${t.id}">Clone</a></li><li><a class="dropdown-item" href="#" data-tab-delete="${t.id}">Delete</a></li></ul></span>` : ''}</a></li>`).join('') +
    (edit ? `<li class="nav-item"><a class="nav-link" href="#" id="cur-newtab">+ Add New Tab</a></li>` : '') + `</ul><div class="tab-content mt-3">`;
  const tab = CUR.tabs.find(t => t.id === CUR.current);
  if (!tab) html += `<div class="notice">${admin ? (edit ? 'Add a tab to start building your school curriculum.' : 'No curriculum yet. Switch to Unlocked to start building one.') : 'Your school has not set up a curriculum yet. Ask your School Administrator.'}</div>`;
  else {
    for (const g of tab.groups) {
      html += `<div class="row curriculum-group-row" data-group="${g.id}"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5">
        <h5 class="card-header bg-primary bg-gradient-primary text-white d-flex"><div>${esc(g.name)}</div><div class="ms-auto">${edit ? `<span class="dropdown d-inline"><i class="bi bi-three-dots-vertical me-2" role="button" data-groupmenu="${g.id}"></i><ul class="dropdown-menu"><li><a class="dropdown-item" href="#" data-group-rename="${g.id}">Rename</a></li><li><a class="dropdown-item" href="#" data-group-clone="${g.id}">Clone</a></li><li><a class="dropdown-item" href="#" data-group-delete="${g.id}">Delete</a></li></ul></span><i class="bi bi-arrow-up me-1" role="button" title="Move up" data-group-move="up"></i><i class="bi bi-arrow-down me-2" role="button" title="Move down" data-group-move="down"></i>` : ''}<button type="button" class="subgroup-collapse" data-toggle aria-expanded="true"></button></div></h5>
        <div class="collapse-smooth"><div><div class="card-body pb-1"><div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 row-cols-lg-3">` + g.lessons.map(gl => lessons[gl.lesson_id] ? curriculumLessonCard(lessons[gl.lesson_id], gl, edit) : '').join('') + (g.lessons.length ? '' : '<div class="col-12 mb-3 text-mid-purple fw-light">No lessons in this group yet.' + (edit ? ' Use "Browse to add resources" or the bookmark icon on any lesson.' : '') + '</div>') + `</div></div></div></div></div></div></div>`;
    }
    if (edit) html += `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><div class="card-body"><a href="#" id="cur-newgroup" class="text-primary">+ Add New Group</a></div></div></div></div>`;
  }
  app.innerHTML = html + `</div></div>`;
  reveal(); bindCollapses(); bindCurriculum(admin, lessons);
}
function bindCurriculum(admin, lessons) {
  const refresh = async () => { await loadCurriculum(); const ls = await curriculumLessons(CUR.tabs.flatMap(t => t.groups.flatMap(g => g.lessons.map(x => x.lesson_id)))); renderCurriculum(admin, ls); };
  const fail = e => alert('Could not save: ' + e.message);
  app.querySelectorAll('[data-tab]').forEach(a => a.addEventListener('click', e => { if (e.target.closest('[data-tabmenu], .dropdown-menu')) return; e.preventDefault(); CUR.current = +a.dataset.tab; renderCurriculum(admin, lessons); }));
  app.querySelectorAll('[data-edit]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); CUR.edit = a.dataset.edit === '1'; try { localStorage.setItem('curriculumEditMode', CUR.edit); } catch (x) {} renderCurriculum(admin, lessons); }));
  app.querySelectorAll('[data-tabmenu], [data-groupmenu]').forEach(i => i.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const m = i.nextElementSibling; const open = m.classList.contains('show'); app.querySelectorAll('.dropdown-menu.show').forEach(x => x.classList.remove('show')); if (!open) m.classList.add('show'); }));
  document.addEventListener('click', () => app.querySelectorAll('.dropdown-menu.show').forEach(x => x.classList.remove('show')), { once: true });
  const tabOf = id => CUR.tabs.find(t => t.id === +id), groupOf = id => CUR.tabs.flatMap(t => t.groups).find(g => g.id === +id);
  const newTab = document.getElementById('cur-newtab');
  if (newTab) newTab.addEventListener('click', async e => { e.preventDefault(); const name = prompt('Tab Name'); if (!name) return; try { await restWrite('curriculum_tabs', { school_id: (Auth.me() || {}).school_id, name: name.trim(), order: CUR.tabs.length + 1 }); await refresh(); CUR.current = CUR.tabs[CUR.tabs.length - 1].id; renderCurriculum(admin, lessons); } catch (x) { fail(x); } });
  const newGroup = document.getElementById('cur-newgroup');
  if (newGroup) newGroup.addEventListener('click', async e => { e.preventDefault(); const name = prompt('Group Name'); if (!name) return; const t = tabOf(CUR.current); try { await restWrite('curriculum_groups', { tab_id: t.id, name: name.trim(), order: t.groups.length + 1 }); await refresh(); } catch (x) { fail(x); } });
  app.querySelectorAll('[data-tab-rename]').forEach(a => a.addEventListener('click', async e => { e.preventDefault(); const t = tabOf(a.dataset.tabRename); const name = prompt('Rename tab', t.name); if (!name) return; try { await restWrite(`curriculum_tabs?id=eq.${t.id}`, { name: name.trim() }, 'PATCH'); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-tab-clone]').forEach(a => a.addEventListener('click', async e => { e.preventDefault(); try { CUR.current = await rpc('web_curriculum_clone_tab', { p_tab_id: +a.dataset.tabClone }); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-tab-delete]').forEach(a => a.addEventListener('click', async e => { e.preventDefault(); const t = tabOf(a.dataset.tabDelete); if (!confirm(`Delete the tab "${t.name}" and everything in it?`)) return; try { await restWrite(`curriculum_tabs?id=eq.${t.id}`, null, 'DELETE'); CUR.current = null; await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-group-rename]').forEach(a => a.addEventListener('click', async e => { e.preventDefault(); const g = groupOf(a.dataset.groupRename); const name = prompt('Rename group', g.name); if (!name) return; try { await restWrite(`curriculum_groups?id=eq.${g.id}`, { name: name.trim() }, 'PATCH'); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-group-clone]').forEach(a => a.addEventListener('click', async e => { e.preventDefault(); try { await rpc('web_curriculum_clone_group', { p_group_id: +a.dataset.groupClone }); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-group-delete]').forEach(a => a.addEventListener('click', async e => { e.preventDefault(); const g = groupOf(a.dataset.groupDelete); if (!confirm(`Delete the group "${g.name}"?`)) return; try { await restWrite(`curriculum_groups?id=eq.${g.id}`, null, 'DELETE'); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-group-move]').forEach(i => i.addEventListener('click', async e => { e.preventDefault(); const row = i.closest('[data-group]'); const t = tabOf(CUR.current); const idx = t.groups.findIndex(g => g.id === +row.dataset.group); const j = i.dataset.groupMove === 'up' ? idx - 1 : idx + 1; if (j < 0 || j >= t.groups.length) return; const order = t.groups.map(g => g.id); [order[idx], order[j]] = [order[j], order[idx]]; try { await Promise.all(order.map((id, k) => restWrite(`curriculum_groups?id=eq.${id}`, { order: k }, 'PATCH'))); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-del-gl]').forEach(b => b.addEventListener('click', async e => { e.preventDefault(); if (!confirm('Remove this lesson from the group?')) return; try { await restWrite(`curriculum_group_lessons?id=eq.${b.dataset.delGl}`, null, 'DELETE'); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', async e => { e.preventDefault(); const card = b.closest('[data-gl]'); const g = groupOf(card.closest('[data-group]').dataset.group); const idx = g.lessons.findIndex(x => x.id === +card.dataset.gl); const j = b.dataset.move === 'up' ? idx - 1 : idx + 1; if (j < 0 || j >= g.lessons.length) return; const order = g.lessons.map(x => x.id); [order[idx], order[j]] = [order[j], order[idx]]; try { await Promise.all(order.map((id, k) => restWrite(`curriculum_group_lessons?id=eq.${id}`, { order: k }, 'PATCH'))); await refresh(); } catch (x) { fail(x); } }));
  app.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); openGroupSelect(+b.dataset.copy, refresh); }));
  const browse = document.getElementById('cur-browse'); if (browse) browse.addEventListener('click', openBrowse);
}

// "Select Curriculum Group" modal (GroupSelectionModal.vue): behind every bookmark button.
async function openGroupSelect(lessonId, after) {
  const admin = !!(Auth.me() || {}).is_admin;
  let m = document.getElementById('curriculumModal');
  if (!m) { m = document.createElement('div'); m.id = 'curriculumModal'; m.className = 'modal fade'; m.tabIndex = -1; document.body.appendChild(m); }
  let body = '';
  if (!admin) body = `<h5>Please ask your School Administrator to add the Lesson to the Curriculum.</h5>`;
  else {
    await loadCurriculum();
    const [l] = await rest(`lessons?id=eq.${lessonId}&select=id,name`);
    const t = CUR.tabs.find(x => x.id === CUR.current) || CUR.tabs[0];
    body = `<h3 class="px-4">${esc(l ? l.name : '')}</h3>` + (CUR.tabs.length ? `<ul class="nav nav-pills px-4" role="presentation">` + CUR.tabs.map(x => `<li class="nav-item"><a href="#" class="nav-link ${x.id === (t && t.id) ? 'active' : ''}" data-seltab="${x.id}">${esc(x.name)}</a></li>`).join('') + `</ul><div class="mt-3 px-4" id="selgroups">${t ? t.groups.map(g => `<div class="card shadow bg-light-purple border-primary mb-3"><h5 class="card-header bg-primary bg-gradient-primary text-white d-flex"><div>${esc(g.name)}</div><div class="ms-auto"><input type="checkbox" class="group-select" value="${g.id}" ${g.lessons.some(x => x.lesson_id === lessonId) ? 'checked' : ''}></div></h5></div>`).join('') || '<p class="text-mid-purple">This tab has no groups yet.</p>' : ''}</div>` : `<p class="text-mid-purple px-4">No curriculum tabs yet. Open Curriculum, switch to Unlocked and add a tab first.</p>`);
  }
  m.innerHTML = `<div class="modal-dialog modal-xl text-primary"><div class="modal-content"><div class="modal-header bg-primary text-white"><h1 class="modal-title fs-5"><i class="bi-bookmark-plus me-2"></i>Select Curriculum Group</h1><button type="button" class="btn-close" data-close aria-label="Close"></button></div><div class="modal-body">${body}</div>${admin ? `<div class="modal-footer"><span>Tick the box next to the Group name to assign.</span><button type="button" class="btn btn-primary" data-close>Confirm</button></div>` : ''}</div></div>`;
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { hideModal('curriculumModal'); if (after) after(); }));
  m.addEventListener('click', e => { if (e.target === m) { hideModal('curriculumModal'); if (after) after(); } });
  m.querySelectorAll('[data-seltab]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); CUR.current = +a.dataset.seltab; openGroupSelect(lessonId, after); }));
  m.querySelectorAll('.group-select').forEach(cb => cb.addEventListener('change', async () => {
    const g = CUR.tabs.flatMap(x => x.groups).find(x => x.id === +cb.value);
    try {
      if (cb.checked) await restWrite('curriculum_group_lessons', { group_id: g.id, lesson_id: lessonId, order: g.lessons.length + 1 });
      else await restWrite(`curriculum_group_lessons?group_id=eq.${g.id}&lesson_id=eq.${lessonId}`, null, 'DELETE');
      await loadCurriculum();
    } catch (x) { cb.checked = !cb.checked; alert('Could not save: ' + x.message); }
  }));
  showModal('curriculumModal');
}

// ---------- category, scheme and lesson pages (live markup, v0.26) ----------
// Markup follows subjects/show-subcategory.blade.php, subjects/partials/scheme-card.blade.php
// and lessons/show.blade.php + lessons/lesson-part.blade.php. Kept from the PoC (agreed
// 1 Nov 2026): same-named age-variant schemes merged into one card with an age switch,
// lessons expanding in place on the category page, "link to a URL" categories that point
// back into the platform followed internally, and the Stream player via wistia().

// Breadcrumb card (the live page's top card)
function crumbs(parts) {
  const inner = parts.map((p, i) => (i ? '<i class="bi-chevron-right text-mid-purple mx-2"></i>' : '') +
    (p.href ? `<a href="${p.href}" class="text-mid-purple">${esc(p.name)}</a>` : `<span class="text-purple">${esc(p.name)}</span>`)).join('');
  return `<div class="row pt-4 pb-2"><div class="col"><div class="row"><div class="col-12"><div class="card shadow border-primary bg-ultra-light-purple rounded"><div class="card-body py-3"><div class="d-block d-md-flex h-100 justify-content-start align-items-center">${inner}</div></div></div></div></div><hr class="d-md-block d-none"></div></div>`;
}
// Lesson::getAgeRange()
function ageText(l, withPrefix = true) {
  if (!l.age_min && !l.age_max) return '';
  const range = l.age_min && l.age_max && l.age_min !== l.age_max;
  const prefix = withPrefix ? (range ? 'Ages ' : 'Age ') : '';
  return range ? `${prefix}${l.age_min}-${l.age_max}` : `${prefix}${l.age_min || l.age_max}`;
}
function ageTextRange(r, withPrefix = true) { if (!r) return ''; const [a, b] = r.split('-').map(Number); return ageText({ age_min: a, age_max: b }, withPrefix); }
// Lesson::getResourceIcon() (unseen variants)
function lessonIcon(l) { return l.has_video ? 'bi-play-btn-fill' : l.has_audio ? 'bi-file-music-fill' : l.has_slides ? 'bi-easel-fill' : l.has_lesson_plan ? 'bi-file-earmark-ruled-fill' : l.has_downloads ? 'bi-file-arrow-down-fill' : l.has_assessment_template ? 'bi-file-pdf-fill' : 'bi-play-btn-fill'; }
// LessonPart::getPartIcon()
function partIcon(p) { return { Video: 'bi-camera-reels-fill', Audio: 'bi-file-music-fill', Slides: 'bi-easel-fill', Download: 'bi-file-arrow-down-fill', Image: 'bi-file-image-fill' }[p.media_type] || 'bi-file-earmark-ruled-fill'; }
const para = (t, cls = 'text-purple') => t && String(t).trim() ? `<p class="card-text ${cls} fw-light text-6 mb-1 pe-1">${nl(t)}</p>` : '';
// The scheme-card body text (scheme-card.blade.php media-body)
function schemeBody(s) {
  let h = para(s.description) + para(s.body_opening_text);
  for (const i of [1, 2, 3]) if (s[`body_subheading_${i}`]) h += `<h5 class="text-purple">${esc(s[`body_subheading_${i}`])}</h5>${para(s[`body_subheading_${i}_text`], 'text-mid-purple')}`;
  h += para(s.body_closing_text);
  return h;
}
function upgradeHref() { return '#/upgrade'; }

function pageSubcategory(subjectId, id) {
  const sc = D.subcatById[id];
  if (!sc) { app.innerHTML = '<div class="notice">Section not found.</div>'; return; }
  if (sc.is_redirect_to_category && sc.subcategory_redirect_id) { location.replace(subcatHref(D.subcatById[sc.subcategory_redirect_id] || sc)); return; }
  if (sc.is_redirect_to_lesson && sc.lesson_redirect_id) { location.replace(`#/lesson/${sc.lesson_redirect_id}?sc=${sc.id}`); return; }
  const subject = D.subjectById[sc.subject_id] || D.subjectById[subjectId], sg = D.subgroupById[sc.subgroup_id];
  setBg(sc.background_image_url || subject?.background_image_url);
  let html = crumbs([subject && { name: subject.name, href: `#/subject/${subject.id}` }, sg && { name: sg.name, href: `#/subject/${subject?.id}` }, { name: sc.name }].filter(Boolean));
  html += `<div class="row"><div class="col-12 order-2 order-lg-1"><div class="row"><div class="col-sm">`;
  if (sc.is_redirect_to_url && sc.url_redirect) {
    const m = sc.url_redirect.match(/platform\.imoves\.com\/subjects\/(\d+)(?:\/subcategories\/(\d+))?/);
    if (m && m[2] && D.subcatById[+m[2]]) { location.replace(subcatHref(D.subcatById[+m[2]])); return; }
    if (m && !m[2] && D.subjectById[+m[1]]) { location.replace(`#/subject/${m[1]}`); return; }
    const host = sc.url_redirect.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    const isFile = /\.(pdf|jpg|jpeg|png)(\?|$)/i.test(sc.url_redirect);
    html += /platform\.imoves\.com\/subscribe/.test(sc.url_redirect)
      ? `<div class="notice">This section opens the subscription options page, which arrives with Phase 2.</div>`
      : `<div class="card mb-5 scheme-card bg-ultra-light-purple border-0 shadow"><div class="row"><div class="col"><div class="card-header bg-primary bg-gradient-primary"><div class="col d-flex justify-content-between align-items-center px-0"><h5 class="text-truncate text-white mr-1 mb-0">${esc(sc.name)}</h5></div></div></div></div><div class="row g-0"><div class="col px-3 pt-4 pb-3">${para(sc.description)}<p><a class="btn btn-primary" href="${esc(sc.url_redirect)}" target="_blank" rel="noopener"><i class="${isFile ? 'bi-file-earmark-arrow-down' : 'bi-box-arrow-up-right'} me-2"></i>${isFile ? 'Open the file' : 'Open ' + esc(host)}</a></p></div></div></div>`;
    app.innerHTML = html + `</div></div></div></div>`; reveal(); return;
  }
  const schemes = D.schemesBySubcat[id] || [];
  // Age variants: same-named schemes in one category become one card with an age switch.
  const groups = []; const byName = {};
  for (const s of schemes) {
    const key = (s.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (key && byName[key]) byName[key].push(s); else { const g = [s]; if (key) byName[key] = g; groups.push(g); }
  }
  for (const g of groups) {
    const variants = g.map(s => ({ s, lessons: schemeLessons(s), ages: ageRange(schemeLessons(s)) })).sort((a, b) => (parseInt(a.ages) || 99) - (parseInt(b.ages) || 99));
    const first = variants[0].s, merged = variants.length > 1;
    let sel = variants.findIndex(v => coversClass(v.ages)); if (sel < 0) sel = 0;
    const labels = variants.map((v, i) => v.ages ? ageTextRange(v.ages) : (v.s.subheading || `Version ${i + 1}`));
    labels.forEach((l, i) => { if (labels.indexOf(l) !== i) labels[i] = `${l} (${i + 1})`; });
    const sw = merged ? `<div class="btn-group btn-group-sm ms-2 age-switch" role="group" aria-label="Age version">${labels.map((l, i) => `<button type="button" class="btn ${i === sel ? 'btn-light text-primary' : 'btn-outline-light'}" data-variant="${i}">${esc(l)}</button>`).join('')}</div>` : '';
    html += `<a id="scheme-${first.id}"></a><div class="row"><div class="col"><div class="card mb-5 scheme-card bg-ultra-light-purple border-0 shadow" data-scheme="${first.id}">
      <div class="row"><div class="col"><div class="card-header bg-primary bg-gradient-primary"><div class="col d-flex justify-content-between align-items-center px-0">
        <h5 class="text-truncate text-white mr-1 mb-0">${esc(first.name)}${!merged && first.subheading ? ` <small class="text-white-50 ml-0 ml-sm-2 d-block d-sm-inline">${esc(first.subheading)}</small>` : ''}${variants.some(v => v.s.is_freemium) ? ' <span class="scheme-badge badge-freemium ms-2"><span class="badge bg-success">Free</span></span>' : ''}</h5>${sw}</div></div></div></div>`;
    variants.forEach((v, i) => {
      const s2 = v.s;
      html += `<div class="variant" ${i === sel ? '' : 'hidden'}>
        <div class="row g-0"><div class="col px-3 pt-4 pb-3"><div class="media d-block d-md-flex align-items-center"><img src="${esc(img(s2.image))}" class="img-thumbnail shadow-sm img-fluid align-self-start ms-1 me-3 mb-3 mb-md-0 scheme-thumbnail" alt="${esc(s2.name)}"><div class="media-body px-1">${merged && s2.subheading ? para(s2.subheading, 'text-mid-purple') : ''}${schemeBody(s2)}</div></div></div></div>
        <div class="row mt-2"><div class="col"><div class="card-body pt-0 pb-4">` + v.lessons.map(l => lessonRow(l, sc, v.ages)).join('') + `</div></div></div></div>`;
    });
    html += `</div></div></div>`;
  }
  if (sc.is_direct_resource) {
    const vid = sc.direct_resource_wistia_id_paid || sc.direct_resource_wistia_id_all;
    const head = sc.direct_resource_heading_paid || sc.direct_resource_heading_all || sc.name;
    html += `<div class="row"><div class="col-12"><div class="card shadow-lg border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white">${esc(head)}</h5><div class="card-body pb-1"><div class="row"><div class="col-12 mb-3"><div class="media d-block">${vid ? `<div class="img-thumbnail shadow-lg img-fluid scheme-thumbnail w-100 d-block border-primary border-dashed p-2">${wistia(vid)}</div>` : ''}<div class="media-body px-1 pt-4"><p class="card-text text-purple fw-light lead mb-0">${nl(sc.direct_resource_text_paid || sc.direct_resource_text_all || sc.description)}</p></div></div></div></div>${sc.is_direct_resource_linked && sc.direct_resource_link_url ? `<div class="row"><div class="col-sm"><div class="filtered-out-notice alert d-block alert-primary bg-extra-light-purple border-primary mb-4" role="alert"><p class="text-primary my-0 d-flex justify-content-between align-items-center"><a class="text-primary stretched-link" href="${esc(sc.direct_resource_link_url)}" target="_blank" rel="noopener"><i class="bi-arrow-right-circle me-2 text-primary"></i>${esc(sc.direct_resource_link_text || 'Open')}</a></p></div></div></div>` : ''}</div></div></div></div>`;
  }
  if (!schemes.length && !sc.is_direct_resource) html += '<div class="notice">This section has no live schemes at the moment.</div>';
  app.innerHTML = html + `</div></div></div></div>`;
  reveal();
  app.querySelectorAll('.age-switch button').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.scheme-card'); const i = +b.dataset.variant;
    card.querySelectorAll('.age-switch button').forEach(x => { const on = +x.dataset.variant === i; x.classList.toggle('btn-light', on); x.classList.toggle('text-primary', on); x.classList.toggle('btn-outline-light', !on); });
    card.querySelectorAll('.variant').forEach((v, j) => { v.hidden = j !== i; });
  }));
  bindLessonRows(sc);
}

// One lesson row of the scheme card (scheme-card.blade.php accordion item), with the PoC's
// expand-in-place body underneath.
function lessonRow(l, sc, schemeAges) {
  const ok = canAccessLesson(l);
  const showAge = !classAge() && lessonAges(l) && lessonAges(l) !== schemeAges;
  const meta = (showAge ? `<span class="lesson-icon text-truncate ms-2 my-1" title="Suitable for ages ${esc(lessonAges(l))}"><i class="bi-person text-purple mr-1"></i> <span class="d-inline d-xl-none">${esc(lessonAges(l))}yrs</span><span class="d-none d-xl-inline">${esc(ageText(l))}</span></span>` : '') +
    (l.duration ? `<span class="lesson-icon text-truncate ms-2 ml-lg-3 my-1" title="Around ${l.duration} minutes long"><i class="bi-clock text-purple mr-1"></i> ${l.duration}m</span>` : '');
  return `<div class="accordion list-group list-group-horizontal shadow mt-0 mb-2 ${ok ? '' : 'content-restricted'} lesson-x" data-lesson="${l.id}">
    <div class="list-group-item list-group-item-action cursor-pointer px-3 lesson-row" role="button" aria-expanded="false"><div class="row h-100"><div class="col d-flex align-items-center">
      <div class="d-flex justify-content-start align-items-center pe-1"><i class="${ok ? (MY.seen.has(l.id) ? 'text-mid-purple ' + lessonIcon(l).replace('-fill', '') : 'text-primary ' + lessonIcon(l)) : 'text-mid-purple bi-lock-fill'} h5 my-0 me-2"></i></div>
      <div class="d-flex flex-grow-1 flex-wrap align-items-center mt-2 mb-1"><h5 class="w-100 text-primary mb-0">${esc(l.name)}${l.is_freemium ? ' <small class="ms-1 scheme-badge badge-freemium"><span class="badge bg-success">Free</span></small>' : ''}</h5><span class="w-100 text-mid-purple fw-light">${ok ? esc(l.description || '') : esc(E.lessonMessage)}</span></div>
      <div class="d-none d-md-flex flex-shrink-0 align-items-center"><small class="ms-3 d-flex flex-wrap justify-content-end text-muted text-mid-purple fw-light">${ok ? meta : (E.showUpgrade ? `<a class="btn btn-primary btn-sm" href="${upgradeHref()}">${esc(E.upgradeText)}</a>` : '')}</small></div>
    </div></div></div>
    <div class="list-group-item px-1 px-md-3"><div class="d-none d-md-flex flex-column h-100 justify-content-around align-items-center"><div>
      <div class="${l.description ? 'mb-1' : ''}"><div class="lesson-icon cursor-pointer mark-as-complete" data-done-for="${l.id}" data-done-kind="icon"><i class="bi-circle text-mid-purple"></i></div></div>
      <div><div class="lesson-icon cursor-pointer add-to-favourites" data-fav-for="${l.id}" data-fav-kind="icon"><i class="bi-star text-mid-purple"></i></div></div>
    </div><div><div class="btn-outline-primary curriculum-btn" title="Add to Curriculum" data-lesson-id="${l.id}"><i class="bi bi-bookmark-plus"></i></div></div></div></div>
  </div>
  <div class="lesson-drawer collapse-smooth closed" data-lesson-body="${l.id}"><div></div></div>`;
}
function bindLessonRows(sc) {
  app.querySelectorAll('.lesson-x:not(.content-restricted) .lesson-row').forEach(row => row.addEventListener('click', async e => {
    if (e.target.closest('a, .lesson-icon')) return;
    const x = row.closest('.lesson-x'), drawer = x.nextElementSibling, wasOpen = !drawer.classList.contains('closed');
    const scope = x.closest('.card-body');
    scope.querySelectorAll('.lesson-drawer').forEach(d => d.classList.add('closed'));
    scope.querySelectorAll('.lesson-row').forEach(r => r.setAttribute('aria-expanded', 'false'));
    if (wasOpen) return;
    drawer.classList.remove('closed'); row.setAttribute('aria-expanded', 'true');
    const body = drawer.firstElementChild;
    if (!body.dataset.loaded) { body.innerHTML = '<div class="loading" style="padding:1rem">Loading…</div>'; await fillLessonBody(body, +drawer.dataset.lessonBody, sc); }
    setTimeout(() => x.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
  }));
  bindActions(app);
}
async function fillLessonBody(el, lessonId, sc) {
  const [rows, parts] = await Promise.all([
    rest(`lessons?id=eq.${lessonId}&select=*`),
    rest(`lesson_parts?lesson_id=eq.${lessonId}&is_live=eq.true&is_archived=eq.false&order=order,index&select=*`),
  ]);
  const l = rows[0];
  if (!l) { el.innerHTML = '<div class="notice">Lesson not found.</div>'; return; }
  el.innerHTML = `<div class="card scheme-card bg-ultra-light-purple border-0 shadow mb-3 lesson-inline">
    ${lessonText(l) ? `<div class="row g-0"><div class="col px-3 pt-3 pb-2"><div class="media-body px-1">${lessonText(l)}</div></div></div>` : ''}
    <div class="row"><div class="col-12"><div class="card-body py-3">${renderParts(l, parts, true)}</div></div></div>
    <div class="row"><div class="col-12"><div class="card-body pt-0 pb-3 d-flex justify-content-end"><a class="btn btn-outline-primary btn-sm" href="${lessonHref(l, sc)}"><i class="bi-arrows-fullscreen me-1"></i> Open full page</a></div></div></div></div>`;
  el.dataset.loaded = '1';
  bindParts(el);
  logView(lessonId);
}
function lessonText(l) {
  let h = para(l.body_opening_text);
  for (const i of [1, 2, 3]) if (l[`body_subheading_${i}`]) h += `<h5 class="text-purple">${esc(l[`body_subheading_${i}`])}</h5>${para(l[`body_subheading_${i}_text`], 'text-mid-purple')}`;
  h += para(l.body_closing_text);
  return h;
}

async function pageLesson(id, scId) {
  app.innerHTML = '<div class="loading">Opening lesson…</div>';
  const [rows, parts] = await Promise.all([
    rest(`lessons?id=eq.${id}&select=*`),
    rest(`lesson_parts?lesson_id=eq.${id}&is_live=eq.true&is_archived=eq.false&order=order,index&select=*`),
  ]);
  const l = rows[0];
  if (!l || !l.is_live) { app.innerHTML = '<div class="notice">Lesson not found.</div>'; return; }
  if (!canAccessLesson(l)) { app.innerHTML = `<div class="notice"><strong>${esc(l.name)}</strong> - ${esc(E.lessonMessage)}${E.showUpgrade ? ` <a class="btn btn-primary btn-sm" href="${upgradeHref()}" style="margin-left:.6rem">${esc(E.upgradeText)}</a>` : ''}</div>`; return; }
  const scheme = D.schemeById[l.scheme_id];
  const sc = D.subcatById[scId] || (scheme && D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]]);
  const subject = sc && D.subjectById[sc.subject_id], sg = sc && D.subgroupById[sc.subgroup_id];
  setBg(l.background_image_url || sc?.background_image_url || subject?.background_image_url);
  const seq = scheme ? schemeLessons(scheme) : [l];
  const pos = seq.findIndex(x => x.id === l.id), prev = seq[pos - 1], next = seq[pos + 1];
  const label = sc ? noun(sc, 1) : 'lesson', Label = label.charAt(0).toUpperCase() + label.slice(1), Labels = (sc ? noun(sc, 2) : 'lessons').replace(/^./, c => c.toUpperCase());
  let html = crumbs([subject && { name: subject.name, href: `#/subject/${subject.id}` }, sg && { name: sg.name, href: `#/subject/${subject?.id}` }, sc && { name: sc.name, href: subcatHref(sc) }, scheme && { name: scheme.name }].filter(Boolean));
  html += `<div class="row"><div class="col-12 order-2 col-lg-9 order-lg-1"><div class="row"><div class="col-sm">
    <div class="card mb-5 scheme-card bg-ultra-light-purple border-0 shadow">
      <div class="row"><div class="col"><div class="card-header bg-primary bg-gradient-primary"><div class="col d-flex justify-content-between align-items-center px-0"><h5 class="text-truncate text-white mr-1 mb-0">${esc(l.name)}${l.heading_2 ? ` <small class="text-white-50 ml-0 ml-sm-2 d-block d-sm-inline">${esc(l.heading_2)}</small>` : ''}</h5><span class="d-flex flex-wrap justify-content-end text-nowrap text-light-purple fw-light py-1">${esc(ageText(l))}</span></div></div></div></div>
      <div class="row g-0"><div class="col px-3 pt-4 pb-3"><div class="media d-block d-md-flex align-items-center"><img src="${esc(img(scheme?.image))}" class="img-thumbnail shadow-sm img-fluid align-self-start ms-1 me-3 mb-3 mb-md-0 scheme-thumbnail" alt="${esc(l.name)}"><div class="media-body px-1">${lessonText(l)}</div></div></div></div>
      <div class="row mt-2"><div class="col-12"><div class="card-body py-3">${renderParts(l, parts, true)}</div></div></div>
      ${seq.length > 1 ? `<div class="row mt-2"><div class="col-12"><div class="card-body py-4"><div class="d-flex w-100 justify-content-between"><a href="${prev ? lessonHref(prev, sc) : '#'}" class="btn btn-outline-primary ${prev ? '' : 'disabled'}"><i class="bi-skip-backward-circle mr-1"></i> Previous ${esc(Label)}</a><a href="${next ? lessonHref(next, sc) : '#'}" class="btn ${next ? 'btn-primary' : 'btn-outline-primary disabled'}">Next ${esc(Label)} <i class="bi-skip-forward-circle-fill ms-1"></i></a></div></div></div></div>` : ''}
    </div></div></div></div>`;
  // Sidebar: What To Expect card (rotated, on a splodge), History / Mark as Done, Favourites
  const splodge = ['red', 'purple', 'mid-purple', 'orange', 'blue', 'pink'][Math.floor(Math.random() * 6)];
  const bg = !!l.background_image_url, btn = bg ? 'btn-primary' : 'btn-outline-primary';
  const item = (icon, text) => text ? `<div class="list-group-item text-purple text-nowrap text-truncate justify-content-center d-flex flex-column flex-fill align-middle"><div class="text-truncate"><i class="${icon} text-purple mr-1"></i> ${esc(text)}</div></div>` : '';
  html += `<div class="col-12 order-1 col-lg-3 order-lg-2">
    <div style="background-image: url(live/img/splodge-${splodge}.png); background-size: contain; background-repeat: no-repeat; background-position: center center; position: relative; top: 15px; margin-bottom: 45px;"><div class="w-100 h-100 px-xl-5"><div class="card border-primary h-100 justify-content-between shadow-lg rotated-4"><div class="list-group list-group-flush h-100">
      <div class="list-group-item active text-nowrap text-truncate justify-content-center d-flex flex-column flex-fill align-middle">What To Expect...</div>
      ${item('bi-lightning-charge', l.intensity)}${item('bi-lightbulb', l.focus)}${item('bi-clock', l.duration ? `About ${l.duration}m long` : '')}${item('bi-building', l.location && l.location.length ? `In the ${l.location.join(', ')}` : '')}${item('bi-watch', l.preparation ? `Prep in ${l.preparation}m` : '')}
    </div></div></div></div>
    <hr class="d-none d-lg-block mx-lg-2 ${bg ? 'border-mid-purple' : ''}">
    <div class="my-4 d-flex justify-content-between px-2"><a href="#/lesson/${l.id}/history" class="btn shadow ${btn}"><i class="d-none d-lg-inline bi-list-check mr-1"></i> History</a><button type="button" class="btn shadow ms-1 mark-as-complete ${btn}" data-done-for="${l.id}" data-bg="${bg ? 1 : 0}" data-label="${esc(Label)}"></button></div>
    <hr class="d-none d-lg-block mx-2 ${bg ? 'border-mid-purple' : ''}">
    <div class="d-none d-lg-block my-4 px-2"><button type="button" class="btn shadow add-to-favourites w-100 ${btn}" data-fav-for="${l.id}" data-bg="${bg ? 1 : 0}" data-label="${esc(Label)}" data-labels="${esc(Labels)}"></button></div>
    ${l.show_assessment ? `<div class="my-4 px-2"><button type="button" class="btn shadow w-100 ${btn}" data-thumb="${l.id}"><i class="bi-hand-thumbs-up me-2"></i>Thumb-o-meter</button></div><div class="d-none d-lg-block my-4 px-2 text-primary" id="readings"></div>` : ''}
    <div class="my-4 px-2"><button type="button" class="btn shadow w-100 curriculum-btn ${btn}" data-lesson-id="${l.id}"><i class="bi bi-bookmark-plus me-1"></i> Add to Curriculum</button></div>
  </div></div>`;
  app.innerHTML = html;
  reveal();
  bindParts(app);
  bindActions(app);
  logView(l.id);
  if (l.show_assessment) { renderReadings(l.id); app.querySelector('[data-thumb]').addEventListener('click', () => openThumb(l)); }
}

// Thumb-o-meter (lessons/show.blade.php #assessmentModal) and the readings list
async function renderReadings(lessonId) {
  const box = document.getElementById('readings'); if (!box) return;
  const rows = (await rpc('web_lesson_history', { p_lesson_id: lessonId })).filter(r => r.kind === 'assessment');
  if (!rows.length) { box.innerHTML = ''; return; }
  const block = (label, list) => list.length ? `<div>${label}</div><div class="row mb-3">` + list.slice(0, 5).map(r => `<div class="col-8 fw-light">${fmtDate(r.at)}</div><div class="col-4 fw-light">${Math.round(r.score * 100)}%</div>`).join('') + `</div>` : '';
  box.innerHTML = `<div class="mb-3">Your thumb-o-meter readings</div>` + block('Before the activity', rows.filter(r => r.before_or_after === 'B')) + block('After the activity', rows.filter(r => r.before_or_after === 'A'));
}
const fmtDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
const fmtTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function openThumb(l) {
  let pupils = 30; try { pupils = +localStorage.getItem('imoves.pupilCount') || (Auth.me() || {}).class_pupils || 30; } catch (e) {}
  let m = document.getElementById('assessmentModal');
  if (!m) { m = document.createElement('div'); m.id = 'assessmentModal'; m.className = 'modal fade'; m.tabIndex = -1; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal-dialog modal-lg text-primary"><div class="modal-content">
    <div class="modal-header bg-primary text-white"><h1 class="modal-title fs-5"><i class="bi-hand-thumbs-up me-2"></i> Thumb-o-meter</h1><button type="button" class="btn-close" data-close aria-label="Close"></button></div>
    <div class="modal-body"><div class="text-center text-primary"><h5>${esc(l.assessment_question || '')}</h5></div>
      <div class="row p-4">${[0, 1, 2].map(i => `<div class="col"><div class="flex"><div><img class="d-block mx-auto w-50" src="live/img/thumbometer-${i}.png" alt=""></div><div class="mt-2 text-center">${esc(l[`assessment_response_${i}`] || '')}</div></div></div>`).join('')}</div>
      <div class="border rounded border-primary bg-light-purple p-4"><form id="form-assessment">
        <div class="row mb-3"><label for="number_of_students" class="col-sm-4 col-form-label fw-light">Number of children present</label><div class="col-sm-3"><input type="number" min="1" value="${pupils}" class="form-control" name="pupil_count" id="number_of_students" required></div></div>
        <div class="row mb-3"><label for="number_of_thumbsup" class="col-sm-4 col-form-label fw-light">Number of 'thumbsup'</label><div class="col-sm-3"><input type="number" class="form-control" value="0" min="0" name="thumb_count" id="number_of_thumbsup" max="${pupils * 2}" required></div></div>
        <fieldset class="row mb-3"><legend class="col-form-label fw-light col-sm-5 pt-0">Measurement before or after activity?</legend><div class="col-sm-5">
          <div class="form-check form-check-inline"><input class="form-check-input" type="radio" name="before_or_after" id="inlineRadio1" value="B" required><label class="form-check-label fw-light" for="inlineRadio1">Before</label></div>
          <div class="form-check form-check-inline"><input class="form-check-input" type="radio" name="before_or_after" id="inlineRadio2" value="A"><label class="form-check-label fw-light" for="inlineRadio2">After</label></div></div></fieldset>
        <div class="text-danger small d-none" id="assess-err"></div>
      </form></div></div>
    <div class="modal-footer"><button type="button" class="btn btn-primary" id="btn-submit-form-assessment"><i class="bi-hand-thumbs-up me-2"></i>Save</button><button type="button" class="btn btn-secondary" data-close>Cancel</button></div>
  </div></div>`;
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => hideModal('assessmentModal')));
  m.addEventListener('click', e => { if (e.target === m) hideModal('assessmentModal'); });
  m.querySelector('#number_of_students').addEventListener('input', e => { m.querySelector('#number_of_thumbsup').max = (+e.target.value || 0) * 2; });
  m.querySelector('#btn-submit-form-assessment').addEventListener('click', async () => {
    const f = m.querySelector('#form-assessment'); if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f)); const err = m.querySelector('#assess-err');
    try {
      await saveAssessment(l.id, { pupil_count: +d.pupil_count, thumb_count: +d.thumb_count, before_or_after: d.before_or_after });
      try { localStorage.setItem('imoves.pupilCount', d.pupil_count); } catch (e) {}
      hideModal('assessmentModal'); renderReadings(l.id);
    } catch (x) { err.textContent = 'Could not save: ' + x.message; err.classList.remove('d-none'); }
  });
  showModal('assessmentModal');
}

// Lesson history (lesson/history.blade.php)
async function pageLessonHistory(id) {
  app.innerHTML = '<div class="loading">Loading history…</div>';
  const [[l], rows] = await Promise.all([rest(`lessons?id=eq.${id}&select=id,name,heading_2`), rpc('web_lesson_history', { p_lesson_id: id })]);
  if (!l) { app.innerHTML = '<div class="notice">Lesson not found.</div>'; return; }
  setBg(null);
  const table = (title, list) => `<div class="heading-2">${title}</div><table class="viewed-table table table-borderless text-1 text-primary"><thead><tr><th class="pl-0">Date</th><th class="pl-0">Time</th></tr></thead><tbody>${list.map(r => `<tr><td class="pl-0">${fmtDate(r.at)}</td><td class="pl-0">${fmtTime(r.at)}</td></tr>`).join('') || '<tr><td class="pl-0 fw-light" colspan="2">None yet</td></tr>'}</tbody></table>`;
  app.innerHTML = `<div class="content-page-nav d-flex justify-content-center mb-3 mt-4"><div class="back d-inline-block"><a href="#/lesson/${l.id}" class="nav-button d-block text-1"><img class="arrow-img" src="live/img/arrow_next.png" alt=""><span class="nav-text">Back</span></a></div></div>
    <div class="lesson-history-container form-page container-fluid text-primary"><div class="row"><div class="col-12 heading-1 text-center">Lesson history</div></div><div class="row mt-3 mb-4"><div class="col-12 heading-2">${esc(l.name)}</div></div>
    <div class="row"><div class="col-12 col-sm-6">${table('Marked as done', rows.filter(r => r.kind === 'completed'))}</div><div class="col-12 col-sm-6">${table('Viewed', rows.filter(r => r.kind === 'viewed'))}</div></div></div>`;
  reveal();
}

// Favourites (results/show-favourites.blade.php): personal favourites grouped by subject.
async function pageFavourites() {
  setBg(null);
  const ids = [...MY.fav];
  let html = `<div class="row"><div class="col-xs-12 col-6 my-3 mb-0"><h4 class="text-primary"><span class="badge bg-warning me-2"><i class="bi-star-fill" style="position: relative; bottom: 1px;"></i></span><span class="d-none d-md-inline">My Favourite Lessons</span><span class="d-inline d-md-none">Favourites</span></h4></div>
    <div class="col-xs-12 col-6 my-3 mb-0"><div class="text-end">${(Auth.me() || {}).is_admin ? '<small class="text-primary fw-light">Your Favourites are shared automatically across all authorised users at your school</small>' : ''}</div></div><div class="col-12" style="margin-top: -0.5em"><hr></div></div>`;
  if (!ids.length) {
    html += `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white"><i class="bi-star-fill mr-1 text-warning"></i> Favourite Lessons</h5><div class="card-body pb-1"><div class="row"><div class="col-12"><div class="filtered-out-notice alert d-block alert-primary bg-extra-light-purple border-primary mb-4" role="alert"><p class="text-primary my-0 d-flex justify-content-between align-items-center"><span><span class="text-primary h5">You haven't favourited any lessons yet.</span> <span class="text-mid-purple ms-1">To save a lesson to your favourites, click the <i class="bi-star mx-1 text-primary"></i> icon.</span></span></p></div></div></div></div></div></div></div>`;
    app.innerHTML = html; reveal(); return;
  }
  const lessons = await rest(`lessons?id=in.(${ids.join(',')})&select=id,name,description,body_opening_text,scheme_id,age_min,age_max,duration&order=name`);
  const bySubject = {};
  for (const l of lessons) {
    const scheme = D.schemeById[l.scheme_id]; const sc = scheme && D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]]; const subj = sc && D.subjectById[sc.subject_id];
    (bySubject[subj ? subj.name : 'Other'] ||= { sc, items: [] }).items.push({ l, scheme, sc });
  }
  for (const [name, g] of Object.entries(bySubject)) {
    const n = g.items.length, lab = (g.sc ? noun(g.sc, n) : (n === 1 ? 'lesson' : 'lessons')).toLowerCase();
    html += `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white">${esc(name)} <small class="text-white-50 ml-0 ml-sm-2 d-block d-sm-inline">${n} favourite ${esc(lab)}</small></h5><div class="card-body pb-1"><div class="row">`;
    for (const { l, scheme, sc } of g.items) {
      const blurb = (l.description || l.body_opening_text || '').trim();
      html += `<div class="col-12 col-md-6 col-lg-3 mb-4"><a href="${lessonHref(l, sc)}" class="text-decoration-none"><div class="card subcategory-card lift h-100 shadow-sm d-flex flex-column"><img src="${esc(img(scheme?.image))}" class="card-img-top" alt="${esc(l.name)}" loading="lazy"><div class="card-body border-top border-primary p-0 d-flex flex-column justify-content-between"><div class="align-self-start w-100 flex-grow-1"><div class="pt-2 d-flex flex-column w-100 h-100 justify-content-center"><h5 class="text-primary ${blurb ? 'mt-3 mb-1' : 'my-3'} mx-3 card-title text-truncate"><small class="text-mid-purple mb-2">${esc(scheme ? scheme.name : '')}<br></small>${esc(l.name)}</h5>${blurb ? `<h6 class="h6 text-mid-purple fw-light mb-3 mx-3 card-title">${esc(limit(blurb, 100))}</h6>` : ''}</div></div>
        <ul class="list-group border-0 list-group-flush list-group-horizontal text-mid-purple small text-nowrap justify-content-around"><li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="lesson-icon text-truncate"><i class="bi-person text-purple mr-1"></i> <span>${esc(ageText(l))}</span></span></li>${l.duration ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="lesson-icon text-truncate ms-2 ml-lg-3 my-1"><i class="bi-clock text-purple mr-1"></i> ${l.duration}m</span></li>` : ''}</ul></div></div></a></div>`;
    }
    html += `</div></div></div></div></div>`;
  }
  app.innerHTML = html; reveal();
}

// Lesson parts accordion (lessons/lesson-part.blade.php + the per-type cards). One open at a time.
function renderParts(l, parts, openFirst) {
  if (!parts.length) return '<div class="notice">This lesson has no live parts at the moment.</div>';
  return `<div class="accordion list-group shadow mt-0 mb-2" id="lesson-${l.id}-parts">` + parts.map((p, i) => {
    const show = openFirst && i === 0;
    const info = p.additional_info && p.additional_info.trim();
    const infoHtml = info ? para(p.additional_info) : '';
    let card = '';
    switch (p.media_type) {
      case 'Video': card = `<div class="media d-block d-md-flex align-items-center"><div class="img-thumbnail shadow-sm img-fluid ${info ? 'w-50' : 'w-100'} align-self-start ms-1 me-3 mb-3 mb-md-0">${p.wistia_id ? wistia(p.wistia_id) : '<div class="notice">No video id on this part.</div>'}</div><div class="media-body px-1 ${info ? '' : 'd-none'}">${infoHtml}</div></div>`; break;
      case 'Audio': card = `<div class="media d-block align-items-center"><div class="img-thumbnail shadow-sm img-fluid w-100 px-2 ${info ? 'mb-4' : ''}"><audio controls controlsList="nodownload" style="width:100%;" class="mt-2" preload="none"><source src="${esc(p.s3_url)}" type="audio/mpeg"></audio></div>${info ? `<div class="media-body w-100 px-1">${infoHtml}</div>` : ''}</div>`; break;
      case 'Download': card = `<div class="media d-block align-items-center"><div class="border border-primary bg-light-purple rounded p-2 ${info ? 'mb-4' : ''}"><a href="${esc(p.s3_url)}" download class="btn btn-primary" target="_blank" rel="noopener"><i class="bi-cloud-download me-2"></i>${esc(p.download_button || 'Download File')}</a><span class="ms-3 text-primary">${esc(p.download_info || 'Save and open this file to complete this part of the lesson.')}</span></div>${info ? `<div class="media-body w-100 px-1">${infoHtml}</div>` : ''}</div>`; break;
      case 'Slides': card = `<div class="media d-block d-md-flex align-items-center"><div class="img-thumbnail shadow-sm img-fluid ${info ? 'w-50' : 'w-100'} align-self-start me-3 p-2"><div class="slideshow-container" style="position: relative; width: 100%; min-height: ${info ? '280px' : '560px'};"><iframe src="https://docs.google.com/presentation/d/e/${esc(p.google_slide_id)}/embed?start=false&loop=false&delayms=60000" frameborder="0" allowfullscreen style="width: 100%; height: 100%; position:absolute; inset:0;" title="Slides"></iframe></div><small class="d-block text-mid-purple fw-light mt-2">Click the dots (<i class="text-primary bi-three-dots-vertical"></i>) to play in full-screen.</small></div><div class="media-body px-1 ${info ? '' : 'd-none'}">${infoHtml}</div></div>`; break;
      case 'Image': card = `<div class="media d-block d-md-flex align-items-center"><img src="${esc(p.s3_url)}" alt="${esc(p.heading || '')}" class="img-thumbnail shadow-sm img-fluid ${info ? 'w-50' : 'w-100'} align-self-start me-3 p-2" loading="lazy"><div class="media-body px-1 ${info ? '' : 'd-none'}">${infoHtml}</div></div>`; break;
      default: card = infoHtml || '<p class="card-text text-mid-purple fw-light mb-1">No content.</p>';
    }
    const dur = p.duration && p.duration.trim() !== ':' ? `<span class="d-flex justify-content-end w-100 text-muted text-mid-purple fw-light"><span class="lesson-icon text-truncate ms-2 my-1"><i class="bi-stopwatch text-purple mr-1"></i> ${esc(p.duration)}</span></span>` : '';
    return `<div class="list-group-item list-group-item-action lesson-collapse cursor-pointer px-3 lesson-part-item ${show ? 'active-part' : ''}" data-part="${p.id}">
      <div class="row part-head" role="button" aria-expanded="${show}"><div class="col d-flex align-items-center"><div class="d-flex justify-content-start align-items-center pe-1"><i class="text-primary ${partIcon(p)} h5 mt-2 me-2"></i></div><div class="d-flex flex-grow-1 flex-wrap align-items-center mt-2 mb-1"><h5 class="w-100 text-primary mb-0">${esc(p.heading || p.media_type)}</h5></div><div class="d-none d-md-flex flex-shrink-0 flex-column align-items-center">${dur}<span class="d-flex justify-content-end w-100 text-muted text-mid-purple fw-light"><small class="ms-1 text-mid-purple">${esc(p.live_part_label || '')}</small></span></div></div></div>
      <div class="collapse-smooth part-body ${show ? '' : 'closed'}"><div><hr><div class="col p-3">${card}</div></div></div>
    </div>`;
  }).join('') + `</div>`;
}
function bindParts(root) {
  root.querySelectorAll('.lesson-part-item .part-head').forEach(h => h.addEventListener('click', e => {
    if (e.target.closest('a, audio, iframe, button')) return;
    const item = h.closest('.lesson-part-item'), body = item.querySelector('.part-body'), wasOpen = !body.classList.contains('closed');
    item.closest('.accordion').querySelectorAll('.part-body').forEach(b => b.classList.add('closed'));
    item.closest('.accordion').querySelectorAll('.part-head').forEach(x => x.setAttribute('aria-expanded', 'false'));
    if (wasOpen) return;
    body.classList.remove('closed'); h.setAttribute('aria-expanded', 'true');
  }));
}

// Search results (results/partials/results-list.blade.php): a title, then one panel per
// subject holding scheme cards for the schemes with matching lessons.
async function pageSearch(q) {
  setBg(null);
  if (!q.trim()) { app.innerHTML = '<div class="notice mt-4">Use Search in the header to find lessons by title, topic, subject or lesson ID.</div>'; return; }
  app.innerHTML = '<div class="loading">Searching…</div>';
  const term = q.trim().replace(/[%,.()]/g, ' ').replace(/\s+/g, ' ');
  const rows = await rest(`lessons?is_live=eq.true&search=ilike.*${encodeURIComponent(term)}*&select=id,name,scheme_id,is_freemium,age_min,age_max&order=order&limit=500`);
  const live = rows.filter(l => D.lessonById[l.id] && canAccessLesson(l));   // inaccessible lessons are hidden, as live
  logSearch(q.trim(), live.length);
  const bySubject = {};
  for (const l of live) {
    const scheme = D.schemeById[l.scheme_id]; if (!scheme) continue;
    const sc = D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]]; const subj = sc ? D.subjectById[sc.subject_id] : null;
    const g = (bySubject[subj ? subj.id : 0] ||= { subject: subj, schemes: {} });
    (g.schemes[scheme.id] ||= { scheme, sc, lessons: [] }).lessons.push(l);
  }
  let html = `<div class="results-page-title d-flex flex-wrap mt-4"><div class="mt-2 heading-2 heading-xs text-primary mr-auto mb-3">Search results for "${esc(q)}"</div></div>`;
  const groups = Object.values(bySubject);
  if (!groups.length) html += `<div class="notice">No lessons match "${esc(q)}".</div>`;
  for (const g of groups) {
    html += `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white">${esc(g.subject ? g.subject.name : 'Other')}</h5><div class="card-body pb-1"><div class="row">`;
    for (const { scheme, sc, lessons } of Object.values(g.schemes)) {
      const ages = ageRange(lessons), name = `${scheme.name}${ages ? ' (' + ageTextRange(ages) + ')' : ''}`;
      const href = lessons.length === 1 ? lessonHref(lessons[0], sc) : (sc ? subcatHref(sc) + `#scheme-${scheme.id}` : lessonHref(lessons[0], sc));
      html += `<div class="col-12 col-md-6 col-lg-3 mb-4"><a href="${href}" class="text-decoration-none"><div class="card subcategory-card lift h-100 shadow-sm d-flex flex-column"><img src="${esc(img(scheme.image))}" class="card-img-top" alt="${esc(name)}" loading="lazy"><div class="card-body border-top border-primary p-0 d-flex flex-column justify-content-between"><div class="align-self-start w-100 flex-grow-1"><div class="pt-2 d-flex flex-column w-100 h-100 justify-content-center"><h5 class="text-primary mx-3 card-title text-truncate"><small class="text-mid-purple mb-2">${esc(name)}<br></small></h5></div></div></div></div></a></div>`;
    }
    html += `</div></div></div></div></div>`;
  }
  app.innerHTML = html;
  reveal();
}

// ---------- boot ----------
// Auth first (Phase 1): no content without signing in, as on the live platform.
// Auth.init() restores a saved session; otherwise auth.js shows the sign-in screen
// and calls startApp() itself after a successful sign-in.
async function startApp() {
  try {
    app.innerHTML = '<div class="loading">Loading the library…</div>';
    initEntitlements();
    await Promise.all([loadTree(), loadMyLessons()]);
    renderSubjectBar();
    renderUserContext();
    renderUserMenu();
    renderBrowse();
    bindSearchModal();
    bindSubjectScroll();
    Auth.renderUser();
    const picker = document.getElementById('classage');
    // "Show lessons suitable for": the user's saved filter (Users fid 569) as on the live site;
    // a change made here is kept locally until the Phase 1 profile write lands.
    const me = Auth.me() || {};
    let saved = null; try { saved = localStorage.getItem('imoves.classAge'); } catch (e) {}
    if (saved === null && me.filter_age_min != null) saved = String(me.filter_age_min);
    try { picker.value = saved || ''; } catch (e) { picker.value = ''; }
    picker.addEventListener('change', () => { try { localStorage.setItem('imoves.classAge', picker.value); } catch (e) {} route(); });
    route();
  } catch (e) {
    app.innerHTML = `<div class="notice">Could not load content: ${esc(e.message)}</div>`;
  }
}
(async () => {
  document.getElementById('stamp').textContent = LOADED_AT;
  if (await Auth.init()) await startApp();
})();
