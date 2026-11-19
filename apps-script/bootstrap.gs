/**
 * ============================================================================
 * PHASE 1 BOOTSTRAP — BUILDS THE OPERATIONAL SPREADSHEET FROM SCRATCH
 * ============================================================================
 *
 * Target: the EXISTING spreadsheet configured by CONFIG.spreadsheetId
 * (default: the business-owned Phase 1 database). A new spreadsheet is never
 * created and the workbook is never renamed.
 *
 * This bootstrap creates, for every entity in TABLES:
 *   - the sheet with the exact header row from the approved catalog,
 *   - a bold/frozen header,
 *   - auto-sized columns,
 *   - dropdown validation on every status / categorical column,
 *   - sheet protection for tbl_audit_logs, idx_tracking, idx_id_map,
 *     tbl_sequences.
 *
 * It then seeds the five default roles, their permission rows, one bootstrap
 * administrator, and the `sheet_registry` row inside tbl_settings.
 *
 * Fully re-runnable: sheets are updated in place and seed rows are inserted
 * only when absent. The Router wraps run() in one LockService transaction.
 *
 * NOTE: Customer master data, warehouses and departments are intentionally NOT
 * created here — they live in a separate daily-updated spreadsheet.
 */
var Bootstrap = (function () {

  function seedSimple(entity, rows, keyField) {
    var created = 0;
    var existing = {};
    SheetsAdapter.readRows(entity).forEach(function (row) {
      existing[String(row[keyField])] = true;
    });
    rows.forEach(function (row) {
      if (!existing[String(row[keyField])]) {
        SheetsAdapter.insertRow(entity, row);
        existing[String(row[keyField])] = true;
        created++;
      }
    });
    return created;
  }

  function seedRolesAndPermissions() {
    var created = 0;

    // Read each seed table once instead of once per permission/grant. The old
    // version re-read the whole role_permissions sheet hundreds of times, which
    // dominated bootstrap runtime and frequently hit Apps Script limits.
    var permissions = SheetsAdapter.readRows('permissions');
    var grants = SheetsAdapter.readRows('role_permissions');
    var permissionKeys = {};
    permissions.forEach(function (row) { permissionKeys[String(row.code)] = true; });
    var grantKeys = {};
    grants.forEach(function (row) {
      grantKeys[String(row.role_id) + '|' + String(row.permission_id)] = true;
    });

    PERMISSION_CATALOG.forEach(function (p) {
      var code = p[0];
      var permissionId = 'PERM_' + code.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
      if (!permissionKeys[String(code)]) {
        SheetsAdapter.insertRow('permissions', {
          permission_id: permissionId, code: code, module: p[1], action: p[2]
        });
        permissionKeys[String(code)] = true;
        created++;
      }
      SEED_ROLES.forEach(function (role) {
        var granted = (ROLE_PERMISSION_MAP[role.name] || []).indexOf(code) >= 0;
        if (!granted) return;
        var key = String(role.role_id) + '|' + permissionId;
        if (!grantKeys[key]) {
          SheetsAdapter.insertRow('role_permissions', {
            role_id: role.role_id, permission_id: permissionId
          });
          grantKeys[key] = true;
          created++;
        }
      });
    });
    return created;
  }

  /** One bootstrap administrator so the system is usable after setup. */
  function seedAdmin() {
    if (SheetsAdapter.findRow('users', 'username', 'admin')) return 0;
    var salt = Utilities.getUuid();
    SheetsAdapter.insertRow('users', {
      user_id: 'USR_ADMIN',
      username: 'admin',
      // Salt is embedded in the stored hash (tbl_users has no password_salt column).
      password_hash: AuthService.hashPassword(CONFIG.adminPassword, salt),
      full_name: 'System Administrator',
      email: 'admin@cms.local',
      role_id: 'ROLE_ADMIN',
      status: 'ACTIVE',
      failed_attempts: 0,
      last_login_at: '',
      version: 1,
      created_at: Helpers.nowIso(),
      updated_at: Helpers.nowIso()
    });
    return 1;
  }

  /** Writes the entity -> sheet/workbook mapping as a row in tbl_settings. */
  function writeRegistry() {
    var registry = {};
    Object.keys(TABLES).forEach(function (entity) {
      registry[entity] = { sheet: TABLES[entity].sheet, workbookId: CONFIG.spreadsheetId };
    });
    SheetsAdapter.setSetting('sheet_registry', registry, 'Entity to sheet/workbook mapping', 'bootstrap');
    SheetsAdapter.clearRegistryCache();
  }

  /**
   * Main entry point. Router wraps this in one LockService transaction,
   * so no nested lock is taken here.
   */
  function run(actor) {
    SheetsAdapter.ensureAllSheets();
    writeRegistry();

    var counts = {
      sheets: Object.keys(TABLES).length,
      protectedSheets: PROTECTED_SHEETS.length,
      roles: seedSimple('roles', SEED_ROLES, 'name'),
      permissionsAndGrants: seedRolesAndPermissions(),
      admin: seedAdmin()
    };

    AuditService.write(actor || { userId: 'system', role: 'SYSTEM', ip: 'bootstrap' }, {
      operation: 'BOOTSTRAP',
      entityType: 'settings',
      entityId: 'sheet_registry',
      oldValue: null,
      newValue: counts,
      result: 'SUCCESS'
    });
    return counts;
  }

  /** Structure-only variant for maintenance (no seed data, no audit row). */
  function rebuildStructure() {
    SheetsAdapter.ensureAllSheets();
    writeRegistry();
    return { sheets: Object.keys(TABLES).length, protectedSheets: PROTECTED_SHEETS.length };
  }

  return {
    run: run,
    rebuildStructure: rebuildStructure,
    // PHASE 2 (M011): additive permission seeding without adding another admin
    // or bootstrap audit row. Safe to call repeatedly.
    seedPermissions: seedRolesAndPermissions
  };
})();
