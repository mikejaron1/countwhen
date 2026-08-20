/* Plotline - Import / Export
 * Round-trips the shared JSON backup schema byte-compatibly, so backups
 * written by older trackers using the same schema import without loss.
 */

const REQUIRED_KEYS = ['topics', 'events'];

/* Top-level key holding Plotline's own settings, plus every name it used
 * before, oldest last. Backup files outlive installs, so all of them stay
 * readable; only the current key is ever written. */
const APP_META_TOP_KEY = '_plotline';
const LEGACY_APP_META_TOP_KEYS = ['_countwhen', '_wdapp'];

const readAppMeta = (obj) => {
  if (!obj) return undefined;
  if (obj[APP_META_TOP_KEY]) return obj[APP_META_TOP_KEY];
  for (const k of LEGACY_APP_META_TOP_KEYS) if (obj[k]) return obj[k];
  return undefined;
};

const KNOWN_TOP_KEYS = new Set([
  'version', 'saveddatelong', 'saveddate', 'eventcount', 'topiccount',
  'measurements', 'pendtimes', 'topics', 'events', 'appdata',
  APP_META_TOP_KEY, ...LEGACY_APP_META_TOP_KEYS,
]);

/* In-app settings that live in the `meta` store rather than in the shared
 * backup schema. They ride along in a single extra top-level key so a Drive
 * round-trip (or a manual export/import) keeps topic colors, kinds, roles and
 * the quick-access bar. Readers that don't know the key ignore it. */
const APP_META_KEYS = [
  'topicKinds', 'topicMeta', 'topicOrder', 'quickBar',
  'topicRoles', 'insightSettings',
];

async function buildAppMeta() {
  const out = {};
  for (const k of APP_META_KEYS) {
    const v = await CWDB.getMeta(k);
    if (v != null) out[k] = v;
  }
  const favs = await CWDB.getAll('favorites');
  if (favs.length) out.favorites = favs;
  return out;
}

async function applyAppMeta(app) {
  if (!app || typeof app !== 'object') return;
  for (const k of APP_META_KEYS) {
    if (app[k] != null) await CWDB.setMeta(k, app[k]);
  }
  if (Array.isArray(app.favorites) && app.favorites.length) {
    await CWDB.putMany('favorites', app.favorites);
  }
}

function formatSavedDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function validateBackup(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    errors.push('File is not a JSON object.');
    return errors;
  }
  for (const k of REQUIRED_KEYS) {
    if (!Array.isArray(obj[k])) errors.push(`Missing or invalid "${k}" array.`);
  }
  if (Array.isArray(obj.topics)) {
    for (const [i, t] of obj.topics.entries()) {
      if (typeof t.id !== 'number') errors.push(`topics[${i}].id missing/non-numeric`);
      if (typeof t.name !== 'string') errors.push(`topics[${i}].name missing/non-string`);
    }
  }
  if (Array.isArray(obj.events)) {
    for (const [i, e] of obj.events.entries()) {
      if (typeof e.id !== 'number') { errors.push(`events[${i}].id missing/non-numeric`); break; }
      if (typeof e.time !== 'number') { errors.push(`events[${i}].time missing/non-numeric`); break; }
      if (typeof e.topicid !== 'number') { errors.push(`events[${i}].topicid missing/non-numeric`); break; }
    }
  }
  return errors;
}

function summarize(obj) {
  const events = obj.events || [];
  let minT = Infinity, maxT = -Infinity;
  for (const e of events) {
    if (e.time < minT) minT = e.time;
    if (e.time > maxT) maxT = e.time;
  }
  return {
    version: obj.version ?? '(unknown)',
    topics: (obj.topics || []).length,
    events: events.length,
    measurements: (obj.measurements || []).length,
    minTime: events.length ? new Date(minT) : null,
    maxTime: events.length ? new Date(maxT) : null,
    saveddate: obj.saveddate || '(not set)',
  };
}

/**
 * Replace local DB with the contents of `obj`.
 * Preserves unknown top-level keys in meta.extraKeys.
 */
async function importReplace(obj) {
  await CWDB.clearAll();
  await applyBackup(obj);
}

/**
 * Merge `obj` into local DB.
 *  - topics: keyed by name (case-insensitive). If a topic with the same
 *    name exists, reuse the existing id; otherwise allocate a new one
 *    that doesn't collide. Re-map event topicids accordingly.
 *  - events: keyed by id. Skip duplicates by id+topicid+time.
 */
