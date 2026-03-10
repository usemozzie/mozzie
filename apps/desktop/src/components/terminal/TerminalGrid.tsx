import { useEffect, useMemo, useState } from 'react';
import { Loader2, X, ChevronRight, Maximize2, Minimize2, Plus, ArrowUp, ChevronDown, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AcpEventItem, AgentPermissionPolicy, WorkItem } from '@mozzie/db';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkItemStore } from '../../stores/workItemStore';
import { useWorkItem } from '../../hooks/useWorkItems';
import { useUpdateWorkItem, useTransitionWorkItem } from '../../hooks/useWorkItemMutation';
import { useAcpRun } from '../../hooks/useAcpRun';
import {
  useAgentLogs,
  useAgentSession,
  useCancelAgentTurn,
  useContinueAgent,
  useRespondToAgentPermission,
  useSetAgentPermissionPolicy,
  useStopAgentSession,
} from '../../hooks/useAgents';
import { useWorkItemAttempts } from '../../hooks/useAttemptHistory';
import { useReview } from '../../hooks/useReview';
import { useApproveWorkItemReview, useRejectWorkItemReview, useCloseWorkItemReview } from '../../hooks/useWorktree';
import { useRecordAttempt } from '../../hooks/useAttemptHistory';
import { getAgentCliCommands } from '../../lib/agentCliCommands';
import { AGENT_OPTIONS } from '../../lib/agentOptions';
import { getWorkItemTag } from '../../lib/workItemColors';
import { StatusBadge } from '../ui/badge';
import { ReviewPanel } from '../review/ReviewPanel';
import { AtReferenceTextarea, type SlashCommandOption } from '../work-items/AtReferenceTextarea';
import { WorkItemDescriptionEditor } from '../work-items/WorkItemDescriptionEditor';

type PanelTab = 'agent' | 'changes' | 'description';

function getColCount(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

export function TerminalGrid() {
  const activeSlots = useTerminalStore((s) => s.activeSlots);
  const selectedWorkItemIds = useWorkItemStore((s) => s.selectedWorkItemIds);
  const [focusedWorkItemId, setFocusedWorkItemId] = useState<string | null>(null);
  const [panelTabs, setPanelTabs] = useState<Record<string, PanelTab>>({});

  const activeEntries = useMemo(() => Array.from(activeSlots.entries()), [activeSlots]);
  const selectedEntries = useMemo(
    () =>
      selectedWorkItemIds.map((workItemId, index) => ({
        workItemId,
        colorIndex: index,
        slot: activeEntries.find(([, activeWorkItemId]) => activeWorkItemId === workItemId)?.[0],
      })),
    [activeEntries, selectedWorkItemIds],
  );
  const fallbackEntries = useMemo(
    () =>
      activeEntries
        .filter(([, workItemId]) => !selectedWorkItemIds.includes(workItemId))
        .map(([slot, workItemId], index) => ({
          slot,
          workItemId,
          colorIndex: selectedEntries.length + index,
        })),
    [activeEntries, selectedEntries.length, selectedWorkItemIds],
  );
  const panelEntries = selectedEntries.length > 0 ? selectedEntries : fallbackEntries;
  const count = panelEntries.length;

  if (count === 0) {
    return (
      <div className="h-full flex items-center justify-center select-none">
        <div className="text-center space-y-2">
          <div className="w-10 h-10 mx-auto rounded-xl bg-surface flex items-center justify-center">
            <span className="text-text-dim text-lg">~</span>
          </div>
          <p className="text-[13px] text-text-muted">No active agents</p>
          <p className="text-[11px] text-text-dim leading-relaxed max-w-56">
            Select a work item to inspect its run, or press the play button on a ready work item
          </p>
        </div>
      </div>
    );
  }

  // If a panel is focused, show it large + others as tiles
  const isFocused = focusedWorkItemId && panelEntries.some((e) => e.workItemId === focusedWorkItemId);

  if (isFocused && count > 1) {
    const focused = panelEntries.find((e) => e.workItemId === focusedWorkItemId)!;
    const background = panelEntries.filter((e) => e.workItemId !== focusedWorkItemId);

    return (
      <div className="h-full flex overflow-hidden">
        {/* Focused panel — takes ~60% */}
        <div className="flex-1 min-w-0 panel-tile panel-tile-focused">
        <WorkItemInteractionPanel
          key={`${focused.workItemId}:${focused.slot ?? 'selected'}`}
          workItemId={focused.workItemId}
          slot={focused.slot}
          colorIndex={focused.colorIndex}
          activeTab={panelTabs[focused.workItemId] ?? 'agent'}
          onActiveTabChange={(tab) =>
            setPanelTabs((current) =>
              current[focused.workItemId] === tab ? current : { ...current, [focused.workItemId]: tab },
            )
          }
          isFocused={true}
          hotkeyEnabled
          onToggleFocus={() => setFocusedWorkItemId(null)}
        />
        </div>

        {/* Background tiles sidebar */}
        <div className="w-56 shrink-0 border-l border-border overflow-y-auto bg-bg">
          {background.map(({ workItemId, slot, colorIndex }) => (
            <BackgroundTile
              key={`${workItemId}:${slot ?? 'bg'}`}
              workItemId={workItemId}
              slot={slot}
              colorIndex={colorIndex}
              onClick={() => setFocusedWorkItemId(workItemId)}
            />
          ))}
        </div>
      </div>
    );
  }

  const cols = getColCount(count);

  return (
    <div
      className="h-full grid gap-px bg-border"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridAutoRows: 'minmax(0, 1fr)',
      }}
    >
      {panelEntries.map(({ workItemId, slot, colorIndex }) => (
        <WorkItemInteractionPanel
          key={`${workItemId}:${slot ?? 'selected'}`}
          workItemId={workItemId}
          slot={slot}
          colorIndex={colorIndex}
          activeTab={panelTabs[workItemId] ?? 'agent'}
          onActiveTabChange={(tab) =>
            setPanelTabs((current) =>
              current[workItemId] === tab ? current : { ...current, [workItemId]: tab },
            )
          }
          isFocused={false}
          hotkeyEnabled={count === 1}
          onToggleFocus={() => setFocusedWorkItemId(count > 1 ? workItemId : null)}
        />
      ))}
    </div>
  );
}

