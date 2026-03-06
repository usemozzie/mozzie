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
      execution_context?: string;
      orchestrator_note?: string;
      repo_path?: string;
      assigned_agent?: string;
      branch_name?: string;
      source_branch?: string;
      duplicate_of_ticket_id?: string;
      duplicate_policy?: string;
      intent_type?: string;
    }) =>
      invoke<Ticket>('create_ticket', {
        title: params.title,
        context: params.context ?? null,
        executionContext: params.execution_context ?? null,
        orchestratorNote: params.orchestrator_note ?? null,
        repoPath: params.repo_path ?? null,
        assignedAgent: params.assigned_agent ?? null,
        branchName: params.branch_name ?? null,
        sourceBranch: params.source_branch ?? null,
        duplicateOfTicketId: params.duplicate_of_ticket_id ?? null,
        duplicatePolicy: params.duplicate_policy ?? null,
        intentType: params.intent_type ?? null,
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

export function useCloseTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<Ticket>('close_ticket', { id }),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
      queryClient.invalidateQueries({ queryKey: [TICKET_KEY, ticket.id] });
    },
  });
}

export function useReopenTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<Ticket>('reopen_ticket', { id }),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
      queryClient.invalidateQueries({ queryKey: [TICKET_KEY, ticket.id] });
    },
  });
}
