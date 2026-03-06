import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from '@mozzie/db';

export const WORKSPACES_KEY = 'workspaces';

export function useWorkspaces() {
  return useQuery<Workspace[]>({
    queryKey: [WORKSPACES_KEY],
    queryFn: () => invoke('list_workspaces'),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => invoke<Workspace>('create_workspace', { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [WORKSPACES_KEY] }),
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      invoke<Workspace>('rename_workspace', { id, name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [WORKSPACES_KEY] }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>('delete_workspace', { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [WORKSPACES_KEY] }),
  });
}
