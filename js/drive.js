/* CountWhen - Google Drive sync (optional).
 *
 * Configuration lives in js/config.js — set window.CW_CONFIG.driveClientId
 * to your OAuth Client ID and the rest is automatic:
 *
 *   - Silent token request on startup (if last sync > 15 min ago)
 *   - Debounced auto-sync after every save (configurable)
 *   - Skips sync when the device is on cellular if wifiOnly is true
 *
 * Scope is drive.file — the app can only see / modify files it creates.
 */

const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'CountWhen';
const DRIVE_FILE_NAME = 'countwhen.json';
const SNAPSHOT_NAME = (i) => `countwhen-${i}.json`;

/* Installs that synced under the app's previous name keep their backups under
 * the names below. Both the folder and the files are renamed in place rather
 * than recreated, so existing Drive file IDs — and the revision history
 * attached to them — survive the rebrand instead of being orphaned. These
 * three strings are load-bearing: removing them strands that data. */
const DRIVE_LEGACY_FOLDER_NAME = 'WhenDidI';
const DRIVE_LEGACY_FILE_NAME = 'whendidibk.json';
const LEGACY_SNAPSHOT_NAME = (i) => `whendidibk-${i}.json`;

const DRIVE_MAX_VERSIONS = 5; // rotated snapshots

/* Minimum age of the newest snapshot before another one is cut.
 *
 * The five slots are only useful if they span time. Without a gap they hold
 * the last five *changed* states, which on a busy logging day is five copies
 * from the same hour — plenty of redundancy for a mistake caught immediately
 * (which Drive's own 30-day revision history on the primary file already
 * covers) and no help at all for a bad delete noticed next week. At 12h the
 * same five files reach back two and a half days at worst, and typically
 * much further. */
const DRIVE_MIN_SNAPSHOT_GAP_MS = 12 * 60 * 60 * 1000;

/* Top-level key carrying CountWhen's own settings inside a backup, plus the
 * name it used before the rebrand (still read so older files merge cleanly). */
const APP_META_KEY = '_countwhen';
const LEGACY_APP_META_KEY = '_wdapp';

const CFG = () => window.CW_CONFIG || {};

let _gisLoaded = false;
let _tokenClient = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _autoSyncTimer = null;
let _consecutiveSilentFailures = 0;

/* ---------- helpers ---------- */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function ensureGis() {
  if (_gisLoaded) return;
  await loadScript('https://accounts.google.com/gsi/client');
  _gisLoaded = true;
}

function getClientId() {
  // Prefer config.js (user edits once and redeploys); fall back to any
  // previously-saved IDB value for backward compatibility.
  const fromCfg = (CFG().driveClientId || '').trim();
  if (fromCfg) return Promise.resolve(fromCfg);
  return CWDB.getMeta('driveClientId').then((v) => (v || '').trim());
}

function isOnline() {
  return navigator.onLine !== false;
}

function isOnWifi() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return null;  // unknown
  if (conn.type) {
    // Known enum values: bluetooth | cellular | ethernet | mixed | none |
    //                    other | unknown | wifi | wimax
    if (conn.type === 'wifi' || conn.type === 'ethernet' || conn.type === 'wimax') return true;
    if (conn.type === 'cellular') return false;
    return null;
  }
  // No `type` field — can't tell.
  return null;
}

function wifiOk() {
  if (!CFG().wifiOnly) return true;
  const wifi = isOnWifi();
  if (wifi === null) return true;  // unknown — be permissive on desktops
  return wifi === true;
}

function setStatus(status, msg) {
  // Update the small sync pill in the header if present
  const el = document.getElementById('syncPill');
  if (!el) return;
  el.classList.remove('ok', 'error');
  if (status === 'ok') el.classList.add('ok');
  if (status === 'error') el.classList.add('error');
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
}

/* ---------- token / OAuth ---------- */

async function getTokenInteractive() {
  return _requestToken(true);
}
async function getTokenSilent() {
  return _requestToken(false);
}

