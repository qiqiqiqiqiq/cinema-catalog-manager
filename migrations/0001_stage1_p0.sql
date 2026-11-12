-- Additive Stage 1 P0 migration. Existing snapshot bodies are not trusted or
-- exposed. The first explicit approval initializes the new publication model.
CREATE TABLE IF NOT EXISTS ccm_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
  generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  deployed_revision INTEGER NOT NULL DEFAULT 0,
  verified_revision INTEGER NOT NULL DEFAULT 0,
  active_attempt_id TEXT
);
INSERT OR IGNORE INTO ccm_state (singleton, revision)
  SELECT 1, COALESCE(MAX(revision), 0) FROM publication_snapshots;

CREATE TABLE IF NOT EXISTS ccm_approved_movies (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  position INTEGER NOT NULL,
  genre TEXT NOT NULL,
  title_mode TEXT NOT NULL CHECK (title_mode IN ('api', 'manual')),
  manual_title TEXT,
  CHECK ((title_mode = 'api' AND manual_title IS NULL) OR
         (title_mode = 'manual' AND manual_title IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS ccm_approved_queue (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES ccm_approved_movies(work_id),
  position INTEGER NOT NULL
);
-- IDs are independent CCM identifiers. This ledger never contains YouTube IDs.
CREATE TABLE IF NOT EXISTS ccm_queue_identities (
  queue_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL
);
INSERT OR IGNORE INTO ccm_queue_identities(queue_id, work_id)
  SELECT id, work_id FROM queue_items;
CREATE TABLE IF NOT EXISTS ccm_tombstones (
  work_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ccm_metadata_state (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  first_missing_at TEXT,
  last_missing_at TEXT,
  missing_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ccm_publication_requests (
  revision INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'deploying', 'deployed', 'verified', 'failed', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ccm_deployment_attempts (
  attempt_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  authorized_at TEXT,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IN ('verified', 'failed', 'superseded', 'uncertain')),
  deployed INTEGER NOT NULL DEFAULT 0,
  library_matches INTEGER NOT NULL DEFAULT 0,
  queue_matches INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  phase TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  terminal_request_json TEXT
);
-- A failed compare-and-swap MUST throw: a zero-row UPDATE does not abort batch.
CREATE TABLE IF NOT EXISTS ccm_cas_guards (
  operation_id TEXT PRIMARY KEY,
  accepted INTEGER NOT NULL CONSTRAINT ccm_cas_guard CHECK (accepted = 1)
);
