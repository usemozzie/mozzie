import { useState, useRef, useEffect } from 'react';
import { Plus, ArrowUp, Loader2, ChevronDown } from 'lucide-react';
import type { Repo, Ticket } from '@mozzie/db';
import { useTickets } from '../../hooks/useTickets';
import { useRepos } from '../../hooks/useRepos';
import {
  useCreateTicket,
  useDeleteTicket,
  useTransitionTicket,
  useUpdateTicket,
} from '../../hooks/useTicketMutation';
import { useStartAgent } from '../../hooks/useStartAgent';
import { useLicense } from '../../hooks/useLicense';
import {
  getOrchestratorConfig,
  saveOrchestratorConfig,
  getKeyStore,
  saveKeyStore,
  hasApiKey,
  PROVIDER_META,
  usePlanOrchestratorActions,
  type OrchestratorAction,
  type OrchestratorProvider,
  type OrchestratorTicketSpec,
} from '../../hooks/useOrchestrator';
import { getRecentRepos } from '../../lib/recentRepos';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import {
  applyRepoSelections,
  buildRepoChoices,
  executeCreateTickets,
  missingRepoTitles,
  preparePendingRepoSelection,
  type PendingRepoSelection,
} from './orchestratorCreateTickets';

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
  const { data: repos = [] } = useRepos();
  const { data: license } = useLicense();
  const isPro = license?.is_pro ?? false;
  const createTicket = useCreateTicket();
  const updateTicket = useUpdateTicket();
  const transitionTicket = useTransitionTicket();
  const deleteTicket = useDeleteTicket();
  const { startAgent } = useStartAgent();
  const planActions = usePlanOrchestratorActions();

  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingRepoSelection, setPendingRepoSelection] = useState<PendingRepoSelection | null>(null);
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

    if (pendingRepoSelection) {
      appendEntry('orchestrator', 'Finish choosing repositories for the pending tickets or cancel that step first.');
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
        repos,
        recentRepos: getRecentRepos(),
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
          isPro,
          createTicket: createTicket.mutateAsync,
          updateTicket: updateTicket.mutateAsync,
          transitionTicket: transitionTicket.mutateAsync,
          deleteTicket: deleteTicket.mutateAsync,
          startAgent,
          setPendingDelete,
          repos,
          recentRepos: getRecentRepos(),
          setPendingRepoSelection,
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

  const config = getOrchestratorConfig();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const MODEL_OPTIONS: { provider: OrchestratorProvider; label: string; suffix: string }[] = [
    { provider: 'anthropic', label: 'Sonnet 3.5', suffix: 'Latest' },
    { provider: 'openai', label: 'GPT-4.1', suffix: 'Mini' },
    { provider: 'gemini', label: 'Gemini 2.0', suffix: 'Flash' },
  ];

  const activeModel = MODEL_OPTIONS.find((m) => m.provider === config.provider) ?? MODEL_OPTIONS[0];

  function selectModel(opt: typeof MODEL_OPTIONS[number]) {
    const store = getKeyStore();
    store.activeProvider = opt.provider;
    saveKeyStore(store);
    setModelMenuOpen(false);
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />

      {/* Floating bar — drops down from top center, below the toolbar */}
      <div className="fixed z-50 top-11 left-1/2 w-[640px] max-w-[90vw] command-bar-enter">
        {/* Chat history (above the input box) */}
        {history.length > 0 && (
          <div ref={scrollRef} className="max-h-72 overflow-y-auto mb-2 space-y-2">
            {history.slice(-12).map((entry) => (
              <div
                key={entry.id}
                className={`text-[13px] leading-relaxed rounded-xl px-4 py-2.5 ${
                  entry.role === 'user'
                    ? 'bg-surface/80 text-text border border-border ml-12'
                    : 'bg-white/[0.06] text-text-muted mr-12'
                }`}
              >
                {entry.text}
              </div>
            ))}
          </div>
        )}

        {pendingDelete && (
          <div className="mb-2 text-[12px] text-state-waiting bg-surface/80 border border-border rounded-xl px-4 py-2">
            Delete {pendingDelete.label}? Reply <code className="text-text">yes</code> to confirm or <code className="text-text">cancel</code>.
          </div>
        )}

        {pendingRepoSelection && (
          <RepoSelectionCard
            pending={pendingRepoSelection}
            repos={repos}
            recentRepos={getRecentRepos()}
            onChange={(title, repoPath) =>
              setPendingRepoSelection((current) =>
                current
                  ? {
                      ...current,
                      selections: { ...current.selections, [title]: repoPath },
                    }
                  : current
              )
            }
            onCancel={() => {
              setPendingRepoSelection(null);
              appendEntry('orchestrator', 'Ticket creation cancelled.');
            }}
            onConfirm={async () => {
              if (!pendingRepoSelection) return;
              const repoChoices = buildRepoChoices(repos, getRecentRepos());
              const resolvedSpecs = applyRepoSelections(
                pendingRepoSelection.specs,
                repoChoices,
                pendingRepoSelection.selections,
              );
              const stillMissing = missingRepoTitles(resolvedSpecs);
              if (stillMissing.length > 0) {
                appendEntry('orchestrator', `Choose a repository for: ${stillMissing.join(', ')}.`);
                return;
              }

              setIsActing(true);
              try {
                const result = await executeCreateTickets({
                  specs: resolvedSpecs,
                  createTicket: createTicket.mutateAsync,
                  transitionTicket: transitionTicket.mutateAsync,
                  isPro,
                });
                appendEntry('orchestrator', result);
                setPendingRepoSelection(null);
              } catch (error) {
                appendEntry('orchestrator', `Ticket creation failed: ${String(error)}`);
              } finally {
                setIsActing(false);
              }
            }}
            disabled={isActing}
          />
        )}

        {/* Input box */}
        <div className="bg-surface border border-border rounded-2xl shadow-2xl shadow-black/40">
          {/* Textarea */}
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
            rows={1}
            placeholder="Create, run, or manage tickets..."
            disabled={isActing}
            className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] text-text
              placeholder:text-text-dim/50 focus:outline-none
              disabled:opacity-60 transition-colors leading-relaxed"
          />

          {/* Bottom row: + button | model selector | send */}
          <div className="flex items-center px-3 pb-3 pt-1">
            {/* Plus button */}
            <button
              className="w-7 h-7 flex items-center justify-center rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all"
              title="Attach context"
            >
              <Plus className="w-4 h-4" />
            </button>

            <div className="flex-1" />

            {/* Model selector */}
            <div className="relative">
              <button
                onClick={() => setModelMenuOpen((v) => !v)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all"
              >
                <span className="text-[12px] font-medium text-text">{activeModel.label}</span>
                <span className="text-[12px] text-text-dim">{activeModel.suffix}</span>
                <ChevronDown className="w-3 h-3 text-text-dim" />
              </button>

              {modelMenuOpen && (
                <div className="absolute top-full right-0 mt-1 w-52 bg-surface border border-border rounded-lg shadow-xl shadow-black/40 py-1 z-10">
                  {MODEL_OPTIONS.map((opt) => {
                    const available = hasApiKey(opt.provider);
                    const isActive = opt.provider === activeModel.provider;
                    return (
                      <button
                        key={opt.provider}
                        onClick={() => available && selectModel(opt)}
                        disabled={!available}
                        className={`w-full text-left px-3 py-2 text-[12px] transition-colors flex items-center gap-2 group relative
                          ${!available
                            ? 'opacity-40 cursor-not-allowed'
                            : isActive
                              ? 'text-text bg-white/[0.04]'
                              : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
                          }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-accent' : available ? 'bg-text-dim/30' : 'bg-text-dim/10'}`} />
                        <span className="font-medium">{opt.label}</span>
                        <span className="text-text-dim">{opt.suffix}</span>
                        {!available && (
                          <span className="ml-auto text-[10px] text-text-dim">No key</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Send button */}
            <button
              onClick={() => void handleSend()}
              disabled={isActing || !message.trim()}
              className="ml-2 w-8 h-8 flex items-center justify-center rounded-xl
                bg-[#d4a087] text-white
                hover:bg-[#c4907a] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {isActing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowUp className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---- Action execution ----

async function executeAction({
  action,
  tickets,
  isPro,
  createTicket,
  updateTicket,
  transitionTicket,
  deleteTicket,
  startAgent,
  setPendingDelete,
  repos,
  recentRepos,
  setPendingRepoSelection,
}: {
  action: OrchestratorAction;
  tickets: Ticket[];
  isPro: boolean;
  createTicket: (params: { title: string; context?: string; repo_path?: string; assigned_agent?: string }) => Promise<Ticket>;
  updateTicket: (params: { id: string; fields: Record<string, unknown> }) => Promise<Ticket>;
  transitionTicket: (params: { id: string; toStatus: Ticket['status'] }) => Promise<Ticket>;
  deleteTicket: (id: string) => Promise<void>;
  startAgent: (ticket: Ticket) => Promise<{ ok: boolean; error?: string }>;
  setPendingDelete: (value: PendingDelete | null) => void;
  repos: Repo[];
  recentRepos: string[];
  setPendingRepoSelection: (value: PendingRepoSelection | null) => void;
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
      const repoChoices = buildRepoChoices(repos, recentRepos);
      const pendingSelection = preparePendingRepoSelection(specs, repoChoices);

      if (pendingSelection) {
        setPendingRepoSelection(pendingSelection);
        return `Choose a repository for ${pendingSelection.unresolvedTitles.join(', ')}.`;
      }

      if (repoChoices.length === 0 && specs.some((spec) => !spec.repo_path?.trim())) {
        return 'I need a repository before creating those tickets. Add a repo or specify one in your prompt.';
      }

      const resolvedSpecs = applyRepoSelections(specs, repoChoices, {});
      return executeCreateTickets({
        specs: resolvedSpecs,
        createTicket,
        transitionTicket,
        isPro,
      });
    }
  }
}

function RepoSelectionCard({
  pending,
  repos,
  recentRepos,
  onChange,
  onCancel,
  onConfirm,
  disabled,
}: {
  pending: PendingRepoSelection;
  repos: Repo[];
  recentRepos: string[];
  onChange: (title: string, repoPath: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  const choices = buildRepoChoices(repos, recentRepos);
  const canConfirm = pending.unresolvedTitles.every((title) => pending.selections[title]);

  return (
    <div className="mb-2 rounded-2xl border border-border bg-surface px-4 py-3 shadow-xl shadow-black/20">
      <div className="mb-2">
        <div className="text-[12px] font-medium text-text">Choose repositories</div>
        <div className="text-[11px] text-text-dim">The orchestrator needs a repo for these tickets before it can create them.</div>
      </div>
      <div className="space-y-2">
        {pending.unresolvedTitles.map((title) => (
          <div key={title} className="grid grid-cols-[minmax(0,1fr)_220px] items-center gap-3">
            <div className="truncate text-[12px] text-text">{title}</div>
            <Select
              value={pending.selections[title] ?? ''}
              onChange={(event) => onChange(title, event.target.value)}
              options={choices.map((choice) => ({ value: choice.path, label: choice.label }))}
              placeholder="Choose repository..."
              disabled={disabled}
              className="text-[12px]"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={disabled}>Cancel</Button>
        <Button size="sm" onClick={onConfirm} disabled={disabled || !canConfirm}>Create Tickets</Button>
      </div>
    </div>
  );
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
