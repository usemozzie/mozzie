import { useMutation, useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';

export interface WorktreeInfo {
  worktree_path: string;
  branch_name: string;
  source_branch: string;
}

export interface RepoBranchInfo {
  branch_name: string;
  detached: boolean;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export function useCreateWorktree() {
  return useMutation({
    mutationFn: ({
      ticketId,
      repoPath,
      sourceBranch,
      branchName,
    }: {
      ticketId: string;
      repoPath: string;
      sourceBranch?: string;
      branchName?: string;
    }) =>
      invoke<WorktreeInfo>('create_worktree', {
        ticketId,
        repoPath,
        sourceBranch: sourceBranch ?? null,
        branchName: branchName ?? null,
      }),
  });
}

// ─── Remove ───────────────────────────────────────────────────────────────────

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

// ─── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Fetches the diff between the ticket worktree's current contents and its base branch.
 */
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

// ─── Merge ────────────────────────────────────────────────────────────────────

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
