-- Rename tables and columns from "ticket" to "work_item".
-- SQLite 3.25+ supports ALTER TABLE RENAME COLUMN and ALTER TABLE RENAME TO.

-- Rename main table
ALTER TABLE tickets RENAME TO work_items;

-- Rename columns in work_items (duplicate_of_ticket_id)
ALTER TABLE work_items RENAME COLUMN duplicate_of_ticket_id TO duplicate_of_work_item_id;

-- Rename agent_logs.ticket_id
ALTER TABLE agent_logs RENAME COLUMN ticket_id TO work_item_id;

-- Rename ticket_dependencies table and columns
ALTER TABLE ticket_dependencies RENAME TO work_item_dependencies;
ALTER TABLE work_item_dependencies RENAME COLUMN ticket_id TO work_item_id;

-- Rename ticket_attempts table and columns
ALTER TABLE ticket_attempts RENAME TO work_item_attempts;
ALTER TABLE work_item_attempts RENAME COLUMN ticket_id TO work_item_id;
