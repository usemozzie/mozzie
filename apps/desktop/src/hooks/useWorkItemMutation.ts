import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { WorkItem, WorkItemStatus } from '@mozzie/db';
import { WORK_ITEM_KEY, WORK_ITEMS_KEY } from './useWorkItems';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function useCreateWorkItem() {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return useMutation({
    mutationFn: (params: {
      title: string;
      context?: string;
      execution_context?: string;
      orchestrator_note?: string;
      repo_path?: string;
      assigned_agent?: string;
      branch_name?: string;
      source_branch?: string;
      parent_id?: string;
      duplicate_of_work_item_id?: string;
      duplicate_policy?: string;
      intent_type?: string;
    }) =>
      invoke<WorkItem>('create_work_item', {
        title: params.title,
        context: params.context ?? null,
        executionContext: params.execution_context ?? null,
        orchestratorNote: params.orchestrator_note ?? null,
        repoPath: params.repo_path ?? null,
        assignedAgent: params.assigned_agent ?? null,
        branchName: params.branch_name ?? null,
        sourceBranch: params.source_branch ?? null,
        parentId: params.parent_id ?? null,
        duplicateOfWorkItemId: params.duplicate_of_work_item_id ?? null,
        duplicatePolicy: params.duplicate_policy ?? null,
        intentType: params.intent_type ?? null,
        workspaceId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
    },
  });
}

export function useUpdateWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; fields: Record<string, unknown> }) =>
      invoke<WorkItem>('update_work_item', {
        id: params.id,
        fields: params.fields,
      }),
    onSuccess: (workItem) => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_KEY, workItem.id] });
    },
  });
}

export function useTransitionWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; toStatus: WorkItemStatus }) =>
      invoke<WorkItem>('transition_work_item', {
        id: params.id,
        toStatus: params.toStatus,
      }),
    onSuccess: (workItem) => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_KEY, workItem.id] });
    },
  });
}

export function useDeleteWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>('delete_work_item', { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
    },
  });
}

export function useCloseWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<WorkItem>('close_work_item', { id }),
    onSuccess: (workItem) => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_KEY, workItem.id] });
    },
  });
}

export function useReopenWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<WorkItem>('reopen_work_item', { id }),
    onSuccess: (workItem) => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_KEY, workItem.id] });
    },
  });
}
