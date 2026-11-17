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
import { isSelectionTui } from './speak-clipboard.ts';
import type { FocusState } from './speak-focus.ts';

/**
 * Terminal focus from the terminal's own focus reports. pi-tui enables `?1004h`, so the terminal sends `\x1b[I` (in) and `\x1b[O` (out),
 * but `TuiAltScreen.handleViewportInput` consumes them without storing state and no public API exposes them. This tracker wraps that method on the
 * live instance (never the prototype), observes, and always delegates unchanged.
 *
 * It relies on a pi-tui PRIVATE method. When the method is missing or the instance is not the fullscreen TUI, the tracker reports `unknown`
 * permanently, logs once and touches nothing.
 */
export const FOCUS_IN = '\x1b[I';
export const FOCUS_OUT = '\x1b[O';
/** Without any focus event, input this recent counts as focus. */
export const TYPING_FOCUS_WINDOW_MS = 60_000;

export interface TerminalFocusTracker {
  /** `focused` | `unfocused` | `unknown`; see `hasEvents` for how much to trust it. */
  state(): FocusState;
  /** True once a real focus event arrived; the state is then authoritative. */
  hasEvents(): boolean;
  /** False when detection failed (state stays `unknown`, nothing was wrapped). */
  readonly attached: boolean;
  onChange(listener: (state: FocusState) => void): () => void;
  /** Restores the original method (only when this wrapper is still the installed one). Idempotent. */
  dispose(): void;
}

export interface TerminalFocusOptions {
  now?: () => number;
  windowMs?: number;
  log?: (message: string) => void;
}

/**
 * Whether `data` is input that means the user is at this pane: keys and mouse. Paste brackets and terminal replies (DA, CPR, kitty and mode reports,
 * window-size reports, OSC/DCS/APC replies) are not: a terminal can send them without anyone present.
 */
export function isUserInput(data: string): boolean {
  if (data.length === 0) return false;
  if (data.includes('\x1b[200~') || data.includes('\x1b[201~')) return false; // paste brackets
  if (/^\x1b[\]P_^X]/.test(data)) return false; // OSC, DCS, APC, PM, SOS replies
  if (/^\x1b\[[?>=]/.test(data)) return false; // private-parameter CSI replies (DA1/DA2/DA3, kitty flags, DECRPM)
  if (/^\x1b\[\d+;\d+R$/.test(data)) return false; // cursor position report
  if (/^\x1b\[\d+(;\d+)*t$/.test(data)) return false; // window size reports
  return true;
}

type Handler = (this: unknown, ...args: unknown[]) => unknown;

export function createTerminalFocusTracker(tui: unknown, opts: TerminalFocusOptions = {}): TerminalFocusTracker {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? TYPING_FOCUS_WINDOW_MS;
  const listeners = new Set<(state: FocusState) => void>();
  let eventState: 'focused' | 'unfocused' | undefined;
  let lastInputAt: number | undefined;
  let disposed = false;
  let last: FocusState = 'unknown';

  const compute = (): FocusState => {
    if (!attached || disposed) return 'unknown';
    if (eventState !== undefined) return eventState;
    return lastInputAt !== undefined && now() - lastInputAt <= windowMs ? 'focused' : 'unknown';
  };
  const emit = () => {
    const next = compute();
    if (next === last) return;
    last = next;
    for (const listener of [...listeners]) { try { listener(next); } catch { /* a listener never breaks input */ } }
  };

  const target = tui as Record<string, unknown> | null | undefined;
  const original = target?.handleViewportInput;
  const detected = isSelectionTui(tui) && typeof original === 'function';
  let attached = false;
  let wrapper: Handler | undefined;
  let ownedOriginally = false;

  if (!detected) {
    try { opts.log?.('terminal focus events unavailable: the TUI does not expose handleViewportInput (pi-tui changed or not fullscreen)'); } catch { /* logging is best effort */ }
  } else {
    const t = target as Record<string, unknown>;
    ownedOriginally = Object.prototype.hasOwnProperty.call(t, 'handleViewportInput');
    wrapper = function (this: unknown, ...args: unknown[]) {
      if (!disposed) {
        try {
          const data = args[0];
          if (data === FOCUS_IN) eventState = 'focused';
          else if (data === FOCUS_OUT) eventState = 'unfocused';
          else if (typeof data === 'string' && isUserInput(data)) { lastInputAt = now(); if (eventState !== undefined) eventState = 'focused'; } // typing implies focus
          emit();
        } catch { /* observing never changes input handling */ }
      }
      return (original as Handler).apply(this, args);
    };
    // The assignment must stick: a frozen object or a setter that ignores it leaves the original installed, and the tracker would wait for events forever.
    try { t.handleViewportInput = wrapper; attached = t.handleViewportInput === wrapper; } catch { attached = false; }
    if (!attached) { wrapper = undefined; try { opts.log?.('terminal focus events unavailable: handleViewportInput could not be wrapped'); } catch { /* logging is best effort */ } }
  }

  return {
    state: compute,
    hasEvents: () => eventState !== undefined,
    get attached() { return attached; },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (!attached || !wrapper) return;
      const t = target as Record<string, unknown>;
      if (t.handleViewportInput !== wrapper) return; // someone wrapped on top of us: leave their chain intact
      try { if (ownedOriginally) t.handleViewportInput = original; else delete t.handleViewportInput; } catch { /* already restored */ }
    },
  };
}
