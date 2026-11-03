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
  const text = await r.text();
  if (!r.ok) { let msg = `${name}: ${r.status}`; try { const j = JSON.parse(text); if (j.message) msg = j.message; } catch (e) {} throw new Error(msg); }
  return text ? JSON.parse(text) : null;
}

const D = {}; // in-memory copy of the tree
async function loadTree() {
  const [subjects, subgroups, subcategories, schemes, links, lessons, subjectLinks] = await Promise.all([
    rest('subjects?select=*&order=order', { all: true }),
    rest('subgroups?select=*&order=order', { all: true }),
    rest('subcategories?select=id,name,order,homepage_order,image,background_image_url,description,subheading,is_live,is_schemes,is_direct_resource,is_redirect_to_category,is_redirect_to_lesson,is_redirect_to_url,is_direct_resource_different_for_free,direct_resource_heading_all,direct_resource_heading_free,direct_resource_heading_paid,direct_resource_text_all,direct_resource_text_free,direct_resource_text_paid,direct_resource_wistia_id_all,direct_resource_wistia_id_free,direct_resource_wistia_id_paid,direct_resource_wistia_duration_all,direct_resource_wistia_duration_free,direct_resource_wistia_duration_paid,is_direct_resource_linked,direct_resource_link_text,direct_resource_link_url,subject_id,subgroup_id,subcategory_redirect_id,lesson_redirect_id,url_redirect,content_noun_derived_plural,content_noun_derived_singular,is_visible_on_homepage,show_all,show_free,show_trial,show_paying&order=order', { all: true }),
    rest('schemes?select=id,name,subheading,description,body_opening_text,body_closing_text,body_subheading_1,body_subheading_1_text,body_subheading_2,body_subheading_2_text,body_subheading_3,body_subheading_3_text,is_live,is_freemium,image,order', { all: true }),
    rest('scheme_subcategories?select=*', { all: true }),
    rest('lessons?select=id,name,is_live,scheme_id,order,description,is_freemium,age_min,age_max,duration,has_video,has_audio,has_downloads,has_slides,has_lesson_plan,has_assessment_template,subject_ids&order=order', { all: true }),
    rest('scheme_subjects?select=scheme_id,subject_id', { all: true }),
  ]);
  D.subjects = subjects.filter(s => s.is_live && (!E.niched || E.nicheIds.has(s.id)));   // LiveScope + NicheScope
  D.subgroups = subgroups.filter(s => s.is_live);
  D.subcategories = subcategories.filter(s => s.is_live);
  D.schemes = schemes.filter(s => s.is_live);
  D.lessons = lessons.filter(l => l.is_live);
  D.subjectById = index(D.subjects); D.subgroupById = index(D.subgroups); D.subcatById = index(D.subcategories);
  D.schemeById = index(D.schemes); D.lessonById = index(D.lessons);
  D.lessons.sort((a, b) => (a.order ?? -1e12) - (b.order ?? -1e12) || a.id - b.id);
  D.lessonsByScheme = group(D.lessons, 'scheme_id');
  D.schemesBySubcat = {}; D.subcatsByScheme = {};
  for (const l of links) {
    // Scheme::qbRelationMap reads three category fields (527, 537, 544). The shared table also holds
    // the CMS PoC's links from fields 702-704 (positions 4-6), which the live platform never reads.
    if (l.position > 3) continue;
    const s = D.schemeById[l.scheme_id]; if (!s) continue;
    (D.schemesBySubcat[l.subcategory_id] ||= []).push(s);
    (D.subcatsByScheme[l.scheme_id] ||= []).push(l.subcategory_id);
  }
  for (const k in D.schemesBySubcat) D.schemesBySubcat[k].sort(byOrder);
  D.subjectsByScheme = {};
  for (const l of subjectLinks) (D.subjectsByScheme[l.scheme_id] ||= []).push(l.subject_id);
  D.ageKeys = null;
  D.subgroupsBySubject = group(D.subgroups, 'subject_id');
  D.subcatsBySubgroup = group(D.subcategories, 'subgroup_id');
  D.loadedAt = new Date();
}
const index = rows => Object.fromEntries(rows.map(r => [r.id, r]));
function group(rows, key) { const g = {}; for (const r of rows) (g[r[key]] ||= []).push(r); return g; }
// OrderScope in MySQL: an empty order sorts first.
const byOrder = (a, b) => (a.order ?? -1e12) - (b.order ?? -1e12) || String(a.name || '').localeCompare(String(b.name || ''));

// ---------- visibility and access (v0.40) ----------
// A port of the live rules, not a deduction from what the pages show. Project doc:
// web-frontend/visibility-rules-v0.1.md. Sources are named against each function.
// Applied client-side for now; API-level enforcement comes at cutover, when anon read of the
// content tables (which the CMS PoC still relies on) is withdrawn.
const E = {};
function initEntitlements() {
  const m = Auth.me() || {};
  E.allContent = !!m.all_content; E.allSubjects = !!m.all_subjects;
  E.allAges = !!m.all_ages; E.ageRights = m.age_rights || [];
  E.userSubjects = new Set(m.subject_ids || []);                                    // $user->subjects (fid 152)
  E.subjectIds = new Set([...(m.subject_ids || []), ...(m.niche_subject_ids || [])]);   // plus $user->nicheSubjects
  E.niched = !!m.is_niched && (m.niche_subject_ids || []).length > 0;               // Nichable::isNiched
  E.nicheIds = new Set(m.niche_subject_ids || []);
  E.freeAll = !!m.free_all; E.trialAll = !!m.trial_all; E.payingAll = !!m.paying_all;
  E.complementary = !!m.has_complementary_access;
  E.showBrowseMenu = m.show_browse_menu !== false;
  E.homepage = m.homepage_subject_id || null;
  E.buttons = m.subject_button_ids || []; E.browse = m.browse_menu_ids || [];
  E.homeSections = m.home_section_ids || [];
  E.lessonMessage = m.lesson_message_1 || 'This lesson isn’t included in your subscription.';
  E.upgradeText = m.lesson_upgrade_button_text || 'Upgrade';
  E.showUpgrade = !!m.show_upgrade_button;
}
// SubjectPolicy::view, SubgroupPolicy::view and SubcategoryPolicy::view are the same test.
// Show lists and buttons only: nothing on the live site blocks opening a subject or category page.
function canView(x) {
  return !!(x.show_all || (x.show_free && E.freeAll) || (x.show_trial && E.trialAll) || (x.show_paying && E.payingAll));
}
const canViewSubject = canView;
// User::canAccessSubject
function canAccessSubject(s) { return E.allContent || E.allSubjects || (!!s && E.userSubjects.has(s.id)); }
// Lesson::subjects: the lesson's own subjects (Lessons fid 944), through Subject's LiveScope and NicheScope.
function lessonSubjects(l) {
  return [...new Set((l.subject_ids || []).map(Number))].filter(id => D.subjectById[id]);
}
// LessonPolicy::access. withAge false is LessonPolicy::withoutAgeFilters(), which search uses.
function canAccessLesson(l, withAge = true) {
  if (l.is_freemium || E.allContent) return true;
  if (!E.allSubjects && !lessonSubjects(l).some(id => E.subjectIds.has(id))) return false;
  if (!withAge || E.allAges) return true;
  if (l.age_min == null) return false;
  return E.ageRights.some((on, k) => on && l.age_min <= 4 + k && l.age_max >= 5 + k);
}
// Scheme::isViewable. Greys the scheme card and removes its Add to Curriculum button.
function schemeViewable(s) {
  if (s.is_freemium || E.allContent) return true;
  return (D.subjectsByScheme[s.id] || []).some(id => D.subjectById[id] && E.userSubjects.has(id));
}
// FilterScope, a global scope on Lesson. "Show lessons suitable for" removes lessons from every
// query, and everything above a lesson needs a lesson to exist (Scheme, Subcategory and Subgroup
// relations all use whereHas), so a category or group with no lesson for the age disappears.
// Filterable::scopeAgeRange only applies the age when it is in HasSubjectFilters::ageFilters()
// for the subject in the URL; with no subject in the URL it is HasFilters::$AGE_FILTERS.
let ROUTE_SUBJECT = null;
const STATIC_AGE_KEYS = new Set([4, 5, 6, 7, 8, 9, 10]);
function ageKeys(subjectId) {
  if (!subjectId) return STATIC_AGE_KEYS;
  if (!D.ageKeys) {
    D.ageKeys = {};
    for (const l of D.lessons) for (const id of new Set((l.subject_ids || []).map(Number))) {
      const keys = (D.ageKeys[id] ||= new Set());
      // Same loop as ageFilters(): includes age_max itself, and runs once when age_max is empty.
      let i = l.age_min;
      do { if (i != null) keys.add(i); i = i == null ? 1 : i + 1; } while (l.age_max != null && i <= l.age_max);
    }
  }
  return D.ageKeys[subjectId] || new Set();
}
function passesAgeFilter(l, subjectId = ROUTE_SUBJECT) {
  const a = classAge();
  if (a == null || !ageKeys(subjectId).has(a)) return true;
  return l.age_min != null && l.age_max != null && l.age_min <= a && l.age_max >= a + 1;
}
// filtered false is FilterScope::ignore(), which the browse menu and curriculum use.
function schemeLessons(scheme, filtered = true) {
  const all = D.lessonsByScheme[scheme.id] || [];
  return filtered ? all.filter(l => passesAgeFilter(l)) : all;
}
// Subcategory::schemes: live schemes with at least one lesson.
function subcatSchemes(sc, filtered = true) { return (D.schemesBySubcat[sc.id] || []).filter(s => schemeLessons(s, filtered).length > 0); }
function subcatLessons(sc, filtered = true) { return subcatSchemes(sc, filtered).flatMap(s => schemeLessons(s, filtered)); }
// Subgroup::subcategories: live, and either has schemes or is not a scheme-based category.
function subgroupSubcats(sg, filtered = true) {
  return (D.subcatsBySubgroup[sg.id] || []).filter(sc => !sc.is_schemes || subcatSchemes(sc, filtered).length > 0).sort(byOrder);
}
// Subject::subgroups. Its whereHas reads as "with at least one of those categories", but the ungrouped
// orWhere(is_schemes = false) in Subgroup::subcategories escapes the join to the group, so one live
// non-scheme category anywhere passes every group. In effect: all the subject's live groups. So an age
// filter never empties this list, and the browse menu can show a group heading with nothing under it.
function subjectSubgroups(subjectId) {
  return (D.subgroupsBySubject[subjectId] || []).slice().sort(byOrder);
}
// subgroup-card.blade.php: the cards on a subject page.
function visibleSubcats(sg) { return subgroupSubcats(sg).filter(sc => canView(sc) && sc.is_visible_on_homepage); }
// Subcategory::directResourceVideo: which version of a category's video this user gets.
function directResource(sc) {
  if (!sc.is_direct_resource || !(sc.direct_resource_wistia_id_all || sc.direct_resource_wistia_id_paid || sc.direct_resource_wistia_id_free)) return null;
  const v = sc.is_direct_resource_different_for_free ? (canAccessSubject(D.subjectById[sc.subject_id]) && !E.complementary ? 'paid' : 'free') : 'all';
  return { id: sc[`direct_resource_wistia_id_${v}`], heading: sc[`direct_resource_heading_${v}`], text: sc[`direct_resource_text_${v}`], duration: sc[`direct_resource_wistia_duration_${v}`] };
}
// Subject::featuredVideo.
function featuredVideo(s) {
  if (!s.is_featuring_video || (s.force_age_selection && !classAge())) return null;
  const a = classAge();
  const v = canAccessSubject(s) ? (a && a <= 6 ? 'paid_ks1' : 'paid_ks2') : 'free';   // User::isKeyStage1: ages 4-5, 5-6 and 6-7
  const id = s[`featured_video_wistia_id_${v}`];
  return id ? { id, heading: s[`featured_video_heading_${v}`], sub: s[`featured_video_subheading_${v}`], desc: s[`featured_video_description_${v}`] } : null;
}
// filters/filtered-out-notice.blade.php with total 0.
const AGE_NOTICE = `<div class="d-flex align-items-center justify-content-center"><div class="filtered-out-notice alert alert-primary border-primary mt-3" role="alert"><h4 class="alert-heading text-primary mt-2">Remove Age Filter for More <i class="bi-exclamation-circle ms-2 text-danger float-end"></i></h4><hr><button type="button" class="btn btn-primary filter-clear-btn filter-clear-age my-2" id="clearage">&times; Click here to remove your age filter</button></div></div>`;
function bindClearAge() {
  const b = document.getElementById('clearage'); if (!b) return;
  b.addEventListener('click', () => { saveClassAge(''); const p = document.getElementById('classage'); if (p) p.value = ''; route(); });
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
  .replace(/&lt;br ?\/?&gt;/g, '<br>')
  .replace(/\r?\n/g, '<br>');   // nl2br, as the live templates
const img = p => p ? (p.startsWith('http') ? p : CF + p) : CF + 'defaultimages/default_s.png';
const limit = (s, n) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');
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
// The age filter is the user's own (Users fid 569, saved to user_profile_edits as on live).
function classAge() { const m = Auth.me() || {}; return m.filter_age_min != null ? +m.filter_age_min : null; }
async function saveClassAge(v) {
  const me = Auth.me() || {}; me.filter_age_min = v === '' || v == null ? null : +v;
  try { await restWrite('user_profile_edits?on_conflict=user_id', { user_id: uid(), filter_age_min: me.filter_age_min, filter_age_set: true }); } catch (e) { /* best effort */ }
}
// home/partials/age-selection-modal.blade.php: shown, with no close button, to users flagged
// force_age_selection (Users fid 567) and on subjects flagged force_age_selection, until an
// age range is chosen.
const AGE_LABELS = { 4: '4–5', 5: '5–6', 6: '6–7', 7: '7-8', 8: '8–9', 9: '9–10', 10: '10–11' };   // HasFilters::$AGE_FILTERS
function maybeForceAge(subj) {
  const me = Auth.me() || {};
  const need = classAge() == null && ((subj && subj.force_age_selection) || me.force_age_selection);
  let m = document.getElementById('age-selection-modal');
  if (!need) { if (m && m.classList.contains('show')) hideModal('age-selection-modal'); return; }
  if (!m) { m = document.createElement('div'); m.id = 'age-selection-modal'; m.className = 'modal fade'; m.tabIndex = -1; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal-dialog"><div class="modal-content"><div class="modal-header bg-primary bg-gradient-primary"><h5 class="modal-title text-white"><i class="bi-person-lines-fill me-2"></i>Set Your Preferred Age Range</h5></div>
    <div class="modal-body bg-extra-light-purple py-3"><form class="d-lg-block" id="age-selection-form"><div class="card" id="age-filter-card"><div class="card-body"><div id="age-fields" class="d-lg-block">
      <div class="form-group pt-0 mb-0"><label for="inputModalAgeRange" class="text-primary text-center mb-0">So we can show you the most relevant lessons, please select your preferred age range from the list below.</label><hr>
      <div class="row"><div class="col-12 col-lg-10 offset-lg-1"><select class="custom-control custom-select form-select text-purple mt-2" id="inputModalAgeRange" name="age"><option value="" selected>Select an age range...</option>${Object.entries(AGE_LABELS).map(([v, l]) => `<option value="${v}">Show lessons for ages ${l}</option>`).join('')}</select>
      <small class="text-mid-purple d-block text-center mt-2">You can change your age range at any time via the sidebar.</small></div></div><hr></div></div>
      <div class="form-group mt-2 mb-0 pt-2 d-flex justify-content-center"><button type="submit" class="btn btn-primary" id="ageSelectionBtn" disabled><i class="bi-check-circle text-white me-1"></i> Save and Continue</button></div></div></div></form></div></div></div>`;
  const sel = m.querySelector('#inputModalAgeRange'), btn = m.querySelector('#ageSelectionBtn');
  sel.addEventListener('change', () => { btn.disabled = !sel.value; });
  m.querySelector('#age-selection-form').addEventListener('submit', async e => {
    e.preventDefault(); if (!sel.value) return; btn.disabled = true;
    await saveClassAge(sel.value);
    const picker = document.getElementById('classage'); if (picker) picker.value = sel.value;
    hideModal('age-selection-modal'); route();
  });
  showModal('age-selection-modal');
  const bd = document.getElementById('poc-backdrop'); if (bd) bd.onclick = null;   // data-backdrop="static": no closing
}
function coversClass(range) { const a = classAge(); if (a == null || !range) return false; const [lo, hi] = range.split('-').map(Number); return lo <= a && a + 1 <= hi; }
function noun(sc, n) { return n === 1 ? (sc.content_noun_derived_singular || 'lesson') : (sc.content_noun_derived_plural || 'lessons'); }
// Subcategory::isFreemium
function subcatIsFree(sc) { return subcatSchemes(sc).some(s => s.is_freemium); }
function subcatHref(sc) { return `#/subject/${sc.subject_id}/subcategory/${sc.id}`; }
function lessonHref(l, sc) { return `#/lesson/${l.id}` + (sc ? `?sc=${sc.id}` : ''); }
function wistia(id) { return `<div class="wistia-ratio videobox"><iframe src="https://fast.wistia.net/embed/iframe/${esc(id)}?videoFoam=true" allow="autoplay; fullscreen" allowfullscreen title="Video"></iframe></div>`; }
function setBg(url) { document.body.style.backgroundImage = url ? `url('${url.replace(/ /g, '%20')}')` : ''; document.body.classList.toggle('with-bg-img', !!url); document.body.classList.remove('bg-no-margin'); }

// ---------- routing ----------
const app = document.getElementById('app-page');
function reveal() { /* v0.32: no reveal animation, as live */ }
window.addEventListener('hashchange', route);
async function route() {
  const hash = location.hash.slice(1) || '/';
  const [pathPart, query = ''] = hash.split('?');
  const qs = Object.fromEntries(new URLSearchParams(query));
  const p = pathPart.split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (p[0] || 'home')));
  document.querySelectorAll('#scrollable-navbar .subject-button').forEach(a => a.classList.toggle('active', p[0] === 'subject' && a.dataset.id === p[1]));
  const subj = p[0] === 'subject' ? D.subjectById[+p[1]] : null;
  ROUTE_SUBJECT = p[0] === 'subject' ? +p[1] : null;   // Filterable::subjectContext
  const an = document.getElementById('agenoun'); if (an) an.textContent = subj && subj.name === 'Active Blasts' ? 'activities' : 'lessons';   // Subject::lessonLabel() - hard-coded on the live site
  const allAges = document.querySelector('#classage option[value=""]'); if (allAges) allAges.hidden = !!(subj && subj.force_age_selection);
  maybeForceAge(subj);
  const hf = document.getElementById('headerfilter'); if (hf) hf.classList.toggle('hidden', p[0] === 'curriculum' || p[0] === 'profile' || p[0] === 'school-management' || p[0] === 'my-school');
  const af = document.getElementById('agefilter'); if (af) af.classList.toggle('hidden', p[0] === 'search' || p[0] === 'favourites');   // results pages: Browse button only (results-list.blade.php)
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
    if (p[0] === 'school-management' && p[1] === 'school') return pageSchoolDetails();
    if (p[0] === 'school-management') return pageSchoolManagement();
    if (p[0] === 'my-school') return pageMySchool();
    if (p[0] === 'upgrade') { app.innerHTML = '<div class="notice">The upgrade options page arrives with Phase 2 of the rebuild.</div>'; return; }
    app.innerHTML = `<div class="notice">Page not found.</div>`;
  } catch (e) { app.innerHTML = `<div class="notice">Something went wrong: ${esc(e.message)}</div>`; }
}

