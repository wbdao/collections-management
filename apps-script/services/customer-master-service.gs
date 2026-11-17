/**
 * ============================================================================
 * CUSTOMER MASTER SERVICE — READ-ONLY VIEW OF THE EXTERNAL CUSTOMER SHEET
 * ============================================================================
 *
 * The customer spreadsheet (sheet: قاعده عملاء الشركه) is the SYSTEM OF RECORD.
 * Customer data is never stored in the operational spreadsheet. This service:
 *   - reads the external sheet through SheetsAdapter (the only file allowed to
 *     use SpreadsheetApp),
 *   - resolves every source column dynamically by HEADER TEXT (never by a
 *     fixed column number),
 *   - normalizes the approved column mapping onto a stable object,
 *   - caches each customer under `customer:{Account}` for 5 minutes.
 *
 * Public API:
 *   getCustomer(account)
 *   searchCustomers(query)
 *   getCustomerWarehouse(account)
 *   getCustomerDepartment(account)
 */
var CustomerMasterService = (function () {

  /** Exact header texts in the customer master sheet. */
  var HEADER = {
    account: 'Account',
    name: 'Name',
    warehouseGroup: 'Warehouse Group',
    customerGroup: 'Customer group',
    eligibleCreditLimit: 'Eligible credit limit',
    creditLimit: 'Credit limit',
    balance: 'Balance',
    paymentSchedule: 'Payment schedule',
    worker: 'Worker',
    workerName: 'Worker Name',
    companyChain: 'Company chain',
    segment: 'Segment',
    idNumber: 'ID number',
    telephone: 'Telephone',
    accountStatus: 'Account status',
    unifiedName: 'الاسم الموحد'
  };

  var REQUIRED_HEADERS = ['Account'];

  function getCache() {
    return CacheService.getScriptCache();
  }

  function cacheKey(account) {
    return 'customer:' + String(account).trim();
  }

  /** Extracts the account from any accepted request field name. */
  function accountFrom(data) {
    if (!data) return '';
    var candidate = data.customer_code || data.account || data.Account ||
      data.customerAccount || data.customerCode;
    if (Helpers.isEmpty(candidate)) return '';
    return String(candidate).trim();
  }

  /**
   * Verifies the sheet still exposes the headers we depend on. Resolution is
   * done by header TEXT — the returned column position is never used to read
   * data, so reordered or inserted columns cannot break the mapping.
   */
  function validateSchema(headers) {
    var available = {};
    (headers || []).forEach(function (header) { if (header) available[header] = true; });
    REQUIRED_HEADERS.forEach(function (header) {
      if (!available[header]) {
        Errors.fail('CUSTOMER_MASTER_SCHEMA',
          'Customer master sheet is missing the required header: ' + header);
      }
    });
    return available;
  }

  function pick(row, headerName) {
    var value = row ? row[headerName] : null;
    return value === undefined || value === null ? '' : String(value).trim();
  }

  /** Maps a raw master row onto the field names used across the system. */
  function normalize(row) {
    var account = pick(row, HEADER.account);
    var name = pick(row, HEADER.name);
    var warehouse = pick(row, HEADER.warehouseGroup);
    var department = pick(row, HEADER.customerGroup);
    var telephone = pick(row, HEADER.telephone);
    var nationalId = pick(row, HEADER.idNumber);
    var accountStatus = pick(row, HEADER.accountStatus);

    return {
      // Primary keys / names
      account: account,
      customer_code: account,
      name: name,
      customer_name: name,
      unifiedName: pick(row, HEADER.unifiedName),

      // Approved denormalized mapping
      warehouse: warehouse,
      warehouseGroup: warehouse,
      department: department,
      customerGroup: department,
      phone: telephone,
      telephone: telephone,
      national_id: nationalId,
      nationalId: nationalId,
      // Approved canonical mapping: Account status -> account_status.
      // The other two keys are retained as backward-compatible aliases.
      account_status: accountStatus,
      customer_status: accountStatus,
      accountStatus: accountStatus,

      // Remaining master attributes (read-only, never persisted locally)
      eligibleCreditLimit: pick(row, HEADER.eligibleCreditLimit),
      creditLimit: pick(row, HEADER.creditLimit),
      balance: pick(row, HEADER.balance),
      paymentSchedule: pick(row, HEADER.paymentSchedule),
      worker: pick(row, HEADER.worker),
      workerName: pick(row, HEADER.workerName),
      companyChain: pick(row, HEADER.companyChain),
      segment: pick(row, HEADER.segment),

      source: 'customer_master'
    };
  }

  /**
   * Returns one normalized customer by Account (the unique identifier).
   * Throws CUSTOMER_NOT_FOUND when the account is absent from the master.
   */
  function getCustomer(account) {
    if (Helpers.isEmpty(account)) {
      Errors.fail('VALIDATION_ERROR', 'Account is required');
    }
    var key = cacheKey(account);
    var cached = getCache().get(key);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* fall through and refresh */ }
    }

    var master = SheetsAdapter.readCustomerMaster();
    validateSchema(master.headers);

    var match = null;
    for (var i = 0; i < master.rows.length; i++) {
      if (pick(master.rows[i], HEADER.account) === String(account).trim()) {
        match = master.rows[i];
        break;
      }
    }
    if (!match) {
      Errors.fail('CUSTOMER_NOT_FOUND', 'Customer account not found: ' + String(account).trim());
    }

    var customer = normalize(match);
    try {
      getCache().put(key, JSON.stringify(customer), CONFIG.customerMasterCacheTtlSeconds);
    } catch (e) { /* cache is best-effort; never fail a lookup because of it */ }
    return customer;
  }

  /**
   * Autocomplete across Account, Name and الاسم الموحد (Arabic unified name).
   * Accepts a plain string or `{ query, limit }`. An empty query returns [].
   */
  function searchCustomers(query) {
    var term = '';
    var limit = CONFIG.customerMasterDefaultSearchLimit;

    if (typeof query === 'string') {
      term = query;
    } else if (query && typeof query === 'object') {
      term = query.query || query.q || query.term || query.search || '';
      if (!Helpers.isEmpty(query.limit)) limit = Number(query.limit);
    }
    term = String(term).trim().toLowerCase();
    if (!term) return [];

    if (!isFinite(limit) || limit < 1) limit = CONFIG.customerMasterDefaultSearchLimit;
    limit = Math.min(limit, CONFIG.customerMasterMaxSearchLimit);

    var master = SheetsAdapter.readCustomerMaster();
    validateSchema(master.headers);

    var found = [];
    for (var i = 0; i < master.rows.length; i++) {
      var customer = normalize(master.rows[i]);
      var matches = customer.account.toLowerCase().indexOf(term) >= 0 ||
        customer.name.toLowerCase().indexOf(term) >= 0 ||
        customer.unifiedName.toLowerCase().indexOf(term) >= 0;
      if (!matches) continue;
      found.push(customer);
      if (found.length >= limit) break;
    }
    return found;
  }

  function getCustomerWarehouse(account) {
    return getCustomer(account).warehouse;
  }

  function getCustomerDepartment(account) {
    return getCustomer(account).department;
  }

  /** Drops one cached customer after a master refresh (maintenance helper). */
  function clearCache(account) {
    getCache().remove(cacheKey(account));
  }

  return {
    HEADER: HEADER,
    accountFrom: accountFrom,
    getCustomer: getCustomer,
    searchCustomers: searchCustomers,
    getCustomerWarehouse: getCustomerWarehouse,
    getCustomerDepartment: getCustomerDepartment,
    clearCache: clearCache
  };
})();
