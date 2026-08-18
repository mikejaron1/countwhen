/* CountWhen - configuration.
 * Edit this file once and redeploy.
 *
 * To enable Google Drive sync:
 *   1. Create a Google OAuth Client ID (Web application) in Google
 *      Cloud Console — see README for the 6-step walkthrough.
 *   2. Paste it in the app under ☰ → Google Drive sync. (Self-hosting
 *      for yourself only? You can hard-code it as `driveClientId`
 *      below instead, but every user of that deployment then shares it.)
 *
 * Everything else has sensible defaults; leave it alone unless you
 * know you want a different behavior.
 */

/* App version — BUMP THIS on every change so you can confirm which
 * build is actually running on your device. Shown at the bottom of
 * the ☰ menu. Keep it in sync with CACHE_VERSION in sw.js. */
window.CW_VERSION = 'v7.3.1 · CountWhen · 2026-08-17';

window.CW_CONFIG = {
  // Google OAuth 2.0 Client ID (Web application). Looks like:
  //   "123456789012-abc...xyz.apps.googleusercontent.com"
  // Leave empty ("") for public builds: each user then pastes their own ID
  // under ☰ → Google Drive sync, so backups run through their own Google
  // project rather than yours. Setting it here forces that ID on every user
  // of this deployment — only do that for a personal, self-hosted copy.
  // Either way the app works fully offline with manual Export / Import JSON.
  driveClientId: '',

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
