import { useState } from 'react';
import { Loader2, X, Check, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AcpEventItem, Ticket } from '@mozzie/db';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTicketStore } from '../../stores/ticketStore';
import { useTicket } from '../../hooks/useTickets';
import { useUpdateTicket, useTransitionTicket } from '../../hooks/useTicketMutation';
import { useAcpRun } from '../../hooks/useAcpRun';
import { useAgentLogs, useContinueAgent } from '../../hooks/useAgents';
import { useReview } from '../../hooks/useReview';
import { useMergeBranch, useRemoveWorktree } from '../../hooks/useWorktree';
import { AGENT_OPTIONS } from '../../lib/agentOptions';
import { getTicketColor } from '../../lib/ticketColors';
import { StatusBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { DiffViewer } from '../review/DiffViewer';

function getColCount(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

export function TerminalGrid() {
  const activeSlots = useTerminalStore((s) => s.activeSlots);
  const selectedTicketIds = useTicketStore((s) => s.selectedTicketIds);
  const [focusedTicketId, setFocusedTicketId] = useState<string | null>(null);

  const activeEntries = Array.from(activeSlots.entries());
  const selectedEntries = selectedTicketIds.map((ticketId, index) => ({
    ticketId,
    colorIndex: index,
    slot: activeEntries.find(([, activeTicketId]) => activeTicketId === ticketId)?.[0],
  }));
  const fallbackEntries = activeEntries
    .filter(([, ticketId]) => !selectedTicketIds.includes(ticketId))
    .map(([slot, ticketId], index) => ({
      slot,
      ticketId,
      colorIndex: selectedEntries.length + index,
    }));
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
            Select a ticket to inspect its run, or press the play button on a ready ticket
          </p>
        </div>
      </div>
    );
  }

  // If a panel is focused, show it large + others as tiles
  const isFocused = focusedTicketId && panelEntries.some((e) => e.ticketId === focusedTicketId);

  if (isFocused && count > 1) {
    const focused = panelEntries.find((e) => e.ticketId === focusedTicketId)!;
    const background = panelEntries.filter((e) => e.ticketId !== focusedTicketId);

    return (
      <div className="h-full flex overflow-hidden">
        {/* Focused panel — takes ~60% */}
        <div className="flex-1 min-w-0 panel-tile panel-tile-focused">
          <TicketInteractionPanel
            key={`${focused.ticketId}:${focused.slot ?? 'selected'}`}
            ticketId={focused.ticketId}
            slot={focused.slot}
            colorIndex={focused.colorIndex}
            isFocused={true}
            onToggleFocus={() => setFocusedTicketId(null)}
          />
        </div>

        {/* Background tiles sidebar */}
        <div className="w-56 shrink-0 border-l border-border overflow-y-auto bg-bg">
          {background.map(({ ticketId, slot, colorIndex }) => (
            <BackgroundTile
              key={`${ticketId}:${slot ?? 'bg'}`}
              ticketId={ticketId}
              slot={slot}
              colorIndex={colorIndex}
              onClick={() => setFocusedTicketId(ticketId)}
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
      {panelEntries.map(({ ticketId, slot, colorIndex }) => (
        <TicketInteractionPanel
          key={`${ticketId}:${slot ?? 'selected'}`}
          ticketId={ticketId}
          slot={slot}
          colorIndex={colorIndex}
          isFocused={false}
          onToggleFocus={() => setFocusedTicketId(count > 1 ? ticketId : null)}
        />
      ))}
    </div>
  );
}

// ---- Background status tile (collapsed view) ----

function BackgroundTile({
  ticketId,
  slot,
  colorIndex,
  onClick,
}: {
  ticketId: string;
  slot?: number;
  colorIndex: number;
  onClick: () => void;
}) {
  const { data: ticket } = useTicket(ticketId);
  const liveItems = useAcpRun(ticketId);
  const accent = getTicketColor(colorIndex);

  const toolCount = liveItems.filter((i) => i.kind === 'tool_call').length;
  const textCount = liveItems.filter((i) => i.kind === 'text' || i.kind === 'text_delta').length;
  const isRunning = ticket?.status === 'running';

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 border-b border-border hover:bg-surface transition-colors"
    >
      {/* Color accent line */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: accent }} />
        <span className="text-[12px] font-medium text-text truncate flex-1">
          {ticket?.title ?? 'Loading...'}
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
  Read: '#3B82F6',
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

// ---- Main interaction panel ----

interface TicketInteractionPanelProps {
  ticketId: string;
  slot?: number;
  colorIndex: number;
  isFocused: boolean;
  onToggleFocus: () => void;
}

function TicketInteractionPanel({ ticketId, slot, colorIndex, isFocused, onToggleFocus }: TicketInteractionPanelProps) {
  const releaseSlot = useTerminalStore((s) => s.releaseSlot);
  const getNextAvailableSlot = useTerminalStore((s) => s.getNextAvailableSlot);
  const transitionTicket = useTransitionTicket();
  const updateTicket = useUpdateTicket();
  const mergeBranch = useMergeBranch();
  const removeWorktree = useRemoveWorktree();
  const continueAgent = useContinueAgent();
  const { data: ticket, isLoading } = useTicket(ticketId);
  const [isMutating, setIsMutating] = useState(false);
  const [activeTab, setActiveTab] = useState<'ticket' | 'agent' | 'review'>('agent');
  const [chatMessage, setChatMessage] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isUpdatingAgent, setIsUpdatingAgent] = useState(false);
  const liveItems = useAcpRun(ticketId);
  const { data: logs } = useAgentLogs(ticketId);
  const latestLog = logs?.[0] ?? null;

  const persistedItems: AcpEventItem[] = latestLog?.messages
    ? tryParse<AcpEventItem[]>(latestLog.messages, [])
    : [];
  const seenIds = new Set(liveItems.map((i) => i.id));
  const mergedItems = [
    ...persistedItems.filter((i) => !seenIds.has(i.id)),
    ...liveItems,
  ];

  const hasRecoverableWorktree = !!(
    ticket &&
    ticket.status === 'ready' &&
    ticket.repo_path &&
    ticket.worktree_path &&
    ticket.branch_name
  );
  const review = useReview(ticket, ticket?.status === 'review' || hasRecoverableWorktree);
  const accent = getTicketColor(colorIndex);
  const canShowReview = ticket?.status === 'review' || hasRecoverableWorktree;
  const canContinueConversation = !!(
    ticket &&
    ticket.assigned_agent &&
    ticket.worktree_path &&
    ticket.status !== 'done' &&
    ticket.status !== 'archived' &&
    ticket.status !== 'running'
  );

  async function handleAbort() {
    if (!ticket || slot == null) return;
    setIsMutating(true);
    setActionError(null);
    try {
      try { await invoke('kill_process', { slot }); } catch { /* no-op */ }
      releaseSlot(slot);
      await updateTicket.mutateAsync({ id: ticketId, fields: { terminal_slot: null } });
      await transitionTicket.mutateAsync({ id: ticketId, toStatus: 'ready' });
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleResumeReview() {
    if (!ticket) return;
    setIsMutating(true);
    setActionError(null);
    try {
      setActiveTab('review');
      await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'review' });
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleApprove() {
    if (!ticket?.repo_path || !ticket.worktree_path || !ticket.source_branch || !ticket.branch_name) return;
    setIsMutating(true);
    setActionError(null);
    try {
      await mergeBranch.mutateAsync({
        repoPath: ticket.repo_path,
        worktreePath: ticket.worktree_path,
        sourceBranch: ticket.source_branch,
        branchName: ticket.branch_name,
      });
      await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'done' });
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleClose() {
    if (!ticket) return;
    setIsMutating(true);
    setActionError(null);
    try {
      if (ticket.worktree_path && ticket.repo_path && ticket.branch_name) {
        await removeWorktree.mutateAsync({
          worktreePath: ticket.worktree_path,
          repoPath: ticket.repo_path,
          branchName: ticket.branch_name,
        });
      }
      await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'done' });
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleReject() {
    if (!ticket) return;
    setIsMutating(true);
    setActionError(null);
    try {
      if (ticket.worktree_path && ticket.repo_path && ticket.branch_name) {
        await removeWorktree.mutateAsync({
          worktreePath: ticket.worktree_path,
          repoPath: ticket.repo_path,
          branchName: ticket.branch_name,
        });
      }
      await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'ready' });
    } catch (error) {
      setActionError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleSendMessage() {
    if (!ticket || !canContinueConversation) return;
    const message = chatMessage.trim();
    if (!message) { setChatError('Enter a follow-up message.'); return; }

    const nextSlot = slot ?? getNextAvailableSlot();
    if (nextSlot == null) {
      setChatError('All 8 terminal slots are in use. Finish or abort a running ticket first.');
      return;
    }

    const previousStatus = ticket.status;
    setIsMutating(true);
    setChatError(null);
    setActionError(null);

    try {
      await updateTicket.mutateAsync({ id: ticket.id, fields: { terminal_slot: nextSlot } });
      await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'running' });
      await continueAgent.mutateAsync({ ticketId: ticket.id, slot: nextSlot, message });
      setChatMessage('');
      setActiveTab('agent');
    } catch (error) {
      releaseSlot(nextSlot);
      await updateTicket.mutateAsync({ id: ticket.id, fields: { terminal_slot: null } });
      if (previousStatus !== 'running') {
        try {
          await transitionTicket.mutateAsync({ id: ticket.id, toStatus: previousStatus });
        } catch { /* best-effort rollback */ }
      }
      setChatError(String(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleAgentChange(nextAgent: string) {
    if (!ticket || ticket.status === 'running') return;
    setAgentError(null);
    setIsUpdatingAgent(true);
    try {
      await updateTicket.mutateAsync({
        id: ticket.id,
        fields: { assigned_agent: nextAgent || null },
      });
    } catch (error) {
      setAgentError(String(error));
    } finally {
      setIsUpdatingAgent(false);
    }
  }

  if (isLoading || !ticket) {
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
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: accent }}
        />
        <StatusBadge status={ticket.status} />
        {/* Title — bold, high contrast */}
        <span className="text-[13px] text-text truncate flex-1 font-semibold">{ticket.title}</span>
        {/* Meta — dimmed */}
        {ticket.assigned_agent && (
          <span className="text-[10px] font-mono text-text-dim shrink-0 bg-white/[0.04] px-1.5 py-0.5 rounded-md border border-white/[0.05]">
            {ticket.assigned_agent}
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
        {ticket.status === 'running' && slot != null && (
          <button
            onClick={handleAbort}
            disabled={isMutating}
            title="Abort and return to ready"
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-state-danger hover:bg-state-danger/10 transition-all duration-150 disabled:opacity-40"
          >
            {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          </button>
        )}
      </div>

      {/* Activity bar — sparkline compressed view of tool usage */}
      {mergedItems.length > 0 && (
        <div className="shrink-0 px-3 py-1.5 bg-surface border-b border-border">
          <ActivityBar items={mergedItems} isRunning={ticket.status === 'running'} />
        </div>
      )}

      {actionError && (
        <div className="shrink-0 px-3 py-2 border-b border-state-danger/20 bg-state-danger/[0.08] text-[11px] text-red-300">
          {actionError}
        </div>
      )}

      {/* Tab bar */}
      <div className="shrink-0 px-3 border-b border-border bg-surface flex gap-0">
        {(
          [
            { id: 'ticket', label: 'Ticket', disabled: false },
            { id: 'agent',  label: 'Agent',  disabled: false },
            { id: 'review', label: 'Review', disabled: !canShowReview },
          ] as const
        ).map(({ id, label, disabled }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => !disabled && setActiveTab(id)}
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
      </div>

      {activeTab === 'ticket' ? (
        <TicketInfoTab
          ticket={ticket}
          onAgentChange={handleAgentChange}
          agentError={agentError}
          isUpdatingAgent={isUpdatingAgent}
        />
      ) : activeTab === 'agent' ? (
        <>
          {/* Agent output */}
          <div className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[12px] leading-[1.6]">
            {mergedItems.length === 0 ? (
              <div className="text-text-dim italic mt-1 text-[12px]">
                {ticket.status === 'running' ? 'Waiting for agent response...' : 'No output recorded.'}
              </div>
            ) : (
              groupIntoSegments(mergedItems).map((seg) =>
                seg.kind === 'tools'
                  ? <ToolGroupRow key={seg.id} items={seg.items} />
                  : <TextSegmentRow key={seg.id} items={seg.items} />
              )
            )}
            {ticket.status === 'running' && mergedItems.length > 0 && (
              <span className="text-text-dim cursor-blink ml-0.5">|</span>
            )}
          </div>

          {/* Chat input */}
          <div className="shrink-0 border-t border-border bg-surface p-3">
            {chatError && (
              <div className="mb-2 text-[11px] text-red-400">{chatError}</div>
            )}
            <textarea
              value={chatMessage}
              onChange={(e) => { setChatMessage(e.target.value); setChatError(null); }}
              placeholder={
                canContinueConversation
                  ? 'Ask the agent to refine, fix, or continue...'
                  : ticket.status === 'running'
                    ? 'Wait for the current run to finish...'
                    : 'This ticket cannot accept follow-up messages.'
              }
              disabled={!canContinueConversation || isMutating}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text
                placeholder:text-text-dim focus:outline-none focus:border-accent/50
                disabled:opacity-40 transition-colors duration-150 leading-relaxed"
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={handleSendMessage} disabled={!canContinueConversation || isMutating}>
                {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Send'}
              </Button>
            </div>
          </div>
        </>
      ) : (
        canShowReview && (
          <>
            {/* Review header */}
            <div className="shrink-0 border-b border-border px-3 py-2 bg-surface">
              {hasRecoverableWorktree && ticket.status === 'ready' && (
                <p className="mb-1.5 text-[11px] text-state-waiting">
                  This ticket has unreviewed work in its existing worktree.
                </p>
              )}
              {latestLog?.cleanup_warning_message && (
                <p className="mb-1.5 text-[11px] text-state-waiting">{latestLog.cleanup_warning_message}</p>
              )}
              {ticket.source_branch && ticket.branch_name && (
                <div className="text-[11px] text-text-muted font-mono">
                  <span className="text-text-dim">diff: </span>
                  <span>{ticket.source_branch}</span>
                  <span className="text-text-dim"> &larr; </span>
                  <span>{ticket.branch_name}</span>
                </div>
              )}
            </div>

            {/* Diff viewer */}
            <div className="flex-1 min-h-0 overflow-auto bg-bg">
              {review.diffLoading ? (
                <div className="h-full flex items-center justify-center gap-2 text-text-muted text-[13px]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading diff...
                </div>
              ) : review.diffError ? (
                <div className="p-3 text-[13px] text-red-400">{review.diffError}</div>
              ) : (
                <DiffViewer diff={review.diff ?? ''} />
              )}
            </div>

            {/* Review actions */}
            <div className="shrink-0 border-t border-border px-3 py-3 flex gap-2 bg-surface">
              {ticket.status === 'ready' ? (
                <Button variant="outline" size="sm" onClick={handleResumeReview} disabled={isMutating} className="flex-1">
                  {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Resume Review'}
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={handleApprove} disabled={isMutating} className="flex-1">
                    {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Check className="w-3 h-3" />Approve</>}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleReject} disabled={isMutating} className="flex-1">
                    {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Reject'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleClose} disabled={isMutating} className="flex-1">
                    {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Close'}
                  </Button>
                </>
              )}
            </div>
          </>
        )
      )}
    </div>
  );
}

// ---- Ticket info tab ----

function TicketInfoTab({
  ticket,
  onAgentChange,
  agentError,
  isUpdatingAgent,
}: {
  ticket: Ticket;
  onAgentChange: (agent: string) => void;
  agentError: string | null;
  isUpdatingAgent: boolean;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-[12px]">

      {/* Title + status */}
      <div>
        {/* 30% Primary: bold title */}
        <p className="text-[15px] font-semibold text-text leading-snug">{ticket.title || <span className="italic text-text-dim">Untitled</span>}</p>
        <div className="mt-1.5">
          <StatusBadge status={ticket.status} />
        </div>
      </div>

      {/* Context / description */}
      {ticket.context ? (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-text-dim mb-1.5">Description</p>
          <div className="font-mono text-[12px] leading-[1.6]">
            <MarkdownText content={ticket.context} />
          </div>
        </div>
      ) : (
        <p className="italic text-text-dim">No description.</p>
      )}

      {/* Meta fields — 60% Neutral: smaller, dimmer */}
      <div className="space-y-2 pt-2 border-t border-border">
        <div className="space-y-1">
          <span className="text-text-dim shrink-0 block">Agent</span>
          <Select
            value={ticket.assigned_agent ?? ''}
            options={AGENT_OPTIONS.map((option) => ({ ...option }))}
            onChange={(event) => onAgentChange(event.target.value)}
            disabled={ticket.status === 'running' || isUpdatingAgent}
          />
          {agentError && (
            <div className="text-[11px] text-red-400">{agentError}</div>
          )}
        </div>
        {ticket.repo_path && (
          <Row label="Repo" value={ticket.repo_path} mono truncate />
        )}
        {ticket.source_branch && (
          <Row label="Base branch" value={ticket.source_branch} mono />
        )}
        {ticket.branch_name && (
          <Row label="Worktree branch" value={ticket.branch_name} mono />
        )}
        {ticket.worktree_path && (
          <Row label="Worktree path" value={ticket.worktree_path} mono truncate />
        )}
        {ticket.terminal_slot != null && (
          <Row label="Slot" value={String(ticket.terminal_slot)} mono />
        )}
      </div>

      {/* Timestamps — smallest, most dimmed */}
      <div className="space-y-1.5 pt-2 border-t border-border text-[11px]">
        <Row label="Created" value={new Date(ticket.created_at).toLocaleString()} />
        <Row label="Updated" value={new Date(ticket.updated_at).toLocaleString()} />
        {ticket.started_at && (
          <Row label="Started" value={new Date(ticket.started_at).toLocaleString()} />
        )}
        {ticket.completed_at && (
          <Row label="Completed" value={new Date(ticket.completed_at).toLocaleString()} />
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-dim shrink-0 w-28 text-[11px]">{label}</span>
      <span
        className={`text-[11px] ${mono ? 'font-mono' : ''} text-text-muted ${truncate ? 'truncate' : ''}`}
        title={truncate ? value : undefined}
      >
        {value}
      </span>
    </div>
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
          <a href={href} className="text-accent underline underline-offset-2 hover:text-blue-400 transition-colors">
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
