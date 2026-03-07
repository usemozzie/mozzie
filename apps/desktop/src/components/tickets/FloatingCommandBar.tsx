import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Plus, ArrowUp, Loader2, ChevronDown, CircleDot, FolderGit2, Bot, Play, BarChart3, Zap, XCircle, RotateCcw } from 'lucide-react';
import type { Repo, Ticket } from '@mozzie/db';
import { useTickets } from '../../hooks/useTickets';
import { useRepos } from '../../hooks/useRepos';
import {
  useCreateTicket,
  useCloseTicket,
  useDeleteTicket,
  useReopenTicket,
  useTransitionTicket,
  useUpdateTicket,
} from '../../hooks/useTicketMutation';
import { useStartAgent } from '../../hooks/useStartAgent';
import { useLicense } from '../../hooks/useLicense';
import { useAgentConfigs } from '../../hooks/useAgents';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  getOrchestratorConfig,
  getDefaultModel,
  getKeyStore,
  saveKeyStore,
  hasApiKey,
  usePlanOrchestratorActions,
  useOrchestratorKeyStore,
  type OrchestratorAction,
  type OrchestratorProvider,
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

interface PopoverItem {
  id: string;
  label: string;
  description?: string;
  category: string;
  action?: string;
}

interface FloatingCommandBarProps {
  onClose: () => void;
}

