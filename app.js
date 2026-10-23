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
    rest('lessons?select=id,name,is_live,scheme_id,order,description,is_freemium,age_min,age_max,duration,has_video,has_audio,has_downloads,has_slides&order=order', { all: true }),
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
function lessonIcon(l) { return l.has_video ? 'bi-play-btn-fill' : l.has_audio ? 'bi-music-note-beamed' : l.has_slides ? 'bi-easel' : l.has_downloads ? 'bi-file-earmark-arrow-down' : 'bi-circle'; }
function wistia(id) { return `<div class="videobox"><iframe src="https://fast.wistia.net/embed/iframe/${esc(id)}?videoFoam=true" allow="autoplay; fullscreen" allowfullscreen title="Video"></iframe></div>`; }
function setBg(url) { document.body.style.backgroundImage = url ? `url('${url.replace(/ /g, '%20')}')` : ''; }

// ---------- routing ----------
const app = document.getElementById('app');
function reveal() { app.classList.remove('reveal'); void app.offsetWidth; app.classList.add('reveal'); }
window.addEventListener('hashchange', route);
async function route() {
  const hash = location.hash.slice(1) || '/';
  const [pathPart, query = ''] = hash.split('?');
  const qs = Object.fromEntries(new URLSearchParams(query));
  const p = pathPart.split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (p[0] || 'home')));
  document.querySelectorAll('.sbtn').forEach(a => a.classList.toggle('active', p[0] === 'subject' && a.dataset.id === p[1]));
  window.scrollTo(0, 0);
  try {
    if (!p.length) return pageHome();
    if (p[0] === 'subject' && p[2] === 'subcategory') return pageSubcategory(+p[1], +p[3]);
    if (p[0] === 'subject') return pageSubject(+p[1]);
    if (p[0] === 'lesson') return pageLesson(+p[1], qs.sc ? +qs.sc : null);
    if (p[0] === 'search') return pageSearch(qs.q || '');
    if (p[0] === 'browse') return pageBrowse();
    app.innerHTML = `<div class="notice">Page not found.</div>`;
  } catch (e) { app.innerHTML = `<div class="notice">Something went wrong: ${esc(e.message)}</div>`; }
}

// ---------- pages ----------
function renderSubjectBar() {
  const subjects = D.subjects.filter(s => s.is_homepage_button).sort(byOrder);
  document.getElementById('subjectbar').innerHTML = subjects.map(s =>
    `<a class="sbtn" data-id="${s.id}" href="#/subject/${s.id}" style="background:#${esc(s.button_colour || '733088')}"><i class="${esc(cleanIcon(s.icon) || 'bi-flag')}"></i>${esc(s.name)}</a>`).join('');
}
function cleanIcon(i) { if (!i) return ''; const m = i.match(/class="([^"]+)"/); return (m ? m[1] : i).trim(); }

function pageHome() {
  setBg(null);
  const subjects = D.subjects.filter(s => s.is_carouselable).sort((a, b) => (a.homepage_order ?? 999) - (b.homepage_order ?? 999));
  let html = '';
  for (const s of subjects) {
    const feats = [1, 2, 3, 4].map(i => ({ sc: D.subcatById[s[`featured_subcategory_id_${i}`]], heading: s[`featured_heading_${i}`], sub: s[`featured_subheading_${i}`] })).filter(f => f.sc);
    if (!feats.length) continue;
    html += `<section class="block"><div class="bh"><a href="#/subject/${s.id}">${esc(s.name)}</a><a class="right" href="#/subject/${s.id}">View all &rarr;</a></div><div class="bb"><div class="grid">`;
    for (const f of feats) {
      html += `<div class="tile"><img src="${esc(img(f.sc.image))}" alt="" loading="lazy"><div class="tb"><h4>${esc(limit(f.heading || f.sc.name, 30))}</h4><p>${esc(limit(f.sub || f.sc.subheading, 200))}</p></div><a class="cover" href="${subcatHref(f.sc)}" aria-label="${esc(f.sc.name)}"></a></div>`;
    }
    html += `</div></div></section>`;
  }
  app.innerHTML = html || '<div class="notice">Nothing to show on the home page yet.</div>';
  reveal();
}

