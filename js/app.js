/* WhenDidI PWA - UI controller. Vanilla JS, single-page, 3 views. */

const VIEWS = ['categories', 'recent', 'day', 'stats', 'insights'];
const state = {
  view: 'categories',
  topics: [],
  events: [],
  measurements: [],
  favorites: new Set(),
  topicOrder: [],
  topicKinds: {}, // topicId -> 'timeonly' | 'duration' | 'amount'
  topicMeta: {},  // topicId -> { emoji, color }
  quickBar: [],   // fixed, user-curated ordered list of topic ids for the quick-access bar
  topicRoles: {}, // topicId -> 'bathroom' | 'meal' | 'blood' | 'accident' | ...
  insightSettings: null,
  insights: null,           // cached result of WDINSIGHTS.analyze()
  insightsDirty: true,      // recompute on next Insights render
  insightOutcome: 'goCount',
  insightLag: 0,
  statsTopicId: null,
  statsPeriod: 'daily',
  chart: null,
  // Per-view UI state
  recentFilter: { topic: '', from: '', to: '', q: '', tag: '' },
  dayDate: null,            // ms epoch (start of day)
  detailTopicId: null,      // currently-open detail view (in Stats)
  charts: {},               // multiple chart instances on Stats page
  // Undo queue
  lastUndo: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ======== UTILITIES ======== */

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDateShort(ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  const wk = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${wk[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtDateLong(ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function fmtTimeInput(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function parseDateTimeInput(dateStr, timeStr) {
  // dateStr: YYYY-MM-DD, timeStr: HH:MM
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

function relativeFromNow(ts) {
  const now = Date.now();
  const delta = now - ts;
  const sec = Math.floor(delta / 1000);
  const min = Math.floor(sec / 60);
  const hr  = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (sec < 60) return { big: `${sec}`, small: 'secs ago' };
  if (min < 60) return { big: `${min}`, small: 'mins ago' };
  if (hr < 24) {
    const m = min % 60;
    return { big: `${hr}:${pad(m)}`, small: 'hh:mm ago' };
  }
  if (day < 60) return { big: `${day}`, small: 'days ago' };
  const mth = Math.floor(day / 30);
  const days = day - mth * 30;
  return { big: `${mth} - ${days}`, small: 'mths - days ago' };
}

/* Format an event's qant for display based on its topic's measurement. */
function fmtQant(qant, topic) {
  const kind = state.topicKinds?.[topic?.id] || inferKind(topic);
  if (kind === 'timeonly') return ''; // don't show "1m" for timestamps
  const m = state.measurements.find((m) => m.id === topic?.msureid);
  if (!m) return String(qant ?? '');
  // type 3 = time-based; qant is in seconds (per observed data)
  if (m.type === 3) {
    const secs = Number(qant || 0);
    const h = Math.floor(secs / 3600);
    const mn = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (m.format === 7) {
      // mm:ss
      const totalMin = Math.floor(secs / 60);
      return `${pad(totalMin)}:${pad(s)}`;
    }
    if (m.format === 6) {
      // hh:mm:ss
      return `${h}:${pad(mn)}:${pad(s)}`;
    }
    if (m.format === 4) {
      // hours
      return `${(secs/3600).toFixed(1)} ${m.symbol}`;
    }
    if (m.format === 3) {
      // minutes
      return `${Math.round(secs/60)} ${m.symbol}`;
    }
    if (m.format === 2) {
      // seconds
      return `${secs} ${m.symbol}`;
    }
    // default Duration hh:mm: if seconds == 60 just show "1m"
    if (h === 0 && mn < 1) return `${mn}m`;
    if (h === 0) return `${mn}m`;
    return `${h}:${pad(mn)}`;
  }
  // unit-based: raw number + symbol
  const sym = m.symbol || '';
  return `${qant}${sym}`;
}

/* Infer a topic kind from its measurement when no explicit kind set. */
function inferKind(topic) {
  if (!topic) return 'amount';
  const m = state.measurements.find((mm) => mm.id === topic.msureid);
  if (!m) return 'amount';
  if (m.type === 3) return 'duration';  // imported duration topics
  return 'amount';
}

function topicKind(topic) {
  return state.topicKinds?.[topic?.id] || inferKind(topic);
}

/* ======== DATA LOADING ======== */

async function reload() {
  const [topics, events, measurements, favIds, topicKinds, topicMeta,
         topicRoles, insightSettings] = await Promise.all([
    WDDB.getAll('topics'),
    WDDB.getAll('events'),
    WDDB.getAll('measurements'),
    WDDB.getFavoriteTopicIds(),
    WDDB.getAllTopicKinds(),
    WDDB.getAllTopicMeta(),
    WDDB.getTopicRoles(),
    WDDB.getInsightSettings(),
  ]);
  const savedOrder = (await WDDB.getMeta('topicOrder')) || [];
  const knownIds = new Set(topics.map((t) => t.id));
  const orderedKnown = savedOrder.filter((id) => knownIds.has(id));
  const orderedSet = new Set(orderedKnown);
  const rest = topics
    .filter((t) => !orderedSet.has(t.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((t) => t.id);
  const finalOrder = [...orderedKnown, ...rest];
  const orderChanged =
    finalOrder.length !== savedOrder.length ||
    finalOrder.some((id, i) => savedOrder[i] !== id);
  if (orderChanged) {
    await WDDB.setMeta('topicOrder', finalOrder);
  }
  state.topicOrder = finalOrder;
  const byId = new Map(topics.map((t) => [t.id, t]));
  state.topics = finalOrder.map((id) => byId.get(id)).filter(Boolean);
  state.events = events;
  state.measurements = measurements;
  state.favorites = new Set(favIds);
  state.topicKinds = topicKinds || {};
  state.topicMeta = topicMeta || {};
  state.topicRoles = topicRoles || {};
  state.insightSettings = insightSettings;
  state.insightsDirty = true;
  // Quick-access bar: keep only ids that still map to existing, non-archived topics.
  const savedQuick = (await WDDB.getMeta('quickBar')) || [];
  const validQuick = Array.isArray(savedQuick)
    ? savedQuick.filter((id) => {
        const t = byId.get(id);
        return t && !t.archived;
      })
    : [];
  state.quickBar = validQuick;
  if (state.statsTopicId == null && state.topics.length) {
    state.statsTopicId = state.topics[0].id;
  }
}

async function saveTopicOrder(orderIds) {
  state.topicOrder = orderIds.slice();
  await WDDB.setMeta('topicOrder', state.topicOrder);
  // re-sort in-memory state.topics to match
  const byId = new Map(state.topics.map((t) => [t.id, t]));
  state.topics = orderIds.map((id) => byId.get(id)).filter(Boolean);
  // any topics not in orderIds (shouldn't happen but defensive)
  for (const t of byId.values()) {
    if (!orderIds.includes(t.id)) state.topics.push(t);
  }
  queueAutoSync();
}

function lastEventForTopic(topicid) {
  let best = null;
  for (const e of state.events) {
    if (e.topicid !== topicid) continue;
    if (!best || e.time > best.time) best = e;
  }
  return best;
}

/* ======== VIEW: CATEGORIES (default home) ======== */

function welcomeBannerHtml() {
  return `
    <div class="banner">
      <span>👋 Welcome! Import your existing <code>whendidibk.json</code> to load your data, or start fresh by adding topics.</span>
      <button class="btn" id="welcomeImport">Import…</button>
    </div>
  `;
}

function bindWelcomeBanner() {
  const btn = $('#welcomeImport');
  if (btn) btn.addEventListener('click', () => triggerImport());
}

/* ======== VIEW: CATEGORIES ======== */

function frequentTopicsLast30Days() {
  const cutoff = Date.now() - 30 * 86400000;
  const counts = new Map();
  for (const e of state.events) {
    if (e.time < cutoff) continue;
    counts.set(e.topicid, (counts.get(e.topicid) || 0) + 1);
  }
  const ranked = Array.from(counts.entries())
    .map(([id, c]) => ({ id, c, topic: state.topics.find((t) => t.id === id) }))
    .filter((r) => r.topic && !r.topic.archived)
    .sort((a, b) => b.c - a.c)
    .slice(0, 5);
  return ranked;
}

/* Topics to show in the quick-access bar, in fixed order.
 * Returns the user-curated list when configured; otherwise null to signal
 * that the auto "frequent topics" fallback should be used. */
function quickBarList() {
  const ids = state.quickBar || [];
  if (!ids.length) return null;
  const byId = new Map(state.topics.map((t) => [t.id, t]));
  return ids
    .map((id) => byId.get(id))
    .filter((t) => t && !t.archived)
    .map((t) => ({ id: t.id, topic: t }));
}

function renderCategories() {
  const main = $('#main');
  const topics = state.topics.filter((t) => !t.archived);
  if (!topics.length) {
    main.innerHTML = `
      ${welcomeBannerHtml()}
      <div class="empty">
        <p>No topics yet.</p>
        <button class="btn" id="emptyAddTopic">Add a topic</button>
      </div>`;
    bindWelcomeBanner();
    $('#emptyAddTopic')?.addEventListener('click', () => openTopicEdit(null));
    return;
  }

  const manual = quickBarList();
  const frequent = manual !== null ? manual : frequentTopicsLast30Days();
  const quickBar = frequent.length ? `
    <div class="quick-bar">
      ${frequent.map((f) => {
        const emoji = topicEmoji(f.topic);
        const color = topicColor(f.topic);
        return `<button class="quick-chip" data-quick="${f.id}" style="--accent:${color}">
          ${emoji ? `<span class="qc-emoji">${escapeHtml(emoji)}</span>` : ''}
          <span class="qc-name">+ ${escapeHtml(f.topic.name)}</span>
        </button>`;
      }).join('')}
    </div>` : '';

  const html = topics.map((t) => {
    const last = lastEventForTopic(t.id);
    const rel = last ? relativeFromNow(last.time) : null;
    const emoji = topicEmoji(t);
    const color = topicColor(t);
    const lastLine = last
      ? `${fmtDateShort(last.time)} <strong>${escapeHtml(fmtQant(last.qant, t))}</strong>`
      : '<em>no entries yet</em>';
    return `
      <div class="card" data-topic="${t.id}" style="--accent:${color}">
        <div class="delta">
          ${rel ? `<div class="big">${rel.big}</div><div class="small">${rel.small}</div>` : `<div class="small">—</div>`}
        </div>
        <div>
          <div class="name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(t.name)}</div>
          ${t.desc ? `<div class="desc">${escapeHtml(t.desc)}</div>` : ''}
          <div class="last">${lastLine}</div>
        </div>
        <div class="actions">
          <button class="add-btn" data-add="${t.id}">ADD</button>
        </div>
      </div>
    `;
  }).join('');

  main.innerHTML = `
    ${quickBar}
    <div class="reorder-hint">Tap ADD to log. Long-press a card to drag-reorder. Rename / change type / delete in ☰ → Manage Topics.</div>
    <div id="categoriesList">${html}</div>
    <button class="new-topic-tile" id="addTopicBtn">+ New topic</button>
  `;

  // Quick-bar one-tap log
  $$('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = Number(e.currentTarget.dataset.quick);
      const topic = state.topics.find((t) => t.id === id);
      if (topic) logNow(topic);
    });
  });

  $$('[data-add]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(e.currentTarget.dataset.add);
      const topic = state.topics.find((t) => t.id === id);
      openAddEvent(topic);
    });
  });

  attachReorder($('#categoriesList'), (newOrderIds) => {
    saveTopicOrder(newOrderIds);
  });

  $('#addTopicBtn').addEventListener('click', () => openTopicEdit(null));
}

/* Long-press to drag, pointermove to reorder live. */
function attachReorder(listEl, onCommit) {
  let drag = null;
  let pressTimer = null;
  let startX = 0, startY = 0;
  let pressedCard = null;
  let pointerId = null;

  const clearHighlight = () => {
    $$('.card.drag-target-above', listEl).forEach((el) => el.classList.remove('drag-target-above'));
    $$('.card.drag-target-below', listEl).forEach((el) => el.classList.remove('drag-target-below'));
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('.card');
    if (!card || !listEl.contains(card)) return;
    // Don't initiate reorder if the user is touching an interactive child
    if (e.target.closest('button')) return;
    pressedCard = card;
    startX = e.clientX; startY = e.clientY;
    pointerId = e.pointerId;
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      startDrag(card);
    }, 380);
  };

  const startDrag = (card) => {
    drag = { card };
    card.classList.add('dragging');
    // Lock touch handling so the page can't scroll out from under us
    document.body.classList.add('drag-active');
    try { card.setPointerCapture(pointerId); } catch (_) {}
    if (navigator.vibrate) navigator.vibrate(25);
  };

  const onPointerMove = (e) => {
    if (pressTimer) {
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > 10 || dy > 10) {
        clearTimeout(pressTimer); pressTimer = null;
      }
    }
    if (!drag) return;
    e.preventDefault();
    // Find which card is under the pointer (excluding the dragging one)
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    const target = els.find((el) => el.classList?.contains('card') && el !== drag.card && listEl.contains(el));
    clearHighlight();
    if (target) {
      const rect = target.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      target.classList.add(above ? 'drag-target-above' : 'drag-target-below');
      if (above) listEl.insertBefore(drag.card, target);
      else listEl.insertBefore(drag.card, target.nextElementSibling);
    }
  };

  const onPointerUp = (e) => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (!drag) { pressedCard = null; return; }
    drag.card.classList.remove('dragging');
    document.body.classList.remove('drag-active');
    clearHighlight();
    drag.card.dataset.justDragged = '1';
    const newOrder = Array.from(listEl.children).map((c) => Number(c.dataset.topic));
    drag = null;
    onCommit(newOrder);
  };

  const onPointerCancel = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (drag) {
      drag.card.classList.remove('dragging');
      document.body.classList.remove('drag-active');
      clearHighlight();
      drag = null;
    }
  };

  listEl.addEventListener('pointerdown', onPointerDown);
  listEl.addEventListener('pointermove', onPointerMove);
  listEl.addEventListener('pointerup', onPointerUp);
  listEl.addEventListener('pointercancel', onPointerCancel);
}

