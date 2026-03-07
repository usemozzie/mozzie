import { useMemo, useState } from 'react';
import {
  Plus,
  Play,
  Loader2,
  MoreHorizontal,
  ListFilter,
  Clock3,
  Layers3,
  ChevronRight,
} from 'lucide-react';
import { useTicketStore } from '../../stores/ticketStore';
import { useTickets } from '../../hooks/useTickets';
import { useStartAgent } from '../../hooks/useStartAgent';
import { getTicketColor } from '../../lib/ticketColors';
import type { Ticket, TicketStatus } from '@mozzie/db';

const statusDot: Record<TicketStatus, string> = {
  draft: 'bg-state-idle',
  ready: 'bg-state-active',
  blocked: 'bg-amber-500',
  queued: 'bg-state-active',
  running: 'bg-state-active dot-pulse',
  review: 'bg-state-waiting',
  done: 'bg-state-success',
  archived: 'bg-state-idle opacity-50',
};

interface AppSidebarProps {
  collapsed: boolean;
}

export function AppSidebar({ collapsed }: AppSidebarProps) {
  const openNewTicketModal = useTicketStore((s) => s.openNewTicketModal);

  if (collapsed) {
    return (
      <div className="w-11 shrink-0 flex flex-col items-center py-2 gap-1 bg-bg border-r border-border">
        <button
          onClick={() => openNewTicketModal()}
          title="New Ticket"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all duration-150"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-[260px] min-w-[260px] max-w-[260px] flex-col bg-bg border-r border-border select-none">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-dim">Tickets</span>
        <button
          onClick={() => openNewTicketModal()}
          className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
          title="New Ticket"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Ticket list */}
      <div className="flex-1 min-h-0">
        <TicketListSection />
      </div>
    </div>
  );
}

type TicketScope = 'active' | 'recent' | 'all';

const TICKET_SCOPE_OPTIONS: Array<{
  id: TicketScope;
  label: string;
  icon: typeof ListFilter;
}> = [
  { id: 'active', label: 'Active', icon: ListFilter },
  { id: 'recent', label: 'Recent', icon: Clock3 },
  { id: 'all', label: 'All', icon: Layers3 },
];

function TicketListSection() {
  const [scope, setScope] = useState<TicketScope>('active');
  const { data: tickets, isLoading } = useTickets();
  const { selectedTicketIds, toggleTicketSelection } = useTicketStore();

  if (isLoading) {
    return <div className="flex items-center justify-center h-20 text-text-dim text-[13px]">Loading...</div>;
  }

  const now = Date.now();
  const recentCutoffMs = 1000 * 60 * 60 * 24 * 7;
  const filteredTickets = (tickets ?? []).filter((ticket) => {
    if (scope === 'active') return ticket.status !== 'done' && ticket.status !== 'archived';
    if (scope === 'recent') return now - new Date(ticket.updated_at).getTime() <= recentCutoffMs;
    return true;
  });

  if (!tickets || tickets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-1.5 px-4 text-center">
        <p className="text-[13px] text-text-muted">No tickets yet</p>
        <p className="text-[11px] text-text-dim">Click + to create one</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Scope filter */}
      <div className="shrink-0 px-2 pb-2">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.03] p-0.5">
          {TICKET_SCOPE_OPTIONS.map(({ id, label, icon: Icon }) => {
            const active = scope === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setScope(id)}
                className={`flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                  active
                    ? 'bg-white/[0.10] text-text'
                    : 'text-text-dim hover:bg-white/[0.05] hover:text-text'
                }`}
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* List grouped by repo */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-0.5">
        {filteredTickets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <p className="text-[13px] text-text-muted">
              {scope === 'active' ? 'No active tickets' : scope === 'recent' ? 'No recent tickets' : 'No tickets'}
            </p>
          </div>
        ) : (
          <GroupedTicketList tickets={filteredTickets} selectedTicketIds={selectedTicketIds} toggleTicketSelection={toggleTicketSelection} />
        )}
      </div>

      {/* Count */}
      <div className="shrink-0 px-3 py-1.5 border-t border-border">
        <span className="text-[10px] text-text-dim">{filteredTickets.length} of {tickets.length}</span>
      </div>
    </div>
  );
}