function pageSubject(id) {
  const s = D.subjectById[id];
  if (!s) { app.innerHTML = '<div class="notice">Subject not found.</div>'; return; }
  setBg(s.background_image_url);
  const video = s.is_featuring_video && (s.featured_video_wistia_id_paid_ks2 || s.featured_video_wistia_id_free);
  const vHead = s.featured_video_heading_paid_ks2 || s.featured_video_heading_free, vSub = s.featured_video_subheading_paid_ks2 || s.featured_video_subheading_free;
  let html = `<div class="subject-head ${video ? 'with-video' : ''}"><div><h1>${esc(s.name)}</h1><p class="light">${nl(s.description)}</p></div>`;
  if (video) html += `<div><h4 style="color:var(--purple)">${esc(vHead || 'Featured')} <span class="muted light">${esc(vSub || '')}</span></h4>${wistia(video)}</div>`;
  html += `</div>`;
  const subgroups = (D.subgroupsBySubject[id] || []).sort(byOrder);
  let any = false;
  for (const sg of subgroups) {
    const subcats = visibleSubcats(sg);
    if (!subcats.length) continue; any = true;
    html += `<section class="block collapsible"><div class="bh">${esc(sg.name)}${sg.description ? `<small>${esc(sg.description)}</small>` : ''}<button class="collapse-btn right" data-toggle aria-expanded="true" aria-label="Show or hide ${esc(sg.name)}"><i class="bi-chevron-up"></i></button></div><div class="bb"><div class="bbi"><div class="grid">`;
    for (const sc of subcats) {
      const lessons = subcatLessons(sc), ages = ageRange(lessons);
      const vid = sc.is_direct_resource && (sc.direct_resource_wistia_duration_paid || sc.direct_resource_wistia_duration_all);
      html += `<div class="tile"><img src="${esc(img(sc.image))}" alt="" loading="lazy"><div class="tb"><h4>${esc(limit(sc.name, 25))}</h4>${sc.subheading ? `<p>${esc(limit(sc.subheading, 130))}</p>` : ''}</div><div class="tf">` +
        (ages ? ageStripRange(ages) : '') +
        (lessons.length ? `<span><i class="bi-collection-play"></i>${lessons.length} ${esc(noun(sc, lessons.length))}</span>` : '') +
        (vid ? `<span><i class="bi-film"></i>${esc(vid)} video</span>` : '') +
        (subcatIsFree(sc) ? `<span class="badge">Free</span>` : '') +
        `</div><a class="cover" href="${subcatHref(sc)}" aria-label="${esc(sc.name)}"></a></div>`;
    }
    html += `</div></div></div></section>`;
  }
  if (!any) html += '<div class="notice">This subject has no live content at the moment.</div>';
  app.innerHTML = html;
  reveal();
  app.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => { const closed = b.closest('.block').classList.toggle('closed'); b.setAttribute('aria-expanded', !closed); }));
}

function crumbs(parts) {
  return `<div class="breadcrumb">` + parts.map((p, i) => (i ? '<i class="bi-chevron-right"></i>' : '') + (p.href ? `<a href="${p.href}">${esc(p.name)}</a>` : `<span class="cur">${esc(p.name)}</span>`)).join('') + `</div>`;
}

