import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { createTestDb, seedWork } from './helpers/d1.js';

function setup(t, initial = '2026-11-11T00:00:00.000Z') {
  const db = createTestDb();
  t.after(() => db.close());
  let now = initial, sequence = 0;
  const service = createService(db, { now: () => now, uuid: () => `event_${++sequence}` });
  return { db, service, at(value) { now = value; } };
}
function row(db, sql, ...values) { return db.sqlite.prepare(sql).get(...values); }
function count(db, table) { return row(db, `SELECT COUNT(*) AS count FROM ${table}`).count; }
function apiMovie(id = 'movie_1', genre = 'Approved genre') { return { id, genre, titleMode: 'api' }; }
async function approve(service, movies = [apiMovie()], queue = []) {
  return service.approve({ expectedGeneration: (await service.state()).generation, movies, queue });
}
async function observe(service, status, extra = {}) {
  return service.applyMetadata({ expectedGeneration: (await service.state()).generation,
    observations: [{ workId: 'movie_1', status, ...extra }] });
}
const finishVerified = { outcome: 'verified', deployed: true, libraryMatches: true, queueMatches: true, phase: 'verify' };

test('bootstrap never exposes opaque legacy snapshots; explicit approval purges bodies and advances high-water mark', async t => {
  const { db, service } = setup(t);
  seedWork(db);
  db.sqlite.prepare(`INSERT INTO publication_snapshots VALUES (9,?,'verified',?)`).run('{"secretLegacyTitle":"Legacy copy"}', '2026-11-01T00:00:00Z');
  db.sqlite.exec('UPDATE ccm_state SET revision=9');
  await assert.rejects(service.publication(), { code: 'not_initialized' });
  const state = await approve(service);
  assert.equal(state.revision, 10);
  assert.equal(state.generation, 1);
  const publication = await service.publication();
  assert.equal(typeof publication.libraryJson, 'string');
  assert.equal(JSON.parse(publication.libraryJson).movies[0].title, 'Synthetic title');
  assert.equal(count(db, 'publication_snapshots'), 1);
  assert.equal(count(db, 'ccm_publication_requests'), 1);
  assert.ok(!row(db, 'SELECT snapshot_json FROM publication_snapshots').snapshot_json.includes('Legacy copy'));
});

test('published API updates preserve approved manual title/genre/queue and exclude draft edits', async t => {
  const { db, service } = setup(t);
  seedWork(db);
  seedWork(db, { id: 'movie_2', videoId: 'video000002', title: 'Other API title' });
  await approve(service, [apiMovie(), { id: 'movie_2', genre: 'Frozen genre', titleMode: 'manual', manualTitle: 'Approved manual' }],
    [{ id: 'queue_1', movieId: 'movie_1' }, { id: 'queue_2', movieId: 'movie_2' }]);
  db.sqlite.prepare(`INSERT INTO genres VALUES ('genre_draft','Unapproved genre',NULL,1)`).run();
  db.sqlite.prepare(`UPDATE works SET genre_id='genre_draft',status='held',review_memo='Unapproved note' WHERE id='movie_1'`).run();
  db.sqlite.prepare(`INSERT INTO queue_items VALUES ('unapproved_queue','movie_2',0)`).run();
  await service.applyMetadata({ expectedGeneration: 1, observations: [
    { workId: 'movie_1', status: 'ok', title: 'Refreshed API title' },
    { workId: 'movie_2', status: 'ok', title: 'Other refreshed title' },
  ] });
  const publication = await service.publication();
  assert.deepEqual(JSON.parse(publication.libraryJson).movies.map(movie => [movie.title, movie.genre]),
    [['Refreshed API title', 'Approved genre'], ['Approved manual', 'Frozen genre']]);
  assert.deepEqual(JSON.parse(publication.queueJson).queue.map(item => item.id), ['queue_1', 'queue_2']);
  assert.equal(row(db, `SELECT review_memo FROM works WHERE id='movie_1'`).review_memo, 'Unapproved note');
  assert.equal(count(db, 'publication_snapshots'), 1);
});

