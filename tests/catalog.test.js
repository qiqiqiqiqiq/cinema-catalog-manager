import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalog, parseVideoUrl} from '../src/catalog.js';
import {createService} from '../src/service.js';
import {createTestDb} from './helpers/d1.js';

function setup(t) {
  const db = createTestDb();
  t.after(() => db.close());
  let at = '2026-11-13T00:00:00.000Z', sequence = 0;
  const options = {now: () => at, uuid: () => `test_${++sequence}`};
  return {db, catalog: createCatalog(db, options), service: createService(db, options),
    at(value) { at = value; }};
}
async function discover(catalog, service, videoUrl = 'AAAAAAAAAAA', source) {
  return catalog.discover({expectedGeneration: (await service.state()).generation,
    videoUrl, ...(source === undefined ? {} : {source})});
}
async function review(catalog, service, workId, status, extra = {}) {
  return catalog.review(workId, {expectedGeneration: (await service.state()).generation, status, ...extra});
}
function count(db, table) { return db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; }

test('single URL parser normalizes only known HTTPS YouTube paths without fetching arbitrary hosts', () => {
  for (const url of ['AAAAAAAAAAA', 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=2',
    'https://youtu.be/AAAAAAAAAAA?si=human', 'https://m.youtube.com/shorts/AAAAAAAAAAA',
    'https://youtube.com/embed/AAAAAAAAAAA/', 'https://youtube.com/live/AAAAAAAAAAA']) {
    assert.equal(parseVideoUrl(url), 'AAAAAAAAAAA');
  }
  for (const url of ['http://youtube.com/watch?v=AAAAAAAAAAA', 'https://youtube.com.evil.test/watch?v=AAAAAAAAAAA',
    'https://www.youtube.com@evil.test/watch?v=AAAAAAAAAAA', 'https://user@youtube.com/watch?v=AAAAAAAAAAA',
    'https://youtube.com:444/watch?v=AAAAAAAAAAA', 'https://youtu.be/AAAAAAAAAAA/extra',
    'https://youtube.com/watch?v=AAAAAAAAAAA&v=BBBBBBBBBBB', 'https://evil.test/AAAAAAAAAAA',
    'https://youtube.com/watch?v=short', 'AAAAAAAAAAA\n', null]) {
    assert.throws(() => parseVideoUrl(url), {code: 'invalid_request'});
  }
});

test('discovery creates unreviewed work without accepting client metadata or publishing it', async t => {
  const {db, catalog, service} = setup(t);
  const result = await discover(catalog, service, 'https://youtu.be/AAAAAAAAAAA', 'Screening shortlist');
  assert.equal(result.created, true); assert.equal(result.discoveryAdded, true);
  assert.equal(result.generation, 1); assert.equal(result.initialized, false);
  const detail = await catalog.detail(result.workId);
  assert.equal(detail.work.status, 'unreviewed');
  assert.equal(detail.work.metadata.fetchStatus, 'unknown');
  assert.equal(detail.work.metadata.title, null);
  assert.equal(detail.work.published, false);
  assert.deepEqual(detail.discoveries.map(x => [x.method, x.source]), [['url', 'Screening shortlist']]);
  assert.equal(count(db, 'api_metadata'), 0);
  await assert.rejects(catalog.discover({expectedGeneration: 1, videoUrl: 'BBBBBBBBBBB', title: 'Client title'}),
    {code: 'invalid_request'});
  await assert.rejects(service.approve({expectedGeneration: 1,
    movies: [{id: result.workId, genre: 'Short', titleMode: 'api'}], queue: []}), {code: 'work_not_approved'});
});

test('rediscovery is idempotent for one source and preserves human review across new provenance', async t => {
  const {db, catalog, service} = setup(t);
  const initial = await discover(catalog, service);
  await review(catalog, service, initial.workId, 'rejected', {reviewMemo: 'Keep human decision'});
  const before = await catalog.detail(initial.workId);
  const retry = await discover(catalog, service, 'https://youtube.com/watch?v=AAAAAAAAAAA');
  assert.equal(retry.workId, initial.workId); assert.equal(retry.created, false);
  assert.equal(retry.discoveryAdded, false); assert.equal(retry.generation, 2);
  const other = await discover(catalog, service, 'AAAAAAAAAAA', 'Another human source');
  assert.equal(other.discoveryAdded, true); assert.equal(other.created, false);
  const after = await catalog.detail(initial.workId);
  assert.deepEqual(after.work, before.work);
  assert.equal(after.discoveries.length, 2); assert.equal(count(db, 'works'), 1);
  assert.equal(count(db, 'ccm_cas_guards'), 0);
});

