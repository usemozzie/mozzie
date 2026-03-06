import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { AgentConfig, AgentLog, AcpEventItem } from '@mozzie/db';
import { useTerminalStore } from '../stores/terminalStore';

const AGENT_CONFIGS_KEY = 'agent_configs';
const AGENT_LOGS_KEY = 'agent_logs';

// ─── Agent config queries ─────────────────────────────────────────────────────

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

// ─── Launch ───────────────────────────────────────────────────────────────────

/**
 * Calls `launch_agent` which opens an ACP stdio session in a Rust background
 * task. Returns the log_id immediately.
 */
export function useLaunchAgent() {
  const assignSlot = useTerminalStore((s) => s.assignSlot);
  return useMutation({
    mutationFn: ({ ticketId, slot }: { ticketId: string; slot: number }) =>
      invoke<string>('launch_agent', { ticketId, slot }),
    onSuccess: (_logId, { ticketId, slot }) => {
      assignSlot(slot, ticketId);
    },
  });
}

export function useContinueAgent() {
  const assignSlot = useTerminalStore((s) => s.assignSlot);
  return useMutation({
    mutationFn: ({
      ticketId,
      slot,
      message,
    }: {
      ticketId: string;
      slot: number;
      message: string;
    }) => invoke<string>('continue_agent', { ticketId, slot, message }),
    onSuccess: (_logId, { ticketId, slot }) => {
      assignSlot(slot, ticketId);
    },
  });
}

export function useInterruptAgent() {
  return useMutation({
    mutationFn: (ticketId: string) => invoke<void>('interrupt_agent', { ticketId }),
  });
}

// ─── Agent logs ───────────────────────────────────────────────────────────────

export function useAgentLogs(ticketId: string | null) {
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
