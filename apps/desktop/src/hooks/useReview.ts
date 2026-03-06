import type { Ticket } from '@mozzie/db';
import { useAgentLogs } from './useAgents';
import { useTicketReviewState } from './useWorktree';

export function useReview(ticket: Ticket | null | undefined, enabled = true) {
  const shouldLoad = !!ticket && enabled;
  const reviewQuery = useTicketReviewState(shouldLoad ? ticket?.id ?? null : null);
  const logsQuery = useAgentLogs(shouldLoad ? ticket?.id ?? null : null);

  return {
    review: reviewQuery.data ?? null,
    reviewLoading: reviewQuery.isLoading,
    reviewError: reviewQuery.error instanceof Error
      ? reviewQuery.error.message
      : reviewQuery.error
        ? String(reviewQuery.error)
        : null,
    logs: logsQuery.data ?? [],
    logsLoading: logsQuery.isLoading,
    latestLog: logsQuery.data?.[0] ?? null,
  };
}
