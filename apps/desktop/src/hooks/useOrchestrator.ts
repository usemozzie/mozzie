import { useMutation } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { Ticket } from '@mozzie/db';

export type OrchestratorProvider = 'openai' | 'anthropic' | 'gemini';

export interface OrchestratorConfig {
  provider: OrchestratorProvider;
  apiKey: string;
  model: string;
}

export interface OrchestratorTicketSpec {
  title: string;
  context: string;
  repo_path?: string | null;
  assigned_agent?: string | null;
}

export interface OrchestratorAction {
  kind: 'summary' | 'create_tickets' | 'start_ticket' | 'run_all_ready' | 'delete_tickets';
  ticket_id?: string | null;
  ticket_ids?: string[] | null;
  tickets?: OrchestratorTicketSpec[] | null;
}

export interface OrchestratorPlan {
  assistant_message: string;
  actions: OrchestratorAction[];
}

const STORAGE_KEY = 'mozzie.orchestratorConfig';

const DEFAULT_CONFIGS: Record<OrchestratorProvider, OrchestratorConfig> = {
  openai: {
    provider: 'openai',
    apiKey: '',
    model: 'gpt-4.1-mini',
  },
  anthropic: {
    provider: 'anthropic',
    apiKey: '',
    model: 'claude-3-5-sonnet-latest',
  },
  gemini: {
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-2.0-flash',
  },
};

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getOrchestratorConfig(): OrchestratorConfig {
  if (!canUseStorage()) {
    return DEFAULT_CONFIGS.openai;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_CONFIGS.openai;
    }

    const parsed = JSON.parse(raw) as Partial<OrchestratorConfig>;
    const provider = isProvider(parsed.provider) ? parsed.provider : 'openai';
    const defaults = DEFAULT_CONFIGS[provider];

    return {
      provider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : defaults.apiKey,
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : defaults.model,
    };
  } catch {
    return DEFAULT_CONFIGS.openai;
  }
}

export function saveOrchestratorConfig(config: OrchestratorConfig) {
  if (!canUseStorage()) return;

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function getDefaultModel(provider: OrchestratorProvider) {
  return DEFAULT_CONFIGS[provider].model;
}

export function usePlanOrchestratorActions() {
  return useMutation({
    mutationFn: ({
      config,
      message,
      tickets,
      history,
    }: {
      config: OrchestratorConfig;
      message: string;
      tickets: Ticket[];
      history: Array<{ role: 'user' | 'orchestrator'; text: string }>;
    }) =>
      invoke<OrchestratorPlan>('plan_orchestrator_actions', {
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        message,
        ticketsJson: JSON.stringify(
          tickets.map((ticket) => ({
            id: ticket.id,
            title: ticket.title,
            status: ticket.status,
            repo_path: ticket.repo_path,
            assigned_agent: ticket.assigned_agent,
            worktree_path: ticket.worktree_path,
            branch_name: ticket.branch_name,
            updated_at: ticket.updated_at,
          }))
        ),
        historyJson: JSON.stringify(history),
      }),
  });
}

function isProvider(value: unknown): value is OrchestratorProvider {
  return value === 'openai' || value === 'anthropic' || value === 'gemini';
}
