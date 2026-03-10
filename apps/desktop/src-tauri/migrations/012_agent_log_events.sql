CREATE TABLE IF NOT EXISTS agent_log_events (
  id         TEXT PRIMARY KEY,
  log_id     TEXT NOT NULL REFERENCES agent_logs(id),
  seq        INTEGER NOT NULL,
  item_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_log_events_log_id ON agent_log_events(log_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_log_events_log_seq ON agent_log_events(log_id, seq);
