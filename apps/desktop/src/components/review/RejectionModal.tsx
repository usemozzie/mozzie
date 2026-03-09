import { useState } from 'react';
import { RotateCcw, X, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';

interface RejectionModalProps {
  workItemTitle: string;
  filesChanged: string[];
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function RejectionModal({
  workItemTitle,
  filesChanged,
  onConfirm,
  onCancel,
  isSubmitting,
}: RejectionModalProps) {
  const [reason, setReason] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(reason.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md mx-4 rounded-xl border border-border bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-red-400" />
            <h3 className="text-[13px] font-semibold text-text">Reject & Reset</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="w-6 h-6 flex items-center justify-center rounded text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          <p className="text-[12px] text-text-dim">
            Rejecting <span className="text-text font-medium">{workItemTitle}</span>.
            This feedback will be injected into the next run so the agent avoids the same mistakes.
          </p>

          <div className="space-y-1.5">
            <label className="text-[11px] text-text-muted font-medium">
              What went wrong?
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., broke existing tests, wrong approach, missing edge case..."
              rows={4}
              autoFocus
              className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text
                placeholder:text-text-dim focus:outline-none focus:border-accent/50
                transition-colors duration-150 leading-relaxed"
            />
            <p className="text-[10px] text-text-dim">
              Optional but recommended. The agent will see this on the next attempt.
            </p>
          </div>

          {filesChanged.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-[11px] text-text-muted font-medium">
                Files changed ({filesChanged.length})
              </label>
              <div className="max-h-24 overflow-y-auto rounded border border-border bg-bg px-2 py-1.5">
                {filesChanged.map((file) => (
                  <div key={file} className="text-[11px] font-mono text-text-dim py-0.5 truncate">
                    {file}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" size="sm" disabled={isSubmitting}>
            {isSubmitting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <>
                <RotateCcw className="w-3 h-3" />
                Reject & Reset
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
