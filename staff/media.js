// imoves CMS - media library v0.1.1 (increment 3, 5 Nov 2026)
//
// One library of files (content.assets): videos on Cloudflare Stream, audio, images, documents
// and slide decks in R2. Staff upload once and use anywhere; replacing a file updates every
// place that uses it at once (files are not versioned, by design). Uploads go straight from the
// browser to Stream / R2 through URLs minted by the cms-media edge function; the browser does
// the processing itself - card-size images and PDF decks rendered to slide images - so there is
// no job queue to wait for. Loaded before cms.js; uses its helpers at call time.

const MEDIA_KINDS = [['video', 'Video', '🎬', 'Videos'], ['audio', 'Audio', '🎵', 'Audio'], ['image', 'Image', '🖼️', 'Images'], ['document', 'Document', '📄', 'Documents'], ['slides', 'Slides', '🖥️', 'Slide decks']];
const kindLabel = k => (MEDIA_KINDS.find(x => x[0] === k) || [k, k, ''])[1];
const kindIcon = k => (MEDIA_KINDS.find(x => x[0] === k) || [k, k, '📁'])[2];
const PART_KIND = { Video: 'video', Audio: 'audio', Slides: 'slides', Image: 'image', Download: 'document' };
const ACCEPT = { video: 'video/*,.mp4,.mov,.m4v,.webm', audio: 'audio/*,.mp3,.m4a,.wav', image: 'image/*', document: '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip,.jpg,.jpeg,.png,.mp3', slides: '.pdf,application/pdf' };
const fmtBytes = b => b == null ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
const fmtSecs = s => s == null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const assetMeta = a => [a.filename, fmtBytes(a.bytes), a.duration != null ? fmtSecs(a.duration) : '', a.pages ? `${a.pages} ${a.kind === 'slides' ? 'slides' : 'pages'}` : '', a.width ? `${a.width}×${a.height}` : ''].filter(Boolean).join(' · ');
// The picture that stands for an asset in a list.
function assetThumb(a, cls = 'thumb') {
  if (!a) return `<span class="${cls} ph"></span>`;
  const src = a.kind === 'image' ? a.url : a.kind === 'video' ? a.thumbnail_url : a.kind === 'slides' && a.url && a.state === 'ready' ? `${a.url}/1.png` : null;
  return src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy">` : `<span class="${cls} ph">${kindIcon(a.kind)}</span>`;
}
const assetState = a => a.state === 'ready' ? '' : `<span class="pill ${a.state === 'failed' ? 'danger' : 'pending'}" title="${esc(a.error || '')}">${a.state === 'failed' ? 'needs attention' : a.state}</span>`;

// ---------- asset lookup (cached) ----------
D.assets = {};
async function loadAssets(ids) {
  const want = [...new Set(ids.filter(id => id != null && !D.assets[id]))];
  for (let i = 0; i < want.length; i += 150) {
    const rows = await get(`assets?select=id,kind,title,state,url,thumbnail_url,filename,bytes,duration,pages,width,height,stream_uid,error&id=in.(${want.slice(i, i + 150).join(',')})`);
    for (const r of rows) D.assets[r.id] = r;
  }
  return D.assets;
}
const asset = id => (id != null && D.assets[id]) || null;
// Row picture: the asset when set, else the pre-library address.
const rowImage = (row, key = 'image_asset_id', legacy = 'image') => { const a = asset(row[key]); return a ? a.url : row[legacy] || null; };

