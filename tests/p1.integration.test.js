import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Miniflare, Log, LogLevel, Response as RuntimeResponse} from 'miniflare';

const ADMIN = 'p1-admin-integration-'.repeat(3);
const DEPLOY = 'p1-deploy-integration-'.repeat(3);
const MAINTENANCE = 'p1-maintenance-integration-'.repeat(3);
const START = '2030-01-01T00:00:00.000Z';
const HOUR = 3600000;

async function setup(t, bindings = {}) {
  let clock = START;
  let apiMode = 'ok';
  let title = 'Synthetic API title';
  const requestedVideos = [];
  const mf = new Miniflare({
    modules: true, modulesRules: [{type: 'ESModule', include: ['**/*.js']}],
    // Clock injection belongs only to this in-memory test entry point. The
    // production worker never reads x-test-clock or exposes a test-time API.
    scriptPath: resolve('tests/p1-test-runtime.js'),
    script: `import {createWorker} from '../src/worker.js';
      export default {fetch(request, env) {
        return createWorker({now: () => request.headers.get('x-test-clock')}).fetch(request, env);
      }};`,
    compatibilityDate: '2026-07-01', d1Databases: ['DB'],
    bindings: {CCM_ADMIN_TOKEN: ADMIN, CCM_DEPLOY_TOKEN: DEPLOY,
      CCM_MAINTENANCE_TOKEN: MAINTENANCE, YOUTUBE_API_KEY: 'synthetic-p1-key', ...bindings},
    log: new Log(LogLevel.NONE),
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://www.googleapis.com');
      assert.equal(request.headers.get('x-goog-api-key'), 'synthetic-p1-key');
      const videos = url.searchParams.get('id').split(',');
      requestedVideos.push(videos);
      if (apiMode === 'error') return new RuntimeResponse('synthetic unavailable API', {status: 503});
      if (apiMode === 'malformed') return RuntimeResponse.json({items: []});
      return RuntimeResponse.json({kind: 'youtube#videoListResponse',
        items: apiMode === 'missing' ? [] : videos.map(id => ({id,
          snippet: {title, channelId: 'UC_SYNTHETIC_P1', channelTitle: 'Synthetic channel'},
          contentDetails: {duration: 'PT5M'}}))});
    }
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  async function sqlFile(path) {
    const sql = (await readFile(path, 'utf8')).replace(/--[^\n]*/g, '');
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
      .filter(s => !/^CREATE TABLE _cf_KV\b/i.test(s));
    await db.batch(statements.map(s => db.prepare(s)));
  }
  await sqlFile('tests/fixtures/base-schema.sql');
  for (const filename of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await sqlFile(`migrations/${filename}`);
  }
  async function call(path, value, token = ADMIN) {
    const response = await mf.dispatchFetch(`https://ccm.invalid${path}`, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-test-clock': clock},
      ...(value === undefined ? {} : {body: JSON.stringify(value)})
    });
    return {status: response.status, body: await response.json()};
  }
  async function ok(path, value, token) {
    const result = await call(path, value, token);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  async function generation() { return (await ok('/v1/state')).generation; }
  async function discover(videoId, source = 'Synthetic manual intake') {
    return ok('/v1/discoveries', {expectedGeneration: await generation(),
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`, source});
  }
  async function review(workId, status, reviewMemo = 'Human decision') {
    return ok(`/v1/works/${workId}/review`, {expectedGeneration: await generation(), status, reviewMemo});
  }
  async function publish(attemptId) {
    const publication = await ok('/v1/publication', undefined, DEPLOY);
    await ok('/v1/deployments/begin', {attemptId, expectedRevision: publication.revision}, DEPLOY);
    await ok(`/v1/deployments/${attemptId}/authorize`, {}, DEPLOY);
    // The HTTP/CDN byte comparison is tested by the deployment-client suite.
    // Here the trusted deployment callback is the boundary under test.
    await ok(`/v1/deployments/${attemptId}/finish`, {outcome: 'verified', deployed: true,
      libraryMatches: true, queueMatches: true, phase: 'verify'}, DEPLOY);
    return publication;
  }
  return {db, call, ok, generation, discover, review, publish, requestedVideos,
    mode(value) {apiMode = value;}, title(value) {title = value;},
    hours(value) {clock = new Date(Date.parse(START) + value * HOUR).toISOString();}};
}

test('P1 real D1: URL discovery, human review, publication, confirmed removal and verified empty publication', async t => {
  const {db, call, ok, generation, discover, review, publish, mode, hours} = await setup(t);
  const discovered = await discover('AAAAAAAAAAA');
  const id = discovered.workId;
  assert.equal(discovered.created, true);
  assert.equal((await ok(`/v1/works/${id}`)).work.status, 'unreviewed');
  const approval = async (queueId = 'p1_queue_1', movieId = id) => ({expectedGeneration: await generation(),
    movies: [{id: movieId, genre: '短編', titleMode: 'api'}], queue: [{id: queueId, movieId}]});
  assert.equal((await call('/v1/approvals', await approval())).status, 409);
  assert.equal((await ok('/v1/metadata/refresh', {workIds: [id]})).refresh.ok, 1);
  await review(id, 'approved');
  await ok('/v1/approvals', await approval());
  const original = await publish('500-1');
  assert.deepEqual(JSON.parse(original.libraryJson).movies, [{id, genre: '短編',
    title: 'Synthetic API title', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA'}]);
  assert.deepEqual(JSON.parse(original.queueJson).queue, [{id: 'p1_queue_1', movieId: id}]);
  assert.equal((await ok('/v1/state')).needsDeployment, false);

  hours(1); mode('missing');
  assert.equal((await ok('/v1/metadata/refresh', {workIds: [id]})).refresh.unavailable, 1);
  assert.equal((await ok('/v1/maintenance/delete-eligible', {expectedGeneration: await generation()})).removedCount, 0);
  hours(2); mode('malformed');
  assert.equal((await ok('/v1/metadata/refresh', {workIds: [id]})).refresh.apiError, 1);
  assert.equal((await db.prepare('SELECT missing_count n FROM ccm_metadata_state WHERE work_id=?').bind(id).first()).n, 1);
  hours(24); mode('missing');
  await ok('/v1/metadata/refresh', {workIds: [id]});
  // Two misses separated by 23 hours are insufficient, even with an API error between them.
  assert.equal((await ok('/v1/maintenance/delete-eligible', {expectedGeneration: await generation()})).removedCount, 0);
  hours(25);
  await ok('/v1/metadata/refresh', {workIds: [id]});
  const removed = await ok('/v1/maintenance/delete-eligible', {expectedGeneration: await generation()});
  assert.equal(removed.removedCount, 1);
  assert.equal(removed.needsDeployment, true);
  for (const [table, column] of [['works', 'id'], ['api_metadata', 'work_id'], ['discoveries', 'work_id'],
    ['ccm_metadata_state', 'work_id'], ['ccm_approved_movies', 'work_id'], ['ccm_approved_queue', 'work_id'], ['queue_items', 'work_id']]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`).bind(id).first()).n, 0, table);
  }
  const audit = await db.prepare('SELECT * FROM deletion_audit WHERE work_id=?').bind(id).first();
  assert.equal(audit.reason_code, 'unavailable_confirmed');
  assert.equal(audit.removed_queue_entries, 1);
  assert.equal(audit.publication_status, 'pending');
  assert.ok(!JSON.stringify(audit).includes('AAAAAAAAAAA'));
  assert.ok(!JSON.stringify(audit).includes('Synthetic API title'));
  const removedPublication = await publish('501-1');
  assert.ok(removedPublication.revision > original.revision);
  assert.deepEqual(JSON.parse(removedPublication.libraryJson), {version: 1, movies: []});
  assert.deepEqual(JSON.parse(removedPublication.queueJson), {version: 1, queue: []});
  assert.equal((await db.prepare('SELECT publication_status FROM deletion_audit WHERE work_id=?').bind(id).first()).publication_status, 'verified');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM publication_snapshots').first()).n, 1);
  assert.equal((await ok('/v1/state')).needsDeployment, false);
  assert.equal((await call('/v1/metadata/refresh', {workIds: [id]})).status, 409);

  // Explicit rediscovery creates a fresh candidate; neither the deleted CCM ID
  // nor the retired queue identity is resurrected automatically.
  const rediscovered = await discover('AAAAAAAAAAA', 'Explicit new intake after removal');
  assert.notEqual(rediscovered.workId, id);
  assert.equal((await ok(`/v1/works/${rediscovered.workId}`)).work.status, 'unreviewed');
  mode('ok');
  await ok('/v1/metadata/refresh', {workIds: [rediscovered.workId]});
  await review(rediscovered.workId, 'approved');
  assert.equal((await call('/v1/approvals', await approval('p1_queue_1', rediscovered.workId))).status, 409);
  assert.deepEqual(JSON.parse((await ok('/v1/publication')).libraryJson).movies, []);
});

