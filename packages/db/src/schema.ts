export type TicketStatus = 'draft' | 'ready' | 'queued' | 'running' | 'review' | 'done' | 'archived';

export interface Ticket {
  id: string;
  title: string;
  context: string | null;
  status: TicketStatus;
  repo_path: string | null;
  source_branch: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  assigned_agent: string | null;
  terminal_slot: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** A single streamed event item from an ACP run, stored as JSON in agent_logs.messages. */
export interface AcpEventItem {
  id: string;
  /** "text" | "text_delta" | "tool_call" | "tool_result" | "error" | "done" */
  kind: string;
  content: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_call_id: string | null;
  ts: string;
}

export interface AgentLog {
  id: string;
  ticket_id: string;
  agent_id: string;
  run_id: string | null;
  /** JSON-serialised AcpEventItem[] collected during the run. */
  messages: string | null;
  summary: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  cleanup_warning: number | null;
  cleanup_warning_message: string | null;
  created_at: string;
}

export interface AgentConfig {
  id: string;
  display_name: string;
  /** ACP transport target, e.g. "builtin:claude-code" or "stdio:gemini --experimental-acp" */
  acp_url: string;
  /** Name of the environment variable that holds the API key (optional). */
  api_key_ref: string | null;
  model: string | null;
  max_concurrent: number;
  enabled: number;
}
