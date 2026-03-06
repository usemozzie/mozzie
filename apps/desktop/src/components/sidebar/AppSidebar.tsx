import { useState } from 'react';
import {
  Plus,
  Search,
  TicketCheck,
  GitFork,
  Settings,
  Play,
  Loader2,
  Trash2,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSidebarStore, type SidebarView } from '../../stores/sidebarStore';
import { useTicketStore } from '../../stores/ticketStore';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useTickets } from '../../hooks/useTickets';
import { useRepos, useAddRepo, useRemoveRepo } from '../../hooks/useRepos';
import { useStartAgent } from '../../hooks/useStartAgent';
import { formatDistanceToNow } from '../../lib/time';
import { getTicketColor } from '../../lib/ticketColors';
import type { Ticket, Repo, TicketStatus } from '@mozzie/db';

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
  onSettingsClick: () => void;
  onCommandBarOpen: () => void;
}

export function AppSidebar({ collapsed, onSettingsClick, onCommandBarOpen }: AppSidebarProps) {
  const { activeView, setActiveView } = useSidebarStore();
  const openNewTicketModal = useTicketStore((s) => s.openNewTicketModal);

  /* ---- Collapsed: icon-only rail ---- */
  if (collapsed) {
    return (
      <div className="w-11 shrink-0 flex flex-col items-center py-2 gap-1 bg-bg border-r border-border">
        <IconButton
          icon={<Plus className="w-4 h-4" />}
          title="New Ticket"
          onClick={() => {
            setActiveView('tickets');
            openNewTicketModal();
          }}
        />
        <IconButton
          icon={<Search className="w-4 h-4" />}
          title="Orchestrator (Ctrl+K)"
          onClick={onCommandBarOpen}
        />

        <div className="w-5 h-px bg-border my-1" />

        <IconButton
          icon={<TicketCheck className="w-4 h-4" />}
          title="Tickets"
          active={activeView === 'tickets'}
          onClick={() => setActiveView('tickets')}
        />
        <IconButton
          icon={<GitFork className="w-4 h-4" />}
          title="Repositories"
          active={activeView === 'repos'}
          onClick={() => setActiveView('repos')}
        />

        <div className="flex-1" />

        <IconButton
          icon={<Settings className="w-4 h-4" />}
          title="Settings"
          onClick={onSettingsClick}
        />
      </div>
    );
  }

  /* ---- Expanded: full sidebar ---- */
  return (
    <div className="flex flex-col h-full bg-bg border-r border-border select-none" style={{ minWidth: 240, maxWidth: 500 }}>
      {/* Workspace switcher (Pro only) */}
      <div className="px-2 pt-2">
        <WorkspaceSwitcher />
      </div>

      {/* Top actions */}
      <div className="px-2 pt-1 pb-1 space-y-0.5">
        <NavAction
          icon={<Plus className="w-4 h-4" />}
          label="New Ticket"
          shortcut="Ctrl+N"
          onClick={() => {
            setActiveView('tickets');
            openNewTicketModal();
          }}
        />
        <NavAction
          icon={<Search className="w-4 h-4" />}
          label="Orchestrator"
          shortcut="Ctrl+K"
          onClick={onCommandBarOpen}
        />
      </div>

      <div className="mx-3 my-1.5 h-px bg-border" />

      {/* Navigation */}
      <div className="px-2 space-y-0.5">
        <NavItem
          icon={<TicketCheck className="w-4 h-4" />}
          label="Tickets"
          active={activeView === 'tickets'}
          onClick={() => setActiveView('tickets')}
        />
        <NavItem
          icon={<GitFork className="w-4 h-4" />}
          label="Repositories"
          active={activeView === 'repos'}
          onClick={() => setActiveView('repos')}
        />
        <NavItem
          icon={<Settings className="w-4 h-4" />}
          label="Settings"
          onClick={onSettingsClick}
        />
      </div>

      <div className="mx-3 my-1.5 h-px bg-border" />

      {/* Section label */}
      <div className="px-4 py-1.5">
        <span className="text-[11px] font-medium text-text-dim uppercase tracking-wider">
          {activeView === 'tickets' ? 'Recents' : 'Repositories'}
        </span>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeView === 'tickets' ? <TicketListSection /> : <RepoListSection />}
      </div>
    </div>
  );
}

