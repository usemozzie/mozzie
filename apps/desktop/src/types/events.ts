import type { AgentSessionState } from '@mozzie/db';

export interface PtyOutputEvent {
  data: number[];
}

export interface PtyExitEvent {
  code: number;
  ticketId: string;
}

export interface TicketStateChangeEvent {
  ticketId: string;
  from: string;
  to: string;
}

export interface AgentLogChangeEvent {
  ticketId: string;
  logId: string;
}

export interface AgentSessionStateEvent {
  ticketId: string;
  state: AgentSessionState | null;
}
