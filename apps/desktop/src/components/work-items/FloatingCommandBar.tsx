import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Plus, ArrowUp, Loader2, ChevronDown, CircleDot, FolderGit2, Bot, Play, BarChart3, Zap, XCircle, RotateCcw, MessageSquare, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { Repo, WorkItem, ConversationMessage } from '@mozzie/db';
import { useWorkItems } from '../../hooks/useWorkItems';
import { useRepos } from '../../hooks/useRepos';
import {
  useCreateWorkItem,
  useCloseWorkItem,
  useDeleteWorkItem,
  useReopenWorkItem,
  useTransitionWorkItem,
  useUpdateWorkItem,
} from '../../hooks/useWorkItemMutation';
import { useStartAgent } from '../../hooks/useStartAgent';
import { useAgentConfigs } from '../../hooks/useAgents';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  useConversations,
  useConversationMessages,
  useCreateConversation,
  useDeleteConversation,
  useAppendMessage,
} from '../../hooks/useConversations';
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
  type OrchestratorWorkItemSpec,
} from '../../hooks/useOrchestrator';
import { getRecentRepos, getRepoDisplayName } from '../../lib/recentRepos';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import {
  applyRepoSelections,
  buildRepoChoices,
  executeCreateWorkItems,
  missingRepoTitles,
  preparePendingRepoSelection,
  type ExecuteCreateWorkItemsResult,
  type PendingRepoSelection,
} from './orchestratorCreateWorkItems';

interface ChatEntry {
  id: string;
  role: 'user' | 'orchestrator';
  text: string;
  metadata?: string | null;
}

interface PendingDelete {
  workItemIds: string[];
  label: string;
}

interface PopoverItem {
  id: string;
  label: string;
  description?: string;
  category: string;
  action?: string;
}

interface ActionExecutionResult {
  message: string;
  metadata?: string | null;
}

interface CreateWorkItemsResultMetadata {
  kind: 'create_work_items_result';
  requested_titles?: string[];
  created_titles?: string[];
  reopened_titles?: string[];
  reused_titles?: string[];
  handled_titles?: string[];
  handled_work_items?: Array<{
    id: string;
    title: string;
    repo_path?: string | null;
    mode: 'created' | 'reopened' | 'reused';
  }>;
}

interface FloatingCommandBarProps {
  onClose: () => void;
}

