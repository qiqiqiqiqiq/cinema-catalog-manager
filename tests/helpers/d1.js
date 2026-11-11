import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// SQLite-backed D1 adapter for transactional unit tests. This deliberately does
// not claim to emulate all Cloudflare D1 behavior; Miniflare tests cover D1 too.
export function createTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../fixtures/base-schema.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0001_stage1_p0.sql', import.meta.url), 'utf8'));
  const db = {
    sqlite,
    beforeBatch: null,
    failBatchAt: null,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { return { ...statement, values }; },
        async all() { return execute(statement); },
        async first(column) {
          const row = execute(statement).results[0] ?? null;
          return column ? row?.[column] ?? null : row;
        },
        async run() { return execute(statement); },
      };
      // Bind returns a new statement whose methods must read that statement.
      statement.bind = (...values) => {
        const bound = { ...statement, values };
        bound.all = async () => execute(bound);
        bound.first = async column => {
          const row = execute(bound).results[0] ?? null;
          return column ? row?.[column] ?? null : row;
        };
        bound.run = async () => execute(bound);
        return bound;
      };
      return statement;
    },
    async batch(statements) {
      if (db.beforeBatch) await db.beforeBatch(statements);
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement, index) => {
          if (db.failBatchAt === index) throw new Error('injected_storage_failure');
          return execute(statement);
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    exec(sql) { sqlite.exec(sql); },
    close() { sqlite.close(); },
  };
  function execute(statement) {
    const query = sqlite.prepare(statement.sql);
    const results = query.all(...statement.values);
    return { success: true, results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
  }
  return db;
}

export function seedWork(db, {
  id = 'movie_1', videoId = 'video000001', title = 'Synthetic title',
  status = 'approved', lastOkAt = '2026-11-01T00:00:00.000Z',
  createdAt = lastOkAt, retentionDeadline = '2026-12-01T00:00:00.000Z',
} = {}) {
  db.sqlite.prepare(`INSERT INTO works
    (id,youtube_video_id,status,created_at,updated_at) VALUES (?,?,?,?,?)`)
    .run(id, videoId, status, createdAt, createdAt);
  db.sqlite.prepare(`INSERT INTO api_metadata
    (work_id,video_id,title,fetch_status,last_ok_at,last_attempt_at,retention_deadline)
    VALUES (?,?,?,'ok',?,?,?)`).run(id, videoId, title, lastOkAt, lastOkAt, retentionDeadline);
}
