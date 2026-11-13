import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestDb, seedWork} from './helpers/d1.js';
import {createMaintenance} from '../src/maintenance.js';
import {createService} from '../src/service.js';

function setup(t) {
  const db = createTestDb(); t.after(() => db.close());
  for (const file of ['0004_maintenance.sql', '0005_deployment_recovery.sql']) {
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const now = () => '2026-11-15T00:00:00.000Z';
  return {db, maintenance: createMaintenance(db, {now}), service: createService(db, {now})};
}

test('maintenance plans all statuses in bounded batches, ordered by retention urgency, resuming from committed attempts', async t => {
  const {db, maintenance, service} = setup(t);
  for (let i = 0; i < 53; i++) seedWork(db, {id: `movie_${String(i).padStart(3, '0')}`,
    videoId: String(i).padStart(11, '0'), status: ['unreviewed','held','rejected','approved'][i % 4]});
  let plan = await maintenance.plan();
  assert.equal(plan.dueCount, 53); assert.equal(plan.workIds.length, 50);
  await service.applyMetadata({expectedGeneration: 0,
    observations: plan.workIds.map(workId => ({workId, status: 'api_error'}))});
  plan = await maintenance.plan();
  assert.equal(plan.dueCount, 3); assert.equal(plan.workIds.length, 3);
  const later = createMaintenance(db, {now: () => '2026-11-16T00:00:00.000Z'});
  assert.equal((await later.plan()).dueCount, 53);
  assert.equal(db.sqlite.prepare('SELECT MIN(last_ok_at) value FROM api_metadata').get().value, '2026-11-01T00:00:00.000Z');
});

test('maintenance run recording is idempotent, rejects competing final results and reveals an interrupted run', async t => {
  const {db, maintenance} = setup(t);
  await maintenance.start({runId: '123-1'});
  await maintenance.start({runId: '123-1'});
  const later = createMaintenance(db, {now: () => '2026-11-15T03:00:00.000Z'});
  assert.equal((await later.status()).lastRun.stale, true);
  await maintenance.finish('123-1', {outcome: 'partial', errorCode: 'api_error'});
  await maintenance.finish('123-1', {outcome: 'partial', errorCode: 'api_error'});
  await assert.rejects(maintenance.finish('123-1', {outcome: 'success'}), {code: 'run_closed'});
  assert.equal((await maintenance.status()).lastRun.status, 'partial');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM ccm_maintenance_runs').get().n, 1);
});

async function abandoned(t, uncertain = true) {
  const context = setup(t), {db, service} = context;
  seedWork(db);
  await service.approve({expectedGeneration: 0, movies: [{id: 'movie_1', genre: 'test', titleMode: 'api'}], queue: []});
  await service.beginDeployment({attemptId: '42-1', expectedRevision: 1});
  await service.authorizeDeployment('42-1');
  if (uncertain) await service.finishDeployment('42-1', {outcome: 'uncertain', deployed: false,
    libraryMatches: false, queueMatches: false, phase: 'deploy', errorCode: 'deployment_unknown'});
  return context;
}
const evidence = {runId: '42', runAttempt: 1, runConclusion: 'failure', pagesConclusion: 'success'};

test('recovery preserves original uncertain result, never marks verified and permits new current-revision publish', async t => {
  const {db, service} = await abandoned(t);
  assert.equal((await service.activeDeployment()).attempt.authorized, true);
  await service.recoverDeployment('42-1', evidence);
  await service.recoverDeployment('42-1', evidence);
  const state = await service.state();
  assert.equal(state.activeAttemptId, null); assert.equal(state.verifiedRevision, 0); assert.equal(state.needsDeployment, true);
  assert.equal(db.sqlite.prepare("SELECT outcome FROM ccm_deployment_attempts WHERE attempt_id='42-1'").get().outcome, 'uncertain');
  await service.beginDeployment({attemptId: '43-1', expectedRevision: 1});
  await assert.rejects(service.recoverDeployment('42-1', {...evidence, pagesConclusion: 'not_started'}), {code: 'recovery_closed'});
  assert.equal((await service.state()).activeAttemptId, '43-1');
});

test('recovery rejects unmatched run evidence and unresolved Pages termination, and rolls back on storage failure', async t => {
  const {db, service} = await abandoned(t, false);
  await assert.rejects(service.recoverDeployment('42-1', {...evidence, runAttempt: 2}), {code: 'recovery_identity_mismatch'});
  await assert.rejects(service.recoverDeployment('42-1', {...evidence, pagesConclusion: 'cancelled'}), {code: 'invalid_request'});
  db.failBatchAt = 2;
  await assert.rejects(service.recoverDeployment('42-1', evidence), {code: 'storage_error'});
  db.failBatchAt = null;
  assert.equal((await service.state()).activeAttemptId, '42-1');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM ccm_deployment_recoveries').get().n, 0);
});

test('recovery CAS cannot release a different deployment or race a metadata generation change', async t => {
  const {db, service} = await abandoned(t, false);
  db.beforeBatch = statements => {
    if (statements[0]?.sql.includes('INSERT INTO ccm_cas_guards')) {
      db.beforeBatch = null;
      db.exec('UPDATE ccm_state SET generation=generation+1 WHERE singleton=1');
    }
  };
  await assert.rejects(service.recoverDeployment('42-1', evidence), {code: 'revision_conflict'});
  assert.equal((await service.state()).activeAttemptId, '42-1');
});