// ---------- pages ----------
function renderSubjectBar() {
  // The live bar is the user's own list (Users fid 918) filtered by SubjectPolicy.
  const listed = D.subjects.filter(s => E.buttons.includes(s.id)).sort(byOrder);
  const subjects = listed.filter(canViewSubject);
  document.getElementById('scrollable-navbar').innerHTML = subjects.map(s =>
    `<div class="p-1 flex-even"><a href="#/subject/${s.id}" data-id="${s.id}" class="subject-button d-flex link align-items-center text-nowrap p-2" style="background-color: #${esc(s.button_colour || '733088')}"><span class="button-text text-center w-100 text-1">${esc(s.name)}</span></a></div>`).join('');
  document.getElementById('subjectnav').classList.toggle('hidden', listed.length < 2);   // $subjectList->count() > 1, counted before the policy
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
  const subjects = D.subjects.filter(s => s.is_browsable && E.browse.includes(s.id) && canViewSubject(s) && subjectSubgroups(s.id).some(sg => subgroupSubcats(sg, false).some(sc => subcatSchemes(sc, false).length > 0))).sort((a, b) => (a.browse_order ?? -1) - (b.browse_order ?? -1));
  const tabs = [], panes = [];
  subjects.forEach((s, i) => {
    // NavComposer ignores the age filter; subject-group-panels.blade.php checks the group's policy but lists every category.
    const sgs = subjectSubgroups(s.id).filter(canView).map(sg => ({ sg, subcats: subgroupSubcats(sg, false) }));
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
  // Below sm: the accordion (browser.blade.php "row d-sm-none" + subject-group-panels.blade.php)
  let first = true;
  document.getElementById('browse-mobile').innerHTML = subjects.map(s => {
    const sgs = subjectSubgroups(s.id).filter(canView).map(sg => ({ sg, subcats: subgroupSubcats(sg, false) }));
    const open = first; first = false;
    return `<li class="mb-1"><button type="button" class="text-primary w-100 btn btn-toggle d-inline-flex align-items-center rounded border-0" data-collapse="subject-${s.id}-collapse" aria-expanded="${open}">${esc(s.name)}</button>
      <div class="collapse ${open ? 'show' : ''} mt-2" id="subject-${s.id}-collapse"><ul class="d-sm-none btn-toggle-nav list-unstyled fw-normal pb-1 small">` + sgs.map(({ sg, subcats }) =>
        `<li class="h6 text-primary"><a class="text-primary btn-toggle d-inline-flex" href="#" data-collapse="subgroup-${sg.id}-collapse" aria-expanded="false">${esc(sg.name)}</a><ul class="list-unstyled ms-3 mt-2 collapse" id="subgroup-${sg.id}-collapse">` +
        subcats.map(sc => `<li class="mb-1"><a class="text-mid-purple fw-light" href="${subcatHref(sc)}">${esc(sc.name)}</a></li>`).join('') + `</ul></li>`).join('') + `</ul></div></li>`;
  }).join('');
  const modal = document.getElementById('subject-browse-modal');
  modal.querySelectorAll('#browse-mobile [data-collapse]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); const t = document.getElementById(b.dataset.collapse); const on = !t.classList.contains('show'); t.classList.toggle('show', on); b.setAttribute('aria-expanded', on); }));
  modal.querySelectorAll('#browse-mobile a[href^="#/"]').forEach(a => a.addEventListener('click', closeBrowse));
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
  document.getElementById('browsebtnwrap').classList.toggle('hidden', !E.showBrowseMenu);
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
  const subjects = D.subjects.filter(s => s.is_carouselable && E.homeSections.includes(s.id)).sort((a, b) => (a.homepage_order ?? 999) - (b.homepage_order ?? 999));
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
  setBg(s.background_image_url);
  const fv = featuredVideo(s), video = fv && fv.id, vHead = fv && fv.heading, vSub = fv && fv.sub, vDesc = (fv && fv.desc) || '';
  let html = `<div class="row pt-4 pb-2 d-none d-sm-block"><div class="col"><div class="card shadow border-primary bg-ultra-light-purple rounded">
    <h5 class="card-header bg-primary bg-gradient-primary text-white d-flex"><div>${esc(s.name)}</div>${s.description ? `<div class="ms-auto"><button type="button" class="subgroup-collapse" data-toggle aria-expanded="true" aria-label="Show or hide"></button></div>` : ''}</h5>
    ${s.description ? `<div class="collapse-smooth"><div><div class="card-body"><p class="fw-light text-primary h6 mb-0">${nl(s.description)}</p></div></div></div>` : ''}</div><hr></div></div>`;
  if (video) html += `<div class="row"><div class="col-12"><div class="card shadow-lg border-primary mb-5">
    <h5 class="card-header bg-primary bg-gradient-primary text-white">${esc(vHead || 'Featured')}${vSub ? ` <small class="text-white-50 ml-0 ml-sm-2 d-block d-sm-inline">${esc(vSub)}</small>` : ''}<small class="float-end"><span class="badge bg-warning"><i class="bi-star-fill mr-1 mt-1"></i> <span style="position: relative; top: 1px;">Featured</span></span></small></h5>
    <div class="card-body pb-1"><div class="row"><div class="col-12 mb-3"><div class="media d-block"><div class="img-thumbnail shadow-lg img-fluid scheme-thumbnail w-100 d-block border-primary border-dashed p-2">${wistia(video)}</div>
    ${vDesc ? `<div class="media-body px-1 pt-4"><p class="card-text text-purple fw-light lead mb-0">${nl(vDesc)}</p></div>` : ''}</div></div></div></div></div></div></div>`;
  const subgroups = subjectSubgroups(id);
  if (!subgroups.length && classAge() != null) html += AGE_NOTICE;
  for (const sg of subgroups.filter(canView)) {
    const subcats = visibleSubcats(sg);
    if (!subcats.length) continue;
    html += `<div class="row" id="parent-subgroup-${sg.id}"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5">
      <h5 class="card-header bg-primary bg-gradient-primary text-white d-flex"><div>${esc(sg.name)}${sg.description ? ` <small class="text-light-purple ml-0 ml-sm-3 d-block d-sm-inline fw-light i-small">${esc(sg.description)}</small>` : ''}</div><div class="ms-auto"><button type="button" class="subgroup-collapse" data-toggle aria-expanded="true" aria-label="Show or hide ${esc(sg.name)}"></button></div></h5>
      <div class="collapse-smooth"><div><div class="card-body pb-1"><div class="row">`;
    for (const sc of subcats) html += subcatCard(sc, {});
    html += `</div></div></div></div></div></div></div>`;
  }
  app.innerHTML = html;
  reveal();
  bindCollapses();
  bindClearAge();
}

// Collapsible panels (live: Bootstrap collapse + subcategory_display_state.js remembering the
// state); here with the expand-in-place transition agreed on 19 Oct.
function bindCollapses() {
  app.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
    const body = b.closest('.card').querySelector('.collapse-smooth'); if (!body) return;
    const closed = body.classList.toggle('closed'); b.classList.toggle('collapsed', closed); b.setAttribute('aria-expanded', !closed);
  }));
}