async function _requestToken(interactive) {
  if (_accessToken && Date.now() < _tokenExpiry - 30000) return _accessToken;
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  await ensureGis();
  return new Promise((resolve, reject) => {
    if (!_tokenClient || _tokenClient._clientId !== clientId) {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPES,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error));
          _accessToken = resp.access_token;
          _tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
          _consecutiveSilentFailures = 0;
          resolve(_accessToken);
        },
        error_callback: (err) => {
          reject(new Error(err.type || 'oauth_error'));
        },
      });
      _tokenClient._clientId = clientId;
    } else {
      _tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        _accessToken = resp.access_token;
        _tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        _consecutiveSilentFailures = 0;
        resolve(_accessToken);
      };
    }
    try {
      _tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    } catch (e) { reject(e); }
  });
}

/* ---------- Drive REST ---------- */

async function driveFetch(path, opts = {}) {
  const token = _accessToken;
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  const resp = await fetch(`https://www.googleapis.com${path}`, { ...opts, headers });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Drive ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp;
}

async function findOrCreateFolder() {
  const findByName = async (name) => {
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`
    );
    const resp = await driveFetch(`/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
    const data = await resp.json();
    return (data.files && data.files[0]) || null;
  };

  const current = await findByName(DRIVE_FOLDER_NAME);
  if (current) return current.id;

  // Pre-rebrand folder: rename in place so the existing backup and its
  // version history carry over instead of being orphaned.
  const legacy = await findByName(DRIVE_LEGACY_FOLDER_NAME);
  if (legacy) {
    try {
      await driveFetch(`/drive/v3/files/${legacy.id}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DRIVE_FOLDER_NAME }),
      });
    } catch (e) {
      console.warn('Could not rename legacy Drive folder; using it as-is.', e);
    }
    return legacy.id;
  }

  const createResp = await driveFetch('/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  return (await createResp.json()).id;
}

async function findFileInFolder(folderId, name) {
  const q = encodeURIComponent(
    `name='${name}' and '${folderId}' in parents and trashed=false`
  );
  const resp = await driveFetch(
    `/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,md5Checksum)&spaces=drive`);
  const data = await resp.json();
  return (data.files && data.files[0]) || null;
}

async function copyDriveFile(srcId, newName, parents) {
  const resp = await driveFetch(`/drive/v3/files/${srcId}/copy?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName, parents }),
  });
  return (await resp.json()).id;
}

async function deleteDriveFile(id) {
  await driveFetch(`/drive/v3/files/${id}`, { method: 'DELETE' });
}

/* Recoverable removal, used for legacy leftovers so a mistake is undoable
 * from the Drive trash. Rotation overflow still hard-deletes. */