function pageSubcategory(subjectId, id) {
  const sc = D.subcatById[id];
  if (!sc) { app.innerHTML = '<div class="notice">Section not found.</div>'; return; }
  if (sc.is_redirect_to_category && sc.subcategory_redirect_id) { location.replace(subcatHref(D.subcatById[sc.subcategory_redirect_id] || sc)); return; }
  if (sc.is_redirect_to_lesson && sc.lesson_redirect_id) { location.replace(`#/lesson/${sc.lesson_redirect_id}?sc=${sc.id}`); return; }
  const subject = D.subjectById[sc.subject_id] || D.subjectById[subjectId], sg = D.subgroupById[sc.subgroup_id];
  setBg(sc.background_image_url || subject?.background_image_url);
  let html = crumbs([subject && { name: subject.name, href: `#/subject/${subject.id}` }, sg && { name: sg.name, href: `#/subject/${subject?.id}` }, { name: sc.name }].filter(Boolean));
  if (sc.is_redirect_to_url && sc.url_redirect) {
    // Many "link to a URL" sections point back into the platform itself: follow those internally.
    const m = sc.url_redirect.match(/platform\.imoves\.com\/subjects\/(\d+)(?:\/subcategories\/(\d+))?/);
    if (m && m[2] && D.subcatById[+m[2]]) { location.replace(subcatHref(D.subcatById[+m[2]])); return; }
    if (m && !m[2] && D.subjectById[+m[1]]) { location.replace(`#/subject/${m[1]}`); return; }
    if (/platform\.imoves\.com\/subscribe/.test(sc.url_redirect)) {
      html += `<div class="notice">This section opens the subscription options page, which is not part of this prototype.</div>`;
    } else {
      const host = sc.url_redirect.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      const isFile = /\.(pdf|jpg|jpeg|png)(\?|$)/i.test(sc.url_redirect);
      html += `<section class="scheme"><div class="sh">${esc(sc.name)}</div><div class="intro" style="flex-direction:column"><div class="txt">${sc.description ? `<p>${nl(sc.description)}</p>` : ''}<p><a class="btn" href="${esc(sc.url_redirect)}" target="_blank" rel="noopener"><i class="${isFile ? 'bi-file-earmark-arrow-down' : 'bi-box-arrow-up-right'}"></i> ${isFile ? 'Open the file' : 'Open ' + esc(host)}</a></p><p class="muted" style="font-size:.9rem">Opens in a new tab.</p></div></div></section>`;
    }
    app.innerHTML = html; reveal(); return;
  }
  if (sc.is_direct_resource) {
    const vid = sc.direct_resource_wistia_id_paid || sc.direct_resource_wistia_id_all;
    html += `<section class="scheme"><div class="sh">${esc(sc.direct_resource_heading_paid || sc.direct_resource_heading_all || sc.name)}</div><div class="intro" style="flex-direction:column">` +
      (vid ? wistia(vid) : '') + `<div class="txt"><p>${nl(sc.direct_resource_text_paid || sc.direct_resource_text_all || sc.description)}</p>` +
      (sc.is_direct_resource_linked && sc.direct_resource_link_url ? `<a class="btn" href="${esc(sc.direct_resource_link_url)}" target="_blank" rel="noopener">${esc(sc.direct_resource_link_text || 'Open')}</a>` : '') + `</div></div></section>`;
  }
  const schemes = D.schemesBySubcat[id] || [];
  // Same-named schemes in one category are age variants of one resource (a Quickbase workaround
  // for the user age filter): present them as one card with an age switch.
  const groups = []; const byName = {};
  for (const s of schemes) {
    const key = (s.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (key && byName[key]) byName[key].push(s); else { const g = [s]; if (key) byName[key] = g; groups.push(g); }
  }
  for (const g of groups) {
    const variants = g.map(s => ({ s, lessons: schemeLessons(s), ages: ageRange(schemeLessons(s)) }))
      .sort((a, b) => (parseInt(a.ages) || 99) - (parseInt(b.ages) || 99));
    const first = variants[0].s;
    const allLessons = variants.flatMap(v => v.lessons);
    const anyFree = variants.some(v => v.s.is_freemium);
    const merged = variants.length > 1;
    // which variant opens: the one covering "my class", else the first
    let sel = variants.findIndex(v => coversClass(v.ages)); if (sel < 0) sel = 0;
    // switch labels: age range, falling back to subheading or a number when ranges repeat
    const labels = variants.map((v, i) => v.ages ? `Ages ${v.ages}` : (v.s.subheading || `Version ${i + 1}`));
    labels.forEach((l, i) => { if (labels.indexOf(l) !== i) labels[i] = `${l} (${i + 1})`; });
    const single = allLessons.length === variants.length;
    html += `<section class="scheme ${single ? 'single' : ''} ${merged ? 'merged' : ''}" id="scheme-${first.id}" data-scheme-ages="${merged ? '' : (variants[0].ages || '')}"><div class="sh">${esc(first.name)}${!merged && first.subheading ? `<small>${esc(first.subheading)}</small>` : ''}${anyFree ? '<span class="badge">Free</span>' : ''}<span class="right">${merged ? ageStripRange(ageRange(allLessons), 'lg') : `${ageStripRange(variants[0].ages, 'lg')}${single ? '' : `<span class="rt">${allLessons.length} ${esc(noun(sc, allLessons.length))}</span>`}`}</span></div>`;
    const ageSwitch = merged ? `<div class="agerow"><span class="agesw" role="tablist" aria-label="Age version">${labels.map((l, i) => `<button type="button" role="tab" aria-selected="${i === sel}" data-variant="${i}">${esc(l)}</button>`).join('')}</span></div>` : '';
    variants.forEach((v, i) => {
      const s2 = v.s, lessons = v.lessons, one = lessons.length === 1, l0 = lessons[0];
      html += `<div class="variant" data-scheme-ages="${v.ages || ''}" ${i === sel ? '' : 'hidden'}>`;
      html += `<div class="intro"><img src="${esc(img(s2.image))}" alt="" loading="lazy"><div class="txt">${merged && s2.subheading ? `<p class="muted" style="margin-top:0">${esc(s2.subheading)}</p>` : ''}${schemeBody(s2)}</div></div>${ageSwitch}`;
      if (one) {
        html += `<div class="lmini">${lessonMeta(l0, false)}<a class="btn small outline" href="${lessonHref(l0, sc)}"><i class="bi-arrows-fullscreen"></i> Open full screen</a></div>`;
        html += `<div class="lbc" data-lesson-body="${l0.id}" data-scheme-text="${esc((s2.body_opening_text || s2.description || '').trim().slice(0, 80))}"></div>`;
      } else {
        html += `<div class="lessons">` + lessons.map(l => `<div class="lx" data-lesson="${l.id}"><button class="lrow" type="button" aria-expanded="false"><i class="res ${lessonIcon(l)}"></i><div class="lt"><h4>${esc(l.name)}${l.is_freemium ? ' <span class="badge">Free</span>' : ''}</h4>${l.description ? `<span>${esc(l.description)}</span>` : ''}</div><div class="meta">${lessonAges(l) !== v.ages ? ageStripRange(lessonAges(l)) : ''}${l.duration ? `<span title="Around ${l.duration} minutes"><i class="bi-clock"></i>${l.duration}m</span>` : ''}</div></button><div class="lb"><div class="lbi"><div class="lbc" data-lesson-body="${l.id}"></div></div></div></div>`).join('') + `</div>`;
      }
      html += `</div>`;
    });
    html += `</section>`;
  }
  if (!schemes.length && !sc.is_direct_resource) html += '<div class="notice">This section has no live schemes at the moment.</div>';
  app.innerHTML = html;
  reveal();
  // single-lesson schemes: fetch every lesson and part for the page in two requests, then fill the cards
  const singles = [...app.querySelectorAll('.variant > [data-lesson-body]')];
  if (singles.length) {
    const ids = singles.map(el => el.dataset.lessonBody).join(',');
    Promise.all([
      rest(`lessons?id=in.(${ids})&select=*`),
      rest(`lesson_parts?lesson_id=in.(${ids})&is_live=eq.true&is_archived=eq.false&order=lesson_id,order,index&select=*`),
    ]).then(([ls, ps]) => {
      const lById = index(ls), pByLesson = group(ps, 'lesson_id');
      singles.forEach(el => renderLessonBody(el, lById[+el.dataset.lessonBody], pByLesson[+el.dataset.lessonBody] || [], sc, true));
    }).catch(e => singles.forEach(el => { el.innerHTML = `<div class="notice">Could not load parts: ${esc(e.message)}</div>`; }));
  }
  // age switch on merged cards
  app.querySelectorAll('.agesw button').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.scheme'); const i = +b.dataset.variant;
    card.querySelectorAll('.agesw button').forEach(x => x.setAttribute('aria-selected', +x.dataset.variant === i));
    card.querySelectorAll('.variant').forEach((v, j) => { v.hidden = j !== i; });
  }));
  // multi-lesson schemes: open one lesson at a time, loading its parts on first open
  app.querySelectorAll('.lx > .lrow').forEach(btn => btn.addEventListener('click', async () => {
    const lx = btn.parentElement, wasOpen = lx.classList.contains('open');
    lx.closest('.lessons').querySelectorAll('.lx.open').forEach(o => { o.classList.remove('open'); o.querySelector('.lrow').setAttribute('aria-expanded', 'false'); });
    if (wasOpen) return;
    lx.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    const body = lx.querySelector('[data-lesson-body]');
    if (!body.dataset.loaded) { body.innerHTML = '<div class="loading" style="padding:1.5rem">Loading parts…</div>'; await fillLessonBody(body, +body.dataset.lessonBody, sc, false); }
    setTimeout(() => btn.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
  }));
}

