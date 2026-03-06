ALTER TABLE tickets ADD COLUMN execution_context TEXT;
ALTER TABLE tickets ADD COLUMN orchestrator_note TEXT;
ALTER TABLE tickets ADD COLUMN duplicate_of_ticket_id TEXT;
ALTER TABLE tickets ADD COLUMN duplicate_policy TEXT;
ALTER TABLE tickets ADD COLUMN intent_type TEXT;

ALTER TABLE agent_config ADD COLUMN strengths TEXT;
ALTER TABLE agent_config ADD COLUMN weaknesses TEXT;
ALTER TABLE agent_config ADD COLUMN best_for TEXT;
ALTER TABLE agent_config ADD COLUMN reasoning_class TEXT;
ALTER TABLE agent_config ADD COLUMN speed_class TEXT;
ALTER TABLE agent_config ADD COLUMN edit_reliability TEXT;