test('metadata freshness updates generation without inventing a changed publication revision', async t => {
  const { db, service } = setup(t);
  seedWork(db);
  await approve(service);
  const state = await observe(service, 'ok', { title: 'Synthetic title' });
  assert.equal(state.generation, 2);
  assert.equal(state.revision, 1);
  assert.equal(row(db, 'SELECT last_ok_at FROM api_metadata').last_ok_at, '2026-11-11T00:00:00.000Z');
  assert.equal(count(db, 'ccm_publication_requests'), 1);
});

test('CAS race rolls back every later statement instead of treating zero updated rows as success', async t => {
  const { db, service } = setup(t);
  seedWork(db);
  await approve(service);
  let triggered = false;
  db.beforeBatch = statements => {
    if (!triggered && statements[0].sql.includes('INSERT INTO ccm_cas_guards')) {
      triggered = true;
      db.sqlite.exec('UPDATE ccm_state SET generation=generation+1');
    }
  };
  await assert.rejects(service.applyMetadata({ expectedGeneration: 1,
    observations: [{ workId: 'movie_1', status: 'ok', title: 'Must not persist' }] }), { status: 409, code: 'revision_conflict' });
  assert.equal(row(db, 'SELECT title FROM api_metadata').title, 'Synthetic title');
  assert.equal(row(db, 'SELECT revision FROM ccm_state').revision, 1);
  assert.equal(count(db, 'publication_snapshots'), 1);
  assert.equal(count(db, 'ccm_publication_requests'), 1);
  assert.equal(count(db, 'ccm_cas_guards'), 0);
});

test('stale explicit generation rejects approval without replacing projection', async t => {
  const { db, service } = setup(t);
  seedWork(db);
  await approve(service);
  await assert.rejects(service.approve({ expectedGeneration: 0, movies: [], queue: [] }), { code: 'revision_conflict' });
  assert.equal(count(db, 'ccm_approved_movies'), 1);
});

test('queue identity cannot be rebound to another movie across approvals', async t => {
  const { db, service } = setup(t);
  seedWork(db); seedWork(db, { id: 'movie_2', videoId: 'video000002' });
  await approve(service, [apiMovie(), apiMovie('movie_2')], [{ id: 'stable_queue', movieId: 'movie_1' }]);
  await approve(service, [], []);
  await assert.rejects(approve(service, [apiMovie('movie_2')], [{ id: 'stable_queue', movieId: 'movie_2' }]), { code: 'queue_id_reused' });
});

test('removed queue IDs cannot be re-added even for the same movie; active IDs survive reordering', async t => {
  const { db, service } = setup(t); seedWork(db);
  const first = { id: 'queue_1', movieId: 'movie_1' }, second = { id: 'queue_2', movieId: 'movie_1' };
  await approve(service, [apiMovie()], [first, second]);
  await approve(service, [apiMovie()], [second, first]);
  assert.deepEqual(JSON.parse((await service.publication()).queueJson).queue, [second, first]);
  await approve(service, [apiMovie()], [second]);
  await assert.rejects(approve(service, [apiMovie()], [first, second]), { code: 'queue_id_retired' });
  assert.deepEqual(JSON.parse((await service.publication()).queueJson).queue, [second]);
});

test('bootstrap can retain a known legacy queue ID for its original movie only', async t => {
  const { db, service } = setup(t);
  seedWork(db); seedWork(db, { id: 'movie_2', videoId: 'video000002' });
  db.sqlite.exec("INSERT INTO queue_items VALUES ('legacy_queue','movie_1',0)");
  db.sqlite.exec("INSERT INTO ccm_queue_identities VALUES ('legacy_queue','movie_1')");
  await assert.rejects(approve(service, [apiMovie('movie_2')], [{ id: 'legacy_queue', movieId: 'movie_2' }]), { code: 'queue_id_reused' });
  await approve(service, [apiMovie()], [{ id: 'legacy_queue', movieId: 'movie_1' }]);
  assert.deepEqual(JSON.parse((await service.publication()).queueJson).queue, [{ id: 'legacy_queue', movieId: 'movie_1' }]);
});

