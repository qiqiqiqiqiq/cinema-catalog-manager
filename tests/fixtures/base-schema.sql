CREATE TABLE _cf_KV (
        key TEXT PRIMARY KEY,
        value BLOB
      ) WITHOUT ROWID;

CREATE TABLE api_metadata (
  work_id TEXT PRIMARY KEY REFERENCES works (id),
  video_id TEXT NOT NULL,
  title TEXT,                          -- API 取得タイトル
  channel_id TEXT,
  channel_name TEXT,                   -- API 取得チャンネル名
  duration_seconds INTEGER,
  fetch_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (fetch_status IN ('ok', 'unavailable', 'api_error', 'unknown', 'stale')),
  last_ok_at TEXT,                     -- 最終正常取得日時 (§7.5)
  last_attempt_at TEXT,                -- 最終試行日時
  consecutive_unavailable INTEGER NOT NULL DEFAULT 0,  -- 連続取得不能回数 (§9.2: 2回で確定)
  retention_deadline TEXT,             -- 保持期限 (§7.2)
  extension_used INTEGER NOT NULL DEFAULT 0  -- 保留・却下の延長は最大1回 (§7.2)
);

CREATE TABLE deletion_audit (
  event_id TEXT PRIMARY KEY,           -- 例: delete_000152
  work_id TEXT NOT NULL,               -- CCM 内部作品 ID のみ
  deleted_at TEXT NOT NULL,
  reason_code TEXT NOT NULL            -- unavailable_confirmed / metadata_expired / manual_removal
    CHECK (reason_code IN ('unavailable_confirmed', 'metadata_expired', 'manual_removal')),
  trigger TEXT NOT NULL                -- automatic / manual
    CHECK (trigger IN ('automatic', 'manual')),
  removed_queue_entries INTEGER NOT NULL DEFAULT 0,
  publication_revision INTEGER,
  publication_status TEXT
);

CREATE TABLE discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL REFERENCES works (id),
  rule_id TEXT REFERENCES rules (id),
  method TEXT,                         -- チャンネル巡回 / 再生リスト / キーワード / URL単体
  condition_text TEXT,                 -- 発見時の検索条件。API 由来情報を含めない
  discovered_at TEXT NOT NULL
);

CREATE TABLE genres (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE publication_snapshots (
  revision INTEGER PRIMARY KEY,        -- 公開リビジョン。単調増加 (§11.4)
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'deploying', 'deployed', 'verified', 'failed')),
  created_at TEXT NOT NULL
);

CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,                 -- キュー ID (例: queue_001)
  work_id TEXT NOT NULL REFERENCES works (id),
  position INTEGER NOT NULL
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  genre_id TEXT REFERENCES genres (id),  -- 発見時に付ける代表ジャンル1つ
  method TEXT NOT NULL,                -- channel / playlist / keyword / url
  target TEXT,                         -- チャンネル / 再生リスト / キーワード (方法に応じて1つ)
  exclude_keywords TEXT,
  min_duration_seconds INTEGER,
  max_duration_seconds INTEGER,
  max_items INTEGER,
  interval_text TEXT
);

CREATE TABLE run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- discovery / refresh / deletion / deploy
  started_at TEXT NOT NULL,
  finished_at TEXT,
  detail_json TEXT,                    -- 件数・API 使用量・結果 (API 応答本文は含めない)
  api_units_used INTEGER
);

CREATE TABLE works (
  id TEXT PRIMARY KEY,                 -- CCM 作品 ID (例: movie_001)
  youtube_video_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (status IN ('unreviewed', 'held', 'rejected', 'approved')),
  genre_id TEXT REFERENCES genres (id),
  review_memo TEXT,                    -- 審査メモ (§8.4)。公開 JSON には出さない
  manual_confirmed_at TEXT,            -- 手動確認日時 (§8.5)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
