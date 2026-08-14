#!/usr/bin/env node
/* Smoke test for the generalized insights engine.
 *
 * Feeds synthetic logs with known, planted relationships through analyze()
 * and checks the engine recovers them — for several unrelated tracking
 * domains, not just one. Also pins the legacy-role migration.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

global.window = {};
const src = fs.readFileSync(path.join(__dirname, 'js', 'insights.js'), 'utf8');
new Function(src)();
const I = window.CWINSIGHTS;

/* ---- synthetic log builder ---- */
const DAY = 86400000;
// Deterministic PRNG so a failure is always reproducible.
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}

/* Build `days` days of events ending today. `plan(dayIndex)` returns
 * [{topicid, n, hour, qant}] for that day. */
function buildEvents(days, plan) {
  const events = [];
  let id = 1;
  const today = Date.now();
  for (let d = 0; d < days; d++) {
    const dayStart = today - (days - 1 - d) * DAY;
    const base = new Date(dayStart); base.setHours(0, 0, 0, 0);
    for (const spec of plan(d)) {
      for (let i = 0; i < spec.n; i++) {
        const hour = spec.hour == null ? 8 + Math.floor(rnd() * 12) : spec.hour;
        const t = new Date(base); t.setHours(hour, Math.floor(rnd() * 60), 0, 0);
        events.push({ id: id++, topicid: spec.topicid, time: t.getTime(),
          qant: spec.qant || 0, note: spec.note || '', cost: 0 });
      }
    }
  }
  return events;
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

console.log('generalized insights engine');

/* ---------------------------------------------------------------- *
 * 1. Migraine tracker: caffeine drives migraines the NEXT day.
 * ---------------------------------------------------------------- */
test('recovers a planted next-day cause (migraines vs caffeine)', () => {
  seed = 999;
  const COFFEE = 1, MIGRAINE = 2;
  const coffeeByDay = [];
  for (let d = 0; d < 200; d++) coffeeByDay.push(1 + Math.floor(rnd() * 5));
  const events = buildEvents(200, (d) => {
    const out = [{ topicid: COFFEE, n: coffeeByDay[d], hour: 9 }];
    // migraines tomorrow scale with today's coffee
    const prev = d > 0 ? coffeeByDay[d - 1] : 2;
    const n = poisson(0.2 + prev * 0.6);
    if (n > 0) out.push({ topicid: MIGRAINE, n, hour: 15 });
    return out;
  });
  const topics = [{ id: COFFEE, name: 'Coffee' }, { id: MIGRAINE, name: 'Migraine' }];
  const res = I.analyze({
    events, topics,
    roles: { [MIGRAINE]: { role: 'focus', dir: 'down' }, [COFFEE]: { role: 'influence' } },
  });
  const hit = res.tests.find((t) =>
    t.predictorKey === `topic:${COFFEE}` &&
    t.outcomeKey === `focus:${MIGRAINE}:count` && t.lag === 1);
  assert.ok(hit, 'no coffee->migraine lag-1 test was run');
  assert.ok(hit.q < 0.05, 'planted effect not significant (q=' + hit.q + ')');
  assert.ok(hit.r > 0, 'expected a positive relationship, got r=' + hit.r);
  const txt = res.narrative.map((n) => n.text).join(' ');
  assert.ok(/Coffee/.test(txt) && /Migraine/.test(txt), 'topic names missing from narrative');
  assert.ok(!/bathroom|trips|blood|flare/i.test(txt), 'domain vocabulary leaked: ' + txt.slice(0, 200));
});

/* ---------------------------------------------------------------- *
 * 2. Habit tracker with an "up is good" focus.
 * ---------------------------------------------------------------- */
test('direction up: a drop in workouts reads as worse, not better', () => {
  seed = 4242;
  const WORKOUT = 1;
  // Steady ~1/day for months, then a slump in the last week.
  const events = buildEvents(160, (d) => {
    const slump = d >= 153;
    const n = slump ? (rnd() < 0.15 ? 1 : 0) : (rnd() < 0.85 ? 1 : 0);
    return n ? [{ topicid: WORKOUT, n, hour: 7 }] : [];
  });
  const topics = [{ id: WORKOUT, name: 'Workout' }];
  const res = I.analyze({
    events, topics,
    roles: { [WORKOUT]: { role: 'focus', dir: 'up' } },
  });
  assert.ok(['alert', 'watch'].includes(res.status.level),
    'a collapse in an up-is-good focus should raise a flag, got ' + res.status.level);
  const m = res.status.metrics.find((x) => x.key === `focus:${WORKOUT}:count`);
  assert.ok(m, 'no metric for the focus topic');
  assert.ok(m.current < m.baseline, 'sanity: current should be below baseline');
  assert.strictEqual(m.worse, true, 'a drop must be "worse" when more is better');
});

test('direction down: the same drop reads as improvement', () => {
  seed = 4242;
  const CIGS = 1;
  const events = buildEvents(160, (d) => {
    const quit = d >= 153;
    const n = quit ? (rnd() < 0.15 ? 1 : 0) : (rnd() < 0.85 ? 1 : 0);
    return n ? [{ topicid: CIGS, n, hour: 7 }] : [];
  });
  const topics = [{ id: CIGS, name: 'Cigarette' }];
  const res = I.analyze({ events, topics, roles: { [CIGS]: { role: 'focus', dir: 'down' } } });
  const m = res.status.metrics.find((x) => x.key === `focus:${CIGS}:count`);
  assert.strictEqual(m.worse, false, 'a drop must not be "worse" when less is better');
  assert.ok(['better', 'ok'].includes(res.status.level),
    'quitting should not raise an alert, got ' + res.status.level);
});

/* ---------------------------------------------------------------- *
 * 3. Legacy IBD setup keeps working after the rename.
 * ---------------------------------------------------------------- */
test('legacy role strings migrate to the new vocabulary', () => {
  const n = I.normalizeRoles({
    1: 'bathroom', 2: 'blood', 3: 'accident', 4: 'meal',
    5: 'sleep', 6: 'med', 7: 'trigger', 8: 'nonsense',
  });
  assert.deepStrictEqual(n[1], { role: 'focus', timing: false, dir: 'down' });
  assert.deepStrictEqual(n[2], { role: 'marker', timing: false, dir: 'down' });
  assert.deepStrictEqual(n[3], { role: 'marker', timing: false, dir: 'down' });
  assert.deepStrictEqual(n[4], { role: 'influence', timing: true, dir: 'down' });
  assert.deepStrictEqual(n[5], { role: 'influence', timing: true, dir: 'down' });
  assert.deepStrictEqual(n[6], { role: 'influence', timing: false, dir: 'down' });
  assert.strictEqual(n[8], undefined, 'unknown roles must be dropped, not kept');
});

test('a legacy install still analyzes end to end', () => {
  seed = 77;
  const GO = 1, MEAL = 2, BLOOD = 3;
  const events = buildEvents(180, (d) => {
    const out = [];
    const late = rnd() < 0.5;
    out.push({ topicid: MEAL, n: 1, hour: late ? 21 : 18 });
    out.push({ topicid: GO, n: poisson(late ? 5 : 3), hour: null, qant: 300 });
    if (rnd() < 0.08) out.push({ topicid: BLOOD, n: 1, hour: 10 });
    return out;
  });
  const topics = [{ id: GO, name: 'Bathroom' }, { id: MEAL, name: 'Meal' },
                  { id: BLOOD, name: 'Blood' }];
  const res = I.analyze({
    events, topics,
    roles: { [GO]: 'bathroom', [MEAL]: 'meal', [BLOOD]: 'blood' },  // legacy strings
    kinds: { [GO]: 'duration' },
  });
  assert.ok(res.table.focusIds.includes(GO), 'legacy bathroom topic should become the focus');
  assert.ok(res.table.markerIds.includes(BLOOD), 'legacy blood topic should become a marker');
  assert.ok(res.table.timingIds.includes(MEAL), 'legacy meal topic should keep timing analysis');
  assert.ok(res.outcomes.some((o) => o.key === `focus:${GO}:minutes`),
    'duration outcome missing for a duration-kind focus');
  assert.ok(res.timing.length > 0, 'timing analysis produced nothing for a meal topic');
  assert.ok(res.tests.length > 0, 'no tests ran for a legacy setup');
});

/* ---------------------------------------------------------------- *
 * 4. General guarantees.
 * ---------------------------------------------------------------- */
test('a topic never predicts its own outcome', () => {
  seed = 5;
  const A = 1;
  const events = buildEvents(120, () => [{ topicid: A, n: 1 + poisson(2) }]);
  const topics = [{ id: A, name: 'Thing' }];
  const res = I.analyze({ events, topics, roles: { [A]: { role: 'focus', dir: 'down' } } });
  const circular = res.tests.filter((t) =>
    t.predictorKey === `topic:${A}` && t.outcomeKey.startsWith(`focus:${A}:`));
  assert.strictEqual(circular.length, 0,
    'found ' + circular.length + ' circular self-predicting tests');
});

test('two focus topics can be tested against each other', () => {
  seed = 31;
  const SLEEP = 1, MOOD = 2;
  const events = buildEvents(200, (d) => {
    const slept = rnd() < 0.5 ? 1 : 0;
    const out = [];
    if (slept) out.push({ topicid: SLEEP, n: 1, hour: 23 });
    const n = slept ? poisson(0.4) : poisson(2.0);
    if (n) out.push({ topicid: MOOD, n, hour: 14 });
    return out;
  });
  const topics = [{ id: SLEEP, name: 'Good sleep' }, { id: MOOD, name: 'Low mood' }];
  const res = I.analyze({
    events, topics,
    roles: { [SLEEP]: { role: 'focus', dir: 'up' }, [MOOD]: { role: 'focus', dir: 'down' } },
  });
  const cross = res.tests.find((t) =>
    t.predictorKey === `topic:${SLEEP}` && t.outcomeKey === `focus:${MOOD}:count`);
  assert.ok(cross, 'focus topics should still predict each other');
  assert.ok(cross.q < 0.05, 'planted cross-focus effect missed (q=' + cross.q + ')');
});

test('no roles configured yields no outcomes and no crash', () => {
  seed = 8;
  const events = buildEvents(90, () => [{ topicid: 1, n: 2 }]);
  const res = I.analyze({ events, topics: [{ id: 1, name: 'Water' }], roles: {} });
  assert.strictEqual(res.outcomes.length, 0);
  assert.strictEqual(res.tests.length, 0);
  assert.ok(Array.isArray(res.narrative));
});

test('night window is configurable', () => {
  seed = 3;
  const A = 1;
  // Everything at 23:00 — inside a 22->6 window, outside a 0->5 one.
  const events = buildEvents(120, () => [{ topicid: A, n: 2, hour: 23 }]);
  const topics = [{ id: A, name: 'Waking' }];
  const roles = { [A]: { role: 'focus', dir: 'down' } };
  const wide = I.analyze({ events, topics, roles, nightStart: 22, nightEnd: 6 });
  const narrow = I.analyze({ events, topics, roles, nightStart: 0, nightEnd: 5 });
  assert.ok(wide.outcomes.some((o) => o.key === `focus:${A}:night`),
    '11pm events should count as night in a 22-6 window');
  assert.ok(!narrow.outcomes.some((o) => o.key === `focus:${A}:night`),
    '11pm events must not count as night in a 0-5 window');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
