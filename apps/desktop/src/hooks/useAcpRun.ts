import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { AcpEventItem } from '@mozzie/db';

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
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!ticketId) {
      setItems([]);
      return;
    }

    setItems([]);

    let cancelled = false;

    listen<AcpEventPayload>('acp:event', (event) => {
      if (cancelled) return;
      if (event.payload.ticketId !== ticketId) return;
      setItems((prev) => [...prev, event.payload.item]);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenRef.current = unlisten;
      }
    });

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [ticketId]);

  return items;
}