// TEMPORARY WORKAROUND (David, 3 Nov 2026) - remove when the CMS rebuild makes the category image
// optional and generates a typographic tile itself. These tile images are words on a colour and
// already carry the category name, so the desktop card shows no heading under them (the subtext
// and meta line stay). Keyed by image file so every subject that reuses the tile is covered.
const WORD_TILE_IMAGES = new Set([
  'Thumbnails mixed (3).jpg', 'Thumbnails mixed (1).jpg', 'Thumbnails mixed.jpg', 'Thumbnails mixed (2).jpg', '2191s.jpg',   // Active Assemblies
  '1 (18).jpg', '2 (13).jpg', '7 (11).jpg', '5 (13).jpg',                     // Active 30 minutes: New to imoves?, Active Blasts, Active Learning, Wellbeing
  '4 (12).jpg', '8 (9).jpg', '6 (9).jpg', '10 (2).jpg',                       // PE / Recommended Programme: Fundamentals, Dance, Gymnastics, Pilates and Yoga
  '9 (3).jpg', '3 (10).jpg', '11 (2).jpg', 'TS.jpg',                          // KS2 Deeper Dive: Sports Specific, Athletics, OAA, Teacher Support
  'Thumbnails mixed (6).jpg', 'Thumbnails mixed (7).jpg', 'BG.jpg', 'OSF.jpg', // PE Extra
  'Thumbnails mixed (8).jpg', 'Thumbnails mixed (9).jpg', 'Thumbnails mixed (10).jpg', 'Thumbnails mixed (11).jpg',   // Working Wall Posters
]);
const isWordTile = sc => WORD_TILE_IMAGES.has(decodeURIComponent((sc.image || '').split('/').pop()));
// A subcategory card: subjects/partials/subcategory-card.blade.php (desktop variant).
function subcatCard(sc, { heading, sub, cols } = {}) {
  const lessons = subcatLessons(sc), dr = directResource(sc), vid = dr && dr.duration;
  const subheading = sub || sc.subheading;
  // Subcategories have no age range of their own, so live's "Ages" item never appears on a card.
  const meta = (lessons.length ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="text-primary"><i class="bi-collection-play text-primary me-1"></i> ${lessons.length} ${esc(noun(sc, lessons.length))}</span></li>` : '') +
    (vid ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="text-primary"><i class="bi-film text-primary me-1"></i> ${esc(vid)} video</span></li>` : '') +
    (subcatIsFree(sc) ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-end align-items-center"><span class="scheme-badge badge-freemium ms-2"><span class="badge bg-success">Free</span></span></li>` : '');
  // Mobile variant (below md): image left, title right, fw-light meta - the "<!-- mobile -->" card in the partial.
  const metaMobile = meta.replace(/<span class="text-primary">/g, '<span class="fw-light text-primary">');
  const mobile = `<div class="card subcategory-card h-100 shadow-sm d-flex flex-column d-md-none"><div class="border-bottom border-primary"><div class="row"><div class="col-5"><img src="${esc(img(sc.image))}" class="w-100 border-primary border-right border-end rounded-top-left" alt="${esc(sc.name)}" loading="lazy"></div><div class="col-7 ms-n2 d-flex align-items-center"><div class="h5 text-primary my-2 card-title">${esc(limit(heading || sc.name, 30))}</div></div></div></div>
    ${subheading || metaMobile ? `<div class="card-body p-0 d-flex flex-column justify-content-between"><div class="align-self-start w-100"><div class="pt-3 d-flex flex-column w-100 h-100 justify-content-center"><h6 class="subcategory-card--subheading fw-light text-mid-purple my-0 mx-3 card-title">${esc(limit(subheading || '', 200))}</h6><ul class="list-group border-0 list-group-flush list-group-horizontal text-mid-purple i-small text-nowrap justify-content-around">${metaMobile}</ul></div></div></div>` : ''}</div>`;   // v0.45.3: no empty body (and no white band) when there is nothing under the title
  return `<div class="${cols || 'col-12 col-md-6 col-lg-6 col-xl-3 mb-4'}"><a href="${subcatHref(sc)}" title="${esc(sc.name)}" class="text-decoration-none">
    <div class="card subcategory-card lift shadow-sm d-none d-md-flex flex-column h-100 ${isWordTile(sc) && !subheading && !meta ? 'tile-only' : ''}"><img src="${esc(img(sc.image))}" class="card-img-top" alt="${esc(sc.name)}" loading="lazy">
    ${isWordTile(sc) && !subheading && !meta ? '' : `<div class="card-body border-top border-primary p-0 d-flex flex-column justify-content-between"><div class="align-self-start w-100"><div class="pt-2 d-flex flex-column w-100 h-100 justify-content-center">
      ${isWordTile(sc) ? '' : `<h5 class="text-primary ${subheading ? 'mt-3 mb-1' : 'my-3'} mx-3 card-title text-nowrap">${esc(limit(heading || sc.name, 25))}</h5>`}
      ${subheading ? `<h6 class="subcategory-card--subheading h6 text-mid-purple fw-light mb-2 ${isWordTile(sc) ? 'mt-3' : ''} mx-3 card-title">${esc(limit(subheading, 130))}</h6>` : ''}</div></div>
    <ul class="list-group border-0 list-group-flush list-group-horizontal text-mid-purple small text-nowrap justify-content-around">${meta}</ul></div>`}</div>${mobile}</a></div>`;
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
    else if (el.dataset.favKind === 'mobile') { el.classList.toggle('btn-primary', on || el.dataset.bg === '1'); el.classList.toggle('btn-outline-primary', !on && el.dataset.bg !== '1'); el.innerHTML = on ? 'Unfavourite' : '<span class="d-inline">Favourite</span>'; }   // lessons/show.blade.php d-lg-none buttons
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
const USER_ROLES = ['Assistant Head Teacher', 'Deputy Head Teacher', 'Early Years Coordinator', 'Head Teacher', 'Invoicing / Accounts / Bursar', 'KS1 Coordinator', 'KS2 Coordinator', 'Lead Contact', 'Literacy Coordinator', 'Maths Coordinator', 'PE Lead', 'Primary School Parent', 'School Games Organiser', 'SEN Assistant', 'SEN Coordinator', 'Teacher', 'Teaching Assistant'];
// A bootstrap-select (1.13) multi-select, as the live profile page renders it: the real
// <select multiple> stays in the form, the button and menu are the picker.
function bsSelect(id, options, selected, title) {
  return `<div class="dropdown bootstrap-select form-control" data-bs-select="${id}"><select multiple id="${id}" name="${id}[]" title="${esc(title)}" class="selectpicker form-control" tabindex="-98">${options.map(o => `<option value="${esc(o)}" ${selected.has(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
    <button type="button" class="btn dropdown-toggle btn-default ${selected.size ? '' : 'bs-placeholder'}" role="combobox" aria-haspopup="listbox" aria-expanded="false" title="${esc(title)}"><div class="filter-option"><div class="filter-option-inner"><div class="filter-option-inner-inner">${esc(selected.size ? [...options].filter(o => selected.has(o)).join(', ') : title)}</div></div></div></button>
    <div class="dropdown-menu"><div class="inner" role="listbox" aria-multiselectable="true" tabindex="-1"><ul class="dropdown-menu inner" role="presentation">${options.map((o, i) => `<li class="${selected.has(o) ? 'selected active' : ''}"><a role="option" class="dropdown-item ${selected.has(o) ? 'selected active' : ''}" tabindex="0" data-index="${i}" aria-selected="${selected.has(o)}"><span class="text">${esc(o)}</span></a></li>`).join('')}</ul></div></div></div>`;
}
function bindBsSelect(root) {
  root.querySelectorAll('[data-bs-select]').forEach(w => {
    const sel = w.querySelector('select'), btn = w.querySelector('.dropdown-toggle'), menu = w.querySelector(':scope > .dropdown-menu'), title = sel.title;
    const paint = () => { const chosen = [...sel.options].filter(o => o.selected).map(o => o.text); btn.classList.toggle('bs-placeholder', !chosen.length); btn.querySelector('.filter-option-inner-inner').textContent = chosen.length ? chosen.join(', ') : title; };
    const open = v => { w.classList.toggle('show', v); menu.classList.toggle('show', v); menu.querySelector('ul.inner').classList.toggle('show', v); btn.setAttribute('aria-expanded', v); if (v) { const r = btn.getBoundingClientRect(); menu.style.cssText = `position:absolute;inset:auto auto auto 0;top:${btn.offsetHeight}px;min-width:${r.width}px;max-height:264px;overflow:hidden;`; menu.querySelector('.inner').style.cssText = 'max-height:246px;overflow-y:auto;'; } };
    btn.addEventListener('click', e => { e.stopPropagation(); open(!w.classList.contains('show')); });
    menu.querySelectorAll('a.dropdown-item').forEach(a => a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const o = sel.options[+a.dataset.index]; o.selected = !o.selected; a.classList.toggle('selected', o.selected); a.classList.toggle('active', o.selected); a.parentElement.classList.toggle('selected', o.selected); a.setAttribute('aria-selected', o.selected); paint(); }));
    document.addEventListener('click', () => open(false));
  });
}
async function pageProfile() {
  setBg(null);
  const m = Auth.me() || {};
  // The pick-list is the live Quickbase User Roles table (ProfileArea::getAllUserRoles(), 17 roles
  // on 1 Nov 2026), plus any role the user already holds that is not in it.
  const mine = new Set(m.roles || []);
  const roles = [...new Set([...USER_ROLES, ...mine])];
  const field = (label, id, value, auto) => `<div class="form-row mb-3"><div class="col"><label for="${id}" class="text-1">${label}</label><input type="text" class="form-control" id="${id}" name="${id}" value="${esc(value || '')}" ${auto ? `autocomplete="${auto}"` : ''}></div></div>`;
  app.innerHTML = `<div class="profile-container form-page container-fluid pb-5"><div class="row justify-content-center"><div class="col-12 col-sm-10 col-lg-8">
    <div class="heading-1 text-primary">My personal profile</div>
    <form id="user_profile_form"><div class="row"><div class="col-6">${field('First Name', 'first_name', m.first_name, 'given-name')}</div><div class="col-6">${field('Last Name', 'last_name', m.last_name, 'family-name')}</div></div>
    ${field('Telephone', 'telephone_number', m.phone, 'tel')}${field('My Class Name', 'class_name', m.class_name)}
    <div class="form-row mb-3"><div class="col"><label for="user_roles" class="text-1">My Role(s)</label>${bsSelect('user_roles', roles, mine, 'Select your role(s)')}</div></div>
    <div class="notice d-none" id="profile-msg" role="status"></div>
    <button class="btn btn-primary heading-2 btn-save w-100" type="submit">Update my details</button></form></div></div></div>`;
  reveal(); bindBsSelect(app);
  document.getElementById('user_profile_form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, msg = document.getElementById('profile-msg'), btn = f.querySelector('.btn-save');
    const body = { user_id: uid(), first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim(), phone: f.telephone_number.value.trim(), class_name: f.class_name.value.trim(), roles: [...f.querySelectorAll('#user_roles option:checked')].map(o => o.value) };
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

// School management (school-management/index.blade.php + partials, resources/js/school-management.js).
// Admins only; the lists come from the accounts copy through web_school_management().
const QMARK = '<svg viewBox="0 0 34.02 34.02" xmlns="http://www.w3.org/2000/svg"><path d="M21.28,11.57c0.4,0.6,0.59,1.26,0.59,1.97c0,0.56-0.11,1.05-0.34,1.47c-0.23,0.42-0.5,0.78-0.81,1.09c-0.31,0.31-0.87,0.82-1.68,1.54c-0.22,0.2-0.4,0.38-0.54,0.54c-0.13,0.15-0.24,0.3-0.3,0.42c-0.06,0.13-0.12,0.26-0.15,0.38c-0.04,0.13-0.09,0.35-0.16,0.67c-0.12,0.68-0.51,1.02-1.17,1.02c-0.34,0-0.63-0.11-0.86-0.33c-0.23-0.22-0.35-0.56-0.35-1c0-0.55,0.09-1.03,0.26-1.43c0.17-0.4,0.4-0.76,0.68-1.06c0.28-0.31,0.66-0.67,1.14-1.09c0.42-0.37,0.72-0.65,0.91-0.83c0.19-0.19,0.35-0.4,0.47-0.63c0.13-0.23,0.19-0.48,0.19-0.75c0-0.53-0.2-0.97-0.59-1.33c-0.39-0.36-0.89-0.54-1.51-0.54c-0.72,0-1.25,0.18-1.6,0.55c-0.34,0.36-0.63,0.9-0.87,1.61c-0.22,0.74-0.65,1.11-1.27,1.11c-0.37,0-0.68-0.13-0.93-0.39s-0.38-0.54-0.38-0.84c0-0.62,0.2-1.26,0.6-1.9c0.4-0.64,0.99-1.17,1.75-1.59c0.77-0.42,1.67-0.63,2.69-0.63c0.95,0,1.79,0.18,2.52,0.53C20.32,10.49,20.89,10.97,21.28,11.57z M16.84,21.58c-0.42,0-0.78,0.14-1.07,0.42c-0.29,0.28-0.43,0.63-0.43,1.04c0,0.47,0.15,0.83,0.45,1.09c0.3,0.26,0.65,0.39,1.05,0.39c0.39,0,0.73-0.13,1.02-0.39c0.29-0.26,0.44-0.62,0.44-1.08c0-0.41-0.14-0.76-0.42-1.04C17.6,21.72,17.25,21.58,16.84,21.58z M28.04,28.03c-2.95,2.95-6.86,4.57-11.03,4.57c-4.17,0-8.08-1.62-11.02-4.56c-2.95-2.94-4.57-6.86-4.57-11.03S3.04,8.93,5.99,5.98c2.94-2.94,6.86-4.57,11.02-4.57c4.16,0,8.08,1.62,11.02,4.57C34.11,12.06,34.11,21.95,28.04,28.03z M26.16,7.85c-2.44-2.44-5.69-3.79-9.15-3.79c-3.46,0-6.71,1.35-9.15,3.79c-2.45,2.44-3.79,5.7-3.79,9.15s1.35,6.71,3.79,9.15c2.44,2.44,5.69,3.79,9.15,3.79c3.46,0,6.71-1.35,9.16-3.79C31.21,21.11,31.21,12.9,26.16,7.85z"/></svg>';
const SM_HELP = {
  approved: ['Approved users', '<p>Users listed here have full access to your school subscription. You can remove access for any of these users, by using the \'Remove access\' link.</p><p>Users with admin access can both access this page for your school, and make all the changes you can make. You can grant or remove this access using the \'Make admin\' and \'Remove admin\' links.</p><p>The system will automatically ensure that there is always at least one admin user for your school.</p>'],
  new: ['New users', '<p>As new users join imoves, they have the option of selecting an existing school to link their account to. However, they will not have access to your school subscription unless you (or another admin) approve them here.</p><p>You can also invite new users.</p><p>When you enter their email address, this will trigger an email invite, which includes a link they can use to join, which automatically gives them access to your subscription, with no further action required by you.</p><p>You can see if and when any user that you invite has joined in this section too, and resend the invite to give them a gentle nudge to join.</p><p>All invites expire automatically after 30 days. If you do still want a new user to join and have access to your subscription after this, then you can simply reinvite them.</p>'],
  removed: ['Removed and declined users', '<p>This section shows all users who have previously had access to your school subscription, and allows you to re-enable their access as required.</p>'],
};
const SM_CONFIRM = {   // resources/js/school-management.js
  'promote-to-admin': ['Make admin?', n => `Are you sure you would like to make ${n} an admin?`],
  'revoke-admin-access': ['Remove admin?', n => `Are you sure you would like to remove admin access for ${n}?`],
  'revoke-access': ['Remove access?', n => `Are you sure you would like to remove access for ${n}?`],
  'approve-user': ['Accept?', n => `Are you sure you would like to accept ${n}?`],
  'decline-user': ['Decline?', n => `Are you sure you would like to decline ${n}?`],
  'reactivate-and-approve': ['Reactivate and approve?', n => `Are you sure you would like to reactivate and approve ${n}?`],
  'resend-invite': ['Resend?', n => `Are you sure you would like to send another invite to ${n}?`],
};
const fmtDays = n => n == null ? '' : `${Number(n).toLocaleString('en-GB')} days`;   // Users fid 112/113 ("2,159 days")
function smModal(id, title, body, footer) {
  let m = document.getElementById(id);
  if (!m) { m = document.createElement('div'); m.id = id; m.className = 'modal fade'; m.tabIndex = -1; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal-dialog"><div class="modal-content">${title ? `<div class="modal-header"><h5 class="modal-title">${title}</h5><button type="button" class="close" data-close aria-label="Close"><span aria-hidden="true">&times;</span></button></div>` : ''}<div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></div></div>`;
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => hideModal(id)));
  showModal(id);
  return m;
}
async function pageSchoolManagement() {
  setBg(null);
  if (!(Auth.me() || {}).is_admin) { app.innerHTML = '<div class="notice">Only users with admin rights can view this page.</div>'; return; }
  app.innerHTML = '<div class="loading">Loading school management…</div>';
  let d; try { d = await rpc('web_school_management'); } catch (e) { app.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  const me = d.me;
  const nameCols = (u, name) => `<div class="pe-0 my-2 my-md-0 col-12 col-md-4 text-1"><div class="d-flex align-items-center name ellipsis pe-2">${esc(name)}</div><div class="align-items-center d-flex d-md-none mt-1 mb-2 ellipsis">${esc(u.email || '')}</div></div><div class="align-items-center p-0 d-none d-md-flex mb-2 mb-md-0 col-12 col-md-4 text-1 ellipsis">${esc(u.email || '')}</div>`;
  const card = (u, inner, name) => `<div class="management-card row mt-4" data-user-id="${u.id}" data-name="${esc(u.full_name)}">${nameCols(u, name || u.full_name)}${inner}</div>`;
  const heading = (title, key) => `<div class="heading-5 text-primary">${title} <span class="help-button" data-help="${key}">${QMARK}</span></div>`;
  const approved = d.approved.map(u => card(u, u.id === me ? '' :
    (u.access_can_be_removed ? `<div class="pb-2 pb-md-0 col-6 col-md-2 text-start text-md-right"><span class="link" data-act="revoke-access">Remove access</span></div>` : '') +
    (u.admin_can_be_granted ? `<div class="pb-2 pb-md-0 col-6 col-md-2 text-end"><span class="link" data-act="promote-to-admin">Make admin</span></div>` : '') +
    (u.admin_can_be_removed ? `<div class="pb-2 pb-md-0 col-6 d-md-none"></div><div class="pb-2 pb-md-0 col-6 col-md-4 text-end"><span class="link" data-act="revoke-admin-access">Remove admin</span></div>` : ''), u.name_with_admin)).join('');
  const fresh = d.new.map(u => card(u, `<div class="pb-2 pb-md-0 col-6 col-md-2 text-start text-md-right"><span class="link" data-act="approve-user">Accept</span></div><div class="pb-2 pb-md-0 col-6 col-md-2 text-end text-md-right"><span class="link" data-act="decline-user">Decline</span></div>`)).join('');
  const invited = d.invited.map(i => `<div class="management-card row mt-4" data-user-email="${esc(i.email)}"><div class="py-2 py-md-0 text-1 col-12 col-md-4 d-flex align-items-center">Invitation pending</div><div class="align-items-center px-3 px-md-0 mb-2 mb-md-0 col-12 col-md-4 text-1 ellipsis">${esc(i.email)}</div><div class="pb-2 pb-md-0 col-12 col-md-4 text-end"><span class="link" data-act="resend-invite">Resend invite</span></div></div>`).join('');
  const removed = d.removed.map(u => card(u, u.id === me ? '' : `<div class="pb-2 pb-md-0 col-md-4 text-end"><span class="link" data-act="reactivate-and-approve">Reactivate &amp; approve</span></div>`)).join('');
  const usageRows = d.approved.map(u => `<tr><td class="pl-0">${esc(u.full_name)}</td><td class="text-end">${fmtDays(u.joined_days)}</td><td class="text-end">${fmtDays(u.last_login_days)}</td><td class="text-end">${u.login_count ?? ''}</td><td class="text-end">${u.login_count_30_days ?? ''}</td></tr>`).join('');
  const usageCards = d.approved.map(u => `<div class="management-card usage-card row mt-4" data-user-id="${u.id}"><div class="pe-0 my-2 my-md-0 col-12 col-md-4 text-1"><div class="d-flex align-items-center name ellipsis pe-2">${esc(u.full_name)}</div></div><div class="col-6">Joined imoves</div><div class="col-6 text-end">${fmtDays(u.joined_days)}</div><div class="col-6">Last login</div><div class="col-6 text-end">${fmtDays(u.last_login_days)}</div><div class="col-6">Logins</div><div class="col-6 text-end">${u.login_count ?? ''}</div><div class="col-6">Last 30 days</div><div class="col-6 text-end">${u.login_count_30_days ?? ''}</div></div>`).join('');
  app.innerHTML = `<div class="school-management-container form-page container-fluid px-4 pb-5"><div class="row"><div class="col-12">
    <div class="heading-1 text-primary text-center">School management</div>
    <div class="management-sub-heading heading-2 text-highlight text-center mb-4">Control access to your subscription(s)</div>
    <div class="text-1 text-primary">Only users with admin rights can view this page, and manage access to your school subscription</div>
    <div class="my-4 d-flex justify-content-between school-details management-card"><div class="pe-2"><div class="heading-5 text-primary">${esc(d.school ? d.school.name : '')}</div><div class="text-1">${esc(d.school ? d.school.address : '')}</div></div><div class="d-flex"><a class="align-self-end d-inline-block d-md-none" href="#/school-management/school">Edit</a><a class="align-self-end d-none d-md-inline-block" href="#/school-management/school">Edit school details</a></div></div>
    <div class="approved-users-container mb-4">${heading('Approved users', 'approved')}${approved}</div>
    <div class="new-users-container mb-4">${heading('New users', 'new')}${fresh}
      <div class="row mt-4"><div class="text-1 text-primary col-12">Your invited users are pre-approved and have immediate access to your school subscription(s)</div></div>
      <div class="management-card invite-user-form-container row mt-4"><div class="py-2 py-md-0 text-1 col-12 col-md-4 d-flex align-items-center">Invite a new user</div><div class="pb-3 pb-md-0 col-12 col-md-5 pl-3 pl-md-0 d-flex align-items-center"><div class="form-row w-100"><div class="col"><div class="form-help"></div><input type="text" placeholder="Enter new user's email address" class="form-control" id="email_address" name="email_address" value=""></div></div></div><div class="pb-3 pb-md-0 col-12 col-md-3"><button id="invite_user_form_submit" class="btn btn-primary heading-5 w-100" type="button">Send Invitation</button></div></div>
      ${invited}</div>
    <div class="approved-users-container mb-4"><div class="heading-5 text-primary mb-2">Usage</div><div class="d-none d-sm-block"><table class="usage-table table text-1 text-primary"><thead><tr><th class="pl-0">Name</th><th class="text-end">Joined imoves</th><th class="text-end">Last login</th><th class="text-end">Logins</th><th class="text-end">Last 30 days</th></tr></thead><tbody>${usageRows}</tbody></table></div><div class="d-sm-none text-1">${usageCards}</div></div>
    ${d.removed.length ? `<div class="removed-and-declined-users-container mb-4">${heading('Removed and declined users', 'removed')}${removed}</div>` : ''}
  </div></div></div>`;
  reveal();
  app.querySelectorAll('[data-help]').forEach(b => b.addEventListener('click', () => { const [t, body] = SM_HELP[b.dataset.help]; smModal('sm_help_modal', t, body, '<button type="button" class="btn btn-primary" data-close>Close</button>'); }));
  const confirmThen = (title, text, run) => {
    const m = smModal('confirm_modal', title, esc(text), '<span class="link dismiss-link" data-close>Cancel</span><button type="button" class="btn btn-primary confirm-action">Yes</button>');
    m.querySelector('.confirm-action').addEventListener('click', async e => {
      e.target.disabled = true;
      try { await run(); hideModal('confirm_modal'); pageSchoolManagement(); }
      catch (x) { hideModal('confirm_modal'); smModal('info_modal', '', esc(x.message), '<button type="button" class="btn btn-primary" data-close>Close</button>'); }
    });
  };
  app.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', () => {
    const c = el.closest('.management-card'), act = el.dataset.act, [title, text] = SM_CONFIRM[act];
    if (act === 'resend-invite') return confirmThen(title, text(c.dataset.userEmail), () => rpc('web_school_invite', { p_email: c.dataset.userEmail, p_resend: true }));
    confirmThen(title, text(c.dataset.name), () => rpc('web_school_action', { p_user_id: +c.dataset.userId, p_action: act }));
  }));
  const inviteBtn = document.getElementById('invite_user_form_submit'), emailEl = document.getElementById('email_address');
  inviteBtn.addEventListener('click', async () => {
    emailEl.parentElement.querySelectorAll('.invalid-feedback').forEach(x => x.remove());
    const email = emailEl.value.trim();
    if (!email) { emailEl.insertAdjacentHTML('afterend', '<div class="invalid-feedback d-block">The email address field is required.</div>'); return; }
    inviteBtn.disabled = true;
    try {
      const msg = await rpc('web_school_invite', { p_email: email, p_resend: false });
      if (msg) { const m = smModal('info_modal', '', esc(msg), '<button type="button" class="btn btn-primary" data-close>Close</button>'); m.querySelector('[data-close]').addEventListener('click', () => pageSchoolManagement()); }
      else pageSchoolManagement();
    } catch (x) { inviteBtn.disabled = false; emailEl.insertAdjacentHTML('afterend', `<div class="invalid-feedback d-block">${esc(x.message)}</div>`); }
  });
}