function getRepoName(repoPath: string | null): string {
  if (!repoPath) return 'No repo';
  return repoPath.split(/[/\\]/).filter(Boolean).pop() || repoPath;
}

function GroupedTicketList({
  tickets,
  selectedTicketIds,
  toggleTicketSelection,
}: {
  tickets: Ticket[];
  selectedTicketIds: string[];
  toggleTicketSelection: (id: string) => void;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const ticket of tickets) {
      const key = ticket.repo_path ?? '__none__';
      const list = map.get(key);
      if (list) list.push(ticket);
      else map.set(key, [ticket]);
    }
    // Sort: repos with tickets first, "No repo" last
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === '__none__') return 1;
      if (b === '__none__') return -1;
      return getRepoName(a).localeCompare(getRepoName(b));
    });
  }, [tickets]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Single group — skip header
  if (groups.length === 1) {
    return (
      <>
        {groups[0][1].map((ticket) => (
          <SidebarTicketRow
            key={ticket.id}
            ticket={ticket}
            isSelected={selectedTicketIds.includes(ticket.id)}
            selectedIndex={selectedTicketIds.indexOf(ticket.id)}
            onClick={() => toggleTicketSelection(ticket.id)}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {groups.map(([key, groupTickets]) => {
        const collapsed = collapsedGroups.has(key);
        const label = key === '__none__' ? 'No repo' : getRepoName(key);
        return (
          <div key={key} className="mb-1">
            <button
              type="button"
              onClick={() => toggleGroup(key)}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-dim hover:text-text transition-colors"
            >
              <ChevronRight className={`w-3 h-3 shrink-0 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`} />
              <span className="truncate">{label}</span>
              <span className="ml-auto text-text-dim/50 tabular-nums">{groupTickets.length}</span>
            </button>
            {!collapsed && groupTickets.map((ticket) => (
              <SidebarTicketRow
                key={ticket.id}
                ticket={ticket}
                isSelected={selectedTicketIds.includes(ticket.id)}
                selectedIndex={selectedTicketIds.indexOf(ticket.id)}
                onClick={() => toggleTicketSelection(ticket.id)}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

function SidebarTicketRow({
  ticket,
  isSelected,
  selectedIndex,
  onClick,
}: {
  ticket: Ticket;
  isSelected: boolean;
  selectedIndex: number;
  onClick: () => void;
}) {
  const { startAgent, isStarting } = useStartAgent();
  const selectTicket = useTicketStore((s) => s.selectTicket);
  const openTicketDetail = useTicketStore((s) => s.openTicketDetail);
  const [showMenu, setShowMenu] = useState(false);
  const isReady = ticket.status === 'ready';
  const accent = getTicketColor(selectedIndex);

  return (
    <div className="relative group">
      <button
        onClick={onClick}
        onDoubleClick={() => openTicketDetail(ticket.id)}
        style={isSelected ? { background: `${accent}0D`, boxShadow: `inset 2px 0 0 ${accent}` } : undefined}
        className={`w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors duration-100
          ${isSelected ? '' : 'hover:bg-white/[0.04]'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[ticket.status]}`} />
        <span className="flex-1 text-[13px] text-text truncate min-w-0">
          {ticket.title || <span className="italic text-text-dim">Untitled</span>}
        </span>
      </button>

      {/* Hover actions */}
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isReady && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              selectTicket(ticket.id);
              void startAgent(ticket);
            }}
            disabled={isStarting}
            title="Start agent"
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-state-success hover:bg-state-success/10 transition-colors"
          >
            {isStarting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
          className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setShowMenu(false)} />
          <div className="absolute right-1 top-full mt-1 z-40 w-36 bg-surface border border-border rounded-lg shadow-xl py-1">
            <button
              onClick={() => { openTicketDetail(ticket.id); setShowMenu(false); }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-text hover:bg-white/[0.06] transition-colors"
            >
              Open details
            </button>
          </div>
        </>
      )}
    </div>
  );
}