function lessonMeta(l, withAges = true) {
  return [withAges ? ageStripRange(lessonAges(l), 'lg') : '', l.duration ? `<span><i class="bi-clock"></i>${l.duration} min</span>` : '', l.intensity ? `<span><i class="bi-lightning-charge"></i>${esc(l.intensity)}</span>` : '', l.location && l.location.length ? `<span><i class="bi-geo-alt"></i>${esc(l.location.join(', '))}</span>` : ''].filter(Boolean).join('');
}

// Fill a lesson drawer on the category page: the lesson's own text, then its parts.
async function fillLessonBody(el, lessonId, sc, single) {
  const [rows, parts] = await Promise.all([
    rest(`lessons?id=eq.${lessonId}&select=*`),
    rest(`lesson_parts?lesson_id=eq.${lessonId}&is_live=eq.true&is_archived=eq.false&order=order,index&select=*`),
  ]);
  renderLessonBody(el, rows[0], parts, sc, single);
}
function renderLessonBody(el, l, parts, sc, single) {
  if (!l) { el.innerHTML = '<div class="notice">Lesson not found.</div>'; return; }
  let h = '';
  const holder = el.closest('.variant') || el.closest('.scheme'); const schemeAges = holder ? holder.dataset.schemeAges : '';
  if (!single) h += `<div class="lmeta">${lessonMeta(l, lessonAges(l) !== schemeAges)}<a class="btn small outline" href="${lessonHref(l, sc)}"><i class="bi-arrows-fullscreen"></i> Open full screen</a></div>`;
  const holderTxt = holder && holder.querySelector('.intro .txt');
  const shownAbove = single ? [holderTxt ? holderTxt.textContent : ''] : [l.description];
  let body = schemeBody(l, shownAbove);
  const sub = l.heading_2 && !single && !(l.body_opening_text || '').trim().startsWith(l.heading_2.trim()) && !(l.description || '').trim().startsWith(l.heading_2.trim());
  if (body && single) { const txt = (el.closest('.variant') || el.closest('.scheme')).querySelector('.intro .txt'); if (txt) txt.insertAdjacentHTML('beforeend', `<div class="ltext" style="margin:.25rem 0 0">${body}</div>`); }
  else if (body) h += `<div class="ltext">${sub ? `<h4>${esc(l.heading_2)}</h4>` : ''}${body}</div>`;
  h += `<div class="parts">${renderParts(parts, !single)}</div>`;
  el.innerHTML = h; el.dataset.loaded = '1';
  el.querySelectorAll('.part button.ph').forEach(ph => ph.addEventListener('click', () => { const open = ph.parentElement.classList.toggle('open'); ph.setAttribute('aria-expanded', open); }));
}

