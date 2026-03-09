ALTER TABLE work_items ADD COLUMN execution_context TEXT;
ALTER TABLE work_items ADD COLUMN orchestrator_note TEXT;
ALTER TABLE work_items ADD COLUMN duplicate_of_work_item_id TEXT;
ALTER TABLE work_items ADD COLUMN duplicate_policy TEXT;
ALTER TABLE work_items ADD COLUMN intent_type TEXT;

ALTER TABLE agent_config ADD COLUMN strengths TEXT;
ALTER TABLE agent_config ADD COLUMN weaknesses TEXT;
ALTER TABLE agent_config ADD COLUMN best_for TEXT;
ALTER TABLE agent_config ADD COLUMN reasoning_class TEXT;
ALTER TABLE agent_config ADD COLUMN speed_class TEXT;
ALTER TABLE agent_config ADD COLUMN edit_reliability TEXT;