// Edit school details (school-management/school/show.blade.php + school-address-form-fields).
function schoolAddressFields(s) {
  const field = (label, id, value, ph) => `<div class="form-row mb-3"><div class="col"><label for="${id}" class="text-1">${label}</label><input type="text" placeholder="${ph}" class="form-control" id="${id}" name="${id}" value="${esc(value || '')}"></div></div>`;
  return `<div class="school-address">${field('School Name', 'school_name', s.name, 'School Name')}${field('Address 1', 'address_2', s.address_1, 'Address 1')}${field('Address 2', 'address_3', s.address_2, 'Address 2')}${field('Town/City', 'town', s.town, 'Town / City')}${field('Region', 'county', s.region, 'Region')}${field('Postal/Zip Code', 'post_code', s.postcode, 'Postal / Zip code')}</div>`;
}
async function pageSchoolDetails() {
  setBg(null);
  if (!(Auth.me() || {}).is_admin) { app.innerHTML = '<div class="notice">Only users with admin rights can view this page.</div>'; return; }
  const [s] = await rpc('web_school_details');
  app.innerHTML = `<div class="form-page container-fluid px-4 pb-5"><div class="row justify-content-center"><div class="col-12 col-sm-10 col-lg-8"><form id="school_form">
    <div class="heading-1 text-primary mb-3">School details</div>${schoolAddressFields(s || {})}
    <div class="notice d-none" id="school-msg" role="status"></div>
    <button class="btn btn-primary btn-save heading-2 w-100" type="submit">Click to Save &amp; Continue</button></form></div></div></div>`;
  reveal();
  document.getElementById('school_form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, msg = document.getElementById('school-msg');
    try {
      await rpc('web_school_update', { p_name: f.school_name.value, p_address_1: f.address_2.value, p_address_2: f.address_3.value, p_town: f.town.value, p_region: f.county.value, p_postcode: f.post_code.value });
      Object.assign(Auth.me(), { school_name: f.school_name.value.trim() }); renderUserContext(); Auth.renderUser();
      location.hash = '#/school-management';
    } catch (x) { msg.textContent = x.message; msg.classList.remove('d-none'); }
  });
}