// Text comparison that ignores case, punctuation and spacing - used to spot repeated copy.
const norm = t => String(t || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// Assemble a scheme's or lesson's text, dropping any paragraph that repeats one already shown
// (staff often paste the same sentence into two fields). `already` holds text shown above it.
function schemeBody(s, already = []) {
  const seen = already.map(norm).filter(Boolean);
  const fresh = t => { const k = norm(t); if (!k) return false; if (seen.some(x => x === k || (k.length > 20 && x.includes(k)))) return false; seen.push(k); return true; };
  // a field may hold several paragraphs; keep only the ones not already shown
  const para = t => String(t || '').split(/\n\s*\n/).map(x => x.trim()).filter(fresh).map(nl).join('<br><br>');
  const p = t => { const x = para(t); return x ? `<p>${x}</p>` : ''; };
  let h = '';
  h += p(s.description);
  h += p(s.body_opening_text);
  for (const i of [1, 2, 3]) if (s[`body_subheading_${i}`]) { const x = para(s[`body_subheading_${i}_text`]); if (x) h += `<h4>${esc(s[`body_subheading_${i}`])}</h4><p>${x}</p>`; }
  h += p(s.body_closing_text);
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
  const scheme = D.schemeById[l.scheme_id];
  const sc = D.subcatById[scId] || (scheme && D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]]);
  const subject = sc && D.subjectById[sc.subject_id], sg = sc && D.subgroupById[sc.subgroup_id];
  setBg(l.background_image_url || sc?.background_image_url || subject?.background_image_url);
  const seq = scheme ? schemeLessons(scheme) : [l];
  const pos = seq.findIndex(x => x.id === l.id), prev = seq[pos - 1], next = seq[pos + 1];
  let html = crumbs([subject && { name: subject.name, href: `#/subject/${subject.id}` }, sg && { name: sg.name, href: `#/subject/${subject?.id}` }, sc && { name: sc.name, href: subcatHref(sc) }, scheme && { name: scheme.name }].filter(Boolean));
  html += `<div class="lesson-layout"><div>`;
  html += `<section class="scheme"><div class="sh">${esc(l.name)}${l.heading_2 ? `<small>${esc(l.heading_2)}</small>` : ''}<span class="right">${ageStripRange(lessonAges(l), 'lg')}</span></div>`;
  html += `<div class="intro"><img src="${esc(img(scheme?.image))}" alt="" loading="lazy"><div class="txt">${schemeBody(l, [l.heading_2])}</div></div>`;
  html += `<div class="parts">${renderParts(parts)}</div>`;
  if (seq.length > 1) {
    const label = sc ? noun(sc, 1) : 'lesson';
    html += `<div class="prevnext"><a class="btn outline ${prev ? '' : 'disabled'}" href="${prev ? lessonHref(prev, sc) : '#'}"><i class="bi-skip-backward-circle"></i> Previous ${esc(label)}</a><a class="btn ${next ? '' : 'outline disabled'}" href="${next ? lessonHref(next, sc) : '#'}">Next ${esc(label)} <i class="bi-skip-forward-circle-fill"></i></a></div>`;
  }
  html += `</section></div>`;
  const rows2 = [['bi-lightning-charge', l.intensity], ['bi-bullseye', l.focus], ['bi-clock', l.duration_text], ['bi-geo-alt', (l.location || []).join(', ')], ['bi-stopwatch', l.preparation_text ? `Prep: ${l.preparation_text}` : null]].filter(r => r[1]);
  html += `<aside class="expect"><div class="row head">What to expect…</div>` + rows2.map(r => `<div class="row"><i class="${r[0]}"></i>${esc(r[1])}</div>`).join('') + `</aside></div>`;
  app.innerHTML = html;
  reveal();
  app.querySelectorAll('.part button.ph').forEach(h => h.addEventListener('click', () => { const open = h.parentElement.classList.toggle('open'); h.setAttribute('aria-expanded', open); if (open) h.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }));
}