test('P1 real D1: rediscovery and metadata refresh preserve review, while credentials and generation fence human changes', async t => {
  const {call, ok, generation, discover, review, title} = await setup(t);
  const first = await discover('BBBBBBBBBBB');
  const id = first.workId;
  await ok('/v1/metadata/refresh', {workIds: [id]});
  await review(id, 'held', 'Do not publish before human review');
  const reviewed = (await ok(`/v1/works/${id}`)).work;
  const staleGeneration = await generation();
  const otherSource = await discover('BBBBBBBBBBB', 'Second independent intake');
  assert.equal(otherSource.created, false);
  assert.equal(otherSource.workId, id);
  assert.equal(otherSource.discoveryAdded, true);
  const repeated = await discover('BBBBBBBBBBB', 'Second independent intake');
  assert.equal(repeated.discoveryAdded, false);
  const detail = await ok(`/v1/works/${id}`);
  assert.equal(detail.discoveries.length, 2);
  assert.equal(detail.work.status, 'held');
  assert.equal(detail.work.reviewMemo, reviewed.reviewMemo);
  assert.equal((await call(`/v1/works/${id}/review`, {expectedGeneration: staleGeneration, status: 'approved'})).status, 409);
  for (const token of [DEPLOY, MAINTENANCE]) {
    assert.equal((await call('/v1/discoveries', {expectedGeneration: await generation(), videoUrl: 'CCCCCCCCCCC'}, token)).status, 403);
    assert.equal((await call(`/v1/works/${id}/review`, {expectedGeneration: await generation(), status: 'approved'}, token)).status, 403);
    assert.equal((await call('/v1/approved-configuration', undefined, token)).status, 403);
  }
  title('A new API title');
  await ok('/v1/metadata/refresh', {workIds: [id]});
  const refreshed = (await ok(`/v1/works/${id}`)).work;
  assert.equal(refreshed.metadata.title, 'A new API title');
  assert.equal(refreshed.status, 'held');
  assert.equal(refreshed.reviewMemo, reviewed.reviewMemo);
  assert.equal(refreshed.manualConfirmedAt, reviewed.manualConfirmedAt);
  assert.equal((await ok('/v1/works?status=held&limit=1')).works[0].id, id);
  await review(id, 'rejected');
  assert.equal((await ok('/v1/works?status=unreviewed')).works.length, 0);
  assert.equal((await ok('/v1/works?status=rejected')).works[0].id, id);
});

