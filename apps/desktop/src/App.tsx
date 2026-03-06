import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import logo from './assets/icon.svg';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { NotebookPen, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { TicketPanel } from './components/tickets/TicketPanel';
import { TerminalGrid } from './components/terminal/TerminalGrid';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { NotesPanel } from './components/notes/NotesPanel';
import { FloatingCommandBar } from './components/tickets/FloatingCommandBar';
import { useTerminalStore } from './stores/terminalStore';
import { useTicketStore } from './stores/ticketStore';
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const releaseSlotForTicket = useTerminalStore((s) => s.releaseSlotForTicket);
  const removeSelectedTicket = useTicketStore((s) => s.removeSelectedTicket);

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

  return (
    <div className="flex flex-col h-screen bg-bg text-text overflow-hidden">
      {/* Toolbar */}
      <div
        className="h-10 shrink-0 flex items-center px-4 border-b border-border select-none bg-surface"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2 mr-auto">
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
        </div>

        <button
          onClick={() => setNotesOpen((value) => !value)}
          className={`w-7 h-7 mr-1 flex items-center justify-center rounded-lg transition-all duration-150
            ${notesOpen
              ? 'text-text bg-white/[0.10] ring-1 ring-accent/40'
              : 'text-text-dim hover:text-text hover:bg-white/[0.06]'
            }`}
          title="Notes"
        >
          <NotebookPen className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all duration-150"
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Collapsible sidebar */}
        <div
          className="sidebar-collapsible shrink-0 h-full"
          style={{
            width: sidebarCollapsed ? 0 : undefined,
            minWidth: sidebarCollapsed ? 0 : 240,
            maxWidth: sidebarCollapsed ? 0 : 500,
            opacity: sidebarCollapsed ? 0 : 1,
          }}
        >
          {!sidebarCollapsed && <TicketPanel />}
        </div>

        {/* Resize handle — only visible when sidebar is open */}
        {!sidebarCollapsed && (
          <div className="w-px bg-border hover:bg-accent/50 transition-colors cursor-col-resize shrink-0" />
        )}

        {/* Main content */}
        <div className="flex-1 min-w-0 flex flex-col h-full">
          <PanelGroup
            direction="horizontal"
            autoSaveId="mozzie-agents-notes-panels"
            className="flex-1 min-h-0"
          >
            <Panel
              id="agents"
              order={1}
              minSize={40}
              defaultSize={notesOpen ? 74 : 100}
              className="flex flex-col h-full min-w-0"
            >
              <TerminalGrid />
            </Panel>

            {notesOpen && (
              <>
                <PanelResizeHandle className="w-px bg-border hover:bg-accent/50 transition-colors cursor-col-resize" />
                <Panel
                  id="notes"
                  order={2}
                  minSize={18}
                  maxSize={50}
                  defaultSize={26}
                  className="flex flex-col h-full min-w-0"
                >
                  <NotesPanel onClose={() => setNotesOpen(false)} />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>

      <StatusBar />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Floating command bar overlay */}
      {commandBarOpen && (
        <FloatingCommandBar onClose={() => setCommandBarOpen(false)} />
      )}
    </div>
  );
}