/* ======== VIEW: RECENT ======== */

function renderRecent() {
  const main = $('#main');
  if (!state.events.length) {
    main.innerHTML = `${welcomeBannerHtml()}<div class="empty">No events logged yet.</div>`;
    bindWelcomeBanner();
    return;
  }
  const f = state.recentFilter;
  const topicById = new Map(state.topics.map((t) => [t.id, t]));
  // Filter
  let filtered = state.events;
  if (f.topic) filtered = filtered.filter((e) => e.topicid === Number(f.topic));
  if (f.from) {
    const fromMs = new Date(f.from + 'T00:00:00').getTime();
    filtered = filtered.filter((e) => e.time >= fromMs);
  }
  if (f.to) {
    const toMs = new Date(f.to + 'T23:59:59.999').getTime();
    filtered = filtered.filter((e) => e.time <= toMs);
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    filtered = filtered.filter((e) => {
      const topic = topicById.get(e.topicid);
      const tname = topic ? topic.name.toLowerCase() : '';
      const note = (e.note || '').toLowerCase();
      return note.includes(q) || tname.includes(q);
    });
  }
  if (f.tag) {
    const tag = f.tag.toLowerCase();
    filtered = filtered.filter((e) => WDSTATS.tagSet(e.note || '').has(tag));
  }
  const sorted = filtered.slice().sort((a, b) => b.time - a.time);

  // Build the filter bar
  const topicOpts = `<option value="">All topics</option>` +
    state.topics.map((t) => `<option value="${t.id}" ${String(t.id)===f.topic?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
  const tags = WDSTATS.allTagsFromEvents(state.events).slice(0, 12);
  const tagBar = tags.length ? `
    <div class="recent-tag-row">
      <button class="tag-filter-chip ${!f.tag?'active':''}" data-tag-filter="">all</button>
      ${tags.map((t) => `<button class="tag-filter-chip ${f.tag===t.tag?'active':''}" data-tag-filter="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)} <small>(${t.count})</small></button>`).join('')}
    </div>` : '';

  let shown = Math.min(200, sorted.length);
  const renderList = () => {
    const rows = sorted.slice(0, shown).map((e) => {
      const t = topicById.get(e.topicid);
      const name = t ? t.name : `(topic ${e.topicid})`;
      const qant = t ? fmtQant(e.qant, t) : e.qant;
      const emoji = t ? topicEmoji(t) : '';
      return `
        <div class="recent-row" data-event="${e.id}">
          <div>
            <div class="r-name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(name)} ${severityBadge(e)}</div>
            <div class="r-when">${fmtDateLong(e.time)} <small>${fmtTime(e.time)}</small></div>
            ${e.note ? `<div class="r-note">${renderNoteWithTags(e.note)}</div>` : ''}
          </div>
          <div class="r-qant">${escapeHtml(qant)}</div>
        </div>
      `;
    }).join('');
    const more = (shown < sorted.length)
      ? `<div style="text-align:center;padding:14px;"><button class="btn secondary" id="loadMore">Load ${Math.min(200, sorted.length - shown)} more (${sorted.length - shown} remaining)</button></div>`
      : (sorted.length ? `<div class="empty">— end of ${sorted.length.toLocaleString()} matching events —</div>` : `<div class="empty">No events match the filters.</div>`);
    main.innerHTML = `
      <div class="recent-filter">
        <div class="row-2">
          <div class="field"><label>Topic</label><select id="rfTopic">${topicOpts}</select></div>
          <div class="field"><label>Search</label><input id="rfQuery" type="text" placeholder="text in note or topic" value="${escapeHtml(f.q)}"></div>
        </div>
        <div class="row-2">
          <div class="field"><label>From</label><input id="rfFrom" type="date" value="${escapeHtml(f.from)}"></div>
          <div class="field"><label>To</label><input id="rfTo" type="date" value="${escapeHtml(f.to)}"></div>
        </div>
        ${tagBar}
        <div class="recent-filter-actions">
          <button class="btn secondary" id="rfClear">Clear</button>
          <button class="btn" id="rfApply">Apply</button>
        </div>
      </div>
      <div class="sticky-header">${sorted.length.toLocaleString()} matching · showing ${Math.min(shown, sorted.length).toLocaleString()}</div>
      ${rows}
      ${more}
    `;
    $('#loadMore')?.addEventListener('click', () => {
      shown = Math.min(shown + 200, sorted.length);
      renderList();
    });
    $$('.recent-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = Number(row.dataset.event);
        const e = state.events.find((x) => x.id === id);
        const t = topicById.get(e.topicid);
        if (t && e) openAddEvent(t, e);
      });
    });
    $('#rfApply')?.addEventListener('click', () => {
      state.recentFilter = {
        topic: $('#rfTopic').value,
        q: $('#rfQuery').value.trim(),
        from: $('#rfFrom').value,
        to: $('#rfTo').value,
        tag: state.recentFilter.tag,
      };
      renderRecent();
    });
    $('#rfClear')?.addEventListener('click', () => {
      state.recentFilter = { topic: '', q: '', from: '', to: '', tag: '' };
      renderRecent();
    });
    $$('[data-tag-filter]').forEach((b) => b.addEventListener('click', () => {
      state.recentFilter = { ...state.recentFilter, tag: b.dataset.tagFilter };
      renderRecent();
    }));
  };
  renderList();
}

/* ======== VIEW: DAY ======== */

function renderDay() {
  const main = $('#main');
  if (!state.events.length) {
    main.innerHTML = `${welcomeBannerHtml()}<div class="empty">No events yet — log something to start.</div>`;
    bindWelcomeBanner();
    return;
  }
  if (!state.dayDate) state.dayDate = WDSTATS.startOfDay(Date.now());
  const day = state.dayDate;
  const nextDay = day + 86400000;
  const events = state.events
    .filter((e) => e.time >= day && e.time < nextDay)
    .sort((a, b) => a.time - b.time);

  const topicById = new Map(state.topics.map((t) => [t.id, t]));

  // Per-topic summary
  const groupMap = new Map();
  for (const e of events) {
    if (!groupMap.has(e.topicid)) groupMap.set(e.topicid, []);
    groupMap.get(e.topicid).push(e);
  }
  const groups = Array.from(groupMap.entries())
    .map(([tid, evs]) => ({ topic: topicById.get(tid), evs }))
    .filter((g) => g.topic)
    .sort((a, b) => b.evs.length - a.evs.length);

  const dateStr = fmtDateLong(day);
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(day).getDay()];
  const isToday = day === WDSTATS.startOfDay(Date.now());
  const todayLabel = isToday ? 'Today' : (day === WDSTATS.startOfDay(Date.now() - 86400000) ? 'Yesterday' : '');

  // Chronological list
  const chronoHtml = events.map((e) => {
    const t = topicById.get(e.topicid);
    const name = t ? t.name : `(${e.topicid})`;
    const emoji = t ? topicEmoji(t) : '';
    const q = t ? fmtQant(e.qant, t) : e.qant;
    return `
      <div class="day-event" data-event="${e.id}">
        <div class="day-time">${fmtTime(e.time)}</div>
        <div class="day-info">
          <div class="day-name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(name)} ${severityBadge(e)}</div>
          ${e.note ? `<div class="day-note">${renderNoteWithTags(e.note)}</div>` : ''}
        </div>
        <div class="day-qant">${escapeHtml(q)}</div>
      </div>`;
  }).join('') || '<div class="empty">No events on this day.</div>';

  // Per-topic summary cards
  const summaryHtml = groups.map((g) => {
    const t = g.topic;
    const emoji = topicEmoji(t);
    const color = topicColor(t);
    const kind = topicKind(t);
    let qantSummary = '';
    if (kind === 'amount' || kind === 'duration') {
      const sum = g.evs.reduce((s, e) => s + Number(e.qant || 0), 0);
      qantSummary = ` · sum ${escapeHtml(fmtQant(sum, t))}`;
    }
    const times = g.evs.map((e) => fmtTime(e.time)).join(', ');
    return `
      <div class="day-summary-row" style="--accent:${color}">
        <div class="dsr-head">
          <span class="dsr-name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(t.name)}</span>
          <span class="dsr-count">${g.evs.length}×${qantSummary}</span>
        </div>
        <div class="dsr-times">${escapeHtml(times)}</div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="day-nav">
      <button class="icon-btn day-prev" id="dayPrev" aria-label="Previous day">‹</button>
      <div class="day-title">
        <div class="dt-main">${dow}, ${dateStr}</div>
        ${todayLabel ? `<div class="dt-sub">${todayLabel}</div>` : ''}
      </div>
      <button class="icon-btn day-next" id="dayNext" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
      <input type="date" id="dayPick" value="${fmtDateInput(day)}">
    </div>
    <div class="day-stats-strip">
      <div><b>${events.length}</b><span>events</span></div>
      <div><b>${groups.length}</b><span>topics</span></div>
      <div><b>${events.filter((e) => Number(e.cost||0) >= 3).length}</b><span>severity 3+</span></div>
    </div>
    ${groups.length ? `<div class="day-section-h">Per topic</div>${summaryHtml}` : ''}
    <div class="day-section-h">Timeline</div>
    ${chronoHtml}
  `;

  $('#dayPrev').addEventListener('click', () => {
    state.dayDate = state.dayDate - 86400000;
    renderDay();
  });
  $('#dayNext').addEventListener('click', () => {
    state.dayDate = Math.min(state.dayDate + 86400000, WDSTATS.startOfDay(Date.now()));
    renderDay();
  });
  $('#dayPick').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v) {
      const [y, mo, d] = v.split('-').map(Number);
      state.dayDate = new Date(y, mo - 1, d).getTime();
      renderDay();
    }
  });
  $$('.day-event').forEach((row) => row.addEventListener('click', () => {
    const id = Number(row.dataset.event);
    const ev = state.events.find((x) => x.id === id);
    const t = topicById.get(ev?.topicid);
    if (ev && t) openAddEvent(t, ev);
  }));
}

/* ======== VIEW: STATISTICS (per-topic detail) ======== */

function destroyCharts() {
  for (const c of Object.values(state.charts)) {
    try { c?.destroy(); } catch (_) {}
  }
  state.charts = {};
}

function renderStats() {
  destroyCharts();
  const main = $('#main');
  if (!state.topics.length) {
    main.innerHTML = `${welcomeBannerHtml()}<div class="empty">Import data or add a topic to see statistics.</div>`;
    bindWelcomeBanner();
    return;
  }
  const topics = state.topics.filter((t) => !t.archived);
  if (state.statsTopicId == null || !topics.find((t) => t.id === state.statsTopicId)) {
    state.statsTopicId = topics[0]?.id;
  }
  const topic = topics.find((t) => t.id === state.statsTopicId);
  const events = state.events.filter((e) => e.topicid === topic.id);
  const measurement = state.measurements.find((m) => m.id === topic?.msureid);
  const kind = topicKind(topic);
  const isMeasurable = kind === 'amount' || kind === 'duration';
  const totalQant = events.reduce((s, e) => s + Number(e.qant || 0), 0);
  const totalQantStr = isMeasurable ? fmtQant(totalQant, topic) : '';

  // Build the top selector + period tabs
  const topOpts = topics.map((t) => `<option value="${t.id}" ${t.id===topic.id?'selected':''}>${escapeHtml(t.name)}</option>`).join('');

  // Interval stats
  const iv = WDSTATS.intervalStats(events);
  const intervalSummary = iv ? `
    <div class="stats-cards">
      <div><b>${events.length.toLocaleString()}</b><span>events</span></div>
      <div><b>${WDSTATS.fmtIntervalShort(iv.avg)}</b><span>avg interval</span></div>
      <div><b>${WDSTATS.fmtIntervalShort(iv.median)}</b><span>median</span></div>
      <div><b>${WDSTATS.fmtIntervalShort(iv.min)}</b><span>min</span></div>
      <div><b>${WDSTATS.fmtIntervalShort(iv.max)}</b><span>max</span></div>
      <div><b>${WDSTATS.fmtIntervalShort(iv.last)}</b><span>since last</span></div>
      ${isMeasurable ? `<div><b>${escapeHtml(totalQantStr)}</b><span>total</span></div>` : ''}
    </div>` : `<div class="stats-cards"><div><b>${events.length}</b><span>events</span></div></div>`;

  // Cross-topic correlations
  const correlations = WDSTATS.correlations(state.events, topic.id, 24 * 3600 * 1000);
  const corrRows = correlations.slice(0, 8).map((c) => {
    const other = state.topics.find((t) => t.id === c.otherTopicId);
    if (!other) return '';
    const dir = c.avgOffsetMs < 0 ? 'before' : 'after';
    return `<div class="corr-row">
      <div><strong>${escapeHtml(other.name)}</strong></div>
      <div><span class="muted">avg</span> ${WDSTATS.fmtIntervalShort(Math.abs(c.avgOffsetMs))} <span class="muted">${dir}</span> (n=${c.sampleCount})</div>
    </div>`;
  }).join('');

  main.innerHTML = `
    <div class="period-tabs" id="periodTabs" role="tablist">
      <button class="tab" data-period="daily"   aria-selected="${state.statsPeriod==='daily'}">Daily</button>
      <button class="tab" data-period="weekly"  aria-selected="${state.statsPeriod==='weekly'}">Weekly</button>
      <button class="tab" data-period="monthly" aria-selected="${state.statsPeriod==='monthly'}">Monthly</button>
    </div>
    <div class="stats-bar">
      <select id="statsTopic">${topOpts}</select>
    </div>
    ${intervalSummary}

    <div class="stats-section">
      <h3>Count over time</h3>
      <div class="chart-wrap"><canvas id="chartOverTime"></canvas></div>
    </div>

    <div class="stats-section">
      <h3>Calendar (last 26 weeks)</h3>
      <div id="heatmap" class="heatmap"></div>
    </div>

    <div class="stats-section">
      <h3>Time of day</h3>
      <div class="chart-wrap"><canvas id="chartTOD"></canvas></div>
    </div>

    <div class="stats-section">
      <h3>Day of week</h3>
      <div class="chart-wrap"><canvas id="chartDOW"></canvas></div>
    </div>

    ${corrRows ? `
      <div class="stats-section">
        <h3>Correlated topics (within 24h)</h3>
        <p class="muted-small">For each event of <em>${escapeHtml(topic.name)}</em>, the nearest event of another topic within 24 hours.</p>
        ${corrRows}
      </div>` : ''}
  `;

  $$('#periodTabs .tab').forEach((tb) => {
    tb.addEventListener('click', () => {
      state.statsPeriod = tb.dataset.period;
      renderStats();
    });
  });
  $('#statsTopic').addEventListener('change', (e) => {
    state.statsTopicId = Number(e.target.value);
    renderStats();
  });

  // Render charts
  drawOverTime(events, topic);
  drawTimeOfDay(events);
  drawDayOfWeek(events);
  drawHeatmap(events);
}

function drawOverTime(events, topic) {
  const canvas = $('#chartOverTime');
  if (!canvas) return;
  const rows = WDSTATS.aggregate(events, state.statsPeriod);
  const cutoff = { daily: 30, weekly: 12, monthly: 12 }[state.statsPeriod];
  const slice = rows.slice(0, cutoff).reverse();
  const labels = slice.map((r) => WDSTATS.labelFor(state.statsPeriod, r.bucket));
  const counts = slice.map((r) => r.count);
  state.charts.overTime = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'count', data: counts, backgroundColor: '#6fa8c4' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function drawTimeOfDay(events) {
  const canvas = $('#chartTOD');
  if (!canvas) return;
  const buckets = WDSTATS.timeOfDay(events);
  const labels = buckets.map((_, i) => `${i}`);
  state.charts.tod = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'count', data: buckets, backgroundColor: '#8a5a2b' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { title: { display: true, text: 'hour' } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function drawDayOfWeek(events) {
  const canvas = $('#chartDOW');
  if (!canvas) return;
  const buckets = WDSTATS.dayOfWeek(events);
  const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  state.charts.dow = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'count', data: buckets, backgroundColor: '#e2a920' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function drawHeatmap(events) {
  const root = $('#heatmap');
  if (!root) return;
  const mat = WDSTATS.calendarMatrix(events, 26);
  const maxC = Math.max(1, mat.maxCount);
  const heatLevel = (c) => {
    if (c === 0) return 0;
    if (c <= maxC * 0.25) return 1;
    if (c <= maxC * 0.5) return 2;
    if (c <= maxC * 0.75) return 3;
    return 4;
  };
  let html = '<div class="heatmap-grid">';
  for (let w = 0; w < mat.weeks.length; w++) {
    html += '<div class="heatmap-col">';
    for (let d = 0; d < 7; d++) {
      const cell = mat.weeks[w][d];
      const lvl = heatLevel(cell.count);
      const date = new Date(cell.date);
      html += `<div class="heatmap-cell level-${lvl}" title="${date.toDateString()}: ${cell.count} event${cell.count===1?'':'s'}"></div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  html += `<div class="heatmap-legend">Less <span class="heatmap-cell level-0"></span><span class="heatmap-cell level-1"></span><span class="heatmap-cell level-2"></span><span class="heatmap-cell level-3"></span><span class="heatmap-cell level-4"></span> More · ${mat.total} total in window</div>`;
  root.innerHTML = html;
}

/* ======== INSIGHTS VIEW ======== */

function insightsSettings() {
  return state.insightSettings || {
    cutoffHour: 4, windowDays: 7, insightWindow: 90,
    alertsEnabled: false, alertOn: 'flare',
  };
}

function hasBathroomRole() {
  return Object.values(state.topicRoles || {}).includes('bathroom');
}

function computeInsights(force = false) {
  if (!force && !state.insightsDirty && state.insights) return state.insights;
  const s = insightsSettings();
  state.insights = WDINSIGHTS.analyze({
    events: state.events,
    topics: state.topics,
    roles: state.topicRoles,
    kinds: state.topicKinds,
    cutoffHour: s.cutoffHour,
    windowDays: s.windowDays,
    insightWindow: s.insightWindow,
  });
  state.insightsDirty = false;
  return state.insights;
}

const STATUS_META = {
  flare:        { icon: '🔴', title: 'Looks like a flare-up',      cls: 'flare' },
  watch:        { icon: '🟠', title: 'Worse than usual — keep an eye on it', cls: 'watch' },
  ok:           { icon: '🟢', title: 'Normal week',                cls: 'ok' },
  better:       { icon: '🟢', title: 'Better than usual',          cls: 'ok' },
  insufficient: { icon: '⚪', title: 'Not enough history yet',     cls: 'none' },
  unknown:      { icon: '⚪', title: 'No baseline yet',            cls: 'none' },
};

function sigBadge(sig) {
  if (!sig) return '';
  const cls = sig.level === 'strong' ? 'sig-strong'
    : sig.level === 'weak' ? 'sig-weak' : 'sig-none';
  return `<span class="sig ${cls}">${escapeHtml(sig.label)}</span>`;
}

function renderInsights() {
  destroyCharts();
  const main = $('#main');
  const N = WDINSIGHTS;

  if (!state.topics.length) {
    main.innerHTML = `${welcomeBannerHtml()}<div class="empty">Import data or add a topic first.</div>`;
    bindWelcomeBanner();
    return;
  }
  if (!hasBathroomRole()) {
    main.innerHTML = `
      <div class="setup-card">
        <h3>One-time setup</h3>
        <p>To answer questions like <em>“is this a flare-up?”</em> or <em>“does a late
        dinner make the next day worse?”</em>, the app needs to know which of your
        topics mean what.</p>
        <p>Tag at least your main <strong>bathroom</strong> topic — plus meals, blood
        and accidents if you track them.</p>
        <button class="btn" id="goSetupRoles">Set up insights</button>
      </div>`;
    $('#goSetupRoles').addEventListener('click', openRolesSetup);
    return;
  }

  const res = computeInsights();
  const { status, meals, narrative, table } = res;
  const s = insightsSettings();
  const meta = STATUS_META[status.level] || STATUS_META.unknown;

  const metricChips = status.metrics.map((m) => {
    const arrow = m.worse ? '▲' : '▼';
    const cls = m.elevated ? 'bad' : m.improved ? 'good' : '';
    const pct = isFinite(m.pct) ? `${m.pct >= 0 ? '+' : ''}${Math.round(m.pct)}%` : '';
    return `<div class="metric ${cls}">
      <b>${N.fmtNum(m.current, m.digits)}<small>${escapeHtml(m.unit)}</small></b>
      <span>${escapeHtml(m.label)}</span>
      <em>usual ${N.fmtNum(m.baseline, m.digits)} · ${arrow} ${pct}</em>
    </div>`;
  }).join('');

  const statusCard = `
    <div class="status-card ${meta.cls}">
      <div class="status-head"><span class="status-icon">${meta.icon}</span>
        <div>
          <h3>${escapeHtml(meta.title)}</h3>
          <p class="muted-small">Last ${status.windowDays} days vs your typical
          ${status.baselineDays ? `${status.baselineDays}-day` : ''} baseline</p>
        </div>
      </div>
      <ul class="status-reasons">${status.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      ${metricChips ? `<div class="metric-row">${metricChips}</div>` : ''}
      ${status.percentile != null ? `<p class="muted-small">This week ranks higher than
        <strong>${status.percentile}%</strong> of all weeks on record
        (${status.windowTotal} trips; worst ever was ${status.worstWindowTotal}).</p>` : ''}
      <div class="status-actions">
        <button class="btn secondary small" id="insAlerts">${s.alertsEnabled ? '🔔 Alerts on' : '🔕 Turn on alerts'}</button>
        <button class="btn secondary small" id="insSetup">⚙️ Topics &amp; settings</button>
      </div>
    </div>`;

  const insightItems = narrative.slice(0, 12).map((n) => `
    <li class="insight ${n.kind === 'test' ? 'is-test' : ''}">
      <span>${escapeHtml(n.text)}</span>
      ${n.sig ? sigBadge(n.sig) : ''}
    </li>`).join('');

  main.innerHTML = `
    ${statusCard}

    <div class="stats-section">
      <h3>Trips per day (last 120 days)</h3>
      <div class="chart-wrap"><canvas id="chartInsTrend"></canvas></div>
    </div>

    <div class="stats-section">
      <h3>What stands out (last ${s.insightWindow} days)</h3>
      ${insightItems
        ? `<ul class="insight-list">${insightItems}</ul>`
        : `<p class="muted-small">Not enough data yet — keep logging.</p>`}
      <p class="muted-small">“Significant” means it survived a false-discovery
      correction across every combination tested, and passed both a parametric
      and a rank-based test. Correlation still isn’t causation.</p>
    </div>

    ${renderMealSection(meals, table)}

    <div class="stats-section">
      <h3>What moves the needle</h3>
      <div class="stats-bar ins-controls">
        <select id="insOutcome">${res.outcomes.map((o) =>
          `<option value="${o.key}" ${o.key === state.insightOutcome ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
        ).join('')}</select>
        <select id="insLag">
          <option value="0" ${state.insightLag === 0 ? 'selected' : ''}>same day</option>
          <option value="1" ${state.insightLag === 1 ? 'selected' : ''}>next day</option>
        </select>
      </div>
      ${renderExplorer(res)}
    </div>
  `;

  $('#insAlerts').addEventListener('click', openAlertsDialog);
  $('#insSetup').addEventListener('click', openRolesSetup);
  $('#insOutcome').addEventListener('change', (e) => {
    state.insightOutcome = e.target.value; renderInsights();
  });
  $('#insLag').addEventListener('change', (e) => {
    state.insightLag = Number(e.target.value); renderInsights();
  });
  drawInsightsTrend(table);
}

function renderMealSection(meals, table) {
  if (!table.hasMeals) {
    return `<div class="stats-section">
      <h3>Meal timing</h3>
      <p class="muted-small">Tag a topic as <strong>Meal / food</strong> in
      ⚙️ Topics &amp; settings to test whether first- or last-meal timing
      affects your day.</p></div>`;
  }
  if (!meals.length) {
    return `<div class="stats-section">
      <h3>Meal timing</h3>
      <p class="muted-small">Not enough overlapping meal + bathroom days yet.</p></div>`;
  }
  const N = WDINSIGHTS;
  const verdict = (q, p) => {
    if (isFinite(q)) {
      if (q < 0.05) return { txt: 'Yes', cls: 'sig-strong' };
      if (q < 0.15) return { txt: 'Maybe', cls: 'sig-weak' };
      return { txt: 'No clear effect', cls: 'sig-none' };
    }
    // Too few days for the corrected panel — judge on the raw p, conservatively.
    if (!isFinite(p)) return { txt: 'Not enough data', cls: 'sig-none' };
    if (p < 0.01) return { txt: 'Maybe (few days)', cls: 'sig-weak' };
    return { txt: 'No clear effect', cls: 'sig-none' };
  };
  const groups = {};
  for (const m of meals) {
    if (!isFinite(m.p)) continue;               // nothing testable
    if (m.earlyMean === 0 && m.lateMean === 0) continue;  // never happens
    (groups[m.predictor] = groups[m.predictor] || []).push(m);
  }
  const cards = Object.entries(groups).map(([pred, rows]) => {
    const body = rows.map((r) => {
      const v = verdict(r.q, r.p);
      const isBinary = r.outcomeKind === 'binary';
      const fmtV = (x) => (isBinary ? `${Math.round(x * 100)}% of days` : N.fmtNum(x, 1));
      const dir = r.delta > 0 ? 'more' : 'less';
      const pTxt = r.p < 0.0001 ? 'p&lt;0.0001' : `p=${N.fmtNum(r.p, 4)}`;
      const qTxt = !isFinite(r.q) ? '' : (r.q < 0.001 ? ' · q&lt;0.001' : ` · q=${N.fmtNum(r.q, 3)}`);
      return `<div class="meal-row">
        <div class="meal-q">
          <strong>${escapeHtml(r.outcome)}</strong>
          <span class="muted-small">${r.lag === 1 ? 'next day' : 'same day'} · n=${r.n}</span>
        </div>
        <div class="meal-v">
          <span class="sig ${v.cls}">${v.txt}</span>
          <span class="muted-small">${escapeHtml(r.lateLabel)}: ${fmtV(r.lateMean)}
          vs ${escapeHtml(r.earlyLabel)}: ${fmtV(r.earlyMean)}
          ${isFinite(r.pct) && Math.abs(r.pct) >= 1 ? `(${r.pct >= 0 ? '+' : ''}${Math.round(r.pct)}% ${dir})` : ''}</span>
          <span class="muted-small">${pTxt}${qTxt}</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="meal-card"><h4>Does a later <em>${escapeHtml(pred.toLowerCase())}</em> change…</h4>${body}</div>`;
  }).join('');

  return `<div class="stats-section">
    <h3>Meal timing</h3>
    <p class="muted-small">Compares your latest third of days against your earliest
    third for each meal time.</p>
    ${cards}
  </div>`;
}

function renderExplorer(res) {
  const N = WDINSIGHTS;
  const outcomeKey = res.outcomes.find((o) => o.key === state.insightOutcome)
    ? state.insightOutcome
    : (res.outcomes[0]?.key || 'goCount');
  state.insightOutcome = outcomeKey;
  const rows = res.tests
    .filter((t) => t.outcomeKey === outcomeKey && t.lag === state.insightLag)
    .sort((a, b) => a.p - b.p)
    .slice(0, 15);
  if (!rows.length) {
    return `<p class="muted-small">No predictor had enough overlapping days
      (need ${20}+) for this combination.</p>`;
  }
  const body = rows.map((t) => {
    const sig = N.significanceLabel(t);
    const cls = sig.level === 'strong' ? 'sig-strong' : sig.level === 'weak' ? 'sig-weak' : 'sig-none';
    let effect;
    if (!t.groupMode) {
      effect = `r=${N.fmtNum(t.r, 2)}`;
    } else {
      const delta = t.meanA - t.meanB;
      const sign = delta > 0 ? '+' : '';
      // When the *predictor* is what differs between groups, show its unit.
      const unit = t.groupMode === 'outcome'
        ? (t.predictorType === 'time' ? ' min' : t.predictorType === 'hours' ? 'h' : '')
        : (t.outcomeUnit === ' min' ? ' min' : '');
      effect = `${sign}${N.fmtNum(delta, 1)}${unit}`;
    }
    return `<tr class="${cls}">
      <td>${escapeHtml(t.predictorLabel)}</td>
      <td class="num">${escapeHtml(effect)}</td>
      <td class="num">${t.n}</td>
      <td class="num">${t.p < 0.0001 ? '&lt;0.0001' : N.fmtNum(t.p, 4)}</td>
      <td class="num">${!isFinite(t.q) ? '—' : t.q < 0.001 ? '&lt;0.001' : N.fmtNum(t.q, 3)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="ins-table">
    <thead><tr><th>Predictor</th><th class="num">Effect</th><th class="num">n</th>
    <th class="num">p</th><th class="num">q</th></tr></thead>
    <tbody>${body}</tbody></table></div>
    <p class="muted-small">Rows are green when they survive FDR correction (q&lt;0.05),
    amber when suggestive (q&lt;0.15). “Effect” is r for numeric predictors, or the
    difference in means for yes/no predictors.</p>`;
}

function drawInsightsTrend(table) {
  const canvas = $('#chartInsTrend');
  if (!canvas) return;
  const days = table.days.slice(-120);
  if (days.length < 5) return;
  const labels = days.map((r) => `${r.date.getMonth() + 1}/${r.date.getDate()}`);
  const counts = days.map((r) => r.goCount);
  const roll = WDINSIGHTS.rolling(counts, 7);
  const baseline = WDINSIGHTS.median(
    table.days.slice(-97, -7).map((r) => r.goCount)
  );
  state.charts.insTrend = new Chart(canvas, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'trips', data: counts, backgroundColor: '#cfd8dc', order: 3 },
        { type: 'line', label: '7-day avg', data: roll, borderColor: '#8a5a2b',
          borderWidth: 2, pointRadius: 0, tension: 0.3, order: 1 },
        ...(isFinite(baseline) ? [{
          type: 'line', label: 'baseline', data: labels.map(() => baseline),
          borderColor: '#76c98b', borderWidth: 1, borderDash: [5, 4],
          pointRadius: 0, order: 2,
        }] : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 9 } } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

/* ---- role setup ---- */

function openRolesSetup() {
  const roleOpts = (cur) =>
    ['<option value="">— none —</option>']
      .concat(WDINSIGHTS.ROLES.map((r) =>
        `<option value="${r.key}" ${cur === r.key ? 'selected' : ''}>${r.icon} ${escapeHtml(r.label)}</option>`))
      .join('');
  const topics = state.topics.filter((t) => !t.archived);
  const rows = topics.map((t) => `
    <div class="role-row">
      <div class="role-name">${escapeHtml(topicEmoji(t))} ${escapeHtml(t.name)}</div>
      <select data-role-topic="${t.id}">${roleOpts(state.topicRoles[t.id] || '')}</select>
    </div>`).join('');
  const s = insightsSettings();
  const hourOpts = [0, 1, 2, 3, 4, 5, 6].map((h) =>
    `<option value="${h}" ${s.cutoffHour === h ? 'selected' : ''}>${h}:00</option>`).join('');

  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Insights setup</div></header>
    <div class="body">
      <p class="muted-small">Tell the app what each topic means so it can test the
      right things. Only <strong>Bathroom trip</strong> is required.</p>
      ${rows}
      <div class="role-row" style="margin-top:14px;">
        <div class="role-name">Day starts at<br>
          <span class="muted-small">A 2am trip counts toward the night before.</span></div>
        <select id="insCutoff">${hourOpts}</select>
      </div>
    </div>
    <div class="actions">
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn" id="saveRoles">Save</button>
    </div>
  `);
  $('#saveRoles').addEventListener('click', async () => {
    const map = {};
    $$('[data-role-topic]').forEach((sel) => {
      if (sel.value) map[Number(sel.dataset.roleTopic)] = sel.value;
    });
    await WDDB.setTopicRoles(map);
    state.topicRoles = map;
    const cutoffHour = Number($('#insCutoff').value);
    state.insightSettings = await WDDB.setInsightSettings({ cutoffHour });
    state.insightsDirty = true;
    closeModal();
    snack('Insights settings saved');
    setView('insights');
  });
}