test('P1 real D1: persistent API failure does not confirm disappearance but retention cleanup still removes old data', async t => {
  const {db, ok, generation, discover, review, publish, mode, hours} = await setup(t);
  const id = (await discover('CCCCCCCCCCC')).workId;
  await ok('/v1/metadata/refresh', {workIds: [id]});
  await review(id, 'approved');
  await ok('/v1/approvals', {expectedGeneration: await generation(),
    movies: [{id, genre: '映画', titleMode: 'api'}], queue: []});
  await publish('600-1');
  mode('error'); hours(14 * 24);
  assert.equal((await ok('/v1/metadata/refresh', {workIds: [id]})).refresh.apiError, 1);
  let metadata = await db.prepare('SELECT * FROM api_metadata WHERE work_id=?').bind(id).first();
  assert.equal(metadata.last_ok_at, START);
  assert.equal(metadata.consecutive_unavailable, 0);
  assert.equal((await ok('/v1/maintenance/delete-eligible', {expectedGeneration: await generation()})).removedCount, 0);
  hours(27 * 24);
  await ok('/v1/metadata/refresh', {workIds: [id]});
  metadata = await db.prepare('SELECT * FROM api_metadata WHERE work_id=?').bind(id).first();
  assert.equal(metadata.last_ok_at, START);
  assert.equal(metadata.consecutive_unavailable, 0);
  assert.equal((await ok('/v1/maintenance/delete-eligible', {expectedGeneration: await generation()})).removedCount, 1);
  assert.equal((await db.prepare('SELECT reason_code FROM deletion_audit WHERE work_id=?').bind(id).first()).reason_code, 'metadata_expired');
  await publish('601-1');
  assert.equal((await ok('/v1/state')).needsDeployment, false);
});