test('unavailable confirmation keeps first anchor, ignores same-time duplicates/errors, and honors 24h boundary', async t => {
  const { db, service, at } = setup(t);
  seedWork(db); await approve(service);
  await observe(service, 'unavailable');
  await observe(service, 'unavailable');
  assert.equal(row(db, 'SELECT missing_count FROM ccm_metadata_state').missing_count, 1);
  at('2026-11-11T01:00:00.000Z'); await observe(service, 'unavailable');
  at('2026-11-11T12:00:00.000Z'); await observe(service, 'api_error');
  assert.equal(row(db, 'SELECT last_ok_at FROM api_metadata').last_ok_at, '2026-11-01T00:00:00.000Z');
  assert.equal(row(db, 'SELECT missing_count FROM ccm_metadata_state').missing_count, 2);
  at('2026-11-11T23:59:59.000Z'); await observe(service, 'unavailable');
  assert.equal((await service.deleteEligible({ expectedGeneration: (await service.state()).generation })).removedCount, 0);
  at('2026-11-12T00:00:00.000Z'); await observe(service, 'unavailable');
  const result = await service.deleteEligible({ expectedGeneration: (await service.state()).generation });
  assert.equal(result.removedCount, 1);
  assert.equal(row(db, 'SELECT reason_code FROM deletion_audit').reason_code, 'unavailable_confirmed');
});

test('successful refresh resets missing observations', async t => {
  const { db, service, at } = setup(t);
  seedWork(db);
  await observe(service, 'unavailable');
  at('2026-11-12T00:00:00.000Z'); await observe(service, 'ok', { title: 'Recovered' });
  at('2026-11-12T01:00:00.000Z'); await observe(service, 'unavailable');
  assert.equal(row(db, 'SELECT first_missing_at FROM ccm_metadata_state').first_missing_at, '2026-11-12T01:00:00.000Z');
  assert.equal((await service.deleteEligible({ expectedGeneration: (await service.state()).generation })).removedCount, 0);
});

test('API errors alone do not confirm unavailability, but deadline deletion still applies without extensions', async t => {
  const { db, service, at } = setup(t);
  seedWork(db); await approve(service);
  db.sqlite.exec("UPDATE api_metadata SET extension_used=1, retention_deadline='2027-01-01T00:00:00.000Z'");
  await observe(service, 'api_error');
  at('2026-11-12T00:00:00.000Z'); await observe(service, 'api_error');
  assert.equal((await service.deleteEligible({ expectedGeneration: (await service.state()).generation })).removedCount, 0);
  at('2026-11-28T00:00:00.000Z');
  assert.equal((await service.deleteEligible({ expectedGeneration: (await service.state()).generation })).removedCount, 1);
  assert.equal(row(db, 'SELECT reason_code FROM deletion_audit').reason_code, 'metadata_expired');
});

