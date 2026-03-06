import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TicketReviewState } from '@mozzie/db';
import type { TicketStateChangeEvent } from '../types/events';
import { TICKET_KEY, TICKETS_KEY } from './useTickets';

export interface WorktreeInfo {
  worktree_path: string;
  branch_name: string;
  source_branch: string;
}

export interface RepoBranchInfo {
  branch_name: string;
  detached: boolean;
}

const TICKET_REVIEW_KEY = 'ticket_review';

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

export function useTicketReviewState(ticketId: string | null | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!ticketId) return;
    const unlisten = listen<TicketStateChangeEvent>('ticket:state-change', (event) => {
      if (event.payload.ticketId === ticketId) {
        queryClient.invalidateQueries({ queryKey: [TICKET_REVIEW_KEY, ticketId] });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [ticketId, queryClient]);

  return useQuery<TicketReviewState>({
    queryKey: [TICKET_REVIEW_KEY, ticketId],
    queryFn: () => invoke('get_ticket_review_state', { ticketId }),
    enabled: !!ticketId,
    staleTime: 5_000,
  });
}

export function useApproveTicketReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => invoke('approve_ticket_review', { ticketId }),
    onSuccess: (_value, ticketId) => {
      queryClient.invalidateQueries({ queryKey: [TICKET_REVIEW_KEY, ticketId] });
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
      queryClient.invalidateQueries({ queryKey: [TICKET_KEY, ticketId] });
      queryClient.invalidateQueries({ queryKey: ['repo_branch'] });
      queryClient.invalidateQueries({ queryKey: ['repo_branches'] });
    },
  });
}

export function useRejectTicketReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => invoke('reject_ticket_review', { ticketId }),
    onSuccess: (_value, ticketId) => {
      queryClient.invalidateQueries({ queryKey: [TICKET_REVIEW_KEY, ticketId] });
    },
  });
}

export function useCloseTicketReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => invoke('close_ticket_review', { ticketId }),
    onSuccess: (_value, ticketId) => {
      queryClient.invalidateQueries({ queryKey: [TICKET_REVIEW_KEY, ticketId] });
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
