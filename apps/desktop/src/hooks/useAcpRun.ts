import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AcpEventItem } from '@mozzie/db';
import type { AgentLogChangeEvent } from '../types/events';

export const WORK_ITEM_ACP_EVENTS_KEY = 'work_item_acp_events';

interface AcpEventPayload {
  workItemId: string;
  logId: string;
  item: AcpEventItem;
}

/**
 * Subscribes to live "acp:event" Tauri events for a specific work item.
 * Returns the accumulated list of AcpEventItem objects streamed so far.
 * When `logId` is provided, also accepts seed items from a persisted log.
 */
export function useAcpRun(workItemId: string | null) {
  const queryClient = useQueryClient();
  const [liveItems, setLiveItems] = useState<AcpEventItem[]>([]);
  const currentLogIdRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);
  const { data: persistedItems = [] } = useQuery<AcpEventItem[]>({
    queryKey: [WORK_ITEM_ACP_EVENTS_KEY, workItemId],
    queryFn: () => invoke('get_work_item_acp_events', { workItemId }),
    enabled: !!workItemId,
  });

  useEffect(() => {
    if (!workItemId) {
      setLiveItems([]);
      currentLogIdRef.current = null;
      return;
    }

    setLiveItems([]);
    currentLogIdRef.current = null;

    let cancelled = false;

    const unlisteners: Array<() => void> = [];

    listen<AcpEventPayload>('acp:event', (event) => {
      if (cancelled) return;
      if (event.payload.workItemId !== workItemId) return;
      if (currentLogIdRef.current !== event.payload.logId) {
        currentLogIdRef.current = event.payload.logId;
        setLiveItems([event.payload.item]);
        return;
      }
      setLiveItems((prev) => [...prev, event.payload.item]);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
        unlistenRefs.current = [...unlisteners];
      }
    });

    listen<AgentLogChangeEvent>('agent:log-change', (event) => {
      if (cancelled) return;
      if (event.payload.workItemId !== workItemId) return;
      currentLogIdRef.current = null;
      setLiveItems([]);
      queryClient.invalidateQueries({ queryKey: [WORK_ITEM_ACP_EVENTS_KEY, workItemId] });
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
        unlistenRefs.current = [...unlisteners];
      }
    });

    return () => {
      cancelled = true;
      for (const unlisten of unlistenRefs.current) {
        unlisten();
      }
      unlistenRefs.current = [];
    };
  }, [queryClient, workItemId]);

  return useMemo(() => {
    const seenIds = new Set<string>();
    const merged: AcpEventItem[] = [];
    for (const item of [...persistedItems, ...liveItems]) {
      if (seenIds.has(item.id)) {
        continue;
      }
      seenIds.add(item.id);
      merged.push(item);
    }
    return merged;
  }, [liveItems, persistedItems]);
}
