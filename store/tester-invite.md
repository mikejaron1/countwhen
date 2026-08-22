# Closed testing — how it works and what to send testers

Source: [Play Console testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)
(personal accounts created after 2023-11-13).

## The actual rule

> At least 12 testers must be opted in to your closed test **when you apply for
> production access**, and they must have been opted in **continuously for the
> preceding 14 days**.

Two things this is *not*:

- It is **not** "14 days to recruit 12 people." The 14 days is a *look-back
  window* from the day you apply. The clock is only satisfied once 12 people
  have been opted in for 14 straight days.
- Dropping below 12 does not trigger a formal reset, but it does mean the
  preceding-14-days condition can't be met again until you are back at 12+ for
  another full 14 days. In practice: **the clock restarts.**

**Therefore recruit 15–16, not 12.** The buffer covers dropouts, people who
never finish opting in, and anyone who uninstalls.

## Prerequisites

- **App setup must be complete** (all the tasks on the dashboard) before a
  closed test can start. Internal testing has no such requirement — use it now
  to smoke-test the build and to generate the Play App Signing key.
- Testers are added by email list or **Google Group**. A Group is far easier to
  manage for 15 people, and lets someone join without you editing the console.

## Platform: Android only

The opt-in link opens in any browser, but installation happens through the Play
Store on an **Android device**. There is no iOS or desktop path.

Two traps worth stating explicitly to testers:

- The Google account they opt in with **must be the same account signed in on
  their Android phone**, or the Play listing will 404 for them.
- Using the website (`https://plotline.day/`) does **not**
  count. It is the same app, but Play only counts Play installs.

## Is opting in enough?

For the *counter*, yes. For the *application*, no.

The production access form asks you to describe:

- how easy it was to recruit testers,
- whether testers used **all available features**,
- whether their usage matched expected real-world behavior,
- a **summary of the feedback** received and how it was collected.

So 12 silent installs satisfies the number and produces a weak application.
Aim for a handful of testers who genuinely log data for two weeks and send
notes. Feedback can also come in through Play directly: Play Console →
**Monitor and improve → Ratings and reviews → Testing feedback**.

Keep a written record of feedback as it arrives — it has to be summarized at
application time.

---

## Message to send testers

Subject: **Want to help me test an Android app? (~2 min setup)**

> Hi — I built a small Android app called **Plotline** and I need 12+ testers
> for two weeks before Google will let me publish it. Low effort, no cost, no
> ads, no account needed.
>
> **What it does:** tracks anything you want to count or time — water, coffee,
> workouts, meds, headaches, chores. One tap logs the moment. It shows running
> totals, time since the last one, streaks against goals, and it runs real
> statistics to find what's actually connected to what.
>
> **To join (Android phone required):**
> 1. Reply with the Gmail address you use on your phone, so I can add you.
> 2. I'll send you an opt-in link — open it on your phone and tap *Become a
>    tester*.
> 3. Install Plotline from the Play Store link on that page.
>
> **The one important thing:** please stay opted in and keep the app installed
> for at least **14 days**. If people drop out, my 14-day clock restarts. After
> that, keep it or delete it, no hard feelings.
>
> **What would help most:** actually log something for a few days — even one
> topic. Then tell me anything that was confusing, broken, ugly, or missing.
> Blunt is useful. Reply here, or use "Send feedback" in the Play Store listing.
>
> Thanks — this genuinely doesn't happen without 12 people.

### Reminder to send on ~day 7

> Quick check-in on the Plotline test — please keep the app installed through
> [DATE]; if anyone opts out, the two-week clock starts over. If you've had a
> chance to use it, I'd love any reaction at all, even "I forgot to open it."
> That's useful too.

### Notes on the ask

- Say **Android only** in the first line. It saves a round trip with iPhone
  users.
- Ask for the address **used on their phone**, not their preferred address.
  Mismatched accounts are the most common failure.
- Tell them the 14-day rule *and why*. People stay opted in when they know a
  dropout costs you two weeks.
