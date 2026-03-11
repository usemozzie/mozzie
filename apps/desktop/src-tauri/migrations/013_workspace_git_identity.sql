-- Add optional git identity columns to workspaces.
-- When set, Mozzie uses these for commits instead of the hardcoded defaults.
-- NULL means "use the repo's own git config".
ALTER TABLE workspaces ADD COLUMN git_user_name TEXT;
ALTER TABLE workspaces ADD COLUMN git_user_email TEXT;
