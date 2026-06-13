# WhenDidI (PWA replacement)

A self-hosted, offline-first Progressive Web App that replaces the
discontinued **WhenDidI – Event Tracker** Android app (SJM Apps, last
updated 2018). Imports and exports the exact same `whendidibk.json`
backup format, so your years of history come along for the ride.

> Built specifically as a drop-in replacement for a Pixel 10 Pro user
> whose original install no longer works. Should be just as useful
> for anyone in the same boat.

## Live URL

**<https://mikejaron1.github.io/whendidi-pwa/>**

Open in Chrome on your phone, tap ⋮ → **Install app**. Done.

## Update workflow (for the dev)

This repo auto-deploys to GitHub Pages on every push to `main`.

```sh
cd ~/projects/whendidi-pwa
# (make edits)
./deploy.sh "what changed"
# Wait ~30-60s for Pages to rebuild, then reload the app on the phone.
```

No drag-and-drop, no console clicks. Pages handles the rest.

## Features

- **Categories** — full topic list with time-since-last + last-event
  date, just like the original. Big blue ADD button per row. **Long-
  press a card** to drag it into a new order; the order is saved.
  Tap a card to edit/archive/delete the topic. **+ New topic** button
  at the end of the list.
- **Recent** — chronological event feed, edit/delete any event.
- **Statistics** — daily / weekly / monthly counts (and sums for
  measured topics like ounces / gallons) with a bar chart.
- **Add / Edit Event** — date, time, duration (hh:mm) or amount, note.
- **Topics manager** — add, rename, archive, delete (also accessible
  via ☰ menu).
- **Quick-access bar** — pinned one-tap chips at the top of Categories
  for fast logging. Stays fixed in place (sticky) and keeps a fixed
  order. Curate exactly which topics appear and their order via
  ☰ menu → **Quick-access bar…**. When none are pinned, the bar falls
  back to auto-showing your most frequent recent topics.
- **Import / Export JSON** — byte-compatible with the original format.
  Import preview shows topic / event counts + date range; choose
  *Replace* (with auto-downloaded safety backup) or *Merge*
  (deduplicates by event id).
- **Offline-first** — service worker caches the app shell, all data
  in IndexedDB. Requests persistent storage so Chrome won't evict.
- **Installable** — Chrome will offer "Install" on first visit; lives
  as a real app icon on your home screen.
- **Google Drive sync** — silent auto-sync after every change once
  you've pasted your OAuth Client ID into `js/config.js`. Wi-Fi only
  by default.

## Install it on a Pixel (or any Android)

### Step 1 — Open the URL in Chrome

<https://mikejaron1.github.io/whendidi-pwa/>

### Step 2 — Install on the phone

1. Chrome shows an "Install app" prompt (or open the ⋮ menu →
   *Install app* / *Add to Home Screen*).
2. Confirm — the app appears on your home screen and launches in a
   standalone window, no browser chrome.

### Step 3 — Import your old data

1. Copy your `whendidibk.json` to your phone (email it, Drive it,
   USB, whatever).
2. Open the app → ☰ menu → **Import JSON** → pick the file.
3. Review the preview (topic + event counts + date range).
4. Tap **Replace** the first time. A safety backup of the current
   (empty) state will download first; then your old data loads.

## Local development / testing

The simplest dev loop:

```sh
cd ~/projects/whendidi-pwa
python3 -m http.server 8000
```

Open <http://localhost:8000> in a browser. Service worker + Drive
sync work on `localhost`.

To test on your phone over LAN:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

Then on the phone: `http://<your-mac-IP>:8000`. (Service worker
*won't* register over LAN HTTP though — install needs HTTPS.)

## Optional: Google Drive sync

Manual export/import via the Android share sheet to Drive works with
zero setup. If you'd rather have auto-sync after every change, set
this up once:

### One-time Google Cloud Console setup (~10 min)

1. Go to <https://console.cloud.google.com/>, create a project (free).
2. Enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → add your
   own Google account as a Test user.
4. **Credentials → Create Credentials → OAuth Client ID →
   Web application**.
5. Under **Authorized JavaScript origins** add the app's origin:
   `https://mikejaron1.github.io` (no path, no trailing slash).
6. Copy the resulting Client ID.

### Bake the Client ID into the app

7. Open `webapp/js/config.js` in any text editor.
8. Paste your Client ID between the quotes on the `driveClientId` line:

   ```js
   driveClientId: '123456789-abc...xyz.apps.googleusercontent.com',
   ```

9. Save the file, then deploy:

   ```sh
   cd ~/projects/whendidi-pwa
   ./deploy.sh "enable drive sync"
   ```

   (Or commit + push manually.)
10. Reload the app on your phone. The first time it syncs you'll see
    Google's "unverified app" warning — tap *Advanced → Go to WhenDidI
    (unsafe)* (it's *your* Cloud project, talking to *your* Drive).

That's it — you'll never need to touch the OAuth setup again. The app
will silently sync to Drive a few seconds after every change, and at
startup if more than 15 minutes have passed since the last sync.

### Sync behavior

- **Wi-Fi only** (default): the app skips sync when on cellular data.
  Toggle this by editing `wifiOnly` in `config.js`.
- **Auto-sync on every change**: edit `autoSyncOnChange` to disable.
- **Auto-sync at startup**: edit `autoSyncOnStartup` to disable.
- The small **☁ pill** next to the app title shows current sync state
  (`queued…`, `synced`, `off (cellular)`, `tap to fix`). Tap it to
  force an interactive sync.
- Drive sync is **one-way (device → Drive)** for v1, plus a manual
  *Restore from Drive* button (☰ → Google Drive sync) that pulls the
  latest snapshot back. Treat one device as the primary; the other as
  a viewer. No multi-device conflict resolution.

Scope used: `drive.file` — the app can only see / modify files it
creates. The sync file lives at `WhenDidI/whendidibk.json` in your
Drive. Nothing else in your Drive is visible to the app.

## Data format

100% compatible with the original `whendidibk.json`. Top-level keys:

```jsonc
{
  "version": 4,
  "saveddatelong": 1779533919112,
  "saveddate": "May 23, 2026",
  "eventcount": 17425,
  "topiccount": 10,
  "measurements": [/* id, name, symbol, type, format */],
  "pendtimes":    [/* time-of-day buckets */],
  "topics":       [/* id, name, desc, msureid, optype, type, archived */],
  "events":       [/* id, cost, qant, time(ms), topicid, note */],
  "appdata":      [/* key/value app settings */]
}
```

Any extra top-level keys we don't recognize are preserved verbatim on
export. New IDs are allocated as `max(existing) + 1`. `qant` is
stored exactly as given — display formatting is driven by the topic's
referenced measurement (`msureid` → `measurements[*]`).

## Data safety

- Persistent IndexedDB storage is requested on first launch
  (`navigator.storage.persist()`).
- Before any destructive operation (Import → Replace, Wipe data,
  Restore from Drive) the app **auto-downloads** a JSON backup of
  your current data.
- Menu → **Save safety backup** lets you take one any time.
- Use Export JSON regularly. The app is great, but it's still
  *just* a web app — nothing replaces a real backup.

## Known limitations / v2 ideas

- No reminders / alerts ("you haven't pooped in N hours") — coming.
- No correlation analytics (e.g., blood-vs-meal heatmap) — coming.
- No two-way Drive sync with conflict resolution — by design in v1.
- The original app's "Quick Links" preset *values* (e.g., "1 glass
  of water = 8 oz") aren't migrated; you can long-press a Quick
  Links tile to enter a custom amount.

## License

Personal use. Distributed without warranty.