function partIcon(p) { return { Video: 'bi-play-btn-fill', Audio: 'bi-music-note-beamed', Slides: 'bi-easel-fill', Download: 'bi-file-earmark-arrow-down-fill', Image: 'bi-file-image-fill' }[p.media_type] || 'bi-card-text'; }
function renderPart(p, open) {
  const info = p.additional_info ? `<p>${nl(p.additional_info)}</p>` : '';
  if (p.media_type === 'Download') {
    // A download is an action, not a drawer: the whole row opens the file.
    return `<div class="part"><a class="ph dl" href="${esc(p.s3_url)}" target="_blank" rel="noopener"><i class="pi ${partIcon(p)}"></i><h4>${esc(p.heading || 'Download')}</h4><span class="dlpill"><i class="bi-download"></i> Download</span></a>${info ? `<div class="pc" style="display:block;grid-template-rows:1fr;opacity:1;padding:0 1rem .8rem 4rem"><div class="pci">${info}</div></div>` : ''}</div>`;
  }
  let body = '';
  switch (p.media_type) {
    case 'Video': body = (p.wistia_id ? wistia(p.wistia_id) : '<div class="notice">No video id on this part.</div>') + info; break;
    case 'Audio': body = `<audio controls controlsList="nodownload" preload="none" src="${esc(p.s3_url)}"></audio>` + info; break;
    case 'Slides': body = `<div class="slides"><iframe src="https://docs.google.com/presentation/d/e/${esc(p.google_slide_id)}/embed?start=false&loop=false&delayms=60000" allowfullscreen title="Slides"></iframe></div>` + info; break;
    case 'Image': body = `<img class="pimg" src="${esc(p.s3_url)}" alt="${esc(p.heading)}">` + info; break;
    default: body = info || '<p class="muted">No content.</p>';
  }
  return `<div class="part ${open ? 'open' : ''}"><button class="ph" type="button" aria-expanded="${open}"><i class="pi ${partIcon(p)}"></i><h4>${esc(p.heading || p.media_type)}</h4>${p.duration ? `<span class="pm"><i class="bi-stopwatch"></i> ${esc(p.duration)}</span>` : ''}<span class="chev" aria-hidden="true"></span></button><div class="pc"><div class="pci">${body}</div></div></div>`;
}
function renderParts(parts, autoOpen = true) {
  if (!parts.length) return '<div class="notice">This lesson has no live parts at the moment.</div>';
  // open the first part that expands (a download opens straight away, so skip those)
  const firstOpen = autoOpen ? parts.findIndex(p => p.media_type !== 'Download') : -1;
  return `<div class="plist">` + parts.map((p, i) => renderPart(p, i === firstOpen)).join('') + `</div>`;
}

