import { useEffect, useState } from 'react';
import { FolderOpen, GitBranch, Loader2, Plus, Trash2, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useRepos, useAddRepo, useRemoveRepo, usePrepareRepo, useCheckoutRepoBranch } from '../../hooks/useRepos';
import { useRepoBranch, useRepoBranches } from '../../hooks/useWorktree';
import { saveRecentRepo } from '../../lib/recentRepos';
import type { Repo } from '@mozzie/db';
import { Select } from '../ui/select';

interface ReposPanelProps {
  onClose: () => void;
}

export function ReposPanel({ onClose }: ReposPanelProps) {
  const { data: repos, isLoading } = useRepos();
  const addRepo = useAddRepo();
  const removeRepo = useRemoveRepo();
  const prepareRepo = usePrepareRepo();
  const checkoutRepoBranch = useCheckoutRepoBranch();
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
              onCheckout={async (branchName) => {
                try {
                  setError(null);
                  await checkoutRepoBranch.mutateAsync({
                    id: repo.id,
                    repoPath: repo.path,
                    branchName,
                  });
                } catch (e: any) {
                  setError(e?.toString() ?? 'Failed to switch branch');
                }
              }}
              isCheckoutPending={
                checkoutRepoBranch.isPending && checkoutRepoBranch.variables?.id === repo.id
              }
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
  onCheckout,
  isCheckoutPending,
  onRemove,
}: {
  repo: Repo;
  onPrepare: () => void;
  onCheckout: (branchName: string) => Promise<void>;
  isCheckoutPending: boolean;
  onRemove: () => void;
}) {
  const repoBranch = useRepoBranch(repo.path);
  const repoBranches = useRepoBranches(repo.path);
  const currentBranch = repoBranch.data?.branch_name || repo.default_branch || '';
  const [selectedBranch, setSelectedBranch] = useState(currentBranch);

  useEffect(() => {
    setSelectedBranch(currentBranch);
  }, [currentBranch]);

  const canCheckout =
    !repo.needs_prepare &&
    !!selectedBranch &&
    selectedBranch !== currentBranch &&
    !isCheckoutPending;

  return (
    <div className="group rounded-lg px-2.5 py-2 hover:bg-white/[0.04] transition-colors">
      <div className="flex items-start gap-2">
        <GitBranch className="w-3.5 h-3.5 text-text-dim shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-text truncate">{repo.name}</div>
          <div className="text-[10px] text-text-dim truncate" title={repo.path}>
            {repo.path}
          </div>
          {currentBranch && (
            <div className="pt-0.5 text-[10px] text-text-dim truncate">
              checked out: <span className="text-text">{currentBranch}</span>
            </div>
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

      {!repo.needs_prepare && (
        <div className="pl-[22px] pt-2 space-y-1.5">
          {repoBranches.isLoading ? (
            <div className="text-[11px] text-text-dim">Loading branches…</div>
          ) : repoBranches.data && repoBranches.data.length > 0 ? (
            <div className="flex items-center gap-2">
              <Select
                className="h-8 text-[12px]"
                value={selectedBranch}
                options={repoBranches.data.map((branch) => ({
                  value: branch,
                  label: branch + (branch === currentBranch ? ' (checked out)' : ''),
                }))}
                onChange={(e) => setSelectedBranch(e.target.value)}
              />
              <button
                onClick={() => void onCheckout(selectedBranch)}
                disabled={!canCheckout}
                className="shrink-0 h-8 px-3 rounded-md border border-border bg-surface text-[11px] text-text-dim hover:text-text hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isCheckoutPending ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Switching
                  </span>
                ) : selectedBranch === currentBranch ? 'Checked Out' : 'Check Out'}
              </button>
            </div>
          ) : (
            <div className="text-[11px] text-text-dim">No local branches found.</div>
          )}
          {repoBranch.error && (
            <div className="text-[11px] text-state-danger">Could not read the current branch.</div>
          )}
        </div>
      )}
    </div>
  );
}
