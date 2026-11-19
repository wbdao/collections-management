/** PHASE 2 / Step 10 — D1 adapter contract conformance (mock D1, never activated). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D1RepositoryAdapter, D1Transaction
} from '../functions/_lib/d1-repository-adapter.js';
import { Repository, createRepository } from '../functions/_lib/repository.js';
import { assertRepository, REPOSITORY_METHODS } from '../shared/contracts/repository.js';

/* -------------------------------------------------------------------------- */
/* Minimal in-memory D1 — understands only the SQL shapes the adapter emits.   */
/* -------------------------------------------------------------------------- */

function mockD1(seed = {}) {
  const tables = {};
  Object.keys(seed).forEach((name) => { tables[name] = seed[name].map((r) => ({ ...r })); });

  function buildPredicate(whereSql, params, cursor) {
    const clauses = whereSql.split(/\s+AND\s+/);
    const tests = clauses.map((clause) => {
      let m = clause.match(/^COALESCE\("is_deleted",\s*0\)\s*=\s*0$/);
      if (m) return (row) => !row.is_deleted || Number(row.is_deleted) === 0;

      m = clause.match(/^"?([a-z_][a-z0-9_]*)"?\s+IN\s+\(([^)]*)\)$/);
      if (m) {
        const column = m[1];
        const parts = m[2].split(',').map((s) => s.trim());
        const values = parts.map((p) => (p === '?' ? params[cursor++] : p.replace(/^'|'$/g, '')));
        return (row) => values.some((v) => String(row[column]) === String(v));
      }

      m = clause.match(/^\((.*)\)$/);
      if (m && m[1].includes(' LIKE ?')) {
        const likes = m[1].split(/\s+OR\s+/).map((part) => {
          const cm = part.match(/"([a-z_][a-z0-9_]*)"\s+LIKE\s+\?/);
          assert.ok(cm, `unsupported LIKE part: ${part}`);
          return { column: cm[1], value: String(params[cursor++]).replace(/%/g, '') };
        });
        return (row) => likes.some(({ column, value }) =>
          String(row[column] ?? '').toLowerCase().includes(value.toLowerCase()));
      }

      m = clause.match(/^"([a-z_][a-z0-9_]*)"\s*=\s*\?$/);
      if (m) {
        const column = m[1];
        const value = params[cursor++];
        return (row) => String(row[column]) === String(value);
      }
      throw new Error(`mockD1: unsupported WHERE clause: ${clause}`);
    });
    return { matches: (row) => tests.every((t) => t(row)), cursor };
  }

  function prepare(sql) {
    let params = [];
    const executor = {
      bind(...values) { params = values; return executor; },
      async all() {
        const result = execute(sql, params);
        return { results: result.rows, success: true };
      },
      async first() {
        const result = execute(sql, params);
        return result.rows[0] || null;
      },
      async run() {
        const result = execute(sql, params);
        return { success: true, meta: { changes: result.changes } };
      }
    };
    return executor;
  }

  function execute(sql, params) {
    // GROUP BY aggregate (native aggregate path) — table name is unquoted here.
    const groupMatch = sql.match(/^SELECT status, COUNT\(\*\) AS count FROM ([a-z_][a-z0-9_]*) GROUP BY status$/);
    if (groupMatch) {
      const counts = {};
      (tables[groupMatch[1]] || []).forEach((row) => { counts[row.status] = (counts[row.status] || 0) + 1; });
      return { rows: Object.keys(counts).map((status) => ({ status, count: counts[status] })), changes: 0 };
    }

    let m = sql.match(/^SELECT\s+(.+?)\s+FROM\s+"?([a-z_][a-z0-9_]*)"?(.*)$/i);
    if (m) {
      const table = m[2];
      let tail = m[3].trim();
      let orderBy = null;
      let descending = true;
      let limit = 0;
      let offset = 0;
      let cursor = 0;

      const orderMatch = tail.match(/\s+ORDER BY\s+"?([a-z_][a-z0-9_]*)"?\s+(ASC|DESC)/i);
      if (orderMatch) {
        orderBy = orderMatch[1];
        descending = orderMatch[2].toUpperCase() === 'DESC';
        tail = tail.replace(orderMatch[0], '');
      }
      const offsetMatch = tail.match(/\s+OFFSET\s+(\?|\d+)/i);
      if (offsetMatch) {
        offset = Number(offsetMatch[1] === '?' ? params[params.length - 1] : offsetMatch[1]);
        tail = tail.replace(offsetMatch[0], '');
      }
      const limitMatch = tail.match(/\s+LIMIT\s+(\?|\d+)/i);
      if (limitMatch) {
        const idx = limitMatch[1] === '?' ? params.length - 1 - (offsetMatch ? 1 : 0) : limitMatch[1];
        limit = Number(limitMatch[1] === '?' ? params[idx] : idx);
        tail = tail.replace(limitMatch[0], '');
      }

      const whereMatch = tail.match(/^\s*WHERE\s+(.*?)\s*$/);
      let matches = () => true;
      if (whereMatch) {
        const built = buildPredicate(whereMatch[1], params, cursor);
        matches = built.matches;
        cursor = built.cursor;
      }
      let rows = (tables[table] || []).filter(matches).map((r) => ({ ...r }));
      if (orderBy) {
        rows.sort((a, b) => {
          if (a[orderBy] === b[orderBy]) return 0;
          return (a[orderBy] > b[orderBy] ? 1 : -1) * (descending ? -1 : 1);
        });
      }
      if (offset) rows = rows.slice(offset);
      if (limit) rows = rows.slice(0, limit);
      return { rows, changes: 0 };
    }

    m = sql.match(/^INSERT INTO "([a-z_][a-z0-9_]*)" \(([^)]*)\) VALUES \((.*)\)$/);
    if (m) {
      const table = m[1];
      const columns = m[2].split(',').map((s) => s.trim().replace(/"/g, ''));
      const count = m[3].split(',').length;
      if (!tables[table]) tables[table] = [];
      const row = {};
      columns.forEach((c, i) => { row[c] = params[i]; });
      tables[table].push(row);
      return { rows: [row], changes: 1 };
    }

    m = sql.match(/^UPDATE "([a-z_][a-z0-9_]*)" SET (.*?) WHERE (.*)$/);
    if (m) {
      const table = m[1];
      const sets = m[2].split(',').map((s) => s.trim().match(/^"([a-z_][a-z0-9_]*)"\s*=\s*\?$/));
      let cursor = 0;
      const updates = sets.map((sm) => {
        assert.ok(sm, `unsupported SET: ${m[2]}`);
        return { column: sm[1], value: params[cursor++] };
      });
      const pkMatch = m[3].match(/^"([a-z_][a-z0-9_]*)"\s*=\s*\?/);
      assert.ok(pkMatch, `unsupported UPDATE WHERE: ${m[3]}`);
      const pk = pkMatch[1];
      const id = params[cursor++];
      const hasVersion = /AND "version" = \?/.test(m[3]);
      const expectedVersion = hasVersion ? params[cursor++] : null;
      let changes = 0;
      (tables[table] || []).forEach((row) => {
        if (String(row[pk]) !== String(id)) return;
        if (hasVersion && Number(row.version) !== Number(expectedVersion)) return;
        updates.forEach(({ column, value }) => { row[column] = value; });
        changes++;
      });
      return { rows: [], changes };
    }

    throw new Error(`mockD1: unsupported SQL: ${sql}`);
  }

  return { prepare, tables };
}