/* ---- alerts ---- */

function openAlertsDialog() {
  const s = insightsSettings();
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Flare-up alerts</div></header>
    <div class="body">
      <p>Get a notification when your recent week looks worse than your own
      baseline — more trips, more time, or blood / accidents above your normal rate.</p>
      <label class="row-toggle">
        <input type="checkbox" id="alertsOn" ${s.alertsEnabled ? 'checked' : ''} />
        <span>Enable flare-up alerts</span>
      </label>
      <label class="row-toggle">
        <span>Alert me when status is</span>
        <select id="alertOn">
          <option value="flare" ${s.alertOn === 'flare' ? 'selected' : ''}>flare only</option>
          <option value="watch" ${s.alertOn === 'watch' ? 'selected' : ''}>watch or worse</option>
        </select>
      </label>
      <p class="muted-small">Notification permission: <strong>${perm}</strong>.
      The check runs whenever you open the app (at most once every
      ${s.alertCooldownHours || 20} hours). A web app can’t reliably wake itself in
      the background, so this is a when-you-open-it nudge, not a background monitor.</p>
      ${s.lastAlertAt ? `<p class="muted-small">Last alert: ${fmtDateLong(s.lastAlertAt)} ${fmtTime(s.lastAlertAt)}</p>` : ''}
    </div>
    <div class="actions">
      <button class="btn secondary" id="alertTest">Test now</button>
      <button class="btn" id="alertSave">Save</button>
    </div>
  `);
  $('#alertSave').addEventListener('click', async () => {
    const enabled = $('#alertsOn').checked;
    if (enabled && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    state.insightSettings = await WDDB.setInsightSettings({
      alertsEnabled: enabled,
      alertOn: $('#alertOn').value,
    });
    closeModal();
    snack(enabled ? 'Flare alerts on' : 'Flare alerts off');
    if (state.view === 'insights') renderInsights();
  });
  $('#alertTest').addEventListener('click', async () => {
    const res = computeInsights(true);
    await showFlareNotification(res.status, true);
    snack(`Current status: ${res.status.level}`);
  });
}

async function showFlareNotification(status, isTest = false) {
  const meta = STATUS_META[status.level] || STATUS_META.unknown;
  const body = status.reasons.slice(0, 3).join('\n');
  const title = isTest ? `WhenDidI: ${meta.title}` : meta.title;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) {
        await reg.showNotification(title, { body, tag: 'whendidi-flare', icon: 'icons/icon-192.png' });
      } else {
        new Notification(title, { body, tag: 'whendidi-flare' });
      }
      return true;
    }
  } catch (e) { console.warn('notification failed', e); }
  if (isTest) snack('Notifications not permitted — showing in-app only');
  return false;
}

/* Runs at startup: if the current window looks bad and we haven't nagged
 * recently, fire a notification + in-app snackbar. */
async function checkFlareAlert() {
  const s = insightsSettings();
  if (!s.alertsEnabled) return;
  if (!hasBathroomRole()) return;
  const cooldown = (s.alertCooldownHours || 20) * 3600000;
  if (s.lastAlertAt && Date.now() - s.lastAlertAt < cooldown) return;
  let res;
  try { res = computeInsights(true); } catch (e) { console.warn(e); return; }
  const level = res.status.level;
  const trigger = s.alertOn === 'watch'
    ? (level === 'watch' || level === 'flare')
    : level === 'flare';
  if (!trigger) return;
  await showFlareNotification(res.status);
  snack(`${STATUS_META[level].icon} ${STATUS_META[level].title} — see Insights`);
  state.insightSettings = await WDDB.setInsightSettings({
    lastAlertAt: Date.now(), lastAlertLevel: level,
  });
}

/* ======== ADD / EDIT EVENT MODAL ======== */

async function logNow(topic) {
  const now = Date.now();
  const id = await WDDB.nextId('events');
  const m = state.measurements.find((m) => m.id === topic.msureid);
  const defaultQant = (m && m.type === 3) ? 60 : 0;
  const ev = { id, cost: 0, qant: defaultQant, time: now, topicid: topic.id, note: '' };
  await WDDB.put('events', ev);
  state.events.push(ev);
  snack(`Logged ${topic.name}`, {
    undo: async () => {
      await WDDB.delete('events', id);
      state.events = state.events.filter((e) => e.id !== id);
      snack('Undone');
      queueAutoSync('undoLog');
      renderCurrent();
    },
  });
  queueAutoSync('logNow');
  if (state.view === 'categories') renderCategories();
  if (state.view === 'recent') renderRecent();
  if (state.view === 'day') renderDay();
}

function openAddEvent(topic, existing = null) {
  const kind = topicKind(topic);
  const m = state.measurements.find((mm) => mm.id === topic.msureid);
  const isDuration = kind === 'duration';
  const isAmount = kind === 'amount';
  const isTimeOnly = kind === 'timeonly';
  const initTime = existing ? existing.time : Date.now();
  const initQantSec = existing ? Number(existing.qant || 0) : (isDuration ? 60 : 0);
  const initQantUnit = existing ? Number(existing.qant || 0) : 0;
  const initSeverity = existing ? Number(existing.cost || 0) : 0;

  const qantHhmm = (() => {
    if (!isDuration) return '';
    const s = initQantSec;
    const h = Math.floor(s / 3600);
    const mn = Math.floor((s % 3600) / 60);
    return `${pad(h)}:${pad(mn)}`;
  })();

  let qantField = '';
  if (isDuration) {
    qantField = `
      <div class="field">
        <label>Duration (hh:mm)</label>
        <input id="qHhmm" type="text" inputmode="numeric" pattern="[0-9:]*" value="${qantHhmm}" placeholder="00:00">
      </div>`;
  } else if (isAmount) {
    qantField = `
      <div class="field">
        <label>Amount${m?.symbol ? ` (${m.symbol})` : ''}</label>
        <input id="qNum" type="number" step="any" value="${initQantUnit}">
      </div>`;
  }

  // Build a sorted list of tag suggestions from existing notes
  const tagSuggest = WDSTATS.allTagsFromEvents(state.events).slice(0, 12);
  const tagChipsHtml = tagSuggest.length ? `
    <div class="tag-suggest">
      ${tagSuggest.map((t) => `<button type="button" class="tag-suggest-chip" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)}</button>`).join('')}
    </div>` : '';

  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">${existing ? 'Edit Event' : 'Add Event'}</div>
      <button class="icon-btn" id="dialogSave" title="Save">✓</button>
    </header>
    <div class="body">
      <div class="topic-name">${topicEmoji(topic) ? topicEmoji(topic) + ' ' : ''}${escapeHtml(topic.name)}</div>
      ${qantField}
      <div class="row-2">
        <div class="field">
          <label>Date</label>
          <input id="evDate" type="date" value="${fmtDateInput(initTime)}">
        </div>
        <div class="field">
          <label>Time</label>
          <input id="evTime" type="time" value="${fmtTimeInput(initTime)}">
        </div>
      </div>
      <div class="time-chips">
        <button type="button" class="t-chip" data-mins="0">Now</button>
        <button type="button" class="t-chip" data-mins="5">5m ago</button>
        <button type="button" class="t-chip" data-mins="15">15m ago</button>
        <button type="button" class="t-chip" data-mins="30">30m ago</button>
        <button type="button" class="t-chip" data-mins="60">1h ago</button>
        <button type="button" class="t-chip" data-mins="120">2h ago</button>
        <button type="button" class="t-chip" data-mins="1440">Yesterday now</button>
      </div>
      <div class="field">
        <label>Severity (optional, 0–5)</label>
        <div class="sev-row">
          <input id="evSev" type="range" min="0" max="5" step="1" value="${initSeverity}">
          <span class="sev-val" id="sevVal">${initSeverity ? initSeverity : '—'}</span>
        </div>
      </div>
      <div class="field">
        <label>Note <span class="hint">(use #tags to categorize, e.g. #stressful #traveling)</span></label>
        <textarea id="evNote" placeholder="(optional)">${existing ? escapeHtml(existing.note || '') : ''}</textarea>
        ${tagChipsHtml}
      </div>
      ${existing ? `<button class="btn danger" id="dialogDelete" style="margin-top:8px;">Delete event</button>` : ''}
    </div>
  `);

  // Severity slider live update
  const sevInput = $('#evSev');
  const sevVal = $('#sevVal');
  if (sevInput) sevInput.addEventListener('input', () => {
    sevVal.textContent = sevInput.value === '0' ? '—' : sevInput.value;
  });

  // Time chips
  $$('.t-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mins = Number(btn.dataset.mins);
      const t = Date.now() - mins * 60 * 1000;
      $('#evDate').value = fmtDateInput(t);
      $('#evTime').value = fmtTimeInput(t);
    });
  });

  // Tag suggestion chips: append to note
  $$('.tag-suggest-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      const ta = $('#evNote');
      const current = ta.value.trim();
      // toggle: if already contains the tag, remove it
      const re = new RegExp(`(^|\\s)#${tag}(\\b)`, 'i');
      if (re.test(current)) {
        ta.value = current.replace(re, '$1$2').replace(/\s+/g, ' ').trim();
        btn.classList.remove('active');
      } else {
        ta.value = (current ? current + ' ' : '') + '#' + tag;
        btn.classList.add('active');
      }
    });
    // initialize active state
    const ta = $('#evNote');
    const re = new RegExp(`(^|\\s)#${btn.dataset.tag}(\\b)`, 'i');
    if (re.test(ta.value)) btn.classList.add('active');
  });

  $('#dialogSave').addEventListener('click', async () => {
    const dateStr = $('#evDate').value;
    const timeStr = $('#evTime').value;
    if (!dateStr || !timeStr) { snack('Date and time are required'); return; }
    let qant = 0;
    if (isDuration) {
      const raw = ($('#qHhmm').value || '0:0').trim();
      const [h, mn] = raw.split(':').map((x) => Number(x || 0));
      if (Number.isNaN(h) || Number.isNaN(mn)) { snack('Bad duration'); return; }
      qant = h * 3600 + mn * 60;
      if (qant === 0) qant = 60;
    } else if (isAmount) {
      const raw = Number($('#qNum').value || 0);
      if (Number.isNaN(raw)) { snack('Bad amount'); return; }
      qant = raw;
    } else {
      qant = existing ? Number(existing.qant || 60) : 60;
    }
    const time = parseDateTimeInput(dateStr, timeStr);
    const note = $('#evNote').value.trim();
    const severity = Number($('#evSev').value || 0);

    if (existing) {
      const prev = { ...existing };
      const updated = { ...existing, qant, cost: severity, time, note };
      await WDDB.put('events', updated);
      const idx = state.events.findIndex((e) => e.id === existing.id);
      if (idx >= 0) state.events[idx] = updated;
      closeModal();
      snack('Event updated', {
        undo: async () => {
          await WDDB.put('events', prev);
          const j = state.events.findIndex((e) => e.id === prev.id);
          if (j >= 0) state.events[j] = prev;
          queueAutoSync('undoEdit');
          renderCurrent();
          snack('Undone');
        },
      });
    } else {
      const id = await WDDB.nextId('events');
      const ev = { id, cost: severity, qant, time, topicid: topic.id, note };
      await WDDB.put('events', ev);
      state.events.push(ev);
      closeModal();
      snack(`Logged ${topic.name}`, {
        undo: async () => {
          await WDDB.delete('events', id);
          state.events = state.events.filter((e) => e.id !== id);
          queueAutoSync('undoLog');
          renderCurrent();
          snack('Undone');
        },
      });
    }
    queueAutoSync('saveEvent');
    renderCurrent();
  });

  if (existing) {
    $('#dialogDelete').addEventListener('click', () => {
      openConfirm('Delete this event?', 'This cannot be undone via the snackbar — only via re-add.', async () => {
        const removed = { ...existing };
        await WDDB.delete('events', existing.id);
        state.events = state.events.filter((e) => e.id !== existing.id);
        closeModal();
        snack('Event deleted', {
          undo: async () => {
            await WDDB.put('events', removed);
            state.events.push(removed);
            queueAutoSync('undoDelete');
            renderCurrent();
            snack('Undone');
          },
        });
        queueAutoSync('deleteEvent');
        renderCurrent();
      });
    });
  }
}

