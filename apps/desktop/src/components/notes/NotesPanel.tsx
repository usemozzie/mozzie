import { useEffect, useRef, useState } from 'react';
import { X, Pencil, Eye } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTicketStore } from '../../stores/ticketStore';

interface NotesPanelProps {
  onClose: () => void;
}

const NOTES_STORAGE_KEY = 'mozzie.notes';

export function NotesPanel({ onClose }: NotesPanelProps) {
  const [notes, setNotes] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const openNewTicketModal = useTicketStore((s) => s.openNewTicketModal);

  useEffect(() => {
    const stored = localStorage.getItem(NOTES_STORAGE_KEY);
    if (stored !== null) {
      setNotes(stored);
    }
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(NOTES_STORAGE_KEY, notes);
  }, [notes, isHydrated]);

  function syncSelection() {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = start === end ? '' : el.value.slice(start, end).trim();
    setSelectedText(value);
  }

  function handleCreateTicketFromSelection() {
    const value = selectedText.trim();
    if (!value) return;
    openNewTicketModal(value);
  }

  return (
    <div
      className="h-full w-full bg-surface border-l border-border flex flex-col"
      role="dialog"
      aria-label="Notes"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-text">Notes</h2>
        <div className="flex items-center gap-1">
          {/* Toggle edit/preview */}
          <button
            onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
            className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors
              ${mode === 'preview' ? 'text-accent bg-accent/10' : 'text-text-dim hover:text-text hover:bg-white/[0.06]'}`}
            title={mode === 'edit' ? 'Preview' : 'Edit'}
          >
            {mode === 'edit' ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
            title="Close notes"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 min-h-0 flex flex-col gap-2">
        {mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onSelect={syncSelection}
            onKeyUp={syncSelection}
            onMouseUp={syncSelection}
            placeholder="Write notes... (supports Markdown)"
            className="w-full flex-1 min-h-0 resize-none rounded-lg border border-border bg-bg/80 text-sm text-text px-3 py-2
              focus:outline-none focus:border-accent/50 placeholder:text-text-dim leading-relaxed"
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-bg/80 px-3 py-2">
            {notes.trim() ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => (
                    <p className="mb-2 last:mb-0 text-text-muted text-sm leading-relaxed">{children}</p>
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
                  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
                  h1: ({ children }) => <h1 className="text-[15px] font-semibold text-text mt-3 mb-1 border-b border-border pb-1">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-[14px] font-semibold text-text mt-2.5 mb-1">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-[13px] font-semibold text-text-muted mt-2 mb-0.5">{children}</h3>,
                  ul: ({ children }) => <ul className="mb-2 ml-3 space-y-0.5 list-disc list-outside text-text-muted text-sm">{children}</ul>,
                  ol: ({ children }) => <ol className="mb-2 ml-3 space-y-0.5 list-decimal list-outside text-text-muted text-sm">{children}</ol>,
                  li: ({ children }) => <li className="leading-relaxed pl-0.5">{children}</li>,
                  blockquote: ({ children }) => (
                    <blockquote className="my-1 pl-3 border-l-2 border-border-bright text-text-muted italic text-sm">
                      {children}
                    </blockquote>
                  ),
                }}
              >
                {notes}
              </ReactMarkdown>
            ) : (
              <p className="text-text-dim text-sm italic">Nothing to preview.</p>
            )}
          </div>
        )}
        {selectedText && mode === 'edit' && (
          <div className="shrink-0 flex items-center justify-between rounded-lg border border-border bg-bg/70 px-3 py-2">
            <span className="text-xs text-text-dim truncate pr-3">
              Create ticket from selected text
            </span>
            <button
              type="button"
              onClick={handleCreateTicketFromSelection}
              className="text-xs px-2.5 py-1 rounded-md border border-border bg-surface hover:bg-surface-raised text-text transition-colors"
            >
              Create Ticket
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
