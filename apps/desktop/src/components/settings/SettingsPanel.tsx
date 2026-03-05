import { X } from 'lucide-react';
import { AgentConfigSection } from './AgentConfigForm';
import { OrchestratorConfigSection } from './OrchestratorConfigSection';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 h-full w-96 bg-surface border-l border-border shadow-2xl z-50 flex flex-col"
        role="dialog"
        aria-label="Settings"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text">Settings</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
            title="Close settings"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <OrchestratorConfigSection />
          <AgentConfigSection />

          {/* General prefs section */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              General
            </h3>
            <div className="text-xs text-text-dim px-1 space-y-1">
              <p>Theme: Dark (default)</p>
              <p>Worktrees: ~/.mozzie/worktrees/</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-2 border-t border-border text-[11px] text-text-dim">
          Mozzie v0.1.0
        </div>
      </div>
    </>
  );
}
