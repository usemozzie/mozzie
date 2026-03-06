import { Play, Loader2, GitBranch } from 'lucide-react';
import type { Ticket, TicketStatus } from '@mozzie/db';
import { formatDistanceToNow } from '../../lib/time';
import { useStartAgent } from '../../hooks/useStartAgent';
import { useTicketDependencies } from '../../hooks/useDependencies';
import { getTicketColor } from '../../lib/ticketColors';
import { useTicketStore } from '../../stores/ticketStore';

// Traffic-light state colors
const statusDot: Record<TicketStatus, string> = {
  draft:    'bg-state-idle',
  ready:    'bg-state-active',
  blocked:  'bg-amber-500',
  queued:   'bg-state-active',
  running:  'bg-state-active dot-pulse',
  review:   'bg-state-waiting',
  done:     'bg-state-success',
  archived: 'bg-state-idle opacity-50',
};

interface TicketCardProps {
  ticket: Ticket;
  isSelected: boolean;
  selectedIndex: number;
  onClick: () => void;
}

export function TicketCard({ ticket, isSelected, selectedIndex, onClick }: TicketCardProps) {
  const { startAgent, isStarting } = useStartAgent();
  const runError = useTicketStore((s) => s.runErrorsByTicketId[ticket.id]);
  const selectTicket = useTicketStore((s) => s.selectTicket);
  const { data: deps } = useTicketDependencies(ticket.id);
  const isReady = ticket.status === 'ready';
  const isBlocked = ticket.status === 'blocked';
  const hasDeps = deps && deps.length > 0;
  const accent = getTicketColor(selectedIndex);

  return (
    <div className="relative group">
      <button
        onClick={onClick}
        style={isSelected ? { boxShadow: `inset 2px 0 0 ${accent}`, background: `${accent}0D` } : undefined}
        className={`w-full text-left flex items-center gap-2.5 px-3 h-10 select-none transition-colors duration-100
          ${isSelected ? '' : 'hover:bg-surface'}
          ${isReady ? 'pr-8' : ''}`}
      >
        {/* Status dot */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[ticket.status]}`} />

        {/* Title — 30% Primary: bold, high contrast */}
        <span className="flex-1 text-[13px] font-medium text-text truncate min-w-0">
          {ticket.title || <span className="italic text-text-dim font-normal">Untitled</span>}
        </span>

        {/* Right meta — 60% Neutral: smaller, dimmer */}
        <div className="flex items-center gap-2 shrink-0">
          {hasDeps && (
            <span className="flex items-center gap-0.5 text-[10px] text-amber-400 opacity-70" title={`${deps.length} dep${deps.length > 1 ? 's' : ''}`}>
              <GitBranch className="w-2.5 h-2.5" />
              {deps.length}
            </span>
          )}
          {isBlocked && (
            <span className="text-[10px] text-amber-400 font-medium">blocked</span>
          )}
          {ticket.assigned_agent && (
            <span className="text-[10px] text-text-dim opacity-50 max-w-[70px] truncate">
              {ticket.assigned_agent}
            </span>
          )}
          <span className="text-[10px] text-text-dim opacity-40 w-12 text-right">
            {formatDistanceToNow(ticket.updated_at)}
          </span>
        </div>
      </button>

      {/* Error tooltip */}
      {runError && (
        <div className="absolute left-3 right-3 bottom-full mb-1 text-[11px] text-red-400 bg-bg border border-red-500/20 rounded px-2 py-1 z-10 pointer-events-none">
          {runError}
        </div>
      )}

      {/* Play button */}
      {isReady && (
        <button
          onClick={() => {
            selectTicket(ticket.id);
            void startAgent(ticket);
          }}
          disabled={isStarting}
          title="Start agent"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md
            text-text-dim opacity-0 group-hover:opacity-100
            hover:text-state-success hover:bg-state-success/10
            transition-all duration-150 disabled:opacity-30"
        >
          {isStarting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Play className="w-3 h-3" />
          )}
        </button>
      )}
    </div>
  );
}
