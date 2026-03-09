import type { AgentSessionState } from '@mozzie/db';

export interface PtyOutputEvent {
  data: number[];
}

export interface PtyExitEvent {
  code: number;
  workItemId: string;
}

export interface WorkItemStateChangeEvent {
  workItemId: string;
  from: string;
  to: string;
}

export interface WorkItemGitStateChangeEvent {
  workItemId: string;
}

export interface AgentLogChangeEvent {
  workItemId: string;
  logId: string;
}

export interface AgentSessionStateEvent {
  workItemId: string;
  state: AgentSessionState | null;
}
