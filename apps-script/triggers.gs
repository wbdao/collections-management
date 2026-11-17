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
