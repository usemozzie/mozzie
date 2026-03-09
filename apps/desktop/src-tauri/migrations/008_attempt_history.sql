CREATE TABLE IF NOT EXISTS work_item_attempts (
  id               TEXT PRIMARY KEY,
  work_item_id     TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
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
  UNIQUE (work_item_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_attempts_work_item ON work_item_attempts(work_item_id);
CREATE INDEX IF NOT EXISTS idx_attempts_work_item_number ON work_item_attempts(work_item_id, attempt_number);
