/* UI smoke test.
 *
 * Loads the real index.html + app scripts in jsdom against a fake IndexedDB,
 * so a runtime error in rendering fails loudly here instead of on the phone.
 * Covers first-launch onboarding, every tab, the insights analysis, and the
 * role editor round-trip.
 *
 *   npm install && node ui-smoke.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = __dirname;
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script[^>]*src="https?:[^"]*"[^>]*><\/script>/g, '');  // drop the CDN Chart.js

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'https://example.com/countwhen/',
  virtualConsole: vc,
  pretendToBeVisual: true,
});
const w = dom.window;
w.indexedDB = new FDBFactory();
w.IDBKeyRange = FDBKeyRange;
w.Chart = class { constructor() {} destroy() {} };
w.Chart.defaults = { color: '', font: {}, plugins: { legend: {} }, scale: { grid: {} } };
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
w.scrollTo = () => {};
try { delete w.navigator.serviceWorker; } catch (_) {}

const load = (rel) => {
  try {
    w.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    errors.push(`load ${rel}: ${e.stack}`);
  }
};
['js/config.js', 'js/db.js', 'js/stats.js', 'js/insights.js', 'js/drive.js', 'js/app.js']
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .forEach(load);

(async () => {
  const D = w.CWDB;
  const N = w.CWINSIGHTS;

  // 1. Fresh install: onboarding is offered.
  await D.seedDefaults();
  const fresh = await w.eval('needsOnboarding()');
  assert(fresh === true, 'fresh install should need onboarding');
  await w.eval('openOnboarding()');
  const cards = w.document.querySelectorAll('[data-preset]');
  assert(cards.length === 4, `expected 4 preset cards, got ${cards.length}`);

  // 2. Tapping a preset card creates topics with roles.
  const card = w.document.querySelector('[data-preset="symptoms"]');
  card.dispatchEvent(new w.Event('click'));
  await new Promise((r) => setTimeout(r, 120));
  const topics = await D.getAll('topics');
  assert(topics.length === 5, `preset seeded ${topics.length} topics, expected 5`);
  ok('symptom preset seeds 5 topics');
  const roles = await D.getTopicRoles();
  const norm = N.normalizeRoles(roles);
  assert(Object.values(norm).some((r) => r.role === 'focus'), 'preset must define a focus');
  assert(await w.eval('needsOnboarding()') === false, 'onboarding should not repeat');

  // 3. Seed ~200 days of events with a planted next-day effect, then render.
  const byName = Object.fromEntries(topics.map((t) => [t.name, t.id]));
  let eid = 1;
  const evs = [];
  const now = Date.now();
  for (let d = 200; d >= 0; d--) {
    const day = now - d * 86400000;
    const lateMeal = d % 3 === 0;
    evs.push({ id: eid++, topicid: byName['Meal'], time: day - (lateMeal ? 0 : 9) * 3600000, qant: 0, cost: 0 });
    const n = lateMeal ? 4 : 1;
    for (let i = 0; i < n; i++) evs.push({ id: eid++, topicid: byName['Symptom'], time: day + i * 1800000, qant: 0, cost: 0 });
    evs.push({ id: eid++, topicid: byName['Sleep'], time: day - 12 * 3600000, qant: 25200, cost: 0 });
    if (d % 17 === 0) evs.push({ id: eid++, topicid: byName['Bad day'], time: day, qant: 0, cost: 0 });
  }
  await D.putMany('events', evs);
  await w.eval('reload()');

  for (const view of ['categories', 'recent', 'day', 'stats', 'insights']) {
    w.eval(`setView('${view}')`);
    const out = w.document.querySelector('#main').innerHTML;
    assert(out && out.length > 50, `${view} rendered empty`);
    ok(`${view} view renders (${out.length} chars)`);
  }

  // 4. The insights view specifically must show the real analysis, not setup.
  w.eval(`setView('insights')`);
  const ins = w.document.querySelector('#main').innerHTML;
  assert(!/One-time setup/.test(ins), 'insights still showing the setup card');
  assert(/Symptom per day/.test(ins), 'trend heading should use the focus topic name');
  assert(/Timing/.test(ins), 'timing section missing');
  assert(!/bathroom|trips|flare-up|poop/i.test(ins), 'domain vocabulary leaked into the UI');
  ok('insights renders the full analysis with the user\'s own vocabulary');

  // 5. The dialogs all open without throwing.
  for (const fn of ['openRolesSetup()', 'openAlertsDialog()']) {
    w.eval(fn);
    assert(w.document.querySelector('#modalRoot .dialog'), `${fn} did not open`);
    w.eval('closeModal()');
    ok(`${fn} opens`);
  }

  // 6. Saving roles round-trips the new dir/timing fields.
  w.eval('openRolesSetup()');
  const sel = w.document.querySelector(`[data-role-topic="${byName['Symptom']}"]`);
  sel.value = 'focus';
  w.document.querySelector(`[data-role-dir="${byName['Symptom']}"]`).value = 'up';
  w.document.querySelector(`[data-role-timing="${byName['Symptom']}"]`).checked = true;
  w.document.querySelector('#saveRoles').dispatchEvent(new w.Event('click'));
  await new Promise((r) => setTimeout(r, 60));
  const saved = N.normalizeRoles(await D.getTopicRoles())[byName['Symptom']];
  assert(saved.role === 'focus' && saved.dir === 'up' && saved.timing === true,
    'role editor lost dir/timing: ' + JSON.stringify(saved));
  ok('role editor saves direction and timing');

  if (errors.length) {
    console.error('\nruntime errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('\nall passing');
})().catch((e) => {
  console.error(e.stack || e);
  if (errors.length) console.error('\nruntime errors:\n' + errors.join('\n'));
  process.exit(1);
});

function assert(c, m) { if (!c) throw new Error(m); }
function ok(m) { console.log('  ok  ' + m); }
