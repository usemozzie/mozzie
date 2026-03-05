import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import type { Ticket, TicketStatus } from '@mozzie/db';
import type { TicketStateChangeEvent } from '../types/events';

export const TICKETS_KEY = 'tickets';
export const TICKET_KEY = 'ticket';

export function useTickets(statusFilter?: TicketStatus[]) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listen<TicketStateChangeEvent>(
      'ticket:state-change',
      () => {
        queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [queryClient]);

  return useQuery({
    queryKey: [TICKETS_KEY, statusFilter],
    queryFn: () =>
      invoke<Ticket[]>('list_tickets', {
        statusFilter: statusFilter ?? null,
      }),
  });
}

export function useTicket(id: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!id) return;
    const unlisten = listen<TicketStateChangeEvent>(
      'ticket:state-change',
      (event) => {
        if (event.payload.ticketId === id) {
          queryClient.invalidateQueries({ queryKey: [TICKET_KEY, id] });
        }
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [id, queryClient]);

  return useQuery({
    queryKey: [TICKET_KEY, id],
    queryFn: () => invoke<Ticket>('get_ticket', { id }),
    enabled: !!id,
  });
}
