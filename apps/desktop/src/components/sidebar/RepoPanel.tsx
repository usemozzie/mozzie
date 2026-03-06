import { useState } from 'react';
import { Plus, Trash2, FolderOpen, GitBranch } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useRepos, useAddRepo, useRemoveRepo } from '../../hooks/useRepos';
import { Button } from '../ui/button';
import type { Repo } from '@mozzie/db';

export function RepoPanel() {
  const { data: repos, isLoading } = useRepos();
  const addRepo = useAddRepo();
  const removeRepo = useRemoveRepo();
  const [error, setError] = useState<string | null>(null);

  async function handleAddRepo() {
    setError(null);
    const selected = await open({ directory: true, title: 'Select a git repository' });
    if (!selected) return;

    const path = typeof selected === 'string' ? selected : selected;
    // Derive name from folder name
    const name = path.split(/[\\/]/).filter(Boolean).pop() || 'repo';

    try {
      await addRepo.mutateAsync({ name, path });
    } catch (e: any) {
      setError(e?.toString() ?? 'Failed to add repository');
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg border-r border-border" style={{ minWidth: 240, maxWidth: 500 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h1 className="text-[13px] font-semibold text-text tracking-tight">Repositories</h1>
        <Button variant="ghost" size="icon" title="Add Repository" onClick={handleAddRepo}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 text-[11px] text-state-danger bg-state-danger/10 border-b border-border">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-text-dim text-[13px]">Loading...</div>
        ) : !repos || repos.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 px-4 text-center">
            <FolderOpen className="w-8 h-8 text-text-dim opacity-40" />
            <p className="text-[13px] text-text-muted">No repositories</p>
            <p className="text-[11px] text-text-dim">Add a repo so agents can work on it</p>
          </div>
        ) : (
          repos.map((repo) => <RepoCard key={repo.id} repo={repo} onRemove={() => removeRepo.mutate(repo.id)} />)
        )}
      </div>
    </div>
  );
}

function RepoCard({ repo, onRemove }: { repo: Repo; onRemove: () => void }) {
  const pathParts = repo.path.replace(/\\/g, '/').split('/');
  const shortPath = pathParts.length > 3
    ? '.../' + pathParts.slice(-3).join('/')
    : repo.path;

  return (
    <div className="group flex items-start gap-3 px-4 py-2.5 border-b border-border/50 hover:bg-white/[0.02] transition-colors">
      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
        <GitBranch className="w-3.5 h-3.5 text-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text truncate">{repo.name}</div>
        <div className="text-[11px] text-text-dim truncate" title={repo.path}>{shortPath}</div>
        {repo.default_branch && (
          <div className="text-[10px] text-text-dim mt-0.5 flex items-center gap-1">
            <span className="opacity-60">branch:</span> {repo.default_branch}
          </div>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-state-danger hover:bg-state-danger/10 transition-all"
        title="Remove repository"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}