/* ======== TOPIC EDIT ======== */

const AMOUNT_UNITS = [
  // ordered for the picker, friendly names
  { id: 101, label: 'Ounces (oz)' },
  { id: 102, label: 'Pounds (lb)' },
  { id: 4,   label: 'Kilograms (kg)' },
  { id: 103, label: 'Grams (g)' },
  { id: 1,   label: 'Litres (l)' },
  { id: 2,   label: 'Gallons (gal)' },
  { id: 3,   label: 'Miles (mi)' },
  { id: 5,   label: 'Kilometres (km)' },
  { id: 6,   label: 'Metres (m)' },
  { id: 100, label: 'Count (no unit)' },
];

function openTopicEdit(existing) {
  const existingKind = existing ? topicKind(existing) : 'timeonly';
  const initialUnit = existing && existingKind === 'amount'
    ? existing.msureid
    : 101;
  const meta = existing ? topicMeta(existing) : {};
  const initEmoji = meta.emoji || '';
  const initColor = meta.color || DEFAULT_TOPIC_COLOR;

  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">${existing ? 'Edit Topic' : 'New Topic'}</div>
      <button class="icon-btn" id="topicSave" title="Save">✓</button>
    </header>
    <div class="body">
      <div class="field">
        <label>Name</label>
        <input id="topicName" type="text" value="${existing ? escapeHtml(existing.name) : ''}" placeholder="e.g. poop start" autocomplete="off">
      </div>
      <div class="field">
        <label>Description (optional)</label>
        <input id="topicDesc" type="text" value="${existing ? escapeHtml(existing.desc || '') : ''}" autocomplete="off">
      </div>
      <div class="row-2">
        <div class="field">
          <label>Emoji (optional)</label>
          <input id="topicEmoji" type="text" maxlength="4" value="${escapeHtml(initEmoji)}" placeholder="💧 🥖 💤 …" autocomplete="off">
        </div>
        <div class="field">
          <label>Color</label>
          <div class="color-swatches" id="colorSwatches">
            ${COLOR_SWATCHES.map((c) => `<button type="button" class="swatch ${c===initColor?'on':''}" style="background:${c}" data-color="${c}" aria-label="Color ${c}"></button>`).join('')}
          </div>
        </div>
      </div>
      <div class="field">
        <label>Topic type</label>
        <div class="kind-picker" id="kindPicker">
          <label class="kind-opt"><input type="radio" name="kind" value="timeonly" ${existingKind==='timeonly'?'checked':''}> <strong>Time only</strong><br><span>Just record when it happened (e.g. "poop start", "first meal", "saw blood").</span></label>
          <label class="kind-opt"><input type="radio" name="kind" value="duration" ${existingKind==='duration'?'checked':''}> <strong>Duration</strong><br><span>Record how long something lasted in hh:mm (e.g. "workout", "nap").</span></label>
          <label class="kind-opt"><input type="radio" name="kind" value="amount"   ${existingKind==='amount'?'checked':''}> <strong>Amount</strong><br><span>Record a quantity with a unit (e.g. "water 12 oz", "weight 175 lb").</span></label>
        </div>
      </div>
      <div class="field" id="unitField" style="display:${existingKind==='amount'?'block':'none'};">
        <label>Unit</label>
        <select id="topicUnit">
          ${AMOUNT_UNITS.map((u) => `<option value="${u.id}" ${u.id===initialUnit?'selected':''}>${escapeHtml(u.label)}</option>`).join('')}
        </select>
      </div>
      ${existing ? `
        <div class="field">
          <label>
            <input type="checkbox" id="topicArchived" ${existing.archived?'checked':''}> Archived (hides from Categories without deleting events)
          </label>
        </div>
        <hr style="border:0;border-top:1px solid var(--rule);margin:24px 0 16px;">
        <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">Danger zone</p>
        <button class="btn danger" id="topicDelete" style="width:100%;">Delete topic and all its events</button>
      ` : ''}
    </div>
  `);

  let selectedColor = initColor;
  $$('#colorSwatches .swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      selectedColor = sw.dataset.color;
      $$('#colorSwatches .swatch').forEach((s) => s.classList.remove('on'));
      sw.classList.add('on');
    });
  });

  $$('input[name="kind"]', $('#modalRoot')).forEach((r) => {
    r.addEventListener('change', () => {
      const k = r.value;
      $('#unitField').style.display = (k === 'amount') ? 'block' : 'none';
    });
  });

  $('#topicSave').addEventListener('click', async () => {
    const name = $('#topicName').value.trim();
    if (!name) { snack('Name required'); return; }
    const desc = $('#topicDesc').value.trim();
    const emoji = $('#topicEmoji').value.trim();
    const kindEl = document.querySelector('input[name="kind"]:checked');
    const kind = kindEl ? kindEl.value : 'timeonly';
    let msureid;
    if (kind === 'amount') {
      msureid = Number($('#topicUnit').value);
    } else if (kind === 'duration') {
      msureid = (existing && [10,11,12].includes(existing.msureid)) ? existing.msureid : 10;
    } else {
      msureid = (existing && [10,11,12].includes(existing.msureid)) ? existing.msureid : 10;
    }

    let savedTopicId;
    if (existing) {
      const updated = {
        ...existing,
        name, desc, msureid,
        archived: $('#topicArchived')?.checked || false,
      };
      await WDDB.put('topics', updated);
      await WDDB.setTopicKind(existing.id, kind);
      savedTopicId = existing.id;
    } else {
      const id = await WDDB.nextId('topics');
      const t = { id, name, desc, msureid, optype: 1, type: 1, archived: false };
      await WDDB.put('topics', t);
      const order = (await WDDB.getMeta('topicOrder')) || [];
      order.push(id);
      await WDDB.setMeta('topicOrder', order);
      await WDDB.setTopicKind(id, kind);
      savedTopicId = id;
    }
    await WDDB.setTopicMeta(savedTopicId, { emoji, color: selectedColor });
    closeModal();
    await reload();
    snack('Saved');
    queueAutoSync('saveTopic');
    renderCurrent();
  });

  if (existing) {
    $('#topicDelete').addEventListener('click', () => {
      const evCount = state.events.filter((e) => e.topicid === existing.id).length;
      openConfirm(
        `Delete "${existing.name}"?`,
        `This will permanently delete the topic AND all ${evCount.toLocaleString()} of its event${evCount === 1 ? '' : 's'}. This cannot be undone. Consider Archive instead if you just want to hide it.`,
        async () => {
          const evs = state.events.filter((e) => e.topicid === existing.id);
          for (const e of evs) await WDDB.delete('events', e.id);
          await WDDB.delete('topics', existing.id);
          await WDDB.setTopicKind(existing.id, null);
          await WDDB.setTopicMeta(existing.id, null);
          await WDDB.setFavorite(existing.id, false);
          const order = (await WDDB.getMeta('topicOrder')) || [];
          await WDDB.setMeta('topicOrder', order.filter((x) => x !== existing.id));
          closeModal();
          await reload();
          snack(`Deleted "${existing.name}" and ${evCount.toLocaleString()} event${evCount === 1 ? '' : 's'}`);
          queueAutoSync('deleteTopic');
          renderCurrent();
        },
        'Delete forever'
      );
    });
  }
}

function openTopicsManager() {
  const buildRow = (t, i, total) => {
    const count = state.events.filter((e) => e.topicid === t.id).length;
    const kind = topicKind(t);
    const m = state.measurements.find((mm) => mm.id === t.msureid);
    const subline = kind === 'amount'
      ? `${count.toLocaleString()} events · Amount (${m?.symbol || m?.name || '?'})`
      : kind === 'duration'
      ? `${count.toLocaleString()} events · Duration`
      : `${count.toLocaleString()} events · Time only`;
    return `
      <div class="topic-row ${t.archived?'archived':''}" data-topic="${t.id}">
        <div class="mgr-arrows">
          <button class="arrow-btn" data-up="${t.id}" ${i===0?'disabled':''} aria-label="Move up">▲</button>
          <button class="arrow-btn" data-down="${t.id}" ${i===total-1?'disabled':''} aria-label="Move down">▼</button>
        </div>
        <div>
          <div class="t-name">${escapeHtml(t.name)}</div>
          <div class="t-sub">${subline}</div>
        </div>
        <button class="btn secondary" data-edit="${t.id}">Edit</button>
      </div>
    `;
  };
  const topics = state.topics;
  const html = topics.map((t, i) => buildRow(t, i, topics.length)).join('');
  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">Manage Topics</div>
      <button class="icon-btn" id="newTopic" title="New topic">＋</button>
    </header>
    <div class="body" style="padding:0;">
      <div class="mgr-hint">▲▼ to reorder · Edit to rename or change type</div>
      ${html || '<div class="empty">No topics yet.</div>'}
    </div>
  `);
  const wire = () => {
    $('#newTopic').addEventListener('click', () => { closeModal(); openTopicEdit(null); });
    $$('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
      const id = Number(e.currentTarget.dataset.edit);
      const t = state.topics.find((x) => x.id === id);
      closeModal();
      openTopicEdit(t);
    }));
    $$('[data-up]').forEach((b) => b.addEventListener('click', async (e) => {
      const id = Number(e.currentTarget.dataset.up);
      await moveTopic(id, -1);
      openTopicsManager(); // re-render
    }));
    $$('[data-down]').forEach((b) => b.addEventListener('click', async (e) => {
      const id = Number(e.currentTarget.dataset.down);
      await moveTopic(id, +1);
      openTopicsManager();
    }));
  };
  wire();
}