// ---------- the edge function ----------
async function mediaFn(action, args) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/cms-media`, { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${Auth.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((j && j.error) || `Upload service: ${r.status}`);
  return j;
}
// PUT with progress (fetch has none for uploads).
function putFile(url, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('PUT', url);
    x.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
    x.setRequestHeader('Cache-Control', 'public, max-age=31536000');
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => x.status < 300 ? resolve() : reject(new Error(`Storage refused the file (${x.status})`));
    x.onerror = () => reject(new Error('Could not reach storage (is the bucket’s CORS set for this site?)'));
    x.send(blob);
  });
}
const safeName = n => (n || 'file').normalize('NFKD').replace(/[^\w.\- ()]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
const titleFrom = n => (n || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

// ---------- browser-side processing ----------
let pdfjsP = null;
function pdfjs() {
  return pdfjsP ||= import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.min.mjs'; return m; });
}
const loadImage = blob => new Promise((res, rej) => { const u = URL.createObjectURL(blob); const i = new Image(); i.onload = () => { URL.revokeObjectURL(u); res(i); }; i.onerror = () => rej(new Error('Not an image the browser can read')); i.src = u; });
const toBlob = (canvas, type, q) => new Promise(res => canvas.toBlob(res, type, q));
// Card-size copy: what the cards, thumbnails and lesson page load. PNGs stay PNG (logos with transparency).
async function cardImage(file) {
  const img = await loadImage(file);
  const MAX = 1200; const scale = Math.min(1, MAX / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
  const png = file.type === 'image/png' || /\.png$/i.test(file.name);
  return { blob: await toBlob(c, png ? 'image/png' : 'image/jpeg', 0.86), ext: png ? 'png' : 'jpg', width: img.naturalWidth, height: img.naturalHeight };
}
const audioDuration = file => new Promise(res => { const u = URL.createObjectURL(file); const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => { URL.revokeObjectURL(u); res(isFinite(a.duration) ? a.duration : null); }; a.onerror = () => res(null); a.src = u; });
async function pdfPages(file) { try { const m = await pdfjs(); const doc = await m.getDocument({ data: await file.arrayBuffer() }).promise; return doc.numPages; } catch (e) { return null; } }
// One PNG per page at the width the player uses (1920, as the Google Slides capture did).
async function* renderDeck(file) {
  const m = await pdfjs(); const doc = await m.getDocument({ data: await file.arrayBuffer() }).promise;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n); const v0 = page.getViewport({ scale: 1 }); const scale = 1920 / v0.width; const v = page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    yield { n, total: doc.numPages, blob: await toBlob(c, 'image/png'), width: c.width, height: c.height };
  }
}

// ---------- upload ----------
// Creates (or replaces, when assetId is given) an asset from a File. Reports progress through
// onStatus(text, fraction). Returns the asset row. State is left 'failed' with the reason when
// something goes wrong, so the library shows what needs attention.
async function uploadAsset(file, kind, { assetId = null, title = null, onStatus = () => {} } = {}) {
  let a;
  const base = { filename: safeName(file.name), content_type: file.type || null, bytes: file.size, error: null };
  if (assetId) a = await patch('assets', assetId, { ...base, state: 'uploading' });
  else a = await insert('assets', { kind, title: title || titleFrom(file.name) || 'Untitled', state: 'uploading', ...base });
  const fail = async e => { await patch('assets', a.id, { state: 'failed', error: e.message }).catch(() => {}); throw e; };
  try {
    if (kind === 'video') {
      onStatus('Asking Stream for an upload slot…', 0);
      const { upload_url, uid } = await mediaFn('stream_upload', { title: a.title });
      const fd = new FormData(); fd.append('file', file, file.name);
      await new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open('POST', upload_url); x.upload.onprogress = e => { if (e.lengthComputable) onStatus('Uploading to Stream…', e.loaded / e.total); }; x.onload = () => x.status < 300 ? resolve() : reject(new Error(`Stream refused the file (${x.status})`)); x.onerror = () => reject(new Error('Could not reach Stream')); x.send(fd); });
      if (a.stream_uid && a.stream_uid !== uid) mediaFn('stream_delete', { uid: a.stream_uid }).catch(() => {});
      a = await patch('assets', a.id, { stream_uid: uid, wistia_id: null, state: 'processing', url: null, thumbnail_url: `https://${STREAM_DOMAIN}/${uid}/thumbnails/thumbnail.jpg?time=2s` });
      onStatus('Stream is processing the video…', 1);
      for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, i < 10 ? 2000 : 5000));
        const s = await mediaFn('stream_status', { uid });
        if (s.error) throw new Error(`Stream could not process the video: ${s.error}`);
        if (s.ready) { a = await patch('assets', a.id, { state: 'ready', duration: s.duration, width: s.width, height: s.height, bytes: s.bytes || a.bytes, thumbnail_url: s.thumbnail || a.thumbnail_url }); return a; }
        onStatus(`Stream is processing the video… ${s.pct ? Math.round(s.pct) + '%' : ''}`, 1);
      }
      throw new Error('Stream is still processing; check the library later');
    }
    if (kind === 'slides') {
      onStatus('Reading the PDF…', 0);
      const srcKey = `slides/${a.id}/source.pdf`;
      const put = await mediaFn('put', { key: srcKey });
      await putFile(put.url, file, 'application/pdf', f => onStatus('Uploading the PDF…', f * 0.2));
      let pages = 0, width = 0, height = 0;
      for await (const pg of renderDeck(file)) {
        onStatus(`Rendering slide ${pg.n} of ${pg.total}…`, 0.2 + 0.8 * pg.n / pg.total);
        const p = await mediaFn('put', { key: `slides/${a.id}/${pg.n}.png` });
        await putFile(p.url, pg.blob, 'image/png');
        pages = pg.n; width = pg.width; height = pg.height;
      }
      if (!pages) throw new Error('The PDF has no pages');
      if (a.pages && a.pages > pages) await mediaFn('delete', { keys: Array.from({ length: a.pages - pages }, (_, i) => `slides/${a.id}/${pages + 1 + i}.png`) }).catch(() => {});
      const baseUrl = put.public_url.replace(/\/source\.pdf$/, '');
      a = await patch('assets', a.id, { state: 'ready', key: srcKey, url: baseUrl, pages, width, height, google_slide_id: null, thumbnail_url: null });
      return a;
    }
    if (kind === 'image') {
      onStatus('Preparing sizes…', 0);
      const card = await cardImage(file);
      const name = safeName(file.name);
      const o = await mediaFn('put', { key: `image/${a.id}/${name}` });
      await putFile(o.url, file, file.type, f => onStatus('Uploading…', f * 0.6));
      const c = await mediaFn('put', { key: `image/${a.id}/card.${card.ext}` });
      await putFile(c.url, card.blob, card.ext === 'png' ? 'image/png' : 'image/jpeg', f => onStatus('Uploading…', 0.6 + f * 0.4));
      // a new address each time (the file name carries the asset id, the card gets a version query) so caches do not keep the old picture
      a = await patch('assets', a.id, { state: 'ready', key: `image/${a.id}/${name}`, url: `${c.public_url}?v=${Date.now().toString(36)}`, original_url: o.public_url, width: card.width, height: card.height, source_url: null });
      return a;
    }
    // audio, document
    const name = safeName(file.name); const key = `${kind}/${a.id}/${name}`;
    const extra = {};
    if (kind === 'audio') extra.duration = await audioDuration(file);
    if (kind === 'document' && /pdf$/i.test(name)) extra.pages = await pdfPages(file);
    const p = await mediaFn('put', { key });
    await putFile(p.url, file, file.type, f => onStatus('Uploading…', f));
    if (a.key && a.key !== key) mediaFn('delete', { keys: [a.key] }).catch(() => {});
    a = await patch('assets', a.id, { state: 'ready', key, url: p.public_url, source_url: null, ...extra });
    return a;
  } catch (e) { await fail(e); }
  finally { if (a) D.assets[a.id] = a; }
}
// A small progress modal around uploadAsset.
function uploadWithProgress(file, kind, opts = {}) {
  const m = modal(`<div class="box narrow"><div class="mhead"><h2>${esc(opts.assetId ? 'Replacing' : 'Uploading')} ${esc(file.name)}</h2></div><div class="mbody" style="padding:16px 18px"><div class="progress"><div class="bar" id="upBar"></div></div><div class="muted small" id="upStatus" style="margin-top:8px">Starting…</div></div><div class="mfoot"></div></div>`);
  m.onclick = null;
  return uploadAsset(file, kind, { ...opts, onStatus: (t, f) => { const s = m.querySelector('#upStatus'), b = m.querySelector('#upBar'); if (s) s.textContent = t; if (b) b.style.width = `${Math.round((f || 0) * 100)}%`; } })
    .then(a => { closeModal(); toast(opts.assetId ? 'File replaced everywhere it is used' : 'Added to the library'); return a; })
    .catch(e => { closeModal(); toast(e.message, true); throw e; });
}
function chooseFile(kind, multiple = false) {
  return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = ACCEPT[kind] || ''; i.multiple = multiple; i.onchange = () => res([...i.files]); i.click(); });
}

