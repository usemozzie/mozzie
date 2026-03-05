import { useState } from 'react';
import { Loader2, Trash2, Plus, Edit2, Check, X } from 'lucide-react';
import type { AgentConfig } from '@mozzie/db';
import { useAgentConfigs, useSaveAgentConfig, useDeleteAgentConfig } from '../../hooks/useAgents';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const EMPTY_FORM: Partial<AgentConfig> = {
  id: '',
  display_name: '',
  acp_url: 'builtin:claude-code',
  api_key_ref: null,
  model: null,
  max_concurrent: 1,
  enabled: 1,
};

export function AgentConfigSection() {
  const { data: agents, isLoading } = useAgentConfigs();
  const [editing, setEditing] = useState<Partial<AgentConfig> | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-text-dim gap-2 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading agents…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
          Agent Configurations
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing({ ...EMPTY_FORM })}
          className="text-xs"
        >
          <Plus className="w-3 h-3 mr-1" />
          Add
        </Button>
      </div>

      {/* Existing agent list */}
      <div className="space-y-1.5">
        {(agents ?? []).map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            onEdit={() => setEditing({ ...agent })}
          />
        ))}
        {agents?.length === 0 && (
          <p className="text-xs text-text-dim text-center py-2">No agents configured.</p>
        )}
      </div>

      {/* Inline editor */}
      {editing && (
        <AgentEditor
          initial={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function AgentRow({ agent, onEdit }: { agent: AgentConfig; onEdit: () => void }) {
  const deleteConfig = useDeleteAgentConfig();

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-bg border border-border text-xs">
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          agent.enabled ? 'bg-state-success' : 'bg-state-idle'
        }`}
      />
      <span className="flex-1 text-text truncate">{agent.display_name}</span>
      <span className="text-text-dim font-mono shrink-0 truncate max-w-[140px]">
        {agent.acp_url}
      </span>
      <button
        onClick={onEdit}
        className="text-text-dim hover:text-text p-0.5"
        title="Edit"
      >
        <Edit2 className="w-3 h-3" />
      </button>
      <button
        onClick={() => deleteConfig.mutate(agent.id)}
        className="text-text-dim hover:text-red-400 p-0.5"
        title="Delete"
        disabled={deleteConfig.isPending}
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Editor ───────────────────────────────────────────────────────────────────

function AgentEditor({
  initial,
  onClose,
}: {
  initial: Partial<AgentConfig>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Partial<AgentConfig>>(initial);
  const saveConfig = useSaveAgentConfig();
  const isNew = !initial.id || initial.id === '';

  function set(key: keyof AgentConfig, value: unknown) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!form.id?.trim() || !form.display_name?.trim()) return;
    await saveConfig.mutateAsync(form as Partial<AgentConfig> & { id: string });
    onClose();
  }

  return (
    <div className="rounded border border-border bg-surface p-3 space-y-2 text-xs">
      <div className="font-medium text-text-muted mb-1">
        {isNew ? 'New Agent' : `Edit: ${initial.display_name}`}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <label className="text-text-dim">ID</label>
          <Input
            value={form.id ?? ''}
            onChange={(e) => set('id', e.target.value)}
            placeholder="claude-code"
            disabled={!isNew}
          />
        </div>
        <div className="space-y-0.5">
          <label className="text-text-dim">Display Name</label>
          <Input
            value={form.display_name ?? ''}
            onChange={(e) => set('display_name', e.target.value)}
            placeholder="Claude Code"
          />
        </div>
      </div>

      <div className="space-y-0.5">
        <label className="text-text-dim">ACP Target</label>
        <Input
          value={form.acp_url ?? ''}
          onChange={(e) => set('acp_url', e.target.value)}
          placeholder="builtin:claude-code"
        />
        <p className="text-[10px] text-text-dim mt-0.5">
          Use <code className="text-text-dim">builtin:claude-code</code> for the bundled adapter
          mapping, or <code className="text-text-dim">stdio:gemini --experimental-acp</code> for
          a custom ACP command.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <label className="text-text-dim">API Key Env Var</label>
          <Input
            value={form.api_key_ref ?? ''}
            onChange={(e) => set('api_key_ref', e.target.value || null)}
            placeholder="ANTHROPIC_API_KEY"
          />
        </div>
        <div className="space-y-0.5">
          <label className="text-text-dim">Model (optional)</label>
          <Input
            value={form.model ?? ''}
            onChange={(e) => set('model', e.target.value || null)}
            placeholder="claude-sonnet-4-6"
          />
        </div>
      </div>

      <div className="space-y-0.5">
        <label className="text-text-dim">Max Concurrent</label>
        <Input
          type="number"
          min={1}
          max={8}
          value={form.max_concurrent ?? 1}
          onChange={(e) => set('max_concurrent', parseInt(e.target.value, 10) || 1)}
          className="w-24"
        />
      </div>

      {saveConfig.isError && (
        <p className="text-red-400 text-xs">{String(saveConfig.error)}</p>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saveConfig.isPending || !form.id?.trim() || !form.display_name?.trim()}
          className="flex-1"
        >
          {saveConfig.isPending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <>
              <Check className="w-3 h-3 mr-1" />
              Save
            </>
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          <X className="w-3 h-3 mr-1" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
