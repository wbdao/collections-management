/** Daily 01:00 UTC alert scan trigger (install once via installDailyScanTrigger). */

function installDailyScanTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'dailyScanTrigger';
  });
  existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('dailyScanTrigger')
    .timeBased()
    .everyDays(1)
    .atHour(1)
    .create();
  return { installed: true };
}

function dailyScanTrigger() {
  var ctx = {
    requestId: 'trigger-' + Utilities.getUuid(),
    actor: { userId: 'SYSTEM', role: 'ADMIN', scopes: [], ip: 'scheduler' },
    ip: 'scheduler'
  };
  return SheetsAdapter.withTransaction(function () {
    return AlertService.dailyScan(ctx);
  });
}

/* ---- R2 backup trigger — DISABLED (Google Sheets only) -------------------- */
/*
 * R2 is intentionally skipped in this rollout. These functions are inert
 * placeholders so no scheduled job can dispatch a backup to a nonexistent
 * bucket or to the unmounted /api/v1/admin/backups route. Install only
 * dailyScanTrigger (01:00 UTC).
 */
function installDailyBackupTrigger() {
  return {
    installed: false,
    disabled: true,
    reason: 'R2 is disabled; Google Sheets is the only storage backend.'
  };
}

function dailyBackupTrigger() {
  return {
    ok: true,
    disabled: true,
    reason: 'R2 is disabled; Google Sheets is the only storage backend.'
  };
}
