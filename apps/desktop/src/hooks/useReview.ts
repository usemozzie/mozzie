import type { Ticket } from '@mozzie/db';
import { useAgentLogs } from './useAgents';
import { useDiff } from './useWorktree';

/**
 * Combined hook for the review state of a ticket.
 * Returns the git diff, the latest agent log, and loading states.
 * Only fetches when the ticket is in 'review' status.
 */
export function useReview(ticket: Ticket | null | undefined, enabled = true) {
  const shouldLoad = !!ticket && enabled;

  const diffQuery = useDiff(
    shouldLoad ? ticket?.worktree_path : null,
    shouldLoad ? ticket?.source_branch : null,
  );

  const logsQuery = useAgentLogs(shouldLoad ? (ticket?.id ?? null) : null);

  return {
    diff: diffQuery.data ?? null,
    diffLoading: diffQuery.isLoading,
    diffError: diffQuery.error instanceof Error
      ? diffQuery.error.message
      : diffQuery.error
        ? String(diffQuery.error)
        : null,
    logs: logsQuery.data ?? [],
    logsLoading: logsQuery.isLoading,
    latestLog: logsQuery.data?.[0] ?? null,
  };
}
