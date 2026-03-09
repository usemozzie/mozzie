import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { AgentConfig, Repo, WorkItem } from '@mozzie/db';

export type OrchestratorProvider = 'openai' | 'anthropic' | 'gemini';

export const ALL_PROVIDERS: OrchestratorProvider[] = ['openai', 'anthropic', 'gemini'];

export const PROVIDER_META: Record<OrchestratorProvider, { label: string; defaultModel: string; placeholder: string }> = {
  openai: { label: 'ChatGPT', defaultModel: 'gpt-5-nano', placeholder: 'sk-...' },
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

export interface OrchestratorWorkItemSpec {
  title: string;
  context: string;
  execution_context?: string | null;
  orchestrator_note?: string | null;
  repo_path?: string | null;
  branch_name?: string | null;
  assigned_agent?: string | null;
  depends_on_titles?: string[] | null;
  parent_title?: string | null;
  duplicate_of_work_item_id?: string | null;
  duplicate_policy?: string | null;
  intent_type?: string | null;
}

export interface OrchestratorAction {
  kind: 'summary' | 'create_work_items' | 'start_work_item' | 'run_all_ready' | 'delete_work_items' | 'close_work_items' | 'reopen_work_items' | 'explore_repo';
  work_item_id?: string | null;
  work_item_ids?: string[] | null;
  work_items?: OrchestratorWorkItemSpec[] | null;
  repo_path?: string | null;
  prompt?: string | null;
}

export interface OrchestratorPlan {
  assistant_message: string;
  actions: OrchestratorAction[];
  done?: boolean;
}

const STORAGE_KEY = 'mozzie.orchestratorConfig';
const STORE_EVENT = 'mozzie:orchestrator-config-changed';

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
  window.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: store }));
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

export function useOrchestratorKeyStore() {
  const [store, setStore] = useState<OrchestratorKeyStore>(() => getKeyStore());

  useEffect(() => {
    function syncFromStorage() {
      setStore(getKeyStore());
    }

    function syncFromEvent(event: Event) {
      const customEvent = event as CustomEvent<OrchestratorKeyStore>;
      if (customEvent.detail) {
        setStore(customEvent.detail);
        return;
      }
      syncFromStorage();
    }

    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(STORE_EVENT, syncFromEvent as EventListener);

    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(STORE_EVENT, syncFromEvent as EventListener);
    };
  }, []);

  return store;
}

export function usePlanOrchestratorActions() {
  return useMutation({
    mutationFn: ({
      config,
      message,
      workItems,
      history,
      repos,
      agents,
      recentRepos,
      workspaceId,
    }: {
      config: OrchestratorConfig;
      message: string;
      workItems: WorkItem[];
      history: Array<{ role: 'user' | 'orchestrator'; text: string; metadata?: string | null }>;
      repos: Repo[];
      agents: AgentConfig[];
      recentRepos: string[];
      workspaceId: string;
    }) =>
      invoke<OrchestratorPlan>('plan_orchestrator_actions', {
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        message,
        workspaceId,
        workItemsJson: JSON.stringify(
          workItems.map((workItem) => ({
            id: workItem.id,
            title: workItem.title,
            status: workItem.status,
            context: workItem.context,
            execution_context: workItem.execution_context,
            orchestrator_note: workItem.orchestrator_note,
            repo_path: workItem.repo_path,
            assigned_agent: workItem.assigned_agent,
            worktree_path: workItem.worktree_path,
            branch_name: workItem.branch_name,
            duplicate_of_work_item_id: workItem.duplicate_of_work_item_id,
            duplicate_policy: workItem.duplicate_policy,
            intent_type: workItem.intent_type,
            updated_at: workItem.updated_at,
          }))
        ),
        historyJson: JSON.stringify(history),
        reposJson: JSON.stringify(
          repos.map((repo) => ({
            id: repo.id,
            name: repo.name,
            path: repo.path,
            default_branch: repo.default_branch,
            last_used_at: repo.last_used_at,
          }))
        ),
        agentsJson: JSON.stringify(
          agents.map((agent) => ({
            id: agent.id,
            display_name: agent.display_name,
            model: agent.model,
            enabled: agent.enabled,
            strengths: agent.strengths,
            weaknesses: agent.weaknesses,
            best_for: agent.best_for,
            reasoning_class: agent.reasoning_class,
            speed_class: agent.speed_class,
            edit_reliability: agent.edit_reliability,
          }))
        ),
        recentReposJson: JSON.stringify(recentRepos),
      }),
  });
}

function isProvider(value: unknown): value is OrchestratorProvider {
  return value === 'openai' || value === 'anthropic' || value === 'gemini';
}