// ---------- picker: from the library, or upload ----------
// onPick(asset). Shows recent assets of that kind, searchable; an Upload button adds one and picks it.
function pickAsset(kind, onPick, { title } = {}) {
  const m = modal(`<div class="box"><div class="mhead"><h2>${esc(title || `Choose ${kindLabel(kind).toLowerCase()}`)}</h2>${canEdit() ? `<button class="btn primary sm" id="pickUpload">${ICON.plus} Upload a file</button>` : ''}<button class="btn quiet sm" data-close>Close</button></div><div class="mtools"><input id="pickq" type="search" placeholder="Search the library by title or file name"></div><div class="mbody" id="pickres"><div class="empty">Loading…</div></div><div class="mfoot"><span class="muted small">Files in the library can be used in any number of places; replacing the file updates them all.</span></div></div>`);
  m.querySelector('[data-close]').addEventListener('click', closeModal);
  const show = rows => {
    m.querySelector('#pickres').innerHTML = rows.length ? rows.map(a => `<button class="pick" data-id="${a.id}">${assetThumb(a, 'pthumb')}<div class="meta"><b>${esc(a.title)}</b><span>${esc(assetMeta(a))}${a.uses ? ` · used ${a.uses}×` : ''} ${assetState(a)}</span></div></button>`).join('') : '<div class="empty">Nothing in the library yet. Upload a file.</div>';
    m.querySelectorAll('.pick').forEach(b => b.addEventListener('click', () => { const a = rows.find(x => x.id === +b.dataset.id); D.assets[a.id] = a; closeModal(); onPick(a); }));
  };
  const run = debounce(async () => {
    const qi = m.querySelector('#pickq'); if (!qi) return; const q = qi.value.trim().replace(/[%,()]/g, ' ');
    const filter = q ? `&or=(title.ilike.*${encodeURIComponent(q)}*,filename.ilike.*${encodeURIComponent(q)}*)` : '';
    try { show(await get(`library?select=*&kind=eq.${kind}&archived=eq.false${filter}&order=${q ? 'title' : 'created_at.desc'}&limit=60`)); } catch (e) { toast(e.message, true); }
  }, 200);
  m.querySelector('#pickq').addEventListener('input', run); run();
  const up = m.querySelector('#pickUpload');
  if (up) up.addEventListener('click', async () => { const [f] = await chooseFile(kind); if (!f) return; closeModal(); try { onPick(await uploadWithProgress(f, kind)); } catch (e) {} });
  setTimeout(() => { const f = m.querySelector('#pickq'); if (f) f.focus(); }, 50);
}

