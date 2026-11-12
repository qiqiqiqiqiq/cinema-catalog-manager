-- This counter covers calls made by this Worker, not other API clients.
CREATE TABLE ccm_api_budget (
  day_key TEXT PRIMARY KEY,
  units INTEGER NOT NULL CHECK (units >= 0)
);