test('deletion atomically purges identities, metadata, discoveries, both queues and snapshot copies with durable outbox', async t => {
  const { db, service, at } = setup(t);
  seedWork(db, { title: 'Sensitive synthetic title' });
  await approve(service, [apiMovie()], [{ id: 'queue_1', movieId: 'movie_1' }, { id: 'queue_2', movieId: 'movie_1' }]);
  db.sqlite.exec("INSERT INTO queue_items VALUES ('queue_1','movie_1',0),('queue_3','movie_1',1)");
  db.sqlite.exec("INSERT INTO discoveries(work_id,condition_text,discovered_at) VALUES ('movie_1','Synthetic rule','2026-11-01T00:00:00Z')");
  db.sqlite.prepare(`INSERT INTO publication_snapshots VALUES (0,?,'deployed','2026-11-01T00:00:00Z')`).run('Sensitive synthetic title');
  const stalePlan = await service.refreshPlan(['movie_1']);
  at('2026-11-28T00:00:00.000Z');
  const result = await service.deleteEligible({ expectedGeneration: stalePlan.generation });
  assert.equal(result.removedCount, 1); assert.equal(result.revision, 2); assert.equal(result.needsDeployment, true);
  for (const table of ['works','api_metadata','discoveries','queue_items','ccm_approved_movies','ccm_approved_queue']) assert.equal(count(db, table), 0);
  assert.equal(count(db, 'publication_snapshots'), 1);
  assert.deepEqual(JSON.parse((await service.publication()).libraryJson), { version: 1, movies: [] });
  assert.deepEqual(JSON.parse((await service.publication()).queueJson), { version: 1, queue: [] });
  const audit = row(db, 'SELECT * FROM deletion_audit');
  assert.equal(audit.removed_queue_entries, 3); assert.equal(audit.publication_status, 'pending');
  assert.ok(!JSON.stringify(audit).includes('video000001'));
  assert.ok(!JSON.stringify(audit).includes('Sensitive synthetic title'));
  assert.equal(row(db, 'SELECT status FROM ccm_publication_requests WHERE revision=2').status, 'pending');
  await assert.rejects(service.applyMetadata({ expectedGeneration: stalePlan.generation,
    observations: [{ workId: 'movie_1', status: 'ok', title: 'Delayed response' }] }), { code: 'revision_conflict' });
  await assert.rejects(service.applyMetadata({ expectedGeneration: result.generation,
    observations: [{ workId: 'movie_1', status: 'ok', title: 'Delayed response' }] }), { code: 'unknown_work' });
  await assert.rejects(service.refreshPlan(['movie_1']), { code: 'unknown_work' });
  assert.deepEqual(Object.keys(row(db, 'SELECT * FROM ccm_tombstones')).sort(), ['deleted_at','work_id']);
});

test('failed deletion batch restores all rows, snapshot, generation and requests', async t => {
  const { db, service, at } = setup(t);
  seedWork(db); await approve(service);
  at('2026-11-28T00:00:00.000Z');
  db.beforeBatch = statements => { if (statements[0].sql.includes('INSERT INTO ccm_cas_guards')) db.failBatchAt = 8; };
  await assert.rejects(service.deleteEligible({ expectedGeneration: 1 }), { code: 'storage_error' });
  db.failBatchAt = null; db.beforeBatch = null;
  assert.equal(count(db, 'works'), 1); assert.equal(count(db, 'api_metadata'), 1);
  assert.equal(count(db, 'deletion_audit'), 0); assert.equal(count(db, 'ccm_tombstones'), 0);
  assert.equal(count(db, 'ccm_publication_requests'), 1);
  assert.equal((await service.state()).generation, 1);
});

test('invalid timestamps fail closed and expired publication is unavailable until deletion', async t => {
  const { db, service, at } = setup(t);
  seedWork(db); await approve(service);
  db.sqlite.exec("UPDATE api_metadata SET last_ok_at='2026-02-30T00:00:00Z'");
  await assert.rejects(service.publication(), { code: 'invalid_metadata_time' });
  await assert.rejects(service.deleteEligible({ expectedGeneration: 1 }), { code: 'invalid_metadata_time' });
  assert.equal(count(db, 'works'), 1);
  db.sqlite.exec("UPDATE api_metadata SET last_ok_at='2026-11-01T00:00:00.000Z'");
  at('2026-12-01T00:00:00.000Z');
  await assert.rejects(service.publication(), { code: 'metadata_expired' });
});

test('approval rejects duplicates, unapproved works, reused queue identifiers and unknown references', async t => {
  const { db, service } = setup(t); seedWork(db, { status: 'held' });
  await assert.rejects(approve(service), { code: 'work_not_approved' });
  db.sqlite.exec("UPDATE works SET status='approved'");
  await assert.rejects(approve(service, [apiMovie(),apiMovie()]), { code: 'invalid_request' });
  await assert.rejects(approve(service, [apiMovie()], [{ id: 'q_1', movieId: 'missing' }]), { code: 'invalid_request' });
  assert.equal((await service.state()).initialized, false);
});

