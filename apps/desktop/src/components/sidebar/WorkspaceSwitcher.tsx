import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { useWorkspaces, useCreateWorkspace, useRenameWorkspace, useDeleteWorkspace } from '../../hooks/useWorkspaces';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useLicense } from '../../hooks/useLicense';

export function WorkspaceSwitcher() {
  const { data: license } = useLicense();
  const { data: workspaces } = useWorkspaces();
  const { activeWorkspaceId, setActiveWorkspaceId } = useWorkspaceStore();
  const createWorkspace = useCreateWorkspace();
  const renameWorkspace = useRenameWorkspace();
  const deleteWorkspace = useDeleteWorkspace();

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPro = license?.is_pro ?? false;

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setEditingId(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Focus input when creating
  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  // Don't render at all for free users
  if (!isPro) return null;

  const active = workspaces?.find((w) => w.id === activeWorkspaceId) ?? workspaces?.[0];

  function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    createWorkspace.mutate(trimmed, {
      onSuccess: (ws) => {
        setActiveWorkspaceId(ws.id);
        setCreating(false);
        setNewName('');
      },
    });
  }

  function handleRename(id: string) {
    const trimmed = editName.trim();
    if (!trimmed) return;
    renameWorkspace.mutate({ id, name: trimmed }, {
      onSuccess: () => {
        setEditingId(null);
        setEditName('');
      },
    });
  }

  function handleDelete(id: string) {
    deleteWorkspace.mutate(id, {
      onSuccess: () => {
        if (activeWorkspaceId === id) {
          setActiveWorkspaceId('default');
        }
      },
    });
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-text hover:bg-white/[0.06] transition-colors"
      >
        <span className="w-5 h-5 flex items-center justify-center rounded bg-accent/20 text-accent text-[11px] font-bold shrink-0">
          {(active?.name ?? 'D')[0].toUpperCase()}
        </span>
        <span className="flex-1 text-left text-[13px] font-medium truncate">
          {active?.name ?? 'Default'}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-text-dim transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg shadow-xl py-1 max-h-64 overflow-y-auto">
          {workspaces?.map((ws) => (
            <div key={ws.id} className="group flex items-center">
              {editingId === ws.id ? (
                <div className="flex-1 flex items-center gap-1 px-2.5 py-1">
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(ws.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="flex-1 text-[12px] bg-bg border border-border rounded px-1.5 py-0.5 text-text focus:outline-none focus:border-accent/50"
                  />
                  <button
                    onClick={() => handleRename(ws.id)}
                    className="w-5 h-5 flex items-center justify-center rounded text-state-success hover:bg-state-success/10"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="w-5 h-5 flex items-center justify-center rounded text-text-dim hover:bg-white/[0.06]"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setActiveWorkspaceId(ws.id);
                      setOpen(false);
                    }}
                    className={`flex-1 text-left px-2.5 py-1.5 text-[12px] transition-colors truncate
                      ${ws.id === activeWorkspaceId ? 'text-accent bg-accent/5' : 'text-text hover:bg-white/[0.06]'}`}
                  >
                    {ws.name}
                  </button>
                  {ws.id !== 'default' && (
                    <div className="flex items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => {
                          setEditingId(ws.id);
                          setEditName(ws.name);
                        }}
                        className="w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-text hover:bg-white/[0.06]"
                        title="Rename"
                      >
                        <Pencil className="w-2.5 h-2.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(ws.id)}
                        className="w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-state-danger hover:bg-state-danger/10"
                        title="Delete"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}

          <div className="border-t border-border mt-1 pt-1">
            {creating ? (
              <div className="flex items-center gap-1 px-2.5 py-1">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                  placeholder="Workspace name"
                  className="flex-1 text-[12px] bg-bg border border-border rounded px-1.5 py-0.5 text-text placeholder:text-text-dim focus:outline-none focus:border-accent/50"
                />
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim()}
                  className="w-5 h-5 flex items-center justify-center rounded text-state-success hover:bg-state-success/10 disabled:opacity-30"
                >
                  <Check className="w-3 h-3" />
                </button>
                <button
                  onClick={() => { setCreating(false); setNewName(''); }}
                  className="w-5 h-5 flex items-center justify-center rounded text-text-dim hover:bg-white/[0.06]"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
              >
                <Plus className="w-3 h-3" />
                <span>New workspace</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
