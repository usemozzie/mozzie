import { useState } from 'react';
import { Shield, ShieldCheck, Loader2, ExternalLink, Sparkles } from 'lucide-react';
import { useLicense, useActivateLicense, useDeactivateLicense } from '../../hooks/useLicense';

const PURCHASE_URL = 'https://buy.stripe.com/8x25kDcCm0E90Oz1dEg3600';

export function LicenseSection() {
  const { data: license, isLoading } = useLicense();
  const activateLicense = useActivateLicense();
  const deactivateLicense = useDeactivateLicense();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isPro = license?.is_pro ?? false;

  function handleActivate() {
    setError(null);
    activateLicense.mutate(key, {
      onSuccess: () => setKey(''),
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }

  function handleDeactivate() {
    setError(null);
    deactivateLicense.mutate(undefined, {
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
        License
      </h3>

      {isLoading ? (
        <div className="flex items-center gap-2 px-1 text-xs text-text-dim">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Checking license...
        </div>
      ) : isPro ? (
        <div className="space-y-2 px-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-state-success" />
            <span className="text-xs text-state-success font-medium">Pro License Active</span>
          </div>
          {license?.license_key && (
            <p className="text-[11px] text-text-dim">Key: {license.license_key}</p>
          )}
          {license?.email && (
            <p className="text-[11px] text-text-dim">Email: {license.email}</p>
          )}
          <button
            onClick={handleDeactivate}
            disabled={deactivateLicense.isPending}
            className="text-[11px] text-state-danger hover:underline"
          >
            Deactivate license
          </button>
        </div>
      ) : (
        <div className="space-y-2 px-1">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-text-dim" />
            <span className="text-xs text-text-dim">Free Plan</span>
          </div>
          <p className="text-[11px] text-text-dim">
            Upgrade to Pro for unlimited workspaces.
          </p>
          <button
            onClick={async () => {
              const { open } = await import('@tauri-apps/plugin-shell');
              await open(PURCHASE_URL);
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg
              bg-gradient-to-r from-accent/20 to-purple-500/20 border border-accent/30
              text-accent text-[12px] font-medium
              hover:from-accent/30 hover:to-purple-500/30 hover:border-accent/50
              transition-all duration-200"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Get Mozzie Pro
            <ExternalLink className="w-3 h-3 opacity-60" />
          </button>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleActivate(); }}
              placeholder="Enter license key"
              className="flex-1 text-[12px] bg-bg border border-border rounded-md px-2 py-1 text-text
                placeholder:text-text-dim focus:outline-none focus:border-accent/50"
            />
            <button
              onClick={handleActivate}
              disabled={!key.trim() || activateLicense.isPending}
              className="text-[11px] px-2.5 py-1 rounded-md bg-accent/20 text-accent hover:bg-accent/30
                disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {activateLicense.isPending ? 'Activating...' : 'Activate'}
            </button>
          </div>
          {error && (
            <p className="text-[11px] text-state-danger">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
