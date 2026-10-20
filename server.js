'use strict';
// TubeSwipe: suggests new videos from YouTube channels and playlists as cards.
// Yes sends the video to MeTube (/add), no dismisses it for good. MeTube itself
// lists the entries of a source (/browse: yt-dlp without downloading), so this
// container needs no yt-dlp of its own.
// No dependencies besides Node; the whole state lives in DATA_DIR/state.json.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const i18n = require('./public/i18n.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const METUBE_URL = (process.env.METUBE_URL || 'http://metube:8081').replace(/\/+$/, '');
const POLL_MINUTES = Math.max(5, Number(process.env.POLL_MINUTES || 60));
// Channels list the newest videos first; more new ones than this between two
// checks practically never happen. Playlists are always read in full.
const CHANNEL_LIMIT = Math.max(5, Number(process.env.CHANNEL_LIMIT || 50));
// How long a yes can be taken back before it goes to MeTube.
const SEND_DELAY_MS = Math.max(0, Number(process.env.SEND_DELAY_SECONDS ?? 8)) * 1000;
// "auto" follows the browser (Accept-Language), "en" or "de" fixes the language.
// Not LANGUAGE, which gettext uses on many Linux systems.
const LANGUAGE = i18n.LANGUAGES.includes(String(process.env.UI_LANGUAGE || '').toLowerCase()) ? process.env.UI_LANGUAGE.toLowerCase() : 'auto';
// The duplicates tab scans and moves files in MEDIA_DIR, so it is off unless asked for.
const DUPLICATES = /^(1|true|yes|on)$/i.test(process.env.DUPLICATES || '');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COMMIT = readCommit();

if (!AUTH_USER !== !AUTH_PASSWORD) {
  console.error('Set both AUTH_USER and AUTH_PASSWORD, or neither.');
  process.exit(1);
}

const DOWNLOAD_PRESETS = {
  'video-best': { download_type: 'video', format: 'any', quality: 'best' },
  'video-1440': { download_type: 'video', format: 'any', quality: '1440' },
  'video-1080': { download_type: 'video', format: 'any', quality: '1080' },
  'video-720': { download_type: 'video', format: 'any', quality: '720' },
  'audio-mp3': { download_type: 'audio', format: 'mp3', quality: 'best' },
};

function readCommit() {
  try {
    return fs.readFileSync(path.join(__dirname, 'COMMIT'), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

// ---------------------------------------------------------------- State

let state = loadState();
let saveTimer = null;

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { sources: s.sources || [], videos: s.videos || {}, seq: s.seq || 0, duplicates: s.duplicates || null };
  } catch (e) {
    // Never overwrite a broken file with an empty state.
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

// Turns whatever is copied from the YouTube app into one unique source.
// Errors are message keys for the caller to translate.
function normalizeSource(input) {
  let text = String(input || '').trim();
  if (text.startsWith('@')) text = 'https://www.youtube.com/' + text;
  let u;
  try {
    u = new URL(text);
  } catch {
    return { error: 'err.notUrl' };
  }
  if (!/^((www|m|music)\.)?youtube\.com$/.test(u.hostname)) {
    return { error: 'err.onlyYoutube' };
  }
  const list = u.searchParams.get('list');
  if (list) {
    if (list === 'WL' || list === 'LL') return { error: 'err.privateList' };
    return { kind: 'playlist', key: 'list:' + list, url: 'https://www.youtube.com/playlist?list=' + encodeURIComponent(list) };
  }
  const m = u.pathname.match(/^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)/);
  if (m) {
    // The "Videos" tab leaves out Shorts and live streams.
    return { kind: 'channel', key: decodeURIComponent(m[1]).toLowerCase(), url: 'https://www.youtube.com/' + m[1] + '/videos' };
  }
  return { error: 'err.needSource' };
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
    throw new Error(`MeTube ${route}: unexpected response`);
  }
  if (data.status === 'error') throw new Error(data.msg || `MeTube ${route}: error`);
  return data;
}

// Videos in a playlist come from different channels; /browse does not name the
// channel, oEmbed does (without an API key).
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

// ---------------------------------------------------------------- Checking

let checking = null; // id of the source being checked right now
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

    // On the first read, suggest only the requested number of existing videos
    // and remember the rest as known. Channels: the first (newest) ones,
    // playlists: the last ones (YouTube appends new entries at the end by default).
    let propose = new Set(entries.map((e) => e.id));
    if (!src.initialized && src.initial >= 0) {
      const pick = src.kind === 'playlist' ? entries.slice(Math.max(0, entries.length - src.initial)) : entries.slice(0, src.initial);
      propose = new Set(pick.map((e) => e.id));
    }

    // New is what this source did not have last time. A video that was skipped
    // as old stock of a channel still shows up once it lands in the inbox (a
    // playlist).
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
      console.warn(`Check failed: ${src.url}: ${e.message}`);
    }
  }
}

