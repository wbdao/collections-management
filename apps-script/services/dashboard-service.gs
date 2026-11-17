/** Dashboard aggregates, including the dedicated custody dashboard. */

var DashboardService = (function () {

  function count(rows, field, value) {
    return rows.filter(function (r) { return r[field] === value; }).length;
  }

  function sum(rows, field) {
    return rows.reduce(function (s, r) { return s + Number(r[field] || 0); }, 0);
  }

  function byStatus(rows) {
    var result = {};
    rows.forEach(function (r) { result[r.status] = (result[r.status] || 0) + 1; });
    return result;
  }

  /** Warehouse Group scoping using the denormalized document field. */
  function matchesWarehouse(row, query) {
    var wanted = query.warehouse || query.warehouseGroup || query.warehouseId;
    if (!wanted && query.warehouseIds && query.warehouseIds.length) wanted = query.warehouseIds;
    if (!wanted || (Array.isArray(wanted) && !wanted.length)) return true;
    if (!row.warehouse) return true; // legacy/blank stub before collection
    if (Array.isArray(wanted)) return wanted.indexOf(row.warehouse) >= 0;
    return row.warehouse === wanted;
  }

  function summary(query) {
    var scoped = function (entity) {
      // Books carry no Warehouse Group; they are never warehouse-scoped here.
      if (entity === 'books') return SheetsAdapter.readRows(entity);
      return SheetsAdapter.readRows(entity, {
        where: function (r) { return matchesWarehouse(r, query); }
      });
    };
    var books = scoped('books');
    var receipts = scoped('receipts');
    var cheques = scoped('cheques');
    var guarantees = scoped('guarantees');
    var collections = SheetsAdapter.readRows('collections');
    var today = Helpers.todayIso();
    var month = today.slice(0, 7);
    var collectedToday = collections.filter(function (r) { return r.collection_date === today; });
    var collectedMonth = collections.filter(function (r) { return String(r.collection_date).slice(0, 7) === month; });

    return {
      books: {
        total: books.length,
        active: books.filter(function (b) { return ['AVAILABLE', 'ASSIGNED'].indexOf(b.status) >= 0; }).length,
        assigned: count(books, 'status', 'ASSIGNED'),
        available: count(books, 'status', 'AVAILABLE'),
        completed: count(books, 'status', 'COMPLETED'),
        lost: count(books, 'status', 'LOST')
      },
      collections: {
        todayMinor: sum(collectedToday, 'total_minor'),
        monthMinor: sum(collectedMonth, 'total_minor'),
        pendingMinor: sum(receipts.filter(function (r) { return r.status === 'COLLECTED'; }), 'amount_minor'),
        depositedMinor: sum(receipts.filter(function (r) {
          return ['DEPOSITED_BRANCH', 'DEPOSITED_HQ'].indexOf(r.status) >= 0;
        }), 'amount_minor')
      },
      cheques: {
        byStatus: byStatus(cheques),
        overdueCount: ChequeService.overdue({}).length
      },
      guarantees: {
        byStatus: byStatus(guarantees),
        expiringCount: GuaranteeService.expiring({}).filter(function (g) {
          return ['DUE_30', 'DUE_15', 'DUE_7'].indexOf(g.alert_bucket) >= 0;
        }).length
      },
      recentMovements: SheetsAdapter.readRows('movements', { limit: 10 })
    };
  }

  function custody(query) {
    var books = SheetsAdapter.readRows('books');
    var receipts = SheetsAdapter.readRows('receipts');
    var cheques = SheetsAdapter.readRows('cheques');
    var guarantees = SheetsAdapter.readRows('guarantees');
    var balances = SheetsAdapter.readRows('custody_balances');

    function balanceSum(documentType, holder) {
      return balances.filter(function (b) {
        return b.document_type === documentType && (!holder || b.holder_id === holder);
      });
    }

    var bookBalance = balanceSum('BOOK');
    var cashBalance = balanceSum('RECEIPT');
    var chequeBalance = balanceSum('CHEQUE');
    var guaranteeBalance = balanceSum('GUARANTEE');

    var byStage = {
      WITH_COLLECTOR: sum(receipts.filter(function (r) { return r.status === 'COLLECTED'; }), 'amount_minor'),
      AT_BRANCH: sum(receipts.filter(function (r) { return r.status === 'DEPOSITED_BRANCH'; }), 'amount_minor'),
      AT_HQ: sum(receipts.filter(function (r) { return r.status === 'DEPOSITED_HQ'; }), 'amount_minor')
    };

    return {
      booksInCustody: {
        total: bookBalance.reduce(function (s, b) { return s + Number(b.document_count || 0); }, 0),
        byHolder: bookBalance.map(function (b) { return { holder: b.holder_id, count: Number(b.document_count || 0) }; })
      },
      cashInCustody: {
        totalMinor: cashBalance.reduce(function (s, b) { return s + Number(b.total_amount_minor || 0); }, 0),
        byStage: byStage
      },
      chequesInCustody: {
        count: chequeBalance.reduce(function (s, b) { return s + Number(b.document_count || 0); }, 0),
        totalMinor: chequeBalance.reduce(function (s, b) { return s + Number(b.total_amount_minor || 0); }, 0),
        byStatus: byStatus(cheques.filter(function (c) { return ['CLEARED', 'RETURNED'].indexOf(c.status) < 0; }))
      },
      guaranteesInCustody: {
        count: guaranteeBalance.reduce(function (s, b) { return s + Number(b.document_count || 0); }, 0),
        totalMinor: guaranteeBalance.reduce(function (s, b) { return s + Number(b.total_amount_minor || 0); }, 0),
        byStatus: byStatus(guarantees.filter(function (g) { return ['RELEASED', 'CLOSED'].indexOf(g.status) < 0; })),
        expiryAlerts: AlertService.summary().GUARANTEE_EXPIRY
      },
      outstandingByCollector: ReportService.outstandingCollections(query).items,
      balanceExceptions: SheetsAdapter.readRows('reconciliation_exceptions', {
        where: function (e) { return e.status === 'OPEN'; }
      }).length,
      asOf: Helpers.nowIso()
    };
  }

  /**
   * Warehouse/department structure is DERIVED from customer master values
   * already denormalized onto operational documents. There is no warehouse or
   * department master table in this spreadsheet.
   */
  function structure() {
    var groups = {};
    ['receipts', 'cheques', 'guarantees'].forEach(function (entity) {
      SheetsAdapter.readRows(entity).forEach(function (row) {
        var warehouse = row.warehouse;
        var department = row.department;
        if (Helpers.isEmpty(warehouse)) return;
        if (!groups[warehouse]) groups[warehouse] = { departments: {} };
        if (!Helpers.isEmpty(department)) groups[warehouse].departments[department] = true;
      });
    });

    var items = Object.keys(groups).sort().map(function (warehouse) {
      var departments = Object.keys(groups[warehouse].departments).sort();
      return {
        warehouseId: warehouse,
        name: warehouse,
        departments: departments.map(function (department) {
          return { departmentId: department, name: department, code: department };
        })
      };
    });
    return { source: 'customer_master_values_on_documents', items: items };
  }

  return { summary: summary, custody: custody, structure: structure };
})();
