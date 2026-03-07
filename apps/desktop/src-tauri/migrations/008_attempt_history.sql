CREATE TABLE IF NOT EXISTS ticket_attempts (
  id               TEXT PRIMARY KEY,
  ticket_id        TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  attempt_number   INTEGER NOT NULL,
  agent_id         TEXT NOT NULL,
  agent_log_id     TEXT,
  outcome          TEXT NOT NULL,          -- 'approved' | 'rejected' | 'error' | 'timeout'
  rejection_reason TEXT,
  files_changed    TEXT,                   -- JSON array of file paths
  diff_summary     TEXT,
  duration_ms      INTEGER,
  exit_code        INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ticket_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_attempts_ticket ON ticket_attempts(ticket_id);
CREATE INDEX IF NOT EXISTS idx_attempts_ticket_number ON ticket_attempts(ticket_id, attempt_number);
