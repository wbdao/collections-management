/**
 * PHASE 2 / Step 9 — workbook split administration (M010).
 *
 * The runtime switch is the `enabled` flag inside the `workbook_registry`
 * setting; `registry.splitEnabled` is the mirrored policy flag. SheetsAdapter
 * requires BOTH to be true before resolving any entity away from CORE, so a
 * single stray flag can never activate a split. This service is the only
 * supported way to flip them, and it keeps them in sync, clears caches and
 * writes a chained audit record.
 *
 * The actual data movement (copying target sheets to DOCS/AUDIT workbooks, verifying
 * checksums) remains a manual, separately approved runbook; this control only
 * changes routing AFTER that copy has completed.
 */
var WorkbookRegistryService = (function () {

  var KEY = 'workbook_registry';
  var SPLIT_FLAG = 'registry.splitEnabled';
  var CORE_ONLY = {
    settings: true, idx_id_map: true, sequences: true, processed_requests: true
  };

  function defaultRegistry() {
    return {
      CORE: CONFIG.coreSpreadsheetId,
      DOCS: CONFIG.docsSpreadsheetId || CONFIG.coreSpreadsheetId,
      AUDIT: CONFIG.auditSpreadsheetId || CONFIG.coreSpreadsheetId,
      enabled: false,
      entities: {}
    };
  }

  function readRegistry() {
    var registry = SheetsAdapter.getSetting(KEY);
    var base = defaultRegistry();
    if (!registry) return base;
    // Backfill missing workbook ids from config without mutating the source.
    base.CORE = registry.CORE || base.CORE;
    base.DOCS = registry.DOCS || base.DOCS;
    base.AUDIT = registry.AUDIT || base.AUDIT;
    base.enabled = !!registry.enabled;
    base.entities = registry.entities || {};
    return base;
  }

  function splitActive(registry, policyFlag) {
    return !!registry.enabled && policyFlag === true;
  }

  /** ADMIN read: registry shape plus the effective workbook for every entity. */
  function status() {
    var registry = readRegistry();
    var policyFlag = SheetsAdapter.getSetting(SPLIT_FLAG);
    var active = splitActive(registry, policyFlag);
    var placement = {};
    var byWorkbook = { CORE: [], DOCS: [], AUDIT: [] };

    Object.keys(TABLES).forEach(function (entity) {
      var name = CORE_ONLY[entity] ? 'CORE' :
        ((registry.entities && registry.entities[entity]) || 'CORE');
      if (!byWorkbook[name]) name = 'CORE';
      var workbookId = active ? (registry[name] || registry.CORE) : registry.CORE;
      placement[entity] = { workbook: name, workbookId: workbookId };
      (byWorkbook[name] || byWorkbook.CORE).push(entity);
    });

    return {
      splitEnabled: active,
      registryEnabled: !!registry.enabled,
      policyFlag: policyFlag === true,
      consistent: !!registry.enabled === (policyFlag === true),
      workbooks: {
        CORE: registry.CORE,
        DOCS: registry.DOCS,
        AUDIT: registry.AUDIT
      },
      placement: placement,
      entitiesByWorkbook: byWorkbook
    };
  }

  /** ADMIN mutation: flip both flags together, clear caches, audit the change. */
  function setSplit(ctx, enabled) {
    enabled = !!enabled;
    var before = readRegistry();
    var beforeActive = splitActive(before, SheetsAdapter.getSetting(SPLIT_FLAG));
    var actorId = (ctx && ctx.actor && ctx.actor.userId) || 'system';

    var registry = Helpers.clone(before);
    registry.enabled = enabled;
    SheetsAdapter.setSetting(KEY, registry, 'Entity to workbook placement', actorId);
    SheetsAdapter.setSetting(SPLIT_FLAG, enabled, 'Phase 2 policy flag', actorId);
    SheetsAdapter.clearRegistryCache();

    if (AuditService) {
      AuditService.write(ctx, {
        operation: enabled ? 'WORKBOOK_SPLIT_ENABLE' : 'WORKBOOK_SPLIT_DISABLE',
        entityType: 'settings', entityId: KEY,
        oldValue: { enabled: beforeActive },
        newValue: { enabled: enabled },
        result: 'SUCCESS'
      });
    }

    var after = status();
    after.previousSplitEnabled = beforeActive;
    return after;
  }

  return {
    status: status,
    setSplit: setSplit,
    KEY: KEY,
    SPLIT_FLAG: SPLIT_FLAG
  };
})();
