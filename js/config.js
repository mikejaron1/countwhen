/* CountWhen - configuration.
 * Edit this file once and redeploy.
 *
 * To enable Google Drive sync:
 *   1. Create a Google OAuth Client ID (Web application) in Google
 *      Cloud Console — see README for the 6-step walkthrough.
 *   2. Paste it as `driveClientId` below.
 *   3. Save, then run ./deploy.sh to publish.
 *   4. Reload the app on your phone — Drive sync now works.
 *
 * Everything else has sensible defaults; leave it alone unless you
 * know you want a different behavior.
 */

/* App version — BUMP THIS on every change so you can confirm which
 * build is actually running on your device. Shown at the bottom of
 * the ☰ menu. Keep it in sync with CACHE_VERSION in sw.js. */
window.CW_VERSION = 'v7.0.1 · CountWhen · 2026-08-12';

window.CW_CONFIG = {
  // Google OAuth 2.0 Client ID (Web application). Looks like:
  //   "123456789012-abc...xyz.apps.googleusercontent.com"
  // Leave empty ("") to disable Drive sync entirely; the app still
  // works fully offline with manual Export / Import JSON.
  driveClientId: '377102902188-joh759ie7vtmfd6uo2n4prucbgo1fde7.apps.googleusercontent.com',

  // If true, Drive sync only runs when the device is on Wi-Fi or
  // Ethernet (never on cellular). Recommended.
  wifiOnly: true,

  // If true, the app silently syncs to Drive a few seconds after
  // any event/topic change.
  autoSyncOnChange: true,

  // If true, the app attempts a silent sync at startup (if it's been
  // more than 15 minutes since the last sync).
  autoSyncOnStartup: true,

  // Minimum gap between auto-syncs (ms). Acts as a debounce.
  autoSyncDebounceMs: 5000,
};
