CREATE TABLE IF NOT EXISTS ccm_deployment_recoveries (
  attempt_id TEXT PRIMARY KEY REFERENCES ccm_deployment_attempts(attempt_id),
  recovered_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
