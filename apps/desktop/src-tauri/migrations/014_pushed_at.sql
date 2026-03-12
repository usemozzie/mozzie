-- Track when a work item's branch was last pushed to origin.
ALTER TABLE work_items ADD COLUMN pushed_at TEXT;