const ENV = { GAS_SHARED_SECRET: '', GAS_URL: '' };
const CTX = { requestId: 'REQ', actor: { userId: 'admin', role: 'ADMIN' } };

function seed() {
  return mockD1({
    books: [
      { book_id: 'B1', book_number: 'BK-1', status: 'AVAILABLE', version: 1, is_deleted: 0 },
      { book_id: 'B2', book_number: 'BK-2', status: 'ASSIGNED', version: 1, is_deleted: 0 },
      { book_id: 'B3', book_number: 'BK-3', status: 'AVAILABLE', version: 2, is_deleted: 1 }
    ],
    receipts: [
      { receipt_id: 'R1', receipt_number: 'RC-1', status: 'COLLECTED', collector_id: 'C1',
        customer_name: 'Acme', amount_minor: 500, version: 1, is_deleted: 0 },
      { receipt_id: 'R2', receipt_number: 'RC-2', status: 'DEPOSITED_HQ', collector_id: 'C2',
        customer_name: 'Beta', amount_minor: 900, version: 1, is_deleted: 0 }
    ],
    users: [
      { user_id: 'U1', username: 'admin', status: 'ACTIVE', version: 1, is_deleted: 0 }
    ],
    custody_ledger: [],
    alerts: [
      { alert_id: 'A1', status: 'OPEN' },
      { alert_id: 'A2', status: 'OPEN' },
      { alert_id: 'A3', status: 'ACK' }
    ]
  });
}

