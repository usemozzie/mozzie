import type { KeyboardEventHandler } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';

interface ActiveReference {
  start: number;
  end: number;
  query: string;
  trigger: '@' | '/';
}

export interface SlashCommandOption {
  command: string;
  description?: string;
}

interface SuggestionOption {
  value: string;
  description?: string;
}

interface AtReferenceTextareaProps {
  value: string;
  onChange: (value: string) => void;
  repoPath: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  slashCommands?: SlashCommandOption[];
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  autosize?: boolean;
  maxRows?: number;
}

function isTokenChar(char: string) {
  return /[A-Za-z0-9_./\\-]/.test(char);
}

function findActiveReference(text: string, caret: number, triggers: Array<'@' | '/'>): ActiveReference | null {
  if (caret < 0) return null;

  let bestMatch: ActiveReference | null = null;

  for (const trigger of triggers) {
    const index = text.lastIndexOf(trigger, caret - 1);
    if (index === -1) continue;

    if (index > 0) {
      const prev = text[index - 1];
      if (isTokenChar(prev)) {
        continue;
      }
    }

    const query = text.slice(index + 1, caret);
    if ([...query].some((char) => !isTokenChar(char))) {
      continue;
    }

    let end = caret;
    while (end < text.length && isTokenChar(text[end])) {
      end += 1;
    }

    if (!bestMatch || index > bestMatch.start) {
      bestMatch = { start: index, end, query, trigger };
    }
  }

  return bestMatch;
}

export function AtReferenceTextarea({
  value,
  onChange,
  repoPath,
  placeholder,
  rows = 5,
  disabled,
  className,
  slashCommands = [],
  onKeyDown,
  autosize = false,
  maxRows = 6,
}: AtReferenceTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const [activeRef, setActiveRef] = useState<ActiveReference | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  function syncReferenceState(target: HTMLTextAreaElement) {
    if (disabled) {
      setActiveRef(null);
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    const triggers: Array<'@' | '/'> = [];
    if (repoPath.trim()) {
      triggers.push('@');
    }
    if (slashCommands.length > 0) {
      triggers.push('/');
    }

    if (triggers.length === 0) {
      setActiveRef(null);
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    const next = findActiveReference(target.value, target.selectionStart ?? 0, triggers);
    setActiveRef(next);
    setSelectedIndex(0);
  }

  function handleInsert(suggestion: SuggestionOption) {
    if (!activeRef) return;

    const before = value.slice(0, activeRef.start);
    const after = value.slice(activeRef.end);
    const nextValue = `${before}${activeRef.trigger}${suggestion.value} ${after}`;
    const nextCaret = before.length + suggestion.value.length + 2;

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
    const requiresRepoPath = activeRef?.trigger === '@';

    if (!activeRef || disabled || (requiresRepoPath && !repoPath.trim())) {
      requestIdRef.current += 1;
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    if (activeRef.trigger === '/') {
      requestIdRef.current += 1;
      const query = activeRef.query.toLowerCase();
      const nextSuggestions = slashCommands
        .filter(({ command }) =>
          query.length === 0 || command.toLowerCase().startsWith(query) || command.toLowerCase().includes(query),
        )
        .slice(0, 12)
        .map((command) => ({
          value: command.command,
          description: command.description,
        }));

      setSuggestions(nextSuggestions);
      setSelectedIndex(0);
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
        setSuggestions(results.map((path) => ({ value: path })));
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
  }, [activeRef, repoPath, disabled, slashCommands]);

  const showSuggestions = !!activeRef && (
    (activeRef.trigger === '@' && !!repoPath.trim()) ||
    (activeRef.trigger === '/' && slashCommands.length > 0)
  );

  useEffect(() => {
    if (popoverRef.current) {
      const active = popoverRef.current.querySelector('[data-active="true"]');
      active?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  useLayoutEffect(() => {
    if (!autosize) {
      return;
    }

    const node = textareaRef.current;
    if (!node) {
      return;
    }

    const styles = window.getComputedStyle(node);
    const borderHeight = parseFloat(styles.borderTopWidth || '0') + parseFloat(styles.borderBottomWidth || '0');
    const paddingHeight = parseFloat(styles.paddingTop || '0') + parseFloat(styles.paddingBottom || '0');
    const lineHeight = parseFloat(styles.lineHeight || '20');
    const minHeight = borderHeight + paddingHeight + (lineHeight * rows);
    const maxHeight = borderHeight + paddingHeight + (lineHeight * maxRows);

    node.style.height = '0px';
    const nextHeight = Math.min(Math.max(node.scrollHeight, minHeight), maxHeight);
    node.style.height = `${nextHeight}px`;
    node.style.overflowY = node.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [autosize, maxRows, rows, value]);

  return (
    <div className="relative w-full">
      <textarea
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
          if (!showSuggestions) {
            onKeyDown?.(e);
            return;
          }

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
            return;
          }

          onKeyDown?.(e);
        }}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className}
      />

      {showSuggestions && (
        <div
          ref={popoverRef}
          className="absolute left-0 right-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto
          rounded-xl border border-border bg-surface shadow-xl shadow-black/30 py-1"
        >
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-dim/50">
            {activeRef?.trigger === '@' ? 'Files' : 'Commands'}
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-text-dim">
              <Loader2 className="w-3 h-3 animate-spin" />
              Searching...
            </div>
          ) : suggestions.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-text-dim">
              {activeRef?.trigger === '@' ? 'No matching files' : 'No matching commands'}
            </div>
          ) : (
            suggestions.map((suggestion, index) => (
              <button
                key={`${activeRef?.trigger}:${suggestion.value}`}
                type="button"
                data-active={index === selectedIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleInsert(suggestion);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 transition-colors
                  ${index === selectedIndex
                    ? 'bg-white/[0.08] text-text'
                    : 'text-text-dim hover:bg-white/[0.04]'
                  }`}
              >
                <span className="truncate font-mono">
                  {activeRef?.trigger === '/' ? `/${suggestion.value}` : suggestion.value}
                </span>
                {suggestion.description && (
                  <span className="ml-auto text-[11px] text-text-dim/50 truncate max-w-[140px]">
                    {suggestion.description}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
