#!/usr/bin/env node
/* Smoke test for the Drive snapshot-rotation and legacy-cleanup logic.
 * Runs js/drive.js against an in-memory fake of the Drive v3 REST API. */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ---- fake Drive ---- */
let nextId = 1;
let files = new Map(); // id -> {id,name,mimeType,parents,trashed,content}
let calls = { copy: 0, rename: 0, delete: 0, trash: 0 };

/* Virtual clock: rotation is time-gated, so tests need to move time by hand. */
const T0 = Date.parse('2026-01-01T00:00:00Z');
let clock = T0;
Date.now = () => clock;
const NOW = () => new Date(clock).toISOString();
const advanceHours = (h) => { clock += h * 60 * 60 * 1000; };

function reset() {
  nextId = 1; files = new Map(); clock = T0;
  calls = { copy: 0, rename: 0, delete: 0, trash: 0 };
}
function add(f) {
  const id = 'f' + nextId++;
  files.set(id, { id, trashed: false, parents: [], modifiedTime: NOW(), ...f });
  return id;
}
const md5 = (s) => require('crypto').createHash('md5').update(s || '').digest('hex');
function meta(f) {
  return {
    id: f.id, name: f.name, modifiedTime: f.modifiedTime,
    md5Checksum: f.mimeType === 'application/vnd.google-apps.folder' ? undefined : md5(f.content),
    size: String((f.content || '').length),
  };
}
function matches(f, q) {
  if (/trashed=false/.test(q) && f.trashed) return false;
  const name = /name='([^']+)'/.exec(q);
  if (name && f.name !== name[1]) return false;
  const parent = /'([^']+)' in parents/.exec(q);
  if (parent && !(f.parents || []).includes(parent[1])) return false;
  const isFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(q);
  if (isFolder && f.mimeType !== 'application/vnd.google-apps.folder') return false;
  return true;
}

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const p = u.pathname;
  const body = opts.body ? JSON.parse(opts.body) : null;
  const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => '' });

  if (p === '/drive/v3/files' && (!opts.method || opts.method === 'GET')) {
    const q = decodeURIComponent(u.searchParams.get('q') || '');
    return ok({ files: [...files.values()].filter((f) => matches(f, q)).map(meta) });
  }
  if (p === '/drive/v3/files' && opts.method === 'POST') {
    return ok({ id: add(body) });
  }
  const copy = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(p);
  if (copy) {
    calls.copy++;
    const src = files.get(copy[1]);
    return ok({ id: add({ ...body, mimeType: src.mimeType, content: src.content }) });
  }
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (one) {
    const f = files.get(one[1]);
    if (opts.method === 'DELETE') { calls.delete++; files.delete(one[1]); return ok({}); }
    if (opts.method === 'PATCH') {
      if (body && body.trashed) { calls.trash++; f.trashed = true; }
      else if (body && body.name) { calls.rename++; f.name = body.name; }
      return ok({ id: f.id });
    }
    if (u.searchParams.get('alt') === 'media') return ok(JSON.parse(f.content));
  }
  throw new Error('unhandled fake Drive request: ' + opts.method + ' ' + p);
};

/* ---- browser + app globals drive.js expects at load ---- */
const metaStore = new Map();
global.window = {
  addEventListener() {},
  CW_CONFIG: { driveClientId: 'test', wifiOnly: false },
};
global.navigator = {};
global.document = {
  querySelector: () => null, getElementById: () => null,
  createElement: () => ({ addEventListener() {} }),
  head: { appendChild() {} },
};
global.CWDB = window.CWDB = {
  async getMeta(k, fb = null) { return metaStore.has(k) ? metaStore.get(k) : fb; },
  async setMeta(k, v) { metaStore.set(k, v); },
};
global.CWIO = window.CWIO = {};

const src = fs.readFileSync(path.join(__dirname, 'js', 'drive.js'), 'utf8');
const probe = `
window.__test = { rotateVersions, cleanupLegacyArtifacts, maybeCleanupLegacyArtifacts,
                  findFileInFolder, DRIVE_MAX_VERSIONS, DRIVE_MIN_SNAPSHOT_GAP_MS };
`;
new Function(src + probe)();
const T = window.__test;

/* ---- helpers ---- */
const FOLDER = () => add({ name: 'CountWhen', mimeType: 'application/vnd.google-apps.folder' });
const json = (n) => JSON.stringify({ events: [n] });
const namesIn = (fid) => [...files.values()]
  .filter((f) => !f.trashed && (f.parents || []).includes(fid))
  .map((f) => f.name).sort();

