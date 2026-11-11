const DAY = 86_400_000;
const HOUR = 3_600_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ATTEMPT_ID = /^[0-9]{1,24}-[0-9]{1,8}$/;
const ERROR_CODES = new Set([
  'prepare_failed', 'revision_changed', 'revision_check_failed', 'artifact_failed',
  'deployment_unknown', 'deployment_failed', 'verification_failed',
  'public_fetch_failed', 'result_record_failed', 'cancelled',
]);
const PHASES = new Set(['prepare', 'authorize', 'deploy', 'verify', 'finish']);

export class ServiceError extends Error {
  constructor(status, code) { super(code); this.name = 'ServiceError'; this.status = status; this.code = code; }
}
function fail(status, code) { throw new ServiceError(status, code); }
function assert(condition, status = 400, code = 'invalid_request') {
  if (!condition) fail(status, code);
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function string(value, max = 500) {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0 && !value.includes('\u0000');
}
function validId(value) { return typeof value === 'string' && ID.test(value); }
function parseUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = new Date(time).toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z') ? time : null;
}
function sameKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function snapshotValue(row) {
  if (!row) fail(409, 'publication_unavailable');
  let value;
  try { value = JSON.parse(row.snapshot_json); } catch { fail(503, 'invalid_snapshot'); }
  assert(sameKeys(value, ['schemaVersion', 'libraryJson', 'queueJson']) && value.schemaVersion === 1 &&
    typeof value.libraryJson === 'string' && typeof value.queueJson === 'string', 503, 'invalid_snapshot');
  let library, queue;
  try { library = JSON.parse(value.libraryJson); queue = JSON.parse(value.queueJson); }
  catch { fail(503, 'invalid_snapshot'); }
  assert(sameKeys(library, ['version', 'movies']) && library.version === 1 && Array.isArray(library.movies) &&
    sameKeys(queue, ['version', 'queue']) && queue.version === 1 && Array.isArray(queue.queue), 503, 'invalid_snapshot');
  const movieIds = new Set();
  for (const movie of library.movies) {
    assert(sameKeys(movie, ['id', 'title', 'genre', 'url']) && validId(movie.id) && string(movie.title) &&
      string(movie.genre, 200) && typeof movie.url === 'string' &&
      /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(movie.url) &&
      !movieIds.has(movie.id), 503, 'invalid_snapshot');
    movieIds.add(movie.id);
  }
  const queueIds = new Set();
  for (const item of queue.queue) {
    assert(sameKeys(item, ['id', 'movieId']) && validId(item.id) && movieIds.has(item.movieId) &&
      !queueIds.has(item.id), 503, 'invalid_snapshot');
    queueIds.add(item.id);
  }
  return value;
}
function publicState(row) {
  return {
    initialized: Boolean(row.initialized), generation: row.generation, revision: row.revision,
    deployedRevision: row.deployed_revision, verifiedRevision: row.verified_revision,
    needsDeployment: Boolean(row.initialized) && row.revision !== row.verified_revision,
    activeAttemptId: row.active_attempt_id ?? null,
  };
}

