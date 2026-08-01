/* WhenDidI - Google Drive sync (optional).
 *
 * Configuration lives in js/config.js — set window.WD_CONFIG.driveClientId
 * to your OAuth Client ID and the rest is automatic:
 *
 *   - Silent token request on startup (if last sync > 15 min ago)
 *   - Debounced auto-sync after every save (configurable)
 *   - Skips sync when the device is on cellular if wifiOnly is true
 *
 * Scope is drive.file — the app can only see / modify files it creates.
 */

const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'WhenDidI';
const DRIVE_FILE_NAME = 'whendidibk.json';
const DRIVE_MAX_VERSIONS = 5; // rotated snapshots

const CFG = () => window.WD_CONFIG || {};

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
  return WDDB.getMeta('driveClientId').then((v) => (v || '').trim());
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
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${DRIVE_FOLDER_NAME}' and trashed=false`
  );
  const resp = await driveFetch(`/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
  const data = await resp.json();
  if (data.files && data.files.length) return data.files[0].id;

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
  const resp = await driveFetch(`/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&spaces=drive`);
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

/* Keep up to DRIVE_MAX_VERSIONS historical snapshots as whendidibk-N.json,
 * WITHOUT touching the primary file's id. The primary file is updated in
 * place so its Drive `modifiedTime` can be used for conflict detection.
 * Best-effort: any failure here is non-fatal.
 */
async function rotateVersions(folderId, currentFileId) {
  try {
    if (!currentFileId) return;
    const existing = [];
    for (let i = 1; i <= DRIVE_MAX_VERSIONS + 2; i++) {
      const f = await findFileInFolder(folderId, `whendidibk-${i}.json`);
      if (f) existing.push({ idx: i, file: f });
    }
    existing.sort((a, b) => a.idx - b.idx);
    // Shift from the highest index down so we never collide with a name.
    for (let i = existing.length - 1; i >= 0; i--) {
      const slot = existing[i];
      const newIdx = slot.idx + 1;
      if (newIdx > DRIVE_MAX_VERSIONS) {
        await deleteDriveFile(slot.file.id);
      } else {
        await driveFetch(`/drive/v3/files/${slot.file.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `whendidibk-${newIdx}.json` }),
        });
      }
    }
    // Snapshot the current contents as -1 (a copy, so the id stays stable).
    await copyDriveFile(currentFileId, 'whendidibk-1.json', [folderId]);
  } catch (e) {
    console.warn('drive version rotation failed:', e?.message || e);
  }
}

const FILE_FIELDS = 'id,name,modifiedTime,md5Checksum,size';