async function moveTopic(id, delta) {
  const order = state.topicOrder.slice();
  const i = order.indexOf(id);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  await saveTopicOrder(order);
  renderCurrent();
}

/* ======== QUICK-ACCESS BAR MANAGER ======== */

async function saveQuickBar(ids) {
  state.quickBar = ids.slice();
  await WDDB.setQuickBar(state.quickBar);
  queueAutoSync();
  renderCurrent();
}

function openQuickBarManager() {
  const byId = new Map(state.topics.map((t) => [t.id, t]));
  const pinnedIds = (state.quickBar || []).filter((id) => {
    const t = byId.get(id);
    return t && !t.archived;
  });
  const pinnedSet = new Set(pinnedIds);
  const available = state.topics.filter((t) => !t.archived && !pinnedSet.has(t.id));

  const chipLabel = (t) => {
    const emoji = topicEmoji(t);
    return `${emoji ? `<span class="qc-emoji">${escapeHtml(emoji)}</span>` : ''}<span class="t-name">${escapeHtml(t.name)}</span>`;
  };

  const pinnedRows = pinnedIds.map((id, i) => {
    const t = byId.get(id);
    return `
      <div class="topic-row" data-topic="${id}" style="--accent:${topicColor(t)}">
        <div class="mgr-arrows">
          <button class="arrow-btn" data-qup="${id}" ${i===0?'disabled':''} aria-label="Move up">▲</button>
          <button class="arrow-btn" data-qdown="${id}" ${i===pinnedIds.length-1?'disabled':''} aria-label="Move down">▼</button>
        </div>
        <div>${chipLabel(t)}</div>
        <button class="btn secondary" data-qremove="${id}">Remove</button>
      </div>`;
  }).join('');

  const availableRows = available.map((t) => `
      <div class="topic-row" data-topic="${t.id}" style="--accent:${topicColor(t)}">
        <div></div>
        <div>${chipLabel(t)}</div>
        <button class="btn secondary" data-qadd="${t.id}">＋ Add</button>
      </div>`).join('');

  const pinnedSection = pinnedIds.length
    ? pinnedRows
    : `<div class="mgr-hint">No quick-access topics pinned yet. The bar currently shows your most frequent recent topics automatically. Add topics below to pin a fixed set in a fixed order.</div>`;

  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">Quick-access bar</div>
    </header>
    <div class="body" style="padding:0;">
      <div class="mgr-hint">These chips appear pinned at the top of Categories for one-tap logging. ▲▼ to reorder.</div>
      <div class="sticky-header">Pinned</div>
      ${pinnedSection}
      <div class="sticky-header">Available topics</div>
      ${availableRows || '<div class="mgr-hint">All topics are already pinned.</div>'}
    </div>
  `);

  const reopen = () => openQuickBarManager();
  $$('[data-qadd]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = Number(e.currentTarget.dataset.qadd);
    if (!pinnedSet.has(id)) await saveQuickBar([...pinnedIds, id]);
    reopen();
  }));
  $$('[data-qremove]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = Number(e.currentTarget.dataset.qremove);
    await saveQuickBar(pinnedIds.filter((x) => x !== id));
    reopen();
  }));
  $$('[data-qup]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = Number(e.currentTarget.dataset.qup);
    await saveQuickBar(swap(pinnedIds, id, -1));
    reopen();
  }));
  $$('[data-qdown]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = Number(e.currentTarget.dataset.qdown);
    await saveQuickBar(swap(pinnedIds, id, +1));
    reopen();
  }));
}

function swap(arr, id, delta) {
  const out = arr.slice();
  const i = out.indexOf(id);
  if (i < 0) return out;
  const j = i + delta;
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/* ======== IMPORT / EXPORT FLOW ======== */

function triggerImport() {
  const inp = $('#fileInput');
  inp.value = '';
  inp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const errs = WDIO.validateBackup(obj);
      if (errs.length) {
        openModal(`
          <header><button class="icon-btn" data-close>←</button><div class="title">Import errors</div></header>
          <div class="body">
            <p>The file doesn't look like a WhenDidI backup:</p>
            <ul>${errs.slice(0, 10).map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
            ${errs.length > 10 ? `<p>(+${errs.length-10} more)</p>` : ''}
          </div>
          <div class="actions"><button class="btn" data-close>OK</button></div>
        `);
        return;
      }
      const sum = WDIO.summarize(obj);
      const dateRange = sum.events
        ? `${sum.minTime ? fmtDateLong(sum.minTime) : '?'} → ${sum.maxTime ? fmtDateLong(sum.maxTime) : '?'}`
        : '(none)';
      openModal(`
        <header><button class="icon-btn" data-close>←</button><div class="title">Import preview</div></header>
        <div class="body">
          <p><strong>${file.name}</strong></p>
          <ul>
            <li>Version: ${escapeHtml(String(sum.version))}</li>
            <li>Topics: ${sum.topics.toLocaleString()}</li>
            <li>Events: ${sum.events.toLocaleString()}</li>
            <li>Date range: ${escapeHtml(dateRange)}</li>
            <li>Backup taken: ${escapeHtml(sum.saveddate)}</li>
          </ul>
          <p>Choose how to apply it:</p>
          <ul>
            <li><strong>Replace</strong> — wipe everything currently in this app and load the file as-is. A safety backup of your current data will be downloaded first.</li>
            <li><strong>Merge</strong> — add new topics/events from the file but keep what you already have. Duplicates skipped by event id.</li>
          </ul>
        </div>
        <div class="actions">
          <button class="btn secondary" data-close>Cancel</button>
          <button class="btn secondary" id="impMerge">Merge</button>
          <button class="btn" id="impReplace">Replace</button>
        </div>
      `);
      $('#impMerge').addEventListener('click', async () => {
        await WDIO.importMerge(obj);
        closeModal();
        await reload();
        snack(`Merged ${sum.events.toLocaleString()} events`);
        queueAutoSync('import');
        renderCurrent();
      });
      $('#impReplace').addEventListener('click', async () => {
        await WDIO.safetyBackup();
        await WDIO.importReplace(obj);
        closeModal();
        await reload();
        snack(`Loaded ${sum.events.toLocaleString()} events`);
        queueAutoSync('import');
        renderCurrent();
      });
    } catch (err) {
      snack('Import failed: ' + err.message);
    }
  };
  inp.click();
}

async function doExport() {
  await WDIO.exportToFile('whendidibk.json');
  snack('Exported whendidibk.json');
}

async function doExportCsv() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
  await WDIO.exportToCsv(`whendidi-events-${stamp}.csv`);
  snack('Exported CSV');
}

async function doSafetyBackup() {
  await WDIO.safetyBackup();
  snack('Safety backup downloaded');
}

/* ======== MENU ACTIONS ======== */

function openDrive() {
  WDDRIVE.openSetupDialog({ openModal, closeModal, snack, reload, renderCurrent });
}

function openAbout() {
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">About</div></header>
    <div class="body">
      <p><strong>WhenDidI</strong> (PWA replacement)</p>
      <p>An offline-first event tracker that mirrors the original WhenDidI Android app
      (SJM Apps, ~2012–2018), with byte-compatible <code>whendidibk.json</code> import/export.</p>
      <p>All data lives only on this device in IndexedDB. Use Export JSON or Google Drive sync
      to back it up.</p>
    </div>
    <div class="actions"><button class="btn" data-close>OK</button></div>
  `);
}

