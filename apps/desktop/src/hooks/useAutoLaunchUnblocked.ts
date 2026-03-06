import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';
import type { Ticket } from '@mozzie/db';
import { useStartAgent } from './useStartAgent';
import { TICKETS_KEY } from './useTickets';

/**
 * Listens for `ticket:deps-unblocked` events (emitted by the Rust cascade logic
 * when a ticket is approved and its dependents become unblocked).
 * Auto-starts each newly-unblocked ticket.
 */
export function useAutoLaunchUnblocked() {
  const { startAgent } = useStartAgent();
  const queryClient = useQueryClient();
  const startAgentRef = useRef(startAgent);
  startAgentRef.current = startAgent;

  useEffect(() => {
    const unlisten = listen<{ ticketIds: string[] }>('ticket:deps-unblocked', async (event) => {
      // Invalidate ticket list so UI updates
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });

      // Auto-launch each unblocked ticket sequentially
      for (const ticketId of event.payload.ticketIds) {
        try {
          const ticket = await invoke<Ticket>('get_ticket', { id: ticketId });
          if (ticket.status === 'ready') {
            await startAgentRef.current(ticket);
          }
        } catch {
          // Ticket may have been deleted or is no longer in ready state
        }
      }
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [queryClient]);
}
