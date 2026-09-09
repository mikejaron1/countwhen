/* Serialized local changes use the same origin-wide lock as Drive sync. */
(function () {
  'use strict';
  let pending = Promise.resolve();
  let channel = null;
  let acceptingChanges = true;
  let mutating = false;
  let refreshNeeded = false;

  async function lock(action) {
    if (window.CWDRIVE?.withDataLock) return CWDRIVE.withDataLock(action);
    if (navigator.locks?.request) return navigator.locks.request('plotline-data', action);
    return action();
  }

  function mutate(action) {
    if (!acceptingChanges) return Promise.reject(new Error('An update is being prepared. Please wait for the app to reload.'));
    const run = pending.then(() => lock(async () => {
      const revision = await CWDB.getMeta('dataRevision', 0);
      if (refreshNeeded || window.CWAPP.dataRevision() !== revision) {
        await window.CWAPP.reload();
        refreshNeeded = false;
      }
      mutating = true;
      let result;
      try {
        result = await action();
        await CWDB.markChange(revision);
        await window.CWAPP.reload();
        await window.CWAPP.reconcileDayChecks();
      } catch (error) {
        // A failed multi-step action can still have committed an earlier write.
        // Reload before the next interaction instead of leaving stale UI data.
        await window.CWAPP.reload();
        throw error;
      } finally {
        mutating = false;
        window.CWAPP.renderCurrent();
      }
      channel?.postMessage('changed');
      window.CWDRIVE?.queueAutoSync('marked-change').catch(window.CWUI.reportError);
      return result;
    }));
    // A failed action must not poison the queue; the caller still receives it.
    pending = run.catch(() => {});
    return run;
  }

  async function prepareUpdate() {
    acceptingChanges = false;
    await pending;
  }

  function refresh() {
    const run = pending.then(() => lock(async () => {
      await window.CWAPP.reload();
      refreshNeeded = false;
      window.CWAPP.renderCurrent();
    }));
    pending = run.catch(() => {});
    return run;
  }

  function start() {
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('plotline-changes');
      channel.addEventListener('message', async () => {
        refreshNeeded = true;
        if (document.querySelector('#modalRoot .dialog')) {
          window.CWUI.snack('Data changed in another tab. Close this editor to refresh.');
          return;
        }
        try {
          await refresh();
        } catch (error) { window.CWUI.reportError(error); }
      });
    }
  }

  window.CWMODEL = { mutate, refresh, start, isMutating: () => mutating, whenIdle: () => pending, prepareUpdate,
    cancelUpdate: () => { acceptingChanges = true; } };
})();