// A field showing the asset an item uses, with Choose / Replace / Remove. onChange(asset|null).
// fallback: what teachers see when nothing is chosen ({ url, note }).
function assetChip(a, { kind, fallback = null, onChange, note = '', compact = false } = {}) {
  const id = `ac${Math.random().toString(36).slice(2, 8)}`;
  const shown = a || (fallback && fallback.url ? { kind: 'image', url: fallback.url, title: fallback.note, state: 'ready', _fb: true } : null);
  const html = `<div class="achip ${compact ? 'compact' : ''} ${shown && shown._fb ? 'fb' : ''}" id="${id}">${kind === 'image' || (a && a.kind === 'image') || shown ? assetThumb(shown, 'athumb') : `<span class="athumb ph">${kindIcon(kind)}</span>`}
    <div class="ameta">${a ? `<b><a href="#/media/${a.id}" title="Open in the library">${esc(a.title)}</a></b><span>${esc(assetMeta(a))} ${assetState(a)}</span>` : shown ? `<b class="muted">${esc(fallback.note)}</b><span>Choose a picture to show this one instead.</span>` : `<b class="muted">No ${kindLabel(kind).toLowerCase()} yet</b><span>${esc(note)}</span>`}</div>
    ${canEdit() ? `<div class="abtns"><button class="btn sm" data-pick>${a ? 'Change' : 'Choose'}</button>${a ? `<button class="btn sm" data-replace title="Upload a new file in its place; every lesson using it updates">Replace file</button><button class="btn icon danger" data-remove title="Use nothing here (the file stays in the library)">${ICON.bin}</button>` : ''}</div>` : ''}</div>`;
  const bind = root => {
    const box = root.querySelector(`#${id}`); if (!box) return;
    const pk = box.querySelector('[data-pick]'); if (pk) pk.addEventListener('click', () => pickAsset(kind, onChange));
    const rp = box.querySelector('[data-replace]'); if (rp) rp.addEventListener('click', async () => { const [f] = await chooseFile(a.kind); if (!f) return; if (!confirm(`Replace the file behind "${a.title}"? Every place that uses it changes at once.`)) return; try { onChange(await uploadWithProgress(f, a.kind, { assetId: a.id })); } catch (e) {} });
    const rm = box.querySelector('[data-remove]'); if (rm) rm.addEventListener('click', () => onChange(null));
  };
  return { html, bind };
}