test('P1 real D1: maintenance covers every review status, resumes past failed work and records bounded run results', async t => {
  const {db, call, ok, discover, review, mode, hours} = await setup(t);
  const ids = [];
  for (const [videoId, status] of [['DDDDDDDDDDD', 'unreviewed'], ['EEEEEEEEEEE', 'held'],
    ['FFFFFFFFFFF', 'rejected'], ['GGGGGGGGGGG', 'approved']]) {
    const id = (await discover(videoId)).workId;
    ids.push(id);
    if (status !== 'unreviewed') await review(id, status);
  }
  let plan = await ok('/v1/maintenance/plan', undefined, MAINTENANCE);
  assert.deepEqual(new Set(plan.workIds), new Set(ids));
  assert.equal(plan.totalCount, 4);
  assert.equal(plan.refreshIntervalDays, 13);
  assert.equal(plan.retryHours, 24);
  await ok('/v1/metadata/refresh', {workIds: ids}, MAINTENANCE);
  assert.equal((await ok('/v1/maintenance/plan', undefined, MAINTENANCE)).dueCount, 0);
  hours(13 * 24);
  plan = await ok('/v1/maintenance/plan', undefined, MAINTENANCE);
  assert.deepEqual(new Set(plan.workIds), new Set(ids));
  const failed = plan.workIds[0];
  const healthy = ids.filter(id => id !== failed);
  await ok('/v1/maintenance/runs/start', {runId: '700-1'}, MAINTENANCE);
  // A partially processed run can stop here. D1 freshness, not process memory,
  // determines which work a replacement run must resume.
  mode('error');
  await ok('/v1/metadata/refresh', {workIds: [failed]}, MAINTENANCE);
  plan = await ok('/v1/maintenance/plan', undefined, MAINTENANCE);
  assert.deepEqual(new Set(plan.workIds), new Set(healthy));
  mode('ok');
  await ok('/v1/metadata/refresh', {workIds: healthy}, MAINTENANCE);
  assert.equal((await ok('/v1/maintenance/plan', undefined, MAINTENANCE)).dueCount, 0);
  await ok('/v1/maintenance/runs/700-1/finish', {outcome: 'partial'}, MAINTENANCE);
  const status = await ok('/v1/maintenance/status', undefined, MAINTENANCE);
  assert.ok(status.lastRun);
  assert.ok(!JSON.stringify(status).includes('Synthetic API title'));
  assert.ok(!JSON.stringify(status).includes('DDDDDDDDDDD'));
  hours(14 * 24 - 1);
  assert.equal((await ok('/v1/maintenance/plan', undefined, MAINTENANCE)).dueCount, 0);
  hours(14 * 24);
  plan = await ok('/v1/maintenance/plan', undefined, MAINTENANCE);
  assert.deepEqual(plan.workIds, [failed]);
  await ok('/v1/maintenance/runs/start', {runId: '701-1'}, MAINTENANCE);
  await ok('/v1/metadata/refresh', {workIds: plan.workIds}, MAINTENANCE);
  await ok('/v1/maintenance/runs/701-1/finish', {outcome: 'success'}, MAINTENANCE);
  assert.equal((await ok('/v1/maintenance/plan', undefined, MAINTENANCE)).dueCount, 0);
  assert.deepEqual((await db.prepare('SELECT status FROM works ORDER BY status').all()).results.map(r => r.status),
    ['approved', 'held', 'rejected', 'unreviewed']);
  assert.equal((await call('/v1/maintenance/plan', undefined, DEPLOY)).status, 403);
  assert.equal((await call('/v1/deployments/begin', {attemptId: '702-1', expectedRevision: 0}, MAINTENANCE)).status, 403);
});