async function pageSearch(q) {
  setBg(null);
  app.innerHTML = `<form class="searchbar" id="sf"><input id="q" type="search" placeholder="Search lessons, e.g. yoga, times tables, dance" value="${esc(q)}" autofocus><button class="btn" type="submit"><i class="bi-search"></i> Search</button></form><div id="results"></div>`;
  document.getElementById('sf').addEventListener('submit', e => { e.preventDefault(); location.hash = `#/search?q=${encodeURIComponent(document.getElementById('q').value.trim())}`; });
  const out = document.getElementById('results');
  if (!q.trim()) { out.innerHTML = '<div class="notice">Type a word or phrase and press Search.</div>'; return; }
  out.innerHTML = '<div class="loading">Searching…</div>';
  const term = q.trim().replace(/[%,.()]/g, ' ').replace(/\s+/g, ' ');
  const rows = await rest(`lessons?is_live=eq.true&search=ilike.*${encodeURIComponent(term)}*&select=id,name,description,scheme_id,age_min,age_max,duration,is_freemium,has_video,has_audio,has_downloads,has_slides&order=order&limit=300`);
  const live = rows.filter(l => D.lessonById[l.id]);
  if (!live.length) { out.innerHTML = `<div class="notice">No lessons match "${esc(q)}".</div>`; return; }
  const bySubject = {};
  for (const l of live) {
    const scheme = D.schemeById[l.scheme_id]; const sc = scheme && D.subcatById[(D.subcatsByScheme[scheme.id] || [])[0]];
    const subj = sc ? D.subjectById[sc.subject_id] : null;
    (bySubject[subj ? subj.id : 0] ||= { subject: subj, items: [] }).items.push({ l, scheme, sc });
  }
  let html = `<p class="muted">${live.length} ${live.length === 1 ? 'lesson' : 'lessons'} match "${esc(q)}".</p>`;
  for (const g of Object.values(bySubject)) {
    html += `<section class="block"><div class="bh">${esc(g.subject ? g.subject.name : 'Other')}</div><div class="bb"><div class="lessons" style="padding:0 0 1rem">` +
      g.items.map(({ l, scheme, sc }) => `<div class="lrow"><i class="res ${lessonIcon(l)}"></i><div class="lt"><h4>${esc(l.name)}${l.is_freemium ? ' <span class="badge">Free</span>' : ''}</h4><span>${esc(scheme ? scheme.name : '')}${sc ? ' · ' + esc(sc.name) : ''}${l.description ? ' · ' + esc(l.description) : ''}</span></div><div class="meta">${ageStripRange(lessonAges(l))}${l.duration ? `<span><i class="bi-clock"></i>${l.duration}m</span>` : ''}</div><a class="cover" href="${lessonHref(l, sc)}"></a></div>`).join('') + `</div></div></section>`;
  }
  out.innerHTML = html;
  reveal();
}

