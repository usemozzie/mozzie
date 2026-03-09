import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { WorkItemReviewState } from '@mozzie/db';
import type { WorkItemGitStateChangeEvent, WorkItemStateChangeEvent } from '../types/events';
import { WORK_ITEM_KEY, WORK_ITEMS_KEY } from './useWorkItems';

export interface WorktreeInfo {
  worktree_path: string;
  branch_name: string;
  source_branch: string;
}

export interface RepoBranchInfo {
  branch_name: string;
  detached: boolean;
}

const WORK_ITEM_REVIEW_KEY = 'work_item_review';

export function useCreateWorktree() {
  return useMutation({
    mutationFn: ({
      workItemId,
      repoPath,
      sourceBranch,
      branchName,
    }: {
      workItemId: string;
      repoPath: string;
      sourceBranch?: string;
      branchName?: string;
    }) =>
      invoke<WorktreeInfo>('create_worktree', {
        workItemId,
        repoPath,
        sourceBranch: sourceBranch ?? null,
        branchName: branchName ?? null,
      }),
  });
}

export function useRemoveWorktree() {
  return useMutation({
    mutationFn: ({
      worktreePath,
      repoPath,
      branchName,
    }: {
      worktreePath: string;
      repoPath: string;
      branchName: string;
    }) =>
      invoke('remove_worktree', {
        worktreePath,
        repoPath,
        branchName,
      }),
  });
}

export function useDiff(
  worktreePath: string | null | undefined,
  sourceBranch?: string | null | undefined,
) {
  return useQuery<string>({
    queryKey: ['diff', worktreePath, sourceBranch],
    queryFn: () =>
      invoke('get_diff', {
        worktreePath: worktreePath!,
        sourceBranch: sourceBranch ?? null,
      }),
    enabled: !!worktreePath,
    staleTime: 30_000,
  });
}

export function useMergeBranch() {
  return useMutation({
    mutationFn: ({
      repoPath,
      worktreePath,
      sourceBranch,
      branchName,
    }: {
      repoPath: string;
      worktreePath: string;
      sourceBranch: string;
      branchName: string;
    }) =>
      invoke('merge_branch', {
        repoPath,
        worktreePath,
        sourceBranch,
        branchName,
      }),
  });
}

export function useWorkItemReviewState(workItemId: string | null | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workItemId) return;
    const unlistenState = listen<WorkItemStateChangeEvent>('work-item:state-change', (event) => {
      if (event.payload.workItemId === workItemId) {
        queryClient.invalidateQueries({ queryKey: [WORK_ITEM_REVIEW_KEY, workItemId] });
      }
    });
    const unlistenGit = listen<WorkItemGitStateChangeEvent>('work-item:git-state-change', (event) => {
      if (event.payload.workItemId === workItemId) {
        queryClient.invalidateQueries({ queryKey: [WORK_ITEM_REVIEW_KEY, workItemId] });
      }
    });
    return () => {
      unlistenState.then((fn) => fn());
      unlistenGit.then((fn) => fn());
    };
  }, [workItemId, queryClient]);

  return useQuery<WorkItemReviewState>({
    queryKey: [WORK_ITEM_REVIEW_KEY, workItemId],
    queryFn: () => invoke('get_work_item_review_state', { workItemId }),
    enabled: !!workItemId,
    staleTime: 5_000,
  });
}

export function useApproveWorkItemReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => invoke('approve_work_item_review', { workItemId }),
    onSuccess: (_value, workItemId) => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_REVIEW_KEY, workItemId] });
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_KEY, workItemId] });
      queryClient.invalidateQueries({ queryKey: ['repo_branch'] });
      queryClient.invalidateQueries({ queryKey: ['repo_branches'] });
    },
  });
}

export function useRejectWorkItemReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => invoke('reject_work_item_review', { workItemId }),
    onSuccess: (_value, workItemId) => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_REVIEW_KEY, workItemId] });
    },
  });
}

export function useCloseWorkItemReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => invoke('close_work_item_review', { workItemId }),
    onSuccess: (_value, workItemId) => {
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_REVIEW_KEY, workItemId] });
    },
  });
}

export function useRepoBranch(repoPath: string | null | undefined) {
  return useQuery<RepoBranchInfo>({
    queryKey: ['repo_branch', repoPath],
    queryFn: () => invoke('get_repo_branch', { repoPath: repoPath! }),
    enabled: !!repoPath,
    retry: false,
    staleTime: 10_000,
  });
}

export function useRepoBranches(repoPath: string | null | undefined) {
  return useQuery<string[]>({
    queryKey: ['repo_branches', repoPath],
    queryFn: () => invoke('list_repo_branches', { repoPath: repoPath! }),
    enabled: !!repoPath,
    retry: false,
    staleTime: 15_000,
  });
}
