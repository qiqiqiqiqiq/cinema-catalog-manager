import {createService, ServiceError} from './service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
const STATUSES = new Set(['unreviewed', 'held', 'rejected', 'approved']);

function assert(ok, status = 400, code = 'invalid_request') {
  if (!ok) throw new ServiceError(status, code);
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function id(value) { return typeof value === 'string' && ID.test(value); }
function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function keys(value, allowed, required = []) {
  assert(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => allowed.includes(k)) && required.every(k => k in value));
}

// Parse only known YouTube shapes. We never fetch a URL supplied by a caller.
export function parseVideoUrl(value) {
  assert(text(value, 2048));
  if (VIDEO.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { assert(false); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.port);
  let result;
  if (url.hostname === 'youtu.be') result = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) result = url.searchParams.get('v');
    else result = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  assert(typeof result === 'string' && VIDEO.test(result));
  return result;
}

export function createCatalog(db, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const service = createService(db, options);
  const query = (sql, ...values) => db.prepare(sql).bind(...values);
  async function batch(statements) {
    try { return await db.batch(statements); }
    catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceError(String(e?.message).includes('ccm_cas_guard') ? 409 : 503,
        String(e?.message).includes('ccm_cas_guard') ? 'revision_conflict' : 'storage_error');
    }
  }
  function timestamp() {
    const value = now();
    assert(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 500, 'invalid_clock');
    return new Date(value).toISOString();
  }
  function generation(result) {
    assert(result.results?.length === 1, 503, 'schema_unavailable');
    return result.results[0].generation;
  }
  async function mutate(expectedGeneration, statements) {
    assert(integer(expectedGeneration));
    const operationId = uuid();
    await batch([
      query(`INSERT INTO ccm_cas_guards(operation_id,accepted)
        VALUES (?,COALESCE((SELECT CASE WHEN generation=? THEN 1 ELSE 0 END
          FROM ccm_state WHERE singleton=1),0))`, operationId, expectedGeneration),
      ...statements,
      query('UPDATE ccm_state SET generation=generation+1 WHERE singleton=1'),
      query('DELETE FROM ccm_cas_guards WHERE operation_id=?', operationId),
    ]);
  }
  const WORK_COLUMNS = `w.*,m.title,m.channel_id,m.channel_name,m.duration_seconds,
    m.fetch_status,m.last_ok_at,m.last_attempt_at,m.retention_deadline,
    EXISTS(SELECT 1 FROM ccm_approved_movies a WHERE a.work_id=w.id) AS published`;
  function work(row) {
    const anchor = Date.parse(row.last_ok_at ?? row.created_at);
    const storedDeadline = row.retention_deadline == null ? Infinity : Date.parse(row.retention_deadline);
    const expires = Math.min(anchor + (options.retentionDays ?? 30) * 86400000, storedDeadline);
    const expired = !Number.isFinite(expires) || expires <= Date.parse(timestamp());
    return {id: row.id, videoId: row.youtube_video_id, status: row.status, genreId: row.genre_id,
      reviewMemo: row.review_memo, manualConfirmedAt: row.manual_confirmed_at,
      createdAt: row.created_at, updatedAt: row.updated_at, published: Boolean(row.published),
      metadata: {title: expired ? null : row.title ?? null, channelId: expired ? null : row.channel_id ?? null,
        channelName: expired ? null : row.channel_name ?? null, durationSeconds: expired ? null : row.duration_seconds ?? null,
        fetchStatus: row.fetch_status ?? 'unknown', lastOkAt: row.last_ok_at ?? null,
        lastAttemptAt: row.last_attempt_at ?? null, retentionDeadline: row.retention_deadline ?? null, expired}};
  }
  async function list(input = {}) {
    keys(input, ['limit', 'after', 'status']);
    const limit = input.limit ?? 50, after = input.after ?? '';
    assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && (after === '' || id(after)) &&
      (input.status === undefined || STATUSES.has(input.status)));
    const result = await batch([
      query('SELECT generation FROM ccm_state WHERE singleton=1'),
      query(`SELECT ${WORK_COLUMNS} FROM works w LEFT JOIN api_metadata m ON m.work_id=w.id
        WHERE w.id>? AND (? IS NULL OR w.status=?) ORDER BY w.id LIMIT ?`,
      after, input.status ?? null, input.status ?? null, limit + 1),
    ]);
    const rows = result[1].results ?? [], more = rows.length > limit;
    const visible = rows.slice(0, limit);
    return {generation: generation(result[0]), works: visible.map(work),
      nextCursor: more ? visible.at(-1).id : null};
  }
  async function detail(workId) {
    assert(id(workId));
    const result = await batch([
      query('SELECT generation FROM ccm_state WHERE singleton=1'),
      query(`SELECT ${WORK_COLUMNS} FROM works w LEFT JOIN api_metadata m ON m.work_id=w.id WHERE w.id=?`, workId),
      query(`SELECT id,rule_id,method,condition_text,discovered_at FROM discoveries
        WHERE work_id=? ORDER BY id LIMIT 101`, workId),
    ]);
    assert(result[1].results?.length === 1, 404, 'unknown_work');
    const discoveries = result[2].results ?? [];
    return {generation: generation(result[0]), work: work(result[1].results[0]),
      discoveries: discoveries.slice(0, 100).map(row => ({id: row.id, ruleId: row.rule_id,
        method: row.method, source: row.condition_text, discoveredAt: row.discovered_at})),
      discoveriesTruncated: discoveries.length > 100};
  }
  async function approved() {
    const result = await batch([
      query('SELECT generation FROM ccm_state WHERE singleton=1'),
      query('SELECT * FROM ccm_approved_movies ORDER BY position,work_id'),
      query('SELECT * FROM ccm_approved_queue ORDER BY position,id'),
    ]);
    return {generation: generation(result[0]), movies: (result[1].results ?? []).map(row => ({
      id: row.work_id, genre: row.genre, titleMode: row.title_mode,
      ...(row.title_mode === 'manual' ? {manualTitle: row.manual_title} : {}),
    })), queue: (result[2].results ?? []).map(row => ({id: row.id, movieId: row.work_id}))};
  }
  async function discover(input) {
    keys(input, ['expectedGeneration', 'videoUrl', 'source'], ['expectedGeneration', 'videoUrl']);
    assert(integer(input.expectedGeneration));
    const videoId = parseVideoUrl(input.videoUrl), source = input.source ?? 'manual';
    assert(text(source, 200));
    const result = await batch([
      query('SELECT generation FROM ccm_state WHERE singleton=1'),
      query('SELECT id FROM works WHERE youtube_video_id=?', videoId),
      query(`SELECT d.id FROM discoveries d JOIN works w ON w.id=d.work_id
        WHERE w.youtube_video_id=? AND d.rule_id IS NULL AND d.method='url' AND d.condition_text=? LIMIT 1`, videoId, source),
    ]);
    assert(generation(result[0]) === input.expectedGeneration, 409, 'revision_conflict');
    const created = !result[1].results?.length, discoveryAdded = !result[2].results?.length;
    let workId = result[1].results?.[0]?.id;
    if (!discoveryAdded) return {...await service.state(), workId, created: false, discoveryAdded: false};
    if (created) {
      // Deleted CCM IDs remain tombstoned, while a later explicit rediscovery
      // starts a new unreviewed identity instead of reviving a publication.
      let available = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        workId = `movie_${uuid()}`;
        assert(id(workId), 500, 'invalid_identifier');
        const rows = await batch([query(`SELECT id FROM works WHERE id=?
          UNION ALL SELECT work_id AS id FROM ccm_tombstones WHERE work_id=?`, workId, workId)]);
        if (!rows[0].results?.length) { available = true; break; }
      }
      assert(available, 503, 'identifier_exhausted');
    } else {
      const count = await batch([query('SELECT COUNT(*) n FROM discoveries WHERE work_id=?', workId)]);
      assert(count[0].results[0].n < 100, 409, 'discovery_limit_reached');
    }
    const iso = timestamp(), statements = [];
    if (created) statements.push(query(`INSERT INTO works(id,youtube_video_id,status,created_at,updated_at)
      VALUES (?,?,'unreviewed',?,?)`, workId, videoId, iso, iso));
    statements.push(query(`INSERT INTO discoveries(work_id,rule_id,method,condition_text,discovered_at)
      VALUES (?,NULL,'url',?,?)`, workId, source, iso));
    await mutate(input.expectedGeneration, statements);
    return {...await service.state(), workId, created, discoveryAdded};
  }
  async function review(workId, input) {
    assert(id(workId));
    keys(input, ['expectedGeneration', 'status', 'reviewMemo', 'genreId'], ['expectedGeneration', 'status']);
    assert(integer(input.expectedGeneration) && STATUSES.has(input.status));
    assert(input.reviewMemo === undefined || input.reviewMemo === null ||
      (typeof input.reviewMemo === 'string' && input.reviewMemo.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.reviewMemo)));
    assert(input.genreId === undefined || input.genreId === null || id(input.genreId));
    const result = await batch([
      query('SELECT generation FROM ccm_state WHERE singleton=1'),
      query('SELECT id,review_memo,genre_id FROM works WHERE id=?', workId),
      query('SELECT id FROM genres WHERE id=? AND enabled=1', input.genreId ?? null),
    ]);
    assert(generation(result[0]) === input.expectedGeneration, 409, 'revision_conflict');
    assert(result[1].results?.length === 1, 404, 'unknown_work');
    if (input.genreId != null) assert(result[2].results?.length === 1, 409, 'unknown_genre');
    const old = result[1].results[0], iso = timestamp();
    await mutate(input.expectedGeneration, [query(`UPDATE works SET status=?,review_memo=?,genre_id=?,
      manual_confirmed_at=?,updated_at=? WHERE id=?`, input.status,
    input.reviewMemo === undefined ? old.review_memo : input.reviewMemo,
    input.genreId === undefined ? old.genre_id : input.genreId, iso, iso, workId)]);
    return service.state();
  }
  return {list, detail, approved, discover, review};
}
