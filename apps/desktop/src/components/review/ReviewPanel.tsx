import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';
import type { AgentLog, WorkItem, WorkItemReviewState } from '@mozzie/db';
import { DiffViewer, formatFileLabel, getFileStatus, parseDiff } from './DiffViewer';
import { RejectionModal } from './RejectionModal';
import { Button } from '../ui/button';

interface ReviewPanelProps {
  workItem: WorkItem;
  review: WorkItemReviewState | null;
  reviewLoading?: boolean;
  reviewError?: string | null;
  latestLog?: AgentLog | null;
  isMutating?: boolean;
  onApprove?: () => void;
  onReject?: (rejectionReason?: string) => void;
  onClose?: () => void;
  showBackButton?: boolean;
  actionError?: string | null;
}

const parsedDiffCache = new Map<string, {
  files: ReturnType<typeof parseDiff>;
  totalAdditions: number;
  totalDeletions: number;
}>();
const MAX_PARSED_DIFF_CACHE_ENTRIES = 24;

function getParsedDiffSummary(diff: string) {
  const cached = parsedDiffCache.get(diff);
  if (cached) {
    return cached;
  }

  const files = parseDiff(diff);
  const summary = {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };

  if (parsedDiffCache.size >= MAX_PARSED_DIFF_CACHE_ENTRIES) {
    const oldestKey = parsedDiffCache.keys().next().value;
    if (oldestKey) {
      parsedDiffCache.delete(oldestKey);
    }
  }

  parsedDiffCache.set(diff, summary);
  return summary;
}

export function ReviewPanel({
  workItem,
  review,
  reviewLoading,
  reviewError,
  latestLog,
  isMutating,
  onApprove,
  onReject,
  onClose,
  actionError,
}: ReviewPanelProps) {
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [showRejectionModal, setShowRejectionModal] = useState(false);
  const isChild = !!workItem.parent_id;

  const diff = review?.diff ?? '';
  const { files, totalAdditions, totalDeletions } = useMemo(
    () => getParsedDiffSummary(diff),
    [diff],
  );
  const primaryLabel = isChild
    ? 'Merge to Parent'
    : !review?.branch_present
      ? 'Branch Missing'
      : !review.can_push && review.needs_push
        ? 'Push Blocked'
        : review.needs_push
          ? review.remote_branch_exists ? 'Push Updates' : 'Push to GitHub'
          : 'Up to Date';
  const primaryDisabled = isMutating || !review || (
    isChild
      ? (!review.has_changes && !review.is_merged)
      : !review.can_push || !review.needs_push
  );

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
      {actionError && (
        <div className="shrink-0 px-3 py-2 border-b border-red-800 bg-red-900/20 text-xs text-red-400">
          {actionError}
        </div>
      )}
      {latestLog?.cleanup_warning_message && (
        <div className="shrink-0 px-3 py-2 border-b border-amber-500/20 text-xs text-amber-300 bg-amber-500/10">
          {latestLog.cleanup_warning_message}
        </div>
      )}
      {!isChild && review && !reviewLoading && !reviewError && (
        <div className="shrink-0 px-3 py-2 border-b border-border bg-surface/20 text-xs text-text-dim">
          {review.push_summary}
        </div>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="w-64 shrink-0 border-r border-border bg-surface/40 overflow-y-auto min-h-0">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-text-dim border-b border-border flex items-center justify-between">
            <span>Changed Files</span>
            {files.length > 0 && (
              <span className="font-mono text-[10px] text-text-dim/70">
                +{totalAdditions} -{totalDeletions}
              </span>
            )}
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
                    <span className={`w-5 shrink-0 text-[11px] font-mono ${status === 'new' ? 'text-emerald-400' : status === 'deleted' ? 'text-red-400' : 'text-zinc-300'}`}>
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

        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
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
            <DiffViewer diff={diff} selectedFileKey={selectedFileKey} files={files} />
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
            <Button size="sm" className="flex-1" onClick={onApprove} disabled={primaryDisabled}>
              {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Check className="w-3 h-3" />{primaryLabel}</>}
            </Button>
          )}
          {onReject && (
            <Button variant="destructive" size="sm" className="flex-1" onClick={() => setShowRejectionModal(true)} disabled={isMutating || !review?.worktree_present}>
              {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><RotateCcw className="w-3 h-3" />Discard</>}
            </Button>
          )}
          {onClose && (
            <Button variant="outline" size="sm" className="flex-1" onClick={onClose} disabled={isMutating}>
              {isMutating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><X className="w-3 h-3" />Mark Done</>}
            </Button>
          )}
        </div>
      )}

      {showRejectionModal && onReject && (
        <RejectionModal
          workItemTitle={workItem.title}
          filesChanged={files.map((f) => formatFileLabel(f.oldPath, f.newPath))}
          onConfirm={(reason) => {
            setShowRejectionModal(false);
            onReject(reason);
          }}
          onCancel={() => setShowRejectionModal(false)}
          isSubmitting={isMutating}
        />
      )}
    </div>
  );
}
