'use strict';
// TubeSwipe in the browser: card stack with swiping, sources, history and duplicate files.

const $ = (sel) => document.querySelector(sel);
const deck = $('#deck');

let t = I18N.translator('en');
let locale = 'en';

let queue = []; // videos in order, queue[0] is the top card
let total = 0;
let undoStack = [];
let loading = false;
let busy = false; // while a card flies out

// ---------------------------------------------------------------- Helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // login redirect or error page of a reverse proxy
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function presetLabel(id) {
  return t('preset.' + id);
}

function fmtDuration(s) {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fmtAgo(ts) {
  if (!ts) return t('ago.never');
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return t('ago.now');
  if (min < 60) return t('ago.min', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('ago.hours', { n: h });
  const d = Math.round(h / 24);
  return d === 1 ? t('ago.yesterday') : t('ago.days', { n: d });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function thumb(id, small) {
  const img = el('img', { alt: '', loading: small ? 'lazy' : 'eager', src: `https://i.ytimg.com/vi/${id}/${small ? 'mqdefault' : 'maxresdefault'}.jpg` });
  if (!small) {
    // Without an HD image, YouTube returns a 120 px wide placeholder.
    const fallback = () => {
      if (!img.src.includes('hqdefault')) img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    };
    img.addEventListener('error', fallback);
    img.addEventListener('load', () => img.naturalWidth <= 120 && fallback());
  }
  return img;
}

let toastTimer = null;
function toast(text, withUndo) {
  $('#toast-text').textContent = text;
  $('#toast-undo').hidden = !withUndo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 4000);
}

// Texts in index.html carry their message key in data-i18n attributes.
function translatePage() {
  document.documentElement.lang = locale;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-html]')) node.innerHTML = t(node.dataset.i18nHtml);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  $('#hint').textContent = t('hint', { alt: presetLabel('audio-mp3') });
  $('#add-initial').replaceChildren(
    ...[0, 5, 10, 25, -1].map((n) =>
      el('option', { value: n, selected: n === 10 }, n === 0 ? t('sources.initial.none') : n < 0 ? t('sources.initial.all') : t('sources.initial.n', { n })),
    ),
  );
}

// ---------------------------------------------------------------- Stack

async function loadQueue() {
  if (loading) return;
  loading = true;
  try {
    const data = await api('/api/queue?limit=12');
    total = data.total;
    const known = new Set(queue.map((v) => v.id));
    for (const v of data.items) if (!known.has(v.id)) queue.push(v);
    render();
  } catch (e) {
    toast(t('toast.loadFailed', { error: e.message }));
  } finally {
    loading = false;
  }
}

function updateCount() {
  $('#count').textContent = total > 0 ? total : '';
  document.title = total > 0 ? `(${total}) TubeSwipe` : 'TubeSwipe';
}

function render() {
  updateCount();
  deck.replaceChildren();
  const [top, next] = queue;
  $('#empty').hidden = !!top;
  for (const b of ['#btn-no', '#btn-yes', '#btn-alt']) $(b).disabled = !top;
  $('#btn-undo').disabled = undoStack.length === 0;
  if (!top) {
    showEmptyInfo();
    return;
  }
  $('#btn-alt').textContent = top.altType === 'audio' ? '♪' : '▶';
  $('#btn-alt').title = t('btn.altTitle', { label: presetLabel(top.altPreset) });
  $('#btn-yes').title = t('btn.yesTitle', { label: presetLabel(top.yesPreset) });
  $('#hint').textContent = t('hint', { alt: presetLabel(top.altPreset) });
  if (next) deck.append(card(next, true));
  deck.append(card(top, false));
  // Load the image of the card after next already
  if (queue[2]) new Image().src = `https://i.ytimg.com/vi/${queue[2].id}/maxresdefault.jpg`;
}

async function showEmptyInfo() {
  try {
    const s = await api('/api/status');
    if (!s.sources) $('#empty-info').textContent = t('stack.noSources');
    else if (s.polling) $('#empty-info').textContent = t('stack.checking');
    else $('#empty-info').textContent = s.nextPoll ? t('stack.nextCheck', { time: fmtTime(s.nextPoll), min: s.pollMinutes }) : '';
  } catch {
    $('#empty-info').textContent = '';
  }
}

function card(v, behind) {
  const stampYes = el('div', { class: 'stamp yes' }, t('stamp.yes'));
  const stampNo = el('div', { class: 'stamp no' }, t('stamp.no'));
  const stampAlt = el('div', { class: 'stamp alt' }, v.altType === 'audio' ? t('stamp.audio') : t('stamp.video'));
  const thumbBox = el('div', { class: 'thumb' }, thumb(v.id), v.duration ? el('span', { class: 'duration' }, fmtDuration(v.duration)) : null);
  const source = v.source || t('sources.removed');
  const node = el(
    'div',
    { class: 'card' + (behind ? ' behind' : '') },
    stampYes,
    stampNo,
    stampAlt,
    thumbBox,
    el(
      'div',
      { class: 'info' },
      el('h2', {}, v.title),
      el('div', { class: 'meta' }, [v.channel, v.channel && v.channel === source ? null : source].filter(Boolean).join(' · ')),
      el('div', { class: 'meta' }, t('card.found', { ago: fmtAgo(v.foundAt), label: presetLabel(v.yesPreset) })),
      el('a', { href: `https://www.youtube.com/watch?v=${v.id}`, target: '_blank', rel: 'noopener' }, t('card.open')),
    ),
  );
  if (behind) return node;

  const play = el('button', { class: 'play', 'aria-label': t('card.preview'), onclick: () => preview(thumbBox, v.id) }, '▶');
  thumbBox.append(play);
  node.thumbBox = thumbBox;
  node.video = v;
  drag(node, { yes: stampYes, no: stampNo, alt: stampAlt });
  return node;
}

function preview(box, id) {
  if (box.querySelector('iframe')) {
    box.querySelector('iframe').remove();
    return;
  }
  box.append(
    el('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`,
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: true,
    }),
  );
}

