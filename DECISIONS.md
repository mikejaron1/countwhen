# Product & architecture decisions

Standing decisions for Plotline, with the reasoning behind them, so future
changes argue against a recorded position instead of a vague memory.

Last reviewed: 2026-08-19 (pre-launch, v7.4.0).

---

## 1. Distribution: free, ungated

**Decision:** ship v1 on Google Play as a **free** app with **no feature
gating**.

**Why:**

- The Android app is a TWA pointing at `https://mikejaron1.github.io/countwhen/`.
  A TWA must load a publicly reachable URL, so the full app is always
  usable for free in any browser. Gating would only inconvenience
  non-technical users.
- The repo is public and the app is 100% client-side. Any entitlement flag
  lives in IndexedDB on the user's device, and the code that reads it is
  readable by anyone. There is no server, so there is nothing to enforce
  with.
- The product's stated promise is "no server, no account, no analytics,
  your data is yours." Capping topics or history contradicts that and holds
  a user's own local data hostage.
- At zero users, the scarce resource is feedback, not revenue. A price is a
  wall placed before anyone can evaluate the app.

**The irreversible half.** Per Google Play policy, a **paid app can be made
free, but a free app can never be made paid** — that requires a brand new
app with a new package name. So launching free permanently forecloses
up-front pricing. It does *not* foreclose in-app purchases, which can be
added to a free app at any time. Free is therefore the option that keeps
the most doors open.

**Revisit when:** there is a real install base asking for more.

---

## 2. Monetization, if it ever happens: additive IAP

**Decision:** no monetization in v1. If the app gains traction, add a
single "Supporter"/Pro **in-app purchase** rather than a price.

**Never gate:**

- Number of topics, length of history, or anything else that makes a user's
  existing data unreachable. That is data hostage-taking, reliably punished
  in reviews, and it contradicts §1.
- Export / import JSON. It is the guarantee that the data is really theirs,
  and it is also the migration path in §3.

**Acceptable to gate (best candidate first):**

1. **Insights / correlation engine.** The genuinely differentiated feature,
   and *additive* — not having it removes nothing and locks nothing up.
   "Free tracker, paid analysis" is a bargain users understand.
2. Goals & streaks.
3. Cosmetics — extra themes, alternate icons.

**Implementation notes for later.** Inside a TWA, billing goes through the
**Digital Goods API** (`getDigitalGoodsService('https://play.google.com/billing')`),
which requires `alphaDependencies.enabled` and `features.playBilling.enabled`
in `twa-manifest.json` (both currently off), a rebuild, and an in-app
product SKU in Play Console. Two caveats:

- The Digital Goods API **does not exist outside the TWA**, so browser users
  could never buy the upgrade. Gating shared code would lock out people who
  are structurally unable to pay.
- With no server there is no way to verify a purchase. Entitlement would be
  a cached client-side flag.

Both caveats disappear under Capacitor (§3), which is the argument for
deferring monetization until after that move rather than building it twice.

---

## 3. Architecture: TWA now, Capacitor when native is needed

**Decision:** stay on the Bubblewrap TWA for v1.

**What TWA genuinely costs.** These are not currently possible:

- Home screen widget for one-tap logging — the most valuable native feature
  for this app category.
- Quick Settings tile and notification quick-actions.
- Health Connect integration (sleep, steps, heart rate would feed the
  correlation engine well).
- Reliable scheduled local reminders without a push server.
- Wear OS, Assistant shortcuts.
- Standard Play Billing; network-level gating.

**What it does not cost.** Package name and signing key are not TWA
concepts — Play only checks package name, signing key, and versionCode, and
the contents of the AAB are arbitrary. A Capacitor or fully native build
shipped under `io.github.mikejaron1.countwhen` with the same key reaches
existing users as a normal **update**, preserving the listing, reviews,
ratings, and install base. Nothing about the store presence has to be
rebuilt.

**Why TWA is right for now.** Its superpower is that a fix ships in ~60
seconds with no Play review, which is exactly what is wanted while still
learning whether anyone wants the app. Building widgets for zero users is
the more expensive mistake.

**The escalation ladder:**

| Stage | What changes | Cost |
| --- | --- | --- |
| **TWA** (today) | Chrome shell around the live site | done |
| **Capacitor** | Same JS, bundled *inside* the APK. Own the WebView, add native plugins (widgets, Health Connect, local notifications), standard Play Billing, no public-hosting requirement, instant cold start. | ~1 week, reuses nearly all code |
| **Full native** | Rewrite | only if this becomes the main project |

**Trigger to move to Capacitor:** the first time a real tester says they
want to log from the home screen. That, or a serious need for Health
Connect data.

---

## 4. Data migration plan (required before any shell change)

**The risk.** App data lives in IndexedDB (`whendidi`) under the origin
`https://mikejaron1.github.io`, inside **Chrome's** storage — that is how
TWAs work. A Capacitor or native app runs in a different storage partition
and **cannot read it**. A naive swap would look exactly like total data
loss to every existing user.

**The mitigation** — both hatches already exist and must keep working:

1. **Google Drive sync** — the clean path. The cutover release prompts
   "sync to Drive"; the new shell signs in and restores from the same
   backup file.
2. **Export / import JSON** — the offline fallback for anyone not using
   Drive.

**Cutover checklist, when the time comes:**

- [ ] Ship a TWA release that nags un-synced users to back up (Drive or JSON).
- [ ] Leave it live long enough for the slow-moving majority to open the app.
- [ ] Ensure the new shell offers **Restore from Drive** and **Import JSON**
      in first-run onboarding, before any empty state is shown.
- [ ] Keep `DB_NAME = 'whendidi'` and the export schema unchanged so old
      backup files still import cleanly.
- [ ] Test an upgrade install over the top of a real TWA install, not just
      a fresh install.

---

## 5. Google Drive OAuth: shipped default with per-device override

**Decision:** `js/config.js` carries the project's OAuth client ID as a
**default**, so a normal user just taps *Sync now* and picks an account. A
client ID saved in-app (☰ → Google Drive sync → *Advanced*) is stored per
device and **overrides** the default; clearing it reverts.

**Why:** requiring every user to create their own Google Cloud project was
a non-starter for a store app, while hard-coding the developer's ID with no
escape hatch removes control from self-hosters. The hybrid serves both.

**Notes:**

- The only scope used is `drive.file`, which Google classifies as
  **non-sensitive** — no demo video, app review, or third-party security
  assessment required.
- The consent screen must be published **Testing → In production**, or the
  default client is capped at 100 users and shows an "unverified app"
  warning.
- Data safety remains **no collection**: the token is issued to the user,
  files land in the user's own Drive, and nothing reaches a developer
  server.
