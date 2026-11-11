import { isSelectionTui } from './speak-clipboard.ts';
import type { FocusState } from './speak-focus.ts';

/**
 * T46 (S16): terminal focus from the terminal's own focus reports. pi-tui enables `?1004h`, so the terminal sends `\x1b[I` (in) and `\x1b[O` (out),
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
          else if (typeof data === 'string' && data.length > 0) { lastInputAt = now(); if (eventState !== undefined) eventState = 'focused'; } // typing implies focus
          emit();
        } catch { /* observing never changes input handling */ }
      }
      return (original as Handler).apply(this, args);
    };
    try { t.handleViewportInput = wrapper; attached = true; } catch { attached = false; wrapper = undefined; }
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
