'use strict';
// TubeSwipe im Browser: Kartenstapel mit Wischen, Quellen, Verlauf und doppelte Dateien.

const $ = (sel) => document.querySelector(sel);
const deck = $('#deck');

let queue = []; // Videos in Reihenfolge, queue[0] ist die oberste Karte
let total = 0;
let undoStack = [];
let loading = false;
let busy = false; // während eine Karte hinausfliegt

// ---------------------------------------------------------------- Hilfen

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
    // Authentik-Weiterleitung oder Proxy-Fehlerseite
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

function fmtDuration(s) {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fmtAgo(ts) {
  if (!ts) return 'nie';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return d === 1 ? 'gestern' : `vor ${d} Tagen`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
}

function thumb(id, small) {
  const img = el('img', { alt: '', loading: small ? 'lazy' : 'eager', src: `https://i.ytimg.com/vi/${id}/${small ? 'mqdefault' : 'maxresdefault'}.jpg` });
  if (!small) {
    // Ohne HD-Bild liefert YouTube einen 120 px breiten Platzhalter.
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

// ---------------------------------------------------------------- Stapel

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
    toast('Laden fehlgeschlagen: ' + e.message);
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
  $('#btn-alt').title = `${top.altLabel} (↑)`;
  $('#btn-yes').title = `Ja: ${top.yesLabel} (→)`;
  $('#hint-alt').textContent = top.altLabel;
  if (next) deck.append(card(next, true));
  deck.append(card(top, false));
  // Bild der übernächsten Karte schon laden
  if (queue[2]) new Image().src = `https://i.ytimg.com/vi/${queue[2].id}/maxresdefault.jpg`;
}

async function showEmptyInfo() {
  try {
    const s = await api('/api/status');
    if (!s.sources) $('#empty-info').textContent = 'Noch keine Quellen. Füge unter «Quellen» einen Kanal oder eine Playlist hinzu.';
    else if (s.polling) $('#empty-info').textContent = 'Quellen werden gerade geprüft …';
    else $('#empty-info').textContent = s.nextPoll ? `Nächste Prüfung um ${fmtTime(s.nextPoll)} (alle ${s.pollMinutes} min).` : '';
  } catch {
    $('#empty-info').textContent = '';
  }
}

function card(v, behind) {
  const stampYes = el('div', { class: 'stamp yes' }, 'JA');
  const stampNo = el('div', { class: 'stamp no' }, 'NEIN');
  const stampAlt = el('div', { class: 'stamp alt' }, v.altType === 'audio' ? 'AUDIO' : 'VIDEO');
  const thumbBox = el('div', { class: 'thumb' }, thumb(v.id), v.duration ? el('span', { class: 'duration' }, fmtDuration(v.duration)) : null);
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
      el('div', { class: 'meta' }, [v.channel, v.channel && v.channel === v.source ? null : v.source].filter(Boolean).join(' · ')),
      el('div', { class: 'meta' }, `gefunden ${fmtAgo(v.foundAt)} · Ja lädt ${v.yesLabel}`),
      el('a', { href: `https://www.youtube.com/watch?v=${v.id}`, target: '_blank', rel: 'noopener' }, 'Auf YouTube öffnen ↗'),
    ),
  );
  if (behind) return node;

  const play = el('button', { class: 'play', 'aria-label': 'Vorschau', onclick: () => preview(thumbBox, v.id) }, '▶');
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
      // künstliche Zeiger (Tests) kennt der Browser nicht
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
    if (decision === 'no') toast('Verworfen', true);
    else toast(`${decision === 'alt' ? v.altLabel : v.yesLabel}: geht in ${r.sendInSeconds} s an MeTube`, true);
  } catch (e) {
    toast('Fehler: ' + e.message);
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
    toast(r.alreadySent ? 'Zurück im Stapel – war schon bei MeTube, dort läuft der Download weiter' : 'Zurück im Stapel');
  } catch (e) {
    undoStack.push(v);
    toast('Fehler: ' + e.message);
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
  $('#empty-info').textContent = 'Quellen werden gerade geprüft …';
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

// ---------------------------------------------------------------- Quellen

let presets = [];

async function loadSources() {
  const data = await api('/api/sources');
  presets = data.presets;
  const addPreset = $('#add-preset');
  if (!addPreset.options.length) addPreset.append(...presets.map((p) => el('option', { value: p.id }, p.label)));

  const list = $('#source-list');
  list.replaceChildren(
    ...data.sources.map((s) => {
      const select = el('select', { 'aria-label': 'Bei Ja laden als', onchange: () => api(`/api/sources/${s.id}`, { method: 'PATCH', body: { preset: select.value } }) }, ...presets.map((p) => el('option', { value: p.id, selected: p.id === s.preset }, p.label)));
      const checkBtn = el('button', {}, s.checking ? 'Prüft …' : 'Prüfen');
      checkBtn.disabled = s.checking;
      checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = 'Prüft …';
        try {
          const r = await api(`/api/sources/${s.id}`, { method: 'POST', body: {} });
          toast(r.added ? `${r.added} neue Videos` : 'Nichts Neues');
          loadQueue();
        } catch (e) {
          toast('Fehler: ' + e.message);
        }
        loadSources();
      };
      const pauseBtn = el('button', {}, s.paused ? 'Fortsetzen' : 'Pausieren');
      pauseBtn.onclick = async () => {
        await api(`/api/sources/${s.id}`, { method: 'PATCH', body: { paused: !s.paused } });
        loadSources();
      };
      const delBtn = el('button', { class: 'danger' }, 'Entfernen');
      delBtn.onclick = async () => {
        if (!confirm(`«${s.title}» entfernen? Offene Vorschläge daraus verschwinden, deine Ja/Nein bleiben gemerkt.`)) return;
        await api(`/api/sources/${s.id}`, { method: 'DELETE', body: {} });
        queue = [];
        loadQueue();
        loadSources();
      };
      const status = s.lastError ? el('span', { class: 'err' }, 'Fehler: ' + s.lastError) : `geprüft ${fmtAgo(s.lastCheck)}`;
      return el(
        'li',
        {},
        el(
          'div',
          { class: 'grow' },
          el('div', { class: 'title' }, el('a', { href: s.url, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' }, s.title), s.paused ? ' (pausiert)' : ''),
          el('div', { class: 'meta' }, `${s.kind === 'playlist' ? 'Playlist' : 'Kanal'} · ${s.counts.pending} offen · ${s.counts.yes} ja · ${s.counts.no} nein · `, status),
        ),
        el('div', { class: 'actions' }, select, checkBtn, pauseBtn, delBtn),
      );
    }),
  );
}

$('#add-url').addEventListener('input', (e) => {
  // Playlists dienen meist als Eingangskorb: dann alles vorschlagen.
  if (/[?&]list=/.test(e.target.value)) $('#add-initial').value = '-1';
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#add-btn');
  btn.disabled = true;
  $('#add-msg').className = 'muted';
  $('#add-msg').textContent = 'MeTube liest die Quelle, das dauert ein paar Sekunden …';
  try {
    const r = await api('/api/sources', {
      method: 'POST',
      body: { url: $('#add-url').value, initial: Number($('#add-initial').value), preset: $('#add-preset').value },
    });
    $('#add-msg').className = 'ok';
    $('#add-msg').textContent = `«${r.source.title}» hinzugefügt, ${r.added} Videos im Stapel.`;
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

// ---------------------------------------------------------------- Verlauf

async function loadHistory() {
  const { items } = await api('/api/history?limit=150');
  const list = $('#history-list');
  if (!items.length) {
    list.replaceChildren(el('li', { class: 'muted' }, 'Noch keine Entscheidungen.'));
    return;
  }
  list.replaceChildren(
    ...items.map((v) => {
      let status;
      if (v.status === 'no') status = el('span', { class: 'muted' }, 'verworfen');
      else if (v.sentAt) status = el('span', { class: 'ok' }, `an MeTube: ${v.label}`);
      else if (v.failed) status = el('span', { class: 'err' }, `fehlgeschlagen: ${v.error}`);
      else if (v.error) status = el('span', { class: 'err' }, `neuer Versuch folgt: ${v.error}`);
      else status = el('span', { class: 'muted' }, `wartet: ${v.label}`);

      const back = el('button', {}, 'Zurück in den Stapel');
      back.onclick = async () => {
        const r = await api('/api/undo', { method: 'POST', body: { id: v.id } });
        toast(r.alreadySent ? 'Zurück im Stapel – war schon bei MeTube' : 'Zurück im Stapel');
        queue = [];
        loadQueue();
        loadHistory();
      };
      const actions = [back];
      if (v.failed) {
        const retry = el('button', {}, 'Nochmal senden');
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
          el('div', { class: 'meta' }, `${v.channel || v.source} · ${fmtAgo(v.decidedAt)} · `, status),
        ),
        el('div', { class: 'actions' }, actions),
      );
    }),
  );
}

// ---------------------------------------------------------------- Doppelte

let dupTimer = null;

function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toLocaleString('de-CH', { maximumFractionDigits: 1 }) + ' GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' kB';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function updateDupCount(n) {
  $('#dup-count').textContent = n > 0 ? n : '';
}

async function loadDuplicates() {
  const d = await api('/api/duplicates');
  const groups = d.groups || [];
  updateDupCount(groups.length);
  clearTimeout(dupTimer);
  // Während die Prüfung läuft, alle 2 s nachsehen.
  if (d.scanning) dupTimer = setTimeout(() => loadDuplicates().catch(() => {}), 2000);

  $('#dup-scan').disabled = !!d.scanning;
  let info;
  if (d.scanning) info = 'Prüfung läuft …';
  else if (!d.scannedAt) info = `Noch nicht geprüft. Die Prüfung läuft alle ${d.dupHours} Std. von selbst.`;
  else {
    info = `Geprüft ${fmtAgo(d.scannedAt)}: ${d.files} Dateien in ${(d.roots || []).join(', ') || 'keinem Ordner'}, ${d.withId} mit YouTube-ID.`;
    if (d.crossKind) info += ` ${d.crossKind} gibt es als Video und als Audio, das zählt nicht als doppelt.`;
    if (d.nextScan) info += ` Nächste Prüfung ${d.nextScan - Date.now() < 86400000 ? 'um ' + fmtTime(d.nextScan) : 'am ' + fmtDate(d.nextScan)}.`;
  }
  $('#dup-info').replaceChildren(info);
  if (d.error) $('#dup-info').append(el('span', { class: 'err' }, ` Letzte Prüfung fehlgeschlagen: ${d.error}`));
  if (d.unreadableCount) {
    $('#dup-info').append(
      el('span', { class: 'err' }, ` ${d.unreadableCount} Ordner nicht lesbar: ${d.unreadable.join(', ')}${d.unreadableCount > d.unreadable.length ? ' …' : ''}`),
    );
  }

  const trash = d.trash || { files: 0, bytes: 0 };
  $('#dup-trash').textContent = trash.files
    ? `Im Papierkorb: ${trash.files} Dateien, ${fmtSize(trash.bytes)}. Geleert wird nur mit diesem Knopf.`
    : 'Papierkorb ist leer.';
  $('#dup-empty').disabled = !trash.files || !!d.scanning;

  const list = $('#dup-list');
  if (!groups.length) {
    list.replaceChildren(el('li', { class: 'muted' }, d.scannedAt ? 'Keine doppelten Dateien gefunden.' : 'Noch keine Funde.'));
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
          el('div', { class: 'meta muted' }, `${g.kind === 'audio' ? 'Audio' : 'Video'} · ${g.files.length} Dateien · ${g.id}`),
        ),
        el(
          'div',
          { class: 'dup-files' },
          ...g.files.map((f, i) => {
            const age = i === 0 ? 'älteste' : i === g.files.length - 1 ? 'neuste' : '';
            const extra = f.sidecars ? ` · ${f.sidecars} Begleitdatei${f.sidecars === 1 ? '' : 'en'}` : '';
            return el(
              'div',
              { class: 'dup-file' },
              el(
                'div',
                { class: 'grow' },
                el('div', { class: 'path' }, `${f.root}/${f.rel}`),
                el('div', { class: 'meta muted' }, `${fmtSize(f.size)} · ${fmtDate(f.mtime)}${age ? ' · ' + age : ''}${extra}`),
              ),
              el('button', { class: 'danger', onclick: (e) => trashFile(f, e.currentTarget) }, 'In Papierkorb'),
            );
          }),
        ),
      ),
    ),
  );
}

async function trashFile(f, btn) {
  const extra = f.sidecars ? ` samt ${f.sidecars} Begleitdatei${f.sidecars === 1 ? '' : 'en'}` : '';
  if (!confirm(`«${f.root}/${f.rel}»${extra} in den Papierkorb verschieben?`)) return;
  btn.disabled = true;
  try {
    const r = await api('/api/duplicates/delete', { method: 'POST', body: { root: f.root, rel: f.rel } });
    toast(`In den Papierkorb verschoben (${r.moved} Datei${r.moved === 1 ? '' : 'en'})`);
  } catch (e) {
    toast(e.message);
  }
  loadDuplicates().catch((e) => toast('Laden fehlgeschlagen: ' + e.message));
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
  if (!confirm('Papierkorb endgültig leeren? Das lässt sich nicht rückgängig machen.')) return;
  try {
    await api('/api/duplicates/empty-trash', { method: 'POST', body: {} });
    toast('Papierkorb geleert');
  } catch (e) {
    toast(e.message);
  }
  loadDuplicates().catch((e) => toast('Laden fehlgeschlagen: ' + e.message));
};

// ---------------------------------------------------------------- Tabs

function showTab(name) {
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === 'tab-' + name);
  const load = { stack: loadQueue, sources: loadSources, history: loadHistory, duplicates: loadDuplicates }[name];
  Promise.resolve(load()).catch((e) => toast('Laden fehlgeschlagen: ' + e.message));
  try {
    localStorage.setItem('tubeswipe-tab', name);
  } catch {
    // privates Fenster
  }
}

for (const b of document.querySelectorAll('nav button')) b.onclick = () => showTab(b.dataset.tab);

let startTab = 'stack';
try {
  startTab = localStorage.getItem('tubeswipe-tab') || 'stack';
} catch {
  // privates Fenster
}
showTab(document.getElementById('tab-' + startTab) ? startTab : 'stack');
api('/api/status')
  .then((s) => updateDupCount(s.duplicates))
  .catch(() => {});

// Neue Videos aus den stündlichen Prüfungen nachladen, ohne die Karte oben zu wechseln.
setInterval(async () => {
  if (document.hidden) return;
  try {
    const s = await api('/api/status');
    total = s.pending;
    updateCount();
    updateDupCount(s.duplicates);
    if (queue.length < 4 && s.pending > queue.length) loadQueue();
  } catch {
    // nächster Versuch in 30 s
  }
}, 30000);
