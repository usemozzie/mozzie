import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { AcpEventItem } from '@mozzie/db';
import type { AgentLogChangeEvent } from '../types/events';

interface AcpEventPayload {
  ticketId: string;
  logId: string;
  item: AcpEventItem;
}

/**
 * Subscribes to live "acp:event" Tauri events for a specific ticket.
 * Returns the accumulated list of AcpEventItem objects streamed so far.
 * When `logId` is provided, also accepts seed items from a persisted log.
 */
export function useAcpRun(ticketId: string | null) {
  const [items, setItems] = useState<AcpEventItem[]>([]);
  const currentLogIdRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!ticketId) {
      setItems([]);
      currentLogIdRef.current = null;
      return;
    }

    setItems([]);
    currentLogIdRef.current = null;

    let cancelled = false;

    const unlisteners: Array<() => void> = [];

    listen<AcpEventPayload>('acp:event', (event) => {
      if (cancelled) return;
      if (event.payload.ticketId !== ticketId) return;
      if (currentLogIdRef.current !== event.payload.logId) {
        currentLogIdRef.current = event.payload.logId;
        setItems([event.payload.item]);
        return;
      }
      setItems((prev) => [...prev, event.payload.item]);
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
      if (event.payload.ticketId !== ticketId) return;
      currentLogIdRef.current = null;
      setItems([]);
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
  }, [ticketId]);

  return items;
}
