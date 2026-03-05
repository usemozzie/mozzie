import { create } from 'zustand';
import type { TicketStatus } from '@mozzie/db';

interface TicketStore {
  selectedTicketIds: string[];
  activeTicketId: string | null;
  viewMode: 'list' | 'detail';
  statusFilter: TicketStatus[];
  isNewTicketModalOpen: boolean;
  newTicketContextSeed: string;
  runErrorsByTicketId: Record<string, string>;

  selectTicket: (id: string | null) => void;
  toggleTicketSelection: (id: string) => void;
  removeSelectedTicket: (id: string) => void;
  clearSelectedTickets: () => void;
  openNewTicketModal: (contextSeed?: string) => void;
  closeNewTicketModal: () => void;
  setRunError: (ticketId: string, message: string) => void;
  clearRunError: (ticketId: string) => void;
  setViewMode: (mode: 'list' | 'detail') => void;
  setStatusFilter: (statuses: TicketStatus[]) => void;
  openTicketDetail: (id: string) => void;
  backToList: () => void;
}

export const useTicketStore = create<TicketStore>((set) => ({
  selectedTicketIds: [],
  activeTicketId: null,
  viewMode: 'list',
  statusFilter: [],
  isNewTicketModalOpen: false,
  newTicketContextSeed: '',
  runErrorsByTicketId: {},

  selectTicket: (id) => set({ selectedTicketIds: id ? [id] : [], activeTicketId: id }),
  toggleTicketSelection: (id) =>
    set((state) => {
      const isSelected = state.selectedTicketIds.includes(id);
      const selectedTicketIds = isSelected
        ? state.selectedTicketIds.filter((ticketId) => ticketId !== id)
        : [...state.selectedTicketIds, id];

      return {
        selectedTicketIds,
        activeTicketId:
          state.activeTicketId === id && isSelected
            ? selectedTicketIds[selectedTicketIds.length - 1] ?? null
            : state.activeTicketId,
      };
    }),
  removeSelectedTicket: (id) =>
    set((state) => {
      if (!state.selectedTicketIds.includes(id)) {
        return state;
      }

      const selectedTicketIds = state.selectedTicketIds.filter((ticketId) => ticketId !== id);
      return {
        selectedTicketIds,
        activeTicketId:
          state.activeTicketId === id
            ? selectedTicketIds[selectedTicketIds.length - 1] ?? null
            : state.activeTicketId,
        viewMode:
          state.activeTicketId === id && state.viewMode === 'detail'
            ? 'list'
            : state.viewMode,
      };
    }),
  clearSelectedTickets: () => set({ selectedTicketIds: [], activeTicketId: null }),
  openNewTicketModal: (contextSeed) =>
    set({
      isNewTicketModalOpen: true,
      newTicketContextSeed: contextSeed?.trim() ?? '',
    }),
  closeNewTicketModal: () =>
    set({
      isNewTicketModalOpen: false,
      newTicketContextSeed: '',
    }),
  setRunError: (ticketId, message) =>
    set((state) => ({
      runErrorsByTicketId: {
        ...state.runErrorsByTicketId,
        [ticketId]: message,
      },
    })),
  clearRunError: (ticketId) =>
    set((state) => {
      if (!state.runErrorsByTicketId[ticketId]) return state;
      const next = { ...state.runErrorsByTicketId };
      delete next[ticketId];
      return { runErrorsByTicketId: next };
    }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setStatusFilter: (statuses) => set({ statusFilter: statuses }),
  openTicketDetail: (id) =>
    set((state) => ({
      selectedTicketIds: state.selectedTicketIds.includes(id)
        ? state.selectedTicketIds
        : [...state.selectedTicketIds, id],
      activeTicketId: id,
      viewMode: 'detail',
    })),
  backToList: () => set({ viewMode: 'list' }),
}));
