import { create } from 'zustand';

export type SidebarView = 'work-items' | 'repos';

interface SidebarStore {
  activeView: SidebarView;
  setActiveView: (view: SidebarView) => void;
}

export const useSidebarStore = create<SidebarStore>((set) => ({
  activeView: 'work-items',
  setActiveView: (view) => set({ activeView: view }),
}));
