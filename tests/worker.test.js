import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../src/worker.js';
import {durationSeconds, fetchMetadata, quotaDay} from '../src/youtube.js';

const ADMIN = 'a'.repeat(48), DEPLOY = 'd'.repeat(48);
const env = {DB: {}, CCM_ADMIN_TOKEN: ADMIN, CCM_DEPLOY_TOKEN: DEPLOY, YOUTUBE_API_KEY: 'synthetic-key'};
function req(path, {token = ADMIN, value, method = value === undefined ? 'GET' : 'POST', headers = {}} = {}) {
  return new Request(`https://worker.invalid${path}`, {method,
    headers: {Authorization: `Bearer ${token}`, ...(value !== undefined ? {'Content-Type': 'application/json'} : {}), ...headers},
    ...(value !== undefined ? {body: JSON.stringify(value)} : {})});
}
function fake(overrides = {}) {
  return createWorker({serviceFactory: () => ({state: async () => ({revision: 7}), ...overrides}), reserve: async () => true});
}
test('unauthorized requests cannot read state or trigger service calls', async () => {
  let calls = 0;
  const worker = fake({state: async () => {calls++;}});
  const result = await worker.fetch(req('/v1/state', {token: 'incorrect'}), env);
  assert.equal(result.status, 401); assert.equal(calls, 0);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
});
test('separate admin and deploy credentials enforce scopes', async () => {
  const worker = fake();
  assert.equal((await worker.fetch(req('/v1/approvals', {token: DEPLOY, value: {}}), env)).status, 403);
  assert.equal((await worker.fetch(req('/v1/deployments/begin', {value: {}}), env)).status, 403);
  assert.equal((await worker.fetch(req('/v1/state', {token: DEPLOY}), env)).status, 200);
  assert.equal((await worker.fetch(req('/v1/state'), {...env, CCM_ADMIN_TOKEN: DEPLOY})).status, 503);
});
test('misconfiguration and unexpected failures do not expose data or keys', async () => {
  const result = await fake({state: async () => {throw new Error('secret-key, private-title, https://youtube.example/video');}})
    .fetch(req('/v1/state'), env);
  assert.deepEqual(await result.json(), {error: {code: 'internal_error'}});
  assert.equal((await fake().fetch(req('/v1/state'), {...env, RETENTION_DAYS: '1'})).status, 503);
  assert.equal((await fake().fetch(req('/v1/state'), {...env, CCM_DEPLOY_TOKEN: ''})).status, 503);
});
test('approval rejects unexpected fields and invalid IDs before storage', async () => {
  let calls = 0;
  const worker = fake({approve: async () => {calls++;}});
  const value = {expectedGeneration: 0, movies: [{id: 'movie_1', genre: '映画', titleMode: 'api', url: 'https://other.invalid'}], queue: []};
  assert.equal((await worker.fetch(req('/v1/approvals', {value}), env)).status, 400);
  delete value.movies[0].url; value.movies[0].manualTitle = 'Unapproved override';
  assert.equal((await worker.fetch(req('/v1/approvals', {value}), env)).status, 400);
  assert.equal(calls, 0);
});
test('body limit applies to streaming bodies with no Content-Length', async () => {
  const value = {workIds: ['x'.repeat(300000)]};
  assert.equal((await fake().fetch(req('/v1/metadata/refresh', {value}), env)).status, 413);
});
test('finish accepts only fixed error codes, not metadata in error strings', async () => {
  const value = {outcome: 'failed', deployed: false, libraryMatches: false, queueMatches: false, errorCode: 'video_abcdefghijk'};
  assert.equal((await fake().fetch(req('/v1/deployments/100-1/finish', {token: DEPLOY, value}), env)).status, 400);
});
test('YouTube budget stops the request before the external call', async () => {
  let calls = 0, writes = 0;
  const worker = createWorker({reserve: async () => false, fetcher: async () => {calls++;},
    serviceFactory: () => ({refreshPlan: async () => ({generation: 3, targets: [{workId: 'movie_1', videoId: 'AAAAAAAAAAA'}]}),
      applyMetadata: async () => {writes++;}})});
  assert.equal((await worker.fetch(req('/v1/metadata/refresh', {value: {workIds: ['movie_1']}}), env)).status, 429);
  assert.equal(calls, 0); assert.equal(writes, 0);
});
test('refresh applies the captured generation, not one read after the network', async () => {
  let applied;
  const worker = createWorker({reserve: async () => true,
    fetcher: async () => Response.json({kind: 'youtube#videoListResponse', items: []}),
    serviceFactory: () => ({refreshPlan: async () => ({generation: 3, targets: [{workId: 'movie_1', videoId: 'AAAAAAAAAAA'}]}),
      applyMetadata: async value => {applied = value; return {revision: 9};}})});
  const result = await worker.fetch(req('/v1/metadata/refresh', {value: {workIds: ['movie_1']}}), env);
  assert.equal(result.status, 200);
  assert.deepEqual(applied, {expectedGeneration: 3, observations: [{workId: 'movie_1', status: 'unavailable'}]});
});

