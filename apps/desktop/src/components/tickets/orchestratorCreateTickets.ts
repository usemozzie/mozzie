import { invoke } from '@tauri-apps/api/core';
import type { Repo, Ticket } from '@mozzie/db';
import type { OrchestratorTicketSpec } from '../../hooks/useOrchestrator';
import { getRepoDisplayName } from '../../lib/recentRepos';

export interface RepoChoice {
  path: string;
  label: string;
}

export interface PendingRepoSelection {
  specs: OrchestratorTicketSpec[];
  unresolvedTitles: string[];
  selections: Record<string, string>;
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
  specs: OrchestratorTicketSpec[],
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
  specs: OrchestratorTicketSpec[],
  repoChoices: RepoChoice[],
  selections: Record<string, string>,
): OrchestratorTicketSpec[] {
  const fallbackRepoPath = repoChoices.length === 1 ? repoChoices[0].path : undefined;

  return specs.slice(0, 8).map((spec) => ({
    ...spec,
    repo_path: spec.repo_path?.trim() || selections[spec.title] || fallbackRepoPath || undefined,
  }));
}

export function missingRepoTitles(specs: OrchestratorTicketSpec[]): string[] {
  return specs
    .filter((spec) => !spec.repo_path?.trim())
    .map((spec) => spec.title);
}

export async function executeCreateTickets({
  specs,
  createTicket,
  transitionTicket,
  isPro,
}: {
  specs: OrchestratorTicketSpec[];
  createTicket: (params: { title: string; context?: string; repo_path?: string; assigned_agent?: string }) => Promise<Ticket>;
  transitionTicket: (params: { id: string; toStatus: Ticket['status'] }) => Promise<Ticket>;
  isPro: boolean;
}) {
  const created: string[] = [];
  const titleToId = new Map<string, string>();

  for (const spec of specs.slice(0, 8)) {
    const ticket = await createTicket({
      title: spec.title,
      context: spec.context,
      repo_path: spec.repo_path ?? undefined,
      assigned_agent: spec.assigned_agent ?? 'claude-code',
    });

    titleToId.set(spec.title, ticket.id);

    if (spec.repo_path && spec.context?.trim()) {
      await transitionTicket({ id: ticket.id, toStatus: 'ready' });
    }

    created.push(spec.title);
  }

  if (isPro) {
    let depsCreated = 0;
    for (const spec of specs.slice(0, 8)) {
      const ticketId = titleToId.get(spec.title);
      if (!ticketId || !spec.depends_on_titles?.length) continue;

      for (const depTitle of spec.depends_on_titles) {
        const depId = titleToId.get(depTitle);
        if (depId) {
          try {
            await invoke('add_ticket_dependency', { ticketId, dependsOnId: depId });
            depsCreated++;
          } catch {
            // Skip cycles and duplicates.
          }
        }
      }
    }

    if (depsCreated > 0) {
      return `Created ${created.length} ticket${created.length === 1 ? '' : 's'} with ${depsCreated} dependency link${depsCreated === 1 ? '' : 's'}: ${created.join(', ')}.`;
    }
  }

  return `Created ${created.length} ticket${created.length === 1 ? '' : 's'}: ${created.join(', ')}.`;
}
