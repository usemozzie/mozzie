import { useState } from 'react';
import { X, Key, Bot, Shield, Info } from 'lucide-react';
import { AgentConfigSection } from './AgentConfigForm';
import { OrchestratorConfigSection } from './OrchestratorConfigSection';
import { LicenseSection } from './LicenseSection';

interface SettingsPanelProps {
  onClose: () => void;
}

const TABS = [
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'license', label: 'License', icon: Shield },
  { id: 'about', label: 'About', icon: Info },
] as const;

type TabId = typeof TABS[number]['id'];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('api-keys');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <h2 className="text-[13px] font-semibold text-text">Settings</h2>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
          title="Close settings"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex px-3 pt-1 gap-0.5 border-b border-border shrink-0">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-t-md transition-colors relative
                ${isActive
                  ? 'text-text bg-white/[0.04]'
                  : 'text-text-dim hover:text-text hover:bg-white/[0.02]'
                }`}
            >
              <Icon className="w-3 h-3" />
              {tab.label}
              {isActive && (
                <span className="absolute bottom-0 left-2.5 right-2.5 h-[2px] bg-accent rounded-full" />
              )}
            </button>
          );
        })}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'api-keys' && (
          <div className="space-y-3">
            <div>
              <h3 className="text-[13px] font-medium text-text">Orchestrator API Keys</h3>
              <p className="text-[11px] text-text-dim mt-1">
                Add API keys for each provider. Only providers with keys can be selected in the orchestrator.
              </p>
            </div>
            <OrchestratorConfigSection />
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="space-y-3">
            <div>
              <h3 className="text-[13px] font-medium text-text">Agent Configurations</h3>
              <p className="text-[11px] text-text-dim mt-1">
                Configure agents that execute ticket work via ACP.
              </p>
            </div>
            <AgentConfigSection />
          </div>
        )}

        {activeTab === 'license' && (
          <div className="space-y-3">
            <LicenseSection />
          </div>
        )}

        {activeTab === 'about' && (
          <div className="space-y-3">
            <div>
              <h3 className="text-[13px] font-medium text-text">Mozzie</h3>
              <p className="text-[11px] text-text-dim mt-1">
                Multi-agent build orchestration for your codebase.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-bg p-3 space-y-2 text-[12px] text-text-dim">
              <div className="flex justify-between">
                <span>Version</span>
                <span className="text-text font-mono">0.1.0</span>
              </div>
              <div className="flex justify-between">
                <span>Theme</span>
                <span className="text-text">Dark</span>
              </div>
              <div className="flex justify-between">
                <span>Worktree root</span>
                <span className="text-text font-mono text-[11px]">~/.mozzie/worktrees/</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
