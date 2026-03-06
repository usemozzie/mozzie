import { useMutation } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { Ticket } from '@mozzie/db';

export type OrchestratorProvider = 'openai' | 'anthropic' | 'gemini';

export const ALL_PROVIDERS: OrchestratorProvider[] = ['openai', 'anthropic', 'gemini'];

export const PROVIDER_META: Record<OrchestratorProvider, { label: string; defaultModel: string; placeholder: string }> = {
  openai: { label: 'ChatGPT', defaultModel: 'gpt-4.1-mini', placeholder: 'sk-...' },
  anthropic: { label: 'Claude', defaultModel: 'claude-3-5-sonnet-latest', placeholder: 'sk-ant-...' },
  gemini: { label: 'Gemini', defaultModel: 'gemini-2.0-flash', placeholder: 'AI...' },
};

export interface OrchestratorConfig {
  provider: OrchestratorProvider;
  apiKey: string;
  model: string;
}

/** Per-provider API keys + models stored in localStorage */
export interface OrchestratorKeyStore {
  activeProvider: OrchestratorProvider;
  keys: Record<OrchestratorProvider, string>;
  models: Record<OrchestratorProvider, string>;
}

export interface OrchestratorTicketSpec {
  title: string;
  context: string;
  repo_path?: string | null;
  assigned_agent?: string | null;
  depends_on_titles?: string[] | null;
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

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function emptyKeys(): Record<OrchestratorProvider, string> {
  return { openai: '', anthropic: '', gemini: '' };
}

function defaultModels(): Record<OrchestratorProvider, string> {
  return {
    openai: PROVIDER_META.openai.defaultModel,
    anthropic: PROVIDER_META.anthropic.defaultModel,
    gemini: PROVIDER_META.gemini.defaultModel,
  };
}

export function getKeyStore(): OrchestratorKeyStore {
  if (!canUseStorage()) {
    return { activeProvider: 'openai', keys: emptyKeys(), models: defaultModels() };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { activeProvider: 'openai', keys: emptyKeys(), models: defaultModels() };

    const parsed = JSON.parse(raw);

    // Migrate old single-key format
    if ('apiKey' in parsed && !('keys' in parsed)) {
      const provider: OrchestratorProvider = isProvider(parsed.provider) ? parsed.provider : 'openai';
      const keys = emptyKeys();
      if (typeof parsed.apiKey === 'string') keys[provider] = parsed.apiKey;
      const models = defaultModels();
      if (typeof parsed.model === 'string' && parsed.model.trim()) models[provider] = parsed.model;
      const store: OrchestratorKeyStore = { activeProvider: provider, keys, models };
      saveKeyStore(store);
      return store;
    }

    return {
      activeProvider: isProvider(parsed.activeProvider) ? parsed.activeProvider : 'openai',
      keys: {
        openai: typeof parsed.keys?.openai === 'string' ? parsed.keys.openai : '',
        anthropic: typeof parsed.keys?.anthropic === 'string' ? parsed.keys.anthropic : '',
        gemini: typeof parsed.keys?.gemini === 'string' ? parsed.keys.gemini : '',
      },
      models: {
        openai: typeof parsed.models?.openai === 'string' && parsed.models.openai.trim() ? parsed.models.openai : PROVIDER_META.openai.defaultModel,
        anthropic: typeof parsed.models?.anthropic === 'string' && parsed.models.anthropic.trim() ? parsed.models.anthropic : PROVIDER_META.anthropic.defaultModel,
        gemini: typeof parsed.models?.gemini === 'string' && parsed.models.gemini.trim() ? parsed.models.gemini : PROVIDER_META.gemini.defaultModel,
      },
    };
  } catch {
    return { activeProvider: 'openai', keys: emptyKeys(), models: defaultModels() };
  }
}

export function saveKeyStore(store: OrchestratorKeyStore) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/** Returns true if the given provider has an API key configured */
export function hasApiKey(provider: OrchestratorProvider): boolean {
  return getKeyStore().keys[provider].trim().length > 0;
}

/** Get the resolved config for the currently active provider */
export function getOrchestratorConfig(): OrchestratorConfig {
  const store = getKeyStore();
  return {
    provider: store.activeProvider,
    apiKey: store.keys[store.activeProvider],
    model: store.models[store.activeProvider] || PROVIDER_META[store.activeProvider].defaultModel,
  };
}

/** Save a resolved config (updates the key store) */
export function saveOrchestratorConfig(config: OrchestratorConfig) {
  const store = getKeyStore();
  store.activeProvider = config.provider;
  store.keys[config.provider] = config.apiKey;
  store.models[config.provider] = config.model;
  saveKeyStore(store);
}

export function getDefaultModel(provider: OrchestratorProvider) {
  return PROVIDER_META[provider].defaultModel;
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
