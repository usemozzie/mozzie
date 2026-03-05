import { useState, useEffect } from 'react';
import { ChevronLeft, Loader2, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Ticket, TicketStatus } from '@mozzie/db';
import { useTicket } from '../../hooks/useTickets';
import { useUpdateTicket, useTransitionTicket } from '../../hooks/useTicketMutation';
import { useCreateWorktree, useRemoveWorktree, useMergeBranch, useRepoBranch, useRepoBranches } from '../../hooks/useWorktree';
import { useLaunchAgent } from '../../hooks/useAgents';
import { AGENT_OPTIONS } from '../../lib/agentOptions';
import { saveRecentRepo } from '../../lib/recentRepos';
import { useTicketStore } from '../../stores/ticketStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { StatusBadge } from '../ui/badge';
import { ReviewPanel } from '../review/ReviewPanel';
import { AtReferenceTextarea } from './AtReferenceTextarea';

interface TransitionButtonConfig {
  label: string;
  toStatus: TicketStatus;
  variant?: 'default' | 'outline' | 'destructive';
}

function getTransitions(status: TicketStatus): TransitionButtonConfig[] {
  switch (status) {
    case 'draft':
      return [{ label: 'Mark Ready', toStatus: 'ready' }];
    case 'ready':
      return [
        { label: 'Queue', toStatus: 'queued' },
        { label: 'Back to Draft', toStatus: 'draft', variant: 'outline' },
      ];
    case 'queued':
      return [
        { label: 'Run Now', toStatus: 'running' },
        { label: 'Unassign', toStatus: 'ready', variant: 'outline' },
      ];
    case 'running':
      return [{ label: 'Abort', toStatus: 'ready', variant: 'destructive' }];
    case 'review':
      // ReviewPanel renders its own Approve / Reject buttons
      return [];
    case 'done':
      return [{ label: 'Archive', toStatus: 'archived', variant: 'outline' }];
    case 'archived':
      return [];
  }
}

