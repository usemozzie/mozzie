import { useMemo, useState } from 'react';
import {
  Plus,
  Play,
  Loader2,
  MoreHorizontal,
  ListFilter,
  Clock3,
  Layers3,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { useWorkItemStore } from '../../stores/workItemStore';
import { useWorkItems } from '../../hooks/useWorkItems';
import { useDeleteWorkItem } from '../../hooks/useWorkItemMutation';
import { useStartAgent } from '../../hooks/useStartAgent';
import { getWorkItemTag } from '../../lib/workItemColors';
import type { WorkItem, WorkItemStatus } from '@mozzie/db';

const statusDot: Record<WorkItemStatus, string> = {
  draft: 'bg-state-idle',
  ready: 'bg-state-active',
  blocked: 'bg-amber-500',
  queued: 'bg-state-active',
  running: 'bg-state-active dot-pulse',
  review: 'bg-state-waiting',
  done: 'bg-state-success',
  archived: 'bg-state-idle opacity-50',
};

interface AppSidebarProps {
  collapsed: boolean;
}

export function AppSidebar({ collapsed }: AppSidebarProps) {
  const openNewWorkItemModal = useWorkItemStore((s) => s.openNewWorkItemModal);

  if (collapsed) {
    return (
      <div className="w-11 shrink-0 flex flex-col items-center py-2 gap-1 bg-bg border-r border-border">
        <button
          onClick={() => openNewWorkItemModal()}
          title="New Work Item"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim hover:text-text hover:bg-white/[0.06] transition-all duration-150"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-[260px] min-w-[260px] max-w-[260px] flex-col bg-bg border-r border-border select-none">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-dim">Work Items</span>
        <button
          onClick={() => openNewWorkItemModal()}
          className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
          title="New Work Item"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Work item list */}
      <div className="flex-1 min-h-0">
        <WorkItemListSection />
      </div>
    </div>
  );
}

type WorkItemScope = 'active' | 'recent' | 'all';

const WORK_ITEM_SCOPE_OPTIONS: Array<{
  id: WorkItemScope;
  label: string;
  icon: typeof ListFilter;
}> = [
  { id: 'active', label: 'Active', icon: ListFilter },
  { id: 'recent', label: 'Recent', icon: Clock3 },
  { id: 'all', label: 'All', icon: Layers3 },
];

function WorkItemListSection() {
  const [scope, setScope] = useState<WorkItemScope>('active');
  const { data: workItems, isLoading } = useWorkItems();
  const { selectedWorkItemIds, toggleWorkItemSelection } = useWorkItemStore();

  if (isLoading) {
    return <div className="flex items-center justify-center h-20 text-text-dim text-[13px]">Loading...</div>;
  }

  const now = Date.now();
  const recentCutoffMs = 1000 * 60 * 60 * 24 * 7;
  const filteredWorkItems = (workItems ?? []).filter((workItem) => {
    if (scope === 'active') return workItem.status !== 'done' && workItem.status !== 'archived';
    if (scope === 'recent') return now - new Date(workItem.updated_at).getTime() <= recentCutoffMs;
    return true;
  });

  if (!workItems || workItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-1.5 px-4 text-center">
        <p className="text-[13px] text-text-muted">No work items yet</p>
        <p className="text-[11px] text-text-dim">Click + to create one</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Scope filter */}
      <div className="shrink-0 px-2 pb-2">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.03] p-0.5">
          {WORK_ITEM_SCOPE_OPTIONS.map(({ id, label, icon: Icon }) => {
            const active = scope === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setScope(id)}
                className={`flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                  active
                    ? 'bg-white/[0.10] text-text'
                    : 'text-text-dim hover:bg-white/[0.05] hover:text-text'
                }`}
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* List grouped by repo */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-0.5">
        {filteredWorkItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <p className="text-[13px] text-text-muted">
              {scope === 'active' ? 'No active work items' : scope === 'recent' ? 'No recent work items' : 'No work items'}
            </p>
          </div>
        ) : (
          <GroupedWorkItemList workItems={filteredWorkItems} selectedWorkItemIds={selectedWorkItemIds} toggleWorkItemSelection={toggleWorkItemSelection} />
        )}
      </div>

      {/* Count */}
      <div className="shrink-0 px-3 py-1.5 border-t border-border">
        <span className="text-[10px] text-text-dim">{filteredWorkItems.length} of {workItems.length}</span>
      </div>
    </div>
  );
}

function getRepoName(repoPath: string | null): string {
  if (!repoPath) return 'No repo';
  return repoPath.split(/[/\\]/).filter(Boolean).pop() || repoPath;
}

