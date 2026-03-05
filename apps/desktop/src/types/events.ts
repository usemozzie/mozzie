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
