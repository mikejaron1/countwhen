/* Real browser regressions with synthetic data and no external requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };

(async () => {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(ROOT, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    try { browser = await chromium.launch(); }
    catch (error) {
      if (!/Executable doesn't exist/.test(error.message)) throw error;
      browser = await chromium.launch({ channel: 'chrome' });
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 },
      serviceWorkers: 'block', timezoneId: 'America/Los_Angeles', isMobile: true, hasTouch: true });
    await context.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/app/`);
    await page.locator('[data-preset="habits"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#main .card').length === 5);
    await page.evaluate(() => CWMODEL.whenIdle());
    assert.equal(await page.locator('#modalRoot .dialog').count(), 0);
    assert.equal(await page.locator('.backup-health, #backupHealthAction').count(), 0);
    await page.evaluate(() => setStatus('', '☁ syncing…'));
    assert.equal(await page.locator('#syncActivity').textContent(), 'Syncing now');
    assert.equal(await page.locator('#syncPill').textContent(), '☁ Sync');
    assert.equal(await page.locator('#syncActivity').evaluate((element) =>
      element.previousElementSibling.id), 'syncPill');

    // Quick amounts are real quantities, and Undo accepts pointer input.
    const waterId = await page.evaluate(() => state.topics.find((topic) => topic.name === 'Water').id);
    await page.evaluate((id) => CWMODEL.mutate(() => saveQuickBar([id])), waterId);
    await page.locator(`[data-quick="${waterId}"]`).click();
    await page.waitForFunction(() => !!document.querySelector('#snackUndoBtn'));
    assert.equal(await page.evaluate(async () => (await CWDB.getAll('events'))[0].qant), 8);
    await page.locator('#snackUndoBtn').click();
    await page.waitForFunction(async () => (await CWDB.getAll('events')).length === 0);

    // Missing quick defaults open the editor; timer state survives a reload.
    const sleepId = await page.evaluate(() => state.topics.find((topic) => topic.name === 'Sleep').id);
    await page.evaluate((id) => CWMODEL.mutate(() => saveQuickBar([id])), sleepId);
    await page.locator(`[data-quick="${sleepId}"]`).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('.dialog');
      return dialog.contains(document.activeElement)
        && [...dialog.querySelectorAll('input,select,textarea')].every((input) =>
          input.labels.length || input.hasAttribute('aria-label'));
    }), true);
    await page.locator('#startTimer').click();
    await page.waitForFunction(() => !document.querySelector('.dialog'));
    await page.evaluate(() => CWMODEL.whenIdle());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-stop-timer]'));
    await page.locator('[data-stop-timer]').click();
    await page.waitForFunction(() => !document.querySelector('[data-stop-timer]'));
    assert.equal(await page.evaluate(async () => (await CWDB.getAll('events')).length), 1);

    // Drawer announces itself and traps focus; zoom is not prohibited.
    await page.locator('#menuBtn').click();
    assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'), 'false');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'menuBtn');
    assert.ok(!(await page.locator('meta[name=viewport]').getAttribute('content')).includes('maximum-scale'));

    // Goal revisions persist rather than overwrite historical configuration.
    await page.evaluate((id) => openGoalEdit(state.topics.find((topic) => topic.id === id)), waterId);
    await page.locator('#goalTarget').fill('80');
    await page.locator('#goalSave').click();
    await page.waitForFunction(() => !document.querySelector('.dialog'));
    const goal = await page.evaluate(async (id) => (await CWDB.getTopicGoals())[id], waterId);
    assert.equal(goal.target, 80);
    assert.ok(goal.history.length >= 1);

    // A save waiting behind sync must use the clicked form, not a later editor.
    await page.evaluate(() => {
      window.releaseDataLock = null;
      navigator.locks.request('plotline-data', () => new Promise((resolve) => { window.releaseDataLock = resolve; }));
    });
    await page.waitForFunction(() => typeof window.releaseDataLock === 'function');
    await page.evaluate((id) => openAddEvent(state.topics.find((topic) => topic.id === id)), waterId);
    await page.locator('#qNum').fill('12');
    await page.locator('#evNote').fill('Captured before waiting');
    await page.locator('#dialogSave').click();
    await page.keyboard.press('Escape');
    await page.evaluate((id) => openAddEvent(state.topics.find((topic) => topic.id === id)), sleepId);
    await page.locator('#evNote').fill('This editor must remain open');
    await page.evaluate(() => window.releaseDataLock());
    await page.evaluate(() => CWMODEL.whenIdle());
    const captured = await page.evaluate(async (id) => (await CWDB.getAll('events'))
      .find((event) => event.topicid === id && event.note === 'Captured before waiting'), waterId);
    assert.equal(captured.qant, 12);
    assert.equal(await page.locator('#evNote').inputValue(), 'This editor must remain open');
    await page.keyboard.press('Escape');

    // Delayed deletion also closes only its own confirmation, not a newer editor.
    await page.evaluate((id) => {
      window.releaseDataLock = null;
      navigator.locks.request('plotline-data', () => new Promise((resolve) => { window.releaseDataLock = resolve; }));
      openAddEvent(state.topics.find((topic) => topic.id === id),
        state.events.find((event) => event.topicid === id));
    }, sleepId);
    await page.waitForFunction(() => typeof window.releaseDataLock === 'function');
    await page.locator('#dialogDelete').click();
    await page.locator('#confirmYes').click();
    await page.keyboard.press('Escape');
    await page.evaluate((id) => openAddEvent(state.topics.find((topic) => topic.id === id)), waterId);
    await page.locator('#evNote').fill('Keep this draft after deletion');
    await page.evaluate(() => window.releaseDataLock());
    await page.evaluate(() => CWMODEL.whenIdle());
    assert.equal(await page.locator('#evNote').inputValue(), 'Keep this draft after deletion');
    assert.equal(await page.evaluate(async (id) => (await CWDB.getAll('events'))
      .filter((event) => event.topicid === id).length, sleepId), 0);
    await page.keyboard.press('Escape');

    // Updates drain already accepted writes before asking the worker to activate.
    await page.evaluate((id) => CWMODEL.mutate(() => saveQuickBar([id])), waterId);
    await page.evaluate(() => {
      window.workerActivated = false;
      CWAPP.watchUpdates({ waiting: {
        state: 'installed', postMessage() { window.workerActivated = true; },
      }, addEventListener() {} });
      window.releaseDataLock = null;
      navigator.locks.request('plotline-data', () => new Promise((resolve) => { window.releaseDataLock = resolve; }));
    });
    await page.waitForFunction(() => typeof window.releaseDataLock === 'function');
    const beforeUpdate = await page.evaluate(async () => (await CWDB.getAll('events')).length);
    await page.locator(`[data-quick="${waterId}"]`).click();
    await page.evaluate((id) => {
      renderCurrent();
      const button = document.querySelector(`[data-quick="${id}"]`);
      for (let i = 0; i < 5; i++) button.dispatchEvent(new Event('click'));
    }, waterId);
    assert.equal(await page.locator(`[data-quick="${waterId}"]`).isDisabled(), true);
    assert.equal(await page.locator(`[data-quick="${waterId}"]`).getAttribute('aria-busy'), 'true');
    await page.locator('#installUpdate').click();
    assert.equal(await page.evaluate(() => window.workerActivated), false);
    await page.evaluate(() => window.releaseDataLock());
    await page.waitForFunction(() => window.workerActivated);
    assert.equal(await page.evaluate(async () => (await CWDB.getAll('events')).length), beforeUpdate + 1);
    await page.evaluate(() => {
      CWMODEL.cancelUpdate();
      updatingApp = false;
      document.querySelector('#updateNotice').hidden = true;
    });

    // The no-Web-Locks fallback still shares one queue between sync and local writes.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
      window.releaseFallback = null;
      CWDRIVE.withDataLock(() => new Promise((resolve) => { window.releaseFallback = resolve; }));
    });
    await page.waitForFunction(() => typeof window.releaseFallback === 'function');
    await page.evaluate(() => {
      window.fallbackMutationRan = false;
      window.fallbackMutation = CWMODEL.mutate(async () => { window.fallbackMutationRan = true; });
    });
    assert.equal(await page.evaluate(() => window.fallbackMutationRan), false);
    await page.evaluate(async () => { releaseFallback(); await fallbackMutation; delete navigator.locks; });
    assert.equal(await page.evaluate(() => window.fallbackMutationRan), true);

    // Repeated view exits dispose charts, including the all-archived case.
    await page.evaluate(() => setView('stats'));
    assert.ok(await page.evaluate(() => Object.keys(Chart.instances).length > 0));
    const calendar = await page.evaluate(() => {
      const previous = state.insightSettings.cutoffHour;
      state.insightSettings.cutoffHour = 4;
      const early = new Date();
      early.setDate(early.getDate() - 1);
      early.setHours(2, 0, 0, 0);
      drawHeatmap([{ time: early.getTime(), qant: 0 }]);
      const expected = `${new Date(CWSTATS.dayKey(early.getTime(), 4)).toDateString()}: 1 event`;
      const matched = [...document.querySelectorAll('.heatmap-cell')].some((cell) =>
        cell.getAttribute('aria-label') === expected);
      state.insightSettings.cutoffHour = 2;
      const [, end] = dayBounds(new Date(2026, 2, 8).getTime());
      state.insightSettings.cutoffHour = previous;
      return { matched, nextHour: new Date(end).getHours(), nextDate: new Date(end).getDate() };
    });
    assert.deepEqual(calendar, { matched: true, nextHour: 2, nextDate: 9 });

    // Topic IDs and measurement IDs are independent, including in report analysis.
    const measured = await page.evaluate((id) => {
      window.savedRoles = state.topicRoles;
      state.topicRoles = { [id]: { role: 'focus', dir: 'up' } };
      const result = computeInsights(true);
      const outcome = primaryOutcome(result);
      return { key: outcome.key, unit: outcome.unit.trim() };
    }, waterId);
    assert.deepEqual(measured, { key: `focus:${waterId}:amount`, unit: 'oz' });
    await page.evaluate(() => {
      window.savedAnalyze = CWINSIGHTS.analyze;
      window.savedDownload = CWREPORT.download;
      CWINSIGHTS.analyze = (options) => {
        const result = savedAnalyze(options);
        window.reportUnit = primaryOutcome(result)?.unit.trim();
        return result;
      };
      CWREPORT.download = (html) => { window.reportHtml = html; };
      openReportDialog();
    });
    const reportRange = await page.evaluate(() =>
      `${document.querySelector('#reportFrom').value} - ${document.querySelector('#reportTo').value}`);
    await page.locator('#reportSave').click();
    await page.waitForFunction(() => !!window.reportHtml);
    assert.equal(await page.evaluate(() => window.reportUnit), 'oz');
    assert.ok(await page.evaluate(() => window.reportHtml.includes('oz')));
    assert.ok(await page.evaluate((range) => window.reportHtml.includes(`<p>${range} ·`), reportRange));
    await page.evaluate(() => {
      state.topicRoles = savedRoles;
      state.insightsDirty = true;
      CWINSIGHTS.analyze = savedAnalyze;
      CWREPORT.download = savedDownload;
    });
    await page.evaluate(() => setView('categories'));
    assert.equal(await page.evaluate(() => Object.keys(Chart.instances).length), 0);
    for (const width of [360, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['categories', 'recent', 'day', 'stats', 'insights']) {
        await page.evaluate((value) => setView(value), view);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${view} overflows at ${width}px`);
      }
    }
    // A long history must not turn each local click into several full DB reads.
    await page.evaluate(async (id) => {
      setView('categories');
      await CWMODEL.mutate(async () => {
        const used = new Set(state.events.map((event) => event.id));
        let next = 1;
        const events = Array.from({ length: 17000 }, (_, i) => {
          while (used.has(next)) next++;
          return { id: next++, topicid: id, time: Date.now() - (i + 1) * 60000,
            qant: 8, cost: 0, note: 'Synthetic history' };
        });
        await CWDB.putMany('events', events);
      });
      window.viewReads = 0;
      window.originalGetViewData = CWDB.getViewData;
      CWDB.getViewData = (...args) => { viewReads++; return originalGetViewData.apply(CWDB, args); };
    }, waterId);
    const responsiveness = await page.evaluate(async (id) => {
      const start = performance.now();
      const before = state.events.length;
      document.querySelector(`[data-quick="${id}"]`).click();
      await CWMODEL.whenIdle();
      return { elapsed: performance.now() - start, added: state.events.length - before, reads: viewReads };
    }, waterId);
    assert.equal(responsiveness.added, 1);
    assert.equal(responsiveness.reads, 1, 'one coherent UI snapshot per local mutation');
    assert.ok(responsiveness.elapsed < 1500, `17000-event quick log took ${responsiveness.elapsed}ms`);
    console.log(`17000-event local save: ${Math.round(responsiveness.elapsed)}ms`);
    await page.evaluate(() => { CWDB.getViewData = originalGetViewData; });

    // Real sync code with a stalled remote read/upload must not block UI edits.
    await page.evaluate(async () => {
      window.syncHooks = { getTokenSilent, findOrCreateFolder, statSyncFile, readSyncFile,
        updateSyncFile, createSyncFile, rotateVersions, maybeCleanupLegacyArtifacts };
      window.originalAutoSync = CW_CONFIG.autoSyncOnChange;
      CW_CONFIG.autoSyncOnChange = false;
      window.fakeRemote = await CWIO.buildExportObject();
      window.fakeRevision = 1;
      await CWDB.setMeta('driveSyncBase', fakeRemote);
      await CWDB.setMeta('driveEnabled', true);
      getTokenSilent = async () => 'synthetic-token';
      findOrCreateFolder = async () => 'synthetic-folder';
      window.fakeModifiedTime = new Date().toISOString();
      statSyncFile = async () => ({ id: 'synthetic-file', version: String(fakeRevision),
        modifiedTime: fakeModifiedTime, md5Checksum: String(fakeRevision) });
      window.pauseNetwork = async (phase) => {
        if (window.blockedPhase !== phase) return;
        window.blockedPhase = null;
        await new Promise((resolve) => { window.releaseNetwork = resolve; });
      };
      readSyncFile = async () => {
        await pauseNetwork('read');
        return JSON.parse(JSON.stringify(fakeRemote));
      };
      updateSyncFile = async (id, data) => {
        await pauseNetwork('write');
        fakeRemote = JSON.parse(JSON.stringify(data));
        fakeRevision++;
        return statSyncFile();
      };
      createSyncFile = async (folder, data) => updateSyncFile('synthetic-file', data);
      rotateVersions = async () => {};
      maybeCleanupLegacyArtifacts = async () => {};
      window.originalSafetyBackup = CWIO.safetyBackup;
      CWIO.safetyBackup = async () => {};
    });
    for (const phase of ['read', 'write']) {
      await page.evaluate((value) => {
        window.releaseNetwork = null;
        window.blockedPhase = value;
        window.syncFailure = null;
        window.pendingSlowSync = CWDRIVE.syncNow().catch((error) => { syncFailure = error.message; });
      }, phase);
      await page.waitForFunction(() => typeof window.releaseNetwork === 'function');
      const removedId = await page.evaluate(() => state.events.find((event) => event.note === 'Synthetic history').id);
      const logged = await page.evaluate(async (id) => {
        const start = performance.now();
        document.querySelector(`[data-quick="${id}"]`).click();
        let timeout;
        try {
          await Promise.race([CWMODEL.whenIdle(), new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Local save blocked by remote sync')), 1500);
          })]);
        } finally { clearTimeout(timeout); }
        return { elapsed: performance.now() - start, id: state.latestByTopic.get(id).id };
      }, waterId);
      assert.ok(logged.elapsed < 1500, `local add waited ${logged.elapsed}ms during remote ${phase}`);
      await page.evaluate(({ topicId, eventId }) => openAddEvent(state.topics.find((topic) => topic.id === topicId),
        state.events.find((event) => event.id === eventId)), { topicId: waterId, eventId: logged.id });
      await page.locator('#evNote').fill(`Saved during remote ${phase}`);
      await page.locator('#dialogSave').click();
      await page.waitForFunction(() => !document.querySelector('.dialog'), null, { timeout: 1500 });
      await page.evaluate(() => CWMODEL.whenIdle());
      await page.evaluate(({ topicId, eventId }) => openAddEvent(state.topics.find((topic) => topic.id === topicId),
        state.events.find((event) => event.id === eventId)), { topicId: waterId, eventId: removedId });
      await page.locator('#dialogDelete').click();
      await page.locator('#confirmYes').click();
      await page.waitForFunction(() => !document.querySelector('.dialog'), null, { timeout: 1500 });
      await page.evaluate(() => CWMODEL.whenIdle());
      await page.evaluate(async () => { releaseNetwork(); await pendingSlowSync; });
      assert.equal(await page.evaluate(() => syncFailure), null);
      const preserved = await page.evaluate(async ({ added, removed }) => {
        const events = await CWDB.getAll('events');
        return { added: events.find((event) => event.id === added)?.note,
          removed: events.some((event) => event.id === removed) };
      }, { added: logged.id, removed: removedId });
      assert.deepEqual(preserved, { added: `Saved during remote ${phase}`, removed: false });
      await page.evaluate(() => CWDRIVE.syncNow());
      assert.equal(await page.evaluate((id) => fakeRemote.events.some((event) => event.id === id), removedId), false);
      assert.equal(await page.evaluate((id) => fakeRemote.events.find((event) => event.id === id)?.note, logged.id),
        `Saved during remote ${phase}`);
    }
    await page.evaluate(async () => {
      await CWDRIVE.disconnect();
      Object.assign(window, syncHooks);
      CW_CONFIG.autoSyncOnChange = originalAutoSync;
      CWIO.safetyBackup = originalSafetyBackup;
    });
    await page.evaluate(async () => {
      for (const topic of state.topics) await CWDB.put('topics', { ...topic, archived: true });
      await reload(); setView('stats');
    });
    await page.locator('#manageArchived').waitFor();

    // Local reset must not call any Drive write operation.
    const beforeResetRevision = await page.evaluate(() => CWAPP.dataRevision());
    await page.evaluate(() => {
      window.remoteWrites = 0;
      CWIO.safetyBackup = async () => {};
      CWDRIVE.syncNow = async () => { window.remoteWrites++; };
      openWipe();
    });
    await page.locator('#confirmYes').click();
    await page.waitForFunction(() => document.querySelector('[data-preset="habits"]'));
    assert.equal(await page.evaluate(() => window.remoteWrites), 0);
    assert.equal(await page.evaluate(async () => (await CWDB.getAll('events')).length), 0);
    assert.equal(await page.evaluate(async () => CWDB.getMeta('driveEnabled')), false);
    assert.ok(await page.evaluate(async (before) => (await CWDB.getMeta('dataRevision')) > before, beforeResetRevision));
    assert.deepEqual(errors, []);
    await context.close();
    console.log('browser workflows passing');
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
