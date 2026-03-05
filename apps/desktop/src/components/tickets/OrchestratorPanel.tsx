import { useState } from 'react';
import type { Ticket } from '@mozzie/db';
import { useTickets } from '../../hooks/useTickets';
import {
  useCreateTicket,
  useDeleteTicket,
  useTransitionTicket,
  useUpdateTicket,
} from '../../hooks/useTicketMutation';
import { useStartAgent } from '../../hooks/useStartAgent';
import {
  getOrchestratorConfig,
  usePlanOrchestratorActions,
  type OrchestratorAction,
} from '../../hooks/useOrchestrator';
import { getRecentRepos } from '../../lib/recentRepos';
import { Button } from '../ui/button';

interface ChatEntry {
  id: string;
  role: 'user' | 'orchestrator';
  text: string;
}

interface PendingDelete {
  ticketIds: string[];
  label: string;
}

export function OrchestratorPanel() {
  const { data: tickets = [] } = useTickets();
  const createTicket = useCreateTicket();
  const updateTicket = useUpdateTicket();
  const transitionTicket = useTransitionTicket();
  const deleteTicket = useDeleteTicket();
  const { startAgent } = useStartAgent();
  const planActions = usePlanOrchestratorActions();

  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [isActing, setIsActing] = useState(false);

  function appendEntry(role: ChatEntry['role'], text: string) {
    setHistory((prev) => [...prev, { id: crypto.randomUUID(), role, text }]);
  }

  async function handleSend() {
    const raw = message.trim();
    if (!raw || isActing) return;

    appendEntry('user', raw);
    setMessage('');

    if (pendingDelete && isConfirmation(raw)) {
      setIsActing(true);
      try {
        await executeDelete(pendingDelete.ticketIds, deleteTicket.mutateAsync);
        appendEntry('orchestrator', `Deleted ${pendingDelete.label}.`);
      } catch (error) {
        appendEntry('orchestrator', `Delete failed: ${String(error)}`);
      } finally {
        setPendingDelete(null);
        setIsActing(false);
      }
      return;
    }

    if (pendingDelete && isCancel(raw)) {
      setPendingDelete(null);
      appendEntry('orchestrator', 'Delete cancelled.');
      return;
    }

    const config = getOrchestratorConfig();
    if (!config.apiKey.trim()) {
      appendEntry('orchestrator', 'Set the orchestrator API key in Settings before using chat orchestration.');
      return;
    }

    setIsActing(true);
    try {
      const plan = await planActions.mutateAsync({
        config,
        message: raw,
        tickets,
        history: history.slice(-8).map((entry) => ({
          role: entry.role,
          text: entry.text,
        })),
      });

      if (plan.assistant_message?.trim()) {
        appendEntry('orchestrator', plan.assistant_message.trim());
      }

      for (const action of plan.actions ?? []) {
        const result = await executeAction({
          action,
          tickets,
          createTicket: createTicket.mutateAsync,
          updateTicket: updateTicket.mutateAsync,
          transitionTicket: transitionTicket.mutateAsync,
          deleteTicket: deleteTicket.mutateAsync,
          startAgent,
          setPendingDelete,
        });

        if (result) {
          appendEntry('orchestrator', result);
        }
      }

      if ((!plan.actions || plan.actions.length === 0) && !plan.assistant_message?.trim()) {
        appendEntry('orchestrator', 'No action taken.');
      }
    } catch (error) {
      appendEntry('orchestrator', `Orchestrator error: ${String(error)}`);
    } finally {
      setIsActing(false);
    }
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-surface">
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="text-xs font-semibold text-zinc-300">Orchestrator</div>
        <div className="text-[10px] text-zinc-500">
          LLM-driven backlog control plane
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {history.slice(-8).map((entry) => (
          <div key={entry.id} className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              {entry.role === 'user' ? 'You' : 'Orchestrator'}
            </div>
            <div
              className={`text-xs leading-relaxed rounded px-2 py-1.5 ${
                entry.role === 'user'
                  ? 'bg-zinc-900 text-zinc-200'
                  : 'bg-zinc-950 text-zinc-300 border border-zinc-800'
              }`}
            >
              {entry.text}
            </div>
          </div>
        ))}
      </div>

      {pendingDelete && (
        <div className="px-3 pb-2 text-[11px] text-amber-300 shrink-0">
          Pending confirmation: delete {pendingDelete.label}. Reply `yes` to confirm or `cancel`.
        </div>
      )}

      <div className="px-3 pb-3 pt-1 border-t border-border shrink-0">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          rows={3}
          placeholder="Ask the orchestrator to create, run, summarize, or delete tickets..."
          disabled={isActing}
          className="w-full resize-none rounded border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600 disabled:opacity-60"
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => void handleSend()} disabled={isActing || !message.trim()}>
            {isActing ? 'Working…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}

async function executeAction({
  action,
  tickets,
  createTicket,
  updateTicket,
  transitionTicket,
  deleteTicket,
  startAgent,
  setPendingDelete,
}: {
  action: OrchestratorAction;
  tickets: Ticket[];
  createTicket: (params: { title: string; context?: string; repo_path?: string; assigned_agent?: string }) => Promise<Ticket>;
  updateTicket: (params: { id: string; fields: Record<string, unknown> }) => Promise<Ticket>;
  transitionTicket: (params: { id: string; toStatus: Ticket['status'] }) => Promise<Ticket>;
  deleteTicket: (id: string) => Promise<void>;
  startAgent: (ticket: Ticket) => Promise<{ ok: boolean; error?: string }>;
  setPendingDelete: (value: PendingDelete | null) => void;
}) {
  switch (action.kind) {
    case 'summary':
      return summarizeTickets(tickets);

    case 'run_all_ready':
      return handleRunAllReady(tickets, startAgent);

    case 'start_ticket':
      if (!action.ticket_id) {
        return 'The LLM did not specify a ticket ID to start.';
      }
      return handleStartOne(action.ticket_id, tickets, startAgent);

    case 'delete_tickets': {
      const ids = (action.ticket_ids ?? []).filter(Boolean);
      if (ids.length === 0) {
        return 'The LLM requested delete, but no ticket IDs were provided.';
      }
      const matches = tickets.filter((ticket) => ids.includes(ticket.id));
      if (matches.length === 0) {
        return 'No matching tickets were found to delete.';
      }
      const blocked = matches.filter((ticket) => ticket.status === 'running' || ticket.worktree_path || ticket.branch_name);
      if (blocked.length > 0) {
        return `Cannot delete yet: ${blocked.map((ticket) => ticket.title).join(', ')}. Clean up running/worktree tickets first.`;
      }
      setPendingDelete({
        ticketIds: matches.map((ticket) => ticket.id),
        label: matches.length === 1 ? `"${matches[0].title}"` : `${matches.length} tickets`,
      });
      return `Delete ${matches.length === 1 ? `"${matches[0].title}"` : `${matches.length} tickets`} ? Reply \`yes\` to confirm or \`cancel\`.`;
    }

    case 'create_tickets': {
      const specs = action.tickets ?? [];
      if (specs.length === 0) {
        return 'The LLM requested ticket creation, but provided no ticket specs.';
      }
      const fallbackRepoPath = getRecentRepos()[0];
      const created: string[] = [];

      for (const spec of specs.slice(0, 8)) {
        const ticket = await createTicket({
          title: spec.title,
          context: spec.context,
          repo_path: spec.repo_path ?? fallbackRepoPath,
          assigned_agent: spec.assigned_agent ?? 'claude-code',
        });

        if ((spec.repo_path ?? fallbackRepoPath) && spec.context?.trim()) {
          await transitionTicket({ id: ticket.id, toStatus: 'ready' });
        }

        created.push(spec.title);
      }

      return `Created ${created.length} ticket${created.length === 1 ? '' : 's'}: ${created.join(', ')}.`;
    }
  }
}

async function executeDelete(
  ticketIds: string[],
  deleteTicket: (id: string) => Promise<void>
) {
  for (const ticketId of ticketIds) {
    await deleteTicket(ticketId);
  }
}

async function handleRunAllReady(
  tickets: Ticket[],
  startAgent: (ticket: Ticket) => Promise<{ ok: boolean; error?: string }>
) {
  const readyTickets = tickets.filter((ticket) => ticket.status === 'ready');

  if (readyTickets.length === 0) {
    return 'No tickets are in `ready` state.';
  }

  const started: string[] = [];
  const skipped: string[] = [];

  for (const ticket of readyTickets) {
    const result = await startAgent(ticket);
    if (result.ok) {
      started.push(ticket.title);
    } else {
      skipped.push(`${ticket.title}: ${result.error ?? 'failed'}`);
      if ((result.error ?? '').includes('All 8 terminal slots')) {
        break;
      }
    }
  }

  const parts: string[] = [];
  if (started.length > 0) {
    parts.push(`Started ${started.length} ticket${started.length === 1 ? '' : 's'}: ${started.join(', ')}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Skipped ${skipped.length}: ${skipped.join(' | ')}.`);
  }

  return parts.join(' ');
}

async function handleStartOne(
  ticketId: string,
  tickets: Ticket[],
  startAgent: (ticket: Ticket) => Promise<{ ok: boolean; error?: string }>
) {
  const ticket = tickets.find((entry) => entry.id === ticketId);

  if (!ticket) {
    return `I could not find ticket ${ticketId}.`;
  }

  const result = await startAgent(ticket);
  return result.ok
    ? `Started "${ticket.title}".`
    : `Could not start "${ticket.title}": ${result.error ?? 'failed'}.`;
}

function summarizeTickets(tickets: Ticket[]) {
  if (tickets.length === 0) {
    return 'There are no tickets yet.';
  }

  const counts = tickets.reduce<Record<string, number>>((acc, ticket) => {
    acc[ticket.status] = (acc[ticket.status] ?? 0) + 1;
    return acc;
  }, {});

  const statusSummary = Object.entries(counts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');

  return `Backlog summary: ${tickets.length} total tickets. ${statusSummary}.`;
}

function isConfirmation(value: string) {
  return ['yes', 'confirm', 'y'].includes(value.trim().toLowerCase());
}

function isCancel(value: string) {
  return ['cancel', 'no', 'n'].includes(value.trim().toLowerCase());
}
