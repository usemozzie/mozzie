import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../stores/workspaceStore';

export const NOTES_KEY = 'workspace-notes';

export function useNotes() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return useQuery<string>({
    queryKey: [NOTES_KEY, workspaceId],
    queryFn: () => invoke<string>('get_workspace_notes', { workspaceId }),
  });
}

export function useSaveNotes() {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return useMutation({
    mutationFn: (content: string) =>
      invoke<void>('save_workspace_notes', { workspaceId, content }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [NOTES_KEY, workspaceId] }),
  });
}
