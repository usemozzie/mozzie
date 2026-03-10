import { useState } from 'react';
import { X, Loader2, FolderOpen } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useCreateWorkItem } from '../../hooks/useWorkItemMutation';
import { useRepoBranch, useRepoBranches } from '../../hooks/useWorktree';
import { getRecentRepos, getRepoDisplayName, saveRecentRepo } from '../../lib/recentRepos';
import { AGENT_OPTIONS, DEFAULT_AGENT } from '../../lib/agentOptions';
import { useWorkItemStore } from '../../stores/workItemStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { WorkItemDescriptionEditor } from './WorkItemDescriptionEditor';

interface NewWorkItemModalProps {
  onClose: () => void;
  initialContext?: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function suggestBranchName(title: string): string {
  const slug = slugify(title);
  if (!slug) return '';
  return `feat/${slug}`;
}

export function NewWorkItemModal({ onClose, initialContext }: NewWorkItemModalProps) {
  const [title, setTitle] = useState('');
  const [context, setContext] = useState(initialContext ?? '');
  const [repoPath, setRepoPath] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchManuallyEdited, setBranchManuallyEdited] = useState(false);
  const [sourceBranch, setSourceBranch] = useState('');
  const [assignedAgent, setAssignedAgent] = useState(DEFAULT_AGENT);
  const [recentRepos, setRecentRepos] = useState<string[]>(() => getRecentRepos());
  const [error, setError] = useState<string | null>(null);
  const repoBranch = useRepoBranch(repoPath);
  const repoBranches = useRepoBranches(repoPath);

  const createWorkItem = useCreateWorkItem();
  const selectWorkItem = useWorkItemStore((s) => s.selectWorkItem);

  async function handlePickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') {
      setRepoPath(selected);
      setSourceBranch('');
      setRecentRepos(saveRecentRepo(selected));
    }
  }

  async function handleCreate() {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    try {
      const trimmedRepoPath = repoPath.trim();
      if (trimmedRepoPath) {
        setRecentRepos(saveRecentRepo(trimmedRepoPath));
      }
      const workItem = await createWorkItem.mutateAsync({
        title: title.trim(),
        context: context.trim() || undefined,
        repo_path: trimmedRepoPath || undefined,
        assigned_agent: assignedAgent || DEFAULT_AGENT,
        branch_name: branchName.trim() || undefined,
        source_branch: sourceBranch.trim() || undefined,
      });
      onClose();
      selectWorkItem(workItem.id);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-border rounded-xl w-[480px] shadow-2xl shadow-black/40">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text">New Work Item</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-2 py-1.5">
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-muted font-medium">
              Title <span className="text-state-danger">*</span>
            </label>
            <Input
              value={title}
              onChange={(e) => {
                const newTitle = e.target.value;
                setTitle(newTitle);
                setError(null);
                if (!branchManuallyEdited) {
                  setBranchName(suggestBranchName(newTitle));
                }
              }}
              placeholder="Short work item title"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-muted font-medium">
              Branch Name
            </label>
            <Input
              value={branchName}
              onChange={(e) => {
                setBranchName(e.target.value);
                setBranchManuallyEdited(true);
                setError(null);
              }}
              placeholder="feat/my-feature (auto-generated from title)"
              className="font-mono text-xs"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <div className="flex gap-2 flex-wrap">
              {['feat', 'fix', 'refactor', 'chore'].map((prefix) => {
                const slug = slugify(title);
                const suggestion = slug ? `${prefix}/${slug}` : '';
                const isActive = branchName === suggestion && !!suggestion;
                return (
                  <button
                    key={prefix}
                    type="button"
                    disabled={!slug}
                    onClick={() => {
                      setBranchName(suggestion);
                      setBranchManuallyEdited(true);
                    }}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                      isActive
                        ? 'border-accent bg-accent/15 text-text'
                        : 'border-border bg-bg text-text-dim hover:text-text hover:border-border-bright'
                    }`}
                  >
                    {prefix}/
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-muted font-medium">
              Assigned Agent <span className="text-red-400">*</span>
            </label>
            <Select
              value={assignedAgent}
              options={AGENT_OPTIONS.map((option) => ({ ...option }))}
              onChange={(event) => setAssignedAgent(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            {recentRepos.length > 0 && (
              <div className="space-y-1 pb-1">
                <label className="text-xs text-text-muted font-medium">Recent Repos</label>
                <div className="flex flex-wrap gap-1.5">
                  {recentRepos.map((recentRepo) => {
                    const isActive = recentRepo === repoPath;
                    return (
                      <button
                        key={recentRepo}
                        type="button"
                        onClick={() => {
                          setRepoPath(recentRepo);
                          setSourceBranch('');
                          setRecentRepos(saveRecentRepo(recentRepo));
                        }}
                        title={recentRepo}
                        className={`max-w-full px-2.5 py-1 rounded-full text-xs border transition-colors ${
                          isActive
                            ? 'border-accent bg-accent/15 text-text'
                            : 'border-border bg-bg text-text-dim hover:text-text hover:border-border-bright'
                        }`}
                      >
                        <span className="block max-w-[180px] truncate">
                          {getRepoDisplayName(recentRepo)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="text-xs text-text-muted font-medium">
              Repository
            </label>
            <button
              type="button"
              onClick={handlePickFolder}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm rounded border border-border bg-surface hover:bg-surface-raised text-left transition-colors"
            >
              <FolderOpen className="w-4 h-4 text-text-muted shrink-0" />
              <span className={repoPath ? 'text-text truncate' : 'text-text-dim truncate'}>
                {repoPath || 'Choose folder…'}
              </span>
            </button>
            {repoPath && repoBranch.error && (
              <div className="text-[11px] text-red-400">Not a git repository</div>
            )}
            {repoPath && repoBranches.data && repoBranches.data.length > 0 && (
              <div className="space-y-1 pt-1">
                <label className="text-xs text-text-muted font-medium">
                  Source Branch
                </label>
                <Select
                  value={sourceBranch || repoBranch.data?.branch_name || ''}
                  options={repoBranches.data.map((b) => ({
                    value: b,
                    label: b + (b === repoBranch.data?.branch_name ? ' (checked out)' : ''),
                  }))}
                  onChange={(e) => setSourceBranch(e.target.value)}
                />
                <div className="text-[11px] text-text-dim">
                  The worktree will branch from this. Defaults to the currently checked-out branch.
                </div>
              </div>
            )}
            {repoPath && repoBranches.isLoading && (
              <div className="text-[11px] text-text-dim">Loading branches…</div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-muted font-medium">What Should Be Done</label>
            <WorkItemDescriptionEditor
              value={context}
              onChange={setContext}
              repoPath={repoPath}
              placeholder="Describe what should be done. Use @path/to/file.tsx to include files from the selected repo."
              rows={8}
              maxRows={14}
              editorClassName="min-h-[180px]"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createWorkItem.isPending}
          >
            {createWorkItem.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              'Create Work Item'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
