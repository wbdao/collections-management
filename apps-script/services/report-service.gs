/** Reports: outstanding collections by collector with aging, and receipts in transit. */

var ReportService = (function () {

  function agingBucket(dateIso) {
    if (!dateIso) return 'd60plus';
    var age = Helpers.daysUntil(dateIso) * -1;
    if (age <= 7) return 'd0_7';
    if (age <= 30) return 'd8_30';
    if (age <= 60) return 'd31_60';
    return 'd60plus';
  }

  function outstandingCollections(query) {
    var receipts = SheetsAdapter.readRows('receipts');
    var collectorIds = {};
    receipts.forEach(function (r) { if (r.collector_id) collectorIds[r.collector_id] = true; });
    SheetsAdapter.readRows('custody_balances', {
      where: function (b) { return b.document_type === 'RECEIPT'; }
    }).forEach(function (b) { collectorIds[b.holder_id] = true; });

    var items = Object.keys(collectorIds).filter(function (id) {
      return !query.collectorId || id === query.collectorId;
    }).map(function (id) {
      var mine = receipts.filter(function (r) { return r.collector_id === id; });
      var collected = mine.filter(function (r) { return r.status === 'COLLECTED'; });
      var aging = { d0_7: 0, d8_30: 0, d31_60: 0, d60plus: 0 };
      collected.forEach(function (r) { aging[agingBucket(r.collection_date)] += Number(r.amount_minor || 0); });
      var dates = collected.map(function (r) { return r.collection_date; }).filter(Boolean).sort();
      var outstanding = sum(collected, 'amount_minor');
      return {
        collectorId: id,
        booksOutstanding: SheetsAdapter.readRows('book_assignments', {
          where: function (a) { return a.assigned_to === id && a.status === 'ACTIVE'; }
        }).length,
        receipts: {
          issued: mine.length,
          unused: count(mine, 'status', 'UNUSED'),
          collected: collected.length,
          depositedBranch: count(mine, 'status', 'DEPOSITED_BRANCH'),
          depositedHq: count(mine, 'status', 'DEPOSITED_HQ'),
          cancelled: count(mine, 'status', 'CANCELLED'),
          lost: count(mine, 'status', 'LOST')
        },
        cashCollectedMinor: sum(mine, 'amount_minor'),
        cashDepositedMinor: sum(mine.filter(function (r) {
          return ['DEPOSITED_BRANCH', 'DEPOSITED_HQ'].indexOf(r.status) >= 0;
        }), 'amount_minor'),
        cashOutstandingMinor: outstanding,
        aging: aging,
        oldestCollectionDate: dates[0] || '',
        lastDepositDate: '',
        riskFlag: outstanding > 0 && aging.d31_60 + aging.d60plus > 0 ? 'HIGH' : (outstanding > 0 ? 'MEDIUM' : 'NONE')
      };
    });
    return { items: items, totals: { collectors: items.length, cashOutstandingMinor: sum(items, 'cashOutstandingMinor') } };
  }

  function receiptsInTransit(query) {
    return {
      items: SheetsAdapter.readRows('movements', {
        where: function (m) {
          if (m.document_type !== 'RECEIPT') return false;
          if (query.documentNumber && m.document_number !== query.documentNumber) return false;
          return m.to_location !== 'HQ_TREASURY' || m.reason !== 'DEPOSIT_TO_HQ';
        },
        orderBy: 'movement_date'
      })
    };
  }

  /**
   * Groups operational documents by a denormalized customer-master field.
   * 'warehouse' = Warehouse Group, 'department' = Customer group.
   * No warehouse or department master table is consulted.
   */
  function groupByCustomerField(field, query) {
    var wanted = (query && (query[field] || query.warehouse || query.department)) || '';
    var groups = {};
    ['receipts', 'cheques', 'guarantees'].forEach(function (entity) {
      SheetsAdapter.readRows(entity).forEach(function (row) {
        var key = row[field];
        if (Helpers.isEmpty(key)) return;
        key = String(key);
        if (wanted && key !== String(wanted)) return;
        if (!groups[key]) {
          groups[key] = {
            key: key, documents: 0, receipts: 0, cheques: 0, guarantees: 0,
            totalMinor: 0, collectedMinor: 0, outstandingMinor: 0
          };
        }
        var group = groups[key];
        var amount = Number(row.amount_minor || 0);
        group.documents++;
        group[entity]++;
        group.totalMinor += amount;
        if (entity === 'receipts') {
          if (row.status === 'COLLECTED') group.collectedMinor += amount;
          if (['COLLECTED', 'DEPOSITED_BRANCH', 'DEPOSITED_HQ'].indexOf(row.status) >= 0) {
            group.outstandingMinor += amount;
          }
        } else if (['CLEARED', 'RETURNED', 'RELEASED', 'CLOSED'].indexOf(row.status) < 0) {
          group.outstandingMinor += amount;
        }
      });
    });

    var items = Object.keys(groups).sort().map(function (key) { return groups[key]; });
    return {
      groupBy: field === 'warehouse' ? 'Warehouse Group' : 'Customer group',
      items: items,
      totals: {
        groups: items.length,
        totalMinor: sum(items, 'totalMinor'),
        outstandingMinor: sum(items, 'outstandingMinor')
      }
    };
  }

  /** Warehouse reports are grouped by the customer's Warehouse Group. */
  function byWarehouse(query) {
    return groupByCustomerField('warehouse', query);
  }

  /** Department reports are grouped by the customer's Customer group. */
  function byDepartment(query) {
    return groupByCustomerField('department', query);
  }

  function count(rows, field, value) {
    return rows.filter(function (r) { return r[field] === value; }).length;
  }

  function sum(rows, field) {
    return rows.reduce(function (s, r) { return s + Number(r[field] || 0); }, 0);
  }

  return {
    outstandingCollections: outstandingCollections,
    receiptsInTransit: receiptsInTransit,
    byWarehouse: byWarehouse,
    byDepartment: byDepartment
  };
})();