let failures = 0;
async function test(name, fn) {
  reset();
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

(async () => {
  console.log('drive rotation + legacy cleanup');

  await test('rotation snapshots the primary file on first run', async () => {
    const fid = FOLDER();
    const cur = add({ name: 'countwhen.json', parents: [fid], content: json(1) });
    await T.rotateVersions(fid, cur, md5(json(1)));
    assert.deepStrictEqual(namesIn(fid), ['countwhen-1.json', 'countwhen.json']);
  });

  await test('repeat sync with unchanged contents does not cut a new snapshot', async () => {
    const fid = FOLDER();
    const cur = add({ name: 'countwhen.json', parents: [fid], content: json(1) });
    for (let i = 0; i < 6; i++) await T.rotateVersions(fid, cur, md5(json(1)));
    assert.deepStrictEqual(namesIn(fid), ['countwhen-1.json', 'countwhen.json']);
    assert.strictEqual(calls.copy, 1, 'expected exactly one copy, got ' + calls.copy);
  });

  await test('changed contents still rotate once the gap has passed', async () => {
    const fid = FOLDER();
    const cur = add({ name: 'countwhen.json', parents: [fid], content: json(1) });
    await T.rotateVersions(fid, cur, md5(json(1)));
    advanceHours(13);
    files.get(cur).content = json(2);
    await T.rotateVersions(fid, cur, md5(json(2)));
    assert.deepStrictEqual(namesIn(fid),
      ['countwhen-1.json', 'countwhen-2.json', 'countwhen.json']);
    const snap1 = [...files.values()].find((f) => f.name === 'countwhen-1.json');
    const snap2 = [...files.values()].find((f) => f.name === 'countwhen-2.json');
    assert.strictEqual(snap1.content, json(2));
    assert.strictEqual(snap2.content, json(1));
  });

  await test('changed contents inside the gap do not cut a snapshot', async () => {
    const fid = FOLDER();
    const cur = add({ name: 'countwhen.json', parents: [fid], content: json(0) });
    await T.rotateVersions(fid, cur, md5(json(0)));
    for (let i = 1; i <= 20; i++) {   // a busy afternoon of real edits
      advanceHours(0.5);
      files.get(cur).content = json(i);
      await T.rotateVersions(fid, cur, md5(json(i)));
    }
    assert.deepStrictEqual(namesIn(fid), ['countwhen-1.json', 'countwhen.json']);
    assert.strictEqual(calls.copy, 1, 'expected 1 copy, got ' + calls.copy);
  });

  await test('five slots reach back more than two days', async () => {
    const fid = FOLDER();
    const cur = add({ name: 'countwhen.json', parents: [fid], content: json(0) });
    for (let i = 1; i <= 60; i++) {   // 30 days of hourly edits
      advanceHours(12);
      files.get(cur).content = json(i);
      await T.rotateVersions(fid, cur, md5(json(i)));
    }
    const oldest = [...files.values()]
      .filter((f) => !f.trashed && /countwhen-\d+\.json/.test(f.name))
      .sort((a, b) => Date.parse(a.modifiedTime) - Date.parse(b.modifiedTime))[0];
    const spanDays = (clock - Date.parse(oldest.modifiedTime)) / 86400000;
    assert.ok(spanDays >= 2, 'oldest snapshot only ' + spanDays.toFixed(1) + ' days back');
  });

  await test('rotation never keeps more than DRIVE_MAX_VERSIONS snapshots', async () => {
    const fid = FOLDER();
    const cur = add({ name: 'countwhen.json', parents: [fid], content: json(0) });
    for (let i = 1; i <= 9; i++) {
      advanceHours(13);
      files.get(cur).content = json(i);
      await T.rotateVersions(fid, cur, md5(json(i)));
    }
    const snaps = namesIn(fid).filter((n) => /countwhen-\d+\.json/.test(n));
    assert.strictEqual(snaps.length, T.DRIVE_MAX_VERSIONS);
  });

  await test('legacy duplicate primary file is trashed, current kept', async () => {
    const fid = FOLDER();
    add({ name: 'countwhen.json', parents: [fid], content: json(1) });
    add({ name: 'whendidibk.json', parents: [fid], content: json(0) });
    const res = await T.cleanupLegacyArtifacts(fid);
    assert.deepStrictEqual(namesIn(fid), ['countwhen.json']);
    assert.strictEqual(calls.trash, 1);
    assert.strictEqual(res.found, 1);
  });

  await test('orphan legacy file with no counterpart is renamed, not trashed', async () => {
    const fid = FOLDER();
    add({ name: 'whendidibk-2.json', parents: [fid], content: json(0) });
    await T.cleanupLegacyArtifacts(fid);
    assert.deepStrictEqual(namesIn(fid), ['countwhen-2.json']);
    assert.strictEqual(calls.trash, 0);
    assert.strictEqual(calls.rename, 1);
  });

  await test('empty legacy folder is trashed', async () => {
    const fid = FOLDER();
    const legacy = add({ name: 'WhenDidI', mimeType: 'application/vnd.google-apps.folder' });
    await T.cleanupLegacyArtifacts(fid);
    assert.strictEqual(files.get(legacy).trashed, true);
  });

  await test('legacy folder holding data is left alone', async () => {
    const fid = FOLDER();
    const legacy = add({ name: 'WhenDidI', mimeType: 'application/vnd.google-apps.folder' });
    add({ name: 'whendidibk.json', parents: [legacy], content: json(0) });
    await T.cleanupLegacyArtifacts(fid);
    assert.strictEqual(files.get(legacy).trashed, false, 'legacy folder with data was trashed');
  });

  await test('cleanup is not repeated once a clean pass finds nothing', async () => {
    metaStore.clear();
    const fid = FOLDER();
    add({ name: 'countwhen.json', parents: [fid], content: json(1) });
    await T.maybeCleanupLegacyArtifacts(fid);
    assert.strictEqual(await CWDB.getMeta('driveLegacyCleanupDone'), true);
    metaStore.set('driveLegacyCleanupAt', 0);
    add({ name: 'whendidibk.json', parents: [fid], content: json(0) });
    await T.maybeCleanupLegacyArtifacts(fid);
    assert.ok(namesIn(fid).includes('whendidibk.json'), 'sweep ran again after being marked done');
  });

  await test('cleanup is throttled to once a day', async () => {
    metaStore.clear();
    const fid = FOLDER();
    add({ name: 'countwhen.json', parents: [fid], content: json(1) });
    add({ name: 'whendidibk.json', parents: [fid], content: json(0) });
    await T.maybeCleanupLegacyArtifacts(fid);
    assert.strictEqual(calls.trash, 1);
    add({ name: 'whendidibk-1.json', parents: [fid], content: json(0) });
    add({ name: 'countwhen-1.json', parents: [fid], content: json(1) });
    await T.maybeCleanupLegacyArtifacts(fid);
    assert.strictEqual(calls.trash, 1, 'second sweep ran inside the 24h window');
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
