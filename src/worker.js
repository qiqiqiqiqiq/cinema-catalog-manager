import {createService} from './service.js';
import {boundedJson, fetchMetadata, reserveApiUnit} from './youtube.js';
import {createCatalog} from './catalog.js';
import {createMaintenance} from './maintenance.js';

const MAX_BODY = 262144;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OUTCOMES = new Set(['verified', 'failed', 'superseded', 'uncertain']);
const ERROR_CODES = new Set(['prepare_failed', 'revision_changed', 'revision_check_failed',
  'artifact_failed', 'deployment_unknown', 'deployment_failed', 'verification_failed',
  'public_fetch_failed', 'result_record_failed', 'cancelled']);
const PHASES = new Set(['prepare', 'authorize', 'deploy', 'verify', 'finish']);

function fail(status, code) { throw Object.assign(new Error(code), {status, code}); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))
      || required.some(k => !(k in value))) fail(400, 'invalid_request');
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function id(value) { return typeof value === 'string' && ID.test(value); }
function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function setting(value, fallback, minimum, maximum) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) fail(503, 'configuration_error');
  return n;
}
async function equalToken(actual, expected) {
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([actual, expected].map(s => crypto.subtle.digest('SHA-256', encode.encode(s))));
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < av.length; i++) mismatch |= av[i] ^ bv[i];
  return mismatch === 0;
}
async function role(request, env) {
  const admin = env.CCM_ADMIN_TOKEN, deploy = env.CCM_DEPLOY_TOKEN;
  if (typeof admin !== 'string' || admin.length < 32 || typeof deploy !== 'string'
      || deploy.length < 32 || admin === deploy) fail(503, 'configuration_error');
  const maintenance = env.CCM_MAINTENANCE_TOKEN;
  if (maintenance !== undefined && (typeof maintenance !== 'string' || maintenance.length < 32 ||
      maintenance === admin || maintenance === deploy)) fail(503, 'configuration_error');
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || auth.length > 1024) fail(401, 'unauthorized');
  const token = auth.slice(7);
  if (await equalToken(token, admin)) return 'admin';
  if (await equalToken(token, deploy)) return 'deploy';
  if (maintenance && await equalToken(token, maintenance)) return 'maintenance';
  fail(401, 'unauthorized');
}
function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  }});
}
async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'json_required');
  const length = request.headers.get('content-length');
  if (length && Number(length) > MAX_BODY) fail(413, 'payload_too_large');
  try { return await boundedJson(request, MAX_BODY); }
  catch (e) { fail(e.message === 'payload_too_large' ? 413 : 400, e.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json'); }
}
function approval(value) {
  keys(value, ['expectedGeneration', 'movies', 'queue'], ['expectedGeneration', 'movies', 'queue']);
  if (!integer(value.expectedGeneration) || !Array.isArray(value.movies) || value.movies.length > 500
      || !Array.isArray(value.queue) || value.queue.length > 2000) fail(400, 'invalid_request');
  for (const m of value.movies) {
    keys(m, ['id', 'genre', 'titleMode', 'manualTitle'], ['id', 'genre', 'titleMode']);
    if (!id(m.id) || !text(m.genre, 200) || !['api', 'manual'].includes(m.titleMode)
        || (m.titleMode === 'manual' && !text(m.manualTitle, 500))
        || (m.titleMode === 'api' && m.manualTitle !== undefined)) fail(400, 'invalid_request');
  }
  for (const q of value.queue) {
    keys(q, ['id', 'movieId'], ['id', 'movieId']);
    if (!id(q.id) || !id(q.movieId)) fail(400, 'invalid_request');
  }
}
function finish(value) {
  keys(value, ['outcome', 'deployed', 'libraryMatches', 'queueMatches', 'errorCode', 'phase', 'retryCount'],
    ['outcome', 'deployed', 'libraryMatches', 'queueMatches']);
  if (!OUTCOMES.has(value.outcome) || ['deployed', 'libraryMatches', 'queueMatches'].some(k => typeof value[k] !== 'boolean')
      || (value.errorCode != null && !ERROR_CODES.has(value.errorCode))
      || (value.phase !== undefined && !PHASES.has(value.phase))
      || (value.retryCount !== undefined && (!integer(value.retryCount) || value.retryCount > 10))) fail(400, 'invalid_request');
}

export function createWorker({serviceFactory = createService, catalogFactory = createCatalog,
  maintenanceFactory = createMaintenance, fetcher = fetch,
  now = () => new Date().toISOString(), uuid = () => crypto.randomUUID(), reserve = reserveApiUnit} = {}) {
  return {async fetch(request, env) {
    try {
      const who = await role(request, env);
      if (!env.DB) fail(503, 'configuration_error');
      const retentionDays = setting(env.RETENTION_DAYS, 30, 1, 30);
      const deletionGraceHours = setting(env.DELETION_GRACE_HOURS, 72, 1, 696);
      if (deletionGraceHours >= retentionDays * 24) fail(503, 'configuration_error');
      const service = serviceFactory(env.DB, {now, uuid, retentionDays, deletionGraceHours});
      const catalog = catalogFactory(env.DB, {now, uuid, retentionDays, deletionGraceHours});
      const maintenance = maintenanceFactory(env.DB, {now, retentionDays, deletionGraceHours});
      const url = new URL(request.url), path = url.pathname;
      if (request.method === 'GET' && path === '/v1/state') return response(await service.state());
      if (request.method === 'GET' && path === '/v1/publication') {
        if (who === 'maintenance') fail(403, 'forbidden');
        return response(await service.publication());
      }
      if (request.method === 'GET') {
        if (path === '/v1/deployments/active') {
          if (who !== 'deploy') fail(403, 'forbidden');
          return response(await service.activeDeployment());
        }
        if (['/v1/maintenance/plan','/v1/maintenance/status'].includes(path)) {
          if (who === 'deploy') fail(403, 'forbidden');
          return response(await maintenance[path.endsWith('/plan') ? 'plan' : 'status']());
        }
        if (path === '/v1/works' || path === '/v1/approved-configuration' || /^\/v1\/works\/[^/]+$/.test(path)) {
          if (who !== 'admin') fail(403, 'forbidden');
          if (path === '/v1/approved-configuration') return response(await catalog.approved());
          if (path !== '/v1/works') return response(await catalog.detail(path.split('/')[3]));
          if ([...url.searchParams.keys()].some(k => !['limit','after','status'].includes(k)) ||
            [...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) fail(400, 'invalid_request');
          return response(await catalog.list({...(url.searchParams.has('limit') ? {limit: Number(url.searchParams.get('limit'))} : {}),
            ...(url.searchParams.has('after') ? {after: url.searchParams.get('after')} : {}),
            ...(url.searchParams.has('status') ? {status: url.searchParams.get('status')} : {})}));
        }
      }
      if (request.method !== 'POST') fail(404, 'not_found');
      const adminRoute = ['/v1/approvals', '/v1/discoveries'].includes(path) || /^\/v1\/works\/[^/]+\/review$/.test(path);
      const maintenanceRoute = ['/v1/metadata/refresh', '/v1/maintenance/delete-eligible','/v1/maintenance/runs/start'].includes(path) || /^\/v1\/maintenance\/runs\/[^/]+\/finish$/.test(path);
      const deploymentRoute = path === '/v1/deployments/begin' || /^\/v1\/deployments\/[^/]+\/(authorize|finish|recover)$/.test(path);
      if (!adminRoute && !deploymentRoute && !maintenanceRoute) fail(404, 'not_found');
      if (adminRoute && who !== 'admin') fail(403, 'forbidden');
      if (maintenanceRoute && who === 'deploy') fail(403, 'forbidden');
      // Separate deployment credentials prevent normal administration from claiming a Pages verification.
      if (deploymentRoute && who !== 'deploy') fail(403, 'forbidden');
      const value = await body(request);
      if (path === '/v1/discoveries') {
        keys(value, ['expectedGeneration','videoUrl','source'], ['expectedGeneration','videoUrl']);
        return response(await catalog.discover(value));
      }
      const review = /^\/v1\/works\/([^/]+)\/review$/.exec(path);
      if (review) {
        keys(value, ['expectedGeneration','status','reviewMemo','genreId'], ['expectedGeneration','status']);
        return response(await catalog.review(review[1], value));
      }
      if (path === '/v1/maintenance/runs/start') {
        keys(value, ['runId'], ['runId']);
        return response(await maintenance.start(value));
      }
      const runFinish = /^\/v1\/maintenance\/runs\/([^/]+)\/finish$/.exec(path);
      if (runFinish) {
        keys(value, ['outcome','errorCode','counts'], ['outcome']);
        return response(await maintenance.finish(runFinish[1], value));
      }
      if (path === '/v1/approvals') {
        approval(value);
        return response(await service.approve(value));
      }
      if (path === '/v1/maintenance/delete-eligible') {
        keys(value, ['expectedGeneration'], ['expectedGeneration']);
        if (!integer(value.expectedGeneration)) fail(400, 'invalid_request');
        return response(await service.deleteEligible(value));
      }
      if (path === '/v1/metadata/refresh') {
        keys(value, ['workIds'], ['workIds']);
        if (!Array.isArray(value.workIds) || !value.workIds.length || value.workIds.length > 50
            || value.workIds.some(v => !id(v)) || new Set(value.workIds).size !== value.workIds.length) fail(400, 'invalid_request');
        if (!text(env.YOUTUBE_API_KEY, 512)) fail(503, 'youtube_not_configured');
        const plan = await service.refreshPlan(value.workIds);
        const budget = setting(env.YOUTUBE_REFRESH_DAILY_BUDGET, 8000, 0, 100000000);
        if (!(await reserve(env.DB, now(), budget))) fail(429, 'api_budget_exhausted');
        const observations = await fetchMetadata(plan.targets, env.YOUTUBE_API_KEY, fetcher);
        const state = await service.applyMetadata({expectedGeneration: plan.generation, observations});
        return response({...state, refresh: {
          ok: observations.filter(x => x.status === 'ok').length,
          unavailable: observations.filter(x => x.status === 'unavailable').length,
          apiError: observations.filter(x => x.status === 'api_error').length
        }});
      }
      if (path === '/v1/deployments/begin') {
        keys(value, ['attemptId', 'expectedRevision'], ['attemptId', 'expectedRevision']);
        if (!id(value.attemptId) || !integer(value.expectedRevision)) fail(400, 'invalid_request');
        return response(await service.beginDeployment(value));
      }
      const match = /^\/v1\/deployments\/([^/]+)\/(authorize|finish|recover)$/.exec(path);
      if (!match || !id(match[1])) fail(400, 'invalid_request');
      if (match[2] === 'recover') {
        keys(value, ['runId','runAttempt','runConclusion','pagesConclusion'], ['runId','runAttempt','runConclusion','pagesConclusion']);
        return response(await service.recoverDeployment(match[1], value));
      }
      if (match[2] === 'authorize') {
        keys(value, []);
        return response(await service.authorizeDeployment(match[1]));
      }
      finish(value);
      return response(await service.finishDeployment(match[1], value));
    } catch (e) {
      const status = Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500;
      const code = status === 500 ? 'internal_error' : /^[a-z][a-z0-9_]{0,63}$/.test(e.code || '') ? e.code : 'request_failed';
      return response({error: {code}}, status);
    }
  }};
}

export default createWorker();
