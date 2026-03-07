import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import logo from './assets/icon.svg';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { NotebookPen, Settings, GitFork, PanelLeftClose, PanelLeftOpen, Command, Minus, Square, X } from 'lucide-react';
import { TerminalGrid } from './components/terminal/TerminalGrid';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { NotesPanel } from './components/notes/NotesPanel';
import { ReposPanel } from './components/repos/ReposPanel';
import { FloatingCommandBar } from './components/tickets/FloatingCommandBar';
import { NewTicketModal } from './components/tickets/NewTicketModal';
import { AppSidebar } from './components/sidebar/AppSidebar';
import { WorkspaceSwitcher } from './components/sidebar/WorkspaceSwitcher';
import { useTerminalStore } from './stores/terminalStore';
import { useTicketStore } from './stores/ticketStore';
import { useAutoLaunchUnblocked } from './hooks/useAutoLaunchUnblocked';
import type { TicketStateChangeEvent } from './types/events';

// ---- Status bar ----
function StatusBar() {
  const activeSlots = useTerminalStore((s) => s.activeSlots);
  const runningCount = activeSlots.size;

  return (
    <div className="h-6 shrink-0 flex items-center gap-3 px-4 select-none border-t border-border bg-surface">
      <div className="flex items-center gap-1.5">
        {runningCount > 0 ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-state-active dot-pulse" />
            <span className="text-[11px] text-state-active">
              {runningCount} agent{runningCount !== 1 ? 's' : ''} running
            </span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-text-dim" />
            <span className="text-[11px] text-text-dim">Idle</span>
          </>
        )}
      </div>
      <span className="ml-auto text-[11px] text-text-dim opacity-40">Mozzie v0.1</span>
    </div>
  );
}