// ---------- pages ----------
async function pageMedia() {
  const nav = ticket();
  PAGE = { type: null, dirty: {}, reload: pageMedia };
  const pref = PREF.get('media') || {};
  const kind = pref.kind || 'all', sort = pref.sort || 'recent', q = pref.q || '', only = pref.only || 'all';
  const filter = (kind !== 'all' ? `&kind=eq.${kind}` : '') + (q ? `&or=(title.ilike.*${encodeURIComponent(q.replace(/[%,()]/g, ' '))}*,filename.ilike.*${encodeURIComponent(q.replace(/[%,()]/g, ' '))}*)` : '') + (only === 'unused' ? '&uses=eq.0' : only === 'attention' ? '&state=neq.ready' : '') + (only === 'archived' ? '&archived=eq.true' : '&archived=eq.false');
  const order = { recent: 'created_at.desc', name: 'title', used: 'uses.desc,title', size: 'bytes.desc.nullslast' }[sort] || 'created_at.desc';
  const [rows, summary] = await Promise.all([get(`library?select=*${filter}&order=${order}&limit=${pref.more ? 2000 : 300}`), get('library_summary?select=*&archived=eq.false')]);
  if (stale(nav)) return;
  const tally = {}; let attention = 0, unused = 0, total = 0; for (const c of summary) { tally[c.kind] = (tally[c.kind] || 0) + c.n; total += c.n; if (c.state !== 'ready') attention += c.n; if (!c.used) unused += c.n; }
  const counts = { length: total };
  const chip = (v, label, n) => `<button type="button" class="chip ${kind === v ? 'on' : ''}" data-kind="${v}">${label}${n != null ? ` <small>${n}</small>` : ''}</button>`;
  editor.innerHTML = `<div class="crumbs"><span>Media library</span></div><div class="edhead"><h1>Media library</h1><span class="meta">${counts.length} files</span><div class="actions">${canEdit() ? `<div class="menu" id="upMenu"><button class="btn primary" data-addbtn>${ICON.plus} Upload</button><div class="items">${MEDIA_KINDS.map(k => `<button data-up="${k[0]}">${k[2]} ${k[1]}${k[0] === 'slides' ? ' (PDF)' : ''}</button>`).join('')}</div></div>` : ''}</div></div>` +
    panel('', `<div class="mediatools"><div class="chips">${chip('all', 'All', counts.length)}${MEDIA_KINDS.map(k => chip(k[0], k[3], tally[k[0]] || 0)).join('')}</div>
      <div class="mediatools2"><input type="search" id="mq" placeholder="Search by title or file name" value="${esc(q)}"><select id="mOnly"><option value="all" ${only === 'all' ? 'selected' : ''}>Everything</option><option value="attention" ${only === 'attention' ? 'selected' : ''}>Needs attention (${attention})</option><option value="unused" ${only === 'unused' ? 'selected' : ''}>Not used anywhere (${unused})</option><option value="archived" ${only === 'archived' ? 'selected' : ''}>Archived</option></select><select id="mSort"><option value="recent" ${sort === 'recent' ? 'selected' : ''}>Newest first</option><option value="name" ${sort === 'name' ? 'selected' : ''}>A to Z</option><option value="used" ${sort === 'used' ? 'selected' : ''}>Most used</option><option value="size" ${sort === 'size' ? 'selected' : ''}>Largest</option></select></div></div>
      <div class="rows media">${rows.map(a => `<div class="row" data-go="#/media/${a.id}">${assetThumb(a)}<span class="kind ${a.kind}">${kindLabel(a.kind)}</span><div class="title"><div class="name">${esc(a.title)} ${assetState(a)}</div><div class="sub">${esc(assetMeta(a))}${a.created_by && a.created_by !== 'migration' ? ` · ${esc(a.created_by)}` : ''}</div></div><span class="uses ${a.uses ? '' : 'none'}" title="Places that use this file">${a.uses ? `used ${a.uses}×` : 'unused'}</span></div>`).join('') || '<div class="empty">Nothing matches.</div>'}</div>${rows.length >= 300 && !pref.more ? `<div class="inline-add"><button class="btn" id="mMore">Show more</button><span class="muted small">Showing the first 300. Narrow the search, or show up to 2,000.</span></div>` : ''}`);
  const setPref = p => { PREF.set('media', { ...(PREF.get('media') || {}), more: false, ...p }); pageMedia(); };
  editor.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => setPref({ kind: b.dataset.kind })));
  $('#mq').addEventListener('input', debounce(e => setPref({ q: e.target.value.trim() }), 300));
  $('#mOnly').addEventListener('change', e => setPref({ only: e.target.value })); $('#mSort').addEventListener('change', e => setPref({ sort: e.target.value }));
  const more = $('#mMore'); if (more) more.addEventListener('click', () => { PREF.set('media', { ...(PREF.get('media') || {}), more: true }); pageMedia(); });
  editor.querySelectorAll('.row[data-go]').forEach(r => r.addEventListener('click', () => location.hash = r.dataset.go));
  const menu = $('#upMenu');
  if (menu) {
    menu.querySelector('[data-addbtn]').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', async () => {
      const files = await chooseFile(b.dataset.up, true); if (!files.length) return;
      for (const f of files) { try { await uploadWithProgress(f, b.dataset.up); } catch (e) { break; } }
      pageMedia();
    }));
  }
  const mq = $('#mq'); if (q) { mq.focus(); mq.setSelectionRange(q.length, q.length); }
}