// ---- Background status tile (collapsed view) ----

function BackgroundTile({
  workItemId,
  slot,
  colorIndex,
  onClick,
}: {
  workItemId: string;
  slot?: number;
  colorIndex: number;
  onClick: () => void;
}) {
  const { data: workItem } = useWorkItem(workItemId);
  const liveItems = useAcpRun(workItemId);
  const tag = getWorkItemTag(colorIndex);

  const toolCount = liveItems.filter((i) => i.kind === 'tool_call').length;
  const textCount = liveItems.filter((i) => i.kind === 'text' || i.kind === 'text_delta').length;
  const isRunning = workItem?.status === 'running';

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 border-b border-border hover:bg-surface transition-colors"
    >
      {/* Tag badge + title */}
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-[10px] font-bold shrink-0 text-white/90"
          style={{ backgroundColor: tag.color }}
        >
          {tag.letter}
        </span>
        <span className="text-[12px] font-medium text-text truncate flex-1">
          {workItem?.title ?? 'Loading...'}
        </span>
      </div>

      {/* Mini activity bar */}
      <ActivityBar items={liveItems} isRunning={isRunning ?? false} />

      {/* Status summary */}
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-text-dim">
        {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-state-active dot-pulse" />}
        <span>{toolCount} tools, {textCount} messages</span>
      </div>
    </button>
  );
}

// ---- Horizontal Activity Bar (Sparkline) ----

const TOOL_COLORS: Record<string, string> = {
  Read: '#6EE7B7',
  Edit: '#10B981',
  Write: '#10B981',
  Bash: '#F59E0B',
  Grep: '#8B5CF6',
  Glob: '#8B5CF6',
  Search: '#8B5CF6',
  default: '#64748B',
};