test('50 observations use a bounded number of D1 statements', async t => {
  const { db, service } = setup(t);
  for (let n=0;n<50;n++) seedWork(db, { id: `movie_${n}`, videoId: `test${String(n).padStart(7,'0')}` });
  let statements = 0;
  db.beforeBatch = batch => { statements += batch.length; };
  await service.applyMetadata({ expectedGeneration: 0,
    observations: Array.from({ length: 50 }, (_, n) => ({ workId: `movie_${n}`, status: 'ok', title: `Synthetic ${n}` })) });
  assert.ok(statements <= 50, `used ${statements} statements`);
  assert.equal(row(db, "SELECT COUNT(*) AS count FROM api_metadata WHERE last_ok_at='2026-11-11T00:00:00.000Z'").count, 50);
});

test('deployment is locked, authorization is required and a successful pair persists verified status', async t => {
  const { db, service } = setup(t); seedWork(db); await approve(service);
  assert.deepEqual(await service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 }), { attemptId: '100-1', revision: 1 });
  assert.deepEqual(await service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 }), { attemptId: '100-1', revision: 1 });
  await assert.rejects(service.beginDeployment({ attemptId: '101-1', expectedRevision: 1 }), { code: 'deployment_locked' });
  await assert.rejects(service.finishDeployment('100-1', finishVerified), { code: 'not_authorized' });
  await service.authorizeDeployment('100-1');
  await assert.rejects(service.finishDeployment('100-1', { ...finishVerified, queueMatches: false }), { code: 'invalid_request' });
  assert.deepEqual(await service.finishDeployment('100-1', finishVerified), { outcome: 'verified', revision: 1 });
  assert.equal((await service.state()).verifiedRevision, 1);
  assert.equal((await service.state()).needsDeployment, false);
  assert.equal((await service.state()).activeAttemptId, null);
  assert.equal(row(db, 'SELECT status FROM publication_snapshots').status, 'verified');
  assert.equal(row(db, 'SELECT status FROM ccm_publication_requests').status, 'verified');
});

test('revision changes invalidate authorization and stale completed target cannot verify newer state', async t => {
  const { db, service } = setup(t); seedWork(db); await approve(service);
  await service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 });
  await service.authorizeDeployment('100-1');
  await observe(service, 'ok', { title: 'Newer target' });
  await assert.rejects(service.authorizeDeployment('100-1'), { code: 'revision_conflict' });
  assert.deepEqual(await service.finishDeployment('100-1', finishVerified), { outcome: 'superseded', revision: 1 });
  assert.equal((await service.state()).verifiedRevision, 0);
  assert.equal((await service.state()).revision, 2);
  assert.equal(row(db, 'SELECT status FROM publication_snapshots').status, 'pending');
  assert.equal(row(db, 'SELECT status FROM ccm_publication_requests WHERE revision=2').status, 'pending');
});

test('terminal callback exact replay is idempotent and altered callback cannot regress state', async t => {
  const { db, service } = setup(t); seedWork(db); await approve(service);
  await service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 });
  await service.authorizeDeployment('100-1'); await service.finishDeployment('100-1', finishVerified);
  assert.deepEqual(await service.finishDeployment('100-1', finishVerified), { outcome: 'verified', revision: 1 });
  await assert.rejects(service.finishDeployment('100-1', { ...finishVerified, outcome: 'failed', errorCode: 'deployment_failed' }), { code: 'attempt_closed' });
  await assert.rejects(service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 }), { code: 'attempt_closed' });
  assert.equal((await service.state()).verifiedRevision, 1);
});