export function TicketDetail() {
  const { activeTicketId, backToList } = useTicketStore();
  const { data: ticket } = useTicket(activeTicketId);
  const updateTicket = useUpdateTicket();
  const transitionTicket = useTransitionTicket();
  const createWorktree = useCreateWorktree();
  const removeWorktree = useRemoveWorktree();
  const mergeBranch = useMergeBranch();
  const launchAgent = useLaunchAgent();
  const getNextAvailableSlot = useTerminalStore((s) => s.getNextAvailableSlot);
  const releaseSlot = useTerminalStore((s) => s.releaseSlot);

  const [form, setForm] = useState<Partial<Ticket>>({});
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const repoBranch = useRepoBranch(form.repo_path ?? '');
  const repoBranches = useRepoBranches(form.repo_path ?? '');

  // Sync form when ticket loads
  useEffect(() => {
    if (ticket) {
      setForm({
        title: ticket.title,
        context: ticket.context ?? '',
        repo_path: ticket.repo_path ?? '',
        assigned_agent: ticket.assigned_agent ?? '',
        branch_name: ticket.branch_name ?? '',
        source_branch: ticket.source_branch ?? '',
      });
      setDirty(false);
    }
  }, [ticket]);

  if (!ticket) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-text-dim" />
      </div>
    );
  }

  // Review state gets its own full-panel component
  if (ticket.status === 'review') {
    return (
      <ReviewPanel
        ticket={ticket}
        onTransition={handleTransition}
        isTransitioning={
          transitionTicket.isPending ||
          mergeBranch.isPending ||
          removeWorktree.isPending
        }
      />
    );
  }

  const isLocked = ticket.status === 'running';

  function handleChange(field: keyof Ticket, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
    setSaveError(null);
  }

  async function handleSave() {
    if (!ticket || !dirty) return;
    const fields: Record<string, unknown> = {};
    if (form.title !== undefined) fields.title = form.title;
    if (form.context !== undefined) fields.context = form.context || null;
    if (form.repo_path !== undefined) fields.repo_path = form.repo_path || null;
    if (form.assigned_agent !== undefined)
      fields.assigned_agent = form.assigned_agent || null;
    if (form.branch_name !== undefined)
      fields.branch_name = form.branch_name || null;
    if (form.source_branch !== undefined)
      fields.source_branch = form.source_branch || null;

    try {
      await updateTicket.mutateAsync({ id: ticket.id, fields });
      setDirty(false);
    } catch (e) {
      setSaveError(String(e));
    }
  }

  async function handleTransition(toStatus: TicketStatus) {
    if (!ticket) return;
    setSaveError(null);

    try {
      // ── ready → queued: create worktree + assign terminal slot ────────
      if (ticket.status === 'ready' && toStatus === 'queued') {
        if (!ticket.repo_path) {
          setSaveError('Repo path is required before queueing.');
          return;
        }
        if (!ticket.assigned_agent) {
          setSaveError('Assigned agent is required before queueing.');
          return;
        }
        const slot = getNextAvailableSlot();
        if (slot === null) {
          setSaveError('All 8 terminal slots are in use. Finish or abort a running ticket first.');
          return;
        }
        const info = await createWorktree.mutateAsync({
          ticketId: ticket.id,
          repoPath: ticket.repo_path,
          sourceBranch: ticket.source_branch ?? undefined,
          branchName: ticket.branch_name ?? undefined,
        });
        await updateTicket.mutateAsync({
          id: ticket.id,
          fields: {
            worktree_path: info.worktree_path,
            source_branch: info.source_branch,
            branch_name: info.branch_name,
            terminal_slot: slot,
          },
        });
        await transitionTicket.mutateAsync({ id: ticket.id, toStatus });
        return;
      }

      // ── queued → running: launch agent process ────────────────────────
      if (ticket.status === 'queued' && toStatus === 'running') {
        const slot = ticket.terminal_slot ?? 0;
        await launchAgent.mutateAsync({ ticketId: ticket.id, slot });
        await transitionTicket.mutateAsync({ id: ticket.id, toStatus });
        return;
      }

      // ── review → done: merge branch into repo HEAD ────────────────────
      if (ticket.status === 'review' && toStatus === 'done') {
        if (
          ticket.repo_path &&
          ticket.worktree_path &&
          ticket.source_branch &&
          ticket.branch_name
        ) {
          await mergeBranch.mutateAsync({
            repoPath: ticket.repo_path,
            worktreePath: ticket.worktree_path,
            sourceBranch: ticket.source_branch,
            branchName: ticket.branch_name,
          });
        }
        await transitionTicket.mutateAsync({ id: ticket.id, toStatus });
        if (ticket.terminal_slot != null) releaseSlot(ticket.terminal_slot);
        return;
      }

      // ── review → ready: reject — remove worktree + branch ────────────
      if (ticket.status === 'review' && toStatus === 'ready') {
        if (ticket.worktree_path && ticket.repo_path && ticket.branch_name) {
          await removeWorktree.mutateAsync({
            worktreePath: ticket.worktree_path,
            repoPath: ticket.repo_path,
            branchName: ticket.branch_name,
          });
        }
        await transitionTicket.mutateAsync({ id: ticket.id, toStatus });
        if (ticket.terminal_slot != null) releaseSlot(ticket.terminal_slot);
        return;
      }

      // ── running → ready: abort — kill process + release slot ─────────
      if (ticket.status === 'running' && toStatus === 'ready') {
        const slot = ticket.terminal_slot;
        if (slot != null) {
          try {
            await invoke('kill_process', { slot });
          } catch {
            // Process may have already exited; ignore
          }
          releaseSlot(slot);
        }
        // Clear terminal_slot on the ticket before transitioning
        await updateTicket.mutateAsync({
          id: ticket.id,
          fields: { terminal_slot: null },
        });
        await transitionTicket.mutateAsync({ id: ticket.id, toStatus });
        return;
      }

      // ── Default: simple status transition ─────────────────────────────
      await transitionTicket.mutateAsync({ id: ticket.id, toStatus });
    } catch (e) {
      setSaveError(String(e));
    }
  }

  const transitions = getTransitions(ticket.status);
  const hasRecoverableWorktree =
    ticket.status === 'ready' &&
    !!ticket.repo_path &&
    !!ticket.worktree_path &&
    !!ticket.branch_name;
  const anyPending =
    transitionTicket.isPending ||
    createWorktree.isPending ||
    removeWorktree.isPending ||
    mergeBranch.isPending ||
    launchAgent.isPending ||
    updateTicket.isPending;

  return (
    <div className="flex flex-col h-full">
      {/* Sub-header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Button variant="ghost" size="icon" onClick={backToList} title="Back to list">
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <StatusBadge status={ticket.status} />
        {dirty && (
          <span className="text-xs text-text-dim ml-auto">Unsaved changes</span>
        )}
        {dirty && (
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateTicket.isPending || isLocked}
          >
            {updateTicket.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              'Save'
            )}
          </Button>
        )}
      </div>

      {/* Form body */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {saveError && (
          <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-2 py-1.5">
            {saveError}
          </div>
        )}

        {/* Title */}
        <div className="space-y-1">
          <label className="text-xs text-text-muted font-medium">Title</label>
          <Input
            value={form.title ?? ''}
            onChange={(e) => handleChange('title', e.target.value)}
            placeholder="Ticket title"
            disabled={isLocked}
          />
        </div>

        {/* Repo path */}
        <div className="space-y-1">
          <label className="text-xs text-text-muted font-medium">Repository</label>
          <button
            type="button"
            disabled={isLocked}
            onClick={async () => {
              const selected = await open({ directory: true, multiple: false });
              if (typeof selected === 'string') {
                saveRecentRepo(selected);
                handleChange('repo_path', selected);
              }
            }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm rounded border border-border bg-surface hover:bg-surface-raised text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FolderOpen className="w-4 h-4 text-text-muted shrink-0" />
            <span className={form.repo_path ? 'text-text truncate' : 'text-text-dim truncate'}>
              {form.repo_path || 'Choose folder…'}
            </span>
          </button>
          {form.repo_path && repoBranch.error && (
            <div className="text-[11px] text-red-400">Not a git repository</div>
          )}
        </div>

        {/* Source branch — editable before worktree is created */}
        {(ticket.status === 'draft' || ticket.status === 'ready') &&
          form.repo_path &&
          repoBranches.data &&
          repoBranches.data.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs text-text-muted font-medium">Source Branch</label>
              <Select
                value={form.source_branch || repoBranch.data?.branch_name || ''}
                options={repoBranches.data.map((b) => ({
                  value: b,
                  label: b + (b === repoBranch.data?.branch_name ? ' (checked out)' : ''),
                }))}
                onChange={(e) => handleChange('source_branch', e.target.value)}
                disabled={isLocked}
              />
              <div className="text-[11px] text-text-dim">
                Worktree will branch from this. Defaults to currently checked-out branch.
              </div>
            </div>
          )}

        {/* Branch name — editable before worktree is created */}
        {(ticket.status === 'draft' || ticket.status === 'ready') && (
          <div className="space-y-1">
            <label className="text-xs text-text-muted font-medium">Branch Name</label>
            <Input
              value={form.branch_name ?? ''}
              onChange={(e) => handleChange('branch_name', e.target.value)}
              placeholder="feat/my-feature (optional, auto-generated if blank)"
              disabled={isLocked}
              className="font-mono text-xs"
            />
          </div>
        )}

        {/* What should be done */}
        <div className="space-y-1">
          <label className="text-xs text-text-muted font-medium">What Should Be Done</label>
          <AtReferenceTextarea
            value={form.context ?? ''}
            onChange={(value) => handleChange('context', value)}
            repoPath={form.repo_path ?? ''}
            placeholder="Describe what should be done. Use @path/to/file.tsx to include files from the selected repo."
            rows={6}
            disabled={isLocked}
          />
        </div>

        {/* Assigned agent — visible when ready or queued */}
        {(ticket.status === 'ready' || ticket.status === 'queued') && (
          <div className="space-y-1">
            <label className="text-xs text-text-muted font-medium">
              Assigned Agent
            </label>
            <Select
              value={form.assigned_agent ?? ''}
              options={AGENT_OPTIONS.map((option) => ({ ...option }))}
              placeholder="Select agent…"
              onChange={(e) => handleChange('assigned_agent', e.target.value)}
              disabled={isLocked}
            />
          </div>
        )}

        {/* Worktree info — show when queued or running */}
        {(ticket.status === 'queued' || ticket.status === 'running') &&
          ticket.worktree_path && (
            <div className="text-xs text-text-dim space-y-0.5 pt-1">
              <div>
                Base:{' '}
                <span className="font-mono text-text-dim">{ticket.source_branch}</span>
              </div>
              <div>
                Branch:{' '}
                <span className="font-mono text-text-dim">{ticket.branch_name}</span>
              </div>
              <div>
                Slot:{' '}
                <span className="font-mono text-text-dim">{ticket.terminal_slot}</span>
              </div>
            </div>
          )}

        {/* Timestamps */}
        <div className="text-xs text-text-dim space-y-0.5 pt-2 border-t border-border">
          <div>Created: {new Date(ticket.created_at).toLocaleString()}</div>
          <div>Updated: {new Date(ticket.updated_at).toLocaleString()}</div>
          {ticket.started_at && (
            <div>Started: {new Date(ticket.started_at).toLocaleString()}</div>
          )}
          {ticket.completed_at && (
            <div>
              Completed: {new Date(ticket.completed_at).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Action buttons at bottom */}
      {transitions.length > 0 && (
        <div className="shrink-0 px-3 py-3 border-t border-border flex gap-2">
          {hasRecoverableWorktree && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleTransition('review')}
              disabled={anyPending}
              className="flex-1"
            >
              View Diff
            </Button>
          )}
          {transitions.map((t) => (
            <Button
              key={t.toStatus}
              variant={t.variant ?? 'default'}
              size="sm"
              onClick={() => handleTransition(t.toStatus)}
              disabled={anyPending}
              className="flex-1"
            >
              {anyPending && transitionTicket.variables?.toStatus === t.toStatus ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                t.label
              )}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
