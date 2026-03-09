CREATE TABLE IF NOT EXISTS work_item_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (work_item_id, depends_on_id),
  CHECK (work_item_id != depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_work_item ON work_item_dependencies(work_item_id);
CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON work_item_dependencies(depends_on_id);
