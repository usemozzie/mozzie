import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import type { WorkItem, WorkItemStatus } from '@mozzie/db';
import type { WorkItemGitStateChangeEvent, WorkItemStateChangeEvent } from '../types/events';
import { useWorkspaceStore } from '../stores/workspaceStore';

export const WORK_ITEMS_KEY = 'work_items';
export const WORK_ITEM_KEY = 'work_item';

export function useWorkItems(statusFilter?: WorkItemStatus[]) {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    const unlistenState = listen<WorkItemStateChangeEvent>(
      'work-item:state-change',
      () => {
        queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
      }
    );
    const unlistenGit = listen<WorkItemGitStateChangeEvent>(
      'work-item:git-state-change',
      () => {
        queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
      }
    );
    return () => {
      unlistenState.then((fn) => fn());
      unlistenGit.then((fn) => fn());
    };
  }, [queryClient]);

  return useQuery({
    queryKey: [WORK_ITEMS_KEY, statusFilter, workspaceId],
    queryFn: () =>
      invoke<WorkItem[]>('list_work_items', {
        statusFilter: statusFilter ?? null,
        workspaceId,
      }),
  });
}

export function useWorkItem(id: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!id) return;
    const unlistenState = listen<WorkItemStateChangeEvent>(
      'work-item:state-change',
      (event) => {
        if (event.payload.workItemId === id) {
          queryClient.invalidateQueries({ queryKey: [WORK_ITEM_KEY, id] });
        }
      }
    );
    const unlistenGit = listen<WorkItemGitStateChangeEvent>(
      'work-item:git-state-change',
      (event) => {
        if (event.payload.workItemId === id) {
          queryClient.invalidateQueries({ queryKey: [WORK_ITEM_KEY, id] });
        }
      }
    );
    return () => {
      unlistenState.then((fn) => fn());
      unlistenGit.then((fn) => fn());
    };
  }, [id, queryClient]);

  return useQuery({
    queryKey: [WORK_ITEM_KEY, id],
    queryFn: () => invoke<WorkItem>('get_work_item', { id }),
    enabled: !!id,
  });
}