let polling = null;
function poll(force) {
  if (!polling) polling = pollDue(force).finally(() => (polling = null));
  return polling;
}

// ---------------------------------------------------------------- Sending

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
        // "Undo" may have come in between sending and the answer.
        if (v.status === 'yes') {
          v.sentAt = Date.now();
          v.error = null;
        }
      } catch (e) {
        v.attempts = (v.attempts || 0) + 1;
        v.error = e.message;
        if (v.attempts >= 3) v.failed = true;
        else v.sendAt = Date.now() + v.attempts * 60000;
        console.warn(`Sending to MeTube failed: ${v.id}: ${e.message}`);
      }
      save();
    }
  } finally {
    sending = false;
  }
}

// ---------------------------------------------------------------- Duplicates

// Looks in the media folders (each subfolder of MEDIA_DIR is one root) for files
// with the same YouTube ID and the same kind. Nothing is deleted directly:
// "Move to trash" moves into <root>/.tubeswipe-trash, which is only emptied on
// request. Every root has its own trash because roots are usually separate
// mounts and rename does not work across mounts.
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

// Sidecar files (.nfo, .info.json, .webp, -poster.webp …) are named like the
// media file without its extension. A file that belongs to a longer stem is not
// one of this media file's.
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
    groups.sort((a, b) => a.title.localeCompare(b.title));
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
    console.log(`Duplicates: ${groups.length} groups in ${scan.files} files (${state.duplicates.durationMs} ms)`);
  } catch (e) {
    // Keep the old results, but do not scan again right away.
    const old = state.duplicates || { roots: [], files: 0, withId: 0, groups: [], crossKind: 0, unreadable: [], unreadableCount: 0, trash: { files: 0, bytes: 0 } };
    state.duplicates = { ...old, scannedAt: started, durationMs: Date.now() - started, error: e.message };
    console.warn(`Duplicate scan failed: ${e.message}`);
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

function noPermission(where, t) {
  return [403, { error: t('err.noPermission', { where }) }];
}

let trashing = false;

async function trashDuplicate(root, rel, t) {
  if (dupScanning) return [409, { error: t('err.scanRunning') }];
  if (trashing) return [409, { error: t('err.moving') }];
  if (typeof root !== 'string' || typeof rel !== 'string' || !root || !rel) return [400, { error: 'root and rel are required' }];
  const rootDir = path.join(MEDIA_DIR, root);
  const file = path.resolve(rootDir, rel);
  const inside = path.relative(rootDir, file).split(path.sep);
  if (path.dirname(rootDir) !== MEDIA_DIR || root.startsWith('.') || !file.startsWith(rootDir + path.sep) || inside[0] === TRASH_DIR) {
    return [400, { error: t('err.invalidPath') }];
  }
  const d = state.duplicates;
  if (!d || !d.groups.some((g) => g.files.some((f) => f.root === root && f.rel === rel))) {
    return [404, { error: t('err.notInResults') }];
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
      return [410, { error: t('err.fileGone'), left: dropDuplicate(root, rel) }];
    }
    const dir = path.dirname(file);
    const names = await fsp.readdir(dir);
    const base = path.basename(file);
    const stem = stemOf(base);
    // When two media files share a stem (webm and mp4), the sidecar files stay
    // with the remaining one.
    const shared = names.some((n) => n !== base && mediaKind(n) && stemOf(n) === stem);
    const moving = [base, ...(shared ? [] : sidecarsOf(names, stem))];

    const day = localDay();
    let target = path.join(rootDir, TRASH_DIR, day, ...inside.slice(0, -1));
    const taken = await fsp.readdir(target).catch(() => []);
    if (moving.some((n) => taken.includes(n))) target = path.join(rootDir, TRASH_DIR, `${day}-${Date.now()}`, ...inside.slice(0, -1));
    try {
      await fsp.mkdir(target, { recursive: true });
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') return noPermission(root, t);
      throw e;
    }
    let moved = 0;
    for (const n of moving) {
      try {
        await moveFile(path.join(dir, n), path.join(target, n));
        moved++;
      } catch (e) {
        if (e.code === 'ENOENT' && n !== base) continue;
        if (moved === 0 && (e.code === 'EACCES' || e.code === 'EPERM')) return noPermission(where, t);
        if (moved === 0) throw e;
        console.warn(`Sidecar file not moved: ${where}/${n}: ${e.message}`);
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

async function emptyTrash(t) {
  if (dupScanning || trashing) return [409, { error: t('err.scanRunning') }];
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
  if (errors.length) return [500, { error: t('err.trashNotEmpty', { errors: errors.join(', ') }), trash }];
  return { ok: true, trash };
}

// ---------------------------------------------------------------- API

// The preset for yes and the other format offered by swiping up.
function presetPair(src) {
  const yes = src && DOWNLOAD_PRESETS[src.preset] ? src.preset : 'video-best';
  const alt = DOWNLOAD_PRESETS[yes].download_type === 'audio' ? 'video-best' : 'audio-mp3';
  return { yes, alt };
}

// Decisions made before presets were stored by id only carry the MeTube fields.
function presetIdOf(options) {
  if (DOWNLOAD_PRESETS[options.preset]) return options.preset;
  const hit = Object.entries(DOWNLOAD_PRESETS).find(([, p]) => p.download_type === options.download_type && p.format === options.format && p.quality === options.quality);
  return hit ? hit[0] : 'video-best';
}

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
  const { yes, alt } = presetPair(src);
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
    preset: v.options ? presetIdOf(v.options) : null,
    source: src ? src.title : null,
    yesPreset: yes,
    altPreset: alt,
    altType: DOWNLOAD_PRESETS[alt].download_type,
  };
}

function pendingSorted() {
  return Object.values(state.videos)
    .filter((v) => v.status === 'pending')
    .sort((a, b) => b.foundAt - a.foundAt || a.seq - b.seq);
}

const routes = {
  'GET /api/health': () => ({ status: 'ok', commit: COMMIT }),

  'GET /api/config': () => ({ language: LANGUAGE, duplicates: DUPLICATES, commit: COMMIT }),

  'GET /api/status': () => {
    const nextPoll = lastPollAt ? lastPollAt + POLL_MINUTES * 60000 : null;
    return {
      pending: pendingSorted().length,
      sources: state.sources.length,
      polling: !!polling,
      checking,
      nextPoll,
      pollMinutes: POLL_MINUTES,
      duplicates: DUPLICATES && state.duplicates ? state.duplicates.groups.length : 0,
    };
  },

  'GET /api/queue': (req, url) => {
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || 10);
    const all = pendingSorted();
    return { total: all.length, items: all.slice(0, limit).map(videoView) };
  },

  'POST /api/decide': (req, url, body, t) => {
    const v = state.videos[body.id];
    if (!v) return [404, { error: t('err.unknownVideo') }];
    if (!['yes', 'alt', 'no'].includes(body.decision)) return [400, { error: 'decision must be yes, alt or no' }];
    if (v.status === 'yes' && v.sentAt) return [409, { error: t('err.alreadySent') }];
    v.decidedAt = Date.now();
    delete v.sentAt;
    delete v.error;
    delete v.failed;
    delete v.attempts;
    if (body.decision === 'no') {
      v.status = 'no';
      delete v.options;
    } else {
      const pair = presetPair(state.sources.find((s) => s.id === v.sourceId));
      const preset = body.decision === 'alt' ? pair.alt : pair.yes;
      v.status = 'yes';
      v.options = { preset, ...DOWNLOAD_PRESETS[preset] };
      v.sendAt = Date.now() + SEND_DELAY_MS;
    }
    save();
    return { ok: true, sendInSeconds: v.status === 'yes' ? SEND_DELAY_MS / 1000 : null };
  },

  // Back into the stack. If it already went to MeTube, the download stays there.
  'POST /api/undo': (req, url, body, t) => {
    const v = state.videos[body.id];
    if (!v) return [404, { error: t('err.unknownVideo') }];
    const alreadySent = v.status === 'yes' && !!v.sentAt;
    v.status = 'pending';
    v.foundAt = Date.now();
    for (const k of ['decidedAt', 'sentAt', 'sendAt', 'options', 'error', 'failed', 'attempts']) delete v[k];
    save();
    return { ok: true, alreadySent };
  },

  'POST /api/retry': (req, url, body, t) => {
    const v = state.videos[body.id];
    if (!v || v.status !== 'yes' || v.sentAt) return [400, { error: t('err.nothingToRetry') }];
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
    presets: Object.keys(DOWNLOAD_PRESETS),
  }),

  'POST /api/sources': async (req, url, body, t) => {
    const n = normalizeSource(body.url);
    if (n.error) return [400, { error: t(n.error) }];
    if (state.sources.some((s) => s.key === n.key)) return [409, { error: t('err.sourceExists') }];
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
      // A source that cannot be read the first time is not kept.
      state.sources = state.sources.filter((s) => s !== src);
      save();
      return [400, { error: t('err.unreadableSource', { error: e.message }) }];
    }
  },

  'POST /api/check': () => {
    poll(true);
    return { ok: true };
  },
};