const targets = [{workId: 'movie_1', videoId: 'AAAAAAAAAAA'}, {workId: 'movie_2', videoId: 'BBBBBBBBBBB'}];
const item = {id: 'AAAAAAAAAAA', snippet: {title: 'Synthetic title', channelId: 'UC_SYNTHETIC', channelTitle: 'Channel'}, contentDetails: {duration: 'PT1H2M3S'}};
test('successful validated response alone distinguishes missing video from API error', async () => {
  let requested;
  const observations = await fetchMetadata(targets, 'test-key', async (url, options) => {
    requested = {url, options};
    return Response.json({kind: 'youtube#videoListResponse', items: [item]});
  });
  assert.equal(observations[0].status, 'ok'); assert.equal(observations[0].durationSeconds, 3723);
  assert.equal(observations[1].status, 'unavailable');
  assert.equal(new URL(requested.url).origin, 'https://www.googleapis.com');
  assert.equal(new URL(requested.url).searchParams.has('key'), false);
  assert.equal(requested.options.headers['X-Goog-Api-Key'], 'test-key');
  assert.equal(requested.options.redirect, 'manual');
});
test('invalid metadata text becomes API error instead of failing the storage contract', async () => {
  for (const snippet of [{...item.snippet, title: ' '.repeat(10)},
    {...item.snippet, title: 'x'.repeat(501)}, {...item.snippet, channelTitle: ''},
    {...item.snippet, channelId: 'invalid\u0000value'}]) {
    const result = await fetchMetadata(targets, 'test-key', async () => Response.json({
      kind: 'youtube#videoListResponse', items: [{...item, snippet}]
    }));
    assert.ok(result.every(x => x.status === 'api_error'));
  }
});
test('HTTP errors, invalid JSON, duplicate IDs, unknown IDs and partial pages never count as unavailable', async () => {
  const bodies = [{items: []}, {kind: 'youtube#videoListResponse', items: [item, item]},
    {kind: 'youtube#videoListResponse', items: [{...item, id: 'CCCCCCCCCCC'}]},
    {kind: 'youtube#videoListResponse', items: [{id: item.id}]},
    {kind: 'youtube#videoListResponse', items: [], nextPageToken: 'partial'}];
  const fetchers = [async () => new Response('quota_exceeded', {status: 403}), async () => new Response('not json'),
    async () => {throw new Error('network');}, ...bodies.map(value => async () => Response.json(value))];
  for (const fetcher of fetchers) assert.ok((await fetchMetadata(targets, 'test-key', fetcher)).every(x => x.status === 'api_error'));
});
test('ISO durations and Pacific quota days handle boundaries', () => {
  assert.equal(durationSeconds('P1DT2H3M4S'), 93784);
  assert.equal(durationSeconds('PT0S'), 0);
  assert.equal(durationSeconds('P'), null);
  assert.equal(durationSeconds('PT'), null);
  assert.equal(durationSeconds('oops'), null);
  assert.equal(quotaDay('2026-11-11T07:59:59Z'), '2026-11-10');
  assert.equal(quotaDay('2026-11-11T08:00:00Z'), '2026-11-11');
  assert.equal(quotaDay('2026-07-11T06:59:59Z'), '2026-07-10');
  assert.equal(quotaDay('2026-07-11T07:00:00Z'), '2026-07-11');
});
