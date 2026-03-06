CREATE TABLE IF NOT EXISTS repos (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    default_branch TEXT,
    last_used_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