async function openStorageStatus() {
  let persisted = false;
  let quota = null;
  try {
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) quota = await navigator.storage.estimate();
  } catch (e) {}
  const lastImport = await WDDB.getMeta('lastImport');
  const lastExport = await WDDB.getMeta('lastExport');
  const lastDrive = await WDDB.getMeta('lastDriveSync');

  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Storage status</div></header>
    <div class="body">
      <p>Persistent storage: <strong>${persisted ? 'enabled' : 'not granted'}</strong></p>
      ${quota ? `<p>Used ${(quota.usage/1e6).toFixed(1)} MB of ${(quota.quota/1e6).toFixed(0)} MB quota</p>` : ''}
      <p>Topics: ${state.topics.length} · Events: ${state.events.length.toLocaleString()}</p>
      <p>Last import: ${lastImport ? fmtDateLong(lastImport) + ' ' + fmtTime(lastImport) : 'never'}</p>
      <p>Last export: ${lastExport ? fmtDateLong(lastExport) + ' ' + fmtTime(lastExport) : 'never'}</p>
      <p>Last Drive sync: ${lastDrive ? fmtDateLong(lastDrive) + ' ' + fmtTime(lastDrive) : 'never'}</p>
      ${!persisted ? `<p><button class="btn" id="persistBtn">Request persistent storage</button></p>` : ''}
    </div>
    <div class="actions"><button class="btn" data-close>Close</button></div>
  `);
  const pb = $('#persistBtn');
  if (pb) pb.addEventListener('click', async () => {
    if (navigator.storage?.persist) {
      const ok = await navigator.storage.persist();
      snack(ok ? 'Persistent storage granted' : 'Browser declined');
    }
  });
}

function openWipe() {
  openConfirm(
    'Wipe all local data?',
    `This deletes all ${state.events.length.toLocaleString()} events and ${state.topics.length} topics from this device. A safety backup will be downloaded first.`,
    async () => {
      await WDIO.safetyBackup();
      await WDDB.clearAll();
      await WDDB.seedDefaults();
      closeModal();
      await reload();
      // A wipe must overwrite Drive rather than merge, otherwise the next
      // sync would helpfully restore everything we just deleted.
      let msg = 'All data wiped';
      try {
        await window.WDDRIVE?.syncNow?.({ interactive: false, force: true });
      } catch (e) {
        if (e && e.message !== 'NO_CLIENT_ID') msg += ' (Drive copy unchanged)';
      }
      snack(msg);
      renderCurrent();
    },
    'Wipe everything'
  );
}

/* ======== ROUTING / TABS ======== */

function setView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  $$('.app-tabs .tab').forEach((t) => {
    t.setAttribute('aria-selected', t.dataset.view === view);
  });
  renderCurrent();
}

function renderCurrent() {
  if (state.view === 'categories') renderCategories();
  else if (state.view === 'recent') renderRecent();
  else if (state.view === 'day') renderDay();
  else if (state.view === 'stats') renderStats();
  else if (state.view === 'insights') renderInsights();
}

/* ======== MODAL / SNACKBAR / DRAWER ======== */

function openModal(html) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="scrim"><section class="dialog">${html}</section></div>`;
  root.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => closeModal());
  });
  root.querySelector('.scrim').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  pushOverlayState('modal');
}