test('P1 real D1: trusted recovery unlocks an abandoned attempt without inventing a verified publication', async t => {
  const {db, call, ok, generation, discover, review, publish} = await setup(t);
  const id = (await discover('HHHHHHHHHHH')).workId;
  await ok('/v1/metadata/refresh', {workIds: [id]});
  await review(id, 'approved');
  const approved = await ok('/v1/approvals', {expectedGeneration: await generation(),
    movies: [{id, genre: '映画', titleMode: 'api'}], queue: []});
  await ok('/v1/deployments/begin', {attemptId: '800-1', expectedRevision: approved.revision}, DEPLOY);
  await ok('/v1/deployments/800-1/authorize', {}, DEPLOY);
  await ok('/v1/deployments/800-1/finish', {outcome: 'uncertain', deployed: false,
    libraryMatches: false, queueMatches: false, errorCode: 'deployment_unknown', phase: 'deploy'}, DEPLOY);
  assert.equal((await ok('/v1/deployments/active', undefined, DEPLOY)).attempt.attemptId, '800-1');
  assert.equal((await call('/v1/deployments/begin', {attemptId: '801-1', expectedRevision: approved.revision}, DEPLOY)).status, 409);
  const evidence = {runId: '800', runAttempt: 1, runConclusion: 'failure', pagesConclusion: 'success'};
  assert.equal((await call('/v1/deployments/800-1/recover', evidence, ADMIN)).status, 403);
  assert.equal((await call('/v1/deployments/800-1/recover', {...evidence, runAttempt: 2}, DEPLOY)).status, 409);
  assert.equal((await call('/v1/deployments/800-1/recover', {...evidence, pagesConclusion: 'cancelled'}, DEPLOY)).status, 400);
  // Only the deploy client may report this evidence, after checking the exact
  // terminal GitHub run and Pages step. Its checks have their own Python tests.
  await ok('/v1/deployments/800-1/recover', evidence, DEPLOY);
  const recovered = await ok('/v1/state');
  assert.equal(recovered.activeAttemptId, null);
  assert.equal(recovered.verifiedRevision, 0);
  assert.equal(recovered.needsDeployment, true);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM ccm_deployment_recoveries').first()).n, 1);
  await publish('801-1');
  await ok('/v1/deployments/800-1/recover', evidence, DEPLOY);
  assert.equal((await ok('/v1/state')).needsDeployment, false);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM ccm_deployment_recoveries').first()).n, 1);
  assert.equal((await call('/v1/deployments/800-1/finish', {outcome: 'verified', deployed: true,
    libraryMatches: true, queueMatches: true}, DEPLOY)).status, 409);
});

test('P1 real D1: configured retention applies to catalog display even without a legacy stored deadline', async t => {
  const {db, call, ok, generation, discover, review, hours} = await setup(t,
    {RETENTION_DAYS: '3', DELETION_GRACE_HOURS: '24'});
  const id = (await discover('IIIIIIIIIII')).workId;
  await ok('/v1/metadata/refresh', {workIds: [id]});
  await review(id, 'approved');
  // Historical rows may lack this optional stored value. The configured
  // retention period must still control both display and publication safety.
  await db.prepare('UPDATE api_metadata SET retention_deadline=NULL WHERE work_id=?').bind(id).run();
  hours(3 * 24);
  const detail = await ok(`/v1/works/${id}`);
  assert.equal(detail.work.metadata.expired, true);
  for (const field of ['title', 'channelId', 'channelName', 'durationSeconds']) {
    assert.equal(detail.work.metadata[field], null);
  }
  assert.equal((await ok('/v1/works')).works[0].metadata.title, null);
  assert.equal((await call('/v1/approvals', {expectedGeneration: await generation(),
    movies: [{id, genre: '映画', titleMode: 'api'}], queue: []})).status, 409);
  assert.equal((await ok('/v1/maintenance/delete-eligible', {expectedGeneration: await generation()})).removedCount, 1);
});