function adapter(db = seed()) {
  return new D1RepositoryAdapter(db, { ...CTX, env: ENV });
}

/* -------------------------------------------------------------------------- */
/* Contract                                                                     */
/* -------------------------------------------------------------------------- */

test('D1 adapter satisfies the 8-method Repository contract', () => {
  assert.doesNotThrow(() => assertRepository(D1RepositoryAdapter.prototype));
  for (const method of REPOSITORY_METHODS) {
    assert.equal(typeof D1RepositoryAdapter.prototype[method], 'function');
  }
  assert.equal(typeof D1RepositoryAdapter.prototype.call, 'function'); // escape hatch
});

test('createRepository selects D1 only with the explicit flag; default stays Sheets', () => {
  const sheetsRepo = createRepository(ENV, CTX);
  assert.ok(sheetsRepo instanceof Repository);

  const d1Env = { ...ENV, REPOSITORY_ADAPTER: 'd1', DB: seed() };
  const d1Repo = createRepository(d1Env, CTX);
  assert.ok(d1Repo instanceof D1RepositoryAdapter);

  const stringEnv = { ...ENV, REPOSITORY_ADAPTER: 'sheets', DB: seed() };
  assert.ok(createRepository(stringEnv, CTX) instanceof Repository);
});

/* -------------------------------------------------------------------------- */
/* list / get                                                                    */
/* -------------------------------------------------------------------------- */

test('list() returns canonical shape and excludes soft-deleted rows', async () => {
  const result = await adapter().list('books');
  assert.equal(result.ok, true);
  assert.deepEqual(result.meta, {});
  assert.equal(result.data.length, 2); // B3 is is_deleted=1
  assert.deepEqual(result.data.map((r) => r.book_id).sort(), ['B1', 'B2']);
});

test('list() includes deleted rows on request', async () => {
  const result = await adapter().list('books', { includeDeleted: true });
  assert.equal(result.data.length, 3);
});

test('list() filters equality, arrays, search and applies order/limit/offset', async () => {
  const repo = adapter();
  const byStatus = await repo.list('books', { status: 'AVAILABLE' });
  assert.deepEqual(byStatus.data.map((r) => r.book_id), ['B1']);

  const inArray = await repo.list('books', { book_id: ['B1', 'B2'] }, { orderBy: 'book_id', descending: false });
  assert.deepEqual(inArray.data.map((r) => r.book_id), ['B1', 'B2']);

  const searched = await repo.list('receipts', { search: 'acme' });
  assert.deepEqual(searched.data.map((r) => r.receipt_id), ['R1']);

  const paged = await repo.list('books', {}, { orderBy: 'book_id', descending: false, limit: 1, offset: 1 });
  assert.deepEqual(paged.data.map((r) => r.book_id), ['B2']);
});

test('get() returns the row and version, or NOT_FOUND', async () => {
  const repo = adapter();
  const found = await repo.get('books', 'B1');
  assert.equal(found.ok, true);
  assert.equal(found.data.book_id, 'B1');
  assert.equal(found.meta.version, 1);

  await assert.rejects(() => repo.get('books', 'missing'), (err) =>
    err.code === 'NOT_FOUND' && err.status === 404);
});

/* -------------------------------------------------------------------------- */
/* insert / update / transition                                                   */
/* -------------------------------------------------------------------------- */

test('insert() generates id, version and timestamps and returns the row', async () => {
  const repo = adapter();
  const result = await repo.insert('receipts', { receipt_number: 'RC-9', status: 'UNUSED', amount_minor: 100 });
  assert.equal(result.ok, true);
  assert.ok(result.data.receipt_id.startsWith('REC_'));
  assert.equal(result.data.version, 1);
  assert.ok(result.data.created_at);
  assert.ok(result.data.updated_at);

  const fetched = await repo.get('receipts', result.data.receipt_id);
  assert.equal(fetched.data.receipt_number, 'RC-9');
});

