CREATE TABLE IF NOT EXISTS work_item_chat_messages (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    agent_log_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_log_id) REFERENCES agent_logs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_work_item_chat_messages_work_item_id
    ON work_item_chat_messages(work_item_id, created_at);