export function FloatingCommandBar({ onClose }: FloatingCommandBarProps) {
  const { data: tickets = [] } = useTickets();
  const { data: repos = [] } = useRepos();
  const { data: agents = [] } = useAgentConfigs();
  const { data: license } = useLicense();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const isPro = license?.is_pro ?? false;
  const createTicket = useCreateTicket();
  const updateTicket = useUpdateTicket();
  const transitionTicket = useTransitionTicket();
  const closeTicket = useCloseTicket();
  const reopenTicket = useReopenTicket();
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
  const keyStore = useOrchestratorKeyStore();

  // Popover state
  const [popoverType, setPopoverType] = useState<'mention' | 'command' | null>(null);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [popoverIndex, setPopoverIndex] = useState(0);
  const [triggerStart, setTriggerStart] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  // Close on Escape (only when popover is not open)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !popoverType) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, popoverType]);

  // Scroll active popover item into view
  useEffect(() => {
    if (popoverRef.current) {
      const active = popoverRef.current.querySelector('[data-active="true"]');
      active?.scrollIntoView({ block: 'nearest' });
    }
  }, [popoverIndex]);

  function appendEntry(role: ChatEntry['role'], text: string) {
    setHistory((prev) => [...prev, { id: crypto.randomUUID(), role, text }]);
  }

  // -- Mention items --
  const mentionItems = useMemo<PopoverItem[]>(() => [
    ...tickets.map((t) => ({
      id: `ticket:${t.id}`,
      label: t.title,
      description: t.status,
      category: 'ticket',
    })),
    ...repos.map((r) => ({
      id: `repo:${r.id}`,
      label: r.name || r.path.split(/[/\\]/).pop() || r.path,
      description: r.path,
      category: 'repo',
    })),
    ...agents.map((a) => ({
      id: `agent:${a.id}`,
      label: a.display_name,
      description: a.acp_url,
      category: 'agent',
    })),
  ], [tickets, repos, agents]);

  // -- Slash commands --
  const commandItems = useMemo<PopoverItem[]>(() => [
    { id: 'cmd:run', label: 'run', description: 'Run all ready tickets', category: 'action', action: 'run' },
    { id: 'cmd:status', label: 'status', description: 'Show ticket summary', category: 'action', action: 'status' },
    { id: 'cmd:create', label: 'create', description: 'Create a new ticket', category: 'action', action: 'create' },
    { id: 'cmd:close', label: 'close', description: 'Close tickets by name', category: 'action', action: 'close' },
    { id: 'cmd:reopen', label: 'reopen', description: 'Reopen closed tickets', category: 'action', action: 'reopen' },
    { id: 'cmd:delete', label: 'delete', description: 'Delete tickets', category: 'action', action: 'delete' },
  ], []);

  // -- Filtered items --
  const filteredItems = useMemo(() => {
    const source = popoverType === 'mention' ? mentionItems : popoverType === 'command' ? commandItems : [];
    if (!popoverFilter) return source.slice(0, 12);
    const lower = popoverFilter.toLowerCase();
    return source.filter((item) =>
      item.label.toLowerCase().includes(lower) ||
      item.description?.toLowerCase().includes(lower) ||
      item.category.toLowerCase().includes(lower)
    ).slice(0, 12);
  }, [popoverType, popoverFilter, mentionItems, commandItems]);

  // -- Popover selection --
  const selectPopoverItem = useCallback((item: PopoverItem) => {
    if (popoverType === 'mention') {
      const before = message.slice(0, triggerStart);
      const afterCursor = inputRef.current?.selectionStart ?? message.length;
      const after = message.slice(afterCursor);
      const insertText = `@${item.label} `;
      setMessage(`${before}${insertText}${after}`);
      // Set cursor after inserted text
      requestAnimationFrame(() => {
        if (inputRef.current) {
          const pos = before.length + insertText.length;
          inputRef.current.selectionStart = pos;
          inputRef.current.selectionEnd = pos;
          inputRef.current.focus();
        }
      });
    } else if (popoverType === 'command') {
      switch (item.action) {
        case 'run':
          setMessage('');
          appendEntry('user', '/run');
          void handleCommandAction('Run all ready tickets');
          break;
        case 'status':
          setMessage('');
          appendEntry('user', '/status');
          void handleCommandAction('Show me a summary of all tickets');
          break;
        case 'create':
          setMessage('Create ticket: ');
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        case 'close':
          setMessage('Close ');
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        case 'reopen':
          setMessage('Reopen ');
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        case 'delete':
          setMessage('Delete ');
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        default:
          setMessage('');
          requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
    setPopoverType(null);
  }, [popoverType, message, triggerStart]);

  async function handleCommandAction(prompt: string) {
    const config = getOrchestratorConfig();
    if (!config.apiKey.trim()) {
      appendEntry('orchestrator', 'Set the orchestrator API key in Settings before using chat orchestration.');
      return;
    }
    setIsActing(true);
    try {
      const plan = await planActions.mutateAsync({
        config,
        message: prompt,
        tickets,
        repos,
        agents,
        recentRepos: getRecentRepos(),
        workspaceId: activeWorkspaceId,
        history: history.slice(-8).map((entry) => ({ role: entry.role, text: entry.text })),
      });
      if (plan.assistant_message?.trim()) {
        appendEntry('orchestrator', plan.assistant_message.trim());
      }
      for (const action of plan.actions ?? []) {
        const result = await executeAction({
          action, tickets, isPro,
          createTicket: createTicket.mutateAsync,
          updateTicket: updateTicket.mutateAsync,
          transitionTicket: transitionTicket.mutateAsync,
          closeTicket: closeTicket.mutateAsync,
          reopenTicket: reopenTicket.mutateAsync,
          deleteTicket: deleteTicket.mutateAsync,
          startAgent, setPendingDelete, repos,
          recentRepos: getRecentRepos(),
          setPendingRepoSelection,
        });
        if (result) appendEntry('orchestrator', result);
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

  // -- Input change handler with @ and / detection --
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setMessage(value);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);

    // Check for @ mention trigger
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);
    if (atMatch) {
      setPopoverType('mention');
      setPopoverFilter(atMatch[1]);
      setPopoverIndex(0);
      setTriggerStart(cursorPos - atMatch[0].length);
      return;
    }

    // Check for / command trigger (only at start of line or input)
    const slashMatch = textBeforeCursor.match(/(?:^|\n)\/([^\s]*)$/);
    if (slashMatch) {
      setPopoverType('command');
      setPopoverFilter(slashMatch[1]);
      setPopoverIndex(0);
      setTriggerStart(cursorPos - slashMatch[0].length);
      return;
    }

    setPopoverType(null);
  }

  // -- Keyboard handler --
  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Popover navigation
    if (popoverType && filteredItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPopoverIndex((i) => (i + 1) % filteredItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPopoverIndex((i) => (i - 1 + filteredItems.length) % filteredItems.length);
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        selectPopoverItem(filteredItems[popoverIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setPopoverType(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  async function handleSend() {
    const raw = message.trim();
    if (!raw || isActing) return;

    appendEntry('user', raw);
    setMessage('');
    setPopoverType(null);

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
        agents,
        recentRepos: getRecentRepos(),
        workspaceId: activeWorkspaceId,
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
          closeTicket: closeTicket.mutateAsync,
          reopenTicket: reopenTicket.mutateAsync,
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

  const modelOptions = useMemo(
    () =>
      (['anthropic', 'openai', 'gemini'] as OrchestratorProvider[]).map((provider) => ({
        provider,
        model: keyStore.models[provider]?.trim() || getDefaultModel(provider),
      })),
    [keyStore.models]
  );

  const activeModel = modelOptions.find((option) => option.provider === config.provider) ?? modelOptions[0];

  function selectModel(opt: { provider: OrchestratorProvider; model: string }) {
    const store = getKeyStore();
    store.activeProvider = opt.provider;
    saveKeyStore(store);
    setModelMenuOpen(false);
  }

  // Category icons for popover
  const categoryIcon: Record<string, typeof CircleDot> = {
    ticket: CircleDot,
    repo: FolderGit2,
    agent: Bot,
    action: Zap,
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />

      {/* Floating bar */}
      <div className="fixed z-50 top-11 left-1/2 w-[640px] max-w-[90vw] command-bar-enter">
        {/* Chat history */}
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
                  existingTickets: tickets,
                  createTicket: createTicket.mutateAsync,
                  reopenTicket: reopenTicket.mutateAsync,
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

        {/* Input container */}
        <div className="bg-surface border border-border rounded-2xl shadow-2xl shadow-black/40 overflow-visible relative">
          {/* @ / Popover — above the input */}
          {popoverType && filteredItems.length > 0 && (
            <div
              ref={popoverRef}
              className="absolute top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto
                rounded-xl border border-border bg-surface shadow-xl shadow-black/30 py-1 z-10"
            >
              {popoverType === 'mention' && (() => {
                let lastCategory = '';
                return filteredItems.map((item, i) => {
                  const showHeader = item.category !== lastCategory;
                  lastCategory = item.category;
                  const Icon = categoryIcon[item.category] ?? CircleDot;
                  return (
                    <div key={item.id}>
                      {showHeader && (
                        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-dim/50">
                          {item.category === 'ticket' ? 'Tickets' : item.category === 'repo' ? 'Repositories' : 'Agents'}
                        </div>
                      )}
                      <button
                        data-active={i === popoverIndex}
                        onMouseDown={(e) => { e.preventDefault(); selectPopoverItem(item); }}
                        onMouseEnter={() => setPopoverIndex(i)}
                        className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 transition-colors
                          ${i === popoverIndex ? 'bg-white/[0.08] text-text' : 'text-text-dim hover:bg-white/[0.04]'}`}
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0 opacity-50" />
                        <span className="truncate">{item.label}</span>
                        {item.description && (
                          <span className="ml-auto text-[11px] text-text-dim/50 truncate max-w-[140px]">{item.description}</span>
                        )}
                      </button>
                    </div>
                  );
                });
              })()}

              {popoverType === 'command' && filteredItems.map((item, i) => {
                const Icon = categoryIcon[item.category] ?? Zap;
                return (
                  <button
                    key={item.id}
                    data-active={i === popoverIndex}
                    onMouseDown={(e) => { e.preventDefault(); selectPopoverItem(item); }}
                    onMouseEnter={() => setPopoverIndex(i)}
                    className={`w-full text-left px-3 py-2 text-[13px] flex items-center gap-2.5 transition-colors
                      ${i === popoverIndex ? 'bg-white/[0.08] text-text' : 'text-text-dim hover:bg-white/[0.04]'}`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0 opacity-50" />
                    <span className="font-medium">/{item.label}</span>
                    {item.description && (
                      <span className="text-[11px] text-text-dim/50">{item.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Textarea — tall, generous padding, top-aligned placeholder */}
          <textarea
            ref={inputRef}
            value={message}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Reply..."
            disabled={isActing}
            className="w-full min-h-[72px] resize-none bg-transparent px-5 pt-4 pb-0 text-[15px] text-text
              placeholder:text-text-dim/30 focus:outline-none
              disabled:opacity-60 transition-colors leading-normal"
          />

          {/* Bottom row — 3 elements only: +, model label, send */}
          <div className="flex items-center px-4 pb-3 pt-1">
            <button
              className="text-text-dim/40 hover:text-text-dim transition-colors"
              title="Attach context"
            >
              <Plus className="w-5 h-5" />
            </button>

            <div className="flex-1" />

            {/* Model label + dropdown */}
            <div className="relative">
              <button
                onClick={() => setModelMenuOpen((v) => !v)}
                className="flex items-center gap-1 text-[13px] text-text-dim/70 hover:text-text-dim transition-colors"
              >
                <span>{activeModel?.model ?? config.model}</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {modelMenuOpen && (
                <>
                  <div className="fixed inset-0 z-[5]" onClick={() => setModelMenuOpen(false)} />
                  <div className="absolute top-full right-0 mt-1 w-56 bg-surface border border-border rounded-xl shadow-xl shadow-black/40 py-1 z-10">
                    {modelOptions.map((opt) => {
                      const available = hasApiKey(opt.provider);
                      const isActive = !!activeModel && opt.provider === activeModel.provider;
                      return (
                        <button
                          key={opt.provider}
                          onClick={() => available && selectModel(opt)}
                          disabled={!available}
                          className={`w-full text-left px-3 py-2 text-[12px] transition-colors flex items-center gap-2
                            ${!available
                              ? 'opacity-40 cursor-not-allowed'
                              : isActive
                                ? 'text-text bg-white/[0.06]'
                                : 'text-text-dim hover:text-text hover:bg-white/[0.04]'
                            }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-accent' : available ? 'bg-text-dim/30' : 'bg-text-dim/10'}`} />
                          <span className="truncate font-medium">{opt.model}</span>
                          {!available && (
                            <span className="ml-auto text-[10px] text-text-dim">No key</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Send button — round, salmon accent */}
            <button
              onClick={() => void handleSend()}
              disabled={isActing || !message.trim()}
              className="ml-3 w-8 h-8 flex items-center justify-center rounded-full
                bg-accent text-white
                hover:bg-accent/80 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
            >
              {isActing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowUp className="w-4 h-4 stroke-[2.5]" />
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
  closeTicket,
  reopenTicket,
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
  createTicket: (params: {
    title: string;
    context?: string;
    execution_context?: string;
    orchestrator_note?: string;
    repo_path?: string;
    assigned_agent?: string;
    duplicate_of_ticket_id?: string;
    duplicate_policy?: string;
    intent_type?: string;
  }) => Promise<Ticket>;
  updateTicket: (params: { id: string; fields: Record<string, unknown> }) => Promise<Ticket>;
  transitionTicket: (params: { id: string; toStatus: Ticket['status'] }) => Promise<Ticket>;
  closeTicket: (id: string) => Promise<Ticket>;
  reopenTicket: (id: string) => Promise<Ticket>;
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

    case 'close_tickets': {
      const ids = (action.ticket_ids ?? []).filter(Boolean);
      if (ids.length === 0) {
        return 'The LLM requested close, but no ticket IDs were provided.';
      }
      const matches = tickets.filter((ticket) => ids.includes(ticket.id));
      if (matches.length === 0) {
        return 'No matching tickets were found to close.';
      }
      for (const ticket of matches) {
        await closeTicket(ticket.id);
      }
      return matches.length === 1
        ? `Closed "${matches[0].title}".`
        : `Closed ${matches.length} tickets: ${matches.map((ticket) => ticket.title).join(', ')}.`;
    }

    case 'reopen_tickets': {
      const ids = (action.ticket_ids ?? []).filter(Boolean);
      if (ids.length === 0) {
        return 'The LLM requested reopen, but no ticket IDs were provided.';
      }
      const matches = tickets.filter((ticket) => ids.includes(ticket.id));
      if (matches.length === 0) {
        return 'No matching tickets were found to reopen.';
      }
      for (const ticket of matches) {
        await reopenTicket(ticket.id);
      }
      return matches.length === 1
        ? `Reopened "${matches[0].title}".`
        : `Reopened ${matches.length} tickets: ${matches.map((ticket) => ticket.title).join(', ')}.`;
    }

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
        existingTickets: tickets,
        createTicket,
        reopenTicket,
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
