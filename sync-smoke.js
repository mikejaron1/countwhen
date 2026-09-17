#!/usr/bin/env node
/* Offline sync integration checks. No Google account or network is used. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const source = fs.readFileSync(require('path').join(__dirname, 'js/drive.js'), 'utf8');
const ioContext = { window: {} };
vm.createContext(ioContext);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, 'js/db.js'), 'utf8'), ioContext);
ioContext.CWDB = ioContext.window.CWDB;
vm.runInContext(fs.readFileSync(require('path').join(__dirname, 'js/import-export.js'), 'utf8'), ioContext);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const backup = (overrides = {}) => ({
  version: 4, topics: [{ id: 1, name: 'Walk', msureid: 1 }], events: [], measurements: [{ id: 1, name: 'count' }],
  pendtimes: [], appdata: [], _plotline: {}, ...overrides,
});
const event = (id, amount = 1) => ({ id, topicid: 1, time: 1000, amount });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function completesWhileBlocked(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('local mutation waited for network')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

async function editLocal(h, change, stamped = true) {
  return h.api.withDataLock(async () => {
    await change();
    const db = h.db || h.browser.CWDB;
    if (stamped) await db.setMeta('dataRevision', (await db.getMeta('dataRevision', 0)) + 1);
    await db.setMeta('lastLocalChangeAt', Date.now());
  });
}

function harness(initial = backup(), remote = clone(initial)) {
  const meta = new Map([['driveEnabled', true], ['driveSyncBase', clone(initial)], ['dataRevision', 1]]);
  const state = { local: clone(initial), remote: clone(remote), revision: 1,
    reads: 0, writes: 0, auth: 0, applies: 0, safety: 0, locks: [], lockDepth: 0, statuses: [] };
  let lockQueue = Promise.resolve();
  const stat = () => state.remote ? {
    id: 'primary', version: String(state.revision), modifiedTime: '2026-01-01T00:00:00Z',
    md5Checksum: String(state.revision),
  } : null;
  const browser = {
    console, setTimeout, clearTimeout, URL, Blob,
    navigator: { onLine: true, locks: { request(name, opts, fn) {
      state.locks.push([name, opts.mode]);
      const result = lockQueue.then(async () => {
        state.lockDepth++;
        try { return await fn(); } finally { state.lockDepth--; }
      });
      lockQueue = result.catch(() => {}); return result;
    } } },
    document: { visibilityState: 'visible', addEventListener() {}, getElementById() { return null; } },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } },
    window: { CW_CONFIG: { driveClientId: 'test', autoSyncOnChange: true, autoSyncOnStartup: true },
      addEventListener() {}, dispatchEvent(e) { state.statuses.push(e); } },
    CWDB: { normalizeInsightSettings: ioContext.CWDB.normalizeInsightSettings,
      async getMeta(key, fallback = null) { return meta.has(key) ? clone(meta.get(key)) : fallback; },
      async setMeta(key, value) { meta.set(key, clone(value)); },
      async markChange(minimumRevision = 0, { local = true } = {}) {
        const revision = Math.max(meta.get('dataRevision') || 0, minimumRevision) + 1;
        meta.set('dataRevision', revision);
        if (local) meta.set('lastLocalChangeAt', Date.now());
        return revision;
      } },
    CWIO: {
      async buildExportObject() { state.reads++; await state.onBuild?.(); return clone(state.local); },
      validateBackup: ioContext.window.CWIO.validateBackup,
      async safetyBackup() { assert.equal(state.lockDepth, 0); state.safety++; await state.onSafety?.(); },
      async checkTimerReplacement() {},
      async importReplace(o) {
        await state.onApply?.(); state.applies++; state.local = clone(o);
      },
    },
    hooks: {
      async auth() { assert.equal(state.lockDepth, 0); state.auth++; await state.onAuth?.(); return 'fake'; },
      async stat() { assert.equal(state.lockDepth, 0); await state.onStat?.(); return clone(stat()); },
      async read() { assert.equal(state.lockDepth, 0); await state.onRead?.(); return clone(state.remote); },
      async write(id, obj) {
        assert.equal(state.lockDepth, 0);
        state.writes++; state.remote = clone(obj); state.revision++;
        const result = stat();
        await state.onWrite?.();
        return result;
      },
      async rotate() { assert.equal(state.lockDepth, 0); await state.onRotate?.(); },
      async cleanup() { assert.equal(state.lockDepth, 0); await state.onCleanup?.(); },
    },
  };
  vm.createContext(browser);
  vm.runInContext(source + `
    window.originalTokenRequest = _requestToken;
    getTokenInteractive = hooks.auth;
    getTokenSilent = hooks.auth;
    findOrCreateFolder = async () => 'folder';
    statSyncFile = hooks.stat;
    readSyncFile = hooks.read;
    updateSyncFile = hooks.write;
    createSyncFile = async (folder, obj) => hooks.write(null, obj);
    rotateVersions = hooks.rotate;
    maybeCleanupLegacyArtifacts = hooks.cleanup;
    window.compare = comparableBackup;
  `, browser);
  return { api: browser.window.CWDRIVE, state, meta, browser };
}

const storageWindows = [];
async function storageHarness() {
  const h = harness();
  const dom = new JSDOM('', { url: 'https://sync.test/', runScripts: 'outside-only' });
  storageWindows.push(dom.window);
  dom.window.indexedDB = new IDBFactory();
  dom.window.IDBKeyRange = IDBKeyRange;
  for (const file of ['db.js', 'import-export.js']) {
    dom.window.eval(fs.readFileSync(require('path').join(__dirname, 'js', file), 'utf8'));
  }
  const db = dom.window.CWDB, io = dom.window.CWIO;
  await io.importReplace({ topics: [{ id: 1, name: 'Local duration', msureid: 10, type: 1 }],
    events: [], _plotline: { topicKinds: { 1: 'duration' } } });
  const local = clone(await io.buildExportObject());
  await db.setMeta('driveEnabled', true);
  await db.setMeta('driveSyncBase', local);
  h.state.local = local; h.state.remote = clone(local);
  h.browser.CWDB = db;
  h.browser.CWIO = {
    ...io,
    async buildExportObject() { h.state.reads++; return io.buildExportObject(); },
    async safetyBackup() { assert.equal(h.state.lockDepth, 0); h.state.safety++; await h.state.onSafety?.(); },
    async importReplace(obj, options) {
      await h.state.onApply?.();
      await io.importReplace(obj, options);
      h.state.applies++;
      h.state.local = clone(await io.buildExportObject());
    },
  };
  return { ...h, db, io };
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n' + e.stack); }
  finally { while (storageWindows.length) storageWindows.pop().close(); }
}

(async () => {
  await test('real storage: legacy remote alert thresholds sync and restore in every namespace', async () => {
    for (const namespace of ['_plotline', '_countwhen', '_wdapp']) {
      const h = await storageHarness();
      const app = h.state.remote._plotline;
      delete h.state.remote._plotline;
      app.insightSettings = { alertOn: 'flare', alertsEnabled: false, cutoffHour: 4 };
      h.state.remote[namespace] = app;
      const events = clone(h.state.remote.events);
      await h.api.syncNow();
      assert.equal((await h.db.getMeta('insightSettings')).alertOn, 'alert');
      assert.equal(h.state.remote._plotline.insightSettings.alertOn, 'alert');
      assert.deepEqual(h.state.remote.events, events);
      h.state.remote._plotline.insightSettings.alertOn = 'flare';
      await h.api.syncDown();
      assert.equal((await h.db.getMeta('insightSettings')).alertOn, 'alert');
      assert.equal((await h.io.buildExportObject())._plotline.insightSettings.alertOn, 'alert');
    }
  });
  await test('legacy flare and current alert compare equally without overriding a local watch preference', async () => {
    const base = backup({ _plotline: { insightSettings: { alertOn: 'flare', alertsEnabled: false } } });
    const remote = clone(base);
    remote._plotline.insightSettings.alertOn = 'alert';
    const h = harness(base, remote);
    h.state.local._plotline.insightSettings.alertOn = 'watch';
    const result = await h.api.syncNow();
    assert.equal(h.state.remote._plotline.insightSettings.alertOn, 'watch');
    assert.equal(result.stats.conflicts, 0);
  });
  await test('invalid remote alert thresholds still reject without overwriting either dataset', async () => {
    const h = await storageHarness();
    h.state.remote._plotline.insightSettings = { alertOn: 'bogus' };
    const before = clone(await h.db.getDataset());
    await assert.rejects(h.api.syncNow(), /INVALID_REMOTE: alertOn: invalid alert level/);
    assert.equal(h.state.writes, 0);
    assert.deepEqual(clone(await h.db.getAll('topics')), before.topics);
    assert.deepEqual(clone(await h.db.getAll('events')), before.events);
    assert.equal(await h.db.getMeta('insightSettings'), null);
  });
  await test('real storage: ordinary metadata/event sync preserves a running timer; restore clears it', async () => {
    const h = await storageHarness();
    await h.db.startTimer(1, 1000);
    h.state.remote._plotline.topicMeta = { 1: { color: '#123456' } };
    h.state.remote.events = [{ id: 2, topicid: 1, time: 2000, qant: 60 }];
    assert.equal((await h.api.syncNow()).changedLocally, true);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
    assert.equal((await h.db.getAll('events')).length, 1);
    assert.equal((await h.db.getMeta('topicMeta'))[1].color, '#123456');
    assert.equal(h.state.remote._plotline.activeTimers, undefined);
    await h.api.syncDown();
    assert.equal(await h.db.getMeta('activeTimers'), null);
    assert.deepEqual(h.state.locks, Array.from({ length: 5 }, () => ['plotline-data', 'exclusive']));
  });
  await test('real storage: colliding duration topics preserve the timer on the moved local topic', async () => {
    const h = await storageHarness();
    const base = clone(h.state.local); base.topics = []; base._plotline.topicKinds = {};
    await h.db.setMeta('driveSyncBase', base);
    await h.db.startTimer(1, 1000);
    h.state.remote.topics[0].name = 'Unrelated remote duration';
    let firstMovedId;
    h.state.onWrite = () => {
      if (h.state.writes === 1) {
        const moved = h.state.remote.topics.find((t) => t.name === 'Local duration');
        firstMovedId = moved.id;
        moved.name = 'Another concurrent remote duration';
        h.state.remote._plotline.dayChecks = { '2026-01-02': 'none' };
        h.state.revision++;
      }
    };
    await h.api.syncNow();
    const moved = (await h.db.getAll('topics')).find((t) => t.name === 'Local duration');
    assert.notEqual(moved.id, 1);
    assert.notEqual(moved.id, firstMovedId, 'successive collisions compose rather than resetting timer provenance');
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { [moved.id]: 1000 });
    assert.equal(h.state.writes, 2, 'identity survives upload verification retries');
    const event = await h.db.finishTimer(moved.id, 6000);
    assert.equal(event.topicid, moved.id);
    assert.equal(event.qant, 5);
  });
  await test('real storage: measurement collisions remap timer units without changing duration semantics', async () => {
    const h = await storageHarness();
    const base = clone(h.state.local);
    base.topics = []; base._plotline.topicKinds = {};
    base.measurements = base.measurements.filter((m) => m.id !== 10);
    await h.db.setMeta('driveSyncBase', base);
    await h.db.startTimer(1, 1000);
    const unit = h.state.remote.measurements.find((m) => m.id === 10);
    unit.name = 'Remote count'; unit.type = 0; unit.format = 0;
    h.state.remote.topics[0].name = 'Remote amount';
    h.state.remote._plotline.topicKinds[1] = 'amount';
    await h.api.syncNow();
    const moved = (await h.db.getAll('topics')).find((t) => t.name === 'Local duration');
    assert.notEqual(moved.id, 1);
    assert.notEqual(moved.msureid, 10);
    assert.equal((await h.db.get('measurements', moved.msureid)).type, 3);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { [moved.id]: 1000 });
  });
  await test('real storage: collision provenance survives a failed upload and subsequent sync', async () => {
    const h = await storageHarness();
    const base = clone(h.state.local); base.topics = []; base._plotline.topicKinds = {};
    await h.db.setMeta('driveSyncBase', base);
    await h.db.startTimer(1, 1000);
    h.state.remote.topics[0].name = 'Remote duration';
    h.state.onWrite = () => { throw new Error('network interrupted'); };
    await assert.rejects(h.api.syncNow(), /network interrupted/);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
    h.state.onWrite = null;
    await h.api.syncNow();
    const moved = (await h.db.getAll('topics')).find((t) => t.name === 'Local duration');
    assert.notEqual(moved.id, 1);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { [moved.id]: 1000 });
  });
  await test('real storage: incompatible remote timer kind, unit, format or deletion rejects without data loss', async () => {
    for (const change of [
      (b) => { b._plotline.topicKinds[1] = 'amount'; },
      (b) => { b.topics[0].msureid = 8; },
      (b) => { b.measurements.find((m) => m.id === 10).type = 0; },
      (b) => { b.measurements.find((m) => m.id === 10).format = 7; },
      (b) => { b.topics = []; b._plotline.topicKinds = {}; },
    ]) {
      const h = await storageHarness();
      await h.db.startTimer(1, 1000);
      const before = clone(await h.db.getDataset());
      const base = clone(await h.db.getMeta('driveSyncBase'));
      change(h.state.remote);
      await assert.rejects(h.api.syncNow(), /TIMER_CONFLICT/);
      assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
      assert.deepEqual(clone(await h.db.getAll('topics')), before.topics);
      assert.deepEqual(clone(await h.db.getAll('measurements')), before.measurements);
      assert.deepEqual(clone(await h.db.getMeta('driveSyncBase')), base);
      assert.equal(h.state.writes, 0);
      assert.equal(h.state.applies, 0);
      assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'pending');
      assert.equal(h.state.statuses.at(-1).detail.status, 'error');
    }
  });
  await test('metadata-only remote changes are applied atomically', async () => {
    const h = harness();
    h.state.remote._plotline = { topicPrefs: { 1: { quickAmount: 4 } }, dayChecks: { '2026-01-02': 'none' } };
    const result = await h.api.syncNow();
    assert.equal(result.changedLocally, true);
    assert.equal(h.state.applies, 1);
    assert.equal(h.state.local._plotline.topicPrefs[1].quickAmount, 4);
    assert.equal(h.state.local._plotline.dayChecks['2026-01-02'], 'none');
  });
  await test('sync replacements advance revision without pretending remote changes were local edits', async () => {
    const h = harness();
    h.meta.set('dataRevision', 10);
    h.meta.set('lastLocalChangeAt', 1234);
    const markChange = h.browser.CWDB.markChange;
    h.browser.CWDB.markChange = async (minimumRevision, options) => {
      assert.equal(h.state.lockDepth, 1, 'revision must be stamped before releasing the apply lock');
      assert.equal(h.state.applies, minimumRevision - 9);
      return markChange(minimumRevision, options);
    };
    await h.api.syncNow();
    assert.equal(h.meta.get('dataRevision'), 10, 'unchanged upload does not invalidate UI caches');
    assert.equal(h.meta.get('lastLocalChangeAt'), 1234, 'unchanged upload does not stamp a change');
    h.state.remote.events.push(event(3)); h.state.revision++;
    await h.api.syncNow();
    assert.equal(h.meta.get('dataRevision'), 11);
    await h.api.syncDown();
    assert.equal(h.meta.get('dataRevision'), 12, 'explicit restore replaces records even when contents match');
    assert.equal(h.meta.get('lastLocalChangeAt'), 1234);
    assert.ok(h.meta.get('lastDriveSync') >= h.meta.get('lastLocalChangeAt'));
  });
  await test('failed local apply does not advance the model revision', async () => {
    const h = harness();
    h.state.remote.events.push(event(3));
    h.state.onApply = () => { throw new Error('transaction aborted'); };
    await assert.rejects(h.api.syncNow(), /transaction aborted/);
    assert.equal(h.meta.get('dataRevision'), 1);
    assert.equal(h.state.applies, 0);
  });
  await test('real storage sync and restore revisions remain monotonic', async () => {
    const h = await storageHarness();
    await h.db.setMeta('dataRevision', 40);
    h.state.remote.events.push({ id: 3, topicid: 1, time: 2000, qant: 60 });
    await h.api.syncNow();
    assert.equal(await h.db.getMeta('dataRevision'), 41);
    await h.api.syncDown();
    assert.equal(await h.db.getMeta('dataRevision'), 42);
  });
  await test('afterSync uses the model refresh queue instead of racing reload/render with a mutation', async () => {
    const h = harness();
    const blocked = deferred(), started = deferred();
    const calls = [];
    h.browser.window.CWAPP = {
      reload() { throw new Error('direct reload must not bypass the model'); },
      renderCurrent() { throw new Error('direct render must not replace busy controls'); },
      snack() { calls.push('snack'); },
    };
    h.browser.window.CWMODEL = {
      refresh() { return h.api.withDataLock(() => { calls.push('refresh'); }); },
    };
    const mutation = h.api.withDataLock(async () => {
      started.resolve(); await blocked.promise; calls.push('mutation');
    });
    await started.promise;
    const refresh = h.api.afterSync({ action: 'merged', changedLocally: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, []);
    blocked.resolve();
    await Promise.all([mutation, refresh]);
    assert.deepEqual(calls, ['mutation', 'refresh', 'snack']);
    await h.api.afterSync({ action: 'merged', changedLocally: false });
    assert.equal(calls.length, 3);
  });
  await test('afterSync retains direct reload/render only when no model exists', async () => {
    const h = harness(), calls = [];
    h.browser.window.CWAPP = {
      async reload() { calls.push('reload'); },
      renderCurrent() { calls.push('render'); },
      snack() { calls.push('snack'); },
    };
    await h.api.afterSync({ action: 'merged', changedLocally: true });
    assert.deepEqual(calls, ['reload', 'render', 'snack']);
  });
  await test('portable maps merge separate topics, days, and nested fields', async () => {
    const h = harness();
    const b = backup({ _plotline: { topicPrefs: { 1: { quickAmount: 1, aggregation: 'sum' } },
      topicGoals: { 1: { target: 3, paused: false } }, dayChecks: {} } });
    const l = clone(b), r = clone(b);
    l._plotline.topicPrefs[1].quickAmount = 5;
    r._plotline.topicPrefs[1].aggregation = 'mean';
    l._plotline.topicGoals[1].paused = true;
    r._plotline.topicGoals[1].target = 10;
    l._plotline.dayChecks['2026-01-01'] = 'complete';
    r._plotline.dayChecks['2026-01-02'] = 'none';
    const { merged, stats } = h.api.mergeBackups(b, l, r);
    assert.deepEqual(clone(merged._plotline.topicPrefs[1]), { quickAmount: 5, aggregation: 'mean' });
    assert.deepEqual(clone(merged._plotline.topicGoals[1]), { target: 10, paused: true });
    assert.equal(Object.keys(merged._plotline.dayChecks).length, 2);
    assert.equal(stats.conflicts, 0);
  });
  await test('metadata deletion versus unchanged remote is preserved', async () => {
    const h = harness();
    const b = backup({ _plotline: { topicPrefs: { 1: { quickAmount: 1 } } } });
    const l = clone(b); delete l._plotline.topicPrefs[1];
    const { merged } = h.api.mergeBackups(b, l, b);
    assert.equal(merged._plotline.topicPrefs[1], undefined);
  });
  await test('goal histories and pause intervals merge independent revisions', async () => {
    const h = harness();
    const b = backup({ _plotline: { topicGoals: { 1: { target: 3, history: [],
      pauses: [{ from: 1000, to: null }] } } } });
    const l = clone(b), r = clone(b);
    l._plotline.topicGoals[1].history.push({ effectiveFrom: 1000, target: 2 });
    r._plotline.topicGoals[1].history.push({ effectiveFrom: 2000, target: 4 });
    l._plotline.topicGoals[1].pauses[0].to = 1500;
    r._plotline.topicGoals[1].pauses.push({ from: 3000, to: 4000 });
    const { merged } = h.api.mergeBackups(b, l, r);
    assert.equal(merged._plotline.topicGoals[1].history.length, 2);
    assert.deepEqual(clone(merged._plotline.topicGoals[1].pauses),
      [{ from: 1000, to: 1500 }, { from: 3000, to: 4000 }]);
  });
  await test('same-length true remote record conflicts trigger local apply', async () => {
    const b = backup({ events: [event(1)] });
    const h = harness(b);
    h.state.local.events[0].amount = 2;
    h.state.remote.events[0].amount = 3;
    const result = await h.api.syncNow();
    assert.equal(result.stats.conflicts, 1);
    assert.equal(result.stats.resolvedRemote, 1);
    assert.equal(result.changedLocally, true);
    assert.equal(h.state.local.events[0].amount, 3);
  });
  await test('true local conflict wins when local change is newer', async () => {
    const b = backup({ events: [event(1)] });
    const h = harness(b);
    h.meta.set('lastLocalChangeAt', Date.parse('2026-02-01'));
    h.state.local.events[0].amount = 2; h.state.remote.events[0].amount = 3;
    const result = await h.api.syncNow();
    assert.equal(result.stats.resolvedLocal, 1);
    assert.equal(h.state.remote.events[0].amount, 2);
  });
  await test('distinct legacy event additions sharing an id survive', async () => {
    const h = harness();
    h.state.local.events = [event(1, 2)]; h.state.remote.events = [event(1, 3)];
    const result = await h.api.syncNow();
    assert.equal(result.stats.remapped, 1);
    assert.equal(h.state.local.events.length, 2);
    assert.equal(new Set(h.state.local.events.map((v) => v.id)).size, 2);
    assert.ok(h.state.local.events.every((v) => Number.isSafeInteger(v.id)));
    await h.api.syncNow();
    assert.equal(h.state.local.events.length, 2);
  });
  await test('colliding topics remap events, settings, order and favorites', async () => {
    const h = harness(backup({ topics: [] }));
    h.state.local = backup({ topics: [{ id: 1, name: 'Local', msureid: 1 }], events: [event(1)],
      _plotline: { topicPrefs: { 1: { quickAmount: 4 } }, topicGoals: { 1: { target: 5 } },
        topicOrder: [1], quickBar: [1], favorites: [{ topicid: 1 }] } });
    h.state.remote = backup({ topics: [{ id: 1, name: 'Remote', msureid: 1 }], events: [event(1)],
      _plotline: { topicPrefs: { 1: { quickAmount: 8 } }, topicOrder: [1], quickBar: [1] } });
    await h.api.syncNow();
    const localId = h.state.local.topics.find((v) => v.name === 'Local').id;
    assert.notEqual(localId, 1);
    assert.equal(h.state.local.events.length, 2);
    assert.ok(h.state.local.events.some((v) => v.topicid === localId));
    assert.equal(h.state.local._plotline.topicPrefs[localId].quickAmount, 4);
    assert.equal(h.state.local._plotline.topicPrefs[1].quickAmount, 8);
    assert.equal(h.state.local._plotline.topicGoals[localId].target, 5);
    assert.ok(h.state.local._plotline.topicOrder.includes(localId));
    assert.ok(h.state.local._plotline.topicOrder.includes(1));
    assert.ok(h.state.local._plotline.quickBar.includes(localId));
    assert.equal(h.state.local._plotline.favorites[0].topicid, localId);
  });
  await test('measurement and pendtime-only remote changes apply', async () => {
    const h = harness();
    h.state.remote.measurements = [{ id: 1, name: 'cups' }];
    h.state.remote.pendtimes = [{ id: 1, topicid: 1, time: 2000 }];
    const result = await h.api.syncNow();
    assert.equal(result.changedLocally, true);
    assert.equal(h.state.local.measurements.length, 1);
    assert.equal(h.state.local.pendtimes.length, 1);
  });
  await test('colliding measurement and pendtime IDs remap their real schema references', async () => {
    const h = harness(backup({ topics: [], measurements: [] }));
    h.state.local = backup({ topics: [{ id: 1, name: 'Local', msureid: 1, pendtimeid: 1 }],
      measurements: [{ id: 1, name: 'cups' }], pendtimes: [{ id: 1, name: 'local period' }],
      events: [{ ...event(1), msureid: 1 }] });
    h.state.remote = backup({ topics: [{ id: 1, name: 'Remote', msureid: 1, pendtimeid: 1 }],
      measurements: [{ id: 1, name: 'liters' }], pendtimes: [{ id: 1, name: 'remote period' }],
      events: [{ ...event(1), msureid: 1 }] });
    await h.api.syncNow();
    const cups = h.state.local.measurements.find((m) => m.name === 'cups').id;
    const period = h.state.local.pendtimes.find((m) => m.name === 'local period').id;
    const topic = h.state.local.topics.find((t) => t.name === 'Local');
    assert.notEqual(cups, 1); assert.notEqual(period, 1);
    assert.equal(topic.msureid, cups); assert.equal(topic.pendtimeid, period);
    assert.equal(h.state.local.events.find((e) => e.topicid === topic.id).msureid, cups);
  });
  await test('remote addition keeps its locally deleted topic parent', async () => {
    const h = harness();
    h.state.local.topics = [];
    h.state.remote.events = [event(2)];
    const result = await h.api.syncNow();
    assert.equal(h.state.local.events.length, 1);
    assert.equal(h.state.local.topics.length, 1);
    assert.equal(result.stats.retainedReferences, 1);
  });
  await test('topic deletion removes stale metadata references', async () => {
    const b = backup({ _plotline: { topicPrefs: { 1: { quickAmount: 2 } },
      topicOrder: [1], favorites: [{ topicid: 1 }] } });
    const h = harness(b);
    h.state.remote.topics = [];
    h.state.remote._plotline = {};
    await h.api.syncNow();
    assert.equal(h.state.local.topics.length, 0);
    assert.equal(h.state.local._plotline.topicPrefs?.[1], undefined);
    assert.equal(h.state.local._plotline.favorites?.length || 0, 0);
  });
  await test('saveddate changes alone never replace the local database', async () => {
    const h = harness(backup({ saveddate: 'Jan 1, 2026' }));
    h.state.remote.saveddate = 'Jan 2, 2026';
    h.state.remote.saveddatelong = 1500;
    assert.equal((await h.api.syncNow()).changedLocally, false);
    assert.equal(h.state.applies, 0);
  });
  await test('remote change before upload is re-read and merged', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    let stats = 0;
    h.state.onStat = () => {
      if (++stats === 3) { h.state.remote.events = [event(3)]; h.state.revision++; }
    };
    await h.api.syncNow();
    assert.deepEqual(h.state.remote.events.map((v) => v.id).sort(), [2, 3]);
    assert.equal(h.state.writes, 1);
  });
  await test('remote change after upload retries and verifies content', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    h.state.onWrite = () => {
      if (h.state.writes === 1) { h.state.remote.events.push(event(3)); h.state.revision++; }
    };
    await h.api.syncNow();
    assert.equal(h.state.writes, 2);
    assert.deepEqual(h.state.remote.events.map((v) => v.id).sort(), [2, 3]);
    assert.equal(h.meta.get('drivePendingSnapshot').status, 'confirmed');
    assert.equal((await h.api.getConnectionState()).recoveryPending, false);
  });
  await test('repeated remote races fail without advancing sync base or local data', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    h.state.onWrite = () => { h.state.remote.events.push(event(100 + h.state.writes)); h.state.revision++; };
    await assert.rejects(h.api.syncNow(), /REMOTE_CONFLICT/);
    assert.equal(h.state.writes, 3);
    assert.equal(h.state.applies, 0);
    assert.equal(h.meta.has('lastDriveSync'), false);
    assert.ok(h.meta.get('drivePendingSnapshot').snapshot);
  });
  await test('pending recovery retains merged data across a failed sync and later retry', async () => {
    const h = harness();
    h.state.remote.events = [event(3)];
    h.state.onWrite = () => { throw new Error('network interrupted'); };
    await assert.rejects(h.api.syncNow(), /network interrupted/);
    h.state.remote = backup(); h.state.revision++;
    h.state.local.events = [event(2)];
    h.state.onWrite = null;
    await h.api.syncNow();
    assert.deepEqual(h.state.local.events.map((e) => e.id).sort(), [2, 3]);
  });
  await test('confirmed recovery survives a later undetected concurrent overwrite', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    await h.api.syncNow();
    const originalRecovery = clone(h.meta.get('drivePendingSnapshot').history);
    assert.ok(originalRecovery.some((entry) => entry.snapshot.events.some((e) => e.id === 2)));
    // This arrives after successful readback, outside any client-side check.
    h.state.remote.events = []; h.state.revision++;
    await h.api.syncNow();
    const recovery = h.meta.get('drivePendingSnapshot');
    assert.ok(recovery.history.some((entry) => entry.snapshot.events.some((e) => e.id === 2)));
    assert.deepEqual(recovery.history.find((entry) => entry.snapshot.events.length === 1),
      originalRecovery.find((entry) => entry.snapshot.events.length === 1));
    assert.equal((await h.api.getConnectionState()).recoveryAvailable, true);
    assert.equal((await h.api.getConnectionState()).recoveryPending, false);
  });
  await test('a failed atomic local apply leaves a recovery snapshot and old sync base', async () => {
    const h = harness();
    h.state.remote.events = [event(3)];
    h.state.onApply = () => { throw new Error('transaction aborted'); };
    await assert.rejects(h.api.syncNow(), /transaction aborted/);
    assert.equal(h.state.local.events.length, 0);
    assert.equal(h.meta.get('driveSyncBase').events.length, 0);
    assert.ok(h.meta.get('drivePendingSnapshot'));
  });
  for (const phase of ['onRead', 'onWrite']) {
    for (const stamped of [true, false]) {
      await test(`${phase}: locked edit/add/delete completes during network and survives retry (${stamped ? 'revision' : 'fallback'})`, async () => {
        const h = harness(backup({ events: [event(1), event(2)] }));
        h.state.remote.events.push(event(3));
        const started = deferred(), blocked = deferred();
        let first = true;
        h.state[phase] = async () => {
          if (!first) return;
          first = false; started.resolve(); await blocked.promise;
        };
        const sync = h.api.syncNow();
        try {
          await started.promise;
          await completesWhileBlocked(editLocal(h, () => {
            h.state.local.events = [event(1, 9), event(4)];
          }, stamped));
          assert.equal(h.state.applies, 0);
        } finally { blocked.resolve(); }
        await sync;
        assert.deepEqual(h.state.local.events.map((e) => e.id).sort(), [1, 3, 4]);
        assert.equal(h.state.local.events.find((e) => e.id === 1).amount, 9);
        assert.deepEqual(h.state.remote.events, h.state.local.events);
        assert.equal(h.state.auth, 1, 'local retries reuse the authenticated operation');
        assert.equal(h.meta.get('drivePendingSnapshot').status, 'confirmed');
      });
    }
  }
  await test('a revision-only change during upload is checked inside the apply lock', async () => {
    const h = harness();
    h.state.remote.events.push(event(3));
    h.state.onWrite = async () => {
      if (h.state.writes === 1) await editLocal(h, () => {});
    };
    await h.api.syncNow();
    assert.equal(h.state.writes, 2);
    assert.equal(h.state.auth, 1);
  });
  await test('continuous local races are bounded, retain recovery, and never mark old edits synced', async () => {
    const h = harness();
    h.state.remote.events.push(event(3));
    h.state.onWrite = async () => {
      await editLocal(h, () => { h.state.local.events.push(event(100 + h.state.writes)); });
    };
    await assert.rejects(h.api.syncNow(), /LOCAL_CHANGED/);
    assert.equal(h.state.writes, 4);
    assert.equal(h.state.auth, 1);
    assert.equal(h.state.applies, 0);
    assert.equal(h.meta.has('lastDriveSync'), false);
    assert.equal(h.meta.get('drivePendingSnapshot').status, 'pending');
    h.state.onWrite = null;
    await h.api.syncNow();
    assert.deepEqual(h.state.local.events.map((e) => e.id).sort(), [101, 102, 103, 104, 3].sort());
  });
  await test('local changes during safety export do not get overwritten', async () => {
    const h = harness();
    h.state.remote.events.push(event(3));
    h.state.onSafety = async () => {
      if (h.state.safety === 1) await editLocal(h, () => { h.state.local.events.push(event(4)); });
    };
    await h.api.syncNow();
    assert.deepEqual(h.state.local.events.map((e) => e.id).sort(), [3, 4]);
  });
  for (const phase of ['onRead', 'onSafety']) {
    await test(`explicit restore rejects new local data during ${phase} until reconfirmed`, async () => {
      const h = harness();
      h.state.remote.events.push(event(3));
      h.state[phase] = async () => {
        h.state[phase] = null;
        await completesWhileBlocked(editLocal(h, () => { h.state.local.events.push(event(4)); }));
      };
      await assert.rejects(h.api.syncDown(), /LOCAL_CHANGED.*confirm restore again/);
      assert.deepEqual(h.state.local.events.map((e) => e.id), [4]);
      assert.equal(h.state.applies, 0);
      assert.equal(h.meta.has('lastDriveSync'), false);
      assert.equal(h.meta.get('drivePendingSnapshot').status, 'restore');
      await h.api.syncDown();
      assert.deepEqual(h.state.local.events.map((e) => e.id), [3]);
    });
  }
  await test('real storage: a timer started during download is preserved through local retry', async () => {
    const h = await storageHarness();
    h.state.remote._plotline.topicMeta = { 1: { color: '#123456' } };
    let first = true;
    h.state.onRead = async () => {
      if (!first) return;
      first = false;
      await completesWhileBlocked(editLocal(h, () => h.db.startTimer(1, 1000), false));
    };
    await h.api.syncNow();
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
    assert.equal(h.state.auth, 1);
  });
  await test('real storage: timer-only changes during restore require renewed confirmation', async () => {
    const h = await storageHarness();
    h.state.onRead = async () => {
      h.state.onRead = null;
      await completesWhileBlocked(editLocal(h, () => h.db.startTimer(1, 1000), false));
    };
    await assert.rejects(h.api.syncDown(), /LOCAL_CHANGED/);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
    assert.equal(h.state.applies, 0);
  });
  await test('real storage: timer and edited legacy topic keep their identity through upload retry', async () => {
    const h = await storageHarness();
    const base = clone(h.state.local); base.topics = []; base._plotline.topicKinds = {};
    await h.db.setMeta('driveSyncBase', base);
    h.state.remote.topics[0].name = 'Remote duration';
    h.state.onWrite = async () => {
      if (h.state.writes !== 1) return;
      await completesWhileBlocked(editLocal(h, async () => {
        await h.db.startTimer(1, 1000);
        const topic = await h.db.get('topics', 1);
        await h.db.put('topics', { ...topic, name: 'Edited local duration' });
      }));
    };
    await h.api.syncNow();
    const topics = await h.db.getAll('topics');
    const moved = topics.find((t) => t.name === 'Edited local duration');
    assert.equal(topics.length, 2);
    assert.notEqual(moved.id, 1);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { [moved.id]: 1000 });
    assert.equal(h.state.auth, 1);
  });
  await test('colliding legacy event deletion during accepted upload does not resurrect moved copy', async () => {
    const h = harness();
    h.state.local.events.push(event(1, 2));
    h.state.remote.events.push(event(1, 3));
    h.state.onWrite = async () => {
      if (h.state.writes === 1) await editLocal(h, () => { h.state.local.events = []; });
    };
    await h.api.syncNow();
    assert.deepEqual(h.state.local.events, [event(1, 3)]);
    assert.deepEqual(h.state.remote.events, [event(1, 3)]);
  });
  await test('pending accepted upload does not resurrect a subsequently deleted legacy collision', async () => {
    const h = harness();
    h.state.local.events.push(event(1, 2));
    h.state.remote.events.push(event(1, 3));
    h.state.onWrite = async () => {
      await editLocal(h, () => { h.state.local.events = []; });
      throw new Error('network interrupted');
    };
    await assert.rejects(h.api.syncNow(), /network interrupted/);
    h.state.onWrite = null;
    await h.api.syncNow();
    assert.deepEqual(h.state.local.events, [event(1, 3)]);
    assert.deepEqual(h.state.remote.events, [event(1, 3)]);
  });
  await test('a pending collision plus a newer remote edit defers instead of resurrecting a local delete', async () => {
    const h = harness();
    h.state.local.events.push(event(1, 2));
    h.state.remote.events.push(event(1, 3));
    h.state.onWrite = () => { throw new Error('network interrupted'); };
    await assert.rejects(h.api.syncNow(), /network interrupted/);
    const moved = h.state.remote.events.find((e) => e.id !== 1);
    moved.amount = 9; h.state.revision++;
    await editLocal(h, () => { h.state.local.events = []; });
    h.state.onWrite = null;
    await assert.rejects(h.api.syncNow(), /LOCAL_CONFLICT/);
    assert.deepEqual(h.state.local.events, []);
    assert.equal(h.state.writes, 1);
    assert.equal(h.meta.has('lastDriveSync'), false);
    assert.equal(h.meta.get('drivePendingSnapshot').status, 'pending');
  });
  await test('older recovery without event identity maps defers newer deletes rather than guessing', async () => {
    const h = harness();
    const local = backup({ events: [event(1, 2)] });
    const candidate = backup({ events: [event(1, 3), event(99, 2)] });
    h.meta.set('drivePendingSnapshot', { status: 'pending', snapshot: candidate, localSnapshot: local,
      localIdMaps: { topics: { 1: 1 }, measurements: { 1: 1 } } });
    h.state.remote = clone(candidate);
    await assert.rejects(h.api.syncNow(), /LOCAL_CONFLICT.*older recovery/);
    assert.deepEqual(h.state.local.events, []);
    assert.equal(h.state.writes, 0);
    assert.equal(h.meta.get('drivePendingSnapshot').snapshot.events.length, 2);
  });
  await test('legacy alert normalization keeps remapped metadata through a pending local topic edit', async () => {
    const h = harness(backup({ topics: [] }));
    h.state.local = backup({ topics: [{ id: 1, name: 'Local', msureid: 1 }],
      _plotline: { insightSettings: { alertOn: 'flare' }, topicPrefs: { 1: { quickAmount: 4 } },
        topicOrder: [1], quickBar: [1], favorites: [{ topicid: 1 }] } });
    h.state.remote = backup({ topics: [{ id: 1, name: 'Remote', msureid: 1 }] });
    h.state.onWrite = () => { throw new Error('network interrupted'); };
    await assert.rejects(h.api.syncNow(), /network interrupted/);
    await editLocal(h, () => {
      h.state.local.topics[0].name = 'Edited local';
      h.state.local._plotline.topicPrefs[1].quickAmount = 8;
    });
    h.state.onWrite = null;
    await h.api.syncNow();
    const id = h.state.local.topics.find((t) => t.name === 'Edited local').id;
    assert.notEqual(id, 1);
    assert.equal(h.state.local.topics.length, 2);
    assert.equal(h.state.local._plotline.insightSettings.alertOn, 'alert');
    assert.equal(h.state.local._plotline.topicPrefs[id].quickAmount, 8);
    assert.deepEqual(h.state.local._plotline.topicOrder, [id]);
    assert.deepEqual(h.state.local._plotline.quickBar, [id]);
    assert.deepEqual(h.state.local._plotline.favorites, [{ topicid: id }]);
  });
  await test('real storage: cancelling a timer during upload does not resurrect the device-only timer', async () => {
    const h = await storageHarness();
    await h.db.startTimer(1, 1000);
    h.state.remote._plotline.topicMeta = { 1: { color: '#123456' } };
    h.state.onWrite = async () => {
      if (h.state.writes === 1) await editLocal(h, () => h.db.setMeta('activeTimers', {}), false);
    };
    await h.api.syncNow();
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), {});
    assert.equal(h.state.writes, 2);
    assert.equal(h.state.auth, 1);
  });
  await test('coalesced background requests during cleanup still sync their newer edits', async () => {
    const h = harness();
    let coalesced;
    h.state.onCleanup = async () => {
      h.state.onCleanup = null;
      await editLocal(h, () => { h.state.local.events.push(event(4)); });
      coalesced = h.api.syncNow();
    };
    await h.api.syncNow();
    await coalesced;
    assert.deepEqual(h.state.remote.events, [event(4)]);
  });
  await test('syncNow and syncDown use one serial queue and shared exclusive lock', async () => {
    const h = harness();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    h.state.onBuild = () => gate;
    const a = h.api.syncNow(), b = h.api.syncDown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.state.auth, 1);
    assert.equal(h.state.reads, 1);
    assert.equal((await h.api.getConnectionState()).pending, true);
    release(); await Promise.all([a, b]);
    assert.deepEqual(h.state.locks, Array.from({ length: 5 }, () => ['plotline-data', 'exclusive']));
    assert.equal(h.state.auth, 2);
  });
  await test('queue fallback works without navigator.locks', async () => {
    const h = harness(); delete h.browser.navigator.locks;
    await Promise.all([h.api.syncNow(), h.api.syncNow()]);
    assert.equal(h.state.writes, 1, 'identical background requests coalesce');
  });
  await test('background bursts coalesce while explicit operations remain serialized', async () => {
    const h = harness();
    const blocked = deferred(), started = deferred();
    h.state.onRead = async () => { started.resolve(); await blocked.promise; };
    const first = h.api.syncNow();
    await started.promise;
    const burst = Array.from({ length: 30 }, () => h.api.syncNow());
    assert.ok(burst.every((p) => p === first));
    const explicit = h.api.syncNow({ interactive: true });
    await completesWhileBlocked(editLocal(h, () => { h.state.local.events.push(event(4)); }));
    blocked.resolve();
    await Promise.all([first, ...burst, explicit]);
    assert.equal(h.state.auth, 2);
    assert.equal(h.state.writes, 2);
    assert.deepEqual(h.state.remote.events, [event(4)]);
  });
  await test('fallback data lock also serializes model mutations with sync snapshots', async () => {
    const h = harness(); delete h.browser.navigator.locks;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const edit = h.api.withDataLock(async () => {
      await gate;
      h.state.local.events.push(event(3));
    });
    const sync = h.api.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.state.reads, 0);
    release(); await Promise.all([edit, sync]);
    assert.equal(h.state.remote.events[0].id, 3);
  });
  await test('OAuth happens before acquiring the data lock', async () => {
    const h = harness();
    h.state.onAuth = () => { assert.equal(h.state.locks.length, 0); };
    await h.api.syncNow({ interactive: true });
  });
  await test('fresh devices with bundled client ID do not authorize automatically', async () => {
    const h = harness(); h.meta.delete('driveEnabled');
    await h.api.startupSync(); await h.api.queueAutoSync('online');
    await assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    assert.equal(h.state.auth, 0);
    assert.equal((await h.api.getConnectionState()).enabled, false);
    await h.api.syncNow({ interactive: true });
    assert.equal(h.meta.get('driveEnabled'), true);
  });
  await test('existing lastDriveSync enables migration but explicit false wins', async () => {
    const h = harness(); h.meta.delete('driveEnabled'); h.meta.set('lastDriveSync', 1);
    assert.equal((await h.api.getConnectionState()).enabled, true);
    h.meta.set('driveEnabled', false);
    assert.equal((await h.api.getConnectionState()).enabled, false);
  });
  await test('disconnect disables timers and auth without deleting remote or configuration', async () => {
    const h = harness(); h.meta.set('driveClientId', 'custom');
    await h.api.queueAutoSync(); await h.api.disconnect();
    await h.api.startupSync(); await h.api.queueAutoSync('connection');
    assert.equal(h.meta.get('driveClientId'), 'custom');
    assert.equal(h.meta.get('driveEnabled'), false);
    assert.equal(h.state.auth, 0);
    assert.equal(h.state.writes, 0);
  });
  await test('disconnect cancels an in-flight session before it can write', async () => {
    const h = harness();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    h.state.onAuth = () => gate;
    const sync = h.api.syncNow();
    const rejected = assert.rejects(sync, /DISCONNECTED/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const disconnect = h.api.disconnect();
    release(); await Promise.all([rejected, disconnect]);
    assert.equal(h.state.writes, 0);
    assert.equal((await h.api.getConnectionState()).enabled, false);
  });
  await test('disconnect during a deferred read permits local edits and prevents all later remote writes', async () => {
    const h = harness();
    const blocked = deferred(), started = deferred();
    h.state.onRead = async () => { started.resolve(); await blocked.promise; };
    const sync = assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    await started.promise;
    const disconnected = h.api.disconnect();
    try {
      await completesWhileBlocked(editLocal(h, () => { h.state.local.events.push(event(4)); }));
      assert.equal(h.state.writes, 0);
    } finally { blocked.resolve(); }
    await Promise.all([sync, disconnected]);
    assert.deepEqual(h.state.local.events, [event(4)]);
    assert.equal(h.state.writes, 0);
    assert.equal(h.meta.get('driveEnabled'), false);
  });
  await test('disconnect drains accepted writes and rejects queued sync before local reset', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    let release, written;
    const gate = new Promise((resolve) => { release = resolve; });
    const writeStarted = new Promise((resolve) => { written = resolve; });
    h.state.onWrite = async () => { written(); await gate; };
    const active = assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    const queued = assert.rejects(h.api.syncNow({ interactive: true }), /DISCONNECTED/);
    await writeStarted;
    let drained = false;
    const disconnect = h.api.disconnect().then(() => { drained = true; });
    await assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(drained, false, 'disconnect returned while a write was still accepted/in flight');
    release();
    await Promise.all([active, queued, disconnect]);
    const writesBeforeReset = h.state.writes;
    await h.api.withDataLock(async () => {
      h.state.local = backup({ topics: [], events: [] });
      h.meta.clear();
      h.meta.set('driveEnabled', false);
    });
    await h.api.queueAutoSync('change');
    await h.api.queueAutoSync('online');
    await h.api.startupSync();
    await assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    assert.equal(h.state.writes, writesBeforeReset);
    assert.equal(h.state.remote.events[0].id, 2);
  });
  await test('interactive onboarding restore works on an empty disconnected database', async () => {
    const h = harness(backup({ topics: [] }), backup({ events: [event(7)] }));
    h.meta.clear();
    await h.api.syncDown({ interactive: true });
    assert.equal(h.state.local.events[0].id, 7);
    assert.equal(h.state.writes, 0);
    assert.equal(h.meta.get('driveEnabled'), true);
  });
  await test('network retries do not change local conflict timestamps', async () => {
    const h = harness(); h.meta.set('driveEnabled', false);
    h.meta.set('lastLocalChangeAt', 1234);
    await h.api.queueAutoSync('online'); await h.api.queueAutoSync('connection');
    assert.equal(h.meta.get('lastLocalChangeAt'), 1234);
    await h.api.queueAutoSync('change');
    assert.ok(h.meta.get('lastLocalChangeAt') > 1234);
    h.meta.set('lastLocalChangeAt', 1234);
    await h.api.queueAutoSync('saveGoal');
    assert.ok(h.meta.get('lastLocalChangeAt') > 1234);
  });
  await test('background OAuth visibility guard remains intact', async () => {
    const h = harness(); h.browser.document.visibilityState = 'hidden';
    await assert.rejects(h.browser.window.originalTokenRequest(false), /BACKGROUNDED/);
    assert.equal(h.state.auth, 0);
  });
  await test('even explicit OAuth rechecks foreground visibility after loading GIS', async () => {
    const h = harness();
    vm.runInContext(`ensureGis = async () => { document.visibilityState = 'hidden'; };`, h.browser);
    await assert.rejects(h.browser.window.originalTokenRequest(true), /BACKGROUNDED/);
  });
  await test('startup and automatic sync never load GIS or open authorization screens', async () => {
    const h = harness();
    let gisLoads = 0;
    h.browser.ensureGis = async () => { gisLoads++; };
    vm.runInContext('getTokenSilent = () => window.originalTokenRequest(false);', h.browser);
    for (let i = 0; i < 4; i++) await h.api.startupSync();
    assert.equal(gisLoads, 0);
    assert.equal(h.state.reads, 0);
    assert.equal(h.state.writes, 0);
    assert.equal(h.state.statuses.at(-1).detail.status, '');
    assert.match(h.state.statuses.at(-1).detail.message, /tap to sync/);
    assert.equal(vm.runInContext('autoSyncSuppressed()', h.browser), false);
    let scheduled;
    h.browser.setTimeout = (callback) => { scheduled = callback; return 1; };
    h.browser.clearTimeout = () => {};
    await h.api.queueAutoSync('marked-change');
    await scheduled();
    assert.equal(gisLoads, 0);
    assert.equal(h.state.writes, 0);
    assert.match(h.state.statuses.at(-1).detail.message, /tap to sync/);
  });
  await test('automatic sync reuses valid tokens but never renews expired ones', async () => {
    const h = harness();
    vm.runInContext(`_accessToken = 'synthetic-cached-token'; _tokenExpiry = Date.now() + 60000;
      ensureGis = async () => { throw new Error('Unexpected GIS load'); };`, h.browser);
    assert.equal(await h.browser.window.originalTokenRequest(false), 'synthetic-cached-token');
    vm.runInContext('_tokenExpiry = Date.now() - 1;', h.browser);
    await assert.rejects(h.browser.window.originalTokenRequest(false), /Tap Sync now to reconnect/);
  });
  await test('an explicit foreground tap can authorize, and rejected tokens require another tap', async () => {
    const h = harness();
    let requests = 0;
    h.browser.google = { accounts: { oauth2: { initTokenClient(options) {
      return { requestAccessToken() {
        requests++;
        options.callback({ access_token: 'synthetic-token', expires_in: 3600 });
      } };
    } } } };
    vm.runInContext('ensureGis = async () => {};', h.browser);
    assert.equal(await h.browser.window.originalTokenRequest(true), 'synthetic-token');
    assert.equal(await h.browser.window.originalTokenRequest(false), 'synthetic-token');
    assert.equal(requests, 1);
    h.browser.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(vm.runInContext("driveFetch('/drive/v3/files')", h.browser), /Tap Sync now to reconnect/);
    await assert.rejects(h.browser.window.originalTokenRequest(false), /Tap Sync now to reconnect/);
    assert.equal(requests, 1);
  });
  await test('every OAuth failure rejects its own request instead of hanging the queue', async () => {
    const h = harness();
    let initialized = 0;
    h.browser.google = { accounts: { oauth2: { initTokenClient(options) {
      initialized++;
      return { requestAccessToken() { options.error_callback({ type: 'popup_closed' }); } };
    } } } };
    vm.runInContext('ensureGis = async () => {};', h.browser);
    await assert.rejects(h.browser.window.originalTokenRequest(true), /popup_closed/);
    await assert.rejects(h.browser.window.originalTokenRequest(true), /popup_closed/);
    assert.equal(initialized, 2);
  });
  await test('status event dispatch does not require a header pill', async () => {
    const h = harness(); await h.api.syncNow();
    assert.ok(h.state.statuses.some((e) => e.type === 'plotline:sync-status' && e.detail.status === 'ok'));
  });
  await test('sync activity status follows pill DOM updates and survives redundant queued requests', async () => {
    const h = harness();
    const pill = { textContent: '', style: {}, classList: { remove() {}, add() {} } };
    const activity = {};
    h.browser.document.getElementById = (id) => ({ syncPill: pill, syncActivity: activity })[id] || null;
    const observed = [];
    const dispatch = h.browser.window.dispatchEvent;
    h.browser.window.dispatchEvent = (e) => {
      observed.push({ ...clone(e.detail), pill: pill.textContent });
      dispatch(e);
    };
    const blocked = deferred(), started = deferred();
    h.state.onRead = async () => { started.resolve(); await blocked.promise; };
    const sync = h.api.syncNow();
    await started.promise;
    assert.equal(pill.textContent, '☁ Sync');
    assert.equal(observed[0].pill, '☁ Sync', 'listeners must see the updated DOM');
    assert.equal(observed[0].pending, true);
    assert.equal(observed[0].phase, 'syncing');
    try {
      for (let i = 0; i < 3; i++) await h.api.queueAutoSync('marked-change');
      assert.equal(pill.textContent, '☁ queued…', 'queued pill status remains meaningful');
      assert.equal(observed.at(-1).pending, true);
      assert.match(observed.at(-1).message, /syncing/);
      assert.ok(observed.every((entry) => entry.pending && /syncing/.test(entry.message)),
        'activity must not flicker off before the real operation finishes');
    } finally { blocked.resolve(); }
    await sync;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pill.textContent, '☁ synced');
    assert.equal(observed.at(-1).pending, false);
    assert.equal(observed.at(-1).phase, 'idle');
    assert.equal(observed.at(-1).message, '☁ synced', 'pending decoration must not persist after completion');
    await h.api.disconnect();
  });
  await test('the original syncing pill remains when the activity span is absent, and errors remain visible', async () => {
    const h = harness();
    const pill = { textContent: '', style: {}, classList: { remove() {}, add() {} } };
    h.browser.document.getElementById = (id) => id === 'syncPill' ? pill : null;
    const blocked = deferred(), started = deferred();
    h.state.onRead = async () => {
      started.resolve(); await blocked.promise; throw new Error('network interrupted');
    };
    const rejected = assert.rejects(h.api.syncNow(), /network interrupted/);
    await started.promise;
    assert.equal(pill.textContent, '☁ syncing…');
    blocked.resolve();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pill.textContent, '☁ sync failed');
    assert.equal(h.state.statuses.at(-1).detail.pending, false);
    assert.equal(h.state.statuses.at(-1).detail.status, 'error');
  });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exitCode = failures ? 1 : 0;
})();
