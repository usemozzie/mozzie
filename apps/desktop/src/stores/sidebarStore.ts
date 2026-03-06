import { create } from 'zustand';

export type SidebarView = 'tickets' | 'repos';

interface SidebarStore {
  activeView: SidebarView;
  setActiveView: (view: SidebarView) => void;
}

export const useSidebarStore = create<SidebarStore>((set) => ({
  activeView: 'tickets',
  setActiveView: (view) => set({ activeView: view }),
}));
