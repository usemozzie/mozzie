export type WorkItemStatus = 'draft' | 'ready' | 'blocked' | 'queued' | 'running' | 'review' | 'done' | 'archived';

export interface WorkItem {
  id: string;
  title: string;
  context: string | null;
  execution_context: string | null;
  orchestrator_note: string | null;
  duplicate_of_work_item_id: string | null;
  duplicate_policy: string | null;
  intent_type: string | null;
  status: WorkItemStatus;
  repo_path: string | null;
  source_branch: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  assigned_agent: string | null;
  terminal_slot: number | null;
  parent_id: string | null;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkItemReviewState {
  work_item_id: string;
  review_status: 'unavailable' | 'clean' | 'changes' | 'merged' | string;
  summary: string;
  source_branch: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  diff: string;
  has_changes: boolean;
  is_merged: boolean;
  worktree_present: boolean;
  branch_present: boolean;
  can_review: boolean;
  can_continue: boolean;
  remote_branch_name: string | null;
  remote_branch_exists: boolean;
  ahead_count: number;
  behind_count: number;
  needs_push: boolean;
  can_push: boolean;
  push_summary: string;
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
  work_item_id: string;
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

export interface Repo {
  id: string;
  name: string;
  path: string;
  default_branch: string | null;
  needs_prepare: boolean;
  last_used_at: string | null;
  workspace_id: string;
  created_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface WorkItemDependency {
  work_item_id: string;
  depends_on_id: string;
  created_at: string;
}

export type AttemptOutcome = 'approved' | 'rejected' | 'error' | 'timeout';

export interface WorkItemAttempt {
  id: string;
  work_item_id: string;
  attempt_number: number;
  agent_id: string;
  agent_log_id: string | null;
  outcome: AttemptOutcome;
  rejection_reason: string | null;
  files_changed: string | null;
  diff_summary: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  workspace_id: string;
  title: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'orchestrator';
  text: string;
  metadata: string | null;
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
  strengths: string | null;
  weaknesses: string | null;
  best_for: string | null;
  reasoning_class: string | null;
  speed_class: string | null;
  edit_reliability: string | null;
}

export type AgentPermissionPolicy =
  | 'ask'
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AgentPermissionOption {
  option_id: string;
  name: string;
  kind: string;
}

export interface AgentPermissionRequest {
  request_id: string;
  tool_title: string | null;
  tool_kind: string | null;
  tool_input: string | null;
  options: AgentPermissionOption[];
  created_at: string;
}

export interface AgentSessionState {
  work_item_id: string;
  agent_id: string;
  session_id: string;
  is_running: boolean;
  opened_at: string;
  last_activity_at: string;
  idle_deadline_at: string;
  permission_policy: AgentPermissionPolicy;
  pending_permission: AgentPermissionRequest | null;
}