test('uncertain external deployment persists its result but keeps the global lock indefinitely', async t => {
  const { db, service, at } = setup(t); seedWork(db); await approve(service);
  await service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 });
  await service.authorizeDeployment('100-1');
  const result = { outcome: 'uncertain', deployed: false, libraryMatches: false, queueMatches: false,
    errorCode: 'deployment_unknown', phase: 'deploy' };
  await service.finishDeployment('100-1', result);
  at('2026-11-20T00:00:00.000Z');
  assert.equal((await service.state()).activeAttemptId, '100-1');
  await assert.rejects(service.beginDeployment({ attemptId: '101-1', expectedRevision: 1 }), { code: 'deployment_locked' });
  await assert.rejects(service.authorizeDeployment('100-1'), { code: 'attempt_not_active' });
  assert.equal(row(db, 'SELECT outcome FROM ccm_deployment_attempts').outcome, 'uncertain');
  assert.equal(row(db, 'SELECT status FROM publication_snapshots').status, 'failed');
  assert.deepEqual(await service.finishDeployment('100-1', result), { outcome: 'uncertain', revision: 1 });
});

test('callback storage failure does not release deployment lock or report success', async t => {
  const { db, service } = setup(t); seedWork(db); await approve(service);
  await service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 });
  await service.authorizeDeployment('100-1');
  db.beforeBatch = statements => { if (statements[0].sql.includes('INSERT INTO ccm_cas_guards')) db.failBatchAt = 3; };
  await assert.rejects(service.finishDeployment('100-1', finishVerified), { code: 'storage_error' });
  db.beforeBatch = null; db.failBatchAt = null;
  assert.equal((await service.state()).activeAttemptId, '100-1');
  assert.equal((await service.state()).verifiedRevision, 0);
  assert.equal(row(db, 'SELECT outcome FROM ccm_deployment_attempts').outcome, null);
  await service.finishDeployment('100-1', finishVerified);
  assert.equal((await service.state()).verifiedRevision, 1);
});

test('verification failure after known deploy releases lock but remains unverified; latest verify covers pending deletion audits', async t => {
  const { db, service, at } = setup(t); seedWork(db); await approve(service);
  at('2026-11-28T00:00:00.000Z'); await service.deleteEligible({ expectedGeneration: 1 });
  await service.beginDeployment({ attemptId: '100-1', expectedRevision: 2 }); await service.authorizeDeployment('100-1');
  await service.finishDeployment('100-1', { ...finishVerified, outcome: 'failed', queueMatches: false, errorCode: 'verification_failed' });
  assert.equal((await service.state()).activeAttemptId, null);
  assert.equal((await service.state()).needsDeployment, true);
  assert.equal(row(db, 'SELECT publication_status FROM deletion_audit').publication_status, 'failed');
  await service.beginDeployment({ attemptId: '101-1', expectedRevision: 2 }); await service.authorizeDeployment('101-1');
  await service.finishDeployment('101-1', finishVerified);
  assert.equal(row(db, 'SELECT publication_status FROM deletion_audit').publication_status, 'verified');
});

test('healthy published metadata persists alongside an expired member while export and authorization stay blocked', async t => {
  const { db, service, at } = setup(t);
  seedWork(db);
  seedWork(db, { id: 'movie_2', videoId: 'video000002', title: 'Another title' });
  await approve(service, [apiMovie(), apiMovie('movie_2')]);
  at('2026-12-01T00:00:00.000Z');
  const result = await observe(service, 'ok', { title: 'Healthy refreshed title' });
  assert.equal(result.generation, 2);
  assert.equal(result.revision, 2);
  assert.equal(row(db, "SELECT title FROM api_metadata WHERE work_id='movie_1'").title, 'Healthy refreshed title');
  assert.equal(row(db, "SELECT last_ok_at FROM api_metadata WHERE work_id='movie_1'").last_ok_at, '2026-12-01T00:00:00.000Z');
  assert.equal(row(db, "SELECT last_ok_at FROM api_metadata WHERE work_id='movie_2'").last_ok_at, '2026-11-01T00:00:00.000Z');
  await assert.rejects(service.publication(), { code: 'metadata_expired' });
  await service.beginDeployment({ attemptId: '100-1', expectedRevision: 2 });
  await assert.rejects(service.authorizeDeployment('100-1'), { code: 'metadata_expired' });
  await service.finishDeployment('100-1', { outcome: 'failed', deployed: false,
    libraryMatches: false, queueMatches: false, errorCode: 'revision_check_failed', phase: 'authorize' });
  const cleanup = await service.deleteEligible({ expectedGeneration: 2 });
  assert.equal(cleanup.removedCount, 1);
  assert.deepEqual(JSON.parse((await service.publication()).libraryJson).movies.map(item => item.title), ['Healthy refreshed title']);
});

