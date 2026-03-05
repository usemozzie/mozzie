CREATE TABLE IF NOT EXISTS agent_logs (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  agent_id    TEXT NOT NULL,
  run_id      TEXT,           -- ACP run identifier returned by the agent server
  messages    TEXT,           -- JSON: AcpEventItem[] (streamed events from the run)
  summary     TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  exit_code   INTEGER,
  duration_ms INTEGER,
  cleanup_warning INTEGER,
  cleanup_warning_message TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_logs_ticket_id ON agent_logs(ticket_id);