async function importMerge(obj) {
  // existing topics
  const existingTopics = await CWDB.getAll('topics');
  const existingByName = new Map(
    existingTopics.map((t) => [t.name.toLowerCase(), t]));
  const existingIds = new Set(existingTopics.map((t) => t.id));
  let nextTopicId = existingTopics.reduce((m, t) => Math.max(m, t.id), 0) + 1;

  const topicIdMap = new Map(); // incoming id -> final id
  const topicsToWrite = [];
  for (const t of (obj.topics || [])) {
    const key = (t.name || '').toLowerCase();
    if (existingByName.has(key)) {
      topicIdMap.set(t.id, existingByName.get(key).id);
    } else {
      let finalId = t.id;
      if (existingIds.has(finalId)) finalId = nextTopicId++;
      existingIds.add(finalId);
      const newTopic = { ...t, id: finalId };
      topicIdMap.set(t.id, finalId);
      topicsToWrite.push(newTopic);
      existingByName.set(key, newTopic);
    }
  }
  if (topicsToWrite.length) await CWDB.putMany('topics', topicsToWrite);

  // existing events: build a dedupe set by topicid|time
  const existingEvents = await CWDB.getAll('events');
  const existingEventIds = new Set(existingEvents.map((e) => e.id));
  const existingEventKeys = new Set(
    existingEvents.map((e) => `${e.topicid}|${e.time}|${e.qant}`));
  let nextEventId = existingEvents.reduce((m, e) => Math.max(m, e.id), 0) + 1;

  const eventsToWrite = [];
  for (const e of (obj.events || [])) {
    const mappedTopic = topicIdMap.get(e.topicid) ?? e.topicid;
    const key = `${mappedTopic}|${e.time}|${e.qant ?? 0}`;
    if (existingEventKeys.has(key)) continue;
    let finalId = e.id;
    if (existingEventIds.has(finalId)) finalId = nextEventId++;
    existingEventIds.add(finalId);
    existingEventKeys.add(key);
    eventsToWrite.push({ ...e, id: finalId, topicid: mappedTopic });
  }
  if (eventsToWrite.length) await CWDB.putMany('events', eventsToWrite);

  // Merge measurements / pendtimes / appdata by id/name; existing wins.
  if (Array.isArray(obj.measurements)) {
    const existing = await CWDB.getAll('measurements');
    const have = new Set(existing.map((m) => m.id));
    const add = obj.measurements.filter((m) => !have.has(m.id));
    if (add.length) await CWDB.putMany('measurements', add);
  }
  if (Array.isArray(obj.pendtimes)) {
    const existing = await CWDB.getAll('pendtimes');
    const have = new Set(existing.map((p) => p.id));
    const add = obj.pendtimes.filter((p) => !have.has(p.id));
    if (add.length) await CWDB.putMany('pendtimes', add);
  }
  if (Array.isArray(obj.appdata)) {
    const existing = await CWDB.getAll('appdata');
    const have = new Set(existing.map((a) => a.name));
    const add = obj.appdata.filter((a) => !have.has(a.name));
    if (add.length) await CWDB.putMany('appdata', add);
  }

  const appMeta = readAppMeta(obj);
  if (appMeta) await applyAppMeta(appMeta);
  await preserveUnknownKeys(obj);
}

async function applyBackup(obj) {
  if (Array.isArray(obj.measurements) && obj.measurements.length) {
    await CWDB.putMany('measurements', obj.measurements);
  } else {
    await CWDB.putMany('measurements', window.CWDB_DEFAULT_MEASUREMENTS);
  }
  if (Array.isArray(obj.pendtimes) && obj.pendtimes.length) {
    await CWDB.putMany('pendtimes', obj.pendtimes);
  } else {
    await CWDB.putMany('pendtimes', window.CWDB_DEFAULT_PENDTIMES);
  }
  if (Array.isArray(obj.topics)) await CWDB.putMany('topics', obj.topics);
  if (Array.isArray(obj.events)) await CWDB.putMany('events', obj.events);
  if (Array.isArray(obj.appdata)) await CWDB.putMany('appdata', obj.appdata);

  await applyAppMeta(readAppMeta(obj));
  await preserveUnknownKeys(obj);
  await CWDB.setMeta('lastImport', Date.now());
  await CWDB.setMeta('originalVersion', obj.version ?? 4);
}

async function preserveUnknownKeys(obj) {
  const extras = {};
  for (const k of Object.keys(obj)) {
    if (!KNOWN_TOP_KEYS.has(k)) extras[k] = obj[k];
  }
  if (Object.keys(extras).length) {
    await CWDB.setMeta('extraTopKeys', extras);
  }
}