async function trashDriveFile(id) {
  await driveFetch(`/drive/v3/files/${id}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

/* Keep up to DRIVE_MAX_VERSIONS historical snapshots alongside the primary
 * file, WITHOUT touching the primary file's id. The primary file is updated in
 * place so its Drive `modifiedTime` can be used for conflict detection.
 * Snapshots left over from the previous name are picked up by the legacy
 * lookup and rotate into the current naming scheme.
 *
 * Rotation is skipped when the primary file's contents are byte-identical to
 * the newest snapshot (Drive's md5Checksum), and when that snapshot is younger
 * than DRIVE_MIN_SNAPSHOT_GAP_MS: auto-sync fires after every save, so without
 * both checks a single busy afternoon would push five near-identical copies
 * through the ring and discard the older history that is actually worth
 * keeping.
 *
 * Best-effort: any failure here is non-fatal.
 */
async function rotateVersions(folderId, currentFileId, currentMd5 = null) {
  try {
    if (!currentFileId) return;
    const existing = [];
    for (let i = 1; i <= DRIVE_MAX_VERSIONS + 2; i++) {
      const f = (await findFileInFolder(folderId, SNAPSHOT_NAME(i)))
             || (await findFileInFolder(folderId, LEGACY_SNAPSHOT_NAME(i)));
      if (f) existing.push({ idx: i, file: f });
    }
    existing.sort((a, b) => a.idx - b.idx);

    const newest = existing.length && existing[0].idx === 1 ? existing[0].file : null;
    if (newest) {
      if (currentMd5 && newest.md5Checksum === currentMd5) return;
      const age = Date.now() - (Date.parse(newest.modifiedTime) || 0);
      if (age < DRIVE_MIN_SNAPSHOT_GAP_MS) return;
    }

    // Shift from the highest index down so we never collide with a name.
    for (let i = existing.length - 1; i >= 0; i--) {
      const slot = existing[i];
      const newIdx = slot.idx + 1;
      if (newIdx > DRIVE_MAX_VERSIONS) {
        await deleteDriveFile(slot.file.id);
      } else {
        await renameDriveFile(slot.file.id, SNAPSHOT_NAME(newIdx));
      }
    }
    // Snapshot the current contents as -1 (a copy, so the id stays stable).
    await copyDriveFile(currentFileId, SNAPSHOT_NAME(1), [folderId]);
  } catch (e) {
    console.warn('drive version rotation failed:', e?.message || e);
  }
}

/* Sweep up pre-rebrand artifacts the in-place renames can't reach.
 *
 * `statSyncFile` / `rotateVersions` only rename a legacy file when the
 * equivalent current-name file is absent; when both exist (two devices
 * upgrading at different times) the legacy copy is skipped forever and shows
 * up as a duplicate. Same for the legacy folder, which `findOrCreateFolder`
 * leaves untouched if a CountWhen folder already exists.
 *
 * Duplicates are trashed (recoverable), orphans are renamed into the current
 * scheme, and the legacy folder is only trashed once it holds nothing this app
 * can see. Best-effort: any failure here is non-fatal.
 */
async function cleanupLegacyArtifacts(folderId) {
  let found = 0;
  try {
    const pairs = [[DRIVE_LEGACY_FILE_NAME, DRIVE_FILE_NAME]];
    for (let i = 1; i <= DRIVE_MAX_VERSIONS; i++) {
      pairs.push([LEGACY_SNAPSHOT_NAME(i), SNAPSHOT_NAME(i)]);
    }
    for (const [legacyName, currentName] of pairs) {
      const legacy = await findFileInFolder(folderId, legacyName);
      if (!legacy) continue;
      found++;
      const current = await findFileInFolder(folderId, currentName);
      if (current) await trashDriveFile(legacy.id);
      else await renameDriveFile(legacy.id, currentName);
    }

    // Legacy snapshots past the current retention window have no counterpart
    // to rotate into, so drop them outright.
    for (let i = DRIVE_MAX_VERSIONS + 1; i <= DRIVE_MAX_VERSIONS + 5; i++) {
      const stale = await findFileInFolder(folderId, LEGACY_SNAPSHOT_NAME(i));
      if (stale) { found++; await trashDriveFile(stale.id); }
    }

    const folderQ = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and ` +
      `name='${DRIVE_LEGACY_FOLDER_NAME}' and trashed=false`
    );
    const folderResp = await driveFetch(
      `/drive/v3/files?q=${folderQ}&fields=files(id)&spaces=drive`);
    const legacyFolders = (await folderResp.json()).files || [];
    for (const f of legacyFolders) {
      if (f.id === folderId) continue;
      found++;
      const childQ = encodeURIComponent(`'${f.id}' in parents and trashed=false`);
      const childResp = await driveFetch(
        `/drive/v3/files?q=${childQ}&fields=files(id)&pageSize=1&spaces=drive`);
      const children = (await childResp.json()).files || [];
      // Anything still inside is data we'd rather strand than destroy.
      if (!children.length) await trashDriveFile(f.id);
    }
    return { found, complete: true };
  } catch (e) {
    console.warn('drive legacy cleanup failed:', e?.message || e);
    return { found, complete: false };
  }
}

/* The sweep costs a handful of requests and only ever has work to do on an
 * install carried over from the old name, so run it at most once a day and
 * stop entirely after a clean pass finds nothing left to migrate. */
