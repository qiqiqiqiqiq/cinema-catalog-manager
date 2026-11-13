-- Supporting indexes only: discovery/review keep the existing base schema.
-- No titles, channel data, or discovery results belong in migration files.
CREATE INDEX IF NOT EXISTS ccm_works_status_id ON works(status,id);
CREATE INDEX IF NOT EXISTS ccm_discoveries_work_id ON discoveries(work_id,id);
