import { useState } from 'react';
import { ChevronDown, ChevronRight, FolderGit2 } from 'lucide-react';
import type { WorkItem } from '@mozzie/db';
import { useWorkItems } from '../../hooks/useWorkItems';
import { useWorkItemStore } from '../../stores/workItemStore';
import { WorkItemCard } from './WorkItemCard';
import { getRepoDisplayName } from '../../lib/recentRepos';

interface RepoGroup {
  repoPath: string;
  label: string;
  parents: ParentGroup[];
  standalone: WorkItem[];
}

interface ParentGroup {
  parent: WorkItem;
  children: WorkItem[];
}

function buildHierarchy(workItems: WorkItem[]): RepoGroup[] {
  // Index children by parent_id
  const childrenByParent = new Map<string, WorkItem[]>();
  for (const wi of workItems) {
    if (wi.parent_id) {
      const list = childrenByParent.get(wi.parent_id) ?? [];
      list.push(wi);
      childrenByParent.set(wi.parent_id, list);
    }
  }

  // Group by repo
  const repoMap = new Map<string, { parents: ParentGroup[]; standalone: WorkItem[] }>();

  for (const wi of workItems) {
    // Skip children — they'll be nested under their parent
    if (wi.parent_id) continue;

    const repoKey = wi.repo_path ?? '__no_repo__';
    if (!repoMap.has(repoKey)) {
      repoMap.set(repoKey, { parents: [], standalone: [] });
    }
    const group = repoMap.get(repoKey)!;

    const children = childrenByParent.get(wi.id);
    if (children && children.length > 0) {
      group.parents.push({ parent: wi, children });
    } else {
      group.standalone.push(wi);
    }
  }

  // Convert to array, sorted: repos with activity first
  const groups: RepoGroup[] = [];
  for (const [repoPath, { parents, standalone }] of repoMap) {
    groups.push({
      repoPath,
      label: repoPath === '__no_repo__' ? 'No Repository' : getRepoDisplayName(repoPath),
      parents,
      standalone,
    });
  }

  return groups;
}

export function WorkItemList() {
  const { data: workItems, isLoading, isError } = useWorkItems();
  const { selectedWorkItemIds, toggleWorkItemSelection } = useWorkItemStore();

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-text-dim text-[13px]">
        Loading...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="h-full flex items-center justify-center text-state-danger text-[13px] px-4 text-center">
        Failed to load work items.
      </div>
    );
  }

  if (!workItems || workItems.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-1.5 px-4 text-center">
        <p className="text-[13px] text-text-muted">No work items yet</p>
        <p className="text-[11px] text-text-dim">Click + to create your first work item</p>
      </div>
    );
  }

  const groups = buildHierarchy(workItems);

  // If only one repo group, skip the repo header
  const singleRepo = groups.length === 1 && groups[0].repoPath !== '__no_repo__';

  return (
    <div className="h-full overflow-y-auto">
      {groups.map((group) => (
        <RepoSection
          key={group.repoPath}
          group={group}
          hideHeader={singleRepo}
          selectedWorkItemIds={selectedWorkItemIds}
          toggleWorkItemSelection={toggleWorkItemSelection}
        />
      ))}
    </div>
  );
}

function RepoSection({
  group,
  hideHeader,
  selectedWorkItemIds,
  toggleWorkItemSelection,
}: {
  group: RepoGroup;
  hideHeader: boolean;
  selectedWorkItemIds: string[];
  toggleWorkItemSelection: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const totalItems = group.parents.reduce((n, p) => n + 1 + p.children.length, 0) + group.standalone.length;

  return (
    <div>
      {!hideHeader && (
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-text-dim
            hover:text-text hover:bg-surface/50 transition-colors select-none sticky top-0 bg-bg z-[1]"
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          <FolderGit2 className="w-3 h-3 opacity-50" />
          <span className="truncate">{group.label}</span>
          <span className="ml-auto opacity-40">{totalItems}</span>
        </button>
      )}

      {!collapsed && (
        <>
          {group.parents.map((pg) => (
            <ParentSection
              key={pg.parent.id}
              parentGroup={pg}
              selectedWorkItemIds={selectedWorkItemIds}
              toggleWorkItemSelection={toggleWorkItemSelection}
            />
          ))}
          {group.standalone.map((wi) => (
            <WorkItemCard
              key={wi.id}
              workItem={wi}
              isSelected={selectedWorkItemIds.includes(wi.id)}
              selectedIndex={selectedWorkItemIds.indexOf(wi.id)}
              onClick={() => toggleWorkItemSelection(wi.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ParentSection({
  parentGroup,
  selectedWorkItemIds,
  toggleWorkItemSelection,
}: {
  parentGroup: ParentGroup;
  selectedWorkItemIds: string[];
  toggleWorkItemSelection: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { parent, children } = parentGroup;
  const doneCount = children.filter((c) => c.status === 'done' || c.status === 'archived').length;

  return (
    <div>
      {/* Parent card with expand toggle */}
      <div className="relative">
        <button
          onClick={() => setExpanded(!expanded)}
          className="absolute left-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center
            text-text-dim hover:text-text z-[1] transition-colors"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <div className="pl-4">
          <WorkItemCard
            workItem={parent}
            isSelected={selectedWorkItemIds.includes(parent.id)}
            selectedIndex={selectedWorkItemIds.indexOf(parent.id)}
            onClick={() => toggleWorkItemSelection(parent.id)}
            canStart={false}
          />
        </div>
        {/* Progress badge */}
        {children.length > 0 && (
          <span className="absolute right-14 top-1/2 -translate-y-1/2 text-[10px] text-text-dim opacity-50">
            {doneCount}/{children.length}
          </span>
        )}
      </div>

      {/* Children — indented */}
      {expanded && children.map((child) => (
        <div key={child.id} className="pl-6 border-l border-border/40 ml-3">
          <WorkItemCard
            workItem={child}
            isSelected={selectedWorkItemIds.includes(child.id)}
            selectedIndex={selectedWorkItemIds.indexOf(child.id)}
            onClick={() => toggleWorkItemSelection(child.id)}
          />
        </div>
      ))}
    </div>
  );
}
