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

async function findSyncFile(folderId) {
  return findFileInFolder(folderId, DRIVE_FILE_NAME);
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

/* Rotate any existing whendidibk.json to whendidibk-1.json, shifting
 * older versions down. Keep at most DRIVE_MAX_VERSIONS. Best-effort:
 * any error here is non-fatal — it shouldn't block the upload.
 */
async function rotateVersions(folderId) {
  try {
    const cur = await findFileInFolder(folderId, DRIVE_FILE_NAME);
    if (!cur) return;
    // Find existing version files
    const existing = [];
    for (let i = 1; i <= DRIVE_MAX_VERSIONS + 2; i++) {
      const f = await findFileInFolder(folderId, `whendidibk-${i}.json`);
      if (f) existing.push({ idx: i, file: f });
    }
    // Sort by index asc; delete anything that would push past max
    existing.sort((a, b) => a.idx - b.idx);
    // After rotation: the highest desired index is (DRIVE_MAX_VERSIONS).
    // We will rename existing N → N+1 starting from highest. Anything
    // above DRIVE_MAX_VERSIONS gets deleted.
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
    // Now rename current to -1
    await driveFetch(`/drive/v3/files/${cur.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'whendidibk-1.json' }),
    });
  } catch (e) {
    // Versioning is a nice-to-have; log and continue with the upload
    console.warn('drive version rotation failed:', e?.message || e);
  }
}

async function uploadSyncFile() {
  const folderId = await findOrCreateFolder();
  // Rotate previous versions first (best-effort)
  await rotateVersions(folderId);
  // After rotation there is no current whendidibk.json — create a new
  // one with the current data.
  const obj = await WDIO.buildExportObject();
  const json = JSON.stringify(obj);

  const boundary = '-------whendidi-boundary-' + Math.random().toString(36).slice(2);
  const metadata = {
    name: DRIVE_FILE_NAME,
    parents: [folderId],
    mimeType: 'application/json',
  };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    json + `\r\n` +
    `--${boundary}--`;
  const resp = await driveFetch(`/upload/drive/v3/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await resp.json()).id;
}

async function downloadSyncFile() {
  const folderId = await findOrCreateFolder();
  const file = await findSyncFile(folderId);
  if (!file) return null;
  const resp = await driveFetch(`/drive/v3/files/${file.id}?alt=media`);
  return await resp.json();
}

/* ---------- public sync ops ---------- */

async function syncUp({ interactive = false } = {}) {
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  if (!isOnline()) throw new Error('OFFLINE');
  if (!wifiOk()) throw new Error('CELLULAR_BLOCKED');
  await (interactive ? getTokenInteractive() : getTokenSilent());
  await uploadSyncFile();
  await WDDB.setMeta('lastDriveSync', Date.now());
  setStatus('ok', '☁ synced');
}

async function syncDown({ interactive = true } = {}) {
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  if (!isOnline()) throw new Error('OFFLINE');
  await (interactive ? getTokenInteractive() : getTokenSilent());
  const obj = await downloadSyncFile();
  if (!obj) throw new Error('NO_REMOTE_FILE');
  const errs = WDIO.validateBackup(obj);
  if (errs.length) throw new Error('INVALID_REMOTE: ' + errs[0]);
  await WDIO.safetyBackup();
  await WDIO.importReplace(obj);
  await WDDB.setMeta('lastDriveSync', Date.now());
  setStatus('ok', '☁ restored');
  return obj;
}

/* ---------- auto-sync ---------- */

function queueAutoSync(reason = 'change') {
  if (!CFG().autoSyncOnChange) return;
  const debounce = Math.max(1000, Number(CFG().autoSyncDebounceMs) || 5000);
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  setStatus('', '☁ queued…');
  _autoSyncTimer = setTimeout(async () => {
    _autoSyncTimer = null;
    try {
      await syncUp({ interactive: false });
    } catch (e) {
      handleAutoSyncFailure(e);
    }
  }, debounce);
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
  if (gap < 15 * 60 * 1000) return;  // synced recently
  try {
    await syncUp({ interactive: false });
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
          <ul>
            <li>Auto-sync on change: ${CFG().autoSyncOnChange ? 'on' : 'off'}</li>
            <li>Auto-sync at startup: ${CFG().autoSyncOnStartup ? 'on' : 'off'}</li>
            <li>Wi-Fi only: ${CFG().wifiOnly ? 'on' : 'off'} (current network: ${wifiLabel})</li>
            <li>Last sync: ${last ? new Date(last).toLocaleString() : 'never'}</li>
          </ul>
          <p style="font-size:13px;color:#666;">To change any of these, edit
          <code>js/config.js</code> and redeploy the app.</p>
        ` : `
          <p>Drive sync is <strong>not configured</strong>.</p>
          <p>Open <code>js/config.js</code> in your hosted app, paste your
          Google OAuth Client ID, and redeploy. Detailed steps in the README.
          ${idbId ? '<br>(Legacy IDB Client ID found and will be used as a fallback.)' : ''}</p>
        `}
        <p style="font-size:13px;color:#666;">Scope used: <code>drive.file</code> — this app
        can only see / modify files it created (folder
        <code>${DRIVE_FOLDER_NAME}/${DRIVE_FILE_NAME}</code> in your Drive).</p>
      </div>
      <div class="actions">
        ${cfgId || idbId ? `<button class="btn secondary" id="driveSyncDown">Restore from Drive</button>` : ''}
        ${cfgId || idbId ? `<button class="btn" id="driveSyncUp">Sync Now</button>` : '<button class="btn" data-close>OK</button>'}
      </div>
    `);
    const up = document.getElementById('driveSyncUp');
    if (up) up.addEventListener('click', async () => {
      try {
        await syncUp({ interactive: true });
        closeModal(); snack('Synced up to Drive');
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
  syncUp, syncDown, openSetupDialog,
  queueAutoSync, startupSync,
  isOnWifi, wifiOk,
  hasClientId: async () => !!(await getClientId()),
};
