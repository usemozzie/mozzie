import { useTickets } from '../../hooks/useTickets';
import { useTicketStore } from '../../stores/ticketStore';
import { TicketCard } from './TicketCard';

export function TicketList() {
  const { data: tickets, isLoading, isError } = useTickets();
  const { selectedTicketIds, toggleTicketSelection } = useTicketStore();

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-text-dim text-[13px]">
        Loading...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="h-full flex items-center justify-center text-state-danger text-[13px] px-4 text-center">
        Failed to load tickets.
      </div>
    );
  }

  if (!tickets || tickets.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-1.5 px-4 text-center">
        <p className="text-[13px] text-text-muted">No tickets yet</p>
        <p className="text-[11px] text-text-dim">Click + to create your first ticket</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {tickets.map((ticket) => (
        <TicketCard
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
