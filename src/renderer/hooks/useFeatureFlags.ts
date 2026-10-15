import { useEffect, useState } from 'react';

/**
 * Live feature flags, owned by the main process (~/.kirolex/config.json).
 *
 * Read here for RENDER decisions and via `featureFlags()` for imperative ones
 * (event handlers). Both refresh on the `kirolex:features-changed` event that the
 * Settings panel fires, so flipping a switch changes behaviour immediately -- no
 * restart, and no reload of the window either.
 */
let cache: Record<string, boolean> = {};
let loaded = false;

async function refresh(): Promise<Record<string, boolean>> {
  try {
    const res = await window.kiroApi.getFeatures?.();
    if (res?.flags) cache = res.flags;
  } catch {}
  loaded = true;
  return cache;
}

/** Imperative read. Unknown/unloaded keys are ON, matching main's defaults, so a
 *  feature is never silently disabled by a failed lookup. */
export function isFeatureOn(key: string): boolean {
  return cache[key] !== false;
}

export function featureFlags(): Record<string, boolean> {
  return cache;
}

export function useFeatureFlags(): Record<string, boolean> {
  const [flags, setFlags] = useState<Record<string, boolean>>(cache);
  useEffect(() => {
    let cancelled = false;
    if (!loaded) void refresh().then((f) => { if (!cancelled) setFlags({ ...f }); });
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as Record<string, boolean> | undefined;
      if (detail) { cache = detail; setFlags({ ...detail }); }
      else void refresh().then((f) => setFlags({ ...f }));
    };
    window.addEventListener('kirolex:features-changed', onChanged);
    return () => { cancelled = true; window.removeEventListener('kirolex:features-changed', onChanged); };
  }, []);
  return flags;
}
