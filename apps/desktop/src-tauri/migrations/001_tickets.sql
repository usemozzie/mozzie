CREATE TABLE IF NOT EXISTS work_items (
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

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_updated_at ON work_items(updated_at);
