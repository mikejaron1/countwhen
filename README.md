# CountWhen

**Count what happens, know when.**

A self-hosted, offline-first Progressive Web App for tracking how often
something happens and how long it's been since the last time — then
telling you what actually moves those numbers.

Log anything you want to keep a count of (symptoms, meds, water, habits,
chores, moods), see time-since-last at a glance, and let the built-in
statistics engine surface real, FDR-corrected correlations rather than
pretty charts.

Everything lives on your device (IndexedDB) and, optionally, in your own
Google Drive. There is no server, no account, and no analytics.

> **Migrating from WhenDidI?** CountWhen reads and writes the exact
> `whendidibk.json` backup format used by the discontinued
> *WhenDidI – Event Tracker* Android app (SJM Apps, last updated 2018),
> so years of existing history import cleanly. See
> [Data format](#data-format).

## Live URL

**<https://mikejaron1.github.io/countwhen/>**

Open in Chrome on your phone, tap ⋮ → **Install app**. Done.

## Update workflow (for the dev)

This repo auto-deploys to GitHub Pages on every push to `main`.

```sh
cd ~/projects/countwhen
# (make edits)
./deploy.sh "what changed"
# Wait ~30-60s for Pages to rebuild, then reload the app on the phone.
```

No drag-and-drop, no console clicks. Pages handles the rest.

## Features

### Logging

- **Categories** — full topic list with time-since-last + last-event
  date, just like the original. Big amber ADD button per row. **Long-
  press a card** to drag it into a new order; the order is saved.
  Tap a card to edit/archive/delete the topic. **+ New topic** button
  at the end of the list.
- **Quick-access bar** — pinned one-tap chips at the top of Categories
  for fast logging. Stays fixed in place (sticky) and keeps a fixed
  order. Curate exactly which topics appear and their order via
  ☰ menu → **Quick-access bar…**. When none are pinned, the bar falls
  back to auto-showing your most frequent recent topics.
- **Add / Edit Event** — date, time, duration (hh:mm) or amount, note,
  plus a **severity** badge and free-form **`#tags`** typed into the
  note (they become filterable chips).
- **Emoji + colour per topic** — set an icon and colour so the list,
  charts, and quick bar are scannable at a glance.
- **Undo** — every delete (and most edits) drops an undo snackbar.

### Reviewing

- **Recent** — chronological event feed with a topic / tag filter;
  edit or delete any event inline.
- **Day** — a single day at a time, laid out on a timeline, for
  answering "what actually happened on Tuesday?".
- **Statistics** — daily / weekly / monthly counts (and sums for
  measured topics like ounces / gallons) with a bar chart.
- **Insights** — see below.

### Insights (v6)

A statistics engine that looks for what actually moves your numbers,
rather than just plotting them.

- **Topic roles** — you tell the app once (☰ → *Insight topics…*)
  which of *your* topics mean bathroom trips, meals, blood, bed
  accidents, medication, drink, etc. Nothing is guessed from names.
- **Daily outcomes** — trips per day, **total time per day** (summed
  durations), blood events, accidents, plus first- and last-meal
  times. Days roll over at 4am (configurable) so a 2am trip counts
  toward the night before.
- **Correlations that are actually tested** — every candidate driver
  is tested at **lag 0** (same day) and **lag 1** (yesterday → today).
  Each test must clear *both* a parametric test (Pearson / Welch) and
  a rank-based one (Spearman / Mann-Whitney); the worse of the two
  p-values is kept, then **Benjamini–Hochberg FDR correction** is
  applied across every test run. Results are labelled *significant*
  (q < 0.05) or *suggestive* (q < 0.15) — never "significant" on a
  single lucky comparison. Rare events (blood, accidents) use a
  Poisson tail test instead of a t-test.
- **Meal timing** — a dedicated section answering "does a late last
  meal, or a late first meal, change tomorrow's trips, total time,
  blood, or accidents?"
- **Flare detection** — a robust baseline (median + MAD over the
  preceding ~90 days) is compared against the last 7 days. The app
  tells you plainly whether you're **flaring**, worth **watching**,
  **normal**, or actually **better than usual**, and lists which
  metrics moved and by how much.
- **Alerts** — opt in (☰ → *Alerts…*) and the app checks on launch,
  notifying you when a flare starts instead of waiting for you to go
  looking.
- **Plain-English narrative** — findings are written out as sentences
  with their effect sizes and units, not just a correlation matrix.

Guardrails: minimum sample sizes (20 paired days, 10 per group),
tautological self-correlations excluded, and DST-safe day bucketing.
If there isn't enough data yet, it says so rather than inventing a
finding.

### Data

- **Import / Export JSON** — byte-compatible with the original format.
  Import preview shows topic / event counts + date range; choose
  *Replace* (with auto-downloaded safety backup) or *Merge*
  (deduplicates by event id).
- **CSV export** — for spreadsheets and anything else.
- **Offline-first** — service worker caches the app shell, all data
  in IndexedDB. Requests persistent storage so Chrome won't evict.
- **Installable** — Chrome will offer "Install" on first visit; lives
  as a real app icon on your home screen.
- **Google Drive sync** — two-way, silent, after every change once
  you've pasted your OAuth Client ID into `js/config.js`. Wi-Fi only
  by default. Keeps rolling versioned snapshots on Drive.

## Install it on a Pixel (or any Android)

### Step 1 — Open the URL in Chrome

<https://mikejaron1.github.io/countwhen/>

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
cd ~/projects/countwhen
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

7. Open `js/config.js` in any text editor.
8. Paste your Client ID between the quotes on the `driveClientId` line:

   ```js
   driveClientId: '123456789-abc...xyz.apps.googleusercontent.com',
   ```

9. Save the file, then deploy:

   ```sh
   cd ~/projects/countwhen
   ./deploy.sh "enable drive sync"
   ```

   (Or commit + push manually.)
10. Reload the app on your phone. The first time it syncs you'll see
    Google's "unverified app" warning — tap *Advanced → Go to CountWhen
    (unsafe)* (it's *your* Cloud project, talking to *your* Drive).

That's it — you'll never need to touch the OAuth setup again. The app
will silently sync to Drive a few seconds after every change, and at
launch.

### Sync behavior

Sync is **two-way**. Every sync compares the file on Drive against the
snapshot the device stored at its last successful sync:

| Situation | What happens |
|---|---|
| No file on Drive yet | It's created from this device's data. |
| Drive file unchanged since our last sync | Straight upload (fast-forward). |
| Drive file changed (another device synced) | Download, **three-way merge**, apply locally, upload the result. |

The merge works record-by-record on topics, events, measurements,
pending times and app settings:

- Added on either side → kept.
- Deleted on one side, untouched on the other → the delete is honoured.
- Deleted on one side, *edited* on the other → the edit wins. Data is
  never silently lost to a delete race.
- Edited differently on both sides → whichever device was touched most
  recently wins, and the sync reports how many conflicts it resolved.

So two phones can both log freely and converge. Merges that pull in
remote changes refresh the UI and tell you what arrived.

Other behaviour:

- **Wi-Fi only** (default): the app skips sync when on cellular data.
  Toggle this by editing `wifiOnly` in `config.js`.
- **Auto-sync on every change**: edit `autoSyncOnChange` to disable.
- **Auto-sync at startup**: edit `autoSyncOnStartup` to disable.
- The small **☁ pill** next to the app title shows current sync state
  (`queued…`, `synced`, `merged`, `off (cellular)`, `tap to fix`).
  Tap it to force an interactive sync.
- **Restore from Drive** (☰ → Google Drive sync) is the escape hatch:
  it *replaces* everything on this device with the Drive copy, after
  downloading a safety backup. Use it for a fresh device or a bad
  mistake — day to day, plain sync is what you want.
- Rolling snapshots (`whendidibk-1.json`, `-2.json`, …) are kept
  beside the live file so an older copy is always recoverable.
- In-app settings (topic colours, emoji, kinds, insight roles, quick
  bar) ride along inside the backup under a `_wdapp` key, so a new
  device gets your setup too. The key is ignored by the original app.

Scope used: `drive.file` — the app can only see / modify files it
creates. The sync file lives at `CountWhen/whendidibk.json` in your
Drive. Nothing else in your Drive is visible to the app. (If you're
upgrading from the old app, an existing `WhenDidI` folder is renamed
to `CountWhen` in place, so file IDs and version history survive.)

## Data format

CountWhen stores and exchanges data as `whendidibk.json` — the same
format used by the original WhenDidI app, kept byte-compatible so
backups move both ways. Top-level keys:

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
export. This app adds one of its own, `_wdapp`, holding in-app-only
settings (topic emoji / colour / kind, insight roles, quick-access
bar). The original app ignores unknown keys, so backups stay
interchangeable. New IDs are allocated as `max(existing) + 1`. `qant` is
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

## Known limitations / next ideas

- No scheduled reminders ("you haven't gone in N hours"). Alerts today
  are flare-detection only, checked when you open the app.
- Insights need history to work: roughly 20+ days with the relevant
  topics logged before correlations are attempted, and ~90 days before
  the flare baseline is meaningful.
- Correlation is not causation. The engine is deliberately
  conservative, but a *suggestive* finding is a hypothesis to test,
  not a diagnosis. It is not medical advice.
- Merge conflicts are resolved automatically (most-recently-touched
  device wins) — there's no interactive "pick a side" UI.
- The original app's "Quick Links" preset *values* (e.g., "1 glass
  of water = 8 oz") aren't migrated; you can long-press a Quick
  Links tile to enter a custom amount.

## License

Personal use. Distributed without warranty.
