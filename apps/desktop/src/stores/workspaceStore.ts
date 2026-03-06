import { create } from 'zustand';

const ACTIVE_WORKSPACE_KEY = 'mozzie.activeWorkspaceId';

interface WorkspaceStore {
  activeWorkspaceId: string;
  setActiveWorkspaceId: (id: string) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  activeWorkspaceId: localStorage.getItem(ACTIVE_WORKSPACE_KEY) || 'default',
  setActiveWorkspaceId: (id) => {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
    set({ activeWorkspaceId: id });
  },
}));
