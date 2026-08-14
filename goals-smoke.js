/* Goals / streaks smoke test.
 *
 * The streak rules have edge cases that are easy to get subtly wrong — zero
 * days, the asymmetry of "today", and clamping so a limit goal can't claim
 * credit for time before it existed. Each is pinned down here.
 *
 *   node goals-smoke.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const win = {};
new Function('window', 'document', 'navigator',
  fs.readFileSync(path.join(ROOT, 'js/insights.js'), 'utf8'))(win, {}, {});
new Function('window', 'document', 'navigator',
  fs.readFileSync(path.join(ROOT, 'js/goals.js'), 'utf8'))(win, {}, {});
const G = win.CWGOALS;

const CUTOFF = 4;
const DAY = 86400000;

/* A fixed "now" well clear of a DST boundary, at midday so the logical day
 * is unambiguous. */
const NOW = new Date(2026, 4, 20, 12, 0, 0).getTime();

/* Builds an event `d` days ago at a given hour. */
function ev(daysAgo, hour = 12, qant = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return { topicid: 1, time: d.getTime(), qant };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* 1. The headline habit case: consecutive days with at least one workout. */
test('counts consecutive days meeting an "at least" goal', () => {
  const events = [0, 1, 2, 3, 4].map((d) => ev(d));
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.current, 5, 'five logged days should be a five-day streak');
  assert.strictEqual(r.best, 5);
  assert.strictEqual(r.met, true, "today's goal is met");
});

/* 2. A gap in the middle ends the streak; the run before it becomes `best`. */
test('a missed day breaks the streak but is remembered as the best', () => {
  const events = [0, 1, 3, 4, 5, 6, 7].map((d) => ev(d));   // day 2 missing
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.current, 2, 'only today and yesterday survive the gap');
  assert.strictEqual(r.best, 5, 'the earlier five-day run is the best');
});

/* 3. The asymmetry of today, part one. An "at least" goal not yet hit is
 *    still winnable, so it must not zero out a live streak. */
test('an unmet "at least" goal today is pending, not a broken streak', () => {
  const events = [1, 2, 3].map((d) => ev(d));   // nothing logged today
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.pending, true, 'today should be pending');
  assert.strictEqual(r.current, 3, 'the streak of the three prior days survives');
  assert.strictEqual(r.remaining, 1, 'one more to go today');
});

/* 4. The asymmetry of today, part two. An "at most" goal you have already
 *    blown is broken now — there is no winning it back. */
test('an exceeded "at most" goal today breaks the streak immediately', () => {
  const events = [ev(0), ev(0, 14), ev(5)];   // two today, limit is one
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.pending, false, 'a blown limit is not pending');
  assert.strictEqual(r.met, false);
  assert.strictEqual(r.current, 0, 'the streak is broken today');
});

/* 5. The quit-smoking case. Days with no events at all are the ones that
 *    count, which only works if periods come from the calendar. */
test('empty days satisfy an "at most 0" goal', () => {
  const events = [ev(9)];   // one slip, nine days ago, nothing since
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'day', metric: 'count', since: NOW - 60 * DAY },
  });
  assert.strictEqual(r.current, 9, 'nine clean days since the slip');
  assert.strictEqual(r.met, true);
});

/* 6. Without clamping, "at most 0" would claim every day since the epoch. */
test('a limit streak cannot start before the goal existed', () => {
  const r = G.evaluate({
    events: [], kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'day', metric: 'count', since: NOW - 4 * DAY },
  });
  assert.strictEqual(r.current, 5, 'four days plus today, not the whole lookback');
});

/* 7. ...but real history before the goal still counts, so adding a goal to a
 *    topic you have tracked for months doesn't throw that away. */
test('a limit streak may start from the first logged event', () => {
  const r = G.evaluate({
    events: [ev(20)], kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'day', metric: 'count', since: NOW },
  });
  assert.strictEqual(r.current, 20, 'twenty clean days since the only event');
});

