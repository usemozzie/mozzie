CREATE TABLE IF NOT EXISTS ticket_dependencies (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, depends_on_id),
  CHECK (ticket_id != depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_ticket ON ticket_dependencies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON ticket_dependencies(depends_on_id);
