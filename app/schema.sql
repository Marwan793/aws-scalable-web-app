-- Run once against the RDS database before the first release.
CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
