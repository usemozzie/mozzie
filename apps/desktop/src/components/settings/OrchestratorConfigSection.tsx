import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  getDefaultModel,
  getOrchestratorConfig,
  saveOrchestratorConfig,
  type OrchestratorConfig,
  type OrchestratorProvider,
} from '../../hooks/useOrchestrator';

const PROVIDERS: Array<{ value: OrchestratorProvider; label: string }> = [
  { value: 'openai', label: 'ChatGPT' },
  { value: 'anthropic', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
];

export function OrchestratorConfigSection() {
  const [form, setForm] = useState<OrchestratorConfig>(() => getOrchestratorConfig());
  const [saved, setSaved] = useState(false);

  function set<K extends keyof OrchestratorConfig>(key: K, value: OrchestratorConfig[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function handleProviderChange(provider: OrchestratorProvider) {
    setForm((prev) => ({
      ...prev,
      provider,
      model:
        prev.model === getDefaultModel(prev.provider)
          ? getDefaultModel(provider)
          : prev.model,
    }));
    setSaved(false);
  }

  function handleSave() {
    saveOrchestratorConfig(form);
    setSaved(true);
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
          Orchestrator LLM
        </h3>
        <p className="text-[11px] text-text-dim mt-1">
          Choose one provider for backlog orchestration. The orchestrator behavior stays the same across providers.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.value}
            type="button"
            onClick={() => handleProviderChange(provider.value)}
            className={`rounded border px-2 py-2 text-xs transition-colors ${
              form.provider === provider.value
                ? 'border-accent bg-accent/10 text-text'
                : 'border-border bg-bg text-text-dim hover:text-text'
            }`}
          >
            {provider.label}
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-text-dim">API Key</label>
        <Input
          type="password"
          value={form.apiKey}
          onChange={(event) => set('apiKey', event.target.value)}
          placeholder="Paste your API key"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-text-dim">Model</label>
        <Input
          value={form.model}
          onChange={(event) => set('model', event.target.value)}
          placeholder={getDefaultModel(form.provider)}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[11px] text-text-dim">
          {saved ? 'Saved locally for this app session/device.' : 'Changes are local until saved.'}
        </div>
        <Button size="sm" onClick={handleSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
