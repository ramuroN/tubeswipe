'use strict';
// Starts the real server as a child process against the mock MeTube.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockMetube } = require('./mock-metube.js');

const SERVER = path.join(__dirname, '..', 'server.js');
const CLEAN_ENV = { UI_LANGUAGE: '', DUPLICATES: '', AUTH_USER: '', AUTH_PASSWORD: '', SEND_DELAY_SECONDS: '0' };

function spawnServer(env, state) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tubeswipe-test-'));
  if (state) fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...CLEAN_ENV, PORT: '0', DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  return { child, dataDir, output: () => output };
}

async function startServer(env, state) {
  const proc = spawnServer(env, state);
  const port = await new Promise((resolve, reject) => {
    const look = () => {
      const m = proc.output().match(/on port (\d+)/);
      if (m) resolve(Number(m[1]));
    };
    proc.child.stdout.on('data', look);
    proc.child.on('exit', (code) => reject(new Error(`server exited with ${code}: ${proc.output()}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      proc.child.kill();
      await once(proc.child, 'exit');
      fs.rmSync(proc.dataDir, { recursive: true, force: true });
    },
  };
}

async function call(base, method, route, body, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

async function waitFor(check, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

let metube;
let metubeUrl;

before(async () => {
  metube = createMockMetube();
  metube.server.listen(0);
  await once(metube.server, 'listening');
  metubeUrl = `http://127.0.0.1:${metube.server.address().port}`;
});

after(() => metube.server.close());

test('swiping: add a channel, yes, other format, no and undo', async (t) => {
  const app = await startServer({ METUBE_URL: metubeUrl });
  t.after(() => app.stop());

  const config = await call(app.base, 'GET', '/api/config');
  assert.deepEqual([config.data.language, config.data.duplicates], ['auto', false]);

  const add = await call(app.base, 'POST', '/api/sources', { url: 'https://www.youtube.com/@blender', initial: 3, preset: 'video-1080' });
  assert.equal(add.status, 200);
  assert.equal(add.data.added, 3);
  assert.equal(add.data.source.title, 'Blender');

  const again = await call(app.base, 'POST', '/api/sources', { url: 'https://m.youtube.com/@Blender' });
  assert.equal(again.status, 409);

  const queue = await call(app.base, 'GET', '/api/queue');
  assert.equal(queue.data.total, 3);
  const [first, second, third] = queue.data.items;
  assert.equal(first.id, 'UXqq0ZvbOnk');
  assert.deepEqual([first.yesPreset, first.altPreset, first.altType], ['video-1080', 'audio-mp3', 'audio']);

  metube.added.length = 0;
  await call(app.base, 'POST', '/api/decide', { id: first.id, decision: 'yes' });
  await call(app.base, 'POST', '/api/decide', { id: second.id, decision: 'alt' });
  await waitFor(() => metube.added.length === 2);
  const sent = Object.fromEntries(metube.added.map((b) => [b.url.slice(-11), b]));
  assert.deepEqual(sent[first.id], {
    url: 'https://www.youtube.com/watch?v=' + first.id,
    download_type: 'video',
    format: 'any',
    quality: '1080',
    codec: 'auto',
    folder: '',
    auto_start: true,
  });
  assert.deepEqual([sent[second.id].download_type, sent[second.id].format], ['audio', 'mp3']);

  await call(app.base, 'POST', '/api/decide', { id: third.id, decision: 'no' });
  const history = await call(app.base, 'GET', '/api/history');
  const byId = Object.fromEntries(history.data.items.map((v) => [v.id, v]));
  assert.equal(byId[first.id].preset, 'video-1080');
  assert.equal(byId[second.id].preset, 'audio-mp3');
  assert.ok(byId[first.id].sentAt);
  assert.equal(byId[third.id].status, 'no');

  const undo = await call(app.base, 'POST', '/api/undo', { id: first.id });
  assert.equal(undo.data.alreadySent, true);
  const after = await call(app.base, 'GET', '/api/queue');
  assert.deepEqual(
    after.data.items.map((v) => v.id),
    [first.id],
  );
});

test('errors follow the language of the request', async (t) => {
  const app = await startServer({ METUBE_URL: metubeUrl });
  t.after(() => app.stop());
  const wl = { url: 'https://www.youtube.com/playlist?list=WL' };
  const de = await call(app.base, 'POST', '/api/sources', wl, { 'accept-language': 'de-CH,de;q=0.9' });
  const en = await call(app.base, 'POST', '/api/sources', wl, { 'accept-language': 'en-US' });
  assert.equal(de.status, 400);
  assert.match(de.data.error, /Später ansehen/);
  assert.match(en.data.error, /Watch later/);
  const bad = await call(app.base, 'POST', '/api/sources', { url: 'https://example.com/@x' });
  assert.match(bad.data.error, /youtube\.com/);
});

test('the duplicates tab stays off unless enabled', async (t) => {
  const app = await startServer({ METUBE_URL: metubeUrl });
  t.after(() => app.stop());
  assert.equal((await call(app.base, 'GET', '/api/duplicates')).status, 404);
  assert.equal((await call(app.base, 'POST', '/api/duplicates/empty-trash', {})).status, 404);
});

test('the duplicate finder moves a copy into the trash of its root', async (t) => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'tubeswipe-media-'));
  t.after(() => fs.rmSync(media, { recursive: true, force: true }));
  fs.mkdirSync(path.join(media, 'videos', 'Blender'), { recursive: true });
  fs.mkdirSync(path.join(media, 'archive'));
  fs.writeFileSync(path.join(media, 'videos', 'Blender', 'CHARGE [UXqq0ZvbOnk].mp4'), 'new copy');
  fs.writeFileSync(path.join(media, 'videos', 'Blender', 'CHARGE [UXqq0ZvbOnk].nfo'), '<nfo/>');
  fs.writeFileSync(path.join(media, 'archive', 'CHARGE [UXqq0ZvbOnk].mkv'), 'old copy');
  fs.writeFileSync(path.join(media, 'archive', 'CHARGE [UXqq0ZvbOnk].mp3'), 'audio is another kind');

  const app = await startServer({ METUBE_URL: metubeUrl, DUPLICATES: 'true', MEDIA_DIR: media });
  t.after(() => app.stop());
  assert.equal((await call(app.base, 'GET', '/api/config')).data.duplicates, true);
  await call(app.base, 'POST', '/api/duplicates/scan', {});
  let d;
  async function poll() {
    d = (await call(app.base, 'GET', '/api/duplicates')).data;
    return !d.scanning;
  }
  while (!(await poll())) await new Promise((r) => setTimeout(r, 100));
  assert.equal(d.groups.length, 1);
  assert.equal(d.crossKind, 1);
  const copy = d.groups[0].files.find((f) => f.root === 'videos');
  assert.equal(copy.sidecars, 1);

  const moved = await call(app.base, 'POST', '/api/duplicates/delete', { root: copy.root, rel: copy.rel }, { 'accept-language': 'en' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.moved, 2);
  assert.ok(!fs.existsSync(path.join(media, 'videos', 'Blender', 'CHARGE [UXqq0ZvbOnk].mp4')));
  const trashed = fs.readdirSync(path.join(media, 'videos', '.tubeswipe-trash'), { recursive: true }).map(String);
  assert.ok(trashed.some((n) => n.endsWith('CHARGE [UXqq0ZvbOnk].nfo')));
  assert.equal((await call(app.base, 'GET', '/api/duplicates')).data.groups.length, 0);

  const outside = await call(app.base, 'POST', '/api/duplicates/delete', { root: 'archive', rel: '../videos/x.mp4' }, { 'accept-language': 'de' });
  assert.equal(outside.status, 400);
  assert.equal(outside.data.error, 'Ungültiger Pfad');

  const emptied = await call(app.base, 'POST', '/api/duplicates/empty-trash', {});
  assert.deepEqual(emptied.data.trash, { files: 0, bytes: 0 });
  assert.ok(!fs.existsSync(path.join(media, 'videos', '.tubeswipe-trash')));
});

test('basic auth and a fixed language', async (t) => {
  const app = await startServer({ METUBE_URL: metubeUrl, AUTH_USER: 'swiper', AUTH_PASSWORD: 'secret', UI_LANGUAGE: 'de' });
  t.after(() => app.stop());
  const anonymous = await call(app.base, 'GET', '/');
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /^Basic /);
  assert.equal((await call(app.base, 'GET', '/api/health')).status, 200);
  const wrong = { authorization: 'Basic ' + Buffer.from('swiper:nope').toString('base64') };
  assert.equal((await call(app.base, 'GET', '/api/config', null, wrong)).status, 401);

  const auth = { authorization: 'Basic ' + Buffer.from('swiper:secret').toString('base64') };
  const config = await call(app.base, 'GET', '/api/config', null, auth);
  assert.equal(config.data.language, 'de');
  const wl = await call(app.base, 'POST', '/api/sources', { url: 'https://www.youtube.com/playlist?list=LL' }, { ...auth, 'accept-language': 'en' });
  assert.match(wl.data.error, /Später ansehen/);
});

test('reads decisions stored before presets had ids', async (t) => {
  const state = {
    seq: 1,
    sources: [{ id: 'src-1', kind: 'channel', key: '@blender', url: 'https://www.youtube.com/@blender/videos', title: 'Blender', preset: 'audio-mp3', initialized: true, seen: [] }],
    videos: {
      UXqq0ZvbOnk: {
        id: 'UXqq0ZvbOnk',
        sourceId: 'src-1',
        title: 'CHARGE',
        status: 'yes',
        decidedAt: 1,
        sentAt: 2,
        options: { download_type: 'audio', format: 'mp3', quality: 'best', label: 'Audio MP3' },
      },
    },
  };
  const app = await startServer({ METUBE_URL: metubeUrl }, state);
  t.after(() => app.stop());
  const history = await call(app.base, 'GET', '/api/history');
  assert.equal(history.data.items[0].preset, 'audio-mp3');
  assert.equal(history.data.items[0].altPreset, 'video-best');
});

test('refuses to start with only half of the basic auth settings', async () => {
  const proc = spawnServer({ METUBE_URL: metubeUrl, AUTH_USER: 'swiper' });
  const [code] = await once(proc.child, 'exit');
  fs.rmSync(proc.dataDir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(proc.output(), /AUTH_USER and AUTH_PASSWORD/);
});
