import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Miniflare, Log, LogLevel, Response as RuntimeResponse} from 'miniflare';
import {reserveApiUnit} from '../src/youtube.js';

const ADMIN = 'admin-integration-'.repeat(3), DEPLOY = 'deploy-integration-'.repeat(3);
const at = days => new Date(Date.now() + days * 86400000).toISOString();
async function sqlFile(db, path) {
  const sql = (await readFile(path, 'utf8')).replace(/--[^\n]*/g, '');
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    .filter(s => !/^CREATE TABLE _cf_KV\b/i.test(s)); // Cloudflare owns this internal table.
  await db.batch(statements.map(s => db.prepare(s)));
}
async function setup(t) {
  let apiMode = 'ok';
  const mf = new Miniflare({
    modules: true, modulesRules: [{type: 'ESModule', include: ['**/*.js']}],
    scriptPath: resolve('src/worker.js'), compatibilityDate: '2026-07-01',
    d1Databases: ['DB'], bindings: {CCM_ADMIN_TOKEN: ADMIN, CCM_DEPLOY_TOKEN: DEPLOY, YOUTUBE_API_KEY: 'synthetic-test-key'},
    log: new Log(LogLevel.NONE),
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://www.googleapis.com');
      assert.equal(request.headers.get('x-goog-api-key'), 'synthetic-test-key');
      if (apiMode === 'error') return new RuntimeResponse('quota denied', {status: 403});
      if (apiMode === 'malformed') return RuntimeResponse.json({items: []});
      return RuntimeResponse.json({kind: 'youtube#videoListResponse', items: apiMode === 'missing' ? [] :
        url.searchParams.get('id').split(',').map(id => ({id, snippet: {
          title: `更新済み ${id}`, channelId: 'UC_SYNTHETIC', channelTitle: 'Synthetic channel'
        }, contentDetails: {duration: 'PT5M'}}))});
    }
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await sqlFile(db, 'tests/fixtures/base-schema.sql');
  await sqlFile(db, 'migrations/0001_stage1_p0.sql');
  await sqlFile(db, 'migrations/0002_api_budget.sql');
  for (const [id, video] of [['movie_1', 'AAAAAAAAAAA'], ['movie_2', 'BBBBBBBBBBB']]) {
    await db.prepare(`INSERT INTO works(id,youtube_video_id,status,created_at,updated_at)
      VALUES (?,?,'approved',?,?)`).bind(id, video, at(-1), at(-1)).run();
    await db.prepare(`INSERT INTO api_metadata(work_id,video_id,title,fetch_status,last_ok_at,last_attempt_at,retention_deadline)
      VALUES (?,?,?,'ok',?,?,?)`).bind(id, video, `初期 ${id}`, at(-1), at(-1), at(29)).run();
  }
  async function call(path, value, token = ADMIN) {
    const response = await mf.dispatchFetch(`https://ccm.invalid${path}`, {
      method: value === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      ...(value === undefined ? {} : {body: JSON.stringify(value)})
    });
    return {status: response.status, body: await response.json()};
  }
  return {db, call, mode(value) {apiMode = value;}};
}
const projection = generation => ({expectedGeneration: generation,
  movies: [{id: 'movie_1', genre: '映画', titleMode: 'api'}, {id: 'movie_2', genre: '短編', titleMode: 'manual', manualTitle: '承認した上映名'}],
  queue: [{id: 'queue_1', movieId: 'movie_1'}, {id: 'queue_2', movieId: 'movie_1'}, {id: 'queue_3', movieId: 'movie_2'}]});

test('real local D1: approval, metadata, revision fencing, callback and deletion remain coherent', async t => {
  const {db, call, mode} = await setup(t);
  assert.equal((await call('/v1/state', undefined, 'wrong')).status, 401);
  assert.equal((await call('/v1/publication', undefined, DEPLOY)).status, 409);
  let result = await call('/v1/approvals', projection(0));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.revision, 1);
  await db.prepare("UPDATE works SET status='held',review_memo='unapproved' WHERE id='movie_1'").run();
  result = await call('/v1/metadata/refresh', {workIds: ['movie_1', 'movie_2']});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.refresh.ok, 2);
  const publication = (await call('/v1/publication', undefined, DEPLOY)).body;
  assert.equal(publication.revision, 2);
  assert.deepEqual(JSON.parse(publication.libraryJson).movies.map(m => [m.title, m.genre]),
    [['更新済み AAAAAAAAAAA', '映画'], ['承認した上映名', '短編']]);
  assert.equal(JSON.parse(publication.queueJson).queue.length, 3);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM publication_snapshots').first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM ccm_publication_requests').first()).n, 2);

  mode('malformed');
  result = await call('/v1/metadata/refresh', {workIds: ['movie_1']});
  assert.equal(result.status, 200); assert.equal(result.body.refresh.apiError, 1);
  assert.equal((await db.prepare("SELECT consecutive_unavailable n FROM api_metadata WHERE work_id='movie_1'").first()).n, 0);

  assert.equal((await call('/v1/deployments/begin', {attemptId: '100-1', expectedRevision: 2}, DEPLOY)).status, 200);
  assert.equal((await call('/v1/deployments/100-1/authorize', {}, DEPLOY)).status, 200);
  // An already-authorized old deployment may complete; it must never verify the newer deletion revision.
  await db.prepare("UPDATE api_metadata SET last_ok_at=?,retention_deadline=? WHERE work_id='movie_1'")
    .bind(at(-28), at(2)).run();
  const generation = (await call('/v1/state')).body.generation;
  result = await call('/v1/maintenance/delete-eligible', {expectedGeneration: generation});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.removedCount, 1);
  assert.equal(result.body.revision, 3);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM works WHERE id='movie_1'").first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM ccm_approved_queue').first()).n, 1);
  const current = await db.prepare('SELECT snapshot_json FROM publication_snapshots').first();
  assert.ok(!current.snapshot_json.includes('AAAAAAAAAAA'));
  assert.ok(!current.snapshot_json.includes('movie_1'));
  assert.equal((await call('/v1/metadata/refresh', {workIds: ['movie_1']})).status, 409);
  const finish = {outcome: 'verified', deployed: true, libraryMatches: true, queueMatches: true, phase: 'verify'};
  result = await call('/v1/deployments/100-1/finish', finish, DEPLOY);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.outcome, 'superseded');
  assert.equal((await call('/v1/state')).body.needsDeployment, true);
  assert.equal((await call('/v1/deployments/begin', {attemptId: '101-1', expectedRevision: 3}, DEPLOY)).status, 200);
  assert.equal((await call('/v1/deployments/101-1/authorize', {}, DEPLOY)).status, 200);
  result = await call('/v1/deployments/101-1/finish', finish, DEPLOY);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await call('/v1/state')).body.verifiedRevision, 3);
  assert.equal((await db.prepare('SELECT publication_status FROM deletion_audit').first()).publication_status, 'verified');
  assert.equal((await call('/v1/deployments/100-1/finish', finish, DEPLOY)).body.outcome, 'superseded');
  assert.equal((await call('/v1/state')).body.verifiedRevision, 3);
});

