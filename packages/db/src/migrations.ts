export const CREATE_TICKETS_TABLE = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'medium',
  tags TEXT NOT NULL DEFAULT '[]',
  prompt TEXT,
  plan TEXT,
  repo_path TEXT,
  source_branch TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  assigned_agent TEXT,
  terminal_slot INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
`;

export const CREATE_AGENT_LOGS_TABLE = `
CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  agent_id TEXT NOT NULL,
  run_id TEXT,
  messages TEXT,
  summary TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  exit_code INTEGER,
  duration_ms INTEGER,
  cleanup_warning INTEGER,
  cleanup_warning_message TEXT,
  created_at TEXT NOT NULL
);
`;

export const CREATE_AGENT_CONFIG_TABLE = `
CREATE TABLE IF NOT EXISTS agent_config (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  acp_url TEXT NOT NULL DEFAULT 'http://localhost:8330',
  api_key_ref TEXT,
  model TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);
`;

export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_updated_at ON tickets(updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_logs_ticket_id ON agent_logs(ticket_id);
`;

export const INSERT_DEFAULT_AGENTS = `
INSERT OR IGNORE INTO agent_config (id, display_name, acp_url, max_concurrent, enabled)
VALUES
  ('claude-code', 'Claude Code', 'http://localhost:8330', 1, 1),
  ('gemini-cli',  'Gemini CLI',  'http://localhost:8331', 1, 1),
  ('codex-cli',   'Codex CLI',   'http://localhost:8332', 1, 1);
`;

export const ALL_MIGRATIONS = [
  CREATE_TICKETS_TABLE,
  CREATE_AGENT_LOGS_TABLE,
  CREATE_AGENT_CONFIG_TABLE,
  CREATE_INDEXES,
  INSERT_DEFAULT_AGENTS,
];
