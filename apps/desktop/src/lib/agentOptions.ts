export const AGENT_OPTIONS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'gemini-cli', label: 'Gemini CLI' },
  { value: 'codex-cli', label: 'Codex CLI' },
] as const;

export const DEFAULT_AGENT = 'claude-code';