export function FloatingCommandBar({ onClose }: FloatingCommandBarProps) {
  const { data: workItems = [] } = useWorkItems();
  const { data: repos = [] } = useRepos();
  const { data: agents = [] } = useAgentConfigs();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const createWorkItem = useCreateWorkItem();
  const updateWorkItem = useUpdateWorkItem();
  const transitionWorkItem = useTransitionWorkItem();
  const closeWorkItem = useCloseWorkItem();
  const reopenWorkItem = useReopenWorkItem();
  const deleteWorkItem = useDeleteWorkItem();
  const { startAgent } = useStartAgent();
  const planActions = usePlanOrchestratorActions();

  // Conversation persistence
  const { data: conversations = [] } = useConversations();
  const createConversation = useCreateConversation();
  const deleteConversation = useDeleteConversation();
  const appendMessageMutation = useAppendMessage();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [showConversationList, setShowConversationList] = useState(false);
  const { data: persistedMessages = [] } = useConversationMessages(activeConversationId);

  // Map persisted messages to the ChatEntry shape used by rendering
  const history: ChatEntry[] = useMemo(
    () =>
      persistedMessages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'orchestrator',
        text: m.text,
        metadata: m.metadata,
      })),
    [persistedMessages],
  );

  const [message, setMessage] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingRepoSelection, setPendingRepoSelection] = useState<PendingRepoSelection | null>(null);
  const [isActing, setIsActing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const keyStore = useOrchestratorKeyStore();

  // CLI agent + permission mode for explore_repo
  const [exploreAgentId, setExploreAgentId] = useState<string>(() =>
    typeof window !== 'undefined' ? localStorage.getItem('mozzie.exploreAgent') || 'claude-code' : 'claude-code'
  );
  const [explorePermission, setExplorePermission] = useState<'full' | 'read_only'>(() =>
    (typeof window !== 'undefined' ? localStorage.getItem('mozzie.explorePermission') : null) === 'read_only' ? 'read_only' : 'full'
  );
  useEffect(() => { localStorage.setItem('mozzie.exploreAgent', exploreAgentId); }, [exploreAgentId]);
  useEffect(() => { localStorage.setItem('mozzie.explorePermission', explorePermission); }, [explorePermission]);

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

  // Scroll to bottom on new messages or when conversation changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [persistedMessages]);

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

  // Mutable ref to track conversation ID within async loops (React state lags behind)
  const convIdRef = useRef<string | null>(activeConversationId);
  useEffect(() => { convIdRef.current = activeConversationId; }, [activeConversationId]);

  /** Fetch fresh conversation messages from the DB (needed mid-loop since React state won't update). */
  async function getCurrentHistory(): Promise<ChatEntry[]> {
    const convId = convIdRef.current;
    if (!convId) return [];
    try {
      const messages = await invoke<ConversationMessage[]>('list_conversation_messages', {
        conversationId: convId,
      });
      return messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'orchestrator',
        text: m.text,
        metadata: m.metadata,
      }));
    } catch {
      return history;
    }
  }

  async function getCurrentWorkItems(): Promise<WorkItem[]> {
    try {
      return await invoke<WorkItem[]>('list_work_items', {
        statusFilter: null,
        workspaceId: activeWorkspaceId,
      });
    } catch {
      return workItems;
    }
  }

  /** Ensure a conversation exists (create on first message), then append. */
  async function appendEntry(role: ChatEntry['role'], text: string, metadata?: string | null) {
    let convId = convIdRef.current;
    if (!convId) {
      const title = role === 'user' ? text.slice(0, 60) : null;
      const conv = await createConversation.mutateAsync(title ?? undefined);
      convId = conv.id;
      convIdRef.current = convId;
      setActiveConversationId(convId);
    }
    await appendMessageMutation.mutateAsync({
      conversationId: convId,
      role,
      text,
      metadata: metadata ?? null,
    });
  }

  // -- Mention items --
  const mentionItems = useMemo<PopoverItem[]>(() => [
    ...workItems.map((t) => ({
      id: `work-item:${t.id}`,
      label: t.title,
      description: t.status,
      category: 'work-item',
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
  ], [workItems, repos, agents]);

  // -- Slash commands --
  const commandItems = useMemo<PopoverItem[]>(() => [
    { id: 'cmd:run', label: 'run', description: 'Run all ready work items', category: 'action', action: 'run' },
    { id: 'cmd:status', label: 'status', description: 'Show work item summary', category: 'action', action: 'status' },
    { id: 'cmd:create', label: 'create', description: 'Create a new work item', category: 'action', action: 'create' },
    { id: 'cmd:close', label: 'close', description: 'Close work items by name', category: 'action', action: 'close' },
    { id: 'cmd:reopen', label: 'reopen', description: 'Reopen closed work items', category: 'action', action: 'reopen' },
    { id: 'cmd:delete', label: 'delete', description: 'Delete work items', category: 'action', action: 'delete' },
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
          void (async () => {
            await appendEntry('user', '/run');
            await handleCommandAction('Run all ready work items');
          })();
          break;
        case 'status':
          setMessage('');
          void (async () => {
            await appendEntry('user', '/status');
            await handleCommandAction('Show me a summary of all work items');
          })();
          break;
        case 'create':
          setMessage('Create work item: ');
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

  const MAX_AGENT_LOOPS = 6;

  async function runOrchestratorLoop(initialMessage: string) {
    const config = getOrchestratorConfig();
    if (!config.apiKey.trim()) {
      await appendEntry('orchestrator', 'Set the orchestrator API key in Settings before using chat orchestration.');
      return;
    }
    setIsActing(true);
    try {
      let loopMessage = initialMessage;
      for (let turn = 0; turn < MAX_AGENT_LOOPS; turn++) {
        // Build fresh history each loop iteration (includes results from previous turns)
        const currentHistory = (await getCurrentHistory()).slice(-12).map((entry) => ({
          role: entry.role,
          text: entry.text,
          metadata: entry.metadata ?? null,
        }));
        const currentWorkItems = await getCurrentWorkItems();

        const plan = await planActions.mutateAsync({
          config,
          message: turn === 0 ? loopMessage : `[continuation — previous action results are in conversation history]`,
          workItems: currentWorkItems,
          repos,
          agents,
          recentRepos: getRecentRepos(),
          workspaceId: activeWorkspaceId,
          history: currentHistory,
        });

        if (plan.assistant_message?.trim()) {
          await appendEntry('orchestrator', plan.assistant_message.trim(), JSON.stringify(plan));
        }

        for (const action of plan.actions ?? []) {
          const actionHistory = await getCurrentHistory();
          const actionWorkItems = await getCurrentWorkItems();
          const result = await executeAction({
            action, workItems: actionWorkItems,
            createWorkItem: createWorkItem.mutateAsync,
            updateWorkItem: updateWorkItem.mutateAsync,
            transitionWorkItem: transitionWorkItem.mutateAsync,
            closeWorkItem: closeWorkItem.mutateAsync,
            reopenWorkItem: reopenWorkItem.mutateAsync,
            deleteWorkItem: deleteWorkItem.mutateAsync,
            startAgent, setPendingDelete, repos,
            recentRepos: getRecentRepos(),
            setPendingRepoSelection,
            exploreAgentId, explorePermission,
            userPrompt: initialMessage,
            conversationHistory: actionHistory,
          });
          if (result) {
            if (typeof result === 'string') {
              await appendEntry('orchestrator', result);
            } else {
              await appendEntry('orchestrator', result.message, result.metadata);
            }
          }
        }

        if ((!plan.actions || plan.actions.length === 0) && !plan.assistant_message?.trim()) {
          await appendEntry('orchestrator', 'No action taken.');
        }

        // If the LLM says it's done (or doesn't set done), stop looping
        if (plan.done !== false) break;
      }
    } catch (error) {
      await appendEntry('orchestrator', `Orchestrator error: ${String(error)}`);
    } finally {
      setIsActing(false);
    }
  }

  async function handleCommandAction(prompt: string) {
    await runOrchestratorLoop(prompt);
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

    await appendEntry('user', raw);
    setMessage('');
    setPopoverType(null);

    if (pendingDelete && isConfirmation(raw)) {
      setIsActing(true);
      try {
        await executeDelete(pendingDelete.workItemIds, deleteWorkItem.mutateAsync);
        await appendEntry('orchestrator', `Deleted ${pendingDelete.label}.`);
      } catch (error) {
        await appendEntry('orchestrator', `Delete failed: ${String(error)}`);
      } finally {
        setPendingDelete(null);
        setIsActing(false);
      }
      return;
    }

    if (pendingDelete && isCancel(raw)) {
      setPendingDelete(null);
      await appendEntry('orchestrator', 'Delete cancelled.');
      return;
    }

    if (pendingRepoSelection) {
      await appendEntry('orchestrator', 'Finish choosing repositories for the pending work items or cancel that step first.');
      return;
    }

    await runOrchestratorLoop(raw);
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
    workItem: CircleDot,
    repo: FolderGit2,
    agent: Bot,
    action: Zap,
  };

  return (
    <>
      {/* Backdrop — starts below the titlebar so window controls stay accessible */}
      <div className="fixed inset-0 top-10 z-50 bg-black/55 backdrop-blur-[3px]" onClick={onClose} />

      {/* Floating bar */}
      <div className="fixed z-[60] top-11 left-1/2 w-[720px] max-w-[calc(100vw-24px)] command-bar-enter pointer-events-none">
        <div className="pointer-events-auto">
          <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
            <button
              onClick={() => setShowConversationList((v) => !v)}
              className="flex min-w-0 items-center gap-2 rounded-full border border-border/70 bg-surface/85 px-3 py-1.5 text-[12px] text-text-dim transition-colors hover:border-border hover:bg-surface hover:text-text"
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {activeConversationId
                  ? conversations.find((c) => c.id === activeConversationId)?.title || 'Conversation'
                  : 'New conversation'}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </button>
            <div className="flex-1" />
            {activeConversationId && (
              <button
                onClick={() => {
                  setActiveConversationId(null);
                  setPendingDelete(null);
                  setPendingRepoSelection(null);
                }}
                className="rounded-full border border-border/60 px-2.5 py-1 text-[11px] text-text-dim/70 transition-colors hover:border-border hover:bg-white/[0.05] hover:text-text-dim"
              >
                New
              </button>
            )}
          </div>

          <div className="space-y-3 p-3">
            {/* Conversation list dropdown */}
            {showConversationList && (
              <>
                <div className="fixed inset-0 z-[1]" onClick={() => setShowConversationList(false)} />
                <div className="relative z-10 max-h-48 overflow-y-auto rounded-2xl border border-border bg-surface/95 shadow-xl shadow-black/40 py-1">
                  {conversations.length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-text-dim/50">No conversations yet</div>
                  )}
                  {conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={`flex items-center gap-2 px-3 py-2 text-[12px] cursor-pointer transition-colors
                        ${conv.id === activeConversationId
                          ? 'bg-white/[0.08] text-text'
                          : 'text-text-dim hover:bg-white/[0.04] hover:text-text'
                        }`}
                    >
                      <button
                        className="flex-1 text-left truncate"
                        onClick={() => {
                          setActiveConversationId(conv.id);
                          setShowConversationList(false);
                          setPendingDelete(null);
                          setPendingRepoSelection(null);
                        }}
                      >
                        {conv.title || 'Untitled'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (activeConversationId === conv.id) {
                            setActiveConversationId(null);
                          }
                          void deleteConversation.mutateAsync(conv.id);
                        }}
                        className="shrink-0 text-text-dim/30 hover:text-state-error transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Chat history */}
            {history.length > 0 && (
              <div className="rounded-2xl border border-border/60 bg-black/[0.14] p-3">
                <div ref={scrollRef} className="max-h-72 overflow-y-auto space-y-2">
                  {history.slice(-12).map((entry) => (
                    <div
                      key={entry.id}
                      className={`text-[13px] leading-relaxed rounded-xl px-4 py-2.5 ${
                        entry.role === 'user'
                          ? 'ml-12 border border-border/70 bg-surface text-text'
                          : 'mr-12 border border-white/[0.05] bg-white/[0.08] text-text-muted'
                      }`}
                    >
                      {entry.text}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {pendingDelete && (
              <div className="text-[12px] text-state-waiting bg-surface/85 border border-border rounded-xl px-4 py-2">
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
                onCancel={async () => {
                  setPendingRepoSelection(null);
                  await appendEntry('orchestrator', 'Work item creation cancelled.');
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
                    await appendEntry('orchestrator', `Choose a repository for: ${stillMissing.join(', ')}.`);
                    return;
                  }

                  setIsActing(true);
                  try {
                    const currentWorkItems = await getCurrentWorkItems();
                    const result = await executeCreateWorkItems({
                      specs: resolvedSpecs,
                      existingWorkItems: currentWorkItems,
                      createWorkItem: createWorkItem.mutateAsync,
                      reopenWorkItem: reopenWorkItem.mutateAsync,
                      transitionWorkItem: transitionWorkItem.mutateAsync,
                     
                    });
                    await appendEntry('orchestrator', result.message, buildCreateWorkItemsResultMetadata(result, resolvedSpecs));
                    setPendingRepoSelection(null);
                  } catch (error) {
                    await appendEntry('orchestrator', `Work item creation failed: ${String(error)}`);
                  } finally {
                    setIsActing(false);
                  }
                }}
                disabled={isActing}
              />
            )}

            {/* Input container */}
            <div className="bg-surface/95 border border-border rounded-2xl shadow-xl shadow-black/30 overflow-visible relative">
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
                              {item.category === 'work-item' ? 'Work Items' : item.category === 'repo' ? 'Repositories' : 'Agents'}
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

                {/* CLI agent selector for exploration */}
                <div className="relative group">
                  <button
                    onClick={() => {
                      const options = agents.filter((a) => a.enabled);
                      if (options.length === 0) return;
                      const idx = options.findIndex((a) => a.id === exploreAgentId);
                      const next = options[(idx + 1) % options.length];
                      setExploreAgentId(next.id);
                    }}
                    className="flex items-center gap-1 text-[11px] text-text-dim/50 hover:text-text-dim transition-colors"
                    title="CLI agent for exploration"
                  >
                    <Bot className="w-3.5 h-3.5" />
                    <span>{agents.find((a) => a.id === exploreAgentId)?.display_name ?? exploreAgentId}</span>
                  </button>
                </div>

                {/* Permission mode toggle */}
                <button
                  onClick={() => setExplorePermission((p) => p === 'full' ? 'read_only' : 'full')}
                  className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-md border transition-colors ${
                    explorePermission === 'read_only'
                      ? 'border-accent/40 text-accent/80 bg-accent/[0.06]'
                      : 'border-border text-text-dim/40 hover:text-text-dim/60'
                  }`}
                  title={explorePermission === 'read_only' ? 'Read-only: agent can only read files' : 'Full access: agent can use all tools'}
                >
                  {explorePermission === 'read_only' ? 'read-only' : 'full access'}
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
        </div>
      </div>
    </>
  );
}

// ---- Action execution ----

async function executeAction({
  action,
  workItems,
 
  createWorkItem,
  updateWorkItem,
  transitionWorkItem,
  closeWorkItem,
  reopenWorkItem,
  deleteWorkItem,
  startAgent,
  setPendingDelete,
  repos,
  recentRepos,
  setPendingRepoSelection,
  exploreAgentId,
  explorePermission,
  userPrompt,
  conversationHistory,
}: {
  action: OrchestratorAction;
  workItems: WorkItem[];
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
  updateWorkItem: (params: { id: string; fields: Record<string, unknown> }) => Promise<WorkItem>;
  transitionWorkItem: (params: { id: string; toStatus: WorkItem['status'] }) => Promise<WorkItem>;
  closeWorkItem: (id: string) => Promise<WorkItem>;
  reopenWorkItem: (id: string) => Promise<WorkItem>;
  deleteWorkItem: (id: string) => Promise<void>;
  startAgent: (workItem: WorkItem) => Promise<{ ok: boolean; error?: string }>;
  setPendingDelete: (value: PendingDelete | null) => void;
  repos: Repo[];
  recentRepos: string[];
  setPendingRepoSelection: (value: PendingRepoSelection | null) => void;
  exploreAgentId: string;
  explorePermission: string;
  userPrompt: string;
  conversationHistory: ChatEntry[];
}) {
  switch (action.kind) {
    case 'summary':
      return summarizeWorkItems(workItems);

    case 'run_all_ready':
      return handleRunAllReady(
        workItems,
        startAgent,
        repos,
        action.repo_path,
        userPrompt,
        action.work_item_ids ?? undefined,
        getLatestConversationBatch(conversationHistory)?.workItemIds,
      );

    case 'start_work_item':
      if (!action.work_item_id) {
        return 'The LLM did not specify a work item ID to start.';
      }
      return handleStartOne(action.work_item_id, workItems, startAgent);

    case 'close_work_items': {
      const ids = (action.work_item_ids ?? []).filter(Boolean);
      if (ids.length === 0) {
        return 'The LLM requested close, but no workItem IDs were provided.';
      }
      const matches = workItems.filter((workItem) => ids.includes(workItem.id));
      if (matches.length === 0) {
        return 'No matching work items were found to close.';
      }
      for (const workItem of matches) {
        await closeWorkItem(workItem.id);
      }
      return matches.length === 1
        ? `Closed "${matches[0].title}".`
        : `Closed ${matches.length} work items: ${matches.map((workItem) => workItem.title).join(', ')}.`;
    }

    case 'reopen_work_items': {
      const ids = (action.work_item_ids ?? []).filter(Boolean);
      if (ids.length === 0) {
        return 'The LLM requested reopen, but no workItem IDs were provided.';
      }
      const matches = workItems.filter((workItem) => ids.includes(workItem.id));
      if (matches.length === 0) {
        return 'No matching work items were found to reopen.';
      }
      for (const workItem of matches) {
        await reopenWorkItem(workItem.id);
      }
      return matches.length === 1
        ? `Reopened "${matches[0].title}".`
        : `Reopened ${matches.length} work items: ${matches.map((workItem) => workItem.title).join(', ')}.`;
    }

    case 'delete_work_items': {
      const ids = (action.work_item_ids ?? []).filter(Boolean);
      if (ids.length === 0) {
        return 'The LLM requested delete, but no workItem IDs were provided.';
      }
      const matches = workItems.filter((workItem) => ids.includes(workItem.id));
      if (matches.length === 0) {
        return 'No matching work items were found to delete.';
      }
      setPendingDelete({
        workItemIds: matches.map((workItem) => workItem.id),
        label: matches.length === 1 ? `"${matches[0].title}"` : `${matches.length} work items`,
      });
      return `Delete ${matches.length === 1 ? `"${matches[0].title}"` : `${matches.length} work items`}? Reply \`yes\` to confirm or \`cancel\`.`;
    }

    case 'create_work_items': {
      const specs = action.work_items ?? [];
      if (specs.length === 0) {
        return 'The LLM requested workItem creation, but provided no workItem specs.';
      }
      const repoChoices = buildRepoChoices(repos, recentRepos);
      const pendingSelection = preparePendingRepoSelection(specs, repoChoices);

      if (pendingSelection) {
        setPendingRepoSelection(pendingSelection);
        return `Choose a repository for ${pendingSelection.unresolvedTitles.join(', ')}.`;
      }

      if (repoChoices.length === 0 && specs.some((spec) => !spec.repo_path?.trim())) {
        return 'I need a repository before creating those work items. Add a repo or specify one in your prompt.';
      }

      const resolvedSpecs = applyRepoSelections(specs, repoChoices, {});
      const result = await executeCreateWorkItems({
        specs: resolvedSpecs,
        existingWorkItems: workItems,
        createWorkItem,
        reopenWorkItem,
        transitionWorkItem,
       
      });
      return {
        message: result.message,
        metadata: buildCreateWorkItemsResultMetadata(result, resolvedSpecs),
      } satisfies ActionExecutionResult;
    }

    case 'explore_repo': {
      const repoPath = action.repo_path?.trim();
      const prompt = action.prompt?.trim();
      if (!repoPath) {
        if (repos.length === 1) {
          action.repo_path = repos[0].path;
        } else if (repos.length === 0) {
          return 'No repositories available. Add a repo before exploring.';
        } else {
          return `Multiple repos available. Please specify which repo to explore: ${repos.map((r) => r.name || r.path).join(', ')}.`;
        }
      }
      if (!prompt) {
        return 'The LLM requested exploration, but no prompt was provided.';
      }

      try {
        const summary = await invoke<string>('explore_repo', {
          repoPath: action.repo_path,
          prompt,
          agentId: exploreAgentId,
          permissionMode: explorePermission,
          maxTurns: 25,
        });

        // Return the exploration summary — it gets appended to the conversation.
        // The orchestrator LLM will see it in the history on the next turn and
        // can create informed work items via create_work_items.
        return `Exploration of ${action.repo_path}:\n\n${summary}`;
      } catch (error) {
        return `Exploration failed: ${String(error)}`;
      }
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
        <div className="text-[11px] text-text-dim">The orchestrator needs a repo for these work items before it can create them.</div>
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
        <Button size="sm" onClick={onConfirm} disabled={disabled || !canConfirm}>Create Work Items</Button>
      </div>
    </div>
  );
}

async function executeDelete(
  workItemIds: string[],
  deleteWorkItem: (id: string) => Promise<void>
) {
  for (const workItemId of workItemIds) {
    await deleteWorkItem(workItemId);
  }
}

function normalizeRepoReference(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sanitizeRepoReference(value: string) {
  return value
    .trim()
    .replace(/^@+/, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[),.:;!?]+$/g, '');
}

function resolveRepoPathReference(repoRef: string | null | undefined, repos: Repo[]) {
  const cleaned = sanitizeRepoReference(repoRef ?? '');
  if (!cleaned) return null;

  const normalized = normalizeRepoReference(cleaned);

  const byPath = repos.find((repo) => normalizeRepoReference(repo.path) === normalized);
  if (byPath) return byPath.path;

  if (cleaned.includes('/') || cleaned.includes('\\') || /^[A-Za-z]:/.test(cleaned)) {
    return cleaned;
  }

  const byName = repos.filter((repo) => repo.name.trim().toLowerCase() === normalized);
  if (byName.length === 1) return byName[0].path;

  const byDisplayName = repos.filter((repo) => getRepoDisplayName(repo.path).trim().toLowerCase() === normalized);
  if (byDisplayName.length === 1) return byDisplayName[0].path;

  return null;
}

function inferRunRepoPath(userPrompt: string, repos: Repo[]) {
  const runScopedMatch = userPrompt.match(/\b(?:run|start)\b[\s\S]*?@([^\s@]+)/i);
  if (!runScopedMatch?.[1]) return null;
  return resolveRepoPathReference(runScopedMatch[1], repos);
}

function getRepoLabel(repoPath: string, repos: Repo[]) {
  const match = repos.find((repo) => normalizeRepoReference(repo.path) === normalizeRepoReference(repoPath));
  if (match?.name.trim()) return match.name.trim();
  return getRepoDisplayName(repoPath);
}

function parseCreateWorkItemsResultMetadata(metadata: string | null | undefined): CreateWorkItemsResultMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as CreateWorkItemsResultMetadata;
    return parsed.kind === 'create_work_items_result' ? parsed : null;
  } catch {
    return null;
  }
}

function getLatestConversationBatch(history: ChatEntry[]) {
  for (let i = history.length - 1; i >= 0; i--) {
    const parsed = parseCreateWorkItemsResultMetadata(history[i].metadata);
    if (!parsed) continue;
    const handledWorkItems = parsed.handled_work_items ?? [];
    if (handledWorkItems.length === 0) continue;
    return {
      workItemIds: handledWorkItems.map((workItem) => workItem.id),
      titles: handledWorkItems.map((workItem) => workItem.title),
    };
  }
  return null;
}

function isExplicitWorkspaceWideRun(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('@')) return false;
  return /\b(run|start)\b/.test(normalized) && /\b(all|everything|workspace)\b/.test(normalized);
}

function buildCreateWorkItemsResultMetadata(
  result: ExecuteCreateWorkItemsResult,
  specs: OrchestratorWorkItemSpec[],
) {
  return JSON.stringify({
    kind: 'create_work_items_result',
    requested_titles: specs.map((spec) => spec.title),
    created_titles: result.createdTitles,
    reopened_titles: result.reopenedTitles,
    reused_titles: result.reusedTitles,
    handled_work_items: result.handledWorkItems,
    handled_titles: Array.from(new Set([
      ...result.createdTitles,
      ...result.reopenedTitles,
      ...result.reusedTitles,
    ])),
  });
}

async function handleRunAllReady(
  workItems: WorkItem[],
  startAgent: (workItem: WorkItem) => Promise<{ ok: boolean; error?: string }>,
  repos: Repo[],
  repoRef?: string | null,
  userPrompt?: string,
  workItemIds?: string[] | null,
  latestConversationBatchWorkItemIds?: string[] | null,
) {
  const explicitRepoPath = resolveRepoPathReference(repoRef, repos);
  const parentIds = new Set(workItems.filter((workItem) => workItem.parent_id).map((workItem) => workItem.parent_id!));
  if (repoRef?.trim() && !explicitRepoPath) {
    return `I could not match repository "${repoRef}" to a known repo.`;
  }

  const scopedRepoPath = explicitRepoPath ?? inferRunRepoPath(userPrompt ?? '', repos);
  const explicitWorkItemIds = (workItemIds ?? []).filter(Boolean);
  const fallbackBatchWorkItemIds =
    explicitWorkItemIds.length === 0 &&
    !scopedRepoPath &&
    !isExplicitWorkspaceWideRun(userPrompt ?? '')
      ? (latestConversationBatchWorkItemIds ?? []).filter(Boolean)
      : [];

  const readyWorkItems = workItems.filter((workItem) => {
    if (workItem.status !== 'ready') return false;
    if (parentIds.has(workItem.id)) return false;
    if (explicitWorkItemIds.length > 0 && !explicitWorkItemIds.includes(workItem.id)) return false;
    if (explicitWorkItemIds.length === 0 && fallbackBatchWorkItemIds.length > 0 && !fallbackBatchWorkItemIds.includes(workItem.id)) {
      return false;
    }
    if (!scopedRepoPath) return true;
    return !!workItem.repo_path && normalizeRepoReference(workItem.repo_path) === normalizeRepoReference(scopedRepoPath);
  });

  if (readyWorkItems.length === 0) {
    if (explicitWorkItemIds.length > 0 || fallbackBatchWorkItemIds.length > 0) {
      return 'No relevant work items from the current work are in `ready` state.';
    }
    if (scopedRepoPath) {
      return `No work items are in \`ready\` state for repo \`${getRepoLabel(scopedRepoPath, repos)}\`.`;
    }
    return 'No work items are in `ready` state.';
  }

  const started: string[] = [];
  const skipped: string[] = [];

  for (const workItem of readyWorkItems) {
    const result = await startAgent(workItem);
    if (result.ok) {
      started.push(workItem.title);
    } else {
      skipped.push(`${workItem.title}: ${result.error ?? 'failed'}`);
      if ((result.error ?? '').includes('All 8 terminal slots')) {
        break;
      }
    }
  }

  const parts: string[] = [];
  if (started.length > 0) {
    const prefix = scopedRepoPath
      ? `Started ${started.length} work item${started.length === 1 ? '' : 's'} for \`${getRepoLabel(scopedRepoPath, repos)}\``
      : explicitWorkItemIds.length > 0 || fallbackBatchWorkItemIds.length > 0
        ? `Started ${started.length} work item${started.length === 1 ? '' : 's'} for the current work`
      : `Started ${started.length} work item${started.length === 1 ? '' : 's'}`;
    parts.push(`${prefix}: ${started.join(', ')}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Skipped ${skipped.length}: ${skipped.join(' | ')}.`);
  }

  return parts.join(' ');
}

async function handleStartOne(
  workItemId: string,
  workItems: WorkItem[],
  startAgent: (workItem: WorkItem) => Promise<{ ok: boolean; error?: string }>
) {
  const workItem = workItems.find((entry) => entry.id === workItemId);

  if (!workItem) {
    return `I could not find work item${workItemId}.`;
  }

  const result = await startAgent(workItem);
  return result.ok
    ? `Started "${workItem.title}".`
    : `Could not start "${workItem.title}": ${result.error ?? 'failed'}.`;
}

function summarizeWorkItems(workItems: WorkItem[]) {
  if (workItems.length === 0) {
    return 'There are no work items yet.';
  }

  const counts = workItems.reduce<Record<string, number>>((acc, workItem) => {
    acc[workItem.status] = (acc[workItem.status] ?? 0) + 1;
    return acc;
  }, {});

  const statusSummary = Object.entries(counts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');

  return `Backlog summary: ${workItems.length} total work items. ${statusSummary}.`;
}

function isConfirmation(value: string) {
  return ['yes', 'confirm', 'y'].includes(value.trim().toLowerCase());
}

function isCancel(value: string) {
  return ['cancel', 'no', 'n'].includes(value.trim().toLowerCase());
}