/* 8. Duration topics are stored in seconds but read in minutes. */
test('duration goals are measured in minutes', () => {
  const events = [0, 1, 2].map((d) => ev(d, 12, 1800));   // 30 min each
  const r = G.evaluate({
    events, kind: 'duration', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 30, period: 'day', metric: 'minutes', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.value, 30, '1800 seconds should read as 30 minutes');
  assert.strictEqual(r.current, 3);
});

/* 9. Amount topics sum their quantity. */
test('amount goals sum the logged quantity', () => {
  const events = [ev(0, 9, 32), ev(0, 15, 40), ev(1, 12, 10)];
  const r = G.evaluate({
    events, kind: 'amount', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 64, period: 'day', metric: 'amount', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.value, 72, 'today should total 72');
  assert.strictEqual(r.current, 1, 'yesterday fell short at 10');
});

/* 10. Weekly goals aggregate days, and judge on the week's total. */
test('weekly goals aggregate the whole week', () => {
  // Three workouts inside the current week, spread across days.
  const dow = (new Date(NOW).getDay() + 6) % 7;   // Mon = 0
  const events = [0, 1, 2].map((i) => ev(Math.min(dow, i)));
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 3, period: 'week', metric: 'count', since: NOW - 200 * DAY },
  });
  assert.ok(r.periods.length > 1, 'should produce multiple weeks');
  assert.strictEqual(r.periods[r.periods.length - 1].value, events.length,
    'the current week should hold all three');
});

/* 11. A partial leading week would be judged unfairly on fewer days. */
test('an incomplete first week is dropped', () => {
  const r = G.evaluate({
    events: [], kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'week', metric: 'count', since: NOW - 30 * DAY },
  });
  const first = r.periods[0];
  assert.strictEqual(first.days, 7, 'the first retained week must be whole');
});

/* 12. Completion rate reports settled periods only. */
test('completion rate ignores the pending period', () => {
  const events = [1, 2, 4].map((d) => ev(d));   // day 3 missed, today empty
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 4 * DAY },
  });
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.totalRecent, 4, 'today is excluded from the rate');
  assert.strictEqual(r.metRecent, 3);
});

/* 13. Garbage in must not throw. */
test('malformed goals are rejected rather than crashing', () => {
  for (const bad of [null, undefined, {}, 'gte', { target: 'x' }, { target: -1 },
                     { cmp: 'gte', target: 0 }]) {
    assert.strictEqual(G.normalizeGoal(bad), null, `should reject ${JSON.stringify(bad)}`);
    assert.strictEqual(G.evaluate({ events: [], goal: bad }), null);
  }
});

/* 14. The user-facing sentence adapts to the goal's shape. */
test('the streak line reads naturally in each direction', () => {
  const mk = (cmp, events, target = 1) => G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp, target, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.match(G.streakLine(mk('gte', [0, 1].map((d) => ev(d)))), /2 days in a row/);
  assert.match(G.streakLine(mk('gte', [ev(0)])), /1 day in a row/);
  assert.match(G.streakLine(mk('lte', [ev(9)], 0)), /9 days within your limit/);
  assert.match(G.streakLine(mk('lte', [ev(0), ev(0, 14)], 1)), /Over your limit/);
  assert.match(G.describeGoal({ cmp: 'lte', target: 2, period: 'week', metric: 'count' }),
    /at most 2× per week/);
});

/* 15. The day cutoff applies, so a 2am log belongs to the night before. */
test('goals respect the logical day cutoff', () => {
  const late = new Date(NOW);
  late.setHours(2, 0, 0, 0);            // 2am today -> counts as yesterday
  const r = G.evaluate({
    events: [{ topicid: 1, time: late.getTime(), qant: 0 }],
    kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.met, false, 'a 2am log should not satisfy today');
  assert.strictEqual(r.current, 1, 'it satisfies yesterday, keeping a 1-day streak');
});

let failed = 0;
console.log('goals and streaks');
for (const [name, fn] of tests) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