async function buildExportObject() {
  const now = new Date();
  const [measurements, pendtimes, topics, events, appdata] = await Promise.all([
    CWDB.getAll('measurements'),
    CWDB.getAll('pendtimes'),
    CWDB.getAll('topics'),
    CWDB.getAll('events'),
    CWDB.getAll('appdata'),
  ]);

  // sort topics by name to match the original layout
  topics.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  // events: keep stable order; the original groups by topicid then desc time
  events.sort((a, b) => (a.topicid - b.topicid) || (b.time - a.time));
  measurements.sort((a, b) => {
    // duration measurements (type 3) listed first by id
    if (a.type !== b.type) return b.type - a.type;
    return a.id - b.id;
  });
  pendtimes.sort((a, b) => a.id - b.id);

  const version = await CWDB.getMeta('originalVersion', 4);
  const appMeta = await buildAppMeta();
  const out = {
    version,
    saveddatelong: now.getTime(),
    saveddate: formatSavedDate(now),
    eventcount: events.length,
    topiccount: topics.length,
    measurements,
    pendtimes,
    topics,
    events,
    appdata,
    [APP_META_TOP_KEY]: appMeta,
  };

  const extras = await CWDB.getMeta('extraTopKeys', {});
  for (const [k, v] of Object.entries(extras)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function downloadJSON(filename, obj) {
  const json = JSON.stringify(obj, null, 0); // compact like original
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportToFile(filename) {
  const obj = await buildExportObject();
  const name = filename || `plotline-backup.json`;
  downloadJSON(name, obj);
  await CWDB.setMeta('lastExport', Date.now());
}

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

async function exportToCsv(filename) {
  const [topics, events, measurements] = await Promise.all([
    CWDB.getAll('topics'),
    CWDB.getAll('events'),
    CWDB.getAll('measurements'),
  ]);
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const measById = new Map(measurements.map((m) => [m.id, m]));

  // Re-implement a tiny formatter so we don't depend on app.js here.
  const fmtQant = (qant, topic) => {
    if (!topic) return String(qant ?? '');
    const m = measById.get(topic.msureid);
    if (!m) return String(qant ?? '');
    if (m.type === 3) {
      const secs = Number(qant || 0);
      const h = Math.floor(secs / 3600);
      const mn = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (m.format === 7) return `${String(Math.floor(secs/60)).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (m.format === 6) return `${h}:${String(mn).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (m.format === 4) return `${(secs/3600).toFixed(1)} ${m.symbol}`;
      if (m.format === 3) return `${Math.round(secs/60)} ${m.symbol}`;
      if (m.format === 2) return `${secs} ${m.symbol}`;
      if (h === 0) return `${mn}m`;
      return `${h}:${String(mn).padStart(2,'0')}`;
    }
    return `${qant}${m.symbol || ''}`;
  };

  const TAG_RE = /#([A-Za-z0-9_][A-Za-z0-9_-]{0,30})/g;
  const extractTags = (note) => {
    if (!note) return '';
    const out = [];
    let m;
    while ((m = TAG_RE.exec(note)) !== null) out.push(m[1].toLowerCase());
    return out.join(' ');
  };

  const header = ['id','time_iso','time_ms','topicid','topic_name','qant_raw','qant_formatted','measurement','cost_severity','tags','note'];
  const lines = [header.map(csvEscape).join(',')];
  const sorted = events.slice().sort((a, b) => a.time - b.time);
  for (const e of sorted) {
    const t = topicById.get(e.topicid);
    const m = t ? measById.get(t.msureid) : null;
    lines.push([
      e.id,
      new Date(e.time).toISOString(),
      e.time,
      e.topicid,
      t ? t.name : '',
      e.qant ?? 0,
      t ? fmtQant(e.qant, t) : (e.qant ?? ''),
      m ? m.name : '',
      e.cost ?? 0,
      extractTags(e.note),
      e.note || '',
    ].map(csvEscape).join(','));
  }
  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'plotline-events.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function safetyBackup() {
  const events = await CWDB.getAll('events');
  if (!events.length) return; // nothing to back up
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-` +
                `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  await exportToFile(`plotline-backup-${stamp}.json`);
}

window.CWIO = {
  APP_META_KEYS,
  buildAppMeta,
  applyAppMeta,
  applyBackup,
  validateBackup,
  summarize,
  importReplace,
  importMerge,
  buildExportObject,
  exportToFile,
  exportToCsv,
  safetyBackup,
  downloadJSON,
};