test('human review supports all states; omitted fields preserve and explicit null clears', async t => {
  const {db, catalog, service} = setup(t);
  db.sqlite.exec("INSERT INTO genres(id,name,enabled) VALUES('short','Short',1),('disabled','Disabled',0)");
  const initial = await discover(catalog, service);
  await review(catalog, service, initial.workId, 'held', {genreId: 'short', reviewMemo: 'First line\nSecond line'});
  await review(catalog, service, initial.workId, 'approved');
  let {work} = await catalog.detail(initial.workId);
  assert.equal(work.status, 'approved'); assert.equal(work.genreId, 'short');
  assert.equal(work.reviewMemo, 'First line\nSecond line');
  assert.equal(work.manualConfirmedAt, '2026-11-13T00:00:00.000Z');
  assert.equal((await service.state()).revision, 0);
  await review(catalog, service, initial.workId, 'unreviewed', {genreId: null, reviewMemo: null});
  ({work} = await catalog.detail(initial.workId));
  assert.equal(work.genreId, null); assert.equal(work.reviewMemo, null);
  await assert.rejects(review(catalog, service, initial.workId, 'approved', {genreId: 'disabled'}), {code: 'unknown_genre'});
});

test('review remains draft until separate approval; approved configuration preserves order and manual title', async t => {
  const {catalog, service} = setup(t);
  const first = await discover(catalog, service), second = await discover(catalog, service, 'BBBBBBBBBBB');
  for (const id of [first.workId, second.workId]) await review(catalog, service, id, 'approved');
  await service.applyMetadata({expectedGeneration: (await service.state()).generation,
    observations: [first, second].map(x => ({workId: x.workId, status: 'ok', title: `API ${x.workId}`}))});
  const input = {expectedGeneration: (await service.state()).generation,
    movies: [{id: second.workId, genre: 'Film', titleMode: 'manual', manualTitle: 'Human title'},
      {id: first.workId, genre: 'Short', titleMode: 'api'}], queue: [{id: 'queue_1', movieId: first.workId}]};
  await service.approve(input);
  const publication = await service.publication();
  await review(catalog, service, first.workId, 'held', {reviewMemo: 'Draft only'});
  assert.deepEqual(await service.publication(), publication);
  const config = await catalog.approved();
  assert.deepEqual(config.movies, input.movies); assert.deepEqual(config.queue, input.queue);
  assert.equal(config.generation, (await service.state()).generation);
  assert.equal((await catalog.detail(first.workId)).work.published, true);
});

test('keyset pagination covers every work once and can filter review state', async t => {
  const {catalog, service} = setup(t);
  for (const video of ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC', 'DDDDDDDDDDD']) await discover(catalog, service, video);
  const first = await catalog.list({limit: 2});
  const second = await catalog.list({limit: 2, after: first.nextCursor});
  assert.equal(first.works.length, 2); assert.equal(second.works.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.works, ...second.works].map(x => x.id)).size, 4);
  await review(catalog, service, first.works[0].id, 'held');
  assert.deepEqual((await catalog.list({status: 'held'})).works.map(x => x.id), [first.works[0].id]);
});

test('discovery CAS conflict rolls back work, provenance and generation change', async t => {
  const {db, catalog} = setup(t);
  let raced = false;
  db.beforeBatch = statements => {
    if (!raced && statements[0].sql.includes('INSERT INTO ccm_cas_guards')) {
      raced = true; db.sqlite.exec('UPDATE ccm_state SET generation=generation+1');
    }
  };
  await assert.rejects(catalog.discover({expectedGeneration: 0, videoUrl: 'AAAAAAAAAAA'}), {code: 'revision_conflict'});
  assert.equal(count(db, 'works'), 0); assert.equal(count(db, 'discoveries'), 0);
  assert.equal(count(db, 'ccm_cas_guards'), 0);
});

