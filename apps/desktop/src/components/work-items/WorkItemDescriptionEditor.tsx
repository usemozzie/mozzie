import type { KeyboardEventHandler } from 'react';
import { AtReferenceTextarea } from './AtReferenceTextarea';

interface WorkItemDescriptionEditorProps {
  value: string;
  onChange: (value: string) => void;
  repoPath: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  autosize?: boolean;
  maxRows?: number;
  editorClassName?: string;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  helperText?: string;
}

export function WorkItemDescriptionEditor({
  value,
  onChange,
  repoPath,
  placeholder,
  disabled,
  rows = 8,
  autosize = true,
  maxRows = 18,
  editorClassName = '',
  onKeyDown,
  helperText,
}: WorkItemDescriptionEditorProps) {
  return (
    <div className="w-full space-y-2">
      <AtReferenceTextarea
        value={value}
        onChange={onChange}
        repoPath={repoPath}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        autosize={autosize}
        maxRows={maxRows}
        onKeyDown={onKeyDown}
        className={`w-full text-[13px] leading-relaxed bg-surface border border-border rounded-xl px-3 py-2 text-text ${editorClassName}`.trim()}
      />
      <div className="text-[11px] text-text-dim">
        {helperText ?? (repoPath
          ? 'Type @ to search files from the selected repository.'
          : 'Select a repository to enable @file references.')}
      </div>
    </div>
  );
}
