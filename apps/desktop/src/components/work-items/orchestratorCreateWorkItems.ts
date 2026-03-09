import { invoke } from '@tauri-apps/api/core';
import type { Repo, WorkItem } from '@mozzie/db';
import type { OrchestratorWorkItemSpec } from '../../hooks/useOrchestrator';
import { getRepoDisplayName } from '../../lib/recentRepos';

export interface RepoChoice {
  path: string;
  label: string;
}

export interface PendingRepoSelection {
  specs: OrchestratorWorkItemSpec[];
  unresolvedTitles: string[];
  selections: Record<string, string>;
}

export interface ExecuteCreateWorkItemsResult {
  message: string;
  createdTitles: string[];
  reopenedTitles: string[];
  reusedTitles: string[];
  handledWorkItems: Array<{
    id: string;
    title: string;
    repo_path?: string | null;
    mode: 'created' | 'reopened' | 'reused';
  }>;
}

export function buildRepoChoices(repos: Repo[], recentRepos: string[]): RepoChoice[] {
  const seen = new Set<string>();
  const choices: RepoChoice[] = [];

  for (const repo of repos) {
    const path = repo.path.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    choices.push({
      path,
      label: repo.name && repo.name !== getRepoDisplayName(path)
        ? `${repo.name} · ${path}`
        : path,
    });
  }

  for (const path of recentRepos) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    choices.push({
      path: trimmed,
      label: `${getRepoDisplayName(trimmed)} · ${trimmed}`,
    });
  }

  return choices;
}

export function preparePendingRepoSelection(
  specs: OrchestratorWorkItemSpec[],
  repoChoices: RepoChoice[],
): PendingRepoSelection | null {
  const limited = specs.slice(0, 8);
  const unresolved = limited.filter((spec) => !spec.repo_path?.trim());
  if (unresolved.length === 0 || repoChoices.length <= 1) {
    return null;
  }

  return {
    specs: limited,
    unresolvedTitles: unresolved.map((spec) => spec.title),
    selections: Object.fromEntries(unresolved.map((spec) => [spec.title, ''])),
  };
}

export function applyRepoSelections(
  specs: OrchestratorWorkItemSpec[],
  repoChoices: RepoChoice[],
  selections: Record<string, string>,
): OrchestratorWorkItemSpec[] {
  const fallbackRepoPath = repoChoices.length === 1 ? repoChoices[0].path : undefined;

  return specs.slice(0, 8).map((spec) => ({
    ...spec,
    repo_path: spec.repo_path?.trim() || selections[spec.title] || fallbackRepoPath || undefined,
  }));
}

export function missingRepoTitles(specs: OrchestratorWorkItemSpec[]): string[] {
  return specs
    .filter((spec) => !spec.repo_path?.trim())
    .map((spec) => spec.title);
}