function getToolColor(name: string): string {
  for (const [key, color] of Object.entries(TOOL_COLORS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return TOOL_COLORS.default;
}

function ActivityBar({ items, isRunning }: { items: AcpEventItem[]; isRunning: boolean }) {
  const toolCalls = items.filter((i) => i.kind === 'tool_call');
  if (toolCalls.length === 0 && !isRunning) return null;

  return (
    <div className="relative h-1 rounded-full bg-white/[0.04] overflow-hidden flex">
      {toolCalls.length === 0 && isRunning ? (
        <div className="h-full w-full activity-shimmer rounded-full" />
      ) : (
        toolCalls.map((tc, i) => (
          <div
            key={tc.id ?? i}
            className="h-full min-w-[3px]"
            style={{
              flex: 1,
              maxWidth: 12,
              backgroundColor: getToolColor(tc.tool_name ?? ''),
              opacity: 0.7,
            }}
            title={tc.tool_name ?? 'tool'}
          />
        ))
      )}
    </div>
  );
}

function extractReferencedFiles(text: string): string[] {
  const matches = text.matchAll(/(^|[\s([{\n])@([A-Za-z0-9_./\\-]+)/g);
  const seen = new Set<string>();
  const files: string[] = [];

  for (const match of matches) {
    const value = match[2];
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    files.push(value);
  }

  return files;
}

function extractSlashCommand(text: string, commands: SlashCommandOption[]): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstLine = trimmed.slice(1).split('\n')[0]?.trim() ?? '';
  if (!firstLine) {
    return null;
  }

  const normalized = firstLine.toLowerCase();
  const command = [...commands]
    .sort((left, right) => right.command.length - left.command.length)
    .find(({ command }) => {
      const candidate = command.toLowerCase();
      return normalized === candidate || normalized.startsWith(`${candidate} `);
    });

  return command?.command ?? null;
}

// ---- Main interaction panel ----

interface WorkItemInteractionPanelProps {
  workItemId: string;
  slot?: number;
  colorIndex: number;
  activeTab: PanelTab;
  onActiveTabChange: (tab: PanelTab) => void;
  isFocused: boolean;
  hotkeyEnabled: boolean;
  onToggleFocus: () => void;
}

function WorkItemInteractionPanel({
  workItemId,
  slot,
  colorIndex,
  activeTab,
  onActiveTabChange,
  isFocused,
  hotkeyEnabled,
  onToggleFocus,
}: WorkItemInteractionPanelProps) {
  const releaseSlot = useTerminalStore((s) => s.releaseSlot);
  const getNextAvailableSlot = useTerminalStore((s) => s.getNextAvailableSlot);
  const transitionWorkItem = useTransitionWorkItem();
  const updateWorkItem = useUpdateWorkItem();
  const approveWorkItemReview = useApproveWorkItemReview();
  const rejectWorkItemReview = useRejectWorkItemReview();
  const closeWorkItemReview = useCloseWorkItemReview();
  const recordAttempt = useRecordAttempt();
  const continueAgent = useContinueAgent();
  const cancelAgentTurn = useCancelAgentTurn();
  const stopAgentSession = useStopAgentSession();
  const setAgentPermissionPolicy = useSetAgentPermissionPolicy();
  const respondToAgentPermission = useRespondToAgentPermission();
  const { data: workItem, isLoading } = useWorkItem(workItemId);
  const [isMutating, setIsMutating] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isUpdatingAgent, setIsUpdatingAgent] = useState(false);
  const [permissionPolicy, setPermissionPolicy] = useState<AgentPermissionPolicy>('allow_once');
  const liveItems = useAcpRun(workItemId);
  const { data: session } = useAgentSession(workItemId);
  const { data: logs } = useAgentLogs(workItemId);
  const latestLog = logs?.[0] ?? null;
  const mergedItems = liveItems;
  const segments = useMemo(() => groupIntoSegments(mergedItems), [mergedItems]);

  const review = useReview(workItem, activeTab === 'changes' || workItem?.status === 'review');
  const { data: attempts } = useWorkItemAttempts(workItemId);
  const attemptCount = attempts?.length ?? 0;
  const tag = getWorkItemTag(colorIndex);
  const accent = tag.color;
  const sessionIsRunning = session?.is_running ?? workItem?.status === 'running';
  const hasOpenSession = !!session;
  const pendingPermission = session?.pending_permission ?? null;
  const slashCommands = useMemo(
    () => getAgentCliCommands(workItem?.assigned_agent),
    [workItem?.assigned_agent],
  );
  const referencedFiles = useMemo(() => extractReferencedFiles(chatMessage), [chatMessage]);
  const activeSlashCommand = useMemo(
    () => extractSlashCommand(chatMessage, slashCommands),
    [chatMessage, slashCommands],
  );
  const visibleReferencedFiles = referencedFiles.slice(0, 3);
  const hiddenReferenceCount = referencedFiles.length - visibleReferencedFiles.length;
  const canChat = !!(
    workItem &&
    workItem.assigned_agent &&
    workItem.worktree_path &&
    workItem.status !== 'done' &&
    workItem.status !== 'archived'
  );
  const composerDisabled = isMutating || !canChat || !!pendingPermission;
  const canSendMessage = !!chatMessage.trim() && !composerDisabled;
  const showStopTurnButton = sessionIsRunning && !chatMessage.trim();

  useEffect(() => {
    if (session?.permission_policy) {
      setPermissionPolicy(session.permission_policy);
    }
  }, [session?.permission_policy]);

  useEffect(() => {
    if (review.review?.has_changes && activeTab === 'agent') {
      onActiveTabChange('changes');
    }
  }, [activeTab, onActiveTabChange, review.review?.has_changes]);

  useEffect(() => {
    if (!workItem || !hotkeyEnabled || workItem.status !== 'running') return;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'input' || target?.isContentEditable) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void handleAbort();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workItem?.id, workItem?.status, hotkeyEnabled, slot, isMutating]);

  async function handleAbort() {
    if (!workItem) return;
    setIsMutating(true);
    setActionError(null);
    try {
      await stopAgentSession.mutateAsync(workItem.id);
      if (slot != null) {
        releaseSlot(slot);
      }
      if (workItem.terminal_slot != null) {
        await updateWorkItem.mutateAsync({ id: workItemId, fields: { terminal_slot: null } });
      }
      if (workItem.status === 'running') {
        try {
          await transitionWorkItem.mutateAsync({ id: workItemId, toStatus: 'ready' });
        } catch (error) {
          if (!String(error).includes('Invalid transition: ready')) {
            throw error;
          }
        }
      }
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleStopTurn() {
    if (!workItem) return;
    setIsMutating(true);
    setActionError(null);
    try {
      await cancelAgentTurn.mutateAsync(workItem.id);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handlePermissionPolicyChange(nextPolicy: AgentPermissionPolicy) {
    const previousPolicy = session?.permission_policy ?? permissionPolicy;
    setPermissionPolicy(nextPolicy);

    if (!workItem || !session) {
      return;
    }

    setActionError(null);
    try {
      await setAgentPermissionPolicy.mutateAsync({
        workItemId: workItem.id,
        policy: nextPolicy,
      });
    } catch (error) {
      setPermissionPolicy(previousPolicy);
      setActionError(String(error));
    }
  }

  async function handlePermissionDecision(optionId: string | null) {
    if (!workItem || !pendingPermission) return;
    setActionError(null);
    try {
      await respondToAgentPermission.mutateAsync({
        workItemId: workItem.id,
        requestId: pendingPermission.request_id,
        optionId,
      });
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function handleApprove() {
    if (!workItem) return;
    setIsMutating(true);
    setActionError(null);
    try {
      if (workItem.parent_id) {
        await recordAttempt.mutateAsync({
          workItemId: workItem.id,
          agentId: workItem.assigned_agent ?? 'unknown',
          agentLogId: latestLog?.id ?? null,
          outcome: 'approved',
          durationMs: latestLog?.duration_ms ?? null,
          exitCode: latestLog?.exit_code ?? null,
        });
      }
      await approveWorkItemReview.mutateAsync(workItem.id);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleReject(rejectionReason?: string) {
    if (!workItem) return;
    setIsMutating(true);
    setActionError(null);
    try {
      await recordAttempt.mutateAsync({
        workItemId: workItem.id,
        agentId: workItem.assigned_agent ?? 'unknown',
        agentLogId: latestLog?.id ?? null,
        outcome: 'rejected',
        rejectionReason: rejectionReason || null,
        durationMs: latestLog?.duration_ms ?? null,
        exitCode: latestLog?.exit_code ?? null,
      });
      await rejectWorkItemReview.mutateAsync(workItem.id);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleClose() {
    if (!workItem) return;
    setIsMutating(true);
    setActionError(null);
    try {
      await closeWorkItemReview.mutateAsync(workItem.id);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleSendMessage() {
    if (!workItem) return;
    const message = chatMessage.trim();
    if (!message) {
      setChatError('Enter a follow-up message.');
      return;
    }

    if (!workItem.assigned_agent) {
      setChatError('Assign an agent first.');
      return;
    }

    if (!workItem.worktree_path) {
      setChatError('Create a worktree before continuing this work item.');
      return;
    }

    if (workItem.status === 'done' || workItem.status === 'archived') {
      setChatError('Closed work items cannot accept more agent turns.');
      return;
    }

    const nextSlot = slot ?? getNextAvailableSlot();
    if (nextSlot == null) {
      setChatError('All 8 terminal slots are in use. Finish or abort a running work item first.');
      return;
    }

    const previousStatus = workItem.status;
    setIsMutating(true);
    setChatError(null);
    setActionError(null);

    try {
      if (workItem.terminal_slot == null) {
        await updateWorkItem.mutateAsync({ id: workItem.id, fields: { terminal_slot: nextSlot } });
      }
      if (workItem.status !== 'running') {
        await transitionWorkItem.mutateAsync({ id: workItem.id, toStatus: 'running' });
      }
      await continueAgent.mutateAsync({
        workItemId: workItem.id,
        slot: nextSlot,
        message,
        permissionPolicy,
      });
      setChatMessage('');
      onActiveTabChange('agent');
    } catch (error) {
      if (workItem.terminal_slot == null) {
        releaseSlot(nextSlot);
        await updateWorkItem.mutateAsync({ id: workItem.id, fields: { terminal_slot: null } });
      }
      if (previousStatus !== 'running') {
        try {
          await transitionWorkItem.mutateAsync({ id: workItem.id, toStatus: previousStatus });
        } catch { /* best-effort rollback */ }
      }
      setChatError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleAgentChange(nextAgent: string) {
    if (!workItem) return;
    setAgentError(null);
    setIsUpdatingAgent(true);
    try {
      await updateWorkItem.mutateAsync({
        id: workItem.id,
        fields: { assigned_agent: nextAgent || null },
      });
    } catch (error) {
      setAgentError(String(error));
    } finally {
      setIsUpdatingAgent(false);
    }
  }

  async function handleDescriptionSave(nextContext: string) {
    if (!workItem) return;
    setActionError(null);
    setIsMutating(true);
    try {
      await updateWorkItem.mutateAsync({
        id: workItem.id,
        fields: { context: nextContext.trim() || null },
      });
    } catch (error) {
      setActionError(String(error));
      throw error;
    } finally {
      setIsMutating(false);
    }
  }

  if (isLoading || !workItem) {
    return (
      <div className="h-full flex items-center justify-center bg-bg">
        <Loader2 className="w-4 h-4 animate-spin text-text-dim" />
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-bg panel-tile"
      style={{
        borderLeft: `2px solid ${accent}`,
        boxShadow: `inset 1px 0 12px ${accent}08`,
      }}
    >
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-border bg-surface">
        <span
          className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-[10px] font-bold shrink-0 text-white/90"
          style={{ backgroundColor: accent }}
        >
          {tag.letter}
        </span>
        {/* Title — bold, high contrast */}
        <span className="text-[13px] text-text truncate flex-1 font-semibold">{workItem.title}</span>
        {/* Meta — dimmed */}
        {attemptCount > 0 && (
          <span className="text-[10px] font-mono text-amber-400/80 shrink-0 bg-amber-500/[0.08] px-1.5 py-0.5 rounded-md border border-amber-500/[0.12]">
            Attempt {attemptCount + 1}
          </span>
        )}
        {workItem.assigned_agent && (
          <span className="text-[10px] font-mono text-text-dim shrink-0 bg-white/[0.04] px-1.5 py-0.5 rounded-md border border-white/[0.05]">
            {workItem.assigned_agent}
          </span>
        )}
        {slot != null && (
          <span className="text-[10px] font-mono text-text-dim shrink-0 opacity-40">#{slot}</span>
        )}
        {/* Focus toggle */}
        <button
          onClick={onToggleFocus}
          title={isFocused ? 'Minimize' : 'Expand'}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-text hover:bg-white/[0.06] transition-all duration-150"
        >
          {isFocused ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
        </button>
        {hasOpenSession && (
          <button
            onClick={handleAbort}
            disabled={isMutating}
            title={sessionIsRunning ? 'Stop session and return work item to ready' : 'Close agent session'}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-state-danger hover:bg-state-danger/10 transition-all duration-150 disabled:opacity-40"
          >
            {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          </button>
        )}
      </div>

      {/* Activity bar — sparkline compressed view of tool usage */}
      {mergedItems.length > 0 && (
        <div className="shrink-0 px-3 py-1.5 bg-surface border-b border-border">
          <ActivityBar items={mergedItems} isRunning={sessionIsRunning} />
        </div>
      )}

      {actionError && (
        <div className="shrink-0 px-3 py-2 border-b border-state-danger/20 bg-state-danger/[0.08] text-[11px] text-red-300">
          {actionError}
        </div>
      )}

      {/* Tab bar + inline meta badges */}
      <div className="shrink-0 px-3 border-b border-border bg-surface flex items-center gap-0">
        {(
          [
            { id: 'agent',       label: 'Agent',       disabled: false },
            { id: 'changes',     label: 'Changes',     disabled: false },
            { id: 'description', label: 'Description', disabled: false },
          ] as const
        ).map(({ id, label, disabled }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => !disabled && onActiveTabChange(id)}
              disabled={disabled}
              className={`relative px-3 py-2 text-[12px] font-medium transition-colors duration-150
                ${active ? 'text-text' : 'text-text-dim hover:text-text-muted'}
                ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {label}
              {active && (
                <span
                  className="absolute inset-x-0 bottom-0 h-px rounded-full"
                  style={{ backgroundColor: accent }}
                />
              )}
            </button>
          );
        })}
        {/* Right-aligned inline badges */}
        <div className="ml-auto flex items-center gap-2">
          <StatusBadge status={workItem.status} />
          {hasOpenSession && (
            <span className="text-[10px] font-mono text-[#d4a087] bg-[#d4a087]/10 px-1.5 py-0.5 rounded-md border border-[#d4a087]/20">
              {sessionIsRunning ? 'session: active' : 'session: open'}
            </span>
          )}
          {workItem.repo_path && (
            <span className="text-[10px] font-mono text-text-dim bg-white/[0.04] px-1.5 py-0.5 rounded-md border border-white/[0.05] truncate max-w-[140px]" title={workItem.repo_path}>
              {workItem.repo_path.split(/[/\\]/).pop() ?? workItem.repo_path}
            </span>
          )}
        </div>
      </div>

      {activeTab === 'agent' ? (
        <>
          {/* Agent output */}
          <div className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[12px] leading-[1.6]">
            {mergedItems.length === 0 ? (
              <div className="text-text-dim italic mt-1 text-[12px]">
                {sessionIsRunning ? 'Waiting for agent response...' : 'No output recorded.'}
              </div>
            ) : (
              segments.map((seg) =>
                seg.kind === 'tools'
                  ? <ToolGroupRow key={seg.id} items={seg.items} />
                  : <TextSegmentRow key={seg.id} items={seg.items} />
              )
            )}
            {sessionIsRunning && mergedItems.length > 0 && (
              <span className="text-text-dim cursor-blink ml-0.5">|</span>
            )}
          </div>

          {/* Chat input */}
          <div className="shrink-0 px-3 pb-3">
            {chatError && (
              <div className="pb-2 text-[11px] text-red-400">{chatError}</div>
            )}
            {pendingPermission && (
              <div className="mb-2 rounded-xl border border-[#d4a087]/20 bg-[#d4a087]/8 px-3 py-3">
                <div className="text-[11px] font-medium text-[#f2c6b1]">Permission required</div>
                <div className="mt-1 text-[12px] text-text">
                  {pendingPermission.tool_title ?? pendingPermission.tool_kind ?? 'Tool request'}
                </div>
                {pendingPermission.tool_input && (
                  <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-black/20 px-2 py-2 text-[10px] text-text-dim whitespace-pre-wrap break-all">
                    {pendingPermission.tool_input}
                  </pre>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {pendingPermission.options.map((option) => (
                    <button
                      key={option.option_id}
                      type="button"
                      onClick={() => void handlePermissionDecision(option.option_id)}
                      className="rounded-lg border border-white/[0.08] bg-white/[0.05] px-2.5 py-1.5 text-[11px] text-text hover:bg-white/[0.08] transition-colors"
                    >
                      {option.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => void handlePermissionDecision(null)}
                    className="rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300 hover:bg-red-500/15 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {agentError && (
              <div className="pb-2 text-[11px] text-red-400">{agentError}</div>
            )}
              {/* Active references / slash command pills */}
              {(activeSlashCommand || referencedFiles.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5 pb-2">
                  {activeSlashCommand && (
                    <span className="rounded-full border border-[#d4a087]/25 bg-[#d4a087]/10 px-2.5 py-0.5 text-[10px] font-medium text-[#f2c6b1]">
                      /{activeSlashCommand}
                    </span>
                  )}
                  {visibleReferencedFiles.map((file) => (
                    <span
                      key={file}
                      className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-0.5 text-[10px] font-mono text-sky-200"
                      title={file}
                    >
                      @{file}
                    </span>
                  ))}
                  {hiddenReferenceCount > 0 && (
                    <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-0.5 text-[10px] text-text-dim">
                      +{hiddenReferenceCount} more
                    </span>
                  )}
                </div>
              )}

              {/* Input container — matches FloatingCommandBar style */}
              <div className="bg-surface border border-border rounded-2xl">
                <AtReferenceTextarea
                  value={chatMessage}
                  onChange={(nextValue) => {
                    setChatMessage(nextValue);
                    setChatError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                  repoPath={workItem.worktree_path ?? workItem.repo_path ?? ''}
                  slashCommands={slashCommands}
                  placeholder={
                    pendingPermission
                      ? 'Resolve the permission request to continue...'
                      : sessionIsRunning
                        ? 'Reply...'
                        : canChat
                          ? 'Reply...'
                          : 'Assign an agent and create a worktree to continue...'
                  }
                  disabled={composerDisabled}
                  rows={2}
                  autosize
                  maxRows={6}
                  className="min-h-[60px] w-full resize-none border-0 bg-transparent px-5 pt-4 pb-0 text-[15px] text-text
                    placeholder:text-text-dim/30 focus:border-transparent focus:outline-none focus:ring-0
                    disabled:opacity-40 transition-colors leading-normal shadow-none"
                />

                {/* Bottom row — 3 elements: +, agent selector, send */}
                <div className="flex items-center px-4 pb-3 pt-1">
                  <button
                    className="text-text-dim/40 hover:text-text-dim transition-colors"
                    title="Attach context (@files, /commands)"
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  <div className="flex-1" />

                  <div className="flex items-center gap-1">
                    <PermissionPolicyDropdown
                      currentPolicy={permissionPolicy}
                      onPolicyChange={handlePermissionPolicyChange}
                      disabled={isMutating}
                    />
                    <AgentSelectorDropdown
                      currentAgent={workItem.assigned_agent ?? ''}
                      onAgentChange={handleAgentChange}
                      disabled={isUpdatingAgent}
                    />
                  </div>

                  {showStopTurnButton ? (
                    <button
                      onClick={() => void handleStopTurn()}
                      disabled={isMutating}
                      className="ml-3 w-8 h-8 flex items-center justify-center rounded-full
                        border border-red-500/30 bg-red-500/15 text-red-300
                        hover:bg-red-500/25 hover:text-red-200
                        disabled:cursor-not-allowed disabled:opacity-30 transition-all"
                      title="Cancel current turn"
                    >
                      {isMutating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Square className="h-3.5 w-3.5 fill-current" />
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={() => void handleSendMessage()}
                      disabled={!canSendMessage}
                      className="ml-3 w-8 h-8 flex items-center justify-center rounded-full
                        bg-accent text-white
                        hover:bg-accent/80 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
                    >
                      {isMutating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowUp className="h-4 w-4 stroke-[2.5]" />
                      )}
                    </button>
                  )}
                </div>
              </div>
          </div>
        </>
      ) : activeTab === 'changes' ? (
        <ReviewPanel
          workItem={workItem}
          review={review.review}
          reviewLoading={review.reviewLoading}
          reviewError={review.reviewError}
          latestLog={latestLog}
          onApprove={handleApprove}
          onReject={workItem.parent_id ? handleReject : undefined}
          onClose={workItem.parent_id ? undefined : handleClose}
          isMutating={isMutating}
          actionError={actionError}
        />
      ) : (
        <DescriptionTab
          workItem={workItem}
          onSaveDescription={handleDescriptionSave}
          isSaving={isMutating}
        />
      )}
    </div>
  );
}

// ---- Agent selector dropdown (orchestrator-style) ----

function AgentSelectorDropdown({
  currentAgent,
  onAgentChange,
  disabled,
}: {
  currentAgent: string;
  onAgentChange: (agent: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeOption = AGENT_OPTIONS.find((a) => a.value === currentAgent);

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="max-w-[180px] truncate text-[12px] font-medium text-text">
          {activeOption?.label ?? 'Select agent...'}
        </span>
        <ChevronDown className="w-3 h-3 text-text-dim" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-1 w-48 bg-surface border border-border rounded-lg shadow-xl shadow-black/40 py-1 z-20">
            {AGENT_OPTIONS.map((opt) => {
              const isActive = opt.value === currentAgent;
              const color = AGENT_COLORS[opt.value] ?? '#64748B';
              return (
                <button
                  key={opt.value}
                  onClick={() => {
                    onAgentChange(opt.value);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-[12px] transition-colors flex items-center gap-2
                    ${isActive
                      ? 'text-text bg-white/[0.04]'
                      : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
                    }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: isActive ? color : `${color}60` }}
                  />
                  <span className="truncate font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const PERMISSION_POLICY_OPTIONS: Array<{ value: AgentPermissionPolicy; label: string }> = [
  { value: 'ask', label: 'Permissions: Ask' },
  { value: 'allow_once', label: 'Permissions: Allow Once' },
  { value: 'allow_always', label: 'Permissions: Allow Always' },
  { value: 'reject_once', label: 'Permissions: Reject Once' },
  { value: 'reject_always', label: 'Permissions: Reject Always' },
];

function PermissionPolicyDropdown({
  currentPolicy,
  onPolicyChange,
  disabled,
}: {
  currentPolicy: AgentPermissionPolicy;
  onPolicyChange: (policy: AgentPermissionPolicy) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeOption = PERMISSION_POLICY_OPTIONS.find((option) => option.value === currentPolicy);

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpen((value) => !value)}
        disabled={disabled}
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="max-w-[170px] truncate text-[12px] font-medium text-text">
          {activeOption?.label ?? 'Permissions'}
        </span>
        <ChevronDown className="w-3 h-3 text-text-dim" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-1 w-52 bg-surface border border-border rounded-lg shadow-xl shadow-black/40 py-1 z-20">
            {PERMISSION_POLICY_OPTIONS.map((option) => {
              const isActive = option.value === currentPolicy;
              return (
                <button
                  key={option.value}
                  onClick={() => {
                    onPolicyChange(option.value);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-[12px] transition-colors
                    ${isActive
                      ? 'text-text bg-white/[0.04]'
                      : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
                    }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#D97706',
  'gemini-cli': '#60a5fa',
  'codex-cli': '#10B981',
};

// ---- Description tab ----

function DescriptionTab({
  workItem,
  onSaveDescription,
  isSaving,
}: {
  workItem: WorkItem;
  onSaveDescription: (nextContext: string) => Promise<void>;
  isSaving: boolean;
}) {
  const canEdit = !workItem.started_at && (workItem.status === 'draft' || workItem.status === 'ready');
  const repoPath = workItem.worktree_path ?? workItem.repo_path ?? '';
  const [isEditing, setIsEditing] = useState(false);
  const [draftContext, setDraftContext] = useState(workItem.context ?? '');

  useEffect(() => {
    setDraftContext(workItem.context ?? '');
    if (!canEdit) {
      setIsEditing(false);
    }
  }, [canEdit, workItem.context, workItem.id]);

  const hasChanges = draftContext !== (workItem.context ?? '');

  async function handleSave() {
    if (!hasChanges || isSaving) return;
    await onSaveDescription(draftContext);
    setIsEditing(false);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
      {/* Dates */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-text-dim">
        <TimestampInline label="Created" date={workItem.created_at} />
        <TimestampInline label="Updated" date={workItem.updated_at} />
        {workItem.started_at && <TimestampInline label="Started" date={workItem.started_at} />}
        {workItem.completed_at && <TimestampInline label="Completed" date={workItem.completed_at} />}
      </div>

      {canEdit && isEditing ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-text-dim">
              Edit the description before the first run.
            </div>
            {hasChanges && (
              <div className="text-[11px] text-amber-300/90">
                Unsaved changes
              </div>
            )}
          </div>
          <WorkItemDescriptionEditor
            value={draftContext}
            onChange={setDraftContext}
            repoPath={repoPath}
            rows={12}
            autosize
            maxRows={28}
            placeholder={
              repoPath
                ? 'Describe what should be done. Use @path/to/file.tsx to include files.'
                : 'Describe what should be done.'
            }
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void handleSave();
              }
            }}
            helperText={
              repoPath
                ? 'Type @ to search files from the selected repository. Press Ctrl/Cmd+Enter to save.'
                : 'Add a repository to this work item to enable @file references.'
            }
            editorClassName="min-h-[320px]"
          />
          <div className="flex items-center gap-3">
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftContext(workItem.context ?? '');
                  setIsEditing(false);
                }}
                disabled={isSaving}
                className="px-2.5 py-1 rounded-md border border-border bg-bg text-[11px] text-text-dim hover:text-text hover:bg-white/[0.04] disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving || !hasChanges}
                className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] text-text-dim hover:text-text hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Saving
                  </span>
                ) : (
                  'Save'
                )}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {canEdit && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-text-dim">
                View the description here. Click edit to update it before the first run.
              </div>
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] text-text-dim hover:text-text hover:bg-surface-raised transition-colors"
              >
                Edit Description
              </button>
            </div>
          )}
          {workItem.context ? (
            <div className="text-[13px] leading-[1.7] text-text-muted">
              <MarkdownText content={workItem.context} />
            </div>
          ) : (
            <p className="text-[12px] text-text-dim italic">No description provided.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TimestampInline({ label, date }: { label: string; date: string }) {
  return (
    <span>
      <span className="text-text-dim/60">{label}: </span>
      <span className="text-text-dim">{new Date(date).toLocaleString()}</span>
    </span>
  );
}


// ---- Segment grouping ----

type TextSegment = { kind: 'text'; id: string; items: AcpEventItem[] };
type ToolSegment = { kind: 'tools'; id: string; items: AcpEventItem[] };
type Segment = TextSegment | ToolSegment;

function groupIntoSegments(items: AcpEventItem[]): Segment[] {
  const segments: Segment[] = [];
  let toolBuf: AcpEventItem[] = [];
  let textBuf: AcpEventItem[] = [];

  function flushText() {
    if (textBuf.length > 0) {
      segments.push({ kind: 'text', id: textBuf[0].id, items: textBuf });
      textBuf = [];
    }
  }
  function flushTools() {
    if (toolBuf.length > 0) {
      segments.push({ kind: 'tools', id: toolBuf[0].id, items: toolBuf });
      toolBuf = [];
    }
  }

  for (const item of items) {
    if (item.kind === 'tool_call' || item.kind === 'tool_result') {
      flushText();
      toolBuf.push(item);
    } else {
      flushTools();
      textBuf.push(item);
    }
  }
  flushTools();
  flushText();
  return segments;
}

function pairToolItems(items: AcpEventItem[]): Array<{ call: AcpEventItem; result?: AcpEventItem }> {
  const pairs: Array<{ call: AcpEventItem; result?: AcpEventItem }> = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].kind === 'tool_call') {
      const result = items[i + 1]?.kind === 'tool_result' ? items[i + 1] : undefined;
      pairs.push({ call: items[i], result });
      i += result ? 2 : 1;
    } else {
      i++;
    }
  }
  return pairs;
}

// ---- Text segment renderer ----

function TextSegmentRow({ items }: { items: AcpEventItem[] }) {
  const prose = items
    .filter((i) => i.kind === 'text' || i.kind === 'text_delta')
    .map((i) => i.content ?? '')
    .join('');

  const specials = items.filter((i) => i.kind === 'error' || i.kind === 'done');

  return (
    <>
      {prose && <MarkdownText content={prose} />}
      {specials.map((item) => {
        if (item.kind === 'error') {
          return (
            <div key={item.id} className="mt-1.5 text-[12px] text-state-danger flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-state-danger shrink-0" />
              <span>{item.content}</span>
            </div>
          );
        }
        if (item.kind === 'done') {
          return (
            <div key={item.id} className="mt-2 text-[11px] text-state-success flex items-center gap-1.5 bg-state-success/[0.08] border border-state-success/20 px-2 py-1 rounded-md w-fit">
              <span className="w-1.5 h-1.5 rounded-full bg-state-success shrink-0" />
              <span>Run complete</span>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

function MarkdownText({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="mb-2 last:mb-0 text-text-muted leading-relaxed">{children}</p>
        ),
        pre: ({ children }) => (
          <pre className="my-2 bg-surface border border-border rounded-lg overflow-x-auto p-3 text-[11px] leading-relaxed">
            {children}
          </pre>
        ),
        code: ({ children, className }) => {
          const isBlock = Boolean(className);
          return isBlock ? (
            <code className="text-emerald-300 font-mono">{children}</code>
          ) : (
            <code className="bg-white/[0.07] border border-white/[0.08] px-1 py-0.5 rounded text-[11px] text-emerald-300 font-mono">
              {children}
            </code>
          );
        },
        strong: ({ children }) => (
          <strong className="font-semibold text-text">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="text-text-muted">{children}</em>
        ),
        h1: ({ children }) => (
          <h1 className="text-[14px] font-semibold text-text mt-3 mb-1 border-b border-border pb-1">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-[13px] font-semibold text-text mt-2.5 mb-1">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-[12px] font-semibold text-text-muted mt-2 mb-0.5">{children}</h3>
        ),
        ul: ({ children }) => (
          <ul className="mb-2 ml-3 space-y-0.5 list-disc list-outside text-text-muted">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-2 ml-3 space-y-0.5 list-decimal list-outside text-text-muted">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="text-[12px] leading-relaxed pl-0.5">{children}</li>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-1 pl-3 border-l-2 border-border-bright text-text-muted italic">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-2 border-border" />,
        a: ({ children, href }) => (
          <a href={href} className="text-accent underline underline-offset-2 hover:text-emerald-400 transition-colors">
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="px-2 py-1 text-left font-semibold text-text-muted border-b border-border-bright">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-2 py-1 text-text-muted border-b border-border">{children}</td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ---- Grouped tool calls (compressed) ----

function ToolGroupRow({ items }: { items: AcpEventItem[] }) {
  const [open, setOpen] = useState(false);
  const pairs = pairToolItems(items);
  const names = pairs.map((p) => p.call.tool_name ?? 'tool');

  // Collapsed: compact pill row with color-coded dots
  if (!open) {
    return (
      <div className="my-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 group"
        >
          <ChevronRight className="w-3 h-3 text-text-dim group-hover:text-text-muted transition-colors shrink-0" />
          <span className="inline-flex items-center gap-0.5 flex-wrap">
            {names.map((name, i) => (
              <span
                key={i}
                className="w-2 h-2 rounded-sm shrink-0"
                style={{ backgroundColor: getToolColor(name), opacity: 0.6 }}
                title={name}
              />
            ))}
          </span>
          <span className="text-[10px] text-text-dim ml-1">
            {pairs.length === 1 ? `1 call: ${names[0]}` : `${pairs.length} calls`}
          </span>
        </button>
      </div>
    );
  }

  // Expanded
  return (
    <div className="my-1 border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-surface hover:bg-surface-raised transition-colors text-left"
      >
        <ChevronRight className="w-3 h-3 text-text-dim rotate-90 transition-transform shrink-0" />
        <span className="text-[10px] text-text-muted">
          {pairs.length === 1 ? '1 tool call' : `${pairs.length} tool calls`}
        </span>
      </button>

      <div className="divide-y divide-border">
        {pairs.map(({ call, result }, i) => (
          <div key={i} className="px-2 py-2 bg-bg">
            <div className="flex items-start gap-1.5">
              <span
                className="w-2 h-2 rounded-sm mt-0.5 shrink-0"
                style={{ backgroundColor: getToolColor(call.tool_name ?? '') }}
              />
              <div className="min-w-0">
                <span className="text-[11px] font-medium" style={{ color: getToolColor(call.tool_name ?? '') }}>
                  {call.tool_name ?? 'tool'}
                </span>
                {call.tool_input && (
                  <pre className="mt-0.5 text-[10px] text-text-dim whitespace-pre-wrap break-all leading-relaxed">
                    {call.tool_input}
                  </pre>
                )}
              </div>
            </div>
            {result?.content && (
              <div className="mt-1 ml-4 pl-2 border-l border-border text-[10px] text-text-dim whitespace-pre-wrap break-all leading-relaxed">
                {result.content}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function tryParse<T>(str: string, fallback: T): T {
  try { return JSON.parse(str); }
  catch { return fallback; }
}
