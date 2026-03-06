import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { Ticket, TicketStatus } from '@mozzie/db';
import { TICKET_KEY, TICKETS_KEY } from './useTickets';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function useCreateTicket() {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return useMutation({
    mutationFn: (params: {
      title: string;
      context?: string;
      repo_path?: string;
      assigned_agent?: string;
      branch_name?: string;
      source_branch?: string;
    }) =>
      invoke<Ticket>('create_ticket', {
        title: params.title,
        context: params.context ?? null,
        repoPath: params.repo_path ?? null,
        assignedAgent: params.assigned_agent ?? null,
        branchName: params.branch_name ?? null,
        sourceBranch: params.source_branch ?? null,
        workspaceId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
    },
  });
}

export function useUpdateTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; fields: Record<string, unknown> }) =>
      invoke<Ticket>('update_ticket', {
        id: params.id,
        fields: params.fields,
      }),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
      queryClient.invalidateQueries({ queryKey: [TICKET_KEY, ticket.id] });
    },
  });
}

export function useTransitionTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; toStatus: TicketStatus }) =>
      invoke<Ticket>('transition_ticket', {
        id: params.id,
        toStatus: params.toStatus,
      }),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
      queryClient.invalidateQueries({ queryKey: [TICKET_KEY, ticket.id] });
    },
  });
}

export function useDeleteTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>('delete_ticket', { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
    },
  });
}
