/* WhenDidI - Insights engine.
 *
 * Turns the raw event log into:
 *   1. A per-day metric table (trips/day, total time/day, first/last meal,
 *      blood days, accidents, night trips, per-topic counts, #tags).
 *   2. Statistical tests between predictors and outcomes, with p-values,
 *      effect sizes and Benjamini-Hochberg FDR correction (so 40 tests
 *      don't produce 2 fake "findings").
 *   3. A robust baseline vs. current-week comparison -> flare detection.
 *   4. Ranked, plain-English insights.
 *
 * Everything here is pure computation: no DOM, no IndexedDB. Wrapped in an
 * IIFE because classic scripts share one global lexical scope.
 */
(function () {
'use strict';

/* ==================== math / stats primitives ==================== */

const MS_DAY = 86400000;

function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - 1);
}

function sd(xs) { return Math.sqrt(variance(xs)); }

function quantile(sortedXs, q) {
  const n = sortedXs.length;
  if (!n) return NaN;
  if (n === 1) return sortedXs[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedXs[lo];
  return sortedXs[lo] + (pos - lo) * (sortedXs[hi] - sortedXs[lo]);
}

function median(xs) {
  if (!xs.length) return NaN;
  return quantile(xs.slice().sort((a, b) => a - b), 0.5);
}

/* Median absolute deviation, scaled to be a consistent estimator of sigma. */
function mad(xs) {
  if (xs.length < 2) return NaN;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

function logGamma(x) {
  // Lanczos approximation (g=7, n=9)
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = g[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/* Continued-fraction expansion for the incomplete beta function. */
function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-12;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/* Regularized incomplete beta I_x(a,b). */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/* Two-tailed p-value for Student's t with df degrees of freedom. */
function tTestP(t, df) {
  if (!isFinite(t) || !isFinite(df) || df <= 0) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

/* P(X >= k) for Poisson(lambda). Used for rare-event flare checks. */
function poissonTailP(k, lambda) {
  if (lambda <= 0) return k > 0 ? 0 : 1;
  if (k <= 0) return 1;
  let cum = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i < k; i++) {
    cum += term;
    term *= lambda / (i + 1);
  }
  return Math.max(0, Math.min(1, 1 - cum));
}

/* Average ranks, ties shared. Returns { ranks, tieCorrection }. */
function rankWithTies(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(xs.length);
  let tieSum = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    const groupSize = j - i + 1;
    if (groupSize > 1) tieSum += groupSize ** 3 - groupSize;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return { ranks, tieCorrection: tieSum };
}

/* Pearson correlation + two-tailed p. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return { n, r: NaN, p: NaN };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { n, r: NaN, p: NaN };
  const r = sxy / Math.sqrt(sxx * syy);
  const rc = Math.min(0.999999, Math.max(-0.999999, r));
  const t = rc * Math.sqrt((n - 2) / (1 - rc * rc));
  return { n, r, p: tTestP(t, n - 2) };
}

function spearman(xs, ys) {
  const rx = rankWithTies(xs).ranks;
  const ry = rankWithTies(ys).ranks;
  return pearson(rx, ry);
}

/* Welch's t-test for two independent samples. */
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return { n: na + nb, t: NaN, p: NaN, df: NaN };
  const ma = mean(a), mb = mean(b);
  const va = variance(a), vb = variance(b);
  const se2 = va / na + vb / nb;
  if (!(se2 > 0)) return { n: na + nb, t: NaN, p: NaN, df: NaN };
  const t = (ma - mb) / Math.sqrt(se2);
  const df = (se2 * se2) /
    ((va * va) / (na * na * (na - 1)) + (vb * vb) / (nb * nb * (nb - 1)));
  return { n: na + nb, t, df, p: tTestP(t, df), meanA: ma, meanB: mb };
}

/* Cohen's d with pooled SD. */
function cohensD(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const va = variance(a), vb = variance(b);
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  if (!(pooled > 0)) return NaN;
  return (mean(a) - mean(b)) / pooled;
}

/* Mann-Whitney U with normal approximation + tie correction. */
function mannWhitney(a, b) {
  const na = a.length, nb = b.length;
  if (na < 3 || nb < 3) return { p: NaN, u: NaN };
  const all = a.concat(b);
  const { ranks, tieCorrection } = rankWithTies(all);
  let ra = 0;
  for (let i = 0; i < na; i++) ra += ranks[i];
  const u = ra - (na * (na + 1)) / 2;
  const n = na + nb;
  const mu = (na * nb) / 2;
  const sigma = Math.sqrt(
    ((na * nb) / 12) * ((n + 1) - tieCorrection / (n * (n - 1)))
  );
  if (!(sigma > 0)) return { p: NaN, u };
  const z = (u - mu) / sigma;
  return { p: 2 * (1 - normalCdf(Math.abs(z))), u, z };
}

/* Benjamini-Hochberg FDR. Mutates each test, adding `q`. */
function benjaminiHochberg(tests) {
  const valid = tests.filter((t) => isFinite(t.p));
  const sorted = valid.slice().sort((a, b) => a.p - b.p);
  const m = sorted.length;
  let prev = 1;
  for (let i = m - 1; i >= 0; i--) {
    const q = Math.min(prev, (sorted[i].p * m) / (i + 1));
    sorted[i].q = q;
    prev = q;
  }
  for (const t of tests) if (!isFinite(t.p)) t.q = NaN;
  return tests;
}

/* ==================== roles ==================== */

const ROLES = [
  { key: 'bathroom', label: 'Bathroom trip', hint: 'The main thing you are tracking ("going")', icon: '🚻' },
  { key: 'meal',     label: 'Meal / food',   hint: 'Used for first-meal / last-meal timing', icon: '🍽' },
  { key: 'blood',    label: 'Blood',         hint: 'Treated as a bad-day marker', icon: '🩸' },
  { key: 'accident', label: 'Accident / bed', hint: 'Treated as a bad-day marker', icon: '🛏' },
  { key: 'sleep',    label: 'Sleep / bedtime', hint: 'Bedtime + wake timing', icon: '😴' },
  { key: 'med',      label: 'Medication',    hint: 'Tested as a possible cause', icon: '💊' },
  { key: 'trigger',  label: 'Possible trigger', hint: 'Drinks, stress, exercise…', icon: '⚡' },
];
const ROLE_KEYS = new Set(ROLES.map((r) => r.key));

/* ==================== daily table ==================== */

/* Logical day start: a trip at 2am belongs to the previous night, so days
 * roll over at `cutoffHour` (default 4am) rather than midnight. */
function dayKey(ts, cutoffHour) {
  const d = new Date(ts - cutoffHour * 3600000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* Step a day key by n calendar days. Never use key + n*MS_DAY: DST shifts
 * would produce keys that don't line up with dayKey() and manifest as
 * phantom empty days (which then fake correlations). */
function addDays(key, n) {
  const d = new Date(key);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function minutesFromDayStart(ts, cutoffHour) {
  const key = dayKey(ts, cutoffHour);
  const start = key + cutoffHour * 3600000;
  return Math.round((ts - start) / 60000);
}

/* Convert "minutes from logical day start" back to a clock label. */
function fmtDayMinutes(min, cutoffHour) {
  if (min == null || !isFinite(min)) return '—';
  let total = Math.round(min) + cutoffHour * 60;
  const nextDay = total >= 1440;
  total = ((total % 1440) + 1440) % 1440;
  let h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}${nextDay ? '' : ''}`;
}

const TAG_RE = /#([A-Za-z0-9_][A-Za-z0-9_-]{0,30})/g;
function tagsOf(note) {
  if (!note) return [];
  const out = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(note)) !== null) out.push(m[1].toLowerCase());
  return out;
}

/**
 * Build the per-day metric table.
 *
 * @param {object} o
 * @param {Array}  o.events    all events
 * @param {Array}  o.topics    all topics
 * @param {object} o.roles     { topicId: roleKey }
 * @param {object} o.kinds     { topicId: 'timeonly'|'duration'|'amount' }
 * @param {number} o.cutoffHour logical day rollover hour (default 4)
 * @param {number} o.days      how many trailing days to include (default 400)
 */
function buildDaily({ events, topics, roles = {}, kinds = {}, cutoffHour = 4, days = 400 }) {
  const byRole = {};
  for (const r of ROLES) byRole[r.key] = [];
  for (const [tid, role] of Object.entries(roles || {})) {
    if (ROLE_KEYS.has(role)) byRole[role].push(Number(tid));
  }
  const roleSet = (key) => new Set(byRole[key] || []);
  const bathroom = roleSet('bathroom');
  const meals = roleSet('meal');
  const blood = roleSet('blood');
  const accident = roleSet('accident');
  const sleep = roleSet('sleep');

  const durationTopics = new Set(
    topics.filter((t) => (kinds[t.id] || '') === 'duration').map((t) => t.id)
  );

  const now = Date.now();
  const todayKey = dayKey(now, cutoffHour);
  const startKey = addDays(todayKey, -(days - 1));

  const rows = new Map();
  const ensure = (key) => {
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        date: new Date(key + cutoffHour * 3600000),
        counts: {},        // topicId -> n
        sums: {},          // topicId -> summed qant (seconds for durations)
        firsts: {},        // topicId -> minutes from day start
        lasts: {},
        tags: new Set(),
        goCount: 0,
        goSeconds: 0,
        goHasDuration: false,
        goFirst: null,
        goLast: null,
        goNight: 0,
        goSeverityMax: 0,
        mealCount: 0,
        mealFirst: null,
        mealLast: null,
        bloodCount: 0,
        accidentCount: 0,
        sleepFirst: null,
        sleepLast: null,
        events: 0,
      });
    }
    return rows.get(key);
  };

  // Pre-create every day in range so gaps count as real zeros.
  for (let k = startKey; k <= todayKey; k = addDays(k, 1)) ensure(k);

  for (const e of events) {
    const key = dayKey(e.time, cutoffHour);
    if (key < startKey || key > todayKey) continue;
    const row = ensure(key);
    const tid = e.topicid;
    const min = minutesFromDayStart(e.time, cutoffHour);
    row.events++;
    row.counts[tid] = (row.counts[tid] || 0) + 1;
    row.sums[tid] = (row.sums[tid] || 0) + Number(e.qant || 0);
    if (row.firsts[tid] == null || min < row.firsts[tid]) row.firsts[tid] = min;
    if (row.lasts[tid] == null || min > row.lasts[tid]) row.lasts[tid] = min;
    for (const t of tagsOf(e.note)) row.tags.add(t);

    if (bathroom.has(tid)) {
      row.goCount++;
      if (durationTopics.has(tid)) {
        row.goSeconds += Number(e.qant || 0);
        row.goHasDuration = true;
      }
      if (row.goFirst == null || min < row.goFirst) row.goFirst = min;
      if (row.goLast == null || min > row.goLast) row.goLast = min;
      const hr = new Date(e.time).getHours();
      if (hr >= 22 || hr < 6) row.goNight++;
      const sev = Number(e.cost || 0);
      if (sev > row.goSeverityMax) row.goSeverityMax = sev;
    }
    if (meals.has(tid)) {
      row.mealCount++;
      if (row.mealFirst == null || min < row.mealFirst) row.mealFirst = min;
      if (row.mealLast == null || min > row.mealLast) row.mealLast = min;
    }
    if (blood.has(tid)) row.bloodCount++;
    if (accident.has(tid)) row.accidentCount++;
    if (sleep.has(tid)) {
      if (row.sleepFirst == null || min < row.sleepFirst) row.sleepFirst = min;
      if (row.sleepLast == null || min > row.sleepLast) row.sleepLast = min;
    }
  }

  const list = Array.from(rows.values()).sort((a, b) => a.key - b.key);
  for (const r of list) {
    r.goMinutes = r.goHasDuration ? r.goSeconds / 60 : null;
    r.bloodAny = r.bloodCount > 0 ? 1 : 0;
    r.accidentAny = r.accidentCount > 0 ? 1 : 0;
    r.badAny = (r.bloodCount > 0 || r.accidentCount > 0) ? 1 : 0;
    const dow = r.date.getDay();
    r.dow = (dow + 6) % 7;              // 0 = Mon
    r.weekend = (dow === 0 || dow === 6) ? 1 : 0;
  }

  // Trim leading days before the very first logged event (avoid fake zeros
  // for a period the user simply wasn't tracking).
  let firstIdx = list.findIndex((r) => r.events > 0);
  if (firstIdx < 0) firstIdx = list.length;
  const trimmed = list.slice(firstIdx);

  return {
    days: trimmed,
    cutoffHour,
    byRole,
    hasBathroom: bathroom.size > 0,
    hasDuration: trimmed.some((r) => r.goHasDuration),
    hasMeals: meals.size > 0,
    hasBlood: blood.size > 0,
    hasAccident: accident.size > 0,
  };
}

/* ==================== predictors & outcomes ==================== */

const OUTCOMES = [
  { key: 'goCount',    label: 'trips per day',      kind: 'continuous', unit: '/day' },
  { key: 'goMinutes',  label: 'total time per day', kind: 'continuous', unit: ' min' },
  { key: 'goNight',    label: 'night trips (10pm–6am)', kind: 'continuous', unit: '/night' },
  { key: 'bloodAny',   label: 'blood that day',     kind: 'binary',     unit: '' },
  { key: 'accidentAny',label: 'accident that day',  kind: 'binary',     unit: '' },
  { key: 'goFirst',    label: 'time of first trip', kind: 'continuous', unit: '' },
];

function availableOutcomes(table) {
  return OUTCOMES.filter((o) => {
    if (o.key === 'goMinutes') return table.hasDuration;
    if (o.key === 'bloodAny') return table.hasBlood;
    if (o.key === 'accidentAny') return table.hasAccident;
    return table.hasBathroom;
  });
}

/**
 * Build the list of candidate predictors, each with an accessor.
 * `topicsById` is used for readable labels.
 */
function buildPredictors(table, topics, roles = {}, kinds = {}) {
  const out = [];
  const roleOf = (id) => roles[id] || roles[String(id)] || null;

  if (table.hasMeals) {
    out.push({ key: 'mealFirst', label: 'First meal (time of day)', type: 'time',
      get: (r) => r.mealFirst });
    out.push({ key: 'mealLast', label: 'Last meal (time of day)', type: 'time',
      get: (r) => r.mealLast });
    out.push({ key: 'mealWindow', label: 'Eating window (first→last meal)', type: 'hours',
      get: (r) => (r.mealFirst != null && r.mealLast != null ? (r.mealLast - r.mealFirst) / 60 : null) });
    out.push({ key: 'mealCount', label: 'Number of meals', type: 'count',
      get: (r) => (r.mealCount || 0) });
  }

  const sleepIds = table.byRole.sleep || [];
  if (sleepIds.length) {
    out.push({ key: 'sleepLast', label: 'Bedtime (last sleep entry)', type: 'time',
      get: (r) => r.sleepLast });
  }

  out.push({ key: 'weekend', label: 'Weekend', type: 'binary', get: (r) => r.weekend });

  // Every non-bathroom topic's daily count is a candidate cause. A topic that
  // *defines* an outcome (blood, accidents) must not be tested against that
  // outcome or we'd "discover" that blood days have blood.
  const bathroomIds = new Set(table.byRole.bathroom || []);
  const selfOutcome = { blood: 'bloodAny', accident: 'accidentAny' };
  for (const t of topics) {
    if (bathroomIds.has(t.id)) continue;
    if (t.archived) continue;
    const role = roleOf(t.id);
    const excludeOutcomes = selfOutcome[role] ? [selfOutcome[role]] : [];
    const isMeasured = (kinds[t.id] || '') !== 'timeonly';
    out.push({
      key: `topic:${t.id}`,
      label: `${t.name} (count)`,
      type: 'count',
      role, excludeOutcomes,
      get: (r) => r.counts[t.id] || 0,
    });
    if (isMeasured && (kinds[t.id] || '') === 'amount') {
      out.push({
        key: `topicsum:${t.id}`,
        label: `${t.name} (amount)`,
        type: 'amount',
        role, excludeOutcomes,
        get: (r) => (r.counts[t.id] ? r.sums[t.id] || 0 : 0),
      });
    }
  }

  // #tags that appear on enough days.
  const tagDays = new Map();
  for (const r of table.days) for (const t of r.tags) tagDays.set(t, (tagDays.get(t) || 0) + 1);
  for (const [tag, n] of tagDays.entries()) {
    if (n < 5) continue;
    out.push({ key: `tag:${tag}`, label: `#${tag}`, type: 'binary',
      get: (r) => (r.tags.has(tag) ? 1 : 0) });
  }

  return out;
}

/* Pair up predictor (day d - lag) with outcome (day d), dropping nulls. */
function pairSeries(days, predictor, outcomeKey, lag) {
  const xs = [], ys = [];
  for (let i = 0; i < days.length; i++) {
    const src = days[i - lag];
    if (!src) continue;
    const x = predictor.get(src);
    const y = days[i][outcomeKey];
    if (x == null || !isFinite(x)) continue;
    if (y == null || !isFinite(y)) continue;
    xs.push(x); ys.push(y);
  }
  return { xs, ys };
}

const MIN_N = 20;

/**
 * Run every predictor x outcome x lag test, FDR-correct, and return them
 * sorted by strength.
 */
function runTests({ table, predictors, outcomes, lags = [0, 1], minN = MIN_N }) {
  const days = table.days;
  const tests = [];
  for (const outcome of outcomes) {
    for (const predictor of predictors) {
      if (predictor.excludeOutcomes?.includes(outcome.key)) continue;
      for (const lag of lags) {
        const { xs, ys } = pairSeries(days, predictor, outcome.key, lag);
        if (xs.length < minN) continue;
        const uniqX = new Set(xs);
        if (uniqX.size < 2) continue;
        const uniqY = new Set(ys);
        if (uniqY.size < 2) continue;

        const test = {
          predictorKey: predictor.key,
          predictorLabel: predictor.label,
          predictorType: predictor.type,
          outcomeKey: outcome.key,
          outcomeLabel: outcome.label,
          outcomeKind: outcome.kind,
          outcomeUnit: outcome.unit,
          lag,
          n: xs.length,
        };

        const isBinaryX = uniqX.size === 2 && uniqX.has(0);
        if (isBinaryX || outcome.kind === 'binary') {
          // Group comparison is far more interpretable than r here.
          let groupA, groupB, aLabel, bLabel;
          if (isBinaryX) {
            groupA = []; groupB = [];
            for (let i = 0; i < xs.length; i++) (xs[i] ? groupA : groupB).push(ys[i]);
            aLabel = 'yes'; bLabel = 'no';
            test.groupMode = 'predictor';
          } else {
            groupA = []; groupB = [];
            for (let i = 0; i < ys.length; i++) (ys[i] ? groupA : groupB).push(xs[i]);
            aLabel = 'on those days'; bLabel = 'other days';
            test.groupMode = 'outcome';
          }
          if (Math.min(groupA.length, groupB.length) < 10) continue;
          const w = welch(groupA, groupB);
          const mw = mannWhitney(groupA, groupB);
          test.meanA = mean(groupA);
          test.meanB = mean(groupB);
          test.nA = groupA.length;
          test.nB = groupB.length;
          test.aLabel = aLabel;
          test.bLabel = bLabel;
          test.d = cohensD(groupA, groupB);
          test.p = isFinite(w.p) ? w.p : mw.p;
          test.pNonparam = mw.p;
          const pr = pearson(xs, ys);
          test.r = pr.r;
        } else {
          const pr = pearson(xs, ys);
          const sp = spearman(xs, ys);
          test.r = pr.r;
          test.rho = sp.r;
          test.p = pr.p;
          test.pNonparam = sp.p;
          // Slope in outcome-units per predictor-unit (for plain-English text).
          const mx = mean(xs), my = mean(ys);
          let sxy = 0, sxx = 0;
          for (let i = 0; i < xs.length; i++) {
            sxy += (xs[i] - mx) * (ys[i] - my);
            sxx += (xs[i] - mx) ** 2;
          }
          test.slope = sxx ? sxy / sxx : NaN;
          test.meanX = mx;
          test.meanY = my;
        }
        // Conservative combination: a finding must satisfy BOTH the
        // parametric and the rank-based test. This costs a little power but
        // kills outlier-driven false positives, which matter more here.
        test.pParametric = test.p;
        if (isFinite(test.pNonparam)) test.p = Math.max(test.p, test.pNonparam);
        if (!isFinite(test.p)) continue;
        test.strength = Math.abs(isFinite(test.d) ? test.d : (test.r || 0));
        tests.push(test);
      }
    }
  }
  benjaminiHochberg(tests);
  tests.sort((a, b) => a.p - b.p);
  return tests;
}

function significanceLabel(t) {
  if (!isFinite(t.q)) return { level: 'none', label: 'n/a' };
  if (t.q < 0.01) return { level: 'strong', label: 'significant (q<0.01)' };
  if (t.q < 0.05) return { level: 'strong', label: 'significant (q<0.05)' };
  if (t.q < 0.15) return { level: 'weak', label: 'suggestive (q<0.15)' };
  if (t.p < 0.05) return { level: 'noise', label: 'not significant after correction' };
  return { level: 'none', label: 'no effect' };
}

/* ==================== baseline / flare detection ==================== */

/**
 * Compare the last `windowDays` against a robust baseline built from the
 * preceding `baselineDays` (excluding the current window).
 */
function baselineStatus(table, { windowDays = 7, baselineDays = 90 } = {}) {
  const days = table.days;
  const out = { ok: false, level: 'unknown', metrics: [], reasons: [], windowDays };
  if (days.length < windowDays + 21) {
    out.level = 'insufficient';
    out.reasons.push(`Need about ${windowDays + 21} days of history; have ${days.length}.`);
    return out;
  }
  const recent = days.slice(-windowDays);
  const baseStart = Math.max(0, days.length - windowDays - baselineDays);
  const base = days.slice(baseStart, days.length - windowDays);
  if (base.length < 14) {
    out.level = 'insufficient';
    out.reasons.push('Not enough baseline history yet.');
    return out;
  }
  out.baselineDays = base.length;

  const addContinuous = (key, label, values, baseValues, unit, digits = 1) => {
    const v = values.filter((x) => x != null && isFinite(x));
    const b = baseValues.filter((x) => x != null && isFinite(x));
    if (v.length < 3 || b.length < 10) return null;
    const cur = mean(v);
    const med = median(b);
    const spread = mad(b) || sd(b) || 0;
    const z = spread > 0 ? (cur - med) / spread : 0;
    const pct = med > 0 ? ((cur - med) / med) * 100 : 0;
    // Significance of the window mean vs baseline distribution.
    const w = welch(v, b);
    if (cur === 0 && med === 0) return null;   // nothing tracked here
    const m = {
      key, label, unit, digits,
      current: cur, baseline: med, z, pct,
      p: w.p,
      worse: z > 0,
      elevated: z >= 1.5 && Math.abs(pct) >= 15 && (isFinite(w.p) ? w.p < 0.1 : true),
      improved: z <= -1.5 && Math.abs(pct) >= 15,
    };
    out.metrics.push(m);
    return m;
  };

  const addRare = (key, label, recentCount, baseCount, baseN) => {
    if (baseN < 21) return null;
    const rate = baseCount / baseN;               // events per day
    const lambda = rate * recent.length;
    const p = poissonTailP(recentCount, lambda);
    const m = {
      key, label, rare: true,
      current: recentCount, baseline: lambda, p,
      unit: ` in ${recent.length}d`, digits: 1,
      pct: lambda > 0 ? ((recentCount - lambda) / lambda) * 100 : (recentCount ? 100 : 0),
      z: lambda > 0 ? (recentCount - lambda) / Math.sqrt(lambda) : 0,
      worse: recentCount > lambda,
      elevated: recentCount >= 2 && p < 0.1 && recentCount > lambda,
      improved: recentCount === 0 && lambda >= 2,
    };
    out.metrics.push(m);
    return m;
  };

  if (table.hasBathroom) {
    addContinuous('goCount', 'Trips per day',
      recent.map((r) => r.goCount), base.map((r) => r.goCount), '/day', 1);
    addContinuous('goNight', 'Night trips per night',
      recent.map((r) => r.goNight), base.map((r) => r.goNight), '/night', 1);
  }
  if (table.hasDuration) {
    addContinuous('goMinutes', 'Total time per day',
      recent.map((r) => r.goMinutes), base.map((r) => r.goMinutes), ' min', 0);
  }
  if (table.hasBlood) {
    addRare('blood', 'Blood events',
      recent.reduce((s, r) => s + r.bloodCount, 0),
      base.reduce((s, r) => s + r.bloodCount, 0), base.length);
  }
  if (table.hasAccident) {
    addRare('accident', 'Accidents',
      recent.reduce((s, r) => s + r.accidentCount, 0),
      base.reduce((s, r) => s + r.accidentCount, 0), base.length);
  }

  const elevated = out.metrics.filter((m) => m.elevated);
  const improved = out.metrics.filter((m) => m.improved);
  const badElevated = elevated.filter((m) => m.key === 'blood' || m.key === 'accident');

  if (badElevated.length || elevated.length >= 2) out.level = 'flare';
  else if (elevated.length === 1) out.level = 'watch';
  else if (improved.length && !elevated.length) out.level = 'better';
  else out.level = 'ok';
  out.ok = out.level === 'ok' || out.level === 'better';

  for (const m of elevated) {
    out.reasons.push(
      `${m.label}: ${fmtNum(m.current, m.digits)}${m.unit} vs usual ${fmtNum(m.baseline, m.digits)}${m.unit} ` +
      `(${m.pct >= 0 ? '+' : ''}${Math.round(m.pct)}%)`
    );
  }
  for (const m of improved) {
    out.reasons.push(
      `${m.label} is below your usual (${fmtNum(m.current, m.digits)}${m.unit} vs ${fmtNum(m.baseline, m.digits)}${m.unit}).`
    );
  }
  if (!out.reasons.length) out.reasons.push('Everything is within your normal range.');

  // Where does this week rank against every other 7-day window?
  if (table.hasBathroom && days.length >= 40) {
    const totals = [];
    for (let i = 0; i + windowDays <= days.length; i++) {
      let s = 0;
      for (let j = i; j < i + windowDays; j++) s += days[j].goCount;
      totals.push(s);
    }
    const curTotal = totals[totals.length - 1];
    const sorted = totals.slice().sort((a, b) => a - b);
    let below = 0;
    for (const v of sorted) if (v < curTotal) below++;
    out.percentile = Math.round((below / sorted.length) * 100);
    out.windowTotal = curTotal;
    out.worstWindowTotal = sorted[sorted.length - 1];
    // Don't let the headline say "normal" while this is one of the worst
    // weeks on record.
    if (out.percentile >= 90 && (out.level === 'ok' || out.level === 'better')) {
      out.level = 'watch';
      out.reasons.unshift(
        `This is a heavier week than ${out.percentile}% of all weeks on record ` +
        `(${curTotal} trips), even though no single metric crossed its alert threshold.`
      );
      out.ok = false;
    }
  }
  return out;
}

function fmtNum(x, digits = 1) {
  if (x == null || !isFinite(x)) return '—';
  return Number(x).toFixed(digits);
}

/* ==================== plain-English insights ==================== */

function pctChange(a, b) {
  if (!(b > 0)) return null;
  return ((a - b) / b) * 100;
}

function fmtByType(v, type, cutoffHour) {
  if (v == null || !isFinite(v)) return '—';
  if (type === 'time') return fmtDayMinutes(v, cutoffHour);
  if (type === 'hours') return `${fmtNum(v, 1)}h`;
  return fmtNum(v, 1);
}

function describeTest(test, cutoffHour, { withSignificance = false } = {}) {
  const lagTxt = test.lag === 1 ? ' the next day' : '';
  const sigTxt = withSignificance ? `, ${significanceLabel(test).label}` : '';
  const cleanLabel = test.predictorLabel.replace(/ \((count|amount|time of day)\)$/, '');
  const unit = test.outcomeUnit === ' min' ? ' min' : '';
  if (test.groupMode) {
    const dir = test.meanA > test.meanB ? 'higher' : 'lower';
    if (test.groupMode === 'predictor') {
      const delta = test.meanA - test.meanB;
      const subject = test.predictorType === 'binary'
        ? `days tagged ${cleanLabel}`
        : `days you logged ${cleanLabel}`;
      return `On ${subject}, ${test.outcomeLabel}${lagTxt} is ` +
        `${fmtNum(Math.abs(delta), 1)}${unit} ${dir} (${fmtNum(test.meanA, 1)} vs ${fmtNum(test.meanB, 1)}, ` +
        `n=${test.nA}/${test.nB}${sigTxt}).`;
    }
    // outcome is the binary one: compare the predictor across outcome groups
    const fmtV = (v) => fmtByType(v, test.predictorType, cutoffHour);
    return `${cleanLabel} differs on days with ${test.outcomeLabel}${lagTxt}: ` +
      `${fmtV(test.meanA)} vs ${fmtV(test.meanB)} on other days ` +
      `(n=${test.nA}/${test.nB}${sigTxt}).`;
  }
  const dir = test.r > 0 ? 'more' : 'less';
  if (test.predictorType === 'time') {
    const perHour = test.slope * 60;
    return `Every hour later your ${cleanLabel.toLowerCase()} is, ` +
      `${test.outcomeLabel}${lagTxt} changes by ${perHour >= 0 ? '+' : ''}${fmtNum(perHour, 2)}${unit} ` +
      `(r=${fmtNum(test.r, 2)}, n=${test.n}${sigTxt}).`;
  }
  return `${cleanLabel} tracks with ${dir} ${test.outcomeLabel}${lagTxt} ` +
    `(r=${fmtNum(test.r, 2)}, n=${test.n}${sigTxt}).`;
}

/* Descriptive, non-inferential observations about a recent window. */
function descriptiveInsights(table, windowDays = 90) {
  const out = [];
  const days = table.days.slice(-windowDays);
  if (days.length < 21) return out;
  const cutoffHour = table.cutoffHour;

  const counts = days.map((r) => r.goCount);
  const avg = mean(counts);
  if (table.hasBathroom && isFinite(avg)) {
    out.push({
      kind: 'summary',
      score: 1,
      text: `Over the last ${days.length} days you averaged ${fmtNum(avg, 1)} trips/day ` +
        `(median ${fmtNum(median(counts), 0)}, worst day ${Math.max(...counts)}).`,
    });
  }

  // Trend over the window
  if (table.hasBathroom) {
    const idx = days.map((_, i) => i);
    const pr = pearson(idx, counts);
    if (isFinite(pr.p) && pr.p < 0.05) {
      const first = mean(counts.slice(0, Math.floor(counts.length / 3)));
      const last = mean(counts.slice(-Math.floor(counts.length / 3)));
      const ch = pctChange(last, first);
      out.push({
        kind: 'trend',
        score: 3 + Math.abs(pr.r),
        text: `Trips/day are ${pr.r > 0 ? 'trending up' : 'trending down'} across this window: ` +
          `${fmtNum(first, 1)}/day early vs ${fmtNum(last, 1)}/day recently` +
          (ch != null ? ` (${ch >= 0 ? '+' : ''}${Math.round(ch)}%)` : '') +
          ` (p=${fmtNum(pr.p, 3)}).`,
      });
    }
  }

  // Time-of-day concentration
  if (table.hasBathroom) {
    const firsts = days.map((r) => r.goFirst).filter((x) => x != null);
    if (firsts.length >= 20) {
      out.push({
        kind: 'timing',
        score: 1.5,
        text: `Your first trip is usually around ${fmtDayMinutes(median(firsts), cutoffHour)} ` +
          `(middle 50% between ${fmtDayMinutes(quantile(firsts.slice().sort((a,b)=>a-b), 0.25), cutoffHour)} ` +
          `and ${fmtDayMinutes(quantile(firsts.slice().sort((a,b)=>a-b), 0.75), cutoffHour)}).`,
      });
    }
    const nightTotal = days.reduce((s, r) => s + r.goNight, 0);
    const total = days.reduce((s, r) => s + r.goCount, 0);
    if (total > 0 && nightTotal > 0) {
      out.push({
        kind: 'timing',
        score: 1.2,
        text: `${Math.round((nightTotal / total) * 100)}% of trips happen overnight (10pm–6am) — ` +
          `${fmtNum(nightTotal / days.length, 1)} per night.`,
      });
    }
  }

  // Day-of-week extremes
  if (table.hasBathroom) {
    const names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const buckets = Array.from({ length: 7 }, () => []);
    for (const r of days) buckets[r.dow].push(r.goCount);
    const avgs = buckets.map((b) => (b.length >= 4 ? mean(b) : NaN));
    const valid = avgs.map((v, i) => [v, i]).filter(([v]) => isFinite(v));
    if (valid.length === 7) {
      valid.sort((a, b) => b[0] - a[0]);
      const [hi, hiIdx] = valid[0];
      const [lo, loIdx] = valid[valid.length - 1];
      const ch = pctChange(hi, lo);
      if (ch != null && ch >= 20) {
        const w = welch(buckets[hiIdx], buckets[loIdx]);
        out.push({
          kind: 'dow',
          score: 2 + (isFinite(w.p) && w.p < 0.05 ? 1 : 0),
          text: `${names[hiIdx]} is your heaviest day (${fmtNum(hi, 1)}/day) and ${names[loIdx]} your lightest ` +
            `(${fmtNum(lo, 1)}/day) — ${Math.round(ch)}% apart` +
            (isFinite(w.p) ? `, p=${fmtNum(w.p, 3)}` : '') + '.',
        });
      }
    }
  }

  // Bad-day clustering
  if (table.hasBlood || table.hasAccident) {
    const badDays = days.filter((r) => r.badAny).length;
    if (badDays) {
      const withBad = days.filter((r) => r.badAny).map((r) => r.goCount);
      const without = days.filter((r) => !r.badAny).map((r) => r.goCount);
      const w = welch(withBad, without);
      out.push({
        kind: 'bad',
        score: 3,
        text: `${badDays} of the last ${days.length} days had blood or an accident ` +
          `(${Math.round((badDays / days.length) * 100)}%). On those days you averaged ` +
          `${fmtNum(mean(withBad), 1)} trips vs ${fmtNum(mean(without), 1)} otherwise` +
          (isFinite(w.p) ? ` (p=${fmtNum(w.p, 3)})` : '') + '.',
      });
    } else {
      out.push({ kind: 'bad', score: 2,
        text: `No blood or accidents in the last ${days.length} days.` });
    }
    // Current clean streak
    let streak = 0;
    for (let i = table.days.length - 1; i >= 0; i--) {
      if (table.days[i].badAny) break;
      streak++;
    }
    let best = 0, run = 0;
    for (const r of table.days) { if (r.badAny) run = 0; else { run++; if (run > best) best = run; } }
    if (best > 0) {
      out.push({ kind: 'streak', score: 1.4,
        text: `Current clean streak: ${streak} day${streak === 1 ? '' : 's'} (best ever: ${best}).` });
    }
  }

  // Duration
  if (table.hasDuration) {
    const mins = days.map((r) => r.goMinutes).filter((x) => x != null && isFinite(x));
    if (mins.length >= 20) {
      out.push({
        kind: 'duration',
        score: 1.6,
        text: `You spend about ${fmtNum(median(mins), 0)} min/day in the bathroom ` +
          `(${fmtNum(mean(mins), 0)} avg, worst ${fmtNum(Math.max(...mins), 0)} min).`,
      });
    }
  }

  // Month-over-month
  if (table.hasBathroom && table.days.length >= 60) {
    const last30 = table.days.slice(-30).map((r) => r.goCount);
    const prev30 = table.days.slice(-60, -30).map((r) => r.goCount);
    const ch = pctChange(mean(last30), mean(prev30));
    if (ch != null && Math.abs(ch) >= 10) {
      const w = welch(last30, prev30);
      out.push({
        kind: 'mom',
        score: 2.5 + (isFinite(w.p) && w.p < 0.05 ? 1 : 0),
        text: `Last 30 days vs the 30 before: ${fmtNum(mean(last30), 1)} vs ${fmtNum(mean(prev30), 1)} trips/day ` +
          `(${ch >= 0 ? '+' : ''}${Math.round(ch)}%${isFinite(w.p) ? `, p=${fmtNum(w.p, 3)}` : ''}).`,
      });
    }
  }

  return out;
}

/* ==================== meal-timing question ==================== */

/**
 * Directly answers: does first / last meal timing affect blood, accidents,
 * trips per day, or total time? Splits days into early vs late thirds and
 * reports the difference, plus the continuous correlation.
 */
function mealTimingAnalysis(table, tests) {
  if (!table.hasMeals) return [];
  const rows = [];
  const cutoffHour = table.cutoffHour;
  const days = table.days;
  const predictors = [
    { key: 'mealFirst', label: 'First meal', get: (r) => r.mealFirst },
    { key: 'mealLast', label: 'Last meal', get: (r) => r.mealLast },
  ];
  const MEAL_OUTCOMES = ['goCount', 'goMinutes', 'bloodAny', 'accidentAny'];
  const outcomes = availableOutcomes(table)
    .filter((o) => MEAL_OUTCOMES.includes(o.key))
    .sort((a, b) => MEAL_OUTCOMES.indexOf(a.key) - MEAL_OUTCOMES.indexOf(b.key));

  for (const p of predictors) {
    for (const o of outcomes) {
      for (const lag of [0, 1]) {
        const { xs, ys } = pairSeries(days, p, o.key, lag);
        if (xs.length < MIN_N) continue;
        const sorted = xs.slice().sort((a, b) => a - b);
        const lo = quantile(sorted, 1 / 3);
        const hi = quantile(sorted, 2 / 3);
        const early = [], late = [];
        for (let i = 0; i < xs.length; i++) {
          if (xs[i] <= lo) early.push(ys[i]);
          else if (xs[i] >= hi) late.push(ys[i]);
        }
        if (early.length < 8 || late.length < 8) continue;
        const w = welch(late, early);
        const mw = mannWhitney(late, early);
        const pr = pearson(xs, ys);
        const matched = tests.find((t) =>
          t.predictorKey === p.key && t.outcomeKey === o.key && t.lag === lag);
        rows.push({
          predictor: p.label,
          predictorKey: p.key,
          outcome: o.label,
          outcomeKey: o.key,
          outcomeKind: o.kind,
          lag,
          n: xs.length,
          earlyThreshold: lo,
          lateThreshold: hi,
          earlyLabel: `before ${fmtDayMinutes(lo, cutoffHour)}`,
          lateLabel: `after ${fmtDayMinutes(hi, cutoffHour)}`,
          earlyMean: mean(early),
          lateMean: mean(late),
          nEarly: early.length,
          nLate: late.length,
          delta: mean(late) - mean(early),
          pct: pctChange(mean(late), mean(early)),
          p: isFinite(w.p) ? w.p : mw.p,
          pNonparam: mw.p,
          q: matched ? matched.q : NaN,
          r: pr.r,
          d: cohensD(late, early),
        });
      }
    }
  }
  return rows;
}

/* ==================== top-level analyze ==================== */

function analyze({ events = [], topics = [], roles = {}, kinds = {}, cutoffHour = 4,
                   windowDays = 7, insightWindow = 90 } = {}) {
  const table = buildDaily({ events, topics, roles, kinds, cutoffHour });
  const outcomes = availableOutcomes(table);
  const predictors = buildPredictors(table, topics, roles, kinds);
  const tests = table.hasBathroom && table.days.length >= 30
    ? runTests({ table, predictors, outcomes })
    : [];
  const status = baselineStatus(table, { windowDays });
  const meals = mealTimingAnalysis(table, tests);

  // Rank the narrative insights: significant tests first, then descriptives.
  // Keep only the stronger lag for each predictor/outcome pair so the list
  // doesn't repeat itself.
  const narrative = [];
  const seenPair = new Set();
  for (const t of tests) {
    const sig = significanceLabel(t);
    if (sig.level !== 'strong' && sig.level !== 'weak') continue;
    const pair = `${t.predictorKey}|${t.outcomeKey}`;
    if (seenPair.has(pair)) continue;   // tests are p-sorted: first = strongest
    seenPair.add(pair);
    narrative.push({
      kind: 'test',
      score: (sig.level === 'strong' ? 6 : 4) + Math.min(2, t.strength || 0),
      sig,
      test: t,
      text: describeTest(t, cutoffHour),
    });
  }
  for (const d of descriptiveInsights(table, insightWindow)) narrative.push(d);
  narrative.sort((a, b) => b.score - a.score);

  return { table, tests, status, meals, narrative, outcomes, predictors };
}

/* Rolling mean helper for charts. */
function rolling(values, window) {
  const out = [];
  let sum = 0;
  const q = [];
  for (const v of values) {
    const x = (v == null || !isFinite(v)) ? 0 : v;
    q.push(x); sum += x;
    if (q.length > window) sum -= q.shift();
    out.push(q.length === window ? sum / window : null);
  }
  return out;
}

window.WDINSIGHTS = {
  ROLES, ROLE_KEYS, OUTCOMES,
  analyze, buildDaily, buildPredictors, availableOutcomes, runTests,
  baselineStatus, mealTimingAnalysis, descriptiveInsights, describeTest,
  significanceLabel, pairSeries,
  dayKey, addDays, minutesFromDayStart, fmtDayMinutes, fmtByType, fmtNum, rolling,
  mean, median, sd, mad, quantile, pearson, spearman, welch, cohensD,
  mannWhitney, benjaminiHochberg, poissonTailP, tTestP, normalCdf,
};

})();
