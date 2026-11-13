CREATE TABLE IF NOT EXISTS ccm_maintenance_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed')),
  error_code TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER
);
CREATE INDEX IF NOT EXISTS ccm_maintenance_runs_started ON ccm_maintenance_runs(started_at);