async function maybeCleanupLegacyArtifacts(folderId) {
  try {
    if (await CWDB.getMeta('driveLegacyCleanupDone')) return;
    const last = Number(await CWDB.getMeta('driveLegacyCleanupAt')) || 0;
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    await CWDB.setMeta('driveLegacyCleanupAt', Date.now());
    const { found, complete } = await cleanupLegacyArtifacts(folderId);
    if (complete && !found) await CWDB.setMeta('driveLegacyCleanupDone', true);
  } catch (e) {
    console.warn('drive legacy cleanup skipped:', e?.message || e);
  }
}

const FILE_FIELDS = 'id,name,modifiedTime,md5Checksum,size';

async function createSyncFile(folderId, obj) {
  const json = JSON.stringify(obj);
  const boundary = '-------countwhen-boundary-' + Math.random().toString(36).slice(2);
  const metadata = { name: DRIVE_FILE_NAME, parents: [folderId], mimeType: 'application/json' };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    json + `\r\n` +
    `--${boundary}--`;
  const resp = await driveFetch(
    `/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  return await resp.json();
}

/* Overwrite the primary file's contents, keeping its id. */
async function updateSyncFile(fileId, obj) {
  const resp = await driveFetch(
    `/upload/drive/v3/files/${fileId}?uploadType=media&fields=${FILE_FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
  return await resp.json();
}

async function readSyncFile(fileId) {
  const resp = await driveFetch(`/drive/v3/files/${fileId}?alt=media`);
  return await resp.json();
}

async function renameDriveFile(fileId, name) {
  await driveFetch(`/drive/v3/files/${fileId}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

async function statSyncFile(folderId) {
  const lookup = async (name) => {
    const q = encodeURIComponent(
      `name='${name}' and '${folderId}' in parents and trashed=false`
    );
    const resp = await driveFetch(
      `/drive/v3/files?q=${q}&fields=files(${FILE_FIELDS})&spaces=drive`);
    const data = await resp.json();
    return (data.files && data.files[0]) || null;
  };

  const current = await lookup(DRIVE_FILE_NAME);
  if (current) return current;

  // Pre-rebrand sync file: rename in place so its id and revision history
  // carry over. If the rename fails we still sync against the legacy file.
  const legacy = await lookup(DRIVE_LEGACY_FILE_NAME);
  if (legacy) {
    try {
      await renameDriveFile(legacy.id, DRIVE_FILE_NAME);
      legacy.name = DRIVE_FILE_NAME;
    } catch (e) {
      console.warn('Could not rename legacy Drive sync file; using it as-is.', e);
    }
    return legacy;
  }
  return null;
}

async function downloadSyncFile() {
  const folderId = await findOrCreateFolder();
  const file = await statSyncFile(folderId);
  if (!file) return null;
  return await readSyncFile(file.id);
}

/* ---------- three-way merge ---------- */

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function sameRecord(a, b) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return stableStringify(a) === stableStringify(b);
}

/* Merge one id-keyed collection. `preferRemote` breaks true conflicts
 * (both sides changed the same record differently since the last sync). */
function mergeCollection(baseArr, localArr, remoteArr, keyName, preferRemote, stats) {
  const index = (arr) => {
    const m = new Map();
    for (const it of (arr || [])) if (it && it[keyName] != null) m.set(it[keyName], it);
    return m;
  };
  const base = index(baseArr), local = index(localArr), remote = index(remoteArr);
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const out = [];
  for (const id of ids) {
    const b = base.get(id), l = local.get(id), r = remote.get(id);
    if (sameRecord(l, r)) {                      // both sides agree
      if (l !== undefined) out.push(l);
      continue;
    }
    if (l === undefined) {
      // Deleted locally. Honour the delete only if the remote didn't change
      // it since the base; otherwise keep the remote edit (never lose data).
      if (b !== undefined && sameRecord(b, r)) { stats.deleted++; continue; }
      out.push(r); stats.fromRemote++; continue;
    }
    if (r === undefined) {
      if (b !== undefined && sameRecord(b, l)) { stats.deleted++; continue; }
      out.push(l); stats.fromLocal++; continue;
    }
    if (sameRecord(b, l)) { out.push(r); stats.fromRemote++; continue; }  // only remote changed
    if (sameRecord(b, r)) { out.push(l); stats.fromLocal++; continue; }   // only local changed
    stats.conflicts++;                                                    // both changed
    out.push(preferRemote ? r : l);
  }
  return out;
}

/**
 * Three-way merge of two backup objects against the snapshot taken at
 * the last successful sync. Additive by nature (events have unique ids), so
 * in practice this is "union everything, and respect real deletions".
 */
function mergeBackups(base, local, remote, { preferRemote = false } = {}) {
  const b = base || {};
  const stats = { fromLocal: 0, fromRemote: 0, deleted: 0, conflicts: 0 };
  const out = {
    ...local,
    topics:       mergeCollection(b.topics, local.topics, remote.topics, 'id', preferRemote, stats),
    events:       mergeCollection(b.events, local.events, remote.events, 'id', preferRemote, stats),
    measurements: mergeCollection(b.measurements, local.measurements, remote.measurements, 'id', preferRemote, stats),
    pendtimes:    mergeCollection(b.pendtimes, local.pendtimes, remote.pendtimes, 'id', preferRemote, stats),
    appdata:      mergeCollection(b.appdata, local.appdata, remote.appdata, 'name', preferRemote, stats),
  };
  // In-app settings are a single blob: last writer wins. Either side may still
  // carry the pre-rebrand key; we read both and always write the current one.
  const readApp = (o) => o?.[APP_META_KEY] || o?.[LEGACY_APP_META_KEY];
  const localApp = readApp(local), remoteApp = readApp(remote);
  delete out[LEGACY_APP_META_KEY];
  if (localApp || remoteApp) {
    if (!localApp) out[APP_META_KEY] = remoteApp;
    else if (!remoteApp) out[APP_META_KEY] = localApp;
    else if (sameRecord(localApp, remoteApp)) out[APP_META_KEY] = localApp;
    else {
      out[APP_META_KEY] = preferRemote ? remoteApp : localApp;
      const baseApp = readApp(b);
      if (!sameRecord(baseApp, localApp) && !sameRecord(baseApp, remoteApp)) stats.conflicts++;
    }
  }
  out.events.sort((a, c) => (a.topicid - c.topicid) || (c.time - a.time));
  out.topics.sort((a, c) => (a.name || '').localeCompare(c.name || ''));
  out.eventcount = out.events.length;
  out.topiccount = out.topics.length;
  out.version = local.version ?? remote.version ?? 4;
  return { merged: out, stats };
}

/* ---------- public sync ops ---------- */

/**
 * Two-way sync.
 *
 *   - No remote file            -> create it from local data.
 *   - Remote unchanged since we
 *     last synced                -> straight upload (fast-forward).
 *   - Remote changed             -> download it, three-way merge against the
 *                                   snapshot we stored at the last sync,
 *                                   apply the merge locally, upload the result.
 *
 * True conflicts (the same record edited differently on both devices since
 * the last sync) are resolved in favour of whichever side was touched most
 * recently, and reported back to the caller so the UI can mention it.
 */
async function syncNow({ interactive = false, allowMerge = true, force = false } = {}) {
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  if (!isOnline()) throw new Error('OFFLINE');
  if (!interactive && !wifiOk()) throw new Error('CELLULAR_BLOCKED');
  await (interactive ? getTokenInteractive() : getTokenSilent());

  const folderId = await findOrCreateFolder();
  const remoteStat = await statSyncFile(folderId);
  const local = await CWIO.buildExportObject();

  // ---- 1. nothing on Drive yet ----
  if (!remoteStat) {
    const created = await createSyncFile(folderId, local);
    await rememberSyncPoint(created, local);
    setStatus('ok', '☁ synced');
    return { action: 'created', stats: null };
  }

  const known = (await CWDB.getMeta('driveRemoteMeta')) || {};
  const base = await CWDB.getMeta('driveSyncBase');
  const remoteUnchanged =
    force ||
    (known.fileId === remoteStat.id && known.modifiedTime === remoteStat.modifiedTime);

  // ---- 2. remote is exactly what we last wrote: fast-forward ----
  if (remoteUnchanged) {
    await rotateVersions(folderId, remoteStat.id, remoteStat.md5Checksum);
    const updated = await updateSyncFile(remoteStat.id, local);
    await rememberSyncPoint(updated, local);
    await maybeCleanupLegacyArtifacts(folderId);
    setStatus('ok', '☁ synced');
    return { action: 'uploaded', stats: null };
  }

  // ---- 3. remote moved on: merge ----
  if (!allowMerge) throw new Error('REMOTE_CHANGED');
  const remote = await readSyncFile(remoteStat.id);
  const errs = CWIO.validateBackup(remote);
  if (errs.length) throw new Error('INVALID_REMOTE: ' + errs[0]);

  // Without a base snapshot we can't tell edits from deletions, so fall back
  // to a purely additive union (base = empty) — nothing is ever lost.
  const lastLocalChange = (await CWDB.getMeta('lastLocalChangeAt')) || 0;
  const remoteTime = Date.parse(remoteStat.modifiedTime || 0) || 0;
  const preferRemote = remoteTime > lastLocalChange;

  const { merged, stats } = mergeBackups(base, local, remote, { preferRemote });
  stats.hadBase = !!base;

  const changedLocally =
    merged.events.length !== (local.events || []).length ||
    merged.topics.length !== (local.topics || []).length ||
    stats.fromRemote > 0;

  if (changedLocally) {
    await CWIO.safetyBackup();
    await CWDB.clearAll();
    await CWIO.applyBackup(merged);
  }
  await rotateVersions(folderId, remoteStat.id, remoteStat.md5Checksum);
  const updated = await updateSyncFile(remoteStat.id, merged);
  await rememberSyncPoint(updated, merged);
  await maybeCleanupLegacyArtifacts(folderId);
  setStatus('ok', '☁ merged');
  return { action: 'merged', stats, changedLocally };
}

/* Record what we just wrote so the next sync can detect remote edits. */
async function rememberSyncPoint(fileMeta, obj) {
  await CWDB.setMeta('driveRemoteMeta', {
    fileId: fileMeta.id,
    modifiedTime: fileMeta.modifiedTime,
    md5Checksum: fileMeta.md5Checksum || null,
  });
  await CWDB.setMeta('driveSyncBase', obj);
  await CWDB.setMeta('lastDriveSync', Date.now());
}

/* Upload-only (kept for the "Sync Now" button and older call sites). */
async function syncUp(opts = {}) {
  return syncNow(opts);
}

/* Explicit "throw away local, take what's on Drive". */
async function syncDown({ interactive = true } = {}) {
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  if (!isOnline()) throw new Error('OFFLINE');
  await (interactive ? getTokenInteractive() : getTokenSilent());
  const folderId = await findOrCreateFolder();
  const stat = await statSyncFile(folderId);
  if (!stat) throw new Error('NO_REMOTE_FILE');
  const obj = await readSyncFile(stat.id);
  const errs = CWIO.validateBackup(obj);
  if (errs.length) throw new Error('INVALID_REMOTE: ' + errs[0]);
  await CWIO.safetyBackup();
  await CWIO.importReplace(obj);
  await rememberSyncPoint(stat, obj);
  setStatus('ok', '☁ restored');
  return obj;
}

/* ---------- auto-sync ---------- */

function queueAutoSync(reason = 'change') {
  // Always stamp the local change, even if auto-sync is off — the timestamp
  // is what breaks conflict ties on the next manual sync.
  CWDB.setMeta('lastLocalChangeAt', Date.now()).catch(() => {});
  if (!CFG().autoSyncOnChange) return;
  const debounce = Math.max(1000, Number(CFG().autoSyncDebounceMs) || 5000);
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  setStatus('', '☁ queued…');
  _autoSyncTimer = setTimeout(async () => {
    _autoSyncTimer = null;
    try {
      const res = await syncNow({ interactive: false });
      await afterSync(res);
    } catch (e) {
      handleAutoSyncFailure(e);
    }
  }, debounce);
}

/* A merge can rewrite local data (events pulled in from the other device),
 * so refresh the UI when that happens. */
async function afterSync(res) {
  if (!res || res.action !== 'merged' || !res.changedLocally) return;
  try {
    await window.CWAPP?.reload?.();
    window.CWAPP?.renderCurrent?.();
    const s = res.stats || {};
    const bits = [];
    if (s.fromRemote) bits.push(`${s.fromRemote} pulled in`);
    if (s.conflicts) bits.push(`${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'} auto-resolved`);
    window.CWAPP?.snack?.(`Merged with Drive${bits.length ? ': ' + bits.join(', ') : ''}`);
  } catch (e) { console.warn('post-merge refresh failed', e); }
}

function handleAutoSyncFailure(e) {
  const msg = String(e?.message || e);
  if (msg === 'NO_CLIENT_ID') { setStatus('', ''); return; }   // not configured
  if (msg === 'CELLULAR_BLOCKED') { setStatus('error', '☁ off (cellular)'); return; }
  if (msg === 'OFFLINE') { setStatus('error', '☁ offline'); return; }
  // Token / OAuth errors: silent prompt failed — needs user action.
  _consecutiveSilentFailures++;
  setStatus('error', '☁ tap to fix');
  // After 2 silent failures, give up auto-syncing until user taps Sync Now.
}

async function startupSync() {
  if (!CFG().autoSyncOnStartup) return;
  const clientId = await getClientId();
  if (!clientId) return;
  const last = await CWDB.getMeta('lastDriveSync', 0);
  const gap = Date.now() - (last || 0);
  // Short gap only: sync is two-way now, so opening the app is how we find
  // out about edits made on the other device.
  if (gap < 2 * 60 * 1000) return;
  try {
    const res = await syncNow({ interactive: false });
    await afterSync(res);
  } catch (e) {
    handleAutoSyncFailure(e);
  }
}

async function disconnect() {
  _accessToken = null;
  _tokenExpiry = 0;
  // Note: we don't wipe config.js (file-based) — only the IDB fallback.
  await CWDB.setMeta('driveClientId', null);
}

/* Drop any cached token/client so the next sync re-authorizes. Needed when
 * the client ID changes underneath us. */
function resetTokenClient() {
  _tokenClient = null;
  _accessToken = null;
  _tokenExpiry = 0;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- in-app dialog ---------- */

function openSetupDialog(ctx) {
  const { openModal, closeModal, snack, reload, renderCurrent } = ctx;
  (async () => {
    const cfgId = (CFG().driveClientId || '').trim();
    const idbId = await CWDB.getMeta('driveClientId', '');
    const last = await CWDB.getMeta('lastDriveSync', 0);
    const wifiState = isOnWifi();
    const wifiLabel = wifiState === true ? 'Wi-Fi' : wifiState === false ? 'Cellular' : 'Unknown';

    openModal(`
      <header><button class="icon-btn" data-close>←</button><div class="title">Google Drive sync</div></header>
      <div class="body">
        ${cfgId ? `
          <p>✅ Drive sync is <strong>configured</strong> via <code>config.js</code>.</p>
          <p style="font-size:13px;color:#666;">Sync is <strong>two-way</strong>: each sync
          checks whether the file on Drive changed since your last sync and merges both
          sides (a three-way merge against the last-synced snapshot). Deletions are
          respected; if the same entry was edited on two devices, the most recently
          touched device wins.</p>
          <ul>
            <li>Auto-sync on change: ${CFG().autoSyncOnChange ? 'on' : 'off'}</li>
            <li>Auto-sync at startup: ${CFG().autoSyncOnStartup ? 'on' : 'off'}</li>
            <li>Wi-Fi only: ${CFG().wifiOnly ? 'on' : 'off'} (current network: ${wifiLabel})</li>
            <li>Last sync: ${last ? new Date(last).toLocaleString() : 'never'}</li>
            <li>Snapshots kept on Drive: ${DRIVE_MAX_VERSIONS}</li>
          </ul>
          <p style="font-size:13px;color:#666;">To change any of these, edit
          <code>js/config.js</code> and redeploy the app.</p>
        ` : `
          <p>Drive sync is <strong>${idbId ? 'set up on this device' : 'not configured'}</strong>.</p>
          <p style="font-size:13px;color:#666;">Backup goes to <em>your own</em> Google Drive.
          To enable it, create a Google OAuth Client ID (Web application) in the
          Google Cloud Console and paste it below — the README has a step-by-step
          walkthrough. Leave it empty to keep Drive sync off; Export / Import JSON
          works without any of this.</p>
          <div class="field">
            <label for="driveClientIdInput">OAuth Client ID</label>
            <input id="driveClientIdInput" type="text" autocomplete="off"
              spellcheck="false" autocapitalize="off" autocorrect="off"
              inputmode="url"
              placeholder="1234567890-abc….apps.googleusercontent.com"
              value="${esc(idbId)}">
          </div>
          ${idbId ? `<ul><li>Last sync: ${last ? new Date(last).toLocaleString() : 'never'}</li></ul>` : ''}
        `}
        <p style="font-size:13px;color:#666;">Restore from Drive <em>replaces</em> everything on
        this device with the Drive copy (a safety backup downloads first). Normal
        <strong>Sync now</strong> merges instead.</p>
        <p style="font-size:13px;color:#666;">Scope used: <code>drive.file</code> — this app
        can only see / modify files it created (folder
        <code>${DRIVE_FOLDER_NAME}/${DRIVE_FILE_NAME}</code> in your Drive).</p>
      </div>
      <div class="actions">
        ${!cfgId ? `<button class="btn secondary" id="driveSaveId">Save ID</button>` : ''}
        ${cfgId || idbId ? `<button class="btn secondary" id="driveSyncDown">Restore from Drive</button>` : ''}
        ${cfgId || idbId ? `<button class="btn" id="driveSyncUp">Sync now</button>` : '<button class="btn" data-close>OK</button>'}
      </div>
    `);
    const save = document.getElementById('driveSaveId');
    if (save) save.addEventListener('click', async () => {
      // Mobile keyboards love to add spaces and capitals. A Google client ID
      // is always lowercase with no whitespace, so normalize both away rather
      // than bounce the user for something they can't see.
      const raw = document.getElementById('driveClientIdInput').value || '';
      const val = raw.replace(/\s+/g, '').toLowerCase();
      if (val && !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(val)) {
        snack('That does not look like a Client ID — it should end in .apps.googleusercontent.com');
        return;
      }
      await CWDB.setMeta('driveClientId', val || null);
      resetTokenClient();
      closeModal();
      snack(val ? 'Client ID saved — tap Sync now to connect' : 'Drive sync disabled');
    });
    const up = document.getElementById('driveSyncUp');
    if (up) up.addEventListener('click', async () => {
      try {
        const res = await syncNow({ interactive: true });
        if (res.action === 'merged' && res.changedLocally) {
          await reload(); renderCurrent();
          const st = res.stats || {};
          closeModal();
          snack(`Merged with Drive: ${st.fromRemote || 0} pulled in` +
            (st.conflicts ? `, ${st.conflicts} conflict(s) auto-resolved` : ''));
        } else {
          closeModal();
          snack(res.action === 'merged' ? 'Drive already up to date' : 'Synced to Drive');
        }
      } catch (e) {
        snack('Sync failed: ' + e.message);
      }
    });
    const dn = document.getElementById('driveSyncDown');
    if (dn) dn.addEventListener('click', async () => {
      try {
        await syncDown({ interactive: true });
        await reload(); renderCurrent();
        closeModal(); snack('Restored from Drive');
      } catch (e) {
        snack('Restore failed: ' + e.message);
      }
    });
  })();
}

/* ---------- network change → retry queued sync ---------- */
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (_autoSyncTimer) return;
    queueAutoSync('online');
  });
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  conn?.addEventListener?.('change', () => {
    if (wifiOk() && !_autoSyncTimer) queueAutoSync('connection');
  });
}

window.CWDRIVE = {
  syncNow, syncUp, syncDown, openSetupDialog, afterSync,
  mergeBackups, mergeCollection,
  queueAutoSync, startupSync,
  isOnWifi, wifiOk,
  hasClientId: async () => !!(await getClientId()),
};
