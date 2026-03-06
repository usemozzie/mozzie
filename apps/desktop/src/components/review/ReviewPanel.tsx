import { useEffect, useMemo, useState } from 'react';
import { Check, GitBranch, Loader2, RotateCcw, ChevronLeft, CheckCheck } from 'lucide-react';
import type { AgentLog, Ticket, TicketReviewState } from '@mozzie/db';
import { useTicketStore } from '../../stores/ticketStore';
import { DiffViewer, formatFileLabel, getFileStatus, parseDiff } from './DiffViewer';
import { Button } from '../ui/button';
import { StatusBadge } from '../ui/badge';
import { formatDistanceToNow } from '../../lib/time';

interface ReviewPanelProps {
  ticket: Ticket;
  review: TicketReviewState | null;
  reviewLoading?: boolean;
  reviewError?: string | null;
  latestLog?: AgentLog | null;
  isMutating?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  onClose?: () => void;
  showBackButton?: boolean;
  actionError?: string | null;
}

export function ReviewPanel({
  ticket,
  review,
  reviewLoading,
  reviewError,
  latestLog,
  isMutating,
  onApprove,
  onReject,
  onClose,
  showBackButton,
  actionError,
}: ReviewPanelProps) {
  const { backToList } = useTicketStore();
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);

  const durationSec = latestLog?.duration_ms != null
    ? (latestLog.duration_ms / 1000).toFixed(1)
    : null;

  const files = useMemo(() => parseDiff(review?.diff ?? ''), [review?.diff]);
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);

  useEffect(() => {
    if (files.length === 0) {
      setSelectedFileKey(null);
      return;
    }
    if (!selectedFileKey || !files.some((file) => file.key === selectedFileKey)) {
      setSelectedFileKey(files[0].key);
    }
  }, [files, selectedFileKey]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 bg-surface">
        {showBackButton && (
          <Button variant="ghost" size="icon" onClick={backToList} title="Back to list">
            <ChevronLeft className="w-4 h-4" />
          </Button>
        )}
        <StatusBadge status={ticket.status} />
        <span className="truncate text-xs text-text-dim ml-auto">{ticket.title}</span>
      </div>

      <div className="shrink-0 px-3 py-2 border-b border-border bg-surface/80">
        {actionError && (
          <div className="mb-2 rounded border border-red-800 bg-red-900/20 px-2 py-1.5 text-xs text-red-400">
            {actionError}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-dim">
          <span className="font-medium text-text-muted">{review?.summary ?? 'Loading review state...'}</span>
          {review?.source_branch && review?.branch_name && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <GitBranch className="w-3 h-3" />
              {review.source_branch}
              <span className="text-text-dim">←</span>
              {review.branch_name}
            </span>
          )}
          {files.length > 0 && (
            <span className="font-mono text-[11px] text-text-muted">
              {files.length} file{files.length === 1 ? '' : 's'} changed, +{totalAdditions} -{totalDeletions}
            </span>
          )}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-text-dim mb-0.5">Duration</div>
            <div className="font-mono text-text">{durationSec ? `${durationSec}s` : '—'}</div>
          </div>
          <div>
            <div className="text-text-dim mb-0.5">Exit Code</div>
            <div className={`font-mono ${latestLog?.exit_code === 0 ? 'text-state-success' : latestLog?.exit_code != null ? 'text-red-400' : 'text-text-muted'}`}>
              {latestLog?.exit_code ?? '—'}
            </div>
          </div>
          <div>
            <div className="text-text-dim mb-0.5">Completed</div>
            <div className="text-text">{ticket.completed_at ? formatDistanceToNow(ticket.completed_at) : '—'}</div>
          </div>
        </div>
        {latestLog?.cleanup_warning_message && (
          <div className="mt-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
            {latestLog.cleanup_warning_message}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="w-64 shrink-0 border-r border-border bg-surface/40 overflow-y-auto min-h-0">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-text-dim border-b border-border">
            Changed Files
          </div>
          {reviewLoading ? (
            <div className="p-3 text-sm text-text-dim flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading review...
            </div>
          ) : reviewError ? (
            <div className="p-3 text-sm text-red-400">{reviewError}</div>
          ) : files.length === 0 ? (
            <div className="p-3 text-sm text-text-dim">{review?.summary ?? 'No changes available.'}</div>
          ) : (
            files.map((file) => {
              const active = selectedFileKey === file.key;
              const status = getFileStatus(file);
              return (
                <button
                  key={file.key}
                  type="button"
                  onClick={() => setSelectedFileKey(file.key)}
                  className={`w-full px-3 py-2 text-left border-b border-border/60 transition-colors ${active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-5 shrink-0 text-[11px] font-mono ${status === 'new' ? 'text-emerald-400' : status === 'deleted' ? 'text-red-400' : 'text-blue-300'}`}>
                      {status === 'new' ? 'A' : status === 'deleted' ? 'D' : 'M'}
                    </span>
                    <span className="truncate text-[12px] text-text">{formatFileLabel(file.oldPath, file.newPath)}</span>
                  </div>
                  <div className="mt-1 pl-7 text-[11px] font-mono text-text-dim">
                    +{file.additions} -{file.deletions}
                  </div>
                </button>
              );
            })
          )}
        </aside>

        <div className="flex-1 min-w-0 min-h-0 overflow-auto">
          {reviewLoading ? (
            <div className="h-full flex items-center justify-center gap-2 text-text-dim text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading diff...
            </div>
          ) : reviewError ? (
            <div className="px-4 py-6 text-sm text-red-400">
              <div className="font-medium mb-1">Review unavailable</div>
              <div className="text-xs text-red-500/80">{reviewError}</div>
            </div>
          ) : review?.review_status === 'merged' ? (
            <div className="px-6 py-10 text-sm text-text-dim">
              This branch is already merged. There are no remaining changes to review.
            </div>
          ) : review?.has_changes ? (
            <DiffViewer diff={review.diff} selectedFileKey={selectedFileKey} />
          ) : (
            <div className="px-6 py-10 text-sm text-text-dim">
              {review?.summary ?? 'No changes to review.'}
            </div>
          )}
        </div>
      </div>

      {(onApprove || onReject || onClose) && (
        <div className="shrink-0 sticky bottom-0 z-10 px-3 py-3 border-t border-border flex gap-2 bg-surface">
          {onApprove && (
            <Button size="sm" className="flex-1" onClick={onApprove} disabled={isMutating || !review || (!review.has_changes && !review.is_merged)}>
              {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Check className="w-3 h-3" />Approve & Merge</>}
            </Button>
          )}
          {onReject && (
            <Button variant="destructive" size="sm" className="flex-1" onClick={onReject} disabled={isMutating || !review?.worktree_present}>
              {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><RotateCcw className="w-3 h-3" />Discard Changes</>}
            </Button>
          )}
          {onClose && (
            <Button variant="outline" size="sm" className="flex-1" onClick={onClose} disabled={isMutating}>
              {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><CheckCheck className="w-3 h-3" />Close</>}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