// ---- App ----
export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [reposOpen, setReposOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const appWindow = getCurrentWindow();
  const allowCloseRef = useRef(false);
  const releaseSlotForTicket = useTerminalStore((s) => s.releaseSlotForTicket);
  const removeSelectedTicket = useTicketStore((s) => s.removeSelectedTicket);
  const { isNewTicketModalOpen, newTicketContextSeed, closeNewTicketModal } = useTicketStore();

  // Auto-launch tickets whose dependencies just got approved
  useAutoLaunchUnblocked();

  const handleToolbarMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, [data-no-drag]')) return;

    if (e.detail === 2) {
      void appWindow.toggleMaximize();
      return;
    }

    void appWindow.startDragging();
  };

  // Global Cmd+K / Ctrl+K to toggle command bar
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandBarOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const unlisten = listen<TicketStateChangeEvent>('ticket:state-change', (event) => {
      if (['ready', 'review', 'done', 'archived'].includes(event.payload.to)) {
        releaseSlotForTicket(event.payload.ticketId);
      }
      if (['done', 'archived', 'deleted'].includes(event.payload.to)) {
        removeSelectedTicket(event.payload.ticketId);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [releaseSlotForTicket, removeSelectedTicket]);

  useEffect(() => {
    const unlisten = appWindow.onCloseRequested(async (event) => {
      if (allowCloseRef.current) {
        return;
      }

      event.preventDefault();
      allowCloseRef.current = true;

      try {
        await invoke('shutdown_all_agent_sessions');
      } catch {
        // Best-effort cleanup before destroying the window.
      }

      await appWindow.destroy();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [appWindow]);

  return (
    <div className="flex flex-col h-screen bg-bg text-text overflow-hidden">
      {/* Toolbar */}
      <div
        className="h-10 shrink-0 flex items-center px-4 border-b border-border select-none bg-surface relative"
        onMouseDown={handleToolbarMouseDown}
      >
        <div className="flex items-center gap-2">
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all duration-150"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
          </button>
          <img src={logo} alt="Mozzie" className="w-5 h-5" />
          <span className="text-[13px] font-semibold text-text tracking-tight">Mozzie</span>
          <div data-no-drag className="ml-1">
            <WorkspaceSwitcher />
          </div>
        </div>

        {/* Command bar trigger — centered */}
        <button
          onClick={() => setCommandBarOpen(true)}
          className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-text-dim hover:text-text bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] transition-all duration-150"
          title="Orchestrator (Ctrl+K)"
        >
          <Command className="w-3 h-3" />
          <span className="text-[11px]">Orchestrator</span>
          <kbd className="text-[10px] text-text-dim bg-white/[0.04] px-1 py-0.5 rounded ml-1">Ctrl+K</kbd>
        </button>

        <div className="flex items-center ml-auto gap-0.5">
          <button
            onClick={() => setReposOpen((v) => !v)}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-150
              ${reposOpen
                ? 'text-text bg-white/[0.10] ring-1 ring-accent/40'
                : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
              }`}
            title="Repositories"
          >
            <GitFork className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setNotesOpen((v) => !v)}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-150
              ${notesOpen
                ? 'text-text bg-white/[0.10] ring-1 ring-accent/40'
                : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
              }`}
            title="Notes"
          >
            <NotebookPen className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-150
              ${settingsOpen
                ? 'text-text bg-white/[0.10] ring-1 ring-accent/40'
                : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
              }`}
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          {/* Window controls */}
          <div className="flex items-center ml-2 -mr-2">
            <button
              onClick={() => appWindow.minimize()}
              className="w-10 h-10 flex items-center justify-center text-text-dim hover:text-text hover:bg-white/[0.08] transition-colors"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => appWindow.toggleMaximize()}
              className="w-10 h-10 flex items-center justify-center text-text-dim hover:text-text hover:bg-white/[0.08] transition-colors"
            >
              <Square className="w-3 h-3" />
            </button>
            <button
              onClick={() => appWindow.close()}
              className="w-10 h-10 flex items-center justify-center text-text-dim hover:text-white hover:bg-red-500/80 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar — always rendered, toggles between icon-only and full */}
        <AppSidebar collapsed={sidebarCollapsed} />

        {/* Resize handle — only visible when sidebar is expanded */}
        {!sidebarCollapsed && (
          <div className="w-px bg-border hover:bg-accent/50 transition-colors cursor-col-resize shrink-0" />
        )}

        {/* Main content */}
        <div className="flex-1 min-w-0 flex flex-col h-full">
          <PanelGroup
            direction="horizontal"
            autoSaveId="mozzie-main-panels"
            className="flex-1 min-h-0"
          >
            <Panel
              id="agents"
              order={1}
              minSize={30}
              className="flex flex-col h-full min-w-0"
            >
              <TerminalGrid />
            </Panel>

            {reposOpen && (
              <>
                <PanelResizeHandle className="w-px bg-border hover:bg-accent/50 transition-colors cursor-col-resize" />
                <Panel
                  id="repos"
                  order={2}
                  minSize={15}
                  maxSize={30}
                  defaultSize={18}
                  className="flex flex-col h-full min-w-0"
                >
                  <ReposPanel onClose={() => setReposOpen(false)} />
                </Panel>
              </>
            )}

            {notesOpen && (
              <>
                <PanelResizeHandle className="w-px bg-border hover:bg-accent/50 transition-colors cursor-col-resize" />
                <Panel
                  id="notes"
                  order={3}
                  minSize={15}
                  maxSize={40}
                  defaultSize={22}
                  className="flex flex-col h-full min-w-0"
                >
                  <NotesPanel onClose={() => setNotesOpen(false)} />
                </Panel>
              </>
            )}

            {settingsOpen && (
              <>
                <PanelResizeHandle className="w-px bg-border hover:bg-accent/50 transition-colors cursor-col-resize" />
                <Panel
                  id="settings"
                  order={4}
                  minSize={20}
                  maxSize={45}
                  defaultSize={28}
                  className="flex flex-col h-full min-w-0"
                >
                  <SettingsPanel onClose={() => setSettingsOpen(false)} />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>

      <StatusBar />

      {/* New ticket modal (triggered from sidebar) */}
      {isNewTicketModalOpen && (
        <NewTicketModal
          onClose={closeNewTicketModal}
          initialContext={newTicketContextSeed}
        />
      )}

      {/* Floating command bar overlay */}
      {commandBarOpen && (
        <FloatingCommandBar onClose={() => setCommandBarOpen(false)} />
      )}
    </div>
  );
}