function GroupedWorkItemList({
  workItems,
  selectedWorkItemIds,
  toggleWorkItemSelection,
}: {
  workItems: WorkItem[];
  selectedWorkItemIds: string[];
  toggleWorkItemSelection: (id: string) => void;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const parentIds = useMemo(
    () => new Set(workItems.filter((workItem) => workItem.parent_id).map((workItem) => workItem.parent_id!)),
    [workItems],
  );

  const groups = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const workItem of workItems) {
      const key = workItem.repo_path ?? '__none__';
      const list = map.get(key);
      if (list) list.push(workItem);
      else map.set(key, [workItem]);
    }
    // Sort: repos with work items first, "No repo" last
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === '__none__') return 1;
      if (b === '__none__') return -1;
      return getRepoName(a).localeCompare(getRepoName(b));
    });
  }, [workItems]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Single group — skip header
  if (groups.length === 1) {
    return (
      <>
        {groups[0][1].map((workItem) => (
          <SidebarWorkItemRow
            key={workItem.id}
            workItem={workItem}
            canStart={!parentIds.has(workItem.id)}
            isSelected={selectedWorkItemIds.includes(workItem.id)}
            selectedIndex={selectedWorkItemIds.indexOf(workItem.id)}
            onClick={() => toggleWorkItemSelection(workItem.id)}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {groups.map(([key, groupWorkItems]) => {
        const collapsed = collapsedGroups.has(key);
        const label = key === '__none__' ? 'No repo' : getRepoName(key);
        return (
          <div key={key} className="mb-1">
            <button
              type="button"
              onClick={() => toggleGroup(key)}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-dim hover:text-text transition-colors"
            >
              <ChevronRight className={`w-3 h-3 shrink-0 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`} />
              <span className="truncate">{label}</span>
              <span className="ml-auto text-text-dim/50 tabular-nums">{groupWorkItems.length}</span>
            </button>
            {!collapsed && groupWorkItems.map((workItem) => (
              <SidebarWorkItemRow
                key={workItem.id}
                workItem={workItem}
                canStart={!parentIds.has(workItem.id)}
                isSelected={selectedWorkItemIds.includes(workItem.id)}
                selectedIndex={selectedWorkItemIds.indexOf(workItem.id)}
                onClick={() => toggleWorkItemSelection(workItem.id)}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

function SidebarWorkItemRow({
  workItem,
  canStart,
  isSelected,
  selectedIndex,
  onClick,
}: {
  workItem: WorkItem;
  canStart: boolean;
  isSelected: boolean;
  selectedIndex: number;
  onClick: () => void;
}) {
  const { startAgent, isStarting } = useStartAgent();
  const selectWorkItem = useWorkItemStore((s) => s.selectWorkItem);
  const removeSelectedWorkItem = useWorkItemStore((s) => s.removeSelectedWorkItem);
  const deleteWorkItem = useDeleteWorkItem();
  const [showMenu, setShowMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isReady = workItem.status === 'ready';
  const isRunning = workItem.status === 'running';
  const showStartButton = isReady && canStart;
  const tag = isSelected ? getWorkItemTag(selectedIndex) : null;

  return (
    <div className="relative group">
      <button
        onClick={onClick}
        style={tag ? { background: `${tag.color}10`, boxShadow: `inset 2px 0 0 ${tag.color}` } : undefined}
        className={`w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors duration-100
          ${isSelected ? '' : 'hover:bg-white/[0.04]'} ${showStartButton ? 'pr-16' : 'pr-10'}`}
      >
        {tag ? (
          <span
            className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-[10px] font-bold shrink-0 text-white/90"
            style={{ backgroundColor: tag.color }}
          >
            {tag.letter}
          </span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[workItem.status]}`} />
        )}
        <span className="flex-1 text-[13px] text-text truncate min-w-0">
          {workItem.title || <span className="italic text-text-dim">Untitled</span>}
        </span>
      </button>

      {/* Hover actions */}
      <div
        className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-border/60 bg-bg/95 px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        {showStartButton && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              selectWorkItem(workItem.id);
              void startAgent(workItem);
            }}
            disabled={isStarting}
            title="Start agent"
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-state-success hover:bg-state-success/10 transition-colors"
          >
            {isStarting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
          className="w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-white/[0.06] transition-colors"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => { setShowMenu(false); setConfirmDelete(false); }} />
          <div className="absolute right-1 top-full mt-1 z-40 w-40 bg-surface border border-border rounded-lg shadow-xl py-1">
            {confirmDelete ? (
              <div className="px-3 py-2 space-y-2">
                <div className="text-[11px] text-text-dim">Delete this work item?</div>
                <div className="flex gap-1.5">
                  <button
                    onClick={async () => {
                      try {
                        removeSelectedWorkItem(workItem.id);
                        await deleteWorkItem.mutateAsync(workItem.id);
                      } catch { /* swallow */ }
                      setShowMenu(false);
                      setConfirmDelete(false);
                    }}
                    disabled={deleteWorkItem.isPending}
                    className="flex-1 px-2 py-1 text-[11px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                  >
                    {deleteWorkItem.isPending ? 'Deleting…' : 'Delete'}
                  </button>
                  <button
                    onClick={() => { setConfirmDelete(false); setShowMenu(false); }}
                    className="flex-1 px-2 py-1 text-[11px] rounded bg-white/[0.06] text-text-dim hover:bg-white/[0.1] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                disabled={isRunning}
                onClick={() => setConfirmDelete(true)}
                className="w-full text-left px-3 py-1.5 text-[12px] text-red-400 hover:bg-white/[0.06] transition-colors flex items-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3 h-3" />
                Delete work item
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
