import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { TicketAttempt } from '@mozzie/db';

export const ATTEMPTS_KEY = 'ticket_attempts';

export function useTicketAttempts(ticketId: string | null | undefined) {
  return useQuery<TicketAttempt[]>({
    queryKey: [ATTEMPTS_KEY, ticketId],
    queryFn: () => invoke('get_ticket_attempts', { ticketId }),
    enabled: !!ticketId,
    staleTime: 10_000,
  });
}

export function useRecordAttempt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      ticketId: string;
      agentId: string;
      agentLogId?: string | null;
      outcome: string;
      rejectionReason?: string | null;
      filesChanged?: string | null;
      diffSummary?: string | null;
      durationMs?: number | null;
      exitCode?: number | null;
    }) =>
      invoke<TicketAttempt>('record_ticket_attempt', {
        ticketId: params.ticketId,
        agentId: params.agentId,
        agentLogId: params.agentLogId ?? null,
        outcome: params.outcome,
        rejectionReason: params.rejectionReason ?? null,
        filesChanged: params.filesChanged ?? null,
        diffSummary: params.diffSummary ?? null,
        durationMs: params.durationMs ?? null,
        exitCode: params.exitCode ?? null,
      }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: [ATTEMPTS_KEY, params.ticketId] });
    },
  });
}
