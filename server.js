'use strict';
// TubeSwipe: schlägt neue Videos aus YouTube-Kanälen und -Playlists als Karten
// vor. Ja schickt das Video an MeTube (/add), Nein verwirft es für immer.
// Die Einträge einer Quelle liest MeTube selbst aus (/browse: yt-dlp ohne
// Download), darum braucht dieser Container kein eigenes yt-dlp.
// Keine Abhängigkeiten ausser Node; der ganze Zustand liegt in DATA_DIR/state.json.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const METUBE_URL = (process.env.METUBE_URL || 'http://metube:8081').replace(/\/+$/, '');
const POLL_MINUTES = Math.max(5, Number(process.env.POLL_MINUTES || 60));
// Kanäle liefern die neusten Videos zuerst; mehr als so viele neue zwischen
// zwei Prüfungen gibt es praktisch nie. Playlists werden immer ganz gelesen.
const CHANNEL_LIMIT = Math.max(5, Number(process.env.CHANNEL_LIMIT || 50));
// So lange lässt sich ein Ja zurücknehmen, bevor es an MeTube geht.
const SEND_DELAY_MS = Math.max(0, Number(process.env.SEND_DELAY_SECONDS ?? 8)) * 1000;
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COMMIT = readCommit();

const DOWNLOAD_PRESETS = {
  'video-best': { download_type: 'video', format: 'any', quality: 'best', label: 'Video, beste' },
  'video-1440': { download_type: 'video', format: 'any', quality: '1440', label: 'Video 1440p' },
  'video-1080': { download_type: 'video', format: 'any', quality: '1080', label: 'Video 1080p' },
  'video-720': { download_type: 'video', format: 'any', quality: '720', label: 'Video 720p' },
  'audio-mp3': { download_type: 'audio', format: 'mp3', quality: 'best', label: 'Audio MP3' },
};