const duplicateRoutes = {
  'GET /api/duplicates': () => {
    const d = state.duplicates;
    const nextScan = d && d.scannedAt ? d.scannedAt + DUP_HOURS * 3600000 : null;
    return { ...(d || { groups: [] }), scanning: !!dupScanning, dupHours: DUP_HOURS, nextScan };
  },

  // Answers right away; the page asks again until scanning is false.
  'POST /api/duplicates/scan': () => {
    scanDuplicates();
    return { ok: true, scanning: true };
  },

  'POST /api/duplicates/delete': (req, url, body, t) => trashDuplicate(body.root, body.rel, t),

  'POST /api/duplicates/empty-trash': (req, url, body, t) => emptyTrash(t),
};

if (DUPLICATES) Object.assign(routes, duplicateRoutes);

const sourceRoutes = {
  PATCH: (src, body) => {
    if (body.preset && DOWNLOAD_PRESETS[body.preset]) src.preset = body.preset;
    if (typeof body.paused === 'boolean') src.paused = body.paused;
    save();
    return { source: sourceView(src) };
  },
  // Decisions stay: a no should still count after the source is added again.
  DELETE: (src) => {
    state.sources = state.sources.filter((s) => s !== src);
    for (const [id, v] of Object.entries(state.videos)) {
      if (v.sourceId === src.id && (v.status === 'pending' || v.status === 'skipped')) delete state.videos[id];
    }
    save();
    return { ok: true };
  },
  POST: async (src, body, t) => {
    if (checking === src.id) return [409, { error: t('err.checking') }];
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

function translatorFor(req) {
  return i18n.translator(LANGUAGE !== 'auto' ? LANGUAGE : i18n.pick(req.headers['accept-language']));
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest();
}

const AUTH_DIGEST = AUTH_USER ? digest(`${AUTH_USER}:${AUTH_PASSWORD}`) : null;

// Optional HTTP Basic auth for setups without a login in front of TubeSwipe.
function authorized(req) {
  if (!AUTH_DIGEST) return true;
  const m = String(req.headers.authorization || '').match(/^Basic\s+(\S+)$/i);
  if (!m) return false;
  return crypto.timingSafeEqual(digest(Buffer.from(m[1], 'base64').toString('utf8')), AUTH_DIGEST);
}

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
        reject(Object.assign(new Error('Too large'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!(req.method === 'GET' && url.pathname === '/api/health') && !authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="TubeSwipe", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Authentication required');
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(res, url.pathname);
    }
    // Only accept JSON: a foreign form cannot send this type without a CORS
    // preflight, and the server never answers one.
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'Only application/json' });
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const t = translatorFor(req);
    let handler = routes[`${req.method} ${url.pathname}`];
    let result;
    if (handler) {
      result = await handler(req, url, body, t);
    } else {
      const m = url.pathname.match(/^\/api\/sources\/([\w-]+)$/);
      const src = m && state.sources.find((s) => s.id === m[1]);
      handler = src && sourceRoutes[req.method];
      if (!handler) return send(res, 404, { error: 'Not found' });
      result = await handler(src, body, t);
    }
    if (Array.isArray(result)) send(res, result[0], result[1]);
    else send(res, 200, result);
  } catch (e) {
    console.error(e);
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const extras = [DUPLICATES && `duplicates in ${MEDIA_DIR}`, AUTH_DIGEST && 'basic auth'].filter(Boolean);
  console.log(`TubeSwipe ${COMMIT} on port ${server.address().port}, MeTube ${METUBE_URL}, checking every ${POLL_MINUTES} min${extras.length ? ', ' + extras.join(', ') : ''}`);
});

setTimeout(() => poll(false), 10000);
setInterval(() => poll(false), 60000);
setInterval(sendDue, 2000);
if (DUPLICATES) {
  // Catch up shortly after the start if a scan is due, then look every 10 min.
  setTimeout(dupDue, 30000);
  setInterval(dupDue, 10 * 60000);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flushSave();
    process.exit(0);
  });
}
