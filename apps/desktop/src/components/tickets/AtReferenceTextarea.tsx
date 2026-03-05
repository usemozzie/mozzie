import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';
import { Textarea } from '../ui/textarea';

interface ActiveReference {
  start: number;
  end: number;
  query: string;
}

interface AtReferenceTextareaProps {
  value: string;
  onChange: (value: string) => void;
  repoPath: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
}

function isTokenChar(char: string) {
  return /[A-Za-z0-9_./\\-]/.test(char);
}

function findActiveReference(text: string, caret: number): ActiveReference | null {
  if (caret < 0) return null;

  const at = text.lastIndexOf('@', caret - 1);
  if (at === -1) return null;

  if (at > 0) {
    const prev = text[at - 1];
    if (/[A-Za-z0-9_./\\-]/.test(prev)) {
      return null;
    }
  }

  const query = text.slice(at + 1, caret);
  if ([...query].some((char) => !isTokenChar(char))) {
    return null;
  }

  let end = caret;
  while (end < text.length && isTokenChar(text[end])) {
    end += 1;
  }

  return { start: at, end, query };
}

export function AtReferenceTextarea({
  value,
  onChange,
  repoPath,
  placeholder,
  rows = 5,
  disabled,
  className,
}: AtReferenceTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const requestIdRef = useRef(0);
  const [activeRef, setActiveRef] = useState<ActiveReference | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  function syncReferenceState(target: HTMLTextAreaElement) {
    if (!repoPath.trim() || disabled) {
      setActiveRef(null);
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    const next = findActiveReference(target.value, target.selectionStart ?? 0);
    setActiveRef(next);
    setSelectedIndex(0);
  }

  function handleInsert(path: string) {
    if (!activeRef) return;

    const before = value.slice(0, activeRef.start);
    const after = value.slice(activeRef.end);
    const nextValue = `${before}@${path} ${after}`;
    const nextCaret = before.length + path.length + 2;

    onChange(nextValue);
    setActiveRef(null);
    setSuggestions([]);

    window.requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
    });
  }

  useEffect(() => {
    if (!activeRef || !repoPath.trim() || disabled) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
    setIsLoading(true);

    const timer = window.setTimeout(async () => {
      try {
        const results = await invoke<string[]>('search_repo_files', {
          repoPath,
          query: activeRef.query || null,
        });

        if (requestIdRef.current !== currentRequestId) return;
        setSuggestions(results);
        setSelectedIndex(0);
      } catch {
        if (requestIdRef.current !== currentRequestId) return;
        setSuggestions([]);
      } finally {
        if (requestIdRef.current === currentRequestId) {
          setIsLoading(false);
        }
      }
    }, 120);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeRef, repoPath, disabled]);

  const showSuggestions = !!activeRef && !!repoPath.trim();

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          syncReferenceState(e.target);
        }}
        onClick={(e) => syncReferenceState(e.currentTarget)}
        onKeyUp={(e) => {
          if (showSuggestions && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
            return;
          }
          syncReferenceState(e.currentTarget);
        }}
        onSelect={(e) => syncReferenceState(e.currentTarget)}
        onBlur={() => {
          window.setTimeout(() => {
            setActiveRef(null);
            setSuggestions([]);
          }, 100);
        }}
        onKeyDown={(e) => {
          if (!showSuggestions) return;

          if (e.key === 'ArrowDown') {
            if (suggestions.length === 0) return;
            e.preventDefault();
            setSelectedIndex((index) => (index + 1) % suggestions.length);
            return;
          }

          if (e.key === 'ArrowUp') {
            if (suggestions.length === 0) return;
            e.preventDefault();
            setSelectedIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
            return;
          }

          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            const selected = suggestions[selectedIndex];
            if (selected) handleInsert(selected);
            return;
          }

          if (e.key === 'Escape') {
            e.preventDefault();
            setActiveRef(null);
            setSuggestions([]);
          }
        }}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className}
      />

      {showSuggestions && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-border bg-surface shadow-2xl overflow-hidden">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-text-dim border-b border-border bg-bg">
            Files
          </div>
          {isLoading ? (
            <div className="px-3 py-2 text-xs text-text-muted flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              Searching…
            </div>
          ) : suggestions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-dim">
              No matching files
            </div>
          ) : (
            suggestions.map((path, index) => (
              <button
                key={path}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleInsert(path);
                }}
                className={`w-full text-left px-3 py-2 text-xs font-mono transition-colors ${
                  index === selectedIndex
                    ? 'bg-accent/15 text-text'
                    : 'text-text-muted hover:bg-surface-raised hover:text-text'
                }`}
              >
                {path}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
