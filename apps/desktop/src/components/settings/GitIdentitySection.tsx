import { useState, useEffect } from 'react';
import { useWorkspaces, useUpdateWorkspaceGitIdentity } from '../../hooks/useWorkspaces';
import { useWorkspaceStore } from '../../stores/workspaceStore';

export function GitIdentitySection() {
  const { activeWorkspaceId } = useWorkspaceStore();
  const { data: workspaces } = useWorkspaces();
  const updateGitIdentity = useUpdateWorkspaceGitIdentity();

  const workspace = workspaces?.find((w) => w.id === activeWorkspaceId);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (workspace) {
      setName(workspace.git_user_name ?? '');
      setEmail(workspace.git_user_email ?? '');
    }
  }, [workspace?.id, workspace?.git_user_name, workspace?.git_user_email]);

  const hasChanges =
    (name || null) !== (workspace?.git_user_name ?? null) ||
    (email || null) !== (workspace?.git_user_email ?? null);

  const handleSave = () => {
    if (!workspace) return;
    updateGitIdentity.mutate(
      {
        id: workspace.id,
        gitUserName: name || null,
        gitUserEmail: email || null,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  if (!workspace) return null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13px] font-medium text-text">Git Identity</h3>
        <p className="text-[11px] text-text-dim mt-1">
          Set the git author used for commits in the{' '}
          <span className="font-medium text-text">{workspace.name}</span> workspace.
          Leave blank to use each repo's own git config.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-bg p-3 space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-text-dim block">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Jane Smith"
            className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text placeholder:text-text-dim/50 focus:outline-none focus:border-accent"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-text-dim block">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. jane@example.com"
            className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text placeholder:text-text-dim/50 focus:outline-none focus:border-accent"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={!hasChanges || updateGitIdentity.isPending}
            className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {updateGitIdentity.isPending ? 'Saving...' : 'Save'}
          </button>
          {saved && (
            <span className="text-[11px] text-green-400">Saved</span>
          )}
          {updateGitIdentity.isError && (
            <span className="text-[11px] text-red-400">
              {String(updateGitIdentity.error)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
