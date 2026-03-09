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
      workItemId,
      slot,
      permissionPolicy,
    }: {
      workItemId: string;
      slot: number;
      permissionPolicy?: AgentPermissionPolicy;
    }) =>
      invoke<string>('launch_agent', {
        workItemId,
        slot,
        permissionPolicy: permissionPolicy ?? null,
      }),
    onSuccess: (_logId, { workItemId, slot }) => {
      assignSlot(slot, workItemId);
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
      queryClient.invalidateQueries({ queryKey: [AGENT_LOGS_KEY, workItemId] });
    },
  });
}

export function useContinueAgent() {
  const queryClient = useQueryClient();
  const assignSlot = useTerminalStore((s) => s.assignSlot);
  return useMutation({
    mutationFn: ({
      workItemId,
      slot,
      message,
      permissionPolicy,
    }: {
      workItemId: string;
      slot: number;
      message: string;
      permissionPolicy?: AgentPermissionPolicy;
    }) =>
      invoke<string>('continue_agent', {
        workItemId,
        slot,
        message,
        permissionPolicy: permissionPolicy ?? null,
      }),
    onSuccess: (_logId, { workItemId, slot }) => {
      assignSlot(slot, workItemId);
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
      queryClient.invalidateQueries({ queryKey: [AGENT_LOGS_KEY, workItemId] });
    },
  });
}

export function useInterruptAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => invoke<void>('interrupt_agent', { workItemId }),
    onSuccess: (_value, workItemId) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
    },
  });
}

export function useCancelAgentTurn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => invoke<void>('cancel_agent_turn', { workItemId }),
    onSuccess: (_value, workItemId) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
    },
  });
}

export function useStopAgentSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => invoke<void>('stop_agent_session', { workItemId }),
    onSuccess: (_value, workItemId) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
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

export function useAgentLogs(workItemId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workItemId) return;
    const unlisten = listen<AgentLogChangeEvent>('agent:log-change', (event) => {
      if (event.payload.workItemId === workItemId) {
        queryClient.invalidateQueries({ queryKey: [AGENT_LOGS_KEY, workItemId] });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [workItemId, queryClient]);

  return useQuery<AgentLog[]>({
    queryKey: [AGENT_LOGS_KEY, workItemId],
    queryFn: () => invoke('get_agent_logs', { workItemId }),
    enabled: !!workItemId,
  });
}

export function useGetAcpMessages(logId: string | null) {
  return useQuery<AcpEventItem[]>({
    queryKey: ['acp_messages', logId],
    queryFn: () => invoke('get_acp_messages', { logId }),
    enabled: !!logId,
  });
}

export function useAgentSession(workItemId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workItemId) return;
    const unlisten = listen<AgentSessionStateEvent>('agent:session-state', (event) => {
      if (event.payload.workItemId === workItemId) {
        queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [workItemId, queryClient]);

  return useQuery<AgentSessionState | null>({
    queryKey: [AGENT_SESSION_KEY, workItemId],
    queryFn: () => invoke('get_agent_session', { workItemId }),
    enabled: !!workItemId,
    staleTime: 5_000,
  });
}

export function useSetAgentPermissionPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workItemId,
      policy,
    }: {
      workItemId: string;
      policy: AgentPermissionPolicy;
    }) => invoke<AgentSessionState>('set_agent_permission_policy', { workItemId, policy }),
    onSuccess: (_value, { workItemId }) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
    },
  });
}

export function useRespondToAgentPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workItemId,
      requestId,
      optionId,
    }: {
      workItemId: string;
      requestId: string;
      optionId: string | null;
    }) =>
      invoke<void>('respond_to_agent_permission', {
        workItemId,
        requestId,
        optionId,
      }),
    onSuccess: (_value, { workItemId }) => {
      queryClient.invalidateQueries({ queryKey: [AGENT_SESSION_KEY, workItemId] });
    },
  });
}
