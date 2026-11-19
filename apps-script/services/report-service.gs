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

  /* =======================================================================
   * PHASE 2 / Step 8 — advanced reporting.
   * All five readers are additive: no new source table, no schema change.
   * Scope is applied with the same warehouse/branch/holder semantics the edge
   * applyScope() uses, so scoped roles never see another unit's documents.
   * ======================================================================= */

  function inScope(row, query) {
    query = query || {};
    if (query.warehouseIds && query.warehouseIds.length && row.warehouse &&
        query.warehouseIds.indexOf(String(row.warehouse)) < 0) return false;
    if (query.branchIds && query.branchIds.length && row.branch_id &&
        query.branchIds.indexOf(String(row.branch_id)) < 0) return false;
    if (query.warehouse && row.warehouse && String(row.warehouse) !== String(query.warehouse)) return false;
    var wanted = query.collectorId || query.holderId;
    if (wanted) {
      var holders = [row.collector_id, row.holder_id, row.current_holder_id, row.current_holder]
        .filter(function (v) { return !Helpers.isEmpty(v); });
      if (!holders.length) return false;
      if (!holders.some(function (id) { return String(id) === String(wanted); })) return false;
    }
    return true;
  }

  /** Receivables aging across cash receipts, cheques and guarantees. */
  function aging(query) {
    query = query || {};
    var buckets = { d0_7: 0, d8_30: 0, d31_60: 0, d60plus: 0 };
    var byType = {};
    var totalCount = 0;

    function add(type, amount, date) {
      if (!byType[type]) {
        byType[type] = { d0_7: 0, d8_30: 0, d31_60: 0, d60plus: 0, count: 0, totalMinor: 0 };
      }
      var bucket = agingBucket(date);
      var value = Number(amount || 0);
      buckets[bucket] += value;
      byType[type][bucket] += value;
      byType[type].count++;
      byType[type].totalMinor += value;
      totalCount++;
    }

    SheetsAdapter.readRows('receipts', {
      where: function (r) { return r.status === 'COLLECTED' && inScope(r, query); }
    }).forEach(function (r) { add('receipts', r.amount_minor, r.collection_date); });

    SheetsAdapter.readRows('cheques', {
      where: function (r) {
        return ['CLEARED', 'RETURNED'].indexOf(r.status) < 0 && inScope(r, query);
      }
    }).forEach(function (r) { add('cheques', r.amount_minor, r.due_date || r.cheque_date); });

    SheetsAdapter.readRows('guarantees', {
      where: function (r) {
        return ['RELEASED', 'CLOSED'].indexOf(r.status) < 0 && inScope(r, query);
      }
    }).forEach(function (r) { add('guarantees', r.amount_minor, r.expiry_date); });

    var totalMinor = buckets.d0_7 + buckets.d8_30 + buckets.d31_60 + buckets.d60plus;
    return {
      asOf: Helpers.nowIso(),
      buckets: buckets,
      byType: byType,
      totals: {
        documents: totalCount,
        totalMinor: totalMinor,
        overdueMinor: buckets.d31_60 + buckets.d60plus
      }
    };
  }

  /** Per-collector productivity and risk; built on the Phase 1 outstanding report. */
  function collectorPerformance(query) {
    var base = outstandingCollections(query || {});
    var items = base.items.map(function (item) {
      return {
        collectorId: item.collectorId,
        receipts: item.receipts,
        cashCollectedMinor: item.cashCollectedMinor,
        cashDepositedMinor: item.cashDepositedMinor,
        cashOutstandingMinor: item.cashOutstandingMinor,
        booksOutstanding: item.booksOutstanding,
        aging: item.aging,
        oldestCollectionDate: item.oldestCollectionDate,
        riskFlag: item.riskFlag,
        depositRate: item.cashCollectedMinor
          ? Number(item.cashDepositedMinor) / Number(item.cashCollectedMinor) : 0
      };
    }).sort(function (a, b) { return Number(b.cashOutstandingMinor) - Number(a.cashOutstandingMinor); });

    return {
      asOf: Helpers.nowIso(),
      items: items,
      totals: {
        collectors: items.length,
        cashCollectedMinor: sum(items, 'cashCollectedMinor'),
        cashDepositedMinor: sum(items, 'cashDepositedMinor'),
        cashOutstandingMinor: sum(items, 'cashOutstandingMinor'),
        highRiskCollectors: items.filter(function (i) { return i.riskFlag === 'HIGH'; }).length
      }
    };
  }

  /** Resolve a legacy holder label to a structured treasury id. */
  function treasuryForHolder(holder, warehouse, treasuries) {
    var value = String(holder || '');
    var ids = treasuries.map(function (t) { return String(t.treasury_id); });
    if (ids.indexOf(value) >= 0) return value;
    if (value === 'HQ_TREASURY') {
      var hq = treasuries.filter(function (t) { return t.treasury_type === 'HQ'; })[0];
      return hq ? hq.treasury_id : 'TR_HQ';
    }
    if (value === 'BRANCH_TREASURY') {
      var branch = treasuries.filter(function (t) {
        return t.treasury_type === 'BRANCH' && String(t.warehouse) === String(warehouse || '');
      })[0];
      return branch ? branch.treasury_id : 'TR_BRANCH';
    }
    return value || 'UNASSIGNED';
  }

  /** Per-treasury expected vs actual counts/amounts, with open exceptions. */
  function treasuryReconciliation(query) {
    query = query || {};
    var treasuries = SheetsAdapter.readRows('treasuries', {
      where: function (t) {
        if (query.type && t.treasury_type !== query.type) return false;
        if (query.status && t.status !== query.status) return false;
        if (query.warehouse && String(t.warehouse) !== String(query.warehouse)) return false;
        if (query.warehouseIds && query.warehouseIds.length && t.warehouse &&
            query.warehouseIds.indexOf(String(t.warehouse)) < 0) return false;
        return true;
      },
      orderBy: 'treasury_id'
    });

    var rows = {};
    var ensure = function (id) {
      if (!rows[id]) {
        var master = treasuries.filter(function (t) { return String(t.treasury_id) === String(id); })[0] || {};
        rows[id] = {
          treasuryId: id,
          treasuryName: master.treasury_name || '(unmapped)',
          treasuryType: master.treasury_type || '',
          warehouse: master.warehouse || '',
          expectedCount: 0, actualCount: 0,
          expectedMinor: 0, actualMinor: 0,
          openExceptions: 0, custodyCount: 0, custodyMinor: 0
        };
      }
      return rows[id];
    };

    var exceptions = SheetsAdapter.readRows('reconciliation_exceptions');
    exceptions.forEach(function (e) {
      var row = ensure(treasuryForHolder(e.holder_id, '', treasuries));
      row.expectedCount += Number(e.expected_count || 0);
      row.actualCount += Number(e.actual_count || 0);
      row.expectedMinor += Number(e.expected_amount_minor || 0);
      row.actualMinor += Number(e.actual_amount_minor || 0);
      if (e.status === 'OPEN') row.openExceptions++;
    });

    SheetsAdapter.readRows('custody_balances').forEach(function (b) {
      var row = ensure(treasuryForHolder(b.holder_id, b.warehouse, treasuries));
      row.custodyCount += Number(b.document_count || 0);
      row.custodyMinor += Number(b.total_amount_minor || 0);
    });

    treasuries.forEach(function (t) { ensure(t.treasury_id); });

    var items = Object.keys(rows).sort().map(function (id) {
      var row = rows[id];
      row.varianceCount = row.actualCount - row.expectedCount;
      row.varianceMinor = row.actualMinor - row.expectedMinor;
      row.status = (row.openExceptions > 0 || row.varianceCount !== 0 || row.varianceMinor !== 0)
        ? 'EXCEPTION' : 'OK';
      return row;
    });

    return {
      asOf: Helpers.nowIso(),
      items: items,
      openExceptions: exceptions.filter(function (e) { return e.status === 'OPEN'; }),
      totals: {
        treasuries: treasuries.length,
        exceptionTreasuries: items.filter(function (i) { return i.status === 'EXCEPTION'; }).length,
        openExceptions: items.reduce(function (s, i) { return s + i.openExceptions; }, 0),
        expectedMinor: sum(items, 'expectedMinor'),
        actualMinor: sum(items, 'actualMinor'),
        varianceMinor: sum(items, 'varianceMinor')
      }
    };
  }

  /** Latest verifyAuditChain() result plus cheap chain status — no re-write. */
  function auditExceptions(query) {
    var stored = Helpers.fromJson(SheetsAdapter.getSetting('audit_chain_last_verified'));
    var status = AuditService.chainStatus();
    return {
      asOf: Helpers.nowIso(),
      neverVerified: !stored,
      valid: stored ? !!stored.valid : true,
      recordsChecked: stored ? Number(stored.recordsChecked || 0) : Number(status.records || 0),
      issues: stored && stored.issues ? stored.issues : [],
      firstFailure: stored ? stored.firstFailure || null : null,
      checkedAt: stored ? stored.checkedAt || null : null,
      genesis: status.genesis,
      tip: status.tip,
      records: status.records
    };
  }

  /** Five headline KPIs; each value is the headline number, with a breakdown. */
  function kpis(query) {
    query = query || {};
    var receipts = SheetsAdapter.readRows('receipts', {
      where: function (r) { return inScope(r, query); }
    });
    var issued = receipts.filter(function (r) {
      return ['CANCELLED', 'LOST'].indexOf(r.status) < 0;
    });
    var collected = receipts.filter(function (r) {
      return ['COLLECTED', 'DEPOSITED_BRANCH', 'DEPOSITED_HQ'].indexOf(r.status) >= 0;
    });
    var issuedMinor = sum(issued, 'amount_minor');
    var collectedMinor = sum(collected, 'amount_minor');

    var pendingCash = receipts.filter(function (r) { return r.status === 'COLLECTED'; });
    var pendingDeposits = SheetsAdapter.readRows('deposits_branch')
      .concat(SheetsAdapter.readRows('deposits_hq'))
      .filter(function (d) {
        return ['CONFIRMED', 'REJECTED'].indexOf(d.status) < 0 && inScope(d, query);
      });

    var outstanding = outstandingCollections(query);
    var highRisk = outstanding.items.filter(function (i) { return i.riskFlag === 'HIGH'; }).length;

    var cheques = SheetsAdapter.readRows('cheques', {
      where: function (c) { return inScope(c, query); }
    });
    var cleared = cheques.filter(function (c) { return c.status === 'CLEARED'; });
    var returned = cheques.filter(function (c) { return c.status === 'RETURNED'; });
    var clearanceDays = cleared.map(function (c) {
      if (!c.cleared_at || !c.clearing_started_at) return null;
      var days = (new Date(c.cleared_at).getTime() - new Date(c.clearing_started_at).getTime()) / 86400000;
      return days >= 0 ? days : null;
    }).filter(function (d) { return d !== null; });
    var today = Helpers.todayIso();
    var overdueCheques = cheques.filter(function (c) {
      return ['CLEARED', 'RETURNED'].indexOf(c.status) < 0 && c.due_date && c.due_date < today;
    });

    var guarantees = SheetsAdapter.readRows('guarantees', {
      where: function (g) { return inScope(g, query); }
    });
    var activeGuarantees = guarantees.filter(function (g) {
      return ['RELEASED', 'CLOSED'].indexOf(g.status) < 0;
    });
    var expiringSoon = activeGuarantees.filter(function (g) {
      var days = Helpers.daysUntil(g.expiry_date);
      return days !== null && days >= 0 && days <= 30;
    });
    var expired = activeGuarantees.filter(function (g) {
      var days = Helpers.daysUntil(g.expiry_date);
      return days !== null && days < 0;
    });

    return {
      asOf: Helpers.nowIso(),
      collectionEfficiency: {
        value: issuedMinor ? Number((collectedMinor / issuedMinor).toFixed(4)) : 0,
        unit: 'ratio',
        collectedMinor: collectedMinor,
        issuedMinor: issuedMinor,
        collectedCount: collected.length,
        issuedCount: issued.length
      },
      depositsPending: {
        value: pendingCash.length + pendingDeposits.length,
        unit: 'count',
        receiptCount: pendingCash.length,
        depositCount: pendingDeposits.length,
        totalMinor: sum(pendingCash, 'amount_minor') + sum(pendingDeposits, 'total_minor')
      },
      collectorOutstandingBalances: {
        value: outstanding.totals.cashOutstandingMinor,
        unit: 'minor',
        collectors: outstanding.totals.collectors,
        highRiskCollectors: highRisk,
        byCollector: outstanding.items.map(function (i) {
          return { collectorId: i.collectorId, outstandingMinor: i.cashOutstandingMinor, riskFlag: i.riskFlag };
        })
      },
      chequeClearancePerformance: {
        value: cheques.length ? Number((cleared.length / cheques.length).toFixed(4)) : 0,
        unit: 'ratio',
        issued: cheques.length,
        cleared: cleared.length,
        returned: returned.length,
        pending: cheques.length - cleared.length - returned.length,
        clearedMinor: sum(cleared, 'amount_minor'),
        overdueCount: overdueCheques.length,
        averageClearanceDays: clearanceDays.length
          ? Number((clearanceDays.reduce(function (a, b) { return a + b; }, 0) / clearanceDays.length).toFixed(2))
          : null
      },
      guaranteeRiskExposure: {
        value: sum(activeGuarantees, 'amount_minor'),
        unit: 'minor',
        activeCount: activeGuarantees.length,
        expiringSoonCount: expiringSoon.length,
        expiredCount: expired.length,
        atRiskMinor: sum(expiringSoon, 'amount_minor') + sum(expired, 'amount_minor')
      }
    };
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
    byDepartment: byDepartment,
    // PHASE 2 / Step 8
    aging: aging,
    collectorPerformance: collectorPerformance,
    treasuryReconciliation: treasuryReconciliation,
    auditExceptions: auditExceptions,
    kpis: kpis
  };
})();
