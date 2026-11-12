// Keep API responses and request URLs out of application logs and errors.
export function durationSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(x => x !== undefined)) return null;
  const seconds = Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600
    + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  return Number.isSafeInteger(Math.ceil(seconds)) ? Math.ceil(seconds) : null;
}

export async function boundedJson(response, maxBytes = 1048576) {
  if (!response.body) throw new Error('invalid_json');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('payload_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

export async function fetchMetadata(targets, apiKey, fetcher = fetch) {
  const failure = () => targets.map(t => ({workId: t.workId, status: 'api_error'}));
  if (!targets.length || targets.length > 50) throw new Error('invalid_targets');
  const ids = targets.map(t => t.videoId);
  if (ids.some(id => !/^[A-Za-z0-9_-]{11}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('invalid_video_identity');
  }
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('fields', 'kind,nextPageToken,items(id,snippet(title,channelId,channelTitle),contentDetails(duration))');
  let data;
  try {
    const response = await fetcher(url.toString(), {
      method: 'GET', headers: {'X-Goog-Api-Key': apiKey},
      redirect: 'manual', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return failure();
    data = await boundedJson(response);
  } catch { return failure(); }
  // A malformed or partial response is never evidence that a video disappeared.
  if (!data || data.kind !== 'youtube#videoListResponse' || !Array.isArray(data.items)
      || data.error || data.nextPageToken || data.items.length > ids.length) return failure();
  const byId = new Map();
  const metadataText = (value, max) => typeof value === 'string' && value.trim().length > 0
    && value.length <= max && !value.includes('\u0000');
  for (const item of data.items) {
    const duration = durationSeconds(item?.contentDetails?.duration);
    if (!item || !ids.includes(item.id) || byId.has(item.id)
        || !metadataText(item.snippet?.title, 500)
        || !metadataText(item.snippet?.channelId, 128)
        || !metadataText(item.snippet?.channelTitle, 500)
        || duration === null) return failure();
    byId.set(item.id, {title: item.snippet.title, channelId: item.snippet.channelId,
      channelName: item.snippet.channelTitle, durationSeconds: duration});
  }
  return targets.map(t => byId.has(t.videoId)
    ? {workId: t.workId, status: 'ok', ...byId.get(t.videoId)}
    : {workId: t.workId, status: 'unavailable'});
}

export function quotaDay(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function reserveApiUnit(db, timestamp, limit) {
  const day = quotaDay(timestamp);
  const row = await db.prepare(`INSERT INTO ccm_api_budget(day_key, units)
    SELECT ?, 1 WHERE ? > 0
    ON CONFLICT(day_key) DO UPDATE SET units = units + 1 WHERE units < ?
    RETURNING units`).bind(day, limit, limit).first();
  return !!row;
}