test('update() bumps version and rejects stale versions (CONFLICT_VERSION)', async () => {
  const repo = adapter();
  const updated = await repo.update('books', 'B1', { status: 'COMPLETED' }, 1);
  assert.equal(updated.data.status, 'COMPLETED');
  assert.equal(updated.data.version, 2);
  assert.equal(updated.meta.version, 2);

  await assert.rejects(() => repo.update('books', 'B1', { status: 'AVAILABLE' }, 1), (err) =>
    err.code === 'CONFLICT_VERSION' && err.status === 409);
  await assert.rejects(() => repo.update('books', 'missing', { status: 'AVAILABLE' }, 1), (err) =>
    err.code === 'NOT_FOUND');
});

test('update() refuses append-only tables', async () => {
  const repo = adapter();
  await assert.rejects(() => repo.update('audit_logs', 'A1', { result: 'SUCCESS' }), (err) =>
    err.code === 'APPEND_ONLY' && err.status === 409);
});

test('transition() validates the state machine and appends an explicit ledger entry', async () => {
  const db = seed();
  const repo = adapter(db);
  await assert.rejects(() => repo.transition('receipts', 'R1', 'DEPOSITED_HQ'), (err) =>
    err.code === 'VALIDATION_ERROR');

  const result = await repo.transition('receipts', 'R1', 'DEPOSITED_BRANCH', {
    entry: { holder_id: 'C1', direction: 'DEBIT', count_delta: 1 }
  });
  assert.equal(result.data.status, 'DEPOSITED_BRANCH');
  assert.equal(db.tables.custody_ledger.length, 1);
  assert.ok(db.tables.custody_ledger[0].ledger_id);
});

/* -------------------------------------------------------------------------- */
/* aggregate / appendLedger / transaction                                         */
/* -------------------------------------------------------------------------- */

test('aggregate() serves native aggregates and delegates unknown names to GAS', async () => {
  const repo = adapter();
  const summary = await repo.aggregate('alertSummary');
  assert.equal(summary.ok, true);
  assert.equal(summary.data.byStatus.OPEN, 2);
  assert.equal(summary.data.total, 3);

  const transit = await repo.aggregate('receiptsInTransit');
  assert.equal(transit.data.items.length, 1);
  assert.equal(transit.data.items[0].receipt_id, 'R1');

  // No GAS config in ENV → the escape hatch fails closed, never silently local.
  await assert.rejects(() => repo.aggregate('dashboardSummary'), (err) =>
    err.code === 'D1_CALL_UNAVAILABLE');
});

test('appendLedger() writes an append-only custody ledger row', async () => {
  const db = seed();
  const result = await adapter(db).appendLedger({ holder_id: 'C1', direction: 'CREDIT', count_delta: 2 });
  assert.equal(result.ok, true);
  assert.ok(result.data.ledger_id);
  assert.equal(db.tables.custody_ledger.length, 1);
});

test('withTransaction() exposes the fluent API and commits the canonical shape', async () => {
  const repo = adapter();
  const empty = await repo.withTransaction().commit();
  assert.deepEqual(empty, { ok: true, data: {}, meta: { rowsAffected: 0 } });

  const tx = repo.withTransaction()
    .insert('books', { book_number: 'BK-9', status: 'AVAILABLE' })
    .update('books', 'B1', { status: 'COMPLETED' }, 1)
    .appendLedger({ holder_id: 'C1', direction: 'DEBIT', count_delta: 1 });
  // `call()` is part of the fluent API; verify it queues without needing GAS.
  tx.call('audit.chainStatus', 'audit_logs', {});
  assert.ok(tx instanceof D1Transaction);
  assert.equal(tx.operations.length, 4);
  tx.operations.pop(); // drop the GAS-only call so commit stays local

  const result = await tx.commit();
  assert.equal(result.ok, true);
  assert.equal(result.data.results.length, 3);
  assert.equal(result.meta.rowsAffected, 3);
  assert.ok(result.data.results.every((r) => r.ok === true));
  await assert.rejects(() => tx.commit(), /already committed/);
});

/* -------------------------------------------------------------------------- */
/* Safety                                                                       */
/* -------------------------------------------------------------------------- */

test('unknown entities are rejected and unsafe orderBy is ignored (no SQL injection)', async () => {
  const repo = adapter();
  await assert.rejects(() => repo.list('books; DROP TABLE users'), (err) => err.code === 'UNKNOWN_ENTITY');
  // Non-column / injection-shaped orderBy is ignored safely, never interpolated.
  const ignored = await repo.list('books', {}, { orderBy: 'status; DROP TABLE users' });
  assert.equal(ignored.ok, true);
  const stillThere = await repo.list('users');
  assert.equal(stillThere.data.length, 1); // users table was never touched
});
