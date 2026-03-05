CREATE TABLE IF NOT EXISTS agent_config (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  acp_url         TEXT NOT NULL DEFAULT 'builtin:claude-code',
  api_key_ref     TEXT,     -- env-var name holding the API key (e.g. ANTHROPIC_API_KEY)
  model           TEXT,     -- optional model override forwarded in the ACP request
  max_concurrent  INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1
);

-- Seed the three well-known agents with built-in ACP transport aliases.
INSERT OR IGNORE INTO agent_config (id, display_name, acp_url, max_concurrent, enabled)
VALUES
  ('claude-code', 'Claude Code', 'builtin:claude-code', 1, 1),
  ('gemini-cli',  'Gemini CLI',  'builtin:gemini-cli', 1, 1),
  ('codex-cli',   'Codex CLI',   'builtin:codex-cli', 1, 1);
