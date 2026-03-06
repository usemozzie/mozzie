import { Plus, TicketCheck, GitFork, Settings } from 'lucide-react';
import { useSidebarStore, type SidebarView } from '../../stores/sidebarStore';
import { useTicketStore } from '../../stores/ticketStore';

interface IconSidebarProps {
  onSettingsClick: () => void;
}

export function IconSidebar({ onSettingsClick }: IconSidebarProps) {
  const { activeView, setActiveView } = useSidebarStore();
  const openNewTicketModal = useTicketStore((s) => s.openNewTicketModal);

  return (
    <div className="w-11 shrink-0 flex flex-col items-center py-2 gap-1 bg-bg border-r border-border">
      {/* New ticket */}
      <SidebarIcon
        icon={<Plus className="w-4 h-4" />}
        title="New Ticket"
        onClick={() => {
          setActiveView('tickets');
          openNewTicketModal();
        }}
      />

      <div className="w-5 h-px bg-border my-1" />

      {/* Tickets view */}
      <SidebarIcon
        icon={<TicketCheck className="w-4 h-4" />}
        title="Tickets"
        active={activeView === 'tickets'}
        onClick={() => setActiveView('tickets')}
      />

      {/* Repos view */}
      <SidebarIcon
        icon={<GitFork className="w-4 h-4" />}
        title="Repositories"
        active={activeView === 'repos'}
        onClick={() => setActiveView('repos')}
      />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Settings at bottom */}
      <SidebarIcon
        icon={<Settings className="w-4 h-4" />}
        title="Settings"
        onClick={onSettingsClick}
      />
    </div>
  );
}

function SidebarIcon({
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
