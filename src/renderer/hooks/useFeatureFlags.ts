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
/**
 * **kiro-cli 的 trace 日志开着吗** —— 和 flags 一起从主进程拿（`app:get-features`）。
 *
 * 它不是 feature flag（不住在 config.json 的 `features` 里，而是一个标记文件），但它是这套里
 * **唯一代价按 GB 计**的开关：开一天十几 GB，而原来界面上一个字都没有。所以跟着同一份 payload 走，
 * 侧栏据此挂一个显眼的标记。
 */
let traceOn = false;

async function refresh(): Promise<Record<string, boolean>> {
  try {
    const res = await window.kiroApi.getFeatures?.();
    if (res?.flags) cache = res.flags;
    traceOn = !!(res as any)?.kiroTrace;
  } catch {}
  loaded = true;
  return cache;
}

/** kiro-cli trace 日志的当前状态（读的是上一次 refresh 拿到的那份）。 */
export function kiroTraceOn(): boolean { return traceOn; }

/** 关掉它，并立刻刷新本地那份状态。 */
export async function setKiroTrace(enabled: boolean): Promise<boolean> {
  try {
    const res: any = await (window.kiroApi as any).setKiroTrace?.(enabled);
    if (res?.ok) traceOn = !!res.kiroTrace;
  } catch {}
  window.dispatchEvent(new CustomEvent('kirolex:features-changed'));
  return traceOn;
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
