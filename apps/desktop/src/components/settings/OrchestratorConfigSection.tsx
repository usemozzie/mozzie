import { useState } from 'react';
import { Eye, EyeOff, Check } from 'lucide-react';
import { Input } from '../ui/input';
import {
  getKeyStore,
  saveKeyStore,
  ALL_PROVIDERS,
  PROVIDER_META,
  type OrchestratorKeyStore,
  type OrchestratorProvider,
} from '../../hooks/useOrchestrator';

export function OrchestratorConfigSection() {
  const [store, setStore] = useState<OrchestratorKeyStore>(() => getKeyStore());
  const [reveal, setReveal] = useState<Partial<Record<OrchestratorProvider, boolean>>>({});
  const [saved, setSaved] = useState(false);

  function updateKey(provider: OrchestratorProvider, value: string) {
    setStore((prev) => ({ ...prev, keys: { ...prev.keys, [provider]: value } }));
    setSaved(false);
  }

  function updateModel(provider: OrchestratorProvider, value: string) {
    setStore((prev) => ({ ...prev, models: { ...prev.models, [provider]: value } }));
    setSaved(false);
  }

  function handleSave() {
    saveKeyStore(store);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-3">
      {ALL_PROVIDERS.map((provider) => {
        const meta = PROVIDER_META[provider];
        const key = store.keys[provider];
        const model = store.models[provider];
        const hasKey = key.trim().length > 0;
        const isRevealed = reveal[provider] ?? false;

        return (
          <div
            key={provider}
            className="rounded-lg border border-border bg-bg p-3 space-y-2.5"
          >
            {/* Provider header */}
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasKey ? 'bg-state-success' : 'bg-state-idle'}`} />
              <span className="text-[13px] font-medium text-text">{meta.label}</span>
              {hasKey && (
                <span className="text-[10px] text-state-success ml-auto">Connected</span>
              )}
            </div>

            {/* API key */}
            <div className="space-y-1">
              <label className="text-[11px] text-text-dim">API Key</label>
              <div className="flex gap-1.5">
                <Input
                  type={isRevealed ? 'text' : 'password'}
                  value={key}
                  onChange={(e) => updateKey(provider, e.target.value)}
                  placeholder={meta.placeholder}
                  className="flex-1 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setReveal((prev) => ({ ...prev, [provider]: !isRevealed }))}
                  className="w-8 h-8 flex items-center justify-center rounded-md border border-border text-text-dim hover:text-text hover:bg-white/[0.04] transition-colors shrink-0"
                  title={isRevealed ? 'Hide' : 'Reveal'}
                >
                  {isRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Model override */}
            <div className="space-y-1">
              <label className="text-[11px] text-text-dim">Model</label>
              <Input
                value={model}
                onChange={(e) => updateModel(provider, e.target.value)}
                placeholder={meta.defaultModel}
                className="text-xs"
              />
            </div>
          </div>
        );
      })}

      <button
        onClick={handleSave}
        className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-all duration-200 ${
          saved
            ? 'bg-state-success/15 text-state-success border border-state-success/30'
            : 'bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25'
        }`}
      >
        {saved ? (
          <>
            <Check className="w-3.5 h-3.5" />
            Saved
          </>
        ) : (
          'Save API Keys'
        )}
      </button>
    </div>
  );
}
