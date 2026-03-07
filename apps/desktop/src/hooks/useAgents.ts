import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AcpEventItem,
  AgentConfig,
  AgentLog,
  AgentPermissionPolicy,
  AgentSessionState,
} from '@mozzie/db';
import { useTerminalStore } from '../stores/terminalStore';
import type { AgentLogChangeEvent, AgentSessionStateEvent } from '../types/events';

const AGENT_CONFIGS_KEY = 'agent_configs';
const AGENT_LOGS_KEY = 'agent_logs';
const AGENT_SESSION_KEY = 'agent_session';

export function useAgentConfigs() {
  return useQuery<AgentConfig[]>({
    queryKey: [AGENT_CONFIGS_KEY],
    queryFn: () => invoke('list_agent_configs'),
  });
}

export function useSaveAgentConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: Partial<AgentConfig> & { id: string }) =>
      invoke<AgentConfig>('save_agent_config', {
        id: config.id,
        displayName: config.display_name ?? '',
        acpUrl: config.acp_url ?? `builtin:${config.id}`,
        apiKeyRef: config.api_key_ref ?? null,
        model: config.model ?? null,
        maxConcurrent: config.max_concurrent ?? 1,
        enabled: config.enabled ?? 1,
        strengths: config.strengths ?? null,
        weaknesses: config.weaknesses ?? null,
        bestFor: config.best_for ?? null,
        reasoningClass: config.reasoning_class ?? null,
        speedClass: config.speed_class ?? null,
        editReliability: config.edit_reliability ?? null,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [AGENT_CONFIGS_KEY] }),
  });
}

export function useDeleteAgentConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke('delete_agent_config', { id }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [AGENT_CONFIGS_KEY] }),
  });
}

export function useLaunchAgent() {
  const queryClient = useQueryClient();
  const assignSlot = useTerminalStore((s) => s.assignSlot);
  return useMutation({
    mutationFn: ({
      ticketId,
      slot,
      permissionPolicy,
    }: {
      ticketId: string;
      slot: number;
      permissionPolicy?: AgentPermissionPolicy;
    }) =>
      invoke<string>('launch_agent', {
        ticketId,
        slot,
        permissionPolicy: permissionPolicy ?? null,
      }),
    onSuccess: (_logId, { ticketId, slot }) => {
      assignSlot(slot, ticketId);
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
      queryClient.invalidateQueries({ queryKey: [AGENT_LOGS_KEY, ticketId] });
    },
  });
}

export function useContinueAgent() {
  const queryClient = useQueryClient();
  const assignSlot = useTerminalStore((s) => s.assignSlot);
  return useMutation({
    mutationFn: ({
      ticketId,
      slot,
      message,
      permissionPolicy,
    }: {
      ticketId: string;
      slot: number;
      message: string;
      permissionPolicy?: AgentPermissionPolicy;
    }) =>
      invoke<string>('continue_agent', {
        ticketId,
        slot,
        message,
        permissionPolicy: permissionPolicy ?? null,
      }),
    onSuccess: (_logId, { ticketId, slot }) => {
      assignSlot(slot, ticketId);
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
      queryClient.invalidateQueries({ queryKey: [AGENT_LOGS_KEY, ticketId] });
    },
  });
}

export function useInterruptAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => invoke<void>('interrupt_agent', { ticketId }),
    onSuccess: (_value, ticketId) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
    },
  });
}

export function useCancelAgentTurn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => invoke<void>('cancel_agent_turn', { ticketId }),
    onSuccess: (_value, ticketId) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
    },
  });
}

export function useStopAgentSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => invoke<void>('stop_agent_session', { ticketId }),
    onSuccess: (_value, ticketId) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
    },
  });
}

export function useShutdownAllAgentSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => invoke<void>('shutdown_all_agent_sessions'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY] });
    },
  });
}

export function useAgentLogs(ticketId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!ticketId) return;
    const unlisten = listen<AgentLogChangeEvent>('agent:log-change', (event) => {
      if (event.payload.ticketId === ticketId) {
        queryClient.invalidateQueries({ queryKey: [AGENT_LOGS_KEY, ticketId] });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [ticketId, queryClient]);

  return useQuery<AgentLog[]>({
    queryKey: [AGENT_LOGS_KEY, ticketId],
    queryFn: () => invoke('get_agent_logs', { ticketId }),
    enabled: !!ticketId,
  });
}

export function useGetAcpMessages(logId: string | null) {
  return useQuery<AcpEventItem[]>({
    queryKey: ['acp_messages', logId],
    queryFn: () => invoke('get_acp_messages', { logId }),
    enabled: !!logId,
  });
}

export function useAgentSession(ticketId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!ticketId) return;
    const unlisten = listen<AgentSessionStateEvent>('agent:session-state', (event) => {
      if (event.payload.ticketId === ticketId) {
        queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [ticketId, queryClient]);

  return useQuery<AgentSessionState | null>({
    queryKey: [AGENT_SESSION_KEY, ticketId],
    queryFn: () => invoke('get_agent_session', { ticketId }),
    enabled: !!ticketId,
    staleTime: 5_000,
  });
}

export function useSetAgentPermissionPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      policy,
    }: {
      ticketId: string;
      policy: AgentPermissionPolicy;
    }) => invoke<AgentSessionState>('set_agent_permission_policy', { ticketId, policy }),
    onSuccess: (_value, { ticketId }) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
    },
  });
}

export function useRespondToAgentPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      requestId,
      optionId,
    }: {
      ticketId: string;
      requestId: string;
      optionId: string | null;
    }) =>
      invoke<void>('respond_to_agent_permission', {
        ticketId,
        requestId,
        optionId,
      }),
    onSuccess: (_value, { ticketId }) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, ticketId] });
    },
  });
}
