import { useState } from 'react';
import { useCreateWorktree } from './useWorktree';
import { useUpdateTicket, useTransitionTicket } from './useTicketMutation';
import { useLaunchAgent } from './useAgents';
import { useTerminalStore } from '../stores/terminalStore';
import { useTicketStore } from '../stores/ticketStore';
import type { Ticket } from '@mozzie/db';

/**
 * Orchestrates the full agent start sequence when a ticket's play button is pressed:
 *   1. Validate repo_path and assigned_agent are set
 *   2. Find the next available terminal slot
 *   3. Create git worktree (idempotent)
 *   4. Update ticket with worktree path, branch name, and terminal slot
 *   5. Transition ticket → queued
 *   6. Register slot in terminal store
 *   7. Launch ACP agent run (returns log_id immediately; run streams in background)
 *   8. Transition ticket → running
 *
 * If step 7 or 8 fails, the slot is released and the ticket is rolled back to ready.
 */
export function useStartAgent() {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createWorktree = useCreateWorktree();
  const updateTicket = useUpdateTicket();
  const transitionTicket = useTransitionTicket();
  const launchAgent = useLaunchAgent();
  const getNextAvailableSlot = useTerminalStore((s) => s.getNextAvailableSlot);
  const assignSlot = useTerminalStore((s) => s.assignSlot);
  const releaseSlot = useTerminalStore((s) => s.releaseSlot);
  const setRunError = useTicketStore((s) => s.setRunError);
  const clearRunError = useTicketStore((s) => s.clearRunError);

  async function startAgent(ticket: Ticket): Promise<{ ok: boolean; error?: string }> {
    // Pre-flight checks — fail fast with clear messages
    if (!ticket.repo_path) {
      const message = 'Set a repository path on the ticket before starting.';
      setError(message);
      setRunError(ticket.id, message);
      return { ok: false, error: message };
    }
    if (!ticket.assigned_agent) {
      const message = 'Assign an agent to this ticket before starting (edit the ticket).';
      setError(message);
      setRunError(ticket.id, message);
      return { ok: false, error: message };
    }

    const slot = getNextAvailableSlot();
    if (slot === null) {
      const message = 'All 8 terminal slots are occupied. Finish or abort a running agent first.';
      setError(message);
      setRunError(ticket.id, message);
      return { ok: false, error: message };
    }

    setIsStarting(true);
    setError(null);
    clearRunError(ticket.id);

    try {
      // Steps 3–6: set up worktree and move to queued
      const info = await createWorktree.mutateAsync({
        ticketId: ticket.id,
        repoPath: ticket.repo_path,
        sourceBranch: ticket.source_branch ?? undefined,
        branchName: ticket.branch_name ?? undefined,
      });

      await updateTicket.mutateAsync({
        id: ticket.id,
        fields: {
          worktree_path: info.worktree_path,
          source_branch: info.source_branch,
          branch_name: info.branch_name,
          terminal_slot: slot,
        },
      });

      await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'queued' });
      assignSlot(slot, ticket.id);

      // Step 7: launch ACP run — returns log_id immediately
      try {
        await launchAgent.mutateAsync({ ticketId: ticket.id, slot });
      } catch (launchErr) {
        // Roll back: release the slot and return ticket to ready
        releaseSlot(slot);
        await updateTicket.mutateAsync({ id: ticket.id, fields: { terminal_slot: null } });
        await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'ready' });
        const message = `Agent launch failed: ${launchErr}`;
        setError(message);
        setRunError(ticket.id, message);
        return { ok: false, error: message };
      }

      // Step 8: mark running
      await transitionTicket.mutateAsync({ id: ticket.id, toStatus: 'running' });
      clearRunError(ticket.id);
      return { ok: true };
    } catch (e) {
      const message = String(e);
      setError(message);
      setRunError(ticket.id, message);
      return { ok: false, error: message };
    } finally {
      setIsStarting(false);
    }
  }

  return { startAgent, isStarting, error };
}
