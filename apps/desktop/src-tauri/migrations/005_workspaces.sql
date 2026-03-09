-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the default workspace
INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at)
VALUES ('default', 'Default', datetime('now'), datetime('now'));

-- Workspace notes (one row per workspace)
CREATE TABLE IF NOT EXISTS workspace_notes (
    workspace_id TEXT PRIMARY KEY NOT NULL,
    content      TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
