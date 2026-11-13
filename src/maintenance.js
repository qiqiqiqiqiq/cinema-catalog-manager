import {ServiceError} from './service.js';

const DAY = 86400000;
const RUN_ID = /^[0-9]{1,24}-[0-9]{1,8}$/;
const ERRORS = new Set(['api_error', 'api_budget_exhausted', 'api_unreachable', 'request_failed',
  'revision_conflict', 'batch_limit', 'invalid_response']);
const fail = (status, code) => { throw new ServiceError(status, code); };

export function createMaintenance(db, {now = () => new Date().toISOString(), refreshIntervalDays = 13,
  retryHours = 24, deletionGraceHours = 72, retentionDays = 30} = {}) {
  const q = (sql, ...args) => db.prepare(sql).bind(...args);
  function clock() {
    const time = Date.parse(now());
    if (!Number.isFinite(time)) fail(503, 'invalid_clock');
    return {time, iso: new Date(time).toISOString()};
  }
  function date(value) {
    const result = Date.parse(value);
    if (typeof value !== 'string' || !Number.isFinite(result)) fail(409, 'invalid_metadata_time');
    return result;
  }
  async function plan() {
    const {time} = clock();
    const {results} = await q(`SELECT w.id,w.created_at,m.last_ok_at,m.last_attempt_at,
      m.fetch_status,m.retention_deadline FROM works w LEFT JOIN api_metadata m ON m.work_id=w.id
      WHERE NOT EXISTS (SELECT 1 FROM ccm_tombstones t WHERE t.work_id=w.id)`).all();
    const due = [];
    for (const row of results) {
      const anchor = date(row.last_ok_at ?? row.created_at);
      const attempted = row.last_attempt_at == null ? null : date(row.last_attempt_at);
      if (anchor > time || (attempted !== null && attempted > time)) fail(409, 'invalid_metadata_time');
      const deadline = Math.min(anchor + retentionDays * DAY,
        row.retention_deadline == null ? Infinity : date(row.retention_deadline));
      const next = row.last_ok_at && row.fetch_status === 'ok'
        ? Math.min(anchor + refreshIntervalDays * DAY, deadline - deletionGraceHours * 3600000) : 0;
      // A failed/missing first batch must not starve later works or spend the same
      // quota again on a restart. last_attempt_at is committed with the observation.
      if (next <= time && (attempted === null || time - attempted >= retryHours * 3600000)) {
        due.push({id: row.id, deadline});
      }
    }
    due.sort((a, b) => a.deadline - b.deadline || a.id.localeCompare(b.id));
    return {workIds: due.slice(0, 50).map(x => x.id), dueCount: due.length,
      totalCount: results.length, refreshIntervalDays, retryHours};
  }
  function validateRun(runId) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) fail(400, 'invalid_request');
  }
  async function start({runId}) {
    validateRun(runId);
    const {iso} = clock();
    await db.batch([
      q("INSERT INTO ccm_maintenance_runs(run_id,started_at,status) VALUES (?,?,'running') ON CONFLICT(run_id) DO NOTHING", runId, iso),
      q(`DELETE FROM ccm_maintenance_runs WHERE status<>'running' AND run_id NOT IN
        (SELECT run_id FROM ccm_maintenance_runs ORDER BY started_at DESC,run_id DESC LIMIT 200)`),
    ]);
    const row = await q('SELECT status FROM ccm_maintenance_runs WHERE run_id=?', runId).first();
    return {runId, status: row.status};
  }
  async function finish(runId, {outcome, errorCode = null, counts = {}}) {
    validateRun(runId);
    if (!['success', 'partial', 'failed'].includes(outcome) ||
      (errorCode !== null && !ERRORS.has(errorCode)) ||
      (outcome === 'success' && errorCode !== null)) fail(400, 'invalid_request');
    if (!counts || typeof counts !== 'object' || Array.isArray(counts) || Object.keys(counts).some(k =>
      !['batches','ok','unavailable','apiError','deleted','refreshRequests'].includes(k) ||
      !Number.isSafeInteger(counts[k]) || counts[k] < 0 || counts[k] > 1000000)) fail(400, 'invalid_request');
    const countsJson = JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))));
    const {iso} = clock();
    const row = await q(`UPDATE ccm_maintenance_runs SET status=?,error_code=?,finished_at=?,counts_json=?,
      revision=(SELECT revision FROM ccm_state WHERE singleton=1) WHERE run_id=? AND status='running'
      RETURNING status,error_code,counts_json`, outcome, errorCode, iso, countsJson, runId).first();
    const current = row ?? await q('SELECT status,error_code,counts_json FROM ccm_maintenance_runs WHERE run_id=?', runId).first();
    if (!current) fail(409, 'unknown_run');
    if (current.status !== outcome || current.error_code !== errorCode || current.counts_json !== countsJson) fail(409, 'run_closed');
    return {runId, status: current.status};
  }
  async function status() {
    const {time} = clock();
    const rows = (await q(`SELECT * FROM ccm_maintenance_runs ORDER BY started_at DESC,run_id DESC LIMIT 20`).all()).results;
    const runs = rows.map(row => ({runId: row.run_id, startedAt: row.started_at,
      finishedAt: row.finished_at, status: row.status, errorCode: row.error_code,
      revision: row.revision, counts: JSON.parse(row.counts_json),
      stale: row.status === 'running' && time - date(row.started_at) > 2 * 3600000}));
    return {lastRun: runs[0] ?? null, runs};
  }
  return {plan, start, finish, status};
}