function readCommit() {
  try {
    return fs.readFileSync(path.join(__dirname, 'COMMIT'), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

// ---------------------------------------------------------------- Zustand

let state = loadState();
let saveTimer = null;

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { sources: s.sources || [], videos: s.videos || {}, seq: s.seq || 0, duplicates: s.duplicates || null };
  } catch (e) {
    // Eine kaputte Datei nicht mit einem leeren Stand überschreiben.
    if (e.code !== 'ENOENT') throw e;
    return { sources: [], videos: {}, seq: 0, duplicates: null };
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

// ---------------------------------------------------------------- YouTube

function videoIdFrom(url) {
  const m = String(url).match(/(?:[?&]v=|\/shorts\/|\/live\/|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Macht aus dem, was man aus der YouTube-App kopiert, eine eindeutige Quelle.
function normalizeSource(input) {
  let text = String(input || '').trim();
  if (text.startsWith('@')) text = 'https://www.youtube.com/' + text;
  let u;
  try {
    u = new URL(text);
  } catch {
    return { error: 'Das ist keine Adresse.' };
  }
  if (!/^((www|m|music)\.)?youtube\.com$/.test(u.hostname)) {
    return { error: 'Nur Adressen von youtube.com.' };
  }
  const list = u.searchParams.get('list');
  if (list) {
    if (list === 'WL' || list === 'LL') {
      return { error: '«Später ansehen» und «Mag ich» sind immer privat. Nimm eine nicht gelistete Playlist.' };
    }
    return { kind: 'playlist', key: 'list:' + list, url: 'https://www.youtube.com/playlist?list=' + encodeURIComponent(list) };
  }
  const m = u.pathname.match(/^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)/);
  if (m) {
    // Der Tab «Videos» lässt Shorts und Livestreams weg.
    return { kind: 'channel', key: decodeURIComponent(m[1]).toLowerCase(), url: 'https://www.youtube.com/' + m[1] + '/videos' };
  }
  return { error: 'Bitte einen Kanal (…/@name) oder eine Playlist (…?list=…) einfügen.' };
}

async function metube(route, body, timeoutMs) {
  const res = await fetch(METUBE_URL + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MeTube ${route}: HTTP ${res.status} ${text.slice(0, 200)}`.trim());
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`MeTube ${route}: unerwartete Antwort`);
  }
  if (data.status === 'error') throw new Error(data.msg || `MeTube ${route}: Fehler`);
  return data;
}

// In Playlists stammen die Videos aus verschiedenen Kanälen; /browse nennt den
// Kanal nicht, oEmbed schon (ohne API-Key).
async function channelOf(id) {
  try {
    const watch = 'https://www.youtube.com/watch?v=' + id;
    const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(watch), {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    return (await res.json()).author_name || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- Prüfen

let checking = null; // id der Quelle, die gerade geprüft wird
let lastPollAt = 0;

async function checkSource(src) {
  checking = src.id;
  try {
    const data = await metube('/browse', { url: src.url, playlist_item_limit: src.kind === 'playlist' ? 0 : CHANNEL_LIMIT }, 180000);
    if (data.title) src.title = String(data.title).replace(/ - Videos$/, '');
    const entries = [];
    const seen = new Set();
    for (const e of data.entries || []) {
      const id = videoIdFrom(e.url);
      if (!id || seen.has(id) || /^\[(deleted|private) video\]$/i.test(e.title || '')) continue;
      seen.add(id);
      entries.push({ id, title: e.title || id, duration: typeof e.duration === 'number' ? e.duration : null });
    }

    // Beim ersten Lesen nur die gewünschte Zahl bestehender Videos vorschlagen,
    // den Rest als bekannt merken. Kanäle: die ersten (neusten), Playlists: die
    // letzten (neu hinzugefügte landen bei YouTube standardmässig hinten).
    let propose = new Set(entries.map((e) => e.id));
    if (!src.initialized && src.initial >= 0) {
      const pick = src.kind === 'playlist' ? entries.slice(Math.max(0, entries.length - src.initial)) : entries.slice(0, src.initial);
      propose = new Set(pick.map((e) => e.id));
    }

    // Neu ist, was diese Quelle beim letzten Mal noch nicht hatte. So taucht ein
    // Video, das bei einem Kanal als alter Bestand übersprungen wurde, trotzdem
    // auf, sobald es in den Eingangskorb (eine Playlist) kommt.
    const seenBefore = new Set(src.seen || []);
    const now = Date.now();
    let added = 0;
    for (const e of entries) {
      const known = state.videos[e.id];
      const want = propose.has(e.id) && !seenBefore.has(e.id);
      if (known) {
        if (want && known.status === 'skipped') {
          Object.assign(known, { sourceId: src.id, foundAt: now, seq: ++state.seq, status: 'pending' });
          if (src.kind === 'channel') known.channel = src.title;
          added++;
        }
        continue;
      }
      const pending = want;
      state.videos[e.id] = {
        id: e.id,
        sourceId: src.id,
        title: e.title,
        channel: src.kind === 'channel' ? src.title : '',
        duration: e.duration,
        foundAt: now,
        seq: ++state.seq,
        status: pending ? 'pending' : 'skipped',
      };
      if (pending) added++;
    }
    if (src.kind === 'playlist') {
      for (const e of entries) {
        const v = state.videos[e.id];
        if (v.status === 'pending' && !v.channel) v.channel = await channelOf(e.id);
      }
    }
    src.seen = entries.map((e) => e.id);
    src.initialized = true;
    src.lastCheck = now;
    src.lastError = null;
    save();
    return { added };
  } catch (e) {
    src.lastCheck = Date.now();
    src.lastError = e.message;
    save();
    throw e;
  } finally {
    checking = null;
  }
}

async function pollDue(force) {
  lastPollAt = Date.now();
  for (const src of [...state.sources]) {
    if (src.paused || !state.sources.includes(src)) continue;
    if (!force && src.lastCheck && Date.now() - src.lastCheck < POLL_MINUTES * 60000) continue;
    try {
      await checkSource(src);
    } catch (e) {
      console.warn(`Prüfen fehlgeschlagen: ${src.url}: ${e.message}`);
    }
  }
}

let polling = null;
function poll(force) {
  if (!polling) polling = pollDue(force).finally(() => (polling = null));
  return polling;
}

// ---------------------------------------------------------------- Senden

let sending = false;

async function sendDue() {
  if (sending) return;
  sending = true;
  try {
    for (const v of Object.values(state.videos)) {
      if (v.status !== 'yes' || v.sentAt || v.failed || v.sendAt > Date.now()) continue;
      const src = state.sources.find((s) => s.id === v.sourceId);
      const o = v.options;
      try {
        await metube(
          '/add',
          {
            url: 'https://www.youtube.com/watch?v=' + v.id,
            download_type: o.download_type,
            format: o.format,
            quality: o.quality,
            codec: 'auto',
            folder: (src && src.folder) || '',
            auto_start: true,
          },
          120000,
        );
        // Zwischen dem Abschicken und der Antwort kann «Zurück» gekommen sein.
        if (v.status === 'yes') {
          v.sentAt = Date.now();
          v.error = null;
        }
      } catch (e) {
        v.attempts = (v.attempts || 0) + 1;
        v.error = e.message;
        if (v.attempts >= 3) v.failed = true;
        else v.sendAt = Date.now() + v.attempts * 60000;
        console.warn(`An MeTube schicken fehlgeschlagen: ${v.id}: ${e.message}`);
      }
      save();
    }
  } finally {
    sending = false;
  }
}

// ---------------------------------------------------------------- Doppelte

// Sucht in den Medienordnern (je ein Unterordner von MEDIA_DIR ist eine Wurzel)
// Dateien mit derselben YouTube-ID und derselben Art. Gelöscht wird nie direkt:
// «In Papierkorb» verschiebt in <Wurzel>/.tubeswipe-trash, geleert wird nur
// auf Knopfdruck. Jede Wurzel hat ihren eigenen Papierkorb, weil die Wurzeln
// getrennte Mounts sind und rename über Mounts hinweg nicht geht.
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || '/media');
const DUP_HOURS = Math.max(1, Number(process.env.DUP_HOURS) || 24);
const TRASH_DIR = '.tubeswipe-trash';
const MEDIA_KINDS = {
  '.mp4': 'video',
  '.mkv': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.opus': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.wav': 'audio',
};
const PARTIAL = /\.(part|ytdl|temp)$/i;
const SIDECAR_TAIL = /^(-poster)?(\.[\w-]+)+$/;
const fsp = fs.promises;

function mediaKind(name) {
  return PARTIAL.test(name) ? null : MEDIA_KINDS[path.extname(name).toLowerCase()] || null;
}

function stemOf(name) {
  return name.slice(0, name.length - path.extname(name).length);
}

// Begleitdateien (.nfo, .info.json, .webp, -poster.webp …) heissen wie das
// Medium ohne Endung. Gehört eine Datei zu einem längeren Stamm, ist sie nicht
// von diesem Medium.
function sidecarsOf(names, stem) {
  const stems = names.filter(mediaKind).map(stemOf);
  return names.filter((n) => {
    if (mediaKind(n) || PARTIAL.test(n) || !n.startsWith(stem) || !SIDECAR_TAIL.test(n.slice(stem.length))) return false;
    return !stems.some((s) => s.length > stem.length && n.startsWith(s) && SIDECAR_TAIL.test(n.slice(s.length)));
  });
}

async function youtubeIdOf(dir, stem, names) {
  const m = stem.match(/\[([\w-]{11})\]$/);
  if (m) return m[1];
  if (names.includes(stem + '.info.json')) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, stem + '.info.json'), 'utf8'));
      if (/^youtube/i.test(j.extractor_key || '') && /^[\w-]{11}$/.test(j.id || '')) return j.id;
    } catch {}
  }
  if (names.includes(stem + '.nfo')) {
    try {
      const nfo = await fsp.readFile(path.join(dir, stem + '.nfo'), 'utf8');
      const n = nfo.match(/<uniqueid[^>]*type="youtube"[^>]*>\s*([\w-]{11})\s*</);
      if (n) return n[1];
    } catch {}
  }
  return null;
}

async function mediaRoots() {
  const entries = await fsp.readdir(MEDIA_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

async function walkMedia(root, scan) {
  const rootDir = path.join(MEDIA_DIR, root);
  const dirs = [''];
  while (dirs.length) {
    const rel = dirs.pop();
    const dir = path.join(rootDir, rel);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
      scan.unreadableCount++;
      if (scan.unreadable.length < 20) scan.unreadable.push(root + (rel ? '/' + rel : ''));
      continue;
    }
    const names = entries.map((e) => e.name);
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'lost+found') continue;
      const relPath = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        dirs.push(relPath);
        continue;
      }
      const kind = e.isFile() && mediaKind(e.name);
      if (!kind) continue;
      scan.files++;
      const stem = stemOf(e.name);
      const id = await youtubeIdOf(dir, stem, names);
      if (!id) continue;
      scan.withId++;
      let st;
      try {
        st = await fsp.stat(path.join(dir, e.name));
      } catch {
        continue;
      }
      scan.found.push({
        id,
        kind,
        title: stem.replace(/\s*\[[\w-]{11}\]$/, ''),
        root,
        rel: relPath,
        size: st.size,
        mtime: st.mtimeMs,
        sidecars: sidecarsOf(names, stem).length,
      });
    }
  }
}

async function trashStats(roots) {
  const t = { files: 0, bytes: 0 };
  for (const root of roots) {
    const dirs = [path.join(MEDIA_DIR, root, TRASH_DIR)];
    while (dirs.length) {
      const dir = dirs.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) dirs.push(p);
        else {
          t.files++;
          try {
            t.bytes += (await fsp.stat(p)).size;
          } catch {}
        }
      }
    }
  }
  return t;
}

async function runDupScan() {
  const started = Date.now();
  try {
    const roots = await mediaRoots();
    const scan = { files: 0, withId: 0, found: [], unreadable: [], unreadableCount: 0 };
    for (const root of roots) await walkMedia(root, scan);
    const byKey = new Map();
    const kindsById = new Map();
    for (const f of scan.found) {
      const key = f.id + ':' + f.kind;
      if (!byKey.has(key)) byKey.set(key, { id: f.id, kind: f.kind, title: f.title, files: [] });
      const { id, kind, title, ...file } = f;
      byKey.get(key).files.push(file);
      if (!kindsById.has(f.id)) kindsById.set(f.id, new Set());
      kindsById.get(f.id).add(f.kind);
    }
    const groups = [...byKey.values()].filter((g) => g.files.length >= 2);
    for (const g of groups) g.files.sort((a, b) => a.mtime - b.mtime);
    groups.sort((a, b) => a.title.localeCompare(b.title, 'de'));
    state.duplicates = {
      scannedAt: started,
      durationMs: Date.now() - started,
      roots,
      files: scan.files,
      withId: scan.withId,
      groups,
      crossKind: [...kindsById.values()].filter((k) => k.size > 1).length,
      unreadable: scan.unreadable,
      unreadableCount: scan.unreadableCount,
      trash: await trashStats(roots),
      error: null,
    };
    console.log(`Doppelte: ${groups.length} Gruppen in ${scan.files} Dateien (${state.duplicates.durationMs} ms)`);
  } catch (e) {
    // Die alten Funde stehen lassen, aber nicht sofort wieder prüfen.
    const old = state.duplicates || { roots: [], files: 0, withId: 0, groups: [], crossKind: 0, unreadable: [], unreadableCount: 0, trash: { files: 0, bytes: 0 } };
    state.duplicates = { ...old, scannedAt: started, durationMs: Date.now() - started, error: e.message };
    console.warn(`Doppelte prüfen fehlgeschlagen: ${e.message}`);
  }
  save();
}

let dupScanning = null;
function scanDuplicates() {
  if (!dupScanning) dupScanning = runDupScan().finally(() => (dupScanning = null));
  return dupScanning;
}

function dupDue() {
  if (trashing) return;
  const d = state.duplicates;
  if (!d || !d.scannedAt || Date.now() - d.scannedAt >= DUP_HOURS * 3600000) scanDuplicates();
}

function dropDuplicate(root, rel) {
  const d = state.duplicates;
  if (!d) return 0;
  const g = d.groups.find((x) => x.files.some((f) => f.root === root && f.rel === rel));
  if (!g) return 0;
  g.files = g.files.filter((f) => !(f.root === root && f.rel === rel));
  if (g.files.length < 2) d.groups = d.groups.filter((x) => x !== g);
  save();
  return g.files.length;
}

function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(from);
  }
}

function noPermission(where) {
  return [
    403,
    {
      error: `Keine Schreibrechte im Ordner «${where}». TubeSwipe läuft als UID 1000 (green) und darf dort nichts verschieben; Besitzer auf green ändern, siehe README.`,
    },
  ];
}

let trashing = false;

async function trashDuplicate(root, rel) {
  if (dupScanning) return [409, { error: 'Die Prüfung läuft gerade. Gleich nochmals versuchen.' }];
  if (trashing) return [409, { error: 'Es wird gerade eine andere Datei verschoben.' }];
  if (typeof root !== 'string' || typeof rel !== 'string' || !root || !rel) return [400, { error: 'root und rel fehlen' }];
  const rootDir = path.join(MEDIA_DIR, root);
  const file = path.resolve(rootDir, rel);
  const inside = path.relative(rootDir, file).split(path.sep);
  if (path.dirname(rootDir) !== MEDIA_DIR || root.startsWith('.') || !file.startsWith(rootDir + path.sep) || inside[0] === TRASH_DIR) {
    return [400, { error: 'Ungültiger Pfad' }];
  }
  const d = state.duplicates;
  if (!d || !d.groups.some((g) => g.files.some((f) => f.root === root && f.rel === rel))) {
    return [404, { error: 'Diese Datei steht nicht in den Funden.' }];
  }
  trashing = true;
  const relDir = inside.slice(0, -1).join('/');
  const where = root + (relDir ? '/' + relDir : '');
  let size = 0;
  try {
    try {
      size = (await fsp.stat(file)).size;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return [410, { error: 'Die Datei gibt es nicht mehr.', left: dropDuplicate(root, rel) }];
    }
    const dir = path.dirname(file);
    const names = await fsp.readdir(dir);
    const base = path.basename(file);
    const stem = stemOf(base);
    // Teilen sich zwei Medien einen Stamm (webm und mp4), bleiben die
    // Begleitdateien beim verbleibenden.
    const shared = names.some((n) => n !== base && mediaKind(n) && stemOf(n) === stem);
    const moving = [base, ...(shared ? [] : sidecarsOf(names, stem))];

    const day = localDay();
    let target = path.join(rootDir, TRASH_DIR, day, ...inside.slice(0, -1));
    const taken = await fsp.readdir(target).catch(() => []);
    if (moving.some((n) => taken.includes(n))) target = path.join(rootDir, TRASH_DIR, `${day}-${Date.now()}`, ...inside.slice(0, -1));
    try {
      await fsp.mkdir(target, { recursive: true });
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') return noPermission(root);
      throw e;
    }
    let moved = 0;
    for (const n of moving) {
      try {
        await moveFile(path.join(dir, n), path.join(target, n));
        moved++;
      } catch (e) {
        if (e.code === 'ENOENT' && n !== base) continue;
        if (moved === 0 && (e.code === 'EACCES' || e.code === 'EPERM')) return noPermission(where);
        if (moved === 0) throw e;
        console.warn(`Begleitdatei nicht verschoben: ${where}/${n}: ${e.message}`);
      }
    }
    if (dir !== rootDir) await fsp.rmdir(dir).catch(() => {});
    const left = dropDuplicate(root, rel);
    const cur = state.duplicates;
    cur.trash = { files: cur.trash.files + moved, bytes: cur.trash.bytes + size };
    return { ok: true, moved, left, trash: path.relative(MEDIA_DIR, target).split(path.sep).join('/') };
  } finally {
    trashing = false;
  }
}

async function emptyTrash() {
  if (dupScanning || trashing) return [409, { error: 'Die Prüfung läuft gerade. Gleich nochmals versuchen.' }];
  const errors = [];
  let roots;
  try {
    roots = await mediaRoots();
  } catch (e) {
    return [500, { error: e.message }];
  }
  for (const root of roots) {
    try {
      await fsp.rm(path.join(MEDIA_DIR, root, TRASH_DIR), { recursive: true });
    } catch (e) {
      if (e.code !== 'ENOENT') errors.push(`${root}: ${e.code || e.message}`);
    }
  }
  const trash = await trashStats(roots);
  if (state.duplicates) {
    state.duplicates.trash = trash;
    save();
  }
  if (errors.length) return [500, { error: 'Papierkorb nicht ganz geleert: ' + errors.join(', '), trash }];
  return { ok: true, trash };
}

// ---------------------------------------------------------------- API

function sourceView(src) {
  const counts = { pending: 0, yes: 0, no: 0 };
  for (const v of Object.values(state.videos)) {
    if (v.sourceId === src.id && v.status in counts) counts[v.status]++;
  }
  const { seen, ...rest } = src;
  return { ...rest, counts, checking: checking === src.id };
}

function videoView(v) {
  const src = state.sources.find((s) => s.id === v.sourceId);
  const preset = DOWNLOAD_PRESETS[(src && src.preset) || 'video-best'];
  const alt = preset.download_type === 'audio' ? DOWNLOAD_PRESETS['video-best'] : DOWNLOAD_PRESETS['audio-mp3'];
  return {
    id: v.id,
    title: v.title,
    channel: v.channel,
    duration: v.duration,
    foundAt: v.foundAt,
    status: v.status,
    decidedAt: v.decidedAt || null,
    sentAt: v.sentAt || null,
    error: v.error || null,
    failed: !!v.failed,
    label: v.options ? v.options.label : null,
    source: src ? src.title : '(entfernte Quelle)',
    yesLabel: preset.label,
    altLabel: alt.label,
    altType: alt.download_type,
  };
}

function pendingSorted() {
  return Object.values(state.videos)
    .filter((v) => v.status === 'pending')
    .sort((a, b) => b.foundAt - a.foundAt || a.seq - b.seq);
}

const routes = {
  'GET /api/health': () => ({ status: 'ok', commit: COMMIT }),

  'GET /api/status': () => {
    const nextPoll = lastPollAt ? lastPollAt + POLL_MINUTES * 60000 : null;
    return {
      pending: pendingSorted().length,
      sources: state.sources.length,
      polling: !!polling,
      checking,
      nextPoll,
      pollMinutes: POLL_MINUTES,
      duplicates: state.duplicates ? state.duplicates.groups.length : 0,
    };
  },

  'GET /api/queue': (req, url) => {
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || 10);
    const all = pendingSorted();
    return { total: all.length, items: all.slice(0, limit).map(videoView) };
  },

  'POST /api/decide': (req, url, body) => {
    const v = state.videos[body.id];
    if (!v) return [404, { error: 'Unbekanntes Video' }];
    if (!['yes', 'alt', 'no'].includes(body.decision)) return [400, { error: 'decision: yes, alt oder no' }];
    if (v.status === 'yes' && v.sentAt) return [409, { error: 'Schon an MeTube geschickt' }];
    v.decidedAt = Date.now();
    delete v.sentAt;
    delete v.error;
    delete v.failed;
    delete v.attempts;
    if (body.decision === 'no') {
      v.status = 'no';
      delete v.options;
    } else {
      const src = state.sources.find((s) => s.id === v.sourceId);
      const preset = DOWNLOAD_PRESETS[(src && src.preset) || 'video-best'];
      const alt = preset.download_type === 'audio' ? DOWNLOAD_PRESETS['video-best'] : DOWNLOAD_PRESETS['audio-mp3'];
      v.status = 'yes';
      v.options = { ...(body.decision === 'alt' ? alt : preset) };
      v.sendAt = Date.now() + SEND_DELAY_MS;
    }
    save();
    return { ok: true, sendInSeconds: v.status === 'yes' ? SEND_DELAY_MS / 1000 : null };
  },

  // Zurück in den Stapel. War es schon bei MeTube, bleibt der Download dort.
  'POST /api/undo': (req, url, body) => {
    const v = state.videos[body.id];
    if (!v) return [404, { error: 'Unbekanntes Video' }];
    const alreadySent = v.status === 'yes' && !!v.sentAt;
    v.status = 'pending';
    v.foundAt = Date.now();
    for (const k of ['decidedAt', 'sentAt', 'sendAt', 'options', 'error', 'failed', 'attempts']) delete v[k];
    save();
    return { ok: true, alreadySent };
  },

  'POST /api/retry': (req, url, body) => {
    const v = state.videos[body.id];
    if (!v || v.status !== 'yes' || v.sentAt) return [400, { error: 'Nichts zu wiederholen' }];
    v.failed = false;
    v.attempts = 0;
    v.sendAt = Date.now();
    save();
    sendDue();
    return { ok: true };
  },

  'GET /api/history': (req, url) => {
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const items = Object.values(state.videos)
      .filter((v) => v.status === 'yes' || v.status === 'no')
      .sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0))
      .slice(0, limit)
      .map(videoView);
    return { items };
  },

  'GET /api/sources': () => ({
    sources: state.sources.map(sourceView),
    presets: Object.entries(DOWNLOAD_PRESETS).map(([id, p]) => ({ id, label: p.label })),
  }),

  'POST /api/sources': async (req, url, body) => {
    const n = normalizeSource(body.url);
    if (n.error) return [400, { error: n.error }];
    if (state.sources.some((s) => s.key === n.key)) return [409, { error: 'Diese Quelle gibt es schon.' }];
    const initial = Number.isInteger(body.initial) ? body.initial : 10;
    const src = {
      id: crypto.randomUUID(),
      kind: n.kind,
      key: n.key,
      url: n.url,
      title: n.url,
      preset: DOWNLOAD_PRESETS[body.preset] ? body.preset : 'video-best',
      initial,
      initialized: false,
      addedAt: Date.now(),
      lastCheck: null,
      lastError: null,
      paused: false,
    };
    state.sources.push(src);
    try {
      const { added } = await checkSource(src);
      return { source: sourceView(src), added };
    } catch (e) {
      // Was sich beim ersten Mal nicht lesen lässt, nicht stehen lassen.
      state.sources = state.sources.filter((s) => s !== src);
      save();
      return [400, { error: 'MeTube konnte die Quelle nicht lesen: ' + e.message }];
    }
  },

  'POST /api/check': () => {
    poll(true);
    return { ok: true };
  },

  'GET /api/duplicates': () => {
    const d = state.duplicates;
    const nextScan = d && d.scannedAt ? d.scannedAt + DUP_HOURS * 3600000 : null;
    return { ...(d || { groups: [] }), scanning: !!dupScanning, dupHours: DUP_HOURS, nextScan };
  },

  // Antwortet sofort; die Seite fragt nach, bis scanning wieder false ist.
  'POST /api/duplicates/scan': () => {
    scanDuplicates();
    return { ok: true, scanning: true };
  },

  'POST /api/duplicates/delete': (req, url, body) => trashDuplicate(body.root, body.rel),

  'POST /api/duplicates/empty-trash': () => emptyTrash(),
};

const sourceRoutes = {
  PATCH: (src, body) => {
    if (body.preset && DOWNLOAD_PRESETS[body.preset]) src.preset = body.preset;
    if (typeof body.paused === 'boolean') src.paused = body.paused;
    save();
    return { source: sourceView(src) };
  },
  // Entscheidungen bleiben: ein Nein soll auch nach erneutem Hinzufügen gelten.
  DELETE: (src) => {
    state.sources = state.sources.filter((s) => s !== src);
    for (const [id, v] of Object.entries(state.videos)) {
      if (v.sourceId === src.id && (v.status === 'pending' || v.status === 'skipped')) delete state.videos[id];
    }
    save();
    return { ok: true };
  },
  POST: async (src) => {
    if (checking === src.id) return [409, { error: 'Wird gerade geprüft' }];
    try {
      return { ...(await checkSource(src)), source: sourceView(src) };
    } catch (e) {
      return [502, { error: e.message }];
    }
  },
};

// ---------------------------------------------------------------- HTTP

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) {
        reject(Object.assign(new Error('Zu gross'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Kein gültiges JSON'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Nicht gefunden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Nicht gefunden' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Nicht erlaubt' });
      return serveStatic(res, url.pathname);
    }
    // Nur JSON annehmen: ein fremdes Formular kann diesen Typ nicht ohne
    // CORS-Vorabfrage schicken, und die beantwortet der Server nicht.
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'Nur application/json' });
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    let handler = routes[`${req.method} ${url.pathname}`];
    let result;
    if (handler) {
      result = await handler(req, url, body);
    } else {
      const m = url.pathname.match(/^\/api\/sources\/([\w-]+)$/);
      const src = m && state.sources.find((s) => s.id === m[1]);
      handler = src && sourceRoutes[req.method];
      if (!handler) return send(res, 404, { error: 'Nicht gefunden' });
      result = await handler(src, body);
    }
    if (Array.isArray(result)) send(res, result[0], result[1]);
    else send(res, 200, result);
  } catch (e) {
    console.error(e);
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`TubeSwipe ${COMMIT} auf Port ${PORT}, MeTube ${METUBE_URL}, Prüfung alle ${POLL_MINUTES} min`);
});

setTimeout(() => poll(false), 10000);
setInterval(() => poll(false), 60000);
setInterval(sendDue, 2000);
// Doppelte: kurz nach dem Start nachholen, falls fällig, danach alle 10 min nachsehen.
setTimeout(dupDue, 30000);
setInterval(dupDue, 10 * 60000);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flushSave();
    process.exit(0);
  });
}
