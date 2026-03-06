import { useState, useEffect } from 'react';
import { ChevronLeft, Loader2, FolderOpen, X, GitBranch } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Ticket, TicketStatus } from '@mozzie/db';
import { useTicket, useTickets } from '../../hooks/useTickets';
import { useUpdateTicket, useTransitionTicket } from '../../hooks/useTicketMutation';
import { useCreateWorktree, useApproveTicketReview, useRejectTicketReview, useCloseTicketReview, useRepoBranch, useRepoBranches } from '../../hooks/useWorktree';
import { useLaunchAgent } from '../../hooks/useAgents';
import { useTicketDependencies, useTicketDependents, useAddDependency, useRemoveDependency } from '../../hooks/useDependencies';
import { useLicense } from '../../hooks/useLicense';
import { useReview } from '../../hooks/useReview';
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
    case 'blocked':
      return [
        { label: 'Force Unblock', toStatus: 'ready', variant: 'outline' },
      ];
    case 'queued':
      return [
        { label: 'Run Now', toStatus: 'running' },
        { label: 'Unassign', toStatus: 'ready', variant: 'outline' },
      ];
    case 'running':
      return [{ label: 'Abort', toStatus: 'ready', variant: 'destructive' }];
    case 'review':
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
  const approveReview = useApproveTicketReview();
  const rejectReview = useRejectTicketReview();
  const closeReview = useCloseTicketReview();
  const launchAgent = useLaunchAgent();
  const getNextAvailableSlot = useTerminalStore((s) => s.getNextAvailableSlot);
  const releaseSlot = useTerminalStore((s) => s.releaseSlot);

  const [form, setForm] = useState<Partial<Ticket>>({});
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const repoBranch = useRepoBranch(form.repo_path ?? '');
  const repoBranches = useRepoBranches(form.repo_path ?? '');

  // Dependencies (Pro only)
  const { data: license } = useLicense();
  const isPro = license?.is_pro ?? false;
  const { data: deps } = useTicketDependencies(activeTicketId);
  const { data: dependents } = useTicketDependents(activeTicketId);
  const { data: allTickets } = useTickets();
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const [depSearch, setDepSearch] = useState('');
  const reviewState = useReview(ticket);

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

  if (ticket.status === 'review' || reviewState.review?.can_review) {
    return (
      <ReviewPanel
        ticket={ticket}
        review={reviewState.review}
        reviewLoading={reviewState.reviewLoading}
        reviewError={reviewState.reviewError}
        latestLog={reviewState.latestLog}
        onApprove={handleApproveReview}
        onReject={handleRejectReview}
        onClose={handleCloseReview}
        isMutating={approveReview.isPending || rejectReview.isPending || closeReview.isPending}
        showBackButton
        actionError={saveError}
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

  async function handleApproveReview() {
    if (!ticket) return;
    setSaveError(null);
    try {
      await approveReview.mutateAsync(ticket.id);
    } catch (e) {
      setSaveError(String(e));
    }
  }

  async function handleRejectReview() {
    if (!ticket) return;
    setSaveError(null);
    try {
      await rejectReview.mutateAsync(ticket.id);
    } catch (e) {
      setSaveError(String(e));
    }
  }

  async function handleCloseReview() {
    if (!ticket) return;
    setSaveError(null);
    try {
      await closeReview.mutateAsync(ticket.id);
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

      // ── running → ready: abort — kill process + release slot ─────────
      if (ticket.status === 'running' && toStatus === 'ready') {
        const slot = ticket.terminal_slot;
        if (slot != null) {
          try {
            await invoke('kill_process', { slot });
          } catch {
            // Process may have already exited.
          }
          releaseSlot(slot);
        }
        await updateTicket.mutateAsync({ id: ticket.id, fields: { terminal_slot: null } });
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
  const anyPending =
    transitionTicket.isPending ||
    createWorktree.isPending ||
    approveReview.isPending ||
    rejectReview.isPending ||
    closeReview.isPending ||
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

        {/* Dependencies (Pro only) */}
        {isPro && (
          <div className="space-y-2 pt-2 border-t border-border">
            <label className="text-xs text-text-muted font-medium flex items-center gap-1.5">
              <GitBranch className="w-3 h-3" />
              Dependencies
            </label>

            {/* Current dependencies */}
            {deps && deps.length > 0 && (
              <div className="space-y-1">
                {deps.map((dep) => {
                  const depTicket = allTickets?.find((t) => t.id === dep.depends_on_id);
                  return (
                    <div key={dep.depends_on_id} className="flex items-center gap-2 text-xs bg-surface-raised rounded px-2 py-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        depTicket?.status === 'done' || depTicket?.status === 'archived'
                          ? 'bg-state-success'
                          : 'bg-amber-500'
                      }`} />
                      <span className="flex-1 text-text truncate">
                        {depTicket?.title ?? dep.depends_on_id}
                      </span>
                      <span className="text-[10px] text-text-dim">{depTicket?.status}</span>
                      {!isLocked && (
                        <button
                          onClick={() => removeDependency.mutate({ ticketId: ticket.id, dependsOnId: dep.depends_on_id })}
                          className="text-text-dim hover:text-red-400 transition-colors"
                          title="Remove dependency"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add dependency picker */}
            {!isLocked && ticket.status !== 'done' && ticket.status !== 'archived' && (
              <div className="space-y-1">
                <Input
                  value={depSearch}
                  onChange={(e) => setDepSearch(e.target.value)}
                  placeholder="Search tickets to add as dependency…"
                  className="text-xs"
                />
                {depSearch.trim() && (
                  <div className="max-h-32 overflow-y-auto border border-border rounded bg-bg">
                    {(allTickets ?? [])
                      .filter((t) =>
                        t.id !== ticket.id &&
                        !deps?.some((d) => d.depends_on_id === t.id) &&
                        t.title.toLowerCase().includes(depSearch.toLowerCase())
                      )
                      .slice(0, 8)
                      .map((t) => (
                        <button
                          key={t.id}
                          onClick={async () => {
                            try {
                              await addDependency.mutateAsync({ ticketId: ticket.id, dependsOnId: t.id });
                              setDepSearch('');
                              setSaveError(null);
                            } catch (e) {
                              setSaveError(String(e));
                            }
                          }}
                          className="w-full text-left px-2 py-1.5 text-xs hover:bg-surface transition-colors flex items-center gap-2"
                        >
                          <span className="text-text truncate flex-1">{t.title}</span>
                          <span className="text-[10px] text-text-dim shrink-0">{t.status}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* Dependents (who depends on this ticket) */}
            {dependents && dependents.length > 0 && (
              <div className="space-y-1 pt-1">
                <label className="text-[11px] text-text-dim">Blocks {dependents.length} ticket{dependents.length > 1 ? 's' : ''}</label>
                {dependents.map((dep) => {
                  const depTicket = allTickets?.find((t) => t.id === dep.ticket_id);
                  return (
                    <div key={dep.ticket_id} className="text-xs text-text-dim px-2 py-1 truncate">
                      {depTicket?.title ?? dep.ticket_id}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Blocked status info */}
        {ticket.status === 'blocked' && deps && deps.length > 0 && (
          <div className="text-xs text-amber-400 bg-amber-900/10 border border-amber-800/30 rounded px-2 py-1.5">
            Waiting for {deps.filter((d) => {
              const t = allTickets?.find((t) => t.id === d.depends_on_id);
              return t && t.status !== 'done' && t.status !== 'archived';
            }).length} dependency ticket{deps.length > 1 ? 's' : ''} to be approved.
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