/* ---- Collapsed icon button ---- */

function IconButton({
  icon,
  title,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150
        ${active
          ? 'bg-white/[0.10] text-text ring-1 ring-accent/40'
          : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
        }`}
    >
      {icon}
    </button>
  );
}

/* ---- Nav items ---- */

function NavAction({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-text hover:bg-white/[0.06] transition-colors"
    >
      <span className="w-5 h-5 flex items-center justify-center text-text-muted shrink-0">{icon}</span>
      <span className="text-[13px] font-medium flex-1 text-left">{label}</span>
      {shortcut && (
        <kbd className="text-[10px] text-text-dim bg-white/[0.04] px-1.5 py-0.5 rounded">{shortcut}</kbd>
      )}
    </button>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-colors
        ${active
          ? 'bg-white/[0.08] text-text'
          : 'text-text-muted hover:bg-white/[0.04] hover:text-text'
        }`}
    >
      <span className="w-5 h-5 flex items-center justify-center shrink-0">{icon}</span>
      <span className="text-[13px]">{label}</span>
    </button>
  );
}

/* ---- Ticket list (Recents) ---- */

function TicketListSection() {
  const { data: tickets, isLoading } = useTickets();
  const { selectedTicketIds, toggleTicketSelection } = useTicketStore();

  if (isLoading) {
    return <ListPlaceholder text="Loading..." />;
  }

  if (!tickets || tickets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-1.5 px-4 text-center">
        <p className="text-[13px] text-text-muted">No tickets yet</p>
        <p className="text-[11px] text-text-dim">Click + New Ticket to get started</p>
      </div>
    );
  }

  return (
    <div className="px-1">
      {tickets.map((ticket) => (
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

/* ---- Repo list ---- */

function RepoListSection() {
  const { data: repos, isLoading } = useRepos();
  const addRepo = useAddRepo();
  const removeRepo = useRemoveRepo();
  const [error, setError] = useState<string | null>(null);

  async function handleAddRepo() {
    setError(null);
    const selected = await open({ directory: true, title: 'Select a git repository' });
    if (!selected) return;
    const path = typeof selected === 'string' ? selected : selected;
    const name = path.split(/[\\/]/).filter(Boolean).pop() || 'repo';
    try {
      await addRepo.mutateAsync({ name, path });
    } catch (e: any) {
      setError(e?.toString() ?? 'Failed to add repository');
    }
  }

  if (isLoading) {
    return <ListPlaceholder text="Loading..." />;
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
        <FolderOpen className="w-8 h-8 text-text-dim opacity-30" />
        <p className="text-[13px] text-text-muted">No repositories</p>
        <p className="text-[11px] text-text-dim">Add repos so agents have context</p>
        <button
          onClick={handleAddRepo}
          className="mt-1 text-[12px] text-accent hover:underline"
        >
          + Add repository
        </button>
      </div>
    );
  }

  return (
    <div className="px-1">
      {error && (
        <div className="mx-2 mb-1 px-2 py-1.5 text-[11px] text-state-danger bg-state-danger/10 rounded-md">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}
      {repos.map((repo) => (
        <SidebarRepoRow
          key={repo.id}
          repo={repo}
          onRemove={() => removeRepo.mutate(repo.id)}
        />
      ))}
      <button
        onClick={handleAddRepo}
        className="w-full flex items-center gap-2.5 px-2.5 py-1.5 mt-1 rounded-lg text-text-dim hover:text-text hover:bg-white/[0.04] transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        <span className="text-[12px]">Add repository</span>
      </button>
    </div>
  );
}

function SidebarRepoRow({ repo, onRemove }: { repo: Repo; onRemove: () => void }) {
  return (
    <div className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors">
      <GitBranch className="w-3.5 h-3.5 text-text-dim shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-text truncate">{repo.name}</div>
        {repo.default_branch && (
          <div className="text-[10px] text-text-dim truncate">{repo.default_branch}</div>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-state-danger transition-all"
        title="Remove"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

/* ---- Shared ---- */

function ListPlaceholder({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-20 text-text-dim text-[13px]">{text}</div>
  );
}
