import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkItem } from '@mozzie/db';
import { useStartAgent } from './useStartAgent';
import { WORK_ITEMS_KEY } from './useWorkItems';

/**
 * Listens for `work-item:deps-unblocked` events (emitted by the Rust cascade logic
 * when a work item is approved and its dependents become unblocked).
 * Auto-starts each newly-unblocked work item.
 */
export function useAutoLaunchUnblocked() {
  const { startAgent } = useStartAgent();
  const queryClient = useQueryClient();
  const startAgentRef = useRef(startAgent);
  startAgentRef.current = startAgent;

  useEffect(() => {
    const unlisten = listen<{ workItemIds: string[] }>('work-item:deps-unblocked', async (event) => {
      // Invalidate work item list so UI updates
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });

      // Auto-launch each unblocked work item sequentially
      for (const workItemId of event.payload.workItemIds) {
        try {
          const workItem = await invoke<WorkItem>('get_work_item', { id: workItemId });
          if (workItem.status === 'ready') {
            await startAgentRef.current(workItem);
          }
        } catch {
          // Work item may have been deleted or is no longer in ready state
        }
      }
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [queryClient]);
}