async function createSyncFile(folderId, obj) {
  const json = JSON.stringify(obj);
  const boundary = '-------whendidi-boundary-' + Math.random().toString(36).slice(2);
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

async function statSyncFile(folderId) {
  const q = encodeURIComponent(
    `name='${DRIVE_FILE_NAME}' and '${folderId}' in parents and trashed=false`
  );
  const resp = await driveFetch(
    `/drive/v3/files?q=${q}&fields=files(${FILE_FIELDS})&spaces=drive`);
  const data = await resp.json();
  return (data.files && data.files[0]) || null;
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
 * Three-way merge of two whendidibk objects against the snapshot taken at
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
  // In-app settings are a single blob: last writer wins.
  const localApp = local._wdapp, remoteApp = remote._wdapp;
  if (localApp || remoteApp) {
    if (!localApp) out._wdapp = remoteApp;
    else if (!remoteApp) out._wdapp = localApp;
    else if (sameRecord(localApp, remoteApp)) out._wdapp = localApp;
    else {
      out._wdapp = preferRemote ? remoteApp : localApp;
      if (!sameRecord(b._wdapp, localApp) && !sameRecord(b._wdapp, remoteApp)) stats.conflicts++;
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
  const local = await WDIO.buildExportObject();

  // ---- 1. nothing on Drive yet ----
  if (!remoteStat) {
    const created = await createSyncFile(folderId, local);
    await rememberSyncPoint(created, local);
    setStatus('ok', '☁ synced');
    return { action: 'created', stats: null };
  }

  const known = (await WDDB.getMeta('driveRemoteMeta')) || {};
  const base = await WDDB.getMeta('driveSyncBase');
  const remoteUnchanged =
    force ||
    (known.fileId === remoteStat.id && known.modifiedTime === remoteStat.modifiedTime);

  // ---- 2. remote is exactly what we last wrote: fast-forward ----
  if (remoteUnchanged) {
    await rotateVersions(folderId, remoteStat.id);
    const updated = await updateSyncFile(remoteStat.id, local);
    await rememberSyncPoint(updated, local);
    setStatus('ok', '☁ synced');
    return { action: 'uploaded', stats: null };
  }

  // ---- 3. remote moved on: merge ----
  if (!allowMerge) throw new Error('REMOTE_CHANGED');
  const remote = await readSyncFile(remoteStat.id);
  const errs = WDIO.validateBackup(remote);
  if (errs.length) throw new Error('INVALID_REMOTE: ' + errs[0]);

  // Without a base snapshot we can't tell edits from deletions, so fall back
  // to a purely additive union (base = empty) — nothing is ever lost.
  const lastLocalChange = (await WDDB.getMeta('lastLocalChangeAt')) || 0;
  const remoteTime = Date.parse(remoteStat.modifiedTime || 0) || 0;
  const preferRemote = remoteTime > lastLocalChange;

  const { merged, stats } = mergeBackups(base, local, remote, { preferRemote });
  stats.hadBase = !!base;

  const changedLocally =
    merged.events.length !== (local.events || []).length ||
    merged.topics.length !== (local.topics || []).length ||
    stats.fromRemote > 0;

  if (changedLocally) {
    await WDIO.safetyBackup();
    await WDDB.clearAll();
    await WDIO.applyBackup(merged);
  }
  await rotateVersions(folderId, remoteStat.id);
  const updated = await updateSyncFile(remoteStat.id, merged);
  await rememberSyncPoint(updated, merged);
  setStatus('ok', '☁ merged');
  return { action: 'merged', stats, changedLocally };
}

/* Record what we just wrote so the next sync can detect remote edits. */
async function rememberSyncPoint(fileMeta, obj) {
  await WDDB.setMeta('driveRemoteMeta', {
    fileId: fileMeta.id,
    modifiedTime: fileMeta.modifiedTime,
    md5Checksum: fileMeta.md5Checksum || null,
  });
  await WDDB.setMeta('driveSyncBase', obj);
  await WDDB.setMeta('lastDriveSync', Date.now());
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
  const errs = WDIO.validateBackup(obj);
  if (errs.length) throw new Error('INVALID_REMOTE: ' + errs[0]);
  await WDIO.safetyBackup();
  await WDIO.importReplace(obj);
  await rememberSyncPoint(stat, obj);
  setStatus('ok', '☁ restored');
  return obj;
}

/* ---------- auto-sync ---------- */

function queueAutoSync(reason = 'change') {
  // Always stamp the local change, even if auto-sync is off — the timestamp
  // is what breaks conflict ties on the next manual sync.
  WDDB.setMeta('lastLocalChangeAt', Date.now()).catch(() => {});
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
    await window.WDAPP?.reload?.();
    window.WDAPP?.renderCurrent?.();
    const s = res.stats || {};
    const bits = [];
    if (s.fromRemote) bits.push(`${s.fromRemote} pulled in`);
    if (s.conflicts) bits.push(`${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'} auto-resolved`);
    window.WDAPP?.snack?.(`Merged with Drive${bits.length ? ': ' + bits.join(', ') : ''}`);
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
  const last = await WDDB.getMeta('lastDriveSync', 0);
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
  await WDDB.setMeta('driveClientId', null);
}

/* ---------- in-app dialog ---------- */

function openSetupDialog(ctx) {
  const { openModal, closeModal, snack, reload, renderCurrent } = ctx;
  (async () => {
    const cfgId = (CFG().driveClientId || '').trim();
    const idbId = await WDDB.getMeta('driveClientId', '');
    const last = await WDDB.getMeta('lastDriveSync', 0);
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
          <p>Drive sync is <strong>not configured</strong>.</p>
          <p>Open <code>js/config.js</code> in your hosted app, paste your
          Google OAuth Client ID, and redeploy. Detailed steps in the README.
          ${idbId ? '<br>(Legacy IDB Client ID found and will be used as a fallback.)' : ''}</p>
        `}
        <p style="font-size:13px;color:#666;">Restore from Drive <em>replaces</em> everything on
        this device with the Drive copy (a safety backup downloads first). Normal
        <strong>Sync now</strong> merges instead.</p>
        <p style="font-size:13px;color:#666;">Scope used: <code>drive.file</code> — this app
        can only see / modify files it created (folder
        <code>${DRIVE_FOLDER_NAME}/${DRIVE_FILE_NAME}</code> in your Drive).</p>
      </div>
      <div class="actions">
        ${cfgId || idbId ? `<button class="btn secondary" id="driveSyncDown">Restore from Drive</button>` : ''}
        ${cfgId || idbId ? `<button class="btn" id="driveSyncUp">Sync now</button>` : '<button class="btn" data-close>OK</button>'}
      </div>
    `);
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

window.WDDRIVE = {
  syncNow, syncUp, syncDown, openSetupDialog, afterSync,
  mergeBackups, mergeCollection,
  queueAutoSync, startupSync,
  isOnWifi, wifiOk,
  hasClientId: async () => !!(await getClientId()),
};
