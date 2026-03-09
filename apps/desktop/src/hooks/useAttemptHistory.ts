import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { WorkItemAttempt } from '@mozzie/db';

export const ATTEMPTS_KEY = 'work_item_attempts';

export function useWorkItemAttempts(workItemId: string | null | undefined) {
  return useQuery<WorkItemAttempt[]>({
    queryKey: [ATTEMPTS_KEY, workItemId],
    queryFn: () => invoke('get_work_item_attempts', { workItemId }),
    enabled: !!workItemId,
    staleTime: 10_000,
  });
}

export function useRecordAttempt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      workItemId: string;
      agentId: string;
      agentLogId?: string | null;
      outcome: string;
      rejectionReason?: string | null;
      filesChanged?: string | null;
      diffSummary?: string | null;
      durationMs?: number | null;
      exitCode?: number | null;
    }) =>
      invoke<WorkItemAttempt>('record_work_item_attempt', {
        workItemId: params.workItemId,
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
      queryClient.invalidateQueries({ queryKey: [ATTEMPTS_KEY, params.workItemId] });
    },
  });
}