function pageBrowse() {
  setBg(null);
  const subjects = D.subjects.filter(s => s.is_browsable).sort((a, b) => (a.browse_order ?? 999) - (b.browse_order ?? 999));
  let html = '<div class="browse">';
  for (const s of subjects) {
    const sgs = (D.subgroupsBySubject[s.id] || []).sort(byOrder).map(sg => ({ sg, subcats: visibleSubcats(sg) })).filter(x => x.subcats.length);
    if (!sgs.length) continue;
    html += `<section class="block"><div class="bh"><a href="#/subject/${s.id}">${esc(s.name)}</a></div><div class="bb"><ul>` + sgs.map(({ sg, subcats }) => `<li class="sg">${esc(sg.name)}</li>` + subcats.map(sc => `<li><a href="${subcatHref(sc)}">${esc(sc.name)}</a></li>`).join('')).join('') + `</ul></div></section>`;
  }
  app.innerHTML = html + '</div>';
  reveal();
}

// ---------- boot ----------
// Auth first (Phase 1): no content without signing in, as on the live platform.
// Auth.init() restores a saved session; otherwise auth.js shows the sign-in screen
// and calls startApp() itself after a successful sign-in.
async function startApp() {
  try {
    app.innerHTML = '<div class="loading">Loading the library…</div>';
    await loadTree();
    renderSubjectBar();
    const picker = document.getElementById('classage');
    // "My class": the stored choice, or the age range saved on the account (users.ages)
    let saved = null; try { saved = localStorage.getItem('imoves.classAge'); } catch (e) {}
    if (saved === null) { const a = (Auth.me()?.ages || [])[0]; if (a) saved = String(parseInt(a)); }
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