// My School (user-profile-school/show.blade.php + user-capture/partials/school-form.blade.php,
// resources/js/user_capture_school.js): country, then the UK postcode lookup (exact postcode)
// or, for other countries, the school address form that creates the school.
async function pageMySchool() {
  const [[s], countries] = await Promise.all([rpc('web_school_details'), rpc('web_countries')]);
  setBg('live/img/sign-up-bg-1.jpeg'); document.body.classList.add('bg-no-margin'); document.body.style.backgroundImage = "linear-gradient(rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.5)), url('live/img/sign-up-bg-1.jpeg')";   // layouts/default bgOpaque
  const uk = countries.find(c => c.is_uk) || {}; const curCountry = (s && s.country_id) || uk.id || '';
  const field = (label, id, value, ph) => `<div class="form-row mb-3"><div class="col"><label for="${id}" class="text-1">${label}</label><div class="form-help"></div><input type="text" placeholder="${ph}" class="form-control" id="${id}" name="${id}" value="${esc(value || '')}"></div></div>`;
  const isUk = c => String(c) === String(uk.id);
  app.innerHTML = `<div class="capture-container form-page container-fluid"><div class="row justify-content-center"><div class="col-12 col-sm-10 col-lg-8">
    <div class="heading-2 text-primary text-center">Enter your School Name here</div>
    <form id="user_capture_form" class="${s && s.id ? '' : ''}"><div class="page-2 mt-3 mb-4">
      <div class="form-row mb-3"><div class="col"><label for="country_id" class="text-1">Country</label><select class="form-select" id="country_id" name="country_id"><option value="">Select your country</option>${countries.map(c => `<option value="${c.id}" ${String(c.id) === String(curCountry) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
      <div class="country-selected ${curCountry ? '' : 'd-none'}">
        <div class="uk ${isUk(curCountry) ? '' : 'd-none'}">
          <div class="form-row"><div class="col"><label for="post_code_lookup" class="text-1">UK School Postcode</label><div class="form-help"></div><input type="text" placeholder="Enter your full UK School Postcode eg AB1 2CD" class="form-control" id="post_code_lookup" name="post_code_lookup" value="${esc(s && isUk(curCountry) ? s.postcode || '' : '')}"></div></div>
          <div class="no-post-code-lookup invalid-feedback my-2 d-none">Please enter a full UK postcode.</div>
          <button id="find_school_button" class="btn btn-primary heading-2 w-100 my-3" type="button">Find my school</button>
          <div class="school-list mt-2 d-none"><div class="form-row mb-3"><div class="col"><label for="school_id" class="text-1">My School</label><select class="form-select" id="school_id" name="school_id"></select></div></div>
            <div class="text-danger my-2">Cannot find your UK based School in our database?<br><br>Just email your school name and postcode to <a href="mailto:laura@imoves.com">laura@imoves.com</a> or call <a href="tel:0114 266 1061">0114 266 1061</a> and we'll get your school details added in a flash.</div></div>
        </div>
        <div class="school-address ${isUk(curCountry) ? 'd-none' : ''}">${field('School Name', 'school_name', s && !isUk(curCountry) ? s.name : '', 'School Name')}${field('Address 1', 'address_2', s && !isUk(curCountry) ? s.address_1 : '', 'Address 1')}${field('Address 2', 'address_3', s && !isUk(curCountry) ? s.address_2 : '', 'Address 2')}${field('Town/City', 'town', s && !isUk(curCountry) ? s.town : '', 'Town / City')}${field('Region', 'county', s && !isUk(curCountry) ? s.region : '', 'Region')}${field('Postal/Zip Code', 'post_code', s && !isUk(curCountry) ? s.postcode : '', 'Postal / Zip code')}</div>
        <button class="btn btn-primary btn-save heading-2 ${isUk(curCountry) ? 'd-none' : ''} w-100" type="button">Click to Save &amp; Continue</button>
      </div>
      <div class="notice d-none mt-3" id="school-msg" role="status"></div>
    </div></form></div></div></div>`;
  reveal();
  const f = document.getElementById('user_capture_form'), country = f.querySelector('#country_id'), list = f.querySelector('.school-list'), sel = f.querySelector('#school_id'), save = f.querySelector('.btn-save'), msg = document.getElementById('school-msg'), find = f.querySelector('#find_school_button');
  const resetSearch = () => { sel.innerHTML = ''; list.classList.add('d-none'); if (isUk(country.value)) save.classList.add('d-none'); };
  const countryChanged = () => { const u = isUk(country.value); if (!u) { f.querySelector('#post_code_lookup').value = ''; resetSearch(); }
    f.querySelector('.country-selected').classList.toggle('d-none', !country.value); f.querySelector('.uk').classList.toggle('d-none', !u); f.querySelector('.school-address').classList.toggle('d-none', u); save.classList.toggle('d-none', u); };
  country.addEventListener('change', countryChanged);
  const findSchool = async () => {
    const pc = f.querySelector('#post_code_lookup').value.trim(); f.querySelector('.no-post-code-lookup').classList.toggle('d-none', pc !== ''); resetSearch(); if (!pc) return;
    find.disabled = true; let rows = []; try { rows = await rpc('web_school_search', { p_q: pc }); } catch (e) {}
    sel.innerHTML = `<option value="">Select your school</option>` + rows.map(r => `<option value="${r.id}" ${s && r.id === s.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    list.classList.toggle('d-none', !rows.length); save.classList.toggle('d-none', !rows.length); find.disabled = false;
  };
  find.addEventListener('click', e => { e.preventDefault(); findSchool(); });
  if (isUk(curCountry) && s && s.postcode) findSchool();   // initialiseForm(): preselect the stored school
  save.addEventListener('click', async e => {
    e.preventDefault(); save.disabled = true; msg.classList.add('d-none');
    try {
      if (isUk(country.value)) { if (!sel.value) throw new Error('Please select your school.'); await rpc('web_school_choose', { p_school_id: +sel.value }); }
      else await rpc('web_school_create', { p_name: f.school_name.value, p_address_1: f.address_2.value, p_address_2: f.address_3.value, p_town: f.town.value, p_region: f.county.value, p_postcode: f.post_code.value, p_country_id: +country.value });
      const me = await rpc('web_me'); if (me && me[0]) Object.assign(Auth.me(), me[0]);
      renderUserContext(); Auth.renderUser(); renderUserMenu();
      location.hash = '#/';
    } catch (x) { msg.textContent = x.message; msg.classList.remove('d-none'); save.disabled = false; }
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
  return `<div class="col mb-4" data-gl="${gl.id}" data-lesson-id="${l.id}"><a href="${edit ? '#' : lessonHref(l, sc)}" class="text-decoration-none ${edit ? 'pe-none' : ''}"><div class="card subcategory-card ${edit ? '' : 'lift'} h-100 shadow-sm d-flex flex-column"><img src="${esc(img(scheme?.image))}" class="card-img-top" alt="${esc(l.name)}" loading="lazy">
    <div class="card-body border-top border-primary p-0 d-flex flex-column justify-content-between">
      ${edit ? `<div class="align-self-end mx-3 pt-2 pe-auto"><i class="drag-handle bi bi-arrows-move" style="cursor: pointer;" title="Drag to move"></i> <div class="dropdown d-inline"><i class="bi bi-three-dots-vertical" role="button" data-menu></i><ul class="dropdown-menu"><li><button type="button" class="dropdown-item" data-copy="${l.id}">Copy</button></li><li><button type="button" class="dropdown-item" data-del-gl="${gl.id}">Delete</button></li></ul></div></div>` : ''}
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
  // Curriculum.vue: tabs are a vuedraggable list (handle = the whole nav-item in edit mode).
  // Menu items are buttons, not anchors: the tab menu sits inside the tab's <a>, where a nested <a> would break the markup.
  const menu = (attr, id) => `<div class="dropdown d-inline"><i class="bi bi-three-dots-vertical" role="button" data-menu></i><ul class="dropdown-menu"><li><button type="button" class="dropdown-item" data-${attr}-rename="${id}">Rename</button></li><li><button type="button" class="dropdown-item" data-${attr}-clone="${id}">Clone</button></li><li><button type="button" class="dropdown-item" data-${attr}-delete="${id}">Delete</button></li></ul></div>`;
  html += `<ul class="nav nav-pills" role="presentation" id="cur-tabs">` + CUR.tabs.map(t => `<li class="nav-item ${edit ? 'handle' : ''}" data-tab-item="${t.id}"><a href="#" class="nav-link ${t.id === CUR.current ? 'active' : ''}" data-tab="${t.id}" role="tab">${CUR.renameTab === t.id ? `<form data-tab-rename-form="${t.id}"><input type="text" placeholder="${esc(t.name)}" value="${esc(t.name)}" class="form-control"></form>` : `<span>${esc(t.name)}</span>` + (edit ? menu('tab', t.id) : '')}</a></li>`).join('') +
    (edit ? `<li>${CUR.newTab ? `<form id="cur-newtab-form" class="row row-cols-lg-auto g-3 align-items-center"><div class="col-12"><input type="text" placeholder="Tab Name" class="form-control" required></div><div class="col-12"><button type="submit" class="btn btn-primary">Submit</button></div></form>` : `<a class="nav-link" href="#" id="cur-newtab">+ Add New Tab</a>`}</li>` : '') + `</ul><div class="tab-content mt-3">`;
  const tab = CUR.tabs.find(t => t.id === CUR.current);
  if (!tab) html += `<div class="notice">${admin ? (edit ? 'Add a tab to start building your school curriculum.' : 'No curriculum yet. Switch to Unlocked to start building one.') : 'Your school has not set up a curriculum yet. Ask your School Administrator.'}</div>`;
  else {
    html += `<div id="cur-groups">`;
    for (const g of tab.groups) {
      // Group.vue: header with name (or rename input), menu, vertical-arrows drag handle, collapse.
      html += `<div class="row curriculum-group-row item" data-group="${g.id}"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5">
        <h5 class="card-header bg-primary bg-gradient-primary text-white d-flex"><div>${CUR.renameGroup === g.id ? `<form data-group-rename-form="${g.id}"><input type="text" placeholder="${esc(g.name)}" value="${esc(g.name)}" class="form-control"></form>` : `<span>${esc(g.name)}</span>`}</div><div class="ms-auto">${edit && CUR.renameGroup !== g.id ? menu('group', g.id) + ` <i class="bi bi-arrows-vertical drag-handle" style="cursor: pointer" title="Drag to reorder"></i>` : ''}<button type="button" class="subgroup-collapse" data-toggle aria-expanded="true"></button></div></h5>
        <div class="collapse-smooth"><div><div class="card-body pb-1"><div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 row-cols-lg-3 cur-lessons" data-lessons="${g.id}">` + g.lessons.map(gl => lessons[gl.lesson_id] ? curriculumLessonCard(lessons[gl.lesson_id], gl, edit) : '').join('') + (g.lessons.length ? '' : '<div class="col-12 mb-3 text-mid-purple fw-light cur-empty">No lessons in this group yet.' + (edit ? ' Use "Browse to add resources" or the bookmark icon on any lesson.' : '') + '</div>') + `</div></div></div></div></div></div></div>`;
    }
    html += `</div>`;
    // NewGroup.vue
    if (edit) html += `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><div class="card-body">${CUR.newGroup ? `<form id="cur-newgroup-form" class="row row-cols-lg-auto g-3 align-items-center"><div class="col-12"><input type="text" placeholder="Group Name" class="form-control" required></div><div class="col-12"><button type="submit" class="btn btn-primary">Submit</button></div></form>` : `<a href="#" id="cur-newgroup" class="text-primary">+ Add New Group</a>`}</div></div></div></div>`;
  }
  app.innerHTML = html + `</div></div>`;
  reveal(); bindCollapses(); bindCurriculum(admin, lessons);
  const focus = app.querySelector('#cur-newtab-form input, #cur-newgroup-form input, [data-tab-rename-form] input, [data-group-rename-form] input'); if (focus) { focus.focus(); focus.select(); }
}
// Drag-to-reorder with the HTML5 drag and drop API (the live site uses vuedraggable / SortableJS).
// Items in `container` matching `itemSel` can be dragged by their `handleSel` (or the whole item
// when handleSel is null). Items may move between containers sharing the same `group`.
// onDrop(item, fromContainer, toContainer) runs after the DOM has been reordered.
const DND = { item: null, group: null };
function makeSortable(container, itemSel, handleSel, group, onDrop) {
  if (!container) return;
  container.querySelectorAll(itemSel).forEach(item => {
    const arm = () => { item.draggable = true; };
    if (handleSel) { item.draggable = false; item.querySelectorAll(handleSel).forEach(h => { h.addEventListener('mousedown', arm); h.addEventListener('touchstart', arm, { passive: true }); }); }
    else item.draggable = true;
    item.addEventListener('dragstart', e => { if (e.target !== item) return; if (!item.draggable) { e.preventDefault(); return; } DND.item = item; DND.group = group; DND.from = container; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', group); } catch (x) {} setTimeout(() => item.classList.add('dnd-ghost'), 0); });
    item.addEventListener('dragend', e => { if (e.target !== item) return; item.classList.remove('dnd-ghost'); if (handleSel) item.draggable = false; DND.item = null; });
    item.addEventListener('dragover', e => {
      if (!DND.item || DND.group !== group || DND.item === item) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const r = item.getBoundingClientRect(); const horizontal = getComputedStyle(container).display.includes('flex') || container.classList.contains('row');
      const before = horizontal ? (e.clientX - r.left) / r.width < 0.5 && (e.clientY - r.top) / r.height < 1 : (e.clientY - r.top) / r.height < 0.5;
      item.parentNode.insertBefore(DND.item, before ? item : item.nextSibling);
    });
  });
  container.addEventListener('dragover', e => { if (DND.item && DND.group === group) { e.preventDefault(); if (!container.querySelector(itemSel + ':not(.dnd-ghost)') && !container.contains(DND.item)) container.appendChild(DND.item); } });
  container.addEventListener('drop', e => { if (!DND.item || DND.group !== group) return; e.preventDefault(); const it = DND.item, from = DND.from; it.classList.remove('dnd-ghost'); onDrop(it, from, container); });
}
function bindCurriculum(admin, lessons) {
  const refresh = async () => { await loadCurriculum(); const ls = await curriculumLessons(CUR.tabs.flatMap(t => t.groups.flatMap(g => g.lessons.map(x => x.lesson_id)))); renderCurriculum(admin, ls); };
  const fail = e => alert('Could not save: ' + e.message);
  const on = (sel, ev, fn) => app.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(e, el)));
  const tabOf = id => CUR.tabs.find(t => t.id === +id), groupOf = id => CUR.tabs.flatMap(t => t.groups).find(g => g.id === +id);
  const saveOrder = (table, ids) => Promise.all(ids.map((id, k) => restWrite(`${table}?id=eq.${id}`, { order: k + 1 }, 'PATCH')));
  on('[data-tab]', 'click', (e, a) => { if (e.target.closest('[data-menu], .dropdown-menu, form')) return; e.preventDefault(); CUR.current = +a.dataset.tab; CUR.renameTab = CUR.renameGroup = null; renderCurriculum(admin, lessons); });
  on('[data-edit]', 'click', (e, a) => { e.preventDefault(); CUR.edit = a.dataset.edit === '1'; CUR.newTab = CUR.newGroup = CUR.renameTab = CUR.renameGroup = null; try { localStorage.setItem('curriculumEditMode', CUR.edit); } catch (x) {} renderCurriculum(admin, lessons); });
  on('[data-menu]', 'click', (e, i) => { e.preventDefault(); e.stopPropagation(); const m = i.nextElementSibling; const open = m.classList.contains('show'); app.querySelectorAll('.dropdown-menu.show').forEach(x => x.classList.remove('show')); if (!open) m.classList.add('show'); });
  document.addEventListener('click', () => app.querySelectorAll('.dropdown-menu.show').forEach(x => x.classList.remove('show')), { once: true });
  // New tab / group: inline forms (NewTab.vue, NewGroup.vue)
  on('#cur-newtab', 'click', e => { e.preventDefault(); CUR.newTab = true; renderCurriculum(admin, lessons); });
  on('#cur-newtab-form', 'submit', async (e, f) => { e.preventDefault(); const name = f.querySelector('input').value.trim(); if (!name) return; CUR.newTab = false; try { await restWrite('curriculum_tabs', { school_id: (Auth.me() || {}).school_id, name, order: CUR.tabs.length + 1 }); await loadCurriculum(); CUR.current = CUR.tabs[CUR.tabs.length - 1].id; renderCurriculum(admin, lessons); } catch (x) { fail(x); } });
  on('#cur-newgroup', 'click', e => { e.preventDefault(); CUR.newGroup = true; renderCurriculum(admin, lessons); });
  on('#cur-newgroup-form', 'submit', async (e, f) => { e.preventDefault(); const name = f.querySelector('input').value.trim(); if (!name) return; CUR.newGroup = false; const t = tabOf(CUR.current); try { await restWrite('curriculum_groups', { tab_id: t.id, name, order: t.groups.length + 1 }); await refresh(); } catch (x) { fail(x); } });
  // Rename: inline input, saved on submit or blur (Curriculum.vue, Group.vue)
  on('[data-tab-rename]', 'click', (e, a) => { e.preventDefault(); CUR.renameTab = +a.dataset.tabRename; renderCurriculum(admin, lessons); });
  on('[data-group-rename]', 'click', (e, a) => { e.preventDefault(); CUR.renameGroup = +a.dataset.groupRename; renderCurriculum(admin, lessons); });
  const renameDone = async (f, table, key, cur) => { const name = f.querySelector('input').value.trim(); const id = +f.dataset[key]; CUR[cur] = null; if (!name || name === (table === 'curriculum_tabs' ? tabOf(id) : groupOf(id)).name) { renderCurriculum(admin, lessons); return; } try { await restWrite(`${table}?id=eq.${id}`, { name }, 'PATCH'); await refresh(); } catch (x) { fail(x); } };
  app.querySelectorAll('[data-tab-rename-form]').forEach(f => { let done = false; const go = () => { if (done) return; done = true; renameDone(f, 'curriculum_tabs', 'tabRenameForm', 'renameTab'); }; f.addEventListener('submit', e => { e.preventDefault(); go(); }); f.querySelector('input').addEventListener('blur', go); });
  app.querySelectorAll('[data-group-rename-form]').forEach(f => { let done = false; const go = () => { if (done) return; done = true; renameDone(f, 'curriculum_groups', 'groupRenameForm', 'renameGroup'); }; f.addEventListener('submit', e => { e.preventDefault(); go(); }); f.querySelector('input').addEventListener('blur', go); });
  // Clone and delete (live confirm texts)
  on('[data-tab-clone]', 'click', async (e, a) => { e.preventDefault(); try { CUR.current = await rpc('web_curriculum_clone_tab', { p_tab_id: +a.dataset.tabClone }); await refresh(); } catch (x) { fail(x); } });
  on('[data-tab-delete]', 'click', async (e, a) => { e.preventDefault(); if (!confirm('Are you sure you want to delete this Tab?')) return; try { await restWrite(`curriculum_tabs?id=eq.${a.dataset.tabDelete}`, null, 'DELETE'); CUR.current = null; await refresh(); } catch (x) { fail(x); } });
  on('[data-group-clone]', 'click', async (e, a) => { e.preventDefault(); try { await rpc('web_curriculum_clone_group', { p_group_id: +a.dataset.groupClone }); await refresh(); } catch (x) { fail(x); } });
  on('[data-group-delete]', 'click', async (e, a) => { e.preventDefault(); if (!confirm('Are you sure you want to delete this group?')) return; try { await restWrite(`curriculum_groups?id=eq.${a.dataset.groupDelete}`, null, 'DELETE'); await refresh(); } catch (x) { fail(x); } });
  on('[data-del-gl]', 'click', async (e, b) => { e.preventDefault(); if (!confirm('Are you sure you want to delete this lesson from the group?')) return; try { await restWrite(`curriculum_group_lessons?id=eq.${b.dataset.delGl}`, null, 'DELETE'); await refresh(); } catch (x) { fail(x); } });
  on('[data-copy]', 'click', (e, b) => { e.preventDefault(); openGroupSelect(+b.dataset.copy, refresh); });
  const browse = document.getElementById('cur-browse'); if (browse) browse.addEventListener('click', openBrowse);
  if (!CUR.edit) return;
  // Drag to reorder: tabs, groups, and lessons (within and between the tab's groups)
  makeSortable(document.getElementById('cur-tabs'), '[data-tab-item]', null, 'tabs', async (it, from, to) => {
    const ids = [...to.querySelectorAll('[data-tab-item]')].map(x => +x.dataset.tabItem);
    try { await saveOrder('curriculum_tabs', ids); await refresh(); } catch (x) { fail(x); }
  });
  makeSortable(document.getElementById('cur-groups'), '[data-group]', '.bi-arrows-vertical.drag-handle', 'groups', async (it, from, to) => {
    const ids = [...to.querySelectorAll('[data-group]')].map(x => +x.dataset.group);
    try { await saveOrder('curriculum_groups', ids); await refresh(); } catch (x) { fail(x); }
  });
  app.querySelectorAll('[data-lessons]').forEach(c => makeSortable(c, '[data-gl]', '.bi-arrows-move.drag-handle', 'lessons-' + CUR.current, async (it, from, to) => {
    const glId = +it.dataset.gl, lessonId = +it.dataset.lessonId, toGroup = +to.dataset.lessons;
    try {
      if (from !== to) {
        const g = groupOf(toGroup);
        if (g.lessons.some(x => x.lesson_id === lessonId)) { await restWrite(`curriculum_group_lessons?id=eq.${glId}`, null, 'DELETE'); }   // already there: live drops the duplicate
        else await restWrite(`curriculum_group_lessons?id=eq.${glId}`, { group_id: toGroup }, 'PATCH');
        const fromIds = [...from.querySelectorAll('[data-gl]')].map(x => +x.dataset.gl); await saveOrder('curriculum_group_lessons', fromIds);
      }
      const ids = [...to.querySelectorAll('[data-gl]')].map(x => +x.dataset.gl); await saveOrder('curriculum_group_lessons', ids);
      await refresh();
    } catch (x) { fail(x); }
  }));
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
  const subject = D.subjectById[subjectId], sg = D.subgroupById[sc.subgroup_id];
  if (!subject) { app.innerHTML = '<div class="notice">Section not found.</div>'; return; }
  // Subcategory::routeUrl: a redirect whose target is not live falls back to this category's own page.
  const toCat = sc.is_redirect_to_category && D.subcatById[sc.subcategory_redirect_id];
  if (toCat && D.subjectById[sc.subject_id] && toCat.id !== sc.id) { location.replace(`#/subject/${sc.subject_id}/subcategory/${toCat.id}`); return; }
  if (sc.is_redirect_to_lesson && D.lessonById[sc.lesson_redirect_id]) { location.replace(`#/lesson/${sc.lesson_redirect_id}?sc=${sc.id}`); return; }
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
  const schemes = subcatSchemes(sc);
  if (!schemes.length && sc.is_schemes && classAge() != null) html += AGE_NOTICE;
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
    const restricted = !schemeViewable(variants[sel].s);
    const labels = variants.map((v, i) => v.ages ? ageTextRange(v.ages) : (v.s.subheading || `Version ${i + 1}`));
    labels.forEach((l, i) => { if (labels.indexOf(l) !== i) labels[i] = `${l} (${i + 1})`; });
    // v0.46: on phones the word "Ages" is shown once, before the group, and the buttons carry only the range.
    const sw = merged ? `<span class="age-switch-lbl d-md-none">Ages:</span><div class="btn-group btn-group-sm ms-2 age-switch" role="group" aria-label="Age version">${labels.map((l, i) => `<button type="button" class="btn ${i === sel ? 'btn-light text-primary' : 'btn-outline-light'}" data-variant="${i}">${esc(l).replace(/^(Ages?)\s+/i, '<span class="age-pre">$1 </span>')}</button>`).join('')}</div>` : '';
    html += `<a id="scheme-${first.id}"></a><div class="row"><div class="col"><div class="card mb-5 scheme-card bg-ultra-light-purple border-0 shadow ${restricted ? 'content-restricted' : ''}" data-scheme="${first.id}">
      <div class="row"><div class="col"><div class="card-header bg-primary bg-gradient-primary"><div class="col d-flex justify-content-between align-items-center px-0 ${merged ? 'has-age-switch' : ''}">
        <h5 class="text-truncate text-white mr-1 mb-0">${esc(first.name)}${!merged && first.subheading ? ` <small class="text-white-50 ml-0 ml-sm-2 d-block d-sm-inline">${esc(first.subheading)}</small>` : ''}${variants.some(v => v.s.is_freemium) ? ' <span class="scheme-badge badge-freemium ms-2"><span class="badge bg-success">Free</span></span>' : ''}</h5>${sw}</div></div></div></div>`;
    variants.forEach((v, i) => {
      const s2 = v.s;
      html += `<div class="variant" data-viewable="${schemeViewable(s2) ? 1 : 0}" ${i === sel ? '' : 'hidden'}>
        <div class="row g-0"><div class="col px-3 pt-4 pb-3"><div class="media d-block d-md-flex align-items-center"><img src="${esc(img(s2.image))}" class="img-thumbnail shadow-sm img-fluid align-self-start ms-1 me-3 mb-3 mb-md-0 scheme-thumbnail" alt="${esc(s2.name)}"><div class="media-body px-1">${merged && s2.subheading ? para(s2.subheading, 'text-mid-purple') : ''}${schemeBody(s2)}</div></div></div></div>
        <div class="row mt-2"><div class="col"><div class="card-body pt-0 pb-4">` + v.lessons.map(l => lessonRow(l, sc, v.ages, schemeViewable(s2))).join('') + `</div></div></div></div>`;
    });
    html += `</div></div></div>`;
  }
  if (sc.is_direct_resource) {
    const dr = directResource(sc), vid = dr && dr.id;
    const head = (dr && dr.heading) || sc.name, drText = dr ? dr.text : sc.description;
    html += `<div class="row"><div class="col-12"><div class="card shadow-lg border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white">${esc(head)}</h5><div class="card-body pb-1"><div class="row"><div class="col-12 mb-3"><div class="media d-block">${vid ? `<div class="img-thumbnail shadow-lg img-fluid scheme-thumbnail w-100 d-block border-primary border-dashed p-2">${wistia(vid)}</div>` : ''}<div class="media-body px-1 pt-4"><p class="card-text text-purple fw-light lead mb-0">${nl(drText)}</p></div></div></div></div>${sc.is_direct_resource_linked && sc.direct_resource_link_url ? `<div class="row"><div class="col-sm"><div class="filtered-out-notice alert d-block alert-primary bg-extra-light-purple border-primary mb-4" role="alert"><p class="text-primary my-0 d-flex justify-content-between align-items-center"><a class="text-primary stretched-link" href="${esc(sc.direct_resource_link_url)}" target="_blank" rel="noopener"><i class="bi-arrow-right-circle me-2 text-primary"></i>${esc(sc.direct_resource_link_text || 'Open')}</a></p></div></div></div>` : ''}</div></div></div></div>`;
  }
  if (!sc.is_schemes && !sc.is_direct_resource) html += '<div class="notice">This section has no live schemes at the moment.</div>';
  app.innerHTML = html + `</div></div></div></div>`;
  reveal();
  app.querySelectorAll('.age-switch button').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.scheme-card'); const i = +b.dataset.variant;
    card.querySelectorAll('.age-switch button').forEach(x => { const on = +x.dataset.variant === i; x.classList.toggle('btn-light', on); x.classList.toggle('text-primary', on); x.classList.toggle('btn-outline-light', !on); });
    card.querySelectorAll('.variant').forEach((v, j) => { v.hidden = j !== i; if (j === i) card.classList.toggle('content-restricted', v.dataset.viewable === '0'); });
  }));
  bindClearAge();
  bindLessonRows(sc);
}

