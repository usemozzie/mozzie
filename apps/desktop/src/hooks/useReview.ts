import type { WorkItem } from '@mozzie/db';
import { useAgentLogs } from './useAgents';
import { useWorkItemReviewState } from './useWorktree';

export function useReview(workItem: WorkItem | null | undefined, enabled = true) {
  const shouldLoad = !!workItem && enabled;
  const reviewQuery = useWorkItemReviewState(shouldLoad ? workItem?.id ?? null : null);
  const logsQuery = useAgentLogs(shouldLoad ? workItem?.id ?? null : null);

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
