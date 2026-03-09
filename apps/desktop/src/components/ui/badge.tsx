import * as React from 'react';
import type { WorkItemStatus } from '@mozzie/db';

const statusConfig: Record<
  WorkItemStatus,
  { dot: string; bg: string; text: string; label: string; animate?: boolean }
> = {
  draft:    { dot: 'bg-state-idle',    bg: 'bg-state-idle/10',    text: 'text-zinc-400',    label: 'Draft' },
  ready:    { dot: 'bg-state-active',  bg: 'bg-state-active/10',  text: 'text-emerald-400', label: 'Ready' },
  blocked:  { dot: 'bg-amber-500',     bg: 'bg-amber-500/10',     text: 'text-amber-400',   label: 'Blocked' },
  queued:   { dot: 'bg-state-active',  bg: 'bg-state-active/10',  text: 'text-emerald-300', label: 'Queued' },
  running:  { dot: 'bg-state-active',  bg: 'bg-state-active/10',  text: 'text-emerald-300', label: 'Running', animate: true },
  review:   { dot: 'bg-state-waiting', bg: 'bg-state-waiting/10', text: 'text-amber-400',   label: 'Review' },
  done:     { dot: 'bg-state-success', bg: 'bg-state-success/10', text: 'text-emerald-400', label: 'Done' },
  archived: { dot: 'bg-state-idle',    bg: 'bg-state-idle/10',    text: 'text-zinc-500',    label: 'Archived' },
};

interface StatusBadgeProps {
  status: WorkItemStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const cfg = statusConfig[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${cfg.bg} shrink-0`}>
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}${cfg.animate ? ' dot-pulse' : ''}`}
      />
      <span className={`text-[10px] font-semibold tracking-wider uppercase ${cfg.text}`}>
        {cfg.label}
      </span>
    </span>
  );
}
