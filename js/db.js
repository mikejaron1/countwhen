/* WhenDidI - IndexedDB wrapper
 * Stores topics, events, measurements, pendtimes, appdata, meta.
 * All data lives on-device; no network required.
 */

const DB_NAME = 'whendidi';
const DB_VERSION = 1;

const STORES = {
  topics: 'id',
  events: 'id',
  measurements: 'id',
  pendtimes: 'id',
  appdata: 'name',
  meta: 'key',
  favorites: 'topicid',
};

const DEFAULT_MEASUREMENTS = [
  { id: 10, name: 'Duration',       symbol: 'hh:mm',    type: 3, format: 5 },
  { id: 11, name: 'Duration Short', symbol: 'mm:ss',    type: 3, format: 7 },
  { id: 12, name: 'Elapsed',        symbol: 'hh:mm:ss', type: 3, format: 6 },
  { id: 2,  name: 'gallons',        symbol: 'gal',      type: 0, format: 0 },
  { id: 9,  name: 'hours',          symbol: 'hrs',      type: 3, format: 4 },
  { id: 4,  name: 'kilograms',      symbol: 'kg',       type: 0, format: 0 },
  { id: 5,  name: 'kilometres',     symbol: 'km',       type: 0, format: 0 },
  { id: 1,  name: 'litres',         symbol: 'l',        type: 0, format: 0 },
  { id: 6,  name: 'metres',         symbol: 'm',        type: 0, format: 0 },
  { id: 3,  name: 'miles',          symbol: 'm',        type: 0, format: 0 },
  { id: 8,  name: 'minutes',        symbol: 'mins',     type: 3, format: 3 },
  { id: 7,  name: 'seconds',        symbol: 's',        type: 3, format: 2 },
  { id: 100, name: 'count',         symbol: '',         type: 0, format: 0 },
  { id: 101, name: 'ounces',        symbol: 'oz',       type: 0, format: 0 },
  { id: 102, name: 'pounds',        symbol: 'lb',       type: 0, format: 0 },
  { id: 103, name: 'grams',         symbol: 'g',        type: 0, format: 0 },
];

const DEFAULT_PENDTIMES = [
  { id: 5, title: 'Early Morning', endtime: 900 },
  { id: 6, title: 'Lunch Time',    endtime: 1200 },
  { id: 7, title: 'Evening',       endtime: 1800 },
  { id: 8, title: 'Night',         endtime: 2200 },
];

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath });
          if (name === 'events') {
            store.createIndex('topicid', 'topicid', { unique: false });
            store.createIndex('time', 'time', { unique: false });
          }
          if (name === 'topics') {
            store.createIndex('name', 'name', { unique: false });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeNames, mode = 'readonly') {
  return openDB().then((db) => {
    const t = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)]))
      : t.objectStore(storeNames);
    return { t, stores };
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const db = {
  async getAll(store) {
    const { stores } = await tx(store);
    return reqToPromise(stores.getAll());
  },

  async get(store, key) {
    const { stores } = await tx(store);
    return reqToPromise(stores.get(key));
  },

  async put(store, value) {
    const { t, stores } = await tx(store, 'readwrite');
    stores.put(value);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(t.error);
    });
  },

  async putMany(store, values) {
    if (!values.length) return 0;
    const { t, stores } = await tx(store, 'readwrite');
    for (const v of values) stores.put(v);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(values.length);
      t.onerror = () => reject(t.error);
    });
  },

  async delete(store, key) {
    const { t, stores } = await tx(store, 'readwrite');
    stores.delete(key);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async clear(store) {
    const { t, stores } = await tx(store, 'readwrite');
    stores.clear();
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async clearAll() {
    for (const name of Object.keys(STORES)) {
      await this.clear(name);
    }
  },

  async getEventsByTopic(topicid) {
    const { stores } = await tx('events');
    const idx = stores.index('topicid');
    return reqToPromise(idx.getAll(topicid));
  },

  async getEventsBetween(start, end) {
    const { stores } = await tx('events');
    const idx = stores.index('time');
    const range = IDBKeyRange.bound(start, end);
    return reqToPromise(idx.getAll(range));
  },

  async getEventsSorted({ desc = true, limit = null } = {}) {
    const { stores } = await tx('events');
    const idx = stores.index('time');
    return new Promise((resolve, reject) => {
      const results = [];
      const cursorReq = idx.openCursor(null, desc ? 'prev' : 'next');
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve(results);
        results.push(cursor.value);
        if (limit && results.length >= limit) return resolve(results);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  async getLastEventForTopic(topicid) {
    const events = await this.getEventsByTopic(topicid);
    if (!events.length) return null;
    let best = events[0];
    for (const e of events) if (e.time > best.time) best = e;
    return best;
  },

  async nextId(store) {
    const items = await this.getAll(store);
    let max = 0;
    for (const it of items) if (it.id > max) max = it.id;
    return max + 1;
  },

  async getMeta(key, fallback = null) {
    const r = await this.get('meta', key);
    return r ? r.value : fallback;
  },

  async setMeta(key, value) {
    return this.put('meta', { key, value });
  },

  async isFavorite(topicid) {
    return !!(await this.get('favorites', topicid));
  },

  async setFavorite(topicid, on) {
    if (on) await this.put('favorites', { topicid, added: Date.now() });
    else await this.delete('favorites', topicid);
  },

  async getFavoriteTopicIds() {
    const all = await this.getAll('favorites');
    return all.map((f) => f.topicid);
  },

  /* Topic kinds: in-app metadata only. Not exported in whendidibk.json.
   *   'timeonly' — log a timestamp; qant defaults to 60, no input shown
   *   'duration' — log a hh:mm duration (msureid 10/11/12)
   *   'amount'   — log a numeric amount in the topic's measurement unit
   */
  async getTopicKind(topicId) {
    const map = (await this.getMeta('topicKinds')) || {};
    return map[topicId] || null;
  },

  async setTopicKind(topicId, kind) {
    const map = (await this.getMeta('topicKinds')) || {};
    if (kind == null) delete map[topicId];
    else map[topicId] = kind;
    await this.setMeta('topicKinds', map);
  },

  async getAllTopicKinds() {
    return (await this.getMeta('topicKinds')) || {};
  },

  /* Topic visual metadata (emoji + color). In-app only, not exported. */
  async getTopicMeta(topicId) {
    const map = (await this.getMeta('topicMeta')) || {};
    return map[topicId] || null;
  },

  async setTopicMeta(topicId, meta) {
    const map = (await this.getMeta('topicMeta')) || {};
    if (meta == null) delete map[topicId];
    else map[topicId] = meta;
    await this.setMeta('topicMeta', map);
  },

  async getAllTopicMeta() {
    return (await this.getMeta('topicMeta')) || {};
  },

  async seedDefaults() {
    // Pendtimes: seed if empty
    const pt = await this.getAll('pendtimes');
    if (!pt.length) await this.putMany('pendtimes', DEFAULT_PENDTIMES);
    // Measurements: ADD any that aren't already present (so existing
    // installs gain newly-added ones like pounds/grams on upgrade).
    const existing = await this.getAll('measurements');
    const haveIds = new Set(existing.map((m) => m.id));
    const missing = DEFAULT_MEASUREMENTS.filter((m) => !haveIds.has(m.id));
    if (missing.length) await this.putMany('measurements', missing);
  },
};

window.WDDB = db;
window.WDDB_DEFAULT_MEASUREMENTS = DEFAULT_MEASUREMENTS;
window.WDDB_DEFAULT_PENDTIMES = DEFAULT_PENDTIMES;
