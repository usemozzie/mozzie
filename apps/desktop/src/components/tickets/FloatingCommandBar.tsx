import { useState, useRef, useEffect } from 'react';
import { X, Command, Loader2 } from 'lucide-react';
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

interface ChatEntry {
  id: string;
  role: 'user' | 'orchestrator';
  text: string;
}

interface PendingDelete {
  ticketIds: string[];
  label: string;
}

interface FloatingCommandBarProps {
  onClose: () => void;
}

export function FloatingCommandBar({ onClose }: FloatingCommandBarProps) {
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />

      {/* Floating bar */}
      <div className="fixed z-50 bottom-6 left-1/2 -translate-x-1/2 w-[640px] max-w-[90vw] command-bar-enter">
        <div className="bg-surface border border-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Command className="w-3.5 h-3.5 text-accent" />
            <span className="text-[13px] font-semibold text-text flex-1">Orchestrator</span>
            <span className="text-[10px] text-text-dim">LLM-driven backlog control</span>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-all"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Chat history */}
          {history.length > 0 && (
            <div ref={scrollRef} className="max-h-60 overflow-y-auto px-4 py-3 space-y-2">
              {history.slice(-8).map((entry) => (
                <div key={entry.id}>
                  <div className="text-[10px] uppercase tracking-wide text-text-dim mb-0.5">
                    {entry.role === 'user' ? 'You' : 'Orchestrator'}
                  </div>
                  <div
                    className={`text-[12px] leading-relaxed rounded-lg px-3 py-2 ${
                      entry.role === 'user'
                        ? 'bg-white/[0.04] text-text'
                        : 'bg-accent/[0.06] text-text-muted border border-accent/10'
                    }`}
                  >
                    {entry.text}
                  </div>
                </div>
              ))}
            </div>
          )}

          {pendingDelete && (
            <div className="px-4 pb-2 text-[11px] text-state-waiting">
              Pending confirmation: delete {pendingDelete.label}. Reply `yes` to confirm or `cancel`.
            </div>
          )}

          {/* Input */}
          <div className="px-4 pb-4 pt-2">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                rows={2}
                placeholder="Create, run, summarize, or delete tickets..."
                disabled={isActing}
                className="flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text
                  placeholder:text-text-dim focus:outline-none focus:border-accent/50
                  disabled:opacity-60 transition-colors leading-relaxed"
              />
              <button
                onClick={() => void handleSend()}
                disabled={isActing || !message.trim()}
                className="shrink-0 h-9 px-4 rounded-lg bg-accent text-white text-[12px] font-medium
                  hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {isActing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---- Action execution (moved from OrchestratorPanel) ----

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
      return `Delete ${matches.length === 1 ? `"${matches[0].title}"` : `${matches.length} tickets`}? Reply \`yes\` to confirm or \`cancel\`.`;
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