test('real local D1: concurrent approvals CAS, predeploy revalidation and atomic quota reservation', async t => {
  const {db, call} = await setup(t);
  const results = await Promise.all([call('/v1/approvals', projection(0)), call('/v1/approvals', projection(0))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409], JSON.stringify(results));
  assert.equal((await call('/v1/state')).body.generation, 1);
  assert.equal((await call('/v1/deployments/begin', {attemptId: '200-1', expectedRevision: 1}, DEPLOY)).status, 200);
  const next = projection(1); next.movies[0].genre = '承認済み変更';
  assert.equal((await call('/v1/approvals', next)).status, 200);
  assert.equal((await call('/v1/deployments/200-1/authorize', {}, DEPLOY)).status, 409);
  const finished = await call('/v1/deployments/200-1/finish', {outcome: 'superseded', deployed: false,
    libraryMatches: false, queueMatches: false, errorCode: 'revision_changed', phase: 'authorize'}, DEPLOY);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const reserved = await Promise.all(Array.from({length: 6}, () => reserveApiUnit(db, '2099-01-01T12:00:00Z', 2)));
  assert.equal(reserved.filter(Boolean).length, 2);
  assert.equal((await db.prepare("SELECT units FROM ccm_api_budget WHERE day_key='2099-01-01'").first()).units, 2);
});

test('real local D1: uncertain Pages failure records the result without allowing the next publisher', async t => {
  const {db, call} = await setup(t);
  assert.equal((await call('/v1/approvals', projection(0))).status, 200);
  await call('/v1/deployments/begin', {attemptId: '300-1', expectedRevision: 1}, DEPLOY);
  await call('/v1/deployments/300-1/authorize', {}, DEPLOY);
  const result = await call('/v1/deployments/300-1/finish', {outcome: 'uncertain', deployed: false,
    libraryMatches: false, queueMatches: false, errorCode: 'deployment_unknown', phase: 'deploy'}, DEPLOY);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await call('/v1/state')).body.activeAttemptId, '300-1');
  assert.equal((await db.prepare('SELECT outcome FROM ccm_deployment_attempts').first()).outcome, 'uncertain');
  assert.equal((await call('/v1/deployments/begin', {attemptId: '301-1', expectedRevision: 1}, DEPLOY)).status, 409);
});
