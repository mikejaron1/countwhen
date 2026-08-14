/* goals.js — targets and streaks.
 *
 * The insights engine explains *variance*: what makes a number move. That
 * suits symptoms, but habit tracking asks a different question — "am I
 * keeping it up?" This module answers that one.
 *
 * A goal is a threshold on a period's value:
 *
 *   at least N per day/week   (gte) — build something: workouts, water, pages
 *   at most  N per day/week   (lte) — limit something: cigarettes, spending
 *
 * Three subtleties drive the whole design:
 *
 *   1. Days with no events are real days. A "at most 0 cigarettes" goal is
 *      met precisely on the days you logged nothing, so periods are built by
 *      walking the calendar, never by grouping the event list.
 *   2. Today is asymmetric. An "at least" goal you haven't hit yet is still
 *      winnable, so it must not break the streak — it's pending. An "at most"
 *      goal you've already blown is broken now.
 *   3. A streak can't predate its goal. Otherwise "0 cigarettes" would claim
 *      a streak running back to the beginning of time. Streaks are clamped to
 *      whichever came first: the goal's creation, or the topic's first event.
 */
(function () {
  'use strict';

  const N = window.CWINSIGHTS;
  const dayKey = N.dayKey;
  const addDays = N.addDays;

  const PERIODS = [
    { key: 'day',  label: 'day',  plural: 'days'  },
    { key: 'week', label: 'week', plural: 'weeks' },
  ];

  const CMPS = [
    { key: 'gte', label: 'at least' },
    { key: 'lte', label: 'at most' },
  ];

  /* What a goal measures depends on what the topic records. */
  function defaultMetric(kind) {
    if (kind === 'duration') return 'minutes';
    if (kind === 'amount') return 'amount';
    return 'count';
  }

  /* Sensible starting point when the user first opens the goal editor. */
  function suggestGoal(kind) {
    return {
      metric: defaultMetric(kind),
      cmp: 'gte',
      target: kind === 'duration' ? 30 : 1,
      period: 'day',
      since: Date.now(),
    };
  }

  /* Accepts whatever is in storage and returns a usable goal, or null.
   * Tolerates partial objects so an older or hand-edited record can't throw. */
  function normalizeGoal(goal, kind = 'timeonly') {
    if (!goal || typeof goal !== 'object') return null;
    const target = Number(goal.target);
    if (!isFinite(target) || target < 0) return null;
    const cmp = goal.cmp === 'lte' ? 'lte' : 'gte';
    // "at least 0" is vacuous — every period passes. Treat it as no goal.
    if (cmp === 'gte' && target === 0) return null;
    const period = goal.period === 'week' ? 'week' : 'day';
    const metric = ['count', 'minutes', 'amount'].includes(goal.metric)
      ? goal.metric : defaultMetric(kind);
    const since = Number(goal.since) || 0;
    return { metric, cmp, target, period, since };
  }

  function normalizeGoals(map, kinds = {}) {
    const out = {};
    for (const [tid, g] of Object.entries(map || {})) {
      const norm = normalizeGoal(g, kinds[tid]);
      if (norm) out[tid] = norm;
    }
    return out;
  }

  /* Monday-based week bucket for a logical day. */
  function weekKeyOf(dk) {
    const d = new Date(dk);
    const dow = (d.getDay() + 6) % 7;   // Mon = 0
    return addDays(dk, -dow);
  }

  /* One event's contribution to a period total. */
  function eventValue(ev, metric) {
    if (metric === 'count') return 1;
    const q = Number(ev.qant || 0);
    return metric === 'minutes' ? q / 60 : q;
  }

  /* Builds every period from the goal's floor up to now, marks each met or
   * not, and derives the streaks. Returns null when there is no goal. */
  function evaluate({ events = [], goal, kind = 'timeonly', cutoffHour = 4,
                      now = Date.now(), lookbackDays = 400 } = {}) {
    const g = normalizeGoal(goal, kind);
    if (!g) return null;

    const todayKey = dayKey(now, cutoffHour);
    const horizonKey = addDays(todayKey, -(lookbackDays - 1));

    let firstEventKey = null;
    for (const e of events) {
      const k = dayKey(e.time, cutoffHour);
      if (firstEventKey == null || k < firstEventKey) firstEventKey = k;
    }

    // Where the record legitimately begins (see note 3 at the top).
    const sinceKey = g.since ? dayKey(g.since, cutoffHour) : null;
    let floorKey;
    if (sinceKey != null && firstEventKey != null) floorKey = Math.min(sinceKey, firstEventKey);
    else if (sinceKey != null) floorKey = sinceKey;
    else if (firstEventKey != null) floorKey = firstEventKey;
    else floorKey = todayKey;
    floorKey = Math.max(floorKey, horizonKey);
    if (floorKey > todayKey) floorKey = todayKey;

    // Daily totals across the whole calendar range, zeros included.
    const daily = new Map();
    for (let k = floorKey; k <= todayKey; k = addDays(k, 1)) daily.set(k, 0);
    for (const e of events) {
      const k = dayKey(e.time, cutoffHour);
      if (k < floorKey || k > todayKey) continue;
      daily.set(k, daily.get(k) + eventValue(e, g.metric));
    }

    // Roll days up into the goal's period.
    let periods;
    if (g.period === 'day') {
      periods = Array.from(daily.entries()).map(([key, value]) => ({ key, value, days: 1 }));
    } else {
      const byWeek = new Map();
      for (const [k, v] of daily) {
        const wk = weekKeyOf(k);
        const row = byWeek.get(wk) || { key: wk, value: 0, days: 0 };
        row.value += v;
        row.days++;
        byWeek.set(wk, row);
      }
      periods = Array.from(byWeek.values()).sort((a, b) => a.key - b.key);
      // A partial first week would be judged on fewer days than it deserves.
      if (periods.length > 1 && periods[0].days < 7) periods.shift();
    }
    periods.sort((a, b) => a.key - b.key);

    const meets = (v) => (g.cmp === 'gte' ? v >= g.target : v <= g.target);
    for (const p of periods) {
      p.date = new Date(p.key + cutoffHour * 3600000);
      p.met = meets(p.value);
      p.current = false;
      p.pending = false;
    }
    const cur = periods[periods.length - 1];
    if (cur) {
      cur.current = true;
      // An unfinished "at least" period hasn't failed yet — it's still open.
      cur.pending = !cur.met && g.cmp === 'gte';
    }

    // Current streak: walk back from now. A pending period is skipped rather
    // than counted, so today's incomplete progress neither adds nor breaks.
    let i = periods.length - 1;
    if (i >= 0 && periods[i].pending) i--;
    let current = 0;
    while (i >= 0 && periods[i].met) { current++; i--; }

    // Best streak only judges periods that actually finished.
    let best = 0;
    let run = 0;
    for (const p of periods) {
      if (p.pending) continue;
      if (p.met) { run++; if (run > best) best = run; }
      else run = 0;
    }
    if (current > best) best = current;

    const settled = periods.filter((p) => !p.pending);
    const recent = settled.slice(-30);
    const metRecent = recent.filter((p) => p.met).length;

    const value = cur ? cur.value : 0;
    const remaining = g.cmp === 'gte'
      ? Math.max(0, g.target - value)
      : g.target - value;

    return {
      goal: g,
      periods,
      current,
      best,
      value,
      met: cur ? cur.met : false,
      pending: cur ? cur.pending : false,
      remaining,
      metRecent,
      totalRecent: recent.length,
      rate: recent.length ? metRecent / recent.length : null,
      totalPeriods: settled.length,
    };
  }

  /* ---- formatting ---- */

  function unitLabel(goal, measurement) {
    if (goal.metric === 'minutes') return 'min';
    if (goal.metric === 'amount') return (measurement && measurement.symbol) || '';
    return '×';
  }

  function fmtValue(v, goal, measurement) {
    const rounded = Math.round(v * 10) / 10;
    const num = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    const unit = unitLabel(goal, measurement);
    return unit === '×' ? `${num}×` : `${num} ${unit}`.trim();
  }

  /* "at least 3× per day" */
  function describeGoal(goal, measurement) {
    const g = normalizeGoal(goal);
    if (!g) return '';
    const cmp = CMPS.find((c) => c.key === g.cmp).label;
    const per = PERIODS.find((p) => p.key === g.period).label;
    return `${cmp} ${fmtValue(g.target, g, measurement)} per ${per}`;
  }

  /* The headline sentence: what the user actually wants to read. */
  function streakLine(result, measurement) {
    if (!result) return '';
    const g = result.goal;
    const unit = PERIODS.find((p) => p.key === g.period);
    const n = result.current;
    const noun = n === 1 ? unit.label : unit.plural;
    if (n === 0) {
      if (g.cmp === 'lte' && !result.met) {
        return `Over your limit today — ${fmtValue(result.value, g, measurement)} logged.`;
      }
      return `No streak yet — hit your goal to start one.`;
    }
    return g.cmp === 'lte'
      ? `${n} ${noun} within your limit`
      : `${n} ${noun} in a row`;
  }

  /* Short badge text for a topic card. */
  function badge(result) {
    if (!result || !result.current) return null;
    return { n: result.current, hot: result.current >= 3, at_risk: result.pending };
  }

  window.CWGOALS = {
    PERIODS, CMPS,
    defaultMetric, suggestGoal, normalizeGoal, normalizeGoals,
    weekKeyOf, evaluate,
    unitLabel, fmtValue, describeGoal, streakLine, badge,
  };
})();
