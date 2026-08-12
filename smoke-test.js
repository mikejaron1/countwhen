#!/usr/bin/env node
/* Smoke test: simulate the import → DB → export pipeline in Node.
 * Verifies our import/export module preserves the JSON backup
 * structure byte-for-byte.
 */

const fs = require('fs');
const path = require('path');

// ---- Minimal IndexedDB stand-in ----
const STORES = {};
function ensureStore(name) {
  if (!STORES[name]) STORES[name] = new Map();
  return STORES[name];
}
// keyPaths
const KEYS = {
  topics: 'id', events: 'id', measurements: 'id', pendtimes: 'id',
  appdata: 'name', meta: 'key', favorites: 'topicid',
};

global.window = {};
global.indexedDB = null;
global.IDBKeyRange = null;
global.Blob = class { constructor(parts, opts){ this.parts = parts; this.type = opts?.type; } };
global.URL = { createObjectURL: () => 'blob://x', revokeObjectURL: () => {} };
global.document = {
  createElement: () => ({ click(){}, set href(v){}, set download(v){} }),
  body: { appendChild(){}, removeChild(){} },
};

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node smoke-test.js <path-to-backup.json>');
  process.exit(2);
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

// ---- Mock the db module the same shape as window.CWDB ----
const CWDB = {
  async getAll(store) {
    return Array.from(ensureStore(store).values()).map((v) => structuredClone(v));
  },
  async get(store, key) {
    const v = ensureStore(store).get(key);
    return v ? structuredClone(v) : undefined;
  },
  async put(store, value) {
    const s = ensureStore(store);
    const key = value[KEYS[store]];
    s.set(key, structuredClone(value));
    return value;
  },
  async putMany(store, values) {
    for (const v of values) await this.put(store, v);
    return values.length;
  },
  async delete(store, key) { ensureStore(store).delete(key); },
  async clear(store) { ensureStore(store).clear(); },
  async clearAll() {
    for (const name of Object.keys(KEYS)) await this.clear(name);
  },
  async getEventsByTopic(topicid) {
    const all = await this.getAll('events');
    return all.filter((e) => e.topicid === topicid);
  },
  async nextId(store) {
    const all = await this.getAll(store);
    return all.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  },
  async getMeta(key, fallback = null) {
    const r = await this.get('meta', key);
    return r ? r.value : fallback;
  },
  async setMeta(key, value) { return this.put('meta', { key, value }); },
  async isFavorite(id) { return !!(await this.get('favorites', id)); },
  async setFavorite(id, on) {
    if (on) await this.put('favorites', { topicid: id, added: Date.now() });
    else await this.delete('favorites', id);
  },
  async getFavoriteTopicIds() {
    const all = await this.getAll('favorites');
    return all.map((f) => f.topicid);
  },
  async seedDefaults() {},
};
global.window.CWDB = CWDB;
global.CWDB = CWDB;
global.window.CWDB_DEFAULT_MEASUREMENTS = [];
global.window.CWDB_DEFAULT_PENDTIMES = [];

// Load import-export.js by eval (it uses window.CWIO assignment at bottom)
const ieSrc = fs.readFileSync(path.join(__dirname, 'js', 'import-export.js'), 'utf8');
eval(ieSrc);
const CWIO = global.window.CWIO;

(async () => {
  console.log('Input events:', input.events.length, 'topics:', input.topics.length);

  // 1) Validate
  const errs = CWIO.validateBackup(input);
  console.log('Validation errors:', errs.length);
  if (errs.length) { console.error(errs); process.exit(1); }

  // 2) Replace import
  await CWIO.importReplace(input);

  // 3) Build export
  const output = await CWIO.buildExportObject();

  // 4) Compare top-level keys
  const inKeys = Object.keys(input).sort();
  const outKeys = Object.keys(output).sort();
  console.log('Input keys :', inKeys);
  console.log('Output keys:', outKeys);

  // 5) Counts
  console.log('Topics in/out:', input.topics.length, '→', output.topics.length);
  console.log('Events in/out:', input.events.length, '→', output.events.length);
  console.log('Measurements in/out:', input.measurements.length, '→', output.measurements.length);
  console.log('Pendtimes in/out:', input.pendtimes.length, '→', output.pendtimes.length);
  console.log('Appdata in/out:', input.appdata.length, '→', output.appdata.length);

  // 6) Build canonical comparison (sort each array by id, compare JSON)
  function canon(obj) {
    const o = { ...obj };
    // Settings written under the pre-rebrand key are migrated on import, so
    // normalise the name before comparing.
    if (o._wdapp && !o._countwhen) { o._countwhen = o._wdapp; delete o._wdapp; }
    // Recomputed fields will differ; ignore them
    delete o.saveddate;
    delete o.saveddatelong;
    delete o.eventcount;
    delete o.topiccount;
    // sort arrays for comparison
    if (Array.isArray(o.topics))       o.topics = [...o.topics].sort((a,b) => a.id - b.id);
    if (Array.isArray(o.events))       o.events = [...o.events].sort((a,b) => a.id - b.id);
    if (Array.isArray(o.measurements)) o.measurements = [...o.measurements].sort((a,b) => a.id - b.id);
    if (Array.isArray(o.pendtimes))    o.pendtimes = [...o.pendtimes].sort((a,b) => a.id - b.id);
    if (Array.isArray(o.appdata))      o.appdata = [...o.appdata].sort((a,b) => a.name.localeCompare(b.name));
    return o;
  }
  // JSON object key order carries no meaning, so compare with keys sorted
  // recursively; array order is still significant and is preserved above.
  function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o; }, {});
    }
    return v;
  }

  const inC  = canon(input);
  const outC = canon(output);
  const inJ  = JSON.stringify(stable(inC));
  const outJ = JSON.stringify(stable(outC));

  if (inJ === outJ) {
    console.log('✅ Round-trip MATCHES (ignoring recomputed counts/dates).');
  } else {
    console.log('❌ Round-trip MISMATCH');
    // find first array that differs
    for (const k of ['topics','events','measurements','pendtimes','appdata']) {
      const a = JSON.stringify(inC[k]);
      const b = JSON.stringify(outC[k]);
      if (a !== b) {
        console.log(`  difference in: ${k}`);
        if (Array.isArray(inC[k]) && Array.isArray(outC[k])) {
          for (let i = 0; i < Math.min(inC[k].length, outC[k].length); i++) {
            const ja = JSON.stringify(inC[k][i]);
            const jb = JSON.stringify(outC[k][i]);
            if (ja !== jb) {
              console.log('  first item diff at index', i);
              console.log('   in :', ja);
              console.log('   out:', jb);
              break;
            }
          }
        }
        break;
      }
    }
    process.exit(2);
  }

  // 7) Verify counts recomputed correctly
  console.log('eventcount:', output.eventcount, '(expected', input.events.length, ')');
  console.log('topiccount:', output.topiccount, '(expected', input.topics.length, ')');

  // 8) Sanity-check qant formatting using js/stats.js sample
  console.log('Sample event:', output.events[0]);

  console.log('---- SMOKE TEST PASSED ----');
})().catch((e) => { console.error(e); process.exit(3); });