test('failed discovery storage transaction leaves no orphan work', async t => {
  const {db, catalog} = setup(t);
  const previous = db.batch;
  db.batch = async statements => {
    db.failBatchAt = statements[0].sql.includes('INSERT INTO ccm_cas_guards') ? 2 : null;
    return previous(statements);
  };
  await assert.rejects(catalog.discover({expectedGeneration: 0, videoUrl: 'AAAAAAAAAAA'}), {code: 'storage_error'});
  db.failBatchAt = null;
  assert.equal(count(db, 'works'), 0); assert.equal(count(db, 'discoveries'), 0);
  assert.equal(db.sqlite.prepare('SELECT generation FROM ccm_state').get().generation, 0);
});

test('stale review cannot overwrite a concurrent reviewer', async t => {
  const {catalog, service} = setup(t);
  const {workId, generation} = await discover(catalog, service);
  await catalog.review(workId, {expectedGeneration: generation, status: 'rejected', reviewMemo: 'First reviewer'});
  await assert.rejects(catalog.review(workId, {expectedGeneration: generation, status: 'approved'}), {code: 'revision_conflict'});
  assert.equal((await catalog.detail(workId)).work.reviewMemo, 'First reviewer');
});

test('deleted identity never returns; explicit rediscovery creates a new unreviewed work', async t => {
  const {db, catalog, service, at} = setup(t);
  const original = await discover(catalog, service);
  await review(catalog, service, original.workId, 'approved');
  at('2026-12-11T00:00:00.000Z');
  const deletion = await service.deleteEligible({expectedGeneration: (await service.state()).generation});
  assert.equal(deletion.removedCount, 1);
  const rediscovered = await discover(catalog, service);
  assert.notEqual(rediscovered.workId, original.workId); assert.equal(rediscovered.created, true);
  assert.equal((await catalog.detail(rediscovered.workId)).work.status, 'unreviewed');
  assert.equal(count(db, 'ccm_tombstones'), 1);
  assert.equal(count(db, 'discoveries'), 1);
  await assert.rejects(catalog.detail(original.workId), {status: 404, code: 'unknown_work'});
});

test('expired API display fields are withheld pending maintenance deletion', async t => {
  const {catalog, service, at} = setup(t);
  const {workId} = await discover(catalog, service);
  await service.applyMetadata({expectedGeneration: (await service.state()).generation, observations: [
    {workId, status: 'ok', title: 'Synthetic title', channelId: 'Synthetic channel ID', channelName: 'Synthetic channel', durationSeconds: 60},
  ]});
  assert.equal((await catalog.detail(workId)).work.metadata.title, 'Synthetic title');
  at('2026-12-13T00:00:00.000Z');
  const {metadata} = (await catalog.detail(workId)).work;
  assert.equal(metadata.expired, true);
  assert.equal(metadata.title, null); assert.equal(metadata.channelId, null);
  assert.equal(metadata.channelName, null); assert.equal(metadata.durationSeconds, null);
  assert.equal((await catalog.list()).works[0].metadata.title, null);
});

test('invalid bounds, injected control characters and unsupported fields are rejected', async t => {
  const {catalog, service} = setup(t);
  for (const input of [{limit: 0}, {limit: 101}, {after: '../escape'}, {status: 'all'}, {offset: 1}]) {
    await assert.rejects(catalog.list(input), {code: 'invalid_request'});
  }
  await assert.rejects(catalog.discover({expectedGeneration: 0, videoUrl: 'AAAAAAAAAAA', source: 'line\ncontrol'}), {code: 'invalid_request'});
  const {workId} = await discover(catalog, service);
  for (const extra of [{reviewMemo: 'bad\0memo'}, {reviewMemo: 'a'.repeat(2001)}, {genreId: '../invalid'}, {title: 'injected'}]) {
    await assert.rejects(review(catalog, service, workId, 'held', extra), {code: 'invalid_request'});
  }
  await assert.rejects(catalog.review('unknown', {expectedGeneration: 1, status: 'held'}), {status: 404, code: 'unknown_work'});
});