function closeModal({ fromHistory = false } = {}) {
  $('#modalRoot').innerHTML = '';
  if (!fromHistory) popOverlayState('modal');
}

function openConfirm(title, body, onYes, yesLabel = 'Yes') {
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">${escapeHtml(title)}</div></header>
    <div class="body confirm"><p>${escapeHtml(body)}</p></div>
    <div class="actions">
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn danger" id="confirmYes">${escapeHtml(yesLabel)}</button>
    </div>
  `);
  $('#confirmYes').addEventListener('click', onYes);
}

let snackTimer = null;
let snackUndoCallback = null;
function snack(msg, opts = {}) {
  const sb = $('#snackbar');
  const onUndo = opts.undo || null;
  snackUndoCallback = onUndo;
  if (onUndo) {
    sb.innerHTML = `<span class="snack-msg">${escapeHtml(msg)}</span>
      <button class="snack-action" id="snackUndoBtn">UNDO</button>`;
    sb.querySelector('#snackUndoBtn').addEventListener('click', async () => {
      if (snackUndoCallback) {
        const cb = snackUndoCallback;
        snackUndoCallback = null;
        sb.classList.remove('show');
        try { await cb(); } catch (e) { console.error(e); }
      }
    });
  } else {
    sb.textContent = msg;
  }
  sb.classList.add('show');
  if (snackTimer) clearTimeout(snackTimer);
  const duration = onUndo ? 5000 : 2200;
  snackTimer = setTimeout(() => {
    sb.classList.remove('show');
    snackUndoCallback = null;
  }, duration);
}

/* ======== TOPIC META (emoji + color) ======== */
const DEFAULT_TOPIC_COLOR = '#8a5a2b';
const COLOR_SWATCHES = [
  '#8a5a2b', // brown (default)
  '#6fa8c4', // blue
  '#76c98b', // green
  '#e2a920', // gold
  '#b94343', // red
  '#9b59b6', // purple
  '#e67e22', // orange
  '#34495e', // slate
  '#16a085', // teal
  '#e91e63', // pink
];

function topicMeta(topic) {
  return state.topicMeta?.[topic?.id] || {};
}
function topicEmoji(topic) {
  return (topicMeta(topic).emoji || '').trim();
}
function topicColor(topic) {
  return topicMeta(topic).color || DEFAULT_TOPIC_COLOR;
}

/* ======== TAG / SEVERITY / NOTE RENDERING ======== */
function renderNoteWithTags(note) {
  if (!note) return '';
  const tags = WDSTATS.parseTags(note);
  if (!tags.length) return escapeHtml(note);
  let out = '';
  let cursor = 0;
  for (const t of tags) {
    out += escapeHtml(note.slice(cursor, t.start));
    out += `<span class="tag-chip">${escapeHtml(note.slice(t.start, t.end))}</span>`;
    cursor = t.end;
  }
  out += escapeHtml(note.slice(cursor));
  return out;
}
function severityBadge(ev) {
  const s = Number(ev?.cost || 0);
  if (!s || s < 1) return '';
  const cls = s >= 4 ? 'sev-hi' : s >= 2 ? 'sev-med' : 'sev-lo';
  return `<span class="sev-badge ${cls}" title="Severity ${s}/5">●${s}</span>`;
}

function openDrawer() {
  $('#drawer').classList.add('open');
  pushOverlayState('drawer');
}
function closeDrawer({ fromHistory = false } = {}) {
  $('#drawer').classList.remove('open');
  if (!fromHistory) popOverlayState('drawer');
}

/* ======== HISTORY-BACKED OVERLAY STACK ========
 * Pushes a state entry when any overlay (modal, drawer) opens so the
 * Android system back gesture closes the overlay instead of exiting
 * the PWA. The stack mirrors what's actually open in the DOM so we
 * don't pop too many history entries.
 *
 * _expectingPop tracks history.back() calls we initiated ourselves
 * (e.g., closing a drawer then immediately opening a modal). When the
 * resulting popstate arrives we decrement and ignore it, so we never
 * mistakenly close the new overlay.
 */
const _overlayStack = [];
let _expectingPop = 0;

function pushOverlayState(kind) {
  _overlayStack.push(kind);
  try {
    history.pushState({ wd_overlay: kind, n: _overlayStack.length }, '');
  } catch (_) { /* private mode etc. */ }
}

function popOverlayState(kind) {
  // Only pop history if the topmost entry matches this overlay.
  const top = _overlayStack[_overlayStack.length - 1];
  if (top !== kind) return;
  _overlayStack.pop();
  if (history.state?.wd_overlay) {
    _expectingPop++;
    try { history.back(); } catch (_) { _expectingPop--; }
  }
}

function handlePopState() {
  if (_expectingPop > 0) {
    _expectingPop--;
    return; // self-initiated, ignore
  }
  // User-initiated back gesture: close whatever overlay is on top.
  const top = _overlayStack.pop();
  if (top === 'modal') {
    closeModal({ fromHistory: true });
  } else if (top === 'drawer') {
    closeDrawer({ fromHistory: true });
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ======== AUTO-SYNC (calls into drive.js if configured) ======== */
function queueAutoSync(reason = 'change') {
  state.insightsDirty = true;   // data changed -> recompute insights lazily
  if (window.WDDRIVE?.queueAutoSync) {
    window.WDDRIVE.queueAutoSync(reason);
  }
}

/* ======== ADD BUTTON (header / FAB) — pick topic first ======== */

function openTopicPicker() {
  if (!state.topics.length) {
    openConfirm('No topics yet', 'Create a topic first or import existing data.', () => {
      closeModal();
      openTopicEdit(null);
    }, 'Create topic');
    return;
  }
  const topics = state.topics.filter((t) => !t.archived);
  const rows = topics.map((t) => `
    <div class="topic-row" data-topic="${t.id}" style="cursor:pointer;">
      <div><div class="t-name">${escapeHtml(t.name)}</div></div>
      <div></div>
      <div></div>
    </div>
  `).join('');
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Pick topic</div></header>
    <div class="body" style="padding:0;">${rows}</div>
  `);
  $$('[data-topic]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.topic);
      const t = state.topics.find((x) => x.id === id);
      closeModal();
      openAddEvent(t);
    });
  });
}