// One lesson row of the scheme card (scheme-card.blade.php accordion item), with the PoC's
// expand-in-place body underneath.
function lessonRow(l, sc, schemeAges, viewable = true) {
  const ok = canAccessLesson(l);
  const showAge = !classAge() && lessonAges(l) && lessonAges(l) !== schemeAges;
  const meta = (showAge ? `<span class="lesson-icon text-truncate ms-2 my-1" title="Suitable for ages ${esc(lessonAges(l))}"><i class="bi-person text-purple mr-1"></i> <span class="d-inline d-xl-none">${esc(lessonAges(l))}yrs</span><span class="d-none d-xl-inline">${esc(ageText(l))}</span></span>` : '') +
    (l.duration ? `<span class="lesson-icon text-truncate ms-2 ml-lg-3 my-1" title="Around ${l.duration} minutes long"><i class="bi-clock text-purple mr-1"></i> ${l.duration}m</span>` : '');
  return `<div class="accordion list-group list-group-horizontal shadow mt-0 mb-2 ${ok ? '' : 'content-restricted'} lesson-x" data-lesson="${l.id}">
    <div class="list-group-item list-group-item-action cursor-pointer px-3 lesson-row" role="button" aria-expanded="false"><div class="row h-100"><div class="col d-flex align-items-center">
      <div class="d-flex justify-content-start align-items-center pe-1"><i class="${MY.seen.has(l.id) ? 'text-mid-purple ' + lessonIcon(l).replace('-fill', '') : 'text-primary ' + lessonIcon(l)} h5 my-0 me-2"></i></div>
      <div class="d-flex flex-grow-1 flex-wrap align-items-center mt-2 mb-1"><h5 class="w-100 text-primary mb-0">${esc(l.name)}${l.is_freemium ? ' <small class="ms-1 scheme-badge badge-freemium"><span class="badge bg-success">Free</span></small>' : ''}</h5><span class="w-100 text-mid-purple fw-light">${esc(l.description || '')}</span></div>
      <div class="d-none d-md-flex flex-shrink-0 align-items-center"><small class="ms-3 d-flex flex-wrap justify-content-end text-muted text-mid-purple fw-light">${meta}</small></div>
    </div></div></div>
    <div class="list-group-item px-1 px-md-3"><div class="d-none d-md-flex flex-column h-100 justify-content-around align-items-center"><div>
      <div class="${l.description ? 'mb-1' : ''}"><div class="lesson-icon cursor-pointer mark-as-complete" data-done-for="${l.id}" data-done-kind="icon"><i class="bi-circle text-mid-purple"></i></div></div>
      <div><div class="lesson-icon cursor-pointer add-to-favourites" data-fav-for="${l.id}" data-fav-kind="icon"><i class="bi-star text-mid-purple"></i></div></div>
    </div>${viewable ? `<div><div class="btn-outline-primary curriculum-btn" title="Add to Curriculum" data-lesson-id="${l.id}"><i class="bi bi-bookmark-plus"></i></div></div>` : ''}</div></div>
  </div>
  <div class="lesson-drawer collapse-smooth closed" data-lesson-body="${l.id}"><div></div></div>`;
}
function bindLessonRows(sc) {
  // scheme-card.blade.php: a lesson the user cannot access links to the subscribe options page.
  app.querySelectorAll('.lesson-x.content-restricted .lesson-row').forEach(row => row.addEventListener('click', e => { if (!e.target.closest('a, .lesson-icon')) location.hash = upgradeHref(); }));
  app.querySelectorAll('.lesson-x:not(.content-restricted) .lesson-row').forEach(row => row.addEventListener('click', async e => {
    if (e.target.closest('a, .lesson-icon')) return;
    const x = row.closest('.lesson-x'), drawer = x.nextElementSibling, wasOpen = !drawer.classList.contains('closed');
    const scope = x.closest('.card-body');
    scope.querySelectorAll('.lesson-drawer').forEach(d => d.classList.add('closed'));
    scope.querySelectorAll('.lesson-row').forEach(r => r.setAttribute('aria-expanded', 'false'));
    scope.querySelectorAll('.lesson-x.open').forEach(o => o.classList.remove('open'));   // v0.45.4: open row + drawer read as one framed block
    if (wasOpen) return;
    drawer.classList.remove('closed'); row.setAttribute('aria-expanded', 'true'); x.classList.add('open');
    const body = drawer.firstElementChild;
    if (!body.dataset.loaded) { body.innerHTML = '<div class="loading" style="padding:1rem">Loading…</div>'; await fillLessonBody(body, +drawer.dataset.lessonBody, sc); }
    scrollToTop(x);
  }));
  bindActions(app);
}
// v0.45.5 (David): whatever has just been opened sits at the top of the window, just under the
// sticky header. Scrolled once the content is in, and again when the drawer has finished
// growing, so the row ends up at the top rather than wherever the layout was mid-animation.
function scrollToTop(el) {
  const target = () => { const header = document.getElementById('header'); return Math.max(0, el.getBoundingClientRect().top + window.scrollY - ((header ? header.offsetHeight : 0) + 8)); };
  const go = behavior => window.scrollTo({ top: target(), behavior });
  requestAnimationFrame(() => go('smooth'));
  setTimeout(() => go('smooth'), 380);   // after the .32s open transition
  // v0.45.6: settle exactly - a smooth scroll can be cut short or throttled (iOS, background tabs)
  setTimeout(() => { if (Math.abs(window.scrollY - target()) > 4) go('auto'); }, 900);
}
async function fillLessonBody(el, lessonId, sc) {
  const [rows, parts] = await Promise.all([
    rest(`lessons?id=eq.${lessonId}&select=*`),
    lessonParts(lessonId),
  ]);
  const l = rows[0];
  if (!l) { el.innerHTML = '<div class="notice">Lesson not found.</div>'; return; }
  el.innerHTML = `<div class="card scheme-card bg-ultra-light-purple border-0 shadow mb-3 lesson-inline">
    ${lessonText(l) ? `<div class="row g-0"><div class="col px-3 pt-3 pb-2"><div class="media-body px-1">${lessonText(l)}</div></div></div>` : ''}
    <div class="row"><div class="col-12"><div class="card-body py-3">${renderParts(l, parts, true)}</div></div></div>
    <div class="row d-none d-md-flex"><div class="col-12"><div class="card-body pt-0 pb-3 d-flex justify-content-end"><a class="btn btn-outline-primary btn-sm" href="${lessonHref(l, sc)}"><i class="bi-arrows-fullscreen me-1"></i> Open full page</a></div></div></div></div>`;   // v0.45.6: no "Open full page" on phones
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
    lessonParts(id),
  ]);
  const l = rows[0];
  if (!l || !l.is_live) { app.innerHTML = '<div class="notice">Lesson not found.</div>'; return; }
  if (!canAccessLesson(l)) { app.innerHTML = `<div class="notice"><strong>${esc(l.name)}</strong> - ${esc(E.lessonMessage)}${E.showUpgrade ? ` <a class="btn btn-primary btn-sm" href="${upgradeHref()}" style="margin-left:.6rem">${esc(E.upgradeText)}</a>` : ''}</div>`; return; }
  const scheme = D.schemeById[l.scheme_id];
  const sc = D.subcatById[scId] || (scheme && D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]]);
  const subject = sc && D.subjectById[sc.subject_id], sg = sc && D.subgroupById[sc.subgroup_id];
  if (sc && !subject) { app.innerHTML = '<div class="notice">You do not have access to this page.</div>'; return; }   // LessonController: 403 when the category's subject is out of scope
  setBg(l.background_image_url || sc?.background_image_url || subject?.background_image_url);
  const seq = scheme ? schemeLessons(scheme) : [l];
  // Lesson::previousLesson / nextLesson: by order among the scheme's lessons, age filter applied.
  const next = seq.find(x => x.order > l.order), prev = [...seq].reverse().find(x => x.order < l.order);
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
    <div class="my-4 d-flex justify-content-between px-2"><a href="#/lesson/${l.id}/history" class="btn shadow ${btn}"><i class="d-none d-lg-inline bi-list-check mr-1"></i> History</a><button type="button" class="d-lg-none mx-2 btn shadow add-to-favourites ${btn}" data-fav-for="${l.id}" data-fav-kind="mobile" data-bg="${bg ? 1 : 0}"></button><button type="button" class="btn shadow ms-1 mark-as-complete ${btn}" data-done-for="${l.id}" data-bg="${bg ? 1 : 0}" data-label="${esc(Label)}"></button></div>
    <hr class="d-none d-lg-block mx-2 ${bg ? 'border-mid-purple' : ''}">
    <div class="d-none d-lg-block my-4 px-2"><button type="button" class="btn shadow add-to-favourites w-100 ${btn}" data-fav-for="${l.id}" data-bg="${bg ? 1 : 0}" data-label="${esc(Label)}" data-labels="${esc(Labels)}"></button></div>
    ${l.show_assessment ? `<div class="d-lg-none px-2 mb-3 row"><div class="col"><button type="button" class="btn shadow w-100 ${btn}" data-thumb="${l.id}">Thumb-o-meter</button></div><div class="col d-flex align-items-center"><a href="#" class="fw-bold text-decoration-underline" id="past-readings">Past measurements</a></div></div><div class="d-none d-lg-block my-4 px-2"><button type="button" class="btn shadow w-100 ${btn}" data-thumb="${l.id}"><i class="bi-hand-thumbs-up me-2"></i>Thumb-o-meter</button></div><div class="d-none d-lg-block my-4 px-2 text-primary" id="readings"></div>` : ''}
    <div class="my-4 px-2"><button type="button" class="btn shadow w-100 curriculum-btn ${btn}" data-lesson-id="${l.id}"><i class="bi bi-bookmark-plus me-1"></i> Add to Curriculum</button></div>
  </div></div>`;
  app.innerHTML = html;
  reveal();
  bindParts(app);
  bindActions(app);
  logView(l.id);
  if (l.show_assessment) {
    renderReadings(l.id); app.querySelectorAll('[data-thumb]').forEach(b => b.addEventListener('click', () => openThumb(l)));
    // #assessmentResultsModal: the readings in a modal, for the mobile layout
    document.getElementById('past-readings').addEventListener('click', e => { e.preventDefault(); const body = (document.getElementById('readings') || {}).innerHTML || '<p class="fw-light">No readings for this lesson yet.</p>';
      smModal('assessmentResultsModal', '', '', ''); const m = document.getElementById('assessmentResultsModal');
      m.innerHTML = `<div class="modal-dialog modal-lg text-primary"><div class="modal-content"><div class="modal-header bg-primary text-white"><h1 class="modal-title fs-5"><i class="bi-hand-thumbs-up me-2"></i> Your thumb-o-meter readings</h1><button type="button" class="btn-close" data-close aria-label="Close"></button></div><div class="modal-body">${body.replace('<div class="mb-3">Your thumb-o-meter readings</div>', '')}</div></div></div>`;
      m.querySelector('[data-close]').addEventListener('click', () => hideModal('assessmentResultsModal')); });
  }
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
  const table = (title, list) => `<div class="heading-2">${title}</div><table class="viewed-table table table-borderless text-1 text-primary"><thead><tr><th class="pl-0">Date</th><th class="pl-0">Time</th></tr></thead><tbody>${list.map(r => `<tr><td class="pl-0">${fmtDate(r.at)}</td><td class="pl-0">${fmtTime(r.at)}</td></tr>`).join('')}</tbody></table>`;
  app.innerHTML = `<div class="content-page-nav d-flex justify-content-center mb-3"><div class="back d-inline-block"><a href="#/lesson/${l.id}" class="nav-button d-block text-1"><img class="arrow-img" src="live/img/arrow_next.png" alt=""> <span class="nav-text">Back</span></a></div></div>
    <div class="lesson-history-container form-page container-fluid text-primary"><div class="row"><div class="col-12 heading-1 text-center">Lesson history</div></div><div class="row mt-3 mb-4"><div class="col-12 heading-2">${esc(l.name)}</div></div>
    <div class="row"><div class="col-12 col-sm-6">${table('Marked as done', rows.filter(r => r.kind === 'completed'))}</div><div class="col-12 col-sm-6">${table('Viewed', rows.filter(r => r.kind === 'viewed'))}</div></div></div>`;
  reveal();
}

// ResultsController groups results under "<i class=\"{icon} text-white mr-1\"></i> {name}".
function subjectIcon(s) { return s && s.icon ? `<i class="${esc(s.icon)} text-white mr-1"></i> ` : ''; }
// Favourites (results/show-favourites.blade.php): personal favourites grouped by subject.
// results/show-favourites.blade.php lesson card (favourites and search results share it).
function resultLessonCard(l, scheme, sc) {
  const blurb = (l.description || l.body_opening_text || '').trim();
  return `<div class="col-12 col-md-6 col-lg-3 mb-4"><a href="${lessonHref(l, sc)}" class="text-decoration-none"><div class="card subcategory-card lift h-100 shadow-sm d-flex flex-column"><img src="${esc(img(scheme?.image))}" class="card-img-top" alt="${esc(l.name)}" loading="lazy"><div class="card-body border-top border-primary p-0 d-flex flex-column justify-content-between"><div class="align-self-start w-100 flex-grow-1"><div class="pt-2 d-flex flex-column w-100 h-100 justify-content-center"><h5 class="text-primary ${blurb ? 'mt-3 mb-1' : 'my-3'} mx-3 card-title text-truncate"><small class="text-mid-purple mb-2">${esc(scheme ? scheme.name : '')}<br></small>${esc(l.name)}</h5>${blurb ? `<h6 class="h6 text-mid-purple fw-light mb-3 mx-3 card-title">${esc(limit(blurb, 100))}</h6>` : ''}</div></div>
        <ul class="list-group border-0 list-group-flush list-group-horizontal text-mid-purple small text-nowrap justify-content-around"><li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="lesson-icon text-truncate"><i class="bi-person text-purple mr-1"></i> <span>${esc(ageText(l))}</span></span></li>${l.duration ? `<li class="list-group-item border-0 bg-transparent d-flex flex-fill justify-content-start align-items-center"><span class="lesson-icon text-truncate ms-2 ml-lg-3 my-1"><i class="bi-clock text-purple mr-1"></i> ${l.duration}m</span></li>` : ''}</ul></div></div></a></div>`;
}
// Lessons grouped under one panel per subject (ResultsController), subjects in name order,
// lessons in name order. withCounts adds the "N favourite lessons" small (favourites only).
function resultPanels(lessons, withCounts) {
  const bySubject = {};
  for (const l of lessons) {
    const scheme = D.schemeById[l.scheme_id]; const sc = scheme && D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]];
    // The lesson's own subjects (Lessons fid 944), as ResultsController does; a lesson sits under
    // each subject it belongs to. Fallback: the subject of its first category.
    // SubjectPolicy::search: all-content users, or the subject is in the user's subject or niche lists.
    const canSearch = s => s && (withCounts || E.allContent || E.subjectIds.has(s.id));   // favourites: every subject (showFavourites has no policy)
    let subjects = [...new Set(l.subject_ids || [])].map(id => D.subjectById[+id]).filter(canSearch);   // Quickbase lists a subject twice at times
    if (!subjects.length && !(l.subject_ids || []).length) { const s = sc && D.subjectById[sc.subject_id]; if (canSearch(s)) subjects = [s]; }   // no subject data at all: the category's subject
    for (const subj of subjects) (bySubject[subj.name] ||= { sc, subj, items: [] }).items.push({ l, scheme, sc });
  }
  let html = '';
  for (const name of Object.keys(bySubject).sort((x, y) => x.localeCompare(y))) {
    const g = bySubject[name]; g.items.sort((x, y) => x.l.name.localeCompare(y.l.name));
    const n = g.items.length, lab = (g.sc ? noun(g.sc, n) : (n === 1 ? 'lesson' : 'lessons')).toLowerCase();
    html += `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white">${subjectIcon(g.subj)}${esc(name)}${withCounts ? ` <small class="text-white-50 ml-0 ml-sm-2 d-block d-sm-inline">${n} favourite ${esc(lab)}</small>` : ''}</h5><div class="card-body pb-1"><div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 row-cols-lg-3">`;
    for (const { l, scheme, sc } of g.items) html += resultLessonCard(l, scheme, sc);
    html += `</div></div></div></div></div>`;
  }
  return html;
}
const NO_FAVOURITES = `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white"><i class="bi-star-fill mr-1 text-warning"></i> Favourite Lessons</h5><div class="card-body pb-1"><div class="row"><div class="col-12"><div class="filtered-out-notice alert d-block alert-primary bg-extra-light-purple border-primary mb-4" role="alert"><p class="text-primary my-0 d-flex justify-content-between align-items-center"><span><span class="text-primary h5">You haven't favourited any lessons yet.</span> <span class="text-mid-purple ms-1">To save a lesson to your favourites, click the <i class="bi-star mx-1 text-primary"></i> icon.</span></span></p></div></div></div></div></div></div></div>`;
async function pageFavourites() {
  setBg(null);
  const ids = [...MY.fav];
  let html = `<div class="row"><div class="col-xs-12 col-6 my-3 mb-0"><h4 class="text-primary"><span class="badge bg-warning me-2"><i class="bi-star-fill" style="position: relative; bottom: 1px;"></i></span><span class="d-none d-md-inline">My Favourite Lessons</span><span class="d-inline d-md-none">Favourites</span></h4></div>
    <div class="col-xs-12 col-6 my-3 mb-0"><div class="text-end">${(Auth.me() || {}).is_admin ? '<small class="text-primary fw-light">Your Favourites are shared automatically across all authorised users at your school</small>' : ''}</div></div><div class="col-12" style="margin-top: -0.5em"><hr></div></div>`;
  if (!ids.length) { app.innerHTML = html + NO_FAVOURITES; reveal(); return; }
  const lessons = await rest(`lessons?id=in.(${ids.join(',')})&is_live=eq.true&select=id,name,description,body_opening_text,scheme_id,age_min,age_max,duration,subject_ids&order=name`);
  app.innerHTML = html + resultPanels(lessons, true); reveal();
}

