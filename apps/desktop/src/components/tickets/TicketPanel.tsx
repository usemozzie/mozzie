import { Plus } from 'lucide-react';
import { useTicketStore } from '../../stores/ticketStore';
import { Button } from '../ui/button';
import { TicketList } from './TicketList';
import { TicketDetail } from './TicketDetail';
import { NewTicketModal } from './NewTicketModal';

export function TicketPanel() {
  const {
    viewMode,
    isNewTicketModalOpen,
    newTicketContextSeed,
    openNewTicketModal,
    closeNewTicketModal,
  } = useTicketStore();

  return (
    <div className="flex flex-col h-full bg-bg border-r border-border" style={{ minWidth: 240, maxWidth: 500 }}>
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h1 className="text-[13px] font-semibold text-text tracking-tight">Tickets</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          title="New Ticket"
          onClick={() => openNewTicketModal()}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Content — full height ticket list (orchestrator moved to floating command bar) */}
      <div className="flex-1 min-h-0">
        {viewMode === 'list' ? <TicketList /> : <TicketDetail />}
      </div>

      {isNewTicketModalOpen && (
        <NewTicketModal
          onClose={closeNewTicketModal}
          initialContext={newTicketContextSeed}
        />
      )}
    </div>
  );
}