export function createService(db, options = {}) {
  const nowFn = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const retentionDays = options.retentionDays ?? 30;
  const deletionGraceHours = options.deletionGraceHours ?? 72;
  assert(Number.isFinite(retentionDays) && retentionDays > 0 && retentionDays <= 30 &&
    Number.isFinite(deletionGraceHours) && deletionGraceHours >= 0 && deletionGraceHours < retentionDays * 24,
  500, 'invalid_configuration');
  const query = (sql, ...values) => db.prepare(sql).bind(...values);
  function clock() {
    const value = nowFn();
    const time = parseUtc(value);
    assert(time !== null, 500, 'invalid_clock');
    return { time, iso: new Date(time).toISOString() };
  }
  async function batch(statements) {
    try { return await db.batch(statements); }
    catch (error) {
      if (error instanceof ServiceError) throw error;
      if (String(error?.message).includes('ccm_cas_guard')) fail(409, 'revision_conflict');
      fail(503, 'storage_error');
    }
  }
  async function context() {
    const results = await batch([
      query('SELECT * FROM ccm_state WHERE singleton = 1'),
      query('SELECT * FROM works'), query('SELECT * FROM api_metadata'),
      query('SELECT * FROM ccm_metadata_state'),
      query('SELECT * FROM ccm_approved_movies ORDER BY position, work_id'),
      query('SELECT * FROM ccm_approved_queue ORDER BY position, id'),
      query(`SELECT * FROM publication_snapshots WHERE revision =
        (SELECT revision FROM ccm_state WHERE singleton = 1 AND initialized = 1)`),
      query('SELECT * FROM ccm_queue_identities'), query('SELECT work_id FROM ccm_tombstones'),
    ]);
    const rows = results.map(result => result.results ?? []);
    assert(rows[0].length === 1, 503, 'schema_unavailable');
    return {
      state: rows[0][0], works: new Map(rows[1].map(row => [row.id, row])),
      metadata: new Map(rows[2].map(row => [row.work_id, row])),
      missing: new Map(rows[3].map(row => [row.work_id, row])),
      approved: rows[4], queue: rows[5], snapshot: rows[6][0],
      queueIdentities: new Map(rows[7].map(row => [row.queue_id, row.work_id])),
      tombstones: new Set(rows[8].map(row => row.work_id)),
    };
  }
  function guard(expectedGeneration, extraSql = '1', extraValues = []) {
    const operationId = uuid();
    return {
      start: query(`INSERT INTO ccm_cas_guards(operation_id, accepted)
        VALUES (?, COALESCE((SELECT CASE WHEN generation = ? AND (${extraSql}) THEN 1 ELSE 0 END
        FROM ccm_state WHERE singleton = 1), 0))`, operationId, expectedGeneration, ...extraValues),
      end: query('DELETE FROM ccm_cas_guards WHERE operation_id = ?', operationId),
    };
  }
  function expected(ctx, generation) {
    assert(integer(generation));
    assert(ctx.state.generation === generation, 409, 'revision_conflict');
  }
  function deadline(work, metadata, time) {
    const anchor = parseUtc(metadata?.last_ok_at ?? work?.created_at);
    assert(anchor !== null && anchor <= time, 409, 'invalid_metadata_time');
    let result = anchor + retentionDays * DAY;
    if (metadata?.retention_deadline !== null && metadata?.retention_deadline !== undefined) {
      const stored = parseUtc(metadata.retention_deadline);
      assert(stored !== null, 409, 'invalid_metadata_time');
      result = Math.min(result, stored);
    }
    return result;
  }
  function usable(ctx, id, time, requireApproved = false, allowExpired = false) {
    const work = ctx.works.get(id), metadata = ctx.metadata.get(id);
    assert(work && !ctx.tombstones.has(id), 409, 'unknown_work');
    if (requireApproved) assert(work.status === 'approved', 409, 'work_not_approved');
    assert(metadata && typeof metadata.video_id === 'string' && VIDEO_ID.test(metadata.video_id) &&
      metadata.video_id === work.youtube_video_id && string(metadata.title) && metadata.last_ok_at,
    409, 'metadata_unavailable');
    const retentionDeadline = deadline(work, metadata, time);
    assert(allowExpired || retentionDeadline > time, 409, 'metadata_expired');
    return metadata;
  }
  function ensureFresh(ctx, time) {
    for (const row of ctx.approved) usable(ctx, row.work_id, time);
  }
  function render(ctx, approved, queue, time, { allowExpired = false } = {}) {
    const movies = approved.map(row => {
      const metadata = usable(ctx, row.work_id, time, false, allowExpired);
      return {
        id: row.work_id, title: row.title_mode === 'manual' ? row.manual_title : metadata.title,
        genre: row.genre, url: `https://www.youtube.com/watch?v=${metadata.video_id}`,
      };
    });
    return {
      schemaVersion: 1,
      libraryJson: JSON.stringify({ version: 1, movies }),
      queueJson: JSON.stringify({ version: 1, queue: queue.map(row => ({ id: row.id, movieId: row.work_id })) }),
    };
  }
  function newPublication(ctx, value, iso, force = false) {
    const current = ctx.state.initialized ? snapshotValue(ctx.snapshot) : null;
    if (!force && current && current.libraryJson === value.libraryJson && current.queueJson === value.queueJson) return [];
    const revision = ctx.state.revision + 1;
    assert(Number.isSafeInteger(revision), 503, 'revision_exhausted');
    // Keep only the current body. Counters/outbox/attempts preserve revision IDs,
    // never prior API metadata. SQL ordering is protected by the batch CAS guard.
    return [
      query('DELETE FROM publication_snapshots'),
      query(`INSERT INTO publication_snapshots(revision,snapshot_json,status,created_at)
        VALUES (?,?,'pending',?)`, revision, JSON.stringify(value), iso),
      query('UPDATE ccm_state SET initialized = 1, revision = ? WHERE singleton = 1', revision),
      query(`UPDATE ccm_publication_requests SET status = 'superseded', updated_at = ?
        WHERE status IN ('pending','failed')`, iso),
      query(`INSERT INTO ccm_publication_requests(revision,status,created_at,updated_at)
        VALUES (?,'pending',?,?)`, revision, iso, iso),
    ];
  }
  async function runMutation(ctx, statements, generation, extraSql, extraValues) {
    const cas = guard(generation, extraSql, extraValues);
    await batch([cas.start, ...statements, cas.end]);
  }
  async function state() {
    const result = await batch([query('SELECT * FROM ccm_state WHERE singleton = 1')]);
    assert(result[0].results?.length === 1, 503, 'schema_unavailable');
    return publicState(result[0].results[0]);
  }
  async function approve(input) {
    assert(input && Array.isArray(input.movies) && input.movies.length <= 500 &&
      Array.isArray(input.queue) && input.queue.length <= 2000);
    const ctx = await context(), { time, iso } = clock();
    expected(ctx, input.expectedGeneration);
    const seen = new Set(), queueIds = new Set();
    const approved = input.movies.map((movie, position) => {
      assert(movie && validId(movie.id) && !seen.has(movie.id) && string(movie.genre, 200) &&
        ['api', 'manual'].includes(movie.titleMode));
      assert(movie.titleMode === 'manual' ? string(movie.manualTitle) : movie.manualTitle === undefined || movie.manualTitle === null);
      seen.add(movie.id);
      usable(ctx, movie.id, time, true);
      return { work_id: movie.id, position, genre: movie.genre, title_mode: movie.titleMode,
        manual_title: movie.titleMode === 'manual' ? movie.manualTitle : null };
    });
    const currentQueueIds = new Set(ctx.queue.map(item => item.id));
    const queue = input.queue.map((item, position) => {
      assert(item && validId(item.id) && seen.has(item.movieId) && !queueIds.has(item.id));
      assert(!ctx.queueIdentities.has(item.id) || ctx.queueIdentities.get(item.id) === item.movieId,
        409, 'queue_id_reused');
      assert(!ctx.state.initialized || !ctx.queueIdentities.has(item.id) || currentQueueIds.has(item.id),
        409, 'queue_id_retired');
      queueIds.add(item.id);
      return { id: item.id, work_id: item.movieId, position };
    });
    const value = render(ctx, approved, queue, time);
    const statements = [
      query('DELETE FROM ccm_approved_queue'), query('DELETE FROM ccm_approved_movies'),
      query(`INSERT INTO ccm_approved_movies(work_id,position,genre,title_mode,manual_title)
        SELECT json_extract(value,'$.work_id'),json_extract(value,'$.position'),json_extract(value,'$.genre'),
          json_extract(value,'$.title_mode'),json_extract(value,'$.manual_title') FROM json_each(?)`, JSON.stringify(approved)),
      query(`INSERT INTO ccm_approved_queue(id,work_id,position)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.work_id'),json_extract(value,'$.position')
        FROM json_each(?)`, JSON.stringify(queue)),
      query(`INSERT OR IGNORE INTO ccm_queue_identities(queue_id,work_id)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.work_id') FROM json_each(?)`, JSON.stringify(queue)),
      ...newPublication(ctx, value, iso, !ctx.state.initialized),
      query('UPDATE ccm_state SET generation = generation + 1 WHERE singleton = 1'),
    ];
    await runMutation(ctx, statements, input.expectedGeneration);
    return state();
  }
  async function publication() {
    const ctx = await context(), { time } = clock();
    assert(ctx.state.initialized, 409, 'not_initialized');
    ensureFresh(ctx, time);
    const value = snapshotValue(ctx.snapshot);
    return { revision: ctx.state.revision, libraryJson: value.libraryJson, queueJson: value.queueJson };
  }
  async function refreshPlan(workIds) {
    assert(Array.isArray(workIds) && workIds.length >= 1 && workIds.length <= 50 &&
      workIds.every(validId) && new Set(workIds).size === workIds.length);
    const ctx = await context();
    const targets = workIds.map(workId => {
      const work = ctx.works.get(workId);
      assert(work && !ctx.tombstones.has(workId), 409, 'unknown_work');
      const videoId = ctx.metadata.get(workId)?.video_id ?? work.youtube_video_id;
      assert(typeof videoId === 'string' && VIDEO_ID.test(videoId) && videoId === work.youtube_video_id,
        409, 'metadata_unavailable');
      return { workId, videoId };
    });
    return { generation: ctx.state.generation, targets };
  }
  async function applyMetadata(input) {
    assert(input && Array.isArray(input.observations) && input.observations.length >= 1 && input.observations.length <= 50);
    const ctx = await context(), { time, iso } = clock();
    expected(ctx, input.expectedGeneration);
    const ids = new Set(), metadataRows = [], missingRows = [];
    for (const observation of input.observations) {
      assert(observation && validId(observation.workId) && !ids.has(observation.workId) &&
        ['ok','unavailable','api_error'].includes(observation.status));
      ids.add(observation.workId);
      const work = ctx.works.get(observation.workId);
      assert(work && !ctx.tombstones.has(work.id), 409, 'unknown_work');
      assert(VIDEO_ID.test(work.youtube_video_id), 409, 'metadata_unavailable');
      const old = ctx.metadata.get(work.id);
      assert(!old || old.video_id === work.youtube_video_id, 409, 'metadata_unavailable');
      if (old?.last_attempt_at) {
        const attempted = parseUtc(old.last_attempt_at);
        assert(attempted !== null && attempted <= time, 409, 'invalid_metadata_time');
      }
      const next = { work_id: work.id, video_id: work.youtube_video_id, title: old?.title ?? null,
        channel_id: old?.channel_id ?? null, channel_name: old?.channel_name ?? null,
        duration_seconds: old?.duration_seconds ?? null, fetch_status: observation.status,
        last_ok_at: old?.last_ok_at ?? null, last_attempt_at: iso,
        consecutive_unavailable: old?.consecutive_unavailable ?? 0,
        retention_deadline: old?.retention_deadline ?? null, extension_used: 0 };
      const missing = { work_id: work.id, first_missing_at: null, last_missing_at: null, missing_count: 0,
        ...(ctx.missing.get(work.id) ?? {}) };
      if (observation.status === 'ok') {
        assert(string(observation.title));
        assert(observation.channelId === undefined || observation.channelId === null || string(observation.channelId, 128));
        assert(observation.channelName === undefined || observation.channelName === null || string(observation.channelName));
        assert(observation.durationSeconds === undefined || observation.durationSeconds === null || integer(observation.durationSeconds));
        Object.assign(next, { title: observation.title, channel_id: observation.channelId ?? null,
          channel_name: observation.channelName ?? null, duration_seconds: observation.durationSeconds ?? null,
          last_ok_at: iso, retention_deadline: new Date(time + retentionDays * DAY).toISOString(),
          consecutive_unavailable: 0 });
        Object.assign(missing, { first_missing_at: null, last_missing_at: null, missing_count: 0 });
      } else if (observation.status === 'unavailable') {
        const lastMissing = missing.last_missing_at === null ? null : parseUtc(missing.last_missing_at);
        assert(missing.last_missing_at === null || (lastMissing !== null && lastMissing <= time), 409, 'invalid_metadata_time');
        if (lastMissing === null || time > lastMissing) {
          missing.first_missing_at ??= iso;
          missing.last_missing_at = iso;
          missing.missing_count += 1;
        }
        next.consecutive_unavailable = missing.missing_count;
      }
      metadataRows.push(next); missingRows.push(missing);
      ctx.metadata.set(work.id, next); ctx.missing.set(work.id, missing);
    }
    const statements = [
      query(`INSERT INTO api_metadata(work_id,video_id,title,channel_id,channel_name,duration_seconds,fetch_status,
        last_ok_at,last_attempt_at,consecutive_unavailable,retention_deadline,extension_used)
        SELECT json_extract(value,'$.work_id'),json_extract(value,'$.video_id'),json_extract(value,'$.title'),
        json_extract(value,'$.channel_id'),json_extract(value,'$.channel_name'),json_extract(value,'$.duration_seconds'),
        json_extract(value,'$.fetch_status'),json_extract(value,'$.last_ok_at'),json_extract(value,'$.last_attempt_at'),
        json_extract(value,'$.consecutive_unavailable'),json_extract(value,'$.retention_deadline'),0 FROM json_each(?) WHERE 1
        ON CONFLICT(work_id) DO UPDATE SET title=excluded.title,channel_id=excluded.channel_id,
        channel_name=excluded.channel_name,duration_seconds=excluded.duration_seconds,fetch_status=excluded.fetch_status,
        last_ok_at=excluded.last_ok_at,last_attempt_at=excluded.last_attempt_at,
        consecutive_unavailable=excluded.consecutive_unavailable,retention_deadline=excluded.retention_deadline,extension_used=0`, JSON.stringify(metadataRows)),
      query(`INSERT INTO ccm_metadata_state(work_id,first_missing_at,last_missing_at,missing_count)
        SELECT json_extract(value,'$.work_id'),json_extract(value,'$.first_missing_at'),
        json_extract(value,'$.last_missing_at'),json_extract(value,'$.missing_count') FROM json_each(?) WHERE 1
        ON CONFLICT(work_id) DO UPDATE SET first_missing_at=excluded.first_missing_at,
          last_missing_at=excluded.last_missing_at,missing_count=excluded.missing_count`, JSON.stringify(missingRows)),
      query('UPDATE ccm_state SET generation = generation + 1 WHERE singleton = 1'),
    ];
    if (ctx.state.initialized) {
      // An unrelated expired published work must not prevent a healthy refresh.
      // render() normally checks freshness, so expired members keep their current
      // bytes until deleteEligible performs the atomic removal. They cannot export.
      const approvedIds = new Set(ctx.approved.map(row => row.work_id));
      const changedPublic = metadataRows.some(row => approvedIds.has(row.work_id) &&
        input.observations.find(item => item.workId === row.work_id)?.status === 'ok');
      if (changedPublic) statements.push(...newPublication(ctx,
        render(ctx, ctx.approved, ctx.queue, time, { allowExpired: true }), iso));
    }
    await runMutation(ctx, statements, input.expectedGeneration);
    return state();
  }
  async function deleteEligible(input) {
    assert(input && integer(input.expectedGeneration));
    const ctx = await context(), { time, iso } = clock();
    expected(ctx, input.expectedGeneration);
    const deletions = [];
    for (const work of ctx.works.values()) {
      const metadata = ctx.metadata.get(work.id), missing = ctx.missing.get(work.id);
      const first = parseUtc(missing?.first_missing_at), last = parseUtc(missing?.last_missing_at);
      const unavailable = missing?.missing_count >= 2 && first !== null && last !== null &&
        last <= time && last - first >= DAY;
      const expired = deadline(work, metadata, time) <= time + deletionGraceHours * HOUR;
      if (unavailable || expired) deletions.push({ workId: work.id, eventId: uuid(),
        reason: unavailable ? 'unavailable_confirmed' : 'metadata_expired' });
    }
    if (!deletions.length) return { ...publicState(ctx.state), removedCount: 0 };
    const ids = new Set(deletions.map(item => item.workId)), idsJson = JSON.stringify([...ids]);
    const approved = ctx.approved.filter(row => !ids.has(row.work_id));
    const queue = ctx.queue.filter(row => !ids.has(row.work_id));
    const publicChanged = approved.length !== ctx.approved.length;
    const targetRevision = ctx.state.revision + (publicChanged ? 1 : 0);
    const auditRows = deletions.map(item => ({ ...item,
      published: ctx.approved.some(row => row.work_id === item.workId) }));
    const statements = [
      query(`INSERT INTO deletion_audit(event_id,work_id,deleted_at,reason_code,trigger,removed_queue_entries,
        publication_revision,publication_status)
        SELECT json_extract(value,'$.eventId'),json_extract(value,'$.workId'),?,json_extract(value,'$.reason'),'automatic',
          (SELECT COUNT(*) FROM (SELECT id FROM queue_items WHERE work_id=json_extract(j.value,'$.workId')
            UNION SELECT id FROM ccm_approved_queue WHERE work_id=json_extract(j.value,'$.workId'))),
          CASE WHEN json_extract(value,'$.published') THEN ? ELSE NULL END,
          CASE WHEN json_extract(value,'$.published') THEN 'pending' ELSE NULL END
        FROM json_each(?) AS j`, iso, targetRevision, JSON.stringify(auditRows)),
      query(`INSERT INTO ccm_tombstones(work_id,deleted_at) SELECT value,? FROM json_each(?)`, iso, idsJson),
      query('DELETE FROM ccm_approved_queue WHERE work_id IN (SELECT value FROM json_each(?))', idsJson),
      query('DELETE FROM ccm_approved_movies WHERE work_id IN (SELECT value FROM json_each(?))', idsJson),
      query('DELETE FROM queue_items WHERE work_id IN (SELECT value FROM json_each(?))', idsJson),
      query('DELETE FROM discoveries WHERE work_id IN (SELECT value FROM json_each(?))', idsJson),
      query('DELETE FROM ccm_metadata_state WHERE work_id IN (SELECT value FROM json_each(?))', idsJson),
      query('DELETE FROM api_metadata WHERE work_id IN (SELECT value FROM json_each(?))', idsJson),
      query('DELETE FROM works WHERE id IN (SELECT value FROM json_each(?))', idsJson),
      query('UPDATE ccm_state SET generation = generation + 1 WHERE singleton = 1'),
    ];
    if (ctx.state.initialized) {
      if (publicChanged) statements.push(...newPublication(ctx, render(ctx, approved, queue, time), iso));
      else statements.push(query('DELETE FROM publication_snapshots WHERE revision <> ?', ctx.state.revision));
    } else {
      // Legacy bodies cannot be selectively scrubbed without trusting their shape.
      // A deletion purges all opaque legacy copies; bootstrap still stays required.
      statements.push(query('DELETE FROM publication_snapshots'));
    }
    await runMutation(ctx, statements, input.expectedGeneration);
    return { ...await state(), removedCount: deletions.length };
  }
  async function attemptContext(attemptId) {
    assert(typeof attemptId === 'string' && ATTEMPT_ID.test(attemptId));
    const results = await batch([
      query('SELECT * FROM ccm_state WHERE singleton = 1'),
      query('SELECT * FROM ccm_deployment_attempts WHERE attempt_id = ?', attemptId),
    ]);
    assert(results[0].results?.length === 1, 503, 'schema_unavailable');
    return { state: results[0].results[0], attempt: results[1].results?.[0] };
  }
  async function beginDeployment(input) {
    assert(input && typeof input.attemptId === 'string' && ATTEMPT_ID.test(input.attemptId) && integer(input.expectedRevision));
    const { state: row, attempt } = await attemptContext(input.attemptId), { iso } = clock();
    assert(row.initialized, 409, 'not_initialized');
    if (attempt) {
      assert(!attempt.outcome && row.active_attempt_id === input.attemptId && attempt.revision === input.expectedRevision,
        409, 'attempt_closed');
      return { attemptId: input.attemptId, revision: attempt.revision };
    }
    assert(row.revision === input.expectedRevision, 409, 'revision_conflict');
    assert(row.active_attempt_id === null, 409, 'deployment_locked');
    await runMutation({ state: row }, [
      query(`INSERT INTO ccm_deployment_attempts(attempt_id,revision,started_at) VALUES (?,?,?)`, input.attemptId, row.revision, iso),
      query('UPDATE ccm_state SET active_attempt_id = ? WHERE singleton = 1', input.attemptId),
      query(`UPDATE ccm_publication_requests SET status='deploying',updated_at=? WHERE revision=?`, iso, row.revision),
      query(`UPDATE publication_snapshots SET status='deploying' WHERE revision=?`, row.revision),
      query(`UPDATE deletion_audit SET publication_status='deploying' WHERE publication_revision<=?
        AND publication_status IN ('pending','failed')`, row.revision),
    ], row.generation, 'revision = ? AND active_attempt_id IS NULL', [row.revision]);
    return { attemptId: input.attemptId, revision: row.revision };
  }
  async function authorizeDeployment(attemptId) {
    const { state: row, attempt } = await attemptContext(attemptId), { time, iso } = clock();
    assert(attempt && !attempt.outcome && row.active_attempt_id === attemptId, 409, 'attempt_not_active');
    assert(row.initialized && row.revision === attempt.revision, 409, 'revision_conflict');
    const ctx = await context();
    assert(ctx.state.revision === attempt.revision, 409, 'revision_conflict');
    ensureFresh(ctx, time); snapshotValue(ctx.snapshot);
    await runMutation(ctx, [
      query(`UPDATE ccm_deployment_attempts SET authorized_at=COALESCE(authorized_at,?) WHERE attempt_id=?`, iso, attemptId),
    ], ctx.state.generation, 'revision = ? AND active_attempt_id = ? AND EXISTS (SELECT 1 FROM ccm_deployment_attempts WHERE attempt_id=? AND outcome IS NULL)',
    [attempt.revision, attemptId, attemptId]);
    return { authorized: true, revision: attempt.revision };
  }
  async function finishDeployment(attemptId, input) {
    assert(input && ['verified','failed','superseded','uncertain'].includes(input.outcome) &&
      typeof input.deployed === 'boolean' && typeof input.libraryMatches === 'boolean' && typeof input.queueMatches === 'boolean');
    assert(input.errorCode === undefined || input.errorCode === null || ERROR_CODES.has(input.errorCode));
    assert(input.phase === undefined || input.phase === null || PHASES.has(input.phase));
    assert(input.retryCount === undefined || (integer(input.retryCount) && input.retryCount <= 1000));
    const request = { outcome: input.outcome, deployed: input.deployed, libraryMatches: input.libraryMatches,
      queueMatches: input.queueMatches, errorCode: input.errorCode ?? null, phase: input.phase ?? null,
      retryCount: input.retryCount ?? 0 };
    const requestJson = JSON.stringify(request);
    const { state: row, attempt } = await attemptContext(attemptId), { iso } = clock();
    assert(attempt, 409, 'unknown_attempt');
    if (attempt.outcome) {
      assert(attempt.terminal_request_json === requestJson, 409, 'attempt_closed');
      return { outcome: attempt.outcome, revision: attempt.revision };
    }
    assert(row.active_attempt_id === attemptId, 409, 'attempt_not_active');
    assert(!request.deployed || attempt.authorized_at, 409, 'not_authorized');
    assert(request.outcome !== 'verified' || (request.deployed && request.libraryMatches && request.queueMatches && attempt.authorized_at));
    assert(request.outcome !== 'uncertain' || !request.deployed);
    const current = row.initialized && row.revision === attempt.revision;
    const outcome = request.outcome === 'verified' && !current ? 'superseded' : request.outcome;
    const verified = outcome === 'verified';
    const snapshotStatus = verified ? 'verified' : request.deployed ? 'deployed' : 'failed';
    const statements = [
      query(`UPDATE ccm_deployment_attempts SET finished_at=?,outcome=?,deployed=?,library_matches=?,queue_matches=?,
        error_code=?,phase=?,retry_count=?,terminal_request_json=? WHERE attempt_id=?`, iso, outcome,
      Number(request.deployed), Number(request.libraryMatches), Number(request.queueMatches), request.errorCode,
      request.phase, request.retryCount, requestJson, attemptId),
      query(`UPDATE ccm_state SET active_attempt_id = CASE WHEN ? THEN active_attempt_id ELSE NULL END,
        deployed_revision=CASE WHEN ? THEN MAX(deployed_revision,?) ELSE deployed_revision END,
        verified_revision=CASE WHEN ? THEN ? ELSE verified_revision END WHERE singleton=1`,
      Number(outcome === 'uncertain'), Number(request.deployed), attempt.revision, Number(verified), attempt.revision),
      query('UPDATE publication_snapshots SET status=? WHERE revision=?', snapshotStatus, attempt.revision),
      query(`UPDATE ccm_publication_requests SET status=?,updated_at=? WHERE revision=?`,
        verified ? 'verified' : outcome === 'superseded' ? 'superseded' : 'failed', iso, attempt.revision),
    ];
    if (verified) {
      statements.push(query(`UPDATE ccm_publication_requests SET status='verified',updated_at=? WHERE revision<=?`, iso, attempt.revision));
      statements.push(query(`UPDATE deletion_audit SET publication_status='verified' WHERE publication_revision<=?`, attempt.revision));
    } else {
      statements.push(query(`UPDATE deletion_audit SET publication_status='failed' WHERE publication_revision<=?
        AND publication_status<>'verified'`, attempt.revision));
    }
    await runMutation({ state: row }, statements, row.generation,
      'revision = ? AND active_attempt_id = ? AND EXISTS (SELECT 1 FROM ccm_deployment_attempts WHERE attempt_id=? AND outcome IS NULL)',
      [row.revision, attemptId, attemptId]);
    return { outcome, revision: attempt.revision };
  }
  return { state, approve, publication, refreshPlan, applyMetadata, deleteEligible,
    beginDeployment, authorizeDeployment, finishDeployment };
}
