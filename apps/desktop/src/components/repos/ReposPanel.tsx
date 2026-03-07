import { useState } from 'react';
import { FolderOpen, GitBranch, Plus, Trash2, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useRepos, useAddRepo, useRemoveRepo, usePrepareRepo } from '../../hooks/useRepos';
import { saveRecentRepo } from '../../lib/recentRepos';
import type { Repo } from '@mozzie/db';

interface ReposPanelProps {
  onClose: () => void;
}

export function ReposPanel({ onClose }: ReposPanelProps) {
  const { data: repos, isLoading } = useRepos();
  const addRepo = useAddRepo();
  const removeRepo = useRemoveRepo();
  const prepareRepo = usePrepareRepo();
  const [error, setError] = useState<string | null>(null);

  async function handleAddRepo() {
    setError(null);
    const selected = await open({ directory: true, title: 'Select a git repository' });
    if (!selected) return;
    const path = typeof selected === 'string' ? selected : selected;
    const name = path.split(/[\\/]/).filter(Boolean).pop() || 'repo';
    try {
      await addRepo.mutateAsync({ name, path });
      saveRecentRepo(path);
    } catch (e: any) {
      setError(e?.toString() ?? 'Failed to add repository');
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="text-[13px] font-semibold text-text">Repositories</span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {error && (
          <div className="mx-1 mb-2 px-2 py-1.5 text-[11px] text-state-danger bg-state-danger/10 rounded-md">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center h-20 text-text-dim text-[13px]">Loading...</div>
        ) : !repos || repos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
            <FolderOpen className="w-8 h-8 text-text-dim opacity-30" />
            <p className="text-[13px] text-text-muted">No repositories</p>
            <p className="text-[11px] text-text-dim">Add repos so agents have context</p>
          </div>
        ) : (
          repos.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              onPrepare={async () => {
                try {
                  setError(null);
                  await prepareRepo.mutateAsync(repo.id);
                } catch (e: any) {
                  setError(e?.toString() ?? 'Failed to prepare repository');
                }
              }}
              onRemove={() => removeRepo.mutate(repo.id)}
            />
          ))
        )}
      </div>

      <div className="shrink-0 px-3 py-2 border-t border-border">
        <button
          onClick={handleAddRepo}
          className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[12px] text-text-dim hover:text-text hover:bg-white/[0.04] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add repository
        </button>
      </div>
    </div>
  );
}

function RepoRow({
  repo,
  onPrepare,
  onRemove,
}: {
  repo: Repo;
  onPrepare: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-white/[0.04] transition-colors">
      <GitBranch className="w-3.5 h-3.5 text-text-dim shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-text truncate">{repo.name}</div>
        {repo.default_branch && (
          <div className="text-[10px] text-text-dim truncate">{repo.default_branch}</div>
        )}
      </div>
      {repo.needs_prepare && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrepare(); }}
          className="opacity-0 group-hover:opacity-100 px-2 h-5 flex items-center justify-center rounded text-[10px] text-text-dim hover:text-text hover:bg-white/[0.06] transition-all"
          title="Prepare repository by creating an initial commit if needed"
        >
          Prepare
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-state-danger transition-all"
        title="Remove"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}