test('finish accepts only the shared fixed operational error codes and phases', async t => {
  const { db, service } = setup(t); seedWork(db); await approve(service);
  await service.beginDeployment({ attemptId: '100-1', expectedRevision: 1 });
  const failed = { outcome: 'failed', deployed: false, libraryMatches: false, queueMatches: false };
  for (const errorCode of ['deployment_uncertain', 'https://example.invalid/', 'Synthetic title']) {
    await assert.rejects(service.finishDeployment('100-1', { ...failed, errorCode, phase: 'deploy' }), { code: 'invalid_request' });
  }
  await assert.rejects(service.finishDeployment('100-1', { ...failed, errorCode: 'deployment_failed', phase: 'unknown' }), { code: 'invalid_request' });
  assert.equal((await service.state()).activeAttemptId, '100-1');
  await service.finishDeployment('100-1', { ...failed, errorCode: 'prepare_failed', phase: 'prepare' });
  assert.equal(row(db, 'SELECT error_code FROM ccm_deployment_attempts').error_code, 'prepare_failed');
});

test('existing explicit positive-offset dates support approval, export and refresh without data normalization', async t => {
  const { db, service } = setup(t);
  const original = '2026-11-10T09:03:41+09:00';
  const originalDeadline = '2026-12-10T09:03:41+09:00';
  seedWork(db, { lastOkAt: original, createdAt: original, retentionDeadline: originalDeadline });
  await approve(service);
  assert.equal(JSON.parse((await service.publication()).libraryJson).movies.length, 1);
  assert.equal((await service.deleteEligible({ expectedGeneration: 1 })).removedCount, 0);
  let metadata = row(db, 'SELECT * FROM api_metadata');
  assert.equal(metadata.last_ok_at, original);
  assert.equal(metadata.last_attempt_at, original);
  assert.equal(metadata.retention_deadline, originalDeadline);
  assert.equal(row(db, 'SELECT created_at FROM works').created_at, original);
  await observe(service, 'api_error');
  metadata = row(db, 'SELECT * FROM api_metadata');
  assert.equal(metadata.last_ok_at, original);
  assert.equal(metadata.retention_deadline, originalDeadline);
  assert.equal(metadata.last_attempt_at, '2026-11-11T00:00:00.000Z');
  await observe(service, 'ok', { title: 'Refreshed after offset date' });
  metadata = row(db, 'SELECT * FROM api_metadata');
  assert.equal(metadata.last_ok_at, '2026-11-11T00:00:00.000Z');
  assert.equal(metadata.retention_deadline, '2026-12-11T00:00:00.000Z');
  assert.equal(row(db, 'SELECT created_at FROM works').created_at, original);
});

test('negative offsets, milliseconds and zero offsets compare as UTC instants and new timestamps use Z', async t => {
  const { db, service } = setup(t, '2026-11-11T09:03:41.123+09:00');
  seedWork(db, { lastOkAt: '2026-11-10T19:03:41.123-05:00',
    createdAt: '2026-11-10T19:03:41.123-05:00', retentionDeadline: '2026-12-11T00:03:41.123+00:00' });
  await approve(service);
  assert.equal(JSON.parse((await service.publication()).libraryJson).movies.length, 1);
  await observe(service, 'ok', { title: 'Same instant refresh' });
  assert.equal(row(db, 'SELECT last_ok_at FROM api_metadata').last_ok_at, '2026-11-11T00:03:41.123Z');
  assert.equal(row(db, 'SELECT retention_deadline FROM api_metadata').retention_deadline, '2026-12-11T00:03:41.123Z');
});

