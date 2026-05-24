/* WhenDidI - Statistics aggregation
 * Buckets events by day / week (Mon-start) / month for a single topic.
 */

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun
  const diff = (dow + 6) % 7; // Mon-start
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function startOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

const BUCKETERS = {
  daily: startOfDay,
  weekly: startOfWeek,
  monthly: startOfMonth,
};

function labelFor(period, ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  if (period === 'monthly') return `${months[d.getMonth()]} ${d.getFullYear()}`;
  if (period === 'weekly') {
    const end = new Date(d); end.setDate(end.getDate() + 6);
    return `${d.getDate()}/${d.getMonth()+1} – ${end.getDate()}/${end.getMonth()+1}`;
  }
  // daily
  return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
}

function aggregate(events, period) {
  const bucket = BUCKETERS[period];
  if (!bucket) throw new Error(`unknown period ${period}`);
  const map = new Map();
  for (const e of events) {
    const k = bucket(e.time);
    if (!map.has(k)) {
      map.set(k, {
        bucket: k,
        count: 0,
        sumQant: 0,
        minTime: e.time,
        maxTime: e.time,
      });
    }
    const b = map.get(k);
    b.count++;
    b.sumQant += Number(e.qant || 0);
    if (e.time < b.minTime) b.minTime = e.time;
    if (e.time > b.maxTime) b.maxTime = e.time;
  }
  const rows = Array.from(map.values()).sort((a, b) => b.bucket - a.bucket);
  return rows;
}

window.WDSTATS = { aggregate, labelFor, startOfDay, startOfWeek, startOfMonth };
