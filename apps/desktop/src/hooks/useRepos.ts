import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { Repo } from '@mozzie/db';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function useRepos() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return useQuery<Repo[]>({
    queryKey: ['repos', workspaceId],
    queryFn: () => invoke('list_repos', { workspaceId }),
  });
}

export function useAddRepo() {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return useMutation({
    mutationFn: ({ name, path }: { name: string; path: string }) =>
      invoke<Repo>('add_repo', { name, path, workspaceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useRemoveRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke('remove_repo', { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function usePrepareRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<Repo>('prepare_repo', { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}