async function pageAsset(id) {
  const nav = ticket();
  const [[a], uses] = await Promise.all([get(`library?id=eq.${id}&select=*`), rpc('asset_uses', { p_asset_id: id })]);
  if (stale(nav)) return; if (!a) return notFound();
  D.assets[a.id] = a;
  PAGE = { type: 'asset', id, row: a, dirty: {}, reload: () => pageAsset(id) };
  const preview = a.state !== 'ready' ? `<div class="empty">${a.state === 'failed' ? `Needs attention: ${esc(a.error || 'the file is missing')}` : 'Still ' + a.state + '…'}</div>`
    : a.kind === 'image' ? `<img class="big" src="${esc(a.url)}" alt="">`
    : a.kind === 'video' ? `<div class="vwrap"><iframe src="https://${STREAM_DOMAIN}/${esc(a.stream_uid)}/iframe?preload=metadata" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
    : a.kind === 'audio' ? `<audio controls src="${esc(a.url)}" style="width:100%"></audio>`
    : a.kind === 'slides' ? `<div class="deck">${Array.from({ length: Math.min(a.pages || 0, 12) }, (_, i) => `<img src="${esc(a.url)}/${i + 1}.png" alt="Slide ${i + 1}" loading="lazy">`).join('')}${a.pages > 12 ? `<div class="muted small">… and ${a.pages - 12} more</div>` : ''}</div>`
    : `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">Open the file</a>`;
  const byItem = {}; for (const u of uses) (byItem[`${u.item_type}:${u.item_id}`] ||= { ...u, fields: [] }).fields.push(u.field);
  editor.innerHTML = `<div class="crumbs"><button data-go="#/media">Media library</button><span class="sep">›</span><span>${esc(kindLabel(a.kind))}</span></div>
    <div class="edhead"><h1><span id="pageTitle">${esc(a.title)}</span><span class="id">${esc(kindLabel(a.kind))} ${a.id}</span></h1><span class="meta">${a.created_by === 'migration' ? 'from the old platform' : `uploaded by ${esc(a.created_by)}`} · ${when(a.created_at)}</span>
      <div class="actions">${canEdit() ? `<button class="btn" id="saveBtn" disabled>Save</button><button class="btn" id="replaceBtn" title="Upload a new file in its place; every place that uses it updates">Replace file</button>${a.kind !== 'video' && a.state === 'ready' ? `<a class="btn" href="${esc(a.kind === 'slides' ? a.url + '/source.pdf' : a.original_url || a.url)}" target="_blank" rel="noopener">Download</a>` : ''}<button class="btn danger" id="deleteBtn" ${uses.length ? 'disabled title="Still in use: remove it from those places first"' : ''}>Delete</button>` : ''}</div></div>` +
    panel('Preview', `<div class="apreview">${preview}</div>`) +
    panel('Details', `<div class="grid">${field('title', 'Title', { help: 'How it is listed in the library. File names are kept as uploaded.' })}<div class="field"><label>File</label><div class="static">${esc(assetMeta(a) || '—')}${a.content_type ? `<div class="muted small">${esc(a.content_type)}</div>` : ''}</div></div>
      ${a.kind === 'video' ? `<div class="field"><label>Stream</label><div class="static mono">${esc(a.stream_uid || '')}${a.wistia_id ? `<div class="muted small">was Wistia ${esc(a.wistia_id)}</div>` : ''}</div></div>` : ''}
      ${a.source_url ? `<div class="field span"><label>Served from (not yet copied to the new storage)</label><div class="static mono small"><a href="${esc(a.source_url)}" target="_blank" rel="noopener">${esc(a.source_url)}</a></div></div>` : ''}
      ${a.google_slide_id && a.state !== 'ready' ? `<div class="field span"><label>Google Slides</label><div class="static small">This deck was never captured from Google Slides. Export it as a PDF and use Replace file.</div></div>` : ''}
      <div class="field span">${field('tags_text', 'Tags (comma-separated)', { help: '"site" marks logos and page backgrounds.' })}</div></div>`) +
    panel(`Where it is used <span class="muted">${Object.keys(byItem).length}</span>`, `<div class="place">${Object.values(byItem).map(u => `<div class="item" data-go="${href(u.item_type, u.item_id)}"><span class="kind ${u.item_type}">${KIND[u.item_type]}</span><div class="path"><b>${esc(u.name)}</b><span>${esc(u.fields.join(', '))}</span></div></div>`).join('') || '<div class="empty">Not used anywhere. It can be deleted.</div>'}</div>`);
  PAGE.row.tags_text = (a.tags || []).join(', ');
  PAGE.onChange = k => { if (k === 'tags_text') { delete PAGE.dirty.tags_text; PAGE.dirty.tags = (PAGE.row.tags_text || '').split(',').map(s => s.trim()).filter(Boolean); } };
  bindFields(editor);
  editor.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => location.hash = b.dataset.go));
  const sb = $('#saveBtn'); if (sb) sb.addEventListener('click', async () => { try { const row = await patch('assets', id, PAGE.dirty); Object.assign(PAGE.row, row); PAGE.dirty = {}; sb.disabled = true; $('#pageTitle').textContent = row.title; D.assets[id] = row; toast('Saved'); } catch (e) { toast(e.message, true); } });
  const rb = $('#replaceBtn'); if (rb) rb.addEventListener('click', async () => { const [f] = await chooseFile(a.kind); if (!f) return; if (uses.length && !confirm(`Replace the file behind "${a.title}"? ${uses.length} place${uses.length > 1 ? 's' : ''} will show the new file at once.`)) return; try { await uploadWithProgress(f, a.kind, { assetId: a.id }); pageAsset(id); } catch (e) {} });
  const db = $('#deleteBtn'); if (db) db.addEventListener('click', async () => {
    if (!confirm(`Delete "${a.title}" from the library and from storage? This cannot be undone.`)) return;
    try {
      if (a.kind === 'video' && a.stream_uid) await mediaFn('stream_delete', { uid: a.stream_uid });
      else if (a.kind === 'slides' && a.key) await mediaFn('delete_prefix', { prefix: `slides/${a.id}/` });
      else if (a.key) await mediaFn('delete', { keys: [a.key, ...(a.kind === 'image' ? [`image/${a.id}/card.jpg`, `image/${a.id}/card.png`] : [])] });
      await rpc('delete_asset', { p_id: id }); delete D.assets[id]; toast('Deleted'); location.hash = '#/media';
    } catch (e) { toast(e.message, true); }
  });
}
