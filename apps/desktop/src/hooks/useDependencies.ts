import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import type { WorkItemDependency } from '@mozzie/db';
import { WORK_ITEMS_KEY } from './useWorkItems';

const DEPS_KEY = 'work-item-dependencies';
const DEPENDENTS_KEY = 'work-item-dependents';

export function useWorkItemDependencies(workItemId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workItemId) return;
    const unlisten = listen<{ workItemId: string }>('work-item:deps-changed', (event) => {
      if (event.payload.workItemId === workItemId) {
        queryClient.invalidateQueries({ queryKey: [DEPS_KEY, workItemId] });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [workItemId, queryClient]);

  return useQuery({
    queryKey: [DEPS_KEY, workItemId],
    queryFn: () => invoke<WorkItemDependency[]>('get_work_item_dependencies', { workItemId }),
    enabled: !!workItemId,
  });
}

export function useWorkItemDependents(workItemId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workItemId) return;
    const unlisten = listen<{ workItemId: string }>('work-item:deps-changed', () => {
      queryClient.invalidateQueries({ queryKey: [DEPENDENTS_KEY, workItemId] });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [workItemId, queryClient]);

  return useQuery({
    queryKey: [DEPENDENTS_KEY, workItemId],
    queryFn: () => invoke<WorkItemDependency[]>('get_work_item_dependents', { workItemId }),
    enabled: !!workItemId,
  });
}

export function useHasUnmetDependencies(workItemId: string | null) {
  return useQuery({
    queryKey: ['unmet-deps', workItemId],
    queryFn: () => invoke<boolean>('has_unmet_dependencies', { workItemId }),
    enabled: !!workItemId,
  });
}

export function useAddDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { workItemId: string; dependsOnId: string }) =>
      invoke<void>('add_work_item_dependency', {
        workItemId: params.workItemId,
        dependsOnId: params.dependsOnId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [DEPS_KEY] });
      queryClient.invalidateQueries({ queryKey: [DEPENDENTS_KEY] });
      queryClient.invalidateQueries({ queryKey: ['unmet-deps'] });
    },
  });
}

export function useRemoveDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { workItemId: string; dependsOnId: string }) =>
      invoke<void>('remove_work_item_dependency', {
        workItemId: params.workItemId,
        dependsOnId: params.dependsOnId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [DEPS_KEY] });
      queryClient.invalidateQueries({ queryKey: [DEPENDENTS_KEY] });
      queryClient.invalidateQueries({ queryKey: ['unmet-deps'] });
      queryClient.invalidateQueries({ queryKey: [WORK_ITEMS_KEY] });
    },
  });
}