export async function executeCreateWorkItems({
  specs,
  existingWorkItems,
  createWorkItem,
  reopenWorkItem,
  transitionWorkItem,
}: {
  specs: OrchestratorWorkItemSpec[];
  existingWorkItems: WorkItem[];
  createWorkItem: (params: {
    title: string;
    context?: string;
    execution_context?: string;
    orchestrator_note?: string;
    repo_path?: string;
    branch_name?: string;
    assigned_agent?: string;
    parent_id?: string;
    duplicate_of_work_item_id?: string;
    duplicate_policy?: string;
    intent_type?: string;
  }) => Promise<WorkItem>;
  reopenWorkItem: (id: string) => Promise<WorkItem>;
  transitionWorkItem: (params: { id: string; toStatus: WorkItem['status'] }) => Promise<WorkItem>;
}): Promise<ExecuteCreateWorkItemsResult> {
  const created: string[] = [];
  const reopened: string[] = [];
  const reused: string[] = [];
  const handledWorkItems: ExecuteCreateWorkItemsResult['handledWorkItems'] = [];
  const titleToId = new Map<string, string>();

  // Two-pass creation: first pass creates parents and standalone items,
  // second pass creates children (specs with parent_title).
  const limited = specs.slice(0, 8);
  const parentTitles = new Set(limited.map((s) => s.parent_title?.trim()).filter(Boolean) as string[]);
  const parents = limited.filter((s) => !s.parent_title?.trim());
  const children = limited.filter((s) => !!s.parent_title?.trim());
  // Sort parents so items referenced as parent_title come first
  parents.sort((a, b) => {
    const aIsParent = parentTitles.has(a.title) ? 0 : 1;
    const bIsParent = parentTitles.has(b.title) ? 0 : 1;
    return aIsParent - bIsParent;
  });
  const ordered = [...parents, ...children];

  for (const spec of ordered) {
    const normalizedTitle = spec.title.trim().toLowerCase();
    const exactMatch = existingWorkItems.find((wi) => wi.title.trim().toLowerCase() === normalizedTitle);

    if (exactMatch && spec.duplicate_policy !== 'intentional_new_work_item') {
      if (spec.intent_type === 'reopen_work_item' && (exactMatch.status === 'done' || exactMatch.status === 'archived')) {
        const reopenedWorkItem = await reopenWorkItem(exactMatch.id);
        titleToId.set(spec.title, reopenedWorkItem.id);
        reopened.push(spec.title);
        handledWorkItems.push({
          id: reopenedWorkItem.id,
          title: reopenedWorkItem.title,
          repo_path: reopenedWorkItem.repo_path,
          mode: 'reopened',
        });
        continue;
      }

      if (exactMatch.status !== 'done' && exactMatch.status !== 'archived') {
        titleToId.set(spec.title, exactMatch.id);
        reused.push(spec.title);
        handledWorkItems.push({
          id: exactMatch.id,
          title: exactMatch.title,
          repo_path: exactMatch.repo_path,
          mode: 'reused',
        });
        continue;
      }
    }

    const executionContext = sanitizeExecutionContext(spec.execution_context ?? spec.context);
    if (!executionContext) {
      continue;
    }

    // Resolve parent_id from parent_title
    const parentId = spec.parent_title?.trim()
      ? titleToId.get(spec.parent_title.trim()) ?? undefined
      : undefined;
    const isParentContainer = parentTitles.has(spec.title);

    const workItem = await createWorkItem({
      title: spec.title,
      context: spec.context,
      execution_context: executionContext,
      orchestrator_note: spec.orchestrator_note ?? undefined,
      repo_path: spec.repo_path ?? undefined,
      branch_name: spec.branch_name ?? undefined,
      assigned_agent: isParentContainer ? undefined : spec.assigned_agent ?? 'claude-code',
      parent_id: parentId,
      duplicate_of_work_item_id: spec.duplicate_of_work_item_id ?? exactMatch?.id ?? undefined,
      duplicate_policy: spec.duplicate_policy ?? undefined,
      intent_type: spec.intent_type ?? 'create_work_item',
    });

    titleToId.set(spec.title, workItem.id);

    // Don't auto-transition parent work items that have children to ready
    // (they are containers, not agent tasks)
    if (spec.repo_path && executionContext.trim() && !isParentContainer) {
      await transitionWorkItem({ id: workItem.id, toStatus: 'ready' });
    }

    created.push(spec.title);
    handledWorkItems.push({
      id: workItem.id,
      title: workItem.title,
      repo_path: workItem.repo_path,
      mode: 'created',
    });
  }

  let depsCreated = 0;
  for (const spec of specs.slice(0, 8)) {
    const workItemId = titleToId.get(spec.title);
    if (!workItemId || !spec.depends_on_titles?.length) continue;

    for (const depTitle of spec.depends_on_titles) {
      const depId = titleToId.get(depTitle);
      if (depId) {
        try {
          await invoke('add_work_item_dependency', { workItemId, dependsOnId: depId });
          depsCreated++;
        } catch {
          // Skip cycles and duplicates.
        }
      }
    }
  }

  if (depsCreated > 0) {
    return {
      message: `Created ${created.length} work item${created.length === 1 ? '' : 's'} with ${depsCreated} dependency link${depsCreated === 1 ? '' : 's'}: ${created.join(', ')}.`,
      createdTitles: created,
      reopenedTitles: reopened,
      reusedTitles: reused,
      handledWorkItems,
    };
  }

  const parts: string[] = [];
  if (created.length > 0) {
    parts.push(`Created ${created.length} work item${created.length === 1 ? '' : 's'}: ${created.join(', ')}.`);
  }
  if (reopened.length > 0) {
    parts.push(`Reopened ${reopened.length} work item${reopened.length === 1 ? '' : 's'}: ${reopened.join(', ')}.`);
  }
  if (reused.length > 0) {
    parts.push(`Reused ${reused.length} existing work item${reused.length === 1 ? '' : 's'}: ${reused.join(', ')}.`);
  }
  return {
    message: parts.join(' ') || 'No work item changes were needed.',
    createdTitles: created,
    reopenedTitles: reopened,
    reusedTitles: reused,
    handledWorkItems,
  };
}

function sanitizeExecutionContext(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';

  const forbiddenPhrases = [
    'create a work item',
    'open a work item',
    'make a task',
    'track this',
    'create this work item',
    'ask the orchestrator',
    'use the orchestrator',
  ];

  const lower = value.toLowerCase();
  const cleaned = forbiddenPhrases.reduce((current, phrase) => current.replaceAll(phrase, ''), lower);
  const normalized = cleaned.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return '';
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
