/**
 * Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
 * SPDX-License-Identifier: MIT
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the MIT License. See the LICENSE file in the root of
 * this project for the full license text.
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * MIT License for more details.
 * Email: victor.perez@e-evolution.com, http://www.e-evolution.com , http://github.com/e-Evolution
 * Created by victor.perez@e-evolution.com , www.e-evolution.com
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * S9 focus probe, frontmost-app reader, latest-only deferral and project prefix. The frontmost-terminal check
 * is injected (the terminal bundle id lives in speak-clipboard).
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

/** An env-provided binary is executed only when it is an absolute path with basename `herdr` to an existing executable regular file. */
const herdrBinary = (value: string | undefined): string => {
  if (!value || !path.isAbsolute(value) || path.basename(value) !== 'herdr' || path.normalize(value) !== value) return 'herdr';
  try {
    if (!fs.statSync(value).isFile()) return 'herdr';
    fs.accessSync(value, fs.constants.X_OK);
    return value;
  } catch { return 'herdr'; }
};

/** Bundle id of the frontmost macOS app through JXA (no System Events permission); undefined when unreadable. */
export const FRONTMOST_SCRIPT = "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js";
export async function readFrontmostBundleId(opts: { exec?: HerdrExec; timeoutMs: number }): Promise<string | undefined> {
  const exec = opts.exec ?? defaultHerdrExec;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('frontmost read timed out')), opts.timeoutMs); timer.unref?.(); });
    const out = (await Promise.race([exec('osascript', ['-l', 'JavaScript', '-e', FRONTMOST_SCRIPT], { timeoutMs: opts.timeoutMs }), timeout])).trim();
    return /^[\w.-]{1,255}$/.test(out) ? out : undefined;
  } catch { return undefined; } finally { if (timer) clearTimeout(timer); }
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
    const out = await Promise.race([exec(herdrBinary(env.HERDR_BIN_PATH), ['pane', 'get', env.HERDR_PANE_ID], { timeoutMs }), timeout]);
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
  /** undefined (or a throw) means the terminal or the frontmost app cannot be identified. */
  isTerminalFrontmost: () => Promise<boolean | undefined>;
  /** Bound for each probe; a probe that does not settle in time counts as unknown. Default 700 ms. */
  timeoutMs?: number;
  /** T46: the terminal's own focus reports. Once a real focus event arrived, its state decides alone; typing-implied focus is the last resort. */
  terminal?: { state(): FocusState; hasEvents(): boolean };
  /** `process.platform` of the session. Only macOS has the frontmost check; elsewhere a known Herdr answer stands alone (L91). Default `darwin` (the pre-T46 behavior). */
  platform?: string;
}

/** Settles with `fallback` when `make()` throws, rejects or does not settle within `ms`. */
function bounded<T>(make: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    let p: Promise<T>;
    try { p = make(); } catch { clearTimeout(timer); resolve(fallback); return; }
    p.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/**
 * Order (S9, S16): terminal focus events when any arrived (authoritative); else Herdr; else, on macOS, the frontmost app refines a focused Herdr;
 * else typing-implied focus; else unknown. Focused only when the terminal is frontmost and Herdr says focused on macOS; unknown follows an unknown
 * Herdr or an unidentifiable frontmost app. Both probes run at once, each bounded by `timeoutMs`; a prompt `unfocused` from Herdr decides alone.
 * Off macOS the frontmost probe never runs and a known Herdr answer is used as is.
 */
export function createFocusCheck(opts: FocusCheckOptions): () => Promise<FocusState> {
  const ms = opts.timeoutMs ?? 700;
  const mac = (opts.platform ?? 'darwin') === 'darwin';
  const typed = (): FocusState => { try { return opts.terminal?.state() === 'focused' ? 'focused' : 'unknown'; } catch { return 'unknown'; } };
  return async () => {
    try { if (opts.terminal?.hasEvents()) return opts.terminal.state(); } catch { /* fall through to the other sources */ }
    const herdrP = bounded(opts.probeHerdr, ms, 'unknown' as FocusState);
    const frontP = mac ? bounded(opts.isTerminalFrontmost, ms, undefined as boolean | undefined) : undefined;
    const herdr = await herdrP;
    if (herdr === 'unknown') return typed();
    if (herdr === 'unfocused') return 'unfocused';
    if (!frontP) return 'focused';
    const front = await frontP;
    return front === undefined ? typed() : front ? 'focused' : 'unfocused';
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
  /** Re-checks the pending item now (a focus event arrived); no-op when nothing is pending. The poll stays as the fallback. */
  wake(): Promise<void>;
  dispose(): void;
}

export function createLatestOnlyDeferral<T>(opts: LatestOnlyDeferralOptions<T>): LatestOnlyDeferral<T> {
  let pending: { item: T } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  let rerun = false;
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
    try { await settle(pending); } catch { /* a failing delivery never becomes an unhandled rejection; the item is already out of the queue */ } finally { busy = false; if (rerun) { rerun = false; void tick(); } }
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
    async wake() {
      if (disposed || !pending) return;
      if (busy) { rerun = true; return; }
      await tick();
    },
    clear() { pending = undefined; stop(); },
    dispose() { disposed = true; pending = undefined; stop(); },
  };
}
