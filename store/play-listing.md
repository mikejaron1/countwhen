# Google Play listing — copy & form answers

Paste-ready content for the Play Console listing of
`io.github.mikejaron1.countwhen`. Character counts verified against Play limits.

## Store listing

**App name** (30 max — uses 28)

```
CountWhen: Timestamp & Tally
```

**Short description** (80 max — uses 70)

```
Log exact moments and counts for habits, symptoms, and daily routines.
```

**Full description** (4000 max — uses ~2500)

```
How many times did it happen, and how long has it been since the last one?

CountWhen answers both in one tap. Pick a topic, tap it, and the moment is logged. From there the app does the work: running totals, time-since-last on every card, streaks against your goals, and a real statistics engine that looks for what actually moves your numbers.

Track anything you can count or time - water, caffeine, workouts, medications, symptoms, moods, chores, screen breaks, the dog's walks. If it happens and you want a record of when, it fits.

WHAT YOU CAN LOG
- One-tap timestamps, the fastest possible entry
- Counts and amounts in your own units (oz, mg, reps, miles)
- Durations, for anything you time rather than count
- A 0-5 severity rating when intensity matters, not just frequency
- Notes with #tags that you can search and filter later
- Edit or backdate any entry when you forget in the moment
- A pinned quick-access bar for whatever you log most

SEE WHAT'S HAPPENING
- Time since last, on every topic at a glance
- Day view, searchable history, and per-topic statistics
- Charts of counts and trends over time
- Goals and streaks: "at least 8 a day", "at most 2 a week", with a live streak counter and a best-ever record

FIND WHAT ACTUALLY MATTERS
Most trackers stop at pretty charts. CountWhen runs actual statistics. Tell it which topics are outcomes you care about and which are possible influences, and it compares them against each other, corrects for multiple comparisons using Benjamini-Hochberg FDR so you are not chasing noise, and reports only the associations that survive. It also checks timing effects, like whether something late in the evening changes the next day.

Everything is described in plain language, using your own topic names.

SET IT UP IN SECONDS
Start from a preset - Symptom Tracker, Daily Habits, or Fitness & Health - or build your own from scratch. Rename, reorder, and delete anything.

YOUR DATA STAYS YOURS
- No account, no sign-up, no server
- No ads, no trackers, no analytics of any kind
- Everything stored on your device
- Works completely offline
- Export your full history to JSON at any time
- Optional backup to your own Google Drive

The developer never sees your data, because there is nowhere for it to go.

FREE
No ads, no subscription, no paid tier, no upsell.

CountWhen is a personal record-keeping tool. It is not a medical device, and it does not diagnose, treat, or provide medical advice. Talk to a clinician about health decisions.
```

## Listing fields

| Field | Value |
|---|---|
| App category | Health & Fitness (or Productivity — see note) |
| Tags | habit tracker, symptom tracker, counter, log, statistics |
| Contact email | mikejaron1@gmail.com |
| Website | https://mikejaron1.github.io/countwhen/ |
| Privacy policy | https://mikejaron1.github.io/countwhen/privacy.html |

**Category note:** *Health & Fitness* matches user intent and searches better for
a symptom tracker, but it triggers Play's **Health Apps declaration**. *Productivity*
avoids that extra form. Both are defensible; Health & Fitness is the better fit if
you don't mind one more questionnaire.

## Graphics

| Asset | Status |
|---|---|
| App icon 512×512 | ✅ `store/icon-512.png` |
| Feature graphic 1024×500 | ✅ `store/feature-graphic.png` |
| Phone screenshots (2–8 required) | ✅ `store/screenshots/` (6 @ 1080×1920) |

Regenerate any time with `npm run screenshots` — it seeds deterministic demo
data in a throwaway Chrome profile, so no personal data ever reaches the store.

## Data safety form

**Does your app collect or share any of the required user data types? → No**

That single answer completes the form. Grounds for it:

- All data is stored on-device in IndexedDB. The app has no backend.
- The only outbound network call in the codebase is `js/drive.js` →
  `googleapis.com`, and only when the user explicitly triggers a backup.
- Drive backup writes to the **user's own Google Drive** under the narrow
  `drive.file` scope, which only grants access to files the app itself created.
  Play's rules exempt user-initiated transfers to a user's own account, and the
  developer has no access to the contents.
- No analytics, ads, crash reporting, or third-party SDKs of any kind.

Because nothing is collected, the follow-ups (encryption in transit, deletion
requests) are not applicable.

## Content rating questionnaire

Category: **Utility, Productivity, Communication or Other**. Answer **No** to
everything — violence, sexuality, profanity, controlled substances, gambling,
user-generated content, data sharing, location sharing. Medication and symptom
entries are user-typed data, not app content, so the drug-reference question is
still No. Expected result: **Everyone / PEGI 3**.

## Other declarations

| Question | Answer |
|---|---|
| Ads | No ads |
| App access | All functionality available without special access (no login) |
| Government app | No |
| Financial features | None |
| Target audience | 18+ (avoids the extra Families policy requirements) |
| Data deletion URL | Not required — nothing is collected |

## ⚠️ Open item before public launch: the Drive OAuth client ID

`js/config.js` ships a hard-coded `driveClientId`, and `getClientId()` in
`js/drive.js` prefers it over any value a user saves. That is fine for a
personal deployment, but on a public Play release **every user's Drive sync
would run through the owner's Google Cloud project**.

Consequences to resolve first:

- An OAuth consent screen left in *Testing* status is capped at 100 users and
  shows an "unverified app" warning. It must be published to *In production*.
- All users appear in that one Cloud project's quota and consent screen.

Options:

1. **Blank `driveClientId` in `config.js`** so Drive sync is off by default and
   users supply their own ID (matches what README and privacy.html describe).
   Manual JSON export/import still works with no setup.
2. **Keep the shared client ID** and publish the OAuth consent screen. `drive.file`
   is a narrow, non-restricted scope, so this is the lighter verification path,
   but the project is then serving all users.

This does not change the Data safety answers either way — user data still only
ever moves to that user's own Drive.
