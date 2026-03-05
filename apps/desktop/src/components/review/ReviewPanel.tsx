import { Check, X, Loader2, ChevronLeft } from 'lucide-react';
import type { Ticket, TicketStatus } from '@mozzie/db';
import { useReview } from '../../hooks/useReview';
import { useTicketStore } from '../../stores/ticketStore';
import { DiffViewer } from './DiffViewer';
import { Button } from '../ui/button';
import { StatusBadge } from '../ui/badge';
import { formatDistanceToNow } from '../../lib/time';

interface ReviewPanelProps {
  ticket: Ticket;
  onTransition: (toStatus: TicketStatus) => void;
  isTransitioning?: boolean;
}

/**
 * Review panel shown when a ticket is in 'review' state.
 * Displays execution stats, the git diff, and Approve / Reject actions.
 */
export function ReviewPanel({
  ticket,
  onTransition,
  isTransitioning,
}: ReviewPanelProps) {
  const { backToList } = useTicketStore();
  const { diff, diffLoading, diffError, latestLog } = useReview(ticket);

  const durationSec = latestLog?.duration_ms != null
    ? (latestLog.duration_ms / 1000).toFixed(1)
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Sub-header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Button variant="ghost" size="icon" onClick={backToList} title="Back to list">
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <StatusBadge status={ticket.status} />
        <span className="text-xs text-text-dim ml-auto truncate">{ticket.title}</span>
      </div>

      {/* Execution stats */}
      <div className="shrink-0 px-3 py-2 border-b border-border bg-surface">
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-text-dim mb-0.5">Duration</div>
            <div className="font-mono text-text">
              {durationSec ? `${durationSec}s` : '—'}
            </div>
          </div>
          <div>
            <div className="text-text-dim mb-0.5">Exit Code</div>
            <div
              className={`font-mono ${
                latestLog?.exit_code === 0
                  ? 'text-state-success'
                  : latestLog?.exit_code != null
                  ? 'text-red-400'
                  : 'text-text-muted'
              }`}
            >
              {latestLog?.exit_code ?? '—'}
            </div>
          </div>
          <div>
            <div className="text-text-dim mb-0.5">Completed</div>
            <div className="text-text">
              {ticket.completed_at
                ? formatDistanceToNow(ticket.completed_at)
                : '—'}
            </div>
          </div>
        </div>
        {ticket.assigned_agent && (
          <div className="mt-1.5 text-xs text-text-dim">
            Agent: <span className="text-text-muted">{ticket.assigned_agent}</span>
          </div>
        )}
        {ticket.source_branch && ticket.branch_name && (
          <div className="mt-1 text-xs text-text-dim">
            Worktree diff: <span className="font-mono text-text-muted">{ticket.source_branch}</span>
            {' <- '}
            <span className="font-mono text-text-muted">{ticket.branch_name}</span>
          </div>
        )}
        {latestLog?.cleanup_warning_message && (
          <div className="mt-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
            {latestLog.cleanup_warning_message}
          </div>
        )}
      </div>

      {/* Diff viewer */}
      <div className="flex-1 overflow-y-auto">
        {diffLoading ? (
          <div className="flex items-center justify-center h-32 gap-2 text-text-dim text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading diff…
          </div>
        ) : diffError ? (
          <div className="px-3 py-4 text-sm text-red-400">
            <div className="font-medium mb-1">Diff unavailable</div>
            <div className="text-xs text-red-500/80">{diffError}</div>
          </div>
        ) : (
          <DiffViewer diff={diff ?? ''} />
        )}
      </div>

      {/* Action buttons */}
      <div className="shrink-0 px-3 py-3 border-t border-border flex gap-2">
        <Button
          variant="default"
          size="sm"
          className="flex-1"
          onClick={() => onTransition('done')}
          disabled={isTransitioning}
          title="Merge branch and mark as done"
        >
          {isTransitioning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <>
              <Check className="w-3 h-3 mr-1" />
              Approve
            </>
          )}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="flex-1"
          onClick={() => onTransition('ready')}
          disabled={isTransitioning}
          title="Remove worktree and return ticket to ready"
        >
          {isTransitioning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <>
              <X className="w-3 h-3 mr-1" />
              Reject
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
