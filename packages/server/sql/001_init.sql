-- PR Walkthrough — durable history (Supabase / any Postgres).
-- Applied automatically on server boot when DATABASE_URL is set. Idempotent.

CREATE TABLE IF NOT EXISTS walkthroughs (
  owner       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  number      INTEGER NOT NULL,
  head_sha    TEXT,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, repo, number)
);

CREATE INDEX IF NOT EXISTS walkthroughs_updated_at_idx
  ON walkthroughs (updated_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  status       TEXT NOT NULL,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS jobs_pr_idx
  ON jobs (owner, repo, number, created_at DESC);

CREATE INDEX IF NOT EXISTS jobs_created_at_idx
  ON jobs (created_at DESC);

-- One row per paid Bob Shell call; the sum of actual_cost is checked against BOB_BUDGET_USD.
CREATE TABLE IF NOT EXISTS spend (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pr           TEXT NOT NULL,
  mode         TEXT NOT NULL,
  max_cost     NUMERIC NOT NULL,
  actual_cost  NUMERIC NOT NULL,
  duration_sec INTEGER NOT NULL,
  tool_calls   INTEGER NOT NULL,
  subagents    INTEGER NOT NULL,
  repairs      INTEGER NOT NULL,
  valid        BOOLEAN,
  notes        TEXT
);

-- The API connects with the database owner role; nothing is exposed through
-- Supabase's auto-generated REST API.
ALTER TABLE walkthroughs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend ENABLE ROW LEVEL SECURITY;