// ---------- slide player (v0.39) ----------
// Decks captured from Google Slides (slides-migration/capture.js, public.lesson_slides) play
// here as images: previous/next, counter, keyboard, pen with colours, erase all, laser pointer,
// full screen. Ink is kept per slide for the page's lifetime. Decks not yet captured keep the
// Google iframe (the Slides case above).
// v0.45: images that are still loading when they reach the page fade in once they arrive
// (cached ones show at once). Covers every page render through one observer on #app.
function watchImages() {
  const seen = img => {
    if (img.dataset.fx) return; img.dataset.fx = '1';
    if (img.complete && img.naturalWidth) return;
    img.classList.add('fx-wait');
    const show = () => { img.classList.remove('fx-wait'); img.classList.add('fx-in'); };
    img.addEventListener('load', show, { once: true }); img.addEventListener('error', show, { once: true });
  };
  app.querySelectorAll('img').forEach(seen);
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; if (n.tagName === 'IMG') seen(n); else n.querySelectorAll && n.querySelectorAll('img').forEach(seen); }))).observe(app, { childList: true, subtree: true });
}
async function loadSlides() {
  try { const rows = await rest('lesson_slides?select=google_slide_id,slide_count,width,height,base_url&state=eq.ready', { all: true }); D.slides = new Map(rows.map(r => [r.google_slide_id, r])); }
  catch (e) { D.slides = new Map(); }
}
const PEN_COLOURS = [['#d93025', 'Red'], ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#f9ab00', 'Yellow'], ['#202124', 'Black']];
function slidePlayer(deck) {
  const ratio = deck.width && deck.height ? (deck.height / deck.width * 100).toFixed(3) : '56.25';
  return `<div class="slide-player" data-deck="${esc(deck.google_slide_id)}" data-count="${deck.slide_count}" data-base="${esc(deck.base_url)}" tabindex="0" aria-label="Slideshow">
    <div class="slide-stage" style="padding-top:${ratio}%"><img class="slide-img" src="${esc(deck.base_url)}/1.png" alt="Slide 1" draggable="false"><canvas class="slide-ink"></canvas><div class="slide-laser"></div></div>
    <div class="slide-bar">
      <button type="button" class="sp-btn" data-sp="prev" title="Previous slide (Left)"><i class="bi-chevron-left"></i></button>
      <span class="sp-counter"><span class="sp-n">1</span> / ${deck.slide_count}</span>
      <button type="button" class="sp-btn" data-sp="next" title="Next slide (Right)"><i class="bi-chevron-right"></i></button>
      <span class="sp-gap"></span>
      <button type="button" class="sp-btn" data-sp="pen" title="Pen (P)"><i class="bi-pencil-fill"></i></button>
      <span class="sp-colours">${PEN_COLOURS.map(([c, n], i) => `<button type="button" class="sp-colour ${i === 0 ? 'active' : ''}" data-colour="${c}" style="background:${c}" title="${n}" aria-label="${n} pen"></button>`).join('')}</span>
      <button type="button" class="sp-btn" data-sp="erase" title="Erase all on this slide (Shift+A)"><i class="bi-eraser-fill"></i></button>
      <button type="button" class="sp-btn" data-sp="laser" title="Laser pointer (L)"><i class="bi-record-circle"></i></button>
      <span class="sp-gap"></span>
      <button type="button" class="sp-btn" data-sp="full" title="Full screen (F)"><i class="bi-arrows-fullscreen"></i></button>
    </div></div>`;
}
function bindSlidePlayers(root) {
  root.querySelectorAll('.slide-player').forEach(sp => {
    if (sp.dataset.bound) return; sp.dataset.bound = '1';
    const count = +sp.dataset.count, base = sp.dataset.base, img = sp.querySelector('.slide-img'), canvas = sp.querySelector('.slide-ink'), ctx = canvas.getContext('2d'), laser = sp.querySelector('.slide-laser'), stage = sp.querySelector('.slide-stage');
    const ink = new Map();   // slide index -> strokes [{c, w, pts:[[x,y]...]}] in 0..1 coordinates
    let n = 1, pen = false, laserOn = false, colour = PEN_COLOURS[0][0], drawing = null;
    const fit = () => { const r = stage.getBoundingClientRect(); canvas.width = Math.round(r.width * devicePixelRatio); canvas.height = Math.round(r.height * devicePixelRatio); redraw(); };
    const redraw = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); for (const s of ink.get(n) || []) stroke(s); };
    const stroke = s => { if (s.pts.length < 1) return; ctx.strokeStyle = s.c; ctx.lineWidth = s.w * canvas.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); s.pts.forEach(([x, y], i) => i ? ctx.lineTo(x * canvas.width, y * canvas.height) : ctx.moveTo(x * canvas.width, y * canvas.height)); if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * canvas.width + 0.1, s.pts[0][1] * canvas.height); ctx.stroke(); };
    const go = k => { if (k < 1 || k > count) return; n = k; img.src = `${base}/${n}.png`; img.alt = `Slide ${n}`; sp.querySelector('.sp-n').textContent = n; redraw(); const pre = new Image(); if (n < count) pre.src = `${base}/${n + 1}.png`; };
    const pos = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    const setPen = v => { pen = v; sp.classList.toggle('pen-on', pen); sp.querySelector('[data-sp="pen"]').classList.toggle('active', pen); if (pen) setLaser(false); };
    const setLaser = v => { laserOn = v; sp.classList.toggle('laser-on', laserOn); sp.querySelector('[data-sp="laser"]').classList.toggle('active', laserOn); laser.style.display = laserOn ? '' : 'none'; if (laserOn) setPen(false); };
    sp.querySelectorAll('[data-sp]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const k = b.dataset.sp;
      if (k === 'prev') go(n - 1); else if (k === 'next') go(n + 1); else if (k === 'pen') setPen(!pen); else if (k === 'laser') setLaser(!laserOn);
      else if (k === 'erase') { ink.delete(n); redraw(); }
      else if (k === 'full') { if (document.fullscreenElement === sp) document.exitFullscreen(); else (sp.requestFullscreen ? sp.requestFullscreen() : sp.webkitRequestFullscreen && sp.webkitRequestFullscreen()); }
      sp.focus(); }));
    sp.querySelectorAll('.sp-colour').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); colour = b.dataset.colour; sp.querySelectorAll('.sp-colour').forEach(x => x.classList.toggle('active', x === b)); setPen(true); sp.focus(); }));
    stage.addEventListener('pointerdown', e => { if (!pen) return; e.preventDefault(); stage.setPointerCapture(e.pointerId); drawing = { c: colour, w: 0.004, pts: [pos(e)] }; (ink.get(n) || ink.set(n, []).get(n)).push(drawing); redraw(); });
    stage.addEventListener('pointermove', e => { if (laserOn) { const r = stage.getBoundingClientRect(); laser.style.left = (e.clientX - r.left) + 'px'; laser.style.top = (e.clientY - r.top) + 'px'; } if (drawing) { drawing.pts.push(pos(e)); redraw(); } });
    const up = () => { drawing = null; }; stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    stage.addEventListener('click', e => { if (pen || laserOn) return; const r = stage.getBoundingClientRect(); go((e.clientX - r.left) / r.width < 0.3 ? n - 1 : n + 1); });
    let tx = null; stage.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true }); stage.addEventListener('touchend', e => { if (tx == null || pen) return; const dx = e.changedTouches[0].clientX - tx; if (Math.abs(dx) > 40) go(dx < 0 ? n + 1 : n - 1); tx = null; });
    sp.addEventListener('keydown', e => { const k = e.key; if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') { e.preventDefault(); go(n + 1); } else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(n - 1); } else if (k === 'Home') go(1); else if (k === 'End') go(count); else if (k === 'p' || k === 'P') setPen(!pen); else if (k === 'l' || k === 'L') setLaser(!laserOn); else if (k === 'A' && e.shiftKey) { ink.delete(n); redraw(); } else if (k === 'f' || k === 'F') sp.querySelector('[data-sp="full"]').click(); });
    document.addEventListener('fullscreenchange', () => { sp.classList.toggle('is-full', document.fullscreenElement === sp); setTimeout(fit, 50); });
    new ResizeObserver(fit).observe(stage); fit();
  });
}

