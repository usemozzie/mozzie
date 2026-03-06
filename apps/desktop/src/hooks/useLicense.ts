import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { LicenseStatus } from '@mozzie/db';

export const LICENSE_KEY = 'license';

export function useLicense() {
  return useQuery<LicenseStatus>({
    queryKey: [LICENSE_KEY],
    queryFn: () => invoke('get_license_status'),
    staleTime: 60_000,
  });
}

export function useActivateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (licenseKey: string) =>
      invoke<LicenseStatus>('activate_license', { licenseKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [LICENSE_KEY] }),
  });
}

export function useDeactivateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke<void>('deactivate_license'),
    onSuccess: () => qc.invalidateQueries({ queryKey: [LICENSE_KEY] }),
  });
}
