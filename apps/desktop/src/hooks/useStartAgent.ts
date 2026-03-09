import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCreateWorktree } from './useWorktree';
import { useUpdateWorkItem, useTransitionWorkItem } from './useWorkItemMutation';
import { useLaunchAgent } from './useAgents';
import { useTerminalStore } from '../stores/terminalStore';
import { useWorkItemStore } from '../stores/workItemStore';
import type { WorkItem } from '@mozzie/db';

/**
 * Orchestrates the full agent start sequence when a work item's play button is pressed:
 *   1. Validate repo_path and assigned_agent are set
 *   2. Find the next available terminal slot
 *   3. Create git worktree (idempotent)
 *   4. Update work item with worktree path, branch name, and terminal slot
 *   5. Transition work item → queued
 *   6. Register slot in terminal store
 *   7. Launch ACP agent run (returns log_id immediately; run streams in background)
 *   8. Transition work item → running
 *
 * If step 7 or 8 fails, the slot is released and the work item is rolled back to ready.
 */
export function useStartAgent() {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createWorktree = useCreateWorktree();
  const updateWorkItem = useUpdateWorkItem();
  const transitionWorkItem = useTransitionWorkItem();
  const launchAgent = useLaunchAgent();
  const getNextAvailableSlot = useTerminalStore((s) => s.getNextAvailableSlot);
  const assignSlot = useTerminalStore((s) => s.assignSlot);
  const releaseSlot = useTerminalStore((s) => s.releaseSlot);
  const setRunError = useWorkItemStore((s) => s.setRunError);
  const clearRunError = useWorkItemStore((s) => s.clearRunError);

  async function startAgent(workItem: WorkItem): Promise<{ ok: boolean; error?: string }> {
    // Pre-flight checks — fail fast with clear messages
    // Parent integration branches do not run agents once they have children.
    if (!workItem.parent_id) {
      try {
        const children = await invoke<WorkItem[]>('get_child_work_items', { parentId: workItem.id });
        if (children.length > 0) {
          const message = 'Parent work items are integration branches. Run a child work item instead.';
          setError(message);
          setRunError(workItem.id, message);
          return { ok: false, error: message };
        }
      } catch {
        // Ignore lookup failures and continue with the normal start flow.
      }
    }

    // Check for unmet dependencies — if any, transition to blocked
    try {
      const hasUnmet = await invoke<boolean>('has_unmet_dependencies', { workItemId: workItem.id });
      if (hasUnmet) {
        // Transition to blocked if currently ready
        if (workItem.status === 'ready') {
          await transitionWorkItem.mutateAsync({ id: workItem.id, toStatus: 'blocked' });
        }
        const message = 'Work item has unmet dependencies. It will auto-start when dependencies are approved.';
        setError(message);
        setRunError(workItem.id, message);
        return { ok: false, error: message };
      }
    } catch (e) {
      // If dependency check fails, proceed without blocking
    }

    if (!workItem.repo_path) {
      const message = 'Set a repository path on the work item before starting.';
      setError(message);
      setRunError(workItem.id, message);
      return { ok: false, error: message };
    }
    if (!workItem.assigned_agent) {
      const message = 'Assign an agent to this work item before starting (edit the work item).';
      setError(message);
      setRunError(workItem.id, message);
      return { ok: false, error: message };
    }

    const slot = getNextAvailableSlot();
    if (slot === null) {
      const message = 'All 8 terminal slots are occupied. Finish or abort a running agent first.';
      setError(message);
      setRunError(workItem.id, message);
      return { ok: false, error: message };
    }

    setIsStarting(true);
    setError(null);
    clearRunError(workItem.id);

    try {
      // If this is a child work item, ensure the parent's branch exists first
      // and use it as the source branch so the child branches off the parent.
      let sourceBranch = workItem.source_branch ?? undefined;
      if (workItem.parent_id) {
        try {
          const parentBranch = await invoke<string>('ensure_parent_branch', { parentId: workItem.parent_id });
          sourceBranch = parentBranch;
        } catch (e) {
          const message = `Failed to set up parent branch: ${e}`;
          setError(message);
          setRunError(workItem.id, message);
          return { ok: false, error: message };
        }
      }

      // Steps 3–6: set up worktree and move to queued
      const info = await createWorktree.mutateAsync({
        workItemId: workItem.id,
        repoPath: workItem.repo_path,
        sourceBranch,
        branchName: workItem.branch_name ?? undefined,
      });

      await updateWorkItem.mutateAsync({
        id: workItem.id,
        fields: {
          worktree_path: info.worktree_path,
          source_branch: info.source_branch,
          branch_name: info.branch_name,
          terminal_slot: slot,
        },
      });

      await transitionWorkItem.mutateAsync({ id: workItem.id, toStatus: 'queued' });
      assignSlot(slot, workItem.id);

      // Step 7: launch ACP run — returns log_id immediately
      try {
        await launchAgent.mutateAsync({ workItemId: workItem.id, slot });
      } catch (launchErr) {
        // Roll back: release the slot and return work item to ready
        releaseSlot(slot);
        await updateWorkItem.mutateAsync({ id: workItem.id, fields: { terminal_slot: null } });
        await transitionWorkItem.mutateAsync({ id: workItem.id, toStatus: 'ready' });
        const message = `Agent launch failed: ${launchErr}`;
        setError(message);
        setRunError(workItem.id, message);
        return { ok: false, error: message };
      }

      // Step 8: mark running
      await transitionWorkItem.mutateAsync({ id: workItem.id, toStatus: 'running' });
      clearRunError(workItem.id);
      return { ok: true };
    } catch (e) {
      const message = String(e);
      setError(message);
      setRunError(workItem.id, message);
      return { ok: false, error: message };
    } finally {
      setIsStarting(false);
    }
  }

  return { startAgent, isStarting, error };
}