function drag(node, stamps) {
  let start = null;
  let dx = 0;
  let dy = 0;

  node.addEventListener('pointerdown', (e) => {
    if (busy || e.button !== 0 || e.target.closest('a, button, iframe')) return;
    start = { x: e.clientX, y: e.clientY };
    try {
      node.setPointerCapture(e.pointerId);
    } catch {
      // the browser does not know synthetic pointers (tests)
    }
    node.classList.remove('animate');
  });
  node.addEventListener('pointermove', (e) => {
    if (!start) return;
    dx = e.clientX - start.x;
    dy = e.clientY - start.y;
    node.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    const up = -dy > Math.abs(dx);
    stamps.yes.style.opacity = !up && dx > 0 ? Math.min(1, dx / 100) : 0;
    stamps.no.style.opacity = !up && dx < 0 ? Math.min(1, -dx / 100) : 0;
    stamps.alt.style.opacity = up ? Math.min(1, -dy / 100) : 0;
  });
  const end = () => {
    if (!start) return;
    start = null;
    const w = Math.min(120, deck.clientWidth / 4);
    if (-dy > w && -dy > Math.abs(dx)) decide('alt');
    else if (dx > w) decide('yes');
    else if (dx < -w) decide('no');
    else {
      node.classList.add('animate');
      node.style.transform = '';
      for (const s of Object.values(stamps)) s.style.opacity = 0;
    }
    dx = dy = 0;
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

async function decide(decision) {
  const v = queue[0];
  if (!v || busy) return;
  busy = true;
  const node = deck.lastElementChild;
  node.classList.add('animate');
  const out = { yes: 'translate(140%, 0) rotate(25deg)', no: 'translate(-140%, 0) rotate(-25deg)', alt: 'translate(0, -140%)' };
  node.style.transform = out[decision];
  node.style.opacity = 0;
  await new Promise((r) => setTimeout(r, 220));

  queue.shift();
  total = Math.max(0, total - 1);
  undoStack.push(v);
  if (undoStack.length > 30) undoStack.shift();
  busy = false;
  render();

  try {
    const r = await api('/api/decide', { method: 'POST', body: { id: v.id, decision } });
    if (decision === 'no') toast(t('toast.dismissed'), true);
    else toast(t('toast.queued', { label: presetLabel(decision === 'alt' ? v.altPreset : v.yesPreset), s: r.sendInSeconds }), true);
  } catch (e) {
    toast(t('toast.error', { error: e.message }));
    undoStack.pop();
    queue.unshift(v);
    total++;
    render();
  }
  if (queue.length < 4) loadQueue();
}

async function undo() {
  const v = undoStack.pop();
  if (!v) return;
  try {
    const r = await api('/api/undo', { method: 'POST', body: { id: v.id } });
    queue = [v, ...queue.filter((q) => q.id !== v.id)];
    total++;
    render();
    toast(r.alreadySent ? t('toast.backSent') : t('toast.back'));
  } catch (e) {
    undoStack.push(v);
    toast(t('toast.error', { error: e.message }));
  }
}

$('#btn-yes').onclick = () => decide('yes');
$('#btn-no').onclick = () => decide('no');
$('#btn-alt').onclick = () => decide('alt');
$('#btn-undo').onclick = undo;
$('#toast-undo').onclick = () => {
  $('#toast').hidden = true;
  undo();
};
$('#check-all').onclick = async () => {
  await api('/api/check', { method: 'POST', body: {} });
  $('#empty-info').textContent = t('stack.checking');
};

document.addEventListener('keydown', (e) => {
  if (!$('#tab-stack').classList.contains('active') || e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const actions = {
    ArrowRight: () => decide('yes'),
    ArrowLeft: () => decide('no'),
    ArrowUp: () => decide('alt'),
    KeyZ: undo,
    Backspace: undo,
    Space: () => deck.lastElementChild && deck.lastElementChild.thumbBox && preview(deck.lastElementChild.thumbBox, queue[0].id),
  };
  if (actions[e.code]) {
    e.preventDefault();
    actions[e.code]();
  }
});

// ---------------------------------------------------------------- Sources

let presets = [];

async function loadSources() {
  const data = await api('/api/sources');
  presets = data.presets;
  const addPreset = $('#add-preset');
  if (!addPreset.options.length) addPreset.append(...presets.map((id) => el('option', { value: id }, presetLabel(id))));

  const list = $('#source-list');
  list.replaceChildren(
    ...data.sources.map((s) => {
      const select = el(
        'select',
        { 'aria-label': t('sources.preset'), onchange: () => api(`/api/sources/${s.id}`, { method: 'PATCH', body: { preset: select.value } }) },
        ...presets.map((id) => el('option', { value: id, selected: id === s.preset }, presetLabel(id))),
      );
      const checkBtn = el('button', {}, s.checking ? t('sources.checkingNow') : t('sources.check'));
      checkBtn.disabled = s.checking;
      checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = t('sources.checkingNow');
        try {
          const r = await api(`/api/sources/${s.id}`, { method: 'POST', body: {} });
          toast(r.added ? t.n('sources.newVideos', r.added) : t('sources.nothingNew'));
          loadQueue();
        } catch (e) {
          toast(t('toast.error', { error: e.message }));
        }
        loadSources();
      };
      const pauseBtn = el('button', {}, s.paused ? t('sources.resume') : t('sources.pause'));
      pauseBtn.onclick = async () => {
        await api(`/api/sources/${s.id}`, { method: 'PATCH', body: { paused: !s.paused } });
        loadSources();
      };
      const delBtn = el('button', { class: 'danger' }, t('sources.remove'));
      delBtn.onclick = async () => {
        if (!confirm(t('sources.confirmRemove', { title: s.title }))) return;
        await api(`/api/sources/${s.id}`, { method: 'DELETE', body: {} });
        queue = [];
        loadQueue();
        loadSources();
      };
      const status = s.lastError ? el('span', { class: 'err' }, t('sources.error', { error: s.lastError })) : t('sources.checked', { ago: fmtAgo(s.lastCheck) });
      const kind = s.kind === 'playlist' ? t('sources.kind.playlist') : t('sources.kind.channel');
      return el(
        'li',
        {},
        el(
          'div',
          { class: 'grow' },
          el('div', { class: 'title' }, el('a', { href: s.url, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' }, s.title), s.paused ? t('sources.paused') : ''),
          el('div', { class: 'meta' }, t('sources.counts', { kind, pending: s.counts.pending, yes: s.counts.yes, no: s.counts.no }), status),
        ),
        el('div', { class: 'actions' }, select, checkBtn, pauseBtn, delBtn),
      );
    }),
  );
}

$('#add-url').addEventListener('input', (e) => {
  // Playlists usually serve as an inbox: then suggest everything.
  if (/[?&]list=/.test(e.target.value)) $('#add-initial').value = '-1';
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#add-btn');
  btn.disabled = true;
  $('#add-msg').className = 'muted';
  $('#add-msg').textContent = t('sources.reading');
  try {
    const r = await api('/api/sources', {
      method: 'POST',
      body: { url: $('#add-url').value, initial: Number($('#add-initial').value), preset: $('#add-preset').value },
    });
    $('#add-msg').className = 'ok';
    $('#add-msg').textContent = t('sources.added', { title: r.source.title, n: r.added });
    $('#add-url').value = '';
    loadSources();
    loadQueue();
  } catch (err) {
    $('#add-msg').className = 'err';
    $('#add-msg').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- History

async function loadHistory() {
  const { items } = await api('/api/history?limit=150');
  const list = $('#history-list');
  if (!items.length) {
    list.replaceChildren(el('li', { class: 'muted' }, t('history.empty')));
    return;
  }
  list.replaceChildren(
    ...items.map((v) => {
      const label = v.preset ? presetLabel(v.preset) : '';
      let status;
      if (v.status === 'no') status = el('span', { class: 'muted' }, t('history.dismissed'));
      else if (v.sentAt) status = el('span', { class: 'ok' }, t('history.sent', { label }));
      else if (v.failed) status = el('span', { class: 'err' }, t('history.failed', { error: v.error }));
      else if (v.error) status = el('span', { class: 'err' }, t('history.retrying', { error: v.error }));
      else status = el('span', { class: 'muted' }, t('history.waiting', { label }));

      const back = el('button', {}, t('history.back'));
      back.onclick = async () => {
        const r = await api('/api/undo', { method: 'POST', body: { id: v.id } });
        toast(r.alreadySent ? t('history.backSent') : t('toast.back'));
        queue = [];
        loadQueue();
        loadHistory();
      };
      const actions = [back];
      if (v.failed) {
        const retry = el('button', {}, t('history.retry'));
        retry.onclick = async () => {
          await api('/api/retry', { method: 'POST', body: { id: v.id } });
          setTimeout(loadHistory, 1500);
        };
        actions.unshift(retry);
      }
      return el(
        'li',
        {},
        thumb(v.id, true),
        el(
          'div',
          { class: 'grow' },
          el('div', { class: 'title' }, el('a', { href: `https://www.youtube.com/watch?v=${v.id}`, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' }, v.title)),
          el('div', { class: 'meta' }, `${v.channel || v.source || t('sources.removed')} · ${fmtAgo(v.decidedAt)} · `, status),
        ),
        el('div', { class: 'actions' }, actions),
      );
    }),
  );
}

// ---------------------------------------------------------------- Duplicates

let dupTimer = null;

function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toLocaleString(locale, { maximumFractionDigits: 1 }) + ' GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' kB';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function updateDupCount(n) {
  $('#dup-count').textContent = n > 0 ? n : '';
}

async function loadDuplicates() {
  const d = await api('/api/duplicates');
  const groups = d.groups || [];
  updateDupCount(groups.length);
  clearTimeout(dupTimer);
  // While a scan runs, look again every 2 s.
  if (d.scanning) dupTimer = setTimeout(() => loadDuplicates().catch(() => {}), 2000);

  $('#dup-scan').disabled = !!d.scanning;
  let info;
  if (d.scanning) info = t('dup.scanning');
  else if (!d.scannedAt) info = t('dup.never', { h: d.dupHours });
  else {
    info = t('dup.scanned', { ago: fmtAgo(d.scannedAt), files: d.files, roots: (d.roots || []).join(', ') || t('dup.noRoots'), withId: d.withId });
    if (d.crossKind) info += t('dup.crossKind', { n: d.crossKind });
    if (d.nextScan) info += d.nextScan - Date.now() < 86400000 ? t('dup.nextAt', { time: fmtTime(d.nextScan) }) : t('dup.nextOn', { date: fmtDate(d.nextScan) });
  }
  $('#dup-info').replaceChildren(info);
  if (d.error) $('#dup-info').append(el('span', { class: 'err' }, t('dup.lastFailed', { error: d.error })));
  if (d.unreadableCount) {
    const list = d.unreadable.join(', ') + (d.unreadableCount > d.unreadable.length ? ' …' : '');
    $('#dup-info').append(el('span', { class: 'err' }, t('dup.unreadable', { n: d.unreadableCount, list })));
  }

  const trash = d.trash || { files: 0, bytes: 0 };
  $('#dup-trash').textContent = trash.files ? t('dup.trash', { files: trash.files, size: fmtSize(trash.bytes) }) : t('dup.trashEmpty');
  $('#dup-empty').disabled = !trash.files || !!d.scanning;

  const list = $('#dup-list');
  if (!groups.length) {
    list.replaceChildren(el('li', { class: 'muted' }, d.scannedAt ? t('dup.none') : t('dup.nothingYet')));
    return;
  }
  list.replaceChildren(
    ...groups.map((g) =>
      el(
        'li',
        {},
        thumb(g.id, true),
        el(
          'div',
          { class: 'grow' },
          el(
            'div',
            { class: 'title' },
            el('a', { href: `https://www.youtube.com/watch?v=${g.id}`, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' }, g.title),
          ),
          el('div', { class: 'meta muted' }, t('dup.group', { kind: g.kind === 'audio' ? t('kind.audio') : t('kind.video'), n: g.files.length, id: g.id })),
        ),
        el(
          'div',
          { class: 'dup-files' },
          ...g.files.map((f, i) => {
            const age = i === 0 ? t('dup.oldest') : i === g.files.length - 1 ? t('dup.newest') : '';
            const extra = f.sidecars ? ' · ' + t.n('dup.sidecars', f.sidecars) : '';
            return el(
              'div',
              { class: 'dup-file' },
              el(
                'div',
                { class: 'grow' },
                el('div', { class: 'path' }, `${f.root}/${f.rel}`),
                el('div', { class: 'meta muted' }, `${fmtSize(f.size)} · ${fmtDate(f.mtime)}${age ? ' · ' + age : ''}${extra}`),
              ),
              el('button', { class: 'danger', onclick: (e) => trashFile(f, e.currentTarget) }, t('dup.toTrash')),
            );
          }),
        ),
      ),
    ),
  );
}

async function trashFile(f, btn) {
  const filePath = `${f.root}/${f.rel}`;
  const question = f.sidecars ? t('dup.confirmTrashWith', { path: filePath, sidecars: t.n('dup.sidecars', f.sidecars) }) : t('dup.confirmTrash', { path: filePath });
  if (!confirm(question)) return;
  btn.disabled = true;
  try {
    const r = await api('/api/duplicates/delete', { method: 'POST', body: { root: f.root, rel: f.rel } });
    toast(t.n('dup.moved', r.moved));
  } catch (e) {
    toast(e.message);
  }
  loadDuplicates().catch((e) => toast(t('toast.loadFailed', { error: e.message })));
}

$('#dup-scan').onclick = async () => {
  try {
    await api('/api/duplicates/scan', { method: 'POST', body: {} });
    await loadDuplicates();
  } catch (e) {
    toast(e.message);
  }
};

$('#dup-empty').onclick = async () => {
  if (!confirm(t('dup.confirmEmpty'))) return;
  try {
    await api('/api/duplicates/empty-trash', { method: 'POST', body: {} });
    toast(t('dup.emptied'));
  } catch (e) {
    toast(e.message);
  }
  loadDuplicates().catch((e) => toast(t('toast.loadFailed', { error: e.message })));
};

// ---------------------------------------------------------------- Tabs

function showTab(name) {
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.id === 'tab-' + name);
  const load = { stack: loadQueue, sources: loadSources, history: loadHistory, duplicates: loadDuplicates }[name];
  Promise.resolve(load()).catch((e) => toast(t('toast.loadFailed', { error: e.message })));
  try {
    localStorage.setItem('tubeswipe-tab', name);
  } catch {
    // private window
  }
}

for (const b of document.querySelectorAll('nav button')) b.onclick = () => showTab(b.dataset.tab);

async function start() {
  let config = { language: 'auto', duplicates: false };
  try {
    config = await api('/api/config');
  } catch {
    // keep the defaults; the tabs report their own errors
  }
  const browser = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  const lang = config.language !== 'auto' ? config.language : I18N.pick(browser);
  // Keep the regional variant for dates and numbers (de-CH, en-GB …) when it matches.
  locale = browser.find((l) => String(l).toLowerCase().split('-')[0] === lang) || lang;
  t = I18N.translator(lang);
  translatePage();

  if (!config.duplicates) {
    $('nav button[data-tab="duplicates"]').remove();
    $('#tab-duplicates').remove();
  }

  let startTab = 'stack';
  try {
    startTab = localStorage.getItem('tubeswipe-tab') || 'stack';
  } catch {
    // private window
  }
  showTab(document.getElementById('tab-' + startTab) ? startTab : 'stack');
  if (config.duplicates) {
    api('/api/status')
      .then((s) => updateDupCount(s.duplicates))
      .catch(() => {});
  }

  // Pick up new videos from the regular checks without changing the top card.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const s = await api('/api/status');
      total = s.pending;
      updateCount();
      if (config.duplicates) updateDupCount(s.duplicates);
      if (queue.length < 4 && s.pending > queue.length) loadQueue();
    } catch {
      // next try in 30 s
    }
  }, 30000);
}

start();