test('offset retention deadlines obey the exact UTC deletion boundary', async t => {
  const { db, service, at } = setup(t, '2026-11-27T23:59:59.999Z');
  seedWork(db, { lastOkAt: '2026-11-01T09:00:00+09:00',
    retentionDeadline: '2026-11-30T19:00:00-05:00' });
  await approve(service);
  assert.equal((await service.deleteEligible({ expectedGeneration: 1 })).removedCount, 0);
  at('2026-11-28T00:00:00.000Z');
  assert.equal((await service.deleteEligible({ expectedGeneration: 1 })).removedCount, 1);
  assert.equal(row(db, 'SELECT deleted_at FROM deletion_audit').deleted_at, '2026-11-28T00:00:00.000Z');
});

test('offset missing-observation anchors use elapsed UTC time for the 24-hour rule', async t => {
  const { db, service, at } = setup(t, '2026-11-12T00:00:00.000Z');
  seedWork(db);
  db.sqlite.prepare(`INSERT INTO ccm_metadata_state VALUES ('movie_1',?,?,2)`).run(
    '2026-11-11T09:00:00+09:00', '2026-11-11T18:59:59.999-05:00');
  assert.equal((await service.deleteEligible({ expectedGeneration: 0 })).removedCount, 0);
  await observe(service, 'unavailable');
  assert.equal(row(db, 'SELECT first_missing_at FROM ccm_metadata_state').first_missing_at, '2026-11-11T09:00:00+09:00');
  assert.equal(row(db, 'SELECT last_missing_at FROM ccm_metadata_state').last_missing_at, '2026-11-12T00:00:00.000Z');
  assert.equal((await service.deleteEligible({ expectedGeneration: 1 })).removedCount, 1);
  at('2026-11-12T09:00:00+09:00');
  assert.equal((await service.state()).generation, 2);
});

test('explicit-offset parser rejects invalid calendar/time/offset values and missing timezone', async t => {
  const { db, service } = setup(t);
  seedWork(db);
  const invalid = [
    '2026-02-30T09:00:00+09:00', '2024-02-30T09:00:00+09:00', '2025-02-29T09:00:00+09:00',
    '1900-02-29T09:00:00+09:00', '2026-04-31T09:00:00+09:00', '2026-00-01T09:00:00+09:00',
    '2026-13-01T09:00:00+09:00', '2026-11-00T09:00:00+09:00', '2026-11-32T09:00:00+09:00',
    '2026-11-01T24:00:00+09:00', '2026-11-01T09:60:00+09:00', '2026-11-01T09:00:60+09:00',
    '2026-11-01T09:00:00+24:00', '2026-11-01T09:00:00+09:60', '2026-11-01T09:00:00-24:00',
    '2026-11-01T09:00:00+0900', '2026-11-01T09:00:00+9:00', '2026-11-01T09:00:00',
    '2026-11-01T09:00:00.1+09:00', '2026-11-01T09:00:00.12+09:00', '2026-11-01T09:00:00.1234+09:00',
    '2026-11-01 09:00:00+09:00', '2026-11-01T09:00:00z',
  ];
  for (const value of invalid) {
    db.sqlite.prepare('UPDATE api_metadata SET last_ok_at=?').run(value);
    await assert.rejects(approve(service), { code: 'invalid_metadata_time' }, value);
    assert.equal((await service.state()).initialized, false);
  }
});

test('valid Gregorian leap dates with explicit offsets remain accepted', async t => {
  const { db, service } = setup(t, '2024-03-01T00:00:00.000Z');
  seedWork(db, { lastOkAt: '2024-02-29T09:00:00+09:00', createdAt: '2024-02-29T09:00:00+09:00',
    retentionDeadline: '2024-03-30T09:00:00+09:00' });
  await approve(service);
  assert.equal(JSON.parse((await service.publication()).libraryJson).movies.length, 1);
  assert.equal(row(db, 'SELECT last_ok_at FROM api_metadata').last_ok_at, '2024-02-29T09:00:00+09:00');
});
