/* Full Drive protocol regressions with real storage, exports and sync code. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const clone = (value) => JSON.parse(JSON.stringify(value));
const initial = () => ({
  version: 4, topics: [{ id: 1, name: 'Walk', msureid: 100 }],
  events: [{ id: 1, topicid: 1, time: 1700000000000, qant: 1, cost: 0, note: '' }],
  measurements: [{ id: 100, name: 'count', type: 0, format: 0 }],
  pendtimes: [], appdata: [], _plotline: {},
});
const extraEvent = (id) => ({ id, topicid: 1, time: 1700000000000 + id, qant: 2, cost: 0, note: '' });
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const windows = [];

async function harness({ local = initial(), remote = initial(), paginated = false,
  staleListings = false, legacy = false, snapshots = false, incomplete = false,
  metadataChurn = false, omitChecksums = false } = {}) {
  const dom = new JSDOM('', { url: 'https://plotline.test/app/', runScripts: 'outside-only',
    pretendToBeVisual: true });
  windows.push(dom.window);
  const w = dom.window;
  w.indexedDB = new IDBFactory();
  w.IDBKeyRange = IDBKeyRange;
  w.AbortController = AbortController;
  w.Response = Response;
  w.CW_CONFIG = { driveClientId: 'test', autoSyncOnStartup: true };
  const files = new Map(), requests = [], safety = [];
  let nextId = 0, writes = 0;
  const oldTime = Date.now() - 24 * 60 * 60 * 1000;
  const add = (file) => {
    const row = { id: `file-${++nextId}`, parents: [], mimeType: 'application/json',
      trashed: false, version: 1, modifiedAt: oldTime, ...file };
    files.set(row.id, row);
    return row;
  };
  const folder = add({ name: legacy ? 'CountWhen' : 'Plotline', mimeType: FOLDER_TYPE });
  const primary = remote && add({ name: legacy ? 'countwhen.json' : 'plotline.json',
    parents: [folder.id], content: JSON.stringify(remote) });
  if (snapshots && primary) {
    for (let i = 1; i <= 5; i++) add({ name: `plotline-${i}.json`, parents: [folder.id],
      content: JSON.stringify({ ...remote, saveddate: `Snapshot ${i}` }) });
  }
  const metadata = (file) => ({
    id: file.id, name: file.name, parents: file.parents, mimeType: file.mimeType,
    trashed: file.trashed, version: String(file.version),
    modifiedTime: new Date(file.modifiedAt).toISOString(),
    ...(file.content == null ? {} : {
      ...(!omitChecksums && { md5Checksum: createHash('md5').update(file.content).digest('hex') }),
      size: String(Buffer.byteLength(file.content)),
    }),
  });
  const index = new Map([...files].map(([id, file]) => [id, metadata(file)]));
  const project = (object, fields) => !fields ? object
    : Object.fromEntries(fields.split(',').filter((key) => Object.hasOwn(object, key))
      .map((key) => [key, object[key]]));
  const touch = (file) => { file.version++; file.modifiedAt = Date.now(); };
  const api = { folder, primary, files, requests, safety, writes: () => writes };
  const response = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
  w.fetch = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    const call = { url, method };
    requests.push(call);
    assert.equal(options.headers.Authorization, 'Bearer protocol-token');
    const intercepted = await api.intercept?.(call, options);
    if (intercepted) return intercepted;
    const fields = url.searchParams.get('fields');
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const name = /name='([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const rows = [...(staleListings ? index.values() : [...files.values()].map(metadata))]
        .filter((file) => !file.trashed && (!name || file.name === name)
          && (!parent || file.parents.includes(parent))
          && (!q.includes("mimeType='") || file.mimeType === FOLDER_TYPE));
      const next = paginated && !url.searchParams.has('pageToken');
      const payload = {
        files: (next ? [] : rows).map((row) => project(row, /files\(([^)]+)\)/.exec(fields)?.[1])),
        ...(next ? { nextPageToken: 'second-page' } : {}), incompleteSearch: incomplete,
      };
      return response(Object.fromEntries(Object.entries(payload).filter(([key]) =>
        !fields || key === 'files' || fields.includes(key))));
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const file = add(JSON.parse(options.body));
      return response(project(metadata(file), fields));
    }
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (upload) {
      let file;
      if (upload[1]) {
        file = files.get(upload[1]);
        assert.ok(file, 'upload must target an existing file');
        assert.equal(method, 'PATCH');
        file.content = options.body;
        touch(file);
      } else {
        assert.equal(method, 'POST');
        assert.equal(url.searchParams.get('uploadType'), 'multipart');
        const boundary = /boundary=([^;]+)/.exec(options.headers['Content-Type'])[1];
        const parts = options.body.split(`--${boundary}`).slice(1, -1)
          .map((part) => part.slice(part.indexOf('\r\n\r\n') + 4).trim());
        file = add({ ...JSON.parse(parts[0]), content: parts[1] });
      }
      writes++;
      const written = project(metadata(file), fields);
      return await api.afterWrite?.(file) || response(written);
    }
    const single = /^\/drive\/v3\/files\/([^/]+)(\/copy)?$/.exec(url.pathname);
    if (single) {
      const file = files.get(decodeURIComponent(single[1]));
      if (!file) return response({ error: { message: 'File not found.', errors: [{ reason: 'notFound' }] } }, 404);
      if (method === 'GET' && metadataChurn && file.content != null) {
        file.version++;
        file.modifiedAt++;
      }
      if (single[2]) {
        const copied = add({ ...file, ...JSON.parse(options.body), id: `file-${++nextId}` });
        return response(project(metadata(copied), fields));
      }
      if (method === 'DELETE') { files.delete(file.id); return response(null, 204); }
      if (method === 'PATCH') { Object.assign(file, JSON.parse(options.body)); touch(file); }
      if (url.searchParams.get('alt') === 'media') return response(JSON.parse(file.content));
      return response(project(metadata(file), fields));
    }
    throw new Error(`Unexpected Drive request: ${method} ${url.pathname}`);
  };
  for (const file of ['db.js', 'import-export.js', 'drive.js']) {
    w.eval(fs.readFileSync(path.join(__dirname, 'js', file), 'utf8'));
  }
  const db = w.CWDB, io = w.CWIO;
  await io.importReplace(local);
  await db.setMeta('driveEnabled', true);
  await db.setMeta('driveToken', { accessToken: 'protocol-token', tokenExpiry: Date.now() + 3600000, clientId: 'test' });
  await db.setMeta('driveLegacyCleanupDone', true);
  if (remote) await db.setMeta('driveSyncBase', initial());
  io.safetyBackup = async () => { safety.push(clone(await io.buildExportObject())); };
  return Object.assign(api, { db, io, drive: w.CWDRIVE, window: w,
    remote: () => JSON.parse([...files.values()].find((file) =>
      !file.trashed && file.name === 'plotline.json').content) });
}

let failures = 0;
let runningTest = null;
process.once('beforeExit', () => {
  if (!runningTest) return;
  console.error('FAIL  unfinished async test: ' + runningTest);
  process.exitCode = 1;
});
async function test(name, action) {
  runningTest = name;
  try { await action(); console.log('  ok  ' + name); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n${error.stack}`); }
  finally {
    while (windows.length) windows.pop().close();
    runningTest = null;
  }
}

(async () => {
  await test('real REST and IndexedDB merge both sides, preserve history, and rotate a full snapshot ring', async () => {
    const local = initial(), remote = initial();
    local.events.push(extraEvent(2)); remote.events.push(extraEvent(3));
    const h = await harness({ local, remote, snapshots: true });
    await h.drive.syncNow();
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2, 3]);
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2, 3]);
    assert.equal(h.writes(), 1);
    assert.equal(h.safety.length, 1);
    assert.equal([...h.files.values()].filter((file) => /^plotline-\d+\.json$/.test(file.name)).length, 5);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
    assert.ok(await h.db.getMeta('lastDriveSync'));
  });
  await test('folder and primary discovery follow an empty first page instead of creating duplicates', async () => {
    const local = initial(), remote = initial();
    local.events.push(extraEvent(2)); remote.events.push(extraEvent(3));
    const h = await harness({ local, remote, paginated: true });
    await h.drive.syncNow();
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2, 3]);
    assert.equal([...h.files.values()].filter((file) => file.mimeType === FOLDER_TYPE).length, 1);
    assert.equal([...h.files.values()].filter((file) => file.name === 'plotline.json').length, 1);
  });
  await test('an updated backup verifies by file ID even while search metadata remains stale', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local, staleListings: true });
    await h.drive.syncNow();
    assert.equal(h.writes(), 1);
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2]);
    assert.ok(await h.db.getMeta('lastDriveSync'));
  });
  await test('upload metadata drift without a content change does not cause repeated writes', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local });
    h.afterWrite = (file) => { file.version++; file.modifiedAt++; };
    await h.drive.syncNow();
    assert.equal(h.writes(), 1);
    assert.equal(h.remote().events.length, 2);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
  });
  await test('metadata changes on every read do not block existing or newly created backups', async () => {
    for (const remote of [initial(), null]) {
      const local = initial();
      local.events.push(extraEvent(2));
      const h = await harness({ local, remote, metadataChurn: true, staleListings: true, snapshots: true });
      await h.drive.syncNow();
      assert.equal(h.writes(), 1);
      assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2]);
      assert.ok(await h.db.getMeta('lastDriveSync'));
      assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
    }
  });
  await test('a metadata-only change during uploaded content readback does not trigger a retry', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local });
    h.intercept = ({ url }) => {
      if (!h.writes() || url.searchParams.get('alt') !== 'media') return;
      h.primary.version++;
      h.primary.modifiedAt++;
    };
    await h.drive.syncNow();
    assert.equal(h.writes(), 1);
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2]);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
    assert.ok(await h.db.getMeta('lastDriveSync'));
  });
  await test('successive local and remote edits sync repeatedly despite metadata-only changes', async () => {
    const h = await harness({ metadataChurn: true });
    for (let i = 0; i < 8; i++) {
      await h.db.putMany('events', [extraEvent(i * 2 + 2)]);
      const remote = JSON.parse(h.primary.content);
      remote.events.push(extraEvent(i * 2 + 3));
      h.primary.content = JSON.stringify(remote);
      await h.drive.syncNow();
      assert.equal(h.remote().events.length, i * 2 + 3);
      assert.equal((await h.db.getAll('events')).length, i * 2 + 3);
      assert.equal((await h.drive.getConnectionState()).error, '');
    }
    assert.equal(h.writes(), 8);
  });
  await test('two independent devices converge after overlapping syncs and repeated edits', async () => {
    const first = await harness({ metadataChurn: true, staleListings: true });
    const second = await harness();
    second.window.fetch = first.window.fetch;
    for (let i = 0; i < 4; i++) {
      await first.db.putMany('events', [extraEvent(i * 2 + 2)]);
      await second.db.putMany('events', [extraEvent(i * 2 + 3)]);
      await Promise.all([first.drive.syncNow(), second.drive.syncNow()]);
      await first.drive.syncNow();
      await second.drive.syncNow();
      const expected = Array.from({ length: i * 2 + 3 }, (_, n) => n + 1);
      assert.deepEqual(first.remote().events.map((row) => row.id).sort((a, b) => a - b), expected);
      for (const device of [first, second]) {
        assert.deepEqual((await device.db.getAll('events')).map((row) => row.id).sort((a, b) => a - b), expected);
        assert.equal((await device.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
        assert.equal((await device.drive.getConnectionState()).error, '');
      }
    }
  });
  await test('one stale media read after upload retries without losing the candidate', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local, metadataChurn: true });
    const stale = h.primary.content;
    let returnedStale = false;
    h.intercept = ({ url }) => {
      if (returnedStale || !h.writes() || url.searchParams.get('alt') !== 'media') return;
      returnedStale = true;
      return new Response(stale);
    };
    await h.drive.syncNow();
    assert.equal(returnedStale, true);
    assert.equal(h.writes(), 2);
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2]);
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2]);
  });
  await test('restore tolerates metadata-only changes without discarding the local safety copy', async () => {
    const remote = initial();
    remote.events.push(extraEvent(2));
    const h = await harness({ remote, metadataChurn: true });
    await h.drive.syncDown({ interactive: false });
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2]);
    assert.equal(h.safety.length, 1);
    assert.equal(h.writes(), 0);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
  });
  await test('missing checksums retain strict revision conflict checks', async () => {
    const h = await harness({ omitChecksums: true, metadataChurn: true });
    await assert.rejects(h.drive.syncNow(), /REMOTE_CONFLICT/);
    assert.equal(h.writes(), 0);
    assert.equal(await h.db.getMeta('lastDriveSync'), null);
    const stable = await harness({ omitChecksums: true });
    await stable.drive.syncNow();
    assert.ok(await stable.db.getMeta('lastDriveSync'));
  });
  await test('a changed checksum is detected even if version and modified time do not change', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local });
    h.afterWrite = (file) => {
      if (h.writes() !== 1) return;
      const remote = JSON.parse(file.content);
      remote.events.push(extraEvent(3));
      file.content = JSON.stringify(remote);
    };
    await h.drive.syncNow();
    assert.equal(h.writes(), 2);
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2, 3]);
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2, 3]);
  });
  await test('continuous content races fail safely and a later retry recovers every addition', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local, metadataChurn: true });
    h.afterWrite = (file) => {
      const remote = JSON.parse(file.content);
      remote.events.push(extraEvent(h.writes() + 2));
      file.content = JSON.stringify(remote);
    };
    await assert.rejects(h.drive.syncNow(), /REMOTE_CONFLICT/);
    assert.equal(h.writes(), 3);
    assert.equal(await h.db.getMeta('lastDriveSync'), null);
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2]);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'pending');
    h.afterWrite = null;
    await h.drive.syncNow();
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2, 3, 4, 5]);
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2, 3, 4, 5]);
    assert.equal((await h.drive.getConnectionState()).error, '');
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
  });
  await test('a first upload verifies by its returned ID before it appears in search', async () => {
    const h = await harness({ remote: null, staleListings: true });
    await h.drive.syncNow();
    assert.equal(h.writes(), 1);
    assert.equal([...h.files.values()].filter((file) => file.name === 'plotline.json').length, 1);
    assert.deepEqual(h.remote().events.map((row) => row.id), [1]);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
  });
  await test('an incomplete Drive search cannot create a replacement folder or backup', async () => {
    const h = await harness({ incomplete: true });
    await assert.rejects(h.drive.syncNow(), /incomplete/i);
    assert.equal(h.writes(), 0);
    assert.equal([...h.files.values()].filter((file) => file.mimeType === FOLDER_TYPE).length, 1);
    assert.equal(await h.db.getMeta('lastDriveSync'), null);
  });
  await test('legacy folder, file names and alert preferences migrate through the complete REST path', async () => {
    for (const cached of [false, true]) {
      const remote = initial();
      remote.events.push(extraEvent(2));
      remote._countwhen = { insightSettings: { alertOn: 'flare' }, futureSetting: { keep: true } };
      delete remote._plotline;
      const h = await harness({ remote, legacy: true, paginated: true });
      if (cached) await h.db.setMeta('driveRemoteMeta', { fileId: h.primary.id });
      await h.drive.syncNow();
      assert.equal(h.files.get(h.folder.id).name, 'Plotline');
      assert.equal(h.files.get(h.primary.id).name, 'plotline.json');
      assert.equal((await h.db.getMeta('insightSettings')).alertOn, 'alert');
      assert.equal(h.remote()._plotline.futureSetting.keep, true);
      assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2]);
    }
  });
  await test('cached backup identity works when search is incomplete; stale IDs rediscover safely', async () => {
    for (const cached of [true, false]) {
      const local = initial();
      local.events.push(extraEvent(2));
      const h = await harness({ local, staleListings: true, incomplete: cached, paginated: !cached });
      await h.db.setMeta('driveFolderId', cached ? h.folder.id : 'deleted-folder');
      await h.db.setMeta('driveRemoteMeta', { fileId: cached ? h.primary.id : 'deleted-file' });
      await h.drive.syncNow();
      assert.equal(h.writes(), 1);
      assert.equal(h.remote().events.length, 2);
      assert.equal([...h.files.values()].filter((file) => file.mimeType === FOLDER_TYPE).length, 1);
      assert.equal((await h.db.getMeta('driveToken')).accessToken, 'protocol-token');
    }
  });
  await test('a server-side concurrent write is merged instead of falsely confirming or dropping it', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local, staleListings: true });
    h.afterWrite = (file) => {
      if (h.writes() !== 1) return;
      const remote = JSON.parse(file.content);
      remote.events.push(extraEvent(3));
      file.content = JSON.stringify(remote);
      file.version++;
    };
    await h.drive.syncNow();
    assert.equal(h.writes(), 2);
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2, 3]);
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2, 3]);
  });
  await test('a concurrent edit during upload readback is detected and merged on retry', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local });
    let changed = false;
    h.intercept = ({ url }) => {
      if (changed || h.writes() !== 1 || url.searchParams.get('alt') !== 'media') return;
      changed = true;
      const before = h.primary.content;
      const remote = JSON.parse(before);
      remote.events.push(extraEvent(3));
      h.primary.content = JSON.stringify(remote);
      h.primary.version++;
      return new Response(before);
    };
    await h.drive.syncNow();
    assert.equal(changed, true);
    assert.equal(h.writes(), 2);
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2, 3]);
    assert.deepEqual((await h.db.getAll('events')).map((row) => row.id).sort(), [1, 2, 3]);
  });
  await test('an uncertain upload retains its exact file ID and failure details for the next retry', async () => {
    const local = initial();
    local.events.push(extraEvent(2));
    const h = await harness({ local, staleListings: true });
    h.afterWrite = () => new Response('{"error":{"message":"Response interrupted"}}', { status: 503 });
    await assert.rejects(h.drive.syncNow(), /Response interrupted/);
    const pending = await h.db.getMeta('drivePendingSnapshot');
    assert.equal(pending.fileId, h.primary.id);
    assert.equal(pending.folderId, h.folder.id);
    assert.equal(pending.status, 'pending');
    const failure = await h.db.getMeta('driveLastFailure');
    assert.equal(failure.step, 'uploading the backup');
    assert.match(failure.message, /Response interrupted/);
    assert.equal(await h.db.getMeta('lastDriveSync'), null);
    const exported = await h.io.buildExportObject();
    assert.equal(exported._plotline.driveLastFailure, undefined, 'diagnostics must stay on this device');
    h.afterWrite = null;
    await h.drive.syncNow();
    assert.equal(await h.db.getMeta('driveLastFailure'), null);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
    assert.deepEqual(h.remote().events.map((row) => row.id).sort(), [1, 2]);
    assert.equal([...h.files.values()].filter((file) => file.name === 'plotline.json').length, 1);
  });
  await test('invalid remote content and malformed upload confirmation never advance last synced', async () => {
    for (const invalid of ['content', 'confirmation']) {
      const local = initial(), remote = initial();
      if (invalid === 'content') remote.events[0].topicid = 999;
      const h = await harness({ local, remote });
      const lastSync = Date.now() - 14 * 60 * 60 * 1000;
      await h.db.setMeta('lastDriveSync', lastSync);
      if (invalid === 'confirmation') h.afterWrite = () => new Response('{}');
      await assert.rejects(h.drive.syncNow(), invalid === 'content' ? /INVALID_REMOTE/ : /invalid upload confirmation/);
      assert.equal(await h.db.getMeta('lastDriveSync'), lastSync);
      assert.equal((await h.drive.getConnectionState()).lastSync, lastSync);
      assert.deepEqual(clone(await h.db.getAll('events')), local.events);
      assert.ok((await h.db.getMeta('drivePendingSnapshot')).snapshot);
      assert.equal(h.writes(), invalid === 'content' ? 0 : 1);
    }
  });
  await test('19,130-event history completes REST verification despite upload metadata drift', async () => {
    const local = initial();
    local.events = Array.from({ length: 19130 }, (_, i) => ({
      ...extraEvent(i + 1), note: 'Synthetic history - multibyte \u00e9 \u2615',
    }));
    const remote = clone(local);
    local.events.push(extraEvent(19131)); remote.events.push(extraEvent(19132));
    const h = await harness({ local, remote, staleListings: true, paginated: true, metadataChurn: true });
    h.afterWrite = (file) => { file.version++; file.modifiedAt++; };
    await h.drive.syncNow();
    assert.equal(h.writes(), 1);
    assert.equal(h.remote().events.length, 19132);
    assert.equal((await h.db.getAll('events')).length, 19132);
    assert.equal((await h.db.getMeta('driveSyncBase')).events.length, 19132);
    assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'confirmed');
  });
  if (failures) process.exitCode = 1;
  else console.log('Drive REST workflows passing');
})().catch((error) => { console.error(error); process.exitCode = 1; });
