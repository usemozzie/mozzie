import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import type { TicketDependency } from '@mozzie/db';
import { TICKETS_KEY } from './useTickets';

const DEPS_KEY = 'ticket-dependencies';
const DEPENDENTS_KEY = 'ticket-dependents';

export function useTicketDependencies(ticketId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!ticketId) return;
    const unlisten = listen<{ ticketId: string }>('ticket:deps-changed', (event) => {
      if (event.payload.ticketId === ticketId) {
        queryClient.invalidateQueries({ queryKey: [DEPS_KEY, ticketId] });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [ticketId, queryClient]);

  return useQuery({
    queryKey: [DEPS_KEY, ticketId],
    queryFn: () => invoke<TicketDependency[]>('get_ticket_dependencies', { ticketId }),
    enabled: !!ticketId,
  });
}

export function useTicketDependents(ticketId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!ticketId) return;
    const unlisten = listen<{ ticketId: string }>('ticket:deps-changed', () => {
      queryClient.invalidateQueries({ queryKey: [DEPENDENTS_KEY, ticketId] });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [ticketId, queryClient]);

  return useQuery({
    queryKey: [DEPENDENTS_KEY, ticketId],
    queryFn: () => invoke<TicketDependency[]>('get_ticket_dependents', { ticketId }),
    enabled: !!ticketId,
  });
}

export function useHasUnmetDependencies(ticketId: string | null) {
  return useQuery({
    queryKey: ['unmet-deps', ticketId],
    queryFn: () => invoke<boolean>('has_unmet_dependencies', { ticketId }),
    enabled: !!ticketId,
  });
}

export function useAddDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { ticketId: string; dependsOnId: string }) =>
      invoke<void>('add_ticket_dependency', {
        ticketId: params.ticketId,
        dependsOnId: params.dependsOnId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [DEPS_KEY] });
      queryClient.invalidateQueries({ queryKey: [DEPENDENTS_KEY] });
      queryClient.invalidateQueries({ queryKey: ['unmet-deps'] });
    },
  });
}

export function useRemoveDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { ticketId: string; dependsOnId: string }) =>
      invoke<void>('remove_ticket_dependency', {
        ticketId: params.ticketId,
        dependsOnId: params.dependsOnId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [DEPS_KEY] });
      queryClient.invalidateQueries({ queryKey: [DEPENDENTS_KEY] });
      queryClient.invalidateQueries({ queryKey: ['unmet-deps'] });
      queryClient.invalidateQueries({ queryKey: [TICKETS_KEY] });
    },
  });
}
