import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * S9 focus probe, latest-only deferral and project prefix. Pure library: nothing here is wired into the
 * extension yet. The frontmost-terminal check is injected (the S8 bundle-id idea lives in speak-clipboard).
 */
export type FocusState = 'focused' | 'unfocused' | 'unknown';

export type HerdrExec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<string>;

export const defaultHerdrExec: HerdrExec = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)));
  });

export interface ProbeHerdrOptions {
  env: Record<string, string | undefined>;
  exec?: HerdrExec;
  timeoutMs: number;
}

/** `herdr pane get $HERDR_PANE_ID` → `result.pane.focused`. Anything unexpected is `unknown`. */
export async function probeHerdrFocus(opts: ProbeHerdrOptions): Promise<FocusState> {
  const { env, timeoutMs } = opts;
  if (env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID) return 'unknown';
  const exec = opts.exec ?? defaultHerdrExec;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('herdr probe timed out')), timeoutMs);
      timer.unref?.();
    });
    const out = await Promise.race([exec(env.HERDR_BIN_PATH || 'herdr', ['pane', 'get', env.HERDR_PANE_ID], { timeoutMs }), timeout]);
    const focused = (JSON.parse(out) as any)?.result?.pane?.focused;
    return focused === true ? 'focused' : focused === false ? 'unfocused' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface FocusCheckOptions {
  probeHerdr: () => Promise<FocusState>;
  isTerminalFrontmost: () => Promise<boolean>;
}

/** Focused only when the terminal is frontmost and Herdr says focused; unknown follows an unknown Herdr. */
export function createFocusCheck(opts: FocusCheckOptions): () => Promise<FocusState> {
  return async () => {
    const herdr = await opts.probeHerdr();
    if (herdr === 'unknown') return 'unknown';
    if (herdr === 'unfocused') return 'unfocused';
    let front = false;
    try { front = await opts.isTerminalFrontmost(); } catch { front = false; }
    return front ? 'focused' : 'unfocused';
  };
}

/** `"<basename>: <text>"` for speech whose focus is unknown. */
export function projectPrefix(cwd: string, text: string): string {
  return `${path.basename(cwd.replace(/[\\/]+$/, ''))}: ${text}`;
}

export interface DeliveryOptions { prefixProject?: boolean }

export interface LatestOnlyDeferralOptions<T> {
  checkFocus: () => Promise<FocusState>;
  pollMs: number;
  onReady: (item: T, opts?: DeliveryOptions) => unknown;
}

export interface LatestOnlyDeferral<T> {
  offer(item: T): Promise<void>;
  clear(): void;
  dispose(): void;
}

export function createLatestOnlyDeferral<T>(opts: LatestOnlyDeferralOptions<T>): LatestOnlyDeferral<T> {
  let pending: { item: T } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  let disposed = false;

  const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const state = async (): Promise<FocusState> => { try { return await opts.checkFocus(); } catch { return 'unknown'; } };
  const settle = async (entry: { item: T }): Promise<void> => {
    const focus = await state();
    if (disposed || pending !== entry) return; // replaced, cleared or disposed while checking
    if (focus === 'unfocused') return;
    pending = undefined;
    stop();
    opts.onReady(entry.item, focus === 'unknown' ? { prefixProject: true } : undefined);
  };
  const tick = async () => {
    if (busy || !pending) return;
    busy = true;
    try { await settle(pending); } finally { busy = false; }
  };

  return {
    async offer(item) {
      if (disposed) return;
      const entry = { item };
      pending = entry;
      await settle(entry);
      if (!disposed && pending === entry && !timer) {
        timer = setInterval(() => { void tick(); }, opts.pollMs);
        timer.unref?.();
      }
    },
    clear() { pending = undefined; stop(); },
    dispose() { disposed = true; pending = undefined; stop(); },
  };
}
