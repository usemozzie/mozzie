-- Add parent/child relationship for stacked branches.
-- parent_id references another work_items row. NULL = standalone or parent.
ALTER TABLE work_items ADD COLUMN parent_id TEXT REFERENCES work_items(id);
CREATE INDEX IF NOT EXISTS idx_work_items_parent_id ON work_items(parent_id);
