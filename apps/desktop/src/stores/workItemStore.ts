import { create } from 'zustand';
import type { WorkItemStatus } from '@mozzie/db';

interface WorkItemStore {
  selectedWorkItemIds: string[];
  activeWorkItemId: string | null;
  statusFilter: WorkItemStatus[];
  isNewWorkItemModalOpen: boolean;
  newWorkItemContextSeed: string;
  runErrorsByWorkItemId: Record<string, string>;

  selectWorkItem: (id: string | null) => void;
  toggleWorkItemSelection: (id: string) => void;
  removeSelectedWorkItem: (id: string) => void;
  clearSelectedWorkItems: () => void;
  openNewWorkItemModal: (contextSeed?: string) => void;
  closeNewWorkItemModal: () => void;
  setRunError: (workItemId: string, message: string) => void;
  clearRunError: (workItemId: string) => void;
  setStatusFilter: (statuses: WorkItemStatus[]) => void;
}

export const useWorkItemStore = create<WorkItemStore>((set) => ({
  selectedWorkItemIds: [],
  activeWorkItemId: null,
  statusFilter: [],
  isNewWorkItemModalOpen: false,
  newWorkItemContextSeed: '',
  runErrorsByWorkItemId: {},

  selectWorkItem: (id) => set({ selectedWorkItemIds: id ? [id] : [], activeWorkItemId: id }),
  toggleWorkItemSelection: (id) =>
    set((state) => {
      const isSelected = state.selectedWorkItemIds.includes(id);
      const selectedWorkItemIds = isSelected
        ? state.selectedWorkItemIds.filter((workItemId) => workItemId !== id)
        : [...state.selectedWorkItemIds, id];

      return {
        selectedWorkItemIds,
        activeWorkItemId:
          state.activeWorkItemId === id && isSelected
            ? selectedWorkItemIds[selectedWorkItemIds.length - 1] ?? null
            : state.activeWorkItemId,
      };
    }),
  removeSelectedWorkItem: (id) =>
    set((state) => {
      if (!state.selectedWorkItemIds.includes(id)) {
        return state;
      }

      const selectedWorkItemIds = state.selectedWorkItemIds.filter((workItemId) => workItemId !== id);
      return {
        selectedWorkItemIds,
        activeWorkItemId:
          state.activeWorkItemId === id
            ? selectedWorkItemIds[selectedWorkItemIds.length - 1] ?? null
            : state.activeWorkItemId,
      };
    }),
  clearSelectedWorkItems: () => set({ selectedWorkItemIds: [], activeWorkItemId: null }),
  openNewWorkItemModal: (contextSeed) =>
    set({
      isNewWorkItemModalOpen: true,
      newWorkItemContextSeed: contextSeed?.trim() ?? '',
    }),
  closeNewWorkItemModal: () =>
    set({
      isNewWorkItemModalOpen: false,
      newWorkItemContextSeed: '',
    }),
  setRunError: (workItemId, message) =>
    set((state) => ({
      runErrorsByWorkItemId: {
        ...state.runErrorsByWorkItemId,
        [workItemId]: message,
      },
    })),
  clearRunError: (workItemId) =>
    set((state) => {
      if (!state.runErrorsByWorkItemId[workItemId]) return state;
      const next = { ...state.runErrorsByWorkItemId };
      delete next[workItemId];
      return { runErrorsByWorkItemId: next };
    }),
  setStatusFilter: (statuses) => set({ statusFilter: statuses }),
}));