/* ======== INIT ======== */

async function init() {
  try {
    await WDDB.seedDefaults();
  } catch (e) { console.error(e); }

  // request persistent storage early
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  await reload();

  // Tab clicks
  $$('.app-tabs .tab').forEach((tb) => {
    tb.addEventListener('click', () => setView(tb.dataset.view));
  });

  // Header buttons
  $('#menuBtn').addEventListener('click', openDrawer);
  $('#exportBtn').addEventListener('click', doExport);
  $('#addBtn').addEventListener('click', openTopicPicker);
  $('#fab').addEventListener('click', openTopicPicker);
  $('#syncPill').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!window.WDDRIVE) return;
    try {
      const res = await window.WDDRIVE.syncNow({ interactive: true });
      if (res?.action === 'merged' && res.changedLocally) {
        await reload(); renderCurrent();
        snack(`Merged with Drive: ${res.stats?.fromRemote || 0} pulled in`);
      } else {
        snack('Synced');
      }
    } catch (err) {
      snack('Sync failed: ' + err.message);
    }
  });

  // Drawer
  $('#drawer').querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => closeDrawer()));
  $('#navImport').addEventListener('click', () => { closeDrawer(); triggerImport(); });
  $('#navExport').addEventListener('click', () => { closeDrawer(); doExport(); });
  $('#navExportCsv').addEventListener('click', () => { closeDrawer(); doExportCsv(); });
  $('#navBackup').addEventListener('click', () => { closeDrawer(); doSafetyBackup(); });
  $('#navTopics').addEventListener('click', () => { closeDrawer(); openTopicsManager(); });
  $('#navQuickBar').addEventListener('click', () => { closeDrawer(); openQuickBarManager(); });
  $('#navRoles').addEventListener('click', () => { closeDrawer(); openRolesSetup(); });
  $('#navAlerts').addEventListener('click', () => { closeDrawer(); openAlertsDialog(); });
  $('#navDrive').addEventListener('click', () => { closeDrawer(); openDrive(); });
  $('#navAbout').addEventListener('click', () => { closeDrawer(); openAbout(); });
  $('#navStorage').addEventListener('click', () => { closeDrawer(); openStorageStatus(); });
  $('#navWipe').addEventListener('click', () => { closeDrawer(); openWipe(); });
  const drawerVersionEl = $('#drawerVersion');
  if (drawerVersionEl) drawerVersionEl.textContent = window.WD_VERSION || '';

  // Back-gesture handler: close overlays instead of exiting the PWA
  window.addEventListener('popstate', handlePopState);

  // Listen for service worker update prompts
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // a new SW took over; nothing to do
    });
  }

  setView('categories');

  // Attempt a silent startup sync if Drive is configured.
  if (window.WDDRIVE?.startupSync) {
    try { await window.WDDRIVE.startupSync(); } catch (_) {}
  }

  // Flare-up check (opt-in, throttled).
  try { await checkFlareAlert(); } catch (e) { console.warn(e); }
}

window.addEventListener('DOMContentLoaded', init);
// Exposed for inline onclick in empty states + drive.js callbacks
window.openTopicEdit = openTopicEdit;
window.WDAPP = {
  reload,
  renderCurrent,
  snack,
  openModal,
  closeModal,
  $, $$,
  fmtDateLong, fmtTime,
};
