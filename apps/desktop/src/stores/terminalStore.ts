import { create } from 'zustand';

const MAX_SLOTS = 8;

export interface AgentProcessInfo {
  processId: string;
  ticketId: string;
  startedAt: number; // epoch ms
}

interface TerminalStore {
  activeSlots: Map<number, string>; // slot → ticketId
  focusedSlot: number | null;
  maximizedSlot: number | null;
  agentProcesses: Map<number, AgentProcessInfo>; // slot → process info

  assignSlot: (slot: number, ticketId: string) => void;
  releaseSlot: (slot: number) => void;
  releaseSlotForTicket: (ticketId: string) => void;
  focusSlot: (slot: number | null) => void;
  toggleMaximize: (slot: number) => void;
  getNextAvailableSlot: () => number | null;

  setAgentProcess: (slot: number, info: AgentProcessInfo) => void;
  clearAgentProcess: (slot: number) => void;
  getAgentProcess: (slot: number) => AgentProcessInfo | null;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  activeSlots: new Map(),
  focusedSlot: null,
  maximizedSlot: null,
  agentProcesses: new Map(),

  assignSlot: (slot, ticketId) =>
    set((state) => {
      const next = new Map(state.activeSlots);
      next.set(slot, ticketId);
      return { activeSlots: next };
    }),

  releaseSlot: (slot) =>
    set((state) => {
      const nextSlots = new Map(state.activeSlots);
      nextSlots.delete(slot);
      const nextProcs = new Map(state.agentProcesses);
      nextProcs.delete(slot);
      return {
        activeSlots: nextSlots,
        agentProcesses: nextProcs,
        focusedSlot: state.focusedSlot === slot ? null : state.focusedSlot,
        maximizedSlot: state.maximizedSlot === slot ? null : state.maximizedSlot,
      };
    }),

  releaseSlotForTicket: (ticketId) =>
    set((state) => {
      let matchedSlot: number | null = null;

      for (const [slot, activeTicketId] of state.activeSlots.entries()) {
        if (activeTicketId === ticketId) {
          matchedSlot = slot;
          break;
        }
      }

      if (matchedSlot === null) {
        return state;
      }

      const nextSlots = new Map(state.activeSlots);
      nextSlots.delete(matchedSlot);
      const nextProcs = new Map(state.agentProcesses);
      nextProcs.delete(matchedSlot);

      return {
        activeSlots: nextSlots,
        agentProcesses: nextProcs,
        focusedSlot: state.focusedSlot === matchedSlot ? null : state.focusedSlot,
        maximizedSlot: state.maximizedSlot === matchedSlot ? null : state.maximizedSlot,
      };
    }),

  focusSlot: (slot) => set({ focusedSlot: slot }),

  toggleMaximize: (slot) =>
    set((state) => ({
      maximizedSlot: state.maximizedSlot === slot ? null : slot,
    })),

  getNextAvailableSlot: () => {
    const { activeSlots } = get();
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (!activeSlots.has(i)) return i;
    }
    return null;
  },

  setAgentProcess: (slot, info) =>
    set((state) => {
      const next = new Map(state.agentProcesses);
      next.set(slot, info);
      return { agentProcesses: next };
    }),

  clearAgentProcess: (slot) =>
    set((state) => {
      const next = new Map(state.agentProcesses);
      next.delete(slot);
      return { agentProcesses: next };
    }),

  getAgentProcess: (slot) => get().agentProcesses.get(slot) ?? null,
}));