// Lesson parts accordion (lessons/lesson-part.blade.php + the per-type cards). One open at a time.
// ---------- lesson documents (v0.44) ----------
// Decision (David, 2 Nov 2026): anything not played or shown to the class on screen - every
// Download part - leaves the "Part X of Y" sequence. The lesson plan gets its own card; the
// other downloads (assessment sheets, flashcards, worksheets ...) are listed as Printables.
// Files come from the R2 copies (files-migration/copy.js, public.lesson_files) under readable
// names; a part not yet copied falls back to its original file.
const isDocPart = p => p.media_type === 'Download';
const isPlanPart = p => /\b(lesson|session)\s*plans?\b/i.test(p.heading || '');
async function lessonParts(lessonId) {
  const q = `lesson_parts?lesson_id=eq.${lessonId}&is_live=eq.true&is_archived=eq.false&order=order,index`;
  try { return await rest(`${q}&select=*,lesson_files(url,filename,bytes,pages,content_type)`); }
  catch (e) { return rest(`${q}&select=*`); }   // copies table not there yet
}
function docFile(p) {
  const f = Array.isArray(p.lesson_files) ? p.lesson_files[0] : p.lesson_files;
  const url = (f && f.url) || p.download_url_override || p.s3_url || '';
  const ext = ((f && f.filename) || url.split('?')[0]).match(/\.([a-z0-9]{2,4})$/i);
  return { url, filename: f && f.filename, bytes: f && f.bytes, pages: f && f.pages, type: ext ? ext[1].toUpperCase() : '' };
}
function docIcon(d) { return { PDF: 'bi-file-earmark-pdf-fill', DOC: 'bi-file-earmark-word-fill', DOCX: 'bi-file-earmark-word-fill', PPT: 'bi-file-earmark-slides-fill', PPTX: 'bi-file-earmark-slides-fill', XLS: 'bi-file-earmark-spreadsheet-fill', XLSX: 'bi-file-earmark-spreadsheet-fill', JPG: 'bi-file-earmark-image-fill', JPEG: 'bi-file-earmark-image-fill', PNG: 'bi-file-earmark-image-fill', MP3: 'bi-file-earmark-music-fill', ZIP: 'bi-file-earmark-zip-fill' }[d.type] || 'bi-file-earmark-arrow-down-fill'; }
function docButton(d) {
  if (!d.url) return '<span class="text-mid-purple fw-light">File not available</span>';
  return `<a class="btn btn-primary btn-sm doc-open" href="${esc(d.url)}" target="_blank" rel="noopener"><i class="bi-eye me-1"></i>Open</a>`;
}
// v0.44.2 (David): one Open button, no file details, icons the size of the part icons.
function renderDocs(l, docs) {
  if (!docs.length) return '';
  const plans = docs.filter(isPlanPart), others = docs.filter(p => !isPlanPart(p));
  // v0.44.3: document rows use the parts rows' own markup (icon, h5 title, right-hand block),
  // so the three blocks - lesson plan, Printables, parts - share one frame, row height and type.
  const row = (p, title) => { const d = docFile(p); return `<div class="list-group-item px-3 doc-row" data-part="${p.id}">
      <div class="row part-head"><div class="col d-flex align-items-center"><div class="d-flex justify-content-start align-items-center pe-1"><i class="text-primary ${docIcon(d)} h5 mt-2 me-2"></i></div><div class="d-flex flex-grow-1 flex-wrap align-items-center mt-2 mb-1"><h5 class="w-100 text-primary mb-0">${esc(title)}</h5></div><div class="d-flex flex-shrink-0 align-items-center ms-2">${docButton(d)}</div></div></div>
    </div>`; };
  return `<div class="lesson-docs">
    ${plans.length ? `<div class="list-group lesson-block doc-plan">${plans.map(p => row(p, plans.length > 1 ? p.heading : 'Lesson plan')).join('')}</div>` : ''}
    ${others.length ? `<div class="list-group lesson-block doc-printables"><div class="doc-printables-head"><i class="bi-printer me-2"></i>Printables</div>${others.map(p => row(p, p.heading || 'Download')).join('')}</div>` : ''}
  </div>`;
}
function renderParts(l, allParts, openFirst) {
  if (!allParts.length) return '<div class="notice">This lesson has no live parts at the moment.</div>';
  // v0.44: downloads leave the sequence and sit above it as documents (renderDocs); the parts
  // played or shown to the class are numbered among themselves.
  const docs = allParts.filter(isDocPart), parts = allParts.filter(p => !isDocPart(p));
  const docsHtml = renderDocs(l, docs);
  if (!parts.length) return docsHtml;
  return docsHtml + `<div class="accordion list-group lesson-block lesson-parts mt-0" id="lesson-${l.id}-parts">` + parts.map((p, i) => {
    const show = openFirst && i === 0;
    const info = p.additional_info && p.additional_info.trim();
    const infoHtml = info ? para(p.additional_info) : '';
    let card = '';
    switch (p.media_type) {
      case 'Video': card = `<div class="media d-block d-md-flex align-items-center"><div class="img-thumbnail shadow-sm img-fluid ${info ? 'w-50' : 'w-100'} align-self-start ms-1 me-3 mb-3 mb-md-0">${p.wistia_id ? wistia(p.wistia_id) : '<div class="notice">No video id on this part.</div>'}</div><div class="media-body px-1 ${info ? '' : 'd-none'}">${infoHtml}</div></div>`; break;
      case 'Audio': card = `<div class="media d-block align-items-center"><div class="img-thumbnail shadow-sm img-fluid w-100 px-2 ${info ? 'mb-4' : ''}"><audio controls controlsList="nodownload" style="width:100%;" class="mt-2" preload="none"><source src="${esc(p.s3_url)}" type="audio/mpeg"></audio></div>${info ? `<div class="media-body w-100 px-1">${infoHtml}</div>` : ''}</div>`; break;
      case 'Download': card = `<div class="media d-block align-items-center"><div class="border border-primary bg-light-purple rounded p-2 ${info ? 'mb-4' : ''}"><a href="${esc(p.s3_url)}" download class="btn btn-primary" target="_blank" rel="noopener"><i class="bi-cloud-download me-2"></i>${esc(p.download_button || 'Download File')}</a><span class="ms-3 text-primary">${esc(p.download_info || 'Save and open this file to complete this part of the lesson.')}</span></div>${info ? `<div class="media-body w-100 px-1">${infoHtml}</div>` : ''}</div>`; break;
      case 'Slides': {
        const deck = D.slides && D.slides.get(p.google_slide_id);
        const show = deck ? slidePlayer(deck) : `<div class="slideshow-container" style="position: relative; width: 100%; min-height: ${info ? '280px' : '560px'};"><iframe src="https://docs.google.com/presentation/d/e/${esc(p.google_slide_id)}/embed?start=false&loop=false&delayms=60000" frameborder="0" allowfullscreen style="width: 100%; height: 100%; position:absolute; inset:0;" title="Slides"></iframe></div><small class="d-block text-mid-purple fw-light mt-2">Click the dots (<i class="text-primary bi-three-dots-vertical"></i>) to play in full-screen.</small>`;
        card = `<div class="media d-block d-md-flex align-items-center"><div class="img-thumbnail shadow-sm img-fluid ${info ? 'w-50' : 'w-100'} align-self-start me-3 p-2">${show}</div><div class="media-body px-1 ${info ? '' : 'd-none'}">${infoHtml}</div></div>`; break;
      }
      case 'Image': card = `<div class="media d-block d-md-flex align-items-center"><img src="${esc(p.s3_url)}" alt="${esc(p.heading || '')}" class="img-thumbnail shadow-sm img-fluid ${info ? 'w-50' : 'w-100'} align-self-start me-3 p-2" loading="lazy"><div class="media-body px-1 ${info ? '' : 'd-none'}">${infoHtml}</div></div>`; break;
      default: card = infoHtml || '<p class="card-text text-mid-purple fw-light mb-1">No content.</p>';
    }
    const dur = p.duration && p.duration.trim() !== ':' ? `<span class="d-flex justify-content-end w-100 text-muted text-mid-purple fw-light"><span class="lesson-icon text-truncate ms-2 my-1"><i class="bi-stopwatch text-purple mr-1"></i> ${esc(p.duration)}</span></span>` : '';
    return `<div class="list-group-item list-group-item-action lesson-collapse cursor-pointer px-3 lesson-part-item ${show ? 'active-part' : ''}" data-part="${p.id}">
      <div class="row part-head" role="button" aria-expanded="${show}"><div class="col d-flex align-items-center"><div class="d-flex justify-content-start align-items-center pe-1"><i class="text-primary ${partIcon(p)} h5 mt-2 me-2"></i></div><div class="d-flex flex-grow-1 flex-wrap align-items-center mt-2 mb-1"><h5 class="w-100 text-primary mb-0">${esc(p.heading || p.media_type)}</h5></div><div class="d-none d-md-flex flex-shrink-0 flex-column align-items-center">${dur}<span class="d-flex justify-content-end w-100 text-muted text-mid-purple fw-light"><small class="ms-1 text-mid-purple">${parts.length > 1 ? `Part ${i + 1} of ${parts.length}` : ''}</small></span></div></div></div>
      <div class="collapse-smooth part-body ${show ? '' : 'closed'}"><div><hr><div class="col p-3">${card}</div></div></div>
    </div>`;
  }).join('') + `</div>`;
}
function bindParts(root) {
  bindSlidePlayers(root);
  root.querySelectorAll('.lesson-part-item .part-head').forEach(h => h.addEventListener('click', e => {
    if (e.target.closest('a, audio, iframe, button, .slide-player')) return;
    const item = h.closest('.lesson-part-item'), body = item.querySelector('.part-body'), wasOpen = !body.classList.contains('closed');
    item.closest('.accordion').querySelectorAll('.part-body').forEach(b => b.classList.add('closed'));
    item.closest('.accordion').querySelectorAll('.part-head').forEach(x => x.setAttribute('aria-expanded', 'false'));
    if (wasOpen) return;
    body.classList.remove('closed'); h.setAttribute('aria-expanded', 'true');
    scrollToTop(item);
  }));
}

// Search results: ResultsController::search() renders results/show-favourites.blade.php with
// no header - one panel per subject of lesson cards (lessons whose "search" text matches),
// inaccessible lessons left out. With no match: "No results found for your query."
async function pageSearch(q) {
  setBg(null);
  if (!q.trim()) { app.innerHTML = '<div class="notice mt-4">Use Search in the header to find lessons by title, topic, subject or lesson ID.</div>'; return; }
  app.innerHTML = '<div class="loading">Searching…</div>';
  const term = q.trim().replace(/[%,.()]/g, ' ').replace(/\s+/g, ' ');
  const rows = await rest(`lessons?is_live=eq.true&search=ilike.*${encodeURIComponent(term)}*&select=id,name,description,body_opening_text,scheme_id,is_freemium,age_min,age_max,duration,subject_ids&order=name&limit=500`);
  // ResultsController::search: the age filter applies (FilterScope, no subject in the URL); the policy check ignores age rights.
  const live = rows.filter(l => D.lessonById[l.id] && D.schemeById[l.scheme_id] && passesAgeFilter(l, null) && canAccessLesson(l, false));
  logSearch(q.trim(), live.length);
  // show-favourites.blade.php without the favourites header: "No results found for your query."
  const none = `<div class="row"><div class="col-12"><div class="card shadow bg-light-purple border-primary mb-5"><h5 class="card-header bg-primary bg-gradient-primary text-white"></h5><div class="card-body pb-1"><div class="row"><div class="col-12"><div class="filtered-out-notice alert d-block alert-primary bg-extra-light-purple border-primary mb-4" role="alert"><p class="text-primary my-0 d-flex justify-content-between align-items-center"><span><span class="text-mid-purple ms-1">No results found for your query.</span></span></p></div></div></div></div></div></div></div>`;
  app.innerHTML = `<div class="my-3">${live.length ? resultPanels(live, false) : none}</div>`;
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
    await Promise.all([loadTree(), loadMyLessons(), loadSlides()]);
    watchImages();   // v0.45: lazy images fade in
    renderSubjectBar();
    renderUserContext();
    renderUserMenu();
    renderBrowse();
    bindSearchModal();
    bindSubjectScroll();
    Auth.renderUser();
    const picker = document.getElementById('classage');
    // "Show lessons suitable for": the user's saved filter (Users fid 569), written back as on live (v0.30).
    const me = Auth.me() || {};
    try { localStorage.removeItem('imoves.classAge'); } catch (e) {}   // pre-v0.30 browser-side copy
    try { picker.value = me.filter_age_min != null ? String(me.filter_age_min) : ''; } catch (e) { picker.value = ''; }
    picker.addEventListener('change', () => { saveClassAge(picker.value); route(); });
    route();
  } catch (e) {
    app.innerHTML = `<div class="notice">Could not load content: ${esc(e.message)}</div>`;
  }
}
(async () => {
  document.getElementById('stamp').textContent = LOADED_AT;
  // The footer date is the latest nightly content refresh when the log exists (041).
  rest('content_refreshes?select=at&order=at.desc&limit=1').then(r => { if (r && r[0]) document.getElementById('stamp').textContent = new Date(r[0].at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }).catch(() => {});
  if (await Auth.init()) await startApp();
})();
